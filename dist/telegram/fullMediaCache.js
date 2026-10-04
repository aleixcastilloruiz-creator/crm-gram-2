"use strict";
/**
 * Cache en memoria para el archivo COMPLETO (foto o vídeo a resolución
 * original, no la miniatura) de la galería del chat. Antes la ruta
 * /gallery/:messageId/media nunca guardaba nada (a diferencia de /thumb, que
 * sí usa mediaCache.ts) - así que ver la misma foto/vídeo dos veces volvía a
 * descargarlo entero de Telegram cada vez, aunque no hubiera cambiado nada.
 *
 * No reutiliza mediaCache.ts porque ese límite es "400 entradas" (pensado
 * para miniaturas pequeñas/avatares) - aquí cada entrada puede pesar decenas
 * de MB, así que unas pocas ya se comerían toda la memoria disponible sin
 * ningún aviso. Por eso este límite es por BYTES totales, no por número de
 * entradas.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedFullMedia = getCachedFullMedia;
exports.setCachedFullMedia = setCachedFullMedia;
exports.clearFullMediaCache = clearFullMediaCache;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024; // 250MB como mucho en RAM para esta caché
const MAX_ITEM_BYTES = 20 * 1024 * 1024; // un vídeo grande no compensa cachearlo: ocuparía casi todo el hueco para un solo archivo
const cache = new Map();
let totalBytes = 0;
function getCachedFullMedia(key) {
    const entry = cache.get(key);
    if (entry) {
        // lo movemos al final (mas recientemente usado) para el LRU
        cache.delete(key);
        cache.set(key, entry);
    }
    return entry;
}
function setCachedFullMedia(key, buf, contentType) {
    if (buf.length > MAX_ITEM_BYTES)
        return; // demasiado grande para merecer la pena cachearlo
    while (totalBytes + buf.length > MAX_TOTAL_BYTES && cache.size > 0) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined)
            break;
        const oldest = cache.get(oldestKey);
        if (oldest)
            totalBytes -= oldest.buf.length;
        cache.delete(oldestKey);
    }
    cache.set(key, { buf, contentType });
    totalBytes += buf.length;
}
/** Vacía toda la caché de archivos completos (botón "Vaciar caché y recargar"). */
function clearFullMediaCache() {
    cache.clear();
    totalBytes = 0;
}
//# sourceMappingURL=fullMediaCache.js.map