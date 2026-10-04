"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecentSourceMessages = getRecentSourceMessages;
exports.groupByAlbum = groupByAlbum;
exports.messageAtPosition = messageAtPosition;
exports.deliverMessage = deliverMessage;
exports.logSendOutcome = logSendOutcome;
const prisma_1 = require("../utils/prisma");
/**
 * Resuelve un chat/canal por su id "marcado" (ej. "-1003764920536"), con un
 * reintento tras refrescar los dialogos si GramJS no tiene el access_hash en
 * su cache local todavia - le puede pasar a una cuenta que no ha vuelto a
 * "ver" ese chat desde que se reinicio el proceso (p.ej. justo despues de un
 * despliegue), aunque siga siendo miembro de verdad. Sin este reintento,
 * getEntity fallaba con un error de "no se encuentra la entidad" que subia
 * sin capturar y dejaba el resto del tick de horarios fijos sin procesar.
 */
async function resolveChatEntity(client, chatId) {
    try {
        return await client.getEntity(chatId);
    }
    catch {
        await client.getDialogs({ limit: 400 });
        return await client.getEntity(chatId);
    }
}
/**
 * Trae los ultimos posts (agrupando albumes) del grupo/tema origen, hasta
 * completar `source.recentLimit` posts distintos (no mensajes en bruto: un
 * album de 3 fotos cuenta como 1 post/posicion, igual que en el panel de
 * referencia). Telegram los devuelve mas recientes primero (ver
 * client.getMessages mas abajo); se dan la vuelta antes de devolverlos para
 * que la posicion 1 sea el MAS ANTIGUO de esos `recentLimit` posts, y la
 * ultima posicion el mas reciente - asi lo pidio Aitor (antes era al
 * reves: posicion 1 = el mas nuevo).
 */
async function getRecentSourceMessages(client, source) {
    let entity;
    try {
        entity = await resolveChatEntity(client, source.chatId);
    }
    catch (err) {
        const reason = err?.errorMessage ?? err?.message ?? String(err);
        throw new Error(`No se pudo leer el origen (chatId ${source.chatId}): ${reason}`);
    }
    // Pedimos de mas por si hay albumes de varias fotos, hasta agrupar
    // suficientes posts distintos. Reintenta ampliando el rango si hace falta.
    let rawLimit = source.recentLimit * 3;
    let groups = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        let raw;
        try {
            raw = await client.getMessages(entity, {
                limit: rawLimit,
                replyTo: source.topicId ?? undefined, // filtra por topic si el origen es un foro
            });
        }
        catch (err) {
            const reason = err?.errorMessage ?? err?.message ?? String(err);
            const topicPart = source.topicId ? ` (tema/topic ${source.topicId})` : "";
            throw new Error(`No se pudieron leer los mensajes del origen${topicPart}: ${reason}`);
        }
        const usable = raw.filter((m) => m.message || m.media);
        groups = groupByAlbum(usable).slice(0, source.recentLimit);
        if (groups.length >= source.recentLimit || usable.length < rawLimit)
            break;
        rawLimit *= 2;
    }
    // Se cogen los `recentLimit` mas nuevos (slice de arriba, sobre la lista
    // que trae Telegram mas-nuevo-primero) y SOLO al final se da la vuelta,
    // para que la posicion 1 sea el mas antiguo de esos posts y la ultima
    // posicion el mas reciente.
    return groups.reverse();
}
/** Agrupa mensajes consecutivos que comparten groupedId (album), preservando el orden en que llegan (ver groupedId de Telegram - mas nuevo primero antes de darle la vuelta en getRecentSourceMessages). */
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
/** Post en la posicion N (1 = el mas antiguo de los `recentLimit` traidos) de una lista ya ordenada por getRecentSourceMessages. */
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