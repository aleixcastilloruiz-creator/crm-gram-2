import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";

/**
 * GET /api/logs?accountId=&campaignId=&level=&search=&limit=
 * Equivale a la "Consola" del panel: filtra por cuenta, campaña/carpeta,
 * nivel (Publicados/Problemas/Esperas) y texto libre.
 */
export async function registerLogsRoutes(app: FastifyInstance) {
  app.get("/api/logs", async (request) => {
    const q = request.query as {
      accountId?: string;
      campaignId?: string;
      level?: "SENT" | "ERROR" | "WAIT" | "INFO";
      search?: string;
      limit?: string;
    };

    const logs = await prisma.sendLog.findMany({
      where: {
        accountId: q.accountId,
        campaignId: q.campaignId,
        level: q.level,
        message: q.search ? { contains: q.search, mode: "insensitive" } : undefined,
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(q.limit) || 200, 1000),
    });

    return { logs };
  });

  app.get("/api/accounts/:id/status", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const [sentToday, errorsToday] = await Promise.all([
      prisma.sendLog.count({
        where: { accountId: id, level: "SENT", createdAt: { gte: startOfToday() } },
      }),
      prisma.sendLog.count({
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

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
