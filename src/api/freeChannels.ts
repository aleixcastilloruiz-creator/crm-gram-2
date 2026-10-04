import { FastifyInstance } from "fastify";
import { Api } from "telegram";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "../telegram/connectionPool";
import { searchGroupDialogs, resolveEntityById } from "../telegram/dialogs";
import { getCachedMedia, setCachedMedia } from "../telegram/mediaCache";

/**
 * "Canales free" (Configuración → Modelos → esta creadora, y el apartado
 * propio de "Canales free" del menú lateral): canales de Telegram con
 * solicitud de union activada, donde se aceptan/rechazan fans en bloque sin
 * tener que abrir Telegram. Tambien "Precios" de Configuración → Modelos,
 * que vive aqui por ser parte de la misma pantalla de configuracion.
 */
export async function registerFreeChannelRoutes(app: FastifyInstance) {
  // --- Precios (Configuración → Modelos → creadora) ---
  app.get("/api/accounts/:id/prices", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    return { prices: account.pricesInfo || "" };
  });

  app.put("/api/accounts/:id/prices", async (request) => {
    const { id } = request.params as { id: string };
    const { prices } = request.body as { prices?: string };
    await prisma.account.update({ where: { id }, data: { pricesInfo: prices ?? "" } });
    return { ok: true };
  });

  // --- Lista de canales free de una cuenta ---
  app.get("/api/accounts/:id/free-channels", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const channels = await prisma.freeChannel.findMany({ where: { accountId: id }, orderBy: { createdAt: "asc" } });
    // Se intenta traer el numero de solicitudes pendientes de cada canal en
    // vivo; si Telegram falla para alguno (canal borrado, sin permisos...) se
    // muestra igualmente con el conteo en null en vez de romper todo el listado.
    let client;
    try {
      client = await getAccountClient(account);
    } catch (err) {
      request.log.warn(err, "No se pudo conectar para contar solicitudes pendientes");
      return { channels: channels.map((c) => ({ id: c.id, chatId: c.chatId, title: c.title, pendingCount: null })) };
    }
    const withCounts = await Promise.all(
      channels.map(async (c) => {
        try {
          const entity = await resolveEntityById(client, c.chatId);
          const peer = await client.getInputEntity(entity);
          const result: any = await client.invoke(new Api.messages.GetChatInviteImporters({ peer, requested: true, limit: 1 }));
          return { id: c.id, chatId: c.chatId, title: c.title, pendingCount: result?.count ?? (result?.importers?.length ?? 0) };
        } catch {
          return { id: c.id, chatId: c.chatId, title: c.title, pendingCount: null };
        }
      })
    );
    return { channels: withCounts };
  });

  // Busca canales/grupos de la cuenta por titulo, para el buscador de
  // "Configurar canales...".
  app.get("/api/accounts/:id/free-channels/search", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { q?: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      // ownedOnly=true: solo grupos/canales que la propia cuenta ha creado
      // (de los que es dueña), nunca uno donde solo es miembro o admin -
      // esta lista es para "Canales free", donde hace falta poder aprobar
      // solicitudes de union, así que un canal ajeno no serviría de nada.
      const results = await searchGroupDialogs(client, q.q, true);
      return { results };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo conectar con Telegram para buscar canales." });
    }
  });

  app.post("/api/accounts/:id/free-channels", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { chatId?: string; title?: string };
    if (!body.chatId || !body.title) return reply.code(400).send({ error: "Falta el canal a añadir" });
    try {
      const channel = await prisma.freeChannel.create({ data: { accountId: id, chatId: body.chatId, title: body.title } });
      return { channel };
    } catch (err: any) {
      if (err?.code === "P2002") return reply.code(409).send({ error: "Ese canal ya está en la lista." });
      request.log.error(err);
      return reply.code(500).send({ error: "No se pudo añadir el canal." });
    }
  });

  app.delete("/api/free-channels/:channelId", async (request) => {
    const { channelId } = request.params as { channelId: string };
    await prisma.freeChannel.delete({ where: { id: channelId } }).catch(() => {});
    return { ok: true };
  });

  // --- Solicitudes de union pendientes de un canal ---
  // Telegram solo da hasta 200 por llamada (GetChatInviteImporters), asi que
  // con canales de miles de solicitudes (ver "Mery Sweetie" con 1061 en el
  // panel de referencia) hacia falta paginar: offsetDate/offsetUserId son
  // los del ULTIMO importer de la pagina anterior (Telegram sigue desde
  // ahi), y hasMore avisa al frontend de si hay que pedir la siguiente
  // pagina ("Cargar más") en vez de dar por hecho que eso es todo.
  app.get("/api/accounts/:id/free-channels/:channelId/join-requests", async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string };
    const q = request.query as { offsetDate?: string; offsetUserId?: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const channel = await prisma.freeChannel.findUnique({ where: { id: channelId } });
    if (!channel || channel.accountId !== id) return reply.code(404).send({ error: "Canal no encontrado" });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveEntityById(client, channel.chatId);
      const peer = await client.getInputEntity(entity);
      const result: any = await client.invoke(
        new Api.messages.GetChatInviteImporters({
          peer,
          requested: true,
          limit: 200,
          offsetDate: q.offsetDate ? Number(q.offsetDate) : 0,
          offsetUser: q.offsetUserId
            ? await client.getInputEntity(q.offsetUserId).catch(() => new Api.InputUserEmpty())
            : new Api.InputUserEmpty(),
        })
      );
      const usersById = new Map<string, any>((result.users || []).map((u: any) => [String(u.id), u]));
      const importers = result.importers || [];
      const requests = importers.map((imp: any) => {
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
      const last = importers[importers.length - 1];
      return {
        requests,
        total: result.count ?? requests.length,
        hasMore: importers.length >= 200,
        nextOffsetDate: last?.date ?? null,
        nextOffsetUserId: last ? String(last.userId) : null,
      };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudieron leer las solicitudes de este canal." });
    }
  });

  // Foto de perfil de quien ha solicitado unirse, para pintar el avatar real
  // en la lista de solicitudes (en vez de solo iniciales). userId+accessHash
  // vienen tal cual los dio /join-requests - no hace falta que el fan esté en
  // los dialogos de la cuenta, un InputUser con su accessHash es suficiente
  // para pedirle la foto a Telegram. 404 si no tiene foto puesta.
  app.get("/api/accounts/:id/free-channels/requester-avatar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as { userId?: string; accessHash?: string };
    if (!q.userId || !q.accessHash) return reply.code(400).send();
    const cacheKey = `avatar:${id}:req:${q.userId}`;
    const cached = getCachedMedia(cacheKey);
    if (cached) {
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=1800");
      return reply.send(cached);
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const inputUser = new Api.InputUser({ userId: q.userId as any, accessHash: q.accessHash as any });
      const buf = (await client.downloadProfilePhoto(inputUser, { isBig: false })) as Buffer | undefined;
      if (!buf || buf.length === 0) return reply.code(404).send();
      setCachedMedia(cacheKey, buf);
      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=1800");
      return reply.send(buf);
    } catch (err) {
      return reply.code(404).send();
    }
  });

  // Aceptar/rechazar UNA solicitud concreta.
  app.post("/api/accounts/:id/free-channels/:channelId/join-requests/decide", async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string };
    const body = request.body as { userId?: string; accessHash?: string; approve?: boolean };
    if (!body.userId || !body.accessHash || body.approve === undefined) {
      return reply.code(400).send({ error: "Faltan datos de la solicitud" });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const channel = await prisma.freeChannel.findUnique({ where: { id: channelId } });
    if (!channel || channel.accountId !== id) return reply.code(404).send({ error: "Canal no encontrado" });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveEntityById(client, channel.chatId);
      const peer = await client.getInputEntity(entity);
      const inputUser = new Api.InputUser({ userId: body.userId as any, accessHash: body.accessHash as any });
      await client.invoke(new Api.messages.HideChatJoinRequest({ peer, userId: inputUser, approved: body.approve }));
      return { ok: true };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudo resolver la solicitud." });
    }
  });

  // Aceptar en bloque: procesa un lote (hasta 200) por llamada -pedir de
  // golpe miles de solicitudes podria tardar minutos y arriesgar la
  // conexion-, el panel repite la llamada mientras hasMore sea true.
  app.post("/api/accounts/:id/free-channels/:channelId/join-requests/accept-all", async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const channel = await prisma.freeChannel.findUnique({ where: { id: channelId } });
    if (!channel || channel.accountId !== id) return reply.code(404).send({ error: "Canal no encontrado" });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveEntityById(client, channel.chatId);
      const peer = await client.getInputEntity(entity);
      const result: any = await client.invoke(new Api.messages.GetChatInviteImporters({ peer, requested: true, limit: 200 }));
      const usersById = new Map<string, any>((result.users || []).map((u: any) => [String(u.id), u]));
      const importers = result.importers || [];
      let accepted = 0;
      for (const imp of importers) {
        const u = usersById.get(String(imp.userId));
        if (!u || u.accessHash === undefined) continue;
        try {
          const inputUser = new Api.InputUser({ userId: u.id, accessHash: u.accessHash });
          await client.invoke(new Api.messages.HideChatJoinRequest({ peer, userId: inputUser, approved: true }));
          accepted++;
        } catch {
          // seguimos con el siguiente aunque uno falle
        }
      }
      return { accepted, hasMore: importers.length >= 200 };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudieron aceptar las solicitudes." });
    }
  });

  // Rechazar en bloque: mismo patron que accept-all pero con approved:false.
  app.post("/api/accounts/:id/free-channels/:channelId/join-requests/reject-all", async (request, reply) => {
    const { id, channelId } = request.params as { id: string; channelId: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const channel = await prisma.freeChannel.findUnique({ where: { id: channelId } });
    if (!channel || channel.accountId !== id) return reply.code(404).send({ error: "Canal no encontrado" });
    try {
      const client = await getAccountClient(account);
      const entity = await resolveEntityById(client, channel.chatId);
      const peer = await client.getInputEntity(entity);
      const result: any = await client.invoke(new Api.messages.GetChatInviteImporters({ peer, requested: true, limit: 200 }));
      const usersById = new Map<string, any>((result.users || []).map((u: any) => [String(u.id), u]));
      const importers = result.importers || [];
      let rejected = 0;
      for (const imp of importers) {
        const u = usersById.get(String(imp.userId));
        if (!u || u.accessHash === undefined) continue;
        try {
          const inputUser = new Api.InputUser({ userId: u.id, accessHash: u.accessHash });
          await client.invoke(new Api.messages.HideChatJoinRequest({ peer, userId: inputUser, approved: false }));
          rejected++;
        } catch {
          // seguimos con el siguiente aunque uno falle
        }
      }
      return { rejected, hasMore: importers.length >= 200 };
    } catch (err: any) {
      request.log.error(err);
      return reply.code(502).send({ error: err?.errorMessage || err?.message || "No se pudieron rechazar las solicitudes." });
    }
  });
}
