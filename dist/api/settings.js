"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSettingsRoutes = registerSettingsRoutes;
const prisma_1 = require("../utils/prisma");
const mediaCache_1 = require("../telegram/mediaCache");
const contentLibrary_1 = require("./contentLibrary");
/**
 * Ajustes generales de la agencia (Configuración → General), tal y como en
 * el panel de referencia: listas de servicios/métodos de pago al apuntar una
 * venta, verificación de ventas, y la etiqueta de "comprador reciente".
 * Es una unica fila ("singleton") compartida por toda la agencia.
 */
const SETTINGS_ID = "singleton";
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
async function getOrCreateSettings() {
    let s = await prisma_1.prisma.agencySettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!s) {
        s = await prisma_1.prisma.agencySettings.create({
            data: {
                id: SETTINGS_ID,
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
    };
}
async function registerSettingsRoutes(app) {
    app.get("/api/settings/general", async () => {
        const s = await getOrCreateSettings();
        return serialize(s);
    });
    app.put("/api/settings/general", async (request) => {
        await getOrCreateSettings(); // asegura que la fila existe antes del update
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
        const updated = await prisma_1.prisma.agencySettings.update({ where: { id: SETTINGS_ID }, data });
        return serialize(updated);
    });
    app.post("/api/settings/general/payment-methods/reset", async () => {
        const updated = await prisma_1.prisma.agencySettings.upsert({
            where: { id: SETTINGS_ID },
            create: { id: SETTINGS_ID, services: JSON.stringify(DEFAULT_SERVICES), paymentMethods: JSON.stringify(DEFAULT_PAYMENT_METHODS) },
            update: { paymentMethods: JSON.stringify(DEFAULT_PAYMENT_METHODS) },
        });
        return serialize(updated);
    });
    app.post("/api/settings/general/services/reset", async () => {
        const updated = await prisma_1.prisma.agencySettings.upsert({
            where: { id: SETTINGS_ID },
            create: { id: SETTINGS_ID, services: JSON.stringify(DEFAULT_SERVICES), paymentMethods: JSON.stringify(DEFAULT_PAYMENT_METHODS) },
            update: { services: JSON.stringify(DEFAULT_SERVICES) },
        });
        return serialize(updated);
    });
    // "Comprador reciente": ids de chat de una cuenta que deben mostrar la
    // etiqueta 🔥 en la lista de Mensajes, segun el modo configurado.
    app.get("/api/accounts/:id/recent-buyers", async (request) => {
        const { id } = request.params;
        const settings = await getOrCreateSettings();
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
        return { ok: true };
    });
}
//# sourceMappingURL=settings.js.map