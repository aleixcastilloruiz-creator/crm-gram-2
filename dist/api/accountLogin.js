"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAccountLoginRoutes = registerAccountLoginRoutes;
const crypto_1 = require("crypto");
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const tl_1 = require("telegram/tl");
// @ts-ignore - sin tipos propios en esta version de gramjs
const Password_1 = require("telegram/Password");
const client_1 = require("../telegram/client");
const prisma_1 = require("../utils/prisma");
const crypto_2 = require("../utils/crypto");
const PENDING_TTL_MS = 8 * 60 * 1000; // 8 minutos
const pendingLogins = new Map();
function assertConfigured() {
    if (!client_1.apiId || !client_1.apiHash) {
        throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
    }
}
function newClient() {
    assertConfigured();
    return new telegram_1.TelegramClient(new sessions_1.StringSession(""), client_1.apiId, client_1.apiHash, {
        connectionRetries: 5,
    });
}
async function cleanupPending(id) {
    const p = pendingLogins.get(id);
    if (!p)
        return;
    pendingLogins.delete(id);
    try {
        if (p.qrHandler)
            p.client.removeEventHandler(p.qrHandler, undefined);
    }
    catch {
        // ignorar
    }
    try {
        if (p.status !== "success")
            await p.client.disconnect();
    }
    catch {
        // ignorar: la conexion ya podia estar rota
    }
}
function scheduleExpiry(id) {
    setTimeout(() => {
        const p = pendingLogins.get(id);
        if (p && p.status !== "success") {
            p.status = "expired";
            cleanupPending(id);
        }
    }, PENDING_TTL_MS);
}
async function finalizeLogin(p) {
    const sessionString = p.client.session.save();
    const me = await p.client.getMe();
    const phoneNumber = me.phone ? `+${me.phone}` : p.phoneNumber || "unknown";
    const account = await prisma_1.prisma.account.upsert({
        where: { phoneNumber },
        update: {
            label: p.accountName,
            sessionString: (0, crypto_2.encryptSecret)(sessionString),
            health: "OK",
        },
        create: {
            label: p.accountName,
            phoneNumber,
            sessionString: (0, crypto_2.encryptSecret)(sessionString),
        },
    });
    p.status = "success";
    p.accountId = account.id;
    try {
        await p.client.disconnect();
    }
    catch {
        // ignorar
    }
    return account.id;
}
function bufferToBase64Url(buf) {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Pide un token de login QR a Telegram y arma la URL tg://login?token=... */
async function exportLoginToken(p) {
    const result = await p.client.invoke(new tl_1.Api.auth.ExportLoginToken({ apiId: client_1.apiId, apiHash: client_1.apiHash, exceptIds: [] }));
    if (result instanceof tl_1.Api.auth.LoginTokenSuccess) {
        await finalizeLogin(p);
        return;
    }
    if (result instanceof tl_1.Api.auth.LoginTokenMigrateTo) {
        // La cuenta vive en otro datacenter: migramos la sesion y reintentamos.
        await p.client._switchDC(result.dcId);
        await exportLoginToken(p);
        return;
    }
    // Caso normal: Api.auth.LoginToken { token, expires }
    const token = result.token;
    p.qrToken = "tg://login?token=" + bufferToBase64Url(token);
    p.status = "pending_scan";
}
/** Arranca el escuchador de "token escaneado" para una sesion de login QR. */
function watchQrLogin(p) {
    const handler = async (update) => {
        try {
            if (update?.className !== "UpdateLoginToken")
                return;
            // El movil confirmo el escaneo: volvemos a pedir el token, que esta
            // vez devuelve el resultado final (exito, o password 2FA pendiente).
            await exportLoginToken(p);
        }
        catch (err) {
            const msg = String(err?.errorMessage || err?.message || err);
            if (msg.includes("SESSION_PASSWORD_NEEDED")) {
                p.status = "pending_password";
            }
            else {
                p.status = "error";
                p.error = msg;
            }
        }
    };
    p.qrHandler = handler;
    p.client.addEventHandler(handler);
}
async function registerAccountLoginRoutes(app) {
    // ---------- login por codigo de Telegram (telefono + OTP) ----------
    app.post("/api/account-login/code/start", async (request, reply) => {
        const body = request.body;
        if (!body.phone || !body.accountName) {
            reply.code(400).send({ error: "Faltan telefono o nombre de la cuenta" });
            return;
        }
        try {
            const client = newClient();
            await client.connect();
            const result = await client.invoke(new tl_1.Api.auth.SendCode({
                apiId: client_1.apiId,
                apiHash: client_1.apiHash,
                phoneNumber: body.phone,
                settings: new tl_1.Api.CodeSettings({}),
            }));
            const id = (0, crypto_1.randomUUID)();
            const pending = {
                id,
                kind: "code",
                client,
                accountName: body.accountName,
                phoneNumber: body.phone,
                phoneCodeHash: result.phoneCodeHash,
                status: "pending_code",
                createdAt: Date.now(),
            };
            pendingLogins.set(id, pending);
            scheduleExpiry(id);
            return { loginId: id, status: pending.status };
        }
        catch (err) {
            reply.code(502).send({ error: err.errorMessage || err.message || "No se pudo pedir el codigo" });
        }
    });
    app.post("/api/account-login/code/:id/verify", async (request, reply) => {
        const { id } = request.params;
        const { code } = request.body;
        const p = pendingLogins.get(id);
        if (!p)
            return reply.code(404).send({ error: "Login expirado o no encontrado, empieza de nuevo" });
        if (!code)
            return reply.code(400).send({ error: "Falta el codigo" });
        try {
            await p.client.invoke(new tl_1.Api.auth.SignIn({
                phoneNumber: p.phoneNumber,
                phoneCodeHash: p.phoneCodeHash,
                phoneCode: code,
            }));
            const accountId = await finalizeLogin(p);
            return { status: "success", accountId };
        }
        catch (err) {
            const msg = String(err.errorMessage || err.message || "");
            if (msg.includes("SESSION_PASSWORD_NEEDED")) {
                p.status = "pending_password";
                return { status: "password_needed" };
            }
            reply.code(400).send({ error: msg || "Codigo invalido" });
        }
    });
    app.post("/api/account-login/code/:id/password", async (request, reply) => {
        const { id } = request.params;
        const { password } = request.body;
        const p = pendingLogins.get(id);
        if (!p)
            return reply.code(404).send({ error: "Login expirado o no encontrado, empieza de nuevo" });
        if (!password)
            return reply.code(400).send({ error: "Falta la contraseña" });
        try {
            const pwd = await p.client.invoke(new tl_1.Api.account.GetPassword());
            const srpCheck = await (0, Password_1.computeCheck)(pwd, password);
            await p.client.invoke(new tl_1.Api.auth.CheckPassword({ password: srpCheck }));
            const accountId = await finalizeLogin(p);
            return { status: "success", accountId };
        }
        catch (err) {
            reply.code(400).send({ error: err.errorMessage || err.message || "Contraseña incorrecta" });
        }
    });
    // ---------- login por codigo QR ----------
    app.post("/api/account-login/qr/start", async (request, reply) => {
        const body = request.body;
        if (!body.accountName) {
            reply.code(400).send({ error: "Falta el nombre de la cuenta" });
            return;
        }
        try {
            const client = newClient();
            await client.connect();
            const id = (0, crypto_1.randomUUID)();
            const pending = {
                id,
                kind: "qr",
                client,
                accountName: body.accountName,
                status: "pending_scan",
                createdAt: Date.now(),
            };
            pendingLogins.set(id, pending);
            scheduleExpiry(id);
            watchQrLogin(pending);
            await exportLoginToken(pending);
            return { loginId: id, status: pending.status, qrToken: pending.qrToken };
        }
        catch (err) {
            reply.code(502).send({ error: err.errorMessage || err.message || "No se pudo generar el QR" });
        }
    });
    app.get("/api/account-login/qr/:id/status", async (request, reply) => {
        const { id } = request.params;
        const p = pendingLogins.get(id);
        if (!p)
            return reply.code(404).send({ error: "Login expirado o no encontrado" });
        return {
            status: p.status,
            qrToken: p.qrToken,
            accountId: p.accountId,
            error: p.error,
        };
    });
    app.post("/api/account-login/qr/:id/password", async (request, reply) => {
        const { id } = request.params;
        const { password } = request.body;
        const p = pendingLogins.get(id);
        if (!p)
            return reply.code(404).send({ error: "Login expirado o no encontrado, empieza de nuevo" });
        if (!password)
            return reply.code(400).send({ error: "Falta la contraseña" });
        try {
            const pwd = await p.client.invoke(new tl_1.Api.account.GetPassword());
            const srpCheck = await (0, Password_1.computeCheck)(pwd, password);
            await p.client.invoke(new tl_1.Api.auth.CheckPassword({ password: srpCheck }));
            const accountId = await finalizeLogin(p);
            return { status: "success", accountId };
        }
        catch (err) {
            reply.code(400).send({ error: err.errorMessage || err.message || "Contraseña incorrecta" });
        }
    });
    app.post("/api/account-login/:id/cancel", async (request) => {
        const { id } = request.params;
        await cleanupPending(id);
        return { ok: true };
    });
}
//# sourceMappingURL=accountLogin.js.map