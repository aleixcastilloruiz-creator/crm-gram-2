import { Campaign, CampaignDestination, ScheduleSlot, SourceGroup } from "@prisma/client";
import { getAccountClient } from "../telegram/connectionPool";
import { prisma } from "../utils/prisma";
import { sendWhatsAppNotification } from "../utils/notifications";
import { ensureAccountReady, handlePeerFlood, isFloodError } from "./peerFlood";
import { deliverMessage, getRecentSourceMessages, logSendOutcome, messageAtPosition } from "./sender";
import { shouldAlert, clearAlert } from "./alertThrottle";
import { applySoftStart, consumeSoftStartCycle } from "./peerFlood";

const ALERT_COOLDOWN_MS = 60 * 60_000; // como mucho un WhatsApp por hora para un mismo problema sin resolver

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Desfase (en minutos) entre UTC y `timezone` para el instante `date`. */
function tzOffsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Date.UTC normaliza solo un desbordamiento de "hour" (24 en vez de
  // 0-23) sumando el dia correspondiente - por eso da igual si, para
  // justo la medianoche, Intl devuelve hora "24" (ver comentario en
  // nowInTimezone mas abajo): el resultado es matematicamente correcto
  // de todas formas.
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUTC - date.getTime()) / 60_000;
}

/** "HH:mm" y "YYYY-MM-DD" en la zona horaria de la cuenta. */
export function nowInTimezone(timezone: string): { hhmm: string; date: string; minutesSinceMidnight: number } {
  const now = new Date();
  // OJO: antes esto se sacaba directamente de formatToParts (hour:
  // "2-digit", hour12: false) sobre `now`. Hay un fallo conocido de
  // ICU/V8 por el que, justo en el instante exacto de la medianoche de la
  // zona horaria, ese formato puede devolver hora "24" en vez de "00" -
  // sin tocar la fecha (dia) a la vez. Con eso, minutesSinceMidnight salia
  // ~1440 mientras `date` seguia siendo el dia que estaba terminando, asi
  // que TODOS los horarios fijos del dia (00:00 a 23:00) pasaban el
  // filtro "ya paso su hora" de golpe en ese unico tick, aunque casi
  // ninguno hubiera llegado de verdad todavia - y se marcaban "Horario
  // perdido" en cadena. Esto es justo lo que se vio: una cuenta con
  // horarios cada hora perdiendo TODO el dia de golpe justo al dar la
  // medianoche, y luego pareciendo "arreglarse" al borrar y recrear los
  // horarios (sin ese "ya procesado hoy" de por medio) hasta la siguiente
  // medianoche.
  //
  // Aqui se evita del todo: se calcula el desfase horario de la zona (un
  // numero de minutos, no un texto con hora/dia por separado) y se aplica
  // con aritmetica de Date normal, que SI normaliza bien cualquier
  // desbordamiento.
  const offsetMinutes = tzOffsetMinutes(now, timezone);
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const hh = local.getUTCHours();
  const mm = local.getUTCMinutes();
  return {
    hhmm: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    date: `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`,
    minutesSinceMidnight: hh * 60 + mm,
  };
}

export function toMinutes(hhmm: string): number {
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
    // Una campaña con un problema (origen ilegible, cuenta caida, lo que
    // sea) NO debe cortar el tick para el resto de campañas/cuentas: antes,
    // un error sin capturar aqui abortaba TODO runFixedScheduleTick de
    // golpe (solo quedaba un console.error del servidor, invisible desde el
    // panel), y ademas el slot ya se habia "reclamado" como enviado (ver
    // claimSlotForToday mas abajo) asi que no se reintentaba en todo el dia
    // aunque en realidad nunca se llegara a mandar nada.
    try {
      await runFixedScheduleForCampaign(campaign);
      clearAlert(`fixedTick:${campaign.id}`);
    } catch (err: any) {
      const reason = err?.errorMessage ?? err?.message ?? String(err);
      console.error(`[fixedEngine] error en campaña ${campaign.id} (${campaign.folderName}):`, err);
      await prisma.sendLog
        .create({
          data: {
            accountId: campaign.accountId,
            campaignId: campaign.id,
            level: "ERROR",
            message: `No se pudo procesar el horario fijo de esta campaña: ${reason}`,
          },
        })
        .catch(() => {});
      // Fallo inesperado (cuenta desconectada de Telegram, error de base de
      // datos, etc.) - antes esto solo quedaba en el console.error del
      // servidor (invisible desde fuera de Railway) y, al no "reclamar"
      // ningun slot, se repetia CADA MINUTO mientras el problema durara sin
      // que nadie se enterase salvo mirando la Consola a mano.
      if (campaign.account?.notifyWhatsAppTo && shouldAlert(`fixedTick:${campaign.id}`, ALERT_COOLDOWN_MS)) {
        await sendWhatsAppNotification(
          campaign.account.notifyWhatsAppTo,
          `🛑 ${campaign.account.label}: la campaña "${campaign.folderName}" (horarios fijos) lleva fallando: ${reason}`
        ).catch(() => {});
      }
    }
  }
}

async function runFixedScheduleForCampaign(
  campaign: Campaign & { account: any; sourceGroup: SourceGroup; destinationChats: CampaignDestination[]; scheduleSlots: ScheduleSlot[] }
): Promise<void> {
  let account = await ensureAccountReady(campaign.account);
  if (!account.reenviadorEnabled) return; // interruptor maestro apagado
  if (account.health === "PEER_FLOOD_PAUSED") return;

  const { date: today, minutesSinceMidnight: nowMin } = nowInTimezone(account.timezone);

  const dueSlotsRaw = (campaign.scheduleSlots as ScheduleSlot[]).filter((slot) => {
    if (!slot.active) return false;
    return toMinutes(slot.timeOfDay) <= nowMin; // ya paso su hora hoy (o es ahora mismo)
  });
  if (dueSlotsRaw.length === 0) return;

  // Antes esto no se comprobaba aqui: cada tick (cada minuto, el resto del
  // dia) volvia a intentar "reclamar" TODOS los horarios de hoy que ya
  // hubieran pasado, aunque llevaran horas ya procesados (enviados o
  // perdidos) - claimSlotForToday solo lo detectaba al chocar con la
  // restriccion UNIQUE de la base de datos (error "duplicate key"), que
  // Postgres deja igualmente registrado como ERROR en sus propios logs.
  // Con varias campañas y ~20 horarios/dia cada una, eso son cientos de
  // intentos-y-rechazo redundantes por minuto, TODO EL DIA, sin ninguna
  // razon (el resultado siempre iba a ser el mismo). Filtrando aqui los que
  // ya tienen ScheduleSlotRun de hoy, el tick solo mira los horarios que de
  // verdad quedan por procesar.
  const alreadyRun = await prisma.scheduleSlotRun.findMany({
    where: { scheduleSlotId: { in: dueSlotsRaw.map((s) => s.id) }, runDate: today },
    select: { scheduleSlotId: true },
  });
  const alreadyRunIds = new Set(alreadyRun.map((r) => r.scheduleSlotId));
  const dueSlots = dueSlotsRaw.filter((slot) => !alreadyRunIds.has(slot.id));
  if (dueSlots.length === 0) return;

  // Sin destinos configurados, no hay nada que enviar - se avisa claro en
  // vez de "reclamar" los horarios de hoy en silencio (antes esto pasaba
  // desapercibido: los slots se marcaban como procesados sin que se
  // enviara nada a ningún sitio, y sin ningún aviso visible en el panel).
  // "Seleccionar grupos a los que NO enviar" (checkbox en el panel): un
  // destino excluido sigue guardado pero aquí se salta igual que si no
  // existiera.
  const allDestinations = campaign.destinationChats as CampaignDestination[];
  const destinations = allDestinations.filter((d) => !d.excluded);
  if (destinations.length === 0) {
    const allExcluded = allDestinations.length > 0;
    for (const slot of dueSlots) {
      const claimed = await claimSlotForToday(slot.id, today, "MISSED");
      if (!claimed) continue;
      await prisma.sendLog.create({
        data: {
          accountId: account.id,
          campaignId: campaign.id,
          level: "ERROR",
          message: allExcluded
            ? `Horario ${slot.timeOfDay}: todos los destinos de "${campaign.folderName}" están marcados como "no enviar", así que no se envía nada.`
            : `Horario ${slot.timeOfDay}: esta campaña no tiene ningún destino configurado, así que no se envía nada. Añade al menos un chat destino a "${campaign.folderName}".`,
        },
      });
    }
    if (account.notifyWhatsAppTo && shouldAlert(`fixedNoDest:${campaign.id}`, ALERT_COOLDOWN_MS)) {
      await sendWhatsAppNotification(
        account.notifyWhatsAppTo,
        `⚠️ ${account.label}: la campaña "${campaign.folderName}" (horarios fijos) está Activa pero sin ningún destino configurado, así que no envía nada.`
      ).catch(() => {});
    }
    return;
  }
  clearAlert(`fixedNoDest:${campaign.id}`);

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

    let messages: Awaited<ReturnType<typeof getRecentSourceMessages>>;
    try {
      messages = await getRecentSourceMessages(client, campaign.sourceGroup as SourceGroup);
    } catch (err: any) {
      const reason = err?.errorMessage ?? err?.message ?? String(err);
      await prisma.sendLog.create({
        data: {
          accountId: account.id,
          campaignId: campaign.id,
          level: "ERROR",
          message: `Horario ${slot.timeOfDay}: ${reason}`,
        },
      });
      if (account.notifyWhatsAppTo && shouldAlert(`fixedSourceFail:${campaign.id}`, ALERT_COOLDOWN_MS)) {
        await sendWhatsAppNotification(
          account.notifyWhatsAppTo,
          `🛑 ${account.label}: la campaña "${campaign.folderName}" (horario ${slot.timeOfDay}) no pudo leer el origen: ${reason}`
        ).catch(() => {});
      }
      continue; // este slot ya quedo reclamado (evita reintentos en bucle), pero el resto del tick sigue
    }

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

    // Antes este bucle mandaba a TODOS los destinos de golpe, uno detras de
    // otro sin ninguna pausa (a diferencia del modo Aleatorio, que sí
    // espera minGapSeconds-maxGapSeconds entre cada envio y descansa cada
    // batchSize envios). Con una cuenta que tiene muchos destinos y/o
    // varias campañas de horarios fijos con la misma hora, eso eran
    // decenas de llamadas a la API de Telegram en rafaga sobre la MISMA
    // conexion compartida de la cuenta - justo el patron que la sobrecarga
    // y hace que Telegram deje de responder a tiempo, disparando el
    // "reconectar por timeout" de connectionPool.ts (lo que se ve en el
    // CRM como "los chats dejan de cargar"). Ahora se espacian igual que
    // el modo Aleatorio, reutilizando los mismos ajustes de la campaña.
    let sentInBatch = 0;
    for (const destination of destinations) {
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
      } else if (!outcome.ok) {
        // Cualquier otro fallo de envio a un chat concreto (CHAT_ADMIN_REQUIRED
        // -la cuenta perdio el admin del grupo/canal-, CHAT_WRITE_FORBIDDEN,
        // USER_BANNED_IN_CHANNEL, el chat se borro, etc.) antes solo quedaba
        // en el log de la Consola (nivel ERROR) sin avisar nunca por
        // WhatsApp - a diferencia del PeerFlood, que si notifica. Con
        // muchos destinos, ese fallo podia repetirse dia tras dia en el
        // mismo chat sin que nadie se enterara hasta revisar la Consola a
        // mano. Throttled por campaña+chat destino (no por campaña entera)
        // para poder avisar de un chat con problema aunque el resto vaya
        // bien, sin machacar WhatsApp si ese mismo chat vuelve a fallar en
        // cada horario del dia.
        const reason = (outcome.error as any)?.errorMessage ?? (outcome.error as any)?.message ?? String(outcome.error);
        if (account.notifyWhatsAppTo && shouldAlert(`sendFail:${campaign.id}:${destination.chatId}`, ALERT_COOLDOWN_MS)) {
          await sendWhatsAppNotification(
            account.notifyWhatsAppTo,
            `⚠️ ${account.label}: la campaña "${campaign.folderName}" no pudo enviar a "${destination.chatTitle}": ${reason}`
          ).catch(() => {});
        }
      } else {
        clearAlert(`sendFail:${campaign.id}:${destination.chatId}`);
      }

      sentInBatch += 1;

      const gapSeconds = applySoftStart(account, randomInt(campaign.minGapSeconds, campaign.maxGapSeconds));
      await sleep(gapSeconds * 1000);

      if (sentInBatch >= campaign.batchSize) {
        const restSeconds = applySoftStart(
          account,
          randomInt(campaign.batchRestMinSeconds, campaign.batchRestMaxSeconds)
        );
        await prisma.sendLog.create({
          data: {
            accountId: account.id,
            campaignId: campaign.id,
            level: "WAIT",
            message: `Descanso de lote: ${restSeconds}s tras ${sentInBatch} envios (horario ${slot.timeOfDay})`,
          },
        });
        await sleep(restSeconds * 1000);
        sentInBatch = 0;
      }
    }

    await consumeSoftStartCycle(account);
  }
}
