"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.quincenaLabel = quincenaLabel;
const MESES_ES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
/**
 * Nombre de una nómina (Nóminas Chatter's / Nóminas Modelos): "Primera/
 * Segunda quincena <Mes> <Año>" a partir del DÍA del inicio del periodo
 * (1-15 = primera quincena, 16 en adelante = segunda) - reemplaza al rango
 * de fechas en crudo (ej. "16/09/2026 - 01/10/2026") tanto en las listas
 * del panel (ver fmtQuincenaLabel en app.js, misma lógica) como en el
 * propio documento Word/PDF generado (campo PERIODO de la plantilla).
 */
function quincenaLabel(periodStart) {
    const day = periodStart.getDate();
    const month = periodStart.getMonth();
    const year = periodStart.getFullYear();
    const mitad = day <= 15 ? "Primera" : "Segunda";
    const mes = MESES_ES[month];
    const mesCapitalizado = mes.charAt(0).toUpperCase() + mes.slice(1);
    return `${mitad} quincena ${mesCapitalizado} ${year}`;
}
//# sourceMappingURL=quincena.js.map