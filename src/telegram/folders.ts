import { TelegramClient, Api } from "telegram";

// Sin esto, un GetDialogFilters que se queda colgado (conexión zombi, ver
// connectionPool.ts) dejaba SIN NINGÚN LÍMITE DE TIEMPO toda carga de
// Mensajes/Mensajes Pro que pasara por aquí (resolveMessageFolderChatIds y
// getChatFoldersMap en messages.ts se llaman en CADA GET /dialogs, para
// TODAS las cuentas, antes incluso de llegar al withTimeout de 2 min que ya
// protege la lista de chats en sí) - el panel se quedaba "Cargando..." para
// siempre, sin ningún error, aunque se reconectara la cuenta entera desde
// cero (la conexión zombi vieja seguía ahí hasta el siguiente barrido
// periódico, ver ZOMBIE_SWEEP_INTERVAL_MS). Esto se vio reportado como que
// a algunas creadoras concretas "no le cargan los chats nunca".
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Telegram está tardando demasiado en responder (${label}).`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export interface TelegramFolderSummary {
  id: number;
  title: string;
  chatIds: string[]; // ids de Telegram (como string) de los chats incluidos
}

/**
 * Lista las carpetas (dialog filters) configuradas en la cuenta, con los
 * chats que contiene cada una. Se usa para poblar el selector de "carpeta
 * de Telegram" al crear una campaña, igual que el desplegable de carpetas
 * con su conteo de chats.
 */
export async function listAccountFolders(client: TelegramClient): Promise<TelegramFolderSummary[]> {
  const result = await withTimeout(client.invoke(new Api.messages.GetDialogFilters()), 30_000, "listando las carpetas");
  const filters = "filters" in result ? result.filters : (result as any);

  const summaries: TelegramFolderSummary[] = [];
  for (const filter of filters as any[]) {
    // "DialogFilter" son las carpetas normales; "DialogFilterChatlist" son
    // las carpetas compartidas por enlace ("chat folders" de Telegram, cada
    // vez más usadas) - antes se descartaban junto con "DialogFilterDefault"
    // (la carpeta implícita "Todos los chats", esa sí sin título real), así
    // que a cuentas con carpetas compartidas les faltaban muchas en el
    // selector. Ambos tipos tienen título + includePeers con la misma forma.
    if (filter.className !== "DialogFilter" && filter.className !== "DialogFilterChatlist") continue;
    const chatIds: string[] = [];
    // OJO: los chats FIJADOS ("pin") dentro de una carpeta los manda Telegram
    // aparte, en "pinnedPeers" - NO estan repetidos en "includePeers". Contar
    // solo includePeers se dejaba fuera todos los chats fijados de la
    // carpeta, asi que una carpeta con muchos chats fijados aparecia con
    // muchos menos chats de los que tiene de verdad (p.ej. "37 de 91").
    for (const peer of [...(filter.pinnedPeers ?? []), ...(filter.includePeers ?? [])]) {
      const id = peerToChatId(peer);
      if (id && !chatIds.includes(id)) chatIds.push(id);
    }
    summaries.push({
      id: filter.id,
      title: filter.title?.text ?? filter.title ?? `Carpeta ${filter.id}`,
      chatIds,
    });
  }
  return summaries;
}

function peerToChatId(peer: any): string | null {
  if (peer.className === "InputPeerChannel") return `-100${peer.channelId}`;
  // OJO: a diferencia de un canal/supergrupo, el chatId de un grupo BASICO
  // (no migrado a supergrupo - el caso tipico de los "grupos restringidos"
  // de 1 cliente, casi siempre solo 2-3 miembros) se marca en NEGATIVO en
  // todo el resto del codigo (ver dialog.id.toString() en dialogs.ts, que
  // usa el mismo "marcado" de Telegram). Devolverlo en positivo aqui hacia
  // que este chatId nunca coincidiese con el de la lista de chats, y por
  // tanto la etiqueta de carpeta no apareciese NUNCA para estos grupos
  // pequeños de cliente (que son justo los que se organizan en carpetas
  // como "Clientes"/"Grupo cliente").
  if (peer.className === "InputPeerChat") return `-${peer.chatId}`;
  if (peer.className === "InputPeerUser") return `${peer.userId}`;
  return null;
}

/**
 * Añade un chat a una carpeta de Telegram existente por su título (usado
 * por "Carpetas de Telegram → Sincronizar carpetas automáticamente").
 * Solo añade: si el chat ya está en la carpeta, o la carpeta no existe, no
 * hace nada. Si Telegram rechaza el cambio (carpeta llena, límite de la
 * cuenta...), se informa en vez de reventar la petición que lo llamó -
 * de momento no se crean carpetas nuevas tipo "Clientes 2" al llenarse.
 */
export async function addChatToFolderByTitle(
  client: TelegramClient,
  folderTitle: string,
  chatId: string
): Promise<{ ok: boolean; reason?: string }> {
  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const filters = "filters" in result ? result.filters : (result as any);
  const filter = (filters as any[]).find(
    (f) => f.className === "DialogFilter" && (f.title?.text ?? f.title ?? "").toLowerCase() === folderTitle.toLowerCase()
  );
  if (!filter) return { ok: false, reason: `No existe una carpeta de Telegram llamada "${folderTitle}".` };

  const already = [...(filter.pinnedPeers ?? []), ...(filter.includePeers ?? [])].some((p: any) => peerToChatId(p) === chatId);
  if (already) return { ok: true };

  let inputPeer: any;
  try {
    inputPeer = await client.getInputEntity(chatId);
  } catch {
    return { ok: false, reason: "No se pudo resolver el chat en Telegram." };
  }

  filter.includePeers = [...(filter.includePeers ?? []), inputPeer];
  try {
    await client.invoke(new Api.messages.UpdateDialogFilter({ id: filter.id, filter }));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.errorMessage || err?.message || "Telegram rechazó el cambio (¿carpeta llena?)." };
  }
}
