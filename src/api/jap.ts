import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import {
  JapNotConfiguredError,
  japGetBalance,
  japGetOrderStatus,
  japGetServices,
  japPlaceOrder,
} from "../utils/japClient";
import { getExchangeRateToEur } from "../utils/exchangeRate";
import { agencyIdFromRequest } from "../utils/agencyContext";

/**
 * "SFS" → Just Another Panel: comprar servicios (vistas/miembros/
 * reacciones...) directamente desde el CRM contra la API de Just Another
 * Panel (panel SMM estándar, ver utils/japClient.ts). Guardamos cada pedido
 * en JapOrder para tener historial propio y poder refrescar su estado a
 * mano, sin depender de que el panel lo notifique.
 *
 * La lista de servicios de un panel SMM puede tener miles de filas y no
 * cambia apenas: se cachea en memoria 10 minutos para no golpear la API de
 * JAP en cada visita a la pantalla.
 */
let servicesCache: { at: number; data: any[] } | null = null;
const SERVICES_CACHE_MS = 10 * 60 * 1000;

function japErrorMessage(err: unknown): string {
  if (err instanceof JapNotConfiguredError) return err.message;
  return err instanceof Error ? err.message : "Error hablando con Just Another Panel.";
}

const JAP_NOTES_KEY = "jap.notes";

export async function registerJapRoutes(app: FastifyInstance) {
  // Apuntes generales de "Just Another Panel": un único cuadro de texto
  // para todo el panel (no por creadora ni por pedido), que NUNCA se borra
  // solo, ni siquiera al hacer un pedido - a diferencia del formulario de
  // arriba (enlace/cantidad/servicio), que sí se limpia tras cada compra.
  // Se guarda en AppSetting (clave-valor genérica ya usada para otros
  // ajustes sueltos del panel, ver workHours.ts) para no tener que crear
  // una tabla nueva solo para esto.
  app.get("/api/jap/notes", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const row = await prisma.appSetting.findUnique({ where: { key: `${agencyId}:${JAP_NOTES_KEY}` } });
    return { notes: row?.value || "" };
  });

  app.put("/api/jap/notes", async (request) => {
    const body = request.body as { notes?: string };
    const notes = body.notes ?? "";
    const agencyId = await agencyIdFromRequest(request);
    const key = `${agencyId}:${JAP_NOTES_KEY}`;
    await prisma.appSetting.upsert({
      where: { key },
      update: { value: notes },
      create: { key, value: notes },
    });
    return { ok: true };
  });

  app.get("/api/jap/balance", async (request, reply) => {
    try {
      const balance = await japGetBalance();
      return balance;
    } catch (err) {
      return reply.code(502).send({ error: japErrorMessage(err) });
    }
  });

  // La agencia quiere ver todos los importes de este panel en euros (saldo,
  // precio por servicio, coste de un pedido), aunque el panel de JAP cobre
  // en su propia moneda (normalmente USD) - esto solo da la TASA para que
  // el frontend convierta al pintar, nunca toca lo que de verdad se guarda
  // (JapOrder.currency sigue siendo la moneda real del panel).
  app.get("/api/jap/eur-rate", async (request, reply) => {
    const { currency } = request.query as { currency?: string };
    try {
      const rate = await getExchangeRateToEur(currency || "USD");
      return { rate, currency: (currency || "USD").toUpperCase() };
    } catch (err) {
      return reply.code(502).send({ error: japErrorMessage(err) });
    }
  });

  app.get("/api/jap/services", async (request, reply) => {
    const force = (request.query as any)?.refresh === "1";
    if (!force && servicesCache && Date.now() - servicesCache.at < SERVICES_CACHE_MS) {
      return { services: servicesCache.data };
    }
    try {
      const services = await japGetServices();
      servicesCache = { at: Date.now(), data: services };
      return { services };
    } catch (err) {
      return reply.code(502).send({ error: japErrorMessage(err) });
    }
  });

  app.get("/api/jap/orders", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    const agencyId = await agencyIdFromRequest(request);
    const orders = await prisma.japOrder.findMany({
      where: accountId ? { accountId, agencyId } : { agencyId },
      orderBy: { createdAt: "desc" },
      include: { account: { select: { id: true, label: true } } },
    });
    return { orders };
  });

  app.post("/api/jap/orders", async (request, reply) => {
    const body = request.body as {
      accountId?: string | null;
      serviceId?: number;
      serviceName?: string;
      link?: string;
      quantity?: number;
    };
    if (!body.serviceId || !body.link || !body.quantity) {
      return reply.code(400).send({ error: "Faltan datos del pedido (servicio, enlace o cantidad)." });
    }
    const agencyId = await agencyIdFromRequest(request);
    if (body.accountId) {
      const owned = await prisma.account.findFirst({ where: { id: body.accountId, agencyId } });
      if (!owned) return reply.code(400).send({ error: "Esa modelo no existe en tu agencia." });
    }
    try {
      const result = await japPlaceOrder(body.serviceId, body.link.trim(), Number(body.quantity));
      // Nada más pedirlo se intenta ya una consulta de estado: la mayoría de
      // paneles SMM (JAP incluido) devuelven "charge" (el coste real, ya con
      // redondeos/mínimos del panel aplicados) desde el primer instante, así
      // que no hace falta esperar a que el chatter/admin le dé al botón
      // "↻" para saber cuánto costó de verdad. Si esta consulta falla (panel
      // lento, etc.) el pedido se guarda igual, solo que sin charge todavía
      // -se rellenará en cuanto se refresque a mano.
      let charge: string | undefined;
      let currency: string | undefined;
      try {
        const status = await japGetOrderStatus(String(result.order));
        charge = status.charge;
        currency = status.currency;
      } catch {
        // se deja sin charge - el botón "↻" del historial lo trae más tarde
      }
      const order = await prisma.japOrder.create({
        data: {
          agencyId,
          accountId: body.accountId || null,
          japOrderId: String(result.order),
          serviceId: body.serviceId,
          serviceName: body.serviceName || "",
          link: body.link.trim(),
          quantity: Number(body.quantity),
          status: "Pending",
          charge,
          currency,
        },
      });
      return { order };
    } catch (err) {
      return reply.code(502).send({ error: japErrorMessage(err) });
    }
  });

  app.post("/api/jap/orders/:id/refresh", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const order = await prisma.japOrder.findFirst({ where: { id, agencyId } });
    if (!order) return reply.code(404).send({ error: "Pedido no encontrado." });
    try {
      const status = await japGetOrderStatus(order.japOrderId);
      const updated = await prisma.japOrder.update({
        where: { id },
        data: {
          status: status.status,
          charge: status.charge,
          currency: status.currency,
          startCount: status.start_count,
          remains: status.remains,
        },
      });
      return { order: updated };
    } catch (err) {
      return reply.code(502).send({ error: japErrorMessage(err) });
    }
  });
}
