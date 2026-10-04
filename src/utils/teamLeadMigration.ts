import { prisma } from "./prisma";
import { LEGACY_AGENCY_ID } from "./agencyMigration";

/**
 * Migración única (una sola vez, para siempre - ver el comentario de
 * AgencySettings.teamLeadFullAccessMigrated en schema.prisma): antes un
 * trabajador con rol "admin" (Team líder) veía TODAS las cuentas en
 * Mensajes/Mensajes Pro/SFS sin necesitar ningún WorkerPermission
 * concedido a mano (requireSectionAccess se saltaba el chequeo entero para
 * ese rol). Al pasar a exigirle permiso explícito por cuenta, igual que a
 * un Chatter, cualquier Team líder ya en activo se habría quedado sin
 * acceso de golpe a todo lo que ya llevaba - así que, la primera vez que
 * arranca el servidor con este cambio, se le concede sin más trámite
 * mensajes+mensajes-pro+sfs en TODAS las cuentas que ya existen en ese
 * momento. Después de esa vez la bandera queda en true para siempre: una
 * cuenta NUEVA que se cree más adelante ya no se concede sola a ningún
 * Team líder - hay que dársela a mano desde Configuración → Equipo, como a
 * un Chatter.
 *
 * Multi-agencia: esta migración histórica solo tiene sentido para
 * LEGACY_AGENCY_ID (tu propia agencia de siempre), que es la única que podía
 * tener Team líderes/cuentas de ANTES de que existiera este permiso
 * explícito. Cualquier agencia nueva (invitada a partir de ahora) empieza
 * siempre con la bandera en su sitio desde el principio, así que nunca
 * necesita este "regalo" de acceso retroactivo.
 */
export async function migrateTeamLeadsToExplicitPermissions(): Promise<void> {
  try {
    const settings = await prisma.agencySettings.upsert({
      where: { agencyId: LEGACY_AGENCY_ID },
      create: { agencyId: LEGACY_AGENCY_ID },
      update: {},
    });
    if (settings.teamLeadFullAccessMigrated) return;

    const [teamLeads, accounts] = await Promise.all([
      prisma.worker.findMany({ where: { role: "admin", agencyId: LEGACY_AGENCY_ID }, select: { id: true, name: true } }),
      prisma.account.findMany({ where: { agencyId: LEGACY_AGENCY_ID }, select: { id: true } }),
    ]);

    if (teamLeads.length > 0 && accounts.length > 0) {
      await prisma.workerPermission.createMany({
        data: teamLeads.flatMap((worker) =>
          accounts.flatMap((account) => [
            { workerId: worker.id, accountId: account.id, section: "mensajes" },
            { workerId: worker.id, accountId: account.id, section: "mensajes-pro" },
            { workerId: worker.id, accountId: account.id, section: "sfs" },
          ])
        ),
        skipDuplicates: true,
      });
      console.log(
        `[team-lead-migration] acceso concedido a ${teamLeads.length} Team líder(es) sobre ${accounts.length} cuenta(s) ya existente(s) (mensajes+mensajes-pro+sfs).`
      );
    }

    await prisma.agencySettings.update({ where: { agencyId: LEGACY_AGENCY_ID }, data: { teamLeadFullAccessMigrated: true } });
  } catch (err) {
    console.error("[team-lead-migration] no se pudo migrar el acceso de Team líder a permisos explícitos:", err);
  }
}
