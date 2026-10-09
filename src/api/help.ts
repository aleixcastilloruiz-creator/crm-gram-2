import { FastifyInstance } from "fastify";
import { getOwnerSessionFromRequest, getWorkerFromRequest } from "../utils/auth";
import { agencyIdFromRequest } from "../utils/agencyContext";

/**
 * Apartado "Ayuda" (visible para Dueño/Jefe, Team líder y Chatter por
 * igual): el formulario de abajo del todo ("¿No lo encuentras? Escríbenos")
 * no guarda nada en la base de datos a propósito - de momento solo deja
 * constancia en los logs del servidor (Railway → backend → Logs, busca
 * "[ayuda]") con quién lo manda, su agencia y el mensaje. Es la via mas
 * simple posible para no tener que tocar el esquema de la base de datos
 * por un formulario de contacto; si hace falta un listado de verdad desde
 * el panel mas adelante, se puede anadir una tabla entonces.
 */
export async function registerHelpRoutes(app: FastifyInstance) {
  app.post("/api/help-requests", async (request, reply) => {
    const body = (request.body as any) || {};
    const kind = body.kind === "sugerencia" ? "sugerencia" : "ayuda";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return reply.code(400).send({ error: "Escribe un mensaje antes de enviar." });
    }
    if (message.length > 4000) {
      return reply.code(400).send({ error: "El mensaje es demasiado largo." });
    }

    const owner = getOwnerSessionFromRequest(request);
    const worker = owner ? null : await getWorkerFromRequest(request);
    if (!owner && !worker) {
      return reply.code(401).send({ error: "No hay sesión." });
    }
    const agencyId = await agencyIdFromRequest(request);
    const authorName = owner ? "Dueño/Jefe" : `${worker!.name} (${worker!.role === "admin" ? "Team líder" : "Chatter"})`;

    request.log.warn(
      { agencyId, authorName, kind, message },
      `[ayuda] ${kind === "sugerencia" ? "Sugerencia" : "Petición de ayuda"} de ${authorName} (agencia ${agencyId}): ${message}`
    );

    return { ok: true };
  });
}
