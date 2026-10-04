"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPayrollRoutes = registerPayrollRoutes;
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
 * "Nóminas Chatter's" (Informes → Nóminas Chatter's, antes vivía en
 * Configuración → Nóminas): genera la hoja de pago de un
 * trabajador (chatter) para una quincena/periodo concreto, con el mismo
 * cálculo que el dueño de la agencia ya usaba a mano en Word
 * (PAGO_<nombre>.docx): salario fijo del periodo + comisión (por defecto
 * 10%) sobre TODAS las ventas (FanSale.amount) atribuidas a ese trabajador
 * -sumando el "Vendido por" de todas las cuentas/modelos, no solo una- más
 * una bonificación opcional.
 *
 * El documento final NO se dibuja a mano (como se hacía antes con pdfkit,
 * que solo se PARECÍA a la plantilla): se coge la plantilla de Word real
 * (templates/payroll-template.docx, una copia de la que ya usaba Aitor con
 * unas "etiquetas" {ASI} metidas en las celdas en vez del texto de ejemplo)
 * y se rellena de verdad con docxtemplater, así que el resultado es
 * literalmente ese Word con los datos puestos - mismo formato, colores,
 * tabla y emojis de siempre. Ver templates/README.md para cómo se generó
 * la plantilla y qué etiqueta va en cada celda.
 *
 * Solo la cuenta principal (dueño) puede generar/ver/borrar nóminas - mismo
 * candado que Configuración → Equipo (ver requireAdmin en workers.ts).
 */
async function requireAdmin(request, reply) {
    if ((0, auth_1.getOwnerSessionFromRequest)(request))
        return;
    reply.code(403).send({ error: "Solo la cuenta principal (luxe) puede gestionar nóminas." });
    return reply;
}
/** Descarga (Word/PDF) de una nómina concreta: la puede pedir la cuenta
 * principal (como siempre) O el propio trabajador al que pertenece esa
 * nómina - de solo lectura, nunca puede generarla/editarla/borrarla (eso
 * sigue siendo cosa exclusiva del dueño, ver requireAdmin arriba). No se
 * puede resolver como preHandler normal porque hace falta saber primero de
 * QUIEN es la nómina (su workerId), así que se llama a mano dentro de cada
 * ruta una vez ya se ha leído el registro. */
async function canAccessPayroll(request, payroll) {
    const owner = (0, auth_1.getOwnerSessionFromRequest)(request);
    if (owner)
        return owner.agencyId === payroll.agencyId;
    const worker = await (0, auth_1.getWorkerFromRequest)(request);
    return !!worker && !!payroll.workerId && worker.id === payroll.workerId;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
/** Junta las ventas (FanSale) de TODAS las cuentas atribuidas a este
 * trabajador ("Vendido por", comparado sin mayúsculas/acentos de más - igual
 * que ya hace Informes → Ingresos, ver informes.ts) dentro del periodo
 * dado, y las desglosa por cuenta (modelo) para la tabla "Ventas totales
 * <Modelo>" de la plantilla. */
async function computeSalesForPeriod(agencyId, workerName, periodStart, periodEnd) {
    const wanted = workerName.trim().toLowerCase();
    const sales = await prisma_1.prisma.fanSale.findMany({
        where: { date: { gte: periodStart, lte: periodEnd }, account: { agencyId } },
        select: { amount: true, soldBy: true, accountId: true, account: { select: { label: true } } },
    });
    const matching = sales.filter((s) => (s.soldBy || "").trim().toLowerCase() === wanted);
    const byAccountMap = new Map();
    let totalSales = 0;
    for (const s of matching) {
        totalSales += s.amount;
        const entry = byAccountMap.get(s.accountId) || { accountLabel: s.account.label, amount: 0 };
        entry.amount += s.amount;
        byAccountMap.set(s.accountId, entry);
    }
    const byAccount = [...byAccountMap.values()]
        .map((e) => ({ accountLabel: e.accountLabel, amount: round2(e.amount) }))
        .sort((a, b) => b.amount - a.amount);
    return { totalSales: round2(totalSales), byAccount };
}
function fmtEsDate(d) {
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function safeJsonArray(raw) {
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    }
    catch {
        return [];
    }
}
const TEMPLATE_PATH = path_1.default.join(__dirname, "../../templates/payroll-template.docx");
/**
 * Rellena templates/payroll-template.docx con los datos de una nómina ya
 * guardada y devuelve el .docx resultante como Buffer. La fila "Ventas
 * totales <modelo>" de la plantilla es una fila-bucle de docxtemplater
 * ({#ventas}...{/ventas} repartido entre su primera y su última celda), así
 * que se repite sola una vez por cada modelo con ventas en el periodo (cero
 * filas si no hubo ninguna venta, más de una si hubo varias modelos).
 */
function renderPayrollDocx(p, byAccount) {
    const content = fs_1.default.readFileSync(TEMPLATE_PATH, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
    try {
        doc.render({
            NOMBRE: p.workerName,
            PERIODO: (0, quincena_1.quincenaLabel)(p.periodStart),
            ROL: p.role || "-",
            MODELOS: p.modelsManaged || "-",
            SALARIO_DESC: `${p.fixedSalary.toFixed(2)} $ + ${p.commissionPct}% comisiones de ventas`,
            ventas: byAccount.map((a) => ({ modelo: a.accountLabel, importe: a.amount.toFixed(2) })),
            BONUS: p.bonus.toFixed(2),
            VENTAS_TOTALES: p.totalSales.toFixed(2),
            PCT: String(p.commissionPct),
            COMISION: p.commissionAmount.toFixed(2),
            TOTAL_FINAL: p.totalAmount.toFixed(2),
            FECHA_PAGO: p.paymentDate ? fmtEsDate(p.paymentDate) : fmtEsDate(new Date()),
            METODO_PAGO: p.paymentMethod || "Criptomonedas: USDC - POL",
        });
    }
    catch (err) {
        const details = err?.properties?.errors
            ?.map((e) => e?.properties?.explanation)
            .filter(Boolean)
            .join("; ");
        throw new Error(`No se pudo rellenar la plantilla de nómina: ${details || err?.message || String(err)}`);
    }
    return doc.getZip().generate({ type: "nodebuffer" });
}
/**
 * Convierte un .docx (el que ya genera renderPayrollDocx) a PDF de verdad,
 * con el mismo aspecto exacto que tendria abierto en Word - no es un PDF
 * "parecido" dibujado a mano, es el propio documento exportado. Para eso
 * hace falta LibreOffice instalado en el servidor (ver Dockerfile: "apk add
 * libreoffice"), que es pesado (varios cientos de MB, build de Railway mas
 * lento) pero es la unica forma fiable de un docx -> pdf que respete tablas,
 * colores y fuentes tal cual sin reescribir el documento en otra libreria.
 *
 * Cada conversion usa un perfil de usuario de LibreOffice y una carpeta de
 * trabajo temporal PROPIOS (creados y borrados en cada llamada): sin esto,
 * dos nominas generadas casi a la vez podrian chocar entre si ("ya hay una
 * instancia de LibreOffice abierta con este perfil") y una de las dos
 * fallaria sin motivo aparente.
 */
async function convertDocxToPdf(docxBuffer) {
    const workDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), "payroll-pdf-"));
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
async function registerPayrollRoutes(app) {
    // Trabajadores activos + sus valores por defecto de nómina (salario fijo
    // guardado y % de comisión) + qué modelos tiene concedidas en Equipo, para
    // rellenar el formulario de "Generar nómina" sin tener que escribirlo cada
    // vez a mano.
    app.get("/api/payroll/workers", { preHandler: requireAdmin }, async (request) => {
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const workers = await prisma_1.prisma.worker.findMany({
            where: { active: true, agencyId },
            orderBy: { name: "asc" },
            include: { permissions: { include: { account: { select: { label: true } } } } },
        });
        return {
            workers: workers.map((w) => ({
                id: w.id,
                name: w.name,
                role: w.role,
                payrollFixedSalary: w.payrollFixedSalary,
                payrollCommissionPct: w.payrollCommissionPct,
                modelsManaged: [...new Set(w.permissions.map((p) => p.account.label))],
            })),
        };
    });
    // Guarda el salario fijo / % de comisión "de siempre" de un trabajador,
    // para que la próxima nómina ya salga con eso puesto (sigue siendo
    // editable nómina a nómina, esto es solo el valor de partida).
    app.patch("/api/payroll/workers/:id", { preHandler: requireAdmin }, async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const data = {};
        if (body.payrollFixedSalary !== undefined)
            data.payrollFixedSalary = body.payrollFixedSalary;
        if (body.payrollCommissionPct !== undefined)
            data.payrollCommissionPct = body.payrollCommissionPct;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const { count } = await prisma_1.prisma.worker.updateMany({ where: { id, agencyId }, data });
        if (count === 0)
            return reply.code(404).send({ error: "Trabajador no encontrado." });
        return { ok: true };
    });
    // Vista previa: cuánto ha vendido este trabajador en el periodo, SIN
    // guardar nada todavía - para poder revisar el desglose por modelo antes
    // de generar la nómina de verdad.
    app.post("/api/payroll/preview", { preHandler: requireAdmin }, async (request, reply) => {
        const body = request.body;
        if (!body.workerName || !body.periodStart || !body.periodEnd) {
            return reply.code(400).send({ error: "Falta el trabajador o el periodo" });
        }
        const periodStart = new Date(body.periodStart + "T00:00:00");
        const periodEnd = new Date(body.periodEnd + "T23:59:59.999");
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const result = await computeSalesForPeriod(agencyId, body.workerName, periodStart, periodEnd);
        return result;
    });
    app.get("/api/payroll", { preHandler: requireAdmin }, async (request) => {
        const q = request.query;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const payrolls = await prisma_1.prisma.payroll.findMany({
            where: q.workerId ? { workerId: q.workerId, agencyId } : { agencyId },
            orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
        });
        return { payrolls };
    });
    app.get("/api/payroll/:id", { preHandler: requireAdmin }, async (request, reply) => {
        const { id } = request.params;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        const payroll = await prisma_1.prisma.payroll.findFirst({ where: { id, agencyId } });
        if (!payroll)
            return reply.code(404).send({ error: "Nómina no encontrada" });
        return { payroll };
    });
    // Apartado propio de "Nóminas" en el panel de cada trabajador: solo ve
    // las nóminas que el dueño ya le generó a ÉL (workerId = su propia
    // sesión), nunca las de otro compañero - de solo lectura, no puede
    // generar/editar/borrar ninguna. Un trabajador sin ninguna nómina
    // generada todavía simplemente ve la lista vacía.
    app.get("/api/payroll/mine", async (request, reply) => {
        const worker = await (0, auth_1.getWorkerFromRequest)(request);
        if (!worker)
            return reply.code(401).send({ error: "Autenticación requerida" });
        const payrolls = await prisma_1.prisma.payroll.findMany({
            where: { workerId: worker.id },
            orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
            select: {
                id: true,
                role: true,
                modelsManaged: true,
                periodStart: true,
                periodEnd: true,
                fixedSalary: true,
                commissionPct: true,
                totalSales: true,
                commissionAmount: true,
                bonus: true,
                totalAmount: true,
                paymentDate: true,
                paymentMethod: true,
            },
        });
        return { payrolls };
    });
    // Genera (guarda) la nómina: los totales se RECALCULAN aquí en el
    // servidor a partir de FanSale (nunca se confía en lo que mande el
    // navegador) y se guardan como foto fija - una nómina ya generada no debe
    // cambiar de importe si después se corrige una venta antigua.
    app.post("/api/payroll", { preHandler: requireAdmin }, async (request, reply) => {
        const body = request.body;
        if (!body.workerName || !body.periodStart || !body.periodEnd || body.fixedSalary === undefined) {
            return reply.code(400).send({ error: "Faltan datos obligatorios (trabajador, periodo o salario fijo)" });
        }
        const periodStart = new Date(body.periodStart + "T00:00:00");
        const periodEnd = new Date(body.periodEnd + "T23:59:59.999");
        const commissionPct = body.commissionPct ?? 10;
        const bonus = body.bonus || 0;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        if (body.workerId) {
            const owned = await prisma_1.prisma.worker.findFirst({ where: { id: body.workerId, agencyId } });
            if (!owned)
                return reply.code(400).send({ error: "Ese trabajador no existe en tu agencia." });
        }
        // Desde el panel de Nóminas, "Ventas por modelo" ahora es una tabla
        // editable a mano (nombre y ventas de cada modelo, filas que se pueden
        // añadir/editar/quitar libremente) en vez de fiarse solo de lo que el
        // CRM detecta automáticamente por "Vendido por" - así el dueño puede
        // anotar el total real de ventas de cada modelo aunque no coincida
        // exactamente con lo registrado en FanSale. Si el panel manda esta
        // lista (salesByAccount), se usa tal cual, tanto para el total como para
        // el desglose de la plantilla; si no la manda (compatibilidad con
        // llamadas antiguas), se sigue detectando solo desde el CRM + el viejo
        // campo suelto "manualExtraSales".
        let totalSales;
        let byAccount;
        // Se sigue guardando en la columna "manualExtraSales" de siempre (no se
        // toca el esquema): con la tabla nueva de "Ventas por modelo" ya no
        // aplica ese concepto suelto, así que se guarda como 0 en ese caso.
        let manualExtraSales = 0;
        if (Array.isArray(body.salesByAccount)) {
            byAccount = body.salesByAccount
                .map((r) => ({ accountLabel: (r.accountLabel || "").trim(), amount: round2(r.amount || 0) }))
                .filter((r) => r.accountLabel && r.amount);
            totalSales = round2(byAccount.reduce((sum, r) => sum + r.amount, 0));
        }
        else {
            manualExtraSales = round2(body.manualExtraSales || 0);
            const detected = await computeSalesForPeriod(agencyId, body.workerName, periodStart, periodEnd);
            totalSales = round2(detected.totalSales + manualExtraSales);
            byAccount = manualExtraSales > 0
                ? [...detected.byAccount, { accountLabel: "Ventas manuales adicionales", amount: manualExtraSales }]
                : detected.byAccount;
        }
        const commissionAmount = round2(totalSales * (commissionPct / 100));
        const totalAmount = round2(body.fixedSalary + commissionAmount + bonus);
        const payroll = await prisma_1.prisma.payroll.create({
            data: {
                agencyId,
                workerId: body.workerId || null,
                workerName: body.workerName,
                role: body.role || null,
                modelsManaged: body.modelsManaged || null,
                periodStart,
                periodEnd,
                fixedSalary: body.fixedSalary,
                commissionPct,
                manualExtraSales,
                totalSales,
                commissionAmount,
                bonus,
                totalAmount,
                paymentDate: body.paymentDate ? new Date(body.paymentDate + "T00:00:00") : null,
                paymentMethod: body.paymentMethod || null,
                salesByAccountJson: JSON.stringify(byAccount),
            },
        });
        return { payroll };
    });
    app.delete("/api/payroll/:id", { preHandler: requireAdmin }, async (request) => {
        const { id } = request.params;
        const agencyId = await (0, agencyContext_1.agencyIdFromRequest)(request);
        await prisma_1.prisma.payroll.deleteMany({ where: { id, agencyId } }).catch(() => { });
        return { ok: true };
    });
    // Word (.docx) con la plantilla real de la agencia (HOJA DE PAGO CHATTER),
    // rellenada con los datos de esta nómina ya guardada.
    app.get("/api/payroll/:id/docx", async (request, reply) => {
        const { id } = request.params;
        const p = await prisma_1.prisma.payroll.findUnique({ where: { id } });
        if (!p)
            return reply.code(404).send({ error: "Nómina no encontrada" });
        if (!(await canAccessPayroll(request, p))) {
            return reply.code(403).send({ error: "No tienes acceso a esta nómina." });
        }
        const byAccount = safeJsonArray(p.salesByAccountJson);
        let buffer;
        try {
            buffer = renderPayrollDocx(p, byAccount);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(500).send({ error: err?.message || "No se pudo generar el documento de la nómina." });
        }
        reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        reply.header("Content-Disposition", `attachment; filename="nomina-${p.workerName.replace(/[^a-z0-9]+/gi, "_")}-${p.periodEnd.toISOString().slice(0, 10)}.docx"`);
        return reply.send(buffer);
    });
    // PDF: el mismo documento de arriba, exportado de verdad con LibreOffice
    // (no un PDF dibujado a mano) - así conserva exactamente el formato de la
    // plantilla. Si la conversión falla (LibreOffice no instalado, o algún
    // fallo puntual del proceso), se avisa con un error claro en vez de
    // devolver un PDF a medias; el botón "Word" del panel sigue disponible
    // como alternativa mientras tanto.
    app.get("/api/payroll/:id/pdf", async (request, reply) => {
        const { id } = request.params;
        const p = await prisma_1.prisma.payroll.findUnique({ where: { id } });
        if (!p)
            return reply.code(404).send({ error: "Nómina no encontrada" });
        if (!(await canAccessPayroll(request, p))) {
            return reply.code(403).send({ error: "No tienes acceso a esta nómina." });
        }
        const byAccount = safeJsonArray(p.salesByAccountJson);
        let pdfBuffer;
        try {
            const docxBuffer = renderPayrollDocx(p, byAccount);
            pdfBuffer = await convertDocxToPdf(docxBuffer);
        }
        catch (err) {
            request.log.error(err);
            return reply.code(502).send({
                error: `No se pudo generar el PDF: ${err?.message || String(err)}. Puedes descargar la nómina en Word mientras tanto.`,
            });
        }
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", `attachment; filename="nomina-${p.workerName.replace(/[^a-z0-9]+/gi, "_")}-${p.periodEnd.toISOString().slice(0, 10)}.pdf"`);
        return reply.send(pdfBuffer);
    });
}
//# sourceMappingURL=payroll.js.map