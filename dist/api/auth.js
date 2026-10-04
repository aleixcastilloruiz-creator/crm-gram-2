"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAuthRoutes = registerAuthRoutes;
const prisma_1 = require("../utils/prisma");
const auth_1 = require("../utils/auth");
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 dias, igual que el token
async function workerPublicInfo(workerId) {
    const permissions = await prisma_1.prisma.workerPermission.findMany({
        where: { workerId },
        include: { account: { select: { id: true, label: true } } },
    });
    return {
        permissions: permissions.map((p) => ({ accountId: p.accountId, accountLabel: p.account.label, section: p.section })),
    };
}
/**
 * Login del "Equipo" (trabajadores): capa AÑADIDA sobre el candado general
 * del panel (Basic Auth de index.ts, que sigue igual). Aquí cada persona
 * entra con su propio email/contraseña, sin necesitar el número/sesión de
 * Telegram de ninguna modelo.
 */
async function registerAuthRoutes(app) {
    app.post("/api/auth/login", async (request, reply) => {
        const body = request.body;
        const email = (body.email || "").trim().toLowerCase();
        const password = body.password || "";
        if (!email || !password) {
            return reply.code(400).send({ error: "Falta el email o la contraseña." });
        }
        const worker = await prisma_1.prisma.worker.findUnique({ where: { email } });
        if (!worker || !worker.active) {
            return reply.code(401).send({ error: "Email o contraseña incorrectos." });
        }
        const ok = await (0, auth_1.verifyPassword)(password, worker.passwordHash);
        if (!ok) {
            return reply.code(401).send({ error: "Email o contraseña incorrectos." });
        }
        let token;
        try {
            token = (0, auth_1.signWorkerToken)(worker.id);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: "El login de trabajadores todavía no está configurado del todo (falta AUTH_JWT_SECRET)." });
        }
        reply.setCookie(auth_1.WORKER_COOKIE, token, {
            httpOnly: true,
            path: "/",
            maxAge: COOKIE_MAX_AGE_SECONDS,
            sameSite: "lax",
        });
        const info = await workerPublicInfo(worker.id);
        return {
            worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role },
            ...info,
        };
    });
    app.post("/api/auth/logout", async (request, reply) => {
        reply.clearCookie(auth_1.WORKER_COOKIE, { path: "/" });
        return { ok: true };
    });
    app.get("/api/auth/me", async (request) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return { worker: null };
        const info = await workerPublicInfo(worker.id);
        return { worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role }, ...info };
    });
}
//# sourceMappingURL=auth.js.map