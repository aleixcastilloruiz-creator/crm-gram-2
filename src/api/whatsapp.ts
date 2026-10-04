import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import {
  destinationToJid,
  disconnectWhatsApp,
  getWhatsAppStatus,
  isWhatsAppConnected,
  listWhatsAppGroups,
  sendWhatsAppMessage,
  startWhatsAppConnection,
} from "../whatsapp/waClient";

/**
 * API de "Conectar WhatsApp": vinculación por QR, a quién avisar del
 * Detector de pagos, y los grupos de seguimiento de las modelos para el
 * aviso de ventas. Todo esto es de agencia entera (no por cuenta de
 * Telegram), así que va sin :id salvo para guardar el grupo de cada
 * modelo. Solo para el dueño (no está en WORKER_ACCESSIBLE_PATH_PATTERNS
 * de index.ts), igual que el resto de Configuración.
 */
export async function registerWhatsAppRoutes(app: FastifyInstance) {
  async function getSettings() {
    const row = await prisma.whatsAppSettings.findUnique({ where: { id: "singleton" } });
    if (row) return row;
    return prisma.whatsAppSettings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  }

  // ---------- Vinculación ----------
  app.get("/api/whatsapp/status", async () => {
    return getWhatsAppStatus();
  });

  app.post("/api/whatsapp/connect", async (request, reply) => {
    try {
      await startWhatsAppConnection();
      return getWhatsAppStatus();
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message || "No se pudo iniciar la conexión con WhatsApp." });
    }
  });

  app.post("/api/whatsapp/disconnect", async () => {
    await disconnectWhatsApp();
    return { ok: true };
  });

  // ---------- Grupos (para los desplegables) ----------
  app.get("/api/whatsapp/groups", async (request, reply) => {
    try {
      const groups = await listWhatsAppGroups();
      return { groups };
    } catch (err: any) {
      return reply.code(409).send({ error: err?.message || "No se pudieron leer los grupos." });
    }
  });

  // ---------- Configuración (destinos + grupos de seguimiento) ----------
  app.get("/api/whatsapp/settings", async () => {
    const settings = await getSettings();
    const accounts = await prisma.account.findMany({
      orderBy: { label: "asc" },
      select: { id: true, label: true, salesTrackingWhatsAppGroupId: true },
    });
    return { settings, accounts };
  });

  // "Guardar destinos" de "A quién avisar" (Detector de pagos).
  app.put("/api/whatsapp/payment-destinations", async (request) => {
    const body = request.body as { destinations?: string };
    const settings = await prisma.whatsAppSettings.upsert({
      where: { id: "singleton" },
      update: { paymentDestinations: body.destinations || "" },
      create: { id: "singleton", paymentDestinations: body.destinations || "" },
    });
    return { settings };
  });

  // "Guardar" de "Grupos de seguimiento de las modelos": el interruptor
  // general, las 4 casillas de "qué más lleva el mensaje", el grupo de
  // "Todos los trabajadores" y el grupo de cada modelo (una fila por
  // cuenta en accountGroups: { [accountId]: groupId | null }).
  app.put("/api/whatsapp/sales-settings", async (request) => {
    const body = request.body as {
      notifySalesToGroups?: boolean;
      allWorkersGroupId?: string | null;
      allGroupIncludePrice?: boolean;
      allGroupIncludeSoldBy?: boolean;
      modelGroupIncludePrice?: boolean;
      modelGroupIncludeSoldBy?: boolean;
      accountGroups?: Record<string, string | null>;
    };
    const settings = await prisma.whatsAppSettings.upsert({
      where: { id: "singleton" },
      update: {
        notifySalesToGroups: !!body.notifySalesToGroups,
        allWorkersGroupId: body.allWorkersGroupId || null,
        allGroupIncludePrice: !!body.allGroupIncludePrice,
        allGroupIncludeSoldBy: !!body.allGroupIncludeSoldBy,
        modelGroupIncludePrice: !!body.modelGroupIncludePrice,
        modelGroupIncludeSoldBy: !!body.modelGroupIncludeSoldBy,
      },
      create: {
        id: "singleton",
        notifySalesToGroups: !!body.notifySalesToGroups,
        allWorkersGroupId: body.allWorkersGroupId || null,
        allGroupIncludePrice: !!body.allGroupIncludePrice,
        allGroupIncludeSoldBy: !!body.allGroupIncludeSoldBy,
        modelGroupIncludePrice: !!body.modelGroupIncludePrice,
        modelGroupIncludeSoldBy: !!body.modelGroupIncludeSoldBy,
      },
    });

    if (body.accountGroups) {
      await Promise.all(
        Object.entries(body.accountGroups).map(([accountId, groupId]) =>
          prisma.account
            .update({ where: { id: accountId }, data: { salesTrackingWhatsAppGroupId: groupId || null } })
            .catch(() => {})
        )
      );
    }

    return { ok: true };
  });

  // ---------- Probar ----------
  // "Enviar prueba" (A quién avisar) y "Probar" (fila de "Todos los
  // trabajadores" o de una modelo en concreto): mandan un mensaje de
  // prueba de verdad al destino ya guardado, para comprobar que llega.
  app.post("/api/whatsapp/test", async (request, reply) => {
    const body = request.body as { target?: "payment" | "all-workers" | "account"; accountId?: string };
    if (!isWhatsAppConnected()) {
      return reply.code(409).send({ error: "El WhatsApp no está conectado todavía." });
    }
    const settings = await getSettings();
    const text = "✅ Mensaje de prueba desde LUREQO CRM.";
    try {
      if (body.target === "payment") {
        const lines = (settings.paymentDestinations || "").split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) return reply.code(400).send({ error: "No hay ningún destino guardado todavía." });
        let sent = 0;
        for (const line of lines) {
          const jid = destinationToJid(line);
          if (!jid) continue;
          await sendWhatsAppMessage(jid, text);
          sent++;
        }
        if (sent === 0) return reply.code(400).send({ error: "Ningún destino guardado es válido." });
        return { ok: true };
      }
      if (body.target === "all-workers") {
        if (!settings.allWorkersGroupId) return reply.code(400).send({ error: "No hay ningún grupo elegido para «Todos los trabajadores»." });
        await sendWhatsAppMessage(settings.allWorkersGroupId, text);
        return { ok: true };
      }
      if (body.target === "account" && body.accountId) {
        const account = await prisma.account.findUniqueOrThrow({ where: { id: body.accountId } });
        if (!account.salesTrackingWhatsAppGroupId) {
          return reply.code(400).send({ error: `No hay ningún grupo elegido para "${account.label}" todavía.` });
        }
        await sendWhatsAppMessage(account.salesTrackingWhatsAppGroupId, text);
        return { ok: true };
      }
      return reply.code(400).send({ error: "Falta a quién mandar la prueba." });
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message || "No se pudo mandar el mensaje de prueba." });
    }
  });
}
