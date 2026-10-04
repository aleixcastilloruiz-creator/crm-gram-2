import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { getOwnerSessionFromRequest, getWorkerFromRequest } from "../utils/auth";
import { agencyIdFromRequest } from "../utils/agencyContext";
import { getSettings as getWorkHoursSettings, summarizePings, msToHm } from "./workHours";

/**
 * "Rendimiento personal": una foto del trabajo de un chatter en un periodo
 * (ventas, horas/conexión, mensajes enviados, comparación con el periodo
 * anterior), reutilizando exactamente los mismos cálculos que ya existen
 * repartidos en Informes (Rendimiento de chatters, Horas trabajadas) en vez
 * de duplicarlos con otra lógica. Se ve en DOS sitios:
 *  - El propio trabajador, en su panel restringido ("Mi rendimiento"):
 *    GET /api/performance/mine, solo de SUS propios datos.
 *  - El dueño/jefe, desde Configuración → Equipo (un botón "Rendimiento"
 *    por fila): GET /api/performance/:workerId, de cualquier trabajador de
 *    SU agencia.
 */

// Mismo candado que Configuración → Equipo (ver requireOwnerOrAdminWorker en
// workers.ts): solo la cuenta luxe (dueño/jefe) puede ver el rendimiento de
// OTRO trabajador; el propio trabajador solo ve el suyo por /mine, más abajo.
async function requireOwnerOrAdminWorker(request: any, reply: any) {
  if (getOwnerSessionFromRequest(request)) return;
  reply.code(403).send({ error: "Solo el dueño puede ver el rendimiento del equipo." });
  return reply;
}

// Multi-agencia: el trabajador que se quiere consultar (:workerId) tiene que
// ser de la MISMA agencia que quien pregunta - si no, 404 (como si no
// existiera), igual que el mismo chequeo en workers.ts.
async function requireSameAgencyWorker(request: any, reply: any) {
  const { workerId } = request.params as { workerId: string };
  const worker = await prisma.worker.findUnique({ where: { id: workerId }, select: { agencyId: true } });
  const callerAgencyId = await agencyIdFromRequest(request);
  if (!worker || worker.agencyId !== callerAgencyId) {
    reply.code(404).send({ error: "Trabajador no encontrado." });
    return reply;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Sin rango de fechas (el trabajador entra directo a "Mi rendimiento" sin
// elegir nada todavía) se muestran por defecto los últimos 30 días, igual de
// razonable que el resto de vistas de Informes que sí piden el rango a mano.
function resolveRange(q: { from?: string; to?: string }) {
  const to = q.to ? new Date(q.to + "T23:59:59.999") : new Date();
  const from = q.from ? new Date(q.from + "T00:00:00") : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to };
}

/** Calcula ventas + comparación, horas/conexión y mensajes enviados de UN
 * trabajador en un periodo dado, todo ya filtrado a su agencia. */
async function computeWorkerPerformance(worker: { id: string; name: string; agencyId: string }, from: Date, to: Date) {
  const durationMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - durationMs);
  // Mismo criterio que Informes → Rendimiento/Nóminas: "Vendido por" es
  // texto libre, se compara normalizado (minúsculas, sin espacios de más).
  const wanted = worker.name.trim().toLowerCase();

  const [sales, prevSales, messages, { disconnectMinutes, breakMinutes }, pings] = await Promise.all([
    prisma.fanSale.findMany({
      where: { date: { gte: from, lte: to }, account: { agencyId: worker.agencyId } },
      select: { amount: true, soldBy: true },
    }),
    prisma.fanSale.findMany({
      where: { date: { gte: prevFrom, lte: prevTo }, account: { agencyId: worker.agencyId } },
      select: { amount: true, soldBy: true },
    }),
    prisma.chatterMessageLog.findMany({
      where: { sentAt: { gte: from, lte: to }, account: { agencyId: worker.agencyId } },
      select: { workerName: true, responseSeconds: true },
    }),
    getWorkHoursSettings(worker.agencyId),
    prisma.workerActivityPing.findMany({
      where: { workerId: worker.id, at: { gte: from, lte: to } },
      orderBy: { at: "asc" },
      select: { at: true, active: true, hasUnreadFans: true },
    }),
  ]);

  const matchesWorker = (soldBy: string | null) => (soldBy || "").trim().toLowerCase() === wanted;
  const mySales = sales.filter((s) => matchesWorker(s.soldBy));
  const myPrevSales = prevSales.filter((s) => matchesWorker(s.soldBy));

  const ingresos = round2(mySales.reduce((sum, s) => sum + s.amount, 0));
  const prevIngresos = round2(myPrevSales.reduce((sum, s) => sum + s.amount, 0));
  const numVentas = mySales.length;
  const ticketMedio = numVentas > 0 ? round2(ingresos / numVentas) : 0;
  const comparisonPct = prevIngresos > 0 ? round2(((ingresos - prevIngresos) / prevIngresos) * 100) : null;

  const disconnectMs = disconnectMinutes * 60 * 1000;
  const breakMsPerDay = breakMinutes * 60 * 1000;
  const hoursSummary = summarizePings(pings, disconnectMs, breakMsPerDay);

  const myMessages = messages.filter((m) => (m.workerName || "").trim().toLowerCase() === wanted);
  const withResponseTime = myMessages.filter((m) => m.responseSeconds !== null && m.responseSeconds !== undefined);
  const avgResponseSeconds =
    withResponseTime.length > 0
      ? Math.round(withResponseTime.reduce((sum, m) => sum + (m.responseSeconds || 0), 0) / withResponseTime.length)
      : null;

  return {
    period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    ventas: { ingresos, numVentas, ticketMedio },
    comparison: { prevIngresos, comparisonPct },
    horas: {
      hoursWorked: msToHm(hoursSummary.workedMs),
      hoursWorkedMs: hoursSummary.workedMs,
      sessions: hoursSummary.sessions,
      disconnections: hoursSummary.disconnections,
    },
    mensajes: { total: myMessages.length, avgResponseSeconds },
  };
}

export async function registerPerformanceRoutes(app: FastifyInstance) {
  // Apartado propio del trabajador en su panel restringido ("Mi
  // rendimiento"): solo SUS propios datos, nunca los de un compañero - ni
  // siquiera hace falta el rol admin/Team líder, cualquier Chatter lo ve.
  app.get("/api/performance/mine", async (request, reply) => {
    const worker = await getWorkerFromRequest(request);
    if (!worker) return reply.code(401).send({ error: "Autenticación requerida" });
    const q = request.query as { from?: string; to?: string };
    const { from, to } = resolveRange(q);
    const result = await computeWorkerPerformance(worker, from, to);
    return result;
  });

  // Vista del dueño/jefe desde Configuración → Equipo: el rendimiento de un
  // trabajador CONCRETO de su propia agencia (nunca de otra, ver
  // requireSameAgencyWorker).
  app.get("/api/performance/:workerId", { preHandler: [requireOwnerOrAdminWorker, requireSameAgencyWorker] }, async (request, reply) => {
    const { workerId } = request.params as { workerId: string };
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) return reply.code(404).send({ error: "Trabajador no encontrado." });
    const q = request.query as { from?: string; to?: string };
    const { from, to } = resolveRange(q);
    const result = await computeWorkerPerformance(worker, from, to);
    return { workerName: worker.name, ...result };
  });
}
