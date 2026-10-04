import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { getOwnerSessionFromRequest, getWorkerFromRequest } from "../utils/auth";

/**
 * Reprogramar/borrar un post ya creado (PATCH/DELETE /api/scheduled-posts/
 * :postId) no lleva el id de la CUENTA en la URL, a diferencia de crear/
 * listar (/api/accounts/:id/scheduled-posts) - así que ni el guardia
 * general de index.ts (que solo compara agencias cuando la URL empieza por
 * /api/accounts/:id/...) ni requireSectionAccess("programar-posts") (que
 * solo mira el permiso por cuenta cuando hay un :id en la URL) pueden
 * comprobar aquí nada por su cuenta - haría falta a mano, igual que
 * canAccessPayroll en payroll.ts. El dueño solo puede tocar posts de
 * cuentas de SU agencia; un Team líder (role "admin"), solo si además tiene
 * concedido el permiso "programar-posts" para esa cuenta en concreto (ver
 * Equipo → Permisos) - un Chatter nunca llega aquí, ya bloqueado antes por
 * requireSectionAccess.
 */
async function canManageScheduledPost(request: any, accountId: string, accountAgencyId: string): Promise<boolean> {
  const owner = getOwnerSessionFromRequest(request);
  if (owner) return owner.agencyId === accountAgencyId;
  const worker = await getWorkerFromRequest(request);
  if (!worker || worker.role !== "admin" || worker.agencyId !== accountAgencyId) return false;
  const allowed = await prisma.workerPermission.findUnique({
    where: { workerId_accountId_section: { workerId: worker.id, accountId, section: "programar-posts" } },
  });
  return !!allowed;
}

/**
 * "Programar posts → Canales": convierte una fecha "YYYY-MM-DD" y una hora
 * "HH:mm" tal y como las ve la cuenta (en SU zona horaria, igual que los
 * horarios del Reenviador) al instante UTC real que representan. Hace falta
 * este calculo (y no un simple new Date(`${date}T${time}`)) porque ese
 * constructor usa la zona horaria del SERVIDOR (Railway, normalmente UTC),
 * no la de la cuenta - sin esto, una cuenta en Europe/Madrid programando
 * "18:00" se publicaria en realidad a las 18:00 UTC (20:00 en Madrid).
 *
 * Truco estandar de "doble conversion": se hace una primera suposicion
 * (tratando la hora elegida como si ya fuera UTC), se mira que hora cae esa
 * suposicion en la timezone real de la cuenta, y se corrige la diferencia.
 * Correcto incluso con cambios de horario de verano en el dia elegido.
 */
function zonedWallTimeToUtc(dateStr: string, timeStr: string, timezone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const naiveUtcMs = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(naiveUtcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Intl a veces da hora "24" para la medianoche (sin avanzar el dia a la
  // vez) - antes esto se "arreglaba" con `% 24`, pero eso perdia el dia
  // que le tocaba sumar y podia desviar el calculo 24h en ese caso
  // exacto. Date.UTC ya normaliza el desbordamiento de hora correctamente
  // (hora 24 = hora 0 del dia siguiente) si se le pasa tal cual, sin
  // recortar antes.
  const asIfUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));

  return new Date(naiveUtcMs + (naiveUtcMs - asIfUtcMs));
}

export async function registerScheduledPostRoutes(app: FastifyInstance) {
  // Lista los posts programados de una cuenta (tablas "Canales"/"Historias"
  // del panel). status opcional: PENDING (por defecto), "all" para verlos
  // todos incluidos los ya publicados/fallidos. kind opcional: CHANNEL o
  // STORY - sin el, se devuelven los CHANNEL (para no romper nada que ya
  // llamara a este endpoint antes de que existieran las Historias).
  app.get("/api/accounts/:id/scheduled-posts", async (request) => {
    const { id } = request.params as { id: string };
    const q = request.query as { status?: string; kind?: string };
    const where: any = { accountId: id, kind: q.kind === "STORY" ? "STORY" : "CHANNEL" };
    if (!q.status || q.status === "PENDING") where.status = "PENDING";
    else if (q.status !== "all") where.status = q.status;

    const posts = await prisma.scheduledPost.findMany({
      where,
      orderBy: { scheduledFor: "asc" },
    });
    return { posts };
  });

  // Crea un post programado nuevo. El contenido (messageIds) viene de la
  // boveda de esta cuenta, elegido con el mismo selector que ya se usa para
  // mandar contenido a un fan en Mensajes. kind="STORY" programa una
  // Historia de Telegram (un solo contenido, va al propio perfil, sin
  // "destino"); por defecto (o kind="CHANNEL") programa un post a un
  // canal/grupo, que sí necesita destinationChatId/destinationTitle.
  app.post("/api/accounts/:id/scheduled-posts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      kind?: "CHANNEL" | "STORY";
      destinationChatId?: string;
      destinationTitle?: string;
      messageIds?: (number | string)[];
      previewText?: string;
      date?: string; // "YYYY-MM-DD" en la timezone de la cuenta
      time?: string; // "HH:mm" en la timezone de la cuenta
      storyPrivacy?: "EVERYONE" | "CONTACTS" | "CLOSE_FRIENDS";
      storyPeriodHours?: number;
      storyPinned?: boolean;
    };
    const isStory = body.kind === "STORY";

    if (!isStory && (!body.destinationChatId || !body.destinationTitle)) {
      return reply.code(400).send({ error: "Falta el canal/grupo destino" });
    }
    if (!body.messageIds || body.messageIds.length === 0) {
      return reply.code(400).send({ error: "Elige al menos un contenido de la bóveda" });
    }
    if (isStory && body.messageIds.length > 1) {
      return reply.code(400).send({ error: "Una Historia solo puede llevar un contenido (no se pueden programar álbumes como Historia)." });
    }
    if (!body.date || !body.time) {
      return reply.code(400).send({ error: "Falta la fecha y hora de publicación" });
    }

    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    if (!account.contentGroupChatId) {
      return reply.code(400).send({ error: "Esta cuenta no tiene una bóveda de contenido conectada todavía (Configurar cuenta → Bóveda de contenido)." });
    }

    const scheduledFor = zonedWallTimeToUtc(body.date, body.time, account.timezone);
    if (Number.isNaN(scheduledFor.getTime())) {
      return reply.code(400).send({ error: "Fecha u hora inválida" });
    }

    const validPeriods = [6, 12, 24, 48];
    const storyPeriodHours = validPeriods.includes(Number(body.storyPeriodHours)) ? Number(body.storyPeriodHours) : 24;

    const post = await prisma.scheduledPost.create({
      data: {
        accountId: id,
        kind: isStory ? "STORY" : "CHANNEL",
        destinationChatId: isStory ? "me" : body.destinationChatId!,
        destinationTitle: isStory ? "Historia (mi perfil)" : body.destinationTitle!,
        messageIds: JSON.stringify(body.messageIds.map((m) => Number(m))),
        previewText: (body.previewText || "").slice(0, 500),
        scheduledFor,
        ...(isStory
          ? {
              storyPrivacy: body.storyPrivacy === "CONTACTS" || body.storyPrivacy === "CLOSE_FRIENDS" ? body.storyPrivacy : "EVERYONE",
              storyPeriodHours,
              storyPinned: !!body.storyPinned,
            }
          : {}),
      },
    });
    return { post };
  });

  // Cambia la fecha/hora (o el canal) de un post que todavia no se ha
  // publicado. Si ya esta SENT/FAILED no tiene sentido reprogramarlo.
  app.patch("/api/scheduled-posts/:postId", async (request, reply) => {
    const { postId } = request.params as { postId: string };
    const body = request.body as { date?: string; time?: string; destinationChatId?: string; destinationTitle?: string };
    const existing = await prisma.scheduledPost.findUnique({ where: { id: postId }, include: { account: true } });
    if (!existing) return reply.code(404).send({ error: "No encontrado" });
    if (!(await canManageScheduledPost(request, existing.accountId, existing.account.agencyId))) {
      return reply.code(403).send({ error: "No tienes acceso a este post programado." });
    }
    if (existing.status !== "PENDING") {
      return reply.code(400).send({ error: "Este post ya se procesó, no se puede reprogramar." });
    }

    const data: any = {};
    if (body.destinationChatId) data.destinationChatId = body.destinationChatId;
    if (body.destinationTitle) data.destinationTitle = body.destinationTitle;
    if (body.date && body.time) {
      data.scheduledFor = zonedWallTimeToUtc(body.date, body.time, existing.account.timezone);
    }
    const post = await prisma.scheduledPost.update({ where: { id: postId }, data });
    return { post };
  });

  // Cancela/borra un post programado. Si estaba PENDING, esto es lo mismo
  // que "cancelar" (nunca se llega a publicar); si ya estaba SENT/FAILED,
  // simplemente lo quita de la tabla (equivalente al "Eliminar" del panel).
  app.delete("/api/scheduled-posts/:postId", async (request, reply) => {
    const { postId } = request.params as { postId: string };
    const existing = await prisma.scheduledPost.findUnique({ where: { id: postId }, include: { account: true } });
    if (!existing) return reply.code(404).send({ error: "No encontrado" });
    if (!(await canManageScheduledPost(request, existing.accountId, existing.account.agencyId))) {
      return reply.code(403).send({ error: "No tienes acceso a este post programado." });
    }
    await prisma.scheduledPost.delete({ where: { id: postId } });
    return { ok: true };
  });
}
