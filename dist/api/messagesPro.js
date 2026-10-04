"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMessagesProRoutes = registerMessagesProRoutes;
const prisma_1 = require("../utils/prisma");
const auth_1 = require("../utils/auth");
/**
 * "Mensajes Pro": el mismo motor de Mensajes (grupo de rutas duplicado bajo
 * el prefijo /pro con su propio requireSectionAccess("mensajes-pro"), ver
 * index.ts), pero con su bandeja de entrada multi-cuenta propia. Esta ruta
 * es la unica que no es "por cuenta": dice, para quien pregunta, que
 * cuentas puede usar en Mensajes Pro, para poder pintar la barra de
 * pestañas ("Todas" + una por creadora) antes de pedir nada mas.
 *
 * Solo id+nombre - nunca telefono, estado del reenviador ni nada de eso:
 * es lo minimo que hace falta para la barra de pestañas, y así ni de
 * casualidad se le enseña al equipo de chatters nada del reenviador.
 */
async function registerMessagesProRoutes(app) {
    app.get("/api/mensajes-pro/accounts", async (request) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (worker && worker.role !== "admin") {
            const permissions = await prisma_1.prisma.workerPermission.findMany({
                where: { workerId: worker.id, section: "mensajes-pro" },
                include: { account: { select: { id: true, label: true } } },
            });
            const accounts = permissions.map((p) => ({ id: p.account.id, label: p.account.label }));
            return { accounts };
        }
        // Sin cookie de trabajador (el dueño con Basic Auth) o admin del
        // equipo: ve todas las cuentas, igual que en el resto del panel.
        const accounts = await prisma_1.prisma.account.findMany({
            orderBy: { createdAt: "asc" },
            select: { id: true, label: true },
        });
        return { accounts };
    });
}
//# sourceMappingURL=messagesPro.js.map