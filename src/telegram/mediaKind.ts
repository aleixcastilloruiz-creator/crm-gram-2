/** Clasifica un MessageMedia de GramJS en el tipo que necesita el CRM
 * (foto/video/audio/otro), para la Galería, Mensajes y ahora también
 * para lo que se guarda en StoredMessage (ver telegram/messageStore.ts).
 * Vivía solo en api/messages.ts; se movió aquí para que messageStore.ts
 * (en telegram/) pueda usarla sin crear un import circular entre
 * api/messages.ts y telegram/messageStore.ts. */
export function classifyGalleryMedia(media: any): "photo" | "video" | "audio" | "other" {
  if (!media) return "other";
  if (media.className === "MessageMediaPhoto") {
    // Una foto "vacia" (className "PhotoEmpty") pasa cuando el contenido ya
    // caducó (p.ej. una foto de "ver una vez" ya vista) - Telegram no tiene
    // nada que descargar para ella, así que mostrar un hueco de miniatura
    // solo daria otro error de carga. Se trata como "other" para que caiga
    // en el enlace generico en vez de un hueco roto.
    if (media.photo?.className === "PhotoEmpty") return "other";
    return "photo";
  }
  if (media.className === "MessageMediaDocument" && media.document) {
    const attrs: any[] = media.document.attributes || [];
    if (attrs.some((a) => a.className === "DocumentAttributeVideo")) return "video";
    if (attrs.some((a) => a.className === "DocumentAttributeAudio")) return "audio";
    const mime: string = media.document.mimeType || "";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("image/")) return "photo";
    // Una foto mandada "como archivo" (sin comprimir, para no perder
    // calidad) llega como MessageMediaDocument, no como MessageMediaPhoto -
    // a veces con un mimeType generico (o incluso vacío) que no empieza por
    // "image/", así que sin esto se colaba como "other" (enlace de
    // descarga) aunque fuera una foto real. Telegram siempre le añade el
    // atributo DocumentAttributeImageSize (ancho/alto) a cualquier imagen,
    // la usen para comprimirla o no, así que es una señal fiable de que es
    // una imagen aunque el mimeType no lo diga.
    if (attrs.some((a) => a.className === "DocumentAttributeImageSize")) return "photo";
    // Animación (GIF reenviado desde fuera de Telegram, "Enviar sin sonido")
    // - Telegram la guarda como documento con DocumentAttributeAnimated, casi
    // siempre con mimeType "video/mp4" (ya cubierto arriba), pero por si
    // acaso llega con otro mime se trata igual como vídeo.
    if (attrs.some((a) => a.className === "DocumentAttributeAnimated")) return "video";
  }
  // Cuando alguien envia (o reenvía) un enlace con vista previa - un link de
  // Instagram/Twitter/una noticia con imagen, etc. - Telegram NO lo guarda
  // como MessageMediaPhoto sino como MessageMediaWebPage con un `photo` (o a
  // veces un `document`, p.ej. un GIF/video) colgando de `webpage`. En la
  // app de Telegram esto se ve exactamente igual que una foto normal dentro
  // de la burbuja del mensaje, pero aqui antes caia siempre en "other" (el
  // enlace generico "Ver archivo adjunto") porque solo se miraba
  // MessageMediaPhoto/MessageMediaDocument sueltos - este es el motivo mas
  // habitual de que una "foto" real se viera como enlace roto en vez de
  // miniatura. client.downloadMedia() de GramJS ya sabe descargar el
  // photo/document de dentro de un webpage sin cambios adicionales, con solo
  // pasarle el message/media tal cual.
  if (media.className === "MessageMediaWebPage" && media.webpage) {
    const webpage = media.webpage;
    if (webpage.photo && webpage.photo.className !== "PhotoEmpty") return "photo";
    if (webpage.document) {
      const attrs: any[] = webpage.document.attributes || [];
      if (attrs.some((a: any) => a.className === "DocumentAttributeVideo")) return "video";
      const mime: string = webpage.document.mimeType || "";
      if (mime.startsWith("video/")) return "video";
      if (mime.startsWith("image/")) return "photo";
    }
  }
  return "other";
}
