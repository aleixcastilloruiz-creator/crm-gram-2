import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { decryptSecret } from "../utils/crypto";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH ?? "";

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
export async function connectAccountClient(encryptedSessionString: string): Promise<TelegramClient> {
  if (!apiId || !apiHash) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
  }
  const sessionString = decryptSecret(encryptedSessionString);
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}

export { apiId, apiHash };
