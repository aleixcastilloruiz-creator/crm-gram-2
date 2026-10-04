"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRandomCampaignCycle = runRandomCampaignCycle;
const connectionPool_1 = require("../telegram/connectionPool");
const prisma_1 = require("../utils/prisma");
const peerFlood_1 = require("./peerFlood");
const sender_1 = require("./sender");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
function isWithinActiveWindow(activeFrom, activeTo, timezone) {
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
async function runRandomCampaignCycle(campaignId) {
    const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        include: { account: true, sourceGroup: true, destinationChats: true },
    });
    if (campaign.status !== "ACTIVE" || campaign.scheduleMode !== "RANDOM")
        return;
    let account = await (0, peerFlood_1.ensureAccountReady)(campaign.account);
    if (!account.reenviadorEnabled)
        return; // interruptor maestro apagado
    if (account.health === "PEER_FLOOD_PAUSED")
        return; // sigue en pausa
    if (!isWithinActiveWindow(campaign.activeFrom, campaign.activeTo, account.timezone))
        return;
    const client = await (0, connectionPool_1.getAccountClient)(account); // conexion persistente, compartida con otras campañas de la cuenta
    let sentInBatch = 0;
    const messages = await (0, sender_1.getRecentSourceMessages)(client, campaign.sourceGroup);
    if (messages.length === 0) {
        await prisma_1.prisma.sendLog.create({
            data: {
                accountId: account.id,
                campaignId: campaign.id,
                level: "WAIT",
                message: `Sin mensajes nuevos en el origen "${campaign.sourceGroup.title}"`,
            },
        });
        return;
    }
    for (const destination of campaign.destinationChats) {
        // El post mas reciente (album o mensaje suelto) es el que se difunde en modo aleatorio
        const group = messages[0];
        const outcome = await (0, sender_1.deliverMessage)(client, campaign, campaign.sourceGroup, destination, group);
        await (0, sender_1.logSendOutcome)({
            accountId: account.id,
            campaignId: campaign.id,
            chatTitle: destination.chatTitle,
            outcome,
            sourceMessageId: group[0].id,
        });
        if (!outcome.ok && (0, peerFlood_1.isFloodError)(outcome.error)) {
            await (0, peerFlood_1.handlePeerFlood)(account, outcome.error);
            return; // corta el ciclo: la cuenta queda pausada
        }
        sentInBatch += 1;
        const gapSeconds = (0, peerFlood_1.applySoftStart)(account, randomInt(campaign.minGapSeconds, campaign.maxGapSeconds));
        await sleep(gapSeconds * 1000);
        if (sentInBatch >= campaign.batchSize) {
            const restSeconds = (0, peerFlood_1.applySoftStart)(account, randomInt(campaign.batchRestMinSeconds, campaign.batchRestMaxSeconds));
            await prisma_1.prisma.sendLog.create({
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
    await (0, peerFlood_1.consumeSoftStartCycle)(account);
}
//# sourceMappingURL=randomEngine.js.map