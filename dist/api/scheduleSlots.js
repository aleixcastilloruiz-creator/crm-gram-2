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
// Margen minimo, en minutos, que debe haber entre el horario de una campaña
// y el de CUALQUIER OTRA campaña (carpeta) de la MISMA cuenta. Sin esto, dos
// carpetas configuradas a la misma hora en punto compiten por el mismo tick
// del reenviador y la misma conexion de la cuenta a la vez, lo que hace mas
// facil un PeerFlood y mezcla en la Consola envios de distintas carpetas en
// el mismo instante, dificultando saber cual es cual. Cuentas DISTINTAS no
// chocan entre si (cada una tiene su propia conexion de Telegram), asi que
// esto solo compara horarios dentro de la misma cuenta.
const MIN_GAP_MINUTES = 2;
function toMin(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
}
function minutesToHHmm(total) {
    const t = ((total % 1440) + 1440) % 1440; // da la vuelta a medianoche en cualquier sentido
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
/** Distancia en minutos entre dos horas del dia, dando la vuelta por medianoche si es mas corto (23:59 y 00:00 estan a 1 minuto, no a 1439). */
function circularGapMinutes(a, b) {
    const diff = Math.abs(a - b) % 1440;
    return Math.min(diff, 1440 - diff);
}
/** Todas las horas (en minutos desde medianoche) ya ocupadas por horarios ACTIVOS de otras campañas de la misma cuenta. */
async function existingSlotMinutesForAccount(accountId, excludeCampaignId) {
    const slots = await prisma_1.prisma.scheduleSlot.findMany({
        where: {
            active: true,
            campaign: { accountId, id: { not: excludeCampaignId } },
        },
        select: { timeOfDay: true },
    });
    return slots.map((s) => toMin(s.timeOfDay));
}
/** Si `candidateMin` queda a menos de MIN_GAP_MINUTES de alguna hora ya ocupada, devuelve esa hora (para el mensaje de error); si no hay choque, null. */
function findConflict(candidateMin, existingMinutes) {
    for (const m of existingMinutes) {
        if (circularGapMinutes(candidateMin, m) < MIN_GAP_MINUTES)
            return m;
    }
    return null;
}
/**
 * Busca el menor desplazamiento (en minutos, siempre hacia adelante) que,
 * aplicado a TODOS los horarios candidatos a la vez (para no romper el
 * reparto "cada X minutos" entre ellos), evita que ninguno quede a menos de
 * MIN_GAP_MINUTES de un horario ya ocupado por otra campaña de la cuenta.
 * Ej: si ya hay una carpeta en 08:00/09:00/10:00/11:00 y se genera otra
 * igual, esto encuentra el offset 2 -> 08:02/09:02/10:02/11:02.
 */
function findNonConflictingOffset(candidateMinutesList, existingMinutes) {
    if (existingMinutes.length === 0)
        return 0;
    for (let offset = 0; offset < 1440; offset++) {
        const ok = candidateMinutesList.every((m) => findConflict((m + offset) % 1440, existingMinutes) === null);
        if (ok)
            return offset;
    }
    // En la practica esto solo pasaria con horarios ocupados casi cada 2 min
    // durante las 24h entre TODAS las demas campañas de la cuenta - si aun asi
    // pasara, se deja sin desplazar (mejor eso que bloquear la generacion).
    return 0;
}
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
    //
    // Antes de guardarlos, si otra campaña de la MISMA cuenta ya ocupa alguna
    // de esas horas (o queda a menos de MIN_GAP_MINUTES), se desplaza TODO el
    // lote generado el minimo numero de minutos hacia adelante para que
    // ningun horario choque - así, dos carpetas distintas nunca quedan
    // configuradas exactamente a la misma hora.
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
        const existingMinutes = await existingSlotMinutesForAccount(campaign.accountId, id);
        const generatedMinutes = generated.map((s) => toMin(s.timeOfDay));
        const offsetMinutes = findNonConflictingOffset(generatedMinutes, existingMinutes);
        const finalSlots = generated.map((s, i) => ({
            timeOfDay: minutesToHHmm(generatedMinutes[i] + offsetMinutes),
            position: s.position,
        }));
        await prisma_1.prisma.scheduleSlot.deleteMany({ where: { campaignId: id } });
        await prisma_1.prisma.scheduleSlot.createMany({
            data: finalSlots.map((s) => ({ campaignId: id, timeOfDay: s.timeOfDay, position: s.position })),
        });
        const slots = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: id }, orderBy: { timeOfDay: "asc" } });
        return { slots, appliedOffsetMinutes: offsetMinutes };
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
    // "Desplazar todos los horarios": mueve TODOS los horarios de la campaña
    // el mismo número de minutos (positivo o negativo), sin tocar posiciones
    // ni el estado activo/inactivo de cada uno - solo la hora. Por ejemplo,
    // +30 convierte "cada hora en punto" en "cada hora y media" de una sola
    // vez, sin tener que editar horario por horario. Se hace borrando y
    // recreando en vez de un update por fila, para no chocar con la
    // restriccion de horario unico por campaña si dos horarios desplazados
    // coincidieran a medio camino de la operación.
    //
    // Si el desplazamiento pedido dejaria algun horario a menos de
    // MIN_GAP_MINUTES de otra campaña de la misma cuenta, se rechaza con un
    // error claro en vez de aplicarlo (a diferencia de "Añadir todos los
    // horarios", aqui el usuario pide un desplazamiento concreto, asi que no
    // tiene sentido "corregirselo" solo - mejor que elija otro numero).
    app.post("/api/campaigns/:id/schedule-slots/shift", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const minutes = Number(body.minutes);
        if (!Number.isFinite(minutes) || minutes === 0) {
            return reply.code(400).send({ error: "Indica cuántos minutos desplazar (puede ser negativo)." });
        }
        const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({ where: { id } });
        const slots = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: id } });
        if (slots.length === 0) {
            return reply.code(400).send({ error: "Esta campaña no tiene ningún horario todavía." });
        }
        const shifted = slots.map((s) => {
            const [h, m] = s.timeOfDay.split(":").map(Number);
            let total = ((h * 60 + m + minutes) % 1440 + 1440) % 1440; // da la vuelta a medianoche en cualquier sentido
            const timeOfDay = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
            return { timeOfDay, position: s.position, active: s.active };
        });
        const existingMinutes = await existingSlotMinutesForAccount(campaign.accountId, id);
        for (const s of shifted) {
            if (!s.active)
                continue;
            const conflict = findConflict(toMin(s.timeOfDay), existingMinutes);
            if (conflict !== null) {
                return reply.code(400).send({
                    error: `Ese desplazamiento dejaría un horario a las ${s.timeOfDay}, a menos de ${MIN_GAP_MINUTES} min de otra campaña de esta cuenta (${minutesToHHmm(conflict)}). Prueba con otro número de minutos.`,
                });
            }
        }
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.scheduleSlot.deleteMany({ where: { campaignId: id } }),
            prisma_1.prisma.scheduleSlot.createMany({ data: shifted.map((s) => ({ campaignId: id, ...s })) }),
        ]);
        const updated = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: id }, orderBy: { timeOfDay: "asc" } });
        return { slots: updated };
    });
    // "Quitar todos": borra todos los horarios de una campaña de golpe.
    app.delete("/api/campaigns/:id/schedule-slots", async (request) => {
        const { id } = request.params;
        await prisma_1.prisma.scheduleSlot.deleteMany({ where: { campaignId: id } });
        return { ok: true };
    });
    // Añade un horario suelto a mano. Si la campaña queda activa a esa hora y
    // otra campaña de la MISMA cuenta ya tiene un horario a menos de
    // MIN_GAP_MINUTES, se rechaza (a diferencia del boton "Añadir todos", aqui
    // es una unica hora elegida a mano, asi que lo mas claro es pedirle al
    // usuario que elija otra en vez de movérsela sin que se de cuenta).
    app.post("/api/campaigns/:id/schedule-slots", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const active = body.active ?? true;
        if (active) {
            const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({ where: { id } });
            const existingMinutes = await existingSlotMinutesForAccount(campaign.accountId, id);
            const conflict = findConflict(toMin(body.timeOfDay), existingMinutes);
            if (conflict !== null) {
                return reply.code(400).send({
                    error: `Ya hay otra campaña de esta cuenta con un horario a las ${minutesToHHmm(conflict)}. Deja al menos ${MIN_GAP_MINUTES} min de margen entre carpetas distintas.`,
                });
            }
        }
        const slot = await prisma_1.prisma.scheduleSlot.create({
            data: {
                campaignId: id,
                timeOfDay: body.timeOfDay,
                position: body.position,
                active,
            },
        });
        return { slot };
    });
    // Misma comprobación de margen mínimo que al crear, pero solo cuando el
    // horario resultante vaya a quedar activo Y se esté tocando la hora o el
    // estado activo (editar solo la posición, por ejemplo, no necesita
    // recomprobar nada).
    app.patch("/api/schedule-slots/:id", async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const existing = await prisma_1.prisma.scheduleSlot.findUniqueOrThrow({ where: { id } });
        const newTimeOfDay = body.timeOfDay ?? existing.timeOfDay;
        const newActive = body.active ?? existing.active;
        const touchesRelevantField = body.timeOfDay !== undefined || body.active !== undefined;
        if (newActive && touchesRelevantField) {
            const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({ where: { id: existing.campaignId } });
            const existingMinutes = await existingSlotMinutesForAccount(campaign.accountId, existing.campaignId);
            const conflict = findConflict(toMin(newTimeOfDay), existingMinutes);
            if (conflict !== null) {
                return reply.code(400).send({
                    error: `Ya hay otra campaña de esta cuenta con un horario a las ${minutesToHHmm(conflict)}. Deja al menos ${MIN_GAP_MINUTES} min de margen entre carpetas distintas.`,
                });
            }
        }
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
    // ya tuviera la campaña destino. Si el origen y el destino son de la
    // MISMA cuenta (el caso normal: copiar de una carpeta a otra de la misma
    // modelo), copiar tal cual chocaría siempre con el propio origen - así
    // que, igual que en "Añadir todos los horarios", se desplaza todo el lote
    // copiado el minimo necesario para respetar el margen de MIN_GAP_MINUTES.
    app.post("/api/campaigns/:id/schedule-slots/copy-from/:sourceCampaignId", async (request, reply) => {
        const { id, sourceCampaignId } = request.params;
        const campaign = await prisma_1.prisma.campaign.findUniqueOrThrow({ where: { id }, include: { account: true } });
        // ":sourceCampaignId" es un segundo id en la URL que el guardia general
        // de index.ts NO comprueba (solo mira el primero, el de la campaña
        // destino) - sin esto, cualquier agencia podría copiar los horarios de
        // una campaña de OTRA agencia con solo adivinar/reutilizar su id.
        const sourceCampaign = await prisma_1.prisma.campaign.findUnique({ where: { id: sourceCampaignId }, include: { account: true } });
        if (!sourceCampaign || sourceCampaign.account.agencyId !== campaign.account.agencyId) {
            return reply.code(404).send({ error: "Campaña de origen no encontrada" });
        }
        const sourceSlots = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: sourceCampaignId } });
        const existingMinutes = await existingSlotMinutesForAccount(campaign.accountId, id);
        const sourceMinutes = sourceSlots.map((s) => toMin(s.timeOfDay));
        const offsetMinutes = findNonConflictingOffset(sourceMinutes, existingMinutes);
        await prisma_1.prisma.scheduleSlot.deleteMany({ where: { campaignId: id } });
        await prisma_1.prisma.scheduleSlot.createMany({
            data: sourceSlots.map((s, i) => ({
                campaignId: id,
                timeOfDay: minutesToHHmm(sourceMinutes[i] + offsetMinutes),
                position: s.position,
                active: s.active,
            })),
        });
        const slots = await prisma_1.prisma.scheduleSlot.findMany({ where: { campaignId: id }, orderBy: { timeOfDay: "asc" } });
        return { slots, appliedOffsetMinutes: offsetMinutes };
    });
}
//# sourceMappingURL=scheduleSlots.js.map