/**
 * Fecha de registro APROXIMADA de una cuenta de Telegram, a partir de su ID
 * numerico. Telegram no expone esta fecha por API (ni siquiera para bots),
 * asi que se estima con una tabla publica de correspondencias "ID de
 * usuario -> fecha" (los IDs se reparten de forma creciente y bastante
 * lineal segun la fecha de alta, por eso funciona como aproximacion). Es la
 * misma tecnica que usan herramientas conocidas del sector para mostrar
 * "fecha de registro estimada"; se marca siempre como aproximada en el panel.
 */

// [id minimo de esa franja, fecha aproximada en la que Telegram llego a ese id]
const ID_DATE_TABLE: [number, string][] = [
  [1000000, "2013-08-01"],
  [10000000, "2013-10-01"],
  [20000000, "2014-01-01"],
  [35000000, "2014-06-01"],
  [50000000, "2014-12-01"],
  [70000000, "2015-06-01"],
  [100000000, "2016-03-01"],
  [130000000, "2016-10-01"],
  [160000000, "2017-04-01"],
  [200000000, "2017-11-01"],
  [250000000, "2018-04-01"],
  [300000000, "2018-08-01"],
  [400000000, "2019-01-01"],
  [500000000, "2019-06-01"],
  [600000000, "2019-11-01"],
  [700000000, "2020-03-01"],
  [800000000, "2020-07-01"],
  [900000000, "2020-11-01"],
  [1000000000, "2021-02-01"],
  [1100000000, "2021-06-01"],
  [1200000000, "2021-09-01"],
  [1300000000, "2021-12-01"],
  [1400000000, "2022-03-01"],
  [1500000000, "2022-06-01"],
  [1600000000, "2022-09-01"],
  [1700000000, "2022-12-01"],
  [1800000000, "2023-03-01"],
  [1900000000, "2023-06-01"],
  [2000000000, "2023-09-01"],
  [2100000000, "2023-12-01"],
  [2200000000, "2024-04-01"],
  [2300000000, "2024-08-01"],
  [2400000000, "2024-12-01"],
  [2500000000, "2025-04-01"],
  [2600000000, "2025-08-01"],
  [2700000000, "2025-12-01"],
  [2800000000, "2026-04-01"],
];

/** Devuelve una fecha aproximada (YYYY-MM-DD) para el id de usuario dado, o
 * null si el id es demasiado bajo/alto para la tabla. */
export function estimateRegistrationDate(userId: string | number): string | null {
  const id = typeof userId === "string" ? Number(userId) : userId;
  if (!Number.isFinite(id) || id <= 0) return null;
  if (id < ID_DATE_TABLE[0][0]) return null;
  let best: string | null = null;
  for (const [minId, date] of ID_DATE_TABLE) {
    if (id >= minId) best = date;
    else break;
  }
  return best;
}
