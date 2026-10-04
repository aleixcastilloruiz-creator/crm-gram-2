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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

function isWithinActiveWindow(activeFrom: string, activeTo: string, timezone: string): boolean {
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return local >= activeFrom && local <= activeTo; // comparacion lexicografica HH:mm funciona aqui
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

  let account = await ensureAccountReady(campaign.account);
  if (!account.reenviadorEnabled) return; // interruptor maestro apagado
  if (account.health === "PEER_FLOOD_PAUSED") return; // sigue en pausa

  if (!isWithinActiveWindow(campaign.activeFrom, campaign.activeTo, account.timezone)) return;

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

  for (const destination of campaign.destinationChats as CampaignDestination[]) {
    // El post mas reciente (album o mensaje suelto) es el que se difunde en modo aleatorio
    const group = messages[0];

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
