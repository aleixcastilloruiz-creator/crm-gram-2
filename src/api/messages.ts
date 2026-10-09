import { FastifyInstance } from "fastify";
import { Api, utils as telegramUtils } from "telegram";
import { generateRandomBigInt } from "telegram/Helpers";
import { prisma } from "../utils/prisma";
import { getAccountClient, invalidateAccountClient, isShadowModeEnabled } from "../telegram/connectionPool";
import { resolveDialogEntity, resolveEntityById, getLastDialogStats, usernameOf } from "../telegram/dialogs";
import { getCachedDialogs, markDialogRead, markDialogsStale, getCachedDialogTitle, shouldNotifyChat, peekCachedDialogs, touchDialogFromLiveMessage } from "../telegram/dialogsCache";
import { listAccountFolders, addChatToFolderByTitle } from "../telegram/folders";
import { subscribeToAccountEvents, getOutboxReadMaxId } from "../telegram/liveEvents";
import { countryFromPhone } from "../telegram/phoneCountry";
import { estimateRegistrationDate } from "../telegram/idRegistrationEstimate";
import { getCachedMedia, setCachedMedia } from "../telegram/mediaCache";
import { getCachedFullMedia, setCachedFullMedia } from "../telegram/fullMediaCache";
import { notifySaleToGroups } from "../whatsapp/waNotify";
import { getOwnerSessionFromRequest, getWorkerFromRequest } from "../utils/auth";
import { detectPaymentInMessage } from "../utils/paymentDetector";
import { agencyIdFromRequest } from "../utils/agencyContext";
import { recordPerfSample, getPerfStats } from "../telegram/perfSamples";
import { classifyGalleryMedia } from "../telegram/mediaKind";
import {
  hasAnyStoredMessages,
  getStoredMessagesPage,
  isFullyBackfilled,
  markFullyBackfilled,
  countOlderStored,
  persistMessagesBulk,
  persistMessage,
  deleteStoredMessage,
} from "../telegram/messageStore";
// Sin @types propios: se usa via require, la libreria en si es JS puro (no
// necesita compilar nada nativo en Railway).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const heicConvert = require("heic-convert");
// Para reconstruir el documentId (un "long" de Telegram) de un emoji premium
// guardado en un Script: viene serializado como string en la base de datos,
// y Api.MessageEntityCustomEmoji necesita un bigInt de verdad, no un string
// ni un number (perderia precision). "big-integer" ya es una dependencia de
// "telegram" (gramjs la usa por dentro para todos sus "long"), asi que esta
// disponible sin instalar nada aparte.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bigInt = require("big-integer");

// Si Telegram tarda demasiado en responder a una peticion (por ejemplo por
// un FLOOD_WAIT que GramJS espera en silencio antes de reintentar, algo que
// puede pasar tras varias acciones seguidas como crear un grupo con la
// cuenta ayudante), sin esto la peticion HTTP se queda colgada y el chat en
// el panel se queda "Cargando conversación..." para siempre, sin avisar de
// nada. Con esto, pasado el tiempo limite se devuelve un error claro en vez
// de dejar la espera infinita - el usuario puede reintentar.
/** Así se reconoce, en un catch, si un error viene de nuestro propio
 * withTimeout (conexión probablemente colgada/zombi) y no de un rechazo
 * normal de Telegram (credenciales, FLOOD_WAIT ya resuelto, etc.) - solo en
 * el primer caso conviene descartar la conexión del pool (ver
 * invalidateAccountClient). */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("tardando demasiado en responder");
}

/** Además del timeout de arriba, hay un segundo caso en el que la conexión
 * en el pool queda inservible y NO conviene seguir reutilizándola:
 * AUTH_KEY_DUPLICATED (y primos como AUTH_KEY_INVALID/AUTH_KEY_UNREGISTERED)
 * - el propio Telegram rechazando la sesión porque detecta la MISMA auth key
 * usada por dos conexiones MTProto a la vez (ver el candado `connecting` en
 * connectionPool.ts, pensado justo para evitar esto dentro de un mismo
 * proceso; si aun así ocurre - por ejemplo por un solape de dos instancias
 * de Railway durante un despliegue - GramJS sigue marcando `client.connected`
 * como true aunque Telegram esté rechazando TODAS las peticiones con un 406
 * rápido, así que sin esto el pool se queda para siempre sirviendo el mismo
 * cliente roto, cuenta "colgada" en Cargando... hasta el próximo despliegue.
 * Con esto, la SIGUIENTE petición ya descarta la conexión y crea una nueva -
 * si el solape ya terminó, se recupera sola; si Telegram sigue rechazando la
 * auth key (baneo temporal tras el conflicto), seguirá fallando pero al
 * menos cada intento abre una conexión nueva en vez de repetir siempre la
 * misma ya muerta. */
function isDeadAuthKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /AUTH_KEY_DUPLICATED|AUTH_KEY_INVALID|AUTH_KEY_UNREGISTERED/.test(err.message);
}

function shouldInvalidateConnection(err: unknown): boolean {
  return isTimeoutError(err) || isDeadAuthKeyError(err);
}

/** ID de usuario fijo (igual en TODAS las cuentas, lo asigna Telegram, no
 * depende de la nuestra) de "Telegram" - el chat de avisos/notificaciones
 * del propio Telegram (el que en algunos clientes aparece con el telefono
 * de pega "42777"). Pasa el filtro normal de "Mensajes" porque Telegram lo
 * manda como si fuera un chat privado mas (isUser), pero no es un fan real:
 * solo lo tiene que poder ver un admin. */
const TELEGRAM_SERVICE_CHAT_ID = "777000";

/** Nombres "de fabrica" de las carpetas de Telegram que un chatter no-admin
 * SI puede ver en Mensajes/Mensajes Pro. "Posibles" y "Clientes" pueden
 * estar renombradas por cuenta (ver account.folderSyncMap, Configuración →
 * Carpetas de Telegram) - por eso el nombre real a comparar se resuelve por
 * cuenta con buildChatterAllowedFolderTitles en vez de comparar contra este
 * literal directamente. "Grupo cliente" y "Time waster" no tienen ese
 * renombrado en ningun otro sitio del codigo, asi que se comparan tal cual. */
const CHATTER_ALLOWED_FOLDERS_DEFAULT = ["Posibles", "Clientes", "Grupo cliente", "Time waster"];

/** Igual que relevantFolderTitles en /unread-summary: los titulos de
 * "Posibles"/"Clientes" pueden venir renombrados por esta cuenta. */
function buildChatterAllowedFolderTitles(account: { folderSyncMap?: string | null }): Set<string> {
  let syncMap: Record<string, string> = {};
  try {
    syncMap = JSON.parse(account.folderSyncMap || "{}");
  } catch {
    syncMap = {};
  }
  return new Set(
    CHATTER_ALLOWED_FOLDERS_DEFAULT.map((t) => (syncMap[t] || t).toLowerCase())
  );
}

/** Un chat sin ninguna carpeta de Telegram SI se ve (no estar en una
 * carpeta no es, por si solo, motivo para ocultarlo) - solo se oculta
 * cuando esta metido en una carpeta y NINGUNA de sus carpetas es una de
 * las permitidas (p.ej. esta en "Admin" o "SFS", carpetas internas del
 * equipo que un chatter no tiene por que ver). */
function isFolderVisibleToChatter(folders: string[], allowedTitles: Set<string>): boolean {
  if (folders.length === 0) return true;
  return folders.some((f) => allowedTitles.has(f.toLowerCase()));
}

/** Convierte las referencias a emoji premium guardadas en un Script (o
 * arrastradas por el composer del chat) en MessageEntityCustomEmoji de
 * verdad para mandarlas con el mensaje. `leadTrim` es cuanto se recorto el
 * texto por delante al hacer .trim() (hay que restarlo a cada offset), y
 * `textLength` es la longitud del texto YA recortado: cualquier entidad que
 * se salga de ese rango (texto editado a mano después de insertar el
 * script) se descarta en vez de arriesgarse a que Telegram rechace el envío
 * entero por una entidad mal formada. */
function buildCustomEmojiEntities(
  entities: { offset: number; length: number; documentId: string }[] | undefined,
  leadTrim: number,
  textLength: number
): Api.MessageEntityCustomEmoji[] {
  if (!entities || entities.length === 0) return [];
  const out: Api.MessageEntityCustomEmoji[] = [];
  for (const e of entities) {
    if (!e || typeof e.offset !== "number" || typeof e.length !== "number" || !e.documentId) continue;
    const offset = e.offset - leadTrim;
    if (offset < 0 || offset + e.length > textLength) continue;
    try {
      out.push(new Api.MessageEntityCustomEmoji({ offset, length: e.length, documentId: bigInt(e.documentId) }));
    } catch {
      // documentId invalido (no deberia pasar salvo dato corrupto) - se
      // ignora ese emoji en vez de tirar abajo el envio del mensaje entero.
    }
  }
  return out;
}

type ScriptEntityRef = { offset: number; length: number; documentId: string };

function parseScriptEntities(raw: string | null): ScriptEntityRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Valida lo que llega del panel antes de guardarlo: solo offset/length
 * (numeros) + documentId (string), nada mas - así un body manipulado a mano
 * no puede meter basura en la columna. Devuelve null (en vez de "[]") si no
 * hay ninguno, para dejar la columna limpia. */
function sanitizeScriptEntitiesJson(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: ScriptEntityRef[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as any;
    if (typeof e.offset === "number" && typeof e.length === "number" && typeof e.documentId === "string" && e.documentId) {
      out.push({ offset: e.offset, length: e.length, documentId: e.documentId });
    }
  }
  return out.length > 0 ? JSON.stringify(out) : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Telegram está tardando demasiado en responder (${label}). Puede que la cuenta esté temporalmente limitada por Telegram - espera un momento y vuelve a intentarlo.`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** "Chatter" para el Dashboard de Informes: el nombre del trabajador si la
 * petición viene con cookie de Equipo, o el usuario del dueño/jefe si la
 * manda él mismo (no hay cookie de trabajador de por medio). */
function chatterNameFromRequest(request: any): string {
  const worker = request.worker;
  if (worker?.name) return worker.name;
  if (getOwnerSessionFromRequest(request)) return process.env.PANEL_USERNAME || "El dueño";
  return "El dueño";
}

/** Registra (best-effort, nunca hace fallar el envío) un mensaje mandado a
 * mano desde Mensajes/Mensajes Pro, para la fila "Enviado" del Dashboard de
 * Informes. responseSeconds sale de compararlo con la fecha del último
 * mensaje del fan que el propio panel ya tenía cargada -así no hace falta
 * un viaje extra a Telegram solo para calcular el tiempo de respuesta-. */
async function logChatterMessage(params: {
  accountId: string;
  chatId: string;
  chatTitle?: string | null;
  workerName: string;
  message: string;
  lastFanMessageAt?: string | null;
  telegramMessageId?: number | null;
}): Promise<void> {
  try {
    let responseSeconds: number | null = null;
    if (params.lastFanMessageAt) {
      const diffMs = Date.now() - new Date(params.lastFanMessageAt).getTime();
      if (Number.isFinite(diffMs) && diffMs >= 0 && diffMs < 1000 * 60 * 60 * 24 * 30) {
        responseSeconds = Math.round(diffMs / 1000);
      }
    }
    await prisma.chatterMessageLog.create({
      data: {
        accountId: params.accountId,
        chatId: params.chatId,
        chatTitle: params.chatTitle || null,
        workerName: params.workerName,
        message: params.message.slice(0, 500),
        responseSeconds,
        telegramMessageId: params.telegramMessageId ?? null,
      },
    });
  } catch {
    // nunca debe romper el envío del mensaje por esto
  }
}

/** Algunos fans mandan fotos en HEIC/HEIF (tipico de iPhone) - ningun
 * navegador las pinta en una etiqueta <img>, asi que si detectamos ese
 * formato lo convertimos a JPEG en el propio servidor antes de servirlo.
 * Si algo falla, se devuelve el archivo original tal cual (nunca rompe la
 * respuesta por esto). */
async function convertHeicIfNeeded(buf: Buffer, mimeType: string): Promise<{ buf: Buffer; mimeType: string }> {
  const isHeic = /image\/hei[cf]/i.test(mimeType) || (buf.length > 12 && buf.slice(4, 12).toString("ascii").includes("ftyp") && /hei[cfsx]|mif1/i.test(buf.slice(8, 12).toString("ascii")));
  if (!isHeic) return { buf, mimeType };
  try {
    const out = await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 });
    return { buf: Buffer.from(out), mimeType: "image/jpeg" };
  } catch {
    return { buf, mimeType };
  }
}

// Miniaturas/medios de la Galería del chat: mismo tipo de semaforo que en la
// bóveda de contenido, para no saturar la conexión si el fan tiene muchos
// archivos intercambiados.
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
const withGalleryThumbSlot = makeSlotLimiter(6);
const withGalleryMediaSlot = makeSlotLimiter(2);
const MAX_GALLERY_MEDIA_BYTES = 60 * 1024 * 1024;

// El <video> nativo (ahora que la foto/vídeo se ve DENTRO del chat en vez de
// en una ventana aparte, ver chatBubbleMediaEl en app.js) pide el archivo con
// cabecera "Range" para ir reproduciendo/buscando por trozos en vez de
// esperar el archivo entero - sin esto, el navegador se queda pidiendo el
// archivo completo una y otra vez cada vez que el usuario mueve la barra de
// progreso, y encima algunos navegadores ni empiezan a reproducir si no hay
// soporte de Range. Como aqui ya tenemos el buffer entero en memoria (se
// descargo de Telegram o vino de la cache), servir un trozo concreto es
// trivial.
function sendBufferWithRange(request: any, reply: any, buf: Buffer, contentType: string) {
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", contentType);
  reply.header("Content-Disposition", "inline");
  reply.header("Cache-Control", "private, max-age=1800");
  const range = request.headers?.range as string | undefined;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : buf.length - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= buf.length) end = buf.length - 1;
      if (start > end || start >= buf.length) {
        reply.code(416);
        reply.header("Content-Range", `bytes */${buf.length}`);
        return reply.send();
      }
      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${buf.length}`);
      reply.header("Content-Length", String(end - start + 1));
      return reply.send(buf.subarray(start, end + 1));
    }
  }
  reply.header("Content-Length", String(buf.length));
  return reply.send(buf);
}


// GramJS a veces "tiene éxito" (no lanza excepción) pero devuelve un Buffer
// vacío (0 bytes) - p.ej. cuando el tamaño de miniatura pedido no existe de
// verdad para ese mensaje en concreto. Un Buffer vacío sigue siendo un
// objeto "truthy" en JS, así que sin este chequeo la respuesta HTTP salía
// como 200 OK con el cuerpo vacío - el navegador la trataba como imagen
// rota, Y ENCIMA se guardaba así en caché (setCachedMedia), así que esa
// miniatura rota se quedaba sirviéndose siempre hasta que la caché
// caducara. Mismo fallo (y mismo arreglo) que ya tenía la miniatura de la
// bóveda, ver contentLibrary.ts.
function isUsableBuf(buf: unknown): buf is Buffer {
  return Buffer.isBuffer(buf) && buf.length > 0;
}

// Elige, dentro de photo.sizes/document.thumbs, el tamaño "de verdad" (no el
// "stripped" de ~40px que Telegram manda primero para pintar un blur de
// carga), como OBJETO concreto de tamaño (no un índice numérico: no hay
// garantía de que el índice de GramJS corresponda a la posición dentro de
// este array en concreto). Mismo criterio que ya usa la miniatura de la
// bóveda (ver pickBestPhotoSize en contentLibrary.ts) - antes esta ruta
// nunca lo intentaba y se quedaba solo con "thumb: -1", que para bastantes
// vídeos no devuelve nada utilizable aunque sí exista una miniatura de
// verdad en document.thumbs.
function pickBestPhotoSize(sizes: any[]): any | null {
  const usable = sizes.filter(
    (s) => s.className === "PhotoSize" || s.className === "PhotoCachedSize" || s.className === "PhotoSizeProgressive"
  );
  if (usable.length === 0) return null;
  const sorted = usable.slice().sort((a, b) => (a.w || 0) - (b.w || 0));
  return sorted.find((s) => (s.w || 0) >= 320) || sorted[sorted.length - 1];
}

function galleryMediaMimeType(media: any): string {
  if (media?.className === "MessageMediaPhoto") return "image/jpeg";
  if (media?.className === "MessageMediaWebPage" && media.webpage) {
    if (media.webpage.document?.mimeType) return media.webpage.document.mimeType;
    if (media.webpage.photo) return "image/jpeg";
  }
  if (media?.document?.mimeType) return media.document.mimeType;
  // Una foto mandada "como archivo" a veces llega con el mimeType vacío o
  // genérico (ver classifyGalleryMedia) - sin esto se servía como
  // "application/octet-stream" y el navegador no la pintaba como imagen en
  // la burbuja del chat (aunque el fallback de arriba sí hubiera
  // conseguido descargarla entera).
  const attrs: any[] = media?.document?.attributes || [];
  if (attrs.some((a) => a.className === "DocumentAttributeImageSize")) return "image/jpeg";
  return "application/octet-stream";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extrae los ids de los mensajes que ha creado un envío (forward o
 * SendMedia), para poder marcarlos como "de la bóveda" en la Galería. Best
 * effort: si no se reconoce la forma de la respuesta, simplemente no se
 * etiqueta nada (nunca hace fallar el envío en si). */
// Resuelve el JSON de carpetas marcadas en "Mostrar también en Mensajes" a
// los chatId de Telegram que contienen (grupos/canales incluidos), para que
// aparezcan junto a los chats privados normales en la lista de Mensajes.
// Cache corta: consultar las carpetas de Telegram en cada apertura de
// Mensajes seria un viaje de mas sin necesidad, ya que casi nunca cambian.
interface ExtraFoldersCacheEntry { chatIds: Set<string>; loadedAt: number }
const dialogsBgRevalidate = new Map<string, number>();
const extraFoldersCache = new Map<string, ExtraFoldersCacheEntry>();
const EXTRA_FOLDERS_TTL_MS = 2 * 60 * 1000;

// GET /dialogs (y /dialogs/search-global) pedían las carpetas de Telegram
// (listAccountFolders -> GetDialogFilters) HASTA 3 VECES por carga: una
// para "Mostrar también en Mensajes" (extraMessageFolders), otra para
// "Ocultar de Mensajes" (excludedMessageFolders) y otra para el mapa de
// etiquetas (getChatFoldersMap) - las tres piden exactamente lo mismo, solo
// que cada una tenía su propia cache por separado (por foldersJson la de
// extra/excluded, por accountId la del mapa), así que en cualquier carga en
// frío (cada ~2 min, o tras un despliegue) se disparaban las 3 a la vez
// contra Telegram para el mismo dato. Esta cache compartida (clave:
// accountId, TTL corto) hace que solo la PRIMERA de las tres llame de
// verdad a Telegram; las otras dos reutilizan el mismo resultado.
interface RawFoldersCacheEntry { folders: Awaited<ReturnType<typeof listAccountFolders>>; loadedAt: number }
const rawFoldersCache = new Map<string, RawFoldersCacheEntry>();
const RAW_FOLDERS_TTL_MS = 60 * 1000;
async function getAccountFoldersCached(client: any, accountId: string) {
  const cached = rawFoldersCache.get(accountId);
  if (cached && Date.now() - cached.loadedAt < RAW_FOLDERS_TTL_MS) return cached.folders;
  const folders = await listAccountFolders(client);
  rawFoldersCache.set(accountId, { folders, loadedAt: Date.now() });
  return folders;
}

async function resolveMessageFolderChatIds(client: any, foldersJson: string, accountId?: string): Promise<Set<string> | undefined> {
  let folderTitles: string[] = [];
  try {
    folderTitles = JSON.parse(foldersJson || "[]");
  } catch {
    folderTitles = [];
  }
  if (folderTitles.length === 0) return undefined;

  const cacheKey = `${foldersJson}`;
  const cached = extraFoldersCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < EXTRA_FOLDERS_TTL_MS) return cached.chatIds;

  try {
    const folders = accountId ? await getAccountFoldersCached(client, accountId) : await listAccountFolders(client);
    const wanted = new Set(folderTitles.map((t) => t.toLowerCase()));
    const chatIds = new Set<string>();
    for (const f of folders) {
      if (wanted.has(f.title.toLowerCase())) {
        for (const id of f.chatIds) chatIds.add(id);
      }
    }
    extraFoldersCache.set(cacheKey, { chatIds, loadedAt: Date.now() });
    return chatIds;
  } catch (err) {
    // Si esto falló por timeout (ver withTimeout en listAccountFolders), lo
    // más probable es que la conexión esté zombi - la descartamos YA en vez
    // de esperar al barrido periódico (hasta 2 min), para que la SIGUIENTE
    // carga de Mensajes ya use una conexión sana en vez de volver a chocar
    // con la misma rota.
    if (accountId && shouldInvalidateConnection(err)) invalidateAccountClient(accountId);
    return cached?.chatIds; // si falla, seguimos con lo que hubiera en cache (aunque este caducado)
  }
}

// Mapa "chatId -> nombres de carpeta de Telegram a las que pertenece", para
// poder pintar en la lista de Mensajes una mini etiqueta (p.ej. "Clientes",
// "GRU Clientes") cuando ese fan/grupo ya está metido en una carpeta real de
// Telegram - no solo la "lista" propia del CRM. Se lee TODA la cuenta (no
// solo las carpetas marcadas en "Mostrar también en Mensajes") porque una
// carpeta como "Clientes" puede no estar entre esas y aun asi querer verse
// aqui como etiqueta informativa. Misma cache corta (2 min) que
// resolveMessageFolderChatIds - las carpetas casi nunca cambian, y pedirlas
// a Telegram en cada carga de Mensajes seria un viaje de mas.
interface ChatFoldersCacheEntry { map: Map<string, string[]>; loadedAt: number }
const chatFoldersCache = new Map<string, ChatFoldersCacheEntry>();
const CHAT_FOLDERS_TTL_MS = 2 * 60 * 1000;

async function getChatFoldersMap(client: any, accountId: string): Promise<Map<string, string[]>> {
  const cached = chatFoldersCache.get(accountId);
  if (cached && Date.now() - cached.loadedAt < CHAT_FOLDERS_TTL_MS) return cached.map;
  try {
    const folders = await getAccountFoldersCached(client, accountId);
    const map = new Map<string, string[]>();
    for (const f of folders) {
      for (const chatId of f.chatIds) {
        const list = map.get(chatId);
        if (list) list.push(f.title);
        else map.set(chatId, [f.title]);
      }
    }
    chatFoldersCache.set(accountId, { map, loadedAt: Date.now() });
    return map;
  } catch (err) {
    // Misma lógica que en resolveMessageFolderChatIds: un timeout aquí casi
    // siempre es una conexión zombi - se descarta ya en vez de esperar al
    // barrido periódico.
    if (shouldInvalidateConnection(err)) invalidateAccountClient(accountId);
    return cached?.map || new Map(); // si falla, mejor sin etiquetas que romper la carga de Mensajes
  }
}

/** "Última conexión" del fan (visto por Telegram), tal y como se ve en la
 * cabecera de cualquier chat. Puede venir como fecha exacta (offline) o solo
 * como categoría ("hace poco", "esta semana"...) si el fan tiene la
 * privacidad restringida — igual pasa dentro de la propia app de Telegram. */
function formatLastSeen(status: any): { text: string | null; date: string | null } {
  if (!status) return { text: null, date: null };
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
function syncFanToTelegramFolder(app: FastifyInstance, accountId: string, chatId: string, list: string | null | undefined) {
  if (!list) return;
  (async () => {
    try {
      const account = await prisma.account.findUnique({ where: { id: accountId } });
      if (!account || !account.autoSyncFoldersEnabled) return;
      let map: Record<string, string> = {};
      try {
        map = JSON.parse(account.folderSyncMap || "{}");
      } catch {
        map = {};
      }
      const folderTitle = map[list];
      if (!folderTitle) return;
      const client = await getAccountClient(account);
      const res = await addChatToFolderByTitle(client, folderTitle, chatId);
      if (!res.ok) app.log.warn(`[folder-sync] ${accountId}/${chatId} -> "${folderTitle}": ${res.reason}`);
    } catch (err) {
      app.log.warn(err, "[folder-sync] fallo al sincronizar carpeta");
    }
  })();
}

export function extractSentMessageIds(result: any): string[] {
  try {
    const ids: string[] = [];
    if (Array.isArray(result)) {
      for (const m of result) if (m && m.id !== undefined) ids.push(String(m.id));
      return ids;
    }
    const updates: any[] = result?.updates || (result?.className?.startsWith?.("Update") ? [result] : []);
    for (const u of updates || []) {
      if (u?.message?.id !== undefined) ids.push(String(u.message.id));
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Apartado "Mensajes": chatear con los fans de una cuenta directamente
 * desde el panel, y llevar notas por fan y una nota general de la cuenta
 * (modelo), igual que en el panel de referencia.
 */
// Avatares: (1) "sin foto" se recuerda un rato, para no volver a pedirle a
// Telegram lo mismo cada vez que se pinta la lista (antes cada carga de
// Mensajes disparaba decenas de descargas que acababan en 404 y competían
// con la carga de los mensajes por la MISMA conexión de Telegram); (2) como
// mucho unas pocas descargas de foto a la vez por cuenta.
const NO_AVATAR_TTL_MS = 30 * 60 * 1000;
const noAvatarUntil = new Map<string, number>();
const AVATAR_MAX_CONCURRENT = 3;
const avatarActive = new Map<string, number>();
const avatarWaiters = new Map<string, (() => void)[]>();
async function withAvatarSlot<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  while ((avatarActive.get(accountId) || 0) >= AVATAR_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => {
      const q = avatarWaiters.get(accountId) || [];
      q.push(resolve);
      avatarWaiters.set(accountId, q);
    });
  }
  avatarActive.set(accountId, (avatarActive.get(accountId) || 0) + 1);
  try {
    return await fn();
  } finally {
    avatarActive.set(accountId, (avatarActive.get(accountId) || 1) - 1);
    const q = avatarWaiters.get(accountId);
    const next = q?.shift();
    if (next) next();
  }
}
function noAvatarReply(reply: any) {
  reply.header("Cache-Control", "private, max-age=1800");
  return reply.code(404).send();
}

export async function registerMessagesRoutes(app: FastifyInstance) {
  // Panel de medicion temporal (ver telegram/perfSamples.ts): cuanto esta
  // tardando HOY, de verdad, cada llamada a Telegram para abrir un chat
  // (getMessages) y para enviar un mensaje (sendMessage) - el "antes" que
  // hace falta tener para decidir con datos (no a ojo) si merece la pena
  // construir un cache local de mensajes. Sin `:id` en la URL (es un
  // resumen de TODAS las cuentas de la agencia), asi que se filtra aqui
  // mismo por agencia en vez de depender del guardia general de index.ts.
  app.get("/api/perf/messages", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const accounts = await prisma.account.findMany({ where: { agencyId }, select: { id: true } });
    return getPerfStats(new Set(accounts.map((a) => a.id)));
  });

  app.get("/api/accounts/:id/dialogs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { search?: string; force?: string };
    const forceRefresh = q.force === "1" || q.force === "true";
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      // CAMINO RAPIDO: si ya hay lista guardada (memoria o base de datos), se
      // responde al instante con ella y con las carpetas ya conocidas, SIN
      // esperar a la conexion con Telegram; la actualizacion real se hace en
      // segundo plano (como mucho una vez cada 20s por cuenta).
      // Un chatter solo puede ver ciertas carpetas: sin el mapa de carpetas ya
      // cargado no se puede filtrar bien, asi que en ese caso no hay atajo.
      const canFast = !forceRefresh && (!isRestrictedWorker(request) || !!chatFoldersCache.get(id));
      const fastDialogs = canFast ? await peekCachedDialogs(id) : null;
      let client: any = null;
      if (!fastDialogs) client = await getAccountClient(account);
      const staleFolders = (json: string) => {
        try { if (JSON.parse(json || "[]").length === 0) return undefined; } catch { return undefined; }
        return extraFoldersCache.get(json)?.chatIds;
      };
      const [folderExtraChatIds, excludedChatIds, restrictedGroupsRaw, chatFoldersMap, hiddenRows] = await Promise.all([
        fastDialogs ? Promise.resolve(staleFolders(account.extraMessageFolders)) : resolveMessageFolderChatIds(client, account.extraMessageFolders, id),
        fastDialogs ? Promise.resolve(staleFolders(account.excludedMessageFolders)) : resolveMessageFolderChatIds(client, account.excludedMessageFolders, id),
        prisma.clientRestrictedGroup.findMany({ where: { accountId: id }, select: { groupChatId: true, groupTitle: true } }),
        fastDialogs ? Promise.resolve(chatFoldersCache.get(id)?.map || new Map<string, string[]>()) : getChatFoldersMap(client, id),
        prisma.hiddenDialog.findMany({ where: { accountId: id }, select: { chatId: true } }),
      ]);
      // "Eliminar chat" (menú ⋮, solo admin): una vez oculto, no lo ve NADIE
      // del equipo (ni siquiera el admin que lo eliminó) - a diferencia de
      // excludedChatIds (que es una configuración de carpetas por cuenta),
      // esto es un chat concreto marcado a mano, ver HiddenDialog.
      const hiddenChatIds = new Set(hiddenRows.map((r) => r.chatId));

      // Autolimpieza: antes de fiarnos de la tabla ClientRestrictedGroup,
      // comprobamos que cada grupo guardado sigue siendo un grupo de este
      // cliente de verdad. Versiones anteriores del boton "grupo
      // restringido" podian adoptar por error un grupo grande o sin
      // relacion (publico, de spam, un canal de marketing) - eso dejo
      // registros corruptos que hacian aparecer esos grupos en Mensajes
      // para siempre.
      //
      // La comprobacion del TITULO (empieza por "<modelo> y ...") es
      // gratis - solo comparar texto, sin llamar a Telegram - asi que se
      // hace siempre, en cada carga, y bloquea la respuesta: es la que
      // evita el bug grave de "me lleva a un grupo que no tiene nada que
      // ver".
      //
      // La comprobacion del TAMAÑO si necesita preguntarle a Telegram (una
      // llamada de red por grupo), y hacerlo en CADA carga de Mensajes es
      // lo que iba dejando el panel lento - sobre todo justo despues de
      // cada despliegue, cuando la cache en memoria se vacia. Como es solo
      // una red de seguridad para datos corruptos de hace tiempo (ya no se
      // pueden generar con el codigo actual), se mueve a segundo plano: no
      // bloquea esta respuesta, se limita a como mucho una vez cada varios
      // minutos por cuenta, y si encuentra algo lo limpia para la
      // siguiente carga en vez de para esta.
      const badGroupChatIds = new Set<string>();
      const expectedGroupTitlePrefix = `${account.label} y `;
      for (const g of restrictedGroupsRaw) {
        if (!(g.groupTitle || "").startsWith(expectedGroupTitlePrefix)) badGroupChatIds.add(g.groupChatId);
      }
      if (badGroupChatIds.size) {
        await prisma.clientRestrictedGroup
          .deleteMany({ where: { accountId: id, groupChatId: { in: Array.from(badGroupChatIds) } } })
          .catch(() => {});
      }
      const restrictedGroups = restrictedGroupsRaw.filter((g) => !badGroupChatIds.has(g.groupChatId));
      if (client) runRestrictedGroupSizeSweepThrottled(client, id, account.label, restrictedGroups);

      // "Mensajes" es el chat con fans, no el Telegram entero de la cuenta:
      // solo chats privados + los grupos restringidos de cliente (título
      // "<modelo> y <cliente>", ya registrados en ClientRestrictedGroup al
      // crearlos desde el CRM) + las carpetas marcadas a mano en
      // Configuración ("Mostrar también en Mensajes"). El resto de
      // grupos/canales de la cuenta se quedan fuera. Se pasa YA fusionado a
      // getCachedDialogs porque listDialogs filtra en el origen: si un grupo
      // no esta en este set, ni siquiera llega hasta aqui.
      const extraChatIds = new Set<string>(folderExtraChatIds || []);
      for (const g of restrictedGroups) extraChatIds.add(g.groupChatId);

      // Sin withTimeout aquí, la primera carga en frío tras un despliegue
      // (o un FLOOD_WAIT de Telegram) podía dejar el panel en "Cargando..."
      // para siempre en vez de fallar con un error claro y reintentable -
      // esto es justo lo que se veía como "Mensajes Pro no funciona" /
      // "los chats cargan muy lento" en una cuenta recién precalentada. El
      // límite es generoso (2 min) a propósito: una cuenta con muchos chats
      // puede tardar de verdad en la primera carga en frío, y cortarla antes
      // de tiempo es peor que esperar un poco más - eso convertiría un "va
      // lento" en un "ya no va" de golpe.
      let dialogs: Awaited<ReturnType<typeof getCachedDialogs>>;
      if (fastDialogs) {
        dialogs = fastDialogs;
        const last = dialogsBgRevalidate.get(id) || 0;
        if (Date.now() - last > 20_000) {
          dialogsBgRevalidate.set(id, Date.now());
          getAccountClient(account)
            .then(async (c) => {
              await Promise.all([
                getCachedDialogs(c, id, extraChatIds, false),
                resolveMessageFolderChatIds(c, account.extraMessageFolders, id),
                resolveMessageFolderChatIds(c, account.excludedMessageFolders, id),
                getChatFoldersMap(c, id),
              ]);
              runRestrictedGroupSizeSweepThrottled(c, id, account.label, restrictedGroups);
            })
            .catch(() => {});
        }
      } else {
        dialogs = await withTimeout(getCachedDialogs(client, id, extraChatIds, forceRefresh), 120_000, "cargando tus conversaciones");
      }
      // Diagnostico: si algun dia una cuenta vuelve a devolver muchos menos
      // chats de los que debería, esto dice en los logs de Railway si el
      // problema viene de Telegram (rawCount ya bajo) o de nuestros propios
      // filtros de abajo (rawCount alto, dialogs.length bajo al final).
      const rawCount = dialogs.length;

      // Qué se ve en Mensajes, sin excepciones: chats individuales, y
      // grupos con MENOS de 3 miembros. Nada mas - da igual si esta
      // registrado como "grupo restringido" o metido a mano en una carpeta
      // de Configuración, si tiene 3 miembros o mas no se ve. Un grupo ya
      // registrado solo se deja pasar cuando, justo en esta carga, Telegram
      // no dio su tamaño (nunca deberia pasar, pero por si acaso no se
      // oculta de golpe algo que sabemos que es de verdad un grupo de
      // cliente).
      const restrictedChatIdSet = new Set(restrictedGroups.map((g) => g.groupChatId));
      dialogs = dialogs.filter((d) => {
        if (d.isUser) return true;
        if (typeof d.participantsCount === "number") return d.participantsCount < 3;
        return restrictedChatIdSet.has(d.chatId);
      });

      // El chat de avisos de "Telegram" (ver TELEGRAM_SERVICE_CHAT_ID) no es
      // un fan: solo un admin lo tiene que poder ver, igual que el resto de
      // datos que este apartado ya le oculta a un chatter no-admin.
      if (isRestrictedWorker(request)) {
        dialogs = dialogs.filter((d) => d.chatId !== TELEGRAM_SERVICE_CHAT_ID);
        // Un chatter solo puede ver las carpetas de Telegram "de cara al
        // fan" (Posibles, Clientes, Grupo cliente, Time waster) y los chats
        // que no estan en ninguna carpeta - carpetas internas del equipo
        // como "Admin" o "SFS" quedan fuera, aunque el chat en si sea
        // individual o un grupo pequeño (ver CHATTER_ALLOWED_FOLDERS).
        const chatterAllowedFolders = buildChatterAllowedFolderTitles(account);
        dialogs = dialogs.filter((d) => isFolderVisibleToChatter(chatFoldersMap.get(d.chatId) || [], chatterAllowedFolders));
      }

      if (excludedChatIds && excludedChatIds.size > 0) {
        dialogs = dialogs.filter((d) => !excludedChatIds.has(d.chatId));
      }
      if (hiddenChatIds.size > 0) {
        dialogs = dialogs.filter((d) => !hiddenChatIds.has(d.chatId));
      }
      if (q.search) {
        const s = q.search.toLowerCase();
        dialogs = dialogs.filter((d) => d.title.toLowerCase().includes(s) || d.lastMessage.toLowerCase().includes(s));
      }
      let debug: Record<string, unknown> | undefined;
      if (rawCount < 20) {
        // Numero sospechosamente bajo para una cuenta en uso: se deja
        // constancia en los logs (cuenta, cuantos trajo Telegram en bruto,
        // cuantos quedaron tras filtrar) para poder diagnosticarlo de verdad
        // la proxima vez que pase. Además se manda en la propia respuesta
        // (el frontend lo enseña como aviso, ver app.js) - antes esto solo
        // se podía ver en los logs de Railway, a los que no siempre hay
        // acceso a mano cuando pasa, así que el aviso se quedaba sin
        // diagnosticar.
        // getLastDialogStats: lo que Telegram devolvió DE VERDAD antes de
        // cualquier filtro (ver dialogs.ts) - rawCount/afterFilters de aquí
        // abajo en realidad ya venían post-filtro de listDialogs, así que no
        // distinguían "Telegram solo dio 8" de "Telegram dio 50 pero se
        // descartaron 42 por ser grupos grandes". Esto sí lo distingue.
        const stats = getLastDialogStats(id);
        debug = { rawCount, afterFilters: dialogs.length, forceRefresh, telegramStats: stats };
        request.log.warn({ accountId: id, ...debug }, "[dialogs] recuento sospechosamente bajo");
      }
      // Etiqueta "carpeta de Telegram" (Clientes, GRU Clientes...) para que se
      // vea en la lista sin tener que entrar en el chat - ver getChatFoldersMap.
      // Un chatter no-admin no debe ver el @usuario del fan aqui tampoco
      // (ver isRestrictedWorker mas abajo, en /profile).
      const restricted = isRestrictedWorker(request);
      const dialogsWithFolders = dialogs.map((d) => ({
        ...d,
        username: restricted ? null : d.username,
        folders: chatFoldersMap.get(d.chatId) || [],
      }));
      return { dialogs: dialogsWithFolders, debug };
    } catch (err) {
      request.log.error(err);
      // Si el fallo fue por timeout (ver isTimeoutError), lo más probable es
      // que la conexión con Telegram se haya quedado colgada/zombi (ver
      // invalidateAccountClient): sin esto, TODAS las cargas siguientes de
      // "Mensajes" de esa cuenta repetían el mismo timeout de 2 min una y
      // otra vez hasta el próximo despliegue. Descartándola ahora, la
      // siguiente petición (p.ej. el usuario recargando) ya crea una
      // conexión nueva.
      if (shouldInvalidateConnection(err)) invalidateAccountClient(id);
      return reply.code(502).send({ error: "No se pudieron leer los mensajes de Telegram. Revisa la conexión de la cuenta." });
    }
  });

  // "Eliminar chat" (menú ⋮): solo la cuenta luxe (dueño/jefe) puede
  // hacerlo - un Team líder tiene aquí el mismo perfil que un Chatter
  // (ninguno de los dos puede). No borra nada de verdad en Telegram: guarda
  // el chat como oculto (HiddenDialog) y a partir de ahí GET /dialogs lo
  // deja fuera de la lista para TODO el equipo - "eliminado" significa
  // invisible para todos, no solo para quien lo elimina.
  app.delete("/api/accounts/:id/dialogs/:chatId", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const worker = (request as any).worker as { name: string; role: string } | null;
    if (worker) {
      return reply.code(403).send({ error: "Solo el dueño puede eliminar chats." });
    }
    // Solo se llega aquí sin cookie de trabajador (worker es siempre null:
    // el dueño/jefe) - antes hiddenBy guardaba el nombre del admin que
    // borraba, pero ya no puede ser nadie más que el dueño.
    try {
      await prisma.hiddenDialog.upsert({
        where: { accountId_chatId: { accountId: id, chatId } },
        create: { accountId: id, chatId, hiddenBy: null },
        update: {},
      });
      markDialogsStale(id);
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo eliminar el chat." });
    }
  });

  // Diagnostico "grupos/canales descartados de Mensajes": para poder revisar
  // a mano si alguno de los que "Mensajes" excluye por ser grupo/canal
  // grande sin registrar debería en realidad verse (p.ej. registrandolo como
  // grupo restringido de cliente o metiendolo en una carpeta marcada en
  // Configuración), o si de verdad son grupos/canales ajenos a los fans.
  // Usa las stats del último listDialogs() de esta cuenta (se piden justo
  // después de cargar Mensajes, así que están frescas); si no hay ninguna
  // todavía, se refresca la lista para generarlas.
  app.get("/api/accounts/:id/dialogs/excluded", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      let stats = getLastDialogStats(id);
      if (!stats) {
        const client = await getAccountClient(account);
        await withTimeout(getCachedDialogs(client, id, new Set(), true), 120_000, "cargando tus conversaciones");
        stats = getLastDialogStats(id);
      }
      return { excluded: stats?.excludedList || [] };
    } catch (err) {
      request.log.error(err);
      if (shouldInvalidateConnection(err)) invalidateAccountClient(id);
      return reply.code(502).send({ error: "No se pudo leer la lista de grupos descartados." });
    }
  });

  // Buscador "de verdad": no solo entre los chats ya traídos (los de arriba,
  // limitados a los mas recientes), sino en TODO el historial de Telegram de
  // la cuenta -incluidos chats con los que no se habla desde hace tiempo y
  // que por eso no aparecen en la lista normal-, usando la búsqueda global
  // de la propia Telegram. Un resultado por chat (el mensaje mas reciente
  // que coincide), para no listar 50 mensajes del mismo fan.
  app.get("/api/accounts/:id/dialogs/search-global", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { q?: string };
    const query = (q.q || "").trim();
    if (!query) return { results: [] };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    // Resultados por NOMBRE del fan (notas del CRM + chats a los que ya se ha
    // escrito desde aquí): la lista de Mensajes solo trae los ~1000 chats más
    // recientes de Telegram, y SearchGlobal busca dentro del TEXTO de los
    // mensajes, no en los nombres - así un fan antiguo buscado por su nombre
    // salía como "Sin resultados". Esto sale de nuestra base de datos, es
    // instantáneo y no depende de Telegram.
    let nameResults: any[] = [];
    try {
      const client = await getAccountClient(account);
      // Mismas excepciones que la lista de "Mensajes" (ver el filtro de
      // GET /dialogs mas arriba): grupos ya registrados como "grupo
      // restringido de cliente" o metidos a mano en una carpeta de
      // Configuracion ("Mostrar tambien en Mensajes") SI cuentan como
      // validos aunque tengan 3 miembros o mas. Se piden en paralelo con la
      // busqueda a Telegram para no alargar mas la espera del usuario.
      const [restrictedGroupsRaw, folderExtraChatIds, hiddenRows, chatFoldersMap] = await Promise.all([
        prisma.clientRestrictedGroup.findMany({ where: { accountId: id }, select: { groupChatId: true } }),
        resolveMessageFolderChatIds(client, account.extraMessageFolders, id),
        prisma.hiddenDialog.findMany({ where: { accountId: id }, select: { chatId: true } }),
        getChatFoldersMap(client, id),
      ]);
      const allowedGroupChatIds = new Set<string>(folderExtraChatIds || []);
      for (const g of restrictedGroupsRaw) allowedGroupChatIds.add(g.groupChatId);
      const hiddenChatIds = new Set(hiddenRows.map((r) => r.chatId));
      const restrictedSearch = isRestrictedWorker(request);
      const chatterAllowedFolders = restrictedSearch ? buildChatterAllowedFolderTitles(account) : null;
      const seenChats = new Set<string>();
      const results: any[] = [];
      try {
        const [noteRows, logRows] = await Promise.all([
          prisma.fanNote.findMany({
            where: { accountId: id, chatTitle: { contains: query, mode: "insensitive" } },
            select: { chatId: true, chatTitle: true, updatedAt: true },
            orderBy: { updatedAt: "desc" },
            take: 30,
          }),
          prisma.chatterMessageLog.findMany({
            where: { accountId: id, chatTitle: { contains: query, mode: "insensitive" } },
            select: { chatId: true, chatTitle: true, message: true, sentAt: true },
            orderBy: { sentAt: "desc" },
            take: 60,
          }),
        ]);
        const byChat = new Map<string, any>();
        for (const l of logRows) {
          if (!byChat.has(l.chatId)) {
            byChat.set(l.chatId, { chatId: l.chatId, title: l.chatTitle || l.chatId, kind: "user", preview: String(l.message || "").slice(0, 140), date: l.sentAt.toISOString() });
          }
        }
        for (const n of noteRows) {
          if (!byChat.has(n.chatId)) {
            byChat.set(n.chatId, { chatId: n.chatId, title: n.chatTitle || n.chatId, kind: "user", preview: "", date: n.updatedAt.toISOString() });
          }
        }
        for (const r of byChat.values()) {
          if (hiddenChatIds.has(r.chatId)) continue;
          if (chatterAllowedFolders && !isFolderVisibleToChatter(chatFoldersMap.get(r.chatId) || [], chatterAllowedFolders)) continue;
          nameResults.push(r);
        }
      } catch {
        // la búsqueda por nombre es un extra: si falla, siguen los resultados de Telegram
      }
      // Antes esta llamada no tenía withTimeout, a diferencia de TODAS las
      // demás de este archivo - si la conexión de la cuenta estaba colgada
      // (zombi, ver connectionPool.ts) o simplemente saturada por el
      // reenviador/otros chatters, esta petición se quedaba esperando a
      // Telegram SIN LÍMITE: la barra de búsqueda se quedaba "buscando..."
      // para siempre (o tardaba muchísimo) y, como nunca llegaba a fallar,
      // tampoco se disparaba nunca la reconexión por timeout - la propia
      // conexión rota se seguía reutilizando en la siguiente búsqueda. Esto
      // es justo lo que se veía como "el buscador va muy lento o a veces no
      // va". Se usa un límite mas corto (25s) que el de abrir un chat: es
      // una búsqueda en vivo mientras el usuario escribe, así que si tarda
      // más que eso ya no aporta - mejor fallar rápido y que se note la
      // conexión colgada, que dejar la búsqueda esperando indefinidamente.
      const result: any = await withTimeout(
        client.invoke(
          new Api.messages.SearchGlobal({
            q: query,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetRate: 0,
            offsetPeer: new Api.InputPeerEmpty(),
            offsetId: 0,
            limit: 50,
          })
        ),
        25_000,
        "buscando en Telegram"
      );
      const messages: any[] = result?.messages || [];
      const chatsById = new Map<string, any>((result?.chats || []).map((c: any) => [String(c.id), c]));
      const usersById = new Map<string, any>((result?.users || []).map((u: any) => [String(u.id), u]));

      for (const m of messages) {
        const peer = m.peerId;
        if (!peer) continue;
        let chatId: string;
        let title = "(sin nombre)";
        let chatEntity: any = null;
        try {
          chatId = telegramUtils.getPeerId(peer).toString();
        } catch {
          continue;
        }
        if (peer.className === "PeerUser") {
          const u = usersById.get(String(peer.userId));
          if (u) title = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || title;
        } else if (peer.className === "PeerChat") {
          chatEntity = chatsById.get(String(peer.chatId));
          title = chatEntity?.title || title;
        } else if (peer.className === "PeerChannel") {
          chatEntity = chatsById.get(String(peer.channelId));
          title = chatEntity?.title || title;
        }
        // Mismo filtro que "Mensajes": solo chats individuales, grupos con
        // MENOS de 3 miembros, o grupos ya permitidos explicitamente
        // (restringido de cliente / carpeta marcada). Antes el buscador
        // devolvia CUALQUIER grupo o canal de la cuenta donde apareciese la
        // palabra buscada, sin aplicar esta restriccion - asi que un
        // chatter podia encontrar (y abrir) grupos grandes que en la lista
        // normal de Mensajes nunca ve.
        if (peer.className !== "PeerUser") {
          const isChannel = !!chatEntity?.broadcast && !chatEntity?.megagroup;
          const participantsCount = typeof chatEntity?.participantsCount === "number" ? chatEntity.participantsCount : null;
          const isSmallGroup = !isChannel && participantsCount !== null && participantsCount < 3;
          const isAllowed = allowedGroupChatIds.has(chatId);
          if (!isSmallGroup && !isAllowed) continue;
        } else if (chatId === TELEGRAM_SERVICE_CHAT_ID && restrictedSearch) {
          continue;
        }
        if (hiddenChatIds.has(chatId)) continue;
        // Igual que en la lista de Mensajes: un chatter no ve chats metidos
        // en una carpeta de Telegram que no sea de cara al fan (Admin, SFS...).
        if (chatterAllowedFolders && !isFolderVisibleToChatter(chatFoldersMap.get(chatId) || [], chatterAllowedFolders)) continue;
        if (seenChats.has(chatId)) continue; // un resultado por chat (el mas reciente)
        seenChats.add(chatId);
        results.push({
          chatId,
          title,
          kind: peer.className === "PeerUser" ? "user" : "group",
          preview: (m.message ? String(m.message).slice(0, 140) : m.media ? "[archivo adjunto]" : ""),
          date: m.date ? new Date(m.date * 1000).toISOString() : null,
        });
      }
      for (const r of nameResults) {
        if (seenChats.has(r.chatId)) continue;
        seenChats.add(r.chatId);
        results.push(r);
      }
      return { results };
    } catch (err: any) {
      request.log.error(err);
      if (shouldInvalidateConnection(err)) invalidateAccountClient(id);
      // Si Telegram no contestó pero ya tenemos resultados por nombre, se
      // devuelven esos en vez de un error.
      if (nameResults.length > 0) return { results: nameResults };
      return reply.code(502).send({ error: "No se pudo buscar en todo Telegram." });
    }
  });

  app.get("/api/accounts/:id/dialogs/:chatId/messages", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    // offsetId: para "cargar mensajes anteriores" (historial mas antiguo) sin
    // recargar toda la conversacion desde cero.
    const q = request.query as { limit?: string; offsetId?: string };
    if (chatId === TELEGRAM_SERVICE_CHAT_ID && isRestrictedWorker(request)) {
      return reply.code(403).send({ error: "No tienes acceso a este chat." });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      // La conexión con Telegram y la entidad del chat se piden SOLO si hacen
      // falta (primera vez que se ve el chat, historial antiguo, o marcar
      // leído). Antes se esperaban SIEMPRE al principio, así que incluso un
      // chat ya guardado en la base de datos tardaba lo que tardase Telegram
      // en resolverlo (lentísimo tras un despliegue o con la conexión fría).
      let tgPromise: Promise<{ client: any; entity: any }> | null = null;
      const getTg = () => {
        if (!tgPromise) {
          tgPromise = (async () => {
            const client = await getAccountClient(account);
            const entity = await withTimeout(resolveDialogEntity(client, id, chatId), 35_000, "abriendo la conversación");
            return { client, entity };
          })();
          tgPromise.catch(() => {}); // evita "unhandled rejection" si nadie llega a esperarla
        }
        return tgPromise;
      };
      const limit = Math.min(Number(q.limit) || 60, 200);
      const offsetId = q.offsetId ? Number(q.offsetId) : undefined;

      // Copia local (ver telegram/messageStore.ts): un chat que ya se haya
      // abierto antes (o cuyo tramo pedido ya se trajo con "Cargar más")
      // se sirve ENTERO desde la base de datos de la agencia, sin tocar
      // Telegram para nada - cada mensaje nuevo ya se fue guardando solo,
      // en tiempo real, según llegaba (ver telegram/liveEvents.ts). Solo se
      // habla con Telegram aquí la PRIMERA vez que se ve un chat, o para
      // completar historial antiguo que todavía no se había pedido nunca.
      let baseMessages: { id: number; text: string; out: boolean; date: string | null; mediaType: string | null }[];
      let hasMore: boolean;

      // Las tres consultas a la base de datos en paralelo (antes una detrás de
      // otra): si el chat no estaba guardado, las dos últimas simplemente
      // devuelven vacío/false y se ignoran.
      const [seenBefore, backfilledRaw, storedRaw] = await Promise.all([
        offsetId ? Promise.resolve(true) : hasAnyStoredMessages(id, chatId),
        isFullyBackfilled(id, chatId),
        getStoredMessagesPage(id, chatId, { limit, beforeId: offsetId }),
      ]);
      const alreadySeen = seenBefore;
      const backfilled = alreadySeen ? backfilledRaw : false;
      let storedPage = alreadySeen ? storedRaw : [];

      const needsLiveFetch = !alreadySeen || (storedPage.length < limit && !backfilled);
      // Chat servido desde la base de datos: se deja preparada en segundo plano
      // la conexión + entidad (sin esperar), para que el primer ENVÍO desde
      // este chat no pague esa resolución. La respuesta no depende de ello.
      if (!needsLiveFetch && !offsetId) getTg().catch(() => {});
      if (needsLiveFetch) {
        const { client, entity } = await getTg();
        const getMessagesStartedAt = Date.now();
        const raw = await withTimeout(
          client.getMessages(entity, { limit, offsetId }),
          35_000,
          "cargando los mensajes"
        );
        // Medicion temporal (ver telegram/perfSamples.ts): cuanto tarda HOY
        // Telegram en devolver el historial de un chat - ya solo se mide
        // cuando de verdad hace falta tocar Telegram (ver arriba), que es
        // justo lo que esta caché local intenta evitar la mayoría de las
        // veces.
        recordPerfSample("getMessages", id, chatId, Date.now() - getMessagesStartedAt);
        const rawMessages = raw as Api.Message[];
        persistMessagesBulk(id, chatId, rawMessages); // fire-and-forget: deja la caché lista para la próxima vez
        if (rawMessages.length < limit) markFullyBackfilled(id, chatId); // esto fue TODO lo que quedaba hacia atrás
        baseMessages = rawMessages
          .filter((m) => m.message || m.media)
          .map((m) => ({
            id: m.id,
            text: m.message || "",
            out: !!m.out,
            date: m.date ? new Date(m.date * 1000).toISOString() : null,
            mediaType: m.media ? classifyGalleryMedia(m.media) : null,
          }))
          .reverse(); // mas antiguo primero, para pintar de arriba a abajo
        hasMore = rawMessages.length >= limit;
      } else {
        baseMessages = storedPage;
        // backfilled=true aquí siempre (si no, needsLiveFetch habría sido
        // true salvo que storedPage ya llenara el límite pedido) - en ese
        // caso hasMore depende de si queda algo guardado más antiguo que
        // lo que se acaba de devolver; si no hay nada en esta página,
        // trivialmente no hay más.
        if (baseMessages.length === 0) {
          hasMore = false;
        } else if (!backfilled) {
          hasMore = true; // se llenó el límite pero el historial no está completo: puede haber más
        } else {
          hasMore = (await countOlderStored(id, chatId, baseMessages[0].id)) > 0;
        }
      }

      // "Tick de leído" (✓✓ como Telegram/TeleCrew): hasta qué id de mensaje
      // saliente nuestro ha confirmado Telegram que el fan ha leído en este
      // chat (ver UpdateReadHistoryOutbox en telegram/liveEvents.ts). 0 =
      // sin ningún aviso de lectura todavía (desde que arrancó el servidor):
      // el frontend lo pinta como un solo ✓ (enviado), no como no-leído.
      const readMaxId = getOutboxReadMaxId(id, chatId);
      const messages = baseMessages.map((m) => ({
        ...m,
        // Solo tiene sentido para los nuestros (out=true) - el frontend
        // ignora este campo en los mensajes entrantes.
        read: !!m.out && readMaxId > 0 && m.id <= readMaxId,
        // El archivo en si se pide luego a /gallery/:id/thumb y
        // /gallery/:id/media (mismos endpoints que la Galeria, ya
        // funcionan para cualquier mensaje con media de este chat).
        hasThumb: m.mediaType === "photo" || m.mediaType === "video",
        // Qué chatter mandó este mensaje (si se pudo saber) - se rellena
        // justo debajo, cruzando con ChatterMessageLog.
        sentBy: null as string | null,
      }));

      // Quién mandó cada mensaje nuestro (chatBubble lo pinta junto a la
      // hora y el tick): se guardó en /send (ver logChatterMessage) con el
      // id real que Telegram le dio. Mensajes de antes de que esto
      // existiera (telegramMessageId null en la tabla) se quedan sin
      // etiquetar - no hay forma de saber quién los mandó.
      const outIds = messages.filter((m) => m.out).map((m) => m.id);
      if (outIds.length > 0) {
        const logs = await prisma.chatterMessageLog.findMany({
          where: { accountId: id, chatId, telegramMessageId: { in: outIds } },
          select: { telegramMessageId: true, workerName: true },
        });
        const sentByMessageId = new Map<number, string>();
        for (const log of logs) {
          if (log.telegramMessageId != null) sentByMessageId.set(log.telegramMessageId, log.workerName);
        }
        for (const m of messages) {
          if (m.out) m.sentBy = sentByMessageId.get(m.id) || null;
        }
      }
      markDialogRead(id, chatId);
      // Confirmación de lectura REAL a Telegram: a petición expresa de
      // Aitor (antes el "modo shadow" bloqueaba esto siempre, para
      // cualquier agencia, sin opción - ver el comentario grande de
      // applyShadowStatus en connectionPool.ts). Ahora, SOLO para las
      // agencias que tengan el modo shadow desactivado en Configuración, al
      // abrir un chat aquí se le dice a Telegram de verdad "esto está
      // leído" - así la propia app de Telegram del móvil (y el fan) quedan
      // sincronizados con lo que se hace desde el panel, en vez de quedarse
      // con burbujas de no-leído "fantasma" para siempre. Con el modo
      // shadow activado (el valor de siempre) no cambia nada: sigue sin
      // mandarse jamás, igual que hasta ahora. Fire-and-forget y en un
      // try/catch aparte: si esto falla (FLOOD_WAIT puntual, etc.) no debe
      // tirar abajo la respuesta de los mensajes, que ya se tienen listos.
      isShadowModeEnabled(account.agencyId)
        .then((shadow) => {
          if (shadow) return;
          return getTg().then(({ client, entity }) => client.markAsRead(entity)).catch(() => {});
        })
        .catch(() => {});
      return { messages, hasMore };
    } catch (err) {
      request.log.error(err);
      if (shouldInvalidateConnection(err)) invalidateAccountClient(id);
      return reply.code(502).send({ error: "No se pudo cargar la conversación desde Telegram." });
    }
  });

  app.post("/api/accounts/:id/dialogs/:chatId/send", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    if (chatId === TELEGRAM_SERVICE_CHAT_ID && isRestrictedWorker(request)) {
      return reply.code(403).send({ error: "No tienes acceso a este chat." });
    }
    const { text, chatTitle, lastFanMessageAt, entities } = request.body as {
      text?: string;
      chatTitle?: string;
      lastFanMessageAt?: string | null;
      // Emoji premium arrastrados desde un Script (ver /scripts): offsets en
      // el texto SIN recortar (antes del .trim() de abajo) tal como los
      // guardo el composer del chat.
      entities?: { offset: number; length: number; documentId: string }[];
    };
    if (!text || !text.trim()) {
      return reply.code(400).send({ error: "Falta el texto del mensaje" });
    }
    const trimmed = text.trim();
    // trim() puede recortar espacio por delante: hay que desplazar los
    // offsets de los emoji premium ese mismo tanto, o apuntarian al
    // caracter equivocado del texto ya recortado.
    const leadTrim = text.length - text.replace(/^\s+/, "").length;
    const formattingEntities = buildCustomEmojiEntities(entities, leadTrim, trimmed.length);
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveDialogEntity(client, id, chatId);
      const sendStartedAt = Date.now();
      const sent = await client.sendMessage(entity, {
        message: trimmed,
        formattingEntities: formattingEntities.length > 0 ? formattingEntities : undefined,
      });
      // Medicion temporal (ver telegram/perfSamples.ts) - mismo motivo que
      // en GET .../messages, aqui para el tramo de ENVIAR.
      recordPerfSample("sendMessage", id, chatId, Date.now() - sendStartedAt);
      // Guarda este mensaje en la copia local (ver telegram/messageStore.ts)
      // YA, sin esperar al eco del evento en vivo (que, como dice el
      // comentario de abajo sobre el detector de pagos, no siempre llega
      // con la misma conexión que acaba de enviar) - así el chat recién
      // enviado está completo en caché al instante.
      if (sent) persistMessage(id, chatId, sent as Api.Message);
      // La lista de chats tambien debe reflejar YA este mensaje como el ultimo
      // de la conversacion (el eco en vivo no siempre llega).
      touchDialogFromLiveMessage(id, chatId, { text: trimmed, out: true, date: new Date().toISOString() });
      logChatterMessage({
        accountId: id,
        chatId,
        chatTitle,
        workerName: chatterNameFromRequest(request),
        message: text.trim(),
        lastFanMessageAt,
        // id real que Telegram le dio a este mensaje - con esto GET
        // .../messages puede decir qué chatter mandó cada burbuja (ver
        // "sentBy" más abajo en ese endpoint).
        telegramMessageId: typeof sent?.id === "number" ? sent.id : null,
      });
      // Detector de pagos: antes esto solo se disparaba si el "eco" del
      // propio envío volvía a llegar como evento en vivo de Telegram
      // (liveEvents.ts) - con la MISMA conexión que acaba de enviar el
      // mensaje eso no siempre pasa (depende de si GramJS reprocesa las
      // updates que trae la respuesta del propio sendMessage), así que un
      // trabajador podía escribir un método de pago que no es el nuestro
      // desde el propio chat del panel y el detector se lo saltaba sin
      // avisar. Se llama aquí también, directamente, para no depender de
      // ese eco - detectPaymentInMessage no lanza nunca (best-effort) y no
      // se espera (fire-and-forget) para no retrasar la respuesta al chat.
      detectPaymentInMessage({
        accountId: id,
        chatId,
        chatTitle: chatTitle || chatId,
        senderOut: true,
        text: text.trim(),
      }).catch(() => {});
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      const msg = err?.errorMessage || err?.message || "";
      // Un grupo restringido cuyo registro en el CRM quedo "fantasma" (el
      // chat ya no existe de verdad en Telegram, o nunca llego a existir
      // del todo) falla al enviar con este error - Telegram lo rechaza aqui
      // aunque la lectura del chat no diera error antes. En vez de dejar
      // solo el error tecnico, se borra el registro (si es que este chat
      // era el grupo restringido de algun cliente) para que el boton 👥
      // pueda crear uno de verdad la proxima vez, y se avisa con claridad.
      if (/PEER_ID_INVALID|CHAT_ID_INVALID|CHANNEL_INVALID|CHAT_INVALID/i.test(msg)) {
        const asRestrictedGroup = await prisma.clientRestrictedGroup.findFirst({ where: { accountId: id, groupChatId: chatId } });
        if (asRestrictedGroup) {
          await prisma.clientRestrictedGroup
            .delete({ where: { accountId_chatId: { accountId: id, chatId: asRestrictedGroup.chatId } } })
            .catch(() => {});
          markDialogsStale(id);
          return reply.code(502).send({
            error: "Este grupo ya no existe de verdad en Telegram (era un registro obsoleto). Se ha quitado del CRM - vuelve al chat de este cliente y pulsa 👥 otra vez para crear el grupo de verdad.",
          });
        }
      }
      return reply.code(502).send({ error: msg || "No se pudo enviar el mensaje." });
    }
  });

  // Borrar un mensaje ENVIADO desde el CRM (solo los nuestros, out=true).
  // Se borra también en Telegram (para el fan) y queda registrado en
  // DeletedMessageLog con el texto original, el fan, quién lo envió y quién
  // lo borró - es lo que enseña Informes → Dashboard → Mensajes borrados.
  app.delete("/api/accounts/:id/dialogs/:chatId/messages/:messageId", async (request, reply) => {
    const { id, chatId, messageId } = request.params as { id: string; chatId: string; messageId: string };
    if (chatId === TELEGRAM_SERVICE_CHAT_ID && isRestrictedWorker(request)) {
      return reply.code(403).send({ error: "No tienes acceso a este chat." });
    }
    const msgId = Number(messageId);
    if (!Number.isInteger(msgId) || msgId <= 0) return reply.code(400).send({ error: "Mensaje no válido" });
    const body = (request.body || {}) as { text?: string; chatTitle?: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const stored = await prisma.storedMessage.findUnique({
      where: { accountId_chatId_telegramMessageId: { accountId: id, chatId, telegramMessageId: msgId } },
    });
    if (stored && !stored.out) {
      return reply.code(403).send({ error: "Solo se pueden borrar los mensajes enviados por vosotros." });
    }
    const sentLog = await prisma.chatterMessageLog.findFirst({
      where: { accountId: id, chatId, telegramMessageId: msgId },
      orderBy: { sentAt: "desc" },
    });
    const text = (stored?.text || sentLog?.message || body.text || "").slice(0, 4000);
    const mediaLabel = stored?.mediaType ? `[${stored.mediaType}]` : "";
    // Primero se anota (así nunca se borra algo sin dejar rastro) y si
    // Telegram falla, se quita la anotación.
    const log = await prisma.deletedMessageLog.create({
      data: {
        accountId: id,
        chatId,
        chatTitle: sentLog?.chatTitle || body.chatTitle || getCachedDialogTitle(id, chatId) || null,
        telegramMessageId: msgId,
        message: text || mediaLabel || "(sin texto)",
        mediaType: stored?.mediaType || null,
        sentBy: sentLog?.workerName || null,
        deletedBy: chatterNameFromRequest(request),
        sentAt: stored?.date || sentLog?.sentAt || null,
      },
    });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveDialogEntity(client, id, chatId);
      await client.deleteMessages(entity, [msgId], { revoke: true });
      await deleteStoredMessage(id, chatId, msgId);
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      await prisma.deletedMessageLog.delete({ where: { id: log.id } }).catch(() => {});
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo borrar el mensaje." });
    }
  });

  // Respuestas rápidas de Telegram Business ("Quick replies"): shortcuts
  // que la propia cuenta ya tiene guardados en Telegram (Ajustes → Negocio →
  // Respuestas rápidas, en la app oficial - requiere Telegram Premium/
  // Business). No se guarda nada en nuestra base de datos: se leen en vivo,
  // igual que el resto de "Mensajes". "count" es cuantos mensajes lleva
  // cada shortcut (texto, fotos... pueden ser varios) - se usa luego al
  // enviarlo para generar el mismo numero de random_id.
  // OJO: la ruta NO puede llamarse "/quick-replies" a secas - eso ya existe
  // en modeloConfig.ts (el "QuickReply" de Configuración → Modelos, una
  // lista de textos guardados en NUESTRA base de datos, sin relacion
  // ninguna con esto) y Fastify no deja registrar dos veces la misma ruta:
  // el servidor entero se caía al arrancar (FST_ERR_DUPLICATED_ROUTE).
  app.get("/api/accounts/:id/business-quick-replies", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const result: any = await client.invoke(new Api.messages.GetQuickReplies({ hash: 0 as any }));
      if (result.className === "messages.QuickRepliesNotModified") return { shortcuts: [] };
      const messagesById = new Map<string, any>((result.messages || []).map((m: any) => [String(m.id), m]));
      const shortcuts = (result.quickReplies || []).map((qr: any) => {
        const topMsg = messagesById.get(String(qr.topMessage));
        return {
          shortcutId: qr.shortcutId,
          shortcut: qr.shortcut,
          count: qr.count,
          preview: topMsg?.message ? topMsg.message.slice(0, 140) : topMsg?.media ? "[archivo adjunto]" : "",
        };
      });
      return { shortcuts };
    } catch (err: any) {
      request.log.error(err);
      const msg = err?.errorMessage || err?.message || "";
      if (/PREMIUM/i.test(msg)) {
        return reply.code(502).send({ error: "Esta cuenta no tiene Telegram Premium/Business: no puede usar respuestas rápidas.", shortcuts: [] });
      }
      return reply.code(502).send({ error: msg || "No se pudieron leer las respuestas rápidas de Telegram." });
    }
  });

  // Manda TODOS los mensajes de un shortcut de golpe (texto, fotos... lo que
  // tenga) tal cual estan guardados en Telegram - asi es como funciona una
  // respuesta rapida de Business en la app oficial, no se manda solo el
  // texto suelto. Se relee el shortcut aqui (no se confia en el "count" que
  // el frontend pudiera tener cacheado) para generar el numero exacto de
  // random_id que Telegram espera.
  app.post("/api/accounts/:id/dialogs/:chatId/send-business-quick-reply", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as { shortcutId?: number };
    if (body.shortcutId === undefined || body.shortcutId === null) {
      return reply.code(400).send({ error: "Falta la respuesta rápida a enviar" });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const listResult: any = await client.invoke(new Api.messages.GetQuickReplies({ hash: 0 as any }));
      const shortcuts = listResult.quickReplies || [];
      const shortcut = shortcuts.find((qr: any) => qr.shortcutId === body.shortcutId);
      if (!shortcut) return reply.code(404).send({ error: "Esa respuesta rápida ya no existe (se habrá borrado/editado desde Telegram)." });
      const entity = await resolveDialogEntity(client, id, chatId);
      const peer = await client.getInputEntity(entity);
      const randomIds = Array.from({ length: shortcut.count || 1 }, () => generateRandomBigInt());
      await client.invoke(
        new Api.messages.SendQuickReplyMessages({ peer, shortcutId: body.shortcutId, id: [], randomId: randomIds })
      );
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo enviar la respuesta rápida." });
    }
  });

  // Un chatter (trabajador con rol "worker", no "admin") no debe poder ver
  // ni el @usuario ni el numero de telefono de un cliente - son datos de
  // contacto directo, y el chatter solo deberia poder hablarle a traves del
  // propio CRM. (request as any).worker ya lo deja puesto
  // requireSectionAccess (ver utils/auth.ts) antes de llegar aqui; null =
  // sin cookie de trabajador (el dueño/jefe), así que solo se restringe
  // cuando SÍ hay trabajador - un Team líder ("admin") ya NO está exento:
  // tiene el mismo perfil que un Chatter aquí (mismas carpetas visibles,
  // mismo ocultado de @usuario/teléfono y del chat de servicio de
  // Telegram). La única diferencia de un Team líder es SFS, aparte.
  function isRestrictedWorker(request: any): boolean {
    const worker = request.worker as { role: string } | null | undefined;
    return !!worker;
  }

  // Numero de telefono + pais detectado (icono de bandera junto al numero,
  // igual que en el panel de referencia) de un fan concreto.
  app.get("/api/accounts/:id/dialogs/:chatId/profile", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    if (chatId === TELEGRAM_SERVICE_CHAT_ID && isRestrictedWorker(request)) {
      return reply.code(403).send({ error: "No tienes acceso a este chat." });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveDialogEntity(client, id, chatId);
      let user = entity as Api.User;
      // La entidad que sale de la lista de dialogos suele venir "recortada"
      // (sin telefono aunque Telegram lo dejase ver), asi que pedimos el
      // usuario completo para tener la mejor oportunidad de verlo.
      if (user.className === "User" && (user as any).accessHash) {
        try {
          const inputUser = new Api.InputUser({ userId: user.id, accessHash: (user as any).accessHash });
          const full = await client.invoke(new Api.users.GetUsers({ id: [inputUser] }));
          if (full && full[0] && (full[0] as any).className === "User") {
            user = full[0] as Api.User;
          }
        } catch (e) {
          request.log.warn(e, "No se pudo pedir el usuario completo para el telefono, uso la entidad en cache");
        }
      }
      const phone = (user as any).phone ? "+" + (user as any).phone : null;
      const country = countryFromPhone(phone);
      // Telegram no da la fecha de alta por API: se estima a partir del id
      // de usuario (ver idRegistrationEstimate.ts). Siempre "aproximada".
      const registeredApprox = estimateRegistrationDate((user as any).id);
      const lastSeen = formatLastSeen((user as any).status);
      const fanNote = await prisma.fanNote.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
      const restricted = isRestrictedWorker(request);
      return {
        phone: restricted ? null : phone,
        username: restricted ? null : usernameOf(user),
        country,
        registeredApprox,
        lastSeenText: lastSeen.text,
        lastSeenDate: lastSeen.date,
        autoBlockedByCountry: !!fanNote?.autoBlockedByCountry,
      };
    } catch (err: any) {
      request.log.error(err);
      const detail = err?.errorMessage || err?.message || "";
      return reply.code(502).send({ error: "No se pudo leer el número de este chat." + (detail ? ` (${detail})` : "") });
    }
  });

  // "Editar nombre del fan" (como en TeleCrew): deja cambiar el nombre con
  // el que se ve a este cliente en el panel (cabecera del chat, lista de
  // Mensajes...) y, a la vez, cambia ese mismo nombre DE VERDAD en Telegram
  // - el nombre de contacto que esta cuenta tiene guardado para él, visible
  // en la propia app de Telegram de la cuenta, no solo aquí en el CRM -.
  // A PROPÓSITO solo se deja tocar el nombre (nunca teléfono, usuario,
  // apellido...): disponible para cualquier trabajador con acceso a este
  // chat, igual que el resto de botones de la cabecera (ver dialogs(\/.*)?
  // en WORKER_ACCESSIBLE_PATH_PATTERNS, index.ts).
  app.post("/api/accounts/:id/dialogs/:chatId/fan-name", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    if (chatId === TELEGRAM_SERVICE_CHAT_ID && isRestrictedWorker(request)) {
      return reply.code(403).send({ error: "No tienes acceso a este chat." });
    }
    const body = request.body as { name?: string };
    const newName = (body?.name || "").trim();
    if (!newName) return reply.code(400).send({ error: "El nombre no puede estar vacío." });
    if (newName.length > 64) return reply.code(400).send({ error: "El nombre es demasiado largo (máximo 64 caracteres)." });
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const fanEntity = await resolveDialogEntity(client, id, chatId);
      const fanUser = fanEntity as any;
      if (fanUser?.className !== "User") {
        return reply.code(400).send({ error: "Solo se puede editar el nombre de un cliente (no de un grupo o canal)." });
      }
      // Se guarda como contacto de ESTA cuenta con el nombre nuevo (sin
      // apellido, a propósito solo se toca el nombre) - es lo mismo que hace
      // Telegram cuando guardas/editas un contacto a mano, así que el
      // cambio se ve de verdad en la propia app de Telegram de la cuenta.
      await withTimeout(
        client.invoke(
          new Api.contacts.AddContact({
            id: new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash }),
            firstName: newName,
            lastName: "",
            phone: fanUser.phone || "",
            addPhonePrivacyException: false,
          })
        ),
        35_000,
        "renombrando al cliente"
      );
      // Se actualiza también lo que ya tenemos cacheado (lista de Mensajes,
      // nota del fan...) para que el nombre nuevo se vea al instante, sin
      // esperar al siguiente refresco de /dialogs contra Telegram.
      await prisma.cachedDialog
        .update({ where: { accountId_chatId: { accountId: id, chatId } }, data: { title: newName } })
        .catch(() => {});
      await prisma.fanNote
        .update({ where: { accountId_chatId: { accountId: id, chatId } }, data: { chatTitle: newName } })
        .catch(() => {});
      markDialogsStale(id);
      return { ok: true, title: newName };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo cambiar el nombre del cliente." });
    }
  });

  // Grupos que la cuenta y este cliente tienen en común (lo mismo que
  // Telegram muestra al tocar el nombre de un contacto: "Grupos en común").
  // Sirve para encontrar el grupo restringido de este cliente si ya existía
  // de antes (creado a mano, o con otra cuenta) y el CRM todavía no lo sabe.
  app.get("/api/accounts/:id/dialogs/:chatId/common-groups", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const fanEntity = await resolveDialogEntity(client, id, chatId);
      const fanUser = fanEntity as any;
      if (fanUser.className !== "User") {
        return { groups: [] }; // solo tiene sentido para chats privados (personas), no grupos/canales
      }
      const inputUser = new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
      const result: any = await client.invoke(
        new Api.messages.GetCommonChats({ userId: inputUser, maxId: 0 as any, limit: 100 })
      );
      const chats: any[] = result?.chats || [];
      const groups = chats.map((c) => ({
        chatId: (c.className === "Channel" ? "-100" + String(c.id) : "-" + String(c.id)),
        title: c.title || "",
      }));
      return { groups };
    } catch (err: any) {
      request.log.error(err);
      const detail = err?.errorMessage || err?.message || "";
      return reply.code(502).send({ error: "No se pudieron leer los grupos en común." + (detail ? ` (${detail})` : "") });
    }
  });

  // "Desbloquear" un fan que se bloqueó solo por el país de su teléfono
  // (Bloqueo automático por país): desbloquea en Telegram y marca que no se
  // le debe volver a bloquear solo, aunque siga escribiendo desde ese país.
  app.post("/api/accounts/:id/dialogs/:chatId/unblock", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveDialogEntity(client, id, chatId);
      const user = entity as any;
      if (user.className === "User" && user.accessHash) {
        const inputUser = new Api.InputUser({ userId: user.id, accessHash: user.accessHash });
        await client.invoke(new Api.contacts.Unblock({ id: inputUser }));
      }
      await prisma.fanNote.upsert({
        where: { accountId_chatId: { accountId: id, chatId } },
        update: { manuallyUnblocked: true, autoBlockedByCountry: false },
        create: { accountId: id, chatId, manuallyUnblocked: true },
      });
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo desbloquear." });
    }
  });

  // Foto de perfil del fan (o de un grupo), para pintar el avatar real en
  // vez de las iniciales. 404 si no tiene foto puesta.
  app.get("/api/accounts/:id/dialogs/:chatId/avatar", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const cacheKey = `avatar:${id}:${chatId}`;
    const cached = getCachedMedia(cacheKey);
    if (cached) {
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=1800");
      return reply.send(cached);
    }
    if ((noAvatarUntil.get(cacheKey) || 0) > Date.now()) return noAvatarReply(reply);
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const buf = await withAvatarSlot(id, async () => {
        const client = await getAccountClient(account);
        const entity = await resolveDialogEntity(client, id, chatId);
        return (await client.downloadProfilePhoto(entity, { isBig: false })) as Buffer | undefined;
      });
      if (!buf || buf.length === 0) {
        noAvatarUntil.set(cacheKey, Date.now() + NO_AVATAR_TTL_MS);
        return noAvatarReply(reply);
      }
      setCachedMedia(cacheKey, buf);
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=1800");
      return reply.send(buf);
    } catch (err) {
      // fallo puntual (conexión...): se recuerda poco rato para no insistir en bucle
      noAvatarUntil.set(cacheKey, Date.now() + 2 * 60 * 1000);
      return reply.code(404).send();
    }
  });

  // Foto de perfil de la propia cuenta (modelo), para la columna de
  // "Cuentas" del apartado Mensajes (avatar real en vez de solo iniciales).
  app.get("/api/accounts/:id/avatar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cacheKey = `avatar:${id}:self`;
    const cached = getCachedMedia(cacheKey);
    if (cached) {
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=1800");
      return reply.send(cached);
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const me = await client.getMe();
      const buf = (await client.downloadProfilePhoto(me, { isBig: false })) as Buffer | undefined;
      if (!buf || buf.length === 0) return reply.code(404).send();
      setCachedMedia(cacheKey, buf);
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=1800");
      return reply.send(buf);
    } catch (err) {
      return reply.code(404).send();
    }
  });

  // Total de mensajes sin leer de una cuenta, para la insignia en la
  // columna de "Cuentas" del apartado Mensajes (igual que en el panel de
  // referencia). Usa la misma cache que la lista de dialogos, asi que no
  // supone una peticion extra a Telegram si ya se cargaron los mensajes.
  //
  // Ademas devuelve "relevantUnread": lo mismo pero SOLO contando fans sin
  // carpeta de Telegram, o en la carpeta de "Posibles"/"Clientes" - esto es
  // lo que usa el latido de "Horas trabajadas" (ver app.js,
  // startWorkerHeartbeat) para decidir si el chatter tiene algun fan
  // esperando respuesta de verdad. Un fan metido en "SFS" o "Time Waster"
  // (u otra carpeta que no sea esas dos) puede llevar tiempo sin
  // contestar sin que eso sea "el chatter no responde al cliente" - por
  // eso NO cuenta para totalUnread cuando se usa para esa metrica, aunque
  // la insignia de "Cuentas" siga mostrando el total real sin filtrar.
  app.get("/api/accounts/:id/unread-summary", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const [dialogs, chatFoldersMap] = await Promise.all([
        getCachedDialogs(client, id),
        getChatFoldersMap(client, id),
      ]);
      // Solo chats privados: la insignia es "mensajes sin leer de fans", no
      // el total de todo Telegram (grupos/canales incluidos) de la cuenta.
      const userDialogs = dialogs.filter((d) => d.isUser);
      const totalUnread = userDialogs.reduce((sum, d) => sum + (d.unreadCount || 0), 0);

      // Los titulos de "Posibles"/"Clientes" pueden estar renombrados por
      // esta cuenta en Configuración → "Carpetas de Telegram → Sincronizar
      // carpetas automáticamente" (ver folder-sync en accounts.ts) - se usa
      // ese mismo mapa para saber el titulo real, con el nombre de siempre
      // como valor por defecto si no esta configurado.
      let syncMap: Record<string, string> = {};
      try {
        syncMap = JSON.parse(account.folderSyncMap || "{}");
      } catch {
        syncMap = {};
      }
      const relevantFolderTitles = new Set(
        [syncMap["Posibles"] || "Posibles", syncMap["Clientes"] || "Clientes"].map((t) => t.toLowerCase())
      );
      const isRelevantChat = (chatId: string) => {
        const folders = chatFoldersMap.get(chatId) || [];
        // Sin carpeta = cuenta igual (el fan "suelto" tambien importa); con
        // carpeta(s), solo cuenta si alguna es Posibles/Clientes.
        return folders.length === 0 || folders.some((f) => relevantFolderTitles.has(f.toLowerCase()));
      };
      const relevantUnread = userDialogs
        .filter((d) => isRelevantChat(d.chatId))
        .reduce((sum, d) => sum + (d.unreadCount || 0), 0);

      return { totalUnread, relevantUnread };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo leer el resumen de mensajes." });
    }
  });

  // Mapa {chatId: lista} de todos los fans con una lista/etiqueta puesta en
  // esta cuenta, para poder filtrar la columna de Mensajes por lista sin
  // pedir la nota de cada chat una a una.
  app.get("/api/accounts/:id/fan-notes-lists", async (request) => {
    const { id } = request.params as { id: string };
    const notes = await prisma.fanNote.findMany({
      where: { accountId: id, list: { not: null } },
      select: { chatId: true, list: true },
    });
    const lists: Record<string, string> = {};
    for (const n of notes) if (n.list) lists[n.chatId] = n.list;
    return { lists };
  });

  // "Marcar como no leído": pone en negrita/con contador la conversación en
  // el propio Telegram, igual que el botón del panel de referencia.
  app.post("/api/accounts/:id/dialogs/:chatId/mark-unread", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveDialogEntity(client, id, chatId);
      const peer = await client.getInputEntity(entity);
      await client.invoke(new Api.messages.MarkDialogUnread({ peer: new Api.InputDialogPeer({ peer }), unread: true }));
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo marcar como no leído." });
    }
  });

  // "Galería" del chat: todas las fotos/vídeos (y audios, aparte) que se han
  // intercambiado con este fan, tanto enviados por la modelo como recibidos.
  // tab: "all" | "vault" (solo lo enviado desde la bóveda) | "photo" | "video" | "audio"
  app.get("/api/accounts/:id/dialogs/:chatId/gallery", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const q = request.query as { tab?: string };
    const tab = q.tab || "all";
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveDialogEntity(client, id, chatId);
      let raw: Api.Message[];
      if (tab === "audio") {
        const [voice, music] = await Promise.all([
          client.getMessages(entity, { limit: 150, filter: new Api.InputMessagesFilterVoice() }),
          client.getMessages(entity, { limit: 150, filter: new Api.InputMessagesFilterMusic() }),
        ]);
        raw = [...(voice as Api.Message[]), ...(music as Api.Message[])];
      } else {
        const filter =
          tab === "photo" ? new Api.InputMessagesFilterPhotos()
          : tab === "video" ? new Api.InputMessagesFilterVideo()
          : new Api.InputMessagesFilterPhotoVideo(); // "all" y "vault"
        raw = (await client.getMessages(entity, { limit: 200, filter })) as Api.Message[];
      }
      const sendLogs = await prisma.contentSendLog.findMany({
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
      if (tab === "vault") items = items.filter((it) => it.fromVault);
      items.sort((a, b) => b.id - a.id);
      return { items };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo cargar la galería de este chat." });
    }
  });

  app.get("/api/accounts/:id/dialogs/:chatId/gallery/:messageId/thumb", async (request, reply) => {
    const { id, chatId, messageId } = request.params as { id: string; chatId: string; messageId: string };
    const cacheKey = `gallery-thumb:${id}:${chatId}:${messageId}`;
    const cached = getCachedMedia(cacheKey);
    if (cached) {
      reply.header("Content-Type", "image/jpeg");
      reply.header("Content-Disposition", "inline");
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(cached);
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      // Antes getAccountClient() no tenia ningun timeout aqui (a diferencia
      // del resto de pasos de abajo, todos envueltos en withTimeout): si la
      // cuenta estaba reconectando con Telegram justo en ese instante (tras
      // un despliegue, una conexion "zombi", etc.), este await podia
      // quedarse colgado sin limite - la peticion HTTP del navegador se
      // quedaba "cargando" para siempre, sin llegar nunca ni a exito ni a
      // error, y la miniatura se veia en blanco sin ningun aviso (el panel
      // no tiene forma de reaccionar a algo que nunca responde).
      const client = await withTimeout(getAccountClient(account), 20_000, "conectando con Telegram");
      const entity = await withTimeout(resolveDialogEntity(client, id, chatId), 20_000, "buscando la conversación");
      const [message] = (await withTimeout(
        client.getMessages(entity, { ids: [Number(messageId)] }),
        20_000,
        "buscando el mensaje"
      )) as Api.Message[];
      if (!message || !message.media) return reply.code(404).send({ error: "No se encontró el archivo adjunto." });
      // Antes esto solo intentaba "thumb: -1" y comprobaba `if (!buf)` - dos
      // fallos a la vez que hacían que las carátulas fallaran en CASI
      // cualquier cuenta/chat, no solo en casos raros:
      //  1. GramJS a veces "tiene éxito" (no lanza excepción) pero devuelve
      //     un Buffer VACÍO (0 bytes) para "thumb: -1", sobre todo en
      //     VÍDEOS - `if (!buf)` no lo detecta (un Buffer vacío es
      //     "truthy"), así que se servía (y se guardaba en caché) una
      //     miniatura de 0 bytes: el navegador la pintaba como imagen rota,
      //     y se quedaba así hasta que la caché caducara.
      //  2. El fallback de "descargar la imagen entera" solo se probaba
      //     para fotos, nunca para vídeos - así que un vídeo sin una
      //     miniatura "de verdad" en document.thumbs se quedaba sin nada.
      // Mismo fallo (y mismo arreglo, con isUsableBuf/pickBestPhotoSize) que
      // ya se corrigió en su día para la miniatura de la bóveda de
      // contenido, ver downloadContentThumb en contentLibrary.ts - nunca se
      // había llevado también aquí, a la Galería de un chat normal.
      const attemptDownload = (opts: any) =>
        withGalleryThumbSlot(() => withTimeout(client.downloadMedia(message, opts), 25_000, "descargando la miniatura"));

      let buf: Buffer | undefined;
      let contentType = "image/jpeg";

      // 1) El tamaño de miniatura "de verdad" (objeto concreto, no el índice
      // "-1"/"0"): es el que de verdad funciona para vídeos.
      const media: any = message.media;
      const sizes: any[] = media.className === "MessageMediaPhoto" ? media.photo?.sizes || [] : media.document?.thumbs || [];
      const bestSize = pickBestPhotoSize(sizes);
      if (bestSize) {
        const attempt = (await attemptDownload({ thumb: bestSize })) as Buffer | undefined;
        if (isUsableBuf(attempt)) buf = attempt;
      }

      // 2) "thumb: -1" ("la miniatura más grande disponible" según GramJS):
      // suele bastar para fotos normales.
      if (!buf) {
        const attempt = (await attemptDownload({ thumb: -1 })) as Buffer | undefined;
        if (isUsableBuf(attempt)) buf = attempt;
      }

      // 3) Última red de seguridad SOLO para fotos: la imagen entera. Cubre
      // MessageMediaWebPage (vista previa de un enlace: la foto está un
      // nivel más adentro y "thumb" no la encuentra) y una foto mandada
      // "como archivo" sin comprimir (típico de un fan mandando desde
      // Archivos en vez de la Galería del móvil) - nunca para vídeos/audios,
      // que sí podrían pesar mucho de verdad.
      if (!buf && classifyGalleryMedia(message.media) === "photo") {
        const attempt = (await attemptDownload({})) as Buffer | undefined;
        if (isUsableBuf(attempt)) {
          buf = attempt;
          contentType = galleryMediaMimeType(message.media);
        }
      }

      if (!buf) return reply.code(404).send({ error: "Telegram no devolvió ninguna miniatura para este archivo." });
      setCachedMedia(cacheKey, buf);
      reply.header("Content-Type", contentType);
      reply.header("Content-Disposition", "inline");
      reply.header("Cache-Control", "private, max-age=3600");
      return reply.send(buf);
    } catch (err: any) {
      request.log.error(err);
      // Igual que en /dialogs: si el fallo fue por timeout, lo mas probable
      // es que la conexion de esta cuenta se haya quedado zombi - se
      // descarta ya para que la SIGUIENTE miniatura (de este chat o de
      // cualquier otro de la misma cuenta) cree una conexion nueva en vez
      // de volver a colgarse contra la misma rota.
      if (shouldInvalidateConnection(err)) invalidateAccountClient(id);
      return reply.code(502).send({ error: err?.message || "No se pudo cargar la miniatura." });
    }
  });

  app.get("/api/accounts/:id/dialogs/:chatId/gallery/:messageId/media", async (request, reply) => {
    const { id, chatId, messageId } = request.params as { id: string; chatId: string; messageId: string };
    // Antes esta ruta NUNCA se cacheaba (a diferencia de /thumb): ver la
    // misma foto/vídeo dos veces (p.ej. al reabrir el chat) volvía a
    // descargarlo entero de Telegram cada vez, con el mismo retraso la
    // segunda vez que la primera. Ahora, si ya se vio antes (y no es
    // demasiado grande, ver fullMediaCache.ts), se sirve al instante.
    const cacheKey = `gallery-media:${id}:${chatId}:${messageId}`;
    const cachedFull = getCachedFullMedia(cacheKey);
    if (cachedFull) {
      return sendBufferWithRange(request, reply, cachedFull.buf, cachedFull.contentType);
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      // Ver comentario igual en /gallery/:messageId/thumb más arriba.
      const client = await withTimeout(getAccountClient(account), 20_000, "conectando con Telegram");
      const entity = await withTimeout(resolveDialogEntity(client, id, chatId), 20_000, "buscando la conversación");
      const [message] = (await withTimeout(
        client.getMessages(entity, { ids: [Number(messageId)] }),
        20_000,
        "buscando el mensaje"
      )) as Api.Message[];
      if (!message || !message.media) return reply.code(404).send({ error: "No se encontró el archivo adjunto." });
      // Para un enlace con vista previa (MessageMediaWebPage) el documento
      // real cuelga de `media.webpage.document`, no de `media.document`
      // directamente - si no, este chequeo de tamaño nunca se aplicaba a
      // ese caso (no rompia nada, pero dejaba pasar sin comprobar el limite).
      const size =
        (message.media as any)?.document?.size ?? (message.media as any)?.webpage?.document?.size;
      const sizeBytes = size !== undefined && size !== null ? Number(size) : null;
      if (sizeBytes && sizeBytes > MAX_GALLERY_MEDIA_BYTES) {
        return reply.code(413).send({ error: "Este archivo pesa demasiado para verlo aquí (más de 60MB)." });
      }
      // Igual que arriba: sin timeout, un video grande o una cuenta con
      // FLOOD_WAIT podia dejar ocupado indefinidamente uno de los (solo 2)
      // huecos globales de withGalleryMediaSlot, bloqueando la descarga de
      // CUALQUIER otro archivo de CUALQUIER chat/cuenta mientras tanto - asi
      // se ve claro en los logs y el hueco se libera solo pasado el tiempo
      // limite en vez de quedarse atascado para siempre.
      let buf = (await withGalleryMediaSlot(() =>
        withTimeout(client.downloadMedia(message, {}), 90_000, "descargando el archivo")
      )) as Buffer | undefined;
      if (!buf) return reply.code(404).send({ error: "Telegram no devolvió ningún archivo para este mensaje." });
      const converted = await convertHeicIfNeeded(buf, galleryMediaMimeType(message.media));
      setCachedFullMedia(cacheKey, converted.buf, converted.mimeType);
      return sendBufferWithRange(request, reply, converted.buf, converted.mimeType);
    } catch (err: any) {
      request.log.error(err);
      if (shouldInvalidateConnection(err)) invalidateAccountClient(id);
      return reply.code(502).send({ error: err?.message || "No se pudo cargar el archivo." });
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
  async function addFanAsContact(client: any, fanUser: any, fanTitle: string): Promise<void> {
    try {
      await withTimeout(
        client.invoke(
          new Api.contacts.AddContact({
            id: new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash }),
            firstName: fanTitle || fanUser.firstName || "Cliente",
            lastName: "",
            phone: fanUser.phone || "",
            addPhonePrivacyException: false,
          })
        ),
        35_000,
        "añadiendo el contacto"
      );
    } catch {
      // no pasa nada: seguimos aunque no se haya podido añadir como contacto
    }
  }

  // Comprueba si el cliente esta REALMENTE dentro del grupo (no solo que el
  // grupo exista). Sin esto, un AddChatUser que Telegram rechaza en
  // silencio (p.ej. porque el cliente tiene la privacidad puesta para no
  // dejarse añadir por quien no es su contacto) dejaba un grupo "fantasma"
  // con solo la modelo dentro, que el CRM daba igualmente por creado.
  async function chatHasFan(client: any, rawChatId: any, fanUserId: any): Promise<boolean> {
    try {
      const full: any = await withTimeout(
        client.invoke(new Api.messages.GetFullChat({ chatId: rawChatId })),
        35_000,
        "comprobando el grupo"
      );
      const participants: any[] = full?.fullChat?.participants?.participants || [];
      return participants.some((p) => String(p.userId) === String(fanUserId));
    } catch {
      return false;
    }
  }

  // Ultimo recurso si, ni siquiera añadiendolo como contacto, Telegram deja
  // meter al cliente directamente en el grupo (privacidad muy estricta):
  // se genera un enlace de invitación de ese grupo para que el propio
  // cliente pueda entrar solo con tocarlo, sin que haga falta que nadie le
  // "añada" - un enlace SÍ se puede mandar aunque la privacidad de grupos
  // esté restringida, porque es el cliente quien decide entrar.
  async function exportGroupInviteLink(client: any, rawChatId: any): Promise<string | null> {
    try {
      const result: any = await withTimeout(
        client.invoke(new Api.messages.ExportChatInvite({ peer: new Api.InputPeerChat({ chatId: rawChatId }) })),
        35_000,
        "generando el enlace de invitación"
      );
      return result?.link || null;
    } catch {
      return null;
    }
  }

  // Si ni añadiéndolo como contacto ni con AddChatUser se pudo meter al
  // cliente dentro del grupo, antes nos quedábamos en "copiar el enlace al
  // portapapeles para que el chatter se lo pegue a mano" - un paso manual
  // que dependía de que el chatter se acordara de hacerlo. Ahora, en cuanto
  // hay un enlace de invitación, se lo mandamos DIRECTAMENTE por privado al
  // cliente (en su chat de siempre con esta cuenta) para que pueda unirse
  // solo con tocarlo, sin que el chatter tenga que hacer nada más. Esto es
  // best-effort: si fallara el envío (chat bloqueado, etc.) devolvemos false
  // y el aviso que se le muestra al chatter sigue incluyendo el enlace, para
  // que pueda mandarlo él mismo como respaldo.
  async function sendInviteLinkToFan(client: any, fanEntity: any, inviteLink: string): Promise<boolean> {
    try {
      await withTimeout(
        client.sendMessage(fanEntity, {
          message: `¡Hola! Para completar esto te invito a un grupo privado, solo tienes que pulsar este enlace para unirte: ${inviteLink}`,
        }),
        35_000,
        "enviando el enlace de invitación al cliente"
      );
      return true;
    } catch {
      return false;
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
  async function isGroupTooLargeForClient(client: any, groupChatId: string): Promise<boolean> {
    try {
      const entity: any = await resolveEntityById(client, groupChatId);
      if (entity?.className === "Channel") {
        const participants: any[] = await client.getParticipants(entity, { limit: MAX_CLIENT_GROUP_MEMBERS + 1 });
        return participants.length > MAX_CLIENT_GROUP_MEMBERS;
      }
      const rawChatId = groupChatId.startsWith("-") ? groupChatId.slice(1) : groupChatId;
      const full: any = await client.invoke(new Api.messages.GetFullChat({ chatId: rawChatId as any }));
      const participants: any[] = full?.fullChat?.participants?.participants || [];
      return participants.length > MAX_CLIENT_GROUP_MEMBERS;
    } catch (err: any) {
      // Si Telegram dice claramente que ese chat ya no existe (borrado, o
      // nunca llegó a confirmarse del todo pese a haberse guardado en el
      // CRM en su momento), se descarta el registro para que la próxima
      // vez se cree uno de verdad. Sin esto, un registro "fantasma" se
      // devolvía para siempre como si el grupo existiera - el botón abría
      // una pestaña en la app, pero no había ningún grupo real en Telegram.
      const msg = err?.errorMessage || err?.message || "";
      if (/CHAT_ID_INVALID|CHANNEL_INVALID|PEER_ID_INVALID|CHAT_INVALID|USER_ID_INVALID/i.test(msg)) return true;
      return false; // error transitorio (red, cuenta desconectada...): mejor no borrar nada por si acaso
    }
  }

  // La comprobacion de arriba pide datos reales a Telegram (participantes),
  // asi que la cacheamos un rato en memoria: /dialogs (la lista de
  // Mensajes) la usa para limpiar TODOS los grupos restringidos de la
  // cuenta en cada carga, y sin cache eso multiplicaria las llamadas a
  // Telegram en cada refresco de la lista sin necesidad (un grupo que hoy
  // es pequeño no se va a volver spam de un momento a otro).
  const groupSizeCheckCache = new Map<string, { tooLarge: boolean; checkedAt: number }>();
  const GROUP_SIZE_CHECK_TTL_MS = 10 * 60 * 1000;
  async function isGroupTooLargeForClientCached(client: any, groupChatId: string): Promise<boolean> {
    const cached = groupSizeCheckCache.get(groupChatId);
    if (cached && Date.now() - cached.checkedAt < GROUP_SIZE_CHECK_TTL_MS) return cached.tooLarge;
    const tooLarge = await isGroupTooLargeForClient(client, groupChatId);
    groupSizeCheckCache.set(groupChatId, { tooLarge, checkedAt: Date.now() });
    return tooLarge;
  }

  // Barrido de tamaño de los grupos restringidos EN SEGUNDO PLANO (no
  // bloquea la respuesta de /dialogs) y limitado a como mucho una vez cada
  // pocos minutos por cuenta - es solo una red de seguridad para datos
  // corruptos de antes de este arreglo, no algo que haga falta comprobar
  // en cada carga de la lista de Mensajes. Si encuentra algo, lo borra del
  // CRM y limpia la cache de dialogos para que desaparezca en la SIGUIENTE
  // carga (no en esta, que ya se ha devuelto).
  const restrictedGroupSweepAt = new Map<string, number>();
  const RESTRICTED_GROUP_SWEEP_THROTTLE_MS = 5 * 60 * 1000;
  function runRestrictedGroupSizeSweepThrottled(
    client: any,
    accountId: string,
    accountLabel: string,
    groups: { groupChatId: string; groupTitle: string | null }[]
  ): void {
    if (!groups.length) return;
    const lastRun = restrictedGroupSweepAt.get(accountId) || 0;
    if (Date.now() - lastRun < RESTRICTED_GROUP_SWEEP_THROTTLE_MS) return;
    restrictedGroupSweepAt.set(accountId, Date.now());
    (async () => {
      try {
        const badIds = new Set<string>();
        for (const g of groups) {
          if (await isGroupTooLargeForClientCached(client, g.groupChatId)) badIds.add(g.groupChatId);
        }
        if (badIds.size) {
          await prisma.clientRestrictedGroup
            .deleteMany({ where: { accountId, groupChatId: { in: Array.from(badIds) } } })
            .catch(() => {});
          markDialogsStale(accountId);
        }
      } catch {
        // barrido de segundo plano: si falla, se reintenta en el siguiente
        // ciclo (el throttle deja pasar otro intento pasados los minutos)
      }
    })();
  }

  // Si el grupo restringido guardado en el CRM para este cliente resulta
  // (comprobado de verdad contra Telegram) ser en realidad un grupo grande
  // - dato corrupto de antes de este arreglo -, lo borramos del CRM para
  // que se pueda crear/adoptar el grupo de verdad la proxima vez, en vez de
  // seguir devolviendo para siempre ese grupo ajeno como si fuera el suyo.
  async function validateRestrictedGroupRecord(client: any, existing: any, accountLabel: string): Promise<any> {
    if (!existing) return null;
    // Un grupo restringido de verdad SIEMPRE tiene un título que empieza
    // por "<modelo> y ..." - es el propio código el que lo pone así al
    // crearlo o al adoptar uno encontrado. Un registro guardado que no siga
    // ese patrón (por ejemplo un canal de marketing cualquiera, adoptado
    // por error por una version anterior de la búsqueda) nunca es de
    // verdad el grupo de este cliente, así que se descarta directamente -
    // sin ni siquiera hacer falta preguntar el tamaño a Telegram.
    if (!(existing.groupTitle || "").startsWith(`${accountLabel} y `)) {
      await prisma.clientRestrictedGroup
        .delete({ where: { accountId_chatId: { accountId: existing.accountId, chatId: existing.chatId } } })
        .catch(() => {});
      markDialogsStale(existing.accountId);
      return null;
    }
    const tooLarge = await isGroupTooLargeForClient(client, existing.groupChatId);
    if (!tooLarge) return existing;
    await prisma.clientRestrictedGroup
      .delete({ where: { accountId_chatId: { accountId: existing.accountId, chatId: existing.chatId } } })
      .catch(() => {});
    markDialogsStale(existing.accountId);
    return null;
  }

  // Antes esto recorria TODOS los grupos de la cuenta (getDialogs) uno a
  // uno preguntando a Telegram si el cliente estaba dentro - en cuentas con
  // muchos grupos (p.ej. las que tambien se usan para el Reenviador, con
  // decenas o cientos de grupos de campañas) eso tardaba tanto que el boton
  // "Ir al grupo restringido" parecia colgado, sin ningun aviso. Ahora se
  // usa GetCommonChats: Telegram devuelve DIRECTAMENTE solo los grupos que
  // la cuenta comparte con ESE cliente en concreto (normalmente ninguno o
  // muy pocos) - la misma llamada que ya usaba el boton de "grupos en
  // común". Rapido siempre, da igual cuantos grupos tenga la cuenta en
  // total, porque nunca mira los que no comparte con este cliente.
  async function findExistingRestrictedGroup(
    client: any,
    fanUser: any,
    accountLabel: string
  ): Promise<{ chatId: string; title: string } | null> {
    let chats: any[];
    try {
      const inputUser = new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
      const result: any = await client.invoke(
        new Api.messages.GetCommonChats({ userId: inputUser, maxId: 0 as any, limit: 100 })
      );
      chats = result?.chats || [];
    } catch {
      return null;
    }
    // No basta con que el grupo sea pequeño (≤3 personas): un grupo
    // cualquiera que la modelo comparta con este cliente por casualidad
    // (una rifa, un grupo de soporte, lo que sea) tambien puede tener poca
    // gente, y antes se adoptaba igualmente como si fuera "su" grupo
    // restringido - llevando al boton a un grupo que no tenia nada que ver.
    // Ahora solo se adopta un grupo si su titulo YA sigue el patron exacto
    // de este boton ("<modelo> y ..."), es decir si es casi seguro que lo
    // creo este mismo boton (o alguien lo nombro igual a mano a proposito).
    const expectedPrefix = `${accountLabel} y `;
    for (const chat of chats) {
      // Solo grupos con miembros (basicos y supergrupos), nunca canales de
      // difusion - GetCommonChats solo puede devolver de todas formas chats
      // donde ambos son miembros, asi que esto es sobre todo por si acaso.
      if (chat.broadcast) continue;
      if (!(chat.title || "").startsWith(expectedPrefix)) continue;
      const rawId = chat.id;
      if (rawId === undefined) continue;
      try {
        let participantsCount: number;
        if (chat.className === "Channel") {
          const participants: any[] = await client.getParticipants(chat, { limit: MAX_CLIENT_GROUP_MEMBERS + 1 });
          participantsCount = participants.length;
        } else {
          const full: any = await client.invoke(new Api.messages.GetFullChat({ chatId: rawId }));
          participantsCount = full?.fullChat?.participants?.participants?.length || 0;
        }
        // Si el grupo tiene mas gente que la modelo + el cliente (+1 margen),
        // NUNCA es un grupo restringido de cliente de verdad - por ejemplo un
        // grupo publico o de spam al que el cliente se unio por su cuenta y
        // en el que tambien está la modelo. No lo adoptamos como "su" grupo.
        if (participantsCount > MAX_CLIENT_GROUP_MEMBERS) continue;
        const chatId = chat.className === "Channel" ? "-100" + String(rawId) : "-" + String(rawId);
        return { chatId, title: chat.title || "" };
      } catch {
        // este grupo no se pudo leer (quiza ya no somos miembros): seguimos con el siguiente
      }
    }
    return null;
  }

  // Nombre a mostrar del cliente para el título del grupo ("<modelo> y
  // <cliente>"): se prioriza el nombre real de Telegram (nombre + apellido,
  // que es lo fiable de verdad, viene siempre del propio Telegram) sobre el
  // título que mande el frontend (que en algún caso raro puede llegar
  // vacío/undefined) y sobre el username. Solo si no hay nada de nada cae
  // en el genérico "Cliente".
  function resolveFanTitle(fanUser: any, fallbackTitle?: string): string {
    const fullName = [fanUser?.firstName, fanUser?.lastName].filter(Boolean).join(" ").trim();
    if (fullName) return fullName;
    if (fanUser?.username) return fanUser.username;
    if (fallbackTitle && fallbackTitle !== "(sin nombre)") return fallbackTitle;
    if (fanUser?.phone) return "+" + fanUser.phone;
    return "Cliente";
  }

  async function renameGroupTitle(client: any, groupChatId: string, newTitle: string): Promise<boolean> {
    try {
      const entity: any = await resolveEntityById(client, groupChatId);
      if (entity?.className === "Channel") {
        await client.invoke(new Api.channels.EditTitle({ channel: entity, title: newTitle }));
      } else {
        const rawChatId = groupChatId.startsWith("-") ? groupChatId.slice(1) : groupChatId;
        await client.invoke(new Api.messages.EditChatTitle({ chatId: rawChatId as any, title: newTitle }));
      }
      return true;
    } catch {
      return false;
    }
  }

  // Autocorrección: si el grupo guardado tiene el título genérico "<modelo>
  // y Cliente" (por ejemplo, creado por una versión anterior de este botón
  // que no encontró el nombre real del cliente), se intenta arreglar tanto
  // en el CRM como en el propio grupo de Telegram, en vez de dejarlo mal
  // para siempre. Si no se puede corregir ahora (p.ej. sin nombre real
  // tampoco esta vez), se deja el título tal cual estaba.
  async function fixPlaceholderGroupTitle(
    client: any,
    account: any,
    chatId: string,
    groupChatId: string,
    currentTitle: string,
    fanUser: any,
    fallbackTitle?: string
  ): Promise<string> {
    if (!currentTitle.endsWith(" y Cliente")) return currentTitle;
    const betterFanTitle = resolveFanTitle(fanUser, fallbackTitle);
    if (betterFanTitle === "Cliente") return currentTitle;
    const newTitle = `${account.label} y ${betterFanTitle}`;
    const renamed = await renameGroupTitle(client, groupChatId, newTitle);
    if (!renamed) return currentTitle;
    await prisma.clientRestrictedGroup
      .update({ where: { accountId_chatId: { accountId: account.id, chatId } }, data: { groupTitle: newTitle } })
      .catch(() => {});
    markDialogsStale(account.id);
    return newTitle;
  }

  // Resuelve un numero de telefono a un usuario de Telegram desde `client`,
  // SIN depender de que ya este en la cache local de la sesion (que es lo
  // unico que mira getInputEntity). Se prueban dos vias, de mas a menos
  // fiable:
  //   1) contacts.ImportContacts: es la forma "oficial" de Telegram de
  //      resolver un telefono a usuario - si el numero ya esta guardado
  //      como contacto mutuo (como aqui), Telegram lo encuentra siempre,
  //      independientemente de si esta cuenta ya habia "visto" antes a ese
  //      usuario en algun chat/dialogo.
  //   2) contacts.GetContacts: por si acaso, se busca tambien en la lista
  //      de contactos ya guardados comparando el telefono.
  // Se comparan solo digitos y por el final del numero (algunos telefonos
  // vienen con o sin "+"/prefijo del pais raro).
  function phoneDigitsMatch(a: string, b: string): boolean {
    const da = String(a || "").replace(/\D/g, "");
    const db = String(b || "").replace(/\D/g, "");
    if (!da || !db) return false;
    return da === db || da.endsWith(db) || db.endsWith(da);
  }

  async function findContactInputUserByPhone(client: any, phoneNumber: string): Promise<any> {
    const digits = String(phoneNumber || "").replace(/\D/g, "");
    if (!digits) return null;

    try {
      const imported: any = await withTimeout(
        client.invoke(
          new Api.contacts.ImportContacts({
            contacts: [
              new Api.InputPhoneContact({
                clientId: BigInt(Date.now()) as any,
                phone: phoneNumber,
                firstName: "Cuenta",
                lastName: "LUXE",
              }),
            ],
          })
        ),
        35_000,
        "buscando el contacto"
      );
      const users: any[] = imported?.users || [];
      const matched = users.find((u) => phoneDigitsMatch(u?.phone, phoneNumber)) || users[0];
      if (matched) return new Api.InputUser({ userId: matched.id, accessHash: matched.accessHash });
    } catch {
      // seguimos con el siguiente metodo
    }

    try {
      const result: any = await withTimeout(client.invoke(new Api.contacts.GetContacts({ hash: 0 as any })), 35_000, "listando contactos");
      const users: any[] = result?.users || [];
      const matched = users.find((u) => phoneDigitsMatch(u?.phone, phoneNumber));
      if (matched) return new Api.InputUser({ userId: matched.id, accessHash: matched.accessHash });
    } catch {
      // seguimos y devolvemos null: el llamador ya sabe convertir esto en
      // el aviso de "no se reconocen entre si"
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
  async function createRestrictedGroupViaHelper(
    request: any,
    account: any,
    fanUser: any,
    fanTitle: string,
    primaryClient: any
  ): Promise<{
    groupChatId: string;
    title: string;
    fanAdded: boolean;
    warning?: string;
    inviteLink?: string | null;
    linkSentToFan?: boolean;
  }> {
    const helperAccount = await prisma.account.findUnique({ where: { id: account.restrictedGroupHelperAccountId! } });
    if (!helperAccount) throw new Error("La cuenta ayudante configurada ya no existe.");
    const helperClient = await getAccountClient(helperAccount);

    let primaryInput: any;
    try {
      primaryInput = await withTimeout(helperClient.getInputEntity(account.phoneNumber), 35_000, "reconociendo la cuenta principal");
    } catch {
      // getInputEntity por telefono solo mira la cache local de la propia
      // sesion (entidades vistas en dialogos/mensajes anteriores) - NO
      // consulta la lista de contactos real de Telegram, asi que puede
      // fallar aunque las dos cuentas sean contactos mutuos de verdad si la
      // ayudante nunca ha "visto" a la principal en su sesion todavia. Antes
      // de rendirnos, buscamos de verdad en los contactos de la ayudante.
      primaryInput = await findContactInputUserByPhone(helperClient, account.phoneNumber);
    }
    if (!primaryInput) {
      throw new Error(
        `"${helperAccount.label}" (la cuenta ayudante) no reconoce a "${account.label}" en Telegram. Tienen que ser contactos entre sí (o haber hablado antes) para que la ayudante pueda crear el grupo con ella.`
      );
    }

    const title = `${account.label} y ${fanTitle}`;
    let created: any;
    try {
      created = await withTimeout(
        helperClient.invoke(new Api.messages.CreateChat({ users: [primaryInput], title })),
        35_000,
        "creando el grupo con la cuenta ayudante"
      );
    } catch (err: any) {
      const msg = err?.errorMessage || err?.message || "";
      // PEER_ID_INVALID aqui significa que el InputUser que tenemos de la
      // cuenta principal esta caducado/es invalido para ESTA sesion de la
      // ayudante - getInputEntity(telefono) solo mira su cache local y esa
      // cache puede estar desactualizada (accessHash antiguo) sin que llegue
      // a lanzar un error por si sola. En vez de rendirnos, se busca un
      // InputUser fresco de verdad en los contactos de la ayudante (la
      // misma via de respaldo de mas arriba) y se reintenta UNA vez.
      if (!/PEER_ID_INVALID|USER_ID_INVALID/i.test(msg)) throw err;
      const freshInput = await findContactInputUserByPhone(helperClient, account.phoneNumber);
      if (!freshInput) {
        throw new Error(
          `"${helperAccount.label}" (la cuenta ayudante) no reconoce a "${account.label}" en Telegram (PEER_ID_INVALID). Tienen que ser contactos entre sí (o haber hablado antes) para que la ayudante pueda crear el grupo con ella.`
        );
      }
      created = await withTimeout(
        helperClient.invoke(new Api.messages.CreateChat({ users: [freshInput], title })),
        35_000,
        "creando el grupo con la cuenta ayudante (reintento)"
      );
    }
    const updates = created?.updates || created;
    const chat = updates?.chats?.[0];
    if (!chat || chat.id === undefined) throw new Error("La cuenta ayudante no pudo crear el grupo.");
    const rawId = chat.id;
    const groupChatId = "-" + String(rawId);

    try {
      await withTimeout(
        helperClient.invoke(new Api.messages.ToggleNoForwards({ peer: new Api.InputPeerChat({ chatId: rawId }), enabled: true })),
        35_000,
        "activando restringir-guardar"
      );
    } catch (err) {
      request.log.warn(err, "No se pudo activar restringir-guardar en el grupo creado por la cuenta ayudante");
    }

    // La ayudante sale, dejando dentro solo a la cuenta principal.
    try {
      await withTimeout(
        helperClient.invoke(new Api.messages.DeleteChatUser({ chatId: rawId, userId: new Api.InputUserSelf() })),
        35_000,
        "saliendo del grupo (cuenta ayudante)"
      );
    } catch (err) {
      request.log.warn(err, "La cuenta ayudante no pudo salir del grupo restringido recién creado");
    }

    // La cuenta principal (ya dentro) invita al cliente ella misma.
    await addFanAsContact(primaryClient, fanUser, fanTitle);

    let addErr: any = null;
    try {
      const inputFan = new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
      await withTimeout(
        primaryClient.invoke(new Api.messages.AddChatUser({ chatId: rawId, userId: inputFan, fwdLimit: 100 })),
        35_000,
        "añadiendo al cliente"
      );
    } catch (err) {
      addErr = err;
      request.log.warn(err, "No se pudo añadir al cliente tras crear el grupo con la cuenta ayudante");
    }

    // Confirmamos con la cuenta PRINCIPAL (que es la que se queda dentro y
    // la que usará el grupo de verdad) que lo ve de verdad, antes de que el
    // CRM lo de por creado. Si la ayudante "crea" el grupo pero la
    // principal no llega a verlo (por ejemplo si tampoco pudo entrar), es
    // mejor avisar que guardar en el CRM un grupo fantasma.
    try {
      await withTimeout(primaryClient.invoke(new Api.messages.GetFullChat({ chatId: rawId })), 35_000, "confirmando el grupo");
    } catch {
      throw new Error(
        `"${helperAccount.label}" creó un grupo, pero "${account.label}" no lo ve en su propio Telegram. No se ha guardado nada; puede que la principal tampoco pudiera entrar.`
      );
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
      const linkSent = inviteLink ? await sendInviteLinkToFan(primaryClient, fanUser, inviteLink) : false;
      return {
        groupChatId,
        title,
        fanAdded: false,
        inviteLink,
        linkSentToFan: linkSent,
        warning:
          `Se creó el grupo, pero el cliente no quedó dentro` +
          (reason ? ` (Telegram dijo: ${reason})` : "") +
          (linkSent
            ? `. Le hemos mandado por privado el enlace de invitación - puede unirse solo con tocarlo.`
            : inviteLink
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
    const { id, chatId } = request.params as { id: string; chatId: string };
    let group = await prisma.clientRestrictedGroup.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
    if (group) {
      // Antes de decirle al boton "ya existe, ve para alla" nos aseguramos
      // de que sigue siendo un grupo de verdad de este cliente (y no un
      // grupo grande adoptado por error en el pasado) - si no se puede
      // comprobar ahora mismo (cuenta desconectada, etc.) se muestra lo que
      // haya en el CRM en vez de dar error, para no romper el boton.
      try {
        const account = await prisma.account.findUnique({ where: { id } });
        if (account) {
          const client = await getAccountClient(account);
          group = await validateRestrictedGroupRecord(client, group, account.label);
        }
      } catch {
        // sigue con lo que ya teniamos
      }
    }
    return { exists: !!group, groupChatId: group?.groupChatId ?? null, groupTitle: group?.groupTitle ?? null };
  });

  // "Usar este grupo como el restringido": cuando el chatter mira la lista
  // de "grupos en común" (ver /common-groups arriba) y reconoce a mano cuál
  // de ellos es el grupo de verdad de ese cliente (p.ej. porque el equipo
  // le ha ido poniendo notas de venta al chat del fan y ya no se llama
  // igual que el grupo, así que la detección automática por nombre no lo
  // encuentra solo), esto lo guarda en ClientRestrictedGroup para que las
  // próximas veces (el botón 👥, o tocar el nombre del fan) vayan directas
  // ahí en vez de ofrecer crear uno nuevo o volver a mostrar la lista.
  // Mismo tope de tamaño que el resto (MAX_CLIENT_GROUP_MEMBERS) para no
  // adoptar por error un grupo grande compartido por casualidad.
  app.post("/api/accounts/:id/dialogs/:chatId/restricted-group/adopt", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as { groupChatId?: string; groupTitle?: string };
    if (!body.groupChatId) return reply.code(400).send({ error: "Falta el grupo a usar." });
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const tooLarge = await isGroupTooLargeForClient(client, body.groupChatId);
      if (tooLarge) {
        return reply.code(400).send({
          error: `Este grupo tiene más de ${MAX_CLIENT_GROUP_MEMBERS} miembros, así que no puede ser el grupo restringido de un solo cliente.`,
        });
      }
      await prisma.clientRestrictedGroup.upsert({
        where: { accountId_chatId: { accountId: id, chatId } },
        create: { accountId: id, chatId, groupChatId: body.groupChatId, groupTitle: body.groupTitle || null },
        update: { groupChatId: body.groupChatId, groupTitle: body.groupTitle || null },
      });
      markDialogsStale(id);
      return { ok: true, groupChatId: body.groupChatId, groupTitle: body.groupTitle || null };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo usar ese grupo como el restringido." });
    }
  });

  // Crea el grupo restringido si no existe todavia, o devuelve el que ya hay.
  app.post("/api/accounts/:id/dialogs/:chatId/restricted-group", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as { fanTitle?: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      let existing = await prisma.clientRestrictedGroup.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
      // Misma autolimpieza que en GET: si lo guardado resulta ser un grupo
      // grande (dato corrupto de antes de este arreglo), se descarta aqui
      // en vez de devolverlo como si fuera valido, para que el codigo de
      // abajo pueda crear/adoptar el grupo de verdad de este cliente.
      existing = await validateRestrictedGroupRecord(client, existing, account.label);
      if (existing) {
        let groupTitle = existing.groupTitle || "";
        // Se pide el perfil del cliente siempre (no solo para el
        // autocorregir el título de abajo): hace falta también para la
        // comprobación de membresía justo debajo.
        const fanEntity = await resolveDialogEntity(client, id, chatId).catch(() => null);
        const fanUser = fanEntity as any;
        if (groupTitle.endsWith(" y Cliente")) {
          // Autocorrección de un grupo creado antes con el nombre generico.
          groupTitle = await fixPlaceholderGroupTitle(client, account, chatId, existing.groupChatId, groupTitle, fanUser, body.fanTitle);
        }
        // Un grupo ya guardado como "creado" en una visita anterior puede
        // seguir sin el cliente de verdad dentro (falló entonces, o salió
        // del grupo después) - antes este camino de "el grupo ya existe" no
        // comprobaba nada de esto y simplemente lo abría como si todo
        // estuviera bien, sin avisar: se veía como si el botón "no hiciera
        // nada", sin ningún error, aunque el cliente no estuviera dentro.
        let fanAdded: boolean | undefined;
        let warning: string | undefined;
        let inviteLink: string | null = null;
        if (fanUser?.id !== undefined) {
          const rawChatId = existing.groupChatId.startsWith("-") ? existing.groupChatId.slice(1) : existing.groupChatId;
          fanAdded = await chatHasFan(client, rawChatId, fanUser.id);
          if (!fanAdded) {
            const inputFan = new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
            await addFanAsContact(client, fanUser, resolveFanTitle(fanUser, body.fanTitle));
            try {
              await client.invoke(new Api.messages.AddChatUser({ chatId: rawChatId as any, userId: inputFan, fwdLimit: 0 }));
              fanAdded = await chatHasFan(client, rawChatId, fanUser.id);
            } catch (err) {
              request.log.warn(err, "No se pudo añadir al cliente a su grupo restringido ya existente");
            }
            if (!fanAdded) {
              inviteLink = await exportGroupInviteLink(client, rawChatId);
              const linkSent = inviteLink ? await sendInviteLinkToFan(client, fanUser, inviteLink) : false;
              warning =
                "El grupo ya existía, pero el cliente no está dentro." +
                (linkSent
                  ? " Le hemos mandado por privado el enlace de invitación - puede unirse solo con tocarlo."
                  : inviteLink
                    ? " Te copiamos un enlace de invitación al grupo - mándaselo por privado para que entre él mismo."
                    : " Suele pasar cuando el cliente tiene su privacidad puesta para que solo sus contactos le añadan a grupos - prueba a reintentarlo con 🔁, o pídele que te añada como contacto primero.");
            }
          }
        }
        return { ok: true, groupChatId: existing.groupChatId, groupTitle, created: false, fanAdded, warning, inviteLink };
      }
      const fanEntity = await resolveDialogEntity(client, id, chatId);
      const fanUser = fanEntity as any;

      // Antes de crear uno nuevo: puede que el grupo YA exista en Telegram
      // (creado a mano, o antes de tener este botón) y el CRM simplemente no
      // lo supiera todavía. Si lo encontramos, lo adoptamos en vez de crear
      // un duplicado.
      const found = await findExistingRestrictedGroup(client, fanUser, account.label);
      if (found) {
        await prisma.clientRestrictedGroup.create({
          data: { accountId: id, chatId, groupChatId: found.chatId, groupTitle: found.title },
        });
        // No usamos clearDialogsCache (vacia la cache del todo y obliga a la
        // SIGUIENTE carga a esperar la lista entera de Telegram, lento en
        // cuentas con muchos chats): con markDialogsStale la lista actual se
        // sigue devolviendo al instante y esta se refresca sola de fondo.
        markDialogsStale(id);
        const groupTitle = await fixPlaceholderGroupTitle(client, account, chatId, found.chatId, found.title, fanUser, body.fanTitle);
        return { ok: true, groupChatId: found.chatId, groupTitle, created: false };
      }

      const inputFan = new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
      const fanTitle = resolveFanTitle(fanUser, body.fanTitle);
      const title = `${account.label} y ${fanTitle}`;

      await addFanAsContact(client, fanUser, fanTitle);

      let created: any;
      try {
        created = await withTimeout(
          client.invoke(new Api.messages.CreateChat({ users: [inputFan], title })),
          35_000,
          "creando el grupo"
        );
      } catch (err: any) {
        const msg = err?.errorMessage || err?.message || "";
        if (/USER_RESTRICTED/.test(msg) && !account.restrictedGroupHelperAccountId) {
          // Telegram esta bloqueando a ESTA cuenta para crear grupos nuevos
          // directamente (le pasa sobre todo a cuentas muy activas, como
          // las que tambien se usan para el Reenviador). El propio codigo
          // ya sabe resolverlo con una "cuenta ayudante" que crea el grupo
          // en su lugar, pero hace falta configurarla primero - sin eso no
          // hay forma de crear el grupo desde aqui, asi que se avisa claro
          // en vez de dejar pasar el codigo de error en crudo de Telegram.
          return reply.code(502).send({
            error:
              `Telegram no deja crear grupos nuevos directamente desde "${account.label}" ahora mismo (USER_RESTRICTED - suele pasar en cuentas muy activas). ` +
              `Hace falta configurar una "cuenta ayudante" para esta cuenta en Configuración → Grupos restringidos, y que esa cuenta ayudante ya se conozca en Telegram con "${account.label}" (sean contactos o hayan hablado antes). Con eso puesto, el botón lo resuelve solo.`,
          });
        }
        if (/USER_RESTRICTED/.test(msg) && account.restrictedGroupHelperAccountId) {
          const viaHelper = await createRestrictedGroupViaHelper(request, account, fanUser, fanTitle, client);
          await prisma.clientRestrictedGroup.create({
            data: { accountId: id, chatId, groupChatId: viaHelper.groupChatId, groupTitle: viaHelper.title },
          });
          markDialogsStale(id);
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
        await withTimeout(client.invoke(new Api.messages.GetFullChat({ chatId: rawId })), 35_000, "confirmando el grupo");
      } catch (err: any) {
        request.log.error(err, "El grupo restringido recien creado no se pudo confirmar en Telegram");
        return reply.code(502).send({
          error:
            "Telegram dijo que había creado el grupo, pero no se pudo confirmar que existe de verdad. No se ha guardado nada; vuelve a intentarlo.",
        });
      }

      // "Restringir guardar contenido": el cliente no puede reenviar/guardar
      // lo que se mande en este grupo.
      try {
        await withTimeout(
          client.invoke(new Api.messages.ToggleNoForwards({ peer: new Api.InputPeerChat({ chatId: rawId }), enabled: true })),
          35_000,
          "activando restringir-guardar"
        );
      } catch (err) {
        request.log.warn(err, "No se pudo activar restringir-guardar en el grupo recien creado");
      }

      // Comprobación real: aunque Telegram haya "aceptado" crear el grupo
      // con el cliente incluido, a veces lo acepta sin llegar a meterlo de
      // verdad (privacidad del cliente). Sin esto se guardaba el grupo como
      // "creado" y el cliente nunca llegaba a estar dentro.
      let fanAdded = await chatHasFan(client, rawId, fanUser.id);
      let warning: string | undefined;
      let inviteLink: string | null = null;
      if (!fanAdded) {
        try {
          await withTimeout(
            client.invoke(new Api.messages.AddChatUser({ chatId: rawId, userId: inputFan, fwdLimit: 0 })),
            35_000,
            "añadiendo al cliente"
          );
          fanAdded = await chatHasFan(client, rawId, fanUser.id);
        } catch (err: any) {
          request.log.warn(err, "No se pudo añadir al cliente al grupo recien creado");
        }
        if (!fanAdded) {
          inviteLink = await exportGroupInviteLink(client, rawId);
          const linkSent = inviteLink ? await sendInviteLinkToFan(client, fanUser, inviteLink) : false;
          warning =
            "Se creó el grupo, pero el cliente no quedó dentro." +
            (linkSent
              ? " Le hemos mandado por privado el enlace de invitación - puede unirse solo con tocarlo."
              : inviteLink
                ? " Te copiamos un enlace de invitación al grupo - mándaselo por privado para que entre él mismo."
                : " Suele pasar cuando el cliente tiene su privacidad puesta para que solo sus contactos le añadan a grupos - prueba a reintentarlo con 🔁, o pídele que te añada como contacto primero.");
        }
      }

      await prisma.clientRestrictedGroup.create({
        data: { accountId: id, chatId, groupChatId, groupTitle: title },
      });
      markDialogsStale(id);
      return { ok: true, groupChatId, groupTitle: title, created: true, fanAdded, warning, inviteLink };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo crear el grupo restringido." });
    }
  });

  // "Reintentar añadir al cliente a su grupo restringido": por si salió del
  // grupo o falló al crearlo la primera vez.
  app.post("/api/accounts/:id/dialogs/:chatId/restricted-group/retry-add", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    let group = await prisma.clientRestrictedGroup.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
    if (!group) return reply.code(404).send({ error: "Este cliente todavía no tiene grupo restringido creado." });
    try {
      const client = await getAccountClient(account);
      // Igual que en GET/POST: si lo guardado resulta ser un grupo grande
      // (dato corrupto de antes de este arreglo), no reintentamos añadir al
      // cliente ahi - se borra y se pide crear el grupo de verdad.
      group = await validateRestrictedGroupRecord(client, group, account.label);
      if (!group) {
        return reply.code(404).send({
          error: "El grupo guardado para este cliente no era válido y se ha descartado. Pulsa de nuevo el botón para crear el grupo restringido de verdad.",
        });
      }
      const fanEntity = await resolveDialogEntity(client, id, chatId);
      const fanUser = fanEntity as any;
      const inputFan = new Api.InputUser({ userId: fanUser.id, accessHash: fanUser.accessHash });
      const rawChatId = group.groupChatId.startsWith("-") ? group.groupChatId.slice(1) : group.groupChatId;
      await addFanAsContact(client, fanUser, fanUser.firstName || "Cliente");
      try {
        await client.invoke(new Api.messages.AddChatUser({ chatId: rawChatId as any, userId: inputFan, fwdLimit: 0 }));
      } catch (err) {
        request.log.warn(err, "Reintento de añadir al cliente al grupo restringido: Telegram lo rechazó");
      }
      const fanAdded = await chatHasFan(client, rawChatId, fanUser.id);
      if (!fanAdded) {
        const inviteLink = await exportGroupInviteLink(client, rawChatId);
        const linkSent = inviteLink ? await sendInviteLinkToFan(client, fanUser, inviteLink) : false;
        return reply.code(502).send({
          error: linkSent
            ? "El cliente sigue sin poder entrar directamente, pero le hemos mandado por privado el enlace de invitación - puede unirse solo con tocarlo."
            : inviteLink
              ? "El cliente sigue sin poder entrar directamente. Te copiamos un enlace de invitación - mándaselo por privado para que entre él mismo."
              : "Telegram aceptó la petición, pero el cliente sigue sin aparecer dentro del grupo. Puede que su privacidad no deje que le añadan sin haber hablado antes por privado.",
          inviteLink,
          linkSentToFan: linkSent,
        });
      }
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo volver a añadir al cliente al grupo." });
    }
  });

  // "Restringir guardar contenido" en el CHAT PRIVADO del cliente (no en un
  // grupo aparte): alternativa a mano cuando el botón de "grupo restringido"
  // (👥/🔁) falla en meter al cliente dentro del grupo. En vez de depender de
  // que el cliente entre a un grupo nuevo, activa la MISMA protección de
  // Telegram (no puede reenviar/guardar lo que se le mande) directamente
  // sobre la conversación de siempre. El botón solo aparece en el panel
  // cuando ese fallo ya ocurrió (ver noForwardsBtn en app.js).
  app.post("/api/accounts/:id/dialogs/:chatId/no-forwards", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const fanEntity = await resolveDialogEntity(client, id, chatId);
      const fanUser = fanEntity as any;
      if (fanUser?.id === undefined) {
        return reply.code(400).send({ error: "Esto solo se puede activar en un chat privado con un cliente." });
      }
      // OJO: construir el InputPeerUser a mano con fanUser.id/accessHash daba
      // PEER_ID_INVALID - el access_hash de la entidad que devuelve
      // resolveDialogEntity no siempre es el que Telegram espera para ESTA
      // sesión/contexto. client.getInputEntity(chatId) usa la propia caché
      // interna de GramJS (la misma vía que ya funciona en folders.ts), así
      // que es más fiable que montar el InputPeer nosotros mismos.
      const peer = await client.getInputEntity(chatId);
      await withTimeout(
        client.invoke(new Api.messages.ToggleNoForwards({ peer, enabled: true })),
        35_000,
        "activando restringir-guardar en el chat"
      );
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo activar la protección de contenido en este chat." });
    }
  });

  // Programa un mensaje para mandarlo mas tarde (envio nativo programado de
  // Telegram: lo entrega Telegram en el momento exacto, sin depender de que
  // el CRM este despierto en ese instante).
  app.post("/api/accounts/:id/dialogs/:chatId/schedule", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as { text?: string; sendAt?: string };
    if (!body.text || !body.text.trim()) return reply.code(400).send({ error: "Falta el texto del mensaje" });
    if (!body.sendAt) return reply.code(400).send({ error: "Falta la fecha/hora de envío" });
    const sendAt = new Date(body.sendAt);
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
      return reply.code(400).send({ error: "La fecha tiene que ser en el futuro" });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveDialogEntity(client, id, chatId);
      await client.sendMessage(entity, { message: body.text.trim(), schedule: Math.floor(sendAt.getTime() / 1000) });
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo programar el mensaje." });
    }
  });

  // "Notas de la modelo": info general de la cuenta.
  app.get("/api/accounts/:id/note", async (request) => {
    const { id } = request.params as { id: string };
    const note = await prisma.accountNote.findUnique({ where: { accountId: id } });
    return { note: note?.info ?? "" };
  });

  app.put("/api/accounts/:id/note", async (request) => {
    const { id } = request.params as { id: string };
    const { note } = request.body as { note?: string };
    await prisma.accountNote.upsert({
      where: { accountId: id },
      update: { info: note ?? "" },
      create: { accountId: id, info: note ?? "" },
    });
    return { ok: true };
  });

  // "Notas del fan": una nota por conversacion, con lista/etiqueta.
  app.get("/api/accounts/:id/dialogs/:chatId/note", async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const note = await prisma.fanNote.findUnique({ where: { accountId_chatId: { accountId: id, chatId } } });
    return { note: note?.note ?? "", list: note?.list ?? null };
  });

  // "Vendido a este fan": historial de ventas de un chat concreto.
  app.get("/api/accounts/:id/dialogs/:chatId/sales", async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const sales = await prisma.fanSale.findMany({ where: { accountId: id, chatId }, orderBy: { date: "desc" } });
    const total = sales.reduce((sum, s) => sum + s.amount, 0);
    return { sales, total };
  });

  app.post("/api/accounts/:id/dialogs/:chatId/sales", async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as {
      amount?: number; date?: string; service?: string; paymentMethod?: string;
      soldBy?: string; detail?: string; paymentRef?: string; chatTitle?: string;
    };
    if (!body.amount || body.amount <= 0) {
      return reply.code(400).send({ error: "Falta el importe de la venta" });
    }
    // Aseguramos que exista la nota del fan (aunque este vacia), para que aparezca en listados.
    await prisma.fanNote.upsert({
      where: { accountId_chatId: { accountId: id, chatId } },
      update: body.chatTitle ? { chatTitle: body.chatTitle } : {},
      create: { accountId: id, chatId, chatTitle: body.chatTitle },
    });
    // "Vendido por": para cualquier trabajador (Chatter o Team líder) va
    // SIEMPRE fijo a su propio nombre - ni el desplegable del frontend le
    // deja tocarlo (ver createSoldBySelector en app.js), ni aunque alguien
    // manipulase la petición a mano se le hace caso a un soldBy distinto
    // aquí. Solo el dueño/jefe (sin cookie de trabajador) puede registrar
    // una venta a nombre de otra persona del equipo.
    const worker = (request as any).worker as { name: string; role: string } | null;
    let soldBy: string;
    if (worker) {
      soldBy = worker.name;
    } else {
      // Si no se rellenó "Vendido por" a mano, se atribuye a quien esté
      // registrando la venta ahora mismo (mismo criterio que ya usa el
      // registro de mensajes, ver chatterNameFromRequest más arriba) en vez
      // de dejarla sin nadie asignado - antes, cualquier venta registrada
      // sin tocar ese campo quedaba con soldBy=null y aparecía como "(sin
      // asignar)" en Informes y no se sumaba a la nómina de nadie, incluso
      // estando el dueño (o un trabajador) con la sesión bien identificada.
      soldBy = (body.soldBy || "").trim() || chatterNameFromRequest(request);
    }
    const sale = await prisma.fanSale.create({
      data: {
        accountId: id,
        chatId,
        amount: body.amount,
        date: body.date ? new Date(body.date) : new Date(),
        service: body.service || null,
        paymentMethod: body.paymentMethod || null,
        soldBy,
        detail: body.detail || null,
        paymentRef: body.paymentRef || null,
      },
    });

    // Aviso a "Grupos de seguimiento de las modelos" (Conectar WhatsApp):
    // best-effort, nunca debe hacer fallar el registro de la venta.
    prisma.account.findUnique({ where: { id } }).then((account) => {
      if (account) notifySaleToGroups(account, sale).catch(() => {});
    }).catch(() => {});

    return { sale };
  });

  // Antes esta ruta era "/api/sales/:id" (el :id era el de la VENTA). El
  // "guardia" de permisos (requireSectionAccess, ver utils/auth.ts) siempre
  // lee ":id" de la ruta como si fuese el id de la CUENTA para comprobar el
  // permiso del trabajador - con el id de la venta ahi, esa comprobacion
  // nunca podia coincidir con ningun WorkerPermission real, así que
  // cualquier trabajador (no-admin) con permiso de sobra para esa cuenta
  // recibía 403 al intentar borrar una venta, sin poder hacerlo nunca. Con
  // el id de cuenta en la ruta (como el resto de endpoints de ventas) el
  // guardia ya compara lo correcto, y de paso se verifica aquí que la venta
  // sea de verdad de esa cuenta antes de borrarla.
  app.delete("/api/accounts/:id/sales/:saleId", async (request, reply) => {
    const { id, saleId } = request.params as { id: string; saleId: string };
    const sale = await prisma.fanSale.findUnique({ where: { id: saleId } });
    if (!sale || sale.accountId !== id) {
      return reply.code(404).send({ error: "Venta no encontrada" });
    }
    await prisma.fanSale.delete({ where: { id: saleId } });
    return { ok: true };
  });

  // "Scripts": mensajes guardados para insertar rapido en la conversacion.
  // "entities": emoji premium copiados de un mensaje de la bóveda (ver
  // /content-group/topics/:topicId/text-items), guardados en su propia
  // columna (entitiesJson) para no mezclar el JSON con el texto plano.
  app.get("/api/accounts/:id/scripts", async (request) => {
    const { id } = request.params as { id: string };
    const scripts = await prisma.script.findMany({ where: { accountId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
    return { scripts: scripts.map((s) => ({ ...s, entities: parseScriptEntities(s.entitiesJson) })) };
  });

  app.post("/api/accounts/:id/scripts", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title: string; content: string; entities?: unknown };
    const script = await prisma.script.create({
      data: { accountId: id, title: body.title, content: body.content, entitiesJson: sanitizeScriptEntitiesJson(body.entities) },
    });
    return { script: { ...script, entities: parseScriptEntities(script.entitiesJson) } };
  });

  app.patch("/api/scripts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<{ title: string; content: string; position: number; entities: unknown }>;
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.content !== undefined) data.content = body.content;
    if (body.position !== undefined) data.position = body.position;
    // Solo se toca entitiesJson si el body trae explicitamente "entities"
    // (aunque sea [] para quitarlos) - si no, se conserva lo que ya tenia.
    if (body.entities !== undefined) data.entitiesJson = sanitizeScriptEntitiesJson(body.entities);
    const script = await prisma.script.update({ where: { id }, data });
    return { script: { ...script, entities: parseScriptEntities(script.entitiesJson) } };
  });

  app.delete("/api/scripts/:id", async (request) => {
    const { id } = request.params as { id: string };
    await prisma.script.delete({ where: { id } });
    return { ok: true };
  });

  app.put("/api/accounts/:id/dialogs/:chatId/note", async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const body = request.body as { note?: string; list?: string | null; chatTitle?: string };
    await prisma.fanNote.upsert({
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

  // Insignias de "sin leer" por cuenta en Mensajes Pro: UNA sola petición
  // para todas las cuentas a la vez (mismo criterio de permiso que
  // /api/accounts/live-stream), en vez de una petición por cuenta como
  // antes. Con varias creadoras, cada mensaje que llegaba disparaba un
  // unread-summary por cuenta A LA VEZ desde refreshProTabUnreadBadges -
  // sumado a las dos conexiones SSE que ya están siempre abiertas en
  // Mensajes Pro (live-stream + la de la pestaña activa), eso llegaba a
  // agotar el límite de conexiones simultáneas por origen del navegador
  // (6 en Chrome con HTTP/1.1) y el panel se quedaba "colgado" - dejaba de
  // cargar justo al entrar a una conversación, porque ya no quedaba hueco
  // para esa petición. Con una sola petición aquí, ese pico desaparece.
  app.get("/api/accounts/unread-summary-bulk", async (request, reply) => {
    const worker = await getWorkerFromRequest(request);
    let accountRows: { id: string; label: string }[];
    if (worker) {
      const isPro = (request.raw.url || "").startsWith("/pro/");
      const perms = await prisma.workerPermission.findMany({
        where: { workerId: worker.id, section: isPro ? "mensajes-pro" : "mensajes" },
        include: { account: { select: { id: true, label: true } } },
      });
      accountRows = perms.map((p) => p.account);
    } else {
      accountRows = await prisma.account.findMany({ select: { id: true, label: true } });
    }

    const results = await Promise.all(
      accountRows.map(async ({ id }) => {
        try {
          const account = await prisma.account.findUnique({ where: { id } });
          if (!account) return { id, totalUnread: 0 };
          const client = await getAccountClient(account);
          const dialogs = await getCachedDialogs(client, id);
          const totalUnread = dialogs
            .filter((d) => d.isUser)
            .reduce((sum, d) => sum + (d.unreadCount || 0), 0);
          return { id, totalUnread };
        } catch (err) {
          request.log.error(err);
          return { id, totalUnread: 0 };
        }
      })
    );
    const byAccount: Record<string, number> = {};
    for (const r of results) byAccount[r.id] = r.totalUnread;
    return { byAccount };
  });

  // Notificaciones de escritorio con varias creadoras a la vez (pedido de
  // Aitor: un chatter con acceso a 2, 4, 5 o 6 modelos en Mensajes Pro debe
  // recibir el aviso de mensaje nuevo como en Telegram Desktop, aunque la
  // creadora que acaba de recibirlo no sea la pestaña que tiene delante
  // ahora mismo). UNA sola conexión SSE multiplexa los eventos de TODAS las
  // cuentas a las que quien pregunta tiene acceso, en vez de abrir una
  // conexión por cuenta - eso sí agotaría pronto el límite de conexiones
  // por origen del navegador con varias creadoras (ver el comentario del
  // mismo problema, para "Abrir en ventana nueva", en el stream de una sola
  // cuenta justo debajo). El permiso (qué cuentas puede ver) es EL MISMO
  // criterio que /api/mensajes-pro/accounts: por WorkerPermission si hay
  // trabajador (según se pida por /api o por /pro/api), todas si es el
  // dueño/admin.
  app.get("/api/accounts/live-stream", async (request, reply) => {
    const worker = await getWorkerFromRequest(request);
    let accountRows: { id: string; label: string }[];
    if (worker) {
      const isPro = (request.raw.url || "").startsWith("/pro/");
      const perms = await prisma.workerPermission.findMany({
        where: { workerId: worker.id, section: isPro ? "mensajes-pro" : "mensajes" },
        include: { account: { select: { id: true, label: true } } },
      });
      accountRows = perms.map((p) => p.account);
    } else {
      accountRows = await prisma.account.findMany({ select: { id: true, label: true } });
    }
    if (accountRows.length === 0) {
      reply.code(200).send({ error: "Sin cuentas accesibles." });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 2000\n\n");

    const unsubscribes = accountRows.map(({ id: accountId, label: accountLabel }) =>
      subscribeToAccountEvents(accountId, (evt) => {
        try {
          // El título del chat se manda ya resuelto desde aquí (cache de
          // dialogos del backend) para que el frontend no tenga que
          // adivinarlo - en Mensajes Pro puede llegar un evento de una
          // creadora que ni siquiera tiene pestaña abierta todavía.
          const chatTitle = evt.type === "message" ? getCachedDialogTitle(accountId, evt.chatId) : undefined;
          const notify = evt.type === "message" ? shouldNotifyChat(accountId, evt.chatId) : undefined;
          reply.raw.write(`data: ${JSON.stringify({ ...evt, accountId, accountLabel, chatTitle, notify })}\n\n`);
        } catch {
          // conexion cerrada: el "close" de abajo limpia todo
        }
      })
    );

    const keepAlive = setInterval(() => {
      try { reply.raw.write(": ping\n\n"); } catch { /* conexion cerrada */ }
    }, 20000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      for (const unsub of unsubscribes) unsub();
    });

    // Fire-and-forget, en paralelo: asegura que cada cuenta tiene su
    // cliente (y su listener en vivo) conectado, SIN bloquear el ping ni la
    // suscripcion de arriba - ver comentario grande en /api/accounts/:id/stream.
    // Con varias cuentas a la vez (Mensajes Pro), bastaba con que UNA sola
    // tardara en conectar para retrasar el primer ping de TODAS.
    for (const { id: accountId } of accountRows) {
      prisma.account.findUnique({ where: { id: accountId } })
        .then((account) => account && getAccountClient(account))
        .catch((err) => request.log.error(err));
    }
  });

  // Stream en tiempo real (Server-Sent Events) de mensajes nuevos de esta
  // cuenta: cuando llega o se envia un mensaje de Telegram, se empuja aqui
  // al instante, para que el panel no dependa de refrescar a mano.
  app.get("/api/accounts/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 2000\n\n");

    // IMPORTANTE: la suscripcion a eventos y el primer "ping" se montan YA,
    // antes de esperar a Telegram - antes se esperaba aqui a
    // getAccountClient() (hasta 40s si la cuenta tardaba en conectar) antes
    // de mandar nada mas al navegador, así que si ese connect tardaba, la
    // conexion SSE podia quedarse sin mandar ni un byte el tiempo
    // suficiente para que el proxy la diera por muerta (o para que
    // pareciera "conectada" en el frontend sin estarlo de verdad), y
    // cualquier mensaje que llegara justo en ese hueco se perdia porque
    // todavia no habia nadie suscrito para recibirlo. Ahora la suscripcion
    // y el ping arrancan al instante, y getAccountClient se deja conectando
    // en segundo plano (fire-and-forget) - en cuanto termine, attachLiveEvents
    // empieza a emitir a esta MISMA suscripcion sin que haga falta reabrir
    // la conexion SSE.
    const unsubscribe = subscribeToAccountEvents(id, (evt) => {
      reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
    });
    const keepAlive = setInterval(() => {
      try { reply.raw.write(": ping\n\n"); } catch { /* conexion cerrada */ }
    }, 20000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });

    getAccountClient(account).catch((err) => request.log.error(err));
  });
}
