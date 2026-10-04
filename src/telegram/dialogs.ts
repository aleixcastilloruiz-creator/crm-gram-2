import { TelegramClient, Api } from "telegram";

/**
 * Apartado "Mensajes": conversaciones privadas (DMs) de una cuenta con sus
 * fans, leidas en vivo desde Telegram (no se guardan en la base de datos,
 * salvo las notas). Como las peticiones HTTP son independientes entre si,
 * mantenemos aqui una cache en memoria de "chatId -> entidad de Telegram"
 * por cuenta, para poder resolver el chat exacto (con su access_hash) en
 * /messages y /send sin tener que listar dialogos cada vez.
 */
type DialogEntity = Api.TypeUser | Api.TypeChat;
const entityCache = new Map<string, Map<string, DialogEntity>>();

function cacheFor(accountId: string): Map<string, DialogEntity> {
  let m = entityCache.get(accountId);
  if (!m) {
    m = new Map();
    entityCache.set(accountId, m);
  }
  return m;
}

/** Diagnóstico del último listDialogs() de cada cuenta: cuántos dialogos
 * devolvió Telegram DE VERDAD (antes de cualquier filtro propio del panel)
 * y en qué se quedaron por el camino. El "rawCount" que ya se mandaba al
 * frontend (ver messages.ts) en realidad medía el resultado DESPUÉS del
 * filtro de listDialogs, no lo que Telegram mandó - por eso no distinguía
 * "Telegram solo dio 8 chats" de "Telegram dio 50 pero el panel descartó
 * 42 por ser grupos grandes/sin entidad". Esto sí lo distingue. */
export interface ExcludedDialogInfo {
  title: string;
  kind: "group" | "channel";
  participantsCount: number | null;
}
export interface LastDialogsStats {
  telegramTotal: number; // dialogs.length tal cual lo devolvió client.getDialogs()
  kept: number; // cuantos pasaron el filtro (lo que ve el usuario, antes de los filtros de messages.ts)
  excludedBigGroup: number; // grupo/canal grande, ni registrado ni en una carpeta marcada
  excludedNoEntity: number; // Telegram no mandó la entidad completa para ese dialogo (caso raro)
  excludedList: ExcludedDialogInfo[]; // detalle de los descartados por excludedBigGroup, para poder revisarlos a mano
}
const lastStats = new Map<string, LastDialogsStats>();
export function getLastDialogStats(accountId: string): LastDialogsStats | undefined {
  return lastStats.get(accountId);
}

export interface DialogSummary {
  chatId: string;
  title: string;
  isUser: boolean;
  isGroup: boolean; // no es un chat privado (grupo, supergrupo o canal)
  kind: "user" | "group" | "channel";
  unreadCount: number;
  lastMessage: string;
  lastMessageDate: string | null;
  lastMessageOut: boolean;
  participantsCount: number | null; // solo grupos/canales; null si Telegram no lo dio en el listado
  username: string | null; // @usuario de Telegram (solo chats privados; null si el fan no tiene uno puesto)
}

/** El @usuario de un User de Telegram. Desde que Telegram permite varios
 * usernames por cuenta, el campo viejo "username" (uno solo) puede venir
 * vacio aunque el fan SI tenga uno puesto - hay que mirar tambien la lista
 * "usernames" y quedarse con el que este activo (o el primero si ninguno
 * viene marcado, mejor mostrar algo que nada). */
export function usernameOf(entity: DialogEntity | undefined): string | null {
  if (!entity) return null;
  const direct = (entity as any).username;
  if (direct) return direct;
  const list = (entity as any).usernames as { username: string; active?: boolean }[] | undefined;
  if (list && list.length > 0) {
    return (list.find((u) => u.active !== false) || list[0]).username || null;
  }
  return null;
}

function previewOf(message: Api.Message | undefined): string {
  if (!message) return "";
  if (message.message) return message.message.slice(0, 120);
  if (message.media) return "[archivo adjunto]";
  return "";
}

function dialogKind(dialog: any): "user" | "group" | "channel" {
  if (dialog.isUser) return "user";
  if (dialog.isChannel && !dialog.isGroup) return "channel"; // canal de difusion (sin miembros que escriban)
  return "group"; // grupo basico o supergrupo
}

/** Lista las conversaciones privadas (con fans) mas recientes, mas los
 * grupos/canales cuyo chatId este en extraChatIds: los grupos restringidos
 * de cada cliente (se añaden solos, ver messages.ts) y las carpetas marcadas
 * a mano en Configuración → "Mostrar también en Mensajes". "Mensajes" es el
 * chat con fans, NO todos los grupos/canales de la cuenta de Telegram. */
export async function listDialogs(
  client: TelegramClient,
  accountId: string,
  limit = 100,
  extraChatIds?: Set<string>,
  includeAllGroups = false
): Promise<DialogSummary[]> {
  const dialogs = await client.getDialogs({ limit });
  const cache = cacheFor(accountId);
  const out: DialogSummary[] = [];
  let excludedBigGroup = 0;
  let excludedNoEntity = 0;
  const excludedList: ExcludedDialogInfo[] = [];

  for (const dialog of dialogs) {
    const chatId = dialog.id!.toString();
    const entity = dialog.entity as DialogEntity | undefined;
    const participantsCount =
      typeof (entity as any)?.participantsCount === "number" ? (entity as any).participantsCount : null;
    const kind = dialogKind(dialog);
    // Cualquier grupo con MENOS de 3 miembros (la modelo + como mucho un
    // par de personas mas) se muestra solo, sin hacer falta registrarlo
    // como "grupo restringido de cliente" ni meterlo a mano en una carpeta
    // de Configuración - es lo bastante pequeño para ser, casi seguro, una
    // conversacion de cliente. Los canales de difusion (sin miembros que
    // escriban, solo "kind: channel") quedan fuera de este automatismo:
    // un canal pequeño no es una conversacion.
    const isSmallGroup = !dialog.isUser && kind !== "channel" && participantsCount !== null && participantsCount < 3;
    const isExtra = !dialog.isUser && !!extraChatIds?.has(chatId);
    // "SFS" (includeAllGroups=true) quiere ver TODOS los grupos/canales de
    // la cuenta, grandes incluidos (ahi es donde se hacen los SFS de
    // verdad), no solo los chats de fans de "Mensajes" - por eso aqui se
    // salta la restriccion de tamaño/registro que sí aplica el resto del
    // panel.
    if (!includeAllGroups && !dialog.isUser && !isExtra && !isSmallGroup) {
      excludedBigGroup++;
      if (excludedList.length < 100) {
        excludedList.push({ title: dialog.title || "(sin nombre)", kind: kind === "channel" ? "channel" : "group", participantsCount });
      }
      continue; // solo chats privados con fans + grupos permitidos explicitamente + grupos pequeños
    }
    if (!entity) {
      excludedNoEntity++;
      continue;
    }
    cache.set(chatId, entity);

    const msg = dialog.message as Api.Message | undefined;
    out.push({
      chatId,
      title: dialog.title || "(sin nombre)",
      isUser: !!dialog.isUser,
      isGroup: !dialog.isUser,
      kind,
      unreadCount: dialog.unreadCount || 0,
      lastMessage: previewOf(msg),
      lastMessageDate: msg?.date ? new Date(msg.date * 1000).toISOString() : null,
      lastMessageOut: !!msg?.out,
      participantsCount,
      username: dialog.isUser ? usernameOf(entity) : null,
    });
  }
  lastStats.set(accountId, { telegramTotal: dialogs.length, kept: out.length, excludedBigGroup, excludedNoEntity, excludedList });
  return out;
}

/** Busca grupos/canales (no chats privados) por titulo, para elegir el
 * "grupo de contenido" de una cuenta (ver api/contentLibrary.ts) o, con
 * `ownedOnly`, solo los que la propia cuenta tiene "en propiedad" (creados
 * por ella - `entity.creator`), para "Canales free" (ver api/freeChannels.ts):
 * ahí solo tiene sentido dar de alta un grupo/canal donde la cuenta puede
 * aprobar solicitudes de union porque es su dueña, no uno donde solo es
 * miembro o admin de un grupo ajeno. */
export async function searchGroupDialogs(
  client: TelegramClient,
  search?: string,
  ownedOnly = false
): Promise<{ chatId: string; title: string; isForum: boolean }[]> {
  const dialogs = await client.getDialogs({ limit: 200 });
  const s = (search || "").toLowerCase();
  const out: { chatId: string; title: string; isForum: boolean }[] = [];
  for (const dialog of dialogs) {
    if (dialog.isUser) continue; // solo grupos/canales
    if (ownedOnly && !(dialog.entity as any)?.creator) continue;
    if (s && !(dialog.title || "").toLowerCase().includes(s)) continue;
    out.push({
      chatId: dialog.id!.toString(),
      title: dialog.title || "(sin nombre)",
      isForum: !!(dialog.entity as any)?.forum,
    });
  }
  return out;
}

/** Resuelve la entidad de Telegram de un chat, usando la cache o relistando dialogos si hace falta. */
export async function resolveDialogEntity(
  client: TelegramClient,
  accountId: string,
  chatId: string
): Promise<DialogEntity> {
  const cache = cacheFor(accountId);
  let entity = cache.get(chatId);
  if (!entity) {
    // Intento barato primero: pedirle a Telegram DIRECTAMENTE esta entidad
    // (una sola llamada) en vez de traer la lista entera de 400 dialogos
    // solo para buscar este chat dentro de ella. Funciona siempre que
    // Telegram (o GramJS, en su propia cache interna de la sesion) ya tenga
    // el access_hash de este chat - el caso normal para cualquier chat con
    // el que la cuenta ya ha hablado antes, que es la inmensa mayoria de
    // las veces que se llama a esta funcion (enviar, ver perfil, galeria,
    // avatar...). Antes esto SIEMPRE caia al plan B de abajo (relistar 400
    // dialogos) en cuanto la cache en memoria del servidor se vaciaba (tras
    // cada despliegue, o simplemente un chat que no se abria hace un rato),
    // aunque Telegram pudiera resolverlo solo con esta unica llamada.
    try {
      entity = (await client.getEntity(chatId)) as DialogEntity;
      cache.set(chatId, entity);
    } catch {
      // No se pudo por la via barata (chat que Telegram no tiene "a mano"
      // todavia): cae al plan B, mas caro pero mas fiable.
    }
  }
  if (!entity) {
    await listDialogs(client, accountId, 400);
    entity = cache.get(chatId);
  }
  if (!entity) {
    // No estaba en la cache de chats privados (listDialogs solo cachea DMs
    // con fans): puede ser un grupo, por ejemplo el grupo restringido de un
    // cliente. Lo resolvemos directo por id antes de rendirnos.
    try {
      entity = (await resolveEntityById(client, chatId)) as DialogEntity;
      cache.set(chatId, entity);
    } catch {
      // sigue sin encontrarse, cae al error de abajo
    }
  }
  if (!entity) {
    throw new Error("No se encontro esa conversacion (prueba a recargar la lista de mensajes)");
  }
  return entity;
}

/** Resuelve cualquier chat/grupo/canal por id (no solo DMs con fans), con un
 * reintento tras refrescar los dialogos si Telegram no tiene el access_hash
 * en cache todavia (p.ej. justo despues de un reinicio del servidor). */
export async function resolveEntityById(client: TelegramClient, chatId: string): Promise<any> {
  try {
    return await client.getEntity(chatId);
  } catch {
    await client.getDialogs({ limit: 400 });
    return await client.getEntity(chatId);
  }
}
