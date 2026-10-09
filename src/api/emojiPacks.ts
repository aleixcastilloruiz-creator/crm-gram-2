import { FastifyInstance } from "fastify";
import { Api } from "telegram";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "../telegram/connectionPool";
import { resolveDialogEntity } from "../telegram/dialogs";
import { getCachedMedia, setCachedMedia } from "../telegram/mediaCache";

const MAX_PACKS_PER_ACCOUNT = 100;

/**
 * "Emoji premium": sets de emoji animados/custom de Telegram enlazados a
 * cada cuenta (modelo), para poder mandarlos en el chat igual que en el
 * panel de referencia. Solo funcionan de verdad (se ven animados, no como
 * texto plano) si la cuenta de Telegram tiene Premium.
 */

// Cache muy corta (evita pedirle el set entero a Telegram en cada miniatura).
interface SetCacheEntry { set: any; loadedAt: number }
const setCache = new Map<string, SetCacheEntry>();
const SET_CACHE_TTL_MS = 10 * 60 * 1000;

function parseShortName(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/addemoji\/([a-zA-Z0-9_]+)/) || trimmed.match(/addstickers\/([a-zA-Z0-9_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_]+$/.test(trimmed)) return trimmed;
  return null;
}

async function getStickerSet(client: any, accountId: string, shortName: string) {
  const key = `${accountId}:${shortName}`;
  const cached = setCache.get(key);
  if (cached && Date.now() - cached.loadedAt < SET_CACHE_TTL_MS) return cached.set;
  const set = await client.invoke(
    new Api.messages.GetStickerSet({
      stickerset: new Api.InputStickerSetShortName({ shortName }),
      hash: 0,
    })
  );
  setCache.set(key, { set, loadedAt: Date.now() });
  return set;
}

export async function registerEmojiPackRoutes(app: FastifyInstance) {
  app.get("/api/accounts/:id/emoji-packs", async (request) => {
    const { id } = request.params as { id: string };
    const packs = await prisma.accountEmojiPack.findMany({ where: { accountId: id }, orderBy: { createdAt: "asc" } });
    return { packs };
  });

  app.post("/api/accounts/:id/emoji-packs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { input?: string };
    const shortName = parseShortName(body.input || "");
    if (!shortName) {
      return reply.code(400).send({ error: "No he reconocido ese link/nombre de pack de emoji." });
    }
    const count = await prisma.accountEmojiPack.count({ where: { accountId: id } });
    if (count >= MAX_PACKS_PER_ACCOUNT) {
      return reply.code(400).send({ error: `Máximo ${MAX_PACKS_PER_ACCOUNT} packs por cuenta.` });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const set = await getStickerSet(client, id, shortName);
      const title = (set as any).set?.title || shortName;
      const pack = await prisma.accountEmojiPack.create({ data: { accountId: id, shortName, title } });
      return { pack };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se ha podido encontrar/leer ese pack en Telegram. Comprueba el link." });
    }
  });

  app.delete("/api/emoji-packs/:id", async (request) => {
    const { id } = request.params as { id: string };
    await prisma.accountEmojiPack.delete({ where: { id } });
    return { ok: true };
  });

  app.get("/api/accounts/:id/emoji-packs/:packId/emojis", async (request, reply) => {
    const { id, packId } = request.params as { id: string; packId: string };
    const pack = await prisma.accountEmojiPack.findUnique({ where: { id: packId } });
    if (!pack || pack.accountId !== id) return reply.code(404).send({ error: "Pack no encontrado" });
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const set = await getStickerSet(client, id, pack.shortName);
      const realTitle = (set as any).set?.title;
      if (realTitle && pack.title !== realTitle) {
        prisma.accountEmojiPack.update({ where: { id: pack.id }, data: { title: realTitle } }).catch(() => {});
      }
      const docs = (set as any).documents ?? [];
      const emojis = docs.map((d: any) => {
        const altAttr = (d.attributes || []).find((a: any) => a.className === "DocumentAttributeCustomEmoji" || a.alt !== undefined);
        return { documentId: d.id.toString(), alt: altAttr?.alt || "🙂" };
      });
      return { emojis };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo leer el contenido del pack." });
    }
  });

  app.get("/api/accounts/:id/emoji-packs/:packId/emoji-thumb/:documentId", async (request, reply) => {
    const { id, packId, documentId } = request.params as { id: string; packId: string; documentId: string };
    const cacheKey = `emoji-thumb:${id}:${documentId}`;
    const cached = getCachedMedia(cacheKey);
    if (cached) {
      reply.header("Content-Type", "image/webp");
      reply.header("Cache-Control", "private, max-age=86400");
      return reply.send(cached);
    }
    const pack = await prisma.accountEmojiPack.findUnique({ where: { id: packId } });
    if (!pack || pack.accountId !== id) return reply.code(404).send();
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const set = await getStickerSet(client, id, pack.shortName);
      const doc = (set as any).documents?.find((d: any) => d.id.toString() === documentId);
      if (!doc) return reply.code(404).send();
      const buf = (await client.downloadMedia(doc, { thumb: 0 })) as Buffer | undefined;
      if (!buf) return reply.code(404).send();
      setCachedMedia(cacheKey, buf);
      reply.header("Content-Type", "image/webp");
      reply.header("Cache-Control", "private, max-age=86400");
      return reply.send(buf);
    } catch (err) {
      request.log.error(err);
      return reply.code(404).send();
    }
  });

  // Manda un emoji premium/custom al chat abierto, como mensaje propio (no
  // se inserta dentro del texto: se manda solo, como si fuese un sticker).
  app.post("/api/accounts/:id/dialogs/:chatId/send-custom-emoji", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as { packId?: string; documentId?: string };
    if (!body.packId || !body.documentId) return reply.code(400).send({ error: "Falta el emoji a enviar" });
    const pack = await prisma.accountEmojiPack.findUnique({ where: { id: body.packId } });
    if (!pack || pack.accountId !== id) return reply.code(404).send({ error: "Pack no encontrado" });
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const set = await getStickerSet(client, id, pack.shortName);
      const doc = (set as any).documents?.find((d: any) => d.id.toString() === body.documentId);
      if (!doc) return reply.code(404).send({ error: "Emoji no encontrado en el pack" });
      const altAttr = (doc.attributes || []).find((a: any) => a.className === "DocumentAttributeCustomEmoji" || a.alt !== undefined);
      const alt = altAttr?.alt || "🙂";
      const entity = await resolveDialogEntity(client, id, chatId);
      await client.sendMessage(entity, {
        message: alt,
        formattingEntities: [
          new Api.MessageEntityCustomEmoji({ offset: 0, length: alt.length, documentId: doc.id }),
        ],
      });
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      const msg = err?.errorMessage || err?.message || "";
      if (msg.includes("PREMIUM")) {
        return reply.code(502).send({ error: "Esta cuenta no tiene Telegram Premium: no puede enviar emoji premium animados." });
      }
      return reply.code(502).send({ error: msg || "No se pudo enviar el emoji." });
    }
  });
}
