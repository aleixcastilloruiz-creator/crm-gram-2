"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFreeChannelRoutes = registerFreeChannelRoutes;
const telegram_1 = require("telegram");
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const dialogs_1 = require("../telegram/dialogs");
/**
 * "Canales free" (Configuración → Modelos → esta creadora, y el apartado
 * propio de "Canales free" del menú lateral): canales de Telegram con
 * solicitud de union activada, donde se aceptan/rechazan fans en bloque sin
 * tener que abrir Telegram. Tambien "Precios" de Configuración → Modelos,
 * que vive aqui por ser parte de la misma pantalla de configuracion.
 */
async function registerFreeChannelRoutes(app) {
    // --- Precios (Configuración → Modelos → creadora) ---
    app.get("/api/accounts/:id/prices", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        return { prices: account.pricesInfo || "" };
    });
    app.put("/api/accounts/:id/prices", async (request) => {
        const { id } = request.params;
        const { prices } = request.body;
        await prisma_1.prisma.account.update({ where: { id }, data: { pricesInfo: prices ?? "" } });
        return { ok: true };
    });
    // --- Lista de canales free de una cuenta ---
    app.get("/api/accounts/:id/free-channels", async (request, reply) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        const channels = await prisma_1.prisma.freeChannel.findMany({ where: { accountId: id }, orderBy: { createdAt: "asc" } });
        // Se intenta traer el numero de solicitudes pendientes de cada canal en
        // vivo; si Telegram falla para alguno (canal borrado, sin permisos...) se
        // muestra igualmente con el conteo en null en vez de romper todo el listado.
        let client;
        try {
            client = await (0, connectionPool_1.getAccountClient)(account);
        }
        catch (err) {
            request.log.warn(err, "No se pudo conectar para contar solicitudes pendientes");
            return { channels: channels.map((c) => ({ id: c.id, chatId: c.chatId, title: c.title, pendingCount: null })) };
        }
        const withCounts = await Promise.all(channels.map(async (c) => {
            try {
                const entity = await (0, dialogs_1.resolveEntityById)(client, c.chatId);
                const peer = await client.getInputEntity(entity);
                const result = await client.invoke(new telegram_1.Api.messages.GetChatInviteImporters({ peer, requested: true, limit: 1 }));
                return { id: c.id, chatId: c.chatId, title: c.title, pendingCount: result?.count ?? (result?.importers?.length ?? 0) };
            }
            catch {
                return { id: c.id, chatId: c.chatId, title: c.title, pendingCount: null };
            }
        }));
        return { channels: withCounts };
    });
    // Busca canales/grupos de la cuenta por titulo, para el buscador de
    // "Configurar canales...".
    app.get("/api/accounts/:id/free-channels/search", async (request, reply) => {
        const { id } = request.params;
        const q = request.query;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const results = await (0, dialogs_1.searchGroupDialogs)(client, q.q);
            return { results };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo conectar con Telegram para buscar canales." });
        }
    });
    app.post("/api/accounts/:id/free-channels", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        if (!body.chatId || !body.title)
            return reply.code(400).send({ error: "Falta el canal a añadir" });
        try {
            const channel = await prisma_1.prisma.freeChannel.create({ data: { accountId: id, chatId: body.chatId, title: body.title } });
            return { channel };
        }
        catch (err) {
            if (err?.code === "P2002")
                return reply.code(409).send({ error: "Ese canal ya está en la lista." });
            request.log.error(err);
            return reply.code(500).send({ error: "No se pudo añadir el canal." });
        }
    });
    app.delete("/api/free-channels/:channelId", async (request) => {
        const { channelId } = request.params;
        await prisma_1.prisma.freeChannel.delete({ where: { id: channelId } }).catch(() => { });
        return { ok: true };
    });
    // --- Solicitudes de union pendientes de un canal ---
    app.get("/api/accounts/:id/free-channels/:channelId/join-requests", async (request, reply) => {
        const { id, channelId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        const channel = await prisma_1.prisma.freeChannel.findUnique({ where: { id: channelId } });
        if (!channel || channel.accountId !== id)
            return reply.code(404).send({ error: "Canal no encontrado" });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveEntityById)(client, channel.chatId);
            const peer = await client.getInputEntity(entity);
            const result = await client.invoke(new telegram_1.Api.messages.GetChatInviteImporters({ peer, requested: true, limit: 200 }));
            const usersById = new Map((result.users || []).map((u) => [String(u.id), u]));
            const requests = (result.importers || []).map((imp) => {
                const u = usersById.get(String(imp.userId));
                return {
                    userId: String(imp.userId),
                    accessHash: u?.accessHash !== undefined ? String(u.accessHash) : null,
                    name: u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "Usuario" : "Usuario",
                    username: u?.username || null,
                    date: imp.date ? new Date(imp.date * 1000).toISOString() : null,
                    about: imp.about || null,
                };
            });
            return { requests, total: result.count ?? requests.length };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudieron leer las solicitudes de este canal." });
        }
    });
    // Aceptar/rechazar UNA solicitud concreta.
    app.post("/api/accounts/:id/free-channels/:channelId/join-requests/decide", async (request, reply) => {
        const { id, channelId } = request.params;
        const body = request.body;
        if (!body.userId || !body.accessHash || body.approve === undefined) {
            return reply.code(400).send({ error: "Faltan datos de la solicitud" });
        }
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        const channel = await prisma_1.prisma.freeChannel.findUnique({ where: { id: channelId } });
        if (!channel || channel.accountId !== id)
            return reply.code(404).send({ error: "Canal no encontrado" });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveEntityById)(client, channel.chatId);
            const peer = await client.getInputEntity(entity);
            const inputUser = new telegram_1.Api.InputUser({ userId: body.userId, accessHash: body.accessHash });
            await client.invoke(new telegram_1.Api.messages.HideChatJoinRequest({ peer, userId: inputUser, approved: body.approve }));
            return { ok: true };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo resolver la solicitud." });
        }
    });
    // Aceptar en bloque: procesa un lote (hasta 200) por llamada -pedir de
    // golpe miles de solicitudes podria tardar minutos y arriesgar la
    // conexion-, el panel repite la llamada mientras hasMore sea true.
    app.post("/api/accounts/:id/free-channels/:channelId/join-requests/accept-all", async (request, reply) => {
        const { id, channelId } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        const channel = await prisma_1.prisma.freeChannel.findUnique({ where: { id: channelId } });
        if (!channel || channel.accountId !== id)
            return reply.code(404).send({ error: "Canal no encontrado" });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(account);
            const entity = await (0, dialogs_1.resolveEntityById)(client, channel.chatId);
            const peer = await client.getInputEntity(entity);
            const result = await client.invoke(new telegram_1.Api.messages.GetChatInviteImporters({ peer, requested: true, limit: 200 }));
            const usersById = new Map((result.users || []).map((u) => [String(u.id), u]));
            const importers = result.importers || [];
            let accepted = 0;
            for (const imp of importers) {
                const u = usersById.get(String(imp.userId));
                if (!u || u.accessHash === undefined)
                    continue;
                try {
                    const inputUser = new telegram_1.Api.InputUser({ userId: u.id, accessHash: u.accessHash });
                    await client.invoke(new telegram_1.Api.messages.HideChatJoinRequest({ peer, userId: inputUser, approved: true }));
                    accepted++;
                }
                catch {
                    // seguimos con el siguiente aunque uno falle
                }
            }
            return { accepted, hasMore: importers.length >= 200 };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudieron aceptar las solicitudes." });
        }
    });
}
//# sourceMappingURL=freeChannels.js.map