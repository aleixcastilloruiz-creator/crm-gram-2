"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedDialogs = getCachedDialogs;
exports.touchDialogFromLiveMessage = touchDialogFromLiveMessage;
exports.markDialogRead = markDialogRead;
exports.clearDialogsCache = clearDialogsCache;
const dialogs_1 = require("./dialogs");
const cache = new Map();
const REFRESH_INTERVAL_MS = 3 * 60 * 1000; // refresco de fondo cada 3 min
const FETCH_LIMIT = 600; // suficiente para incluir historial antiguo + reciente
function refresh(client, accountId, entry) {
    const promise = (0, dialogs_1.listDialogs)(client, accountId, FETCH_LIMIT, entry.extraChatIds)
        .then((dialogs) => {
        entry.dialogs = dialogs;
        entry.loadedAt = Date.now();
        entry.loading = null;
        return dialogs;
    })
        .catch((err) => {
        entry.loading = null;
        throw err;
    });
    entry.loading = promise;
    return promise;
}
/** Devuelve la lista de conversaciones lo mas rapido posible (cache si existe).
 * extraChatIds: chats de grupo/canal (carpetas marcadas en Configuración) que
 * deben incluirse ademas de los chats privados normales. */
async function getCachedDialogs(client, accountId, extraChatIds) {
    let entry = cache.get(accountId);
    if (!entry) {
        entry = { dialogs: [], loadedAt: 0, loading: null, extraChatIds };
        cache.set(accountId, entry);
    }
    else {
        entry.extraChatIds = extraChatIds;
    }
    if (entry.dialogs.length === 0 && !entry.loading) {
        // Nunca cargada: aqui si toca esperar de verdad (unica vez).
        await refresh(client, accountId, entry);
    }
    else if (entry.loading) {
        // Ya hay un refresco en marcha (p.ej. lanzado por otra peticion): lo aprovechamos.
        await entry.loading;
    }
    else if (Date.now() - entry.loadedAt > REFRESH_INTERVAL_MS) {
        // Cache "vieja": se refresca en segundo plano, pero devolvemos ya lo que tenemos.
        refresh(client, accountId, entry).catch(() => { });
    }
    return cache.get(accountId).dialogs;
}
/** Actualiza (o mueve arriba) una conversacion existente al recibir un mensaje en vivo. */
function touchDialogFromLiveMessage(accountId, chatId, message) {
    const entry = cache.get(accountId);
    if (!entry || entry.dialogs.length === 0)
        return; // aun no hay cache: se llenara con la carga inicial
    const idx = entry.dialogs.findIndex((d) => d.chatId === chatId);
    if (idx === -1) {
        // Chat que no estaba en la lista (conversacion nueva): forzamos un
        // refresco de fondo para que aparezca pronto, sin bloquear nada ahora.
        if (!entry.loading && Date.now() - entry.loadedAt > 10_000) {
            entry.loadedAt = 0;
        }
        return;
    }
    const d = entry.dialogs[idx];
    d.lastMessage = message.text;
    d.lastMessageDate = message.date;
    d.lastMessageOut = message.out;
    if (!message.out)
        d.unreadCount = (d.unreadCount || 0) + 1;
    entry.dialogs.splice(idx, 1);
    entry.dialogs.unshift(d);
}
function markDialogRead(accountId, chatId) {
    const entry = cache.get(accountId);
    if (!entry)
        return;
    const d = entry.dialogs.find((x) => x.chatId === chatId);
    if (d)
        d.unreadCount = 0;
}
function clearDialogsCache(accountId) {
    cache.delete(accountId);
}
//# sourceMappingURL=dialogsCache.js.map