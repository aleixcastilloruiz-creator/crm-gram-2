"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopRandomLoop = stopRandomLoop;
exports.startOrchestrator = startOrchestrator;
const prisma_1 = require("../utils/prisma");
const randomEngine_1 = require("./randomEngine");
const fixedEngine_1 = require("./fixedEngine");
const scheduledPostsEngine_1 = require("./scheduledPostsEngine");
const notifications_1 = require("../utils/notifications");
const runningRandomLoops = new Set();
// "Latido" del motor: cada tick de horarios fijos deja constancia de a que
// hora se ejecuto. Si al arrancar el proceso el ultimo latido guardado es
// de hace demasiado (deberia haber uno cada 60s), es que el motor estuvo
// parado un buen rato -por lo que sea: el proceso caido/reiniciandose, un
// fallo que tumbo el servidor entero, Railway durmiendo el servicio... En
// ese caso, antes esto solo se notaba horas despues como "horarios
// perdidos" sueltos en la Consola, sin ningun aviso claro de que habia
// pasado. Con esto, en cuanto el proceso vuelve a arrancar, si detecta un
// hueco se manda un aviso de WhatsApp a todas las cuentas con notificacion
// configurada, para enterarse al momento en vez de descubrirlo horas
// despues revisando logs.
const HEARTBEAT_KEY = "orchestrator.lastTickAt";
const HEARTBEAT_GAP_ALERT_MINUTES = 5; // un tick normal es cada 60s; mas de esto es un hueco real
async function recordHeartbeat() {
    await prisma_1.prisma.appSetting
        .upsert({
        where: { key: HEARTBEAT_KEY },
        update: { value: new Date().toISOString() },
        create: { key: HEARTBEAT_KEY, value: new Date().toISOString() },
    })
        .catch((err) => console.error("[orchestrator] no se pudo guardar el latido:", err));
}
async function checkHeartbeatGapOnStartup() {
    try {
        const row = await prisma_1.prisma.appSetting.findUnique({ where: { key: HEARTBEAT_KEY } });
        if (!row)
            return; // primer arranque de siempre, nada que comparar
        const lastTick = new Date(row.value);
        const gapMinutes = (Date.now() - lastTick.getTime()) / 60_000;
        if (gapMinutes < HEARTBEAT_GAP_ALERT_MINUTES)
            return; // reinicio normal (deploy rapido), sin hueco real
        const hours = Math.floor(gapMinutes / 60);
        const mins = Math.round(gapMinutes % 60);
        const gapText = hours > 0 ? `${hours}h ${mins}min` : `${mins} min`;
        const msg = `⚠️ El reenviador estuvo parado ${gapText} (desde ${lastTick.toLocaleString("es-ES")}). Los horarios fijos que le tocaba mandar en ese hueco se han marcado como "Horario perdido" en la Consola - revisa si hace falta reenviar algo a mano.`;
        console.error("[orchestrator] hueco de latido detectado:", gapText);
        const accountsToNotify = await prisma_1.prisma.account.findMany({
            where: { notifyWhatsAppTo: { not: null } },
            select: { notifyWhatsAppTo: true },
        });
        const seen = new Set();
        for (const acc of accountsToNotify) {
            if (!acc.notifyWhatsAppTo || seen.has(acc.notifyWhatsAppTo))
                continue;
            seen.add(acc.notifyWhatsAppTo);
            await (0, notifications_1.sendWhatsAppNotification)(acc.notifyWhatsAppTo, msg).catch(() => { });
        }
    }
    catch (err) {
        console.error("[orchestrator] error comprobando el latido:", err);
    }
}
/** Lanza (si no esta ya corriendo) un loop infinito de ciclos para una campaña en modo Aleatorio. */
async function startRandomLoop(campaignId, cycleSeconds) {
    if (runningRandomLoops.has(campaignId))
        return;
    runningRandomLoops.add(campaignId);
    (async () => {
        while (runningRandomLoops.has(campaignId)) {
            try {
                await (0, randomEngine_1.runRandomCampaignCycle)(campaignId);
            }
            catch (err) {
                // eslint-disable-next-line no-console
                console.error(`[orchestrator] error en campaña ${campaignId}:`, err);
            }
            await new Promise((resolve) => setTimeout(resolve, cycleSeconds * 1000));
        }
    })();
}
function stopRandomLoop(campaignId) {
    runningRandomLoops.delete(campaignId);
}
/**
 * Punto de entrada del motor: arranca un loop por cada campaña Aleatorio
 * activa y un tick de un minuto para las campañas de Horarios fijos.
 * Re-sincroniza la lista de campañas activas cada minuto (para recoger
 * altas/bajas/pausas hechas desde el panel sin reiniciar el proceso).
 */
async function startOrchestrator() {
    const resync = async () => {
        const activeRandom = await prisma_1.prisma.campaign.findMany({
            where: { status: "ACTIVE", scheduleMode: "RANDOM" },
            select: { id: true, cycleSeconds: true },
        });
        const activeIds = new Set(activeRandom.map((c) => c.id));
        for (const id of runningRandomLoops) {
            if (!activeIds.has(id))
                stopRandomLoop(id);
        }
        for (const c of activeRandom) {
            startRandomLoop(c.id, c.cycleSeconds);
        }
    };
    await checkHeartbeatGapOnStartup();
    await recordHeartbeat();
    await resync();
    setInterval(resync, 60_000);
    setInterval(() => {
        (0, fixedEngine_1.runFixedScheduleTick)()
            .then(() => recordHeartbeat())
            .catch((err) => console.error("[orchestrator] fixed tick error:", err));
    }, 60_000);
    setInterval(() => {
        (0, scheduledPostsEngine_1.runScheduledPostsTick)().catch((err) => console.error("[orchestrator] scheduled posts tick error:", err));
    }, 60_000);
    console.log("Orquestador arrancado: loops aleatorios + tick de horarios fijos + tick de posts programados, cada 60s.");
}
//# sourceMappingURL=orchestrator.js.map