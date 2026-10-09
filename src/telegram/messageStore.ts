import { Api } from "telegram";
import { prisma } from "../utils/prisma";
import { classifyGalleryMedia } from "./mediaKind";

/**
 * Copia local (en la base de datos de la agencia) del historial de cada
 * chat - ver el comentario grande de StoredMessage en schema.prisma para el
 * porqué. Este fichero es el único sitio que lee/escribe esa tabla: la API
 * (messages.ts) y el puente en vivo (liveEvents.ts) pasan siempre por aquí
 * en vez de hablar con Prisma directamente para esto.
 */

export interface StoredMessageDTO {
  id: number; // telegramMessageId, con el mismo nombre que ya usa el frontend
  text: string;
  out: boolean;
  date: string | null;
  mediaType: "photo" | "video" | "audio" | "other" | null;
}

function toRow(accountId: string, chatId: string, message: Api.Message) {
  return {
    accountId,
    chatId,
    telegramMessageId: message.id,
    text: message.message || "",
    out: !!message.out,
    date: message.date ? new Date(message.date * 1000) : null,
    mediaType: message.media ? classifyGalleryMedia(message.media) : null,
  };
}

/** Guarda (o actualiza, si ya existía - p.ej. un mensaje editado) UN
 * mensaje. Nunca debe tumbar nada que lo llame - un fallo aquí solo
 * significa "esta vez no quedó guardado en caché local", no "se perdió el
 * mensaje de Telegram" (ese sigue estando en Telegram igual). */
export async function persistMessage(accountId: string, chatId: string, message: Api.Message): Promise<void> {
  try {
    // Un mensaje sin texto NI media (p.ej. un service message de Telegram,
    // "fulano se unió al grupo") no se guarda - el resto del CRM tampoco
    // los pinta nunca (ver el .filter((m) => m.message || m.media) de
    // GET .../messages), así que guardarlos solo ensuciaría la tabla.
    if (!message.message && !message.media) return;
    const row = toRow(accountId, chatId, message);
    await prisma.storedMessage.upsert({
      where: { accountId_chatId_telegramMessageId: { accountId, chatId, telegramMessageId: row.telegramMessageId } },
      update: { text: row.text, out: row.out, date: row.date, mediaType: row.mediaType },
      create: row,
    });
  } catch {
    // best effort, ver comentario de arriba
  }
}

/** Igual que persistMessage pero para varios de golpe (tras un fetch en
 * vivo a Telegram) - una sola pasada en vez de await uno a uno. */
export async function persistMessagesBulk(accountId: string, chatId: string, messages: Api.Message[]): Promise<void> {
  const rows = messages.filter((m) => m.message || m.media).map((m) => toRow(accountId, chatId, m));
  if (rows.length === 0) return;
  try {
    await Promise.all(
      rows.map((row) =>
        prisma.storedMessage.upsert({
          where: { accountId_chatId_telegramMessageId: { accountId, chatId, telegramMessageId: row.telegramMessageId } },
          update: { text: row.text, out: row.out, date: row.date, mediaType: row.mediaType },
          create: row,
        })
      )
    );
  } catch {
    // best effort
  }
}

function rowToDTO(row: { telegramMessageId: number; text: string; out: boolean; date: Date | null; mediaType: string | null }): StoredMessageDTO {
  return {
    id: row.telegramMessageId,
    text: row.text,
    out: row.out,
    date: row.date ? row.date.toISOString() : null,
    mediaType: row.mediaType as StoredMessageDTO["mediaType"],
  };
}

/** Si ya tenemos ALGO guardado de este chat (no dice si está completo, solo
 * si ya se visitó al menos una vez) - decide si la primera página se sirve
 * desde aquí o hay que ir a buscarla en vivo a Telegram todavía. */
export async function hasAnyStoredMessages(accountId: string, chatId: string): Promise<boolean> {
  const row = await prisma.storedMessage.findFirst({ where: { accountId, chatId }, select: { id: true } });
  return !!row;
}

/** Los `limit` mensajes más recientes guardados (o, con beforeId, los
 * `limit` más recientes ANTERIORES a ese id - para "Cargar más"). Siempre
 * en orden cronológico (más antiguo primero), igual que ya espera el
 * frontend de GET .../messages. */
export async function getStoredMessagesPage(
  accountId: string,
  chatId: string,
  opts: { limit: number; beforeId?: number }
): Promise<StoredMessageDTO[]> {
  const rows = await prisma.storedMessage.findMany({
    where: {
      accountId,
      chatId,
      ...(opts.beforeId ? { telegramMessageId: { lt: opts.beforeId } } : {}),
    },
    orderBy: { telegramMessageId: "desc" },
    take: opts.limit,
    select: { telegramMessageId: true, text: true, out: true, date: true, mediaType: true },
  });
  return rows.reverse().map(rowToDTO);
}

export async function isFullyBackfilled(accountId: string, chatId: string): Promise<boolean> {
  const row = await prisma.chatSyncState.findUnique({ where: { accountId_chatId: { accountId, chatId } } });
  return !!row?.fullyBackfilled;
}

export async function markFullyBackfilled(accountId: string, chatId: string): Promise<void> {
  try {
    await prisma.chatSyncState.upsert({
      where: { accountId_chatId: { accountId, chatId } },
      update: { fullyBackfilled: true },
      create: { accountId, chatId, fullyBackfilled: true },
    });
  } catch {
    // best effort - si esto falla, simplemente se reintentará el fetch en
    // vivo la próxima vez que se pida "Cargar más" en este chat
  }
}

/** Cuántos mensajes más antiguos que `beforeId` quedan guardados (para
 * decidir "hasMore" cuando el chat ya está completamente respaldado y la
 * página se sirvió entera desde aquí, sin tocar Telegram). */
export async function countOlderStored(accountId: string, chatId: string, beforeId: number): Promise<number> {
  return prisma.storedMessage.count({ where: { accountId, chatId, telegramMessageId: { lt: beforeId } } });
}


/** Quita un mensaje de la copia local (tras borrarlo en Telegram desde el CRM). */
export async function deleteStoredMessage(accountId: string, chatId: string, telegramMessageId: number): Promise<void> {
  try {
    await prisma.storedMessage.deleteMany({ where: { accountId, chatId, telegramMessageId } });
  } catch {
    // best effort
  }
}
