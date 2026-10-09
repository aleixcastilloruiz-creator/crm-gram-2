import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "../telegram/connectionPool";
import { listAccountGroupsAndChannels } from "../telegram/promoGroups";
import { agencyIdFromRequest } from "../utils/agencyContext";
// Sin @types propios de verdad para el uso que se les da aqui (build de PDF
// / Excel del veredicto): se cargan via require, igual que heic-convert en
// messages.ts - ambas son JS/TS puro, no hace falta compilar nada nativo.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require("pdfkit");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ExcelJS = require("exceljs");

/**
 * "Grupos de promoción": admins EXTERNOS (nada que ver con Configuración →
 * Equipo) a los que se paga por promocionar en sus grupos/canales de
 * Telegram: catálogo de grupos por creadora, precios por admin/creadora,
 * veredicto de rentabilidad (ingresos atribuidos vs. coste) y su
 * exportación a PDF/Excel.
 */

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Telegram está tardando demasiado en responder (${label}). Puede que la cuenta esté temporalmente limitada por Telegram - espera un momento y vuelve a intentarlo.`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function readAndCatalogAccount(accountId: string, agencyId: string): Promise<{ accountId: string; label: string; groupsFound: number }> {
  const account = await prisma.account.findFirstOrThrow({ where: { id: accountId, agencyId } });
  const client = await getAccountClient(account);
  const live = await withTimeout(listAccountGroupsAndChannels(client), 90_000, `leyendo los grupos de "${account.label}"`);

  for (const g of live) {
    const group = await prisma.promoGroup.upsert({
      where: { agencyId_chatId: { agencyId, chatId: g.chatId } },
      update: { title: g.title, isChannel: g.isChannel, memberCount: g.memberCount },
      create: { agencyId, chatId: g.chatId, title: g.title, isChannel: g.isChannel, memberCount: g.memberCount },
    });
    await prisma.promoGroupAccount.upsert({
      where: { promoGroupId_accountId: { promoGroupId: group.id, accountId } },
      update: {},
      create: { promoGroupId: group.id, accountId },
    });
  }

  return { accountId, label: account.label, groupsFound: live.length };
}

export async function registerPromoGroupRoutes(app: FastifyInstance) {
  // ---------- Admins externos ----------
  app.get("/api/promo-admins", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const admins = await prisma.promoAdmin.findMany({
      where: { agencyId },
      orderBy: { name: "asc" },
      include: {
        prices: true,
        _count: { select: { groups: true } },
      },
    });
    return {
      admins: admins.map((a) => ({
        id: a.id,
        name: a.name,
        groupCount: a._count.groups,
        generalPrice: a.prices.find((p) => p.accountId === null)?.priceMonthly ?? null,
      })),
    };
  });

  app.post("/api/promo-admins", async (request, reply) => {
    const body = request.body as { name?: string };
    const name = (body.name || "").trim();
    if (!name) return reply.code(400).send({ error: "El admin necesita un nombre." });
    const agencyId = await agencyIdFromRequest(request);
    const existing = await prisma.promoAdmin.findUnique({ where: { agencyId_name: { agencyId, name } } });
    if (existing) return reply.code(400).send({ error: "Ya existe un admin con ese nombre." });
    const admin = await prisma.promoAdmin.create({ data: { agencyId, name } });
    return { admin };
  });

  app.patch("/api/promo-admins/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; comment?: string };
    const data: { name?: string; comment?: string } = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return reply.code(400).send({ error: "El admin necesita un nombre." });
      data.name = name;
    }
    if (body.comment !== undefined) data.comment = body.comment;
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.promoAdmin.updateMany({ where: { id, agencyId }, data });
    if (count === 0) return reply.code(404).send({ error: "Admin no encontrado." });
    const admin = await prisma.promoAdmin.findUnique({ where: { id } });
    return { admin };
  });

  app.delete("/api/promo-admins/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    // Los grupos ya catalogados de este admin quedan "Sin admin asignada"
    // (onDelete: SetNull en el esquema) en vez de borrarse.
    const { count } = await prisma.promoAdmin.deleteMany({ where: { id, agencyId } });
    if (count === 0) return reply.code(404).send({ error: "Admin no encontrado." });
    return { ok: true };
  });

  // ---------- Carpetas propias del CRM (nada que ver con Telegram) ----------
  app.get("/api/promo-group-folders", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const folders = await prisma.promoGroupFolder.findMany({
      where: { agencyId },
      orderBy: { name: "asc" },
      include: { _count: { select: { groups: true } } },
    });
    return { folders: folders.map((f) => ({ id: f.id, name: f.name, groupCount: f._count.groups })) };
  });

  app.post("/api/promo-group-folders", async (request, reply) => {
    const body = request.body as { name?: string };
    const name = (body.name || "").trim();
    if (!name) return reply.code(400).send({ error: "La carpeta necesita un nombre." });
    const agencyId = await agencyIdFromRequest(request);
    const existing = await prisma.promoGroupFolder.findUnique({ where: { agencyId_name: { agencyId, name } } });
    if (existing) return reply.code(400).send({ error: "Ya existe una carpeta con ese nombre." });
    const folder = await prisma.promoGroupFolder.create({ data: { agencyId, name } });
    return { folder };
  });

  app.patch("/api/promo-group-folders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string };
    const name = (body.name || "").trim();
    if (!name) return reply.code(400).send({ error: "La carpeta necesita un nombre." });
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.promoGroupFolder.updateMany({ where: { id, agencyId }, data: { name } });
    if (count === 0) return reply.code(404).send({ error: "Carpeta no encontrada." });
    const folder = await prisma.promoGroupFolder.findUnique({ where: { id } });
    return { folder };
  });

  app.delete("/api/promo-group-folders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    // Los grupos ya clasificados con esta carpeta quedan "Sin carpeta"
    // (onDelete: SetNull en el esquema) en vez de borrarse.
    const { count } = await prisma.promoGroupFolder.deleteMany({ where: { id, agencyId } });
    if (count === 0) return reply.code(404).send({ error: "Carpeta no encontrada." });
    return { ok: true };
  });

  // ---------- Catálogo de grupos/canales ----------

  // "Leer grupos de esta creadora": lee en vivo de Telegram los
  // grupos/canales de UNA cuenta y los cataloga/actualiza.
  app.post("/api/promo-groups/read/:accountId", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const agencyId = await agencyIdFromRequest(request);
    try {
      const result = await readAndCatalogAccount(accountId, agencyId);
      return result;
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message || "No se pudieron leer los grupos de Telegram." });
    }
  });

  // "Leer las N creadoras": lee TODAS las cuentas (o las indicadas), una
  // detrás de otra -nunca en paralelo, mismo motivo que warmUpDialogsCache:
  // conectar+listar grupos de varias cuentas a la vez es justo el patrón que
  // puede hacer que Telegram limite una cuenta.
  app.post("/api/promo-groups/read-all", async (request) => {
    const body = request.body as { accountIds?: string[] };
    const agencyId = await agencyIdFromRequest(request);
    const accounts = body.accountIds?.length
      ? await prisma.account.findMany({ where: { id: { in: body.accountIds }, agencyId }, select: { id: true } })
      : await prisma.account.findMany({ where: { agencyId }, select: { id: true } });

    const results: { accountId: string; label: string; groupsFound?: number; error?: string }[] = [];
    for (const acc of accounts) {
      try {
        const r = await readAndCatalogAccount(acc.id, agencyId);
        results.push(r);
      } catch (err: any) {
        const account = await prisma.account.findUnique({ where: { id: acc.id }, select: { label: true } });
        results.push({ accountId: acc.id, label: account?.label || acc.id, error: err?.message || "fallo al leer" });
      }
    }
    return { results };
  });

  // Listado del catálogo (tabla "Clasificar grupos por admin"), con los
  // filtros del panel de referencia: por creadora, "solo sin asignar"
  // (ninguna cuenta lo tiene ya clasificado... en realidad se refiere a "sin
  // admin"), búsqueda por título.
  app.get("/api/promo-groups", async (request) => {
    const q = request.query as { accountId?: string; search?: string; onlyUnassigned?: string; promoGroupFolderId?: string; onlyUnassignedFolder?: string };
    const agencyId = await agencyIdFromRequest(request);
    const where: any = { agencyId };
    if (q.accountId) where.accounts = { some: { accountId: q.accountId } };
    if (q.search) where.title = { contains: q.search, mode: "insensitive" };
    if (q.onlyUnassigned === "true") where.promoAdminId = null;
    if (q.promoGroupFolderId) where.promoGroupFolderId = q.promoGroupFolderId;
    if (q.onlyUnassignedFolder === "true") where.promoGroupFolderId = null;

    const groups = await prisma.promoGroup.findMany({
      where,
      orderBy: { title: "asc" },
      include: {
        promoAdmin: { select: { id: true, name: true } },
        promoGroupFolder: { select: { id: true, name: true } },
        accounts: { include: { account: { select: { id: true, label: true } } } },
      },
    });

    // Columnas "Hablaron/Compraron/Conv./Ventas" del panel de referencia:
    // todo el histórico (esta tabla no tiene selector de fechas, a diferencia
    // del Veredicto), por grupo en vez de por admin. Un fan puede estar
    // atribuido a varios grupos a la vez (ver PromoGroupFanAttribution), asi
    // que aqui SI puede contar en más de un grupo - a diferencia del
    // reparto "a partes iguales" que hace el Veredicto por admin, aquí
    // interesa ver el rendimiento de CADA grupo por separado.
    const groupIds = groups.map((g) => g.id);
    const [attributions, salesRows] = groupIds.length
      ? await Promise.all([
          prisma.promoGroupFanAttribution.findMany({
            where: { promoGroupId: { in: groupIds } },
            select: { promoGroupId: true, accountId: true, chatId: true },
          }),
          prisma.fanSale.findMany({ where: { account: { agencyId } }, select: { accountId: true, chatId: true } }),
        ])
      : [[], []];

    const salesCountByFan = new Map<string, number>();
    for (const s of salesRows as { accountId: string; chatId: string }[]) {
      const key = `${s.accountId}|${s.chatId}`;
      salesCountByFan.set(key, (salesCountByFan.get(key) || 0) + 1);
    }
    // Igual que fansByGroup, pero separado por creadora dentro del mismo
    // grupo - un grupo puede tener varias modelos a la vez (ver
    // PromoGroupAccount) y se quiere poder ver "con esta modelo hablaron X,
    // con esta otra Y" en vez de solo el total combinado del grupo.
    const fansByGroup = new Map<string, Set<string>>();
    const fansByGroupAccount = new Map<string, Map<string, Set<string>>>();
    for (const a of attributions as { promoGroupId: string; accountId: string; chatId: string }[]) {
      const key = `${a.accountId}|${a.chatId}`;
      if (!fansByGroup.has(a.promoGroupId)) fansByGroup.set(a.promoGroupId, new Set());
      fansByGroup.get(a.promoGroupId)!.add(key);
      if (!fansByGroupAccount.has(a.promoGroupId)) fansByGroupAccount.set(a.promoGroupId, new Map());
      const byAccount = fansByGroupAccount.get(a.promoGroupId)!;
      if (!byAccount.has(a.accountId)) byAccount.set(a.accountId, new Set());
      byAccount.get(a.accountId)!.add(key);
    }

    function countFanSet(fanSet: Set<string>) {
      let compraron = 0;
      let ventas = 0;
      for (const key of fanSet) {
        const c = salesCountByFan.get(key) || 0;
        if (c > 0) {
          compraron++;
          ventas += c;
        }
      }
      const hablaron = fanSet.size;
      const conversion = hablaron > 0 ? (compraron / hablaron) * 100 : null;
      return { hablaron, compraron, ventas, conversion };
    }

    return {
      groups: groups.map((g) => {
        const fanSet = fansByGroup.get(g.id) || new Set<string>();
        const totals = countFanSet(fanSet);
        const byAccount = fansByGroupAccount.get(g.id) || new Map<string, Set<string>>();
        // Desglose "con esta modelo hablaron X" - una entrada por cada
        // creadora que esté dentro del grupo (aunque todavía no tenga
        // ningún fan atribuido, para que no "desaparezca" de la lista).
        const porModelo = g.accounts.map((a) => ({
          accountId: a.account.id,
          label: a.account.label,
          ...countFanSet(byAccount.get(a.account.id) || new Set<string>()),
        }));
        return {
          id: g.id,
          chatId: g.chatId,
          title: g.title,
          isChannel: g.isChannel,
          memberCount: g.memberCount,
          promoAdminId: g.promoAdminId,
          promoAdminName: g.promoAdmin?.name ?? null,
          promoGroupFolderId: g.promoGroupFolderId,
          promoGroupFolderName: g.promoGroupFolder?.name ?? null,
          // "Modelos dentro": creadoras (cuentas) que están metidas en este grupo.
          accounts: g.accounts.map((a) => ({ id: a.account.id, label: a.account.label })),
          hablaron: totals.hablaron,
          compraron: totals.compraron,
          conversion: totals.conversion,
          ventas: totals.ventas,
          porModelo,
        };
      }),
    };
  });

  // Asignar el mismo admin (o quitarlo, con promoAdminId: null) a VARIOS
  // grupos a la vez - botón "Asignar a la selección" de la tabla, para no
  // tener que ir grupo por grupo cuando se marcan muchos a mano.
  app.post("/api/promo-groups/bulk-assign", async (request, reply) => {
    const body = request.body as { groupIds?: string[]; promoAdminId?: string | null };
    if (!body.groupIds || body.groupIds.length === 0) {
      return reply.code(400).send({ error: "No hay ningún grupo seleccionado." });
    }
    const agencyId = await agencyIdFromRequest(request);
    if (body.promoAdminId) {
      const admin = await prisma.promoAdmin.findFirst({ where: { id: body.promoAdminId, agencyId } });
      if (!admin) return reply.code(400).send({ error: "Ese admin no existe en tu agencia." });
    }
    const { count } = await prisma.promoGroup.updateMany({
      where: { id: { in: body.groupIds }, agencyId },
      data: { promoAdminId: body.promoAdminId ?? null },
    });
    return { ok: true, updated: count };
  });

  // Asignar (o quitar, con promoAdminId/promoGroupFolderId: null) el admin
  // y/o la carpeta de un grupo ya catalogado - los desplegables "Admin" y
  // "Carpeta" de cada fila de la tabla. Solo se toca lo que venga presente
  // en el body (para no borrar la carpeta al cambiar solo el admin, y
  // viceversa).
  app.patch("/api/promo-groups/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { promoAdminId?: string | null; promoGroupFolderId?: string | null };
    const agencyId = await agencyIdFromRequest(request);
    const data: { promoAdminId?: string | null; promoGroupFolderId?: string | null } = {};
    if ("promoAdminId" in body) {
      if (body.promoAdminId) {
        const admin = await prisma.promoAdmin.findFirst({ where: { id: body.promoAdminId, agencyId } });
        if (!admin) return reply.code(400).send({ error: "Ese admin no existe en tu agencia." });
      }
      data.promoAdminId = body.promoAdminId ?? null;
    }
    if ("promoGroupFolderId" in body) {
      if (body.promoGroupFolderId) {
        const folder = await prisma.promoGroupFolder.findFirst({ where: { id: body.promoGroupFolderId, agencyId } });
        if (!folder) return reply.code(400).send({ error: "Esa carpeta no existe en tu agencia." });
      }
      data.promoGroupFolderId = body.promoGroupFolderId ?? null;
    }
    const { count } = await prisma.promoGroup.updateMany({ where: { id, agencyId }, data });
    if (count === 0) return reply.code(404).send({ error: "Grupo no encontrado." });
    const group = await prisma.promoGroup.findUnique({ where: { id } });
    return { group };
  });

  // Asignar la misma carpeta (o quitarla, con promoGroupFolderId: null) a
  // VARIOS grupos a la vez - mismo patrón que bulk-assign para el admin.
  app.post("/api/promo-groups/bulk-assign-folder", async (request, reply) => {
    const body = request.body as { groupIds?: string[]; promoGroupFolderId?: string | null };
    if (!body.groupIds || body.groupIds.length === 0) {
      return reply.code(400).send({ error: "No hay ningún grupo seleccionado." });
    }
    const agencyId = await agencyIdFromRequest(request);
    if (body.promoGroupFolderId) {
      const folder = await prisma.promoGroupFolder.findFirst({ where: { id: body.promoGroupFolderId, agencyId } });
      if (!folder) return reply.code(400).send({ error: "Esa carpeta no existe en tu agencia." });
    }
    const { count } = await prisma.promoGroup.updateMany({
      where: { id: { in: body.groupIds }, agencyId },
      data: { promoGroupFolderId: body.promoGroupFolderId ?? null },
    });
    return { ok: true, updated: count };
  });

  // ---------- Precios por admin y creadora ----------

  // Matriz completa para la pantalla "Precios por admin y creadora": una
  // fila por admin, una columna por creadora + la columna "General" (el
  // precio que se usa si esa creadora no tiene uno propio cargado).
  app.get("/api/promo-admin-prices", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const [accounts, admins] = await Promise.all([
      prisma.account.findMany({ where: { agencyId }, select: { id: true, label: true }, orderBy: { label: "asc" } }),
      prisma.promoAdmin.findMany({ where: { agencyId }, orderBy: { name: "asc" }, include: { prices: true } }),
    ]);
    return {
      accounts,
      admins: admins.map((a) => ({
        id: a.id,
        name: a.name,
        generalPrice: a.prices.find((p) => p.accountId === null)?.priceMonthly ?? null,
        pricesByAccount: Object.fromEntries(
          a.prices.filter((p) => p.accountId !== null).map((p) => [p.accountId as string, p.priceMonthly])
        ),
      })),
    };
  });

  // Guarda (o borra, con priceMonthly: null) UNA celda de la matriz.
  // accountId ausente/null = columna "General". accountId es nullable en el
  // esquema (null = "General"), y Prisma no deja usar el índice compuesto
  // promoAdminId+accountId en un upsert cuando esa columna es nullable (el
  // tipo generado para el "where" no acepta null ahí) - así que se hace a
  // mano con findFirst + create/update en vez de upsert().
  app.patch("/api/promo-admin-prices", async (request, reply) => {
    const body = request.body as { promoAdminId?: string; accountId?: string | null; priceMonthly?: number | null };
    if (!body.promoAdminId) return reply.code(400).send({ error: "Falta el admin." });
    const agencyId = await agencyIdFromRequest(request);
    const admin = await prisma.promoAdmin.findFirst({ where: { id: body.promoAdminId, agencyId } });
    if (!admin) return reply.code(404).send({ error: "Admin no encontrado." });
    const accountId = body.accountId ?? null;
    if (accountId) {
      const owned = await prisma.account.findFirst({ where: { id: accountId, agencyId } });
      if (!owned) return reply.code(400).send({ error: "Esa modelo no existe en tu agencia." });
    }
    const priceMonthly = body.priceMonthly === undefined || body.priceMonthly === null ? null : Number(body.priceMonthly);
    const existing = await prisma.promoAdminPrice.findFirst({ where: { promoAdminId: body.promoAdminId, accountId } });
    const row = existing
      ? await prisma.promoAdminPrice.update({ where: { id: existing.id }, data: { priceMonthly } })
      : await prisma.promoAdminPrice.create({ data: { promoAdminId: body.promoAdminId, accountId, priceMonthly } });
    return { row };
  });

  // "Copiar precios de [Elegir...] a [Elegir...]": copia, para CADA admin
  // que ya tenga un precio cargado en la creadora de origen, ese mismo
  // precio a la creadora de destino (sobrescribiendo lo que hubiera).
  app.post("/api/promo-admin-prices/copy", async (request, reply) => {
    const body = request.body as { fromAccountId?: string; toAccountId?: string };
    const { fromAccountId, toAccountId } = body;
    if (!fromAccountId || !toAccountId) return reply.code(400).send({ error: "Elige la creadora de origen y la de destino." });
    if (fromAccountId === toAccountId) return reply.code(400).send({ error: "Elige dos creadoras distintas." });

    const agencyId = await agencyIdFromRequest(request);
    const bothOwned = await prisma.account.count({ where: { id: { in: [fromAccountId, toAccountId] }, agencyId } });
    if (bothOwned !== 2) return reply.code(400).send({ error: "Alguna de esas creadoras no existe en tu agencia." });

    const fromPrices = await prisma.promoAdminPrice.findMany({ where: { accountId: fromAccountId, promoAdmin: { agencyId } } });
    let copied = 0;
    for (const p of fromPrices) {
      const existing = await prisma.promoAdminPrice.findFirst({ where: { promoAdminId: p.promoAdminId, accountId: toAccountId } });
      if (existing) {
        await prisma.promoAdminPrice.update({ where: { id: existing.id }, data: { priceMonthly: p.priceMonthly } });
      } else {
        await prisma.promoAdminPrice.create({ data: { promoAdminId: p.promoAdminId, accountId: toAccountId, priceMonthly: p.priceMonthly } });
      }
      copied++;
    }
    return { ok: true, copied };
  });

  // ---------- Veredicto por admin ----------

  // Ingresos/coste/margen/ROI/conversión por admin en un rango de fechas,
  // como la tabla principal del panel de referencia. La ATRIBUCIÓN de un fan
  // a un grupo es "de por vida" (se guarda una sola vez, ver liveEvents.ts);
  // lo que sí se filtra por rango son las VENTAS. Si un fan está atribuido a
  // grupos de varios admins a la vez, el importe de cada venta suya se
  // reparte a partes iguales entre esos admins (igual que el panel de
  // referencia: "el monto de cada venta se reparte entre los grupos en
  // común del fan"). El coste de un admin es: por cada creadora en la que
  // tiene al menos un grupo catalogado, su precio para esa creadora (o el
  // "General" si no tiene uno propio cargado) × los meses que dura el rango
  // elegido - si no hay precio cargado para alguna, esa creadora no cuenta
  // coste y el admin queda marcado "sinPrecio" (veredicto incompleto).
  // accountId (opcional): filtra a una sola creadora ("Todas las creadoras"
  // = sin filtro, precio por admin ambiguo entre creadoras -> "-").
  async function computeVeredicto(agencyId: string, from: Date, to: Date, accountId: string | null) {
    const days = Math.max(1, (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
    const months = days / 30;

    const [attributions, sales, admins] = await Promise.all([
      prisma.promoGroupFanAttribution.findMany({
        where: { account: { agencyId }, ...(accountId ? { accountId } : {}) },
        include: { promoGroup: { select: { promoAdminId: true } } },
      }),
      prisma.fanSale.findMany({ where: { date: { gte: from, lte: to }, account: { agencyId }, ...(accountId ? { accountId } : {}) } }),
      prisma.promoAdmin.findMany({
        where: { agencyId },
        orderBy: { name: "asc" },
        include: { prices: true, groups: { include: { accounts: true } } },
      }),
    ]);

    // fan (accountId|chatId) -> admins a los que está atribuido
    const fanAdmins = new Map<string, Set<string>>();
    for (const a of attributions) {
      if (!a.promoGroup.promoAdminId) continue;
      const key = `${a.accountId}|${a.chatId}`;
      if (!fanAdmins.has(key)) fanAdmins.set(key, new Set());
      fanAdmins.get(key)!.add(a.promoGroup.promoAdminId);
    }

    const hablaronByAdmin = new Map<string, Set<string>>();
    for (const [key, adminSet] of fanAdmins) {
      for (const adminId of adminSet) {
        if (!hablaronByAdmin.has(adminId)) hablaronByAdmin.set(adminId, new Set());
        hablaronByAdmin.get(adminId)!.add(key);
      }
    }

    const ingresosByAdmin = new Map<string, number>();
    const compraronByAdmin = new Map<string, Set<string>>();
    let ingresosNoAtribuidos = 0;
    let ingresosTotal = 0;
    for (const s of sales) {
      ingresosTotal += s.amount;
      const key = `${s.accountId}|${s.chatId}`;
      const adminSet = fanAdmins.get(key);
      if (!adminSet || adminSet.size === 0) {
        ingresosNoAtribuidos += s.amount;
        continue;
      }
      const share = s.amount / adminSet.size;
      for (const adminId of adminSet) {
        ingresosByAdmin.set(adminId, (ingresosByAdmin.get(adminId) || 0) + share);
        if (!compraronByAdmin.has(adminId)) compraronByAdmin.set(adminId, new Set());
        compraronByAdmin.get(adminId)!.add(key);
      }
    }

    const rows = admins.map((admin) => {
      const allAccountIdsWithGroups = new Set<string>();
      for (const g of admin.groups) for (const ga of g.accounts) allAccountIdsWithGroups.add(ga.accountId);
      // Con una creadora elegida, el coste/precio de este admin solo cuenta
      // si tiene al menos un grupo catalogado en ELLA - si no, no le cuesta
      // nada en esta vista (aunque tenga grupos en otras creadoras).
      const relevantAccountIds = accountId
        ? (allAccountIdsWithGroups.has(accountId) ? [accountId] : [])
        : [...allAccountIdsWithGroups];

      const generalPrice = admin.prices.find((p) => p.accountId === null)?.priceMonthly ?? null;

      let coste = 0;
      let missingPrice = 0;
      for (const accId of relevantAccountIds) {
        const specific = admin.prices.find((p) => p.accountId === accId)?.priceMonthly;
        const price = specific !== undefined && specific !== null ? specific : generalPrice;
        if (price === null || price === undefined) {
          missingPrice++;
          continue;
        }
        coste += price * months;
      }
      // "Precio": solo tiene sentido como un único número cuando se ha
      // elegido UNA creadora concreta - con "Todas las creadoras" el admin
      // puede tener precios distintos por creadora, así que se deja "-".
      let precio: number | null = null;
      if (accountId && relevantAccountIds.length > 0) {
        const specific = admin.prices.find((p) => p.accountId === accountId)?.priceMonthly;
        precio = specific !== undefined && specific !== null ? specific : generalPrice;
      }

      const ingresos = ingresosByAdmin.get(admin.id) || 0;
      const margen = ingresos - coste;
      const ratio = coste > 0 ? ingresos / coste : null;
      const hablaron = hablaronByAdmin.get(admin.id)?.size || 0;
      const compraron = compraronByAdmin.get(admin.id)?.size || 0;
      const conversion = hablaron > 0 ? (compraron / hablaron) * 100 : null;

      return {
        id: admin.id,
        name: admin.name,
        comment: admin.comment,
        grupos: admin.groups.length,
        creadoras: relevantAccountIds.length,
        precio,
        ingresos,
        coste,
        margen,
        ratio,
        hablaron,
        compraron,
        conversion,
        sinVentas: ingresos === 0,
        sinPrecio: missingPrice > 0,
      };
    });

    const costeAdmins = rows.reduce((s, r) => s + r.coste, 0);
    const margenTotal = rows.reduce((s, r) => s + r.margen, 0);
    const adminsConVentasSinPrecio = rows.filter((r) => r.ingresos > 0 && r.sinPrecio).length;
    const totals = {
      ingresosAtribuidos: rows.reduce((s, r) => s + r.ingresos, 0),
      costeAdmins,
      margen: margenTotal,
      ratioGlobal: costeAdmins > 0 ? rows.reduce((s, r) => s + r.ingresos, 0) / costeAdmins : null,
      clientes: rows.reduce((s, r) => s + r.compraron, 0),
      ingresosNoAtribuidos,
      ingresosTotal,
      periodMonths: Math.round(months * 10) / 10,
      adminsConVentasSinPrecio,
    };

    return { rows, totals };
  }

  app.get("/api/promo-groups/veredicto", async (request) => {
    const q = request.query as { from?: string; to?: string; accountId?: string };
    const agencyId = await agencyIdFromRequest(request);
    const from = q.from ? new Date(q.from + "T00:00:00") : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = q.to ? new Date(q.to + "T23:59:59.999") : new Date();
    const result = await computeVeredicto(agencyId, from, to, q.accountId || null);
    return result;
  });

  // "Veredicto en PDF": un resumen de la tabla, una fila por admin.
  app.get("/api/promo-groups/veredicto/export.pdf", async (request, reply) => {
    const q = request.query as { from?: string; to?: string; accountId?: string };
    const agencyId = await agencyIdFromRequest(request);
    const from = q.from ? new Date(q.from + "T00:00:00") : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = q.to ? new Date(q.to + "T23:59:59.999") : new Date();
    const { rows, totals } = await computeVeredicto(agencyId, from, to, q.accountId || null);

    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

    doc.fontSize(18).text("Veredicto por admin - Grupos de promoción", { align: "left" });
    doc.fontSize(10).fillColor("#555").text(`Del ${q.from || "-"} al ${q.to || "-"}  ·  Periodo: ${totals.periodMonths} mes(es)`);
    doc.moveDown(0.5);
    doc.fillColor("#000").fontSize(11).text(
      `Fact. atribuida: ${totals.ingresosAtribuidos.toFixed(2)} €   Coste admins: ${totals.costeAdmins.toFixed(2)} €   Margen: ${totals.margen.toFixed(2)} €   Clientes: ${totals.clientes}`
    );
    doc.moveDown(1);

    const cols = ["Admin", "Grupos", "Mod.", "Ingresos", "Coste", "Margen", "Hablaron", "Compraron", "Conv.", "Veredicto"];
    const widths = [110, 45, 40, 70, 70, 70, 65, 70, 50, 90];
    let y = doc.y;
    let x = doc.x;
    doc.fontSize(9).font("Helvetica-Bold");
    cols.forEach((c, i) => { doc.text(c, x, y, { width: widths[i] }); x += widths[i]; });
    doc.font("Helvetica");
    y += 16;
    for (const r of rows) {
      x = doc.x;
      const badge = r.sinPrecio ? "SIN PRECIO" : r.sinVentas ? "SIN VENTAS" : r.margen >= 0 ? "RENTABLE" : "NO RENTABLE";
      const cells = [
        r.name, String(r.grupos), String(r.creadoras),
        `${r.ingresos.toFixed(2)} €`, `${r.coste.toFixed(2)} €`, `${r.margen.toFixed(2)} €`,
        String(r.hablaron), String(r.compraron), r.conversion === null ? "-" : `${r.conversion.toFixed(1)}%`,
        badge,
      ];
      cells.forEach((c, i) => { doc.fontSize(9).text(c, x, y, { width: widths[i] }); x += widths[i]; });
      y += 15;
      if (y > 520) { doc.addPage({ margin: 40, size: "A4", layout: "landscape" }); y = 40; }
    }
    if (totals.ingresosNoAtribuidos > 0) {
      doc.moveDown(1);
      doc.fontSize(9).fillColor("#a55").text(`Facturación sin atribuir (fans que no llegaron por ningún grupo catalogado): ${totals.ingresosNoAtribuidos.toFixed(2)} €`);
    }
    doc.end();

    const buffer = await done;
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="veredicto-grupos-promocion.pdf"`);
    return reply.send(buffer);
  });

  // "Excel con el detalle": una fila por admin con todas las columnas.
  app.get("/api/promo-groups/veredicto/export.xlsx", async (request, reply) => {
    const q = request.query as { from?: string; to?: string; accountId?: string };
    const agencyId = await agencyIdFromRequest(request);
    const from = q.from ? new Date(q.from + "T00:00:00") : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = q.to ? new Date(q.to + "T23:59:59.999") : new Date();
    const { rows, totals } = await computeVeredicto(agencyId, from, to, q.accountId || null);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Veredicto");
    sheet.columns = [
      { header: "Admin", key: "name", width: 22 },
      { header: "Grupos", key: "grupos", width: 10 },
      { header: "Modelos", key: "creadoras", width: 10 },
      { header: "Precio", key: "precio", width: 12 },
      { header: "Ingresos", key: "ingresos", width: 12 },
      { header: "Coste", key: "coste", width: 12 },
      { header: "Margen", key: "margen", width: 12 },
      { header: "Ratio", key: "ratio", width: 10 },
      { header: "Hablaron", key: "hablaron", width: 10 },
      { header: "Compraron", key: "compraron", width: 10 },
      { header: "Conversión %", key: "conversion", width: 12 },
      { header: "Veredicto", key: "veredicto", width: 14 },
      { header: "Comentario", key: "comment", width: 30 },
    ];
    sheet.getRow(1).font = { bold: true };
    for (const r of rows) {
      const badge = r.sinPrecio ? "SIN PRECIO" : r.sinVentas ? "SIN VENTAS" : r.margen >= 0 ? "RENTABLE" : "NO RENTABLE";
      sheet.addRow({
        name: r.name, grupos: r.grupos, creadoras: r.creadoras,
        precio: r.precio, ingresos: r.ingresos, coste: r.coste, margen: r.margen,
        ratio: r.ratio, hablaron: r.hablaron, compraron: r.compraron,
        conversion: r.conversion, veredicto: badge, comment: r.comment,
      });
    }
    sheet.addRow({});
    sheet.addRow({ name: "TOTAL", ingresos: totals.ingresosAtribuidos, coste: totals.costeAdmins, margen: totals.margen });
    sheet.addRow({ name: "Sin atribuir (sin grupo)", ingresos: totals.ingresosNoAtribuidos });

    const buffer = await wb.xlsx.writeBuffer();
    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("Content-Disposition", `attachment; filename="veredicto-grupos-promocion.xlsx"`);
    return reply.send(Buffer.from(buffer));
  });
}
