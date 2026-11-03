"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldAlert = shouldAlert;
exports.clearAlert = clearAlert;
/**
 * Pequeña utilidad para no ahogar el WhatsApp cuando un mismo problema se
 * repite tick tras tick (o ciclo tras ciclo) mientras no se soluciona - por
 * ejemplo, un origen ilegible o una campaña sin destinos configurados: sin
 * esto, cada intento fallido (cada 60s en horarios fijos, cada
 * `cycleSeconds` en modo Aleatorio) mandaría un WhatsApp nuevo, y en un rato
 * serían decenas de avisos idénticos. Con esto, cada problema concreto
 * (identificado por una clave, normalmente el id de la campaña + el tipo de
 * fallo) manda como mucho un aviso cada `cooldownMs`, hasta que se
 * resuelva - suficiente para enterarse enseguida sin saturar el telefono.
 */
const lastAlertAt = new Map();
function shouldAlert(key, cooldownMs) {
    const now = Date.now();
    const last = lastAlertAt.get(key);
    if (last !== undefined && now - last < cooldownMs)
        return false;
    lastAlertAt.set(key, now);
    return true;
}
/** Se borra la marca de un problema en cuanto se sabe que ya se resolvió, para que el siguiente fallo distinto no espere el cooldown de uno viejo. */
function clearAlert(key) {
    lastAlertAt.delete(key);
}
//# sourceMappingURL=alertThrottle.js.map