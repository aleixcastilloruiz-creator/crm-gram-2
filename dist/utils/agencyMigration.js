"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_AGENCY_ID = void 0;
exports.ensureLegacyAgency = ensureLegacyAgency;
const prisma_1 = require("./prisma");
const auth_1 = require("./auth");
/**
 * Multi-agencia: la agencia "legacy-agency" es la propia LUXE FAN MANAGEMENT
 * (todo lo que ya existía en el CRM antes de esta funcionalidad). Su id es
 * FIJO a propósito (no cuid()) porque Account.agencyId / Worker.agencyId ya
 * tienen ese mismo valor como @default en el esquema (ver schema.prisma) -
 * así, en cuanto `prisma db push` añade la columna a las filas existentes,
 * quedan automáticamente "dentro" de esta agencia sin tocar ni una fila a
 * mano.
 *
 * Esta fila se siembra aquí, al arrancar la app, DESPUÉS de que `db push` ya
 * haya creado la tabla Agency - si se intentara crear como parte del propio
 * esquema (un "seed" dentro del push), la restricción de clave foránea de
 * agencyId (si la hubiera) fallaría porque la tabla Agency estaría vacía en
 * el momento de aplicar el @default a las filas ya existentes de Account/
 * Worker. Por eso Account/Worker.agencyId NO llevan relación de Prisma (ver
 * comentario en schema.prisma) y este sembrado va en el código, no en el
 * esquema.
 *
 * ownerEmail/ownerPasswordHash de esta fila en concreto NO se usan para
 * entrar (esta agencia sigue con PANEL_USERNAME/PANEL_PASSWORD de Railway,
 * exactamente igual que siempre) - se rellenan con un valor de relleno único
 * y una contraseña aleatoria e inutilizable, solo para cumplir el esquema
 * (ownerEmail es @unique).
 */
exports.LEGACY_AGENCY_ID = "legacy-agency";
async function ensureLegacyAgency() {
    const existing = await prisma_1.prisma.agency.findUnique({ where: { id: exports.LEGACY_AGENCY_ID } });
    if (existing)
        return;
    const randomJunkPassword = await (0, auth_1.hashPassword)(`no-login:${Date.now()}:${Math.random()}`);
    await prisma_1.prisma.agency.create({
        data: {
            id: exports.LEGACY_AGENCY_ID,
            name: process.env.PANEL_USERNAME || "LUXE FAN MANAGEMENT",
            ownerEmail: `${exports.LEGACY_AGENCY_ID}@no-login.local`,
            ownerPasswordHash: randomJunkPassword,
            active: true,
        },
    });
    console.log(`[agencias] Agencia "${exports.LEGACY_AGENCY_ID}" sembrada (todo lo ya existente queda ahí).`);
}
//# sourceMappingURL=agencyMigration.js.map