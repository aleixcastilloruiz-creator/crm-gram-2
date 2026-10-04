import { Campaign, CampaignDestination, ScheduleSlot, SourceGroup } from "@prisma/client";
import { getAccountClient } from "../telegram/connectionPool";
import { prisma } from "../utils/prisma";
import { sendWhatsAppNotification } from "../utils/notifications";
import { ensureAccountReady, handlePeerFlood, isFloodError } from "./peerFlood";
import { deliverMessage, getRecentSourceMessages, logSendOutcome, messageAtPosition } from "./sender";

/** "HH:mm" y "YYYY-MM-DD" en la zona horaria de la cuenta. */
function nowInTimezone(timezone: string): { hhmm: string; date: string; minutesSinceMidnight: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hh = Number(get("hour"));
  const mm = Number(get("minute"));
  return {
    hhmm: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutesSinceMidnight: hh * 60 + mm,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Genera una lista de horarios "HH:mm" repartidos uniformemente entre
 * `from` y `to` cada `intervalMinutes` minutos, asignando posiciones
 * consecutivas 1..N (dando la vuelta si hacen falta mas mensajes de los
 * que hay en `distinctMessages`). Equivale al boton "Añadir todos los horarios".
 */
export function generateFixedSchedule(params: {
  intervalMinutes: number;
  from: string; // "HH:mm"
  to: string; // "HH:mm"
  distinctMessages: number;
}): { timeOfDay: string; position: number }[] {
  const { intervalMinutes, from, to, distinctMessages } = params;
  const fromMin = toMinutes(from);
  const toMin = toMinutes(to);

  const slots: { timeOfDay: string; position: number }[] = [];
  let position = 1;
  for (let t = fromMin; t <= toMin; t += intervalMinutes) {
    const h = Math.floor(t / 60) % 24;
    const m = t % 60;
    slots.push({
      timeOfDay: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      position,
    });
    position = position >= distinctMessages ? 1 : position + 1;
  }
  return slots;
}

/**
 * Intenta "reclamar" un slot para hoy: crea el ScheduleSlotRun del dia. Si
 * ya existia (violacion de la unique constraint), es que ya se proceso hoy
 * (enviado o perdido) y no hay que hacer nada mas. Esto hace la operacion
 * segura aunque el tick se solape o el proceso se reinicie.
 */
async function claimSlotForToday(slotId: string, runDate: string, status: "SENT" | "MISSED"): Promise<boolean> {
  try {
    await prisma.scheduleSlotRun.create({ data: { scheduleSlotId: slotId, runDate, status } });
    return true;
  } catch (err: any) {
    if (err?.code === "P2002") return false; // ya reclamado hoy
    throw err;
  }
}

/**
 * Se llama cada minuto (desde el orquestador). Para cada cuenta con el
 * interruptor maestro encendido y cada campaña en modo FIXED, mira todos
 * los slots del dia cuya hora ya paso:
 * - si paso dentro del margen de tolerancia (missedSlotToleranceMinutes),
 *   se envia ahora (cubre pequeños retrasos del propio tick/servidor)
 * - si paso ya de ese margen, se marca "Horario perdido" y se avisa por
 *   WhatsApp, sin enviarlo tarde
 * Cada slot se procesa como mucho una vez al dia gracias a ScheduleSlotRun.
 */
export async function runFixedScheduleTick(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { status: "ACTIVE", scheduleMode: "FIXED" },
    include: { account: true, sourceGroup: true, destinationChats: true, scheduleSlots: true },
  });

  for (const campaign of campaigns) {
    let account = await ensureAccountReady(campaign.account);
    if (!account.reenviadorEnabled) continue; // interruptor maestro apagado
    if (account.health === "PEER_FLOOD_PAUSED") continue;

    const { date: today, minutesSinceMidnight: nowMin } = nowInTimezone(account.timezone);

    const dueSlots = (campaign.scheduleSlots as ScheduleSlot[]).filter((slot) => {
      if (!slot.active) return false;
      return toMinutes(slot.timeOfDay) <= nowMin; // ya paso su hora hoy (o es ahora mismo)
    });
    if (dueSlots.length === 0) continue;

    // Conexion persistente de la cuenta (compartida con el modo Aleatorio y
    // con el resto de campañas FIXED de la misma cuenta): solo se pide si
    // de verdad hay algo que enviar, ya que puede que todos los dueSlots
    // acaben siendo "Horario perdido" sin necesitar conectar nada.
    let client: Awaited<ReturnType<typeof getAccountClient>> | null = null;

    for (const slot of dueSlots) {
      const delayMinutes = nowMin - toMinutes(slot.timeOfDay);
      const withinTolerance = delayMinutes <= account.missedSlotToleranceMinutes;

      if (!withinTolerance) {
        const claimed = await claimSlotForToday(slot.id, today, "MISSED");
        if (!claimed) continue; // ya se habia marcado antes
        const msg = `Horario ${slot.timeOfDay} (${account.timezone}): se pasó ${delayMinutes} min de su hora (tope ${account.missedSlotToleranceMinutes} min), así que hoy no se manda. Pasa si a esa hora el reenviador estaba apagado o parado por PeerFlood, la cuenta desconectada de Telegram, o el CRM reiniciándose.`;
        await prisma.sendLog.create({
          data: { accountId: account.id, campaignId: campaign.id, level: "MISSED", message: msg },
        });
        if (account.notifyWhatsAppTo) {
          await sendWhatsAppNotification(account.notifyWhatsAppTo, `⏰ ${account.label}: ${msg}`);
        }
        continue;
      }

      const claimed = await claimSlotForToday(slot.id, today, "SENT");
      if (!claimed) continue; // ya enviado hoy (o ya marcado)

      if (!client) client = await getAccountClient(account);

      const messages = await getRecentSourceMessages(client, campaign.sourceGroup as SourceGroup);
      const group = messageAtPosition(messages, slot.position);
      if (!group) {
        await prisma.sendLog.create({
          data: {
            accountId: account.id,
            campaignId: campaign.id,
            level: "WAIT",
            message: `Horario ${slot.timeOfDay}: no hay mensaje en la posicion ${slot.position}`,
          },
        });
        continue;
      }

      for (const destination of campaign.destinationChats as CampaignDestination[]) {
        const outcome = await deliverMessage(client, campaign as Campaign, campaign.sourceGroup as SourceGroup, destination, group);
        await logSendOutcome({
          accountId: account.id,
          campaignId: campaign.id,
          chatTitle: destination.chatTitle,
          outcome,
          sourceMessageId: group[0].id,
        });
        if (!outcome.ok && isFloodError(outcome.error)) {
          await handlePeerFlood(account, outcome.error);
          break; // corta el resto de destinos de este slot: la cuenta queda pausada
        }
      }
    }
  }
}
