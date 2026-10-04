import { FastifyRequest } from "fastify";
import { getOwnerSessionFromRequest, getWorkerFromRequest } from "./auth";
import { LEGACY_AGENCY_ID } from "./agencyMigration";

/**
 * A qué agencia pertenece quien hace esta petición: el dueño de
 * "legacy-agency" (súper-admin, PANEL_USERNAME/PANEL_PASSWORD), el dueño de
 * una agencia nueva (invitada desde /api/agencies), o un trabajador de
 * cualquiera de las dos - ver Agency en schema.prisma.
 *
 * Nunca devuelve null: si por lo que sea no hay ninguna sesión reconocible
 * (no debería pasar - las rutas que la usan ya exigen login antes de llegar
 * aquí), se asume "legacy-agency" para no romper nada de antes de
 * multi-agencia.
 */
export async function agencyIdFromRequest(request: FastifyRequest): Promise<string> {
  const owner = getOwnerSessionFromRequest(request);
  if (owner) return owner.agencyId;
  // requireSectionAccess ya deja el trabajador colgado de request.worker en
  // las rutas de Mensajes/SFS - si ya está ahí, no hace falta volver a leer
  // la cookie ni la base de datos.
  const already = (request as any).worker;
  if (already?.agencyId) return already.agencyId;
  const worker = await getWorkerFromRequest(request);
  if (worker) return worker.agencyId;
  return LEGACY_AGENCY_ID;
}
