"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAccountRoutes = registerAccountRoutes;
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const dialogsCache_1 = require("../telegram/dialogsCache");
const fixedEngine_1 = require("../engine/fixedEngine");
const agencyContext_1 = require("../utils/agencyContext");
/**
 * Rutas para gestionar cuentas ya dadas de alta (el login inicial de una
 * cuenta nueva sigue haciendose por Terminal con loginCli.ts, porque
 * requiere el codigo OTP de Telegram). Desde aqui se puede: ver el listado,
 * ver el detalle, encender/apagar el interruptor maestro y ajustar la
 * configuracion anti-baneo / notificaciones.
 */
async function registerAccountRoutes(app) {
    app.get("/api/accounts", async (request) => {
        const accounts = await prisma_1.prisma.account.findMany({
            where: { agencyId: await (0, agencyContext_1.agencyIdFromRequest)(request) },
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
        return { accounts };
    });
    app.get("/api/accounts/:id", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        return { account };
    });
    app.patch("/api/accounts/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const data = { ...body };
        if (Array.isArray(body.extraMessageFolders)) {
            data.extraMessageFolders = JSON.stringify(body.extraMessageFolders.filter((v) => !!v && v.trim()));
        }
        const account = await prisma_1.prisma.account.update({ where: { id }, data });
        if (body.extraMessageFolders !== undefined) {
            // Cambian que chats/grupos aparecen en "Mensajes": invalidamos la
            // cache para que se note al instante, sin esperar al refresco de fondo.
            (0, dialogsCache_1.clearDialogsCache)(id);
        }
        if (body.reenviadorEnabled !== undefined) {
            await prisma_1.prisma.sendLog.create({
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
        const { id } = request.params;
        const existing = await prisma_1.prisma.account.findUnique({ where: { id } });
        if (!existing) {
            reply.code(404).send({ error: "Cuenta no encontrada" });
            return;
        }
        await (0, connectionPool_1.closeAccountClient)(id);
        await prisma_1.prisma.account.delete({ where: { id } });
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
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        const { date: today, minutesSinceMidnight: nowMin } = (0, fixedEngine_1.nowInTimezone)(account.timezone);
        const campaigns = await prisma_1.prisma.campaign.findMany({
            where: { accountId: id, status: "ACTIVE", scheduleMode: "FIXED" },
            include: { scheduleSlots: { where: { active: true } } },
        });
        const allSlots = campaigns.flatMap((c) => c.scheduleSlots.map((s) => ({ slotId: s.id, timeOfDay: s.timeOfDay, folderName: c.folderName })));
        if (allSlots.length === 0) {
            return { nextSend: null, timezone: account.timezone, reason: "sin_horarios" };
        }
        const runsToday = await prisma_1.prisma.scheduleSlotRun.findMany({
            where: { scheduleSlotId: { in: allSlots.map((s) => s.slotId) }, runDate: today },
            select: { scheduleSlotId: true },
        });
        const doneToday = new Set(runsToday.map((r) => r.scheduleSlotId));
        const pending = allSlots.filter((s) => !doneToday.has(s.slotId));
        const todaySlots = pending.filter((s) => (0, fixedEngine_1.toMinutes)(s.timeOfDay) >= nowMin).sort((a, b) => (0, fixedEngine_1.toMinutes)(a.timeOfDay) - (0, fixedEngine_1.toMinutes)(b.timeOfDay));
        if (todaySlots.length > 0) {
            const next = todaySlots[0];
            return { nextSend: { timeOfDay: next.timeOfDay, folderName: next.folderName, when: "hoy" }, timezone: account.timezone };
        }
        // Nada pendiente ya hoy (todos con hora ya pasada, o ya procesados):
        // mañana el dia vuelve a empezar para TODOS los slots activos (el
        // ScheduleSlotRun es por fecha), asi que el siguiente real es el mas
        // temprano de mañana entre TODOS los slots activos, no solo "pending".
        const tomorrow = [...allSlots].sort((a, b) => (0, fixedEngine_1.toMinutes)(a.timeOfDay) - (0, fixedEngine_1.toMinutes)(b.timeOfDay))[0];
        return { nextSend: { timeOfDay: tomorrow.timeOfDay, folderName: tomorrow.folderName, when: "mañana" }, timezone: account.timezone };
    });
}
//# sourceMappingURL=accounts.js.map