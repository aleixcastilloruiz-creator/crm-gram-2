"use strict";
/**
 * Muestreo ligero de latencia real contra Telegram (MTProto), en memoria -
 * SOLO para medir "cuanto tarda esto hoy" antes de decidir si merece la
 * pena construir el cache local de mensajes (la mejora #2 de la auditoria
 * de rendimiento). No es infraestructura nueva de verdad: un array en
 * memoria, capado, que se vacia con cada despliegue - nunca se guarda en
 * base de datos ni se manda a ningun sitio externo.
 *
 * Dos operaciones se miden, las dos "caras" de abrir/usar un chat:
 *  - "getMessages": lo que tarda Telegram en devolver el historial de una
 *    conversacion (GET .../messages).
 *  - "sendMessage": lo que tarda Telegram en aceptar un mensaje saliente
 *    (POST .../send) - esto es justo el tramo que la burbuja optimista ya
 *    esconde de la vista del chatter, pero sigue siendo util medirlo para
 *    saber cuanto se esta escondiendo de verdad.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordPerfSample = recordPerfSample;
exports.getPerfStats = getPerfStats;
const MAX_SAMPLES = 2000;
const samples = [];
function recordPerfSample(op, accountId, chatId, ms) {
    samples.push({ ts: Date.now(), op, accountId, chatId, ms });
    if (samples.length > MAX_SAMPLES)
        samples.splice(0, samples.length - MAX_SAMPLES);
}
function percentile(sorted, p) {
    if (sorted.length === 0)
        return null;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}
/** Resumen de las muestras recogidas hasta ahora, limitado a las cuentas
 * dadas (multi-agencia: cada agencia solo debe ver sus propias cuentas). */
function getPerfStats(accountIds) {
    const relevant = samples.filter((s) => accountIds.has(s.accountId));
    const byOp = {};
    for (const op of ["getMessages", "sendMessage"]) {
        const ms = relevant.filter((s) => s.op === op).map((s) => s.ms).sort((a, b) => a - b);
        byOp[op] = {
            count: ms.length,
            avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
            p50Ms: percentile(ms, 50),
            p95Ms: percentile(ms, 95),
            maxMs: ms.length ? ms[ms.length - 1] : null,
        };
    }
    const oldestTs = relevant.length ? Math.min(...relevant.map((s) => s.ts)) : null;
    return {
        windowSamples: relevant.length,
        since: oldestTs ? new Date(oldestTs).toISOString() : null,
        byOp,
    };
}
//# sourceMappingURL=perfSamples.js.map