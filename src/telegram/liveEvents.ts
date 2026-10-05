import { TelegramClient, Api } from "telegram";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { touchDialogFromLiveMessage, getCachedDialogTitle } from "./dialogsCache";
import { prisma } from "../utils/prisma";
import { prefixFromPhone } from "./phoneCountry";
import { detectPaymentInMessage } from "../utils/paymentDetector";
import { isChatMemberOf } from "./promoGroups";
import { sendWhatsAppNotification } from "../utils/notifications";

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

type Listener = (event: LiveMessageEvent) => void;

const listeners = new Map<string, Set<Listener>>();
const attachedAccounts = new Set<string>();

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

/**
 * "Bloqueo automático por país": si el mensaje entrante es de un chat
 * privado (1:1, chatId positivo con la convencion de ids "marcados" que se
 * usa en todo el proyecto) y el fan escribe desde un país de la lista negra
 * de esta cuenta, se bloquea en Telegram en el momento. Nunca reintenta si
 * ya quedó marcado (auto-bloqueado o desbloqueado a mano), y nunca debe
 * tumbar el resto del puente en vivo si algo falla.
 */
function isIncomingPrivateMessage(message: Api.Message): boolean {
  if (message.out) return false;
  const peer = (message as any).peerId;
  if (peer?.className) return peer.className === "PeerUser";
  const chatId = (message as any).chatId;
  return !!chatId && Number(chatId) > 0;
}

/**
 * Aviso personal por WhatsApp cuando un cliente escribe en un chat 1:1.
 * Nunca avisa de grupos/canales ni de mensajes enviados por la propia cuenta.
 * Usa el numero `notifyWhatsAppTo` ya existente en la configuracion de cada
 * cuenta, por lo que no hace falta crear otra tabla ni cambiar el esquema.
 */
async function maybeNotifyPrivateMessage(accountId: string, chatId: string, message: Api.Message) {
  try {
    if (!isIncomingPrivateMessage(message)) return;

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { label: true, notifyWhatsAppTo: true },
    });
    if (!account?.notifyWhatsAppTo) return;

    let sender: any = null;
    try { sender = await (message as any).getSender(); } catch { sender = null; }

    const firstName = sender?.firstName || "";
    const lastName = sender?.lastName || "";
    const fullName = `${firstName} ${lastName}`.trim();
    const username = sender?.username ? `@${sender.username}` : "";
    const senderLabel = fullName || username || "Cliente";
    const text = (message.message || (message.media ? "[archivo adjunto]" : "")).trim();
    const preview = text.length > 1800 ? `${text.slice(0, 1800)}…` : text;

    const lines = [
      "🔔 Nuevo mensaje de cliente",
      `👤 ${senderLabel}${username && fullName ? ` (${username})` : ""}`,
      `📱 Cuenta: ${account.label}`,
      preview ? `💬 ${preview}` : "💬 [archivo adjunto]",
    ];

    await sendWhatsAppNotification(account.notifyWhatsAppTo, lines.join("\n"));
  } catch (err) {
    // El aviso es best-effort: WhatsApp nunca debe afectar la conexión de Telegram.
    console.error("[notifications] error avisando de mensaje privado:", err);
  }
}

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
      maybeNotifyPrivateMessage(accountId, chatId, message);
      maybeAutoBlockByCountry(accountId, client, chatId, message);
      maybeDetectPayment(accountId, chatId, message);
      maybeAttributePromoGroups(accountId, client, chatId, message);
    } catch {
      // no dejamos que un fallo de parseo tumbe la conexion
    }
  }, new NewMessage({}));

  // Nota: esta version de GramJS no expone un evento "EditedMessage" propio;
  // los mensajes editados no se emiten en vivo (solo los nuevos), pero se
  // veran igualmente al reabrir/recargar la conversacion.
}

export function detachLiveEvents(accountId: string): void {
  attachedAccounts.delete(accountId);
}
