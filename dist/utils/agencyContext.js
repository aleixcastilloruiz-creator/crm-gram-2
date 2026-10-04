"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agencyIdFromRequest = agencyIdFromRequest;
const auth_1 = require("./auth");
const agencyMigration_1 = require("./agencyMigration");
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
async function agencyIdFromRequest(request) {
    const owner = (0, auth_1.getOwnerSessionFromRequest)(request);
    if (owner)
        return owner.agencyId;
    // requireSectionAccess ya deja el trabajador colgado de request.worker en
    // las rutas de Mensajes/SFS - si ya está ahí, no hace falta volver a leer
    // la cookie ni la base de datos.
    const already = request.worker;
    if (already?.agencyId)
        return already.agencyId;
    const worker = await (0, auth_1.getWorkerFromRequest)(request);
    if (worker)
        return worker.agencyId;
    return agencyMigration_1.LEGACY_AGENCY_ID;
}
//# sourceMappingURL=agencyContext.js.map