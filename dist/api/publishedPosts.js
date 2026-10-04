"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPublishedPostsRoutes = registerPublishedPostsRoutes;
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const dialogs_1 = require("../telegram/dialogs");
/**
 * "Programar posts → Publicadas": a diferencia de las otras dos pestañas
 * (que son cosas programadas DESDE este CRM), esto es un espejo de lo que
 * de verdad hay publicado en Telegram ahora mismo, venga de donde venga -
 * de "Programar posts" o publicado a mano desde el móvil -, para poder
 * auditarlo o borrarlo sin salir del panel. Se escanean los canales/grupos
 * dados de alta en "Canales free" (son los canales conocidos de esta
 * cuenta); si no hay ninguno, no hay donde mirar.
 */
function mediaKind(m) {
    const media = m.media;
    if (!media)
        return "Texto";
    if (media.className === "MessageMediaPhoto")
        return "📷 Foto";
    if (media.className === "MessageMediaDocument") {
        const attrs = media.document?.attributes || [];
        if (attrs.some((a) => a.className === "DocumentAttributeVideo"))
            return "🎬 Vídeo";
        if (attrs.some((a) => a.className === "DocumentAttributeAudio"))
            return "🎧 Audio";
        return "📎 Archivo";
    }
    return "📝 Post";
}
async function registerPublishedPostsRoutes(app) {
    app.get("/api/accounts/:id/published-posts", async (request, reply) => {
        const { id } = request.params;
        const q = request.query;
        const days = Math.max(1, Math.min(30, Number(q.days) || 7));
        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        const channels = await prisma_1.prisma.freeChannel.findMany({ where: { accountId: id }, orderBy: { createdAt: "asc" } });
        if (channels.length === 0) {
            return { posts: [], reason: "sin_canales" };
        }
        let client;
        try {
            client = await (0, connectionPool_1.getAccountClient)(account);
        }
        catch {
            return reply.code(502).send({ error: "No se pudo conectar con Telegram para leer lo publicado." });
        }
        const posts = [];
        for (const ch of channels) {
            try {
                const entity = await (0, dialogs_1.resolveEntityById)(client, ch.chatId);
                // Vienen ordenados de mas nuevo a mas viejo: en cuanto se cruza el
                // corte de dias se puede parar, no hace falta traer mas de este canal.
                const messages = await client.getMessages(entity, { limit: 150 });
                for (const m of messages) {
                    const msgDateMs = (m.date || 0) * 1000;
                    if (msgDateMs < cutoffMs)
                        break;
                    if (!m.out)
                        continue; // solo lo que publico esta propia cuenta, no lo que otros admins/bots posteen ahi
                    if (!m.message && !m.media)
                        continue;
                    posts.push({
                        chatId: ch.chatId,
                        chatTitle: ch.title,
                        messageId: m.id,
                        kind: mediaKind(m),
                        text: (m.message || "").slice(0, 300),
                        date: new Date(msgDateMs).toISOString(),
                    });
                }
            }
            catch (err) {
                request.log.warn(err, `No se pudo leer lo publicado de "${ch.title}"`);
                // un canal que falle (borrado, sin permisos...) no debe tirar el resto
            }
        }
        posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        return { posts: posts.slice(0, 300) };
    });
    // Borra un post ya publicado directamente en Telegram (no solo en el
    // panel): es lo mismo que pulsar "Eliminar" en un canal desde la app de
    // Telegram - revoke:true lo quita para todo el mundo, no solo localmente.
    app.delete("/api/accounts/:id/published-posts", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        if (!body.chatId || body.messageId === undefined) {
            return reply.code(400).send({ error: "Falta el mensaje a borrar" });
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveEntityById)(client, body.chatId);
            await client.deleteMessages(entity, [body.messageId], { revoke: true });
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo borrar el mensaje en Telegram." });
        }
    });
}
//# sourceMappingURL=publishedPosts.js.map