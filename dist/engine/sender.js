"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecentSourceMessages = getRecentSourceMessages;
exports.groupByAlbum = groupByAlbum;
exports.messageAtPosition = messageAtPosition;
exports.deliverMessage = deliverMessage;
exports.logSendOutcome = logSendOutcome;
const prisma_1 = require("../utils/prisma");
/**
 * Trae los ultimos posts (agrupando albumes) del grupo/tema origen, mas
 * recientes primero, hasta completar `source.recentLimit` posts distintos
 * (no mensajes en bruto: un album de 3 fotos cuenta como 1 post/posicion,
 * igual que en el panel de referencia).
 */
async function getRecentSourceMessages(client, source) {
    const entity = await client.getEntity(source.chatId);
    // Pedimos de mas por si hay albumes de varias fotos, hasta agrupar
    // suficientes posts distintos. Reintenta ampliando el rango si hace falta.
    let rawLimit = source.recentLimit * 3;
    let groups = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await client.getMessages(entity, {
            limit: rawLimit,
            replyTo: source.topicId ?? undefined, // filtra por topic si el origen es un foro
        });
        const usable = raw.filter((m) => m.message || m.media);
        groups = groupByAlbum(usable).slice(0, source.recentLimit);
        if (groups.length >= source.recentLimit || usable.length < rawLimit)
            break;
        rawLimit *= 2;
    }
    return groups;
}
/** Agrupa mensajes consecutivos que comparten groupedId (album), preservando el orden (mas nuevo primero). */
function groupByAlbum(messages) {
    const groups = [];
    const seenGroupIds = new Set();
    for (const message of messages) {
        const groupedId = message.groupedId?.toString();
        if (groupedId && seenGroupIds.has(groupedId)) {
            // ya se añadió como parte de un grupo anterior (getMessages viene ordenado, deberian ser consecutivos)
            const existing = groups.find((g) => g[0].groupedId?.toString() === groupedId);
            existing?.push(message);
            continue;
        }
        if (groupedId)
            seenGroupIds.add(groupedId);
        groups.push([message]);
    }
    // Dentro de cada album, que el texto/caption quede accesible sin importar en que item vino
    return groups;
}
/** Texto/caption de un post (album o mensaje suelto): el primero no vacio que se encuentre. */
function captionOf(group) {
    return group.find((m) => m.message)?.message ?? "";
}
/** Post en la posicion N (1 = el mas nuevo) de una lista ya ordenada. */
function messageAtPosition(groups, position) {
    return groups[position - 1];
}
/**
 * Envia un post (mensaje suelto o album) del origen a un chat destino
 * segun el modo configurado en la campaña:
 * - "reenvio sin autor" (por defecto): forward de Telegram con dropAuthor,
 *   así el mensaje llega SIN indicar remitente ni chat de origen.
 * - "copiar como propio": reconstruye el post como mensaje nuevo (sin
 *   marca de reenvio en absoluto).
 */
async function deliverMessage(client, campaign, source, destination, group) {
    try {
        const destEntity = await client.getEntity(destination.chatId);
        const caption = captionOf(group);
        const mediaItems = group.filter((m) => m.media);
        if (campaign.sendMode === "COPY_AS_OWN") {
            if (mediaItems.length > 0 && campaign.sendAlbums) {
                await client.sendFile(destEntity, {
                    file: mediaItems.map((m) => m.media),
                    caption,
                    replyTo: destination.topicId ?? undefined,
                });
            }
            else if (caption && (campaign.textOnlyAllowed || mediaItems.length === 0)) {
                await client.sendMessage(destEntity, {
                    message: caption,
                    replyTo: destination.topicId ?? undefined,
                });
            }
            else {
                return { ok: false, error: new Error("Post sin contenido enviable segun la config de la campaña") };
            }
        }
        else {
            const sourceEntity = await client.getEntity(source.chatId);
            await client.forwardMessages(destEntity, {
                messages: group.map((m) => m.id), // todo el album junto, para no romper el agrupamiento
                fromPeer: sourceEntity,
                dropAuthor: true, // oculta remitente y chat de origen
            });
        }
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error };
    }
}
/** Registra el resultado de un envio en la consola de logs. */
async function logSendOutcome(params) {
    const { accountId, campaignId, chatTitle, outcome, sourceMessageId } = params;
    await prisma_1.prisma.sendLog.create({
        data: {
            accountId,
            campaignId,
            level: outcome.ok ? "SENT" : "ERROR",
            chatTitle,
            message: outcome.ok
                ? `Chat: ${chatTitle} | mensaje origen ${sourceMessageId}`
                : `Chat: ${chatTitle} | fallo enviando mensaje origen ${sourceMessageId}`,
            errorCode: outcome.ok ? undefined : String(outcome.error?.errorMessage ?? outcome.error?.message ?? outcome.error),
        },
    });
}
//# sourceMappingURL=sender.js.map