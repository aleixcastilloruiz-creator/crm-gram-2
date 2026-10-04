"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLogsRoutes = registerLogsRoutes;
const prisma_1 = require("../utils/prisma");
const agencyContext_1 = require("../utils/agencyContext");
/**
 * GET /api/logs?accountId=&campaignId=&level=&search=&limit=
 * Equivale a la "Consola" del panel: filtra por cuenta, campaña/carpeta,
 * nivel (Publicados/Problemas/Esperas) y texto libre.
 *
 * Esta ruta NO lleva el id de ninguna cuenta en la URL (va en la query, si
 * acaso), así que el guardia general de index.ts (que solo mira
 * /api/accounts/:id/... en la URL) no la protege por su cuenta - sin este
 * filtro por agencia aquí dentro, cualquier agencia podría ver los logs de
 * TODAS las demás con solo pedir /api/logs sin accountId, o colar el id de
 * una cuenta ajena en ?accountId=.
 */
async function registerLogsRoutes(app) {
    app.get("/api/logs", async (request) => {
        const q = request.query;
        const callerAgencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        let accountFilter;
        if (q.accountId) {
            const account = await prisma_1.prisma.account.findUnique({ where: { id: q.accountId }, select: { agencyId: true } });
            if (!account || account.agencyId !== callerAgencyId) {
                return { logs: [], total: 0, errorCount: 0 };
            }
            accountFilter = q.accountId;
        }
        else {
            const agencyAccounts = await prisma_1.prisma.account.findMany({ where: { agencyId: callerAgencyId }, select: { id: true } });
            accountFilter = { in: agencyAccounts.map((a) => a.id) };
        }
        const where = {
            accountId: accountFilter,
            campaignId: q.campaignId,
            level: q.level,
            message: q.search ? { contains: q.search, mode: "insensitive" } : undefined,
        };
        const [logsRaw, total, errorCount] = await Promise.all([
            prisma_1.prisma.sendLog.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: Math.min(Number(q.limit) || 200, 1000),
                include: { campaign: { select: { folderName: true } } },
            }),
            prisma_1.prisma.sendLog.count({ where: { accountId: accountFilter, campaignId: q.campaignId } }),
            prisma_1.prisma.sendLog.count({ where: { accountId: accountFilter, campaignId: q.campaignId, level: "ERROR" } }),
        ]);
        // "folderName" al mismo nivel que el resto de campos del log (no anidado
        // en "campaign"), para que la Consola pueda pintar a qué carpeta
        // corresponde cada línea sin tener que ir a buscarlo aparte. Los logs
        // que no son de ninguna campaña (ej. avisos generales de la cuenta) se
        // quedan sin folderName, y el panel simplemente no muestra esa etiqueta.
        const logs = logsRaw.map(({ campaign, ...log }) => ({ ...log, folderName: campaign?.folderName ?? null }));
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