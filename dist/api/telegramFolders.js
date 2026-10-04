"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTelegramFolderRoutes = registerTelegramFolderRoutes;
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const folders_1 = require("../telegram/folders");
/** Igual que Promise.all, pero como mucho CONCURRENCY llamadas de Telegram a
 * la vez: una carpeta puede tener decenas de chats, y pedirle a Telegram su
 * entidad una por una (en serie) es lo que hacia que aplicar el filtro de
 * carpeta en SFS se notase lento. En paralelo total tampoco conviene -
 * demasiadas peticiones de golpe puede disparar un FLOOD_WAIT de Telegram -
 * asi que se procesan en tandas pequeñas. */
async function mapWithConcurrency(items, concurrency, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i]);
        }
    }
    await Promise.all(new Array(Math.min(concurrency, items.length)).fill(0).map(() => worker()));
    return results;
}
/** Cache en memoria (2 min) de "chats de esta carpeta ya resueltos": una
 * carpeta no cambia cada segundo, y SFS vuelve a pedir la misma carpeta cada
 * vez que se entra en esa creadora (para aplicar el filtro guardado) - sin
 * esto, cada visita repetia todas las llamadas a Telegram de nuevo. */
const folderChatsCache = new Map();
const FOLDER_CHATS_CACHE_MS = 2 * 60 * 1000;
/**
 * Lee en vivo (via GramJS) las carpetas de Telegram de una cuenta, para que
 * el panel pueda ofrecer un selector real en vez de que el usuario tenga
 * que escribir el nombre exacto a mano. Se resuelve el numero de chats de
 * cada carpeta sin resolver cada entidad (mas rapido), usando el tamaño de
 * chatIds ya presente en el filtro de Telegram.
 */
async function registerTelegramFolderRoutes(app) {
    app.get("/api/accounts/:id/telegram-folders", async (request, reply) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const folders = await (0, folders_1.listAccountFolders)(client);
            return {
                folders: folders.map((f) => ({ title: f.title, chatCount: f.chatIds.length })),
            };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo conectar con Telegram para leer las carpetas. Intenta de nuevo en unos segundos." });
        }
    });
    // Chats dentro de una carpeta concreta (para autocompletar destinos al crear una campaña)
    app.get("/api/accounts/:id/telegram-folders/:folderName/chats", async (request, reply) => {
        const { id, folderName } = request.params;
        const q = request.query;
        const decodedFolder = decodeURIComponent(folderName);
        const cacheKey = `${id}:${decodedFolder.toLowerCase()}`;
        const cached = folderChatsCache.get(cacheKey);
        if (!q.force && cached && Date.now() - cached.at < FOLDER_CHATS_CACHE_MS) {
            return { chats: cached.chats };
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const folders = await (0, folders_1.listAccountFolders)(client);
            const match = folders.find((f) => f.title.toLowerCase() === decodedFolder.toLowerCase());
            if (!match)
                return reply.code(404).send({ error: "Carpeta no encontrada" });
            let chats = await mapWithConcurrency(match.chatIds, 6, async (chatId) => {
                try {
                    const entity = await client.getEntity(chatId);
                    const title = entity.title ?? entity.username ?? entity.firstName ?? String(chatId);
                    const isForum = entity.forum === true;
                    return { chatId: String(chatId), title, isForum };
                }
                catch {
                    return { chatId: String(chatId), title: "(no se pudo resolver)", isForum: false };
                }
            });
            // Un chat "(no se pudo resolver)" normalmente no es un chat roto de
            // verdad, sino que GramJS todavia no tiene el access_hash de ese chat
            // en su cache local (le pasa sobre todo a chats privados con fans que
            // esta cuenta no ha "visto" desde que se reinicio el proceso, aunque
            // la carpeta sea grande y tenga cientos) - mismo fallo que ya se
            // arreglo para el envio del Reenviador (ver resolveChatEntity en
            // sender.ts). Aqui, en vez de reintentar chat por chat, se refresca la
            // lista de dialogos UNA vez si hizo falta y se reintentan solo los que
            // fallaron - mucho mas barato que un getDialogs por cada chat.
            const unresolved = chats.filter((c) => c.title === "(no se pudo resolver)").map((c) => c.chatId);
            if (unresolved.length > 0) {
                try {
                    await client.getDialogs({ limit: 400 });
                    const retried = await mapWithConcurrency(unresolved, 6, async (chatId) => {
                        try {
                            const entity = await client.getEntity(chatId);
                            const title = entity.title ?? entity.username ?? entity.firstName ?? String(chatId);
                            const isForum = entity.forum === true;
                            return { chatId: String(chatId), title, isForum };
                        }
                        catch {
                            return null;
                        }
                    });
                    const retriedById = new Map(retried.filter((r) => r !== null).map((r) => [r.chatId, r]));
                    chats = chats.map((c) => retriedById.get(c.chatId) ?? c);
                }
                catch {
                    // el refresco de dialogos en si fallo (cuenta desconectada, etc.) - se deja lo que ya se tenia
                }
            }
            folderChatsCache.set(cacheKey, { at: Date.now(), chats });
            return { chats };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo leer la carpeta desde Telegram." });
        }
    });
}
//# sourceMappingURL=telegramFolders.js.map