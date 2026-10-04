import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { FastifyRequest } from "fastify";
import { prisma } from "./prisma";

/**
 * Login de trabajadores ("Equipo"): cada trabajador tiene su propia cuenta
 * (email + contraseña) SIN necesitar el número de teléfono/sesión de
 * Telegram de ninguna modelo. role "admin" ve/gestiona todo (la propia
 * agencia); role "worker" solo llega, cuenta por cuenta y apartado por
 * apartado, a lo que se le haya concedido en WorkerPermission.
 *
 * Esto es una capa AÑADIDA aparte del candado general del panel (Basic Auth
 * de PANEL_USERNAME/PANEL_PASSWORD en index.ts, que sigue protegiendo todo
 * el sitio igual que antes): hace falta pasar los dos para que un
 * trabajador entre a Mensajes/SFS, y solo el primero para que el dueño siga
 * usando el resto del panel exactamente como hasta ahora.
 */

export const WORKER_COOKIE = "luxe_worker";
const TOKEN_TTL = "30d";

/**
 * Portal /login del dueño: antes el candado general del panel era SOLO el
 * cuadro nativo de usuario/contraseña del navegador (HTTP Basic Auth), que
 * el propio navegador va olvidando (pestaña de incógnito, cambio de
 * navegador, etc.) y no se puede vestir ni customizar. Las credenciales
 * siguen siendo las mismas de siempre (PANEL_USERNAME/PANEL_PASSWORD en
 * Railway) - lo único que cambia es que ahora, al meterlas en /login, se
 * guardan en una cookie propia de larga duración (igual que hace ya
 * "Equipo" con sus trabajadores) para no tener que volver a escribirlas.
 * El Basic Auth "de toda la vida" (curl, scripts) se queda funcionando
 * exactamente igual, por si acaso.
 */
export const OWNER_COOKIE = "luxe_owner";
const OWNER_TOKEN_TTL = "180d";

// Mismo valor que utils/agencyMigration.ts (LEGACY_AGENCY_ID) - duplicado a
// propósito en vez de importado, para no crear un import circular
// (agencyMigration.ts importa hashPassword de este mismo fichero).
const LEGACY_AGENCY_ID = "legacy-agency";

/**
 * Multi-agencia: la sesión de "dueño" ahora lleva SIEMPRE una agencyId.
 * - El súper-admin (PANEL_USERNAME/PANEL_PASSWORD de Railway, de siempre)
 *   entra como dueño de "legacy-agency" Y ADEMÁS como súper-admin
 *   (isSuperAdmin: true) - por eso sigue viendo su panel exactamente igual
 *   que siempre, sin tocar nada, y además puede entrar a /api/agencies.
 * - El dueño de una agencia NUEVA (invitada por el súper-admin, con su
 *   propio email/contraseña) entra como dueño de SU agencyId, sin
 *   isSuperAdmin - nunca ve /api/agencies ni las de otra agencia.
 */
export interface OwnerSession {
  agencyId: string;
  isSuperAdmin: boolean;
}

export function signOwnerToken(agencyId: string = LEGACY_AGENCY_ID, isSuperAdmin: boolean = agencyId === LEGACY_AGENCY_ID): string {
  return jwt.sign({ owner: true, agencyId, isSuperAdmin }, getJwtSecret(), { expiresIn: OWNER_TOKEN_TTL });
}

/** Credenciales de siempre (Railway PANEL_USERNAME/PANEL_PASSWORD): siguen
 * siendo el súper-admin Y el dueño de "legacy-agency". */
export function verifyOwnerCredentials(username: string, password: string): boolean {
  const panelUser = process.env.PANEL_USERNAME;
  const panelPass = process.env.PANEL_PASSWORD;
  if (!panelUser || !panelPass) return false;
  return username === panelUser && password === panelPass;
}

/** Lee y valida la cookie de sesión del dueño. Nunca lanza (igual que
 * getWorkerFromRequest), para poder llamarla desde cualquier ruta sin
 * try/catch. Devuelve null si no hay sesión válida - antes devolvía
 * true/false; todo el código existente que hacía "if (getOwnerSessionFromRequest(...))"
 * sigue funcionando igual (un objeto es "truthy", null es "falsy"). */
export function getOwnerSessionFromRequest(request: FastifyRequest): OwnerSession | null {
  const token = (request as any).cookies?.[OWNER_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret()) as any;
    if (!payload || payload.owner !== true) return null;
    // Tokens firmados ANTES de multi-agencia no llevan agencyId: se tratan
    // como el dueño de "legacy-agency" + súper-admin, para no romper ninguna
    // sesión ya guardada en el navegador de nadie tras este despliegue.
    return {
      agencyId: typeof payload.agencyId === "string" ? payload.agencyId : LEGACY_AGENCY_ID,
      isSuperAdmin: typeof payload.isSuperAdmin === "boolean" ? payload.isSuperAdmin : true,
    };
  } catch {
    return null;
  }
}

/** El Basic Auth de siempre (usuario/contraseña de Railway), ahora
 * compartido entre index.ts (candado general) y auth.ts (para el estado de
 * /login: "¿ya está dentro por Basic Auth, p.ej. con curl?"). */
export function isValidBasicAuthHeader(header: string | undefined): boolean {
  const panelUser = process.env.PANEL_USERNAME;
  const panelPass = process.env.PANEL_PASSWORD;
  if (!panelUser || !panelPass || !header) return false;
  const expected = "Basic " + Buffer.from(`${panelUser}:${panelPass}`).toString("base64");
  return header === expected;
}

function getJwtSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "Falta AUTH_JWT_SECRET en el entorno (Railway → Variables). Generala con: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  return secret;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

interface WorkerTokenPayload {
  workerId: string;
}

export function signWorkerToken(workerId: string): string {
  return jwt.sign({ workerId } as WorkerTokenPayload, getJwtSecret(), { expiresIn: TOKEN_TTL });
}

export interface AuthedWorker {
  id: string;
  name: string;
  email: string;
  role: string; // "admin" | "worker"
  active: boolean;
  agencyId: string;
  canUseBrowser: boolean;
  readOnly: boolean;
}

/** Lee y valida la cookie de sesión de trabajador de la petición. Devuelve
 * null si no hay cookie, el token no es válido/ha caducado, o el trabajador
 * ya no existe/está desactivado -nunca lanza, para que cualquier ruta pueda
 * llamarla sin tener que envolverla en try/catch-. */
export async function getWorkerFromRequest(request: FastifyRequest): Promise<AuthedWorker | null> {
  const token = (request as any).cookies?.[WORKER_COOKIE];
  if (!token) return null;
  let payload: WorkerTokenPayload;
  try {
    payload = jwt.verify(token, getJwtSecret()) as WorkerTokenPayload;
  } catch {
    return null;
  }
  try {
    const worker = await prisma.worker.findUnique({ where: { id: payload.workerId } });
    if (!worker || !worker.active) return null;
    return { id: worker.id, name: worker.name, email: worker.email, role: worker.role, active: worker.active, agencyId: worker.agencyId, canUseBrowser: worker.canUseBrowser, readOnly: worker.readOnly };
  } catch {
    return null;
  }
}

/** Fastify preHandler: solo el súper-admin (PANEL_USERNAME/PANEL_PASSWORD de
 * Railway) puede gestionar agencias - ni el dueño de una agencia normal ni
 * ningún trabajador llegan aquí, sea cual sea su rol. */
// Cabecera que manda SIEMPRE la app de escritorio empaquetada (ver carpeta
// desktop/, session.webRequest.onBeforeSendHeaders en desktop/main.js) en
// TODAS sus peticiones, con un secreto compartido (DESKTOP_APP_SECRET en
// Railway = el mismo valor horneado en el build de la app - ver
// desktop/README.md). No es una protección a prueba de un atacante que
// desmonte el binario de la app, pero basta para que un trabajador con
// "solo app" (Worker.canUseBrowser = false) no se salte el candado
// simplemente abriendo Chrome y usando la cookie de sesión ahí - el
// almacén de cookies de Electron es aparte del navegador normal, así que
// en la práctica ni siquiera comparten sesión.
const DESKTOP_APP_HEADER = "x-luxe-app";

/** ¿Esta petición viene de verdad de la app de escritorio? Si
 * DESKTOP_APP_SECRET no está configurado en el servidor, NADIE cuenta como
 * app (por defecto más restrictivo, no menos - mejor que un trabajador
 * "solo app" se quede sin poder entrar hasta que se configure la variable,
 * que dejar coarse el candado por un despliegue a medias). */
export function isDesktopAppRequest(request: FastifyRequest): boolean {
  const secret = process.env.DESKTOP_APP_SECRET;
  if (!secret) return false;
  const header = request.headers[DESKTOP_APP_HEADER];
  return typeof header === "string" && header === secret;
}

export function requireSuperAdmin() {
  return async function (request: FastifyRequest, reply: any) {
    const owner = getOwnerSessionFromRequest(request);
    if (!owner || !owner.isSuperAdmin) {
      reply.code(403).send({ error: "Solo el súper-admin puede gestionar agencias." });
    }
  };
}

/** Fastify preHandler: exige que la cuenta (:id de la ruta) + esta sección
 * estén permitidas para el trabajador logueado. Si NO hay cookie de
 * trabajador (el dueño/jefe, cuenta luxe), deja pasar sin tocar nada - solo
 * el dueño ve todo sin restricción. El perfil de "Team líder" (Worker.role
 * "admin") ya NO salta este chequeo (antes lo hacía, viendo todas las
 * cuentas sin permiso explícito): un Team líder tiene el mismo perfil que
 * un Chatter (Worker.role "worker") en Mensajes/Mensajes Pro - solo las
 * cuentas que se le concedan a mano, igual que a un Chatter. La única
 * diferencia de un Team líder es SFS, reservado a su rol - ver el chequeo
 * de abajo, antes de mirar el permiso por cuenta. */
export function requireSectionAccess(section: "mensajes" | "sfs" | "mensajes-pro" | "programar-posts") {
  return async function (request: FastifyRequest, reply: any) {
    const worker = await getWorkerFromRequest(request);
    (request as any).worker = worker;
    if (!worker) return; // sin sesion de trabajador (el dueño/jefe): sin restriccion
    // SFS y "Programar posts" son lo único que distingue a un Team líder de
    // un Chatter: un Chatter nunca entra aquí, tenga o no tenga (por datos
    // antiguos) algún WorkerPermission de "sfs"/"programar-posts" guardado -
    // el rol manda por encima de eso.
    if ((section === "sfs" || section === "programar-posts") && worker.role !== "admin") {
      reply.code(403).send({ error: section === "sfs" ? "SFS es solo para Team líder." : "Programar posts es solo para Team líder." });
      return;
    }
    const params = request.params as { id?: string };
    const accountId = params?.id;
    if (!accountId) return; // ruta sin cuenta de por medio (poco probable aqui, pero no bloqueamos por si acaso)
    const allowed = await prisma.workerPermission.findUnique({
      where: { workerId_accountId_section: { workerId: worker.id, accountId, section } },
    });
    if (!allowed) {
      reply.code(403).send({ error: "No tienes acceso a este apartado para esta cuenta." });
    }
  };
}
