import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { encryptSecret } from "../utils/crypto";
import { getWorkerFromRequest } from "../utils/auth";
import { agencyIdFromRequest } from "../utils/agencyContext";
import { nowInTimezone } from "../engine/fixedEngine";
import {
  verifyStripeKey,
  verifyPayPalCredentials,
  syncPaymentAccount,
  StripeCredentials,
  PayPalCredentials,
} from "../payments/paymentSync";

// Zona horaria de referencia para "el día en curso" de un chatter en Pagos:
// no hay una zona horaria única de la agencia (cada Account tiene la suya, y
// un ingreso de Stripe/PayPal no pertenece a una sola cuenta necesariamente,
// ver scope "agency"/"models" mas abajo) - se usa la misma por defecto que ya
// tiene Account.timezone en el esquema.
const AGENCY_TIMEZONE = "Europe/Madrid";

/** Rango en UTC (para comparar con occurredAt, guardado en UTC) del "día de
 * hoy" en AGENCY_TIMEZONE - usado para limitar a un chatter a los ingresos
 * del día en curso sin fiarse de ningún from/to que mande el propio cliente
 * (ver /api/incoming-payments mas abajo: para un chatter este rango PISA
 * cualquier from/to de la petición, no se limita a ser el valor por
 * defecto). */
function todayUtcRangeInAgencyTimezone(): { start: Date; end: Date } {
  const now = new Date();
  const { minutesSinceMidnight } = nowInTimezone(AGENCY_TIMEZONE);
  const start = new Date(now.getTime() - minutesSinceMidnight * 60_000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/**
 * "Pagos": cuentas de cobro (Stripe/PayPal) conectadas de solo lectura, y los
 * ingresos que se traen de ellas para adjuntarlos a una venta (FanSale) ya
 * registrada o para registrar una nueva directamente desde aquí.
 *
 * Conectar/desconectar/forzar sincronización maneja credenciales reales de
 * dinero de la agencia, así que se restringe a "admin" (el dueño, o un
 * trabajador con rol admin) - un trabajador normal solo puede LEER los
 * ingresos que le tocan (ver allowedAccountIdsForWorker más abajo).
 */

async function requireAdmin(request: any, reply: any): Promise<boolean> {
  const worker = await getWorkerFromRequest(request);
  if (worker) {
    // Conectar/desconectar/sincronizar cuentas de cobro es "de las demás
    // opciones" reservadas al dueño/jefe - ni siquiera un Team líder llega
    // aquí, igual que un Chatter.
    reply.code(403).send({ error: "Solo el dueño puede gestionar las cuentas de cobro." });
    return false;
  }
  return true; // sin cookie de trabajador (el dueño): se deja pasar
}

/** Cuentas (modelos) a las que puede llegar este trabajador: "todas, sin
 * filtrar" (null) SOLO para el dueño/jefe (sin cookie de trabajador); un
 * Team líder tiene aquí el mismo perfil que un Chatter - solo aquellas para
 * las que tiene AL MENOS un permiso concedido (Mensajes, SFS o Mensajes
 * Pro), "las modelos que lleva". */
async function allowedAccountIdsForWorker(request: any): Promise<Set<string> | null> {
  const worker = await getWorkerFromRequest(request);
  if (!worker) return null;
  const perms = await prisma.workerPermission.findMany({ where: { workerId: worker.id }, select: { accountId: true } });
  return new Set(perms.map((p) => p.accountId));
}

function maskCredentials(kind: string, raw: any): string {
  if (kind === "stripe") {
    const key: string = raw.restrictedKey || "";
    return key.length > 10 ? key.slice(0, 8) + "…" + key.slice(-4) : "••••";
  }
  if (kind === "paypal") {
    const id: string = raw.clientId || "";
    return id.length > 8 ? id.slice(0, 6) + "…" + id.slice(-4) : "••••";
  }
  return "••••";
}

export async function registerPaymentAccountsRoutes(app: FastifyInstance) {
  // ---- Cuentas de cobro ----

  app.get("/api/payment-accounts", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const allowed = await allowedAccountIdsForWorker(request);
    const accounts = await prisma.paymentAccount.findMany({ where: { agencyId }, orderBy: { createdAt: "asc" } });
    const visible = accounts.filter((a) => {
      if (allowed === null) return true;
      if (a.scope === "agency") return true;
      const ids: string[] = JSON.parse(a.accountIds || "[]");
      return ids.some((id) => allowed.has(id));
    });
    return {
      accounts: visible.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        scope: a.scope,
        accountIds: JSON.parse(a.accountIds || "[]"),
        sandbox: a.sandbox,
        active: a.active,
        lastSyncedAt: a.lastSyncedAt,
        lastSyncError: a.lastSyncError,
        createdAt: a.createdAt,
      })),
    };
  });

  app.post("/api/payment-accounts", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as {
      kind?: "stripe" | "paypal";
      label?: string;
      scope?: "agency" | "models";
      accountIds?: string[];
      sandbox?: boolean;
      restrictedKey?: string; // stripe
      clientId?: string; // paypal
      secret?: string; // paypal
    };
    if (body.kind !== "stripe" && body.kind !== "paypal") {
      return reply.code(400).send({ error: "Elige Stripe o PayPal." });
    }
    if (!body.label || !body.label.trim()) {
      return reply.code(400).send({ error: "Ponle un nombre a la cuenta de cobro." });
    }
    if (body.scope === "models" && (!body.accountIds || body.accountIds.length === 0)) {
      return reply.code(400).send({ error: "Elige al menos una modelo, o marca que es de toda la agencia." });
    }

    const agencyId = await agencyIdFromRequest(request);
    // Nunca fiarse a ciegas de los accountIds que manda el cliente: sin este
    // chequeo, el dueño de una agencia podría (a mano, manipulando la
    // petición) apuntar una cuenta de cobro a la modelo de OTRA agencia.
    if (body.scope === "models" && body.accountIds && body.accountIds.length > 0) {
      const owned = await prisma.account.count({ where: { id: { in: body.accountIds }, agencyId } });
      if (owned !== body.accountIds.length) {
        return reply.code(400).send({ error: "Alguna de esas modelos no existe en tu agencia." });
      }
    }

    let credentials: StripeCredentials | PayPalCredentials;
    try {
      if (body.kind === "stripe") {
        const key = (body.restrictedKey || "").trim();
        if (!key) return reply.code(400).send({ error: "Pega la clave restringida de Stripe." });
        await verifyStripeKey(key);
        credentials = { restrictedKey: key } as StripeCredentials;
      } else {
        const clientId = (body.clientId || "").trim();
        const secret = (body.secret || "").trim();
        if (!clientId || !secret) return reply.code(400).send({ error: "Pega el Client ID y el Secret de PayPal." });
        await verifyPayPalCredentials(clientId, secret, !!body.sandbox);
        credentials = { clientId, secret } as PayPalCredentials;
      }
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || "No se pudo comprobar la conexión." });
    }

    const created = await prisma.paymentAccount.create({
      data: {
        agencyId,
        kind: body.kind,
        label: body.label.trim(),
        scope: body.scope === "models" ? "models" : "agency",
        accountIds: JSON.stringify(body.scope === "models" ? body.accountIds : []),
        sandbox: !!body.sandbox,
        credentials: encryptSecret(JSON.stringify(credentials)),
      },
    });

    // Primera sincronización: no se espera a que termine (puede tardar si
    // hay muchos meses de historial) - el panel ya la enseña como
    // "conectada" y los ingresos van apareciendo solos según se traen.
    syncPaymentAccount(created.id).catch(() => {});

    return { account: { id: created.id, kind: created.kind, label: created.label, scope: created.scope } };
  });

  app.delete("/api/payment-accounts/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const existing = await prisma.paymentAccount.findFirst({ where: { id, agencyId } });
    if (!existing) return reply.code(404).send({ error: "No existe esa cuenta de cobro." });
    // Soft-delete: los ingresos ya traídos de ella siguen viéndose en el
    // historial (con "(eliminada)" en el panel), en vez de desaparecer.
    await prisma.paymentAccount.update({ where: { id }, data: { active: false } });
    return { ok: true };
  });

  app.post("/api/payment-accounts/:id/sync", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const existing = await prisma.paymentAccount.findFirst({ where: { id, agencyId } });
    if (!existing) return reply.code(404).send({ error: "No existe esa cuenta de cobro." });
    if (!existing.active) return reply.code(400).send({ error: "Esta cuenta de cobro está desconectada." });
    await syncPaymentAccount(id);
    const updated = await prisma.paymentAccount.findUnique({ where: { id } });
    if (updated?.lastSyncError) return reply.code(502).send({ error: updated.lastSyncError });
    return { ok: true, lastSyncedAt: updated?.lastSyncedAt };
  });

  // ---- Ingresos ----

  app.get("/api/incoming-payments", async (request) => {
    const q = request.query as {
      search?: string;
      gateway?: string; // "all" | "stripe" | "paypal"
      paymentAccountId?: string; // "all" | id
      from?: string;
      to?: string;
      onlyUnlinked?: string;
    };
    const allowed = await allowedAccountIdsForWorker(request);
    // Un chatter (trabajador con rol "worker") solo puede ver los ingresos
    // del día en curso - a diferencia del admin (dueño, o trabajador con rol
    // admin), que puede filtrar por cualquier fecha y ver el histórico
    // entero. Esto se decide aquí, en el backend, y PISA cualquier from/to
    // que llegue en la petición: no basta con que el frontend no enseñe el
    // selector de fechas al chatter, porque cualquiera podría llamar a este
    // endpoint a mano con otro rango.
    const worker = await getWorkerFromRequest(request);
    // Cualquier trabajador (Chatter o Team líder) queda limitado al día en
    // curso - solo el dueño/jefe (sin cookie de trabajador) ve el histórico
    // entero y puede filtrar por fecha.
    const isChatterOnly = !!worker;

    const agencyId = await agencyIdFromRequest(request);
    const paymentAccounts = await prisma.paymentAccount.findMany({ where: { agencyId } });
    const visibleAccounts = paymentAccounts.filter((a) => {
      if (q.gateway && q.gateway !== "all" && a.kind !== q.gateway) return false;
      if (q.paymentAccountId && q.paymentAccountId !== "all" && a.id !== q.paymentAccountId) return false;
      if (allowed === null) return true;
      if (a.scope === "agency") return true;
      const ids: string[] = JSON.parse(a.accountIds || "[]");
      return ids.some((id) => allowed.has(id));
    });
    const accountsById = new Map(visibleAccounts.map((a) => [a.id, a]));
    if (visibleAccounts.length === 0) return { payments: [] };

    const where: any = { paymentAccountId: { in: visibleAccounts.map((a) => a.id) } };
    if (q.onlyUnlinked === "1") where.fanSaleId = null;
    if (isChatterOnly) {
      const { start, end } = todayUtcRangeInAgencyTimezone();
      where.occurredAt = { gte: start, lte: end };
    } else if (q.from || q.to) {
      where.occurredAt = {};
      if (q.from) where.occurredAt.gte = new Date(q.from);
      if (q.to) where.occurredAt.lte = new Date(q.to + "T23:59:59");
    }
    if (q.search) {
      const s = q.search.trim();
      const asNumber = Number(s.replace(",", "."));
      where.OR = [
        { payerName: { contains: s, mode: "insensitive" } },
        { payerEmail: { contains: s, mode: "insensitive" } },
        ...(Number.isFinite(asNumber) && s !== "" ? [{ amount: asNumber }] : []),
      ];
    }

    const rows = await prisma.incomingPayment.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: 300,
      include: { fanSale: { select: { id: true, accountId: true, chatId: true, service: true } } },
    });

    // A qué cliente (chat) está enlazada cada venta: tanto el admin como el
    // chatter tienen que poder verlo desde Pagos, no solo el admin desde
    // "Ir al chat". El título del chat ya está en caché de Mensajes
    // (CachedDialog, se rellena solo al abrir Mensajes de esa cuenta) - se
    // trae en un solo lote para las ventas enlazadas de esta página, en vez
    // de una consulta aparte por fila.
    const linkedPairs = rows
      .filter((r): r is typeof r & { fanSale: NonNullable<typeof r.fanSale> } => !!r.fanSale)
      .map((r) => ({ accountId: r.fanSale.accountId, chatId: r.fanSale.chatId }));
    const modelAccountIds = [...new Set(linkedPairs.map((p) => p.accountId))];
    const [modelAccounts, cachedDialogs] = await Promise.all([
      modelAccountIds.length
        ? prisma.account.findMany({ where: { id: { in: modelAccountIds } }, select: { id: true, label: true } })
        : Promise.resolve([]),
      linkedPairs.length
        ? prisma.cachedDialog.findMany({
            where: { OR: linkedPairs.map((p) => ({ accountId: p.accountId, chatId: p.chatId })) },
            select: { accountId: true, chatId: true, title: true },
          })
        : Promise.resolve([]),
    ]);
    const modelLabelById = new Map(modelAccounts.map((a) => [a.id, a.label]));
    const dialogTitleByKey = new Map(cachedDialogs.map((d) => [`${d.accountId}:${d.chatId}`, d.title]));

    return {
      payments: rows.map((r) => {
        const pa = accountsById.get(r.paymentAccountId);
        return {
          id: r.id,
          externalId: r.externalId,
          payerName: r.payerName,
          payerEmail: r.payerEmail,
          amount: r.amount,
          currency: r.currency,
          occurredAt: r.occurredAt,
          paymentAccount: pa
            ? { id: pa.id, kind: pa.kind, label: pa.label, active: pa.active }
            : { id: r.paymentAccountId, kind: "?", label: "(cuenta borrada)", active: false },
          linkedSale: r.fanSale
            ? {
                id: r.fanSale.id,
                accountId: r.fanSale.accountId,
                chatId: r.fanSale.chatId,
                service: r.fanSale.service,
                accountLabel: modelLabelById.get(r.fanSale.accountId) || null,
                chatTitle: dialogTitleByKey.get(`${r.fanSale.accountId}:${r.fanSale.chatId}`) || null,
              }
            : null,
        };
      }),
    };
  });

  // "Sincronizar venta": antes esto buscaba solo ventas (FanSale) sin
  // adjuntar con el MISMO importe y una fecha cercana (±3 días), y si
  // encontraba una sola la adjuntaba sola sin preguntar - con eso, cualquier
  // pequeña diferencia (comisión de la pasarela descontada del importe,
  // una venta apuntada con otra fecha, etc.) hacía que no saliera ningún
  // candidato y el panel mandaba directo a "Registrar venta", aunque la
  // venta de verdad YA estuviera registrada (acababa duplicada). Ahora
  // siempre devuelve las últimas ventas sin adjuntar (sin filtrar por
  // importe/fecha) para que el panel enseñe una ventana y se elija a mano
  // cuál es - las que sí coinciden en importe exacto se marcan y se dejan
  // arriba del todo para encontrarlas a simple vista.
  app.get("/api/incoming-payments/:id/candidates", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const payment = await prisma.incomingPayment.findUnique({ where: { id }, include: { paymentAccount: true } });
    if (!payment || payment.paymentAccount.agencyId !== agencyId) {
      return reply.code(404).send({ error: "No existe ese ingreso." });
    }

    const scopeIds: string[] = JSON.parse(payment.paymentAccount.accountIds || "[]");
    const allowed = await allowedAccountIdsForWorker(request);
    let accountFilter: string[] | undefined;
    if (payment.paymentAccount.scope === "models") accountFilter = scopeIds;
    if (allowed !== null) accountFilter = accountFilter ? accountFilter.filter((id2) => allowed.has(id2)) : [...allowed];

    const rows = await prisma.fanSale.findMany({
      where: {
        OR: [{ paymentRef: null }, { paymentRef: "" }],
        account: { agencyId },
        ...(accountFilter ? { accountId: { in: accountFilter } } : {}),
      },
      orderBy: { date: "desc" },
      take: 40,
      include: { account: { select: { label: true } } },
    });

    // Array.prototype.sort es estable en Node (desde V8 7.0), así que este
    // reparto en dos grupos conserva el orden por fecha descendente DENTRO
    // de cada grupo - no hace falta un comparador más complejo.
    const candidates = rows
      .map((c) => ({
        id: c.id,
        accountLabel: c.account.label,
        amount: c.amount,
        date: c.date,
        service: c.service,
        soldBy: c.soldBy,
        exactAmountMatch: c.amount === payment.amount,
      }))
      .sort((a, b) => Number(b.exactAmountMatch) - Number(a.exactAmountMatch));

    return { candidates };
  });

  // Adjunta un ingreso a una venta YA registrada (elegida a mano, o la única
  // candidata de /candidates): pone paymentRef en la venta (si no lo tenía
  // ya) y marca el ingreso como "no libre". Un chatter SÍ puede enlazar (una
  // vez enlazado, solo el admin puede deshacerlo, ver /unlink) - pero solo
  // dentro de las cuentas a las que ya tiene acceso concedido, lo mismo que
  // ya limita qué candidatas ve en /candidates: sin este chequeo, alguien
  // podría manipular la petición a mano y enlazar un pago con la venta de
  // una cuenta que no lleva.
  app.post("/api/incoming-payments/:id/link", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { saleId } = request.body as { saleId?: string };
    if (!saleId) return reply.code(400).send({ error: "Falta la venta a adjuntar." });
    const agencyId = await agencyIdFromRequest(request);
    const payment = await prisma.incomingPayment.findUnique({ where: { id }, include: { paymentAccount: true } });
    if (!payment || payment.paymentAccount.agencyId !== agencyId) {
      return reply.code(404).send({ error: "No existe ese ingreso." });
    }
    const sale = await prisma.fanSale.findUnique({ where: { id: saleId }, include: { account: { select: { agencyId: true } } } });
    if (!sale || sale.account.agencyId !== agencyId) return reply.code(404).send({ error: "No existe esa venta." });

    const allowed = await allowedAccountIdsForWorker(request);
    if (allowed !== null) {
      if (!allowed.has(sale.accountId)) {
        return reply.code(403).send({ error: "No tienes acceso a la cuenta de esa venta." });
      }
      const scopeIds: string[] = JSON.parse(payment.paymentAccount.accountIds || "[]");
      const paymentVisible = payment.paymentAccount.scope === "agency" || scopeIds.some((aid) => allowed.has(aid));
      if (!paymentVisible) {
        return reply.code(403).send({ error: "No tienes acceso a este pago." });
      }
    }

    await prisma.$transaction([
      prisma.incomingPayment.update({ where: { id }, data: { fanSaleId: saleId } }),
      prisma.fanSale.update({ where: { id: saleId }, data: { paymentRef: sale.paymentRef || payment.externalId } }),
    ]);
    return { ok: true };
  });

  // Desvincular un pago de su venta: "por una vez" que un chatter enlaza un
  // pago, deshacerlo es cosa del admin (dueño, o trabajador con rol admin) -
  // mismo criterio que el botón "Quitar de la venta" en el panel, pero
  // exigido aquí también para que no baste con manipular la petición a mano.
  app.post("/api/incoming-payments/:id/unlink", async (request, reply) => {
    const { id } = request.params as { id: string };
    const worker = await getWorkerFromRequest(request);
    if (worker) {
      return reply.code(403).send({ error: "Solo el dueño puede desvincular un pago de su venta." });
    }
    const agencyId = await agencyIdFromRequest(request);
    const payment = await prisma.incomingPayment.findUnique({ where: { id }, include: { paymentAccount: { select: { agencyId: true } } } });
    if (!payment || payment.paymentAccount.agencyId !== agencyId) {
      return reply.code(404).send({ error: "No existe ese ingreso." });
    }
    await prisma.incomingPayment.update({ where: { id }, data: { fanSaleId: null } });
    return { ok: true };
  });
}
