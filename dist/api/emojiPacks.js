"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEmojiPackRoutes = registerEmojiPackRoutes;
const telegram_1 = require("telegram");
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const dialogs_1 = require("../telegram/dialogs");
const mediaCache_1 = require("../telegram/mediaCache");
const MAX_PACKS_PER_ACCOUNT = 20;
const setCache = new Map();
const SET_CACHE_TTL_MS = 10 * 60 * 1000;
function parseShortName(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return null;
    const m = trimmed.match(/addemoji\/([a-zA-Z0-9_]+)/) || trimmed.match(/addstickers\/([a-zA-Z0-9_]+)/);
    if (m)
        return m[1];
    if (/^[a-zA-Z0-9_]+$/.test(trimmed))
        return trimmed;
    return null;
}
async function getStickerSet(client, accountId, shortName) {
    const key = `${accountId}:${shortName}`;
    const cached = setCache.get(key);
    if (cached && Date.now() - cached.loadedAt < SET_CACHE_TTL_MS)
        return cached.set;
    const set = await client.invoke(new telegram_1.Api.messages.GetStickerSet({
        stickerset: new telegram_1.Api.InputStickerSetShortName({ shortName }),
        hash: 0,
    }));
    setCache.set(key, { set, loadedAt: Date.now() });
    return set;
}
async function registerEmojiPackRoutes(app) {
    app.get("/api/accounts/:id/emoji-packs", async (request) => {
        const { id } = request.params;
        const packs = await prisma_1.prisma.accountEmojiPack.findMany({ where: { accountId: id }, orderBy: { createdAt: "asc" } });
        return { packs };
    });
    app.post("/api/accounts/:id/emoji-packs", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const shortName = parseShortName(body.input || "");
        if (!shortName) {
            return reply.code(400).send({ error: "No he reconocido ese link/nombre de pack de emoji." });
        }
        const count = await prisma_1.prisma.accountEmojiPack.count({ where: { accountId: id } });
        if (count >= MAX_PACKS_PER_ACCOUNT) {
            return reply.code(400).send({ error: `Máximo ${MAX_PACKS_PER_ACCOUNT} packs por cuenta.` });
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const set = await getStickerSet(client, id, shortName);
            const title = set.set?.title || shortName;
            const pack = await prisma_1.prisma.accountEmojiPack.create({ data: { accountId: id, shortName, title } });
            return { pack };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se ha podido encontrar/leer ese pack en Telegram. Comprueba el link." });
        }
    });
    app.delete("/api/emoji-packs/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.accountEmojiPack.delete({ where: { id } });
        return { ok: true };
    });
    app.get("/api/accounts/:id/emoji-packs/:packId/emojis", async (request, reply) => {
        const { id, packId } = request.params;
        const pack = await prisma_1.prisma.accountEmojiPack.findUnique({ where: { id: packId } });
        if (!pack || pack.accountId !== id)
            return reply.code(404).send({ error: "Pack no encontrado" });
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const set = await getStickerSet(client, id, pack.shortName);
            const docs = set.documents ?? [];
            const emojis = docs.map((d) => {
                const altAttr = (d.attributes || []).find((a) => a.className === "DocumentAttributeCustomEmoji" || a.alt !== undefined);
                return { documentId: d.id.toString(), alt: altAttr?.alt || "🙂" };
            });
            return { emojis };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo leer el contenido del pack." });
        }
    });
    app.get("/api/accounts/:id/emoji-packs/:packId/emoji-thumb/:documentId", async (request, reply) => {
        const { id, packId, documentId } = request.params;
        const cacheKey = `emoji-thumb:${id}:${documentId}`;
        const cached = (0, mediaCache_1.getCachedMedia)(cacheKey);
        if (cached) {
            reply.header("Content-Type", "image/webp");
            reply.header("Cache-Control", "private, max-age=86400");
            return reply.send(cached);
        }
        const pack = await prisma_1.prisma.accountEmojiPack.findUnique({ where: { id: packId } });
        if (!pack || pack.accountId !== id)
            return reply.code(404).send();
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const set = await getStickerSet(client, id, pack.shortName);
            const doc = set.documents?.find((d) => d.id.toString() === documentId);
            if (!doc)
                return reply.code(404).send();
            const buf = (await client.downloadMedia(doc, { thumb: 0 }));
            if (!buf)
                return reply.code(404).send();
            (0, mediaCache_1.setCachedMedia)(cacheKey, buf);
            reply.header("Content-Type", "image/webp");
            reply.header("Cache-Control", "private, max-age=86400");
            return reply.send(buf);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(404).send();
        }
    });
    // Manda un emoji premium/custom al chat abierto, como mensaje propio (no
    // se inserta dentro del texto: se manda solo, como si fuese un sticker).
    app.post("/api/accounts/:id/dialogs/:chatId/send-custom-emoji", async (request, reply) => {
        const { id, chatId } = request.params;
        const body = request.body;
        if (!body.packId || !body.documentId)
            return reply.code(400).send({ error: "Falta el emoji a enviar" });
        const pack = await prisma_1.prisma.accountEmojiPack.findUnique({ where: { id: body.packId } });
        if (!pack || pack.accountId !== id)
            return reply.code(404).send({ error: "Pack no encontrado" });
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const set = await getStickerSet(client, id, pack.shortName);
            const doc = set.documents?.find((d) => d.id.toString() === body.documentId);
            if (!doc)
                return reply.code(404).send({ error: "Emoji no encontrado en el pack" });
            const altAttr = (doc.attributes || []).find((a) => a.className === "DocumentAttributeCustomEmoji" || a.alt !== undefined);
            const alt = altAttr?.alt || "🙂";
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            await client.sendMessage(entity, {
                message: alt,
                formattingEntities: [
                    new telegram_1.Api.MessageEntityCustomEmoji({ offset: 0, length: alt.length, documentId: doc.id }),
                ],
            });
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            const msg = err?.errorMessage || err?.message || "";
            if (msg.includes("PREMIUM")) {
                return reply.code(502).send({ error: "Esta cuenta no tiene Telegram Premium: no puede enviar emoji premium animados." });
            }
            return reply.code(502).send({ error: msg || "No se pudo enviar el emoji." });
        }
    });
}
//# sourceMappingURL=emojiPacks.js.map