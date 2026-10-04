import { Account, ScheduledPost } from "@prisma/client";
import { Api, TelegramClient } from "telegram";
import { CustomFile } from "telegram/client/uploads";
import { generateRandomBigInt } from "telegram/Helpers";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "../telegram/connectionPool";
import { resolveDialogEntity } from "../telegram/dialogs";
import { getContentGroupEntity, getContentMessage, mediaSizeBytes, MAX_FULL_MEDIA_BYTES, withFullMediaSlot } from "../api/contentLibrary";

/**
 * "Programar posts": a diferencia del Reenviador (que repite un ritmo/unos
 * horarios FIJOS todos los dias con contenido que va rotando), cada
 * ScheduledPost es un envio SUELTO y UNICO: un post concreto de la boveda,
 * en una fecha/hora exacta - a un canal/grupo (kind=CHANNEL) o como Historia
 * de Telegram en el propio perfil (kind=STORY, requiere cuenta Premium). Se
 * llama cada minuto desde el orquestador, igual que runFixedScheduleTick.
 */
export async function runScheduledPostsTick(): Promise<void> {
  const due = await prisma.scheduledPost.findMany({
    where: { status: "PENDING", scheduledFor: { lte: new Date() } },
    include: { account: true },
    orderBy: { scheduledFor: "asc" },
  });
  if (due.length === 0) return;

  for (const post of due) {
    // Cada post se procesa en su propio try/catch: uno que falle (cuenta
    // desconectada, contenido borrado de la boveda, chat destino invalido,
    // cuenta sin Premium para una Historia...) no debe impedir que se
    // publiquen los demas que ya tocaban.
    try {
      if (post.kind === "STORY") {
        await publishScheduledStory(post);
      } else {
        await publishScheduledChannelPost(post);
      }
    } catch (err: any) {
      const reason = describeStoryError(err) ?? (err?.errorMessage ?? err?.message ?? String(err));
      console.error(`[scheduledPostsEngine] error publicando ${post.id}:`, err);
      await prisma.scheduledPost
        .update({ where: { id: post.id }, data: { status: "FAILED", errorMessage: String(reason) } })
        .catch(() => {});
      await prisma.sendLog
        .create({
          data: {
            accountId: post.accountId,
            level: "ERROR",
            chatTitle: post.destinationTitle,
            message: post.kind === "STORY"
              ? `Programar posts (Historia): no se pudo publicar: ${reason}`
              : `Programar posts: no se pudo publicar en "${post.destinationTitle}": ${reason}`,
          },
        })
        .catch(() => {});
    }
  }
}

/** Convierte los codigos de error mas frecuentes de Telegram para Historias
 * en un mensaje claro en español, en vez del codigo en ingles a secas. */
function describeStoryError(err: any): string | null {
  const code: string = err?.errorMessage ?? err?.message ?? "";
  if (/PREMIUM_ACCOUNT_REQUIRED/i.test(code)) {
    return "Esta cuenta no tiene Telegram Premium: las Historias solo se pueden publicar desde una cuenta con Premium activo.";
  }
  if (/STORY_PERIOD_INVALID/i.test(code)) {
    return "La duración elegida para la Historia no es válida para esta cuenta (24h es la única que no requiere Premium).";
  }
  if (/VIDEO_CONTENT_TYPE_INVALID|FILE_PARTS_INVALID/i.test(code)) {
    return "El vídeo elegido no tiene un formato válido para una Historia de Telegram.";
  }
  if (/STORIES_TOO_MUCH/i.test(code)) {
    return "Esta cuenta ya tiene el máximo de Historias activas permitido por Telegram.";
  }
  return null;
}

function parseMessageIds(raw: string): number[] {
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    throw new Error("El contenido de este post quedó corrupto y no se puede leer.");
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Este post no tiene ningún contenido asociado.");
  }
  return ids as number[];
}

async function publishScheduledChannelPost(post: ScheduledPost & { account: Account }): Promise<void> {
  const account = post.account;
  if (!account.contentGroupChatId) {
    throw new Error("Esta cuenta ya no tiene una bóveda de contenido configurada (se quitó después de programar este post).");
  }
  const messageIds = parseMessageIds(post.messageIds);

  const client = await getAccountClient(account);
  const destEntity = await resolveDialogEntity(client, account.id, post.destinationChatId);
  const sourceEntity = await getContentGroupEntity(client, account.id, account.contentGroupChatId);

  await client.forwardMessages(destEntity, {
    messages: messageIds,
    fromPeer: sourceEntity,
    dropAuthor: true, // llega como publicado por la propia cuenta, sin "reenviado de"
  });

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "SENT", sentAt: new Date() },
  });
  await prisma.sendLog
    .create({
      data: {
        accountId: account.id,
        level: "SENT",
        chatTitle: post.destinationTitle,
        message: `Programar posts: publicado en "${post.destinationTitle}"`,
      },
    })
    .catch(() => {});
}

/**
 * Una Historia de Telegram no admite "reenviar" un archivo ya existente tal
 * cual (a diferencia de un post a canal): hay que bajarlo de la boveda y
 * volver a subirlo como media NUEVA, exactamente igual que ya hace el envio
 * "ver una vez" de la boveda (content-group/send-once) - por eso se copian
 * los mismos "attributes" del documento original (duracion, ancho/alto...)
 * en vez de intentar recalcularlos, que es lo que ya funciona en produccion
 * para ese otro envio.
 */
async function buildStoryInputMedia(client: TelegramClient, message: Api.Message): Promise<any> {
  const sourceMedia: any = message.media;
  if (!sourceMedia) throw new Error("Ese contenido no tiene ninguna foto/vídeo asociado.");
  const sizeBytes = mediaSizeBytes(sourceMedia);
  if (sizeBytes && sizeBytes > MAX_FULL_MEDIA_BYTES) {
    throw new Error("Este archivo pesa demasiado para publicarlo como Historia (más de 60MB).");
  }
  const buf = (await withFullMediaSlot(() => client.downloadMedia(message, {}))) as Buffer | undefined;
  if (!buf) throw new Error("No se pudo descargar el contenido de la bóveda para publicarlo.");

  const uploaded = await client.uploadFile({
    file: new CustomFile("historia", buf.length, "", buf),
    workers: 1,
  });

  if (sourceMedia.className === "MessageMediaPhoto") {
    return new Api.InputMediaUploadedPhoto({ file: uploaded });
  }
  const doc: any = sourceMedia.document;
  return new Api.InputMediaUploadedDocument({
    file: uploaded,
    mimeType: doc?.mimeType || "video/mp4",
    attributes: doc?.attributes || [],
  });
}

function storyPrivacyRules(privacy: string): any[] {
  if (privacy === "CONTACTS") return [new Api.InputPrivacyValueAllowContacts()];
  if (privacy === "CLOSE_FRIENDS") return [new Api.InputPrivacyValueAllowCloseFriends()];
  return [new Api.InputPrivacyValueAllowAll()];
}

async function publishScheduledStory(post: ScheduledPost & { account: Account }): Promise<void> {
  const account = post.account;
  if (!account.contentGroupChatId) {
    throw new Error("Esta cuenta ya no tiene una bóveda de contenido configurada (se quitó después de programar este post).");
  }
  const messageIds = parseMessageIds(post.messageIds);
  const messageId = messageIds[0]; // una Historia es siempre un solo contenido, nunca un album

  const client = await getAccountClient(account);
  const message = await getContentMessage(client, account.id, account.contentGroupChatId, String(messageId));
  if (!message) throw new Error("El contenido elegido ya no existe en la bóveda.");

  const media = await buildStoryInputMedia(client, message);

  const result: any = await client.invoke(
    new Api.stories.SendStory({
      peer: new Api.InputPeerSelf(),
      media,
      privacyRules: storyPrivacyRules(post.storyPrivacy as unknown as string),
      period: Math.max(1, post.storyPeriodHours) * 3600,
      pinned: post.storyPinned,
      caption: post.previewText || undefined,
      randomId: generateRandomBigInt(),
    })
  );

  // La respuesta trae el update con la Historia recien creada; se guarda su
  // id de Telegram por si en el futuro hace falta borrarla desde aqui.
  let telegramStoryId: number | null = null;
  try {
    const storyUpdate = (result?.updates || []).find((u: any) => u?.story?.id !== undefined);
    telegramStoryId = storyUpdate?.story?.id ?? null;
  } catch {
    telegramStoryId = null;
  }

  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: { status: "SENT", sentAt: new Date(), telegramStoryId },
  });
  await prisma.sendLog
    .create({
      data: {
        accountId: account.id,
        level: "SENT",
        chatTitle: "Historia",
        message: "Programar posts (Historia): publicada en el perfil",
      },
    })
    .catch(() => {});
}
