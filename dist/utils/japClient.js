"use strict";
// Cliente minimo para "Just Another Panel" (panel SMM de compra de
// vistas/miembros/reacciones etc). JAP usa el mismo esquema de API que casi
// todos los paneles SMM del mercado ("SMM Panel API v2"): POST
// application/x-www-form-urlencoded a un unico endpoint, con "key" (API key
// del panel) + "action" indicando que se pide. No hace falta ninguna
// libreria: usamos el fetch global de Node.
//
// La API key se guarda como variable de entorno JAP_API_KEY en Railway (el
// usuario todavia no la tiene - la sacara aparte). Sin ella, cualquier
// llamada falla con un mensaje claro en vez de reventar.
Object.defineProperty(exports, "__esModule", { value: true });
exports.JapNotConfiguredError = void 0;
exports.japGetServices = japGetServices;
exports.japGetBalance = japGetBalance;
exports.japPlaceOrder = japPlaceOrder;
exports.japGetOrderStatus = japGetOrderStatus;
exports.japGetOrdersStatus = japGetOrdersStatus;
const JAP_API_URL = "https://justanotherpanel.com/api/v2";
class JapNotConfiguredError extends Error {
    constructor() {
        super("Falta configurar JAP_API_KEY en las variables de entorno.");
        this.name = "JapNotConfiguredError";
    }
}
exports.JapNotConfiguredError = JapNotConfiguredError;
function getApiKey() {
    const key = process.env.JAP_API_KEY;
    if (!key)
        throw new JapNotConfiguredError();
    return key;
}
async function callJap(params) {
    const key = getApiKey();
    const body = new URLSearchParams();
    body.set("key", key);
    for (const [k, v] of Object.entries(params))
        body.set(k, String(v));
    const res = await fetch(JAP_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
    if (!res.ok) {
        throw new Error(`Just Another Panel respondió con error HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data && typeof data === "object" && "error" in data) {
        throw new Error(`Just Another Panel: ${data.error}`);
    }
    return data;
}
async function japGetServices() {
    const data = await callJap({ action: "services" });
    return Array.isArray(data) ? data : [];
}
async function japGetBalance() {
    return callJap({ action: "balance" });
}
async function japPlaceOrder(serviceId, link, quantity) {
    return callJap({ action: "add", service: serviceId, link, quantity });
}
async function japGetOrderStatus(japOrderId) {
    return callJap({ action: "status", order: japOrderId });
}
async function japGetOrdersStatus(japOrderIds) {
    if (japOrderIds.length === 0)
        return {};
    return callJap({ action: "status", orders: japOrderIds.join(",") });
}
//# sourceMappingURL=japClient.js.map