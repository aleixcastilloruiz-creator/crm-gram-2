"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiHash = exports.apiId = void 0;
exports.connectAccountClient = connectAccountClient;
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const crypto_1 = require("../utils/crypto");
const apiId = Number(process.env.TELEGRAM_API_ID);
exports.apiId = apiId;
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
exports.apiHash = apiHash;
if (!apiId || !apiHash) {
    // No lanzamos aqui para permitir que scripts como prisma:generate
    // funcionen sin .env completo, pero cualquier intento real de conectar
    // fallara con un mensaje claro mas abajo.
    // eslint-disable-next-line no-console
    console.warn("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados todavia.");
}
/**
 * Crea y conecta un TelegramClient para una cuenta ya autenticada
 * (session string cifrado guardado en Account.sessionString).
 *
 * Importante: esto opera la cuenta de usuario real de la modelo (MTProto),
 * no un bot. El uso de este cliente para envios masivos/automatizados va
 * contra los Terminos de Servicio de Telegram y el riesgo (baneo del
 * numero) lo asume el negocio, no esta libreria.
 */
async function connectAccountClient(encryptedSessionString) {
    if (!apiId || !apiHash) {
        throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
    }
    const sessionString = (0, crypto_1.decryptSecret)(encryptedSessionString);
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
    });
    await client.connect();
    return client;
}
//# sourceMappingURL=client.js.map