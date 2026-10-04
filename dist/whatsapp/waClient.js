"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWhatsAppStatus = getWhatsAppStatus;
exports.isWhatsAppConnected = isWhatsAppConnected;
exports.startWhatsAppConnection = startWhatsAppConnection;
exports.disconnectWhatsApp = disconnectWhatsApp;
exports.resumeWhatsAppIfLinked = resumeWhatsAppIfLinked;
exports.listWhatsAppGroups = listWhatsAppGroups;
exports.destinationToJid = destinationToJid;
exports.sendWhatsAppMessage = sendWhatsAppMessage;
exports.sendWhatsAppToDestinations = sendWhatsAppToDestinations;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const qrcode_1 = __importDefault(require("qrcode"));
const prisma_1 = require("../utils/prisma");
const waAuthState_1 = require("./waAuthState");
const waState = {
    sock: null,
    status: "disconnected",
    qrDataUrl: null,
    phoneNumber: null,
    lastError: null,
    connectingPromise: null,
    explicitDisconnect: false,
};
const logger = (0, pino_1.default)({ level: "silent" });
function getWhatsAppStatus() {
    return {
        status: waState.status,
        qrDataUrl: waState.qrDataUrl,
        phoneNumber: waState.phoneNumber,
        lastError: waState.lastError,
    };
}
function isWhatsAppConnected() {
    return waState.status === "connected" && !!waState.sock;
}
/** Arranca (o reanuda) la conexión. Idempotente: si ya está conectando o
 * conectada, no hace nada. Se llama tanto al pulsar "Conectar" en el panel
 * como sola al arrancar el servidor, si ya había una sesión guardada. */
function startWhatsAppConnection() {
    if (waState.connectingPromise)
        return waState.connectingPromise;
    if (waState.status === "connected")
        return Promise.resolve();
    waState.explicitDisconnect = false;
    waState.connectingPromise = doConnect().finally(() => {
        waState.connectingPromise = null;
    });
    return waState.connectingPromise;
}
async function doConnect() {
    try {
        waState.status = "connecting";
        waState.lastError = null;
        const { state, saveCreds } = await (0, waAuthState_1.useDbAuthState)();
        const { version } = await (0, baileys_1.fetchLatestBaileysVersion)().catch(() => ({ version: undefined }));
        // Se pasa "as any": la forma exacta de las opciones cambia bastante
        // entre versiones de Baileys (p.ej. "printQRInTerminal" se ha ido
        // quitando en versiones recientes) y aquí no hay forma de comprobar
        // con tsc antes de subir a Railway qué versión exacta se instaló -
        // mejor no arriesgarse a que una propiedad ya no exista rompa el build,
        // como pasó la última vez.
        const socketOptions = {
            auth: state,
            logger,
            browser: baileys_1.Browsers.ubuntu("Chrome"),
            version,
        };
        const sock = (0, baileys_1.default)(socketOptions);
        waState.sock = sock;
        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                waState.status = "qr";
                qrcode_1.default.toDataURL(qr, { margin: 1, width: 220 })
                    .then((dataUrl) => { waState.qrDataUrl = dataUrl; })
                    .catch((err) => { console.error("[whatsapp] no se pudo generar la imagen del QR:", err); });
            }
            if (connection === "open") {
                waState.status = "connected";
                waState.qrDataUrl = null;
                waState.lastError = null;
                waState.phoneNumber = (sock.user?.id || "").split(":")[0].split("@")[0] || null;
            }
            else if (connection === "close") {
                waState.sock = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = statusCode === baileys_1.DisconnectReason.loggedOut;
                if (loggedOut) {
                    // Se desvinculó desde el móvil (o se pidió "Desconectar" aquí):
                    // no tiene sentido reintentar solo, hace falta un QR nuevo.
                    waState.status = "disconnected";
                    waState.qrDataUrl = null;
                    waState.phoneNumber = null;
                    (0, waAuthState_1.clearDbAuthState)().catch(() => { });
                }
                else if (!waState.explicitDisconnect) {
                    // Corte de red u otro motivo pasajero: reintenta sola.
                    waState.status = "connecting";
                    startWhatsAppConnection().catch((err) => {
                        waState.lastError = err?.message || String(err);
                    });
                }
                else {
                    waState.status = "disconnected";
                }
            }
        });
    }
    catch (err) {
        waState.status = "disconnected";
        waState.lastError = err?.message || String(err);
        waState.sock = null;
        throw err;
    }
}
/** Cierra la sesión de verdad (equivalente a quitar el dispositivo vinculado
 * desde el móvil) y borra la sesión guardada, para poder vincular un
 * WhatsApp distinto desde cero con un QR nuevo. */
async function disconnectWhatsApp() {
    waState.explicitDisconnect = true;
    try {
        const sock = waState.sock;
        if (sock) {
            await sock.logout().catch(() => { });
        }
    }
    finally {
        waState.sock = null;
        waState.status = "disconnected";
        waState.qrDataUrl = null;
        waState.phoneNumber = null;
        await (0, waAuthState_1.clearDbAuthState)();
    }
}
/** Si ya había una sesión vinculada antes del último despliegue, reanuda
 * sola sin esperar a que alguien entre al panel y pulse "Conectar". Se
 * llama una vez al arrancar el servidor (ver index.ts). Nunca lanza. */
async function resumeWhatsAppIfLinked() {
    try {
        const creds = await prisma_1.prisma.whatsAppAuthKey.findUnique({ where: { id: "creds" } });
        if (creds)
            await startWhatsAppConnection();
    }
    catch (err) {
        console.error("[whatsapp] no se pudo reanudar la sesión guardada:", err);
    }
}
/** Lista los grupos del WhatsApp conectado, para los desplegables de "A
 * quién avisar" / grupo de cada modelo / grupo de todos los trabajadores. */
async function listWhatsAppGroups() {
    const sock = waState.sock;
    if (!sock || waState.status !== "connected") {
        throw new Error("El WhatsApp no está conectado todavía.");
    }
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups)
        .map((g) => ({ id: g.id, subject: g.subject || g.id }))
        .sort((a, b) => a.subject.localeCompare(b.subject, "es"));
}
/** "...@g.us" tal cual (ya es un id de grupo), o un número normal (con o
 * sin "+", espacios, guiones...) al que se le queda solo los dígitos para
 * armar el jid "digits@s.whatsapp.net" que espera Baileys. */
function destinationToJid(raw) {
    const t = (raw || "").trim();
    if (!t)
        return null;
    if (t.endsWith("@g.us") || t.endsWith("@s.whatsapp.net"))
        return t;
    const digits = t.replace(/[^\d]/g, "");
    if (!digits)
        return null;
    return `${digits}@s.whatsapp.net`;
}
/** Manda un mensaje de texto a un destino (jid de grupo o de número) ya
 * resuelto. Lanza si no está conectado o si Telegram... si WhatsApp
 * rechaza el envío (número no existe, no está en WhatsApp, etc). */
async function sendWhatsAppMessage(jid, text) {
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
async function sendWhatsAppToDestinations(destinationsText, text) {
    if (!isWhatsAppConnected())
        return;
    const lines = (destinationsText || "").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const jid = destinationToJid(line);
        if (!jid)
            continue;
        try {
            await sendWhatsAppMessage(jid, text);
        }
        catch (err) {
            console.error(`[whatsapp] no se pudo avisar a "${line}":`, err);
        }
    }
}
//# sourceMappingURL=waClient.js.map