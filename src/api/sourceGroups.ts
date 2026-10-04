import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "../telegram/connectionPool";
import { getRecentSourceMessages } from "../engine/sender";

/** Gestion de los "origenes" (de donde se reenvia el spam) de una cuenta. */
export async function registerSourceGroupRoutes(app: FastifyInstance) {
  app.get("/api/accounts/:accountId/source-groups", async (request) => {
    const { accountId } = request.params as { accountId: string };
    const sourceGroups = await prisma.sourceGroup.findMany({
      where: { accountId },
      orderBy: { title: "asc" },
    });
    return { sourceGroups };
  });

  app.post("/api/accounts/:accountId/source-groups", async (request) => {
    const { accountId } = request.params as { accountId: string };
    const body = request.body as {
      title: string;
      chatId: string;
      topicId?: number | null;
      topicName?: string | null;
      recentLimit?: number;
    };

    const sourceGroup = await prisma.sourceGroup.create({
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
    const { id } = request.params as { id: string };
    const body = request.body as Partial<{
      title: string;
      chatId: string;
      topicId: number | null;
      topicName: string | null;
      recentLimit: number;
    }>;
    const sourceGroup = await prisma.sourceGroup.update({ where: { id }, data: body });
    return { sourceGroup };
  });

  // "Comprobar origen": confirma que se puede leer el chat/tema y cuantos
  // posts recientes hay disponibles, sin enviar nada.
  app.post("/api/source-groups/:id/check", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sourceGroup = await prisma.sourceGroup.findUniqueOrThrow({ where: { id }, include: { account: true } });
    try {
      const client = await getAccountClient(sourceGroup.account);
      const messages = await getRecentSourceMessages(client, sourceGroup);
      return { ok: true, postsFound: messages.length };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo leer el origen desde Telegram. Revisa el chatId/topicId." });
    }
  });

  app.delete("/api/source-groups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const inUse = await prisma.campaign.count({ where: { sourceGroupId: id } });
    if (inUse > 0) {
      return reply.code(409).send({
        error: `Este origen esta en uso por ${inUse} campaña(s). Borra o reasigna esas campañas primero.`,
      });
    }
    await prisma.sourceGroup.delete({ where: { id } });
    return { ok: true };
  });
}
