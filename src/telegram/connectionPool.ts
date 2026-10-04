import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Account } from "@prisma/client";
import { decryptSecret } from "../utils/crypto";
import { apiId, apiHash } from "./client";

/**
 * Pool de conexiones Telegram: UNA conexion MTProto persistente por
 * cuenta, reutilizada por todas sus campañas (en vez de abrir/cerrar una
 * conexion nueva en cada ciclo de cada campaña). Con varias cuentas y
 * varias campañas por cuenta, reconectar constantemente es innecesario y
 * acerca mas de lo debido a los limites de conexion de Telegram.
 */
const pool = new Map<string, TelegramClient>();

export async function getAccountClient(account: Account): Promise<TelegramClient> {
  const existing = pool.get(account.id);
  if (existing && existing.connected) {
    return existing;
  }
  if (existing) {
    // Conexion muerta: la limpiamos antes de crear una nueva
    try {
      await existing.disconnect();
    } catch {
      // ignoramos: ya estaba rota
    }
    pool.delete(account.id);
  }

  if (!apiId || !apiHash) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
  }
  const sessionString = decryptSecret(account.sessionString);
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  await client.connect();
  pool.set(account.id, client);
  return client;
}

/** Cierra y quita del pool la conexion de una cuenta concreta (ej. al desactivarla). */
export async function closeAccountClient(accountId: string): Promise<void> {
  const client = pool.get(accountId);
  if (!client) return;
  pool.delete(accountId);
  try {
    await client.disconnect();
  } catch {
    // best-effort
  }
}

/** Cierra todas las conexiones abiertas. Se llama al apagar el proceso (SIGTERM/SIGINT). */
export async function closeAllAccountClients(): Promise<void> {
  const ids = [...pool.keys()];
  await Promise.all(ids.map((id) => closeAccountClient(id)));
}
