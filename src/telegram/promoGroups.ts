import { TelegramClient, Api } from "telegram";

/**
 * "Grupos de promoción": lee en VIVO (nunca desde una tabla propia de
 * Telegram) los grupos/canales reales en los que está metida una cuenta,
 * para poder catalogarlos (ver api/promoGroups.ts, que hace el upsert en
 * PromoGroup/PromoGroupAccount). A diferencia de dialogs.ts (que filtra
 * para "Mensajes", solo DMs con fans + algunos grupos permitidos), aquí
 * interesa justo lo contrario: SOLO grupos/canales, todos, sin importar el
 * tamaño - un grupo de promoción puede tener desde 3 hasta miles de
 * miembros.
 */
export interface LivePromoGroup {
  chatId: string;
  title: string;
  isChannel: boolean; // canal de difusión (broadcast) vs grupo/supergrupo
  memberCount: number;
}

export async function listAccountGroupsAndChannels(client: TelegramClient): Promise<LivePromoGroup[]> {
  const dialogs = await client.getDialogs({ limit: 500 });
  const out: LivePromoGroup[] = [];
  for (const dialog of dialogs) {
    if (dialog.isUser) continue; // solo grupos/canales, nunca chats privados
    const entity: any = dialog.entity;
    if (!entity) continue;
    const chatId = dialog.id!.toString();
    const isChannel = !!dialog.isChannel && !dialog.isGroup; // canal de difusión puro (sin "megagroup")
    const memberCount = typeof entity.participantsCount === "number" ? entity.participantsCount : 0;
    out.push({
      chatId,
      title: dialog.title || "(sin nombre)",
      isChannel,
      memberCount,
    });
  }
  return out;
}

/**
 * Comprueba si un fan (por su chatId de Telegram) es miembro de un grupo o
 * canal concreto, SIN descargar la lista completa de miembros (que en
 * grupos grandes puede ser lenta/pesada y consumir cuota de Telegram de
 * sobra). Se usa para la atribución de fans a grupos de promoción: en
 * cuanto un fan nuevo escribe por primera vez, se comprueba contra cada
 * grupo ya catalogado de esa cuenta.
 */
export async function isChatMemberOf(client: TelegramClient, groupChatId: string, fanChatId: string): Promise<boolean> {
  try {
    const channel = await client.getInputEntity(groupChatId);
    const participant = await client.getInputEntity(fanChatId);
    await client.invoke(
      new Api.channels.GetParticipant({
        channel,
        participant,
      })
    );
    return true; // si no lanza error, es miembro (o lo fue con un rol devuelto)
  } catch (err: any) {
    // USER_NOT_PARTICIPANT es la respuesta normal de "no está" - cualquier
    // otro fallo (grupo no resoluble, chat básico sin channels.GetParticipant...)
    // tambien se trata como "no se pudo confirmar" en vez de reventar la
    // atribución de todo el lote.
    return false;
  }
}
