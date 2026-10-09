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

export type PerfOp = "getMessages" | "sendMessage";

interface PerfSample {
  ts: number;
  op: PerfOp;
  accountId: string;
  chatId: string;
  ms: number;
}

const MAX_SAMPLES = 2000;
const samples: PerfSample[] = [];

export function recordPerfSample(op: PerfOp, accountId: string, chatId: string, ms: number): void {
  samples.push({ ts: Date.now(), op, accountId, chatId, ms });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export interface PerfStatsForOp {
  count: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface PerfStats {
  windowSamples: number;
  since: string | null; // fecha del primer sample que entra en este resumen
  byOp: Record<PerfOp, PerfStatsForOp>;
}

/** Resumen de las muestras recogidas hasta ahora, limitado a las cuentas
 * dadas (multi-agencia: cada agencia solo debe ver sus propias cuentas). */
export function getPerfStats(accountIds: Set<string>): PerfStats {
  const relevant = samples.filter((s) => accountIds.has(s.accountId));
  const byOp = {} as Record<PerfOp, PerfStatsForOp>;
  for (const op of ["getMessages", "sendMessage"] as PerfOp[]) {
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
