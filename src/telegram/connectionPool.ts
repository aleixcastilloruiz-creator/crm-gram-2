import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { Account } from "@prisma/client";
import { decryptSecret } from "../utils/crypto";
import { apiId, apiHash } from "./client";
import { attachLiveEvents, detachLiveEvents } from "./liveEvents";
import { clearDialogsCache } from "./dialogsCache";
import { prisma } from "../utils/prisma";

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

async function isShadowModeEnabled(agencyId: string): Promise<boolean> {
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

async function createClient(account: Account): Promise<TelegramClient> {
  if (!apiId || !apiHash) {
    throw new Error("TELEGRAM_API_ID / TELEGRAM_API_HASH no configurados en el entorno");
  }
  const sessionString = decryptSecret(account.sessionString);
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  await client.connect();
  pool.set(account.id, client);
  poolAgencyByAccountId.set(account.id, account.agencyId);
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

/** Cierra y quita del pool la conexion de una cuenta concreta (ej. al desactivarla). */
export async function closeAccountClient(accountId: string): Promise<void> {
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
