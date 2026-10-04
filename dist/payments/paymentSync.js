"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCredentials = parseCredentials;
exports.verifyStripeKey = verifyStripeKey;
exports.verifyPayPalCredentials = verifyPayPalCredentials;
exports.syncPaymentAccount = syncPaymentAccount;
exports.syncAllPaymentAccounts = syncAllPaymentAccounts;
const prisma_1 = require("../utils/prisma");
const crypto_1 = require("../utils/crypto");
function parseCredentials(paymentAccount) {
    return JSON.parse((0, crypto_1.decryptSecret)(paymentAccount.credentials));
}
/** Nombre/correo del pagador, lo mejor que Stripe nos deje ver con una clave
 * restringida de solo Charges (sin permiso de Customers no siempre viene el
 * nombre en el propio cargo). */
function stripePayerFromCharge(charge) {
    const billing = charge.billing_details || {};
    return {
        name: billing.name || (charge.customer && charge.customer.name) || null,
        email: billing.email || (charge.customer && charge.customer.email) || null,
    };
}
/** Comprueba que la clave restringida de Stripe es válida y de solo lectura
 * (una llamada barata, /v1/balance) - se usa al conectar la cuenta, antes de
 * guardar nada, para no guardar una clave que no funciona o dar una falsa
 * sensación de "conectado". */
async function verifyStripeKey(restrictedKey) {
    const res = await fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: "Bearer " + restrictedKey },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || "Stripe rechazó la clave (revisa que sea correcta y no haya caducado).");
    }
}
/** Trae los cargos cobrados (paid=true) desde `sinceUnix` (o los últimos 90
 * días si es la primera vez), paginando con starting_after. Devuelve como
 * mucho 1000 por pasada (agencias pequeñas de sobra; si hiciera falta más,
 * el siguiente sync periódico sigue trayendo el resto). */
async function fetchStripeCharges(restrictedKey, sinceUnix) {
    const out = [];
    let startingAfter = null;
    for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ limit: "100", "created[gte]": String(sinceUnix) });
        if (startingAfter)
            params.set("starting_after", startingAfter);
        const res = await fetch(`https://api.stripe.com/v1/charges?${params.toString()}`, {
            headers: { Authorization: "Bearer " + restrictedKey },
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body?.error?.message || `Stripe devolvió un error (${res.status})`);
        }
        const data = await res.json();
        const charges = (data.data || []).filter((c) => c.paid && !c.refunded);
        out.push(...charges);
        if (!data.has_more || charges.length === 0)
            break;
        startingAfter = data.data[data.data.length - 1]?.id || null;
        if (!startingAfter)
            break;
    }
    return out;
}
async function getPayPalAccessToken(clientId, secret, sandbox) {
    const base = sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
    const res = await fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(`${clientId}:${secret}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error_description || "PayPal rechazó las credenciales (revisa Client ID y Secret).");
    }
    const data = await res.json();
    return data.access_token;
}
async function verifyPayPalCredentials(clientId, secret, sandbox) {
    await getPayPalAccessToken(clientId, secret, sandbox);
}
/** La API "Transaction Search" de PayPal solo deja pedir tramos de 31 días
 * como mucho por llamada - si hace falta traer más (primera sincronización,
 * o llevaba mucho sin sincronizarse), se pide en varios tramos seguidos, con
 * un tope para no quedarse aquí eternamente en una cuenta muy antigua (el
 * siguiente sync periódico sigue avanzando desde donde se quedó). */
async function fetchPayPalTransactions(clientId, secret, sandbox, sinceMs) {
    const token = await getPayPalAccessToken(clientId, secret, sandbox);
    const base = sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
    const out = [];
    let cursor = sinceMs;
    const now = Date.now();
    for (let chunk = 0; chunk < 6 && cursor < now; chunk++) {
        const chunkEnd = Math.min(cursor + THIRTY_ONE_DAYS, now);
        let page = 1;
        for (let p = 0; p < 20; p++) {
            const params = new URLSearchParams({
                start_date: new Date(cursor).toISOString(),
                end_date: new Date(chunkEnd).toISOString(),
                fields: "transaction_info,payer_info",
                page_size: "100",
                page: String(page),
            });
            const res = await fetch(`${base}/v1/reporting/transactions?${params.toString()}`, {
                headers: { Authorization: "Bearer " + token },
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body?.message || `PayPal devolvió un error (${res.status})`);
            }
            const data = await res.json();
            out.push(...(data.transaction_details || []));
            if (page >= (data.total_pages || 1))
                break;
            page++;
        }
        cursor = chunkEnd;
    }
    return out;
}
/** Sincroniza UNA cuenta de cobro: pide lo nuevo desde el último sync (o los
 * últimos 90 días si nunca se sincronizó), y guarda cada pago cobrado que
 * todavía no estuviera guardado (el índice único paymentAccountId+externalId
 * hace que repetir un pago ya guardado no falle ni lo duplique). Nunca lanza
 * hacia fuera: el error se guarda en lastSyncError para verlo en el panel, y
 * quien haya llamado a esto (sync manual o el periódico) sigue con las
 * demás cuentas aunque esta falle. */
async function syncPaymentAccount(paymentAccountId) {
    const account = await prisma_1.prisma.paymentAccount.findUnique({ where: { id: paymentAccountId } });
    if (!account || !account.active)
        return;
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const sinceMs = account.lastSyncedAt ? account.lastSyncedAt.getTime() : Date.now() - NINETY_DAYS_MS;
    try {
        if (account.kind === "stripe") {
            const creds = parseCredentials(account);
            const charges = await fetchStripeCharges(creds.restrictedKey, Math.floor(sinceMs / 1000));
            for (const c of charges) {
                const payer = stripePayerFromCharge(c);
                await prisma_1.prisma.incomingPayment.upsert({
                    where: { paymentAccountId_externalId: { paymentAccountId: account.id, externalId: c.id } },
                    update: {},
                    create: {
                        paymentAccountId: account.id,
                        externalId: c.id,
                        payerName: payer.name,
                        payerEmail: payer.email,
                        amount: c.amount / 100,
                        currency: (c.currency || "eur").toUpperCase(),
                        occurredAt: new Date(c.created * 1000),
                    },
                });
            }
        }
        else if (account.kind === "paypal") {
            const creds = parseCredentials(account);
            const txs = await fetchPayPalTransactions(creds.clientId, creds.secret, account.sandbox, sinceMs);
            for (const t of txs) {
                const info = t.transaction_info || {};
                // "S" = Success. Solo dinero que ENTRA (importe positivo) - los
                // pagos salientes de la propia agencia (comisiones, reembolsos) no
                // son "Ingresos".
                const amountStr = info.transaction_amount?.value;
                if (info.transaction_status !== "S" || !amountStr || Number(amountStr) <= 0)
                    continue;
                const payer = t.payer_info || {};
                const payerName = payer.payer_name
                    ? [payer.payer_name.given_name, payer.payer_name.surname].filter(Boolean).join(" ") || null
                    : null;
                await prisma_1.prisma.incomingPayment.upsert({
                    where: { paymentAccountId_externalId: { paymentAccountId: account.id, externalId: info.transaction_id } },
                    update: {},
                    create: {
                        paymentAccountId: account.id,
                        externalId: info.transaction_id,
                        payerName,
                        payerEmail: payer.email_address || null,
                        amount: Number(amountStr),
                        currency: info.transaction_amount?.currency_code || "EUR",
                        occurredAt: new Date(info.transaction_initiation_date),
                    },
                });
            }
        }
        await prisma_1.prisma.paymentAccount.update({
            where: { id: account.id },
            data: { lastSyncedAt: new Date(), lastSyncError: null },
        });
    }
    catch (err) {
        await prisma_1.prisma.paymentAccount.update({
            where: { id: account.id },
            data: { lastSyncError: err?.message || String(err) },
        }).catch(() => { });
    }
}
/** Sincroniza todas las cuentas de cobro activas, una detrás de otra (nunca
 * a la vez: Stripe/PayPal tienen límites de peticiones por segundo, y una
 * agencia normal tiene como mucho un puñado de cuentas conectadas). */
async function syncAllPaymentAccounts() {
    const accounts = await prisma_1.prisma.paymentAccount.findMany({ where: { active: true }, select: { id: true } });
    for (const a of accounts) {
        await syncPaymentAccount(a.id).catch(() => { });
    }
}
//# sourceMappingURL=paymentSync.js.map