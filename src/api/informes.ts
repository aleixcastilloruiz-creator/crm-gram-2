import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { isWhatsAppConnected } from "../whatsapp/waClient";
import { agencyIdFromRequest } from "../utils/agencyContext";

// Una cuenta/trabajador se considera "en línea ahora" si mandó un latido de
// actividad en los últimos 5 minutos (mismo criterio informal que "Horas
// trabajadas" usa para detectar desconexiones, pero fijo y sencillo aquí
// porque el Dashboard es solo una foto rápida, no el detalle por turnos).
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Informes → Ingresos: agrega las ventas (FanSale) registradas desde el
 * panel ("registrar venta" en la ficha del fan) en un rango de fechas,
 * con desglose por día / modelo / servicio / método de pago / top fans,
 * más una comparación contra el periodo anterior de la misma duración
 * (igual que "+X% vs Y€ antes" del panel de referencia).
 *
 * Todo se calcula en memoria (no con groupBy de Prisma) porque hace falta
 * cruzar FanSale con FanNote (para el nombre del fan) y con Account (para
 * el nombre de la modelo), y el volumen de ventas de una agencia no es tan
 * grande como para que esto sea un problema de rendimiento.
 */
export async function registerInformesRoutes(app: FastifyInstance) {
  // Resumen rápido del estado de la agencia (ingresos de hoy/este mes,
  // cuentas, campañas, envíos, equipo conectado, WhatsApp). Ya no es lo que
  // pinta el Dashboard de Informes (ahora es el feed de mensajes/ventas de
  // abajo, como en el panel de referencia), pero se deja disponible por si
  // hace falta un resumen así en otro sitio más adelante.
  app.get("/api/informes/dashboard-summary", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const now = new Date();
    const startToday = startOfDay(now.toISOString().slice(0, 10))!;
    const endToday = endOfDay(now.toISOString().slice(0, 10))!;
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      salesToday,
      salesMonth,
      accounts,
      campaigns,
      sentToday,
      errorsToday,
      workers,
      recentPings,
    ] = await Promise.all([
      prisma.fanSale.findMany({ where: { date: { gte: startToday, lte: endToday }, account: { agencyId } } }),
      prisma.fanSale.findMany({ where: { date: { gte: startMonth, lte: endToday }, account: { agencyId } } }),
      prisma.account.findMany({ where: { agencyId }, select: { id: true, label: true, health: true, reenviadorEnabled: true } }),
      prisma.campaign.findMany({ where: { account: { agencyId } }, select: { id: true, status: true, accountId: true } }),
      prisma.sendLog.count({ where: { level: "SENT", createdAt: { gte: startToday }, account: { agencyId } } }),
      prisma.sendLog.count({ where: { level: "ERROR", createdAt: { gte: startToday }, account: { agencyId } } }),
      prisma.worker.findMany({ where: { active: true, agencyId }, select: { id: true, name: true } }),
      prisma.workerActivityPing.findMany({
        where: { at: { gte: new Date(now.getTime() - ONLINE_WINDOW_MS) }, active: true, worker: { agencyId } },
        select: { workerId: true },
        distinct: ["workerId"],
      }),
    ]);

    const onlineWorkerIds = new Set(recentPings.map((p) => p.workerId));

    return {
      ingresosHoy: round2(sum(salesToday)),
      ventasHoy: salesToday.length,
      ingresosMes: round2(sum(salesMonth)),
      ventasMes: salesMonth.length,
      cuentas: {
        total: accounts.length,
        activas: accounts.filter((a) => a.reenviadorEnabled).length,
        pausadasPeerFlood: accounts.filter((a) => a.health === "PEER_FLOOD_PAUSED").length,
        deshabilitadas: accounts.filter((a) => a.health === "DISABLED").length,
      },
      campanas: {
        total: campaigns.length,
        activas: campaigns.filter((c) => c.status === "ACTIVE").length,
      },
      envios: { hoy: sentToday, erroresHoy: errorsToday },
      equipo: { total: workers.length, enLineaAhora: onlineWorkerIds.size },
      whatsappConectado: isWhatsAppConnected(),
    };
  });

  // Informes → Rendimiento de chatters: ventas agrupadas por "Vendido por"
  // (el campo libre que se rellena al registrar una venta desde la ficha
  // del fan), con ranking, ticket medio por chatter y comparación contra
  // el periodo anterior — mismo patrón de fechas que Ingresos.
  app.get("/api/informes/rendimiento", async (request, reply) => {
    const q = request.query as { from?: string; to?: string; accountId?: string; chatter?: string };
    if (!q.from || !q.to) {
      return reply.code(400).send({ error: "Indica un rango de fechas (from/to)." });
    }
    const from = startOfDay(q.from);
    const to = endOfDay(q.to);
    if (!from || !to || from > to) {
      return reply.code(400).send({ error: "Rango de fechas inválido." });
    }

    const durationMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - durationMs);
    const agencyId = await agencyIdFromRequest(request);
    const accountWhere = q.accountId ? { accountId: q.accountId, account: { agencyId } } : { account: { agencyId } };

    // "Vendido por" es texto libre, así que se agrupa normalizando
    // mayúsculas/espacios para que "Aitor" y "aitor " cuenten como el mismo
    // chatter, mostrando el primer valor tal cual se escribió como etiqueta.
    const soldByLabel = (s: { soldBy: string | null }) => (s.soldBy || "").trim();
    const chatterFilter = (q.chatter || "").trim().toLowerCase();

    const [accounts, workers, allSalesForList, sales, prevSales] = await Promise.all([
      prisma.account.findMany({ where: { agencyId }, select: { id: true, label: true }, orderBy: { label: "asc" } }),
      // El selector tiene que ofrecer a los empleados dados de alta en
      // Equipo aunque todavía no hayan cerrado ninguna venta con su nombre
      // exacto en "Vendido por" (campo de texto libre al registrar la
      // venta, no ligado a esta tabla) - si no, alguien nuevo nunca
      // aparecía para elegir.
      prisma.worker.findMany({ where: { agencyId }, select: { name: true } }),
      // Además de los empleados, cualquier nombre que se haya escrito a
      // mano en "Vendido por" (independiente del rango de fechas elegido,
      // para que no desaparezca del desplegable un chatter que hoy no
      // tiene ventas pero sí las tuvo otro día) - cubre ventas cerradas por
      // la propia cuenta luxe o con un nombre que no coincide con ningún
      // empleado dado de alta.
      prisma.fanSale.findMany({ where: accountWhere, select: { soldBy: true } }),
      prisma.fanSale.findMany({ where: { ...accountWhere, date: { gte: from, lte: to } } }),
      prisma.fanSale.findMany({ where: { ...accountWhere, date: { gte: prevFrom, lte: prevTo } } }),
    ]);

    const chatterNamesMap = new Map<string, string>(); // key normalizada -> etiqueta a mostrar
    for (const w of workers) {
      const name = w.name.trim();
      if (name) chatterNamesMap.set(name.toLowerCase(), name);
    }
    for (const s of allSalesForList) {
      const name = soldByLabel(s);
      if (name && !chatterNamesMap.has(name.toLowerCase())) chatterNamesMap.set(name.toLowerCase(), name);
    }
    const chatterNames = [...chatterNamesMap.values()].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

    const matchesChatter = (s: { soldBy: string | null }) => !chatterFilter || soldByLabel(s).toLowerCase() === chatterFilter;
    const withChatter = sales.filter((s) => soldByLabel(s) !== "" && matchesChatter(s));
    const withoutChatter = chatterFilter ? 0 : sales.length - sales.filter((s) => soldByLabel(s) !== "").length;

    const byChatterMap = new Map<string, { label: string; total: number; ventas: number }>();
    for (const s of withChatter) {
      const key = soldByLabel(s).toLowerCase();
      const entry = byChatterMap.get(key) || { label: soldByLabel(s), total: 0, ventas: 0 };
      entry.total += s.amount;
      entry.ventas += 1;
      byChatterMap.set(key, entry);
    }
    const byChatter = [...byChatterMap.values()]
      .map((c) => ({ label: c.label, total: round2(c.total), ventas: c.ventas, ticketMedio: round2(c.total / c.ventas) }))
      .sort((a, b) => b.total - a.total);

    const ingresos = round2(sum(withChatter));
    const prevIngresos = round2(sum(prevSales.filter((s) => soldByLabel(s) !== "" && matchesChatter(s))));
    const comparisonPct = prevIngresos > 0 ? round2(((ingresos - prevIngresos) / prevIngresos) * 100) : null;

    return {
      totals: {
        ingresos,
        ventas: withChatter.length,
        chatters: byChatter.length,
        ventasSinAsignar: withoutChatter,
      },
      comparison: { prevIngresos, comparisonPct },
      byChatter,
      accounts,
      chatters: chatterNames,
    };
  });

  // Informes → Dashboard: TODOS los mensajes enviados por el equipo (fila
  // "Enviado") y todas las ventas (fila "Venta"), de TODAS las cuentas
  // juntas, más reciente primero — igual que el Dashboard del panel de
  // referencia. "Chatter" = quién lo mandó (trabajador, o la cuenta luxe
  // si lo mandó el dueño); "Creadora" = la cuenta/modelo de Telegram.
  // Los mensajes solo empiezan a aparecer desde que se desplegó esto (no
  // hay forma de reconstruir el historial de chat de antes), igual que ya
  // pasaba con "Acumulado anterior al CRM" en las ventas.
  // Informes → Dashboard → Mensajes borrados: lo que los chatters (o el
  // dueño) han borrado desde el CRM, con el texto original, el fan, quién lo
  // envió, quién lo borró y las horas.
  app.get("/api/informes/deleted-messages", async (request) => {
    const q = request.query as { from?: string; to?: string; q?: string; chatter?: string; accountId?: string };
    const from = q.from ? startOfDay(q.from) : null;
    const to = q.to ? endOfDay(q.to) : null;
    const search = (q.q || "").trim().toLowerCase();
    const agencyId = await agencyIdFromRequest(request);
    const dateWhere: any = {};
    if (from) dateWhere.gte = from;
    if (to) dateWhere.lte = to;
    const [accounts, rows] = await Promise.all([
      prisma.account.findMany({ where: { agencyId }, select: { id: true, label: true }, orderBy: { label: "asc" } }),
      prisma.deletedMessageLog.findMany({
        where: {
          account: { agencyId },
          ...(q.accountId ? { accountId: q.accountId } : {}),
          ...(Object.keys(dateWhere).length ? { deletedAt: dateWhere } : {}),
          ...(q.chatter ? { deletedBy: q.chatter } : {}),
        },
        orderBy: { deletedAt: "desc" },
        take: 501,
      }),
    ]);
    const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
    const allChatters = await prisma.deletedMessageLog.findMany({
      where: { account: { agencyId } },
      select: { deletedBy: true },
      distinct: ["deletedBy"],
    });
    let list = rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      chatId: r.chatId,
      creadora: accountLabel.get(r.accountId) || r.accountId,
      fan: r.chatTitle || r.chatId,
      mensaje: r.message,
      mediaType: r.mediaType,
      enviadoPor: r.sentBy,
      borradoPor: r.deletedBy,
      enviadoEn: r.sentAt,
      borradoEn: r.deletedAt,
    }));
    if (search) {
      list = list.filter((r) => `${r.mensaje} ${r.fan} ${r.borradoPor} ${r.enviadoPor || ""}`.toLowerCase().includes(search));
    }
    const hasMore = list.length > 500;
    return {
      rows: list.slice(0, 500),
      hasMore,
      chatters: allChatters.map((c) => c.deletedBy).sort(),
      accounts,
    };
  });

  app.get("/api/informes/dashboard", async (request) => {
    const q = request.query as { from?: string; to?: string; q?: string; chatter?: string; accountId?: string; limit?: string };
    const from = q.from ? startOfDay(q.from) : null;
    const to = q.to ? endOfDay(q.to) : null;
    const limit = Math.min(Number(q.limit) || 150, 500);
    const search = (q.q || "").trim().toLowerCase();
    const agencyId = await agencyIdFromRequest(request);

    const accountWhere = q.accountId ? { accountId: q.accountId, account: { agencyId } } : { account: { agencyId } };
    const dateWhereMsg: any = {};
    if (from) dateWhereMsg.gte = from;
    if (to) dateWhereMsg.lte = to;
    const dateWhereSale: any = {};
    if (from) dateWhereSale.gte = from;
    if (to) dateWhereSale.lte = to;

    const [accounts, messages, sales] = await Promise.all([
      prisma.account.findMany({ where: { agencyId }, select: { id: true, label: true }, orderBy: { label: "asc" } }),
      prisma.chatterMessageLog.findMany({
        where: {
          ...accountWhere,
          ...(Object.keys(dateWhereMsg).length ? { sentAt: dateWhereMsg } : {}),
          ...(q.chatter ? { workerName: q.chatter } : {}),
        },
        orderBy: { sentAt: "desc" },
        take: 600,
      }),
      prisma.fanSale.findMany({
        where: {
          ...accountWhere,
          ...(Object.keys(dateWhereSale).length ? { date: dateWhereSale } : {}),
          ...(q.chatter ? { soldBy: q.chatter } : {}),
        },
        orderBy: { date: "desc" },
        take: 600,
      }),
    ]);

    const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));

    // Nombre del fan para las filas de venta (FanSale no guarda el título,
    // a diferencia de ChatterMessageLog): se completa con FanNote, igual
    // que en Informes → Ingresos.
    const saleKeys = sales.map((s) => ({ accountId: s.accountId, chatId: s.chatId }));
    const fanNotes = saleKeys.length
      ? await prisma.fanNote.findMany({
          where: { OR: saleKeys },
          select: { accountId: true, chatId: true, chatTitle: true },
        })
      : [];
    const fanTitle = new Map(fanNotes.map((n) => [`${n.accountId}:${n.chatId}`, n.chatTitle]));

    const rows: any[] = [];
    for (const m of messages) {
      rows.push({
        id: `msg:${m.id}`,
        chatter: m.workerName,
        accountId: m.accountId,
        creadora: accountLabel.get(m.accountId) || "",
        chatId: m.chatId,
        fan: m.chatTitle || m.chatId,
        accion: "Enviado",
        mensaje: m.message,
        fecha: m.sentAt,
        responseSeconds: m.responseSeconds,
      });
    }
    for (const s of sales) {
      rows.push({
        id: `sale:${s.id}`,
        chatter: s.soldBy || "(sin asignar)",
        accountId: s.accountId,
        creadora: accountLabel.get(s.accountId) || "",
        chatId: s.chatId,
        fan: fanTitle.get(`${s.accountId}:${s.chatId}`) || s.chatId,
        accion: "Venta",
        mensaje: s.detail || [s.service, s.amount ? `${s.amount}€` : null].filter(Boolean).join(" · ") || "Venta registrada",
        fecha: s.date,
        responseSeconds: null,
      });
    }

    rows.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());

    const chatterNames = [...new Set([...messages.map((m) => m.workerName), ...sales.map((s) => s.soldBy).filter(Boolean) as string[]])].sort();

    let filtered = rows;
    if (search) {
      filtered = filtered.filter((r) =>
        r.mensaje.toLowerCase().includes(search) || r.fan.toLowerCase().includes(search) || r.chatter.toLowerCase().includes(search)
      );
    }

    return {
      rows: filtered.slice(0, limit),
      hasMore: filtered.length > limit,
      chatters: chatterNames,
      accounts,
    };
  });

  app.get("/api/informes/ingresos", async (request, reply) => {
    const q = request.query as { from?: string; to?: string; accountId?: string; chatter?: string };
    if (!q.from || !q.to) {
      return reply.code(400).send({ error: "Indica un rango de fechas (from/to)." });
    }

    const from = startOfDay(q.from);
    const to = endOfDay(q.to);
    if (!from || !to || from > to) {
      return reply.code(400).send({ error: "Rango de fechas inválido." });
    }

    // Periodo anterior, misma duración, justo antes de "from", para la
    // comparación "+X% vs periodo anterior".
    const durationMs = to.getTime() - from.getTime();
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - durationMs);

    const agencyId = await agencyIdFromRequest(request);
    const accountWhere = q.accountId ? { accountId: q.accountId, account: { agencyId } } : { account: { agencyId } };

    // "Vendido por" es texto libre (igual que en Rendimiento de chatters):
    // se normaliza mayúsculas/espacios para filtrar sin que "Aitor" y
    // "aitor " cuenten como personas distintas.
    const soldByLabel = (s: { soldBy: string | null }) => (s.soldBy || "").trim();
    const chatterFilter = (q.chatter || "").trim().toLowerCase();
    const chatterWhere = chatterFilter ? { soldBy: { equals: q.chatter, mode: "insensitive" as const } } : {};

    const [accounts, workers, allSalesForList, sales, prevSales] = await Promise.all([
      prisma.account.findMany({ where: { agencyId }, select: { id: true, label: true }, orderBy: { label: "asc" } }),
      // Igual que en Rendimiento de chatters: el desplegable ofrece a los
      // empleados dados de alta en Equipo aunque todavía no hayan cerrado
      // ninguna venta con su nombre exacto en "Vendido por".
      prisma.worker.findMany({ where: { agencyId }, select: { name: true } }),
      prisma.fanSale.findMany({ where: accountWhere, select: { soldBy: true } }),
      prisma.fanSale.findMany({ where: { ...accountWhere, ...chatterWhere, date: { gte: from, lte: to } } }),
      prisma.fanSale.findMany({ where: { ...accountWhere, ...chatterWhere, date: { gte: prevFrom, lte: prevTo } } }),
    ]);

    const chatterNamesMap = new Map<string, string>(); // key normalizada -> etiqueta a mostrar
    for (const w of workers) {
      const name = w.name.trim();
      if (name) chatterNamesMap.set(name.toLowerCase(), name);
    }
    for (const s of allSalesForList) {
      const name = soldByLabel(s);
      if (name && !chatterNamesMap.has(name.toLowerCase())) chatterNamesMap.set(name.toLowerCase(), name);
    }
    const chatterNames = [...chatterNamesMap.values()].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

    const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));

    const ingresos = sum(sales);
    const ventas = sales.length;
    const ticketMedio = ventas > 0 ? ingresos / ventas : 0;
    const fansQuePagaron = new Set(sales.map((s) => `${s.accountId}:${s.chatId}`)).size;
    const ventaMasAlta = sales.reduce((max, s) => Math.max(max, s.amount), 0);
    const modelosConIngresos = new Set(sales.map((s) => s.accountId)).size;

    const prevIngresos = sum(prevSales);
    const comparisonPct = prevIngresos > 0 ? ((ingresos - prevIngresos) / prevIngresos) * 100 : null;

    // --- Por día (para el gráfico "Ingresos por día") ---
    const byDayMap = new Map<string, number>();
    for (const s of sales) {
      const day = s.date.toISOString().slice(0, 10);
      byDayMap.set(day, (byDayMap.get(day) || 0) + s.amount);
    }
    const byDay = [...byDayMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, total]) => ({ day, total: round2(total) }));

    // --- Ranking de modelos ---
    const byModelMap = new Map<string, { total: number; ventas: number }>();
    for (const s of sales) {
      const row = byModelMap.get(s.accountId) || { total: 0, ventas: 0 };
      row.total += s.amount;
      row.ventas += 1;
      byModelMap.set(s.accountId, row);
    }
    const byModel = [...byModelMap.entries()]
      .map(([accountId, row]) => ({
        accountId,
        label: accountLabel.get(accountId) || "(cuenta eliminada)",
        total: round2(row.total),
        ventas: row.ventas,
      }))
      .sort((a, b) => b.total - a.total);

    // --- Por servicio ---
    const byService = groupByLabel(sales, (s) => s.service || "(sin especificar)");

    // --- Por método de pago ---
    const byPaymentMethod = groupByLabel(sales, (s) => s.paymentMethod || "(sin especificar)");

    // --- Top fans (los que más han dejado en el periodo) ---
    const byFanMap = new Map<string, { accountId: string; chatId: string; total: number; ventas: number }>();
    for (const s of sales) {
      const key = `${s.accountId}:${s.chatId}`;
      const row = byFanMap.get(key) || { accountId: s.accountId, chatId: s.chatId, total: 0, ventas: 0 };
      row.total += s.amount;
      row.ventas += 1;
      byFanMap.set(key, row);
    }
    const topFanRows = [...byFanMap.values()].sort((a, b) => b.total - a.total).slice(0, 10);
    const fanNotes = topFanRows.length
      ? await prisma.fanNote.findMany({
          where: { OR: topFanRows.map((r) => ({ accountId: r.accountId, chatId: r.chatId })) },
          select: { accountId: true, chatId: true, chatTitle: true },
        })
      : [];
    const fanTitle = new Map(fanNotes.map((n) => [`${n.accountId}:${n.chatId}`, n.chatTitle]));
    const topFans = topFanRows.map((r) => ({
      chatId: r.chatId,
      accountId: r.accountId,
      modelLabel: accountLabel.get(r.accountId) || "",
      fanTitle: fanTitle.get(`${r.accountId}:${r.chatId}`) || r.chatId,
      total: round2(r.total),
      ventas: r.ventas,
    }));

    return {
      totals: {
        ingresos: round2(ingresos),
        ventas,
        ticketMedio: round2(ticketMedio),
        fansQuePagaron,
        ventaMasAlta: round2(ventaMasAlta),
        modelosConIngresos,
        totalModelos: accounts.length,
      },
      comparison: { prevIngresos: round2(prevIngresos), comparisonPct: comparisonPct === null ? null : round2(comparisonPct) },
      byDay,
      byModel,
      byService,
      byPaymentMethod,
      topFans,
      accounts,
      chatters: chatterNames,
    };
  });
}

function sum(sales: { amount: number }[]): number {
  return sales.reduce((total, s) => total + s.amount, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function groupByLabel<T extends { amount: number }>(rows: T[], labelFn: (row: T) => string) {
  const map = new Map<string, { total: number; ventas: number }>();
  for (const row of rows) {
    const label = labelFn(row);
    const entry = map.get(label) || { total: 0, ventas: 0 };
    entry.total += row.amount;
    entry.ventas += 1;
    map.set(label, entry);
  }
  return [...map.entries()]
    .map(([label, v]) => ({ label, total: round2(v.total), ventas: v.ventas }))
    .sort((a, b) => b.total - a.total);
}

function startOfDay(dateStr: string): Date | null {
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function endOfDay(dateStr: string): Date | null {
  const d = new Date(dateStr + "T23:59:59.999");
  return isNaN(d.getTime()) ? null : d;
}
