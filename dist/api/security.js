"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordNoClockInAlert = recordNoClockInAlert;
exports.registerSecurityRoutes = registerSecurityRoutes;
const prisma_1 = require("../utils/prisma");
const auth_1 = require("../utils/auth");
const agencyContext_1 = require("../utils/agencyContext");
/**
 * "Seguridad → Capturas de pantalla": la app de escritorio (ver carpeta
 * desktop/) intercepta Impr Pant/Alt+Impr Pant a nivel de sistema operativo
 * y, en el momento, manda aquí en qué sección del panel estaba el
 * trabajador (POST /api/security/capture-attempt). El dueño ve el
 * histórico (GET .../capture-attempts) y recibe el aviso EN VIVO si tiene
 * el panel abierto (GET .../stream, Server-Sent Events) - un navegador
 * normal nunca puede detectar esto de forma fiable, así que este endpoint
 * solo lo llama de verdad la app empaquetada (que además necesita pasar
 * isDesktopAppRequest para que el trabajador pueda entrar siquiera, ver
 * utils/auth.ts).
 */
async function requireOwnerOrAdminWorker(request, reply) {
    if ((0, auth_1.getOwnerSessionFromRequest)(request))
        return;
    reply.code(403).send({ error: "Solo el dueño puede ver los avisos de seguridad." });
    return reply;
}
const securityListeners = new Map();
function emitSecurityEvent(agencyId, evt) {
    const set = securityListeners.get(agencyId);
    if (!set || set.size === 0)
        return;
    for (const l of set) {
        try {
            l(evt);
        }
        catch {
            // un listener roto no debe tumbar al resto
        }
    }
}
// Llamado desde clock.ts (noteWorkerHeartbeatForClock) cuando un trabajador
// lleva más de 3 minutos activo en el CRM sin haber fichado la entrada -
// misma forma que un CaptureAttempt (persiste + avisa en vivo), para poder
// reutilizar tal cual el listado y el stream de Seguridad.
async function recordNoClockInAlert(agencyId, workerId, workerName, view, accountId) {
    const alert = await prisma_1.prisma.noClockInAlert.create({
        data: { workerId, agencyId, view, accountId },
    });
    emitSecurityEvent(agencyId, {
        kind: "no_clock_in",
        id: alert.id,
        workerName,
        view: VIEW_LABELS[view] || view,
        accountId: alert.accountId,
        at: alert.at.toISOString(),
    });
}
const VIEW_LABELS = {
    mensajes: "Mensajes",
    "mensajes-pro": "Mensajes Pro",
    sfs: "SFS",
    "programar-posts": "Programar posts",
    pagos: "Pagos",
    nominas: "Nóminas",
    rendimiento: "Mi rendimiento",
};
async function registerSecurityRoutes(app) {
    // Lo llama la app de escritorio en el momento del intento - cualquier
    // trabajador con sesión válida (Chatter o Team líder), sin exigir ningún
    // permiso de sección concreto, porque esto no es "ver contenido", es solo
    // avisar de que se intentó capturar ALGO del panel.
    app.post("/api/security/capture-attempt", async (request, reply) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return reply.code(401).send({ error: "Autenticación requerida" });
        const body = request.body;
        const view = (body.view || "desconocido").slice(0, 60);
        const attempt = await prisma_1.prisma.captureAttempt.create({
            data: {
                workerId: worker.id,
                agencyId: worker.agencyId,
                view,
                accountId: body.accountId || null,
            },
        });
        emitSecurityEvent(worker.agencyId, {
            kind: "capture",
            id: attempt.id,
            workerName: worker.name,
            view: VIEW_LABELS[view] || view,
            accountId: attempt.accountId,
            at: attempt.at.toISOString(),
        });
        return { ok: true };
    });
    // Histórico (Configuración → Seguridad), más reciente primero.
    app.get("/api/security/capture-attempts", { preHandler: requireOwnerOrAdminWorker }, async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const attempts = await prisma_1.prisma.captureAttempt.findMany({
            where: { agencyId },
            orderBy: { at: "desc" },
            take: 200,
            include: { worker: { select: { name: true } } },
        });
        return {
            attempts: attempts.map((a) => ({
                kind: "capture",
                id: a.id,
                workerName: a.worker.name,
                view: VIEW_LABELS[a.view] || a.view,
                accountId: a.accountId,
                at: a.at,
            })),
        };
    });
    // Histórico de avisos "sin fichar" (ver clock.ts/noteWorkerHeartbeatForClock),
    // misma forma que capture-attempts para poder mostrarlos juntos en
    // Configuración → Seguridad.
    app.get("/api/security/no-clock-in-alerts", { preHandler: requireOwnerOrAdminWorker }, async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const alerts = await prisma_1.prisma.noClockInAlert.findMany({
            where: { agencyId },
            orderBy: { at: "desc" },
            take: 200,
            include: { worker: { select: { name: true } } },
        });
        return {
            alerts: alerts.map((a) => ({
                kind: "no_clock_in",
                id: a.id,
                workerName: a.worker.name,
                view: VIEW_LABELS[a.view] || a.view,
                accountId: a.accountId,
                at: a.at,
            })),
        };
    });
    // Aviso en vivo mientras el dueño tiene el panel abierto.
    app.get("/api/security/stream", { preHandler: requireOwnerOrAdminWorker }, async (request, reply) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        reply.raw.write("retry: 2000\n\n");
        let set = securityListeners.get(agencyId);
        if (!set) {
            set = new Set();
            securityListeners.set(agencyId, set);
        }
        const listener = (evt) => {
            reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
        };
        set.add(listener);
        const keepAlive = setInterval(() => {
            try {
                reply.raw.write(": ping\n\n");
            }
            catch { /* conexion cerrada */ }
        }, 20000);
        request.raw.on("close", () => {
            clearInterval(keepAlive);
            set.delete(listener);
            if (set.size === 0)
                securityListeners.delete(agencyId);
        });
    });
}
//# sourceMappingURL=security.js.map