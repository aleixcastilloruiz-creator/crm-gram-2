"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCampaignRoutes = registerCampaignRoutes;
const prisma_1 = require("../utils/prisma");
/**
 * Gestion de campañas: crear/editar/pausar/activar, y sus destinos.
 * IMPORTANTE (seguridad): activar una campaña (status ACTIVE) NO envia nada
 * por si sola si el interruptor maestro de la cuenta (reenviadorEnabled)
 * sigue apagado. El panel debe dejar esto claro en la interfaz.
 */
async function registerCampaignRoutes(app) {
    app.get("/api/accounts/:accountId/campaigns", async (request) => {
        const { accountId } = request.params;
        const campaigns = await prisma_1.prisma.campaign.findMany({
            where: { accountId },
            orderBy: { createdAt: "desc" },
            include: {
                sourceGroup: true,
                destinationChats: true,
                _count: { select: { destinationChats: true } },
            },
        });
        const lastSent = await prisma_1.prisma.sendLog.groupBy({
            by: ["campaignId"],
            where: { accountId, level: "SENT", campaignId: { in: campaigns.map((c) => c.id) } },
            _max: { createdAt: true },
        });
        const lastSentMap = new Map(lastSent.map((l) => [l.campaignId, l._max.createdAt]));
        return {
            campaigns: campaigns.map((c) => ({ ...c, lastSentAt: lastSentMap.get(c.id) ?? null })),
        };
    });
    app.get("/api/campaigns/:id", async (request) => {
        const { id } = request.params;
        const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({
            where: { id },
            include: { sourceGroup: true, destinationChats: true, account: true },
        });
        return { campaign };
    });
    app.post("/api/accounts/:accountId/campaigns", async (request) => {
        const { accountId } = request.params;
        const body = request.body;
        const campaign = await prisma_1.prisma.campaign.create({
            data: {
                accountId,
                sourceGroupId: body.sourceGroupId,
                folderName: body.folderName,
                status: "PAUSED", // las campañas nuevas siempre nacen en pausa, por seguridad
                sendMode: body.sendMode ?? "FORWARD_NO_AUTHOR",
                scheduleMode: body.scheduleMode ?? "RANDOM",
                cycleSeconds: body.cycleSeconds ?? 2700,
                minGapSeconds: body.minGapSeconds ?? 2,
                maxGapSeconds: body.maxGapSeconds ?? 7,
                batchSize: body.batchSize ?? 60,
                batchRestMinSeconds: body.batchRestMinSeconds ?? 30,
                batchRestMaxSeconds: body.batchRestMaxSeconds ?? 60,
                activeFrom: body.activeFrom ?? "00:00",
                activeTo: body.activeTo ?? "23:59",
            },
        });
        return { campaign };
    });
    app.patch("/api/campaigns/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const campaign = await prisma_1.prisma.campaign.update({ where: { id }, data: body });
        if (body.status) {
            await prisma_1.prisma.sendLog.create({
                data: {
                    accountId: campaign.accountId,
                    campaignId: campaign.id,
                    level: "INFO",
                    message: body.status === "ACTIVE"
                        ? `Campaña "${campaign.folderName}" activada desde el panel`
                        : `Campaña "${campaign.folderName}" pausada desde el panel`,
                },
            });
        }
        return { campaign };
    });
    app.delete("/api/campaigns/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.campaign.delete({ where: { id } });
        return { ok: true };
    });
    // --- Destinos de una campaña ---
    app.post("/api/campaigns/:id/destinations", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const destination = await prisma_1.prisma.campaignDestination.create({
            data: {
                campaignId: id,
                chatId: body.chatId,
                chatTitle: body.chatTitle,
                topicId: body.topicId ?? null,
            },
        });
        return { destination };
    });
    app.delete("/api/destinations/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.campaignDestination.delete({ where: { id } });
        return { ok: true };
    });
}
//# sourceMappingURL=campaigns.js.map