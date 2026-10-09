"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAgencyRoutes = registerAgencyRoutes;
const prisma_1 = require("../utils/prisma");
const auth_1 = require("../utils/auth");
const agencyMigration_1 = require("../utils/agencyMigration");
const paymentDetector_1 = require("../utils/paymentDetector");
// Misma duración que la cookie de siempre del dueño (ver OWNER_COOKIE_MAX_AGE_SECONDS
// en api/auth.ts) - duplicada aquí a propósito, igual que LEGACY_AGENCY_ID se
// duplica en utils/auth.ts, para no crear un import cruzado entre los dos
// ficheros de auth.
const OWNER_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/**
 * Gestión de agencias (multi-agencia): SOLO el súper-admin (PANEL_USERNAME/
 * PANEL_PASSWORD de Railway) llega aquí, ver requireSuperAdmin en
 * utils/auth.ts. Crear una agencia da de alta su Dueño/Jefe (email +
 * contraseña) - a partir de ahí esa persona entra en el MISMO /login que
 * todo el mundo con ese email/contraseña, y ve un panel completamente vacío
 * y aislado (sin cuentas de Telegram ni equipo todavía, los da de alta ella
 * misma). El súper-admin puede además entrar a ver/gestionar TODO lo suyo
 * en cualquier momento con "Ver datos" (POST .../view-as, más abajo) - deja
 * de operar como legacy-agency y pasa a operar como esa agencia (mismo
 * mecanismo que el login normal, solo que sin contraseña, porque ya es
 * súper-admin) hasta que vuelve con ".../exit-view-as".
 */
async function registerAgencyRoutes(app) {
    await app.register(async (instance) => {
        instance.addHook("preHandler", (0, auth_1.requireSuperAdmin)());
        // "Ocultar" (ver Agency.hidden en schema.prisma): a petición de Aitor,
        // esta lista YA NO filtra por "oculta" - se devuelven SIEMPRE todas las
        // agencias (como dueño del CRM, debe poder ver y tener acceso a
        // cualquiera que esté dada de alta, nunca que una quede escondida sin
        // querer). El botón "Ocultar"/"Mostrar" del panel sigue ahí y sigue
        // guardando el campo hidden por si algún día hace falta otra vez, pero
        // ya no tiene ningún efecto sobre lo que se ve aquí.
        instance.get("/api/agencies", async (request) => {
            void request.query; // ya no se usa: ver comentario de arriba
            const agencies = await prisma_1.prisma.agency.findMany({
                where: {
                    id: { not: agencyMigration_1.LEGACY_AGENCY_ID },
                },
                orderBy: { createdAt: "desc" },
            });
            // Nunca se manda el hash de la contraseña al frontend, aunque sea al
            // súper-admin - si quiere cambiarla, hay un endpoint aparte para eso.
            const withCounts = await Promise.all(agencies.map(async (a) => {
                const [accountsCount, workersCount] = await Promise.all([
                    prisma_1.prisma.account.count({ where: { agencyId: a.id } }),
                    prisma_1.prisma.worker.count({ where: { agencyId: a.id } }),
                ]);
                return {
                    id: a.id,
                    name: a.name,
                    ownerEmail: a.ownerEmail,
                    active: a.active,
                    hidden: a.hidden,
                    createdAt: a.createdAt,
                    accountsCount,
                    workersCount,
                };
            }));
            return { agencies: withCounts };
        });
        // Ocultar/mostrar una agencia del listado (ver Agency.hidden en
        // schema.prisma) - no toca su acceso para nada, solo si aparece aquí
        // por defecto.
        instance.put("/api/agencies/:id/hidden", async (request, reply) => {
            const { id } = request.params;
            if (id === agencyMigration_1.LEGACY_AGENCY_ID) {
                return reply.code(400).send({ error: "Esa es tu propia agencia, no aplica aquí." });
            }
            const body = request.body;
            const agency = await prisma_1.prisma.agency.findUnique({ where: { id } });
            if (!agency)
                return reply.code(404).send({ error: "Agencia no encontrada." });
            const updated = await prisma_1.prisma.agency.update({ where: { id }, data: { hidden: !!body.hidden } });
            return { agency: { id: updated.id, hidden: updated.hidden } };
        });
        instance.post("/api/agencies", async (request, reply) => {
            const body = request.body;
            const name = (body.name || "").trim();
            const ownerEmail = (body.ownerEmail || "").trim().toLowerCase();
            const ownerPassword = body.ownerPassword || "";
            if (!name || !ownerEmail || !ownerPassword) {
                return reply.code(400).send({ error: "Faltan el nombre, el email o la contraseña del dueño de la agencia." });
            }
            if (ownerPassword.length < 8) {
                return reply.code(400).send({ error: "La contraseña debe tener al menos 8 caracteres." });
            }
            const existing = await prisma_1.prisma.agency.findUnique({ where: { ownerEmail } });
            if (existing) {
                return reply.code(409).send({ error: "Ya hay una agencia con ese email de dueño." });
            }
            const agency = await prisma_1.prisma.agency.create({
                data: {
                    name,
                    ownerEmail,
                    ownerPasswordHash: await (0, auth_1.hashPassword)(ownerPassword),
                },
            });
            // Reglas de fábrica del Detector de pagos: para que la agencia nueva
            // empiece con el mismo punto de partida razonable que tuvo la tuya,
            // en vez de con el Detector completamente vacío.
            await (0, paymentDetector_1.ensureDefaultPaymentRules)(agency.id).catch((err) => console.error("[agencias] no se pudieron sembrar las reglas de fábrica del Detector de pagos:", err));
            return { agency: { id: agency.id, name: agency.name, ownerEmail: agency.ownerEmail, active: agency.active } };
        });
        // Suspender/reactivar: false = nadie de esa agencia (ni su dueño ni sus
        // trabajadores) puede entrar, pero sus datos NO se tocan ni se borran.
        instance.put("/api/agencies/:id/active", async (request, reply) => {
            const { id } = request.params;
            if (id === agencyMigration_1.LEGACY_AGENCY_ID) {
                return reply.code(400).send({ error: "Esa es tu propia agencia, no se puede suspender." });
            }
            const body = request.body;
            const agency = await prisma_1.prisma.agency.findUnique({ where: { id } });
            if (!agency)
                return reply.code(404).send({ error: "Agencia no encontrada." });
            const updated = await prisma_1.prisma.agency.update({ where: { id }, data: { active: !!body.active } });
            return { agency: { id: updated.id, active: updated.active } };
        });
        // Resetear la contraseña del dueño de una agencia (por si la pierde).
        instance.put("/api/agencies/:id/owner-password", async (request, reply) => {
            const { id } = request.params;
            if (id === agencyMigration_1.LEGACY_AGENCY_ID) {
                return reply.code(400).send({ error: "Esa agencia usa las variables de Railway, no una contraseña guardada aquí." });
            }
            const body = request.body;
            const newPassword = body.newPassword || "";
            if (newPassword.length < 8) {
                return reply.code(400).send({ error: "La contraseña debe tener al menos 8 caracteres." });
            }
            const agency = await prisma_1.prisma.agency.findUnique({ where: { id } });
            if (!agency)
                return reply.code(404).send({ error: "Agencia no encontrada." });
            await prisma_1.prisma.agency.update({ where: { id }, data: { ownerPasswordHash: await (0, auth_1.hashPassword)(newPassword) } });
            return { ok: true };
        });
        // "Ver datos de esta agencia": el súper-admin pasa a operar como si
        // fuera el dueño de esa agencia (misma cookie de sesión, solo que con la
        // agencyId de ESA agencia en vez de la suya) - ve y gestiona sus
        // cuentas, chats, equipo, nóminas, pagos... todo. isSuperAdmin se queda
        // en true a propósito: es lo que hace que el candado general
        // (onRequest en index.ts) le siga dejando pasar sin la restricción de
        // "agencia nueva" mientras mira los datos de otra agencia, y lo que
        // mantiene visible "Agencias" en su menú para poder volver.
        instance.post("/api/agencies/:id/view-as", async (request, reply) => {
            const { id } = request.params;
            if (id !== agencyMigration_1.LEGACY_AGENCY_ID) {
                const agency = await prisma_1.prisma.agency.findUnique({ where: { id } });
                if (!agency)
                    return reply.code(404).send({ error: "Agencia no encontrada." });
            }
            const token = (0, auth_1.signOwnerToken)(id, true);
            reply.setCookie(auth_1.OWNER_COOKIE, token, {
                httpOnly: true,
                path: "/",
                maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
                sameSite: "lax",
            });
            return { ok: true, agencyId: id };
        });
        // Volver a ver tu propia agencia (legacy-agency) después de haber
        // entrado a ver la de otra - mismo mecanismo que arriba, pero de vuelta.
        instance.post("/api/agencies/exit-view-as", async (_request, reply) => {
            const token = (0, auth_1.signOwnerToken)(agencyMigration_1.LEGACY_AGENCY_ID, true);
            reply.setCookie(auth_1.OWNER_COOKIE, token, {
                httpOnly: true,
                path: "/",
                maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
                sameSite: "lax",
            });
            return { ok: true, agencyId: agencyMigration_1.LEGACY_AGENCY_ID };
        });
        // Borrar una agencia de verdad (y TODO lo suyo: cuentas, trabajadores...).
        // No hay confirmación de por medio aquí a propósito -la pide el propio
        // frontend con un confirm()-, pero es irreversible, así que se deja
        // clarísimo en el propio texto del botón/aviso del panel.
        instance.delete("/api/agencies/:id", async (request, reply) => {
            const { id } = request.params;
            if (id === agencyMigration_1.LEGACY_AGENCY_ID) {
                return reply.code(400).send({ error: "Esa es tu propia agencia, no se puede borrar." });
            }
            const agency = await prisma_1.prisma.agency.findUnique({ where: { id } });
            if (!agency)
                return reply.code(404).send({ error: "Agencia no encontrada." });
            // Cuentas y trabajadores no llevan relación de Prisma con Agency (ver
            // comentario en schema.prisma), así que hay que borrarlos a mano en
            // vez de confiar en un onDelete: Cascade. Cada Account SÍ cascada a
            // todo lo que cuelga de ella (chats, notas, ventas...) por su propia
            // relación de siempre.
            await prisma_1.prisma.account.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.worker.deleteMany({ where: { agencyId: id } });
            // Ajustes generales, Detector de pagos y Cuentas de cobro tampoco
            // llevan relación de Prisma con Agency, por el mismo motivo (ver
            // comentario de arriba y el de schema.prisma) - se borran a mano.
            await prisma_1.prisma.agencySettings.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.paymentAccount.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.paymentRule.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.paymentTextFilter.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.paymentOwnMethods.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.japOrder.deleteMany({ where: { agencyId: id } });
            // PromoGroup/PromoAdmin cascadan a lo que cuelga de ellos
            // (PromoGroupAccount, PromoGroupFanAttribution, PromoAdminPrice) por su
            // propia relación de Prisma - solo hace falta borrar estos dos.
            await prisma_1.prisma.promoGroup.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.promoAdmin.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.payroll.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.modelPayroll.deleteMany({ where: { agencyId: id } });
            await prisma_1.prisma.agency.delete({ where: { id } });
            return { ok: true };
        });
    });
}
//# sourceMappingURL=agencies.js.map