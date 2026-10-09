import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { closeAccountClient, getAccountConnectionStatus } from "../telegram/connectionPool";
import { clearDialogsCache } from "../telegram/dialogsCache";
import { syncSubscriptionQuantity } from "./subscription";
import { nowInTimezone, toMinutes } from "../engine/fixedEngine";
import { agencyIdFromRequest } from "../utils/agencyContext";

/**
 * Rutas para gestionar cuentas ya dadas de alta (el login inicial de una
 * cuenta nueva sigue haciendose por Terminal con loginCli.ts, porque
 * requiere el codigo OTP de Telegram). Desde aqui se puede: ver el listado,
 * ver el detalle, encender/apagar el interruptor maestro y ajustar la
 * configuracion anti-baneo / notificaciones.
 */
export async function registerAccountRoutes(app: FastifyInstance) {
  app.get("/api/accounts", async (request) => {
    const accounts = await prisma.account.findMany({
      where: { agencyId: await agencyIdFromRequest(request) },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        label: true,
        phoneNumber: true,
        timezone: true,
        reenviadorEnabled: true,
        health: true,
        peerFloodUntil: true,
        notifyWhatsAppTo: true,
        extraMessageFolders: true,
        sfsFolder: true,
        sfsGroupChatId: true,
        sfsGroupTitle: true,
        createdAt: true,
        _count: { select: { campaigns: true, sourceGroups: true } },
      },
    });
    // connectionStatus: ver comentario de getAccountConnectionStatus - es el
    // estado real del proceso ahora mismo, no el campo "health" de la fila
    // (que puede llevar horas sin reflejar una sesion caida de verdad).
    return { accounts: accounts.map((a) => ({ ...a, connectionStatus: getAccountConnectionStatus(a.id) })) };
  });

  app.get("/api/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    return { account };
  });

  app.patch("/api/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as Partial<{
      reenviadorEnabled: boolean;
      timezone: string;
      notifyWhatsAppTo: string | null;
      peerFloodPauseMinutes: number;
      softStartCycles: number;
      firstCycleSendCap: number;
      firstCycleLinkFraction: number;
      missedSlotToleranceMinutes: number;
      extraMessageFolders: string[];
      sfsFolder: string | null;
      sfsGroupChatId: string | null;
      sfsGroupTitle: string | null;
    }>;

    const data: Record<string, unknown> = { ...body };
    if (Array.isArray(body.extraMessageFolders)) {
      data.extraMessageFolders = JSON.stringify(body.extraMessageFolders.filter((v) => !!v && v.trim()));
    }

    const account = await prisma.account.update({ where: { id }, data });

    if (body.extraMessageFolders !== undefined) {
      // Cambian que chats/grupos aparecen en "Mensajes": invalidamos la
      // cache para que se note al instante, sin esperar al refresco de fondo.
      clearDialogsCache(id);
    }

    if (body.reenviadorEnabled !== undefined) {
      await prisma.sendLog.create({
        data: {
          accountId: id,
          level: "INFO",
          message: body.reenviadorEnabled
            ? "Interruptor maestro ENCENDIDO desde el panel"
            : "Interruptor maestro APAGADO desde el panel",
        },
      });
    }

    return { account };
  });

  // Elimina por completo una cuenta (modelo) del panel: cierra su conexion
  // de Telegram si estaba abierta y borra en cascada sus origenes,
  // campañas, destinos y logs. No hay vuelta atras.
  app.delete("/api/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.account.findUnique({ where: { id } });
    if (!existing) {
      reply.code(404).send({ error: "Cuenta no encontrada" });
      return;
    }
    await closeAccountClient(id);
    const agencyId = existing.agencyId;
    await prisma.account.delete({ where: { id } });
    // Suscripción: una modelo menos - se ajusta la cantidad de la
    // suscripción de Stripe si esta agencia ya tiene un plan activo (ver
    // syncSubscriptionQuantity en api/subscription.ts). Fire-and-forget.
    syncSubscriptionQuantity(agencyId).catch(() => {});
    return { ok: true };
  });

  // Calcula el proximo horario de envio programado (modo Horarios fijos)
  // para esta cuenta, en SU zona horaria - lo que se le pide al reenviador
  // no es "que envie ya", es que respete estos horarios, asi que este
  // calculo tiene que reflejar exactamente lo mismo que usa runFixedScheduleTick:
  // entre todos los slots ACTIVOS de campañas ACTIVAS, se descartan los que
  // ya se procesaron hoy (tienen un ScheduleSlotRun para la fecha de hoy en
  // la timezone de la cuenta), y de los que quedan se elige el mas proximo:
  // si hay alguno cuya hora es igual o posterior a la hora actual, ese es el
  // siguiente de hoy; si no queda ninguno, el siguiente es el mas temprano
  // de mañana (el ciclo vuelve a empezar).
  app.get("/api/accounts/:id/next-send", async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findUniqueOrThrow({ where: { id } });
    const { date: today, minutesSinceMidnight: nowMin } = nowInTimezone(account.timezone);

    const campaigns = await prisma.campaign.findMany({
      where: { accountId: id, status: "ACTIVE", scheduleMode: "FIXED" },
      include: { scheduleSlots: { where: { active: true } } },
    });

    const allSlots = campaigns.flatMap((c) =>
      c.scheduleSlots.map((s) => ({ slotId: s.id, timeOfDay: s.timeOfDay, folderName: c.folderName }))
    );
    if (allSlots.length === 0) {
      return { nextSend: null, timezone: account.timezone, reason: "sin_horarios" };
    }

    const runsToday = await prisma.scheduleSlotRun.findMany({
      where: { scheduleSlotId: { in: allSlots.map((s) => s.slotId) }, runDate: today },
      select: { scheduleSlotId: true },
    });
    const doneToday = new Set(runsToday.map((r) => r.scheduleSlotId));
    const pending = allSlots.filter((s) => !doneToday.has(s.slotId));

    const todaySlots = pending.filter((s) => toMinutes(s.timeOfDay) >= nowMin).sort((a, b) => toMinutes(a.timeOfDay) - toMinutes(b.timeOfDay));
    if (todaySlots.length > 0) {
      const next = todaySlots[0];
      return { nextSend: { timeOfDay: next.timeOfDay, folderName: next.folderName, when: "hoy" }, timezone: account.timezone };
    }

    // Nada pendiente ya hoy (todos con hora ya pasada, o ya procesados):
    // mañana el dia vuelve a empezar para TODOS los slots activos (el
    // ScheduleSlotRun es por fecha), asi que el siguiente real es el mas
    // temprano de mañana entre TODOS los slots activos, no solo "pending".
    const tomorrow = [...allSlots].sort((a, b) => toMinutes(a.timeOfDay) - toMinutes(b.timeOfDay))[0];
    return { nextSend: { timeOfDay: tomorrow.timeOfDay, folderName: tomorrow.folderName, when: "mañana" }, timezone: account.timezone };
  });
}
