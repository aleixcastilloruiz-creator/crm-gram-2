import { FastifyInstance } from "fastify";
import { randomUUID } from "crypto";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram/tl";
// @ts-ignore - sin tipos propios en esta version de gramjs
import { computeCheck } from "telegram/Password";
import { apiId, apiHash } from "../telegram/client";
import { prisma } from "../utils/prisma";
import { encryptSecret } from "../utils/crypto";
import { invalidateAccountClient } from "../telegram/connectionPool";
import { agencyIdFromRequest } from "../utils/agencyContext";

/**
 * Alta de cuentas nuevas (modelos) desde el panel web, sin tocar la
 * Terminal. Dos caminos, igual que en TeleCrew:
 *
 *  - "Codigo de Telegram": telefono -> codigo OTP -> (password 2FA si aplica)
 *  - "Codigo QR": se genera un enlace tg://login?token=... como QR, la
 *    modelo lo escanea con Telegram > Dispositivos vinculados, y en cuanto
 *    lo confirma en su movil quedamos con sesion iniciada.
 *
 * Cada intento de login vive en memoria (no en la base de datos) mientras
 * dura, identificado por un loginId; se guarda en la base de datos SOLO al
 * confirmarse con exito (mismo formato que usa loginCli.ts: sessionString
 * cifrado con SESSION_ENCRYPTION_KEY).
 */

type PendingStatus =
  | "pending_code"
  | "pending_scan"
  | "pending_password"
  | "success"
  | "error"
  | "expired";

interface PendingLogin {
  id: string;
  kind: "code" | "qr";
  client: TelegramClient;
  agencyId: string; // multi-agencia: a qué agencia se da de alta esta cuenta nueva (la de quien inició el login)
  accountName: string;
  phoneNumber?: string;
  phoneCodeHash?: string;
  status: PendingStatus;
  qrToken?: string; // URL tg://login?token=... vigente para mostrar como QR
  error?: string;
  accountId?: string;
  createdAt: number;
  qrHandler?: (update: any) => void;
}

const PENDING_TTL_MS = 8 * 60 * 1000; // 8 minutos
const pendingLogins = new Map<string, PendingLogin>();

function assertConfigured() {
  if (!apiId || !apiHash) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
  }
}

function newClient(): TelegramClient {
  assertConfigured();
  return new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
}

async function cleanupPending(id: string) {
  const p = pendingLogins.get(id);
  if (!p) return;
  pendingLogins.delete(id);
  try {
    if (p.qrHandler) p.client.removeEventHandler(p.qrHandler, undefined as any);
  } catch {
    // ignorar
  }
  try {
    if (p.status !== "success") await p.client.disconnect();
  } catch {
    // ignorar: la conexion ya podia estar rota
  }
}

function scheduleExpiry(id: string) {
  setTimeout(() => {
    const p = pendingLogins.get(id);
    if (p && p.status !== "success") {
      p.status = "expired";
      cleanupPending(id);
    }
  }, PENDING_TTL_MS);
}

async function finalizeLogin(p: PendingLogin): Promise<string> {
  const sessionString = p.client.session.save() as unknown as string;
  const me = await p.client.getMe();
  const phoneNumber = (me as any).phone ? `+${(me as any).phone}` : p.phoneNumber || "unknown";

  // El upsert por phoneNumber es justo lo que hace que "Reconectar cuenta"
  // (botón en Configuración → Cuentas de Telegram) funcione sin perder nada:
  // si el teléfono ya existía, esto ACTUALIZA esa misma fila (mismo id) en
  // vez de crear una cuenta nueva - así todas las campañas, notas, carpetas
  // guardadas, etc. (todo lo que cuelga de accountId) se quedan intactas,
  // solo cambia la sesión de Telegram guardada.
  const account = await prisma.account.upsert({
    where: { phoneNumber },
    update: {
      label: p.accountName,
      sessionString: encryptSecret(sessionString),
      health: "OK",
      // agencyId NO se toca al reconectar una cuenta ya existente (mismo
      // teléfono): se queda en la agencia a la que ya pertenecía, nunca se
      // reasigna sola solo por volver a iniciar sesión.
    },
    create: {
      label: p.accountName,
      phoneNumber,
      sessionString: encryptSecret(sessionString),
      agencyId: p.agencyId,
    },
  });

  // Si ya había una conexión (viva o zombi, ver connectionPool.ts) en el
  // pool para esta cuenta, la descartamos: si no, el panel seguiría usando
  // la conexión VIEJA con la sesión antigua hasta el próximo despliegue, en
  // vez de la que se acaba de iniciar sesión ahora mismo.
  invalidateAccountClient(account.id);

  p.status = "success";
  p.accountId = account.id;
  try {
    await p.client.disconnect();
  } catch {
    // ignorar
  }
  return account.id;
}

function bufferToBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Pide un token de login QR a Telegram y arma la URL tg://login?token=... */
async function exportLoginToken(p: PendingLogin) {
  const result = await p.client.invoke(
    new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] })
  );

  if (result instanceof Api.auth.LoginTokenSuccess) {
    await finalizeLogin(p);
    return;
  }

  if (result instanceof (Api.auth as any).LoginTokenMigrateTo) {
    // La cuenta vive en otro datacenter: migramos la sesion y reintentamos.
    await p.client._switchDC((result as any).dcId);
    await exportLoginToken(p);
    return;
  }

  // Caso normal: Api.auth.LoginToken { token, expires }
  const token: Buffer = (result as any).token;
  p.qrToken = "tg://login?token=" + bufferToBase64Url(token);
  p.status = "pending_scan";
}

/** Arranca el escuchador de "token escaneado" para una sesion de login QR. */
function watchQrLogin(p: PendingLogin) {
  const handler = async (update: any) => {
    try {
      if (update?.className !== "UpdateLoginToken") return;
      // El movil confirmo el escaneo: volvemos a pedir el token, que esta
      // vez devuelve el resultado final (exito, o password 2FA pendiente).
      await exportLoginToken(p);
    } catch (err: any) {
      const msg = String(err?.errorMessage || err?.message || err);
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        p.status = "pending_password";
      } else {
        p.status = "error";
        p.error = msg;
      }
    }
  };
  p.qrHandler = handler;
  p.client.addEventHandler(handler);
}

export async function registerAccountLoginRoutes(app: FastifyInstance) {
  // ---------- login por codigo de Telegram (telefono + OTP) ----------

  app.post("/api/account-login/code/start", async (request, reply) => {
    const body = request.body as { phone?: string; accountName?: string };
    if (!body.phone || !body.accountName) {
      reply.code(400).send({ error: "Faltan telefono o nombre de la cuenta" });
      return;
    }
    try {
      const client = newClient();
      await client.connect();
      const result = await client.invoke(
        new Api.auth.SendCode({
          apiId,
          apiHash,
          phoneNumber: body.phone,
          settings: new Api.CodeSettings({}),
        })
      );
      const id = randomUUID();
      const pending: PendingLogin = {
        id,
        kind: "code",
        client,
        agencyId: await agencyIdFromRequest(request),
        accountName: body.accountName,
        phoneNumber: body.phone,
        phoneCodeHash: (result as any).phoneCodeHash,
        status: "pending_code",
        createdAt: Date.now(),
      };
      pendingLogins.set(id, pending);
      scheduleExpiry(id);
      return { loginId: id, status: pending.status };
    } catch (err: any) {
      reply.code(502).send({ error: err.errorMessage || err.message || "No se pudo pedir el codigo" });
    }
  });

  app.post("/api/account-login/code/:id/verify", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { code } = request.body as { code?: string };
    const p = pendingLogins.get(id);
    if (!p) return reply.code(404).send({ error: "Login expirado o no encontrado, empieza de nuevo" });
    if (!code) return reply.code(400).send({ error: "Falta el codigo" });
    try {
      await p.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: p.phoneNumber,
          phoneCodeHash: p.phoneCodeHash,
          phoneCode: code,
        })
      );
      const accountId = await finalizeLogin(p);
      return { status: "success", accountId };
    } catch (err: any) {
      const msg = String(err.errorMessage || err.message || "");
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        p.status = "pending_password";
        return { status: "password_needed" };
      }
      reply.code(400).send({ error: msg || "Codigo invalido" });
    }
  });

  app.post("/api/account-login/code/:id/password", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { password } = request.body as { password?: string };
    const p = pendingLogins.get(id);
    if (!p) return reply.code(404).send({ error: "Login expirado o no encontrado, empieza de nuevo" });
    if (!password) return reply.code(400).send({ error: "Falta la contraseña" });
    try {
      const pwd = await p.client.invoke(new Api.account.GetPassword());
      const srpCheck = await computeCheck(pwd, password);
      await p.client.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
      const accountId = await finalizeLogin(p);
      return { status: "success", accountId };
    } catch (err: any) {
      reply.code(400).send({ error: err.errorMessage || err.message || "Contraseña incorrecta" });
    }
  });

  // ---------- login por codigo QR ----------

  app.post("/api/account-login/qr/start", async (request, reply) => {
    const body = request.body as { accountName?: string };
    if (!body.accountName) {
      reply.code(400).send({ error: "Falta el nombre de la cuenta" });
      return;
    }
    try {
      const client = newClient();
      await client.connect();
      const id = randomUUID();
      const pending: PendingLogin = {
        id,
        kind: "qr",
        client,
        agencyId: await agencyIdFromRequest(request),
        accountName: body.accountName,
        status: "pending_scan",
        createdAt: Date.now(),
      };
      pendingLogins.set(id, pending);
      scheduleExpiry(id);
      watchQrLogin(pending);
      await exportLoginToken(pending);
      return { loginId: id, status: pending.status, qrToken: pending.qrToken };
    } catch (err: any) {
      reply.code(502).send({ error: err.errorMessage || err.message || "No se pudo generar el QR" });
    }
  });

  app.get("/api/account-login/qr/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = pendingLogins.get(id);
    if (!p) return reply.code(404).send({ error: "Login expirado o no encontrado" });
    return {
      status: p.status,
      qrToken: p.qrToken,
      accountId: p.accountId,
      error: p.error,
    };
  });

  app.post("/api/account-login/qr/:id/password", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { password } = request.body as { password?: string };
    const p = pendingLogins.get(id);
    if (!p) return reply.code(404).send({ error: "Login expirado o no encontrado, empieza de nuevo" });
    if (!password) return reply.code(400).send({ error: "Falta la contraseña" });
    try {
      const pwd = await p.client.invoke(new Api.account.GetPassword());
      const srpCheck = await computeCheck(pwd, password);
      await p.client.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
      const accountId = await finalizeLogin(p);
      return { status: "success", accountId };
    } catch (err: any) {
      reply.code(400).send({ error: err.errorMessage || err.message || "Contraseña incorrecta" });
    }
  });

  app.post("/api/account-login/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    await cleanupPending(id);
    return { ok: true };
  });
}
