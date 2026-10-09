import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "../telegram/connectionPool";
import { listAccountFolders } from "../telegram/folders";

/** Igual que Promise.all, pero como mucho CONCURRENCY llamadas de Telegram a
 * la vez: una carpeta puede tener decenas de chats, y pedirle a Telegram su
 * entidad una por una (en serie) es lo que hacia que aplicar el filtro de
 * carpeta en SFS se notase lento. En paralelo total tampoco conviene -
 * demasiadas peticiones de golpe puede disparar un FLOOD_WAIT de Telegram -
 * asi que se procesan en tandas pequeñas. */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
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
const folderChatsCache = new Map<string, { at: number; chats: { chatId: string; title: string; isForum: boolean }[] }>();
const FOLDER_CHATS_CACHE_MS = 2 * 60 * 1000;

/**
 * Lee en vivo (via GramJS) las carpetas de Telegram de una cuenta, para que
 * el panel pueda ofrecer un selector real en vez de que el usuario tenga
 * que escribir el nombre exacto a mano. Se resuelve el numero de chats de
 * cada carpeta sin resolver cada entidad (mas rapido), usando el tamaño de
 * chatIds ya presente en el filtro de Telegram.
 */
export async function registerTelegramFolderRoutes(app: FastifyInstance) {
  app.get("/api/accounts/:id/telegram-folders", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const folders = await listAccountFolders(client);
      return {
        folders: folders.map((f) => ({ title: f.title, chatCount: f.chatIds.length })),
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo conectar con Telegram para leer las carpetas. Intenta de nuevo en unos segundos." });
    }
  });

  // Chats dentro de una carpeta concreta (para autocompletar destinos al crear una campaña)
  app.get("/api/accounts/:id/telegram-folders/:folderName/chats", async (request, reply) => {
    const { id, folderName } = request.params as { id: string; folderName: string };
    const q = request.query as { force?: string };
    const decodedFolder = decodeURIComponent(folderName);
    const cacheKey = `${id}:${decodedFolder.toLowerCase()}`;
    const cached = folderChatsCache.get(cacheKey);
    if (!q.force && cached && Date.now() - cached.at < FOLDER_CHATS_CACHE_MS) {
      return { chats: cached.chats };
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    try {
      const client = await getAccountClient(account);
      const folders = await listAccountFolders(client);
      const match = folders.find((f) => f.title.toLowerCase() === decodedFolder.toLowerCase());
      if (!match) return reply.code(404).send({ error: "Carpeta no encontrada" });

      const resolveAll = async (ids: string[]) =>
        mapWithConcurrency(ids, 6, async (chatId) => {
          try {
            const entity = await client.getEntity(chatId);
            const title = (entity as any).title ?? (entity as any).username ?? (entity as any).firstName ?? String(chatId);
            const isForum = (entity as any).forum === true;
            return { chatId: String(chatId), title, isForum };
          } catch {
            return { chatId: String(chatId), title: "(no se pudo resolver)", isForum: false };
          }
        });

      let chats = await resolveAll(match.chatIds);

      // Un chat "(no se pudo resolver)" normalmente no es un chat roto de
      // verdad, sino que GramJS todavia no tiene el access_hash de ese chat
      // en su cache local (le pasa sobre todo justo despues de un deploy/
      // reinicio del servidor, con la cache de entidades en frio, o con
      // chats privados que esta cuenta no ha "visto" recientemente) - mismo
      // fallo que ya se arreglo para el envio del Reenviador (ver
      // resolveChatEntity en sender.ts). Antes se intentaba refrescar UNA
      // vez con un limite de 400 dialogos, que se quedaba corto justo en el
      // caso que mas falla (cuenta recien reiniciada, con decenas/cientos
      // de chats sin resolver) - "creaba la campaña bien, pero con menos
      // destinos de los que tenia la carpeta de verdad". Ahora se reintenta
      // en un par de rondas con un limite mucho mayor, y solo si de verdad
      // no hay manera se deja lo que quede sin resolver (y se avisa, en vez
      // de desaparecer en silencio - ver unresolvedCount en la respuesta).
      for (const dialogsLimit of [800, 3000]) {
        const unresolved = chats.filter((c) => c.title === "(no se pudo resolver)").map((c) => c.chatId);
        if (unresolved.length === 0) break;
        try {
          await client.getDialogs({ limit: dialogsLimit });
        } catch {
          // el refresco de dialogos en si fallo (cuenta desconectada, etc.) - se deja lo que ya se tenia
          break;
        }
        const retried = await resolveAll(unresolved);
        const retriedById = new Map(retried.map((r) => [r.chatId, r]));
        chats = chats.map((c) => retriedById.get(c.chatId) ?? c);
      }

      const unresolvedCount = chats.filter((c) => c.title === "(no se pudo resolver)").length;
      folderChatsCache.set(cacheKey, { at: Date.now(), chats });
      return { chats, unresolvedCount };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "No se pudo leer la carpeta desde Telegram." });
    }
  });
}
