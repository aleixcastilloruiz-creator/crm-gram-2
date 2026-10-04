"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFloodError = isFloodError;
exports.handlePeerFlood = handlePeerFlood;
exports.ensureAccountReady = ensureAccountReady;
exports.applySoftStart = applySoftStart;
exports.consumeSoftStartCycle = consumeSoftStartCycle;
const prisma_1 = require("../utils/prisma");
const notifications_1 = require("../utils/notifications");
/**
 * Detecta si un error lanzado por GramJS/Telegram corresponde a un
 * flood/spam-block de la cuenta (PEER_FLOOD, FLOOD_WAIT_*, o el propio
 * FloodWaitError que expone la libreria "telegram").
 */
function isFloodError(err) {
    const anyErr = err;
    if (!anyErr)
        return false;
    const code = anyErr.errorMessage ?? anyErr.message;
    if (anyErr.className === "FloodWaitError")
        return true;
    if (typeof code === "string" && /PEER_FLOOD|FLOOD_WAIT|FLOOD_PREMIUM_WAIT/i.test(code))
        return true;
    return false;
}
/**
 * Marca la cuenta como pausada por PeerFlood: bloquea nuevos envios hasta
 * peerFloodUntil y arma el "arranque suave" (menos envios / mas lento en
 * los primeros ciclos tras reanudar), igual que describe el panel de
 * referencia. Tambien dispara la notificacion configurada.
 */
async function handlePeerFlood(account, sourceError) {
    const until = new Date(Date.now() + account.peerFloodPauseMinutes * 60_000);
    await prisma_1.prisma.account.update({
        where: { id: account.id },
        data: {
            health: "PEER_FLOOD_PAUSED",
            peerFloodUntil: until,
            softStartCyclesLeft: account.softStartCycles,
        },
    });
    await prisma_1.prisma.sendLog.create({
        data: {
            accountId: account.id,
            level: "ERROR",
            message: `Telegram marco la cuenta (PeerFlood). Pausada ${account.peerFloodPauseMinutes} min, hasta ${until.toISOString()}.`,
            errorCode: sourceError?.errorMessage ?? sourceError?.message ?? "PEER_FLOOD",
        },
    });
    await notify(account, `⚠️ ${account.label}: cuenta pausada por PeerFlood hasta ${until.toLocaleString("es-ES")}`);
}
/**
 * Comprueba si la cuenta puede enviar ahora mismo. Si la pausa ya expiro,
 * la reactiva automaticamente (queda en arranque suave).
 */
async function ensureAccountReady(account) {
    if (account.health !== "PEER_FLOOD_PAUSED")
        return account;
    if (!account.peerFloodUntil || account.peerFloodUntil.getTime() > Date.now()) {
        return account; // sigue pausada
    }
    const updated = await prisma_1.prisma.account.update({
        where: { id: account.id },
        data: { health: "OK", peerFloodUntil: null },
    });
    await prisma_1.prisma.sendLog.create({
        data: {
            accountId: account.id,
            level: "INFO",
            message: `Cuenta reanudada tras pausa por PeerFlood. Arranque suave: ${account.softStartCycles} ciclo(s).`,
        },
    });
    await notify(account, `✅ ${account.label}: cuenta reanudada (arranque suave activo)`);
    return updated;
}
/** Aplica el multiplicador de arranque suave a un intervalo/pausa en segundos. */
function applySoftStart(account, seconds) {
    if (account.softStartCyclesLeft > 0) {
        return Math.round(seconds * account.softStartMultiplier);
    }
    return seconds;
}
/** Descuenta un ciclo de arranque suave tras completarlo. */
async function consumeSoftStartCycle(account) {
    if (account.softStartCyclesLeft <= 0)
        return;
    await prisma_1.prisma.account.update({
        where: { id: account.id },
        data: { softStartCyclesLeft: { decrement: 1 } },
    });
}
async function notify(account, text) {
    if (!account.notifyWhatsAppTo)
        return;
    await (0, notifications_1.sendWhatsAppNotification)(account.notifyWhatsAppTo, text);
}
//# sourceMappingURL=peerFlood.js.map