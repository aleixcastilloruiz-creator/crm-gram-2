import { Account } from "@prisma/client";
import { prisma } from "../utils/prisma";
import { sendWhatsAppNotification } from "../utils/notifications";

/**
 * Detecta si un error lanzado por GramJS/Telegram corresponde a un
 * flood/spam-block de la cuenta (PEER_FLOOD, FLOOD_WAIT_*, o el propio
 * FloodWaitError que expone la libreria "telegram").
 */
export function isFloodError(err: unknown): boolean {
  const anyErr = err as any;
  if (!anyErr) return false;
  const code: string | undefined = anyErr.errorMessage ?? anyErr.message;
  if (anyErr.className === "FloodWaitError") return true;
  if (typeof code === "string" && /PEER_FLOOD|FLOOD_WAIT|FLOOD_PREMIUM_WAIT/i.test(code)) return true;
  return false;
}

/**
 * Marca la cuenta como pausada por PeerFlood: bloquea nuevos envios hasta
 * peerFloodUntil y arma el "arranque suave" (menos envios / mas lento en
 * los primeros ciclos tras reanudar), igual que describe el panel de
 * referencia. Tambien dispara la notificacion configurada.
 */
export async function handlePeerFlood(account: Account, sourceError: unknown): Promise<void> {
  const until = new Date(Date.now() + account.peerFloodPauseMinutes * 60_000);

  await prisma.account.update({
    where: { id: account.id },
    data: {
      health: "PEER_FLOOD_PAUSED",
      peerFloodUntil: until,
      softStartCyclesLeft: account.softStartCycles,
    },
  });

  await prisma.sendLog.create({
    data: {
      accountId: account.id,
      level: "ERROR",
      message: `Telegram marco la cuenta (PeerFlood). Pausada ${account.peerFloodPauseMinutes} min, hasta ${until.toISOString()}.`,
      errorCode: (sourceError as any)?.errorMessage ?? (sourceError as any)?.message ?? "PEER_FLOOD",
    },
  });

  await notify(account, `⚠️ ${account.label}: cuenta pausada por PeerFlood hasta ${until.toLocaleString("es-ES")}`);
}

/**
 * Comprueba si la cuenta puede enviar ahora mismo. Si la pausa ya expiro,
 * la reactiva automaticamente (queda en arranque suave).
 */
export async function ensureAccountReady(account: Account): Promise<Account> {
  if (account.health !== "PEER_FLOOD_PAUSED") return account;
  if (!account.peerFloodUntil || account.peerFloodUntil.getTime() > Date.now()) {
    return account; // sigue pausada
  }
  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { health: "OK", peerFloodUntil: null },
  });
  await prisma.sendLog.create({
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
export function applySoftStart(account: Account, seconds: number): number {
  if (account.softStartCyclesLeft > 0) {
    return Math.round(seconds * account.softStartMultiplier);
  }
  return seconds;
}

/** Descuenta un ciclo de arranque suave tras completarlo. */
export async function consumeSoftStartCycle(account: Account): Promise<void> {
  if (account.softStartCyclesLeft <= 0) return;
  await prisma.account.update({
    where: { id: account.id },
    data: { softStartCyclesLeft: { decrement: 1 } },
  });
}

async function notify(account: Account, text: string): Promise<void> {
  if (!account.notifyWhatsAppTo) return;
  await sendWhatsAppNotification(account.notifyWhatsAppTo, text);
}
