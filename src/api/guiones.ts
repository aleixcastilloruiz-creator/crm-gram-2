import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";

/**
 * "Guiones": apartado propio del sidebar (no confundir con el botón rápido
 * «Scripts» del chat, que sigue viviendo en messages.ts/Script). Un guion
 * de venta paso a paso, con precio orientativo, agrupado en categorías
 * libres (ej. "SEXTING CAMA") por cuenta/modelo.
 */

type GuionMediaRef = { id: string; caption?: string; type?: string };

type GuionStep =
  | { type: "text"; text: string; premiumLetters?: boolean }
  | { type: "pack"; media: GuionMediaRef[] }
  | { type: "audio"; media: GuionMediaRef[] };

function sanitizeMediaRefs(input: unknown): GuionMediaRef[] {
  if (!Array.isArray(input)) return [];
  const out: GuionMediaRef[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as any;
    if (typeof m.id === "string" && m.id.trim()) {
      out.push({ id: m.id, caption: typeof m.caption === "string" ? m.caption : "", type: typeof m.type === "string" ? m.type : undefined });
    }
  }
  return out;
}

function parseSteps(raw: string): GuionStep[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeSteps(input: unknown): GuionStep[] {
  if (!Array.isArray(input)) return [];
  const out: GuionStep[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as any;
    if (s.type === "text" && typeof s.text === "string" && s.text.trim()) {
      out.push({ type: "text", text: s.text.trim(), premiumLetters: !!s.premiumLetters });
    } else if (s.type === "pack") {
      const media = sanitizeMediaRefs(s.media);
      if (media.length > 0) out.push({ type: "pack", media });
    } else if (s.type === "audio") {
      const media = sanitizeMediaRefs(s.media).slice(0, 1);
      if (media.length > 0) out.push({ type: "audio", media });
    }
  }
  return out;
}

export async function registerGuionesRoutes(app: FastifyInstance) {
  // --- Categorías ---
  app.get("/api/accounts/:id/guiones-categories", async (request) => {
    const { id } = request.params as { id: string };
    const categories = await prisma.scriptCategory.findMany({
      where: { accountId: id },
      orderBy: { position: "asc" },
      include: { _count: { select: { guionScripts: true } } },
    });
    return {
      categories: categories.map((c) => ({ id: c.id, name: c.name, count: c._count.guionScripts })),
    };
  });

  app.post("/api/accounts/:id/guiones-categories", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string };
    const name = (body.name || "").trim();
    if (!name) return reply.code(400).send({ error: "Escribe el nombre de la categoría." });
    const last = await prisma.scriptCategory.findFirst({ where: { accountId: id }, orderBy: { position: "desc" } });
    const category = await prisma.scriptCategory.create({
      data: { accountId: id, name, position: (last?.position ?? -1) + 1 },
    });
    return { category: { id: category.id, name: category.name, count: 0 } };
  });

  app.patch("/api/guiones-categories/:categoryId", async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const body = request.body as { name?: string };
    const name = (body.name || "").trim();
    if (!name) return reply.code(400).send({ error: "Escribe el nombre de la categoría." });
    const category = await prisma.scriptCategory.update({ where: { id: categoryId }, data: { name } });
    return { category: { id: category.id, name: category.name } };
  });

  app.delete("/api/guiones-categories/:categoryId", async (request) => {
    const { categoryId } = request.params as { categoryId: string };
    // Los guiones de esta categoría no se borran: se quedan "Sin categoría"
    // (relación opcional, onDelete: SetNull).
    await prisma.scriptCategory.delete({ where: { id: categoryId } }).catch(() => {});
    return { ok: true };
  });

  // --- Guiones ---
  app.get("/api/accounts/:id/guiones", async (request) => {
    const { id } = request.params as { id: string };
    const q = request.query as { categoryId?: string };
    const where: any = { accountId: id };
    if (q.categoryId === "none") where.categoryId = null;
    else if (q.categoryId) where.categoryId = q.categoryId;
    const guiones = await prisma.guionScript.findMany({
      where,
      orderBy: { position: "asc" },
      include: { category: { select: { id: true, name: true } } },
    });
    return {
      guiones: guiones.map((g) => ({
        id: g.id,
        name: g.name,
        price: g.price,
        categoryId: g.categoryId,
        categoryName: g.category?.name || null,
        steps: parseSteps(g.stepsJson),
      })),
    };
  });

  app.post("/api/accounts/:id/guiones", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; categoryId?: string | null; price?: number | null; steps?: unknown };
    const name = (body.name || "").trim();
    if (!name) return reply.code(400).send({ error: "Escribe el nombre del guion." });
    const steps = sanitizeSteps(body.steps);
    if (steps.length === 0) return reply.code(400).send({ error: "Añade al menos un paso con contenido." });
    const last = await prisma.guionScript.findFirst({ where: { accountId: id }, orderBy: { position: "desc" } });
    const guion = await prisma.guionScript.create({
      data: {
        accountId: id,
        name,
        categoryId: body.categoryId || null,
        price: body.price === undefined || body.price === null || Number.isNaN(Number(body.price)) ? null : Number(body.price),
        stepsJson: JSON.stringify(steps),
        position: (last?.position ?? -1) + 1,
      },
    });
    return { guion: { id: guion.id, name: guion.name, price: guion.price, categoryId: guion.categoryId, steps } };
  });

  app.patch("/api/guiones/:guionId", async (request, reply) => {
    const { guionId } = request.params as { guionId: string };
    const body = request.body as { name?: string; categoryId?: string | null; price?: number | null; steps?: unknown };
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return reply.code(400).send({ error: "Escribe el nombre del guion." });
      data.name = name;
    }
    if (body.categoryId !== undefined) data.categoryId = body.categoryId || null;
    if (body.price !== undefined) {
      data.price = body.price === null || Number.isNaN(Number(body.price)) ? null : Number(body.price);
    }
    if (body.steps !== undefined) {
      const steps = sanitizeSteps(body.steps);
      if (steps.length === 0) return reply.code(400).send({ error: "Añade al menos un paso con contenido." });
      data.stepsJson = JSON.stringify(steps);
    }
    const guion = await prisma.guionScript.update({ where: { id: guionId }, data });
    return { guion: { id: guion.id, name: guion.name, price: guion.price, categoryId: guion.categoryId, steps: parseSteps(guion.stepsJson) } };
  });

  app.delete("/api/guiones/:guionId", async (request) => {
    const { guionId } = request.params as { guionId: string };
    await prisma.guionScript.delete({ where: { id: guionId } }).catch(() => {});
    return { ok: true };
  });
}
