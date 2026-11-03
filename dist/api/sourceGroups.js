"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSourceGroupRoutes = registerSourceGroupRoutes;
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const sender_1 = require("../engine/sender");
/** Gestion de los "origenes" (de donde se reenvia el spam) de una cuenta. */
async function registerSourceGroupRoutes(app) {
    app.get("/api/accounts/:accountId/source-groups", async (request) => {
        const { accountId } = request.params;
        const sourceGroups = await prisma_1.prisma.sourceGroup.findMany({
            where: { accountId },
            orderBy: { title: "asc" },
        });
        return { sourceGroups };
    });
    app.post("/api/accounts/:accountId/source-groups", async (request) => {
        const { accountId } = request.params;
        const body = request.body;
        const sourceGroup = await prisma_1.prisma.sourceGroup.create({
            data: {
                accountId,
                title: body.title,
                chatId: body.chatId,
                topicId: body.topicId ?? null,
                topicName: body.topicName ?? null,
                recentLimit: body.recentLimit ?? 25,
            },
        });
        return { sourceGroup };
    });
    app.patch("/api/source-groups/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const sourceGroup = await prisma_1.prisma.sourceGroup.update({ where: { id }, data: body });
        return { sourceGroup };
    });
    // "Comprobar origen": confirma que se puede leer el chat/tema y cuantos
    // posts recientes hay disponibles, sin enviar nada.
    app.post("/api/source-groups/:id/check", async (request, reply) => {
        const { id } = request.params;
        const sourceGroup = await prisma_1.prisma.sourceGroup.findUniqueOrThrow({ where: { id }, include: { account: true } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(sourceGroup.account);
            const messages = await (0, sender_1.getRecentSourceMessages)(client, sourceGroup);
            return { ok: true, postsFound: messages.length };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo leer el origen desde Telegram. Revisa el chatId/topicId." });
        }
    });
    app.delete("/api/source-groups/:id", async (request, reply) => {
        const { id } = request.params;
        const inUse = await prisma_1.prisma.campaign.count({ where: { sourceGroupId: id } });
        if (inUse > 0) {
            return reply.code(409).send({
                error: `Este origen esta en uso por ${inUse} campaña(s). Borra o reasigna esas campañas primero.`,
            });
        }
        await prisma_1.prisma.sourceGroup.delete({ where: { id } });
        return { ok: true };
    });
}
//# sourceMappingURL=sourceGroups.js.map