"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerScheduleSlotRoutes = registerScheduleSlotRoutes;
const prisma_1 = require("../utils/prisma");
const fixedEngine_1 = require("../engine/fixedEngine");
const connectionPool_1 = require("../telegram/connectionPool");
const sender_1 = require("../engine/sender");
/**
 * Horarios fijos de una campaña (solo aplica cuando scheduleMode = FIXED):
 * cada fila es "a esta hora, manda el post que hoy ocupa esta posicion
 * entre los mas recientes del origen".
 */
async function registerScheduleSlotRoutes(app) {
    app.get("/api/campaigns/:id/schedule-slots", async (request) => {
        const { id } = request.params;
        const slots = await prisma_1.prisma.scheduleSlot.findMany({
            where: { campaignId: id },
            orderBy: { timeOfDay: "asc" },
        });
        // "Ultimo disparo": la fecha mas reciente en que este horario se marco
        // como "SENT" (se registra una fila por dia en ScheduleSlotRun).
        const slotsWithLastRun = await Promise.all(slots.map(async (slot) => {
            const lastRun = await prisma_1.prisma.scheduleSlotRun.findFirst({
                where: { scheduleSlotId: slot.id, status: "SENT" },
                orderBy: { runDate: "desc" },
            });
            return { ...slot, lastRunDate: lastRun?.runDate ?? null };
        }));
        return { slots: slotsWithLastRun };
    });
    // "+ Añadir todos los horarios": crea un horario por hora (00:00, 01:00,
    // ...) cubriendo todo el dia, repartiendo posiciones 1..distinctMessages
    // en orden (dando la vuelta si hacen falta mas horas que mensajes).
    // Sustituye los horarios que ya tuviera la campaña.
    app.post("/api/campaigns/:id/schedule-slots/bulk-generate", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({
            where: { id },
            include: { sourceGroup: true },
        });
        const distinctMessages = body.distinctMessages ?? campaign.minForeignMessagesBeforeRepeat ?? campaign.sourceGroup.recentLimit ?? 25;
        const generated = (0, fixedEngine_1.generateFixedSchedule)({
            intervalMinutes: body.intervalMinutes ?? 60,
            from: body.from ?? "00:00",
            to: body.to ?? "23:00",
            distinctMessages: distinctMessages > 0 ? distinctMessages : 25,
        });
        await prisma_1.prisma.scheduleSlot.deleteMany({ where: { campaignId: id } });
        await prisma_1.prisma.scheduleSlot.createMany({
            data: generated.map((s) => ({ campaignId: id, timeOfDay: s.timeOfDay, position: s.position })),
        });
        const slots = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: id }, orderBy: { timeOfDay: "asc" } });
        return { slots };
    });
    // Detecta de verdad, leyendo Telegram ahora mismo, cuantos posts
    // distintos (foto/fotos + texto publicitario, agrupando albumes como 1
    // solo post) hay disponibles en el origen de esta campaña, y un resumen
    // de cada uno para poder elegir "que spam concreto" va en cada horario
    // en vez de adivinar un numero de posicion a ciegas.
    app.get("/api/campaigns/:id/schedule-slots/source-preview", async (request, reply) => {
        const { id } = request.params;
        const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({
            where: { id },
            include: { account: true, sourceGroup: true },
        });
        try {
            const client = await (0, connectionPool_1.getAccountClient)(campaign.account);
            const groups = await (0, sender_1.getRecentSourceMessages)(client, campaign.sourceGroup);
            const messages = groups.map((group, index) => {
                const caption = group.find((m) => m.message)?.message ?? "";
                const mediaCount = group.filter((m) => m.media).length;
                const preview = caption ? caption.replace(/\s+/g, " ").trim().slice(0, 70) : "(sin texto)";
                return { position: index + 1, preview, mediaCount };
            });
            return { messages, recentLimit: campaign.sourceGroup.recentLimit };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo leer el origen desde Telegram para detectar los mensajes." });
        }
    });
    // "Quitar todos": borra todos los horarios de una campaña de golpe.
    app.delete("/api/campaigns/:id/schedule-slots", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.scheduleSlot.deleteMany({ where: { campaignId: id } });
        return { ok: true };
    });
    app.post("/api/campaigns/:id/schedule-slots", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const slot = await prisma_1.prisma.scheduleSlot.create({
            data: {
                campaignId: id,
                timeOfDay: body.timeOfDay,
                position: body.position,
                active: body.active ?? true,
            },
        });
        return { slot };
    });
    app.patch("/api/schedule-slots/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const slot = await prisma_1.prisma.scheduleSlot.update({ where: { id }, data: body });
        return { slot };
    });
    app.delete("/api/schedule-slots/:id", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.scheduleSlot.delete({ where: { id } });
        return { ok: true };
    });
    // Copia todos los horarios de una campaña a otra (mismo uso que "Copiar
    // horarios de otra modelo" del panel de referencia), sustituyendo los que
    // ya tuviera la campaña destino.
    app.post("/api/campaigns/:id/schedule-slots/copy-from/:sourceCampaignId", async (request) => {
        const { id, sourceCampaignId } = request.params;
        const sourceSlots = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: sourceCampaignId } });
        await prisma_1.prisma.scheduleSlot.deleteMany({ where: { campaignId: id } });
        await prisma_1.prisma.scheduleSlot.createMany({
            data: sourceSlots.map((s) => ({
                campaignId: id,
                timeOfDay: s.timeOfDay,
                position: s.position,
                active: s.active,
            })),
        });
        const slots = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: id }, orderBy: { timeOfDay: "asc" } });
        return { slots };
    });
}
//# sourceMappingURL=scheduleSlots.js.map