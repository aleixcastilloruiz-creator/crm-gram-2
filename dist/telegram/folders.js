"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAccountFolders = listAccountFolders;
exports.addChatToFolderByTitle = addChatToFolderByTitle;
const telegram_1 = require("telegram");
/**
 * Lista las carpetas (dialog filters) configuradas en la cuenta, con los
 * chats que contiene cada una. Se usa para poblar el selector de "carpeta
 * de Telegram" al crear una campaña, igual que el desplegable de carpetas
 * con su conteo de chats.
 */
async function listAccountFolders(client) {
    const result = await client.invoke(new telegram_1.Api.messages.GetDialogFilters());
    const filters = "filters" in result ? result.filters : result;
    const summaries = [];
    for (const filter of filters) {
        if (filter.className !== "DialogFilter")
            continue; // salta Default/Chatlist especiales
        const chatIds = [];
        for (const peer of filter.includePeers ?? []) {
            const id = peerToChatId(peer);
            if (id)
                chatIds.push(id);
        }
        summaries.push({
            id: filter.id,
            title: filter.title?.text ?? filter.title ?? `Carpeta ${filter.id}`,
            chatIds,
        });
    }
    return summaries;
}
function peerToChatId(peer) {
    if (peer.className === "InputPeerChannel")
        return `-100${peer.channelId}`;
    if (peer.className === "InputPeerChat")
        return `${peer.chatId}`;
    if (peer.className === "InputPeerUser")
        return `${peer.userId}`;
    return null;
}
/**
 * Añade un chat a una carpeta de Telegram existente por su título (usado
 * por "Carpetas de Telegram → Sincronizar carpetas automáticamente").
 * Solo añade: si el chat ya está en la carpeta, o la carpeta no existe, no
 * hace nada. Si Telegram rechaza el cambio (carpeta llena, límite de la
 * cuenta...), se informa en vez de reventar la petición que lo llamó -
 * de momento no se crean carpetas nuevas tipo "Clientes 2" al llenarse.
 */
async function addChatToFolderByTitle(client, folderTitle, chatId) {
    const result = await client.invoke(new telegram_1.Api.messages.GetDialogFilters());
    const filters = "filters" in result ? result.filters : result;
    const filter = filters.find((f) => f.className === "DialogFilter" && (f.title?.text ?? f.title ?? "").toLowerCase() === folderTitle.toLowerCase());
    if (!filter)
        return { ok: false, reason: `No existe una carpeta de Telegram llamada "${folderTitle}".` };
    const already = (filter.includePeers ?? []).some((p) => peerToChatId(p) === chatId);
    if (already)
        return { ok: true };
    let inputPeer;
    try {
        inputPeer = await client.getInputEntity(chatId);
    }
    catch {
        return { ok: false, reason: "No se pudo resolver el chat en Telegram." };
    }
    filter.includePeers = [...(filter.includePeers ?? []), inputPeer];
    try {
        await client.invoke(new telegram_1.Api.messages.UpdateDialogFilter({ id: filter.id, filter }));
        return { ok: true };
    }
    catch (err) {
        return { ok: false, reason: err?.errorMessage || err?.message || "Telegram rechazó el cambio (¿carpeta llena?)." };
    }
}
//# sourceMappingURL=folders.js.map