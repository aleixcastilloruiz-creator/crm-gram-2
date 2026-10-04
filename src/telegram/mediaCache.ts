/**
 * Cache en memoria muy simple para no volver a descargar de Telegram la
 * misma foto de perfil o miniatura una y otra vez cada vez que se pinta la
 * lista de conversaciones o la biblioteca de contenido. Tamaño acotado
 * (LRU basico por orden de insercion) para no comerse la memoria del
 * contenedor con cientos de fotos.
 */

const MAX_ENTRIES = 400;
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
