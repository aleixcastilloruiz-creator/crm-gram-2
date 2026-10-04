import { prisma } from "./prisma";
import { notifyPaymentDetection } from "../whatsapp/waNotify";
import { isWhatsAppConnected } from "../whatsapp/waClient";

/**
 * Detector de pagos: vigila los mensajes que ESCRIBE la propia cuenta (el
 * remitente/equipo) en chats directos y grupos de venta - nunca los que
 * escribe el fan/cliente, esos se ignoran por completo - buscando datos de
 * pago (IBAN, PayPal, Bizum, cripto, enlaces de Stripe/Revolut...), guarda
 * un historial y avisa por WhatsApp - por el WhatsApp vinculado por QR en
 * "Conectar WhatsApp" (ver whatsapp/waClient.ts y waNotify.ts), a la lista
 * de "A quién avisar" (WhatsAppSettings.paymentDestinations), no al Twilio
 * que sigue usando solo PeerFlood (ver notifications.ts).
 *
 * "Nuestros métodos de pago" y los "Filtros de texto" son para que NO
 * avise de los datos propios de la agencia (los que sí se le dan al fan a
 * propósito): se compara el filtro contra el MENSAJE completo (no solo el
 * trocito que coincidió con la regla) - si el filtro de texto coincide con
 * el mensaje, no se avisa; si no coincide, sí se avisa. De cualquier modo
 * se guarda igual en el historial (marcado "silenciado" cuando no avisa),
 * para poder revisarlo si hace falta - nunca se descarta sin más.
 *
 * Un chat "silenciado" del todo (pestaña Chats silenciados) es distinto:
 * ahí ni se guarda ni se avisa aunque una regla coincida, sea cual sea el
 * texto.
 */

interface RuleRow {
  id: string;
  name: string;
  pattern: string;
  searchText: boolean;
  searchCaption: boolean;
  searchFilename: boolean;
  active: boolean;
}

interface FilterRow {
  id: string;
  name: string;
  pattern: string;
  active: boolean;
}

// Cache en memoria de reglas/filtros/metodos propios/chats silenciados: se
// piden a la BD como mucho una vez cada pocos segundos, no en cada mensaje
// (una cuenta activa puede recibir bastantes mensajes seguidos). Cualquier
// escritura desde la API (crear/editar/borrar regla, etc.) llama a
// invalidatePaymentDetectorCache() para que el siguiente mensaje ya vea el
// cambio sin esperar a que caduque sola.
//
// Multi-agencia: cada agencia tiene sus propias reglas/filtros/métodos
// propios (Pagos es cosa de cada agencia, no compartido), así que la caché
// es un mapa agencyId -> su propio estado en vez de un único bloque global.
const CACHE_TTL_MS = 15_000;
interface CacheEntry {
  at: number;
  rules: RuleRow[];
  filters: FilterRow[];
  ownMethodsText: string;
  mutedChats: Set<string>; // "accountId:chatId"
}
const cacheByAgency = new Map<string, CacheEntry>();

export function invalidatePaymentDetectorCache(): void {
  cacheByAgency.clear();
}

async function loadCache(agencyId: string): Promise<CacheEntry> {
  const cached = cacheByAgency.get(agencyId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const [rules, filters, ownMethods, muted] = await Promise.all([
    prisma.paymentRule.findMany({ where: { agencyId }, orderBy: { position: "asc" } }),
    prisma.paymentTextFilter.findMany({ where: { agencyId } }),
    prisma.paymentOwnMethods.findUnique({ where: { agencyId } }),
    prisma.paymentMutedChat.findMany({ where: { account: { agencyId } } }),
  ]);
  const entry: CacheEntry = {
    at: Date.now(),
    rules,
    filters,
    ownMethodsText: ownMethods?.text || "",
    mutedChats: new Set(muted.map((m) => `${m.accountId}:${m.chatId}`)),
  };
  cacheByAgency.set(agencyId, entry);
  return entry;
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null; // una regla con un patrón roto simplemente no coincide con nada
  }
}

// Códigos de país reales que emiten IBAN (registro oficial IBAN/SWIFT). La
// regla de fábrica "IBAN genérico" ANTES aceptaba CUALQUIER par de letras
// ("\b[A-Z]{2}..." con la bandera "i" del regex, o sea, en cualquier
// mayúscula/minúscula) seguido de un par de dígitos y unos trozos de 4
// caracteres - eso hace que "coincida" con muchísimo texto normal que no
// tiene nada que ver con un IBAN (un código de invitación, un hash, una
// palabra con números detrás...), sobre todo en mensajes con emojis/texto
// raro como el spam que se cuela en los grupos de promoción. Restringir el
// prefijo a países que de verdad usan IBAN reduce mucho esos falsos
// positivos, aunque no los elimina del todo por sí solo (ver
// isValidIbanChecksum más abajo, que es el filtro que de verdad importa).
const IBAN_COUNTRY_CODES =
  "AD|AE|AL|AT|AZ|BA|BE|BG|BH|BR|BY|CH|CR|CY|CZ|DE|DJ|DK|DO|EE|EG|ES|FI|FO|FR|GB|GE|GI|GL|GR|GT|HR|HU|" +
  "IE|IL|IQ|IS|IT|JO|KW|KZ|LB|LC|LI|LT|LU|LV|LY|MC|MD|ME|MK|MR|MT|MU|MZ|NL|NO|OM|PK|PL|PS|PT|QA|RO|RS|" +
  "SA|SC|SD|SE|SI|SK|SM|SO|ST|SV|TL|TN|TR|UA|VA|VG|XK";

// Longitud TOTAL exacta de un IBAN de cada país (es fija por país, parte
// del propio estándar - registro oficial IBAN/SWIFT). Se usa para recortar
// el candidato encontrado por el regex a su longitud real antes de calcular
// el dígito de control: sin esto, si justo después del IBAN viene más texto
// pegado sin espacio (p.ej. "...051332gracias"), el regex avaricioso lo
// engancharía también, y probar "todas las longitudes posibles" hasta que
// alguna cuadre por casualidad reintroduciría el mismo problema de fondo
// (con ~20 longitudes distintas probadas, la probabilidad de que CUALQUIERA
// cuadre por azar deja de ser insignificante). Con la longitud exacta solo
// se prueba UN candidato por coincidencia, así que sigue siendo ~1 entre 97.
const IBAN_LENGTH_BY_COUNTRY: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24,
  FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21,
  LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30,
  MZ: 25, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23,
  TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/** Validación real de un IBAN por su dígito de control (algoritmo mod-97,
 * ISO 7064 - el mismo que usan los bancos): mueve los 4 primeros caracteres
 * al final, convierte cada letra en su valor numérico (A=10 ... Z=35) y
 * comprueba que el número resultante sea congruente con 1 módulo 97. Un
 * texto aleatorio que por pura casualidad tenga la forma de un IBAN (2
 * letras + 2 dígitos + un puñado de caracteres) pasa este cálculo solo 1 de
 * cada 97 veces aprox., así que es el filtro que de verdad distingue un
 * IBAN real de "algo con esa pinta" - es justo lo que le faltaba a la regla
 * de fábrica y lo que causaba avisos de "IBAN genérico" con textos que no
 * eran ningún IBAN (p.ej. un código/id suelto dentro de un mensaje de spam).
 */
function isValidIbanChecksum(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false; // longitud real de un IBAN: 15-34
  const rearranged = s.slice(4) + s.slice(0, 4);
  let numeric = "";
  for (const ch of rearranged) {
    numeric += /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
  }
  // mod 97 sobre un número que puede tener más de 30 dígitos: se procesa
  // por trozos (igual que hace cualquier librería de validación de IBAN)
  // para no desbordar los enteros normales de JS.
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(String(remainder) + numeric.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

/** Quita espacios (para comparar "BE06 9056..." con "BE069056...") y pasa a
 * minúsculas, igual que hace el detector de referencia. */
function normalize(s: string): string {
  return (s || "").replace(/\s+/g, "").toLowerCase();
}

/** ¿El MENSAJE completo (no solo el trocito que hizo saltar la regla)
 * contiene "lo nuestro" (nuestros métodos de pago + filtros de texto
 * activos)? Es lo que decide si se avisa o no: si el filtro de texto
 * coincide con el mensaje, no se avisa; si no coincide con nada, sí se
 * avisa. Reconoce tanto el dato exacto como, si es un enlace, solo su
 * tramo final (el "usuario") cuando tiene 5 caracteres o más - igual que
 * se explica en la pestaña "Filtros de texto" del panel. */
function matchesOwnData(messageText: string, filters: FilterRow[], ownMethodsText: string): boolean {
  const target = normalize(messageText);
  if (!target) return false;

  const candidates: string[] = [];
  for (const f of filters) if (f.active && f.pattern) candidates.push(f.pattern);
  for (const line of (ownMethodsText || "").split("\n")) {
    const t = line.trim();
    if (t) candidates.push(t);
  }

  for (const raw of candidates) {
    const own = normalize(raw);
    if (!own) continue;
    if (target.includes(own)) return true;
    // Tramo final de un enlace (después de la última "/"), si tiene 5+ caracteres.
    const ownTail = own.split("/").pop() || "";
    if (ownTail.length >= 5 && target.includes(ownTail)) return true;
  }
  return false;
}

export interface PaymentScanInput {
  accountId: string;
  chatId: string;
  chatTitle?: string | null;
  senderOut: boolean; // true = lo escribió el equipo, false = el fan
  text?: string | null; // texto normal (sin adjunto)
  caption?: string | null; // pie de un archivo/foto/vídeo adjunto
  filename?: string | null; // nombre del archivo adjunto, si lo hay
}

export interface PaymentScanMatch {
  ruleId: string;
  ruleName: string;
  matchedText: string;
  silenced: boolean;
}

/** Busca la coincidencia de UNA regla en un trozo de texto. Para la regla de
 * fábrica "IBAN genérico" no basta con que el patrón encaje en FORMA (eso
 * es justo lo que causaba los falsos positivos, ver DEFAULT_RULES e
 * isValidIbanChecksum más arriba): se revisan TODAS las coincidencias del
 * patrón en el texto (con la bandera global) y solo se acepta la primera
 * que además pase el dígito de control real de un IBAN. Si ninguna lo pasa,
 * es que no hay ningún IBAN de verdad ahí, aunque "tenga la forma". El
 * resto de reglas (PayPal, Bizum, enlaces...) se comportan igual que
 * siempre: la primera coincidencia en forma ya vale.
 */
function findRuleMatch(rule: RuleRow, re: RegExp, text: string): string | null {
  if (rule.name === "IBAN genérico") {
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(text)) !== null) {
      // El propio regex es "avaricioso": si justo después del IBAN viene
      // más texto pegado sin ningún espacio/puntuación de por medio (p.ej.
      // "...051332gracias"), lo engancha también en la coincidencia sin que
      // el "\b" del final lo evite (dentro de una racha de letras/números
      // seguidos no hay ningún límite de palabra intermedio). Se recorta el
      // candidato a la longitud REAL de su país (IBAN_LENGTH_BY_COUNTRY)
      // antes de comprobar el dígito de control, así un IBAN real seguido
      // de texto normal se sigue reconociendo igual.
      const compact = m[0].replace(/\s+/g, "").toUpperCase();
      const expectedLen = IBAN_LENGTH_BY_COUNTRY[compact.slice(0, 2)];
      if (expectedLen && compact.length >= expectedLen) {
        const candidate = compact.slice(0, expectedLen);
        if (isValidIbanChecksum(candidate)) return candidate;
      }
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++; // evita bucle infinito con coincidencias vacías
    }
    return null;
  }
  const m = text.match(re);
  return m && m[0] ? m[0] : null;
}

/** Corre las reglas activas sobre las distintas partes de un mensaje
 * (texto / pie de archivo / nombre de archivo, según lo que cada regla
 * tenga marcado) y devuelve todo lo que ha coincidido. Solo lectura -no
 * guarda nada ni avisa-, la usan tanto el detector en vivo como la pestaña
 * "Probar". */
export async function scanPaymentText(agencyId: string, input: {
  text?: string | null;
  caption?: string | null;
  filename?: string | null;
}): Promise<PaymentScanMatch[]> {
  const { rules, filters, ownMethodsText } = await loadCache(agencyId);
  const chunks: { value: string; from: "text" | "caption" | "filename" }[] = [];
  if (input.text) chunks.push({ value: input.text, from: "text" });
  if (input.caption) chunks.push({ value: input.caption, from: "caption" });
  if (input.filename) chunks.push({ value: input.filename, from: "filename" });

  // El mensaje completo (texto + pie + nombre de archivo juntos) es contra
  // lo que se compara el filtro de texto para decidir si se avisa o no -
  // no solo el trocito diminuto que hizo saltar la regla, que a veces ni
  // siquiera incluye el resto de la frase donde está el dato propio.
  const fullMessageText = chunks.map((c) => c.value).join("\n");

  const matches: PaymentScanMatch[] = [];
  for (const rule of rules) {
    if (!rule.active) continue;
    const re = safeRegex(rule.pattern);
    if (!re) continue;
    for (const chunk of chunks) {
      if (chunk.from === "text" && !rule.searchText) continue;
      if (chunk.from === "caption" && !rule.searchCaption) continue;
      if (chunk.from === "filename" && !rule.searchFilename) continue;
      const matchedText = findRuleMatch(rule, re, chunk.value);
      if (matchedText) {
        matches.push({
          ruleId: rule.id,
          ruleName: rule.name,
          matchedText: matchedText.slice(0, 120),
          silenced: matchesOwnData(fullMessageText, filters, ownMethodsText),
        });
        break; // una coincidencia por regla es suficiente, no hace falta repetir en cada trozo
      }
    }
  }
  return matches;
}

/** Punto de entrada para un mensaje real ya llegado por Telegram: aplica
 * "chat silenciado" (no guarda nada), guarda cada coincidencia en el
 * historial, y avisa por WhatsApp las que no estén silenciadas (si la
 * cuenta tiene número configurado). Nunca lanza - un fallo aquí no debe
 * tumbar el puente en vivo de mensajes. */
// Un mismo mensaje enviado desde el propio panel puede llegar a
// detectPaymentInMessage DOS veces: una vez desde la propia ruta de envío
// (llamada directa, para no depender de que el "eco" del envío llegue) y
// otra vez si ese eco SÍ llega luego como evento en vivo de Telegram
// (liveEvents.ts). Sin esto, un solo mensaje con un método de pago que no
// es el nuestro generaría dos filas en el historial y dos avisos por
// WhatsApp idénticos. Se recuerda brevemente (10s) qué combinación de
// cuenta+chat+regla+texto coincidido ya se proceso, y la segunda vez se
// ignora.
const RECENT_DEDUP_MS = 10_000;
const recentlyProcessed = new Map<string, number>();

function alreadyProcessedRecently(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of recentlyProcessed) {
    if (now - at > RECENT_DEDUP_MS) recentlyProcessed.delete(k);
  }
  if (recentlyProcessed.has(key)) return true;
  recentlyProcessed.set(key, now);
  return false;
}

export async function detectPaymentInMessage(input: PaymentScanInput): Promise<void> {
  try {
    // Solo interesan los mensajes que escribe la propia cuenta (el
    // remitente/equipo) - los que escribe el fan/cliente se ignoran del
    // todo, ni se guardan en el historial.
    if (!input.senderOut) return;

    const account = await prisma.account.findUnique({ where: { id: input.accountId } });
    if (!account) return; // cuenta borrada justo entre el mensaje y aquí: nada que detectar

    const { mutedChats } = await loadCache(account.agencyId);
    if (mutedChats.has(`${input.accountId}:${input.chatId}`)) return;

    const matches = await scanPaymentText(account.agencyId, {
      text: input.text,
      caption: input.caption,
      filename: input.filename,
    });
    if (matches.length === 0) return;

    const fullText = [input.text, input.caption].filter(Boolean).join("\n").slice(0, 4000);

    for (const match of matches) {
      const dedupKey = `${input.accountId}:${input.chatId}:${match.ruleId}:${match.matchedText}`;
      if (alreadyProcessedRecently(dedupKey)) continue;
      const event = await prisma.paymentDetectionEvent.create({
        data: {
          accountId: input.accountId,
          chatId: input.chatId,
          chatTitle: input.chatTitle || null,
          senderOut: !!input.senderOut,
          messageText: fullText,
          ruleId: match.ruleId,
          ruleName: match.ruleName,
          matchedText: match.matchedText,
          silenced: match.silenced,
        },
      });

      // isWhatsAppConnected() no garantiza que cada destino en concreto
      // reciba el mensaje (notifyPaymentDetection es best-effort y nunca
      // lanza), pero al menos evita marcar "enviado" cuando ni siquiera
      // hay un WhatsApp vinculado para intentarlo.
      if (!match.silenced && isWhatsAppConnected()) {
        const whatsappText =
          `💳 Detector de pagos · ${account?.label || input.accountId}\n` +
          `${input.chatTitle || input.chatId} (el equipo)\n` +
          `${match.ruleName}: ${match.matchedText}`;
        notifyPaymentDetection(whatsappText)
          .then(() => prisma.paymentDetectionEvent.update({ where: { id: event.id }, data: { whatsappSent: true } }))
          .catch(() => {
            // best-effort, igual que el resto de avisos por WhatsApp del proyecto
          });
      }
    }
  } catch (err) {
    console.error("[payment-detector] error procesando mensaje:", err);
  }
}

// ---------- Reglas de fábrica ----------
// Conjunto inicial razonable (no es una copia de ninguna lista de terceros,
// son patrones propios para cubrir los casos más comunes en España/LatAm).
// Se insertan solo la primera vez (ver ensureDefaultPaymentRules, llamado
// una vez al arrancar el servidor): si el usuario borra o edita alguna
// después, no se vuelve a recrear.
const DEFAULT_RULES: Omit<RuleRow, "id">[] = [
  {
    name: "IBAN genérico",
    // Prefijo restringido a países que de verdad usan IBAN (ver
    // IBAN_COUNTRY_CODES) + el dígito de control real (isValidIbanChecksum,
    // aplicado en scanPaymentText) - antes aceptaba CUALQUIER par de letras,
    // lo que hacía que "detectara" cosas que no tenían nada que ver con un
    // IBAN.
    pattern: `\\b(?:${IBAN_COUNTRY_CODES})\\d{2}(?:\\s?[A-Z0-9]{4}){2,7}(?:\\s?[A-Z0-9]{1,4})?\\b`,
    searchText: true, searchCaption: true, searchFilename: false, active: true,
  },
  {
    name: "PayPal",
    pattern: "\\bpaypal\\.me\\/[\\w.-]+\\b|\\bpaypal\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: true,
  },
  {
    name: "Bizum nombrado",
    pattern: "\\bbizum\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: true,
  },
  {
    name: "Enlace Stripe/Revolut",
    pattern: "\\bhttps?:\\/\\/(?:[^\\/\\s]*\\.)?(?:stripe\\.com|revolut\\.me)\\/\\S+",
    searchText: true, searchCaption: true, searchFilename: true, active: true,
  },
  {
    name: "Wise / TransferWise",
    pattern: "\\b(?:wise|transferwise)\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: true,
  },
  {
    name: "Cashtag CashApp",
    pattern: "(?<!\\w)\\$[A-Za-z][A-Za-z0-9_]{1,20}\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: true,
  },
  {
    name: "Enlace Venmo/Zelle/CashApp",
    pattern: "\\bhttps?:\\/\\/(?:cash\\.app|venmo\\.com|zellepay\\.com)\\/\\S+",
    searchText: true, searchCaption: true, searchFilename: true, active: true,
  },
  {
    name: "Correo",
    pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
    searchText: true, searchCaption: true, searchFilename: false, active: true,
  },
  {
    name: "Binance nombrado",
    pattern: "\\b(?:binance\\s*pay|bep20|bnb|busd)\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: false,
  },
  {
    name: "Cripto nombrado",
    pattern: "\\b(?:crypto|cripto|cryptocurrency|criptomoneda|criptomonedas|bitcoin|btc|usdt|ethereum|eth)\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: false,
  },
  {
    name: "Wallet cripto (BTC/ETH)",
    pattern: "\\b(?:bc1[a-z0-9]{25,39}|0x[a-fA-F0-9]{40})\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: true,
  },
  {
    name: "Número de tarjeta",
    pattern: "\\b\\d(?:[ -]?\\d){12,18}\\b",
    searchText: true, searchCaption: true, searchFilename: false, active: false,
  },
];

// Multi-agencia: cada agencia necesita sus propias reglas de fábrica (Pagos
// ya no es un único bloque compartido). Se siembra por cada agencia que
// todavía no tenga ninguna regla propia - tanto al arrancar (recorre todas
// las agencias ya existentes) como al dar de alta una agencia nueva desde
// /api/agencies (ver agencies.ts, que llama a esta misma función con un solo
// id).
export async function ensureDefaultPaymentRules(onlyAgencyId?: string): Promise<void> {
  try {
    const agencyIds = onlyAgencyId
      ? [onlyAgencyId]
      : (await prisma.agency.findMany({ select: { id: true } })).map((a) => a.id);
    for (const agencyId of agencyIds) {
      const count = await prisma.paymentRule.count({ where: { agencyId } });
      if (count > 0) continue;
      await prisma.paymentRule.createMany({
        data: DEFAULT_RULES.map((r, i) => ({ ...r, agencyId, position: i })),
      });
      console.log(`[payment-detector] ${DEFAULT_RULES.length} reglas de fábrica creadas para la agencia ${agencyId}.`);
    }
  } catch (err) {
    console.error("[payment-detector] no se pudieron crear las reglas de fábrica:", err);
  }
}

// El patrón viejo (demasiado suelto) de la regla de fábrica "IBAN genérico":
// cualquier cuenta que ya tuviera esta regla creada de ANTES de este arreglo
// se quedó con este patrón guardado en su base de datos - cambiar solo
// DEFAULT_RULES de arriba no le afecta, porque ensureDefaultPaymentRules
// nunca vuelve a sembrar reglas si ya hay alguna (para no pisar ediciones
// del usuario). Este arreglo puntual actualiza SOLO esa regla, y SOLO si su
// patrón sigue siendo exactamente el de fábrica de antes (si el usuario ya
// la editó a mano con otra cosa, no se toca).
const OLD_LOOSE_IBAN_PATTERN = "\\b[A-Z]{2}\\d{2}(?:\\s?[A-Z0-9]{4}){2,7}(?:\\s?[A-Z0-9]{1,4})?\\b";

export async function fixLooseIbanRulePattern(): Promise<void> {
  try {
    const newPattern = DEFAULT_RULES.find((r) => r.name === "IBAN genérico")!.pattern;
    const { count } = await prisma.paymentRule.updateMany({
      where: { name: "IBAN genérico", pattern: OLD_LOOSE_IBAN_PATTERN },
      data: { pattern: newPattern },
    });
    if (count > 0) {
      invalidatePaymentDetectorCache();
      console.log(`[payment-detector] regla "IBAN genérico" actualizada al patrón más estricto (era demasiado suelta y daba falsos positivos).`);
    }
  } catch (err) {
    console.error("[payment-detector] no se pudo actualizar la regla \"IBAN genérico\":", err);
  }
}
