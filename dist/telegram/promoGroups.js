"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAccountGroupsAndChannels = listAccountGroupsAndChannels;
exports.isChatMemberOf = isChatMemberOf;
const telegram_1 = require("telegram");
async function listAccountGroupsAndChannels(client) {
    const dialogs = await client.getDialogs({ limit: 500 });
    const out = [];
    for (const dialog of dialogs) {
        if (dialog.isUser)
            continue; // solo grupos/canales, nunca chats privados
        const entity = dialog.entity;
        if (!entity)
            continue;
        const chatId = dialog.id.toString();
        const isChannel = !!dialog.isChannel && !dialog.isGroup; // canal de difusión puro (sin "megagroup")
        const memberCount = typeof entity.participantsCount === "number" ? entity.participantsCount : 0;
        out.push({
            chatId,
            title: dialog.title || "(sin nombre)",
            isChannel,
            memberCount,
        });
    }
    return out;
}
/**
 * Comprueba si un fan (por su chatId de Telegram) es miembro de un grupo o
 * canal concreto, SIN descargar la lista completa de miembros (que en
 * grupos grandes puede ser lenta/pesada y consumir cuota de Telegram de
 * sobra). Se usa para la atribución de fans a grupos de promoción: en
 * cuanto un fan nuevo escribe por primera vez, se comprueba contra cada
 * grupo ya catalogado de esa cuenta.
 */
async function isChatMemberOf(client, groupChatId, fanChatId) {
    try {
        const channel = await client.getInputEntity(groupChatId);
        const participant = await client.getInputEntity(fanChatId);
        await client.invoke(new telegram_1.Api.channels.GetParticipant({
            channel,
            participant,
        }));
        return true; // si no lanza error, es miembro (o lo fue con un rol devuelto)
    }
    catch (err) {
        // USER_NOT_PARTICIPANT es la respuesta normal de "no está" - cualquier
        // otro fallo (grupo no resoluble, chat básico sin channels.GetParticipant...)
        // tambien se trata como "no se pudo confirmar" en vez de reventar la
        // atribución de todo el lote.
        return false;
    }
}
//# sourceMappingURL=promoGroups.js.map