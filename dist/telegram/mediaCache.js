"use strict";
/**
 * Cache en memoria muy simple para no volver a descargar de Telegram la
 * misma foto de perfil o miniatura una y otra vez cada vez que se pinta la
 * lista de conversaciones o la biblioteca de contenido. Tamaño acotado
 * (LRU basico por orden de insercion) para no comerse la memoria del
 * contenedor con cientos de fotos.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedMedia = getCachedMedia;
exports.setCachedMedia = setCachedMedia;
exports.clearMediaCache = clearMediaCache;
const MAX_ENTRIES = 400;
const cache = new Map();
function getCachedMedia(key) {
    const buf = cache.get(key);
    if (buf) {
        // lo movemos al final (mas recientemente usado)
        cache.delete(key);
        cache.set(key, buf);
    }
    return buf;
}
function setCachedMedia(key, buf) {
    if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined)
            cache.delete(oldest);
    }
    cache.set(key, buf);
}
/** Vacía toda la caché de miniaturas/avatares (botón "Vaciar caché y recargar"). */
function clearMediaCache() {
    cache.clear();
}
//# sourceMappingURL=mediaCache.js.map