import { seedEmojiPacksOnce } from "./telegram/emojiSeed";
import "dotenv/config";
import path from "path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import { registerLogsRoutes } from "./api/logs";
import { registerAccountRoutes } from "./api/accounts";
import { registerSourceGroupRoutes } from "./api/sourceGroups";
import { registerCampaignRoutes } from "./api/campaigns";
import { registerTelegramFolderRoutes } from "./api/telegramFolders";
import { registerScheduleSlotRoutes } from "./api/scheduleSlots";
import { registerAccountLoginRoutes } from "./api/accountLogin";
import { registerMessagesRoutes } from "./api/messages";
import { registerMessagesProRoutes } from "./api/messagesPro";
import { registerContentLibraryRoutes } from "./api/contentLibrary";
import { registerEmojiPackRoutes } from "./api/emojiPacks";
import { registerSettingsRoutes } from "./api/settings";
import { registerFreeChannelRoutes, registerAccountPricesRoutes } from "./api/freeChannels";
import { registerModeloConfigRoutes } from "./api/modeloConfig";
import { registerAuthRoutes } from "./api/auth";
import { registerWorkerRoutes } from "./api/workers";
import { registerWorkHoursRoutes } from "./api/workHours";
import { registerGuionesRoutes } from "./api/guiones";
import { registerPaymentDetectorRoutes } from "./api/paymentDetector";
import { registerScheduledPostRoutes } from "./api/scheduledPosts";
import { registerPublishedPostsRoutes } from "./api/publishedPosts";
import { registerWhatsAppRoutes } from "./api/whatsapp";
import { registerInformesRoutes } from "./api/informes";
import { registerPromoGroupRoutes } from "./api/promoGroups";
import { registerSfsChatRoutes } from "./api/sfsChat";
import { registerJapRoutes } from "./api/jap";
import { registerPayrollRoutes } from "./api/payroll";
import { registerModelPayrollRoutes } from "./api/modelPayroll";
import { registerPerformanceRoutes } from "./api/performance";
import { registerSecurityRoutes } from "./api/security";
import { registerClockRoutes } from "./api/clock";
import { registerHelpRoutes } from "./api/help";
import { registerPaymentAccountsRoutes } from "./api/paymentAccounts";
import { syncAllPaymentAccounts } from "./payments/paymentSync";
import { requireSectionAccess, requireContentLibraryAccess, getWorkerFromRequest, getOwnerSessionFromRequest, isDesktopAppRequest } from "./utils/auth";
import { startOrchestrator } from "./engine/orchestrator";
import { closeAllAccountClients, getAccountClient, reconnectAllAccountsGently } from "./telegram/connectionPool";
import { getCachedDialogs } from "./telegram/dialogsCache";
import { prisma } from "./utils/prisma";
import { ensureDefaultPaymentRules, fixLooseIbanRulePattern } from "./utils/paymentDetector";
import { migrateTeamLeadsToExplicitPermissions } from "./utils/teamLeadMigration";
import { ensureLegacyAgency, LEGACY_AGENCY_ID } from "./utils/agencyMigration";
import { registerAgencyRoutes } from "./api/agencies";
import { registerSubscriptionRoutes, isAgencyBlockedForBilling } from "./api/subscription";
import { resumeWhatsAppIfLinked } from "./whatsapp/waClient";

// NOTA: antes hacía falta un "admin" de Equipo (creado automáticamente al
// arrancar, con contraseña temporal) para poder entrar en /equipo y dar de
// alta al resto del equipo — un login totalmente aparte del panel normal.
// Ahora Configuración → Equipo lo gestiona directamente la cuenta luxe (la
// misma sesión de /login de siempre), así que ese arranque automático ya no
// hace falta: nadie necesita ese admin de Equipo para empezar a dar de alta
// empleados.

const LOG_RETENTION_DAYS = 7;

async function purgeOldLogs() {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.sendLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) console.log(`[cleanup] borrados ${count} logs con mas de ${LOG_RETENTION_DAYS} dias`);
}

/**
 * Precalienta la caché de "Mensajes" (getCachedDialogs, ver dialogsCache.ts)
 * de todas las cuentas justo al arrancar el servidor. Sin esto, la caché
 * (en memoria, se vacía en CADA despliegue) está siempre fría cuando alguien
 * -dueño o trabajador- abre Mensajes justo después de un "railway up": la
 * primera persona en abrirlo es quien paga la espera real de pedirle a
 * Telegram la lista entera de conversaciones (puede tardar bastante con
 * muchos chats). Esto se notó sobre todo con un empleado nuevo probando
 * justo tras desplegar, pero le pasa a CUALQUIERA que sea el primero.
 *
 * Se hace en segundo plano (nunca bloquea app.listen), UNA cuenta detrás de
 * otra (nunca todas a la vez: conectar+pedir 600 diálogos de golpe en varias
 * cuentas simultáneamente es justo el patrón que a Telegram le puede oler a
 * abuso y hacer que limite/corte una cuenta - con cuentas ya delicadas por
 * PeerFlood esto es especialmente arriesgado), con una pequeña pausa entre
 * cuenta y cuenta, y con cada fallo aislado (una cuenta caída/desconectada
 * no debe impedir precalentar el resto). Para cuando alguien realmente abra
 * Mensajes, la caché ya debería estar lista.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function warmUpDialogsCache() {
  try {
    const accounts = await prisma.account.findMany({ select: { id: true, label: true } });
    for (const account of accounts) {
      try {
        const full = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
        const client = await getAccountClient(full);
        await getCachedDialogs(client, account.id);
      } catch (err) {
        console.error(`[warmup] no se pudo precargar Mensajes de "${account.label}":`, (err as any)?.message || err);
      }
      await sleep(4000); // respiro entre cuenta y cuenta
    }
    console.log(`[warmup] caché de Mensajes precargada para ${accounts.length} cuenta(s).`);
  } catch (err) {
    console.error("[warmup] fallo precargando caché de Mensajes:", err);
  }
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

  const app = Fastify({ logger: true });

  // Cookie de sesión del "Equipo" (login de trabajadores). Se registra ANTES
  // del Basic Auth para que este ya pueda leer request.cookies y decidir si
  // dejar pasar a un trabajador logueado sin pedirle el usuario/contraseña
  // general de Railway (que nunca debe tener un chatter).
  await app.register(fastifyCookie);

  // Proteccion con usuario/contraseña (HTTP Basic Auth) para el panel de
  // administrador (dueño) y el resto de la API, porque el dominio de
  // Railway es publico y desde el panel se puede encender el interruptor
  // maestro de envios. Usuario/contraseña se configuran con las variables
  // de entorno PANEL_USERNAME / PANEL_PASSWORD en Railway y SOLO las tiene
  // el dueño - nunca se le dan a un trabajador.
  //
  // Un trabajador ("Equipo") nunca ve ni escribe este usuario/contraseña:
  // entra con su propio email/contraseña en el MISMO /login que la cuenta
  // luxe (POST /api/auth/unified-login decide con qué cookie se queda), y
  // ese login necesita poder llegar al servidor sin Basic Auth de por
  // medio. Por eso dejamos pasar sin pedir Basic Auth:
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
    console.error(
      "[seguridad] Faltan las variables PANEL_USERNAME / PANEL_PASSWORD: el panel NO arrancara sin ellas, para no quedar publico por error."
    );
    process.exit(1);
  }
  // Mensajes Pro es el MISMO motor de Mensajes, registrado otra vez mas
  // abajo bajo el prefijo /pro con su propio requireSectionAccess
  // ("mensajes-pro") - por eso cada patron de aqui tiene tambien su gemelo
  // con "/pro" delante. /api/mensajes-pro/accounts es la unica ruta nueva
  // de verdad (la lista de cuentas para la barra de pestañas).
  const WORKER_ACCESSIBLE_PATH_PATTERNS: RegExp[] = [
    // La lista de cuentas en sí (sin :id): la necesita CUALQUIER trabajador
    // nada más entrar, para saber a qué cuentas tiene acceso (el filtro fino
    // de cuáles exactamente es cosa de WorkerPermission, ver
    // renderWorkerRestrictedShell en el frontend) — faltaba en esta lista,
    // así que un empleado nuevo veía "Error cargando cuentas: Autenticación
    // requerida" nada más iniciar sesión.
    /^\/api\/accounts$/,
    /^\/api\/accounts\/[^/]+\/dialogs(\/.*)?$/,
    /^\/api\/accounts\/[^/]+\/avatar$/,
    /^\/api\/accounts\/[^/]+\/unread-summary$/,
    /^\/api\/accounts\/[^/]+\/fan-notes-lists$/,
    /^\/api\/accounts\/[^/]+\/note$/,
    /^\/api\/accounts\/[^/]+\/prices$/,
    /^\/api\/accounts\/[^/]+\/scripts$/,
    /^\/api\/accounts\/[^/]+\/stream$/,
    // Notificaciones de Mensajes Pro con varias creadoras a la vez y las
    // insignias de 'sin leer' de la barra de pestañas (ver
    // /api/accounts/live-stream y /api/accounts/unread-summary-bulk en
    // messages.ts) - sin estas dos, ningún trabajador (Team líder ni
    // Chatter) podía conectar ninguna de las dos, así que las
    // notificaciones de escritorio y las insignias nunca llegaban a
    // funcionar en Mensajes Pro para el equipo, solo para el dueño.
    /^\/api\/accounts\/live-stream$/,
    /^\/api\/accounts\/unread-summary-bulk$/,
    /^\/api\/accounts\/[^/]+\/content-group(\/.*)?$/,
    /^\/api\/scripts\/[^/]+$/,
    // "Servicio"/"Método de pago" del formulario de registrar venta (ver
    // openSaleModal en app.js): sin esto, cualquier chatter se quedaba con
    // esos dos desplegables vacíos (solo el placeholder, sin ninguna
    // opción real) al dar un 401 en silencio - el PUT que cambia estas
    // listas de agencia sigue bloqueado para no-admins, ver el chequeo de
    // "worker" dentro del propio handler en settings.ts.
    /^\/api\/settings\/general$/,
    // Mismo caso que arriba pero visto desde Mensajes Pro: su frontend usa
    // API_BASE = "/pro/api" para TODAS las llamadas mientras esa pantalla
    // está abierta, así que la petición de verdad es "/pro/api/settings/
    // general", no "/api/settings/general" - sin este gemelo, el desplegable
    // de Servicio/Método de pago se quedaba vacío en Mensajes Pro incluso
    // después de arreglarlo en Mensajes normal (y afectaba también al dueño,
    // no solo a los chatters, porque la ruta ni existía bajo /pro - ver el
    // registro duplicado de registerSettingsRoutes más abajo).
    /^\/pro\/api\/settings\/general$/,
    // Antes era "/api/sales(/:id)?" (el :id, cuando estaba, era el de la
    // VENTA - lo que hacia que requireSectionAccess comprobase el permiso
    // contra un id que nunca era el de una cuenta, bloqueando siempre a los
    // trabajadores no-admin al borrar una venta, ver messages.ts). Ahora el
    // borrado va por cuenta ("/api/accounts/:id/sales/:saleId"), asi que ya
    // encaja con el resto de patrones de aqui (":id" = cuenta de verdad).
    /^\/api\/accounts\/[^/]+\/sales\/[^/]+$/,
    /^\/api\/mensajes-pro\/accounts$/,
    /^\/api\/workers\/heartbeat$/,
    // SFS: la pestaña nueva, exclusiva de Team líder (ver requireSectionAccess
    // "sfs" en utils/auth.ts, que ya bloquea a cualquier Chatter aunque pase
    // este guardia general). Sin estos dos patrones, sfs-dialogs y
    // sfs-group/forward daban 401 aquí mismo para CUALQUIER trabajador,
    // incluso un Team líder con el permiso "sfs" concedido - nunca habían
    // sido alcanzables por HTTP para ningún rol hasta ahora. sfs-note ya
    // encajaba con el patrón de "dialogs" de arriba, no hace falta repetirlo.
    /^\/api\/accounts\/[^/]+\/sfs-dialogs$/,
    /^\/api\/accounts\/[^/]+\/sfs-group\/forward$/,
    /^\/pro\/api\/accounts\/[^/]+\/dialogs(\/.*)?$/,
    /^\/pro\/api\/accounts\/[^/]+\/avatar$/,
    /^\/pro\/api\/accounts\/[^/]+\/unread-summary$/,
    /^\/pro\/api\/accounts\/[^/]+\/fan-notes-lists$/,
    /^\/pro\/api\/accounts\/[^/]+\/note$/,
    /^\/pro\/api\/accounts\/[^/]+\/prices$/,
    /^\/pro\/api\/accounts\/[^/]+\/scripts$/,
    /^\/pro\/api\/accounts\/[^/]+\/stream$/,
    /^\/pro\/api\/accounts\/live-stream$/,
    /^\/pro\/api\/accounts\/unread-summary-bulk$/,
    /^\/pro\/api\/accounts\/[^/]+\/content-group(\/.*)?$/,
    /^\/pro\/api\/scripts\/[^/]+$/,
    /^\/pro\/api\/accounts\/[^/]+\/sales\/[^/]+$/,
    // NOTA: /api/workers (lista del equipo, para "Vendido por") ya NO está
    // en esta lista - ver a proposito el equipo en Configuracion es "de las
    // demas opciones" reservadas al dueño/jefe (requireOwnerOrAdminWorker en
    // workers.ts ahora exige la cuenta luxe de verdad); un Team líder tiene
    // aqui el mismo perfil que un Chatter (ninguno de los dos ve el equipo).
    // "Pagos" del chatter (ver renderWorkerPagosView en app.js): sin esto
    // daba "Error: Autenticación requerida" nada más entrar, porque este
    // guardia general bloquea CUALQUIER /api/* que no esté en esta lista
    // antes de que la petición llegue siquiera a paymentAccounts.ts (que ya
    // tenía su propia lógica para dejar pasar a un trabajador y limitarlo a
    // los ingresos de hoy - ver isChatterOnly en esa ruta - pero nunca
    // llegaba a ejecutarse).
    /^\/api\/incoming-payments$/,
    // El chatter también puede enlazar un pago con una venta ya registrada
    // (candidatas + adjuntar) - "por una vez": deshacerlo (unlink) sigue
    // siendo solo del admin, así que esa ruta se queda FUERA de esta lista
    // a propósito (paymentAccounts.ts también lo exige por su cuenta, pero
    // así ni siquiera llega hasta ahí). Registrar una venta nueva o
    // gestionar cuentas de cobro tampoco están aquí: eso sigue siendo cosa
    // del admin.
    /^\/api\/incoming-payments\/[^/]+\/candidates$/,
    /^\/api\/incoming-payments\/[^/]+\/link$/,
    // "Nóminas" del propio trabajador (ver renderWorkerNominasView en
    // app.js): solo sus propias nóminas ya generadas por el dueño, de solo
    // lectura - payroll.ts comprueba por su cuenta que workerId sea el
    // suyo (ver canAccessPayroll/GET /mine), esto solo abre la puerta del
    // guardia general para que la petición llegue siquiera hasta ahí.
    /^\/api\/payroll\/mine$/,
    /^\/api\/payroll\/[^/]+\/docx$/,
    /^\/api\/payroll\/[^/]+\/pdf$/,
    // "Mi rendimiento" del propio trabajador (ver renderWorkerPerformanceView
    // en app.js): solo sus propios datos - performance.ts calcula todo a
    // partir de su propia sesión (worker.id/worker.name), esto solo abre la
    // puerta del guardia general para que la petición llegue hasta ahí.
    /^\/api\/performance\/mine$/,
    // "Programar posts": exclusivo de Team líder (role "admin"), igual que
    // SFS - requireSectionAccess("programar-posts") ya bloquea a cualquier
    // Chatter (ver registro más abajo), y scheduledPosts.ts comprueba a mano
    // el permiso por cuenta en reprogramar/borrar (canManageScheduledPost,
    // porque esas dos rutas no llevan el id de la cuenta en la URL). Sin
    // estos dos patrones, ambas daban 401 aquí mismo para CUALQUIER
    // trabajador, incluso un Team líder con el permiso concedido.
    /^\/api\/accounts\/[^/]+\/scheduled-posts$/,
    /^\/api\/scheduled-posts\/[^/]+$/,
    /^\/api\/accounts\/[^/]+\/published-posts$/,
    // "Seguridad → Capturas de pantalla": lo llama la app de escritorio en
    // el momento del intento, cualquier trabajador (Chatter o Team líder),
    // sin permiso de sección concreto - ver security.ts.
    /^\/api\/security\/capture-attempt$/,
    // "Fichar" (entrada/salida/descanso): cualquier trabajador con sesión,
    // sin permiso de sección concreto - ver clock.ts.
    /^\/api\/clock(\/.*)?$/,
  ];

  // Multi-agencia, fase 2: Cuentas de Telegram, Equipo, Ajustes generales,
  // Pagos (cuentas de cobro + Detector de pagos), JAP, Grupos de promoción,
  // Nóminas (Chatter's y Modelos) e Informes/Horas trabajadas ya están
  // realmente separados por agencia en el backend (ver settings.ts,
  // paymentAccounts.ts, paymentDetector.ts, jap.ts, promoGroups.ts,
  // payroll.ts, modelPayroll.ts, informes.ts, workHours.ts). Lo único que
  // sigue siendo UNA sola conexión/tabla global compartida es WhatsApp (un
  // solo número vinculado por QR para todo el servidor, ver whatsapp/
  // waClient.ts - dar de alta un WhatsApp por agencia es un cambio de
  // arquitectura mayor, pendiente) - por eso el dueño de una agencia NUEVA
  // (no "legacy-agency", es decir, no tú) sigue sin poder tocar esa sección
  // concreta, con un 403 claro en vez de dejarle ver o desconectar el
  // WhatsApp de otra agencia.
  const NEW_AGENCY_OWNER_ALLOWED_PATH_PATTERNS: RegExp[] = [
    /^\/api\/subscription(\/.*)?$/,
    /^\/api\/accounts(\/.*)?$/,
    /^\/api\/account-login\//,
    /^\/api\/workers(\/.*)?$/,
    /^\/pro\/api\/accounts\/[^/]+/,
    /^\/api\/settings\/general(\/.*)?$/,
    /^\/pro\/api\/settings\/general$/,
    /^\/api\/settings\/clear-cache$/,
    /^\/api\/settings\/disk-usage$/,
    /^\/api\/settings\/shadow-mode$/,
    /^\/api\/payment-accounts(\/.*)?$/,
    /^\/api\/incoming-payments(\/.*)?$/,
    /^\/api\/payment-detector\/.*/,
    /^\/api\/jap\/.*/,
    /^\/api\/promo-admins(\/.*)?$/,
    /^\/api\/promo-groups(\/.*)?$/,
    /^\/api\/promo-admin-prices(\/.*)?$/,
    /^\/api\/payroll(\/.*)?$/,
    /^\/api\/model-payroll(\/.*)?$/,
    /^\/api\/informes\/.*/,
    /^\/api\/work-hours(\/.*)?$/,
    /^\/api\/performance(\/.*)?$/,
    // Reprogramar/borrar un post ya creado no lleva el id de cuenta en la
    // URL (a diferencia de /api/accounts/:id/scheduled-posts, ya cubierto
    // por el patrón de /api/accounts de arriba) - scheduledPosts.ts
    // comprueba a mano que la cuenta del post sea de la agencia de quien
    // pregunta (canManageScheduledPost), así que ya es seguro abrirlo aquí.
    /^\/api\/scheduled-posts(\/.*)?$/,
    /^\/api\/security(\/.*)?$/,
    /^\/api\/clock(\/.*)?$/,
    // El REENVIADOR en sí (el motivo por el que existe este CRM) se había
    // quedado fuera para cualquier agencia nueva: "Orígenes" (source-groups)
    // y "Campañas/Programados" (campaigns + schedule-slots) solo tienen el
    // id de la propia cuenta en la URL para crear/listar (ya cubierto por
    // /api/accounts arriba) pero editar/comprobar/borrar un origen o una
    // campaña concreta va por SU PROPIO id (/api/source-groups/:id,
    // /api/campaigns/:id...) - sin estos patrones daban 403 "próximamente"
    // en cuanto se tocaba cualquiera de esos botones. Seguro abrirlos aquí
    // porque el chequeo de agencia para estos ids concretos ya se hace más
    // abajo (ver SUBRESOURCE_OWNER_PATTERNS) antes de dejar pasar nada.
    /^\/api\/source-groups(\/.*)?$/,
    /^\/api\/campaigns(\/.*)?$/,
    /^\/api\/logs$/,
    // Igual que arriba para los packs de emoji personalizado y los guiones
    // (y sus categorías) - crear/listar ya cuelga de /api/accounts/:id/...,
    // pero borrar un pack o editar/borrar un guion/categoría va por su
    // propio id.
    /^\/api\/emoji-packs(\/.*)?$/,
    /^\/api\/guiones(\/.*)?$/,
    /^\/api\/guiones-categories(\/.*)?$/,
    // Borrar/editar un destino concreto de una campaña (quitar un grupo de
    // la carpeta de envío) va por su propio id, no por el de la campaña.
    /^\/api\/destinations(\/.*)?$/,
    // Igual que arriba: editar/borrar UN horario concreto (schedule-slots/:id,
    // distinto de /api/campaigns/:id/schedule-slots que lista/crea) va por
    // el id del propio horario.
    /^\/api\/schedule-slots(\/.*)?$/,
    // Mismo patrón para borrar un canal gratuito, una respuesta rápida o un
    // paquete SFS concretos - listar/crear ya cuelga de /api/accounts/:id/...
    // (cubierto arriba), pero borrar va por su propio id.
    /^\/api\/free-channels(\/.*)?$/,
    /^\/api\/quick-replies(\/.*)?$/,
    /^\/api\/sfs-packages(\/.*)?$/,
  ];
  // Rutas que cuelgan de un SUB-recurso (origen, campaña, pack de emoji,
  // guion, categoría de guion) en vez de llevar directamente el id de la
  // CUENTA en la URL - a diferencia de /api/accounts/:id/..., el chequeo de
  // agencia de más abajo no las cubre por su cuenta, así que hay que
  // resolver manualmente "a qué cuenta pertenece este id" antes de dejar
  // pasar ninguna lectura/escritura cruzada entre agencias (ver uso justo
  // debajo, en el onRequest). Sin esto, abrir los patrones de arriba habría
  // dejado que el dueño de una agencia nueva editase/borrase el origen o la
  // campaña de OTRA agencia con solo adivinar o reutilizar su id.
  const SUBRESOURCE_OWNER_PATTERNS: { pattern: RegExp; resolve: (id: string) => Promise<string | null> }[] = [
    {
      pattern: /^\/api\/source-groups\/([^/]+)/,
      resolve: async (id) => (await prisma.sourceGroup.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
    {
      pattern: /^\/api\/campaigns\/([^/]+)/,
      resolve: async (id) => (await prisma.campaign.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
    {
      pattern: /^\/api\/emoji-packs\/([^/]+)/,
      resolve: async (id) => (await prisma.accountEmojiPack.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
    {
      pattern: /^\/api\/guiones\/([^/]+)/,
      resolve: async (id) => (await prisma.guionScript.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
    {
      pattern: /^\/api\/guiones-categories\/([^/]+)/,
      resolve: async (id) => (await prisma.scriptCategory.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
    {
      pattern: /^\/api\/destinations\/([^/]+)/,
      resolve: async (id) => {
        const dest = await prisma.campaignDestination.findUnique({ where: { id }, select: { campaign: { select: { accountId: true } } } });
        return dest?.campaign.accountId ?? null;
      },
    },
    {
      pattern: /^\/api\/schedule-slots\/([^/]+)/,
      resolve: async (id) => {
        const slot = await prisma.scheduleSlot.findUnique({ where: { id }, select: { campaign: { select: { accountId: true } } } });
        return slot?.campaign.accountId ?? null;
      },
    },
    {
      pattern: /^\/api\/free-channels\/([^/]+)/,
      resolve: async (id) => (await prisma.freeChannel.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
    {
      pattern: /^\/api\/quick-replies\/([^/]+)/,
      resolve: async (id) => (await prisma.quickReply.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
    {
      pattern: /^\/api\/sfs-packages\/([^/]+)/,
      resolve: async (id) => (await prisma.sfsPackage.findUnique({ where: { id }, select: { accountId: true } }))?.accountId ?? null,
    },
  ];
  // Mismo límite que arriba pero para un TRABAJADOR de una agencia nueva: ya
  // no hace falta una lista aparte y más corta - todo lo que un trabajador
  // puede llegar a tocar (ver WORKER_ACCESSIBLE_PATH_PATTERNS) ya está
  // aislado por agencia igual que para el dueño, así que usa la MISMA lista
  // que un trabajador de tu propia agencia.
  const NEW_AGENCY_WORKER_ALLOWED_PATH_PATTERNS: RegExp[] = WORKER_ACCESSIBLE_PATH_PATTERNS;

  app.addHook("onRequest", async (request, reply) => {
    const url = (request.raw.url || "").split("?")[0];

    // 1) Panel estático (SPA): sin esto ni siquiera cargaría la pantalla de
    // login de Equipo en /equipo.
    if (!url.startsWith("/api/")) return;

    // 2) Login/logout/sesión de Equipo: tiene que poder llegar sin Basic Auth.
    if (url.startsWith("/api/auth/")) return;

    // Webhook de Stripe: lo llama Stripe directamente, sin ninguna cookie
    // nuestra - su propia firma (STRIPE_WEBHOOK_SECRET, ver api/subscription.ts)
    // es la que garantiza que viene de verdad de Stripe, así que tiene que
    // poder llegar sin pasar por este guardia de sesión/agencia.
    if (url === "/api/subscription/webhook") return;

    // 3) Cookie de sesión del dueño (portal /login, mismas credenciales de
    // PANEL_USERNAME/PANEL_PASSWORD - ver utils/auth.ts y api/auth.ts). Ya
    // NO se acepta el Basic Auth "de toda la vida" aquí: si se siguiera
    // aceptando, un navegador que ya lo tuviera guardado de antes (los
    // guarda hasta que se cierra del todo) volvería a colar solo al dueño
    // después de darle a "Cerrar sesión" -que solo borra esta cookie-,
    // haciendo que cerrar sesión no sirviera de nada. Ahora la cookie es la
    // ÚNICA forma de entrar por aquí.
    const ownerSession = getOwnerSessionFromRequest(request);

    // Multi-agencia: averiguamos primero la agencia de quien pregunta (dueño
    // de legacy-agency, dueño de una agencia nueva, o trabajador de
    // cualquiera de las dos) para poder bloquear el acceso cruzado entre
    // agencias ANTES de decidir si se deja pasar o no.
    let worker: Awaited<ReturnType<typeof getWorkerFromRequest>> = null;
    let callerAgencyId: string | null = ownerSession ? ownerSession.agencyId : null;
    if (!ownerSession) {
      worker = await getWorkerFromRequest(request);
      if (worker) callerAgencyId = worker.agencyId;
    }

    // Muro de pago (solo agencias NUEVAS que usan este CRM como servicio de
    // pago - nunca "legacy-agency", ver isAgencyBlockedForBilling): si la
    // prueba gratuita ya terminó sin activar un plan, o hay un impago de más
    // de 3 días, se bloquea TODO excepto la propia pantalla de Suscripción
    // (para que el dueño pueda entrar a pagar) y el login/logout de siempre.
    // El súper-admin (tú) NUNCA se bloquea con esto, ni siquiera "viendo
    // como" una agencia nueva sin pagar (Configuración → Agencias → "Ver
    // datos") - tienes que poder entrar a revisarla/suspenderla igual.
    if (callerAgencyId && !ownerSession?.isSuperAdmin && !url.startsWith("/api/subscription")) {
      const blockedReason = await isAgencyBlockedForBilling(callerAgencyId);
      if (blockedReason) {
        reply.code(402).send({ error: blockedReason });
        return;
      }
    }

    // Si la URL apunta a una cuenta concreta (/api/accounts/:id/... o
    // /pro/api/accounts/:id/..., de donde cuelgan Mensajes, SFS, bóveda,
    // campañas, ajustes de la cuenta...), esa cuenta tiene que ser de la
    // MISMA agencia que quien pregunta - si no, 404 (no 403, para no
    // confirmar que existe una cuenta con ese id en otra agencia). Con este
    // único chequeo, ninguna ruta que cuelgue de una cuenta concreta necesita
    // tocarse una por una para quedar aislada entre agencias.
    if (callerAgencyId) {
      const accountMatch = url.match(/^\/(?:pro\/)?api\/accounts\/([^/]+)/);
      if (accountMatch) {
        const account = await prisma.account.findUnique({ where: { id: accountMatch[1] }, select: { agencyId: true } });
        if (account && account.agencyId !== callerAgencyId) {
          reply.code(404).send({ error: "Cuenta no encontrada" });
          return;
        }
      } else {
        // No es /api/accounts/:id/... pero puede ser un sub-recurso que
        // cuelga de su PROPIO id (origen, campaña, pack de emoji, guion...,
        // ver SUBRESOURCE_OWNER_PATTERNS arriba) - resolvemos a qué cuenta
        // pertenece ese id y comprobamos la agencia igual que arriba.
        for (const sub of SUBRESOURCE_OWNER_PATTERNS) {
          const subMatch = url.match(sub.pattern);
          if (!subMatch) continue;
          const accountId = await sub.resolve(subMatch[1]);
          if (accountId) {
            const account = await prisma.account.findUnique({ where: { id: accountId }, select: { agencyId: true } });
            if (account && account.agencyId !== callerAgencyId) {
              reply.code(404).send({ error: "Recurso no encontrado" });
              return;
            }
          }
          break;
        }
      }
    }

    if (ownerSession) {
      // El súper-admin (tú) sigue viendo TODO exactamente igual que
      // siempre, tanto en su propia agencia como "viendo como" cualquier
      // otra (Configuración → Agencias → "Ver datos" - ver api/agencies.ts,
      // POST .../view-as): isSuperAdmin se queda en true aunque
      // ownerSession.agencyId ya no sea legacy-agency en ese momento, así
      // que este bypass mira isSuperAdmin, NO qué agencia está mirando
      // ahora mismo. El dueño de una agencia NUEVA (isSuperAdmin: false de
      // verdad, el que la creó desde /login con su propio email) queda
      // limitado a lo ya aislado (ver NEW_AGENCY_OWNER_ALLOWED_PATH_PATTERNS
      // arriba) hasta que el resto de apartados también se separen por
      // agencia.
      if (ownerSession.isSuperAdmin) return;
      if (NEW_AGENCY_OWNER_ALLOWED_PATH_PATTERNS.some((pattern) => pattern.test(url))) return;
      reply.code(403).send({ error: "Esta función todavía no está disponible para tu agencia (próximamente)." });
      return;
    }

    // 4) Sin sesión de dueño: solo puede pasar un trabajador con sesión
    // válida, y solo a las rutas de Mensajes/SFS - requireSectionAccess hace
    // después la comprobación fina de cuenta+apartado concreto. Un
    // trabajador de una agencia NUEVA queda limitado a una lista más corta
    // (ver comentario de NEW_AGENCY_WORKER_ALLOWED_PATH_PATTERNS arriba).
    if (worker) {
      // "Solo app de escritorio" (Equipo → Permisos): esto NO es solo en el
      // login (api/auth.ts) - un trabajador con canUseBrowser=false que de
      // algún modo conservara una cookie válida (en teoría no puede, el
      // almacén de cookies de la app de escritorio es aparte del navegador
      // normal) tampoco puede seguir usando ninguna ruta desde un navegador
      // normal a partir de aquí.
      if (!worker.canUseBrowser && !isDesktopAppRequest(request)) {
        reply.code(403).send({ error: "Esta cuenta solo puede entrar desde la aplicación de escritorio de LUREQO." });
        return;
      }
      // "Solo lectura" (Equipo → Permisos, Worker.readOnly): puede ver todo
      // lo que ya veía, pero ningún método que no sea GET - así no hace
      // falta ir ruta por ruta bloqueando cada acción de escritura (enviar
      // mensaje, registrar venta, fichar, programar un post...) una por una,
      // ni aquí ni en las que se añadan en el futuro. Esto corta ANTES de
      // mirar los patrones de abajo, para la agencia legacy y para
      // cualquier agencia nueva por igual.
      if (worker.readOnly && request.method !== "GET") {
        reply.code(403).send({ error: "Tu cuenta es de solo lectura: puedes ver, pero no puedes hacer cambios." });
        return;
      }
      const patterns = worker.agencyId === LEGACY_AGENCY_ID
        ? WORKER_ACCESSIBLE_PATH_PATTERNS
        : NEW_AGENCY_WORKER_ALLOWED_PATH_PATTERNS;
      if (patterns.some((pattern) => pattern.test(url))) return;
    }

    // Ya no se manda WWW-Authenticate: eso es lo que hacía que el propio
    // navegador sacara su cuadro nativo de usuario/contraseña (feo, y sin
    // "recuérdame" de verdad) delante del portal /login. El frontend es
    // quien decide mandar a /login al ver este 401 (ver app.js, init()).
    reply.code(401).send({ error: "Autenticación requerida" });
  });

  // Panel web (frontend estatico): se sirve desde el mismo servicio/dominio
  // que la API, asi que no hace falta CORS ni un segundo servicio en Railway.
  // app.js/style.css cambian en casi cada deploy; sin esto el navegador (sobre
  // todo Safari) a veces sigue usando una copia vieja en cache despues de
  // desplegar y "el arreglo no se nota" aunque el servidor ya lo tenga listo.
  // Con no-cache el navegador SIEMPRE pregunta al servidor si hay una version
  // nueva (barato, son ficheros pequeños) en vez de asumir que la que tiene
  // sigue valiendo.
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public"),
    prefix: "/",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".js") || filePath.endsWith(".css") || filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  });

  // Web de guías (website/, Next.js export estático) servida en /crm desde
  // este mismo servicio/dominio - así se puede mandar un enlace público tipo
  // https://luxefan.es/crm sin depender de Vercel ni de un subdominio aparte.
  // Se genera con `npm run build` dentro de website/ (output: "export",
  // basePath: "/crm") y se copia tal cual a backend/public-crm antes de cada
  // deploy que la toque.
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public-crm"),
    prefix: "/crm",
    decorateReply: false,
    redirect: true,
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    if (request.raw.url?.startsWith("/crm")) {
      reply.code(404).send("Página no encontrada");
      return;
    }
    reply.sendFile("index.html");
  });

  await registerLogsRoutes(app);
  await registerAccountRoutes(app);
  await registerSourceGroupRoutes(app);
  await registerCampaignRoutes(app);
  await registerTelegramFolderRoutes(app);
  await registerScheduleSlotRoutes(app);
  await registerAccountLoginRoutes(app);

  // Mensajes y SFS (bóveda/paquetes) son los dos apartados a los que un
  // trabajador puede tener acceso: se registran dentro de un hijo de
  // Fastify con el "guardia" de permisos enganchado como preHandler, así
  // que TODAS sus rutas quedan cubiertas sin tocar messages.ts/
  // contentLibrary.ts. El dueño (sin cookie de trabajador, o admin) sigue
  // entrando exactamente igual que hasta ahora.
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("mensajes"));
    await registerMessagesRoutes(instance);
  });
  await app.register(async (instance) => {
    // NO es requireSectionAccess("sfs") a proposito: "Contenido de la
    // modelo" es la boveda que usa Mensajes normal (y tambien SFS -> Chat,
    // que comparte el mismo composer), no la pestaña SFS en si - ver el
    // comentario grande en requireContentLibraryAccess (utils/auth.ts).
    instance.addHook("preHandler", requireContentLibraryAccess());
    await registerContentLibraryRoutes(instance);
  });

  // "Mensajes Pro": la bandeja multi-cuenta para el equipo de chatters. Por
  // dentro es EL MISMO motor de Mensajes (mismas rutas de dialogos,
  // mensajes, notas, ventas, grupos restringidos...), registrado otra vez
  // bajo el prefijo /pro para que tenga su propio permiso
  // ("mensajes-pro", concedido aparte en Equipo - una cuenta puede tener
  // Mensajes sin Mensajes Pro, o al reves). No se toca messages.ts para
  // nada de esto.
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("mensajes-pro"));
    await registerMessagesRoutes(instance);
  }, { prefix: "/pro" });
  await registerMessagesProRoutes(app);

  // "Ajustes generales" (Servicio/Método de pago, verificación de ventas...)
  // NO estaba registrado bajo /pro en absoluto, así que "/pro/api/settings/
  // general" daba 404 para TODO EL MUNDO (dueño incluido) mientras se usaba
  // Mensajes Pro, ya que ahí el frontend llama a esa ruta con el prefijo
  // /pro (ver API_BASE en app.js). Se registra otra vez aquí, igual que
  // Mensajes, para que exista de verdad bajo ese prefijo.
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("mensajes-pro"));
    await registerSettingsRoutes(instance);
  }, { prefix: "/pro" });

  // Mismo caso: "/api/workers" tampoco estaba bajo /pro, así que un admin
  // usando Mensajes Pro no podía leer la lista de empleados para el
  // desplegable "Vendido por" (ver createSoldBySelector en app.js, que
  // ahora también desbloquea ese desplegable para un admin, no solo para la
  // cuenta luxe). Dar de alta/editar/borrar trabajadores sigue exigiendo la
  // cuenta luxe de verdad (ver requireAdmin en workers.ts) aunque estas
  // rutas también queden disponibles aquí.
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("mensajes-pro"));
    await registerWorkerRoutes(instance);
  }, { prefix: "/pro" });

  // Mismo caso otra vez: Mensajes Pro llama a todo con el prefijo /pro (ver
  // API_BASE en app.js), así que "Precios modelo" también necesita su
  // propio registro aquí para no dar 404 en esa pantalla.
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("mensajes-pro"));
    await registerAccountPricesRoutes(instance);
  }, { prefix: "/pro" });

  await registerEmojiPackRoutes(app);
  await registerSettingsRoutes(app);
  await registerFreeChannelRoutes(app);
  // "Precios modelo": accesible tambien para un Chatter/Team lider con
  // Mensajes concedido en esa cuenta (ver pestaña nueva en
  // renderNotesPanel, app.js) - el dueño sigue entrando igual (sin cookie
  // de trabajador, requireSectionAccess no restringe nada).
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("mensajes"));
    await registerAccountPricesRoutes(instance);
  });
  await registerModeloConfigRoutes(app);
  await registerAuthRoutes(app);
  await registerWorkerRoutes(app);
  await registerWorkHoursRoutes(app);
  await registerGuionesRoutes(app);
  await registerPaymentDetectorRoutes(app);
  // "Programar posts": exclusivo de Team líder (role "admin") entre los
  // trabajadores, igual que SFS - ver requireSectionAccess en utils/auth.ts
  // (bloquea a cualquier Chatter) y canManageScheduledPost dentro de
  // scheduledPosts.ts (comprueba el permiso por cuenta en reprogramar/
  // borrar, que no llevan el id de cuenta en la URL). El dueño sigue
  // entrando exactamente igual (requireSectionAccess deja pasar sin
  // restricción cuando no hay cookie de trabajador).
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("programar-posts"));
    await registerScheduledPostRoutes(instance);
    // "Publicadas" (una de las tres pestañas de Programar posts, ver
    // renderProgramarPostsView en app.js): mismo candado que las otras dos.
    await registerPublishedPostsRoutes(instance);
  });
  await registerWhatsAppRoutes(app);
  await registerInformesRoutes(app);
  await registerPromoGroupRoutes(app);
  // OJO: sus rutas /dialogs/:chatId/sfs-note coinciden con el patron
  // "worker accesible" de arriba (/^\/api\/accounts\/[^/]+\/dialogs(\/.*)?$/,
  // pensado para las notas normales de Mensajes) - sin envolverlo aqui con
  // requireSectionAccess("sfs"), cualquier trabajador con sesion valida
  // (aunque no tuviera "sfs" concedido, o fuese de otra cuenta) podia leer y
  // sobreescribir la nota de SFS de CUALQUIER cuenta/chat, sin que
  // sfsChat.ts comprobase nada por su cuenta. Con esto el dueño sigue
  // entrando exactamente igual (requireSectionAccess deja pasar sin
  // restriccion cuando no hay cookie de trabajador), y de paso queda listo
  // para el dia que SFS se reparta tambien por trabajador.
  await app.register(async (instance) => {
    instance.addHook("preHandler", requireSectionAccess("sfs"));
    await registerSfsChatRoutes(instance);
  });
  await registerJapRoutes(app);
  await registerPayrollRoutes(app);
  await registerModelPayrollRoutes(app);
  await registerPerformanceRoutes(app);
  await registerSecurityRoutes(app);
  await registerClockRoutes(app);
  await registerHelpRoutes(app);
  await registerPaymentAccountsRoutes(app);
  await registerAgencyRoutes(app);
  await registerSubscriptionRoutes(app);

  // Multi-agencia: se siembra ANTES de aceptar peticiones (a diferencia de
  // las migraciones de abajo, que son best-effort y pueden esperar) porque
  // Account.agencyId/Worker.agencyId ya usan "legacy-agency" como valor por
  // defecto desde el propio `prisma db push` - sin esta fila, cualquier
  // comprobación de agencia (ver el hook de arriba y agencyContext.ts)
  // fallaría para todo el mundo hasta que se creara sola más tarde.
  await ensureLegacyAgency();

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });

  await ensureDefaultPaymentRules().catch((err) => console.error("[payment-detector] no se pudieron crear las reglas de fábrica:", err));
  await fixLooseIbanRulePattern().catch((err) => console.error("[payment-detector] no se pudo actualizar la regla \"IBAN genérico\":", err));
  await migrateTeamLeadsToExplicitPermissions();
  // Si ya había un WhatsApp vinculado antes de este despliegue, se reconecta
  // solo (la sesión vive en la BD, ver whatsapp/waAuthState.ts) - nadie
  // tiene que volver a escanear el QR tras un "railway up".
  resumeWhatsAppIfLinked().catch((err) => console.error("[whatsapp] error reanudando sesión:", err));

  // DESACTIVADO: conectar+pedir diálogos de todas las cuentas al arrancar
  // (aunque fuera una detrás de otra, no todas a la vez) parece haber sido
  // justo lo que dejó a las cuentas fallando con "No se pudieron leer los
  // mensajes de Telegram" después del despliegue - probablemente Telegram
  // las limitó por las conexiones/peticiones extra de cada arranque. Se dan
  // MUCHOS despliegues seguidos en este panel (cada "railway up" reinicia el
  // proceso), así que precalentar en cada uno multiplica el riesgo. Se
  // vuelve a la carga perezosa de siempre (solo al abrir Mensajes de esa
  // cuenta) hasta encontrar una forma más segura de precalentar.
  // warmUpDialogsCache().catch(() => {});

  // Reconexión escalonada de las cuentas tras arrancar (solo conectar, sin pedir
  // chats; empieza a los 90s y va de una en una). Ver connectionPool.ts.
  reconnectAllAccountsGently().catch(() => {});
  seedEmojiPacksOnce().catch(() => {});

  await startOrchestrator();

  await purgeOldLogs();
  setInterval(purgeOldLogs, 6 * 60 * 60 * 1000); // cada 6h

  // Pagos → Cuentas de cobro: trae los pagos nuevos de Stripe/PayPal solas,
  // sin que nadie tenga que darle a "Sincronizar ahora" - cada 15 min, y una
  // primera vez a los 30s de arrancar (no al instante, para no competir con
  // el resto de cosas que arrancan a la vez con el servidor).
  setTimeout(() => syncAllPaymentAccounts().catch(() => {}), 30_000);
  setInterval(() => syncAllPaymentAccounts().catch(() => {}), 15 * 60 * 1000);

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} recibido, cerrando conexiones de Telegram...`);
    await closeAllAccountClients();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
