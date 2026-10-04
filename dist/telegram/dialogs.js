"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDialogs = listDialogs;
exports.searchGroupDialogs = searchGroupDialogs;
exports.resolveDialogEntity = resolveDialogEntity;
exports.resolveEntityById = resolveEntityById;
const entityCache = new Map();
function cacheFor(accountId) {
    let m = entityCache.get(accountId);
    if (!m) {
        m = new Map();
        entityCache.set(accountId, m);
    }
    return m;
}
function previewOf(message) {
    if (!message)
        return "";
    if (message.message)
        return message.message.slice(0, 120);
    if (message.media)
        return "[archivo adjunto]";
    return "";
}
function dialogKind(dialog) {
    if (dialog.isUser)
        return "user";
    if (dialog.isChannel && !dialog.isGroup)
        return "channel"; // canal de difusion (sin miembros que escriban)
    return "group"; // grupo basico o supergrupo
}
/** Lista las conversaciones privadas (con fans) mas recientes, mas los
 * grupos/canales cuyo chatId este en extraChatIds: los grupos restringidos
 * de cada cliente (se añaden solos, ver messages.ts) y las carpetas marcadas
 * a mano en Configuración → "Mostrar también en Mensajes". "Mensajes" es el
 * chat con fans, NO todos los grupos/canales de la cuenta de Telegram. */
async function listDialogs(client, accountId, limit = 100, extraChatIds) {
    const dialogs = await client.getDialogs({ limit });
    const cache = cacheFor(accountId);
    const out = [];
    for (const dialog of dialogs) {
        const chatId = dialog.id.toString();
        const isExtra = !dialog.isUser && !!extraChatIds?.has(chatId);
        if (!dialog.isUser && !isExtra)
            continue; // solo chats privados con fans + grupos permitidos explicitamente
        const entity = dialog.entity;
        if (!entity)
            continue;
        cache.set(chatId, entity);
        const msg = dialog.message;
        const participantsCount = typeof entity?.participantsCount === "number" ? entity.participantsCount : null;
        out.push({
            chatId,
            title: dialog.title || "(sin nombre)",
            isUser: !!dialog.isUser,
            isGroup: !dialog.isUser,
            kind: dialogKind(dialog),
            unreadCount: dialog.unreadCount || 0,
            lastMessage: previewOf(msg),
            lastMessageDate: msg?.date ? new Date(msg.date * 1000).toISOString() : null,
            lastMessageOut: !!msg?.out,
            participantsCount,
        });
    }
    return out;
}
/** Busca grupos/canales (no chats privados) por titulo, para elegir el "grupo de contenido" de una cuenta. */
async function searchGroupDialogs(client, search) {
    const dialogs = await client.getDialogs({ limit: 200 });
    const s = (search || "").toLowerCase();
    const out = [];
    for (const dialog of dialogs) {
        if (dialog.isUser)
            continue; // solo grupos/canales
        if (s && !(dialog.title || "").toLowerCase().includes(s))
            continue;
        out.push({
            chatId: dialog.id.toString(),
            title: dialog.title || "(sin nombre)",
            isForum: !!dialog.entity?.forum,
        });
    }
    return out;
}
/** Resuelve la entidad de Telegram de un chat, usando la cache o relistando dialogos si hace falta. */
async function resolveDialogEntity(client, accountId, chatId) {
    const cache = cacheFor(accountId);
    let entity = cache.get(chatId);
    if (!entity) {
        await listDialogs(client, accountId, 400);
        entity = cache.get(chatId);
    }
    if (!entity) {
        // No estaba en la cache de chats privados (listDialogs solo cachea DMs
        // con fans): puede ser un grupo, por ejemplo el grupo restringido de un
        // cliente. Lo resolvemos directo por id antes de rendirnos.
        try {
            entity = (await resolveEntityById(client, chatId));
            cache.set(chatId, entity);
        }
        catch {
            // sigue sin encontrarse, cae al error de abajo
        }
    }
    if (!entity) {
        throw new Error("No se encontro esa conversacion (prueba a recargar la lista de mensajes)");
    }
    return entity;
}
/** Resuelve cualquier chat/grupo/canal por id (no solo DMs con fans), con un
 * reintento tras refrescar los dialogos si Telegram no tiene el access_hash
 * en cache todavia (p.ej. justo despues de un reinicio del servidor). */
async function resolveEntityById(client, chatId) {
    try {
        return await client.getEntity(chatId);
    }
    catch {
        await client.getDialogs({ limit: 400 });
        return await client.getEntity(chatId);
    }
}
//# sourceMappingURL=dialogs.js.map