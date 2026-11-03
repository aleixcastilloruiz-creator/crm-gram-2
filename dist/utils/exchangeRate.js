"use strict";
// Tipo de cambio a EUR para mostrar en "Just Another Panel": el panel SMM
// cobra en su propia moneda (normalmente USD) y esa es la que devuelve su
// API (balance/rate/charge) - la agencia quiere ver esos importes en euros,
// así que aquí se convierte solo para PINTARLO en el panel, nunca se toca
// lo que de verdad se envía/guarda de JAP (eso sigue en su moneda original,
// ver JapOrder.currency).
//
// Se usa una API pública gratuita sin clave (open.er-api.com) y se cachea
// la tasa varias horas en memoria - el cambio EUR/USD no varía lo bastante
// rápido como para consultarlo en cada visita a la pantalla, y así una
// caída puntual de esa API no deja el panel sin poder mostrar nada.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExchangeRateError = void 0;
exports.getExchangeRateToEur = getExchangeRateToEur;
const CACHE_MS = 6 * 60 * 60 * 1000; // 6 horas
const cacheByBase = new Map();
class ExchangeRateError extends Error {
}
exports.ExchangeRateError = ExchangeRateError;
/** 1 unidad de `fromCurrency` equivale a cuántos euros - p.ej. 0.92 si
 * fromCurrency es "USD". Lanza ExchangeRateError si no se pudo conseguir
 * ninguna tasa (ni fresca ni en caché, aunque estuviera caducada). */
async function getExchangeRateToEur(fromCurrency) {
    const base = (fromCurrency || "USD").trim().toUpperCase();
    if (base === "EUR")
        return 1;
    const cached = cacheByBase.get(base);
    if (cached && Date.now() - cached.at < CACHE_MS && cached.rates.EUR) {
        return cached.rates.EUR;
    }
    try {
        const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = (await res.json());
        if (data.result !== "success" || !data.rates || !data.rates.EUR) {
            throw new Error("La API de tipo de cambio no devolvió una tasa a EUR.");
        }
        cacheByBase.set(base, { at: Date.now(), rates: data.rates });
        return data.rates.EUR;
    }
    catch (err) {
        // Si falla la consulta en vivo pero había una tasa vieja en caché,
        // mejor una conversión aproximada con una tasa caducada que no poder
        // mostrar nada - se avisa igualmente con approx=true en la respuesta.
        if (cached?.rates.EUR)
            return cached.rates.EUR;
        throw new ExchangeRateError(err instanceof Error ? `No se pudo obtener el tipo de cambio a euros: ${err.message}` : "No se pudo obtener el tipo de cambio a euros.");
    }
}
//# sourceMappingURL=exchangeRate.js.map