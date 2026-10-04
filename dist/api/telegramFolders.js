"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTelegramFolderRoutes = registerTelegramFolderRoutes;
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const folders_1 = require("../telegram/folders");
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
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const folders = await (0, folders_1.listAccountFolders)(client);
            const match = folders.find((f) => f.title.toLowerCase() === decodeURIComponent(folderName).toLowerCase());
            if (!match)
                return reply.code(404).send({ error: "Carpeta no encontrada" });
            const chats = [];
            for (const chatId of match.chatIds) {
                try {
                    const entity = await client.getEntity(chatId);
                    const title = entity.title ?? entity.username ?? entity.firstName ?? String(chatId);
                    const isForum = entity.forum === true;
                    chats.push({ chatId: String(chatId), title, isForum });
                }
                catch {
                    chats.push({ chatId: String(chatId), title: "(no se pudo resolver)", isForum: false });
                }
            }
            return { chats };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo leer la carpeta desde Telegram." });
        }
    });
}
//# sourceMappingURL=telegramFolders.js.map