"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedDialogs = getCachedDialogs;
exports.getCachedAllDialogs = getCachedAllDialogs;
exports.touchDialogFromLiveMessage = touchDialogFromLiveMessage;
exports.getCachedDialogTitle = getCachedDialogTitle;
exports.markDialogRead = markDialogRead;
exports.clearDialogsCache = clearDialogsCache;
exports.markDialogsStale = markDialogsStale;
const dialogs_1 = require("./dialogs");
const prisma_1 = require("../utils/prisma");
/**
 * Cache en memoria de la lista de conversaciones (Mensajes) por cuenta.
 *
 * Sin esto, cada vez que se abre "Mensajes" o llega un mensaje nuevo (evento
 * en tiempo real) habria que volver a pedirle a Telegram la lista entera de
 * dialogos, que es la parte lenta y la que hacia que el panel se quedase
 * "cargando" o que la lista pareciese desaparecer un instante. Ahora:
 *  - La primera vez que se pide, se carga de Telegram (unica espera real) -
 *    salvo que ya haya una copia en la base de datos (ver CachedDialog mas
 *    abajo), en cuyo caso se sirve esa al instante y Telegram se pide en
 *    segundo plano para refrescarla.
 *  - Los eventos en tiempo real (mensaje nuevo) actualizan la cache al
 *    instante, sin llamar a Telegram otra vez.
 *  - Cada pocos minutos se refresca entera en segundo plano (para detectar
 *    chats nuevos que aun no aparecian), sin bloquear ninguna peticion.
 *
 * Persistencia en base de datos (tabla CachedDialog): esta cache en memoria
 * se vacia entera con cada reinicio/despliegue del servidor, y justo despues
 * la primera carga de Mensajes de cada cuenta volvia a ser lenta porque no
 * quedaba nada que servir salvo esperar a Telegram. Para que esto no haga
 * falta ningun proceso ni comando aparte, la propia funcion refresh() de
 * aqui abajo -la que YA se ejecuta sola cada pocos minutos y en cada carga-
 * guarda tambien su resultado en la base de datos (best-effort, nunca hace
 * fallar la respuesta por esto), y getCachedDialogs sirve desde ahi cuando
 * la cache en memoria esta recien arrancada. Solo aplica a esta cache
 * "normal" de Mensajes, NO a la de SFS (ve TODOS los grupos/canales, es un
 * listado distinto para el mismo accountId - mezclarlas en la misma tabla
 * confundiria las dos vistas tras un reinicio).
 */
/** Guarda en la base de datos la foto actual de los dialogos de una cuenta
 * (solo la cache "normal" de Mensajes). Sustituye la copia anterior entera
 * -es mas simple y seguro que ir comparando fila a fila, y esta tabla solo
 * existe para servir de arranque rapido, no como fuente de verdad-. */
async function persistDialogsToDb(accountId, dialogs) {
    try {
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.cachedDialog.deleteMany({ where: { accountId } }),
            prisma_1.prisma.cachedDialog.createMany({
                data: dialogs.map((d) => ({
                    accountId,
                    chatId: d.chatId,
                    title: d.title,
                    isUser: d.isUser,
                    isGroup: d.isGroup,
                    kind: d.kind,
                    unreadCount: d.unreadCount,
                    lastMessage: d.lastMessage,
                    lastMessageDate: d.lastMessageDate ? new Date(d.lastMessageDate) : null,
                    lastMessageOut: d.lastMessageOut,
                    participantsCount: d.participantsCount,
                    username: d.username,
                })),
            }),
        ]);
    }
    catch {
        // Best-effort: si falla (BD ocupada, despliegue en marcha...) no pasa
        // nada grave - la cache en memoria sigue funcionando igual, y el
        // siguiente refresco que si tenga exito deja la tabla al dia.
    }
}
/** Lee la ultima foto guardada de una cuenta, para servirla al instante justo
 * despues de un reinicio del servidor (antes de que la cache en memoria
 * tenga nada). Devuelve [] si no hay nada guardado aun (cuenta nueva, o
 * primera vez que se activa esto). */
async function loadDialogsFromDb(accountId) {
    try {
        const rows = await prisma_1.prisma.cachedDialog.findMany({ where: { accountId } });
        // El orden "chat mas reciente primero" es el que espera el panel (ver
        // listDialogs, que ya devuelve los dialogos de Telegram en ese orden) -
        // aqui hay que ordenarlo a mano porque findMany no preserva el orden de
        // la cache original.
        rows.sort((a, b) => {
            const ta = a.lastMessageDate ? a.lastMessageDate.getTime() : 0;
            const tb = b.lastMessageDate ? b.lastMessageDate.getTime() : 0;
            return tb - ta;
        });
        return rows.map((r) => ({
            chatId: r.chatId,
            title: r.title,
            isUser: r.isUser,
            isGroup: r.isGroup,
            kind: r.kind,
            unreadCount: r.unreadCount,
            lastMessage: r.lastMessage,
            lastMessageDate: r.lastMessageDate ? r.lastMessageDate.toISOString() : null,
            lastMessageOut: r.lastMessageOut,
            participantsCount: r.participantsCount,
            username: r.username,
        }));
    }
    catch {
        return []; // sin copia usable: getCachedDialogs cae al camino de siempre (esperar a Telegram)
    }
}
/** Actualiza en la base de datos SOLO la fila de un chat concreto, cuando
 * llega un mensaje en vivo (ver touchDialogFromLiveMessage) - evita esperar
 * al refresco periodico completo (hasta 3 min) para que la copia guardada
 * refleje la conversacion que se acaba de mover arriba. Si esa fila aun no
 * existe (chat nuevo que no ha pasado por ningun refresco completo todavia),
 * no se crea aqui - el proximo refresco completo la añadira igual. */
async function persistDialogTouchToDb(accountId, chatId, message) {
    try {
        await prisma_1.prisma.cachedDialog.updateMany({
            where: { accountId, chatId },
            data: {
                lastMessage: message.text,
                lastMessageDate: message.date ? new Date(message.date) : null,
                lastMessageOut: message.out,
                ...(message.out ? {} : { unreadCount: { increment: 1 } }),
            },
        });
    }
    catch {
        // best-effort, ver comentario en persistDialogsToDb
    }
}
const cache = new Map();
// Cuentas para las que la PROXIMA carga debe saltarse el atajo de la base de
// datos (ver getCachedDialogs) aunque la cache en memoria este vacia -lo usa
// clearDialogsCache: cuando se borra la cache a proposito es porque algo
// relevante cambio (que carpetas se ven en Mensajes, etc.) y la copia
// guardada en la BD todavia refleja el filtro VIEJO, asi que servirla tal
// cual seria mostrar exactamente lo que clearDialogsCache queria evitar.
const bypassDbOnNextLoad = new Set();
// Cache aparte para SFS (ve TODOS los grupos/canales, no solo los chats de
// fans de "Mensajes"): si compartiese la cache de arriba, cada carga de una
// pisaria la lista filtrada de la otra (mismo accountId, resultados
// distintos), asi que van en su propio mapa.
const allDialogsCache = new Map();
const REFRESH_INTERVAL_MS = 3 * 60 * 1000; // refresco de fondo cada 3 min
const FETCH_LIMIT = 600; // suficiente para incluir historial antiguo + reciente
// Un listDialogs() que devuelve muy pocos chats (p.ej. 8) para una cuenta
// que sabemos que tiene fans hablando casi siempre NO es que la cuenta
// tenga de verdad tan pocos chats: es el mismo patrón que ya vimos con
// "(no se pudo resolver)" en telegramFolders.ts -Telegram, justo despues de
// reconectar (tras un despliegue, un reinicio del pool de conexiones, etc.),
// a veces contesta a la PRIMERA getDialogs con una lista todavia sin
// terminar de sincronizar, y una segunda llamada ya con la conexion
// "caliente" trae la lista completa. Con esto no hace falta que el usuario
// note el hueco y le de a "Recargar chats" a mano: se reintenta solo.
const LOW_COUNT_RETRY_THRESHOLD = 15;
function refresh(client, accountId, entry, includeAllGroups = false) {
    // Burbuja de "no leído" que no se quitaba: Telegram NUNCA se entera de que
    // un chat se ha leído desde aquí (ver "modo shadow" en connectionPool.ts -
    // a propósito, para que el fan no vea "visto"), así que su propio
    // unreadCount para ese chat no baja jamás. markDialogRead (más abajo) lo
    // ponía a 0 en la cache/BD, pero este refresco (cada 3 min, o al forzar
    // "Recargar chats", o al detectar un chat nuevo) volvía a pedirle la lista
    // entera a Telegram y SOBREESCRIBÍA ese 0 con el número crudo de Telegram
    // de nuevo - la burbuja "revivía" sola sin que el trabajador hiciera nada
    // raro. Antes de pisar entry.dialogs, nos guardamos el unreadCount que ya
    // llevábamos nosotros (mantenido al día en touchEntry con cada mensaje en
    // vivo, y puesto a 0 en markDialogRead) y lo restauramos por chat después
    // - solo se acepta el número crudo de Telegram para un chat que no
    // teníamos todavía en la cache (de verdad nuevo para nosotros, no hay otro
    // dato mejor). Si en el hueco entre dos refrescos llegó un mensaje nuevo
    // que no se vio en vivo (servidor caído, evento perdido...), se detecta
    // porque cambia lastMessageDate del propio chat y se suma 1 en vez de
    // dejar el contador vencido en 0 - no es exacto si llegó más de un
    // mensaje en ese hueco, pero es muchísimo mejor que o bien quedarse en 0
    // (como si nada hubiera llegado) o bien que vuelva el número de Telegram,
    // que nunca refleja lo ya leído aquí.
    const previousByChatId = new Map(entry.dialogs.map((d) => [d.chatId, d]));
    const promise = (async () => {
        let dialogs = await (0, dialogs_1.listDialogs)(client, accountId, FETCH_LIMIT, entry.extraChatIds, includeAllGroups);
        if (dialogs.length < LOW_COUNT_RETRY_THRESHOLD) {
            try {
                const retryDialogs = await (0, dialogs_1.listDialogs)(client, accountId, FETCH_LIMIT, entry.extraChatIds, includeAllGroups);
                if (retryDialogs.length > dialogs.length)
                    dialogs = retryDialogs;
            }
            catch {
                // si el reintento falla, nos quedamos con lo que ya teniamos de la primera pasada
            }
        }
        for (const d of dialogs) {
            const prev = previousByChatId.get(d.chatId);
            if (!prev)
                continue; // chat nuevo para nosotros: no hay mejor dato que el crudo de Telegram
            const missedIncoming = !d.lastMessageOut && d.lastMessageDate && d.lastMessageDate !== prev.lastMessageDate;
            d.unreadCount = missedIncoming ? prev.unreadCount + 1 : prev.unreadCount;
        }
        entry.dialogs = dialogs;
        entry.loadedAt = Date.now();
        entry.loading = null;
        // Solo la cache "normal" de Mensajes se guarda en la base de datos (ver
        // comentario grande de mas arriba) - la de SFS (includeAllGroups=true)
        // no, para no mezclar dos listados distintos del mismo accountId. No se
        // espera a que termine (fire-and-forget): guardar esto no debe retrasar
        // la respuesta a quien esta esperando este refresco.
        if (!includeAllGroups)
            persistDialogsToDb(accountId, dialogs).catch(() => { });
        return dialogs;
    })().catch((err) => {
        entry.loading = null;
        throw err;
    });
    entry.loading = promise;
    return promise;
}
/** Devuelve la lista de conversaciones lo mas rapido posible (cache si existe).
 * extraChatIds: chats de grupo/canal (carpetas marcadas en Configuración) que
 * deben incluirse ademas de los chats privados normales. */
async function getCachedDialogs(client, accountId, extraChatIds, forceRefresh = false) {
    let entry = cache.get(accountId);
    if (!entry) {
        entry = { dialogs: [], loadedAt: 0, loading: null, extraChatIds };
        cache.set(accountId, entry);
    }
    else {
        entry.extraChatIds = extraChatIds;
    }
    if (entry.dialogs.length === 0 && !entry.loading) {
        // Cache en memoria recien arrancada (primera peticion tras un
        // reinicio/despliegue, o la primera vez de verdad para esta cuenta). Si
        // hay una copia guardada de antes (ver CachedDialog), se sirve YA -sin
        // esperar nada- y Telegram se pide en segundo plano para refrescarla;
        // si no hay nada guardado (cuenta nueva de verdad) no queda otra que
        // esperar a Telegram, igual que antes de tener esta tabla. forceRefresh
        // (boton "Recargar chats" pulsado a mano) se salta este atajo a
        // proposito: si el usuario pide explicitamente lo fresco, no tiene
        // sentido servirle primero una copia que puede estar desactualizada.
        // .delete() de un Set devuelve true si el valor estaba (y lo quita de
        // paso): asi el salto solo aplica UNA vez, a la primera carga tras el
        // clearDialogsCache que lo pidio, no a todas las siguientes.
        if (!forceRefresh && !bypassDbOnNextLoad.delete(accountId)) {
            entry.dialogs = await loadDialogsFromDb(accountId);
        }
        if (entry.dialogs.length > 0) {
            entry.loadedAt = 0; // se trata como "vieja" a proposito, para que dispare el refresco de fondo
            refresh(client, accountId, entry).catch(() => { });
        }
        else {
            await refresh(client, accountId, entry);
        }
    }
    else if (entry.loading) {
        // Ya hay un refresco en marcha (p.ej. lanzado por otra peticion): lo aprovechamos.
        await entry.loading;
    }
    else if (forceRefresh) {
        // Boton "Recargar chats" pulsado a mano: el usuario quiere de verdad la
        // lista fresca de Telegram ahora mismo, no lo que hubiera en cache -
        // aqui si merece la pena esperar, es una accion explicita y puntual.
        await refresh(client, accountId, entry);
    }
    else if (entry.forceFreshOnNextGet) {
        // Una conversacion nueva llego por el puente en vivo: esta vez SI se
        // espera al refresco de verdad (ver comentario en forceFreshOnNextGet),
        // para que la siguiente carga de Mensajes la incluya ya.
        entry.forceFreshOnNextGet = false;
        await refresh(client, accountId, entry);
    }
    else if (Date.now() - entry.loadedAt > REFRESH_INTERVAL_MS) {
        // Cache "vieja": se refresca en segundo plano, pero devolvemos ya lo que tenemos.
        refresh(client, accountId, entry).catch(() => { });
    }
    return cache.get(accountId).dialogs;
}
/** Igual que getCachedDialogs, pero para "SFS": incluye TODOS los grupos y
 * canales de la cuenta (no solo los chats de fans + grupos pequeños/
 * registrados de "Mensajes"), porque ahí es donde viven los SFS de verdad.
 * Cache totalmente aparte (ver allDialogsCache) para no mezclarse con la de
 * "Mensajes". */
async function getCachedAllDialogs(client, accountId, forceRefresh = false) {
    let entry = allDialogsCache.get(accountId);
    if (!entry) {
        entry = { dialogs: [], loadedAt: 0, loading: null };
        allDialogsCache.set(accountId, entry);
    }
    if (entry.dialogs.length === 0 && !entry.loading) {
        await refresh(client, accountId, entry, true);
    }
    else if (entry.loading) {
        await entry.loading;
    }
    else if (forceRefresh) {
        await refresh(client, accountId, entry, true);
    }
    else if (entry.forceFreshOnNextGet) {
        entry.forceFreshOnNextGet = false;
        await refresh(client, accountId, entry, true);
    }
    else if (Date.now() - entry.loadedAt > REFRESH_INTERVAL_MS) {
        refresh(client, accountId, entry, true).catch(() => { });
    }
    return allDialogsCache.get(accountId).dialogs;
}
function touchEntry(entry, chatId, message) {
    if (!entry || entry.dialogs.length === 0)
        return; // aun no hay cache: se llenara con la carga inicial
    const idx = entry.dialogs.findIndex((d) => d.chatId === chatId);
    if (idx === -1) {
        // Chat que no estaba en la lista (conversacion nueva): la marcamos para
        // que la PROXIMA carga espere de verdad al refresco (ver
        // forceFreshOnNextGet) en vez de devolver la lista vieja sin esta
        // conversacion - si no, se queda sin aparecer hasta el refresco
        // periodico de varios minutos, y el fan escribiendo parece "perdido".
        if (!entry.loading)
            entry.forceFreshOnNextGet = true;
        return;
    }
    const d = entry.dialogs[idx];
    d.lastMessage = message.text;
    d.lastMessageDate = message.date;
    d.lastMessageOut = message.out;
    if (!message.out)
        d.unreadCount = (d.unreadCount || 0) + 1;
    entry.dialogs.splice(idx, 1);
    entry.dialogs.unshift(d);
}
/** Actualiza (o mueve arriba) una conversacion existente al recibir un mensaje en vivo,
 * tanto en la cache de "Mensajes" como en la de "SFS" (ver getCachedAllDialogs) -
 * un mensaje en vivo puede pertenecer a un chat que solo una de las dos liste. */
function touchDialogFromLiveMessage(accountId, chatId, message) {
    touchEntry(cache.get(accountId), chatId, message);
    touchEntry(allDialogsCache.get(accountId), chatId, message);
    // Solo la copia en base de datos de la cache "normal" de Mensajes (no la
    // de SFS, ver comentario grande al principio del archivo). Se actualiza
    // SOLO esta fila (no toda la lista) para que sea barato hacerlo en cada
    // mensaje en vivo, sin esperar al proximo refresco periodico completo -
    // fire-and-forget, un mensaje no debe esperar a que esto termine.
    persistDialogTouchToDb(accountId, chatId, message).catch(() => { });
}
/** Título ya en caché de un chat (sin llamar a Telegram) - lo usa el
 * Detector de pagos para no tener que pedir el chat entero solo para poner
 * un nombre en el historial. Puede devolver undefined si esa cuenta aún no
 * tiene la lista de diálogos cargada, o si es un chat nuevo que todavía no
 * apareció en ella. */
function getCachedDialogTitle(accountId, chatId) {
    const entry = cache.get(accountId);
    if (!entry)
        return undefined;
    return entry.dialogs.find((d) => d.chatId === chatId)?.title;
}
function markDialogRead(accountId, chatId) {
    const entry = cache.get(accountId);
    if (!entry)
        return;
    const d = entry.dialogs.find((x) => x.chatId === chatId);
    if (d)
        d.unreadCount = 0;
    // Best-effort, fire-and-forget: sin esto, un reinicio justo despues de leer
    // un chat podia volver a mostrarlo como "sin leer" un instante (la copia
    // guardada aun tendria el contador viejo) hasta el siguiente refresco.
    prisma_1.prisma.cachedDialog.updateMany({ where: { accountId, chatId }, data: { unreadCount: 0 } }).catch(() => { });
}
function clearDialogsCache(accountId) {
    cache.delete(accountId);
    bypassDbOnNextLoad.add(accountId);
}
/** Marca la cache de una cuenta como "vieja" sin BORRARLA, para forzar un
 * refresco pero sin bloquear la siguiente peticion: getCachedDialogs sigue
 * teniendo dialogos que devolver de inmediato (los de antes) mientras pide
 * la lista nueva en segundo plano. clearDialogsCache, en cambio, deja la
 * cache vacia del todo - la siguiente peticion no tiene nada que devolver y
 * tiene que esperar a la carga completa de Telegram (lenta en cuentas con
 * muchos chats). Se usa para las autolimpiezas silenciosas (un grupo
 * restringido corrupto detectado y borrado) donde no hace falta que se note
 * al instante - solo clearDialogsCache real cuando el usuario acaba de crear
 * algo y necesita verlo YA en la lista. */
function markDialogsStale(accountId) {
    const entry = cache.get(accountId);
    if (!entry)
        return; // nada cargado todavia: no hay nada que marcar
    entry.loadedAt = 0;
}
//# sourceMappingURL=dialogsCache.js.map