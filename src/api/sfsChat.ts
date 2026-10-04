import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { getAccountClient, invalidateAccountClient } from "../telegram/connectionPool";
import { getCachedAllDialogs } from "../telegram/dialogsCache";
import { resolveDialogEntity } from "../telegram/dialogs";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`__TIMEOUT__ Tiempo de espera agotado ${label}.`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Ver messages.ts: distingue un timeout de withTimeout (conexión
 * probablemente colgada/zombi, hay que descartarla del pool) de un error
 * normal de Telegram. */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("__TIMEOUT__");
}

/** Ver messages.ts (isDeadAuthKeyError): AUTH_KEY_DUPLICATED y primos son
 * otro caso, además del timeout, en el que hay que descartar la conexión
 * del pool para que la siguiente petición abra una nueva en vez de repetir
 * siempre contra la misma ya rechazada por Telegram. */
function isDeadAuthKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /AUTH_KEY_DUPLICATED|AUTH_KEY_INVALID|AUTH_KEY_UNREGISTERED/.test(err.message);
}

function shouldInvalidateConnection(err: unknown): boolean {
  return isTimeoutError(err) || isDeadAuthKeyError(err);
}

/**
 * "SFS" (Shoutout For Shoutout) → Chat: reutiliza EXACTAMENTE los mismos
 * chats de Telegram que "Mensajes" (misma cuenta, mismo chatId: no hay
 * ninguna tabla nueva de conversaciones, dialogos ni mensajes). Lo único
 * propio de este apartado es la nota - independiente de la nota de fan de
 * siempre (FanNote), guardada aparte en SfsNote - para que un mismo chat
 * pueda tener nota de fan Y nota de SFS a la vez, sin pisarse.
 *
 * Sin preHandler de permisos por ahora (como Grupos de promoción): solo lo
 * ve el dueño de la cuenta, no hay reparto por trabajador todavía.
 */
export async function registerSfsChatRoutes(app: FastifyInstance) {
  // Lista de conversaciones propia de SFS: a diferencia de "Mensajes" (solo
  // chats de fans + grupos pequeños/registrados), aquí se ven TODOS los
  // grupos y canales de la cuenta - los SFS de verdad se coordinan en
  // grupos grandes, que "Mensajes" deja fuera a propósito (ver dialogs.ts).
  app.get("/api/accounts/:id/sfs-dialogs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { search?: string; force?: string };
    const forceRefresh = q.force === "1" || q.force === "true";
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      let dialogs = await withTimeout(getCachedAllDialogs(client, id, forceRefresh), 120_000, "cargando los chats de SFS");
      if (q.search) {
        const s = q.search.toLowerCase();
        dialogs = dialogs.filter((d) => d.title.toLowerCase().includes(s) || d.lastMessage.toLowerCase().includes(s));
      }
      return { dialogs };
    } catch (err) {
      request.log.error(err);
      if (shouldInvalidateConnection(err)) invalidateAccountClient(id);
      return reply.code(502).send({ error: "No se pudieron leer los chats de Telegram. Revisa la conexión de la cuenta." });
    }
  });

  // "Grupo SFS": reenvía UN mensaje ya existente (de cualquier chat de esta
  // cuenta) al canal/grupo fijo guardado en Account.sfsGroupChatId. Con
  // hideSender=true (por defecto, checkbox "Ocultar remitente" del panel)
  // se usa forwardMessages con dropAuthor: llega como si lo hubiese
  // publicado la propia cuenta, sin el "Reenviado de..." de Telegram -
  // mismo mecanismo que ya usa la Bóveda de contenido (ver
  // contentLibrary.ts) y el propio Reenviador (engine/sender.ts).
  app.post("/api/accounts/:id/sfs-group/forward", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { chatId?: string; messageId?: number; hideSender?: boolean };
    if (!body.chatId || !body.messageId) {
      return reply.code(400).send({ error: "Falta el chat de origen o el mensaje a reenviar" });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.sfsGroupChatId) {
      return reply.code(400).send({ error: "Elige antes un canal/grupo fijo para SFS." });
    }
    try {
      const client = await getAccountClient(account);
      const sourceEntity = await resolveDialogEntity(client, id, body.chatId);
      const destEntity = await resolveDialogEntity(client, id, account.sfsGroupChatId);
      await client.forwardMessages(destEntity, {
        messages: [body.messageId],
        fromPeer: sourceEntity,
        dropAuthor: body.hideSender !== false,
      });
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo reenviar el mensaje al grupo SFS." });
    }
  });

  app.get("/api/accounts/:id/dialogs/:chatId/sfs-note", async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const note = await prisma.sfsNote.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
    return { note: note?.note || "" };
  });

  app.put("/api/accounts/:id/dialogs/:chatId/sfs-note", async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as { note?: string };
    const note = body.note ?? "";
    await prisma.sfsNote.upsert({
      where: { accountId_chatId: { accountId: id, chatId } },
      update: { note },
      create: { accountId: id, chatId, note },
    });
    return { ok: true };
  });
}
