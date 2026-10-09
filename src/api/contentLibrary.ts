import { FastifyInstance } from "fastify";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { generateRandomBigInt } from "telegram/Helpers";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "../telegram/connectionPool";
import { searchGroupDialogs, resolveDialogEntity } from "../telegram/dialogs";
import { groupByAlbum, SourceMessageGroup } from "../engine/sender";
import { getCachedMedia, setCachedMedia } from "../telegram/mediaCache";
import { extractSentMessageIds } from "./messages";
// Igual que en messages.ts: "big-integer" ya es dependencia de gramjs, y los
// offsets de descarga de archivo deben ser BigInteger (no un number normal).
const bigInt = require("big-integer");

/** Registra (best-effort, nunca hace fallar el envío) que un mensaje
 * recién enviado a un fan viene de la bóveda, para la etiqueta "GRUPO" de la
 * Galería del chat y para el "YA ENVIADO" de la propia bóveda (ver
 * getAlreadySentItemIds más abajo). sourceMessageId es el id del item de la
 * bóveda de origen (el mensaje "portada" del grupo/álbum que se mandó) -
 * opcional por si el llamante no lo tiene. */
async function logContentSend(accountId: string, chatId: string, result: any, sourceMessageId?: string): Promise<void> {
  try {
    const ids = extractSentMessageIds(result);
    if (ids.length === 0) return;
    await prisma.contentSendLog.createMany({
      data: ids.map((telegramMessageId) => ({ accountId, chatId, telegramMessageId, sourceMessageId: sourceMessageId || null })),
      skipDuplicates: true,
    });
  } catch {
    // no pasa nada si esto falla, el envío ya se hizo
  }
}

/** "YA ENVIADO": ids de items de la bóveda (ver sourceMessageId arriba) que
 * ya se le mandaron a ESTE chat/fan en algún momento, para que la bóveda
 * pueda marcarlos al abrirla con esa conversación delante. Vacío si no hay
 * chatId (p.ej. la bóveda abierta desde "Programar posts", sin un fan
 * concreto detrás). */
async function getAlreadySentItemIds(accountId: string, chatId: string | undefined): Promise<Set<string>> {
  if (!chatId) return new Set();
  const rows = await prisma.contentSendLog.findMany({
    where: { accountId, chatId, sourceMessageId: { not: null } },
    select: { sourceMessageId: true },
  });
  return new Set(rows.map((r) => r.sourceMessageId!));
}

/** Añade `alreadySentToChat` a cada item sin tocar la cache de items (ver
 * getCachedItems/setCachedItems) - esto es especifico del chat que se esta
 * mirando ahora mismo, no del contenido en si, así que nunca debe formar
 * parte de la clave de cache ni guardarse en ella. */
function markAlreadySent<T extends { id: number | string }>(items: T[], sentIds: Set<string>): (T & { alreadySentToChat: boolean })[] {
  return items.map((it) => ({ ...it, alreadySentToChat: sentIds.has(String(it.id)) }));
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
function makeSlotLimiter(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}
// Miniaturas: pesan poco (unos KB), toleran mas paralelismo.
const withThumbSlot = makeSlotLimiter(10);
// Contador de archivos por tema (GetForumTopics no lo trae, hay que pedirlo
// aparte por cada tema): sin tope, una cuenta con muchos temas lanzaba
// TODAS esas llamadas a Telegram a la vez en el primer golpe de caché frío
// (cada 10 min, ver TOPICS_TTL_MS), lo que podia saturar la conexion y
// ralentizar justo la apertura de la bóveda. 6 a la vez es de sobra para
// que vaya rapido sin arriesgarse a un FLOOD_WAIT.
const withTopicCountSlot = makeSlotLimiter(6);

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
const failedThumbCache = new Map<string, number>();
function isRecentlyFailedThumb(key: string): boolean {
  const at = failedThumbCache.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > FAILED_THUMB_TTL_MS) {
    failedThumbCache.delete(key);
    return false;
  }
  return true;
}
function markFailedThumb(key: string): void {
  // Evita que este mapa crezca sin límite en un proceso de larga duración.
  if (failedThumbCache.size > 2000) failedThumbCache.clear();
  failedThumbCache.set(key, Date.now());
}
// Archivo COMPLETO (vista grande / envío "ver una vez"): un vídeo puede
// pesar decenas de MB, así que aquí somos mucho más estrictos para no
// comernos la RAM del contenedor con varias descargas grandes a la vez.
export const withFullMediaSlot = makeSlotLimiter(2);
// Si el archivo es descomunal (mas de 60MB), mejor fallar con un mensaje
// claro que arriesgarnos a que el proceso se quede sin memoria.
export const MAX_FULL_MEDIA_BYTES = 60 * 1024 * 1024;

// Cache pequeña y aparte (no la de miniaturas) para la vista grande: si
// alguien reabre el mismo vídeo/foto en la misma sesión, la segunda vez es
// instantánea. Pocas entradas y solo archivos no muy grandes, para no
// comernos la memoria del contenedor con vídeos guardados sin usar.
const FULL_MEDIA_CACHE_MAX_ENTRIES = 12;
const FULL_MEDIA_CACHE_MAX_BYTES = 15 * 1024 * 1024;
const fullMediaCache = new Map<string, Buffer>();
function getCachedFullMedia(key: string): Buffer | undefined {
  const buf = fullMediaCache.get(key);
  if (buf) {
    fullMediaCache.delete(key);
    fullMediaCache.set(key, buf);
  }
  return buf;
}
function setCachedFullMedia(key: string, buf: Buffer): void {
  if (buf.length > FULL_MEDIA_CACHE_MAX_BYTES) return;
  if (fullMediaCache.size >= FULL_MEDIA_CACHE_MAX_ENTRIES) {
    const oldest = fullMediaCache.keys().next().value;
    if (oldest !== undefined) fullMediaCache.delete(oldest);
  }
  fullMediaCache.set(key, buf);
}
/** Para el botón "Vaciar caché" de Configuración → General. */
export function clearContentFullMediaCache(): void {
  fullMediaCache.clear();
}

/**
 * "Contenido de la modelo": el grupo/canal con temas (sexting, lenceria,
 * fotos...) desde el que se manda un pack directamente a un fan sin salir
 * del chat, igual que el boton de carpeta del panel de referencia.
 */

// Cache de la entidad del grupo de contenido por cuenta. Resolver la entidad
// (necesita el access_hash del canal) puede fallar justo despues de un
// reinicio del servidor (cada deploy reinicia el proceso y la cache interna
// de Telegram se vacia), asi que si falla la primera vez volvemos a listar
// los dialogos para refrescar esa cache antes de rendirnos.
interface EntityCacheEntry { entity: any; loadedAt: number }
const groupEntityCache = new Map<string, EntityCacheEntry>();
const GROUP_ENTITY_TTL_MS = 10 * 60 * 1000;

export async function getContentGroupEntity(client: any, accountId: string, chatId: string) {
  const cached = groupEntityCache.get(accountId);
  if (cached && Date.now() - cached.loadedAt < GROUP_ENTITY_TTL_MS) return cached.entity;
  try {
    const entity = await client.getEntity(chatId);
    groupEntityCache.set(accountId, { entity, loadedAt: Date.now() });
    return entity;
  } catch (err) {
    // Refrescamos la lista de dialogos (esto repuebla la cache interna de
    // Telegram con el access_hash del grupo) y lo intentamos una vez mas.
    await client.getDialogs({ limit: 400 });
    const entity = await client.getEntity(chatId);
    groupEntityCache.set(accountId, { entity, loadedAt: Date.now() });
    return entity;
  }
}

// Cache corta de los temas de un grupo (evita pedirlos a Telegram cada vez
// que se reabre la boveda durante la misma sesion). Antes eran solo 2
// minutos: como pedir los temas hace 1 llamada a Telegram POR CADA carpeta
// (para el contador), con 10-15 carpetas eso son 10-15 viajes de ida y
// vuelta cada vez que se reabre la bóveda — la causa principal de que
// "abrir la bóveda" se sintiera lento. Los temas y sus contadores cambian
// poco, así que se puede cachear bastante más tiempo sin que se note.
interface TopicsCacheEntry { topics: any[]; loadedAt: number }
const topicsCache = new Map<string, TopicsCacheEntry>();
const TOPICS_TTL_MS = 10 * 60 * 1000;

// Cache corta del LISTADO de contenido de una carpeta (no solo de cada
// mensaje suelto): volver a entrar en la misma carpeta/tema a los pocos
// segundos (algo muy habitual al ir y venir eligiendo qué mandar a un fan)
// no debería repetir toda la lectura a Telegram.
interface ItemsCacheEntry { payload: any; loadedAt: number }
const itemsCache = new Map<string, ItemsCacheEntry>();
const ITEMS_TTL_MS = 45 * 1000;
function getCachedItems(key: string): any | null {
  const entry = itemsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > ITEMS_TTL_MS) {
    itemsCache.delete(key);
    return null;
  }
  return entry.payload;
}
function setCachedItems(key: string, payload: any): void {
  if (itemsCache.size > 300) itemsCache.clear();
  itemsCache.set(key, { payload, loadedAt: Date.now() });
}

// Cache muy corta de los mensajes ya leidos al listar el contenido de un
// tema, para que pedir la miniatura de cada item no tenga que volver a
// pedirle el mensaje a Telegram (solo hace falta la descarga del archivo).
interface MessageCacheEntry { message: Api.Message; loadedAt: number }
const messageCache = new Map<string, MessageCacheEntry>();
const MESSAGE_TTL_MS = 5 * 60 * 1000;

function cacheMessage(accountId: string, message: Api.Message) {
  messageCache.set(`${accountId}:${message.id}`, { message, loadedAt: Date.now() });
}

function getCachedMessage(accountId: string, messageId: string): Api.Message | null {
  const entry = messageCache.get(`${accountId}:${messageId}`);
  if (!entry) return null;
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
function pickBestPhotoSize(sizes: any[]): any | null {
  const usable = sizes.filter(
    (s) => s.className === "PhotoSize" || s.className === "PhotoCachedSize" || s.className === "PhotoSizeProgressive"
  );
  if (usable.length === 0) return null;
  const sorted = usable.slice().sort((a, b) => (a.w || 0) - (b.w || 0));
  return sorted.find((s) => (s.w || 0) >= 320) || sorted[sorted.length - 1];
}

// Clasifica el contenido de un mensaje para poder distinguir foto/video/audio
// en la rejilla (icono, filtro Fotos/Vídeos/Audios) y mostrar la duración
// como hace el panel de referencia (ej. "0:05" sobre el video).
function classifyMedia(media: any): { type: "photo" | "video" | "audio" | "other"; duration?: number } {
  if (!media) return { type: "other" };
  if (media.className === "MessageMediaPhoto") return { type: "photo" };
  if (media.className === "MessageMediaDocument" && media.document) {
    const doc: any = media.document;
    const attrs: any[] = doc.attributes || [];
    const videoAttr = attrs.find((a) => a.className === "DocumentAttributeVideo");
    if (videoAttr) return { type: "video", duration: Math.round(videoAttr.duration || 0) };
    const audioAttr = attrs.find((a) => a.className === "DocumentAttributeAudio");
    if (audioAttr) return { type: "audio", duration: Math.round(audioAttr.duration || 0) };
    const mime: string = doc.mimeType || "";
    if (mime.startsWith("video/")) return { type: "video" };
    if (mime.startsWith("audio/")) return { type: "audio" };
    if (mime.startsWith("image/")) return { type: "photo" };
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
function isUsableBuf(buf: unknown): buf is Buffer {
  return Buffer.isBuffer(buf) && buf.length > 0;
}

async function downloadContentThumb(client: any, message: Api.Message): Promise<Buffer | undefined> {
  const media: any = message.media;

  // Intento preferente (sobre todo para VIDEOS): pedir el tamaño de
  // miniatura mas grande DE VERDAD como OBJETO concreto de
  // photo.sizes/document.thumbs, no como el indice numerico "-1"/"0" de
  // abajo - igual que ya se explicaba en pickBestPhotoSize (escrita para
  // esto, pero nunca se llegaba a usar aqui: por eso las fotos si se veian
  // bien -tienen el fallback de la imagen entera mas abajo- y los vídeos
  // se quedaban sin caratula, porque "-1" no siempre devuelve nada
  // utilizable para ellos aunque su miniatura SI exista en document.thumbs.
  const sizes: any[] =
    media?.className === "MessageMediaPhoto" ? media.photo?.sizes || [] : media?.document?.thumbs || [];
  const bestSize = pickBestPhotoSize(sizes);
  if (bestSize) {
    try {
      const buf = (await client.downloadMedia(message, { thumb: bestSize })) as Buffer | undefined;
      if (isUsableBuf(buf)) return buf;
    } catch {
      // seguimos con los intentos de abajo
    }
  }

  try {
    const buf = (await client.downloadMedia(message, { thumb: -1 })) as Buffer | undefined;
    if (isUsableBuf(buf)) return buf;
  } catch {
    // seguimos con el fallback de abajo
  }
  // Ultimo recurso para fotos: la imagen entera. Telegram ya la comprime al
  // subirla (normalmente <1MB), asi que sigue siendo rapido y esto garantiza
  // que nunca se vea borrosa si el intento de arriba no trajo nada.
  if (media?.className === "MessageMediaPhoto") {
    try {
      const buf = (await client.downloadMedia(message, {})) as Buffer | undefined;
      if (isUsableBuf(buf)) return buf;
    } catch {
      // sin suerte, probamos el ultimo recurso de abajo
    }
  }
  const last = (await client.downloadMedia(message, { thumb: 0 })) as Buffer | undefined;
  return isUsableBuf(last) ? last : undefined;
}

/** Consigue el mensaje de Telegram (de la caché corta si se puede) para un
 * item de la bóveda, resolviendo la entidad del grupo de contenido si hace
 * falta pedirlo. Se reutiliza en la miniatura, la vista grande y el envío
 * "ver una vez". */
export async function getContentMessage(client: any, accountId: string, chatId: string, messageId: string): Promise<Api.Message | null> {
  const cached = getCachedMessage(accountId, messageId);
  if (cached) return cached;
  const entity = await getContentGroupEntity(client, accountId, chatId);
  const [msg] = await client.getMessages(entity, { ids: [Number(messageId)] });
  return (msg as Api.Message) || null;
}

/** Mime type + extensión "de verdad" del contenido, para servirlo con el
 * Content-Type correcto en la vista grande y para el nombre del archivo al
 * volver a subirlo con el envío "ver una vez". */
function mediaMimeType(media: any): string {
  if (media?.className === "MessageMediaPhoto") return "image/jpeg";
  return media?.document?.mimeType || "application/octet-stream";
}

/** Tamaño del archivo (si Telegram lo dice de antemano), para poder negarnos
 * a bajar algo descomunal a memoria sin ni intentarlo. */
export function mediaSizeBytes(media: any): number | null {
  const size = media?.document?.size;
  if (size === undefined || size === null) return null;
  const n = typeof size === "number" ? size : Number(size);
  return Number.isFinite(n) ? n : null;
}

export async function registerContentLibraryRoutes(app: FastifyInstance) {
  app.get("/api/accounts/:id/content-group", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return { group: null };
    return { group: { chatId: account.contentGroupChatId, title: account.contentGroupTitle } };
  });

  app.get("/api/accounts/:id/content-group/search", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { q?: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const groups = await searchGroupDialogs(client, q.q);
      return { groups };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudieron leer los grupos de Telegram." });
    }
  });

  app.put("/api/accounts/:id/content-group", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { chatId: string; title?: string };
    await prisma.account.update({
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
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(400).send({ error: "Todavía no has elegido el grupo de contenido de esta cuenta." });
    const cached = topicsCache.get(id);
    if (cached && Date.now() - cached.loadedAt < TOPICS_TTL_MS) {
      return { topics: cached.topics };
    }
    try {
      const client = await getAccountClient(account);
      const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
      const result = await client.invoke(
        new Api.channels.GetForumTopics({
          channel: entity,
          offsetDate: 0,
          offsetId: 0,
          offsetTopic: 0,
          limit: 100,
        })
      );
      const rawTopics = ((result as any).topics ?? []).filter((t: any) => t.className === "ForumTopic");
      // Numero de archivos por tema, como en el desplegable de carpetas del
      // panel de referencia (ej. "CANAL TLGRM 100"). Pedimos 1 mensaje por
      // tema y leemos el total que devuelve Telegram, en vez de listarlos
      // todos (seria muy lento con temas grandes).
      const topics = await Promise.all(
        rawTopics.map(async (t: any) => {
          let count: number | null = null;
          try {
            const raw: any = await withTopicCountSlot(() => client.getMessages(entity, { replyTo: t.id, limit: 1 }));
            count = typeof raw.total === "number" ? raw.total : raw.length;
          } catch {
            count = null;
          }
          // Telegram asigna a cada tema uno de sus colores fijos de icono
          // (iconColor, un entero); lo convertimos a hex para pintar el
          // puntito de color en la lista de carpetas, igual que el panel
          // de referencia (que en realidad está leyendo ese mismo dato).
          const color = typeof t.iconColor === "number" ? "#" + (t.iconColor >>> 0).toString(16).padStart(6, "0").slice(-6) : null;
          return { id: t.id, title: t.title, count, color };
        })
      );
      topicsCache.set(id, { topics, loadedAt: Date.now() });
      return { topics };
    } catch (err: any) {
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
    const { id, topicId } = request.params as { id: string; topicId: string };
    const q = request.query as { offsetId?: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
    try {
      const client = await getAccountClient(account);
      const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
      const limit = 50;
      const raw = await client.getMessages(entity, {
        limit,
        replyTo: Number(topicId),
        offsetId: q.offsetId ? Number(q.offsetId) : undefined,
      });
      const rawArr = raw as Api.Message[];
      const items = rawArr
        .filter((m) => m.message && m.message.trim())
        .map((m) => ({
          id: m.id,
          text: m.message,
          preview: m.message!.slice(0, 90),
          entities: (m.entities || [])
            .filter((e: any) => e.className === "MessageEntityCustomEmoji")
            .map((e: any) => ({ offset: e.offset, length: e.length, documentId: e.documentId.toString() })),
          date: m.date ? new Date(m.date * 1000).toISOString() : null,
        }));
      const hasMore = rawArr.length >= limit;
      const nextOffsetId = rawArr.length > 0 ? rawArr[rawArr.length - 1].id : null;
      return { items, hasMore, nextOffsetId };
    } catch (err: any) {
      request.log.error(err);
      const detail = err?.errorMessage || err?.message || "";
      return reply.code(502).send({ error: "No se pudieron leer los textos de ese tema." + (detail ? ` (${detail})` : "") });
    }
  });

  app.get("/api/accounts/:id/content-group/topics/:topicId/items", async (request, reply) => {
    const { id, topicId } = request.params as { id: string; topicId: string };
    // offsetId: para "cargar más" contenido antiguo del tema sin recargar
    // todo desde el principio (igual que el historial de mensajes).
    // type: filtro opcional "photo" | "video" | "audio" para el desplegable
    // Todo/Fotos/Vídeos/Audios de dentro de un tema.
    const q = request.query as { offsetId?: string; type?: string; chatId?: string };
    const typeFilter = q.type && q.type !== "all" ? q.type : null;
    const cacheKey = `topic-items:${id}:${topicId}:${q.offsetId || "0"}:${q.type || "all"}`;
    const cachedPayload = getCachedItems(cacheKey);
    if (cachedPayload) {
      const sentIds = await getAlreadySentItemIds(id, q.chatId);
      return { ...cachedPayload, items: markAlreadySent(cachedPayload.items, sentIds) };
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
    try {
      const client = await getAccountClient(account);
      const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
      const favoriteIds = new Set(
        (await prisma.contentFavorite.findMany({ where: { accountId: id }, select: { messageId: true } })).map((f) => f.messageId)
      );
      const notes = new Map(
        (await prisma.contentNote.findMany({ where: { accountId: id }, select: { messageId: true, note: true } })).map((n) => [n.messageId, n.note])
      );
      // Tandas mas pequeñas (antes 60): con "Cargar más contenido" siempre
      // disponible, es mejor que la carpeta aparezca rapido con un primer
      // grupo que hacer esperar a que se resuelvan 60 miniaturas de golpe.
      const limit = 30;
      const collected: any[] = [];
      let offsetId = q.offsetId ? Number(q.offsetId) : undefined;
      let nextOffsetId: number | null = null;
      let hasMore = true;
      // Sin filtro de tipo: una sola pagina, igual que antes. Con filtro,
      // vamos pidiendo tandas hasta reunir suficientes items de ese tipo (o
      // hasta un tope de tandas, para no darle a Telegram muchisimas vueltas
      // si el tema tiene poco contenido de ese tipo en particular).
      const maxRounds = typeFilter ? 6 : 1;
      for (let round = 0; round < maxRounds && hasMore && collected.length < limit; round++) {
        const raw = await client.getMessages(entity, { limit, replyTo: Number(topicId), offsetId });
        const rawArr = raw as Api.Message[];
        const usable = rawArr.filter((m) => m.message || m.media);
        for (const m of usable) cacheMessage(id, m);
        const groups: SourceMessageGroup[] = groupByAlbum(usable);
        for (const g of groups) {
          const mediaMsg = g.find((m) => m.media) || g[0];
          const { type, duration } = classifyMedia(mediaMsg.media);
          if (typeFilter && type !== typeFilter) continue;
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
      const sentIds = await getAlreadySentItemIds(id, q.chatId);
      return { ...payload, items: markAlreadySent(payload.items, sentIds) };
    } catch (err: any) {
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
    const { id } = request.params as { id: string };
    const q = request.query as { offsetId?: string; type?: string; chatId?: string };
    const typeFilter = q.type && q.type !== "all" ? q.type : null;
    const cacheKey = `all-items:${id}:${q.offsetId || "0"}:${q.type || "all"}`;
    const cachedPayload = getCachedItems(cacheKey);
    if (cachedPayload) {
      const sentIds = await getAlreadySentItemIds(id, q.chatId);
      return { ...cachedPayload, items: markAlreadySent(cachedPayload.items, sentIds) };
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
    try {
      const client = await getAccountClient(account);
      const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
      const favoriteIds = new Set(
        (await prisma.contentFavorite.findMany({ where: { accountId: id }, select: { messageId: true } })).map((f) => f.messageId)
      );
      const notes = new Map(
        (await prisma.contentNote.findMany({ where: { accountId: id }, select: { messageId: true, note: true } })).map((n) => [n.messageId, n.note])
      );
      const limit = 30;
      const collected: any[] = [];
      let offsetId = q.offsetId ? Number(q.offsetId) : undefined;
      let nextOffsetId: number | null = null;
      let hasMore = true;
      const maxRounds = typeFilter ? 6 : 1;
      for (let round = 0; round < maxRounds && hasMore && collected.length < limit; round++) {
        const raw = await client.getMessages(entity, { limit, offsetId });
        const rawArr = raw as Api.Message[];
        const usable = rawArr.filter((m) => m.message || m.media);
        for (const m of usable) cacheMessage(id, m);
        const groups: SourceMessageGroup[] = groupByAlbum(usable);
        for (const g of groups) {
          const mediaMsg = g.find((m) => m.media) || g[0];
          const { type, duration } = classifyMedia(mediaMsg.media);
          if (typeFilter && type !== typeFilter) continue;
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
      const sentIds = await getAlreadySentItemIds(id, q.chatId);
      return { ...payload, items: markAlreadySent(payload.items, sentIds) };
    } catch (err: any) {
      request.log.error(err);
      const detail = err?.errorMessage || err?.message || "";
      return reply.code(502).send({ error: "No se pudo leer el contenido de la bóveda." + (detail ? ` (${detail})` : "") });
    }
  });

  // Favoritos: marcados desde cualquier tema, listados aparte como si fuera
  // una carpeta mas ("Favoritos"), igual que el filtro "Solo favoritos" del
  // panel de referencia.
  app.post("/api/accounts/:id/content-group/favorites/toggle", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { messageId?: number | string; topicId?: number | string };
    if (body.messageId === undefined || body.messageId === null) {
      return reply.code(400).send({ error: "Falta el mensaje a marcar." });
    }
    const messageId = String(body.messageId);
    const existing = await prisma.contentFavorite.findUnique({ where: { accountId_messageId: { accountId: id, messageId } } });
    if (existing) {
      await prisma.contentFavorite.delete({ where: { id: existing.id } });
      return { favorite: false };
    }
    await prisma.contentFavorite.create({
      data: { accountId: id, messageId, topicId: body.topicId !== undefined ? String(body.topicId) : "" },
    });
    return { favorite: true };
  });

  app.get("/api/accounts/:id/content-group/favorites", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { chatId?: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
    const favorites = await prisma.contentFavorite.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } });
    if (favorites.length === 0) return { items: [] };
    try {
      const client = await getAccountClient(account);
      const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
      const ids = favorites.map((f) => Number(f.messageId)).filter((n) => !Number.isNaN(n));
      const raw = (await client.getMessages(entity, { ids })) as Api.Message[];
      for (const m of raw) if (m) cacheMessage(id, m);
      const notes = new Map(
        (await prisma.contentNote.findMany({ where: { accountId: id }, select: { messageId: true, note: true } })).map((n) => [n.messageId, n.note])
      );
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
      const sentIds = await getAlreadySentItemIds(id, q.chatId);
      return { items: markAlreadySent(items, sentIds) };
    } catch (err: any) {
      request.log.error(err);
      const detail = err?.errorMessage || err?.message || "";
      return reply.code(502).send({ error: "No se pudieron leer los favoritos." + (detail ? ` (${detail})` : "") });
    }
  });

  app.get("/api/accounts/:id/content-group/messages/:messageId/thumb", async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    const cacheKey = `content-thumb:${id}:${messageId}`;
    const cached = getCachedMedia(cacheKey);
    if (cached) {
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(cached);
    }
    if (isRecentlyFailedThumb(cacheKey)) return reply.code(404).send();
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(404).send();
    try {
      const client = await getAccountClient(account);
      // Si ya tenemos el mensaje en cache (de haber listado el tema hace
      // poco) nos ahorramos un viaje entero a Telegram por cada miniatura.
      let message = getCachedMessage(id, messageId);
      if (!message) {
        const entity = await getContentGroupEntity(client, id, account.contentGroupChatId);
        const [msg] = await client.getMessages(entity, { ids: [Number(messageId)] });
        message = msg as Api.Message;
      }
      if (!message || !message.media) {
        markFailedThumb(cacheKey);
        return reply.code(404).send();
      }
      const buf = (await withThumbSlot(() => downloadContentThumb(client, message as Api.Message))) as Buffer | undefined;
      if (!buf) {
        markFailedThumb(cacheKey);
        return reply.code(404).send();
      }
      setCachedMedia(cacheKey, buf);
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(buf);
    } catch (err) {
      request.log.error(err);
      markFailedThumb(cacheKey);
      return reply.code(404).send();
    }
  });

  // Vista grande al darle "VER" a un contenido: la foto entera o el
  // vídeo/audio completo (no la miniatura). Sin caché para archivos
  // grandes (podrían pesar decenas de MB) — solo se pide bajo demanda al
  // abrir la vista, no al pintar la rejilla.
  //
  // IMPORTANTE (rendimiento): antes esto bajaba el archivo ENTERO de
  // Telegram a memoria y luego, ya completo, lo mandaba al navegador — es
  // decir, el chatter esperaba la descarga completa DOS veces seguidas
  // (Telegram -> servidor, y luego servidor -> navegador) antes de ver un
  // solo fotograma. Ahora se transmite en streaming, Y además soporta
  // peticiones "Range" (las que manda el navegador cuando arrastras la
  // barra de un vídeo): en vez de tener que bajar/mandar el archivo desde
  // el principio, se le pide a Telegram directamente el trozo que hace
  // falta a partir del segundo al que saltaste, así que arrastrar la
  // barra también funciona sin esperar a que cargue todo lo anterior.
  app.get("/api/accounts/:id/content-group/messages/:messageId/media", async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    const cacheKey = `content-full:${id}:${messageId}`;
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(404).send();
    try {
      const client = await getAccountClient(account);
      const message = await getContentMessage(client, id, account.contentGroupChatId, messageId);
      if (!message || !message.media) return reply.code(404).send();
      const mimeType = mediaMimeType(message.media);
      const sizeBytes = mediaSizeBytes(message.media);
      if (sizeBytes && sizeBytes > MAX_FULL_MEDIA_BYTES) {
        return reply.code(413).send({ error: "Este archivo pesa demasiado para verlo aquí (más de 60MB)." });
      }

      // Si ya lo tenemos entero en caché (alguien lo acaba de ver), para
      // cualquier Range la respondemos directamente en memoria, sin tocar
      // Telegram para nada.
      const cached = getCachedFullMedia(cacheKey);

      // Soporte de "Range: bytes=INICIO-FIN" para poder arrastrar la barra
      // de reproducción sin tener que cargar el vídeo desde el principio.
      const rangeHeader = request.headers.range;
      let start = 0;
      let end = sizeBytes ? sizeBytes - 1 : undefined;
      let isPartial = false;
      if (rangeHeader && sizeBytes) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (m && (m[1] !== "" || m[2] !== "")) {
          const reqStart = m[1] !== "" ? parseInt(m[1], 10) : undefined;
          const reqEnd = m[2] !== "" ? parseInt(m[2], 10) : undefined;
          let s = reqStart ?? (reqEnd !== undefined ? sizeBytes - reqEnd : 0);
          let e = reqEnd !== undefined && reqStart !== undefined ? reqEnd : sizeBytes - 1;
          if (e > sizeBytes - 1) e = sizeBytes - 1;
          if (s >= 0 && e < sizeBytes && s <= e) {
            start = s;
            end = e;
            isPartial = true;
          }
        }
      }

      if (cached) {
        const slice = isPartial ? cached.subarray(start, end! + 1) : cached;
        reply.code(isPartial ? 206 : 200);
        reply.header("Content-Type", mimeType);
        reply.header("Accept-Ranges", "bytes");
        reply.header("Content-Length", String(slice.length));
        reply.header("Cache-Control", "private, max-age=3600");
        if (isPartial) reply.header("Content-Range", `bytes ${start}-${end}/${cached.length}`);
        return reply.send(slice);
      }

      reply.hijack();
      const res = reply.raw;
      const headers: Record<string, string> = {
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      };
      if (sizeBytes) headers["Content-Length"] = String((end ?? sizeBytes - 1) - start + 1);
      if (isPartial && sizeBytes) headers["Content-Range"] = `bytes ${start}-${end}/${sizeBytes}`;
      res.writeHead(isPartial ? 206 : 200, headers);

      // Solo guardamos en caché cuando se ha pedido el archivo COMPLETO
      // desde el principio (lo normal al abrir el visor por primera vez);
      // un trozo suelto de un salto de barra no se cachea entero.
      const isFullFetch = start === 0 && (!sizeBytes || end === sizeBytes - 1);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let clientGone = false;
      res.on("close", () => {
        clientGone = true;
      });
      try {
        await withFullMediaSlot(async () => {
          const CHUNK_SIZE = 512 * 1024;
          const iter = client.iterDownload({ file: message as any, offset: bigInt(start), requestSize: CHUNK_SIZE });
          let pos = start;
          for await (const chunk of iter) {
            if (clientGone) break;
            const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const chunkStartAbs = pos;
            const chunkEndAbs = pos + buf.length - 1;
            let toWrite = buf;
            let reachedEnd = false;
            if (end !== undefined && chunkEndAbs >= end) {
              toWrite = buf.subarray(0, end - chunkStartAbs + 1);
              reachedEnd = true;
            }
            if (isFullFetch) {
              chunks.push(toWrite);
              totalBytes += toWrite.length;
            }
            const canContinue = res.write(toWrite);
            if (!canContinue) {
              await new Promise<void>((resolve) => res.once("drain", () => resolve()));
            }
            pos += buf.length;
            if (reachedEnd) break;
          }
        });
        if (!clientGone) res.end();
        if (!clientGone && isFullFetch && totalBytes > 0) setCachedFullMedia(cacheKey, Buffer.concat(chunks, totalBytes));
      } catch (streamErr) {
        request.log.error(streamErr);
        if (!res.writableEnded) res.destroy();
      }
      return;
    } catch (err) {
      request.log.error(err);
      return reply.code(404).send();
    }
  });

  // Nota interna (solo la ve el equipo) sobre un contenido: un resumen de
  // qué se ve o qué dice la modelo, para no tener que reproducirlo entero.
  app.put("/api/accounts/:id/content-group/messages/:messageId/note", async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    const body = request.body as { note?: string };
    const note = (body.note || "").slice(0, 2000);
    await prisma.contentNote.upsert({
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
    const { id } = request.params as { id: string };
    const body = request.body as { chatId?: string; messageId?: number | string; sourceItemId?: number | string };
    if (!body.chatId || body.messageId === undefined || body.messageId === null) {
      return reply.code(400).send({ error: "Falta el chat destino o el contenido a enviar" });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
    try {
      const client = await getAccountClient(account);
      const message = await getContentMessage(client, id, account.contentGroupChatId, String(body.messageId));
      if (!message || !message.media) return reply.code(404).send({ error: "No se encontró ese contenido." });
      const sizeBytes = mediaSizeBytes(message.media);
      if (sizeBytes && sizeBytes > MAX_FULL_MEDIA_BYTES) {
        return reply.code(413).send({ error: "Este archivo pesa demasiado para reenviarlo así (más de 60MB)." });
      }
      const buf = (await withFullMediaSlot(() => client.downloadMedia(message as Api.Message, {}))) as Buffer | undefined;
      if (!buf) return reply.code(502).send({ error: "No se pudo descargar el contenido para reenviarlo." });

      const destEntity = await resolveDialogEntity(client, id, body.chatId);
      const destPeer = await client.getInputEntity(destEntity);
      const uploaded = await client.uploadFile({
        file: new CustomFile("contenido", buf.length, "", buf),
        workers: 1,
      });

      const sourceMedia: any = message.media;
      let media: any;
      if (sourceMedia.className === "MessageMediaPhoto") {
        media = new Api.InputMediaUploadedPhoto({ file: uploaded, ttlSeconds: TTL_VIEW_ONCE });
      } else {
        const doc: any = sourceMedia.document;
        media = new Api.InputMediaUploadedDocument({
          file: uploaded,
          mimeType: doc?.mimeType || "application/octet-stream",
          attributes: doc?.attributes || [],
          ttlSeconds: TTL_VIEW_ONCE,
        });
      }

      const sendResult = await client.invoke(
        new Api.messages.SendMedia({
          peer: destPeer,
          media,
          message: "",
          randomId: generateRandomBigInt(),
        })
      );
      await logContentSend(id, body.chatId, sendResult, body.sourceItemId !== undefined ? String(body.sourceItemId) : String(body.messageId));
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo enviar el contenido para ver una vez." });
    }
  });

  app.post("/api/accounts/:id/content-group/send", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { chatId?: string; messageIds?: number[]; sourceItemId?: number | string };
    if (!body.chatId || !body.messageIds || body.messageIds.length === 0) {
      return reply.code(400).send({ error: "Falta el chat destino o el contenido a enviar" });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) return reply.code(400).send({ error: "Sin grupo de contenido configurado." });
    try {
      const client = await getAccountClient(account);
      const destEntity = await resolveDialogEntity(client, id, body.chatId);
      const sourceEntity = await getContentGroupEntity(client, id, account.contentGroupChatId);
      const sendResult = await client.forwardMessages(destEntity, {
        messages: body.messageIds,
        fromPeer: sourceEntity,
        dropAuthor: true, // llega como si lo hubiese enviado la modelo, sin "reenviado de"
      });
      await logContentSend(id, body.chatId, sendResult, body.sourceItemId !== undefined ? String(body.sourceItemId) : String(body.messageIds[0]));
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo enviar el contenido." });
    }
  });
}
