"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const path_1 = __importDefault(require("path"));
const fastify_1 = __importDefault(require("fastify"));
const static_1 = __importDefault(require("@fastify/static"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const logs_1 = require("./api/logs");
const accounts_1 = require("./api/accounts");
const sourceGroups_1 = require("./api/sourceGroups");
const campaigns_1 = require("./api/campaigns");
const telegramFolders_1 = require("./api/telegramFolders");
const scheduleSlots_1 = require("./api/scheduleSlots");
const accountLogin_1 = require("./api/accountLogin");
const messages_1 = require("./api/messages");
const messagesPro_1 = require("./api/messagesPro");
const contentLibrary_1 = require("./api/contentLibrary");
const emojiPacks_1 = require("./api/emojiPacks");
const settings_1 = require("./api/settings");
const freeChannels_1 = require("./api/freeChannels");
const modeloConfig_1 = require("./api/modeloConfig");
const auth_1 = require("./api/auth");
const workers_1 = require("./api/workers");
const auth_2 = require("./utils/auth");
const orchestrator_1 = require("./engine/orchestrator");
const connectionPool_1 = require("./telegram/connectionPool");
const prisma_1 = require("./utils/prisma");
// "Empleados": si todavia no hay ningun trabajador dado de alta, se crea un
// primer admin con una contraseña temporal conocida, para que el dueño
// pueda entrar a Configuración → Empleados y crear al resto / cambiarla.
// Sin esto no habria forma de entrar la primera vez (nadie puede leer los
// logs de Railway para sacar una contraseña generada al azar).
const INITIAL_ADMIN_EMAIL = "aiitoorveega@gmail.com";
const INITIAL_ADMIN_TEMP_PASSWORD = "LuxeEquipo2026!";
// Email con el que se creo el primer admin en una version anterior de este
// arranque automatico: si ya existe con ese email, lo renombramos al nuevo
// en vez de crear uno duplicado (no le toca la contraseña ni nada mas).
const LEGACY_INITIAL_ADMIN_EMAIL = "malasiaaitor@gmail.com";
async function seedInitialAdmin() {
    const count = await prisma_1.prisma.worker.count();
    if (count === 0) {
        const passwordHash = await (0, auth_2.hashPassword)(INITIAL_ADMIN_TEMP_PASSWORD);
        await prisma_1.prisma.worker.create({
            data: { name: "Aitor", email: INITIAL_ADMIN_EMAIL, passwordHash, role: "admin" },
        });
        console.log(`[equipo] Primer admin creado: ${INITIAL_ADMIN_EMAIL} / contraseña temporal "${INITIAL_ADMIN_TEMP_PASSWORD}" — cámbiala desde Configuración → Empleados en cuanto entres.`);
        return;
    }
    const legacy = await prisma_1.prisma.worker.findUnique({ where: { email: LEGACY_INITIAL_ADMIN_EMAIL } });
    if (legacy && legacy.role === "admin") {
        await prisma_1.prisma.worker.update({ where: { id: legacy.id }, data: { email: INITIAL_ADMIN_EMAIL } });
        console.log(`[equipo] Admin inicial renombrado de ${LEGACY_INITIAL_ADMIN_EMAIL} a ${INITIAL_ADMIN_EMAIL}.`);
    }
}
const LOG_RETENTION_DAYS = 7;
async function purgeOldLogs() {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await prisma_1.prisma.sendLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count > 0)
        console.log(`[cleanup] borrados ${count} logs con mas de ${LOG_RETENTION_DAYS} dias`);
}
async function main() {
    // Red de seguridad: un error inesperado en una sola peticion (por ejemplo
    // al bajar un vídeo grande de la bóveda) NO debe tirar abajo todo el
    // proceso -y con el, el reenviador y el resto del panel para todas las
    // cuentas-. Sin esto, Node mata el proceso entero ante cualquier promesa
    // sin capturar. Lo dejamos solo registrado (log), nunca silenciamos un
    // fallo real sin que quede constancia.
    process.on("unhandledRejection", (reason) => {
        console.error("[unhandledRejection] fallo no controlado, el panel sigue en pie:", reason);
    });
    process.on("uncaughtException", (err) => {
        console.error("[uncaughtException] fallo no controlado, el panel sigue en pie:", err);
    });
    const app = (0, fastify_1.default)({ logger: true });
    // Cookie de sesión del "Equipo" (login de trabajadores). Se registra ANTES
    // del Basic Auth para que este ya pueda leer request.cookies y decidir si
    // dejar pasar a un trabajador logueado sin pedirle el usuario/contraseña
    // general de Railway (que nunca debe tener un chatter).
    await app.register(cookie_1.default);
    // Proteccion con usuario/contraseña (HTTP Basic Auth) para el panel de
    // administrador (dueño) y el resto de la API, porque el dominio de
    // Railway es publico y desde el panel se puede encender el interruptor
    // maestro de envios. Usuario/contraseña se configuran con las variables
    // de entorno PANEL_USERNAME / PANEL_PASSWORD en Railway y SOLO las tiene
    // el dueño - nunca se le dan a un trabajador.
    //
    // Un trabajador ("Equipo") nunca ve ni escribe este usuario/contraseña:
    // entra solo con su propio email/contraseña en /equipo, y ese login
    // necesita poder llegar al servidor sin Basic Auth de por medio. Por eso
    // dejamos pasar sin pedir Basic Auth:
    //   1) cualquier fichero estatico del panel (todo lo que no sea /api/...)
    //      - es solo código/HTML, sin datos, y el propio panel decide en el
    //        navegador qué mostrar (login de Equipo o panel de admin);
    //   2) /api/auth/... (login/logout/quién-soy de Equipo) - si no, nadie
    //      podría ni intentar meter su email/contraseña;
    //   3) las rutas de Mensajes/SFS (bóveda) cuando quien pregunta ya tiene
    //      una cookie de Equipo válida - el acceso fino (qué cuentas, qué
    //      apartado) lo sigue comprobando requireSectionAccess exactamente
    //      igual que antes. El resto de la API (cuentas, reenviador,
    //      campañas, configuración...) sigue exigiendo Basic Auth siempre,
    //      tenga o no cookie de Equipo la petición.
    const panelUser = process.env.PANEL_USERNAME;
    const panelPass = process.env.PANEL_PASSWORD;
    if (!panelUser || !panelPass) {
        console.error("[seguridad] Faltan las variables PANEL_USERNAME / PANEL_PASSWORD: el panel NO arrancara sin ellas, para no quedar publico por error.");
        process.exit(1);
    }
    // Mensajes Pro es el MISMO motor de Mensajes, registrado otra vez mas
    // abajo bajo el prefijo /pro con su propio requireSectionAccess
    // ("mensajes-pro") - por eso cada patron de aqui tiene tambien su gemelo
    // con "/pro" delante. /api/mensajes-pro/accounts es la unica ruta nueva
    // de verdad (la lista de cuentas para la barra de pestañas).
    const WORKER_ACCESSIBLE_PATH_PATTERNS = [
        /^\/api\/accounts\/[^/]+\/dialogs(\/.*)?$/,
        /^\/api\/accounts\/[^/]+\/avatar$/,
        /^\/api\/accounts\/[^/]+\/unread-summary$/,
        /^\/api\/accounts\/[^/]+\/fan-notes-lists$/,
        /^\/api\/accounts\/[^/]+\/note$/,
        /^\/api\/accounts\/[^/]+\/scripts$/,
        /^\/api\/accounts\/[^/]+\/stream$/,
        /^\/api\/accounts\/[^/]+\/content-group(\/.*)?$/,
        /^\/api\/scripts\/[^/]+$/,
        /^\/api\/sales(\/[^/]+)?$/,
        /^\/api\/mensajes-pro\/accounts$/,
        /^\/pro\/api\/accounts\/[^/]+\/dialogs(\/.*)?$/,
        /^\/pro\/api\/accounts\/[^/]+\/avatar$/,
        /^\/pro\/api\/accounts\/[^/]+\/unread-summary$/,
        /^\/pro\/api\/accounts\/[^/]+\/fan-notes-lists$/,
        /^\/pro\/api\/accounts\/[^/]+\/note$/,
        /^\/pro\/api\/accounts\/[^/]+\/scripts$/,
        /^\/pro\/api\/accounts\/[^/]+\/stream$/,
        /^\/pro\/api\/accounts\/[^/]+\/content-group(\/.*)?$/,
        /^\/pro\/api\/scripts\/[^/]+$/,
        /^\/pro\/api\/sales(\/[^/]+)?$/,
    ];
    app.addHook("onRequest", async (request, reply) => {
        const url = (request.raw.url || "").split("?")[0];
        // 1) Panel estático (SPA): sin esto ni siquiera cargaría la pantalla de
        // login de Equipo en /equipo.
        if (!url.startsWith("/api/"))
            return;
        // 2) Login/logout/sesión de Equipo: tiene que poder llegar sin Basic Auth.
        if (url.startsWith("/api/auth/"))
            return;
        // 3) Basic Auth correcto (el dueño): pasa siempre, a cualquier ruta.
        const header = request.headers.authorization;
        const expected = "Basic " + Buffer.from(`${panelUser}:${panelPass}`).toString("base64");
        if (header === expected)
            return;
        // 4) Sin Basic Auth: solo puede pasar un trabajador con sesión válida,
        // y solo a las rutas de Mensajes/SFS - requireSectionAccess hace después
        // la comprobación fina de cuenta+apartado concreto.
        if (WORKER_ACCESSIBLE_PATH_PATTERNS.some((pattern) => pattern.test(url))) {
            const worker = await (0, auth_2.getWorkerFromRequest)(request);
            if (worker)
                return;
        }
        reply
            .code(401)
            .header("WWW-Authenticate", 'Basic realm="Panel LUXE FAN MANAGEMENT"')
            .send("Autenticacion requerida");
    });
    // Panel web (frontend estatico): se sirve desde el mismo servicio/dominio
    // que la API, asi que no hace falta CORS ni un segundo servicio en Railway.
    // app.js/style.css cambian en casi cada deploy; sin esto el navegador (sobre
    // todo Safari) a veces sigue usando una copia vieja en cache despues de
    // desplegar y "el arreglo no se nota" aunque el servidor ya lo tenga listo.
    // Con no-cache el navegador SIEMPRE pregunta al servidor si hay una version
    // nueva (barato, son ficheros pequeños) en vez de asumir que la que tiene
    // sigue valiendo.
    await app.register(static_1.default, {
        root: path_1.default.join(__dirname, "..", "public"),
        prefix: "/",
        setHeaders: (res, filePath) => {
            if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".html")) {
                res.setHeader("Cache-Control", "no-cache");
            }
        },
    });
    app.setNotFoundHandler((request, reply) => {
        if (request.raw.url?.startsWith("/api/")) {
            reply.code(404).send({ error: "not found" });
            return;
        }
        reply.sendFile("index.html");
    });
    await (0, logs_1.registerLogsRoutes)(app);
    await (0, accounts_1.registerAccountRoutes)(app);
    await (0, sourceGroups_1.registerSourceGroupRoutes)(app);
    await (0, campaigns_1.registerCampaignRoutes)(app);
    await (0, telegramFolders_1.registerTelegramFolderRoutes)(app);
    await (0, scheduleSlots_1.registerScheduleSlotRoutes)(app);
    await (0, accountLogin_1.registerAccountLoginRoutes)(app);
    // Mensajes y SFS (bóveda/paquetes) son los dos apartados a los que un
    // trabajador puede tener acceso: se registran dentro de un hijo de
    // Fastify con el "guardia" de permisos enganchado como preHandler, así
    // que TODAS sus rutas quedan cubiertas sin tocar messages.ts/
    // contentLibrary.ts. El dueño (sin cookie de trabajador, o admin) sigue
    // entrando exactamente igual que hasta ahora.
    await app.register(async (instance) => {
        instance.addHook("preHandler", (0, auth_2.requireSectionAccess)("mensajes"));
        await (0, messages_1.registerMessagesRoutes)(instance);
    });
    await app.register(async (instance) => {
        instance.addHook("preHandler", (0, auth_2.requireSectionAccess)("sfs"));
        await (0, contentLibrary_1.registerContentLibraryRoutes)(instance);
    });
    // "Mensajes Pro": la bandeja multi-cuenta para el equipo de chatters. Por
    // dentro es EL MISMO motor de Mensajes (mismas rutas de dialogos,
    // mensajes, notas, ventas, grupos restringidos...), registrado otra vez
    // bajo el prefijo /pro para que tenga su propio permiso
    // ("mensajes-pro", concedido aparte en Equipo - una cuenta puede tener
    // Mensajes sin Mensajes Pro, o al reves). No se toca messages.ts para
    // nada de esto.
    await app.register(async (instance) => {
        instance.addHook("preHandler", (0, auth_2.requireSectionAccess)("mensajes-pro"));
        await (0, messages_1.registerMessagesRoutes)(instance);
    }, { prefix: "/pro" });
    await (0, messagesPro_1.registerMessagesProRoutes)(app);
    await (0, emojiPacks_1.registerEmojiPackRoutes)(app);
    await (0, settings_1.registerSettingsRoutes)(app);
    await (0, freeChannels_1.registerFreeChannelRoutes)(app);
    await (0, modeloConfig_1.registerModeloConfigRoutes)(app);
    await (0, auth_1.registerAuthRoutes)(app);
    await (0, workers_1.registerWorkerRoutes)(app);
    const port = Number(process.env.PORT ?? 4000);
    await app.listen({ port, host: "0.0.0.0" });
    await seedInitialAdmin().catch((err) => console.error("[equipo] no se pudo crear el primer admin:", err));
    await (0, orchestrator_1.startOrchestrator)();
    await purgeOldLogs();
    setInterval(purgeOldLogs, 6 * 60 * 60 * 1000); // cada 6h
    const shutdown = async (signal) => {
        console.log(`[shutdown] ${signal} recibido, cerrando conexiones de Telegram...`);
        await (0, connectionPool_1.closeAllAccountClients)();
        await app.close();
        await prisma_1.prisma.$disconnect();
        process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map