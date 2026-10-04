import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { invalidatePaymentDetectorCache, scanPaymentText } from "../utils/paymentDetector";
import { isWhatsAppConnected } from "../whatsapp/waClient";
import { agencyIdFromRequest } from "../utils/agencyContext";

/**
 * API del Detector de pagos: reglas, filtros de texto, "nuestros métodos de
 * pago", chats silenciados, historial y la pestaña "Probar". Todo esto es
 * de agencia entera (no por cuenta), así que va sin :id de cuenta salvo
 * donde hace falta filtrar (historial) o identificar un chat (chats
 * silenciados). Solo para el dueño (no está en
 * WORKER_ACCESSIBLE_PATH_PATTERNS de index.ts), como el resto de
 * Configuración.
 */
export async function registerPaymentDetectorRoutes(app: FastifyInstance) {
  // ---------- Reglas ----------
  app.get("/api/payment-detector/rules", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const rules = await prisma.paymentRule.findMany({ where: { agencyId }, orderBy: { position: "asc" } });
    return { rules };
  });

  app.post("/api/payment-detector/rules", async (request, reply) => {
    const body = request.body as {
      name?: string; pattern?: string;
      searchText?: boolean; searchCaption?: boolean; searchFilename?: boolean;
    };
    if (!body.name?.trim() || !body.pattern?.trim()) {
      return reply.code(400).send({ error: "Falta el nombre o el patrón." });
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(body.pattern);
    } catch (err: any) {
      return reply.code(400).send({ error: "El patrón no es una expresión regular válida: " + err.message });
    }
    const agencyId = await agencyIdFromRequest(request);
    const maxPos = await prisma.paymentRule.aggregate({ where: { agencyId }, _max: { position: true } });
    const rule = await prisma.paymentRule.create({
      data: {
        agencyId,
        name: body.name.trim(),
        pattern: body.pattern,
        searchText: body.searchText !== false,
        searchCaption: body.searchCaption !== false,
        searchFilename: body.searchFilename !== false,
        position: (maxPos._max.position ?? -1) + 1,
      },
    });
    invalidatePaymentDetectorCache();
    return { rule };
  });

  app.patch("/api/payment-detector/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string; pattern?: string; active?: boolean;
      searchText?: boolean; searchCaption?: boolean; searchFilename?: boolean;
    };
    if (body.pattern !== undefined) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(body.pattern);
      } catch (err: any) {
        return reply.code(400).send({ error: "El patrón no es una expresión regular válida: " + err.message });
      }
    }
    const data: any = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.pattern !== undefined) { data.pattern = body.pattern; data.edited = true; }
    if (body.active !== undefined) data.active = body.active;
    if (body.searchText !== undefined) data.searchText = body.searchText;
    if (body.searchCaption !== undefined) data.searchCaption = body.searchCaption;
    if (body.searchFilename !== undefined) data.searchFilename = body.searchFilename;
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.paymentRule.updateMany({ where: { id, agencyId }, data });
    if (count === 0) return reply.code(404).send({ error: "Regla no encontrada." });
    invalidatePaymentDetectorCache();
    const rule = await prisma.paymentRule.findUnique({ where: { id } });
    return { rule };
  });

  app.delete("/api/payment-detector/rules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.paymentRule.deleteMany({ where: { id, agencyId } });
    if (count === 0) return reply.code(404).send({ error: "Regla no encontrada." });
    invalidatePaymentDetectorCache();
    return { ok: true };
  });

  // ---------- Filtros de texto (datos propios de la agencia) ----------
  app.get("/api/payment-detector/text-filters", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const filters = await prisma.paymentTextFilter.findMany({ where: { agencyId }, orderBy: { createdAt: "asc" } });
    return { filters };
  });

  app.post("/api/payment-detector/text-filters", async (request, reply) => {
    const body = request.body as { name?: string; pattern?: string };
    if (!body.name?.trim() || !body.pattern?.trim()) {
      return reply.code(400).send({ error: "Falta el nombre o el dato." });
    }
    const agencyId = await agencyIdFromRequest(request);
    const filter = await prisma.paymentTextFilter.create({ data: { agencyId, name: body.name.trim(), pattern: body.pattern.trim() } });
    invalidatePaymentDetectorCache();
    return { filter };
  });

  app.patch("/api/payment-detector/text-filters/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; pattern?: string; active?: boolean };
    const data: any = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.pattern !== undefined) { data.pattern = body.pattern.trim(); data.edited = true; }
    if (body.active !== undefined) data.active = body.active;
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.paymentTextFilter.updateMany({ where: { id, agencyId }, data });
    if (count === 0) return reply.code(404).send({ error: "Filtro no encontrado." });
    invalidatePaymentDetectorCache();
    const filter = await prisma.paymentTextFilter.findUnique({ where: { id } });
    return { filter };
  });

  app.delete("/api/payment-detector/text-filters/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.paymentTextFilter.deleteMany({ where: { id, agencyId } });
    if (count === 0) return reply.code(404).send({ error: "Filtro no encontrado." });
    invalidatePaymentDetectorCache();
    return { ok: true };
  });

  // ---------- Nuestros métodos de pago ----------
  app.get("/api/payment-detector/own-methods", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const row = await prisma.paymentOwnMethods.findUnique({ where: { agencyId } });
    return { text: row?.text || "" };
  });

  app.put("/api/payment-detector/own-methods", async (request) => {
    const body = request.body as { text?: string };
    const agencyId = await agencyIdFromRequest(request);
    const row = await prisma.paymentOwnMethods.upsert({
      where: { agencyId },
      update: { text: body.text || "" },
      create: { agencyId, text: body.text || "" },
    });
    invalidatePaymentDetectorCache();
    return { text: row.text };
  });

  // ---------- Chats silenciados ----------
  app.get("/api/payment-detector/muted-chats", async (request) => {
    const agencyId = await agencyIdFromRequest(request);
    const muted = await prisma.paymentMutedChat.findMany({
      where: { account: { agencyId } },
      include: { account: { select: { id: true, label: true } } },
      orderBy: { createdAt: "desc" },
    });
    return {
      chats: muted.map((m) => ({
        id: m.id, accountId: m.accountId, accountLabel: m.account.label,
        chatId: m.chatId, chatTitle: m.chatTitle, createdAt: m.createdAt,
      })),
    };
  });

  app.post("/api/payment-detector/muted-chats", async (request, reply) => {
    const body = request.body as { accountId?: string; chatId?: string; chatTitle?: string };
    if (!body.accountId || !body.chatId) {
      return reply.code(400).send({ error: "Falta la modelo o el id de chat." });
    }
    const agencyId = await agencyIdFromRequest(request);
    const account = await prisma.account.findFirst({ where: { id: body.accountId, agencyId } });
    if (!account) return reply.code(404).send({ error: "No existe esa modelo en tu agencia." });
    const muted = await prisma.paymentMutedChat.upsert({
      where: { accountId_chatId: { accountId: body.accountId, chatId: body.chatId } },
      update: { chatTitle: body.chatTitle || undefined },
      create: { accountId: body.accountId, chatId: body.chatId, chatTitle: body.chatTitle || null },
    });
    invalidatePaymentDetectorCache();
    return { muted };
  });

  app.delete("/api/payment-detector/muted-chats/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.paymentMutedChat.deleteMany({ where: { id, account: { agencyId } } });
    if (count === 0) return reply.code(404).send({ error: "No encontrado." });
    invalidatePaymentDetectorCache();
    return { ok: true };
  });

  // ---------- Historial ----------
  app.get("/api/payment-detector/history", async (request) => {
    const q = request.query as { accountId?: string; includeSilenced?: string };
    const agencyId = await agencyIdFromRequest(request);
    const where: any = { dismissed: false, account: { agencyId } };
    if (q.accountId && q.accountId !== "all") where.accountId = q.accountId;
    if (q.includeSilenced !== "1") where.silenced = false;
    const rows = await prisma.paymentDetectionEvent.findMany({
      where,
      include: { account: { select: { id: true, label: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    // "A quién avisar" es de agencia entera (no por cuenta) desde que el
    // aviso pasó del Twilio de cada modelo al WhatsApp vinculado por QR -
    // se comprueba una vez para toda la lista, no por evento. Con
    // multi-agencia esta configuración de WhatsApp sigue siendo global (ver
    // Fase 2 pendiente para WhatsApp), así que no se filtra por agencyId
    // todavía.
    const waSettings = await prisma.whatsAppSettings.findUnique({ where: { id: "singleton" } });
    const hasWhatsAppDestination = isWhatsAppConnected() && !!(waSettings?.paymentDestinations || "").trim();
    return {
      events: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        accountLabel: r.account.label,
        hasWhatsAppDestination,
        chatId: r.chatId,
        chatTitle: r.chatTitle,
        senderOut: r.senderOut,
        messageText: r.messageText,
        ruleName: r.ruleName,
        matchedText: r.matchedText,
        silenced: r.silenced,
        whatsappSent: r.whatsappSent,
        createdAt: r.createdAt,
      })),
    };
  });

  app.delete("/api/payment-detector/history/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const { count } = await prisma.paymentDetectionEvent.updateMany({ where: { id, account: { agencyId } }, data: { dismissed: true } });
    if (count === 0) return reply.code(404).send({ error: "No encontrado." });
    return { ok: true };
  });

  app.post("/api/payment-detector/history/clear", async (request) => {
    const body = request.body as { accountId?: string };
    const agencyId = await agencyIdFromRequest(request);
    const where: any = { account: { agencyId } };
    if (body.accountId && body.accountId !== "all") where.accountId = body.accountId;
    await prisma.paymentDetectionEvent.updateMany({ where, data: { dismissed: true } });
    return { ok: true };
  });

  app.post("/api/payment-detector/history/:id/mute-chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const event = await prisma.paymentDetectionEvent.findFirst({ where: { id, account: { agencyId } } });
    if (!event) return reply.code(404).send({ error: "No encontrado." });
    await prisma.paymentMutedChat.upsert({
      where: { accountId_chatId: { accountId: event.accountId, chatId: event.chatId } },
      update: { chatTitle: event.chatTitle || undefined },
      create: { accountId: event.accountId, chatId: event.chatId, chatTitle: event.chatTitle },
    });
    invalidatePaymentDetectorCache();
    return { ok: true };
  });

  app.post("/api/payment-detector/history/:id/mark-ours", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agencyId = await agencyIdFromRequest(request);
    const event = await prisma.paymentDetectionEvent.findFirst({ where: { id, account: { agencyId } } });
    if (!event) return reply.code(404).send({ error: "No encontrado." });
    const row = await prisma.paymentOwnMethods.findUnique({ where: { agencyId } });
    const currentText = row?.text || "";
    const line = event.matchedText.trim();
    const alreadyThere = currentText.split("\n").some((l) => l.trim().toLowerCase() === line.toLowerCase());
    const newText = alreadyThere ? currentText : (currentText ? currentText + "\n" + line : line);
    await prisma.paymentOwnMethods.upsert({
      where: { agencyId },
      update: { text: newText },
      create: { agencyId, text: newText },
    });
    await prisma.paymentDetectionEvent.update({ where: { id }, data: { dismissed: true } });
    invalidatePaymentDetectorCache();
    return { ok: true };
  });

  // ---------- Probar ----------
  app.post("/api/payment-detector/test", async (request) => {
    const body = request.body as { text?: string; filename?: string; hasMedia?: boolean };
    const agencyId = await agencyIdFromRequest(request);
    const text = body.text || "";
    const matches = await scanPaymentText(agencyId, {
      text: body.hasMedia ? null : text,
      caption: body.hasMedia ? text : null,
      filename: body.filename || null,
    });
    return { matches };
  });
}
