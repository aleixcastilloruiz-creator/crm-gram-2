"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSettingsRoutes = registerSettingsRoutes;
const fs_1 = __importDefault(require("fs"));
const prisma_1 = require("../utils/prisma");
const mediaCache_1 = require("../telegram/mediaCache");
const fullMediaCache_1 = require("../telegram/fullMediaCache");
const contentLibrary_1 = require("./contentLibrary");
const auth_1 = require("../utils/auth");
const connectionPool_1 = require("../telegram/connectionPool");
const agencyContext_1 = require("../utils/agencyContext");
/**
 * Ajustes generales de la agencia (Configuración → General), tal y como en
 * el panel de referencia: listas de servicios/métodos de pago al apuntar una
 * venta, verificación de ventas, y la etiqueta de "comprador reciente".
 * Con multi-agencia hay una fila POR AGENCIA (identificada por agencyId, ver
 * comentario en schema.prisma) en vez de una única fila global.
 */
const DEFAULT_SERVICES = [
    "VIDEOLLAMADA",
    "SEXTING",
    "CONTENIDO",
    "CONT CON CHICO",
    "PERSONALIZADO",
    "DICKRATE",
    "RULETA",
    "Pack de Fotos",
    "RESERVA",
    "OTROS",
];
const DEFAULT_PAYMENT_METHODS = ["TRANSFERENCIA", "PAYPAL", "BIZUM", "CRIPTO", "STRIPE", "REVOLUT", "WISE"];
async function getOrCreateSettings(agencyId) {
    let s = await prisma_1.prisma.agencySettings.findUnique({ where: { agencyId } });
    if (!s) {
        s = await prisma_1.prisma.agencySettings.create({
            data: {
                agencyId,
                services: JSON.stringify(DEFAULT_SERVICES),
                paymentMethods: JSON.stringify(DEFAULT_PAYMENT_METHODS),
            },
        });
    }
    return s;
}
function serialize(s) {
    let services = [];
    let paymentMethods = [];
    try {
        services = JSON.parse(s.services);
    }
    catch {
        services = DEFAULT_SERVICES;
    }
    try {
        paymentMethods = JSON.parse(s.paymentMethods);
    }
    catch {
        paymentMethods = DEFAULT_PAYMENT_METHODS;
    }
    return {
        services,
        paymentMethods,
        saleVerificationMode: s.saleVerificationMode,
        recentBuyerEnabled: s.recentBuyerEnabled,
        recentBuyerMode: s.recentBuyerMode,
        recentBuyerDays: s.recentBuyerDays,
        shadowModeEnabled: s.shadowModeEnabled,
    };
}
/** Modo shadow toca la presencia (online/offline) de TODAS las cuentas de
 * Telegram conectadas, así que -igual que con Pagos- es cosa solo del
 * dueño/jefe, reservada fuera del perfil de Team líder/Chatter. Un
 * trabajador normal solo puede leer si está activo (para que el toggle, si
 * llegara a verse, se muestre bien), nunca cambiarlo. */
async function requireAdminForShadowMode(request, reply) {
    const worker = await (0, auth_1.getWorkerFromRequest)(request);
    if (worker) {
        reply.code(403).send({ error: "Solo el dueño puede activar o desactivar el modo shadow." });
        return false;
    }
    return true; // sin cookie de trabajador (el dueño): se deja pasar
}
async function registerSettingsRoutes(app) {
    app.get("/api/settings/general", async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const s = await getOrCreateSettings(agencyId);
        return serialize(s);
    });
    app.put("/api/settings/general", async (request, reply) => {
        // El GET de esta misma ruta ahora es accesible para cualquier chatter
        // (necesitan leer las listas de Servicio/Método de pago para el
        // formulario de registrar venta, ver WORKER_ACCESSIBLE_PATH_PATTERNS en
        // index.ts), pero cambiarlas sigue siendo cosa solo del dueño/admin.
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (worker) {
            return reply.code(403).send({ error: "Solo el dueño puede cambiar los ajustes generales de la agencia." });
        }
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        await getOrCreateSettings(agencyId); // asegura que la fila existe antes del update
        const body = request.body;
        const data = {};
        if (Array.isArray(body.services))
            data.services = JSON.stringify(body.services.filter((v) => !!v && v.trim()));
        if (Array.isArray(body.paymentMethods))
            data.paymentMethods = JSON.stringify(body.paymentMethods.filter((v) => !!v && v.trim()));
        if (body.saleVerificationMode)
            data.saleVerificationMode = body.saleVerificationMode;
        if (typeof body.recentBuyerEnabled === "boolean")
            data.recentBuyerEnabled = body.recentBuyerEnabled;
        if (body.recentBuyerMode)
            data.recentBuyerMode = body.recentBuyerMode;
        if (typeof body.recentBuyerDays === "number" && body.recentBuyerDays > 0)
            data.recentBuyerDays = Math.floor(body.recentBuyerDays);
        const updated = await prisma_1.prisma.agencySettings.update({ where: { agencyId }, data });
        return serialize(updated);
    });
    app.post("/api/settings/general/payment-methods/reset", async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const updated = await prisma_1.prisma.agencySettings.upsert({
            where: { agencyId },
            create: { agencyId, services: JSON.stringify(DEFAULT_SERVICES), paymentMethods: JSON.stringify(DEFAULT_PAYMENT_METHODS) },
            update: { paymentMethods: JSON.stringify(DEFAULT_PAYMENT_METHODS) },
        });
        return serialize(updated);
    });
    app.post("/api/settings/general/services/reset", async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const updated = await prisma_1.prisma.agencySettings.upsert({
            where: { agencyId },
            create: { agencyId, services: JSON.stringify(DEFAULT_SERVICES), paymentMethods: JSON.stringify(DEFAULT_PAYMENT_METHODS) },
            update: { services: JSON.stringify(DEFAULT_SERVICES) },
        });
        return serialize(updated);
    });
    // "Comprador reciente": ids de chat de una cuenta que deben mostrar la
    // etiqueta 🔥 en la lista de Mensajes, segun el modo configurado.
    app.get("/api/accounts/:id/recent-buyers", async (request) => {
        const { id } = request.params;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const settings = await getOrCreateSettings(agencyId);
        if (!settings.recentBuyerEnabled)
            return { chatIds: [] };
        const cutoff = new Date(Date.now() - settings.recentBuyerDays * 24 * 60 * 60 * 1000);
        if (settings.recentBuyerMode === "first") {
            const firstSales = await prisma_1.prisma.fanSale.groupBy({
                by: ["chatId"],
                where: { accountId: id },
                _min: { date: true },
            });
            const chatIds = firstSales.filter((f) => f._min.date && f._min.date >= cutoff).map((f) => f.chatId);
            return { chatIds };
        }
        const recent = await prisma_1.prisma.fanSale.groupBy({
            by: ["chatId"],
            where: { accountId: id, date: { gte: cutoff } },
            _max: { date: true },
        });
        return { chatIds: recent.map((r) => r.chatId) };
    });
    // "Caché de imágenes" (ajuste de este ordenador, botón "Vaciar caché y
    // recargar"): borra las miniaturas/avatares guardados en el servidor para
    // que se vuelvan a descargar de Telegram desde cero.
    app.post("/api/settings/clear-cache", async () => {
        (0, mediaCache_1.clearMediaCache)();
        (0, contentLibrary_1.clearContentFullMediaCache)();
        (0, fullMediaCache_1.clearFullMediaCache)();
        return { ok: true };
    });
    // Configuración → General → "Espacio del servidor": cuánto disco ocupa DE
    // VERDAD el contenedor de Railway donde corre el panel (código, node_modules,
    // caché en disco si la hubiera... - la base de datos es un servicio
    // Postgres aparte de Railway, así que esto NO la mide a ella).
    //
    // OJO: esto NO usa fs.statfs. Sin un Volumen de Railway configurado (este
    // proyecto no tiene ninguno), el contenedor no tiene un disco propio con un
    // tamaño fijo - statfs devuelve el disco de la máquina física que le haya
    // tocado a Railway esa vez, compartida con otros clientes, así que un
    // "total"/"% usado" sacado de ahí no significa nada real y puede confundir
    // más que ayudar (dio pie a esto: 3 TB de "total" en una cuenta pequeña).
    // En su lugar, se suma el tamaño real de los archivos bajo /app -eso sí es
    // 100% lo que ocupa esta app, sea cual sea la máquina- y se cachea 5 min
    // (recorrer node_modules entero en cada carga sería lento de más).
    let diskUsageCache = null;
    const DISK_USAGE_CACHE_MS = 5 * 60 * 1000;
    const DISK_USAGE_MAX_ENTRIES = 300_000; // red de seguridad: no recorrer para siempre si algo raro pasa
    async function dirSizeBytes(dir) {
        let total = 0;
        let visited = 0;
        const stack = [dir];
        while (stack.length > 0) {
            const current = stack.pop();
            let entries;
            try {
                entries = await fs_1.default.promises.readdir(current, { withFileTypes: true });
            }
            catch {
                continue; // permiso denegado o desapareció mientras recorríamos: se ignora, no debe tumbar el conteo
            }
            for (const entry of entries) {
                if (++visited > DISK_USAGE_MAX_ENTRIES)
                    return total;
                const full = current + "/" + entry.name;
                if (entry.isSymbolicLink())
                    continue; // nunca seguir symlinks (evita bucles infinitos)
                if (entry.isDirectory()) {
                    stack.push(full);
                }
                else if (entry.isFile()) {
                    try {
                        total += (await fs_1.default.promises.stat(full)).size;
                    }
                    catch {
                        // el archivo pudo desaparecer justo entre el readdir y el stat: se ignora
                    }
                }
            }
        }
        return total;
    }
    app.get("/api/settings/disk-usage", async (request, reply) => {
        try {
            if (!diskUsageCache || Date.now() - diskUsageCache.at > DISK_USAGE_CACHE_MS) {
                const bytes = await dirSizeBytes("/app");
                diskUsageCache = { bytes, at: Date.now() };
            }
            return { usedBytes: diskUsageCache.bytes, measuredAt: diskUsageCache.at };
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({ error: "No se pudo leer el espacio ocupado del servidor." });
        }
    });
    // "Modo shadow" (barra lateral, solo visible para el admin): mientras esté
    // activo, todas las cuentas de Telegram conectadas se mantienen marcadas
    // como "desconectadas" (offline) de cara a Telegram, para que ningún fan
    // vea "en línea ahora" mientras se lee o responde desde el CRM. El "no
    // dejar visto" ya pasa siempre en este panel, con o sin modo shadow: nunca
    // se manda confirmación de lectura a Telegram (ver connectionPool.ts).
    app.get("/api/settings/shadow-mode", async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const s = await getOrCreateSettings(agencyId);
        return { enabled: s.shadowModeEnabled };
    });
    app.post("/api/settings/shadow-mode", async (request, reply) => {
        if (!(await requireAdminForShadowMode(request, reply)))
            return;
        const body = request.body;
        if (typeof body.enabled !== "boolean") {
            return reply.code(400).send({ error: "Falta el campo 'enabled'." });
        }
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        await getOrCreateSettings(agencyId);
        const updated = await prisma_1.prisma.agencySettings.update({
            where: { agencyId },
            data: { shadowModeEnabled: body.enabled },
        });
        await (0, connectionPool_1.setShadowModeEnabled)(agencyId, body.enabled);
        return { enabled: updated.shadowModeEnabled };
    });
}
//# sourceMappingURL=settings.js.map