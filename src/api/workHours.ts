import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { getWorkerFromRequest, getOwnerSessionFromRequest } from "../utils/auth";
import { agencyIdFromRequest } from "../utils/agencyContext";
import { noteWorkerHeartbeatForClock } from "./clock";

/**
 * Informes → Horas trabajadas (como en TeleCrew): un latido cada ~30s desde
 * el navegador de cada trabajador mientras tiene Mensajes/Mensajes Pro
 * abierto (ver heartbeat más abajo). A partir de esos latidos se
 * reconstruyen, por trabajador y rango de fechas:
 *  - Horas trabajadas: suma de la duración de cada "sesión" (tramo de
 *    latidos sin huecos mayores que el umbral de "desconectado").
 *  - Inactivo con fans esperando / sin nada que responder: dentro de una
 *    sesión, tiempo entre latidos marcados "active: false", repartido
 *    según si en ese momento tenía algún fan con mensajes sin leer.
 *  - Sesiones: nº de tramos. Desconexiones: nº de huecos que cerraron una
 *    sesión y abrieron la siguiente (sesiones - 1).
 * Nada de esto toca el motor de reenvío/campañas.
 */

const DEFAULT_DISCONNECT_MINUTES = 10;
const DEFAULT_BREAK_MINUTES = 30;

// Informes es de "las demás opciones" reservadas al dueño/jefe (la cuenta
// luxe, con OWNER_COOKIE) - ni un Team líder ni un Chatter llegan aquí (en
// la práctica tampoco podrían: init() en app.js ya manda a cualquier
// trabajador, sea el rol que sea, a renderWorkerRestrictedShell y nunca al
// panel completo donde vive Informes).
async function requireAdmin(request: any, reply: any) {
  if (getOwnerSessionFromRequest(request)) return;
  reply.code(403).send({ error: "Solo el dueño puede ver esto." });
  return reply;
}

// Multi-agencia: AppSetting es una tabla genérica clave-valor sin agencyId
// propio (ver comentario de JAP_NOTES_KEY en jap.ts) - se namespacea la
// clave con el id de la agencia delante, en vez de tocar el esquema de una
// tabla que comparten varios ajustes sueltos distintos.
function workHoursSettingKeys(agencyId: string) {
  return {
    disconnect: `${agencyId}:workHours.disconnectMinutes`,
    breakKey: `${agencyId}:workHours.breakMinutes`,
  };
}

// Exportada para que api/performance.ts (rendimiento personal, ver ese
// fichero) pueda calcular las mismas horas/sesiones/desconexiones que
// Informes → Horas trabajadas, sin duplicar la lógica ni los ajustes
// (minutos de "desconectado"/"pausa") de aquí.
export async function getSettings(agencyId: string) {
  const { disconnect, breakKey } = workHoursSettingKeys(agencyId);
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [disconnect, breakKey] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const disconnectMinutes = Number(map.get(disconnect)) || DEFAULT_DISCONNECT_MINUTES;
  const breakMinutes = Number(map.get(breakKey)) || DEFAULT_BREAK_MINUTES;
  return { disconnectMinutes, breakMinutes };
}

function startOfDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Reconstruye sesiones/inactividad/desconexiones de un trabajador a partir
 * de sus latidos, ya ordenados por fecha ascendente.
 *
 * "Horas trabajadas" cuenta SOLO los tramos entre dos latidos donde el
 * propio navegador marcó "active: true" (ha habido un click/tecla en los
 * últimos ~35s) - antes se sumaba toda la sesión de un tirón (desde el
 * primer hasta el último latido, estuviera activo o no), así que un
 * chatter con la pestaña abierta pero sin tocar nada contaba igual como
 * "trabajado". Los tramos "active: false" siguen sin contar como
 * trabajado; en su lugar van a idleWithFans/idleNoFans como hasta ahora
 * (con el mismo perdón de "pausa" diaria). */
export function summarizePings(pings: { at: Date; active: boolean; hasUnreadFans: boolean }[], disconnectMs: number, breakMsPerDay: number) {
  let workedMs = 0;
  let idleWithFansMs = 0;
  let idleNoFansMs = 0;
  let sessions = 0;
  let disconnections = 0;
  const breakUsedByDay = new Map<string, number>();

  let prev: { at: Date; active: boolean; hasUnreadFans: boolean } | null = null;

  for (const p of pings) {
    if (!prev) {
      sessions += 1;
      prev = p;
      continue;
    }
    const gap = p.at.getTime() - prev.at.getTime();
    if (gap > disconnectMs) {
      // hueco grande: se cierra la sesión anterior y empieza una nueva
      disconnections += 1;
      sessions += 1;
      prev = p;
      continue;
    }
    if (p.active) {
      workedMs += gap;
    } else {
      const day = startOfDay(p.at);
      const usedSoFar = breakUsedByDay.get(day) || 0;
      const remainingBreak = Math.max(0, breakMsPerDay - usedSoFar);
      const forgiven = Math.min(remainingBreak, gap);
      const counted = gap - forgiven;
      if (forgiven > 0) breakUsedByDay.set(day, usedSoFar + forgiven);
      if (p.hasUnreadFans) idleWithFansMs += counted;
      else idleNoFansMs += counted;
    }
    prev = p;
  }

  return {
    workedMs,
    idleWithFansMs,
    idleNoFansMs,
    sessions,
    disconnections,
  };
}

export function msToHm(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

export async function registerWorkHoursRoutes(app: FastifyInstance) {
  // Latido: lo manda el propio navegador del trabajador cada ~30s mientras
  // tiene Mensajes/Mensajes Pro abierto. Solo trabajadores con sesión de
  // Equipo (cookie) - el dueño con Basic Auth no manda esto, no hace falta.
  app.post("/api/workers/heartbeat", async (request, reply) => {
    const worker = await getWorkerFromRequest(request);
    if (!worker) return reply.code(401).send({ error: "No hay sesión de trabajador." });
    const body = request.body as { active?: boolean; hasUnreadFans?: boolean; view?: string; accountId?: string };
    await prisma.workerActivityPing.create({
      data: {
        workerId: worker.id,
        active: !!body.active,
        hasUnreadFans: !!body.hasUnreadFans,
      },
    });
    // "Sin fichar": cada latido es también la señal de "sigue activo en el
    // CRM" que usa el aviso al dueño si no ha fichado la entrada (ver
    // clock.ts) - no bloquea la respuesta del latido si algo fallara aquí.
    noteWorkerHeartbeatForClock(worker, (body.view || "desconocido").slice(0, 60), body.accountId || null).catch(() => {});
    return { ok: true };
  });

  app.get("/api/work-hours/settings", { preHandler: requireAdmin }, async (request) => {
    return getSettings(await agencyIdFromRequest(request));
  });

  app.patch("/api/work-hours/settings", { preHandler: requireAdmin }, async (request) => {
    const body = request.body as { disconnectMinutes?: number; breakMinutes?: number };
    const agencyId = await agencyIdFromRequest(request);
    const { disconnect, breakKey } = workHoursSettingKeys(agencyId);
    if (body.disconnectMinutes !== undefined) {
      await prisma.appSetting.upsert({
        where: { key: disconnect },
        update: { value: String(body.disconnectMinutes) },
        create: { key: disconnect, value: String(body.disconnectMinutes) },
      });
    }
    if (body.breakMinutes !== undefined) {
      await prisma.appSetting.upsert({
        where: { key: breakKey },
        update: { value: String(body.breakMinutes) },
        create: { key: breakKey, value: String(body.breakMinutes) },
      });
    }
    return getSettings(agencyId);
  });

  app.get("/api/work-hours", { preHandler: requireAdmin }, async (request) => {
    const q = request.query as { workerId?: string; from?: string; to?: string };
    const agencyId = await agencyIdFromRequest(request);
    const { disconnectMinutes, breakMinutes } = await getSettings(agencyId);
    const disconnectMs = disconnectMinutes * 60 * 1000;
    const breakMsPerDay = breakMinutes * 60 * 1000;

    const from = q.from ? new Date(q.from + "T00:00:00") : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = q.to ? new Date(q.to + "T23:59:59.999") : new Date();

    const workers = await prisma.worker.findMany({
      where: q.workerId ? { id: q.workerId, agencyId } : { agencyId },
      orderBy: { createdAt: "asc" },
    });

    const rows = [];
    for (const w of workers) {
      const pings = await prisma.workerActivityPing.findMany({
        where: { workerId: w.id, at: { gte: from, lte: to } },
        orderBy: { at: "asc" },
        select: { at: true, active: true, hasUnreadFans: true },
      });
      const summary = summarizePings(pings, disconnectMs, breakMsPerDay);
      rows.push({
        workerId: w.id,
        workerName: w.name,
        hoursWorked: msToHm(summary.workedMs),
        idleWithFans: msToHm(summary.idleWithFansMs),
        idleNoFans: msToHm(summary.idleNoFansMs),
        sessions: summary.sessions,
        disconnections: summary.disconnections,
      });
    }
    return { rows };
  });
}
