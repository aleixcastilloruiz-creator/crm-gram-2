import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import { hashPassword, getOwnerSessionFromRequest } from "../utils/auth";
import { agencyIdFromRequest } from "../utils/agencyContext";

const VALID_SECTIONS = new Set(["mensajes", "sfs", "mensajes-pro", "programar-posts"]);

function safeParseJson(raw: string, fallback: any) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Configuración → Equipo: ÚNICAMENTE la cuenta luxe (la sesión de /login con
 * PANEL_USERNAME/PANEL_PASSWORD, la misma que usa el resto del panel de
 * administrador) puede dar de alta trabajadores y conceder accesos. Antes
 * esto exigía haber iniciado sesión TAMBIÉN como un trabajador con role
 * "admin" (un login aparte en /equipo) — es decir, había que entrar "en
 * otro sitio" además de en el panel normal. Ahora basta con la sesión de
 * siempre del panel: si ya estás dentro como cuenta luxe, ya puedes
 * gestionar el equipo desde Configuración → Equipo sin nada más.
 */
async function requireAdmin(request: any, reply: any) {
  if (getOwnerSessionFromRequest(request)) return;
  reply.code(403).send({ error: "Solo la cuenta principal (luxe) puede gestionar el equipo." });
  return reply;
}

/** Ver el equipo (aunque sea solo lectura, para el desplegable "Vendido
 * por") es de "las demás opciones" reservadas al dueño/jefe: un Team líder
 * tiene aquí el mismo perfil que un Chatter -ninguno de los dos ve el
 * listado del equipo-, así que esto ya NO deja pasar a ningún trabajador,
 * tenga el rol que tenga. */
async function requireOwnerOrAdminWorker(request: any, reply: any) {
  if (getOwnerSessionFromRequest(request)) return;
  reply.code(403).send({ error: "Solo el dueño puede ver el equipo." });
  return reply;
}

/** Multi-agencia: el trabajador que se quiere tocar (:workerId) tiene que
 * ser de la MISMA agencia que quien pregunta - si no, 404 (como si no
 * existiera), para que el dueño de una agencia nunca pueda ni editar ni
 * borrar ni ver los permisos de un trabajador de otra agencia adivinando su
 * id. */
async function requireSameAgencyWorker(request: any, reply: any) {
  const { workerId } = request.params as { workerId: string };
  const worker = await prisma.worker.findUnique({ where: { id: workerId }, select: { agencyId: true } });
  const callerAgencyId = await agencyIdFromRequest(request);
  if (!worker || worker.agencyId !== callerAgencyId) {
    reply.code(404).send({ error: "Trabajador no encontrado." });
    return reply;
  }
}

export async function registerWorkerRoutes(app: FastifyInstance) {
  app.get("/api/workers", { preHandler: requireOwnerOrAdminWorker }, async (request) => {
    const workers = await prisma.worker.findMany({
      where: { agencyId: await agencyIdFromRequest(request) },
      orderBy: { createdAt: "asc" },
      include: { permissions: { include: { account: { select: { id: true, label: true } } } } },
    });
    return {
      workers: workers.map((w) => ({
        id: w.id,
        name: w.name,
        email: w.email,
        role: w.role,
        active: w.active,
        canUseBrowser: w.canUseBrowser,
        readOnly: w.readOnly,
        schedule: safeParseJson(w.scheduleJson, {}),
        extraPermissions: safeParseJson(w.extraPermissionsJson, {}),
        createdAt: w.createdAt,
        permissions: w.permissions.map((p) => ({ accountId: p.accountId, accountLabel: p.account.label, section: p.section })),
      })),
    };
  });

  // Genera una contraseña temporal legible (sin caracteres ambiguos tipo
  // 0/O, 1/l) para cuando se da de alta un trabajador sin ponerle
  // contraseña a mano - de momento no hay un correo de invitación real
  // configurado (haría falta un proveedor de email en el servidor), así que
  // esta es la que el admin comparte a mano con la persona.
  function generateTempPassword(): string {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let out = "";
    for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  app.post("/api/workers", { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; email?: string; password?: string; role?: string; accountIds?: string[] };
    const name = (body.name || "").trim();
    const email = (body.email || "").trim().toLowerCase();
    const role = body.role === "admin" ? "admin" : "worker";
    if (!name || !email) {
      return reply.code(400).send({ error: "Faltan nombre o email." });
    }
    if (body.password && body.password.length < 6) {
      return reply.code(400).send({ error: "La contraseña necesita al menos 6 caracteres." });
    }
    const existing = await prisma.worker.findUnique({ where: { email } });
    if (existing) {
      return reply.code(400).send({ error: "Ya hay un trabajador con ese email." });
    }
    const callerAgencyId = await agencyIdFromRequest(request);
    const tempPassword = body.password || generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const worker = await prisma.worker.create({ data: { name, email, passwordHash, role, agencyId: callerAgencyId } });

    // Un trabajador nunca puede quedar con acceso a una cuenta de OTRA
    // agencia, aunque se le pase su id a mano (p.ej. copiando una petición) -
    // se filtra aquí a las cuentas que de verdad son de la agencia de quien
    // está dando de alta al trabajador.
    const requestedAccountIds = Array.isArray(body.accountIds) ? body.accountIds.filter((v) => !!v) : [];
    const accountIds = requestedAccountIds.length > 0
      ? (await prisma.account.findMany({
          where: { id: { in: requestedAccountIds }, agencyId: callerAgencyId },
          select: { id: true },
        })).map((a) => a.id)
      : [];
    if (accountIds.length > 0) {
      // Un Chatter solo tiene Mensajes y Mensajes Pro. SFS y "Programar
      // posts" son lo único que distingue a un Team líder (role "admin") de
      // un Chatter, así que solo se conceden de entrada si el rol elegido ya
      // es Team líder - de todas formas requireSectionAccess (utils/auth.ts)
      // bloquea las dos para cualquier Chatter aunque quede algún permiso
      // suelto, pero mejor no crearlos de entrada si ni le sirven.
      await prisma.workerPermission.createMany({
        data: accountIds.flatMap((accountId) => [
          { workerId: worker.id, accountId, section: "mensajes" },
          ...(role === "admin" ? [
            { workerId: worker.id, accountId, section: "sfs" },
            { workerId: worker.id, accountId, section: "programar-posts" },
          ] : []),
          { workerId: worker.id, accountId, section: "mensajes-pro" },
        ]),
        skipDuplicates: true,
      });
    }

    return {
      worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role, active: worker.active },
      // Solo se manda de vuelta si no la puso el admin a mano (para poder
      // enseñarla una vez y que se la pase al trabajador).
      generatedPassword: body.password ? undefined : tempPassword,
    };
  });

  app.put("/api/workers/:workerId", { preHandler: [requireAdmin, requireSameAgencyWorker] }, async (request, reply) => {
    const { workerId } = request.params as { workerId: string };
    const body = request.body as {
      name?: string;
      password?: string;
      generatePassword?: boolean;
      role?: string;
      active?: boolean;
      canUseBrowser?: boolean;
      readOnly?: boolean;
      schedule?: Record<string, string[]>;
      extraPermissions?: Record<string, boolean>;
    };
    const data: any = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.role !== undefined) data.role = body.role === "admin" ? "admin" : "worker";
    if (body.active !== undefined) data.active = !!body.active;
    if (body.canUseBrowser !== undefined) data.canUseBrowser = !!body.canUseBrowser;
    if (body.readOnly !== undefined) data.readOnly = !!body.readOnly;
    if (body.schedule !== undefined) data.scheduleJson = JSON.stringify(body.schedule || {});
    if (body.extraPermissions !== undefined) data.extraPermissionsJson = JSON.stringify(body.extraPermissions || {});

    let generatedPassword: string | undefined;
    if (body.generatePassword) {
      generatedPassword = generateTempPassword();
      data.passwordHash = await hashPassword(generatedPassword);
    } else if (body.password) {
      if (body.password.length < 6) return reply.code(400).send({ error: "La contraseña necesita al menos 6 caracteres." });
      data.passwordHash = await hashPassword(body.password);
    }

    await prisma.worker.update({ where: { id: workerId }, data }).catch(() => {});
    return { ok: true, generatedPassword };
  });

  app.delete("/api/workers/:workerId", { preHandler: [requireAdmin, requireSameAgencyWorker] }, async (request) => {
    const { workerId } = request.params as { workerId: string };
    await prisma.worker.delete({ where: { id: workerId } }).catch(() => {});
    return { ok: true };
  });

  // Sustituye TODOS los permisos de un trabajador de una sola vez (mas
  // simple para el editor de casillas del frontend que ir añadiendo/
  // quitando uno a uno).
  app.put("/api/workers/:workerId/permissions", { preHandler: [requireAdmin, requireSameAgencyWorker] }, async (request, reply) => {
    const { workerId } = request.params as { workerId: string };
    const body = request.body as { permissions?: { accountId: string; section: string }[] };
    const callerAgencyId = await agencyIdFromRequest(request);
    const requested = (body.permissions || []).filter((p) => p?.accountId && VALID_SECTIONS.has(p.section));
    // Igual que al crear el trabajador: nunca se concede acceso a una cuenta
    // que no sea de la propia agencia, aunque venga en el body a mano.
    const ownAccountIds = new Set(
      (await prisma.account.findMany({
        where: { id: { in: requested.map((p) => p.accountId) }, agencyId: callerAgencyId },
        select: { id: true },
      })).map((a) => a.id)
    );
    const permissions = requested.filter((p) => ownAccountIds.has(p.accountId));
    await prisma.$transaction([
      prisma.workerPermission.deleteMany({ where: { workerId } }),
      ...(permissions.length > 0
        ? [
            prisma.workerPermission.createMany({
              data: permissions.map((p) => ({ workerId, accountId: p.accountId, section: p.section })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);
    return { ok: true };
  });
}
