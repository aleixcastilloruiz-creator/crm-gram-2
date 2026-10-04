"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_FULL_MEDIA_BYTES = exports.withFullMediaSlot = void 0;
exports.clearContentFullMediaCache = clearContentFullMediaCache;
exports.getContentGroupEntity = getContentGroupEntity;
exports.getContentMessage = getContentMessage;
exports.mediaSizeBytes = mediaSizeBytes;
exports.registerContentLibraryRoutes = registerContentLibraryRoutes;
const telegram_1 = require("telegram");
const uploads_1 = require("telegram/client/uploads");
const Helpers_1 = require("telegram/Helpers");
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const dialogs_1 = require("../telegram/dialogs");
const sender_1 = require("../engine/sender");
const mediaCache_1 = require("../telegram/mediaCache");
const messages_1 = require("./messages");
/** Registra (best-effort, nunca hace fallar el envío) que un mensaje
 * recién enviado a un fan viene de la bóveda, para la etiqueta "GRUPO" de la
 * Galería del chat. */
async function logContentSend(accountId, chatId, result) {
    try {
        const ids = (0, messages_1.extractSentMessageIds)(result);
        if (ids.length === 0)
            return;
        await prisma_1.prisma.contentSendLog.createMany({
            data: ids.map((telegramMessageId) => ({ accountId, chatId, telegramMessageId })),
            skipDuplicates: true,
        });
    }
    catch {
        // no pasa nada si esto falla, el envío ya se hizo
    }
}
// Valor "magico" de Telegram para que una foto/vídeo se autodestruya nada
// mas verse una vez (en vez de una cuenta atras en segundos concretos).
const TTL_VIEW_ONCE = 0x7fffffff;
// Si un tema tiene muchos archivos (60-80+), el navegador pide todas las
// miniaturas casi a la vez. Bajarlas todas en paralelo satura la conexion
// de Telegram (y la memoria del contenedor) y muchas acaban fallando (imagen
// rota) o, en el peor caso, tirando abajo el proceso entero. Con un pequeño
// semaforo por tipo de descarga solo dejamos unas pocas a la vez; el resto
// espera su turno en vez de fallar/reventar la memoria.
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
// Miniaturas: pesan poco (unos KB), toleran mas paralelismo.
const withThumbSlot = makeSlotLimiter(10);
// Algunos mensajes (documentos, stickers, contenido reenviado con
// "no reenviar", etc.) nunca van a poder generar una miniatura: cada intento
// hace 1-3 descargas a Telegram en serie antes de rendirse. Sin esto, cada
// vez que se abre la bóveda se repiten esos intentos fallidos para los
// mismos mensajes, lo cual es la parte más lenta de la rejilla. Guardamos
// durante un rato corto qué mensajes fallaron para devolver 404 al instante
// la próxima vez, en vez de repetir la descarga.
// OJO: esto antes duraba 10 minutos, y un fallo TRANSITORIO (un FLOOD_WAIT
// puntual, un corte de red al descargar) se guardaba igual que uno
// permanente — así que una miniatura que fallara una vez por mala suerte se
// quedaba rota (🖼️) durante los siguientes 10 minutos aunque se recargara la
// página o se reabriera la carpeta. Bajarlo a un minuto es tiempo de sobra
// para no martillear a Telegram con los mensajes que de verdad nunca van a
// tener miniatura, sin castigar tanto rato a los que fallaron por algo
// puntual.
const FAILED_THUMB_TTL_MS = 60 * 1000;
const failedThumbCache = new Map();
function isRecentlyFailedThumb(key) {
    const at = failedThumbCache.get(key);
    if (at === undefined)
        return false;
    if (Date.now() - at > FAILED_THUMB_TTL_MS) {
        failedThumbCache.delete(key);
        return false;
    }
    return true;
}
function markFailedThumb(key) {
    // Evita que este mapa crezca sin límite en un proceso de larga duración.
    if (failedThumbCache.size > 2000)
        failedThumbCache.clear();
    failedThumbCache.set(key, Date.now());
}
// Archivo COMPLETO (vista grande / envío "ver una vez"): un vídeo puede
// pesar decenas de MB, así que aquí somos mucho más estrictos para no
// comernos la RAM del contenedor con varias descargas grandes a la vez.
exports.withFullMediaSlot = makeSlotLimiter(2);
// Si el archivo es descomunal (mas de 60MB), mejor fallar con un mensaje
// claro que arriesgarnos a que el proceso se quede sin memoria.
exports.MAX_FULL_MEDIA_BYTES = 60 * 1024 * 1024;
// Cache pequeña y aparte (no la de miniaturas) para la vista grande: si
// alguien reabre el mismo vídeo/foto en la misma sesión, la segunda vez es
// instantánea. Pocas entradas y solo archivos no muy grandes, para no
// comernos la memoria del contenedor con vídeos guardados sin usar.
const FULL_MEDIA_CACHE_MAX_ENTRIES = 12;
const FULL_MEDIA_CACHE_MAX_BYTES = 15 * 1024 * 1024;
const fullMediaCache = new Map();
function getCachedFullMedia(key) {
    const buf = fullMediaCache.get(key);
    if (buf) {
        fullMediaCache.delete(key);
        fullMediaCache.set(key, buf);
    }
    return buf;
}
function setCachedFullMedia(key, buf) {
    if (buf.length > FULL_MEDIA_CACHE_MAX_BYTES)
        return;
    if (fullMediaCache.size >= FULL_MEDIA_CACHE_MAX_ENTRIES) {
        const oldest = fullMediaCache.keys().next().value;
        if (oldest !== undefined)
            fullMediaCache.delete(oldest);
    }
    fullMediaCache.set(key, buf);
}
/** Para el botón "Vaciar caché" de Configuración → General. */
function clearContentFullMediaCache() {
    fullMediaCache.clear();
}
const groupEntityCache = new Map();
const GROUP_ENTITY_TTL_MS = 10 * 60 * 1000;
async function getContentGroupEntity(client, accountId, chatId) {
    const cached = groupEntityCache.get(accountId);
    if (cached && Date.now() - cached.loadedAt < GROUP_ENTITY_TTL_MS)
        return cached.entity;
    try {
        const entity = await client.getEntity(chatId);
        groupEntityCache.set(accountId, { entity, loadedAt: Date.now() });
        return entity;
    }
    catch (err) {
        // Refrescamos la lista de dialogos (esto repuebla la cache interna de
        // Telegram con el access_hash del grupo) y lo intentamos una vez mas.
        await client.getDialogs({ limit: 400 });
        const entity = await client.getEntity(chatId);
        groupEntityCache.set(accountId, { entity, loadedAt: Date.now() });
        return entity;
    }
}
const topicsCache = new Map();
const TOPICS_TTL_MS = 10 * 60 * 1000;
const itemsCache = new Map();
const ITEMS_TTL_MS = 45 * 1000;
function getCachedItems(key) {
    const entry = itemsCache.get(key);
    if (!entry)
        return null;
    if (Date.now() - entry.loadedAt > ITEMS_TTL_MS) {
        itemsCache.delete(key);
        return null;
    }
    return entry.payload;
}
function setCachedItems(key, payload) {
    if (itemsCache.size > 300)
        itemsCache.clear();
    itemsCache.set(key, { payload, loadedAt: Date.now() });
}
const messageCache = new Map();
const MESSAGE_TTL_MS = 5 * 60 * 1000;
function cacheMessage(accountId, message) {
    messageCache.set(`${accountId}:${message.id}`, { message, loadedAt: Date.now() });
}
function getCachedMessage(accountId, messageId) {
    const entry = messageCache.get(`${accountId}:${messageId}`);
    if (!entry)
        return null;
    if (Date.now() - entry.loadedAt > MESSAGE_TTL_MS) {
        messageCache.delete(`${accountId}:${messageId}`);
        return null;
    }
    return entry.message;
}
// Elige, dentro de photo.sizes, el tamaño "de verdad" (no el "stripped" de
// ~40px que Telegram manda primero para pintar un blur de carga). Pasamos el
// OBJETO de tamaño en si a downloadMedia (no un indice numerico: no hay
// garantia documentada de que el indice numerico de GramJS corresponda a la
// posicion dentro de este array en concreto, y eso es lo que seguia dando
// miniaturas borrosas). Preferimos el menor tamaño que ya sea >= 320px de
// ancho; si no hay ninguno tan grande, el mayor que haya.
function pickBestPhotoSize(sizes) {
    const usable = sizes.filter((s) => s.className === "PhotoSize" || s.className === "PhotoCachedSize" || s.className === "PhotoSizeProgressive");
    if (usable.length === 0)
        return null;
    const sorted = usable.slice().sort((a, b) => (a.w || 0) - (b.w || 0));
    return sorted.find((s) => (s.w || 0) >= 320) || sorted[sorted.length - 1];
}
// Clasifica el contenido de un mensaje para poder distinguir foto/video/audio
// en la rejilla (icono, filtro Fotos/Vídeos/Audios) y mostrar la duración
// como hace el panel de referencia (ej. "0:05" sobre el video).
function classifyMedia(media) {
    if (!media)
        return { type: "other" };
    if (media.className === "MessageMediaPhoto")
        return { type: "photo" };
    if (media.className === "MessageMediaDocument" && media.document) {
        const doc = media.document;
        const attrs = doc.attributes || [];
        const videoAttr = attrs.find((a) => a.className === "DocumentAttributeVideo");
        if (videoAttr)
            return { type: "video", duration: Math.round(videoAttr.duration || 0) };
        const audioAttr = attrs.find((a) => a.className === "DocumentAttributeAudio");
        if (audioAttr)
            return { type: "audio", duration: Math.round(audioAttr.duration || 0) };
        const mime = doc.mimeType || "";
        if (mime.startsWith("video/"))
            return { type: "video" };
        if (mime.startsWith("audio/"))
            return { type: "audio" };
        if (mime.startsWith("image/"))
            return { type: "photo" };
    }
    return { type: "other" };
}
/** Descarga una miniatura NITIDA para la rejilla de la bóveda de contenido.
 * Usa exactamente el mismo criterio que la Galería de un chat de cliente
 * (`thumb: -1`, "la miniatura mas grande disponible" segun GramJS) porque
 * ahi si funciona para fotos Y vídeos: pasarle el objeto de tamaño entero
 * (como se hacia antes) fallaba en silencio para vídeos/documentos y dejaba
 * la miniatura en blanco. */
// GramJS a veces "tiene éxito" (no lanza excepción) pero devuelve un Buffer
// vacío (0 bytes) — por ejemplo cuando el tamaño de miniatura pedido no
// existe para ese mensaje en concreto. Un Buffer vacío sigue siendo un
// objeto "truthy" en JS, así que sin este chequeo la respuesta HTTP salía
// como 200 OK con el cuerpo vacío: el navegador la trataba como imagen rota
// (por eso las miniaturas fallaban aunque la petición no diera error).
function isUsableBuf(buf) {
    return Buffer.isBuffer(buf) && buf.length > 0;
}
async function downloadContentThumb(client, message) {
    const media = message.media;
    // Intento preferente (sobre todo para VIDEOS): pedir el tamaño de
    // miniatura mas grande DE VERDAD como OBJETO concreto de
    // photo.sizes/document.thumbs, no como el indice numerico "-1"/"0" de
    // abajo - igual que ya se explicaba en pickBestPhotoSize (escrita para
    // esto, pero nunca se llegaba a usar aqui: por eso las fotos si se veian
    // bien -tienen el fallback de la imagen entera mas abajo- y los vídeos
    // se quedaban sin caratula, porque "-1" no siempre devuelve nada
    // utilizable para ellos aunque su miniatura SI exista en document.thumbs.
    const sizes = media?.className === "MessageMediaPhoto" ? media.photo?.sizes || [] : media?.document?.thumbs || [];
    const bestSize = pickBestPhotoSize(sizes);
    if (bestSize) {
        try {
            const buf = (await client.downloadMedia(message, { thumb: bestSize }));
            if (isUsableBuf(buf))
                return buf;
        }
        catch {
            // seguimos con los intentos de abajo
        }
    }
    try {
        const buf = (await client.downloadMedia(message, { thumb: -1 }));
        if (isUsableBuf(buf))
            return buf;
    }
    catch {
        // seguimos con el fallback de abajo
    }
    // Ultimo recurso para fotos: la imagen entera. Telegram ya la comprime al
    // subirla (normalmente <1MB), asi que sigue siendo rapido y esto garantiza
    // que nunca se vea borrosa si el intento de arriba no trajo nada.
    if (media?.className === "MessageMediaPhoto") {
        try {
            const buf = (await client.downloadMedia(message, {}));
            if (isUsableBuf(buf))
                return buf;
        }
        catch {
            // sin suerte, probamos el ultimo recurso de abajo
        }
    }
    const last = (await client.downloadMedia(message, { thumb: 0 }));
    return isUsableBuf(last) ? last : undefined;
}
/** Consigue el mensaje de Telegram (de la caché corta si se puede) para un
 * item de la bóveda, resolviendo la entidad del grupo de contenido si hace
 * falta pedirlo. Se reutiliza en la miniatura, la vista grande y el envío
 * "ver una vez". */
async function getContentMessage(client, accountId, chatId, messageId) {
    const cached = getCachedMessage(accountId, messageId);
    if (cached)
        return cached;
    const entity = await getContentGroupEntity(client, accountId, chatId);
    const [msg] = await client.getMessages(entity, { ids: [Number(messageId)] });
    return msg || null;
}
/** Mime type + extensión "de verdad" del contenido, para servirlo con el
 * Content-Type correcto en la vista grande y para el nombre del archivo al
 * volver a subirlo con el envío "ver una vez". */
function mediaMimeType(media) {
    if (media?.className === "MessageMediaPhoto")
        return "image/jpeg";
    return media?.document?.mimeType || "application/octet-stream";
}
/** Tamaño del archivo (si Telegram lo dice de antemano), para poder negarnos
 * a bajar algo descomunal a memoria sin ni intentarlo. */
function mediaSizeBytes(media) {
    const size = media?.document?.size;
    if (size === undefined || size === null)
        return null;
    const n = typeof size === "number" ? size : Number(size);
    return Number.isFinite(n) ? n : null;
}
async function registerContentLibraryRoutes(app) {
    app.get("/api/accounts/:id/content-group", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return { group: null };
        return { group: { chatId: account.contentGroupChatId, title: account.contentGroupTitle } };
    });
    app.get("/api/accounts/:id/content-group/search", async (request, reply) => {
        const { id } = request.params;
        const q = request.query;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const groups = await (0, dialogs_1.searchGroupDialogs)(client, q.q);
            return { groups };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudieron leer los grupos de Telegram." });
        }
    });
    app.put("/api/accounts/:id/content-group", async (request) => {
        const { id } = request.params;
        const body = request.body;
        await prisma_1.prisma.account.update({
            where: { id },
            data: { contentGroupChatId: body.chatId, contentGroupTitle: body.title || null },
        });
        // Si se cambia el grupo de contenido, invalidamos las cachés para que
        // no se mezclen temas/entidad del grupo anterior.
        groupEntityCache.delete(id);
        topicsCache.delete(id);
        return { ok: true };
    });
    app.get("/api/accounts/:id/content-group/topics", async (request, reply) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(400).send({ error: "Todavía no has elegido el grupo de contenido de esta cuenta." });
        const cached = topicsCache.get(id);
        if (cached && Date.now() - cached.loadedAt < TOPICS_TTL_MS) {
            return { topics: cached.topics };
        }
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
            const result = await client.invoke(new telegram_1.Api.channels.GetForumTopics({
                channel: entity,
                offsetDate: 0,
                offsetId: 0,
                offsetTopic: 0,
                limit: 100,
            }));
            const rawTopics = (result.topics ?? []).filter((t) => t.className === "ForumTopic");
            // Numero de archivos por tema, como en el desplegable de carpetas del
            // panel de referencia (ej. "CANAL TLGRM 100"). Pedimos 1 mensaje por
            // tema y leemos el total que devuelve Telegram, en vez de listarlos
            // todos (seria muy lento con temas grandes).
            const topics = await Promise.all(rawTopics.map(async (t) => {
                let count = null;
                try {
                    const raw = await client.getMessages(entity, { replyTo: t.id, limit: 1 });
                    count = typeof raw.total === "number" ? raw.total : raw.length;
                }
                catch {
                    count = null;
                }
                // Telegram asigna a cada tema uno de sus colores fijos de icono
                // (iconColor, un entero); lo convertimos a hex para pintar el
                // puntito de color en la lista de carpetas, igual que el panel
                // de referencia (que en realidad está leyendo ese mismo dato).
                const color = typeof t.iconColor === "number" ? "#" + (t.iconColor >>> 0).toString(16).padStart(6, "0").slice(-6) : null;
                return { id: t.id, title: t.title, count, color };
            }));
            topicsCache.set(id, { topics, loadedAt: Date.now() });
            return { topics };
        }
        catch (err) {
            request.log.error(err);
            const detail = err?.errorMessage || err?.message || "";
            return reply.code(502).send({
                error: "No se pudieron leer los temas del grupo de contenido. ¿Es un grupo con temas activados?" + (detail ? ` (${detail})` : ""),
            });
        }
    });
    // Mensajes de TEXTO de un tema de la bóveda (no fotos/vídeos/audios), para
    // el selector "De la bóveda" de Scripts (Mensajes/Mensajes Pro): permite
    // guardar en un script un texto ya escrito por la modelo en su bóveda,
    // incluyendo sus emoji premium (custom emoji animados de Telegram) tal
    // cual - MessageEntityCustomEmoji marca en qué tramo del texto va cada
    // uno, por eso se devuelven junto al texto completo (no solo el preview
    // recortado de /items).
    app.get("/api/accounts/:id/content-group/topics/:topicId/text-items", async (request, reply) => {
        const { id, topicId } = request.params;
        const q = request.query;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
            const limit = 50;
            const raw = await client.getMessages(entity, {
                limit,
                replyTo: Number(topicId),
                offsetId: q.offsetId ? Number(q.offsetId) : undefined,
            });
            const rawArr = raw;
            const items = rawArr
                .filter((m) => m.message && m.message.trim())
                .map((m) => ({
                id: m.id,
                text: m.message,
                preview: m.message.slice(0, 90),
                entities: (m.entities || [])
                    .filter((e) => e.className === "MessageEntityCustomEmoji")
                    .map((e) => ({ offset: e.offset, length: e.length, documentId: e.documentId.toString() })),
                date: m.date ? new Date(m.date * 1000).toISOString() : null,
            }));
            const hasMore = rawArr.length >= limit;
            const nextOffsetId = rawArr.length > 0 ? rawArr[rawArr.length - 1].id : null;
            return { items, hasMore, nextOffsetId };
        }
        catch (err) {
            request.log.error(err);
            const detail = err?.errorMessage || err?.message || "";
            return reply.code(502).send({ error: "No se pudieron leer los textos de ese tema." + (detail ? ` (${detail})` : "") });
        }
    });
    app.get("/api/accounts/:id/content-group/topics/:topicId/items", async (request, reply) => {
        const { id, topicId } = request.params;
        // offsetId: para "cargar más" contenido antiguo del tema sin recargar
        // todo desde el principio (igual que el historial de mensajes).
        // type: filtro opcional "photo" | "video" | "audio" para el desplegable
        // Todo/Fotos/Vídeos/Audios de dentro de un tema.
        const q = request.query;
        const typeFilter = q.type && q.type !== "all" ? q.type : null;
        const cacheKey = `topic-items:${id}:${topicId}:${q.offsetId || "0"}:${q.type || "all"}`;
        const cachedPayload = getCachedItems(cacheKey);
        if (cachedPayload)
            return cachedPayload;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
            const favoriteIds = new Set((await prisma_1.prisma.contentFavorite.findMany({ where: { accountId: id }, select: { messageId: true } })).map((f) => f.messageId));
            const notes = new Map((await prisma_1.prisma.contentNote.findMany({ where: { accountId: id }, select: { messageId: true, note: true } })).map((n) => [n.messageId, n.note]));
            // Tandas mas pequeñas (antes 60): con "Cargar más contenido" siempre
            // disponible, es mejor que la carpeta aparezca rapido con un primer
            // grupo que hacer esperar a que se resuelvan 60 miniaturas de golpe.
            const limit = 30;
            const collected = [];
            let offsetId = q.offsetId ? Number(q.offsetId) : undefined;
            let nextOffsetId = null;
            let hasMore = true;
            // Sin filtro de tipo: una sola pagina, igual que antes. Con filtro,
            // vamos pidiendo tandas hasta reunir suficientes items de ese tipo (o
            // hasta un tope de tandas, para no darle a Telegram muchisimas vueltas
            // si el tema tiene poco contenido de ese tipo en particular).
            const maxRounds = typeFilter ? 6 : 1;
            for (let round = 0; round < maxRounds && hasMore && collected.length < limit; round++) {
                const raw = await client.getMessages(entity, { limit, replyTo: Number(topicId), offsetId });
                const rawArr = raw;
                const usable = rawArr.filter((m) => m.message || m.media);
                for (const m of usable)
                    cacheMessage(id, m);
                const groups = (0, sender_1.groupByAlbum)(usable);
                for (const g of groups) {
                    const mediaMsg = g.find((m) => m.media) || g[0];
                    const { type, duration } = classifyMedia(mediaMsg.media);
                    if (typeFilter && type !== typeFilter)
                        continue;
                    collected.push({
                        id: mediaMsg.id,
                        messageIds: g.map((m) => m.id),
                        caption: g.find((m) => m.message)?.message?.slice(0, 140) || "",
                        mediaCount: g.filter((m) => m.media).length,
                        hasThumb: g.some((m) => m.media),
                        type,
                        duration: duration || null,
                        date: mediaMsg.date ? new Date(mediaMsg.date * 1000).toISOString() : null,
                        isFavorite: favoriteIds.has(String(mediaMsg.id)),
                        note: notes.get(String(mediaMsg.id)) || "",
                    });
                }
                hasMore = rawArr.length >= limit;
                nextOffsetId = rawArr.length > 0 ? rawArr[rawArr.length - 1].id : null;
                offsetId = nextOffsetId || undefined;
            }
            const payload = { items: collected.slice(0, limit), hasMore, nextOffsetId };
            setCachedItems(cacheKey, payload);
            return payload;
        }
        catch (err) {
            request.log.error(err);
            const detail = err?.errorMessage || err?.message || "";
            return reply.code(502).send({ error: "No se pudo leer el contenido de ese tema." + (detail ? ` (${detail})` : "") });
        }
    });
    // Vista "Todos los medios": lo mismo que arriba pero sin restringir a un
    // tema (replyTo), para poder elegir contenido de cualquier carpeta sin
    // tener que entrar carpeta por carpeta, igual que la fila "Todos los
    // medios" del panel de referencia.
    app.get("/api/accounts/:id/content-group/all-items", async (request, reply) => {
        const { id } = request.params;
        const q = request.query;
        const typeFilter = q.type && q.type !== "all" ? q.type : null;
        const cacheKey = `all-items:${id}:${q.offsetId || "0"}:${q.type || "all"}`;
        const cachedPayload = getCachedItems(cacheKey);
        if (cachedPayload)
            return cachedPayload;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
            const favoriteIds = new Set((await prisma_1.prisma.contentFavorite.findMany({ where: { accountId: id }, select: { messageId: true } })).map((f) => f.messageId));
            const notes = new Map((await prisma_1.prisma.contentNote.findMany({ where: { accountId: id }, select: { messageId: true, note: true } })).map((n) => [n.messageId, n.note]));
            const limit = 30;
            const collected = [];
            let offsetId = q.offsetId ? Number(q.offsetId) : undefined;
            let nextOffsetId = null;
            let hasMore = true;
            const maxRounds = typeFilter ? 6 : 1;
            for (let round = 0; round < maxRounds && hasMore && collected.length < limit; round++) {
                const raw = await client.getMessages(entity, { limit, offsetId });
                const rawArr = raw;
                const usable = rawArr.filter((m) => m.message || m.media);
                for (const m of usable)
                    cacheMessage(id, m);
                const groups = (0, sender_1.groupByAlbum)(usable);
                for (const g of groups) {
                    const mediaMsg = g.find((m) => m.media) || g[0];
                    const { type, duration } = classifyMedia(mediaMsg.media);
                    if (typeFilter && type !== typeFilter)
                        continue;
                    collected.push({
                        id: mediaMsg.id,
                        messageIds: g.map((m) => m.id),
                        caption: g.find((m) => m.message)?.message?.slice(0, 140) || "",
                        mediaCount: g.filter((m) => m.media).length,
                        hasThumb: g.some((m) => m.media),
                        type,
                        duration: duration || null,
                        date: mediaMsg.date ? new Date(mediaMsg.date * 1000).toISOString() : null,
                        isFavorite: favoriteIds.has(String(mediaMsg.id)),
                        note: notes.get(String(mediaMsg.id)) || "",
                    });
                }
                hasMore = rawArr.length >= limit;
                nextOffsetId = rawArr.length > 0 ? rawArr[rawArr.length - 1].id : null;
                offsetId = nextOffsetId || undefined;
            }
            const payload = { items: collected.slice(0, limit), hasMore, nextOffsetId };
            setCachedItems(cacheKey, payload);
            return payload;
        }
        catch (err) {
            request.log.error(err);
            const detail = err?.errorMessage || err?.message || "";
            return reply.code(502).send({ error: "No se pudo leer el contenido de la bóveda." + (detail ? ` (${detail})` : "") });
        }
    });
    // Favoritos: marcados desde cualquier tema, listados aparte como si fuera
    // una carpeta mas ("Favoritos"), igual que el filtro "Solo favoritos" del
    // panel de referencia.
    app.post("/api/accounts/:id/content-group/favorites/toggle", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        if (body.messageId === undefined || body.messageId === null) {
            return reply.code(400).send({ error: "Falta el mensaje a marcar." });
        }
        const messageId = String(body.messageId);
        const existing = await prisma_1.prisma.contentFavorite.findUnique({ where: { accountId_messageId: { accountId: id, messageId } } });
        if (existing) {
            await prisma_1.prisma.contentFavorite.delete({ where: { id: existing.id } });
            return { favorite: false };
        }
        await prisma_1.prisma.contentFavorite.create({
            data: { accountId: id, messageId, topicId: body.topicId !== undefined ? String(body.topicId) : "" },
        });
        return { favorite: true };
    });
    app.get("/api/accounts/:id/content-group/favorites", async (request, reply) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
        const favorites = await prisma_1.prisma.contentFavorite.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } });
        if (favorites.length === 0)
            return { items: [] };
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
            const ids = favorites.map((f) => Number(f.messageId)).filter((n) => !Number.isNaN(n));
            const raw = (await client.getMessages(entity, { ids }));
            for (const m of raw)
                if (m)
                    cacheMessage(id, m);
            const notes = new Map((await prisma_1.prisma.contentNote.findMany({ where: { accountId: id }, select: { messageId: true, note: true } })).map((n) => [n.messageId, n.note]));
            const items = raw
                .filter((m) => m && (m.message || m.media))
                .map((m) => {
                const { type, duration } = classifyMedia(m.media);
                return {
                    id: m.id,
                    messageIds: [m.id],
                    caption: m.message?.slice(0, 140) || "",
                    mediaCount: m.media ? 1 : 0,
                    hasThumb: !!m.media,
                    type,
                    duration: duration || null,
                    date: m.date ? new Date(m.date * 1000).toISOString() : null,
                    isFavorite: true,
                    note: notes.get(String(m.id)) || "",
                };
            });
            return { items };
        }
        catch (err) {
            request.log.error(err);
            const detail = err?.errorMessage || err?.message || "";
            return reply.code(502).send({ error: "No se pudieron leer los favoritos." + (detail ? ` (${detail})` : "") });
        }
    });
    app.get("/api/accounts/:id/content-group/messages/:messageId/thumb", async (request, reply) => {
        const { id, messageId } = request.params;
        const cacheKey = `content-thumb:${id}:${messageId}`;
        const cached = (0, mediaCache_1.getCachedMedia)(cacheKey);
        if (cached) {
            reply.header("Content-Type", "image/jpeg");
            reply.header("Cache-Control", "private, max-age=3600");
            return reply.send(cached);
        }
        if (isRecentlyFailedThumb(cacheKey))
            return reply.code(404).send();
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(404).send();
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            // Si ya tenemos el mensaje en cache (de haber listado el tema hace
            // poco) nos ahorramos un viaje entero a Telegram por cada miniatura.
            let message = getCachedMessage(id, messageId);
            if (!message) {
                const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
                const [msg] = await client.getMessages(entity, { ids: [Number(messageId)] });
                message = msg;
            }
            if (!message || !message.media) {
                markFailedThumb(cacheKey);
                return reply.code(404).send();
            }
            const buf = (await withThumbSlot(() => downloadContentThumb(client, message)));
            if (!buf) {
                markFailedThumb(cacheKey);
                return reply.code(404).send();
            }
            (0, mediaCache_1.setCachedMedia)(cacheKey, buf);
            reply.header("Content-Type", "image/jpeg");
            reply.header("Cache-Control", "private, max-age=3600");
            return reply.send(buf);
        }
        catch (err) {
            request.log.error(err);
            markFailedThumb(cacheKey);
            return reply.code(404).send();
        }
    });
    // Vista grande al darle "VER" a un contenido: la foto entera o el
    // vídeo/audio completo (no la miniatura). Sin caché para vídeos/audios
    // (podrían ser bastante pesados) — solo se pide bajo demanda al abrir la
    // vista, no al pintar la rejilla.
    app.get("/api/accounts/:id/content-group/messages/:messageId/media", async (request, reply) => {
        const { id, messageId } = request.params;
        const cacheKey = `content-full:${id}:${messageId}`;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(404).send();
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const message = await getContentMessage(client, id, account.contentGroupChatId, messageId);
            if (!message || !message.media)
                return reply.code(404).send();
            const cached = getCachedFullMedia(cacheKey);
            if (cached) {
                reply.header("Content-Type", mediaMimeType(message.media));
                reply.header("Cache-Control", "private, max-age=3600");
                return reply.send(cached);
            }
            const sizeBytes = mediaSizeBytes(message.media);
            if (sizeBytes && sizeBytes > exports.MAX_FULL_MEDIA_BYTES) {
                return reply.code(413).send({ error: "Este archivo pesa demasiado para verlo aquí (más de 60MB)." });
            }
            const buf = (await (0, exports.withFullMediaSlot)(() => client.downloadMedia(message, {})));
            if (!buf)
                return reply.code(404).send();
            setCachedFullMedia(cacheKey, buf);
            reply.header("Content-Type", mediaMimeType(message.media));
            reply.header("Cache-Control", "private, max-age=3600");
            return reply.send(buf);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(404).send();
        }
    });
    // Nota interna (solo la ve el equipo) sobre un contenido: un resumen de
    // qué se ve o qué dice la modelo, para no tener que reproducirlo entero.
    app.put("/api/accounts/:id/content-group/messages/:messageId/note", async (request, reply) => {
        const { id, messageId } = request.params;
        const body = request.body;
        const note = (body.note || "").slice(0, 2000);
        await prisma_1.prisma.contentNote.upsert({
            where: { accountId_messageId: { accountId: id, messageId } },
            update: { note },
            create: { accountId: id, messageId, note },
        });
        return { ok: true, note };
    });
    // Envío "ver una vez": baja el archivo entero y lo vuelve a subir como
    // mensaje NUEVO (no un reenvío) con autodestrucción activada, porque
    // Telegram no permite añadir esa autodestrucción a un mensaje reenviado.
    // Al ser un envío nuevo (no un forward) tampoco lleva nunca la etiqueta
    // de "reenviado de", igual que pide el usuario.
    app.post("/api/accounts/:id/content-group/send-once", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        if (!body.chatId || body.messageId === undefined || body.messageId === null) {
            return reply.code(400).send({ error: "Falta el chat destino o el contenido a enviar" });
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const message = await getContentMessage(client, id, account.contentGroupChatId, String(body.messageId));
            if (!message || !message.media)
                return reply.code(404).send({ error: "No se encontró ese contenido." });
            const sizeBytes = mediaSizeBytes(message.media);
            if (sizeBytes && sizeBytes > exports.MAX_FULL_MEDIA_BYTES) {
                return reply.code(413).send({ error: "Este archivo pesa demasiado para reenviarlo así (más de 60MB)." });
            }
            const buf = (await (0, exports.withFullMediaSlot)(() => client.downloadMedia(message, {})));
            if (!buf)
                return reply.code(502).send({ error: "No se pudo descargar el contenido para reenviarlo." });
            const destEntity = await (0, dialogs_1.resolveDialogEntity)(client, id, body.chatId);
            const destPeer = await client.getInputEntity(destEntity);
            const uploaded = await client.uploadFile({
                file: new uploads_1.CustomFile("contenido", buf.length, "", buf),
                workers: 1,
            });
            const sourceMedia = message.media;
            let media;
            if (sourceMedia.className === "MessageMediaPhoto") {
                media = new telegram_1.Api.InputMediaUploadedPhoto({ file: uploaded, ttlSeconds: TTL_VIEW_ONCE });
            }
            else {
                const doc = sourceMedia.document;
                media = new telegram_1.Api.InputMediaUploadedDocument({
                    file: uploaded,
                    mimeType: doc?.mimeType || "application/octet-stream",
                    attributes: doc?.attributes || [],
                    ttlSeconds: TTL_VIEW_ONCE,
                });
            }
            const sendResult = await client.invoke(new telegram_1.Api.messages.SendMedia({
                peer: destPeer,
                media,
                message: "",
                randomId: (0, Helpers_1.generateRandomBigInt)(),
            }));
            await logContentSend(id, body.chatId, sendResult);
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo enviar el contenido para ver una vez." });
        }
    });
    app.post("/api/accounts/:id/content-group/send", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        if (!body.chatId || !body.messageIds || body.messageIds.length === 0) {
            return reply.code(400).send({ error: "Falta el chat destino o el contenido a enviar" });
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        if (!account.contentGroupChatId)
            return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const destEntity = await (0, dialogs_1.resolveDialogEntity)(client, id, body.chatId);
            const sourceEntity = await getContentGroupEntity(client, id, account.contentGroupChatId);
            const sendResult = await client.forwardMessages(destEntity, {
                messages: body.messageIds,
                fromPeer: sourceEntity,
                dropAuthor: true, // llega como si lo hubiese enviado la modelo, sin "reenviado de"
            });
            await logContentSend(id, body.chatId, sendResult);
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo enviar el contenido." });
        }
    });
}
//# sourceMappingURL=contentLibrary.js.map