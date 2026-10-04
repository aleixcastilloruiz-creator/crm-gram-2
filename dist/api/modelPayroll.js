"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerModelPayrollRoutes = registerModelPayrollRoutes;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const util_1 = require("util");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PizZip = require("pizzip");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Docxtemplater = require("docxtemplater");
const prisma_1 = require("../utils/prisma");
const auth_1 = require("../utils/auth");
const agencyContext_1 = require("../utils/agencyContext");
const quincena_1 = require("../utils/quincena");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * "Nóminas Modelos" (Informes → Nóminas Modelos, justo debajo de Nóminas
 * Chatter's): hoja de pago de una MODELO, no de una trabajadora/chatter -
 * eso es Nóminas Chatter's (ver payroll.ts), con su propia plantilla de
 * Word (templates/model-payroll-template.docx, la que compartió el dueño
 * de la agencia: "HOJA DE PAGO MODELO - ...").
 *
 * A diferencia de Nóminas Chatter's, aquí NO se calcula ninguna comisión
 * sobre ventas del CRM: la modelo cobra un importe FIJO que decide el
 * dueño a mano ("TOTAL CON EL % MODELO" en la plantilla - se deja ese
 * nombre tal cual porque así lo tenía él escrito, aunque en realidad ya no
 * es un % sobre nada) más bonificaciones sueltas por servicios
 * personalizados (videollamadas, contenido a medida...), que se anotan una
 * a una en una lista editable (concepto + importe, se puede añadir/quitar).
 *
 * Solo la cuenta principal (dueño) puede generar/ver/borrar estas nóminas -
 * mismo candado que Nóminas Chatter's y Configuración → Equipo.
 */
async function requireAdmin(request, reply) {
    if ((0, auth_1.getOwnerSessionFromRequest)(request))
        return;
    reply.code(403).send({ error: "Solo la cuenta principal (luxe) puede gestionar nóminas." });
    return reply;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function fmtEsDate(d) {
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function safeBonusArray(raw) {
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    }
    catch {
        return [];
    }
}
const TEMPLATE_PATH = path_1.default.join(__dirname, "../../templates/model-payroll-template.docx");
/**
 * Rellena templates/model-payroll-template.docx con los datos de una
 * nómina de modelo ya guardada y devuelve el .docx resultante como Buffer.
 * "DESGLOSE DE BONIFICACIONES" es una fila-bucle de docxtemplater
 * ({#bonos}...{/bonos} dentro del mismo párrafo/viñeta), igual que la fila
 * "Ventas totales <modelo>" de la plantilla de Nóminas Chatter's - se
 * repite sola una vez por bonificación (cero líneas si no hubo ninguna).
 */
function renderModelPayrollDocx(p, bonuses) {
    const content = fs_1.default.readFileSync(TEMPLATE_PATH, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    try {
        doc.render({
            NOMBRE_TITULO: (p.collaboratorName || p.stageName).toUpperCase(),
            NOMBRE_COLABORADOR: p.collaboratorName,
            NOMBRE_ARTISTICO: p.stageName,
            PERIODO: (0, quincena_1.quincenaLabel)(p.periodStart),
            SALARIO_FIJO: p.fixedSalary.toFixed(2),
            BONO_TOTAL: p.bonusTotal.toFixed(2),
            TOTAL_GENERADO: p.totalAmount.toFixed(2),
            TOTAL_FINAL: p.totalAmount.toFixed(2),
            FECHA_PAGO: p.paymentDate ? fmtEsDate(p.paymentDate) : fmtEsDate(new Date()),
            METODO_PAGO: p.paymentMethod || "Criptomonedas: USDC - POL",
            bonos: bonuses.map((b) => ({ concepto: b.concept, importe: b.amount.toFixed(2) })),
        });
    }
    catch (err) {
        const details = err?.properties?.errors
            ?.map((e) => e?.properties?.explanation)
            .filter(Boolean)
            .join("; ");
        throw new Error(`No se pudo rellenar la plantilla de nómina de modelo: ${details || err?.message || String(err)}`);
    }
    return doc.getZip().generate({ type: "nodebuffer" });
}
/** Igual que en payroll.ts: conversión de verdad con LibreOffice (no un PDF
 * "parecido" dibujado a mano), con perfil y carpeta de trabajo propios en
 * cada llamada para que dos conversiones a la vez no choquen entre sí. */
async function convertDocxToPdf(docxBuffer) {
    const workDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "model-payroll-pdf-"));
    try {
        const docxPath = path_1.default.join(workDir, "nomina.docx");
        const pdfPath = path_1.default.join(workDir, "nomina.pdf");
        const profileDir = path_1.default.join(workDir, "lo-profile");
        fs_1.default.writeFileSync(docxPath, docxBuffer);
        await execFileAsync("soffice", [
            "--headless",
            "--norestore",
            `-env:UserInstallation=file://${profileDir}`,
            "--convert-to",
            "pdf",
            "--outdir",
            workDir,
            docxPath,
        ], { timeout: 45_000 });
        if (!fs_1.default.existsSync(pdfPath)) {
            throw new Error("LibreOffice no generó el PDF (¿está instalado en el servidor? ver Dockerfile).");
        }
        return fs_1.default.readFileSync(pdfPath);
    }
    finally {
        fs_1.default.rmSync(workDir, { recursive: true, force: true });
    }
}
async function registerModelPayrollRoutes(app) {
    // Cuentas (modelos) activas + sus valores "de siempre" (nombre del
    // colaborador y salario fijo guardados), para rellenar el formulario sin
    // tener que escribirlo cada vez.
    app.get("/api/model-payroll/accounts", { preHandler: requireAdmin }, async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const accounts = await prisma_1.prisma.account.findMany({
            where: { agencyId },
            orderBy: { label: "asc" },
            select: {
                id: true,
                label: true,
                modelPayrollCollaboratorName: true,
                modelPayrollFixedSalary: true,
            },
        });
        return { accounts };
    });
    // Guarda el nombre del colaborador / salario fijo "de siempre" de una
    // modelo, para que la próxima nómina ya salga con eso puesto (sigue
    // siendo editable nómina a nómina).
    app.patch("/api/model-payroll/accounts/:id", { preHandler: requireAdmin }, async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const data = {};
        if (body.collaboratorName !== undefined)
            data.modelPayrollCollaboratorName = body.collaboratorName;
        if (body.fixedSalary !== undefined)
            data.modelPayrollFixedSalary = body.fixedSalary;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const { count } = await prisma_1.prisma.account.updateMany({ where: { id, agencyId }, data });
        if (count === 0)
            return reply.code(404).send({ error: "Modelo no encontrada." });
        return { ok: true };
    });
    app.get("/api/model-payroll", { preHandler: requireAdmin }, async (request) => {
        const q = request.query;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const payrolls = await prisma_1.prisma.modelPayroll.findMany({
            where: q.accountId ? { accountId: q.accountId, agencyId } : { agencyId },
            orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
        });
        return { payrolls };
    });
    app.get("/api/model-payroll/:id", { preHandler: requireAdmin }, async (request, reply) => {
        const { id } = request.params;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const payroll = await prisma_1.prisma.modelPayroll.findFirst({ where: { id, agencyId } });
        if (!payroll)
            return reply.code(404).send({ error: "Nómina no encontrada" });
        return { payroll };
    });
    // Genera (guarda) la nómina de modelo: el total se recalcula aquí en el
    // servidor a partir de las bonificaciones mandadas (nunca se confía solo
    // en lo que mande el navegador) y se guarda como foto fija.
    app.post("/api/model-payroll", { preHandler: requireAdmin }, async (request, reply) => {
        const body = request.body;
        if (!body.stageName || !body.collaboratorName || !body.periodStart || !body.periodEnd) {
            return reply.code(400).send({ error: "Faltan datos obligatorios (modelo, nombre del colaborador o periodo)" });
        }
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        if (body.accountId) {
            const owned = await prisma_1.prisma.account.findFirst({ where: { id: body.accountId, agencyId } });
            if (!owned)
                return reply.code(400).send({ error: "Esa modelo no existe en tu agencia." });
        }
        const periodStart = new Date(body.periodStart + "T00:00:00");
        const periodEnd = new Date(body.periodEnd + "T23:59:59.999");
        const fixedSalary = round2(body.fixedSalary || 0);
        const bonuses = (body.bonuses || [])
            .map((b) => ({ concept: (b.concept || "").trim(), amount: round2(b.amount || 0) }))
            .filter((b) => b.concept && b.amount);
        const bonusTotal = round2(bonuses.reduce((sum, b) => sum + b.amount, 0));
        const totalAmount = round2(fixedSalary + bonusTotal);
        const payroll = await prisma_1.prisma.modelPayroll.create({
            data: {
                agencyId,
                accountId: body.accountId || null,
                stageName: body.stageName,
                collaboratorName: body.collaboratorName,
                periodStart,
                periodEnd,
                fixedSalary,
                bonusesJson: JSON.stringify(bonuses),
                bonusTotal,
                totalAmount,
                paymentDate: body.paymentDate ? new Date(body.paymentDate + "T00:00:00") : null,
                paymentMethod: body.paymentMethod || null,
            },
        });
        return { payroll };
    });
    app.delete("/api/model-payroll/:id", { preHandler: requireAdmin }, async (request) => {
        const { id } = request.params;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        await prisma_1.prisma.modelPayroll.deleteMany({ where: { id, agencyId } }).catch(() => { });
        return { ok: true };
    });
    app.get("/api/model-payroll/:id/docx", { preHandler: requireAdmin }, async (request, reply) => {
        const { id } = request.params;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const p = await prisma_1.prisma.modelPayroll.findFirst({ where: { id, agencyId } });
        if (!p)
            return reply.code(404).send({ error: "Nómina no encontrada" });
        const bonuses = safeBonusArray(p.bonusesJson);
        let buffer;
        try {
            buffer = renderModelPayrollDocx(p, bonuses);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err?.message || "No se pudo generar el documento de la nómina." });
        }
        reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        reply.header("Content-Disposition", `attachment; filename="nomina-modelo-${p.stageName.replace(/[^a-z0-9]+/gi, "_")}-${p.periodEnd.toISOString().slice(0, 10)}.docx"`);
        return reply.send(buffer);
    });
    app.get("/api/model-payroll/:id/pdf", { preHandler: requireAdmin }, async (request, reply) => {
        const { id } = request.params;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const p = await prisma_1.prisma.modelPayroll.findFirst({ where: { id, agencyId } });
        if (!p)
            return reply.code(404).send({ error: "Nómina no encontrada" });
        const bonuses = safeBonusArray(p.bonusesJson);
        let pdfBuffer;
        try {
            const docxBuffer = renderModelPayrollDocx(p, bonuses);
            pdfBuffer = await convertDocxToPdf(docxBuffer);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({
                error: `No se pudo generar el PDF: ${err?.message || String(err)}. Puedes descargar la nómina en Word mientras tanto.`,
            });
        }
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", `attachment; filename="nomina-modelo-${p.stageName.replace(/[^a-z0-9]+/gi, "_")}-${p.periodEnd.toISOString().slice(0, 10)}.pdf"`);
        return reply.send(pdfBuffer);
    });
}
//# sourceMappingURL=modelPayroll.js.map