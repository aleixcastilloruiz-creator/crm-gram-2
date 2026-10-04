import { TelegramClient, Api } from "telegram";

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
  const result = await client.invoke(new Api.messages.GetDialogFilters());
  const filters = "filters" in result ? result.filters : (result as any);

  const summaries: TelegramFolderSummary[] = [];
  for (const filter of filters as any[]) {
    if (filter.className !== "DialogFilter") continue; // salta Default/Chatlist especiales
    const chatIds: string[] = [];
    for (const peer of filter.includePeers ?? []) {
      const id = peerToChatId(peer);
      if (id) chatIds.push(id);
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
  if (peer.className === "InputPeerChat") return `${peer.chatId}`;
  if (peer.className === "InputPeerUser") return `${peer.userId}`;
  return null;
}
