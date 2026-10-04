"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribeToAccountEvents = subscribeToAccountEvents;
exports.attachLiveEvents = attachLiveEvents;
exports.detachLiveEvents = detachLiveEvents;
const telegram_1 = require("telegram");
const events_1 = require("telegram/events");
const dialogsCache_1 = require("./dialogsCache");
const prisma_1 = require("../utils/prisma");
const phoneCountry_1 = require("./phoneCountry");
const listeners = new Map();
const attachedAccounts = new Set();
function subscribeToAccountEvents(accountId, listener) {
    let set = listeners.get(accountId);
    if (!set) {
        set = new Set();
        listeners.set(accountId, set);
    }
    set.add(listener);
    return () => {
        set.delete(listener);
        if (set.size === 0)
            listeners.delete(accountId);
    };
}
function emit(accountId, chatId, message) {
    const payload = {
        type: "message",
        chatId,
        message: {
            id: message.id,
            text: message.message || (message.media ? "[archivo adjunto]" : ""),
            out: !!message.out,
            date: message.date ? new Date(message.date * 1000).toISOString() : null,
        },
    };
    // Mantiene la lista de conversaciones al dia sin volver a pedirsela a Telegram.
    (0, dialogsCache_1.touchDialogFromLiveMessage)(accountId, chatId, payload.message);
    const set = listeners.get(accountId);
    if (!set || set.size === 0)
        return;
    for (const l of set) {
        try {
            l(payload);
        }
        catch {
            // un listener roto no debe tumbar al resto
        }
    }
}
/**
 * "Bloqueo automático por país": si el mensaje entrante es de un chat
 * privado (1:1, chatId positivo con la convencion de ids "marcados" que se
 * usa en todo el proyecto) y el fan escribe desde un país de la lista negra
 * de esta cuenta, se bloquea en Telegram en el momento. Nunca reintenta si
 * ya quedó marcado (auto-bloqueado o desbloqueado a mano), y nunca debe
 * tumbar el resto del puente en vivo si algo falla.
 */
async function maybeAutoBlockByCountry(accountId, client, chatId, message) {
    try {
        if (message.out)
            return;
        if (!(Number(chatId) > 0))
            return; // solo chats privados, nunca grupos/canales
        const account = await prisma_1.prisma.account.findUnique({ where: { id: accountId } });
        if (!account)
            return;
        let prefixes = [];
        try {
            prefixes = JSON.parse(account.blockedCountries || "[]");
        }
        catch {
            prefixes = [];
        }
        if (prefixes.length === 0)
            return;
        const existing = await prisma_1.prisma.fanNote.findUnique({ where: { accountId_chatId: { accountId, chatId } } });
        if (existing?.manuallyUnblocked || existing?.autoBlockedByCountry)
            return;
        let sender = null;
        try {
            sender = await message.getSender();
        }
        catch {
            sender = null;
        }
        if (!sender || sender.className !== "User" || !sender.accessHash)
            return;
        // La entidad del evento en vivo suele venir "recortada" (sin telefono
        // aunque Telegram lo dejase ver), igual que en /dialogs/:chatId/profile:
        // pedimos el usuario completo para tener la mejor oportunidad de verlo.
        let phone = sender.phone ? "+" + sender.phone : null;
        try {
            const inputUser = new telegram_1.Api.InputUser({ userId: sender.id, accessHash: sender.accessHash });
            const full = await client.invoke(new telegram_1.Api.users.GetUsers({ id: [inputUser] }));
            if (full && full[0] && full[0].className === "User" && full[0].phone) {
                phone = "+" + full[0].phone;
            }
        }
        catch {
            // seguimos con lo que ya tuvieramos
        }
        const prefix = (0, phoneCountry_1.prefixFromPhone)(phone);
        if (!prefix || !prefixes.includes(prefix))
            return;
        const inputUser = new telegram_1.Api.InputUser({ userId: sender.id, accessHash: sender.accessHash });
        await client.invoke(new telegram_1.Api.contacts.Block({ id: inputUser }));
        await prisma_1.prisma.fanNote.upsert({
            where: { accountId_chatId: { accountId, chatId } },
            update: { autoBlockedByCountry: true },
            create: { accountId, chatId, autoBlockedByCountry: true },
        });
    }
    catch {
        // best effort: un fallo aqui nunca debe afectar al resto del puente en vivo
    }
}
function resolveChatId(message) {
    try {
        // chatId ya resuelve al id "de dialogo" (usuario/chat), igual que en listDialogs/dialogs.ts
        const cid = message.chatId;
        if (cid)
            return cid.toString();
    }
    catch {
        // sigue al fallback
    }
    return null;
}
/**
 * Conecta el listener de mensajes en tiempo real para una cuenta. Se llama
 * cada vez que se obtiene el cliente del pool, pero solo se engancha una
 * vez de verdad por cuenta (el resto de llamadas no hacen nada).
 */
function attachLiveEvents(accountId, client) {
    if (attachedAccounts.has(accountId))
        return;
    attachedAccounts.add(accountId);
    client.addEventHandler((event) => {
        try {
            const message = event.message;
            if (!message)
                return;
            const chatId = resolveChatId(message);
            if (!chatId)
                return;
            emit(accountId, chatId, message);
            // No se espera (fire-and-forget): el bloqueo por país nunca debe
            // retrasar la actualización en vivo del chat.
            maybeAutoBlockByCountry(accountId, client, chatId, message);
        }
        catch {
            // no dejamos que un fallo de parseo tumbe la conexion
        }
    }, new events_1.NewMessage({}));
    // Nota: esta version de GramJS no expone un evento "EditedMessage" propio;
    // los mensajes editados no se emiten en vivo (solo los nuevos), pero se
    // veran igualmente al reabrir/recargar la conversacion.
}
function detachLiveEvents(accountId) {
    attachedAccounts.delete(accountId);
}
//# sourceMappingURL=liveEvents.js.map