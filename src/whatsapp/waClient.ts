import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import { prisma } from "../utils/prisma";
import { clearDbAuthState, useDbAuthState } from "./waAuthState";

/**
 * Conexión de WhatsApp de "Conectar WhatsApp": una sola, de toda la
 * agencia (no por modelo), vinculada por QR como WhatsApp Web. La usan el
 * Detector de pagos y el aviso de ventas a los grupos de seguimiento. Vive
 * en memoria (el socket en sí no se puede guardar en BD), pero la sesión
 * (creds/claves) sí, en WhatsAppAuthKey (ver waAuthState.ts) - así que tras
 * un "railway up" se reconecta sola sin pedir el QR de nuevo, mientras no
 * se haya cerrado sesión desde el móvil o pulsado "Desconectar" aquí.
 */

type WaStatus = "disconnected" | "connecting" | "qr" | "connected";

interface WaState {
  sock: WASocket | null;
  status: WaStatus;
  // Se guarda ya como imagen (data URL PNG en base64), generada aquí mismo
  // con la libreria "qrcode" - antes se mandaba el texto crudo del QR a un
  // servicio externo (api.qrserver.com) para que lo dibujara, lo que
  // significaba enviar el código de emparejamiento de este WhatsApp a un
  // tercero. Generándolo en el propio servidor no hace falta confiar en
  // nadie más con ese dato, aunque sea de corta duración.
  qrDataUrl: string | null;
  phoneNumber: string | null;
  lastError: string | null;
  connectingPromise: Promise<void> | null;
  explicitDisconnect: boolean;
}

const waState: WaState = {
  sock: null,
  status: "disconnected",
  qrDataUrl: null,
  phoneNumber: null,
  lastError: null,
  connectingPromise: null,
  explicitDisconnect: false,
};

const logger = pino({ level: "silent" });

export function getWhatsAppStatus() {
  return {
    status: waState.status,
    qrDataUrl: waState.qrDataUrl,
    phoneNumber: waState.phoneNumber,
    lastError: waState.lastError,
  };
}

export function isWhatsAppConnected(): boolean {
  return waState.status === "connected" && !!waState.sock;
}

/** Arranca (o reanuda) la conexión. Idempotente: si ya está conectando o
 * conectada, no hace nada. Se llama tanto al pulsar "Conectar" en el panel
 * como sola al arrancar el servidor, si ya había una sesión guardada. */
export function startWhatsAppConnection(): Promise<void> {
  if (waState.connectingPromise) return waState.connectingPromise;
  if (waState.status === "connected") return Promise.resolve();

  waState.explicitDisconnect = false;
  waState.connectingPromise = doConnect().finally(() => {
    waState.connectingPromise = null;
  });
  return waState.connectingPromise;
}

async function doConnect(): Promise<void> {
  try {
    waState.status = "connecting";
    waState.lastError = null;
    const { state, saveCreds } = await useDbAuthState();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }));

    // Se pasa "as any": la forma exacta de las opciones cambia bastante
    // entre versiones de Baileys (p.ej. "printQRInTerminal" se ha ido
    // quitando en versiones recientes) y aquí no hay forma de comprobar
    // con tsc antes de subir a Railway qué versión exacta se instaló -
    // mejor no arriesgarse a que una propiedad ya no exista rompa el build,
    // como pasó la última vez.
    const socketOptions: any = {
      auth: state,
      logger,
      browser: Browsers.ubuntu("Chrome"),
      version,
    };
    const sock = makeWASocket(socketOptions);
    waState.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        waState.status = "qr";
        QRCode.toDataURL(qr, { margin: 1, width: 220 })
          .then((dataUrl) => { waState.qrDataUrl = dataUrl; })
          .catch((err) => { console.error("[whatsapp] no se pudo generar la imagen del QR:", err); });
      }
      if (connection === "open") {
        waState.status = "connected";
        waState.qrDataUrl = null;
        waState.lastError = null;
        waState.phoneNumber = (sock.user?.id || "").split(":")[0].split("@")[0] || null;
      } else if (connection === "close") {
        waState.sock = null;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          // Se desvinculó desde el móvil (o se pidió "Desconectar" aquí):
          // no tiene sentido reintentar solo, hace falta un QR nuevo.
          waState.status = "disconnected";
          waState.qrDataUrl = null;
          waState.phoneNumber = null;
          clearDbAuthState().catch(() => {});
        } else if (!waState.explicitDisconnect) {
          // Corte de red u otro motivo pasajero: reintenta sola.
          waState.status = "connecting";
          startWhatsAppConnection().catch((err) => {
            waState.lastError = err?.message || String(err);
          });
        } else {
          waState.status = "disconnected";
        }
      }
    });
  } catch (err: any) {
    waState.status = "disconnected";
    waState.lastError = err?.message || String(err);
    waState.sock = null;
    throw err;
  }
}

/** Cierra la sesión de verdad (equivalente a quitar el dispositivo vinculado
 * desde el móvil) y borra la sesión guardada, para poder vincular un
 * WhatsApp distinto desde cero con un QR nuevo. */
export async function disconnectWhatsApp(): Promise<void> {
  waState.explicitDisconnect = true;
  try {
    const sock = waState.sock;
    if (sock) {
      await sock.logout().catch(() => {});
    }
  } finally {
    waState.sock = null;
    waState.status = "disconnected";
    waState.qrDataUrl = null;
    waState.phoneNumber = null;
    await clearDbAuthState();
  }
}

/** Si ya había una sesión vinculada antes del último despliegue, reanuda
 * sola sin esperar a que alguien entre al panel y pulse "Conectar". Se
 * llama una vez al arrancar el servidor (ver index.ts). Nunca lanza. */
export async function resumeWhatsAppIfLinked(): Promise<void> {
  try {
    const creds = await prisma.whatsAppAuthKey.findUnique({ where: { id: "creds" } });
    if (creds) await startWhatsAppConnection();
  } catch (err) {
    console.error("[whatsapp] no se pudo reanudar la sesión guardada:", err);
  }
}

export interface WaGroup {
  id: string;
  subject: string;
}

/** Lista los grupos del WhatsApp conectado, para los desplegables de "A
 * quién avisar" / grupo de cada modelo / grupo de todos los trabajadores. */
export async function listWhatsAppGroups(): Promise<WaGroup[]> {
  const sock = waState.sock;
  if (!sock || waState.status !== "connected") {
    throw new Error("El WhatsApp no está conectado todavía.");
  }
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups)
    .map((g: any) => ({ id: g.id as string, subject: (g.subject as string) || g.id }))
    .sort((a, b) => a.subject.localeCompare(b.subject, "es"));
}

/** "...@g.us" tal cual (ya es un id de grupo), o un número normal (con o
 * sin "+", espacios, guiones...) al que se le queda solo los dígitos para
 * armar el jid "digits@s.whatsapp.net" que espera Baileys. */
export function destinationToJid(raw: string): string | null {
  const t = (raw || "").trim();
  if (!t) return null;
  if (t.endsWith("@g.us") || t.endsWith("@s.whatsapp.net")) return t;
  const digits = t.replace(/[^\d]/g, "");
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

/** Manda un mensaje de texto a un destino (jid de grupo o de número) ya
 * resuelto. Lanza si no está conectado o si Telegram... si WhatsApp
 * rechaza el envío (número no existe, no está en WhatsApp, etc). */
export async function sendWhatsAppMessage(jid: string, text: string): Promise<void> {
  const sock = waState.sock;
  if (!sock || waState.status !== "connected") {
    throw new Error("El WhatsApp no está conectado todavía.");
  }
  await sock.sendMessage(jid, { text });
}

/** Manda el mismo texto a cada línea no vacía de una lista de destinos
 * (textarea "A quién avisar", un grupo/número por línea). Nunca lanza -
 * cada destino que falle se ignora y sigue con el resto (best-effort, como
 * el resto de avisos del proyecto); útil para el Detector de pagos, donde
 * un fallo de WhatsApp nunca debe tumbar nada. */
export async function sendWhatsAppToDestinations(destinationsText: string, text: string): Promise<void> {
  if (!isWhatsAppConnected()) return;
  const lines = (destinationsText || "").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const jid = destinationToJid(line);
    if (!jid) continue;
    try {
      await sendWhatsAppMessage(jid, text);
    } catch (err) {
      console.error(`[whatsapp] no se pudo avisar a "${line}":`, err);
    }
  }
}
