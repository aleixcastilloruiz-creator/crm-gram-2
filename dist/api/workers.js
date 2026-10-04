"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWorkerRoutes = registerWorkerRoutes;
const prisma_1 = require("../utils/prisma");
const auth_1 = require("../utils/auth");
const VALID_SECTIONS = new Set(["mensajes", "sfs", "mensajes-pro"]);
function safeParseJson(raw, fallback) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/**
 * Configuración → Equipo: el dueño (role "admin") da de alta trabajadores y
 * les concede, cuenta por cuenta y apartado por apartado, a qué pueden
 * llegar (Mensajes / SFS / Mensajes Pro). Solo un "admin" logueado puede
 * usar estas rutas -a diferencia de Mensajes/SFS, aquí SÍ hace falta haber
 * iniciado sesión como trabajador admin, porque antes de hoy esto no
 * existía y nadie depende de usarlo sin login-.
 */
async function requireAdmin(request, reply) {
    const worker = await (0, auth_1.getWorkerFromRequest)(request);
    if (!worker || worker.role !== "admin") {
        reply.code(403).send({ error: "Solo un administrador del equipo puede gestionar trabajadores." });
        return reply;
    }
    request.worker = worker;
}
async function registerWorkerRoutes(app) {
    app.get("/api/workers", { preHandler: requireAdmin }, async () => {
        const workers = await prisma_1.prisma.worker.findMany({
            orderBy: { createdAt: "asc" },
            include: { permissions: { include: { account: { select: { id: true, label: true } } } } },
        });
        return {
            workers: workers.map((w) => ({
                id: w.id,
                name: w.name,
                email: w.email,
                role: w.role,
                active: w.active,
                canUseBrowser: w.canUseBrowser,
                schedule: safeParseJson(w.scheduleJson, {}),
                extraPermissions: safeParseJson(w.extraPermissionsJson, {}),
                createdAt: w.createdAt,
                permissions: w.permissions.map((p) => ({ accountId: p.accountId, accountLabel: p.account.label, section: p.section })),
            })),
        };
    });
    // Genera una contraseña temporal legible (sin caracteres ambiguos tipo
    // 0/O, 1/l) para cuando se da de alta un trabajador sin ponerle
    // contraseña a mano - de momento no hay un correo de invitación real
    // configurado (haría falta un proveedor de email en el servidor), así que
    // esta es la que el admin comparte a mano con la persona.
    function generateTempPassword() {
        const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
        let out = "";
        for (let i = 0; i < 10; i++)
            out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    }
    app.post("/api/workers", { preHandler: requireAdmin }, async (request, reply) => {
        const body = request.body;
        const name = (body.name || "").trim();
        const email = (body.email || "").trim().toLowerCase();
        const role = body.role === "admin" ? "admin" : "worker";
        if (!name || !email) {
            return reply.code(400).send({ error: "Faltan nombre o email." });
        }
        if (body.password && body.password.length < 6) {
            return reply.code(400).send({ error: "La contraseña necesita al menos 6 caracteres." });
        }
        const existing = await prisma_1.prisma.worker.findUnique({ where: { email } });
        if (existing) {
            return reply.code(400).send({ error: "Ya hay un trabajador con ese email." });
        }
        const tempPassword = body.password || generateTempPassword();
        const passwordHash = await (0, auth_1.hashPassword)(tempPassword);
        const worker = await prisma_1.prisma.worker.create({ data: { name, email, passwordHash, role } });
        const accountIds = Array.isArray(body.accountIds) ? body.accountIds.filter((v) => !!v) : [];
        if (accountIds.length > 0) {
            await prisma_1.prisma.workerPermission.createMany({
                data: accountIds.flatMap((accountId) => [
                    { workerId: worker.id, accountId, section: "mensajes" },
                    { workerId: worker.id, accountId, section: "sfs" },
                ]),
                skipDuplicates: true,
            });
        }
        return {
            worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role, active: worker.active },
            // Solo se manda de vuelta si no la puso el admin a mano (para poder
            // enseñarla una vez y que se la pase al trabajador).
            generatedPassword: body.password ? undefined : tempPassword,
        };
    });
    app.put("/api/workers/:workerId", { preHandler: requireAdmin }, async (request, reply) => {
        const { workerId } = request.params;
        const body = request.body;
        const data = {};
        if (body.name !== undefined)
            data.name = body.name.trim();
        if (body.role !== undefined)
            data.role = body.role === "admin" ? "admin" : "worker";
        if (body.active !== undefined)
            data.active = !!body.active;
        if (body.canUseBrowser !== undefined)
            data.canUseBrowser = !!body.canUseBrowser;
        if (body.schedule !== undefined)
            data.scheduleJson = JSON.stringify(body.schedule || {});
        if (body.extraPermissions !== undefined)
            data.extraPermissionsJson = JSON.stringify(body.extraPermissions || {});
        let generatedPassword;
        if (body.generatePassword) {
            generatedPassword = generateTempPassword();
            data.passwordHash = await (0, auth_1.hashPassword)(generatedPassword);
        }
        else if (body.password) {
            if (body.password.length < 6)
                return reply.code(400).send({ error: "La contraseña necesita al menos 6 caracteres." });
            data.passwordHash = await (0, auth_1.hashPassword)(body.password);
        }
        await prisma_1.prisma.worker.update({ where: { id: workerId }, data }).catch(() => { });
        return { ok: true, generatedPassword };
    });
    app.delete("/api/workers/:workerId", { preHandler: requireAdmin }, async (request) => {
        const { workerId } = request.params;
        await prisma_1.prisma.worker.delete({ where: { id: workerId } }).catch(() => { });
        return { ok: true };
    });
    // Sustituye TODOS los permisos de un trabajador de una sola vez (mas
    // simple para el editor de casillas del frontend que ir añadiendo/
    // quitando uno a uno).
    app.put("/api/workers/:workerId/permissions", { preHandler: requireAdmin }, async (request, reply) => {
        const { workerId } = request.params;
        const body = request.body;
        const permissions = (body.permissions || []).filter((p) => p?.accountId && VALID_SECTIONS.has(p.section));
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.workerPermission.deleteMany({ where: { workerId } }),
            ...(permissions.length > 0
                ? [
                    prisma_1.prisma.workerPermission.createMany({
                        data: permissions.map((p) => ({ workerId, accountId: p.accountId, section: p.section })),
                        skipDuplicates: true,
                    }),
                ]
                : []),
        ]);
        return { ok: true };
    });
}
//# sourceMappingURL=workers.js.map