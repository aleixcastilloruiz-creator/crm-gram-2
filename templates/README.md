# templates/payroll-template.docx

Plantilla real de "HOJA DE PAGO CHATTER" (la misma que ya usaba Aitor a mano
en Word), con el texto de ejemplo sustituido por etiquetas de
[docxtemplater](https://docxtemplater.com/) para poder rellenarla con datos
de verdad desde `src/api/payroll.ts` (función `renderPayrollDocx`).

No se toca a mano editando el `.docx` en Word: cualquier edición futura del
formato (colores, texto fijo, orden de las filas) sí se puede hacer
abriéndolo en Word normal, siempre que se mantengan las etiquetas
`{ASI}` tal cual (ver tabla de abajo) y que cada una quede en una única
"pasada" de texto sin negrita/color a medias dentro de la celda - si Word
trocea una etiqueta en dos formatos distintos, la puede partir en dos
`<w:r>` internos y docxtemplater ya no la reconoce. Lo más seguro para
tocar una etiqueta es: seleccionar toda la celda, borrar, y escribir la
etiqueta de una vez con un único formato.

## Etiquetas

| Celda / fila | Etiqueta | De dónde sale |
|---|---|---|
| Título ("HOJA DE PAGO CHATTER - ...") | `{NOMBRE}` | `payroll.workerName` |
| PERIODO | `{PERIODO}` | `periodStart` - `periodEnd` formateados |
| NOMBRE DEL COLABORADOR | `{NOMBRE}` | `payroll.workerName` |
| ROL | `{ROL}` | `payroll.role` |
| MODELOS GESTIONADAS | `{MODELOS}` | `payroll.modelsManaged` |
| Salario fijo quincenal (importe) | `{SALARIO_DESC}` | `"<fixedSalary> $ + <commissionPct>% comisiones de ventas"` ya formateado |
| Fila "Ventas totales `<modelo>`" | fila-bucle `{#ventas}Ventas totales {modelo}` ... `{importe} ${/ventas}` | una fila por cada elemento de `ventas` (array `{modelo, importe}[]`, uno por cuenta/modelo con ventas en el periodo) |
| Bonificaciones | `{BONUS} $` | `payroll.bonus` |
| VENTAS TOTALES | `{VENTAS_TOTALES} $` | `payroll.totalSales` |
| % Comisión | `{PCT}%` | `payroll.commissionPct` |
| Total ventas realizadas (tabla comisión) | `{VENTAS_TOTALES} $` | igual que arriba, reutilizada |
| Comisión total chatter | `{COMISION} $` | `payroll.commissionAmount` |
| IMPORTE FINAL A PERCIBIR | `{TOTAL_FINAL} $` | `payroll.totalAmount` |
| FECHA DE PAGO | `{FECHA_PAGO}` | `payroll.paymentDate` (o la fecha de hoy si no se puso) |
| MÉTODO DE PAGO | `{METODO_PAGO}` | `payroll.paymentMethod` (por defecto "Criptomonedas: USDC - POL") |

Todo lo demás (AGENCIA, cabeceras de tabla, los emoji de sección, FIRMA
AGENCIA/FIRMA COLABORADOR) es texto fijo de la plantilla, no se toca.

## Fila-bucle ("Ventas totales `<modelo>`")

La plantilla original traía 5 filas fijas ("MODELO A" a "MODELO E"). Se
sustituyeron por UNA sola fila con las etiquetas de bucle de docxtemplater:
el tag de apertura `{#ventas}` es el primer texto de la primera celda de la
fila, y el de cierre `{/ventas}` es el último texto de la última celda de
esa misma fila - así docxtemplater repite la fila entera una vez por cada
elemento de `ventas`, sin límite de 5 y sin dejar filas "MODELO B" vacías o
sobrantes si hay menos de 5 modelos (o ninguna fila si no hubo ventas ese
periodo).

## Cómo se generó este archivo

A partir de la plantilla original que subió Aitor
(`Copia_de_PLANTILLA_HOJA_DE_PAGO_TRABAJADORES.docx`), con un script de
python-docx que:
1. Sustituye el texto de ejemplo de cada celda de la tabla anterior por su
   etiqueta, dejando cada una como UN ÚNICO run (mismo motivo que arriba:
   evitar que quede partida en dos formatos y docxtemplater no la vea).
2. Convierte la fila "MODELO A" en la fila-bucle y borra las 4 filas
   "MODELO B/C/D/E" que sobraban.
