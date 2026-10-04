"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractSentMessageIds = extractSentMessageIds;
exports.registerMessagesRoutes = registerMessagesRoutes;
const telegram_1 = require("telegram");
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const dialogs_1 = require("../telegram/dialogs");
const dialogsCache_1 = require("../telegram/dialogsCache");
const folders_1 = require("../telegram/folders");
const liveEvents_1 = require("../telegram/liveEvents");
const phoneCountry_1 = require("../telegram/phoneCountry");
const idRegistrationEstimate_1 = require("../telegram/idRegistrationEstimate");
const mediaCache_1 = require("../telegram/mediaCache");
// Sin @types propios: se usa via require, la libreria en si es JS puro (no
// necesita compilar nada nativo en Railway).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const heicConvert = require("heic-convert");
/** Algunos fans mandan fotos en HEIC/HEIF (tipico de iPhone) - ningun
 * navegador las pinta en una etiqueta <img>, asi que si detectamos ese
 * formato lo convertimos a JPEG en el propio servidor antes de servirlo.
 * Si algo falla, se devuelve el archivo original tal cual (nunca rompe la
 * respuesta por esto). */
async function convertHeicIfNeeded(buf, mimeType) {
    const isHeic = /image\/hei[cf]/i.test(mimeType) || (buf.length > 12 && buf.slice(4, 12).toString("ascii").includes("ftyp") && /hei[cfsx]|mif1/i.test(buf.slice(8, 12).toString("ascii")));
    if (!isHeic)
        return { buf, mimeType };
    try {
        const out = await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 });
        return { buf: Buffer.from(out), mimeType: "image/jpeg" };
    }
    catch {
        return { buf, mimeType };
    }
}
// Miniaturas/medios de la Galería del chat: mismo tipo de semaforo que en la
// bóveda de contenido, para no saturar la conexión si el fan tiene muchos
// archivos intercambiados.
function makeSlotLimiter(maxConcurrent) {
    let active = 0;
    const waiters = [];
    return async function withSlot(fn) {
        if (active >= maxConcurrent) {
            await new Promise((resolve) => waiters.push(resolve));
        }
        active++;
        try {
            return await fn();
        }
        finally {
            active--;
            const next = waiters.shift();
            if (next)
                next();
        }
    };
}
const withGalleryThumbSlot = makeSlotLimiter(6);
const withGalleryMediaSlot = makeSlotLimiter(2);
const MAX_GALLERY_MEDIA_BYTES = 60 * 1024 * 1024;
function classifyGalleryMedia(media) {
    if (!media)
        return "other";
    if (media.className === "MessageMediaPhoto")
        return "photo";
    if (media.className === "MessageMediaDocument" && media.document) {
        const attrs = media.document.attributes || [];
        if (attrs.some((a) => a.className === "DocumentAttributeVideo"))
            return "video";
        if (attrs.some((a) => a.className === "DocumentAttributeAudio"))
            return "audio";
        const mime = media.document.mimeType || "";
        if (mime.startsWith("video/"))
            return "video";
        if (mime.startsWith("audio/"))
            return "audio";
        if (mime.startsWith("image/"))
            return "photo";
    }
    return "other";
}
function galleryMediaMimeType(media) {
    if (media?.className === "MessageMediaPhoto")
        return "image/jpeg";
    return media?.document?.mimeType || "application/octet-stream";
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const extraFoldersCache = new Map();
const EXTRA_FOLDERS_TTL_MS = 2 * 60 * 1000;
async function resolveMessageFolderChatIds(client, foldersJson) {
    let folderTitles = [];
    try {
        folderTitles = JSON.parse(foldersJson || "[]");
    }
    catch {
        folderTitles = [];
    }
    if (folderTitles.length === 0)
        return undefined;
    const cacheKey = `${foldersJson}`;
    const cached = extraFoldersCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < EXTRA_FOLDERS_TTL_MS)
        return cached.chatIds;
    try {
        const folders = await (0, folders_1.listAccountFolders)(client);
        const wanted = new Set(folderTitles.map((t) => t.toLowerCase()));
        const chatIds = new Set();
        for (const f of folders) {
            if (wanted.has(f.title.toLowerCase())) {
                for (const id of f.chatIds)
                    chatIds.add(id);
            }
        }
        extraFoldersCache.set(cacheKey, { chatIds, loadedAt: Date.now() });
        return chatIds;
    }
    catch {
        return cached?.chatIds; // si falla, seguimos con lo que hubiera en cache (aunque este caducado)
    }
}
/** "Última conexión" del fan (visto por Telegram), tal y como se ve en la
 * cabecera de cualquier chat. Puede venir como fecha exacta (offline) o solo
 * como categoría ("hace poco", "esta semana"...) si el fan tiene la
 * privacidad restringida — igual pasa dentro de la propia app de Telegram. */
function formatLastSeen(status) {
    if (!status)
        return { text: null, date: null };
    switch (status.className) {
        case "UserStatusOnline":
            return { text: "En línea ahora", date: null };
        case "UserStatusOffline":
            return status.wasOnline
                ? { text: null, date: new Date(status.wasOnline * 1000).toISOString() }
                : { text: "Desconectado", date: null };
        case "UserStatusRecently":
            return { text: "Última vez hace poco", date: null };
        case "UserStatusLastWeek":
            return { text: "Última vez esta semana", date: null };
        case "UserStatusLastMonth":
            return { text: "Última vez este mes", date: null };
        default:
            return { text: "Última conexión oculta para esta cuenta", date: null };
    }
}
/**
 * "Carpetas de Telegram → Sincronizar carpetas automáticamente": al ponerle
 * una lista a un fan, si esta encendido, se añade su chat a la carpeta de
 * Telegram mapeada para esa lista. Best-effort y en segundo plano (no debe
 * retrasar ni romper el guardado de la nota): si Telegram lo rechaza
 * (carpeta llena, carpeta borrada...) simplemente queda en el log.
 */
function syncFanToTelegramFolder(app, accountId, chatId, list) {
    if (!list)
        return;
    (async () => {
        try {
            const account = await prisma_1.prisma.account.findUnique({ where: { id: accountId } });
            if (!account || !account.autoSyncFoldersEnabled)
                return;
            let map = {};
            try {
                map = JSON.parse(account.folderSyncMap || "{}");
            }
            catch {
                map = {};
            }
            const folderTitle = map[list];
            if (!folderTitle)
                return;
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const res = await (0, folders_1.addChatToFolderByTitle)(client, folderTitle, chatId);
            if (!res.ok)
                app.log.warn(`[folder-sync] ${accountId}/${chatId} -> "${folderTitle}": ${res.reason}`);
        }
        catch (err) {
            app.log.warn(err, "[folder-sync] fallo al sincronizar carpeta");
        }
    })();
}
function extractSentMessageIds(result) {
    try {
        const ids = [];
        if (Array.isArray(result)) {
            for (const m of result)
                if (m && m.id !== undefined)
                    ids.push(String(m.id));
            return ids;
        }
        const updates = result?.updates || (result?.className?.startsWith?.("Update") ? [result] : []);
        for (const u of updates || []) {
            if (u?.message?.id !== undefined)
                ids.push(String(u.message.id));
        }
        return ids;
    }
    catch {
        return [];
    }
}
/**
 * Apartado "Mensajes": chatear con los fans de una cuenta directamente
 * desde el panel, y llevar notas por fan y una nota general de la cuenta
 * (modelo), igual que en el panel de referencia.
 */
async function registerMessagesRoutes(app) {
    app.get("/api/accounts/:id/dialogs", async (request, reply) => {
        const { id } = request.params;
        const q = request.query;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const [folderExtraChatIds, excludedChatIds, restrictedGroupsRaw] = await Promise.all([
                resolveMessageFolderChatIds(client, account.extraMessageFolders),
                resolveMessageFolderChatIds(client, account.excludedMessageFolders),
                prisma_1.prisma.clientRestrictedGroup.findMany({ where: { accountId: id }, select: { groupChatId: true } }),
            ]);
            // Autolimpieza: antes de fiarnos de la tabla ClientRestrictedGroup,
            // comprobamos (de verdad, contra Telegram) que cada grupo guardado
            // sigue siendo pequeño. Una version anterior del boton "grupo
            // restringido" podia adoptar por error un grupo grande (publico o de
            // spam) solo porque el cliente ya estaba metido en el por su cuenta -
            // eso dejo registros corruptos que hacian aparecer esos grupos en
            // Mensajes para siempre. Se borran aqui mismo en cuanto se detectan,
            // asi el boton puede crear/encontrar la proxima vez el grupo de
            // verdad en lugar de seguir devolviendo el ajeno.
            const badGroupChatIds = new Set();
            await Promise.all(restrictedGroupsRaw.map(async (g) => {
                if (await isGroupTooLargeForClientCached(client, g.groupChatId))
                    badGroupChatIds.add(g.groupChatId);
            }));
            if (badGroupChatIds.size) {
                await prisma_1.prisma.clientRestrictedGroup
                    .deleteMany({ where: { accountId: id, groupChatId: { in: Array.from(badGroupChatIds) } } })
                    .catch(() => { });
            }
            const restrictedGroups = restrictedGroupsRaw.filter((g) => !badGroupChatIds.has(g.groupChatId));
            // "Mensajes" es el chat con fans, no el Telegram entero de la cuenta:
            // solo chats privados + los grupos restringidos de cliente (título
            // "<modelo> y <cliente>", ya registrados en ClientRestrictedGroup al
            // crearlos desde el CRM) + las carpetas marcadas a mano en
            // Configuración ("Mostrar también en Mensajes"). El resto de
            // grupos/canales de la cuenta se quedan fuera. Se pasa YA fusionado a
            // getCachedDialogs porque listDialogs filtra en el origen: si un grupo
            // no esta en este set, ni siquiera llega hasta aqui.
            const extraChatIds = new Set(folderExtraChatIds || []);
            for (const g of restrictedGroups)
                extraChatIds.add(g.groupChatId);
            let dialogs = await (0, dialogsCache_1.getCachedDialogs)(client, id, extraChatIds);
            // Cinturón y tirantes contra "grupos de spam" colándose en Mensajes: un
            // grupo/canal registrado como grupo restringido de verdad (tabla
            // ClientRestrictedGroup) siempre se ve, da igual su título. Cualquier
            // OTRO grupo/canal (los que llegan solo por venir de una carpeta de
            // Telegram marcada a mano en Configuración) solo se ve si su título
            // sigue el patrón "<nombre de la modelo> y <cliente>" - así, si esa
            // carpeta llegase a incluir alguna vez un grupo que no es de un
            // cliente (p.ej. uno al que Telegram añade solo, tipo spam/ads), no
            // aparece en Mensajes aunque técnicamente esté en la carpeta.
            const restrictedChatIdSet = new Set(restrictedGroups.map((g) => g.groupChatId));
            const modelGroupPattern = new RegExp(`${escapeRegExp(account.label)}.*\\sy\\s`, "i");
            // Un grupo restringido de cliente de verdad es la modelo + ese cliente
            // (a veces +1 mientras la cuenta ayudante todavía no ha salido del
            // todo) - nunca más de un puñado de personas. Esto manda por encima de
            // lo demás: aunque un grupo grande esté registrado por error como
            // "restringido", o su título coincida con el patrón, si tiene más de
            // unas pocas personas dentro NO es un grupo de cliente y no debe
            // aparecer en Mensajes. (MAX_CLIENT_GROUP_MEMBERS se define mas abajo,
            // compartida con la creacion/adopcion de grupos restringidos.)
            dialogs = dialogs.filter((d) => {
                if (d.isUser)
                    return true;
                if (typeof d.participantsCount === "number" && d.participantsCount > MAX_CLIENT_GROUP_MEMBERS)
                    return false;
                if (restrictedChatIdSet.has(d.chatId))
                    return true;
                return modelGroupPattern.test(d.title);
            });
            if (excludedChatIds && excludedChatIds.size > 0) {
                dialogs = dialogs.filter((d) => !excludedChatIds.has(d.chatId));
            }
            if (q.search) {
                const s = q.search.toLowerCase();
                dialogs = dialogs.filter((d) => d.title.toLowerCase().includes(s) || d.lastMessage.toLowerCase().includes(s));
            }
            return { dialogs };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudieron leer los mensajes de Telegram. Revisa la conexión de la cuenta." });
        }
    });
    // Buscador "de verdad": no solo entre los chats ya traídos (los de arriba,
    // limitados a los mas recientes), sino en TODO el historial de Telegram de
    // la cuenta -incluidos chats con los que no se habla desde hace tiempo y
    // que por eso no aparecen en la lista normal-, usando la búsqueda global
    // de la propia Telegram. Un resultado por chat (el mensaje mas reciente
    // que coincide), para no listar 50 mensajes del mismo fan.
    app.get("/api/accounts/:id/dialogs/search-global", async (request, reply) => {
        const { id } = request.params;
        const q = request.query;
        const query = (q.q || "").trim();
        if (!query)
            return { results: [] };
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const result = await client.invoke(new telegram_1.Api.messages.SearchGlobal({
                q: query,
                filter: new telegram_1.Api.InputMessagesFilterEmpty(),
                minDate: 0,
                maxDate: 0,
                offsetRate: 0,
                offsetPeer: new telegram_1.Api.InputPeerEmpty(),
                offsetId: 0,
                limit: 50,
            }));
            const messages = result?.messages || [];
            const chatsById = new Map((result?.chats || []).map((c) => [String(c.id), c]));
            const usersById = new Map((result?.users || []).map((u) => [String(u.id), u]));
            const seenChats = new Set();
            const results = [];
            for (const m of messages) {
                const peer = m.peerId;
                if (!peer)
                    continue;
                let chatId;
                let title = "(sin nombre)";
                try {
                    chatId = telegram_1.utils.getPeerId(peer).toString();
                }
                catch {
                    continue;
                }
                if (peer.className === "PeerUser") {
                    const u = usersById.get(String(peer.userId));
                    if (u)
                        title = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || title;
                }
                else if (peer.className === "PeerChat") {
                    title = chatsById.get(String(peer.chatId))?.title || title;
                }
                else if (peer.className === "PeerChannel") {
                    title = chatsById.get(String(peer.channelId))?.title || title;
                }
                if (seenChats.has(chatId))
                    continue; // un resultado por chat (el mas reciente)
                seenChats.add(chatId);
                results.push({
                    chatId,
                    title,
                    kind: peer.className === "PeerUser" ? "user" : "group",
                    preview: (m.message ? String(m.message).slice(0, 140) : m.media ? "[archivo adjunto]" : ""),
                    date: m.date ? new Date(m.date * 1000).toISOString() : null,
                });
            }
            return { results };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo buscar en todo Telegram." });
        }
    });
    app.get("/api/accounts/:id/dialogs/:chatId/messages", async (request, reply) => {
        const { id, chatId } = request.params;
        // offsetId: para "cargar mensajes anteriores" (historial mas antiguo) sin
        // recargar toda la conversacion desde cero.
        const q = request.query;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const limit = Math.min(Number(q.limit) || 60, 200);
            const raw = await client.getMessages(entity, {
                limit,
                offsetId: q.offsetId ? Number(q.offsetId) : undefined,
            });
            const messages = raw
                .filter((m) => m.message || m.media)
                .map((m) => {
                const mediaType = m.media ? classifyGalleryMedia(m.media) : null;
                return {
                    id: m.id,
                    text: m.message || "",
                    out: !!m.out,
                    date: m.date ? new Date(m.date * 1000).toISOString() : null,
                    // El archivo en si se pide luego a /gallery/:id/thumb y
                    // /gallery/:id/media (mismos endpoints que la Galeria, ya
                    // funcionan para cualquier mensaje con media de este chat).
                    mediaType,
                    hasThumb: mediaType === "photo" || mediaType === "video",
                };
            })
                .reverse(); // mas antiguo primero, para pintar de arriba a abajo
            (0, dialogsCache_1.markDialogRead)(id, chatId);
            return { messages, hasMore: raw.length >= limit };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo cargar la conversación desde Telegram." });
        }
    });
    app.post("/api/accounts/:id/dialogs/:chatId/send", async (request, reply) => {
        const { id, chatId } = request.params;
        const { text } = request.body;
        if (!text || !text.trim()) {
            return reply.code(400).send({ error: "Falta el texto del mensaje" });
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            await client.sendMessage(entity, { message: text.trim() });
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo enviar el mensaje." });
        }
    });
    // Numero de telefono + pais detectado (icono de bandera junto al numero,
    // igual que en el panel de referencia) de un fan concreto.
    app.get("/api/accounts/:id/dialogs/:chatId/profile", async (request, reply) => {
        const { id, chatId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            let user = entity;
            // La entidad que sale de la lista de dialogos suele venir "recortada"
            // (sin telefono aunque Telegram lo dejase ver), asi que pedimos el
            // usuario completo para tener la mejor oportunidad de verlo.
            if (user.className === "User" && user.accessHash) {
                try {
                    const inputUser = new telegram_1.Api.InputUser({ userId: user.id, accessHash: user.accessHash });
                    const full = await client.invoke(new telegram_1.Api.users.GetUsers({ id: [inputUser] }));
                    if (full && full[0] && full[0].className === "User") {
                        user = full[0];
                    }
                }
                catch (e) {
                    request.log.warn(e, "No se pudo pedir el usuario completo para el telefono, uso la entidad en cache");
                }
            }
            const phone = user.phone ? "+" + user.phone : null;
            const country = (0, phoneCountry_1.countryFromPhone)(phone);
            // Telegram no da la fecha de alta por API: se estima a partir del id
            // de usuario (ver idRegistrationEstimate.ts). Siempre "aproximada".
            const registeredApprox = (0, idRegistrationEstimate_1.estimateRegistrationDate)(user.id);
            const lastSeen = formatLastSeen(user.status);
            const fanNote = await prisma_1.prisma.fanNote.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
            return {
                phone,
                country,
                registeredApprox,
                lastSeenText: lastSeen.text,
                lastSeenDate: lastSeen.date,
                autoBlockedByCountry: !!fanNote?.autoBlockedByCountry,
            };
        }
        catch (err) {
            request.log.error(err);
            const detail = err?.errorMessage || err?.message || "";
            return reply.code(502).send({ error: "No se pudo leer el número de este chat." + (detail ? ` (${detail})` : "") });
        }
    });
    // Grupos que la cuenta y este cliente tienen en común (lo mismo que
    // Telegram muestra al tocar el nombre de un contacto: "Grupos en común").
    // Sirve para encontrar el grupo restringido de este cliente si ya existía
    // de antes (creado a mano, o con otra cuenta) y el CRM todavía no lo sabe.
    app.get("/api/accounts/:id/dialogs/:chatId/common-groups", async (request, reply) => {
        const { id, chatId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const fanEntity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const fanUser = fanEntity;
            if (fanUser.className !== "User") {
                return { groups: [] }; // solo tiene sentido para chats privados (personas), no grupos/canales
            }
            const inputUser = new telegram_1.Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
            const result = await client.invoke(new telegram_1.Api.messages.GetCommonChats({ userId: inputUser, maxId: 0, limit: 100 }));
            const chats = result?.chats || [];
            const groups = chats.map((c) => ({
                chatId: (c.className === "Channel" ? "-100" + String(c.id) : "-" + String(c.id)),
                title: c.title || "",
            }));
            return { groups };
        }
        catch (err) {
            request.log.error(err);
            const detail = err?.errorMessage || err?.message || "";
            return reply.code(502).send({ error: "No se pudieron leer los grupos en común." + (detail ? ` (${detail})` : "") });
        }
    });
    // "Desbloquear" un fan que se bloqueó solo por el país de su teléfono
    // (Bloqueo automático por país): desbloquea en Telegram y marca que no se
    // le debe volver a bloquear solo, aunque siga escribiendo desde ese país.
    app.post("/api/accounts/:id/dialogs/:chatId/unblock", async (request, reply) => {
        const { id, chatId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const user = entity;
            if (user.className === "User" && user.accessHash) {
                const inputUser = new telegram_1.Api.InputUser({ userId: user.id, accessHash: user.accessHash });
                await client.invoke(new telegram_1.Api.contacts.Unblock({ id: inputUser }));
            }
            await prisma_1.prisma.fanNote.upsert({
                where: { accountId_chatId: { accountId: id, chatId } },
                update: { manuallyUnblocked: true, autoBlockedByCountry: false },
                create: { accountId: id, chatId, manuallyUnblocked: true },
            });
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo desbloquear." });
        }
    });
    // Foto de perfil del fan (o de un grupo), para pintar el avatar real en
    // vez de las iniciales. 404 si no tiene foto puesta.
    app.get("/api/accounts/:id/dialogs/:chatId/avatar", async (request, reply) => {
        const { id, chatId } = request.params;
        const cacheKey = `avatar:${id}:${chatId}`;
        const cached = (0, mediaCache_1.getCachedMedia)(cacheKey);
        if (cached) {
            reply.header("Content-Type", "image/jpeg");
            reply.header("Cache-Control", "private, max-age=1800");
            return reply.send(cached);
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const buf = (await client.downloadProfilePhoto(entity, { isBig: false }));
            if (!buf || buf.length === 0)
                return reply.code(404).send();
            (0, mediaCache_1.setCachedMedia)(cacheKey, buf);
            reply.header("Content-Type", "image/jpeg");
            reply.header("Cache-Control", "private, max-age=1800");
            return reply.send(buf);
        }
        catch (err) {
            return reply.code(404).send();
        }
    });
    // Foto de perfil de la propia cuenta (modelo), para la columna de
    // "Cuentas" del apartado Mensajes (avatar real en vez de solo iniciales).
    app.get("/api/accounts/:id/avatar", async (request, reply) => {
        const { id } = request.params;
        const cacheKey = `avatar:${id}:self`;
        const cached = (0, mediaCache_1.getCachedMedia)(cacheKey);
        if (cached) {
            reply.header("Content-Type", "image/jpeg");
            reply.header("Cache-Control", "private, max-age=1800");
            return reply.send(cached);
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const me = await client.getMe();
            const buf = (await client.downloadProfilePhoto(me, { isBig: false }));
            if (!buf || buf.length === 0)
                return reply.code(404).send();
            (0, mediaCache_1.setCachedMedia)(cacheKey, buf);
            reply.header("Content-Type", "image/jpeg");
            reply.header("Cache-Control", "private, max-age=1800");
            return reply.send(buf);
        }
        catch (err) {
            return reply.code(404).send();
        }
    });
    // Total de mensajes sin leer de una cuenta, para la insignia en la
    // columna de "Cuentas" del apartado Mensajes (igual que en el panel de
    // referencia). Usa la misma cache que la lista de dialogos, asi que no
    // supone una peticion extra a Telegram si ya se cargaron los mensajes.
    app.get("/api/accounts/:id/unread-summary", async (request, reply) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const dialogs = await (0, dialogsCache_1.getCachedDialogs)(client, id);
            // Solo chats privados: la insignia es "mensajes sin leer de fans", no
            // el total de todo Telegram (grupos/canales incluidos) de la cuenta.
            const totalUnread = dialogs.filter((d) => d.isUser).reduce((sum, d) => sum + (d.unreadCount || 0), 0);
            return { totalUnread };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo leer el resumen de mensajes." });
        }
    });
    // Mapa {chatId: lista} de todos los fans con una lista/etiqueta puesta en
    // esta cuenta, para poder filtrar la columna de Mensajes por lista sin
    // pedir la nota de cada chat una a una.
    app.get("/api/accounts/:id/fan-notes-lists", async (request) => {
        const { id } = request.params;
        const notes = await prisma_1.prisma.fanNote.findMany({
            where: { accountId: id, list: { not: null } },
            select: { chatId: true, list: true },
        });
        const lists = {};
        for (const n of notes)
            if (n.list)
                lists[n.chatId] = n.list;
        return { lists };
    });
    // "Marcar como no leído": pone en negrita/con contador la conversación en
    // el propio Telegram, igual que el botón del panel de referencia.
    app.post("/api/accounts/:id/dialogs/:chatId/mark-unread", async (request, reply) => {
        const { id, chatId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const peer = await client.getInputEntity(entity);
            await client.invoke(new telegram_1.Api.messages.MarkDialogUnread({ peer: new telegram_1.Api.InputDialogPeer({ peer }), unread: true }));
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo marcar como no leído." });
        }
    });
    // "Galería" del chat: todas las fotos/vídeos (y audios, aparte) que se han
    // intercambiado con este fan, tanto enviados por la modelo como recibidos.
    // tab: "all" | "vault" (solo lo enviado desde la bóveda) | "photo" | "video" | "audio"
    app.get("/api/accounts/:id/dialogs/:chatId/gallery", async (request, reply) => {
        const { id, chatId } = request.params;
        const q = request.query;
        const tab = q.tab || "all";
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            let raw;
            if (tab === "audio") {
                const [voice, music] = await Promise.all([
                    client.getMessages(entity, { limit: 150, filter: new telegram_1.Api.InputMessagesFilterVoice() }),
                    client.getMessages(entity, { limit: 150, filter: new telegram_1.Api.InputMessagesFilterMusic() }),
                ]);
                raw = [...voice, ...music];
            }
            else {
                const filter = tab === "photo" ? new telegram_1.Api.InputMessagesFilterPhotos()
                    : tab === "video" ? new telegram_1.Api.InputMessagesFilterVideo()
                        : new telegram_1.Api.InputMessagesFilterPhotoVideo(); // "all" y "vault"
                raw = (await client.getMessages(entity, { limit: 200, filter }));
            }
            const sendLogs = await prisma_1.prisma.contentSendLog.findMany({
                where: { accountId: id, chatId },
                select: { telegramMessageId: true },
            });
            const vaultIds = new Set(sendLogs.map((s) => s.telegramMessageId));
            let items = raw
                .filter((m) => m.media)
                .map((m) => {
                const type = classifyGalleryMedia(m.media);
                return {
                    id: m.id,
                    type,
                    out: !!m.out,
                    date: m.date ? new Date(m.date * 1000).toISOString() : null,
                    fromVault: vaultIds.has(String(m.id)),
                    hasThumb: type === "photo" || type === "video",
                };
            });
            if (tab === "vault")
                items = items.filter((it) => it.fromVault);
            items.sort((a, b) => b.id - a.id);
            return { items };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo cargar la galería de este chat." });
        }
    });
    app.get("/api/accounts/:id/dialogs/:chatId/gallery/:messageId/thumb", async (request, reply) => {
        const { id, chatId, messageId } = request.params;
        const cacheKey = `gallery-thumb:${id}:${chatId}:${messageId}`;
        const cached = (0, mediaCache_1.getCachedMedia)(cacheKey);
        if (cached) {
            reply.header("Content-Type", "image/jpeg");
            reply.header("Content-Disposition", "inline");
            reply.header("Cache-Control", "private, max-age=3600");
            return reply.send(cached);
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const [message] = (await client.getMessages(entity, { ids: [Number(messageId)] }));
            if (!message || !message.media)
                return reply.code(404).send();
            const buf = (await withGalleryThumbSlot(() => client.downloadMedia(message, { thumb: -1 })));
            if (!buf)
                return reply.code(404).send();
            (0, mediaCache_1.setCachedMedia)(cacheKey, buf);
            reply.header("Content-Type", "image/jpeg");
            reply.header("Content-Disposition", "inline");
            reply.header("Cache-Control", "private, max-age=3600");
            return reply.send(buf);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(404).send();
        }
    });
    app.get("/api/accounts/:id/dialogs/:chatId/gallery/:messageId/media", async (request, reply) => {
        const { id, chatId, messageId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const [message] = (await client.getMessages(entity, { ids: [Number(messageId)] }));
            if (!message || !message.media)
                return reply.code(404).send();
            const size = message.media?.document?.size;
            const sizeBytes = size !== undefined && size !== null ? Number(size) : null;
            if (sizeBytes && sizeBytes > MAX_GALLERY_MEDIA_BYTES) {
                return reply.code(413).send({ error: "Este archivo pesa demasiado para verlo aquí (más de 60MB)." });
            }
            let buf = (await withGalleryMediaSlot(() => client.downloadMedia(message, {})));
            if (!buf)
                return reply.code(404).send();
            const converted = await convertHeicIfNeeded(buf, galleryMediaMimeType(message.media));
            reply.header("Content-Type", converted.mimeType);
            reply.header("Content-Disposition", "inline");
            reply.header("Cache-Control", "private, max-age=1800");
            return reply.send(converted.buf);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(404).send();
        }
    });
    // Recorre los grupos basicos (no canales/supergrupos, que es lo que crea
    // este boton) de la cuenta buscando uno en el que ya este metido este fan
    // en concreto -para no crear un grupo restringido duplicado si ya existia
    // uno (creado a mano, o antes de tener este boton en el panel)-.
    // Antes de intentar meter al cliente en el grupo restringido: lo añadimos
    // como contacto (sin nombre completo, solo lo justo para que cuente como
    // contacto). Muchos clientes tienen la privacidad de Telegram puesta en
    // "solo mis contactos pueden añadirme a grupos" - añadirlo a los
    // contactos de la cuenta que va a invitarlo suele bastar para saltarse
    // esa restricción, sin que el cliente tenga que hacer nada ni note nada
    // raro (no le llega notificación ni mensaje por esto). Si falla (ya lo
    // era, o Telegram lo rechaza por otro motivo) seguimos igual: es solo un
    // intento extra para mejorar las probabilidades, nunca bloquea el resto.
    async function addFanAsContact(client, fanUser, fanTitle) {
        try {
            await client.invoke(new telegram_1.Api.contacts.AddContact({
                id: new telegram_1.Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash }),
                firstName: fanTitle || fanUser.firstName || "Cliente",
                lastName: "",
                phone: fanUser.phone || "",
                addPhonePrivacyException: false,
            }));
        }
        catch {
            // no pasa nada: seguimos aunque no se haya podido añadir como contacto
        }
    }
    // Comprueba si el cliente esta REALMENTE dentro del grupo (no solo que el
    // grupo exista). Sin esto, un AddChatUser que Telegram rechaza en
    // silencio (p.ej. porque el cliente tiene la privacidad puesta para no
    // dejarse añadir por quien no es su contacto) dejaba un grupo "fantasma"
    // con solo la modelo dentro, que el CRM daba igualmente por creado.
    async function chatHasFan(client, rawChatId, fanUserId) {
        try {
            const full = await client.invoke(new telegram_1.Api.messages.GetFullChat({ chatId: rawChatId }));
            const participants = full?.fullChat?.participants?.participants || [];
            return participants.some((p) => String(p.userId) === String(fanUserId));
        }
        catch {
            return false;
        }
    }
    // Ultimo recurso si, ni siquiera añadiendolo como contacto, Telegram deja
    // meter al cliente directamente en el grupo (privacidad muy estricta):
    // se genera un enlace de invitación de ese grupo para que el propio
    // cliente pueda entrar solo con tocarlo, sin que haga falta que nadie le
    // "añada" - un enlace SÍ se puede mandar aunque la privacidad de grupos
    // esté restringida, porque es el cliente quien decide entrar.
    async function exportGroupInviteLink(client, rawChatId) {
        try {
            const result = await client.invoke(new telegram_1.Api.messages.ExportChatInvite({ peer: new telegram_1.Api.InputPeerChat({ chatId: rawChatId }) }));
            return result?.link || null;
        }
        catch {
            return null;
        }
    }
    // Un grupo restringido de cliente de verdad es solo la modelo + ese
    // cliente (como mucho +1 mientras la cuenta ayudante todavia no ha
    // salido del todo) - nunca mas de un puñado de personas. Se comparte con
    // el filtro de "Mensajes" en /dialogs para que el mismo criterio decida
    // en todos lados que SÍ es un grupo de cliente.
    const MAX_CLIENT_GROUP_MEMBERS = 3;
    // Comprueba (con una llamada real a Telegram, no lo que haya guardado en
    // el CRM) si un grupo ya guardado como "restringido" de un cliente tiene
    // en realidad mas gente de la cuenta - es decir, si es un grupo publico o
    // de spam al que el cliente se unio por su cuenta y que una version
    // anterior de "buscar grupo ya existente" adopto por error solo porque el
    // cliente resultaba estar dentro. Devuelve true si hay que descartarlo.
    async function isGroupTooLargeForClient(client, groupChatId) {
        try {
            const entity = await (0, dialogs_1.resolveEntityById)(client, groupChatId);
            if (entity?.className === "Channel") {
                const participants = await client.getParticipants(entity, { limit: MAX_CLIENT_GROUP_MEMBERS + 1 });
                return participants.length > MAX_CLIENT_GROUP_MEMBERS;
            }
            const rawChatId = groupChatId.startsWith("-") ? groupChatId.slice(1) : groupChatId;
            const full = await client.invoke(new telegram_1.Api.messages.GetFullChat({ chatId: rawChatId }));
            const participants = full?.fullChat?.participants?.participants || [];
            return participants.length > MAX_CLIENT_GROUP_MEMBERS;
        }
        catch {
            return false; // si no se puede comprobar ahora mismo, mejor no borrar nada por si acaso
        }
    }
    // La comprobacion de arriba pide datos reales a Telegram (participantes),
    // asi que la cacheamos un rato en memoria: /dialogs (la lista de
    // Mensajes) la usa para limpiar TODOS los grupos restringidos de la
    // cuenta en cada carga, y sin cache eso multiplicaria las llamadas a
    // Telegram en cada refresco de la lista sin necesidad (un grupo que hoy
    // es pequeño no se va a volver spam de un momento a otro).
    const groupSizeCheckCache = new Map();
    const GROUP_SIZE_CHECK_TTL_MS = 10 * 60 * 1000;
    async function isGroupTooLargeForClientCached(client, groupChatId) {
        const cached = groupSizeCheckCache.get(groupChatId);
        if (cached && Date.now() - cached.checkedAt < GROUP_SIZE_CHECK_TTL_MS)
            return cached.tooLarge;
        const tooLarge = await isGroupTooLargeForClient(client, groupChatId);
        groupSizeCheckCache.set(groupChatId, { tooLarge, checkedAt: Date.now() });
        return tooLarge;
    }
    // Si el grupo restringido guardado en el CRM para este cliente resulta
    // (comprobado de verdad contra Telegram) ser en realidad un grupo grande
    // - dato corrupto de antes de este arreglo -, lo borramos del CRM para
    // que se pueda crear/adoptar el grupo de verdad la proxima vez, en vez de
    // seguir devolviendo para siempre ese grupo ajeno como si fuera el suyo.
    async function validateRestrictedGroupRecord(client, existing) {
        if (!existing)
            return null;
        const tooLarge = await isGroupTooLargeForClient(client, existing.groupChatId);
        if (!tooLarge)
            return existing;
        await prisma_1.prisma.clientRestrictedGroup
            .delete({ where: { accountId_chatId: { accountId: existing.accountId, chatId: existing.chatId } } })
            .catch(() => { });
        (0, dialogsCache_1.clearDialogsCache)(existing.accountId);
        return null;
    }
    async function findExistingRestrictedGroup(client, fanUserId) {
        let dialogs;
        try {
            dialogs = await client.getDialogs({ limit: 400 });
        }
        catch {
            return null;
        }
        for (const dialog of dialogs) {
            if (!dialog.isGroup)
                continue; // grupos con miembros (basicos y supergrupos), nunca privados ni canales de difusion
            const entity = dialog.entity;
            if (!entity || entity.id === undefined)
                continue;
            try {
                let hasFan = false;
                let participantsCount = 0;
                if (entity.className === "Channel") {
                    // Supergrupo: puede pasar sin avisar (Telegram "sube de categoria"
                    // un grupo basico solo al crecer, o admins lo convierten a mano).
                    // GetFullChat es solo para grupos BASICOS - contra un supergrupo
                    // Telegram la rechaza, y antes eso hacia que el grupo se saltase
                    // en silencio y pareciese "no existe" aunque el cliente ya
                    // estuviera dentro. Pedimos como mucho MAX+1 participantes: nos
                    // basta para saber que es "demasiada gente", y evita traernos 200
                    // miembros de un canal de spam solo para descartarlo.
                    const participants = await client.getParticipants(entity, { limit: MAX_CLIENT_GROUP_MEMBERS + 1 });
                    participantsCount = participants.length;
                    hasFan = participants.some((p) => String(p.id) === String(fanUserId));
                }
                else {
                    const full = await client.invoke(new telegram_1.Api.messages.GetFullChat({ chatId: entity.id }));
                    const participants = full?.fullChat?.participants?.participants || [];
                    participantsCount = participants.length;
                    hasFan = participants.some((p) => String(p.userId) === String(fanUserId));
                }
                // Si el grupo tiene mas gente que la modelo + el cliente (+1 margen),
                // NUNCA es un grupo restringido de cliente de verdad, aunque el
                // cliente sea miembro - por ejemplo un grupo publico o de spam al
                // que se unio el solo. No lo adoptamos como "su" grupo restringido:
                // sin este corte, el CRM colaba grupos de spam como si fueran el
                // grupo del cliente (y ademas nunca llegaba a crear el de verdad,
                // porque siempre "encontraba" este primero).
                if (participantsCount > MAX_CLIENT_GROUP_MEMBERS)
                    continue;
                if (hasFan)
                    return { chatId: dialog.id.toString(), title: dialog.title || "" };
            }
            catch {
                // este grupo no se pudo leer (quiza ya no somos miembros): seguimos con el siguiente
            }
        }
        return null;
    }
    // "Grupos restringidos → Cuenta ayudante": si Telegram rechaza crear el
    // grupo desde la cuenta principal (USER_RESTRICTED), la cuenta ayudante
    // crea un grupo con la principal, sale de él (dejando solo a la
    // principal dentro) y la PROPIA cuenta principal añade al cliente -
    // invitar a un grupo ya existente no suele tener la misma restricción
    // que crear uno nuevo-. Para que la ayudante pueda crear el grupo con la
    // principal, ambas cuentas deben ya conocerse en Telegram (ser
    // contactos entre sí o haber chateado antes); si no, se informa del
    // motivo en vez de fallar en silencio.
    async function createRestrictedGroupViaHelper(request, account, fanUser, fanTitle, primaryClient) {
        const helperAccount = await prisma_1.prisma.account.findUnique({ where: { id: account.restrictedGroupHelperAccountId } });
        if (!helperAccount)
            throw new Error("La cuenta ayudante configurada ya no existe.");
        const helperClient = await (0, connectionPool_1.getAccountClient)(helperAccount);
        let primaryInput;
        try {
            primaryInput = await helperClient.getInputEntity(account.phoneNumber);
        }
        catch {
            throw new Error(`"${helperAccount.label}" (la cuenta ayudante) no reconoce a "${account.label}" en Telegram. Tienen que ser contactos entre sí (o haber hablado antes) para que la ayudante pueda crear el grupo con ella.`);
        }
        const title = `${account.label} y ${fanTitle}`;
        const created = await helperClient.invoke(new telegram_1.Api.messages.CreateChat({ users: [primaryInput], title }));
        const updates = created?.updates || created;
        const chat = updates?.chats?.[0];
        if (!chat || chat.id === undefined)
            throw new Error("La cuenta ayudante no pudo crear el grupo.");
        const rawId = chat.id;
        const groupChatId = "-" + String(rawId);
        try {
            await helperClient.invoke(new telegram_1.Api.messages.ToggleNoForwards({ peer: new telegram_1.Api.InputPeerChat({ chatId: rawId }), enabled: true }));
        }
        catch (err) {
            request.log.warn(err, "No se pudo activar restringir-guardar en el grupo creado por la cuenta ayudante");
        }
        // La ayudante sale, dejando dentro solo a la cuenta principal.
        try {
            await helperClient.invoke(new telegram_1.Api.messages.DeleteChatUser({ chatId: rawId, userId: new telegram_1.Api.InputUserSelf() }));
        }
        catch (err) {
            request.log.warn(err, "La cuenta ayudante no pudo salir del grupo restringido recién creado");
        }
        // La cuenta principal (ya dentro) invita al cliente ella misma.
        await addFanAsContact(primaryClient, fanUser, fanTitle);
        let addErr = null;
        try {
            const inputFan = new telegram_1.Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
            await primaryClient.invoke(new telegram_1.Api.messages.AddChatUser({ chatId: rawId, userId: inputFan, fwdLimit: 100 }));
        }
        catch (err) {
            addErr = err;
            request.log.warn(err, "No se pudo añadir al cliente tras crear el grupo con la cuenta ayudante");
        }
        // Confirmamos con la cuenta PRINCIPAL (que es la que se queda dentro y
        // la que usará el grupo de verdad) que lo ve de verdad, antes de que el
        // CRM lo de por creado. Si la ayudante "crea" el grupo pero la
        // principal no llega a verlo (por ejemplo si tampoco pudo entrar), es
        // mejor avisar que guardar en el CRM un grupo fantasma.
        try {
            await primaryClient.invoke(new telegram_1.Api.messages.GetFullChat({ chatId: rawId }));
        }
        catch {
            throw new Error(`"${helperAccount.label}" creó un grupo, pero "${account.label}" no lo ve en su propio Telegram. No se ha guardado nada; puede que la principal tampoco pudiera entrar.`);
        }
        // Comprobación real: ¿el cliente está de verdad dentro? Si AddChatUser
        // falló (o Telegram lo aceptó pero no lo reflejó), esto lo detecta -
        // antes se guardaba el grupo como "creado" igualmente y el cliente
        // nunca llegaba a estar en él. Aun así guardamos el grupo (no lo
        // descartamos): así la próxima vez que pulse el botón no se crea OTRO
        // grupo duplicado, y "Reintentar añadir" (🔁) puede seguir intentándolo
        // sobre este mismo grupo.
        const fanIsIn = await chatHasFan(primaryClient, rawId, fanUser.id);
        if (!fanIsIn) {
            const reason = addErr?.errorMessage || addErr?.message;
            const inviteLink = await exportGroupInviteLink(primaryClient, rawId);
            return {
                groupChatId,
                title,
                fanAdded: false,
                inviteLink,
                warning: `Se creó el grupo, pero el cliente no quedó dentro` +
                    (reason ? ` (Telegram dijo: ${reason})` : "") +
                    (inviteLink
                        ? `. Te copiamos un enlace de invitación al grupo - mándaselo por privado para que entre él mismo.`
                        : `. Prueba a reintentarlo con 🔁, o pídele que te añada como contacto primero.`),
            };
        }
        return { groupChatId, title, fanAdded: true };
    }
    // ---------- Grupo restringido del cliente ----------
    // Para ciertos servicios de pago (que el cliente no pueda guardar el
    // contenido) se trabaja desde un grupo aparte con SOLO la modelo y ese
    // cliente, con "restringir guardar contenido" de Telegram activado. Se
    // trabaja/chatea normalmente desde el chat privado; este grupo es solo
    // para el envío puntual de ese contenido protegido.
    app.get("/api/accounts/:id/dialogs/:chatId/restricted-group", async (request) => {
        const { id, chatId } = request.params;
        let group = await prisma_1.prisma.clientRestrictedGroup.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
        if (group) {
            // Antes de decirle al boton "ya existe, ve para alla" nos aseguramos
            // de que sigue siendo un grupo de verdad de este cliente (y no un
            // grupo grande adoptado por error en el pasado) - si no se puede
            // comprobar ahora mismo (cuenta desconectada, etc.) se muestra lo que
            // haya en el CRM en vez de dar error, para no romper el boton.
            try {
                const account = await prisma_1.prisma.account.findUnique({ where: { id } });
                if (account) {
                    const client = await (0, connectionPool_1.getAccountClient)(account);
                    group = await validateRestrictedGroupRecord(client, group);
                }
            }
            catch {
                // sigue con lo que ya teniamos
            }
        }
        return { exists: !!group, groupChatId: group?.groupChatId ?? null, groupTitle: group?.groupTitle ?? null };
    });
    // Crea el grupo restringido si no existe todavia, o devuelve el que ya hay.
    app.post("/api/accounts/:id/dialogs/:chatId/restricted-group", async (request, reply) => {
        const { id, chatId } = request.params;
        const body = request.body;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            let existing = await prisma_1.prisma.clientRestrictedGroup.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
            // Misma autolimpieza que en GET: si lo guardado resulta ser un grupo
            // grande (dato corrupto de antes de este arreglo), se descarta aqui
            // en vez de devolverlo como si fuera valido, para que el codigo de
            // abajo pueda crear/adoptar el grupo de verdad de este cliente.
            existing = await validateRestrictedGroupRecord(client, existing);
            if (existing)
                return { ok: true, groupChatId: existing.groupChatId, groupTitle: existing.groupTitle, created: false };
            const fanEntity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const fanUser = fanEntity;
            // Antes de crear uno nuevo: puede que el grupo YA exista en Telegram
            // (creado a mano, o antes de tener este botón) y el CRM simplemente no
            // lo supiera todavía. Si lo encontramos, lo adoptamos en vez de crear
            // un duplicado.
            const found = await findExistingRestrictedGroup(client, fanUser.id);
            if (found) {
                await prisma_1.prisma.clientRestrictedGroup.create({
                    data: { accountId: id, chatId, groupChatId: found.chatId, groupTitle: found.title },
                });
                (0, dialogsCache_1.clearDialogsCache)(id); // para que aparezca en Mensajes ya mismo, sin esperar al refresco de 3 min
                return { ok: true, groupChatId: found.chatId, groupTitle: found.title, created: false };
            }
            const inputFan = new telegram_1.Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
            const fanTitle = body.fanTitle || fanUser.firstName || "Cliente";
            const title = `${account.label} y ${fanTitle}`;
            await addFanAsContact(client, fanUser, fanTitle);
            let created;
            try {
                created = await client.invoke(new telegram_1.Api.messages.CreateChat({ users: [inputFan], title }));
            }
            catch (err) {
                const msg = err?.errorMessage || err?.message || "";
                if (/USER_RESTRICTED/.test(msg) && account.restrictedGroupHelperAccountId) {
                    const viaHelper = await createRestrictedGroupViaHelper(request, account, fanUser, fanTitle, client);
                    await prisma_1.prisma.clientRestrictedGroup.create({
                        data: { accountId: id, chatId, groupChatId: viaHelper.groupChatId, groupTitle: viaHelper.title },
                    });
                    (0, dialogsCache_1.clearDialogsCache)(id);
                    return {
                        ok: true,
                        groupChatId: viaHelper.groupChatId,
                        groupTitle: viaHelper.title,
                        created: true,
                        viaHelper: true,
                        fanAdded: viaHelper.fanAdded,
                        warning: viaHelper.warning,
                        inviteLink: viaHelper.inviteLink,
                    };
                }
                throw err;
            }
            const updates = created?.updates || created;
            const chat = updates?.chats?.[0];
            if (!chat || chat.id === undefined) {
                return reply.code(502).send({ error: "Telegram no devolvió el grupo creado." });
            }
            const rawId = chat.id;
            const groupChatId = "-" + String(rawId);
            // Antes de dar por buena la creación (y guardarla en el CRM como si
            // ya existiera de verdad): confirmamos con Telegram que el grupo
            // existe realmente. Sin esto, un CreateChat que Telegram acepta a
            // medias (o cuya respuesta no refleja lo que de verdad pasó del lado
            // de Telegram) se quedaba guardado en el CRM como "creado" aunque en
            // la app real no hubiera grupo, y a partir de ahí el CRM lo daba
            // siempre por bueno sin volver a comprobarlo.
            try {
                await client.invoke(new telegram_1.Api.messages.GetFullChat({ chatId: rawId }));
            }
            catch (err) {
                request.log.error(err, "El grupo restringido recien creado no se pudo confirmar en Telegram");
                return reply.code(502).send({
                    error: "Telegram dijo que había creado el grupo, pero no se pudo confirmar que existe de verdad. No se ha guardado nada; vuelve a intentarlo.",
                });
            }
            // "Restringir guardar contenido": el cliente no puede reenviar/guardar
            // lo que se mande en este grupo.
            try {
                await client.invoke(new telegram_1.Api.messages.ToggleNoForwards({ peer: new telegram_1.Api.InputPeerChat({ chatId: rawId }), enabled: true }));
            }
            catch (err) {
                request.log.warn(err, "No se pudo activar restringir-guardar en el grupo recien creado");
            }
            // Comprobación real: aunque Telegram haya "aceptado" crear el grupo
            // con el cliente incluido, a veces lo acepta sin llegar a meterlo de
            // verdad (privacidad del cliente). Sin esto se guardaba el grupo como
            // "creado" y el cliente nunca llegaba a estar dentro.
            let fanAdded = await chatHasFan(client, rawId, fanUser.id);
            let warning;
            let inviteLink = null;
            if (!fanAdded) {
                try {
                    await client.invoke(new telegram_1.Api.messages.AddChatUser({ chatId: rawId, userId: inputFan, fwdLimit: 0 }));
                    fanAdded = await chatHasFan(client, rawId, fanUser.id);
                }
                catch (err) {
                    request.log.warn(err, "No se pudo añadir al cliente al grupo recien creado");
                }
                if (!fanAdded) {
                    inviteLink = await exportGroupInviteLink(client, rawId);
                    warning =
                        "Se creó el grupo, pero el cliente no quedó dentro." +
                            (inviteLink
                                ? " Te copiamos un enlace de invitación al grupo - mándaselo por privado para que entre él mismo."
                                : " Suele pasar cuando el cliente tiene su privacidad puesta para que solo sus contactos le añadan a grupos - prueba a reintentarlo con 🔁, o pídele que te añada como contacto primero.");
                }
            }
            await prisma_1.prisma.clientRestrictedGroup.create({
                data: { accountId: id, chatId, groupChatId, groupTitle: title },
            });
            (0, dialogsCache_1.clearDialogsCache)(id);
            return { ok: true, groupChatId, groupTitle: title, created: true, fanAdded, warning, inviteLink };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo crear el grupo restringido." });
        }
    });
    // "Reintentar añadir al cliente a su grupo restringido": por si salió del
    // grupo o falló al crearlo la primera vez.
    app.post("/api/accounts/:id/dialogs/:chatId/restricted-group/retry-add", async (request, reply) => {
        const { id, chatId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        let group = await prisma_1.prisma.clientRestrictedGroup.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
        if (!group)
            return reply.code(404).send({ error: "Este cliente todavía no tiene grupo restringido creado." });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            // Igual que en GET/POST: si lo guardado resulta ser un grupo grande
            // (dato corrupto de antes de este arreglo), no reintentamos añadir al
            // cliente ahi - se borra y se pide crear el grupo de verdad.
            group = await validateRestrictedGroupRecord(client, group);
            if (!group) {
                return reply.code(404).send({
                    error: "El grupo guardado para este cliente no era válido y se ha descartado. Pulsa de nuevo el botón para crear el grupo restringido de verdad.",
                });
            }
            const fanEntity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            const fanUser = fanEntity;
            const inputFan = new telegram_1.Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
            const rawChatId = group.groupChatId.startsWith("-") ? group.groupChatId.slice(1) : group.groupChatId;
            await addFanAsContact(client, fanUser, fanUser.firstName || "Cliente");
            try {
                await client.invoke(new telegram_1.Api.messages.AddChatUser({ chatId: rawChatId, userId: inputFan, fwdLimit: 0 }));
            }
            catch (err) {
                request.log.warn(err, "Reintento de añadir al cliente al grupo restringido: Telegram lo rechazó");
            }
            const fanAdded = await chatHasFan(client, rawChatId, fanUser.id);
            if (!fanAdded) {
                const inviteLink = await exportGroupInviteLink(client, rawChatId);
                return reply.code(502).send({
                    error: inviteLink
                        ? "El cliente sigue sin poder entrar directamente. Te copiamos un enlace de invitación - mándaselo por privado para que entre él mismo."
                        : "Telegram aceptó la petición, pero el cliente sigue sin aparecer dentro del grupo. Puede que su privacidad no deje que le añadan sin haber hablado antes por privado.",
                    inviteLink,
                });
            }
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo volver a añadir al cliente al grupo." });
        }
    });
    // Programa un mensaje para mandarlo mas tarde (envio nativo programado de
    // Telegram: lo entrega Telegram en el momento exacto, sin depender de que
    // el CRM este despierto en ese instante).
    app.post("/api/accounts/:id/dialogs/:chatId/schedule", async (request, reply) => {
        const { id, chatId } = request.params;
        const body = request.body;
        if (!body.text || !body.text.trim())
            return reply.code(400).send({ error: "Falta el texto del mensaje" });
        if (!body.sendAt)
            return reply.code(400).send({ error: "Falta la fecha/hora de envío" });
        const sendAt = new Date(body.sendAt);
        if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
            return reply.code(400).send({ error: "La fecha tiene que ser en el futuro" });
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveDialogEntity)(client, id, chatId);
            await client.sendMessage(entity, { message: body.text.trim(), schedule: Math.floor(sendAt.getTime() / 1000) });
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo programar el mensaje." });
        }
    });
    // "Notas de la modelo": info general de la cuenta.
    app.get("/api/accounts/:id/note", async (request) => {
        const { id } = request.params;
        const note = await prisma_1.prisma.accountNote.findUnique({ where: { accountId: id } });
        return { note: note?.info ?? "" };
    });
    app.put("/api/accounts/:id/note", async (request) => {
        const { id } = request.params;
        const { note } = request.body;
        await prisma_1.prisma.accountNote.upsert({
            where: { accountId: id },
            update: { info: note ?? "" },
            create: { accountId: id, info: note ?? "" },
        });
        return { ok: true };
    });
    // "Notas del fan": una nota por conversacion, con lista/etiqueta.
    app.get("/api/accounts/:id/dialogs/:chatId/note", async (request) => {
        const { id, chatId } = request.params;
        const note = await prisma_1.prisma.fanNote.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
        return { note: note?.note ?? "", list: note?.list ?? null };
    });
    // "Vendido a este fan": historial de ventas de un chat concreto.
    app.get("/api/accounts/:id/dialogs/:chatId/sales", async (request) => {
        const { id, chatId } = request.params;
        const sales = await prisma_1.prisma.fanSale.findMany({ where: { accountId: id, chatId }, orderBy: { date: "desc" } });
        const total = sales.reduce((sum, s) => sum + s.amount, 0);
        return { sales, total };
    });
    app.post("/api/accounts/:id/dialogs/:chatId/sales", async (request, reply) => {
        const { id, chatId } = request.params;
        const body = request.body;
        if (!body.amount || body.amount <= 0) {
            return reply.code(400).send({ error: "Falta el importe de la venta" });
        }
        // Aseguramos que exista la nota del fan (aunque este vacia), para que aparezca en listados.
        await prisma_1.prisma.fanNote.upsert({
            where: { accountId_chatId: { accountId: id, chatId } },
            update: body.chatTitle ? { chatTitle: body.chatTitle } : {},
            create: { accountId: id, chatId, chatTitle: body.chatTitle },
        });
        const sale = await prisma_1.prisma.fanSale.create({
            data: {
                accountId: id,
                chatId,
                amount: body.amount,
                date: body.date ? new Date(body.date) : new Date(),
                service: body.service || null,
                paymentMethod: body.paymentMethod || null,
                soldBy: body.soldBy || null,
                detail: body.detail || null,
                paymentRef: body.paymentRef || null,
            },
        });
        return { sale };
    });
    app.delete("/api/sales/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.fanSale.delete({ where: { id } });
        return { ok: true };
    });
    // "Scripts": mensajes guardados para insertar rapido en la conversacion.
    app.get("/api/accounts/:id/scripts", async (request) => {
        const { id } = request.params;
        const scripts = await prisma_1.prisma.script.findMany({ where: { accountId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
        return { scripts };
    });
    app.post("/api/accounts/:id/scripts", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const script = await prisma_1.prisma.script.create({ data: { accountId: id, title: body.title, content: body.content } });
        return { script };
    });
    app.patch("/api/scripts/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const script = await prisma_1.prisma.script.update({ where: { id }, data: body });
        return { script };
    });
    app.delete("/api/scripts/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.script.delete({ where: { id } });
        return { ok: true };
    });
    app.put("/api/accounts/:id/dialogs/:chatId/note", async (request) => {
        const { id, chatId } = request.params;
        const body = request.body;
        await prisma_1.prisma.fanNote.upsert({
            where: { accountId_chatId: { accountId: id, chatId } },
            update: { note: body.note ?? "", list: body.list ?? null, chatTitle: body.chatTitle },
            create: {
                accountId: id,
                chatId,
                note: body.note ?? "",
                list: body.list ?? null,
                chatTitle: body.chatTitle,
            },
        });
        syncFanToTelegramFolder(app, id, chatId, body.list);
        return { ok: true };
    });
    // Stream en tiempo real (Server-Sent Events) de mensajes nuevos de esta
    // cuenta: cuando llega o se envia un mensaje de Telegram, se empuja aqui
    // al instante, para que el panel no dependa de refrescar a mano.
    app.get("/api/accounts/:id/stream", async (request, reply) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        reply.raw.write("retry: 2000\n\n");
        try {
            await (0, connectionPool_1.getAccountClient)(account); // asegura que el cliente (y su listener) esta conectado
        }
        catch (err) {
            request.log.error(err);
        }
        const unsubscribe = (0, liveEvents_1.subscribeToAccountEvents)(id, (evt) => {
            reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
        });
        const keepAlive = setInterval(() => {
            try {
                reply.raw.write(": ping\n\n");
            }
            catch { /* conexion cerrada */ }
        }, 20000);
        request.raw.on("close", () => {
            clearInterval(keepAlive);
            unsubscribe();
        });
    });
}
//# sourceMappingURL=messages.js.map