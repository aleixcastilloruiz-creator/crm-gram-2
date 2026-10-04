"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKER_COOKIE = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.signWorkerToken = signWorkerToken;
exports.getWorkerFromRequest = getWorkerFromRequest;
exports.requireSectionAccess = requireSectionAccess;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("./prisma");
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
exports.WORKER_COOKIE = "luxe_worker";
const TOKEN_TTL = "30d";
function getJwtSecret() {
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret) {
        throw new Error("Falta AUTH_JWT_SECRET en el entorno (Railway → Variables). Generala con: " +
            "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    }
    return secret;
}
async function hashPassword(plain) {
    return bcryptjs_1.default.hash(plain, 10);
}
async function verifyPassword(plain, hash) {
    return bcryptjs_1.default.compare(plain, hash);
}
function signWorkerToken(workerId) {
    return jsonwebtoken_1.default.sign({ workerId }, getJwtSecret(), { expiresIn: TOKEN_TTL });
}
/** Lee y valida la cookie de sesión de trabajador de la petición. Devuelve
 * null si no hay cookie, el token no es válido/ha caducado, o el trabajador
 * ya no existe/está desactivado -nunca lanza, para que cualquier ruta pueda
 * llamarla sin tener que envolverla en try/catch-. */
async function getWorkerFromRequest(request) {
    const token = request.cookies?.[exports.WORKER_COOKIE];
    if (!token)
        return null;
    let payload;
    try {
        payload = jsonwebtoken_1.default.verify(token, getJwtSecret());
    }
    catch {
        return null;
    }
    try {
        const worker = await prisma_1.prisma.worker.findUnique({ where: { id: payload.workerId } });
        if (!worker || !worker.active)
            return null;
        return { id: worker.id, name: worker.name, email: worker.email, role: worker.role, active: worker.active };
    }
    catch {
        return null;
    }
}
/** Fastify preHandler: exige que la cuenta (:id de la ruta) + esta sección
 * estén permitidas para el trabajador logueado. Si NO hay cookie de
 * trabajador (caso de hoy: el dueño usando el panel solo con el Basic Auth
 * general), deja pasar sin tocar nada -cero cambio de comportamiento para
 * el uso actual-. Si hay cookie y el rol es "admin", tambien deja pasar
 * (el admin ve todo). Solo un trabajador sin permiso para esa cuenta+
 * sección recibe 403. */
function requireSectionAccess(section) {
    return async function (request, reply) {
        const worker = await getWorkerFromRequest(request);
        request.worker = worker;
        if (!worker || worker.role === "admin")
            return; // sin sesion de trabajador, o admin: sin restriccion extra
        const params = request.params;
        const accountId = params?.id;
        if (!accountId)
            return; // ruta sin cuenta de por medio (poco probable aqui, pero no bloqueamos por si acaso)
        const allowed = await prisma_1.prisma.workerPermission.findUnique({
            where: { workerId_accountId_section: { workerId: worker.id, accountId, section } },
        });
        if (!allowed) {
            reply.code(403).send({ error: "No tienes acceso a este apartado para esta cuenta." });
        }
    };
}
//# sourceMappingURL=auth.js.map