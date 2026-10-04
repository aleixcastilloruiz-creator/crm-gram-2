"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLogsRoutes = registerLogsRoutes;
const prisma_1 = require("../utils/prisma");
/**
 * GET /api/logs?accountId=&campaignId=&level=&search=&limit=
 * Equivale a la "Consola" del panel: filtra por cuenta, campaña/carpeta,
 * nivel (Publicados/Problemas/Esperas) y texto libre.
 */
async function registerLogsRoutes(app) {
    app.get("/api/logs", async (request) => {
        const q = request.query;
        const where = {
            accountId: q.accountId,
            campaignId: q.campaignId,
            level: q.level,
            message: q.search ? { contains: q.search, mode: "insensitive" } : undefined,
        };
        const [logs, total, errorCount] = await Promise.all([
            prisma_1.prisma.sendLog.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: Math.min(Number(q.limit) || 200, 1000),
            }),
            prisma_1.prisma.sendLog.count({ where: { accountId: q.accountId, campaignId: q.campaignId } }),
            prisma_1.prisma.sendLog.count({ where: { accountId: q.accountId, campaignId: q.campaignId, level: "ERROR" } }),
        ]);
        return { logs, total, errorCount };
    });
    app.get("/api/accounts/:id/status", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        const [sentToday, errorsToday] = await Promise.all([
            prisma_1.prisma.sendLog.count({
                where: { accountId: id, level: "SENT", createdAt: { gte: startOfToday() } },
            }),
            prisma_1.prisma.sendLog.count({
                where: { accountId: id, level: "ERROR", createdAt: { gte: startOfToday() } },
            }),
        ]);
        return {
            label: account.label,
            health: account.health,
            peerFloodUntil: account.peerFloodUntil,
            sentToday,
            errorsToday,
        };
    });
}
function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}
//# sourceMappingURL=logs.js.map