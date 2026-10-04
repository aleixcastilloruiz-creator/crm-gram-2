"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearNoClockInTracking = clearNoClockInTracking;
exports.noteWorkerHeartbeatForClock = noteWorkerHeartbeatForClock;
exports.registerClockRoutes = registerClockRoutes;
const prisma_1 = require("../utils/prisma");
const auth_1 = require("../utils/auth");
const agencyContext_1 = require("../utils/agencyContext");
const security_1 = require("./security");
// Multi-agencia: mismo criterio de "día" que workHours.ts (summarizePings,
// breakUsedByDay) - se namespacea por fecha UTC, sin depender de la zona
// horaria de cada agencia, para no desincronizar el presupuesto de descanso
// del resto de métricas que ya usan ese mismo corte de día.
function startOfDayUtc(d) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
/** Estado actual (fichado/no, en descanso/no, desde cuándo) a partir de los
 * últimos eventos del trabajador, del más reciente al más antiguo. No hace
 * falta guardar un booleano aparte: el último evento (y el "in"/"out" más
 * cercano hacia atrás) ya lo dice todo. */
function deriveStatus(eventsDesc) {
    let clockedIn = false;
    let clockedInSince = null;
    let onBreak = false;
    let breakSince = null;
    let breakDetermined = false;
    for (const e of eventsDesc) {
        if (!breakDetermined) {
            if (e.type === "break_start") {
                onBreak = true;
                breakSince = e.at;
                breakDetermined = true;
            }
            else if (e.type === "break_end" || e.type === "in" || e.type === "out") {
                breakDetermined = true;
            }
        }
        if (e.type === "out") {
            clockedIn = false;
            break;
        }
        if (e.type === "in") {
            clockedIn = true;
            clockedInSince = e.at;
            break;
        }
    }
    return { clockedIn, clockedInSince, onBreak, breakSince };
}
/** Milisegundos de descanso ya gastados HOY, a partir de los eventos del día
 * en orden ascendente - suma cada tramo break_start→break_end (o hasta
 * ahora mismo si el descanso sigue abierto). */
function computeBreakUsedMs(eventsAsc, now) {
    let used = 0;
    let openStart = null;
    for (const e of eventsAsc) {
        if (e.type === "break_start") {
            openStart = e.at;
        }
        else if (e.type === "break_end" && openStart) {
            used += e.at.getTime() - openStart.getTime();
            openStart = null;
        }
        else if (e.type === "out" && openStart) {
            used += e.at.getTime() - openStart.getTime();
            openStart = null;
        }
    }
    if (openStart)
        used += now.getTime() - openStart.getTime();
    return used;
}
async function getBreakBudgetMinutes(agencyId) {
    const key = `${agencyId}:workHours.breakMinutes`;
    const row = await prisma_1.prisma.appSetting.findUnique({ where: { key } });
    const n = Number(row?.value);
    return n > 0 ? n : 30;
}
async function computeStatus(workerId, agencyId) {
    const now = new Date();
    const recentEvents = await prisma_1.prisma.workerClockEvent.findMany({
        where: { workerId },
        orderBy: { at: "desc" },
        take: 20,
        select: { type: true, at: true },
    });
    const { clockedIn, clockedInSince, onBreak, breakSince } = deriveStatus(recentEvents);
    const todayStart = startOfDayUtc(now);
    const todayEventsAsc = await prisma_1.prisma.workerClockEvent.findMany({
        where: { workerId, at: { gte: todayStart } },
        orderBy: { at: "asc" },
        select: { type: true, at: true },
    });
    const breakBudgetMinutes = await getBreakBudgetMinutes(agencyId);
    const breakUsedMs = computeBreakUsedMs(todayEventsAsc, now);
    const breakUsedMinutes = Math.floor(breakUsedMs / 60000);
    const breakRemainingMinutes = Math.max(0, breakBudgetMinutes - breakUsedMinutes);
    return {
        clockedIn,
        clockedInSince,
        onBreak,
        breakSince,
        breakBudgetMinutes,
        breakUsedMinutes,
        breakRemainingMinutes,
    };
}
// ---------- Aviso "sin fichar" (Seguridad): si un trabajador manda latidos
// de actividad (ver workHours.ts) sin haber fichado, y lleva así más de 3
// minutos seguidos, se avisa al dueño UNA vez (hasta que ficha o deja de
// estar activo). En memoria, como el resto de detectores "en vivo" de la
// app (ver attributionChecked en telegram/liveEvents.ts) - no hace falta
// persistir el seguimiento, solo el aviso final. ----------
const NO_CLOCK_IN_THRESHOLD_MS = 3 * 60 * 1000;
const noClockInTracking = new Map();
function clearNoClockInTracking(workerId) {
    noClockInTracking.delete(workerId);
}
/** Llamado desde el latido de actividad (workHours.ts) en cada ping de un
 * trabajador. Si está fichado, no hace nada (y limpia cualquier
 * seguimiento a medias). Si no lo está, cuenta cuánto lleva así y avisa al
 * dueño la primera vez que se pasa de 3 minutos. */
async function noteWorkerHeartbeatForClock(worker, view, accountId) {
    const events = await prisma_1.prisma.workerClockEvent.findMany({
        where: { workerId: worker.id },
        orderBy: { at: "desc" },
        take: 5,
        select: { type: true, at: true },
    });
    const { clockedIn } = deriveStatus(events);
    if (clockedIn) {
        clearNoClockInTracking(worker.id);
        return;
    }
    const now = Date.now();
    const existing = noClockInTracking.get(worker.id);
    if (!existing) {
        noClockInTracking.set(worker.id, { since: now, alerted: false });
        return;
    }
    if (existing.alerted)
        return;
    if (now - existing.since >= NO_CLOCK_IN_THRESHOLD_MS) {
        existing.alerted = true;
        await (0, security_1.recordNoClockInAlert)(worker.agencyId, worker.id, worker.name, view, accountId);
    }
}
// "Informes → Horas trabajadas" (ver app.js, renderHorasTrabajadasSection)
// es de "las demás opciones" reservadas al dueño/jefe - mismo guardia que
// workHours.ts/requireAdmin.
async function requireAdmin(request, reply) {
    if ((0, auth_1.getOwnerSessionFromRequest)(request))
        return;
    reply.code(403).send({ error: "Solo el dueño puede ver esto." });
    return reply;
}
async function registerClockRoutes(app) {
    // A qué hora ha fichado cada trabajador HOY (Informes → Horas trabajadas):
    // estado actual + desde cuándo, para todos los trabajadores de la
    // agencia de un vistazo - no hace falta pedirlo uno a uno.
    app.get("/api/clock/team", { preHandler: requireAdmin }, async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const workers = await prisma_1.prisma.worker.findMany({
            where: { agencyId },
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true },
        });
        const rows = [];
        for (const w of workers) {
            const status = await computeStatus(w.id, agencyId);
            rows.push({ workerId: w.id, workerName: w.name, ...status });
        }
        return { rows };
    });
    app.get("/api/clock/status", async (request, reply) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return reply.code(401).send({ error: "No hay sesión de trabajador." });
        return computeStatus(worker.id, worker.agencyId);
    });
    app.post("/api/clock/in", async (request, reply) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return reply.code(401).send({ error: "No hay sesión de trabajador." });
        const status = await computeStatus(worker.id, worker.agencyId);
        if (!status.clockedIn) {
            await prisma_1.prisma.workerClockEvent.create({
                data: { workerId: worker.id, agencyId: worker.agencyId, type: "in" },
            });
        }
        clearNoClockInTracking(worker.id);
        return computeStatus(worker.id, worker.agencyId);
    });
    app.post("/api/clock/out", async (request, reply) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return reply.code(401).send({ error: "No hay sesión de trabajador." });
        const status = await computeStatus(worker.id, worker.agencyId);
        if (!status.clockedIn) {
            return reply.code(400).send({ error: "Todavía no habías fichado la entrada." });
        }
        if (status.onBreak) {
            // Se cierra el descanso abierto automáticamente para no dejar un
            // tramo colgado si al trabajador se le olvida volver del break.
            await prisma_1.prisma.workerClockEvent.create({
                data: { workerId: worker.id, agencyId: worker.agencyId, type: "break_end" },
            });
        }
        await prisma_1.prisma.workerClockEvent.create({
            data: { workerId: worker.id, agencyId: worker.agencyId, type: "out" },
        });
        return computeStatus(worker.id, worker.agencyId);
    });
    app.post("/api/clock/break/start", async (request, reply) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return reply.code(401).send({ error: "No hay sesión de trabajador." });
        const status = await computeStatus(worker.id, worker.agencyId);
        if (!status.clockedIn) {
            return reply.code(400).send({ error: "Ficha primero la entrada para poder empezar un descanso." });
        }
        if (status.onBreak) {
            return reply.code(400).send({ error: "Ya tienes un descanso en marcha." });
        }
        if (status.breakRemainingMinutes <= 0) {
            return reply.code(400).send({ error: "Ya has gastado hoy los 30 minutos de descanso." });
        }
        await prisma_1.prisma.workerClockEvent.create({
            data: { workerId: worker.id, agencyId: worker.agencyId, type: "break_start" },
        });
        return computeStatus(worker.id, worker.agencyId);
    });
    app.post("/api/clock/break/end", async (request, reply) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return reply.code(401).send({ error: "No hay sesión de trabajador." });
        const status = await computeStatus(worker.id, worker.agencyId);
        if (!status.onBreak) {
            return reply.code(400).send({ error: "No tienes ningún descanso en marcha." });
        }
        await prisma_1.prisma.workerClockEvent.create({
            data: { workerId: worker.id, agencyId: worker.agencyId, type: "break_end" },
        });
        return computeStatus(worker.id, worker.agencyId);
    });
}
//# sourceMappingURL=clock.js.map