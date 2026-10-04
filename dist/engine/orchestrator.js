"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopRandomLoop = stopRandomLoop;
exports.startOrchestrator = startOrchestrator;
const prisma_1 = require("../utils/prisma");
const randomEngine_1 = require("./randomEngine");
const fixedEngine_1 = require("./fixedEngine");
const runningRandomLoops = new Set();
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
    await resync();
    setInterval(resync, 60_000);
    setInterval(() => {
        (0, fixedEngine_1.runFixedScheduleTick)().catch((err) => console.error("[orchestrator] fixed tick error:", err));
    }, 60_000);
    console.log("Orquestador arrancado: loops aleatorios + tick de horarios fijos cada 60s.");
}
//# sourceMappingURL=orchestrator.js.map