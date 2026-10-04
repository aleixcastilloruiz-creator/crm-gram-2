import { FastifyInstance } from "fastify";
import { prisma } from "../utils/prisma";
import {
  verifyPassword,
  signWorkerToken,
  getWorkerFromRequest,
  WORKER_COOKIE,
  signOwnerToken,
  verifyOwnerCredentials,
  getOwnerSessionFromRequest,
  OWNER_COOKIE,
  isDesktopAppRequest,
} from "../utils/auth";
import { LEGACY_AGENCY_ID } from "../utils/agencyMigration";

/** Prueba las credenciales del Dueño/Jefe de una agencia NUEVA (invitada por
 * el súper-admin, ver api/agencies.ts): email + contraseña guardados en la
 * propia tabla Agency. Devuelve la agencia si coinciden y sigue activa
 * (nunca la de "legacy-agency": esa sigue siendo solo PANEL_USERNAME/
 * PANEL_PASSWORD, ver verifyOwnerCredentials). */
async function findAgencyOwnerByCredentials(identifier: string, password: string) {
  const email = identifier.trim().toLowerCase();
  if (!email) return null;
  const agency = await prisma.agency.findUnique({ where: { ownerEmail: email } });
  if (!agency || agency.id === LEGACY_AGENCY_ID || !agency.active) return null;
  const ok = await verifyPassword(password, agency.ownerPasswordHash);
  return ok ? agency : null;
}

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 dias, igual que el token
const OWNER_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 dias: "la sesión se mantiene activa"

async function workerPublicInfo(workerId: string) {
  const permissions = await prisma.workerPermission.findMany({
    where: { workerId },
    include: { account: { select: { id: true, label: true } } },
  });
  return {
    permissions: permissions.map((p) => ({ accountId: p.accountId, accountLabel: p.account.label, section: p.section })),
  };
}

/**
 * Login del "Equipo" (trabajadores): capa AÑADIDA sobre el candado general
 * del panel (Basic Auth de index.ts, que sigue igual). Aquí cada persona
 * entra con su propio email/contraseña, sin necesitar el número/sesión de
 * Telegram de ninguna modelo.
 */
export async function registerAuthRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    if (!email || !password) {
      return reply.code(400).send({ error: "Falta el email o la contraseña." });
    }
    const worker = await prisma.worker.findUnique({ where: { email } });
    if (!worker || !worker.active) {
      return reply.code(401).send({ error: "Email o contraseña incorrectos." });
    }
    const ok = await verifyPassword(password, worker.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: "Email o contraseña incorrectos." });
    }
    // "Solo app de escritorio" (Equipo → Permisos, ver isDesktopAppRequest
    // en utils/auth.ts): si este trabajador no tiene marcado "puede entrar
    // también desde el navegador", se le corta aquí mismo, antes de darle
    // ninguna cookie.
    if (!worker.canUseBrowser && !isDesktopAppRequest(request)) {
      return reply.code(403).send({ error: "Esta cuenta solo puede entrar desde la aplicación de escritorio de LUXE FAN MANAGEMENT." });
    }
    let token: string;
    try {
      token = signWorkerToken(worker.id);
    } catch (err: any) {
      request.log.error(err);
      return reply.code(500).send({ error: "El login de trabajadores todavía no está configurado del todo (falta AUTH_JWT_SECRET)." });
    }
    reply.setCookie(WORKER_COOKIE, token, {
      httpOnly: true,
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
    const info = await workerPublicInfo(worker.id);
    return {
      worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role },
      ...info,
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    reply.clearCookie(WORKER_COOKIE, { path: "/" });
    return { ok: true };
  });

  /**
   * Login único en /login para TODO el mundo (antes había dos portales
   * separados: /login para la cuenta luxe y /equipo para empleados, lo que
   * obligaba a entrar "en otro sitio" para gestionar el equipo). Prueba
   * primero las credenciales de la cuenta luxe (PANEL_USERNAME/PANEL_PASSWORD
   * de Railway); si no coinciden, prueba el email/contraseña de un
   * empleado. Solo la cuenta luxe puede después gestionar el equipo (ver
   * requireAdmin en api/workers.ts) — esto solo decide con qué cookie
   * queda la sesión, no da más permisos que antes.
   */
  app.post("/api/auth/unified-login", async (request, reply) => {
    const body = request.body as { identifier?: string; password?: string };
    const identifier = (body.identifier || "").trim();
    const password = body.password || "";
    if (!identifier || !password) {
      return reply.code(400).send({ error: "Escribe el usuario/email y la contraseña." });
    }

    if (verifyOwnerCredentials(identifier, password)) {
      let ownerToken: string;
      try {
        ownerToken = signOwnerToken(LEGACY_AGENCY_ID, true);
      } catch (err: any) {
        request.log.error(err);
        return reply.code(500).send({ error: "Falta AUTH_JWT_SECRET en el entorno (Railway → Variables)." });
      }
      reply.setCookie(OWNER_COOKIE, ownerToken, {
        httpOnly: true,
        path: "/",
        maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
        sameSite: "lax",
      });
      return { kind: "owner" };
    }

    // Dueño de una agencia NUEVA (invitada por el súper-admin): mismo
    // formulario de siempre, con su email + la contraseña que le dio el
    // súper-admin (o la que puso ella luego si la cambia - ver más abajo).
    const agencyOwner = await findAgencyOwnerByCredentials(identifier, password);
    if (agencyOwner) {
      let ownerToken: string;
      try {
        ownerToken = signOwnerToken(agencyOwner.id, false);
      } catch (err: any) {
        request.log.error(err);
        return reply.code(500).send({ error: "Falta AUTH_JWT_SECRET en el entorno (Railway → Variables)." });
      }
      reply.setCookie(OWNER_COOKIE, ownerToken, {
        httpOnly: true,
        path: "/",
        maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
        sameSite: "lax",
      });
      return { kind: "owner" };
    }

    const email = identifier.toLowerCase();
    const worker = await prisma.worker.findUnique({ where: { email } });
    if (!worker || !worker.active) {
      return reply.code(401).send({ error: "Usuario o contraseña incorrectos." });
    }
    const ok = await verifyPassword(password, worker.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: "Usuario o contraseña incorrectos." });
    }
    // Si el súper-admin suspendió la agencia de este trabajador (ver
    // api/agencies.ts), tampoco puede entrar - la fila sigue existiendo, solo
    // se bloquea el acceso.
    if (worker.agencyId !== LEGACY_AGENCY_ID) {
      const agency = await prisma.agency.findUnique({ where: { id: worker.agencyId } });
      if (!agency || !agency.active) {
        return reply.code(401).send({ error: "Esta agencia está suspendida." });
      }
    }
    // "Solo app de escritorio" (ver comentario igual en /api/auth/login más
    // arriba).
    if (!worker.canUseBrowser && !isDesktopAppRequest(request)) {
      return reply.code(403).send({ error: "Esta cuenta solo puede entrar desde la aplicación de escritorio de LUXE FAN MANAGEMENT." });
    }
    let workerToken: string;
    try {
      workerToken = signWorkerToken(worker.id);
    } catch (err: any) {
      request.log.error(err);
      return reply.code(500).send({ error: "El login todavía no está configurado del todo (falta AUTH_JWT_SECRET)." });
    }
    reply.setCookie(WORKER_COOKIE, workerToken, {
      httpOnly: true,
      path: "/",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
    const info = await workerPublicInfo(worker.id);
    return {
      kind: "worker",
      worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role },
      ...info,
    };
  });

  app.get("/api/auth/me", async (request) => {
    const worker = await getWorkerFromRequest(request);
    if (!worker) {
      // Sesión del dueño (cuenta luxe, o el dueño de una agencia nueva), sin
      // trabajador de por medio: antes esto devolvía "worker: null" sin más,
      // así que el panel no tenía ningún nombre que ofrecer para "Vendido
      // por" al registrar una venta -quedaba en blanco y, si no se rellenaba
      // a mano, la venta se guardaba sin chatter asignado ("(sin asignar)"
      // en Informes/Nóminas). ownerName es el mismo nombre que ya usa
      // chatterNameFromRequest en messages.ts para el registro de mensajes,
      // para que sea consistente en todo el panel.
      const owner = getOwnerSessionFromRequest(request);
      if (!owner) return { worker: null, ownerName: null };
      let ownerName: string;
      if (owner.agencyId === LEGACY_AGENCY_ID) {
        ownerName = process.env.PANEL_USERNAME || "El dueño";
      } else {
        const agency = await prisma.agency.findUnique({ where: { id: owner.agencyId } });
        ownerName = agency?.name || "El dueño";
      }
      // "Ver como": el súper-admin puede entrar a ver/gestionar los datos de
      // OTRA agencia (Configuración → Agencias → "Ver datos") sin dejar de
      // ser súper-admin - viewingOwnAgency: false es la señal que usa el
      // frontend para pintar el aviso "Viendo como <agencia> · Volver a tu
      // agencia" (ver renderSidenav en app.js).
      const isLegacyAgency = owner.agencyId === LEGACY_AGENCY_ID;
      return {
        worker: null,
        ownerName,
        isSuperAdmin: owner.isSuperAdmin,
        agencyId: owner.agencyId,
        viewingOwnAgency: isLegacyAgency,
        // Marca blanca: ninguna agencia que no sea la tuya (legacy-agency)
        // debe ver el logo/nombre de LUXE FAN MANAGEMENT en ningún sitio del
        // panel (pestaña del navegador, barra lateral, topbar móvil...) -
        // ver applyBranding en app.js. agencyName ya es ownerName de arriba
        // (el nombre de SU agencia) cuando no es legacy.
        isLegacyAgency,
        agencyName: isLegacyAgency ? null : ownerName,
      };
    }
    const info = await workerPublicInfo(worker.id);
    const isLegacyAgency = worker.agencyId === LEGACY_AGENCY_ID;
    let agencyName: string | null = null;
    if (!isLegacyAgency) {
      const agency = await prisma.agency.findUnique({ where: { id: worker.agencyId } });
      agencyName = agency?.name || null;
    }
    return {
      worker: { id: worker.id, name: worker.name, email: worker.email, role: worker.role },
      ...info,
      isLegacyAgency,
      agencyName,
      // "Solo lectura" (Equipo → Permisos): el frontend lo usa para avisar
      // en la barra lateral y para que los botones de escritura no ni
      // intenten la petición (el bloqueo de verdad, el que importa, está en
      // el servidor - ver el hook onRequest en index.ts).
      readOnly: worker.readOnly,
    };
  });

  /**
   * Portal /login del dueño (mismas credenciales de siempre,
   * PANEL_USERNAME/PANEL_PASSWORD en Railway - ver utils/auth.ts). Estas 3
   * rutas van bajo /api/auth/, así que el candado general de index.ts ya las
   * deja pasar sin pedir Basic Auth (si no, nadie podría ni intentar
   * meter la contraseña).
   */
  app.post("/api/auth/owner-login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!username || !password) {
      return reply.code(400).send({ error: "Escribe el usuario y la contraseña." });
    }
    if (!verifyOwnerCredentials(username, password)) {
      return reply.code(401).send({ error: "Usuario o contraseña incorrectos." });
    }
    let token: string;
    try {
      token = signOwnerToken();
    } catch (err: any) {
      request.log.error(err);
      return reply.code(500).send({ error: "Falta AUTH_JWT_SECRET en el entorno (Railway → Variables)." });
    }
    reply.setCookie(OWNER_COOKIE, token, {
      httpOnly: true,
      path: "/",
      maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
    return { ok: true };
  });

  app.post("/api/auth/owner-logout", async (request, reply) => {
    reply.clearCookie(OWNER_COOKIE, { path: "/" });
    return { ok: true };
  });

  // Le dice al panel si ya hay sesión válida del dueño (cookie de /login),
  // para decidir si mandar a /login o dejar entrar directo. El candado
  // general (index.ts) ya no acepta Basic Auth aquí -solo esta cookie-, así
  // que las dos comprobaciones van siempre de la mano.
  app.get("/api/auth/owner-status", async (request) => {
    const session = getOwnerSessionFromRequest(request);
    return { authenticated: !!session, viaCookie: !!session };
  });
}
