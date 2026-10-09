import { TelegramClient, Api, utils as telegramUtils } from "telegram";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import { touchDialogFromLiveMessage, getCachedDialogTitle } from "./dialogsCache";
import { persistMessage } from "./messageStore";
import { prisma } from "../utils/prisma";
import { prefixFromPhone } from "./phoneCountry";
import { detectPaymentInMessage } from "../utils/paymentDetector";
import { isChatMemberOf } from "./promoGroups";

/**
 * Puente en tiempo real entre Telegram y el panel: cuando llega o se envia
 * un mensaje en cualquier chat privado de una cuenta, lo emitimos al
 * instante a quien este escuchando esa cuenta (el endpoint SSE en
 * messages.ts), para que la lista de conversaciones y el chat abierto se
 * actualicen solos, sin esperar a que el frontend refresque.
 */

export interface LiveMessageEvent {
  type: "message";
  chatId: string;
  message: {
    id: number;
    text: string;
    out: boolean;
    date: string | null;
  };
}

/** "Tick de leído" (como Telegram/TeleCrew): se emite cuando el FAN lee
 * alguno de nuestros mensajes salientes en ese chat (ver
 * UpdateReadHistoryOutbox más abajo). El frontend, al recibirlo, vuelve a
 * pedir los mensajes del chat abierto (igual que ya hace con "message") para
 * repintar los ticks - no hace falta mandar el maxId por aquí, ver
 * getOutboxReadMaxId. */
export interface LiveReadEvent {
  type: "read";
  chatId: string;
}

type Listener = (event: LiveMessageEvent | LiveReadEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const attachedAccounts = new Set<string>();

/** "Tick de leído": hasta qué id de mensaje saliente (nuestro, m.out=true) ha
 * leído el fan en cada chat, por cuenta. Solo en memoria (se vacía con cada
 * despliegue, igual que otras caches "mejor esfuerzo" de este fichero) -
 * basta con que Telegram mande un UpdateReadHistoryOutbox nuevo mientras el
 * servidor está arriba para que el tick se ponga al día; tras un deploy
 * vuelve a empezar en "✓" (enviado) hasta el siguiente aviso de lectura, sin
 * que eso rompa nada. Solo cubre chats privados (1:1, el caso de "Mensajes"
 * con fans) - los grupos/canales usan un update distinto
 * (UpdateReadChannelOutbox) que no se trata aquí a propósito, fuera de
 * alcance de "tick de leído en el chat con el fan".
 */
const outboxReadMaxId = new Map<string, Map<string, number>>(); // accountId -> chatId -> maxId

/** Hasta qué id de mensaje saliente ha leído el fan en este chat (0 = nunca
 * se ha visto ningún aviso de lectura desde que arrancó el servidor - el
 * frontend lo trata como "todavía sin confirmar", un solo ✓). */
export function getOutboxReadMaxId(accountId: string, chatId: string): number {
  return outboxReadMaxId.get(accountId)?.get(chatId) || 0;
}

export function subscribeToAccountEvents(accountId: string, listener: Listener): () => void {
  let set = listeners.get(accountId);
  if (!set) {
    set = new Set();
    listeners.set(accountId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(accountId);
  };
}

function emit(accountId: string, chatId: string, message: Api.Message) {
  const payload: LiveMessageEvent = {
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
  touchDialogFromLiveMessage(accountId, chatId, payload.message);
  // Guarda este mensaje en la copia local (ver telegram/messageStore.ts) en
  // cuanto llega - de cualquier lado (fan, trabajador desde el CRM, o la
  // propia creadora desde su móvil) - para que la próxima vez que se abra
  // este chat ya esté aquí sin tener que volver a pedírselo a Telegram.
  // Fire-and-forget: nunca debe retrasar el aviso en vivo al frontend.
  persistMessage(accountId, chatId, message);

  const set = listeners.get(accountId);
  if (!set || set.size === 0) return;
  for (const l of set) {
    try {
      l(payload);
    } catch {
      // un listener roto no debe tumbar al resto
    }
  }
}

/** Avisa a quien esté escuchando esta cuenta de que el fan ha leído (al
 * menos) hasta cierto punto de un chat - ver LiveReadEvent arriba. */
function emitRead(accountId: string, chatId: string) {
  const set = listeners.get(accountId);
  if (!set || set.size === 0) return;
  const payload: LiveReadEvent = { type: "read", chatId };
  for (const l of set) {
    try {
      l(payload);
    } catch {
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
async function maybeAutoBlockByCountry(accountId: string, client: TelegramClient, chatId: string, message: Api.Message) {
  try {
    if (message.out) return;
    if (!(Number(chatId) > 0)) return; // solo chats privados, nunca grupos/canales
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) return;
    let prefixes: string[] = [];
    try {
      prefixes = JSON.parse(account.blockedCountries || "[]");
    } catch {
      prefixes = [];
    }
    if (prefixes.length === 0) return;

    const existing = await prisma.fanNote.findUnique({ where: { accountId_chatId: { accountId, chatId } } });
    if (existing?.manuallyUnblocked || existing?.autoBlockedByCountry) return;

    let sender: any = null;
    try {
      sender = await (message as any).getSender();
    } catch {
      sender = null;
    }
    if (!sender || sender.className !== "User" || !sender.accessHash) return;

    // La entidad del evento en vivo suele venir "recortada" (sin telefono
    // aunque Telegram lo dejase ver), igual que en /dialogs/:chatId/profile:
    // pedimos el usuario completo para tener la mejor oportunidad de verlo.
    let phone: string | null = sender.phone ? "+" + sender.phone : null;
    try {
      const inputUser = new Api.InputUser({ userId: sender.id, accessHash: sender.accessHash });
      const full = await client.invoke(new Api.users.GetUsers({ id: [inputUser] }));
      if (full && full[0] && (full[0] as any).className === "User" && (full[0] as any).phone) {
        phone = "+" + (full[0] as any).phone;
      }
    } catch {
      // seguimos con lo que ya tuvieramos
    }

    const prefix = prefixFromPhone(phone);
    if (!prefix || !prefixes.includes(prefix)) return;

    const inputUser = new Api.InputUser({ userId: sender.id, accessHash: sender.accessHash });
    await client.invoke(new Api.contacts.Block({ id: inputUser }));
    await prisma.fanNote.upsert({
      where: { accountId_chatId: { accountId, chatId } },
      update: { autoBlockedByCountry: true },
      create: { accountId, chatId, autoBlockedByCountry: true },
    });
  } catch {
    // best effort: un fallo aqui nunca debe afectar al resto del puente en vivo
  }
}

/** Nombre del archivo adjunto (si el mensaje trae uno), para las reglas del
 * Detector de pagos que buscan también en "nombre del archivo". */
function extractAttachmentFilename(message: Api.Message): string | null {
  try {
    const doc = (message.media as any)?.document;
    const attrs = doc?.attributes || [];
    const fileAttr = attrs.find((a: any) => a.className === "DocumentAttributeFilename");
    return fileAttr?.fileName || null;
  } catch {
    return null;
  }
}

/** Detector de pagos: revisa el mensaje (texto/pie de archivo/nombre de
 * archivo) en busca de datos de pago, tanto si lo escribió el fan como el
 * equipo. Fire-and-forget, nunca debe retrasar ni tumbar el puente en vivo. */
async function maybeDetectPayment(accountId: string, chatId: string, message: Api.Message) {
  try {
    const hasMedia = !!message.media;
    const bodyText = message.message || "";
    await detectPaymentInMessage({
      accountId,
      chatId,
      chatTitle: getCachedDialogTitle(accountId, chatId) || chatId,
      senderOut: !!message.out,
      text: hasMedia ? null : bodyText,
      caption: hasMedia ? bodyText : null,
      filename: extractAttachmentFilename(message),
    });
  } catch {
    // best effort: un fallo aqui nunca debe afectar al resto del puente en vivo
  }
}

/**
 * "Grupos de promoción" → atribución de fans: en cuanto un fan escribe por
 * primera vez a una cuenta, comprobamos si es miembro de alguno de los
 * grupos de promoción YA CATALOGADOS de esa cuenta (channels.GetParticipant,
 * sin descargar listas de miembros - ver telegram/promoGroups.ts), y lo
 * dejamos guardado (PromoGroupFanAttribution) para el veredicto por admin.
 * Un mismo fan puede acabar atribuido a varios grupos a la vez (su venta se
 * repartirá entre todos, ver informes de veredicto).
 *
 * "checked" (en memoria, por cuenta) evita repetir la comprobación en CADA
 * mensaje del mismo fan dentro de este proceso - se vacía en cada
 * despliegue, así que tras un "railway up" el primer mensaje siguiente de
 * cada fan activo se vuelve a comprobar una vez (barato: una consulta a la
 * base de datos si ya está guardado, antes de tocar Telegram para nada).
 * Nunca se comprueba nada si la cuenta no tiene ningún grupo catalogado
 * todavía, para no gastar peticiones a Telegram de balde.
 */
const attributionChecked = new Map<string, Set<string>>();

async function maybeAttributePromoGroups(accountId: string, client: TelegramClient, chatId: string, message: Api.Message) {
  try {
    if (message.out) return;
    if (!(Number(chatId) > 0)) return; // solo chats privados (fans), nunca grupos/canales

    let checked = attributionChecked.get(accountId);
    if (!checked) {
      checked = new Set();
      attributionChecked.set(accountId, checked);
    }
    if (checked.has(chatId)) return;
    checked.add(chatId);

    const already = await prisma.promoGroupFanAttribution.findFirst({ where: { accountId, chatId } });
    if (already) return; // ya se guardó en un despliegue anterior

    const catalogued = await prisma.promoGroupAccount.findMany({
      where: { accountId },
      select: { promoGroup: { select: { id: true, chatId: true } } },
    });
    if (catalogued.length === 0) return; // sin grupos catalogados aun para esta cuenta

    for (const c of catalogued) {
      const isMember = await isChatMemberOf(client, c.promoGroup.chatId, chatId);
      if (!isMember) continue;
      await prisma.promoGroupFanAttribution.upsert({
        where: { accountId_chatId_promoGroupId: { accountId, chatId, promoGroupId: c.promoGroup.id } },
        update: {},
        create: { accountId, chatId, promoGroupId: c.promoGroup.id },
      });
    }
  } catch {
    // best effort: un fallo aqui nunca debe afectar al resto del puente en vivo
  }
}

function resolveChatId(message: Api.Message): string | null {
  try {
    // chatId ya resuelve al id "de dialogo" (usuario/chat), igual que en listDialogs/dialogs.ts
    const cid = (message as any).chatId;
    if (cid) return cid.toString();
  } catch {
    // sigue al fallback
  }
  return null;
}

/**
 * Conecta el listener de mensajes en tiempo real para una cuenta. Se llama
 * cada vez que se obtiene el cliente del pool, pero solo se engancha una
 * vez de verdad por cuenta (el resto de llamadas no hacen nada).
 */
export function attachLiveEvents(accountId: string, client: TelegramClient): void {
  if (attachedAccounts.has(accountId)) return;
  attachedAccounts.add(accountId);

  client.addEventHandler((event: NewMessageEvent) => {
    try {
      const message = event.message;
      if (!message) return;
      const chatId = resolveChatId(message);
      if (!chatId) return;
      emit(accountId, chatId, message);
      // No se espera (fire-and-forget): el bloqueo por país y el detector de
      // pagos nunca deben retrasar la actualización en vivo del chat.
      maybeAutoBlockByCountry(accountId, client, chatId, message);
      maybeDetectPayment(accountId, chatId, message);
      maybeAttributePromoGroups(accountId, client, chatId, message);
    } catch {
      // no dejamos que un fallo de parseo tumbe la conexion
    }
  }, new NewMessage({}));

  // Mensajes EDITADOS: igual que el "tick de leído" de más abajo, esta
  // version de GramJS no expone un evento "EditedMessage" de alto nivel
  // propio, así que se engancha con Raw({}) y se filtra a mano por
  // className. Antes esto no se trataba para nada (el comentario que había
  // aquí decía literalmente que una edición solo se veía "al
  // reabrir/recargar la conversación") - eso era tolerable mientras CADA
  // apertura de chat volvía a pedirle el historial entero a Telegram, pero
  // deja de serlo con la copia local (ver telegram/messageStore.ts): si un
  // chat ya está guardado, reabrirlo NUNCA vuelve a tocar Telegram, así que
  // sin esto una edición se quedaría mal para siempre. Se trata (persiste +
  // se avisa en vivo al frontend) exactamente igual que un mensaje nuevo.
  const handleEditUpdate = (update: Api.UpdateEditMessage | Api.UpdateEditChannelMessage) => {
    try {
      const message = update.message;
      if (!message || message.className !== "Message") return; // MessageEmpty/MessageService: nada que guardar
      const chatId = resolveChatId(message as Api.Message);
      if (!chatId) return;
      emit(accountId, chatId, message as Api.Message);
    } catch {
      // no dejamos que un fallo de parseo tumbe la conexion
    }
  };
  client.addEventHandler((update: Api.TypeUpdate) => {
    if (update.className === "UpdateEditMessage" || update.className === "UpdateEditChannelMessage") {
      handleEditUpdate(update as Api.UpdateEditMessage | Api.UpdateEditChannelMessage);
    }
  }, new Raw({}));

  // "Tick de leído" (✓✓ como Telegram/TeleCrew): UpdateReadHistoryOutbox es
  // el aviso de MTProto de que el OTRO lado (el fan) ha leído nuestros
  // mensajes salientes hasta cierto id, en un chat privado. No tiene su
  // propio "event builder" en GramJS (a diferencia de NewMessage), así que
  // se engancha con Raw({}) -recibe TODOS los updates crudos- y se filtra a
  // mano por className, igual que se hace en el resto del proyecto cuando
  // hace falta un dato que GramJS no envuelve en un evento de alto nivel.
  client.addEventHandler((update: Api.TypeUpdate) => {
    try {
      if (update.className !== "UpdateReadHistoryOutbox") return;
      const u = update as Api.UpdateReadHistoryOutbox;
      const chatId = telegramUtils.getPeerId(u.peer).toString();
      let perChat = outboxReadMaxId.get(accountId);
      if (!perChat) {
        perChat = new Map();
        outboxReadMaxId.set(accountId, perChat);
      }
      const prevMax = perChat.get(chatId) || 0;
      if (u.maxId > prevMax) {
        perChat.set(chatId, u.maxId);
        emitRead(accountId, chatId);
      }
    } catch {
      // no dejamos que un fallo de parseo tumbe la conexion
    }
  }, new Raw({}));
}

export function detachLiveEvents(accountId: string): void {
  attachedAccounts.delete(accountId);
}
