/**
 * Cache en memoria muy simple para no volver a descargar de Telegram la
 * misma foto de perfil o miniatura una y otra vez cada vez que se pinta la
 * lista de conversaciones o la biblioteca de contenido. Tamaño acotado
 * (LRU basico por orden de insercion) para no comerse la memoria del
 * contenedor con cientos de fotos.
 */

// Antes 400: compartido entre avatares de chat Y miniaturas de la bóveda de
// contenido, una carpeta con 60-80+ archivos podia desalojar ella sola las
// miniaturas de otras carpetas ya vistas (y los avatares de la lista de
// chats), forzando redescargas constantes de Telegram y haciendo que la
// bóveda se sintiera lenta cada vez que se cambiaba de carpeta. Son buffers
// pequeños (miniaturas comprimidas), así que subir el tope es barato.
const MAX_ENTRIES = 2000;
const cache = new Map<string, Buffer>();

export function getCachedMedia(key: string): Buffer | undefined {
  const buf = cache.get(key);
  if (buf) {
    // lo movemos al final (mas recientemente usado)
    cache.delete(key);
    cache.set(key, buf);
  }
  return buf;
}

export function setCachedMedia(key: string, buf: Buffer): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, buf);
}

/** Vacía toda la caché de miniaturas/avatares (botón "Vaciar caché y recargar"). */
export function clearMediaCache(): void {
  cache.clear();
}
