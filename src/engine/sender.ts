import { TelegramClient, Api } from "telegram";
import { Campaign, CampaignDestination, SourceGroup } from "@prisma/client";
import { prisma } from "../utils/prisma";

/**
 * Un "post" del origen puede ser un mensaje suelto o un album (varias
 * fotos/video agrupadas bajo el mismo groupedId, con el texto normalmente
 * en el ultimo item). SourceMessageGroup representa ese post completo, ya
 * que es la unidad que hay que reenviar junta para no romper el album.
 */
export type SourceMessageGroup = Api.Message[];

/**
 * Resuelve un chat/canal por su id "marcado" (ej. "-1003764920536"), con un
 * reintento tras refrescar los dialogos si GramJS no tiene el access_hash en
 * su cache local todavia - le puede pasar a una cuenta que no ha vuelto a
 * "ver" ese chat desde que se reinicio el proceso (p.ej. justo despues de un
 * despliegue), aunque siga siendo miembro de verdad. Sin este reintento,
 * getEntity fallaba con un error de "no se encuentra la entidad" que subia
 * sin capturar y dejaba el resto del tick de horarios fijos sin procesar.
 */
async function resolveChatEntity(client: TelegramClient, chatId: string): Promise<any> {
  try {
    return await client.getEntity(chatId);
  } catch {
    await client.getDialogs({ limit: 400 });
    return await client.getEntity(chatId);
  }
}

/**
 * Trae los ultimos posts (agrupando albumes) del grupo/tema origen, hasta
 * completar `source.recentLimit` posts distintos (no mensajes en bruto: un
 * album de 3 fotos cuenta como 1 post/posicion, igual que en el panel de
 * referencia). Telegram los devuelve mas recientes primero (ver
 * client.getMessages mas abajo); se dan la vuelta antes de devolverlos para
 * que la posicion 1 sea el MAS ANTIGUO de esos `recentLimit` posts, y la
 * ultima posicion el mas reciente - asi lo pidio Aitor (antes era al
 * reves: posicion 1 = el mas nuevo).
 */
export async function getRecentSourceMessages(
  client: TelegramClient,
  source: SourceGroup
): Promise<SourceMessageGroup[]> {
  let entity: any;
  try {
    entity = await resolveChatEntity(client, source.chatId);
  } catch (err: any) {
    const reason = err?.errorMessage ?? err?.message ?? String(err);
    throw new Error(`No se pudo leer el origen (chatId ${source.chatId}): ${reason}`);
  }

  // Pedimos de mas por si hay albumes de varias fotos, hasta agrupar
  // suficientes posts distintos. Reintenta ampliando el rango si hace falta.
  let rawLimit = source.recentLimit * 3;
  let groups: SourceMessageGroup[] = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    let raw: Api.Message[];
    try {
      raw = await client.getMessages(entity, {
        limit: rawLimit,
        replyTo: source.topicId ?? undefined, // filtra por topic si el origen es un foro
      });
    } catch (err: any) {
      const reason = err?.errorMessage ?? err?.message ?? String(err);
      const topicPart = source.topicId ? ` (tema/topic ${source.topicId})` : "";
      throw new Error(`No se pudieron leer los mensajes del origen${topicPart}: ${reason}`);
    }
    const usable = raw.filter((m) => m.message || m.media) as Api.Message[];
    groups = groupByAlbum(usable).slice(0, source.recentLimit);
    if (groups.length >= source.recentLimit || usable.length < rawLimit) break;
    rawLimit *= 2;
  }

  // Se cogen los `recentLimit` mas nuevos (slice de arriba, sobre la lista
  // que trae Telegram mas-nuevo-primero) y SOLO al final se da la vuelta,
  // para que la posicion 1 sea el mas antiguo de esos posts y la ultima
  // posicion el mas reciente.
  return groups.reverse();
}

/** Agrupa mensajes consecutivos que comparten groupedId (album), preservando el orden en que llegan (ver groupedId de Telegram - mas nuevo primero antes de darle la vuelta en getRecentSourceMessages). */
export function groupByAlbum(messages: Api.Message[]): SourceMessageGroup[] {
  const groups: SourceMessageGroup[] = [];
  const seenGroupIds = new Set<string>();

  for (const message of messages) {
    const groupedId = (message as any).groupedId?.toString();
    if (groupedId && seenGroupIds.has(groupedId)) {
      // ya se añadió como parte de un grupo anterior (getMessages viene ordenado, deberian ser consecutivos)
      const existing = groups.find((g) => (g[0] as any).groupedId?.toString() === groupedId);
      existing?.push(message);
      continue;
    }
    if (groupedId) seenGroupIds.add(groupedId);
    groups.push([message]);
  }

  // Dentro de cada album, que el texto/caption quede accesible sin importar en que item vino
  return groups;
}

/** Texto/caption de un post (album o mensaje suelto): el primero no vacio que se encuentre. */
function captionOf(group: SourceMessageGroup): string {
  return group.find((m) => m.message)?.message ?? "";
}

/** Post en la posicion N (1 = el mas antiguo de los `recentLimit` traidos) de una lista ya ordenada por getRecentSourceMessages. */
export function messageAtPosition(groups: SourceMessageGroup[], position: number): SourceMessageGroup | undefined {
  return groups[position - 1];
}

export interface SendOutcome {
  ok: boolean;
  error?: unknown;
}

/**
 * Envia un post (mensaje suelto o album) del origen a un chat destino
 * segun el modo configurado en la campaña:
 * - "reenvio sin autor" (por defecto): forward de Telegram con dropAuthor,
 *   así el mensaje llega SIN indicar remitente ni chat de origen.
 * - "copiar como propio": reconstruye el post como mensaje nuevo (sin
 *   marca de reenvio en absoluto).
 */
export async function deliverMessage(
  client: TelegramClient,
  campaign: Campaign,
  source: SourceGroup,
  destination: CampaignDestination,
  group: SourceMessageGroup
): Promise<SendOutcome> {
  try {
    const destEntity = await client.getEntity(destination.chatId);
    const caption = captionOf(group);
    const mediaItems = group.filter((m) => m.media);

    if (campaign.sendMode === "COPY_AS_OWN") {
      if (mediaItems.length > 0 && campaign.sendAlbums) {
        await client.sendFile(destEntity, {
          file: mediaItems.map((m) => m.media!) as any,
          caption,
          replyTo: destination.topicId ?? undefined,
        });
      } else if (caption && (campaign.textOnlyAllowed || mediaItems.length === 0)) {
        await client.sendMessage(destEntity, {
          message: caption,
          replyTo: destination.topicId ?? undefined,
        });
      } else {
        return { ok: false, error: new Error("Post sin contenido enviable segun la config de la campaña") };
      }
    } else {
      const sourceEntity = await client.getEntity(source.chatId);
      await client.forwardMessages(destEntity, {
        messages: group.map((m) => m.id), // todo el album junto, para no romper el agrupamiento
        fromPeer: sourceEntity,
        dropAuthor: true, // oculta remitente y chat de origen
      });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Registra el resultado de un envio en la consola de logs. */
export async function logSendOutcome(params: {
  accountId: string;
  campaignId: string;
  chatTitle: string;
  outcome: SendOutcome;
  sourceMessageId: number;
}) {
  const { accountId, campaignId, chatTitle, outcome, sourceMessageId } = params;
  await prisma.sendLog.create({
    data: {
      accountId,
      campaignId,
      level: outcome.ok ? "SENT" : "ERROR",
      chatTitle,
      message: outcome.ok
        ? `Chat: ${chatTitle} | mensaje origen ${sourceMessageId}`
        : `Chat: ${chatTitle} | fallo enviando mensaje origen ${sourceMessageId}`,
      errorCode: outcome.ok ? undefined : String((outcome.error as any)?.errorMessage ?? (outcome.error as any)?.message ?? outcome.error),
    },
  });
}
