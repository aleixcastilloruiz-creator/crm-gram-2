import { Campaign, CampaignDestination, SourceGroup } from "@prisma/client";
import { getAccountClient } from "../telegram/connectionPool";
import { prisma } from "../utils/prisma";
import {
  ensureAccountReady,
  handlePeerFlood,
  isFloodError,
  applySoftStart,
  consumeSoftStartCycle,
} from "./peerFlood";
import { deliverMessage, getRecentSourceMessages, logSendOutcome } from "./sender";
import { nowInTimezone } from "./fixedEngine";
import { sendWhatsAppNotification } from "../utils/notifications";
import { shouldAlert, clearAlert } from "./alertThrottle";

const ALERT_COOLDOWN_MS = 60 * 60_000; // como mucho un WhatsApp por hora para un mismo problema sin resolver

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// Antes esto calculaba "HH:mm" con su propio Intl.DateTimeFormat suelto,
// con el mismo fallo que se encontro en fixedEngine.ts: justo en el
// instante de la medianoche de la zona horaria, algunos entornos dan hora
// "24" en vez de "00", lo que aqui habria hecho fallar la comparacion
// ("24:00" > cualquier activeTo normal) y saltarse ese ciclo sin motivo.
// Reutiliza el mismo calculo ya blindado contra eso.
function isWithinActiveWindow(activeFrom: string, activeTo: string, timezone: string): boolean {
  const { hhmm } = nowInTimezone(timezone);
  if (activeFrom <= activeTo) {
    return hhmm >= activeFrom && hhmm <= activeTo; // comparacion lexicografica HH:mm funciona aqui
  }
  // Horario "de madrugada" que cruza la medianoche (p.ej. 22:00 -> 06:00):
  // con la comparacion de arriba NUNCA se cumplirian las dos condiciones a
  // la vez (ninguna hora es a la vez >= "22:00" y <= "06:00"), asi que la
  // campaña se quedaba "Activa" en el panel pero sin enviar nunca nada, sin
  // ningun aviso - parecia un bug de envio cuando en realidad era este
  // chequeo del horario. Si activeFrom > activeTo, la ventana cruza la
  // medianoche: esta dentro si ya es >= la hora de inicio (mismo dia) O
  // todavia <= la hora de fin (ya el dia siguiente).
  return hhmm >= activeFrom || hhmm <= activeTo;
}

/**
 * Ejecuta un ciclo de la campaña en modo "Aleatorio": recorre los chats
 * destino de la carpeta enviando con pausas aleatorias entre min/max
 * segundos, y un descanso mas largo cada N envios (lote), respetando el
 * horario activo y la pausa/arranque-suave por PeerFlood de la cuenta.
 */
export async function runRandomCampaignCycle(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { account: true, sourceGroup: true, destinationChats: true },
  });

  if (campaign.status !== "ACTIVE" || campaign.scheduleMode !== "RANDOM") return;

  try {
    await runRandomCampaignCycleInner(campaign);
    clearAlert(`randomCycle:${campaign.id}`);
  } catch (err: any) {
    // Antes un fallo aqui (cuenta desconectada de Telegram, error de base de
    // datos, cualquier cosa no prevista) solo se veia en el console.error
    // del propio orquestador (startRandomLoop) - invisible fuera de los
    // logs de Railway, y se repetia cada `cycleSeconds` sin ningun aviso.
    const reason = err?.errorMessage ?? err?.message ?? String(err);
    console.error(`[randomEngine] error en campaña ${campaign.id} (${campaign.folderName}):`, err);
    await prisma.sendLog
      .create({
        data: {
          accountId: campaign.accountId,
          campaignId: campaign.id,
          level: "ERROR",
          message: `No se pudo procesar el ciclo Aleatorio de esta campaña: ${reason}`,
        },
      })
      .catch(() => {});
    if (campaign.account?.notifyWhatsAppTo && shouldAlert(`randomCycle:${campaign.id}`, ALERT_COOLDOWN_MS)) {
      await sendWhatsAppNotification(
        campaign.account.notifyWhatsAppTo,
        `🛑 ${campaign.account.label}: la campaña "${campaign.folderName}" (modo Aleatorio) lleva fallando: ${reason}`
      ).catch(() => {});
    }
  }
}

async function runRandomCampaignCycleInner(
  campaign: Campaign & { account: any; sourceGroup: SourceGroup; destinationChats: CampaignDestination[] }
): Promise<void> {
  let account = await ensureAccountReady(campaign.account);
  if (!account.reenviadorEnabled) return; // interruptor maestro apagado
  if (account.health === "PEER_FLOOD_PAUSED") return; // sigue en pausa

  if (!isWithinActiveWindow(campaign.activeFrom, campaign.activeTo, account.timezone)) return;

  // "Seleccionar grupos a los que NO enviar" (checkbox en el panel): un
  // destino excluido sigue guardado (por si se reactiva más adelante) pero
  // aquí se salta, exactamente igual que si no existiera.
  const destinationsList = (campaign.destinationChats as CampaignDestination[]).filter((d) => !d.excluded);
  if (destinationsList.length === 0) {
    // Antes esto pasaba totalmente desapercibido: una campaña Activa con 0
    // destinos (p.ej. porque al crearla desde una carpeta grande Telegram no
    // pudo resolver ninguno de sus chats, o se limitaron por un FLOOD_WAIT
    // justo en ese momento) simplemente no hacia nada en cada ciclo, sin
    // ningun aviso en la Consola - parecia una campaña "Activa" normal que
    // sencillamente nunca enviaba nada, indistinguible de un bug en el envio.
    const allExcluded = campaign.destinationChats.length > 0;
    await prisma.sendLog.create({
      data: {
        accountId: account.id,
        campaignId: campaign.id,
        level: "ERROR",
        message: allExcluded
          ? `Campaña "${campaign.folderName}" esta Activa pero todos sus destinos estan marcados como "no enviar", asi que no envia nada.`
          : `Campaña "${campaign.folderName}" esta Activa pero no tiene ningun destino configurado, asi que no envia nada. Revisa/vuelve a añadir la carpeta.`,
      },
    });
    if (account.notifyWhatsAppTo && shouldAlert(`randomNoDest:${campaign.id}`, ALERT_COOLDOWN_MS)) {
      await sendWhatsAppNotification(
        account.notifyWhatsAppTo,
        `⚠️ ${account.label}: la campaña "${campaign.folderName}" (modo Aleatorio) está Activa pero sin ningún destino ${allExcluded ? "sin excluir" : "configurado"}, así que no envía nada.`
      ).catch(() => {});
    }
    return;
  }
  clearAlert(`randomNoDest:${campaign.id}`);

  const client = await getAccountClient(account); // conexion persistente, compartida con otras campañas de la cuenta
  let sentInBatch = 0;

  const messages = await getRecentSourceMessages(client, campaign.sourceGroup as SourceGroup);
  if (messages.length === 0) {
    await prisma.sendLog.create({
      data: {
        accountId: account.id,
        campaignId: campaign.id,
        level: "WAIT",
        message: `Sin mensajes nuevos en el origen "${campaign.sourceGroup.title}"`,
      },
    });
    return;
  }

  for (const destination of destinationsList) {
    // El post mas reciente (album o mensaje suelto) es el que se difunde en
    // modo aleatorio - getRecentSourceMessages ahora devuelve posicion 1 =
    // el mas antiguo, asi que el mas reciente es el ULTIMO del array (antes
    // era messages[0], cuando el orden era al reves).
    const group = messages[messages.length - 1];

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
      return; // corta el ciclo: la cuenta queda pausada
    } else if (!outcome.ok) {
      // Igual que en fixedEngine.ts: cualquier fallo que no sea FloodWait
      // (CHAT_ADMIN_REQUIRED, chat borrado, expulsada, etc.) antes solo
      // quedaba en el log de la Consola sin avisar nunca por WhatsApp.
      // Throttled por campaña+chat destino, no por campaña entera.
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
          message: `Descanso de lote: ${restSeconds}s tras ${sentInBatch} envios`,
        },
      });
      await sleep(restSeconds * 1000);
      sentInBatch = 0;
    }
  }

  await consumeSoftStartCycle(account);
}
