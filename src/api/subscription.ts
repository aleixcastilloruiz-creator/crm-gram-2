import { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { prisma } from "../utils/prisma";
import { getOwnerSessionFromRequest } from "../utils/auth";
import { agencyIdFromRequest } from "../utils/agencyContext";
import { LEGACY_AGENCY_ID } from "../utils/agencyMigration";

/**
 * "Suscripción" (Configuración → Suscripción): cobro real por modelo
 * conectada, con Stripe, para las agencias NUEVAS que usan este CRM como
 * servicio de pago - igual que se ve en TeleCrew (29€/modelo al mes, 25€ a
 * partir de 5, un solo cobro el día 1, prorrateado si se añade/quita una
 * modelo a mitad de mes). "legacy-agency" (tu propia agencia, LUREQO
 * MANAGEMENT) NUNCA paga - ver LEGACY_AGENCY_ID.
 *
 * Fuente de verdad del cobro: Stripe. Lo que se guarda en Agency
 * (stripeCustomerId/stripeSubscriptionId/subscriptionStatus/...) es solo una
 * COPIA local, actualizada por el webhook de Stripe (ver /webhook más abajo)
 * para no tener que preguntarle a Stripe en cada carga del panel ni en cada
 * petición (ver isAgencyBlockedForBilling, que usa index.ts en el guardia
 * general de acceso).
 */

const PRICE_UNDER_5_CENTS = 2900; // 29€/modelo/mes con menos de 5 modelos
const PRICE_FROM_5_CENTS = 2500; // 25€/modelo/mes a partir de 5 modelos
const TRIAL_GRACE_PAST_DUE_MS = 3 * 24 * 60 * 60 * 1000; // 3 días de margen tras un impago

let stripeClient: Stripe | null | undefined; // undefined = aún no comprobado, null = sin configurar
function getStripe(): Stripe | null {
  if (stripeClient !== undefined) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  // Sin fijar apiVersion a propósito: así se usa siempre la que tenga
  // configurada por defecto la cuenta de Stripe (la más reciente al crearla),
  // sin tener que venir aquí a actualizar este número a mano cada vez que
  // sale una versión nueva del SDK.
  stripeClient = key ? new Stripe(key) : null;
  return stripeClient;
}

function unitPriceCentsFor(modelsCount: number): number {
  return modelsCount >= 5 ? PRICE_FROM_5_CENTS : PRICE_UNDER_5_CENTS;
}

async function requireOwner(request: any, reply: any) {
  if (getOwnerSessionFromRequest(request)) return;
  reply.code(403).send({ error: "Solo el dueño puede gestionar la suscripción." });
  return reply;
}

/**
 * Null = acceso normal. Si no es null, es el mensaje a mostrar/bloquear con
 * (ver uso en index.ts, en el guardia general de acceso): la agencia ya no
 * tiene ni prueba gratis ni plan de pago activo. SIEMPRE null para
 * "legacy-agency" - esa nunca se bloquea.
 */
export async function isAgencyBlockedForBilling(agencyId: string): Promise<string | null> {
  if (agencyId === LEGACY_AGENCY_ID) return null;
  const agency = await prisma.agency.findUnique({
    where: { id: agencyId },
    select: { subscriptionStatus: true, trialEndsAt: true, pastDueSince: true },
  });
  if (!agency) return null; // no debería pasar - si la agencia no existe, otro guardia ya lo habrá cortado antes
  const now = Date.now();

  if (!agency.subscriptionStatus) {
    // Nunca se activó un plan de pago: solo se bloquea si la prueba gratis ya terminó.
    if (agency.trialEndsAt && agency.trialEndsAt.getTime() < now) {
      return "Tu prueba gratuita ha terminado. Activa tu plan en Configuración → Suscripción para seguir usando el CRM.";
    }
    return null;
  }
  if (agency.subscriptionStatus === "active" || agency.subscriptionStatus === "trialing") return null;
  if (agency.subscriptionStatus === "past_due") {
    if (agency.pastDueSince && now - agency.pastDueSince.getTime() > TRIAL_GRACE_PAST_DUE_MS) {
      return "No se pudo cobrar tu suscripción y ya pasaron los 3 días de margen. Actualiza tu método de pago en Configuración → Suscripción.";
    }
    return null; // dentro del margen de 3 días: se deja pasar, pero el aviso ya se ve en la propia pantalla
  }
  // "canceled" / "unpaid" / cualquier otro estado final de Stripe.
  return "Tu suscripción no está activa. Actívala en Configuración → Suscripción para seguir usando el CRM.";
}

/**
 * Ajusta la cantidad del item de la suscripción de Stripe al número actual
 * de modelos (cuentas) de la agencia - Stripe prorratea solo el cambio
 * (cobra/abona la diferencia en la siguiente factura del día 1, como se
 * explica en la propia pantalla). Se llama, best-effort y sin bloquear la
 * respuesta, cada vez que se da de alta o se borra una cuenta de Telegram
 * de una agencia que YA tiene un plan activo - si la agencia no tiene
 * suscripción todavía (o Stripe no está configurado), no hace nada.
 */
export async function syncSubscriptionQuantity(agencyId: string): Promise<void> {
  try {
    if (agencyId === LEGACY_AGENCY_ID) return;
    const stripe = getStripe();
    if (!stripe) return;
    const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { stripeSubscriptionId: true } });
    if (!agency?.stripeSubscriptionId) return;
    const modelsCount = await prisma.account.count({ where: { agencyId } });
    const sub = await stripe.subscriptions.retrieve(agency.stripeSubscriptionId);
    const item = sub.items.data[0];
    if (!item) return;
    const unitPriceCents = unitPriceCentsFor(modelsCount);
    // Si el número de modelos cruzó el umbral de 5 (sube o baja del
    // descuento), hay que cambiar también el Price, no solo la cantidad -
    // ver ensurePriceForUnitAmount más abajo (reutiliza el Price de Stripe
    // ya creado para ese importe si existe, en vez de crear uno nuevo cada
    // vez).
    const price = await ensurePriceForUnitAmount(stripe, unitPriceCents);
    await stripe.subscriptions.update(agency.stripeSubscriptionId, {
      items: [{ id: item.id, price: price.id, quantity: Math.max(modelsCount, 1) }],
      proration_behavior: "create_prorations",
    });
  } catch (err) {
    console.error(`[subscription] no se pudo ajustar la cantidad de la suscripción de la agencia ${agencyId}:`, err);
  }
}

// Un Price de Stripe es inmutable (no se puede cambiar su importe una vez
// creado) - como el importe por modelo cambia según el total (29€ o 25€),
// se necesitan DOS Price distintos y se reutilizan siempre los mismos (por
// importe) en vez de crear uno nuevo en cada suscripción/ajuste. Product +
// Price se crean solos la primera vez que hacen falta.
let cachedProductId: string | null = null;
const cachedPriceByAmount = new Map<number, Stripe.Price>();
async function ensurePriceForUnitAmount(stripe: Stripe, unitAmountCents: number): Promise<Stripe.Price> {
  const cached = cachedPriceByAmount.get(unitAmountCents);
  if (cached) return cached;
  if (!cachedProductId) {
    const products = await stripe.products.list({ limit: 1, active: true });
    const existing = products.data.find((p) => p.metadata?.luxeCrmSubscription === "1");
    if (existing) {
      cachedProductId = existing.id;
    } else {
      const product = await stripe.products.create({
        name: "LUXE CRM - Suscripción por modelo",
        metadata: { luxeCrmSubscription: "1" },
      });
      cachedProductId = product.id;
    }
  }
  const prices = await stripe.prices.list({ product: cachedProductId, active: true, limit: 100 });
  const existingPrice = prices.data.find(
    (p) => p.unit_amount === unitAmountCents && p.recurring?.interval === "month" && p.currency === "eur"
  );
  const price =
    existingPrice ||
    (await stripe.prices.create({
      product: cachedProductId,
      currency: "eur",
      unit_amount: unitAmountCents,
      recurring: { interval: "month" },
    }));
  cachedPriceByAmount.set(unitAmountCents, price);
  return price;
}

export async function registerSubscriptionRoutes(app: FastifyInstance) {
  // Webhook de Stripe: SIN autenticación propia del panel (Stripe no tiene
  // nuestra sesión/cookie) - en su lugar se verifica la firma con
  // STRIPE_WEBHOOK_SECRET, que es lo que de verdad garantiza que la llamada
  // viene de Stripe y no de cualquiera que adivine esta URL. Necesita el
  // cuerpo CRUDO (sin parsear como JSON) para poder verificar esa firma, así
  // que este content-type parser solo se registra en ESTA sub-app
  // (encapsulada aparte con app.register), sin tocar el parseo JSON normal
  // del resto del panel.
  await app.register(async (instance) => {
    instance.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });
    instance.post("/api/subscription/webhook", async (request, reply) => {
      const stripe = getStripe();
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!stripe || !webhookSecret) {
        return reply.code(503).send({ error: "Stripe no está configurado." });
      }
      const signature = request.headers["stripe-signature"];
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(request.body as Buffer, signature as string, webhookSecret);
      } catch (err: any) {
        request.log.warn(err, "[subscription] firma de webhook de Stripe inválida");
        return reply.code(400).send({ error: `Firma inválida: ${err.message}` });
      }

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;
            const agencyId = session.metadata?.agencyId;
            if (agencyId && session.subscription) {
              const subscriptionId =
                typeof session.subscription === "string" ? session.subscription : session.subscription.id;
              const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
              await prisma.agency.update({
                where: { id: agencyId },
                data: {
                  stripeCustomerId: customerId || undefined,
                  stripeSubscriptionId: subscriptionId,
                },
              });
            }
            break;
          }
          case "customer.subscription.updated":
          case "customer.subscription.created": {
            const sub = event.data.object as Stripe.Subscription;
            const agency = await prisma.agency.findFirst({ where: { stripeSubscriptionId: sub.id } });
            if (agency) {
              await prisma.agency.update({
                where: { id: agency.id },
                data: {
                  subscriptionStatus: sub.status,
                  // Desde las versiones recientes de la API de Stripe, el fin
                  // del periodo actual vive en el ITEM de la suscripción, no
                  // en la suscripción misma.
                  currentPeriodEnd: sub.items.data[0]
                    ? new Date(sub.items.data[0].current_period_end * 1000)
                    : undefined,
                  // Se marca el primer impago SOLO la primera vez que se ve
                  // "past_due" (si ya estaba puesto, no se pisa) - y se
                  // limpia en cuanto deja de estarlo.
                  pastDueSince: sub.status === "past_due" ? agency.pastDueSince || new Date() : null,
                },
              });
            }
            break;
          }
          case "customer.subscription.deleted": {
            const sub = event.data.object as Stripe.Subscription;
            const agency = await prisma.agency.findFirst({ where: { stripeSubscriptionId: sub.id } });
            if (agency) {
              await prisma.agency.update({
                where: { id: agency.id },
                data: { subscriptionStatus: "canceled", pastDueSince: null },
              });
            }
            break;
          }
          default:
            break; // el resto de eventos no nos hace falta escucharlos
        }
      } catch (err) {
        request.log.error(err, "[subscription] error procesando webhook de Stripe");
        // Devolvemos 200 igualmente: un reintento de Stripe no va a arreglar
        // un error nuestro de procesamiento, y si devolviéramos error Stripe
        // seguiría reintentando este mismo evento indefinidamente.
      }
      return { received: true };
    });
  });

  // Estado actual + cálculo del precio (lo que pinta la pantalla de
  // Suscripción) - ver Suscripción en TeleCrew para el mismo diseño/lógica.
  app.get("/api/subscription", { preHandler: requireOwner }, async (request, reply) => {
    const agencyId = await agencyIdFromRequest(request);
    if (agencyId === LEGACY_AGENCY_ID) {
      return { isLegacyAgency: true };
    }
    const agency = await prisma.agency.findUniqueOrThrow({ where: { id: agencyId } });
    const accounts = await prisma.account.findMany({
      where: { agencyId },
      select: { id: true, label: true, health: true },
      orderBy: { label: "asc" },
    });
    const modelsCount = accounts.length;
    const unitPriceCents = unitPriceCentsFor(modelsCount);
    const totalCents = modelsCount * unitPriceCents;
    const discountUnlockedAt = 5;
    return {
      isLegacyAgency: false,
      stripeConfigured: !!getStripe(),
      models: accounts.map((a) => ({ id: a.id, label: a.label, connected: a.health !== "DISABLED" })),
      modelsCount,
      unitPriceCents,
      totalCents,
      discountUnlockedAt,
      priceUnder5Cents: PRICE_UNDER_5_CENTS,
      priceFrom5Cents: PRICE_FROM_5_CENTS,
      subscriptionStatus: agency.subscriptionStatus,
      trialEndsAt: agency.trialEndsAt,
      currentPeriodEnd: agency.currentPeriodEnd,
      pastDueSince: agency.pastDueSince,
      blockedReason: await isAgencyBlockedForBilling(agencyId),
    };
  });

  // "Activar plan ahora": Checkout de Stripe (mode "subscription"), con
  // cantidad = nº de modelos actuales ya puesta - Stripe se encarga del
  // formulario de pago, 3D Secure, etc. returnUrl lo manda el frontend
  // (window.location.origin + la propia pantalla) para no depender de
  // adivinar el dominio público detrás del proxy de Railway.
  app.post("/api/subscription/activate", { preHandler: requireOwner }, async (request, reply) => {
    const agencyId = await agencyIdFromRequest(request);
    if (agencyId === LEGACY_AGENCY_ID) {
      return reply.code(400).send({ error: "Tu propia agencia no necesita suscripción." });
    }
    const stripe = getStripe();
    if (!stripe) {
      return reply.code(503).send({
        error: "Falta configurar Stripe en el servidor (STRIPE_SECRET_KEY) - avisa a soporte para activarlo.",
      });
    }
    const body = request.body as { returnUrl?: string };
    const returnUrl = (body.returnUrl || "").trim();
    if (!returnUrl) return reply.code(400).send({ error: "Falta returnUrl." });

    const agency = await prisma.agency.findUniqueOrThrow({ where: { id: agencyId } });
    const modelsCount = Math.max(await prisma.account.count({ where: { agencyId } }), 1);
    const unitPriceCents = unitPriceCentsFor(modelsCount);
    const price = await ensurePriceForUnitAmount(stripe, unitPriceCents);

    let customerId = agency.stripeCustomerId || undefined;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: agency.ownerEmail,
        name: agency.name,
        metadata: { agencyId },
      });
      customerId = customer.id;
      await prisma.agency.update({ where: { id: agencyId }, data: { stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: price.id, quantity: modelsCount }],
      success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}suscripcion=ok`,
      cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}suscripcion=cancelado`,
      // "Se paga una sola vez al mes, siempre el día 1": se ancla el ciclo de
      // facturación al día 1 del mes siguiente - Stripe cobra ahora mismo
      // solo la parte proporcional hasta esa fecha (prorrateado), y a partir
      // de ahí ya cobra siempre el día 1 completo.
      subscription_data: {
        billing_cycle_anchor: nextFirstOfMonth(),
        proration_behavior: "create_prorations",
        metadata: { agencyId },
      } as any,
      metadata: { agencyId },
    });
    return { url: session.url };
  });

  // "Actualizar" (ver TeleCrew): portal de cliente de Stripe - desde ahí
  // puede cambiar el método de pago, ver facturas o cancelar el plan, sin
  // que nosotros tengamos que construir nada de eso a mano.
  app.post("/api/subscription/portal", { preHandler: requireOwner }, async (request, reply) => {
    const agencyId = await agencyIdFromRequest(request);
    if (agencyId === LEGACY_AGENCY_ID) {
      return reply.code(400).send({ error: "Tu propia agencia no necesita suscripción." });
    }
    const stripe = getStripe();
    if (!stripe) {
      return reply.code(503).send({ error: "Falta configurar Stripe en el servidor (STRIPE_SECRET_KEY)." });
    }
    const body = request.body as { returnUrl?: string };
    const returnUrl = (body.returnUrl || "").trim();
    if (!returnUrl) return reply.code(400).send({ error: "Falta returnUrl." });
    const agency = await prisma.agency.findUniqueOrThrow({ where: { id: agencyId } });
    if (!agency.stripeCustomerId) {
      return reply.code(400).send({ error: "Todavía no has activado ningún plan." });
    }
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: agency.stripeCustomerId,
      return_url: returnUrl,
    });
    return { url: portalSession.url };
  });
}

/** Próximo día 1 de mes (a las 00:00 UTC) como timestamp Unix en segundos,
 * para anclar ahí el ciclo de facturación - ver subscription_data.billing_cycle_anchor
 * arriba. Si hoy ya es día 1, se usa el día 1 del MES SIGUIENTE (Stripe exige
 * que el ancla esté en el futuro). */
function nextFirstOfMonth(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.floor(next.getTime() / 1000);
}
