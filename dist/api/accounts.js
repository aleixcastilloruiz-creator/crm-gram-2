"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAccountRoutes = registerAccountRoutes;
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("../telegram/connectionPool");
const dialogsCache_1 = require("../telegram/dialogsCache");
/**
 * Rutas para gestionar cuentas ya dadas de alta (el login inicial de una
 * cuenta nueva sigue haciendose por Terminal con loginCli.ts, porque
 * requiere el codigo OTP de Telegram). Desde aqui se puede: ver el listado,
 * ver el detalle, encender/apagar el interruptor maestro y ajustar la
 * configuracion anti-baneo / notificaciones.
 */
async function registerAccountRoutes(app) {
    app.get("/api/accounts", async () => {
        const accounts = await prisma_1.prisma.account.findMany({
            orderBy: { createdAt: "asc" },
            select: {
                id: true,
                label: true,
                phoneNumber: true,
                timezone: true,
                reenviadorEnabled: true,
                health: true,
                peerFloodUntil: true,
                notifyWhatsAppTo: true,
                extraMessageFolders: true,
                createdAt: true,
                _count: { select: { campaigns: true, sourceGroups: true } },
            },
        });
        return { accounts };
    });
    app.get("/api/accounts/:id", async (request) => {
        const { id } = request.params;
        const account = await prisma_1.prisma.account.findUniqueOrThrow({ where: { id } });
        return { account };
    });
    app.patch("/api/accounts/:id", async (request) => {
        const { id } = request.params;
        const body = request.body;
        const data = { ...body };
        if (Array.isArray(body.extraMessageFolders)) {
            data.extraMessageFolders = JSON.stringify(body.extraMessageFolders.filter((v) => !!v && v.trim()));
        }
        const account = await prisma_1.prisma.account.update({ where: { id }, data });
        if (body.extraMessageFolders !== undefined) {
            // Cambian que chats/grupos aparecen en "Mensajes": invalidamos la
            // cache para que se note al instante, sin esperar al refresco de fondo.
            (0, dialogsCache_1.clearDialogsCache)(id);
        }
        if (body.reenviadorEnabled !== undefined) {
            await prisma_1.prisma.sendLog.create({
                data: {
                    accountId: id,
                    level: "INFO",
                    message: body.reenviadorEnabled
                        ? "Interruptor maestro ENCENDIDO desde el panel"
                        : "Interruptor maestro APAGADO desde el panel",
                },
            });
        }
        return { account };
    });
    // Elimina por completo una cuenta (modelo) del panel: cierra su conexion
    // de Telegram si estaba abierta y borra en cascada sus origenes,
    // campañas, destinos y logs. No hay vuelta atras.
    app.delete("/api/accounts/:id", async (request, reply) => {
        const { id } = request.params;
        const existing = await prisma_1.prisma.account.findUnique({ where: { id } });
        if (!existing) {
            reply.code(404).send({ error: "Cuenta no encontrada" });
            return;
        }
        await (0, connectionPool_1.closeAccountClient)(id);
        await prisma_1.prisma.account.delete({ where: { id } });
        return { ok: true };
    });
}
//# sourceMappingURL=accounts.js.map