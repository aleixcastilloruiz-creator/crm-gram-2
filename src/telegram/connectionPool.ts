import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { Account } from "@prisma/client";
import { decryptSecret } from "../utils/crypto";
import { apiId, apiHash } from "./client";
import { attachLiveEvents, detachLiveEvents } from "./liveEvents";
import { clearDialogsCache } from "./dialogsCache";
import { prisma } from "../utils/prisma";

// Sin esto, un client.connect() que se queda colgado (red rara, un
// handshake MTProto que nunca termina de resolver) dejaba SIN NINGÚN
// LÍMITE DE TIEMPO la promesa que devuelve getAccountClient() - y casi
// NINGÚN sitio que la llama (44 sitios en toda la API, ver mensajes.ts) la
// envuelve en su propio withTimeout, así que esa petición se quedaba
// "Cargando..." para siempre, sin error, y sin que invalidateAccountClient
// ni el barrido de zombies pudieran hacer nada (un cliente a medio
// conectar nunca llega a marcarse `connected`, así que el barrido -que solo
// vigila conexiones YA abiertas- ni lo ve). Esto se vio reportado como que
// a algunas creadoras concretas "no le cargan los chats nunca", incluso
// después de reconectar la cuenta desde cero. Con esto, connect() SIEMPRE
// se resuelve o falla en un tiempo acotado, así que cualquier petición que
// dependa de getAccountClient() también lo hace.
function withConnectTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT: la conexión con Telegram tardó demasiado")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}
const CONNECT_TIMEOUT_MS = 40_000;

/**
 * Pool de conexiones Telegram: UNA conexion MTProto persistente por
 * cuenta, reutilizada por todas sus campañas (en vez de abrir/cerrar una
 * conexion nueva en cada ciclo de cada campaña). Con varias cuentas y
 * varias campañas por cuenta, reconectar constantemente es innecesario y
 * acerca mas de lo debido a los limites de conexion de Telegram.
 */
const pool = new Map<string, TelegramClient>();

// accountId -> agencyId de la cuenta conectada en `pool`, para poder saber a
// que agencia pertenece cada conexion sin volver a tocar la base de datos
// (multi-agencia: el modo shadow es por agencia, ver mas abajo).
const poolAgencyByAccountId = new Map<string, string>();

// Candado de conexión por cuenta: SIN esto, si dos peticiones piden la
// conexión de la misma cuenta casi a la vez (p.ej. Mensajes + Mensajes Pro
// abriéndose juntos, o dos pestañas), y ninguna de las dos encuentra aún
// nada en `pool` (la primera todavía no ha terminado `connect()`), cada una
// crea su PROPIO TelegramClient con la MISMA sesión y llama a connect() por
// su cuenta. Dos conexiones MTProto simultáneas con la misma sesión es
// justo lo que Telegram responde con "AUTH_KEY_DUPLICATED" - y una vez pasa
// eso, la cuenta se queda en un bucle de "Not connected" / reconexión que
// no se arregla solo (visto en los logs de Railway). Con este mapa, la
// SEGUNDA petición que llega mientras la primera ya está conectando espera
// a esa misma conexión en marcha en vez de abrir una nueva.
const connecting = new Map<string, Promise<TelegramClient>>();

/**
 * "Modo shadow": este panel NUNCA manda confirmación de lectura a Telegram
 * (no hay ninguna llamada a messages.readHistory / channels.readHistory en
 * todo el proyecto - abrir un chat aquí solo actualiza el contador local,
 * ver dialogsCache.markDialogRead), así que la parte de "no dejar visto" ya
 * pasa siempre, con o sin modo shadow. Lo que SÍ cambia por defecto es la
 * presencia: Telegram marca la cuenta como "en línea" / "en línea hace X" en
 * cuanto el cliente MTProto está conectado y activo. Modo shadow fuerza el
 * estado a "desconectado" (offline) con account.updateStatus, para que el
 * fan no vea "en línea ahora" mientras se lee o responde desde el CRM.
 *
 * Se guarda en caché en memoria (con la misma AgencySettings ya usada por el
 * resto de Configuración) para no tener que consultar la base de datos en
 * cada conexión/reconexión de cada cuenta. Con multi-agencia esto es POR
 * AGENCIA: cada agencia tiene su propia fila de AgencySettings y su propio
 * modo shadow, así que la caché es un mapa agencyId -> estado en vez de un
 * único booleano global.
 */
const shadowModeCache = new Map<string, { enabled: boolean; at: number }>();
const SHADOW_MODE_CACHE_MS = 30 * 1000;

export async function isShadowModeEnabled(agencyId: string): Promise<boolean> {
  const cached = shadowModeCache.get(agencyId);
  if (cached && Date.now() - cached.at < SHADOW_MODE_CACHE_MS) {
    return cached.enabled;
  }
  const settings = await prisma.agencySettings.findUnique({ where: { agencyId } });
  const enabled = !!settings?.shadowModeEnabled;
  shadowModeCache.set(agencyId, { enabled, at: Date.now() });
  return enabled;
}

async function applyShadowStatus(client: TelegramClient, agencyId: string): Promise<void> {
  try {
    if (await isShadowModeEnabled(agencyId)) {
      await client.invoke(new Api.account.UpdateStatus({ offline: true }));
    }
  } catch {
    // best-effort: si Telegram rechaza esta llamada puntual, no debe tumbar
    // la conexión ni la petición que estuviera en marcha.
  }
}

/**
 * Llamado desde el endpoint de Configuración al activar/desactivar el modo
 * shadow, para que el cambio se note YA en todas las cuentas ya conectadas de
 * ESA agencia en vez de esperar a que cada una se reconecte sola. Al
 * desactivarlo se manda offline:false para que la cuenta vuelva a
 * comportarse como una cuenta normal (en línea mientras está activa).
 */
export async function setShadowModeEnabled(agencyId: string, enabled: boolean): Promise<void> {
  shadowModeCache.set(agencyId, { enabled, at: Date.now() });
  await Promise.all(
    [...pool.entries()]
      .filter(([accountId]) => poolAgencyByAccountId.get(accountId) === agencyId)
      .map(([, client]) => client.invoke(new Api.account.UpdateStatus({ offline: enabled })).catch(() => {}))
  );
}

// Reafirma el estado offline cada pocos minutos mientras el modo shadow esté
// activo: Telegram puede volver a marcar la cuenta "en línea" si el cliente
// hace cualquier petición sin haber reafirmado el estado recientemente, así
// que no basta con mandarlo una sola vez al conectar.
setInterval(() => {
  for (const [accountId, client] of pool.entries()) {
    if (!client.connected) continue;
    const agencyId = poolAgencyByAccountId.get(accountId);
    if (!agencyId) continue;
    isShadowModeEnabled(agencyId).then((enabled) => {
      if (!enabled) return;
      client.invoke(new Api.account.UpdateStatus({ offline: true })).catch(() => {});
    }).catch(() => {});
  }
}, 3 * 60 * 1000);

// Cuentas que HAN estado conectadas en este proceso y que nadie ha cerrado a
// propósito (closeAccountClient las quita). El vigilante de abajo las
// reconecta solo si se caen (zombi descartada por el barrido, corte de red...)
// en vez de esperar a que un chatter abra esa cuenta y se coma la espera.
const wantConnected = new Set<string>();
// Reintentos con espera creciente por cuenta, para no martillear a Telegram.
const reconnectState = new Map<string, { fails: number; nextAt: number }>();

async function createClient(account: Account): Promise<TelegramClient> {
  if (!apiId || !apiHash) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
  }
  const sessionString = decryptSecret(account.sessionString);
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  try {
    await withConnectTimeout(client.connect(), CONNECT_TIMEOUT_MS);
  } catch (err) {
    // No se deja a medio conectar en ningún sitio: ni se añadió todavía al
    // pool (eso pasa justo debajo, solo si connect() tuvo éxito), así que
    // solo hace falta intentar cerrar lo que GramJS haya llegado a abrir.
    client.disconnect().catch(() => {});
    throw err;
  }
  pool.set(account.id, client);
  poolAgencyByAccountId.set(account.id, account.agencyId);
  wantConnected.add(account.id);
  reconnectState.delete(account.id);
  // Enchufa el listener de mensajes en tiempo real (Mensajes -> tiempo real).
  attachLiveEvents(account.id, client);
  await applyShadowStatus(client, account.agencyId);
  return client;
}

export function getAccountClient(account: Account): Promise<TelegramClient> {
  const existing = pool.get(account.id);
  if (existing && existing.connected) {
    attachLiveEvents(account.id, existing);
    return Promise.resolve(existing);
  }

  // Ya hay una conexión en marcha para esta cuenta (lanzada por otra
  // petición hace un instante): nos enganchamos a ELLA en vez de abrir otra.
  const inFlight = connecting.get(account.id);
  if (inFlight) return inFlight;

  // IMPORTANTE: el candado (`connecting.set`) se registra AQUI, de forma
  // sincrona, antes de cualquier `await` - incluido el disconnect() de abajo
  // para limpiar un cliente muerto. Antes ese disconnect() iba primero y el
  // `connecting.set` quedaba despues de un punto de espera: si dos
  // peticiones llegaban casi a la vez para una cuenta con conexion "zombi"
  // (existe en el pool pero no conectada), las DOS pasaban el chequeo de
  // `inFlight` (ninguna veia aun el candado, porque la primera todavia no
  // habia llegado a ponerlo) y cada una acababa creando su PROPIO
  // TelegramClient con la MISMA sesion - justo el "AUTH_KEY_DUPLICATED" que
  // este candado existe para evitar (ver comentario de `connecting` arriba).
  // Como JS es de un solo hilo, envolviendo TODO (incluido el disconnect)
  // en la promesa que se registra ya, no hay ningun hueco entre "miro si hay
  // candado" y "pongo el candado" en el que otra peticion pueda colarse.
  const promise = (async () => {
    if (existing) {
      // Conexion muerta: la limpiamos antes de crear una nueva
      try {
        await existing.disconnect();
      } catch {
        // ignoramos: ya estaba rota
      }
      pool.delete(account.id);
      detachLiveEvents(account.id);
    }
    return createClient(account);
  })().finally(() => {
    connecting.delete(account.id);
  });
  connecting.set(account.id, promise);
  return promise;
}

/**
 * Descarta del pool la conexión de una cuenta SIN esperar a que se cierre
 * bien (a diferencia de closeAccountClient). Existe para el caso de una
 * conexión "zombi": GramJS a veces sigue marcando `client.connected` como
 * true aunque la conexión de verdad ya no responda (tras un corte de red,
 * un reinicio de contenedor en Railway, o quedarse colgada en medio de un
 * FLOOD_WAIT) - en ese caso getAccountClient() seguía devolviendo SIEMPRE
 * el mismo cliente roto, así que cada petición fallaba (por el timeout, ver
 * withTimeout en dialogs/mensajes) una y otra vez sin arreglarse sola, hasta
 * el siguiente "railway up". Esto es lo que se veía como "se cierra la
 * cuenta de la modelo" / "los chats dejan de cargar" de forma persistente.
 *
 * Se llama desde el catch de los endpoints que más se notan (lista de
 * chats, abrir conversación) cuando el error viene de un timeout: así la
 * SIGUIENTE petición ya crea una conexión nueva en vez de reintentar contra
 * la misma rota.
 */
/**
 * Estado de conexión REAL (lo que de verdad sabe este proceso ahora mismo,
 * no un campo cacheado en la base de datos) para pintar en el frontend si
 * una cuenta está conectada a Telegram o no. Antes el listado de cuentas
 * solo miraba `account.health` (OK/PEER_FLOOD_PAUSED/DISABLED), un campo
 * que SOLO cambia en el login inicial y en el ciclo de peerFlood - si la
 * sesión se invalidaba por otra vía (revocada desde el móvil, zombi
 * detectada por el barrido de abajo, AUTH_KEY_*) la cuenta seguía
 * devolviendo "health: OK" para siempre, así que en el panel se veía
 * "conectada" aunque llevara horas sin poder hablar con Telegram de
 * verdad. "unknown" es a propósito un tercer estado (ni verde ni rojo):
 * una cuenta que esta agencia aún no ha usado en este arranque del
 * servidor no tiene por qué estar mal, solo no se ha comprobado todavía -
 * tratarla como "desconectada" sería tan engañoso como el bug que esto
 * arregla.
 */
export function getAccountConnectionStatus(accountId: string): "connected" | "disconnected" | "unknown" {
  const client = pool.get(accountId);
  if (!client) return "unknown";
  return client.connected ? "connected" : "disconnected";
}

export function invalidateAccountClient(accountId: string): void {
  const client = pool.get(accountId);
  if (!client) return;
  pool.delete(accountId);
  detachLiveEvents(accountId);
  // No se espera (fire-and-forget) ni se usa el `try/await` normal: si la
  // conexión está de verdad colgada, `disconnect()` podría no resolver
  // nunca, y aquí lo que importa es soltar la entrada del pool YA para que
  // la próxima petición no la reutilice.
  client.disconnect().catch(() => {});
}

/**
 * Barrido periódico de conexiones "zombi" (ver comentario grande de
 * invalidateAccountClient, justo arriba): hasta ahora, una conexión rota
 * SOLO se detectaba cuando una petición de un chatter chocaba con ella de
 * verdad y esperaba el timeout entero (hasta 2 minutos) antes de
 * descartarla - así es como "Lara"/"Alexia" se quedaban sin cargar NADA de
 * forma persistente (ni chats ni fotos) aunque se reconectara la cuenta
 * entera desde cero: la sesión nueva se guardaba bien, pero la conexión
 * VIEJA zombi seguía en el pool (invalidateAccountClient solo se llama
 * desde el catch de los endpoints, nunca sola) y cada petición volvía a
 * chocar con ella. En los logs de Railway esto se vio como un aluvión de
 * "Error: TIMEOUT" desde dentro de la propia librería de Telegram
 * (client/updates.js) sin parar, cada pocos segundos: la conexión
 * intentaba sola reconectar/sincronizar una y otra vez y nunca lo lograba,
 * pero como eso no pasa por ningún endpoint nuestro, invalidateAccountClient
 * nunca llegaba a llamarse para ella.
 *
 * Este barrido hace, cada par de minutos, una llamada barata y de solo
 * lectura (updates.GetState - lo mismo que usa cualquier cliente de
 * Telegram para "comprobar que sigues ahí") a cada conexión que YA está
 * abierta en el pool; si no contesta a tiempo, se da por zombi y se
 * descarta aquí mismo. Así la PRÓXIMA petición de cualquier chatter ya se
 * encuentra una conexión nueva en vez de ser quien "descubre" la rota y
 * paga la espera. No abre conexiones nuevas, no manda nada, no toca el
 * arranque/reconexión de cuentas (eso sigue con su propio ritmo pausado a
 * propósito, ver warmUpDialogsCache en index.ts) - solo vigila lo que ya
 * estaba conectado.
 */
const ZOMBIE_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const ZOMBIE_PING_TIMEOUT_MS = 15_000;

function withZombiePingTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ZOMBIE_PING_TIMEOUT")), ZOMBIE_PING_TIMEOUT_MS);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function sweepZombieConnections(): Promise<void> {
  // En paralelo, no una cuenta detras de otra: con el timeout de 15s por
  // cuenta, bastaban 2-3 conexiones zombi para que el barrido entero
  // tardase 30-45s en lugar de como mucho 15s, dejando esas cuentas
  // "colgadas" (sin descartarse para reconectar) mas tiempo del necesario.
  await Promise.all(
    [...pool.entries()].map(async ([accountId, client]) => {
      if (!client.connected) return; // esto ya se nota solo (p.ej. autoReconnect en marcha), no hace falta tocarlo aqui
      try {
        await withZombiePingTimeout(client.invoke(new Api.updates.GetState()));
      } catch {
        // No contesto a tiempo (o devolvio un error de conexion real): zombi
        // confirmada, se descarta para que la siguiente peticion cree una
        // conexion nueva en vez de chocar otra vez con esta.
        invalidateAccountClient(accountId);
      }
    })
  );
}

setInterval(() => {
  sweepZombieConnections().catch(() => {
    // best-effort: un fallo barriendo no debe tumbar nada, se reintenta solo en el proximo ciclo
  });
}, ZOMBIE_SWEEP_INTERVAL_MS);

/** Cierra y quita del pool la conexion de una cuenta concreta (ej. al desactivarla). */
export async function closeAccountClient(accountId: string): Promise<void> {
  wantConnected.delete(accountId);
  reconnectState.delete(accountId);
  detachLiveEvents(accountId);
  clearDialogsCache(accountId);
  const client = pool.get(accountId);
  if (!client) return;
  pool.delete(accountId);
  try {
    await client.disconnect();
  } catch {
    // best-effort
  }
}

/** Cierra todas las conexiones abiertas. Se llama al apagar el proceso (SIGTERM/SIGINT). */
export async function closeAllAccountClients(): Promise<void> {
  const ids = [...pool.keys()];
  await Promise.all(ids.map((id) => closeAccountClient(id)));
}


// ---------------------------------------------------------------------------
// Reconexión automática de cuentas
// ---------------------------------------------------------------------------
// Antes, una cuenta que se caía (conexión zombi descartada por el barrido,
// corte de red, despliegue) se quedaba "fuera del CRM" hasta que alguien abría
// sus chats: mientras tanto no llegaban sus mensajes en tiempo real ni el
// detector de pagos. Ahora un vigilante la reconecta solo, una a una, con
// espera creciente si falla, y sin tocar las que Telegram ha dejado sin
// sesión (esas hay que volver a iniciarlas a mano con "Reconectar cuenta").
// OJO: solo CONECTA - no pide chats ni diálogos (eso fue justo lo que, en
// cada arranque, parecía limitar cuentas, ver comentario en index.ts).

const DEAD_SESSION_RE = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_INVALID/;
const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;
const RECONNECT_GAP_MS = 8_000; // respiro entre cuenta y cuenta
const RECONNECT_BACKOFF_BASE_MS = 30_000;
const RECONNECT_BACKOFF_MAX_MS = 15 * 60 * 1000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let watchdogRunning = false;

async function reconnectOne(accountId: string): Promise<void> {
  const state = reconnectState.get(accountId) ?? { fails: 0, nextAt: 0 };
  try {
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account || account.health === "DISABLED") {
      wantConnected.delete(accountId);
      reconnectState.delete(accountId);
      return;
    }
    await getAccountClient(account);
    reconnectState.delete(accountId);
    console.log(`[reconnect] "${account.label}" reconectada.`);
  } catch (err: any) {
    const msg = String(err?.errorMessage || err?.message || err);
    if (DEAD_SESSION_RE.test(msg)) {
      // Sesión muerta de verdad: reintentar no sirve, hay que re-loguear.
      wantConnected.delete(accountId);
      reconnectState.delete(accountId);
      console.error(`[reconnect] ${accountId}: sesión inválida (${msg}), hay que usar "Reconectar cuenta".`);
      return;
    }
    const fails = state.fails + 1;
    const wait = Math.min(RECONNECT_BACKOFF_MAX_MS, RECONNECT_BACKOFF_BASE_MS * 2 ** (fails - 1));
    reconnectState.set(accountId, { fails, nextAt: Date.now() + wait });
    console.error(`[reconnect] ${accountId}: fallo ${fails} (${msg}); reintento en ${Math.round(wait / 1000)}s.`);
  }
}

async function reconnectDroppedAccounts(): Promise<void> {
  if (watchdogRunning) return;
  watchdogRunning = true;
  try {
    for (const accountId of [...wantConnected]) {
      const existing = pool.get(accountId);
      if (existing && existing.connected) continue;
      if (connecting.has(accountId)) continue;
      const st = reconnectState.get(accountId);
      if (st && Date.now() < st.nextAt) continue;
      await reconnectOne(accountId);
      await sleepMs(RECONNECT_GAP_MS);
    }
  } finally {
    watchdogRunning = false;
  }
}

if (process.env.LUXE_AUTO_RECONNECT !== "0") {
  setInterval(() => {
    reconnectDroppedAccounts().catch(() => {});
  }, WATCHDOG_INTERVAL_MS);
}

/**
 * Tras cada arranque del servidor (railway up), reconecta las cuentas una a
 * una y despacio, SOLO conectando. Se espera un rato antes de empezar para que
 * el contenedor anterior ya esté apagado del todo: dos procesos con la misma
 * sesión a la vez es lo que provoca AUTH_KEY_DUPLICATED y tira la cuenta.
 * Se puede desactivar poniendo LUXE_AUTO_RECONNECT=0 en las variables de Railway.
 */
export async function reconnectAllAccountsGently(initialDelayMs = 90_000): Promise<void> {
  if (process.env.LUXE_AUTO_RECONNECT === "0") return;
  await sleepMs(initialDelayMs);
  try {
    const accounts = await prisma.account.findMany({
      where: { health: { not: "DISABLED" } },
      select: { id: true, label: true, sessionString: true },
      orderBy: { label: "asc" },
    });
    for (const a of accounts) {
      if (!a.sessionString) continue;
      const existing = pool.get(a.id);
      if (existing && existing.connected) continue;
      await reconnectOne(a.id);
      if (reconnectState.has(a.id)) wantConnected.add(a.id); // falló por red: que el vigilante siga intentándolo
      await sleepMs(RECONNECT_GAP_MS);
    }
    console.log(`[reconnect] arranque: revisadas ${accounts.length} cuenta(s).`);
  } catch (err) {
    console.error("[reconnect] fallo en la reconexión de arranque:", err);
  }
}
