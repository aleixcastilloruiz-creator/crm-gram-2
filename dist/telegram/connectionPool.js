"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAccountClient = getAccountClient;
exports.closeAccountClient = closeAccountClient;
exports.closeAllAccountClients = closeAllAccountClients;
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const crypto_1 = require("../utils/crypto");
const client_1 = require("./client");
const liveEvents_1 = require("./liveEvents");
const dialogsCache_1 = require("./dialogsCache");
/**
 * Pool de conexiones Telegram: UNA conexion MTProto persistente por
 * cuenta, reutilizada por todas sus campañas (en vez de abrir/cerrar una
 * conexion nueva en cada ciclo de cada campaña). Con varias cuentas y
 * varias campañas por cuenta, reconectar constantemente es innecesario y
 * acerca mas de lo debido a los limites de conexion de Telegram.
 */
const pool = new Map();
async function getAccountClient(account) {
    const existing = pool.get(account.id);
    if (existing && existing.connected) {
        (0, liveEvents_1.attachLiveEvents)(account.id, existing);
        return existing;
    }
    if (existing) {
        // Conexion muerta: la limpiamos antes de crear una nueva
        try {
            await existing.disconnect();
        }
        catch {
            // ignoramos: ya estaba rota
        }
        pool.delete(account.id);
        (0, liveEvents_1.detachLiveEvents)(account.id);
    }
    if (!client_1.apiId || !client_1.apiHash) {
        throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
    }
    const sessionString = (0, crypto_1.decryptSecret)(account.sessionString);
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), client_1.apiId, client_1.apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
    });
    await client.connect();
    pool.set(account.id, client);
    // Enchufa el listener de mensajes en tiempo real (Mensajes -> tiempo real).
    (0, liveEvents_1.attachLiveEvents)(account.id, client);
    return client;
}
/** Cierra y quita del pool la conexion de una cuenta concreta (ej. al desactivarla). */
async function closeAccountClient(accountId) {
    (0, liveEvents_1.detachLiveEvents)(accountId);
    (0, dialogsCache_1.clearDialogsCache)(accountId);
    const client = pool.get(accountId);
    if (!client)
        return;
    pool.delete(accountId);
    try {
        await client.disconnect();
    }
    catch {
        // best-effort
    }
}
/** Cierra todas las conexiones abiertas. Se llama al apagar el proceso (SIGTERM/SIGINT). */
async function closeAllAccountClients() {
    const ids = [...pool.keys()];
    await Promise.all(ids.map((id) => closeAccountClient(id)));
}
//# sourceMappingURL=connectionPool.js.map