// Panel Reenviador — LUREQO
// SPA en JS puro (sin build step). Todo vive dentro de "Reenviador"; el
// resto de secciones del sidebar son visuales (aun no construidas).

const appEl = document.getElementById("app");
const accountListEl = document.getElementById("accountList");
const sidenavEl = document.getElementById("sidenav");
const sidebarEl = document.querySelector(".sidebar");
const toastEl = document.getElementById("toast");

// ---------- Móvil: cajón del menú lateral ----------
// El sidebar entero vive siempre en el DOM (igual que en escritorio); en
// pantallas estrechas se convierte en un cajón (ver style.css) que se abre
// con el botón ☰ de la barra superior fija y se cierra solo, al elegir una
// sección, tocar fuera, o abrir un chat.
function closeMobileNav() {
  document.body.classList.remove("mobile-nav-open");
}
const mobileNavToggleEl = document.getElementById("mobileNavToggle");
const mobileNavBackdropEl = document.getElementById("mobileNavBackdrop");
if (mobileNavToggleEl) {
  mobileNavToggleEl.addEventListener("click", () => document.body.classList.toggle("mobile-nav-open"));
}
if (mobileNavBackdropEl) {
  mobileNavBackdropEl.addEventListener("click", closeMobileNav);
}

// ---------- Paneles redimensionables (lista de modelos, lista de chats,
// notas) ----------
// A algunos chatters/Team líderes les resultaba todo muy apretado (varias
// columnas fijas a la vez: menú, cuentas, chats, conversación, notas). En
// vez de imponer un tamaño, cada persona arrastra el borde entre dos
// columnas y lo deja a su gusto - se guarda en SU propio navegador
// (localStorage), nunca en la cuenta ni compartido con el resto del equipo,
// así que el dueño, un Team líder y un Chatter pueden tener cada uno sus
// anchos preferidos sin pisarse.
//
// handleEl: el div.resize-handle de por medio.
// cssVar: variable CSS (en :root) que controla el ancho de la columna de la
// izquierda del handle - cambiarla ahí basta, el CSS ya la usa como width.
// storageKey: dónde se guarda el ancho elegido.
function initPanelResizer(handleEl, cssVar, storageKey, { min, max, default: def }) {
  if (!handleEl) return;
  const saved = Number(localStorage.getItem(storageKey));
  const initial = Number.isFinite(saved) && saved >= min && saved <= max ? saved : def;
  document.documentElement.style.setProperty(cssVar, initial + "px");

  let dragging = false;
  let startX = 0;
  let startWidth = initial;

  handleEl.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10) || def;
    document.body.classList.add("panel-resizing");
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const next = Math.min(max, Math.max(min, startWidth + (e.clientX - startX)));
    document.documentElement.style.setProperty(cssVar, next + "px");
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("panel-resizing");
    const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10);
    if (Number.isFinite(current)) localStorage.setItem(storageKey, String(current));
  });
  // Doble clic en el borde: vuelve al ancho de siempre, por si alguien lo
  // deja demasiado estrecho/ancho sin querer.
  handleEl.addEventListener("dblclick", () => {
    document.documentElement.style.setProperty(cssVar, def + "px");
    localStorage.setItem(storageKey, String(def));
  });
}

initPanelResizer(document.getElementById("accountListResizer"), "--accountlist-w", "luxe_panel_w_accountlist", {
  min: 140,
  max: 360,
  default: 200,
});

let state = {
  accounts: [],
  currentAccountId: null,
  currentView: "reenviador", // "reenviador" | "configuracion"
  configSection: "cuentas-telegram",
  informesSection: "horas-trabajadas",
  guionesAccountId: null,
  guionesCategoryId: null, // null = "Todos", "none" = "Sin categoría", o el id de una categoría
  // "Equipo": si hay una sesión de trabajador (cookie luxe_worker), se
  // guarda aquí. null = nadie logueado como trabajador (el dueño sigue
  // usando el panel solo con el Basic Auth general, como hasta ahora).
  currentWorker: null,
  workerPermissions: [], // [{accountId, accountLabel, section}]
  ownerName: null, // nombre de la cuenta luxe cuando NO hay trabajador logueado (ver fetchWorkerSession)
  isSuperAdmin: false, // multi-agencia: solo true para PANEL_USERNAME/PANEL_PASSWORD de Railway (ve "Agencias" en el menú)
  viewingOwnAgency: true, // false si el súper-admin ha entrado a "Ver datos" de otra agencia (ver fetchWorkerSession/renderSidenav)
  // Marca blanca: true = esta sesión es de tu propia agencia (legacy-agency,
  // la única que ve "LUREQO") - false = una agencia invitada o
  // uno de sus trabajadores, que en vez de eso ve agencyBrandName (su
  // propio nombre) y ningún logo (ver applyBranding).
  isLegacyAgency: true,
  agencyBrandName: null,
  // "Solo lectura" (Equipo → Permisos, worker.readOnly): true solo cuando
  // hay un trabajador logueado y el dueño lo ha marcado así - ve todo igual
  // que siempre, pero los botones de escritura quedan deshabilitados aquí
  // (el bloqueo de verdad va en el servidor, esto es solo para no hacerle
  // clicar en algo que de todas formas va a dar 403 - ver renderWorkerNav).
  isReadOnlyWorker: false,
  // Portal /login del dueño: true si la sesión actual viene de la cookie
  // luxe_owner (para saber si tiene sentido mostrar "Cerrar sesión").
  ownerSessionCookie: false,
  // "Modo shadow" (barra lateral, solo dueño/admin): true = todas las
  // cuentas se mantienen "desconectadas" de cara a Telegram. Se carga en
  // init() y se actualiza al tocar el interruptor (ver toggleShadowMode).
  shadowModeEnabled: false,
};

// "Listas" (etiquetas rápidas) de un fan: igual que en el panel de
// referencia. "Prioridad" tiene además su propia pestaña de acceso rápido
// en Mensajes, por eso se deja fuera del desplegable "Todas las listas".
const FAN_LISTS = [
  { value: "", label: "Sin lista" },
  { value: "Posibles", label: "🔵 Posibles" },
  { value: "Clientes", label: "🟢 Clientes" },
  { value: "Grupo cliente", label: "🟣 Grupo cliente" },
  { value: "SFS", label: "🟠 SFS" },
  { value: "TW", label: "🟤 TW" },
  { value: "Prioridad", label: "🔴 Prioridad" },
];
const FAN_LISTS_FOR_FILTER = FAN_LISTS.filter((o) => o.value && o.value !== "Prioridad");

// ---------- helpers ----------

// Prefijo de la API: "/api" en la app normal, "/pro/api" dentro de la
// ventana de Mensajes Pro (mismo motor de Mensajes, registrado aparte en el
// backend con su propio permiso "mensajes-pro" - ver index.ts). Mensajes
// Pro siempre se abre en una ventana/pestaña de verdad, nunca dentro de la
// app normal, así que cambiar este valor aquí no afecta a nadie más.
let API_BASE = "/api";

async function api(path, options = {}) {
  // Ojo: el Content-Type solo se manda si hay body. Un POST sin body (como
  // /auth/logout u /auth/owner-logout) con Content-Type: application/json
  // pero sin nada dentro hace que Fastify lo rechace con 400 ("body vacío"),
  // lo que a su vez hacía que "Cerrar sesión" fallara en silencio (el catch
  // de ownerLogout() se comía el error) y por tanto nunca se borrara la
  // cookie en el servidor.
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.data = data; // por si el backend manda algo más útil además del mensaje (p.ej. un enlace de invitación)
    throw err;
  }
  return data;
}

/** Descarga un archivo binario (PDF, etc.) de un endpoint del API - a
 * diferencia de api(), que siempre espera JSON. Usa las mismas cookies de
 * sesión (fetch same-origin) y dispara la descarga en el navegador sin
 * abrir pestañas nuevas. */
async function downloadFileFromApi(path, filename) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Error ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toastEl.className = "toast hidden"), 3800);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

// ---------- Ajustes "de este ordenador" (zona horaria, formato de hora,
// notificaciones...): son solo de este navegador, no de la agencia, asi que
// viven en localStorage en vez de en el servidor. ----------
// Lista de zonas horarias para el desplegable de "Zona horaria" (Configuración
// → General). Los navegadores modernos exponen la lista completa (~400) via
// Intl.supportedValuesOf; si no está disponible, usamos una lista reducida
// con las zonas mas comunes para que el desplegable nunca quede vacío.
const FALLBACK_TIMEZONES = [
  "UTC", "Europe/Madrid", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome",
  "Europe/Lisbon", "Europe/Amsterdam", "Europe/Dublin", "Europe/Moscow", "Europe/Kyiv",
  "Europe/Warsaw", "Europe/Athens", "Europe/Istanbul", "Europe/Zurich",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Mexico_City", "America/Bogota", "America/Lima", "America/Caracas",
  "America/Santiago", "America/Buenos_Aires", "America/Sao_Paulo", "America/Montevideo",
  "America/Toronto", "America/Vancouver", "America/Guatemala", "America/Santo_Domingo",
  "America/Havana", "America/Panama",
  "Asia/Bangkok", "Asia/Jakarta", "Asia/Singapore", "Asia/Manila", "Asia/Ho_Chi_Minh",
  "Asia/Kuala_Lumpur", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
  "Asia/Kolkata", "Asia/Dubai", "Asia/Riyadh", "Asia/Jerusalem", "Asia/Istanbul",
  "Africa/Casablanca", "Africa/Cairo", "Africa/Lagos", "Africa/Johannesburg", "Africa/Nairobi",
  "Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Pacific/Auckland",
  "Pacific/Honolulu", "Atlantic/Canary",
];
const TIMEZONES = (typeof Intl.supportedValuesOf === "function")
  ? Intl.supportedValuesOf("timeZone")
  : FALLBACK_TIMEZONES;

const LOCAL_SETTINGS_KEY = "luxeLocalSettings";
const DEFAULT_LOCAL_SETTINGS = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  hourFormat: "24", // "24" | "12"
  notifications: true,
};

function getLocalSettings() {
  try {
    const raw = localStorage.getItem(LOCAL_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_LOCAL_SETTINGS };
    return { ...DEFAULT_LOCAL_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_LOCAL_SETTINGS };
  }
}

function setLocalSettings(patch) {
  const next = { ...getLocalSettings(), ...patch };
  try {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // si el navegador bloquea localStorage (modo privado, etc.) simplemente no persiste
  }
  return next;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const s = getLocalSettings();
  try {
    return new Date(iso).toLocaleString("es-ES", {
      timeZone: s.timezone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: s.hourFormat === "12",
    });
  } catch {
    // por si el nombre de zona horaria guardado dejase de ser valido
    return new Date(iso).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
}

const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Nombre de una nómina (Nóminas Chatter's / Nóminas Modelos): "Primera/
 * Segunda quincena <Mes> <Año>" en vez del rango de fechas en crudo (ej.
 * "16/09, 07:00 - 01/10, 06:59"), que no se leía de un vistazo. Se calcula
 * a partir del DÍA del inicio del periodo (1-15 = primera quincena, 16 en
 * adelante = segunda) en la misma zona horaria que el resto del panel -
 * nunca se guarda como texto aparte, así que sigue funcionando igual con
 * nóminas ya generadas antes de este cambio. */
function fmtQuincenaLabel(periodStartIso) {
  if (!periodStartIso) return "—";
  const s = getLocalSettings();
  const d = new Date(periodStartIso);
  let day, month, year;
  try {
    const parts = new Intl.DateTimeFormat("es-ES", { timeZone: s.timezone, day: "numeric", month: "numeric", year: "numeric" }).formatToParts(d);
    day = Number(parts.find((p) => p.type === "day").value);
    month = Number(parts.find((p) => p.type === "month").value);
    year = parts.find((p) => p.type === "year").value;
  } catch {
    day = d.getDate();
    month = d.getMonth() + 1;
    year = d.getFullYear();
  }
  const mitad = day <= 15 ? "Primera" : "Segunda";
  const mes = MESES_ES[month - 1];
  const mesCapitalizado = mes.charAt(0).toUpperCase() + mes.slice(1);
  return `${mitad} quincena ${mesCapitalizado} ${year}`;
}

/** Hora del último mensaje para la LISTA de conversaciones (Mensajes y
 * Mensajes Pro, mismo formato en las dos) - igual que WhatsApp/Telegram:
 * solo la hora si es de hoy, "Ayer" si fue ayer, el día de la semana si fue
 * esta última semana, o la fecha corta si es más antiguo. Usa la misma
 * zona horaria y formato de 12/24h que ya tiene guardados el usuario. */
function fmtDialogTime(iso) {
  if (!iso) return "";
  const s = getLocalSettings();
  let d;
  try {
    d = new Date(iso);
    if (isNaN(d.getTime())) return "";
  } catch {
    return "";
  }
  const opts = { timeZone: s.timezone };
  let nowParts, dateParts;
  try {
    nowParts = new Date().toLocaleDateString("es-ES", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" });
    dateParts = d.toLocaleDateString("es-ES", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    nowParts = new Date().toLocaleDateString("es-ES", { year: "numeric", month: "2-digit", day: "2-digit" });
    dateParts = d.toLocaleDateString("es-ES", { year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const daysAgo = Math.round((new Date(nowParts.split("/").reverse().join("-")) - new Date(dateParts.split("/").reverse().join("-"))) / dayMs);

  const timeOpts = { timeZone: s.timezone, hour: "2-digit", minute: "2-digit", hour12: s.hourFormat === "12" };
  const timeOnly = () => {
    try {
      return d.toLocaleTimeString("es-ES", timeOpts);
    } catch {
      return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: s.hourFormat === "12" });
    }
  };

  if (daysAgo === 0) return timeOnly();
  if (daysAgo === 1) return "Ayer";
  if (daysAgo > 1 && daysAgo < 7) {
    try {
      return d.toLocaleDateString("es-ES", { timeZone: s.timezone, weekday: "short" }).replace(/^./, (c) => c.toUpperCase());
    } catch {
      return d.toLocaleDateString("es-ES", { weekday: "short" }).replace(/^./, (c) => c.toUpperCase());
    }
  }
  try {
    return d.toLocaleDateString("es-ES", { timeZone: s.timezone, day: "2-digit", month: "2-digit" });
  } catch {
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" });
  }
}

function initials(label) {
  return (label || "?").slice(0, 2).toUpperCase();
}

// Telegram le da a cada contacto un color de fondo de avatar distinto (fijo
// para ese contacto, no aleatorio cada vez) sacado de un puñado de colores -
// asi es mas facil reconocer de un vistazo quien es quien en la lista de
// chats. AVATAR_COLOR_CLASSES son esos colores (ver .avatar-color-N en
// style.css); avatarColorClass elige siempre el mismo para el mismo chat
// (hash simple del id/titulo, sin nada aleatorio de por medio).
const AVATAR_COLOR_CLASSES = ["avatar-color-0", "avatar-color-1", "avatar-color-2", "avatar-color-3", "avatar-color-4", "avatar-color-5", "avatar-color-6"];
function avatarColorClass(seed) {
  const s = String(seed || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return AVATAR_COLOR_CLASSES[Math.abs(hash) % AVATAR_COLOR_CLASSES.length];
}

/** Avatar con foto de perfil real (si Telegram la tiene) con las iniciales como fondo/fallback. */
function avatarEl(accountId, chatId, title) {
  const wrap = el("div", { class: "account-avatar contact-avatar " + avatarColorClass(chatId || title) }, initials(title));
  if (accountId && chatId) {
    const img = el("img", { src: `${API_BASE}/accounts/${accountId}/dialogs/${chatId}/avatar`, loading: "lazy", class: "avatar-img" });
    img.addEventListener("error", () => img.remove());
    wrap.appendChild(img);
  }
  return wrap;
}

/** Avatar de la propia cuenta (modelo), con foto real de Telegram si la tiene. */
function accountAvatarEl(accountId, title, extraClass) {
  const wrap = el("div", { class: "account-avatar" + (extraClass ? " " + extraClass : "") }, initials(title));
  const img = el("img", { src: `${API_BASE}/accounts/${accountId}/avatar`, loading: "lazy", class: "avatar-img" });
  img.addEventListener("error", () => img.remove());
  wrap.appendChild(img);
  return wrap;
}

/** Avatar de quien ha solicitado unirse a un canal free (lista de
 * solicitudes pendientes) - mismo patrón que avatarEl, pero pidiendo la
 * foto por userId+accessHash (ver /free-channels/requester-avatar en el
 * backend) porque este fan no tiene por qué estar en los dialogos de la
 * cuenta. */
function requesterAvatarEl(accountId, r) {
  const wrap = el("div", { class: "account-avatar contact-avatar " + avatarColorClass(r.userId || r.name) }, initials(r.name));
  if (accountId && r.userId && r.accessHash) {
    const img = el("img", {
      src: `${API_BASE}/accounts/${accountId}/free-channels/requester-avatar?userId=${encodeURIComponent(r.userId)}&accessHash=${encodeURIComponent(r.accessHash)}`,
      loading: "lazy",
      class: "avatar-img",
    });
    img.addEventListener("error", () => img.remove());
    wrap.appendChild(img);
  }
  return wrap;
}

function confirmModal({ title, body, confirmLabel = "Confirmar", danger = false }) {
  return new Promise((resolve) => {
    const backdrop = el("div", { class: "modal-backdrop" });
    const modal = el("div", { class: "modal" }, [
      el("h3", {}, title),
      el("div", { style: "font-size:13.5px;color:var(--cream-dim);line-height:1.5" }, body),
      el("div", { class: "actions" }, [
        el("button", { class: "ghost", onclick: () => { backdrop.remove(); resolve(false); } }, "Cancelar"),
        el("button", { class: danger ? "danger" : "primary", onclick: () => { backdrop.remove(); resolve(true); } }, confirmLabel),
      ]),
    ]);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  });
}

function openModal(contentBuilder, { wide = false } = {}) {
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const modal = el("div", { class: "modal" + (wide ? " wide" : "") });
  contentBuilder(modal, () => backdrop.remove());
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  return () => backdrop.remove();
}

// ---------- sidebar (secciones) ----------

const SECTIONS = [
  { key: "mensajes", label: "Mensajes", icon: "💬", enabled: true },
  { key: "mensajes-pro", label: "Mensajes Pro", icon: "⭐", enabled: true, opensWindow: true },
  { key: "canales-free", label: "Canales free", icon: "📣", enabled: true },
  { key: "sfs", label: "SFS", icon: "🔄", enabled: true },
  { key: "guiones", label: "Guiones", icon: "📝", enabled: true },
  { key: "programar-posts", label: "Programar posts", icon: "🗓️", enabled: true },
  { key: "reenviador", label: "Reenviador", icon: "📤", enabled: true },
  { key: "detector-pagos", label: "Detector de pagos", icon: "🛡️", enabled: true },
  { key: "whatsapp", label: "Conectar WhatsApp", icon: "📱", enabled: true },
  { key: "pagos", label: "Pagos", icon: "💳", enabled: true },
  { key: "revision", label: "Revisión", icon: "📋", enabled: false },
  { key: "informes", label: "Informes", icon: "📊", enabled: true },
  { key: "configuracion", label: "Configuración", icon: "⚙️", enabled: true },
  { key: "ayuda", label: "Ayuda", icon: "❓", enabled: true },
];

// Dentro de "Mensajes" la barra se minimiza a solo iconos (como en el panel
// de referencia): ahí el nombre de cada sección se ve solo como tooltip al
// pasar el ratón. En el resto de vistas (Reenviador, Configuración...) se ve
// completa, con el icono y el nombre al lado, también como en el panel de
// referencia.
function renderSidenav() {
  const collapsed = state.currentView === "mensajes" || (state.currentView === "sfs" && sfsSubTab === "chat");
  if (sidebarEl) sidebarEl.classList.toggle("sidebar-collapsed", collapsed);
  sidenavEl.innerHTML = "";
  // renderSidenav SOLO se llama para la cuenta luxe (un trabajador, tenga
  // el rol que tenga, siempre acaba en renderWorkerRestrictedShell con su
  // propia barra, ver init()) - así que quien está aquí es, siempre, el
  // Dueño/Jefe. Se enseña igual que un rol más, para que quede claro que
  // hay 3 (Dueño/Jefe, Team líder, Chatter) y no solo 2.
  const ownerBadgeTooltip = collapsed ? { "data-tooltip": (state.ownerName || "El dueño") + " · Dueño/Jefe" } : {};
  sidenavEl.appendChild(el("div", { class: "nav-item owner-identity-badge", ...ownerBadgeTooltip }, [
    el("span", { class: "nav-icon" }, "👑"),
    el("span", { class: "nav-label" }, [
      el("div", {}, state.ownerName || "El dueño"),
      el("div", { class: "pill", style: "margin-top:2px" }, "Dueño/Jefe"),
    ]),
  ]));
  // "Viendo como": el súper-admin ha entrado a ver los datos de OTRA
  // agencia (Agencias → "Ver datos", ver openAgenciasView) - se deja
  // siempre visible, en cualquier apartado, para no perder de vista que no
  // está mirando su propia agencia, con un botón para volver directamente
  // sin tener que ir a Agencias.
  if (state.isSuperAdmin && !state.viewingOwnAgency) {
    const exitBtn = el("button", { class: "sm viewing-as-exit-btn" }, "Volver a tu agencia");
    exitBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      exitBtn.disabled = true;
      try {
        await api("/agencies/exit-view-as", { method: "POST" });
        window.location.reload();
      } catch (err) {
        toast(err.message, true);
        exitBtn.disabled = false;
      }
    });
    const bannerTooltip = collapsed ? { "data-tooltip": `Viendo como ${state.ownerName || "otra agencia"} · clic para volver a la tuya` } : {};
    sidenavEl.appendChild(el("div", {
      class: "nav-item viewing-as-banner",
      ...bannerTooltip,
      onclick: collapsed ? (e) => { e.preventDefault(); exitBtn.click(); } : null,
    }, [
      el("span", { class: "nav-icon" }, "👁️"),
      el("span", { class: "nav-label" }, [
        el("div", {}, "Viendo como:"),
        el("div", { style: "font-weight:700" }, state.ownerName || "otra agencia"),
      ]),
    ]));
    if (!collapsed) sidenavEl.appendChild(exitBtn);
  }
  // Multi-agencia: solo el súper-admin (tú, con PANEL_USERNAME/PANEL_PASSWORD
  // de Railway) ve este acceso - el dueño de una agencia invitada nunca lo ve,
  // ni siquiera sabe que existe.
  if (state.isSuperAdmin) {
    const tooltipAttrs = collapsed ? { "data-tooltip": "Agencias" } : {};
    sidenavEl.appendChild(el("a", {
      class: "nav-item" + (state.currentView === "agencias" ? " active" : ""),
      href: "#",
      ...tooltipAttrs,
      onclick: (e) => { e.preventDefault(); closeMobileNav(); goToView("agencias"); },
    }, [
      el("span", { class: "nav-icon" }, "🏢"),
      el("span", { class: "nav-label" }, "Agencias"),
    ]));
  }
  for (const s of SECTIONS) {
    const tooltip = s.enabled ? s.label : `${s.label} (próximamente)`;
    const content = [
      el("span", { class: "nav-icon" }, s.icon),
      el("span", { class: "nav-label" }, s.label),
      !s.enabled ? el("span", { class: "nav-soon" }, "pronto") : null,
    ];
    // El tooltip solo hace falta cuando esta minimizada (si no, el nombre
    // ya se ve escrito al lado del icono).
    const tooltipAttrs = collapsed ? { "data-tooltip": tooltip } : {};
    if (s.enabled) {
      sidenavEl.appendChild(el("a", {
        class: "nav-item" + (s.key === state.currentView ? " active" : ""),
        href: "#",
        ...tooltipAttrs,
        onclick: (e) => {
          e.preventDefault();
          closeMobileNav();
          // Mensajes Pro es una ventana/pestaña aparte de verdad, no una
          // sección más dentro de esta app (así trabaja igual de rápido e
          // independiente aunque la app normal se quede cargando algo).
          if (s.opensWindow) { window.open("/mensajes-pro", "_blank"); return; }
          goToView(s.key);
        },
      }, content));
    } else {
      sidenavEl.appendChild(el("div", { class: "nav-item disabled", ...tooltipAttrs }, content));
    }
  }
  // Solo tiene sentido cerrar sesión aquí si se entró por el portal /login
  // (cookie propia) - si el dueño sigue usando Basic Auth "de toda la
  // vida" (curl, o una sesión vieja del navegador), no hay cookie que
  // borrar y el botón no haría nada útil, así que no se muestra.
  // "Modo shadow": solo lo ve quien llega hasta renderSidenav() -es decir,
  // solo el dueño/admin, nunca un trabajador (a un trabajador siempre se le
  // arma renderWorkerRestrictedShell() en su lugar, ver init())-, así que no
  // hace falta ninguna comprobación de rol aparte aquí.
  navRerender = renderSidenav;
  sidenavEl.appendChild(buildThemeNavItem(collapsed));

  const shadowTooltip = collapsed ? { "data-tooltip": "Modo shadow" } : {};
  sidenavEl.appendChild(el("a", {
    class: "nav-item shadow-mode-item" + (state.shadowModeEnabled ? " shadow-mode-on" : ""),
    href: "#",
    ...shadowTooltip,
    onclick: (e) => { e.preventDefault(); toggleShadowMode(); },
  }, [
    el("span", { class: "nav-icon" }, "🕶️"),
    el("span", { class: "nav-label" }, "Modo shadow"),
    el("span", { class: "shadow-mode-switch" + (state.shadowModeEnabled ? " on" : "") }, state.shadowModeEnabled ? "ON" : "OFF"),
  ]));

  if (state.ownerSessionCookie) {
    const logoutTooltip = collapsed ? { "data-tooltip": "Cerrar sesión" } : {};
    sidenavEl.appendChild(el("a", {
      class: "nav-item worker-logout-item",
      href: "#",
      ...logoutTooltip,
      onclick: (e) => { e.preventDefault(); ownerLogout(); },
    }, [
      el("span", { class: "nav-icon" }, "🚪"),
      el("span", { class: "nav-label" }, "Cerrar sesión"),
    ]));
  }
}

/** Activa/desactiva el modo shadow (solo dueño/admin, ver renderSidenav): el
 * backend fuerza el estado "desconectado" en Telegram para todas las
 * cuentas ya conectadas al momento (y para las que se conecten después,
 * mientras siga activo) - ver POST /api/settings/shadow-mode y
 * connectionPool.ts. */
/** Modo oscuro/claro: se guarda en localStorage (por navegador) y se aplica
 * con data-theme en <html> (ver bloque "Modo oscuro" de style.css). */
let navRerender = null; // re-dibuja la barra lateral que esté activa (dueño o trabajador)

function buildThemeNavItem(collapsed) {
  const darkOn = document.documentElement.getAttribute("data-theme") === "dark";
  return el("a", {
    class: "nav-item",
    href: "#",
    ...(collapsed ? { "data-tooltip": "Modo oscuro" } : {}),
    onclick: (e) => { e.preventDefault(); toggleTheme(); },
  }, [
    el("span", { class: "nav-icon" }, darkOn ? "☀️" : "🌙"),
    el("span", { class: "nav-label" }, darkOn ? "Modo claro" : "Modo oscuro"),
  ]);
}

function toggleTheme() {
  const goDark = document.documentElement.getAttribute("data-theme") !== "dark";
  if (goDark) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("lureqo_theme", goDark ? "dark" : "light"); } catch {}
  if (navRerender) navRerender();
}

async function toggleShadowMode() {
  const next = !state.shadowModeEnabled;
  try {
    const res = await api("/settings/shadow-mode", { method: "POST", body: JSON.stringify({ enabled: next }) });
    state.shadowModeEnabled = !!res.enabled;
  } catch (err) {
    toast("No se pudo cambiar el modo shadow: " + err.message);
    return;
  }
  renderSidenav();
  toast(state.shadowModeEnabled ? "Modo shadow activado: ahora eres invisible en Telegram" : "Modo shadow desactivado");
}

function goToView(view) {
  if (view !== "mensajes") closeMensajesLiveConnection();
  if (view !== "whatsapp" && typeof stopWaStatusPoll === "function") stopWaStatusPoll();
  state.currentView = view;
  renderSidenav();
  // El Detector de pagos usa el ancho completo (sin la columna de cuentas),
  // como Mensajes Pro: hay que quitar esa clase al salir a cualquier otra
  // sección o se quedaría pegada.
  // "Conectar WhatsApp" usa el mismo ancho completo que Detector de pagos.
  document.body.classList.toggle("detector-pagos-mode", view === "detector-pagos" || view === "whatsapp" || view === "pagos" || view === "agencias");
  if (view === "reenviador" || view === "mensajes") {
    renderAccountList();
    if (state.currentAccountId) {
      selectAccount(state.currentAccountId);
    } else if (state.accounts.length > 0) {
      selectAccount(state.accounts[0].id);
    } else {
      appEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "empty" }, "No hay cuentas dadas de alta todavía."));
    }
  } else if (view === "configuracion") {
    openConfiguracion();
  } else if (view === "informes") {
    openInformes();
  } else if (view === "guiones") {
    openGuiones();
  } else if (view === "canales-free") {
    openCanalesFreeView();
  } else if (view === "sfs") {
    openSfs();
  } else if (view === "programar-posts") {
    openProgramarPostsView();
  } else if (view === "detector-pagos") {
    openPaymentDetectorView();
  } else if (view === "whatsapp") {
    openWhatsAppView();
  } else if (view === "pagos") {
    openPagosView();
  } else if (view === "agencias") {
    openAgenciasView();
  } else if (view === "ayuda") {
    openAyuda();
  }
}

// ---------- Ayuda (preguntas frecuentes, visible para cualquier rol) ----------
// A diferencia del resto de secciones, esta la ve también un Chatter o Team
// líder tal cual (ver renderWorkerNav más abajo), por eso vive como función
// aparte en vez de colgar de ninguna de las vistas "solo dueño". El
// contenido es fijo (no depende de la cuenta ni de la agencia); lo único
// que habla con el backend es el formulario de contacto de abajo del todo.
// La mitad larga de esta lista está pensada para quien más usa el apartado
// de Ayuda: Team líder y, sobre todo, Chatter (atienden chats todo el día
// y son quienes menos partes del panel han tocado) - por eso no aparece
// nada de lo que un Chatter ni siquiera tiene en su menú (Reenviador,
// Detector de pagos, Cuentas de Telegram, Equipo... todo eso es solo del
// Dueño/Jefe, ver renderSidenav más arriba). El Dueño/Jefe la ve igual,
// simplemente no necesita la mitad de estas respuestas.
// URL del sitio con la guía/manual (ver website/ en el repo, Next.js export
// estático servido por este mismo servidor en /crm - ver backend/src/index.ts).
// Ruta relativa a propósito: así funciona igual en luxefan.es que en
// cualquier otro dominio/puerto donde corra el backend (local, staging...).
const AYUDA_GUIDE_BASE_URL = "/crm";
const AYUDA_GUIDES = [
  {
    title: "Manual del chatter",
    subtitle: "Cada botón de la app explicado",
    url: AYUDA_GUIDE_BASE_URL + "/manual-del-chatter/",
  },
  {
    title: "Primeros pasos",
    subtitle: "Conectar cuentas, invitar al equipo...",
    url: AYUDA_GUIDE_BASE_URL + "/primeros-pasos/",
  },
  {
    title: "Qué hace LUREQO CRM",
    subtitle: "La guía completa, con ejemplos",
    url: AYUDA_GUIDE_BASE_URL + "/que-hace/",
  },
];

const AYUDA_FAQ = [
  {
    q: "¿Cómo apunto una venta?",
    a: "Desde el chat del fan (o desde Pagos) pulsa «Registrar venta» y apunta el servicio, el importe, la fecha y quién la hizo.",
  },
  {
    q: "¿Cómo le mando contenido de la bóveda a un fan?",
    a: "Con el botón de contenido del cuadro de escribir se abre la bóveda. Todo lo que se manda a un fan sale de ahí, no se adjuntan archivos sueltos del ordenador.",
  },
  {
    q: "¿Cómo mando algo para ver una vez (que se autodestruya)?",
    a: "Al elegir la foto o el vídeo de la bóveda para mandarlo, marca la casilla «🔥 Enviar para ver una vez». Se autodestruye en cuanto el fan lo abre.",
  },
  {
    q: "¿Cómo uso las respuestas rápidas?",
    a: "Escribe «/» en el cuadro de texto y salen los atajos guardados; sigue escribiendo para filtrar. Las crea quien dirige tu agencia.",
  },
  {
    q: "¿Cómo voy directo al grupo restringido de un cliente?",
    a: "En la cabecera del chat, el icono 👥 «Ir al grupo restringido de este cliente» te lleva directo a su grupo (y lo crea si todavía no existe), sin pasar por la lista de grupos en común.",
  },
  {
    q: "Un filtro de carpeta (Posibles, Clientes...) no me enseña nada, ¿por qué?",
    a: "Esos filtros usan el nombre real que le pusiste a esa carpeta en tu propio Telegram. Pídele a quien dirige tu agencia que lo configure en Configuración → Carpetas de Telegram.",
  },
  {
    q: "¿Por qué no veo algunos chats en Mensajes?",
    a: "Mensajes solo enseña las cuentas que tu agencia te ha dado permiso de ver, tus conversaciones privadas con fans en ellas y los grupos pequeños (menos de 3 miembros). Si crees que te falta algo, pregúntale a quien dirige tu agencia.",
  },
  {
    q: "¿Cómo ficho la entrada y la salida?",
    a: "Con el reloj que sale abajo del menú: fichas la entrada al empezar tu turno y la salida al terminar. De ahí salen tus horas trabajadas, tu rendimiento y tu nómina.",
  },
  {
    q: "¿Cómo hago un descanso (break)?",
    a: "En el mismo reloj, el botón «☕ Descanso» lo empieza y descuenta de tu cupo del día; pulsa otra vez (o «Terminar descanso») para acabarlo. Si se agota el cupo, no se puede abrir otro hasta el día siguiente.",
  },
  {
    q: "¿Dónde veo los pagos de hoy?",
    a: "En Pagos: lo que ha entrado hoy por Stripe y PayPal de la agencia. Solo se ve el día en curso; el histórico completo lo lleva quien dirige tu agencia.",
  },
  {
    q: "¿Dónde veo mis nóminas?",
    a: "En Nóminas: las que tu agencia ya te ha generado, con botones para descargarlas en PDF o Word.",
  },
  {
    q: "¿Dónde veo mi rendimiento?",
    a: "En Mi rendimiento: tus ventas, tus horas trabajadas y tus mensajes enviados, en el periodo de fechas que elijas.",
  },
  {
    q: "¿Qué es Mensajes Pro?",
    a: "Otra forma de ver y responder los mismos chats, en una ventana aparte (se abre en otra pestaña) - para no perder velocidad aunque Mensajes esté cargando algo a la vez.",
  },
  {
    q: 'Me aparece "Solo lectura" arriba del todo, ¿qué significa?',
    a: "Tu agencia te ha dado acceso de solo mirar: puedes ver los chats, pero enviar y guardar no va a funcionar desde tu cuenta. Si crees que es un error, pregúntale a quien dirige tu agencia.",
  },
  {
    q: "¿Qué diferencia hay entre Team líder y Chatter?",
    a: "El Team líder, además de atender chats, tiene también SFS y Programar posts. El Chatter ve solo Mensajes (de las cuentas que le hayan dado), Pagos de hoy, Nóminas y Mi rendimiento.",
  },
  {
    q: "Soy Team líder, ¿qué es SFS?",
    a: "Reenvía contenido a un chat o a un grupo/canal fijo de la creadora sin desvelar quién lo manda (pestañas «Chat» y «Grupo SFS»). Solo lo ve el Team líder, nunca el Chatter.",
  },
  {
    q: "Soy Team líder, ¿cómo programo un post?",
    a: "Desde Programar posts eliges el contenido, la fecha y la hora, y el panel lo publica solo cuando toca - no hace falta estar delante en ese momento. Solo lo ve el Team líder.",
  },
];

function renderAyudaView(container) {
  container.innerHTML = "";
  const wrap = el("div", { class: "ayuda-view" });

  const header = el("div", { class: "ayuda-header" }, [
    el("h1", {}, "Ayuda"),
    el("p", { class: "hint" }, "¿Algo no funciona o no sabes cómo se hace? Escríbenos."),
  ]);
  wrap.appendChild(header);

  const searchInput = el("input", { placeholder: "Buscar: venta, bóveda, break, carpeta..." });
  const listTitle = el("h3", {}, "Preguntas frecuentes");
  const listEl = el("div", { class: "ayuda-faq-list" });

  function renderList() {
    listEl.innerHTML = "";
    const q = searchInput.value.trim().toLowerCase();
    const items = AYUDA_FAQ.filter(
      (item) => !q || item.q.toLowerCase().includes(q) || item.a.toLowerCase().includes(q)
    );
    if (items.length === 0) {
      listEl.appendChild(el("div", { class: "empty" }, "No hay ninguna pregunta que coincida. Prueba con otra palabra, o escríbenos abajo."));
      return;
    }
    for (const item of items) {
      const row = el("div", { class: "accordion-row ayuda-faq-row" }, [
        el("span", {}, item.q),
        el("span", { class: "accordion-count ayuda-faq-chevron" }, "›"),
      ]);
      const body = el("div", { class: "ayuda-faq-answer hidden" }, item.a);
      row.addEventListener("click", () => {
        const open = !body.classList.contains("hidden");
        body.classList.toggle("hidden", open);
        row.classList.toggle("ayuda-faq-row-open", !open);
      });
      listEl.appendChild(row);
      listEl.appendChild(body);
    }
  }
  searchInput.addEventListener("input", renderList);
  renderList();

  const leftCol = el("div", { class: "ayuda-col-main" }, [searchInput, listTitle, listEl]);

  const guidesCard = el("div", { class: "card ayuda-guides-card" }, [
    el("h3", {}, "Guías"),
    ...AYUDA_GUIDES.map((g) => {
      const link = el("div", { class: "ayuda-guide-link", role: "button", tabindex: "0" }, [
        el("div", { class: "ayuda-guide-link-title" }, g.title),
        el("div", { class: "ayuda-guide-link-sub" }, g.subtitle),
      ]);
      link.addEventListener("click", () => openGuideModal(g));
      link.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openGuideModal(g);
        }
      });
      return link;
    }),
  ]);
  const moreCard = el("div", { class: "card ayuda-guides-card" }, [
    el("h3", {}, "¿No está aquí lo que buscas?"),
    el("p", { class: "hint" }, "Escríbenos más abajo contándonos qué pantalla estabas mirando y qué esperabas que pasara. Lo lee directamente el equipo."),
  ]);
  const rightCol = el("div", { class: "ayuda-col-side" }, [guidesCard, moreCard]);

  wrap.appendChild(el("div", { class: "ayuda-columns" }, [leftCol, rightCol]));

  // ---- "¿No lo encuentras? Escríbenos" ----
  let kind = "ayuda"; // "ayuda" | "sugerencia"
  const tabAyuda = el("button", { type: "button", class: "sm primary" }, "🆘 Pedir ayuda");
  const tabSugerencia = el("button", { type: "button", class: "sm ghost" }, "💡 Sugerir un cambio");
  const textarea = el("textarea", {
    rows: "4",
    placeholder: "Cuéntanos qué pasa: en qué pantalla estabas, qué hiciste y qué esperabas que pasara.",
  });
  const sentHint = el("p", { class: "hint" }, "Lo lee directamente el equipo.");
  const sentList = el("div", { class: "ayuda-sent-list" }, "Todavía nada.");
  const sendBtn = el("button", { type: "button", class: "primary" }, "Enviar");

  function setKind(next) {
    kind = next;
    tabAyuda.className = "sm" + (kind === "ayuda" ? " primary" : " ghost");
    tabSugerencia.className = "sm" + (kind === "sugerencia" ? " primary" : " ghost");
  }
  tabAyuda.addEventListener("click", () => setKind("ayuda"));
  tabSugerencia.addEventListener("click", () => setKind("sugerencia"));

  sendBtn.addEventListener("click", async () => {
    const message = textarea.value.trim();
    if (!message) {
      toast("Escribe algo antes de enviar", true);
      return;
    }
    sendBtn.disabled = true;
    try {
      await api("/help-requests", { method: "POST", body: JSON.stringify({ kind, message }) });
      if (sentList.textContent === "Todavía nada.") sentList.innerHTML = "";
      sentList.appendChild(el("div", { class: "ayuda-sent-item" }, (kind === "sugerencia" ? "💡 " : "🆘 ") + message));
      textarea.value = "";
      toast("Enviado, gracias");
    } catch (err) {
      toast("No se pudo enviar: " + err.message, true);
    } finally {
      sendBtn.disabled = false;
    }
  });

  const contactCard = el("div", { class: "card ayuda-contact-card" }, [
    el("h3", {}, "¿No lo encuentras? Escríbenos"),
    el("div", { class: "ayuda-contact-tabs" }, [tabAyuda, tabSugerencia]),
    textarea,
    el("div", { class: "actions" }, [sentHint, sendBtn]),
    el("h4", {}, "Lo que has enviado"),
    sentList,
  ]);
  wrap.appendChild(contactCard);

  container.appendChild(wrap);
}

// Abre una guía (de website/) dentro de una ventana flotante del propio CRM,
// con un iframe a la página ya publicada - así el chatter no tiene que salir
// de la app ni abrir el navegador para leerla.
function openGuideModal(guide) {
  const closeBtn = el("button", { type: "button", class: "ayuda-guide-modal-close", title: "Cerrar" }, "✕");
  const openTab = el(
    "a",
    { class: "ayuda-guide-modal-open", href: guide.url, target: "_blank", rel: "noopener" },
    "Abrir en pestaña nueva ↗"
  );
  const header = el("div", { class: "ayuda-guide-modal-header" }, [
    el("div", { class: "ayuda-guide-modal-title" }, guide.title),
    el("div", { class: "ayuda-guide-modal-actions" }, [openTab, closeBtn]),
  ]);
  const iframe = el("iframe", {
    class: "ayuda-guide-modal-iframe",
    src: guide.url,
    title: guide.title,
    loading: "lazy",
  });
  const modal = el("div", { class: "ayuda-guide-modal" }, [header, iframe]);
  const overlay = el("div", { class: "ayuda-guide-modal-overlay" }, [modal]);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
}

function openAyuda() {
  accountListEl.innerHTML = "";
  renderAyudaView(appEl);
}

// ---------- Agencias (multi-agencia, solo súper-admin) ----------
// El súper-admin invita agencias nuevas desde aquí: cada una con su propio
// email/contraseña de Dueño/Jefe, que entra por el MISMO /login de siempre
// pero ve un panel completamente vacío y aislado del tuyo (sin tus cuentas
// de Telegram ni tu equipo). Tú nunca ves sus chats ni sus datos desde aquí
// -solo el alta, la suspensión y el borrado.
async function openAgenciasView() {
  accountListEl.innerHTML = "";
  appEl.innerHTML = "";
  appEl.appendChild(el("div", { class: "empty" }, "Cargando agencias..."));
  try {
    // Sin ningún control en el panel para traer las ocultas (ver Agency.hidden
    // en schema.prisma) a propósito: una agencia oculta no debe tener NINGÚN
    // rastro visible desde aquí, ni con un checkbox. Solo queda accesible por
    // API (?includeHidden=true) para un caso excepcional futuro.
    const { agencies } = await api("/agencies");
    renderAgenciasShell(agencies);
  } catch (err) {
    appEl.innerHTML = "";
    appEl.appendChild(el("div", { class: "empty" }, "Error cargando agencias: " + err.message));
  }
}

function renderAgenciasShell(agencies) {
  appEl.innerHTML = "";
  appEl.appendChild(el("div", { class: "pd-header" }, [
    el("div", {}, [
      el("h1", {}, "Agencias"),
      el("p", { class: "subtitle" }, "Invita agencias nuevas para que usen este mismo CRM con su propio panel. Con \"Ver datos\" entras a ver y gestionar todo lo suyo (cuentas, chats, equipo, pagos, nóminas...) exactamente igual que si fueras su dueño - usa \"Volver a tu agencia\" (arriba a la izquierda) para salir. Esta tabla muestra SIEMPRE todas las agencias dadas de alta, estén \"ocultas\" o no."),
    ]),
  ]));

  const form = el("div", { class: "card" });
  const nameInput = el("input", { placeholder: "Nombre de la agencia" });
  const emailInput = el("input", { type: "email", placeholder: "Email del dueño de esa agencia" });
  const passInput = el("input", { type: "text", placeholder: "Contraseña inicial (mínimo 8 caracteres)" });
  const createBtn = el("button", { class: "primary" }, "Crear agencia");
  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const ownerEmail = emailInput.value.trim();
    const ownerPassword = passInput.value;
    if (!name || !ownerEmail || !ownerPassword) {
      toast("Rellena nombre, email y contraseña.", true);
      return;
    }
    createBtn.disabled = true;
    try {
      await api("/agencies", { method: "POST", body: JSON.stringify({ name, ownerEmail, ownerPassword }) });
      toast(`Agencia "${name}" creada. Dale a su dueño el email y la contraseña para que entre en /login.`);
      nameInput.value = "";
      emailInput.value = "";
      passInput.value = "";
      openAgenciasView();
    } catch (err) {
      toast(err.message, true);
    } finally {
      createBtn.disabled = false;
    }
  });
  form.appendChild(el("h3", {}, "Invitar agencia nueva"));
  form.appendChild(el("div", { class: "form-row" }, [nameInput, emailInput, passInput, createBtn]));
  appEl.appendChild(form);

  const table = el("table", { class: "work-hours-table" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", {}, "Agencia"),
    el("th", {}, "Email del dueño"),
    el("th", {}, "Cuentas"),
    el("th", {}, "Equipo"),
    el("th", {}, "Estado"),
    el("th", {}, "Acciones"),
  ])));
  const tbody = el("tbody");
  if (agencies.length === 0) {
    tbody.appendChild(el("tr", {}, el("td", { colspan: "6", class: "empty" }, "Todavía no has invitado ninguna agencia.")));
  }
  for (const a of agencies) {
    const suspendBtn = el("button", { class: "ghost" }, a.active ? "Suspender" : "Reactivar");
    suspendBtn.addEventListener("click", async () => {
      suspendBtn.disabled = true;
      try {
        await api(`/agencies/${a.id}/active`, { method: "PUT", body: JSON.stringify({ active: !a.active }) });
        openAgenciasView();
      } catch (err) {
        toast(err.message, true);
        suspendBtn.disabled = false;
      }
    });
    const resetBtn = el("button", { class: "ghost" }, "Cambiar contraseña");
    resetBtn.addEventListener("click", async () => {
      const newPassword = prompt(`Nueva contraseña para el dueño de "${a.name}" (mínimo 8 caracteres):`);
      if (!newPassword) return;
      try {
        await api(`/agencies/${a.id}/owner-password`, { method: "PUT", body: JSON.stringify({ newPassword }) });
        toast("Contraseña actualizada.");
      } catch (err) {
        toast(err.message, true);
      }
    });
    const deleteBtn = el("button", { class: "danger" }, "Borrar");
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`¿Borrar la agencia "${a.name}" para siempre? Se borran también TODAS sus cuentas de Telegram y su equipo. Esto no se puede deshacer.`)) return;
      deleteBtn.disabled = true;
      try {
        await api(`/agencies/${a.id}`, { method: "DELETE" });
        openAgenciasView();
      } catch (err) {
        toast(err.message, true);
        deleteBtn.disabled = false;
      }
    });
    const viewAsBtn = el("button", { class: "primary" }, "Ver datos");
    viewAsBtn.addEventListener("click", async () => {
      viewAsBtn.disabled = true;
      try {
        await api(`/agencies/${a.id}/view-as`, { method: "POST" });
        window.location.reload();
      } catch (err) {
        toast(err.message, true);
        viewAsBtn.disabled = false;
      }
    });
    // El botón "Ocultar" se quitó a petición de Aitor: como dueño del CRM
    // esta tabla debe mostrar SIEMPRE todas las agencias dadas de alta, sin
    // posibilidad de que una quede escondida sin querer (ver GET
    // /api/agencies en agencies.ts, que ya no filtra por "hidden").
    tbody.appendChild(el("tr", {}, [
      el("td", {}, a.name),
      el("td", {}, a.ownerEmail),
      el("td", {}, String(a.accountsCount)),
      el("td", {}, String(a.workersCount)),
      el("td", {}, el("span", { class: "pill " + (a.active ? "ok" : "off") }, a.active ? "Activa" : "Suspendida")),
      el("td", {}, [viewAsBtn, suspendBtn, resetBtn, deleteBtn]),
    ]));
  }
  table.appendChild(tbody);
  appEl.appendChild(table);
}

// ---------- lista de cuentas ----------

function statusDotClass(acc) {
  if (!acc.reenviadorEnabled) return "off";
  // connectionStatus viene del proceso en vivo (ver getAccountConnectionStatus
  // en el backend), no de un campo cacheado en BD: si la sesion de Telegram
  // esta de verdad caida ahora mismo, se pinta en rojo aunque el reenviador
  // este encendido y no haya ningun flood - antes esto se quedaba siempre en
  // verde aunque la cuenta llevara horas sin poder hablar con Telegram.
  if (acc.connectionStatus === "disconnected") return "paused";
  if (acc.health === "PEER_FLOOD_PAUSED") return "paused";
  return "on";
}

function statusDotTitle(acc) {
  if (!acc.reenviadorEnabled) return "Reenviador apagado";
  if (acc.connectionStatus === "disconnected") return "Desconectada de Telegram ahora mismo";
  if (acc.health === "PEER_FLOOD_PAUSED") return "Pausada por límite de Telegram (flood)";
  return "Conectada";
}

function renderAccountList() {
  accountListEl.innerHTML = "";
  accountListEl.appendChild(el("div", { class: "account-list-title" }, "Cuentas"));
  // Foto de perfil real de la creadora en TODOS los apartados (antes solo se
  // veia en Mensajes); en Mensajes ademas se ve la insignia de no leidos, en
  // el resto el punto de estado del reenviador.
  const inMensajes = state.currentView === "mensajes";
  for (const acc of state.accounts) {
    const badge = inMensajes ? el("div", { class: "account-unread-badge hidden" }, "0") : null;
    accountListEl.appendChild(
      el("div", {
        class: "account-item" + (acc.id === state.currentAccountId ? " active" : ""),
        onclick: () => selectAccount(acc.id),
      }, [
        accountAvatarEl(acc.id, acc.label),
        el("div", { class: "account-name" }, acc.label),
        inMensajes ? badge : el("div", { class: "status-dot " + statusDotClass(acc), title: statusDotTitle(acc) }),
      ])
    );
    if (inMensajes) {
      api(`/accounts/${acc.id}/unread-summary`).then((res) => {
        if (res.totalUnread > 0) {
          badge.textContent = String(res.totalUnread);
          badge.classList.remove("hidden");
        }
      }).catch(() => {
        // si falla, simplemente no se muestra la insignia esta vez
      });
    }
  }
}

async function selectAccount(id) {
  state.currentAccountId = id;
  renderAccountList();
  if (state.currentView === "mensajes") {
    await renderMensajesView(id);
  } else {
    await renderAccountView(id);
  }
}

// ---------- Canales free (solicitudes de unión pendientes) ----------

// Igual que con Modelos: se recuerda la cuenta/canal elegidos mientras dura
// la sesión del navegador, para no perder el sitio al ir y volver.
let canalesFreeAccountId = null;
let canalesFreeSelectedChannelId = null;
let sfsAccountId = null;
let sfsSubTab = "chat"; // "chat" | "jap"
let programarPostsAccountId = null;
let programarPostsStatusFilter = "PENDING"; // "PENDING" | "all"
let programarPostsTab = "canales"; // "canales" | "historias" | "publicadas"

async function openCanalesFreeView() {
  if (state.accounts.length === 0) {
    try {
      state.accounts = (await api("/accounts")).accounts;
    } catch {
      // se comprueba de nuevo mas abajo si sigue vacio
    }
  }
  if (!canalesFreeAccountId || !state.accounts.some((a) => a.id === canalesFreeAccountId)) {
    canalesFreeAccountId = state.accounts[0] ? state.accounts[0].id : null;
  }
  renderCanalesFreeAccountList();
  await renderCanalesFreeView();
}

function selectCanalesFreeAccount(id) {
  if (canalesFreeAccountId === id) return;
  canalesFreeAccountId = id;
  canalesFreeSelectedChannelId = null;
  renderCanalesFreeAccountList();
  renderCanalesFreeView();
}

function renderCanalesFreeAccountList() {
  accountListEl.innerHTML = "";
  accountListEl.appendChild(el("div", { class: "account-list-title" }, "Cuentas"));
  for (const acc of state.accounts) {
    accountListEl.appendChild(el("div", {
      class: "account-item" + (acc.id === canalesFreeAccountId ? " active" : ""),
      onclick: () => selectCanalesFreeAccount(acc.id),
    }, [
      accountAvatarEl(acc.id, acc.label),
      el("div", { class: "account-name" }, acc.label),
    ]));
  }
}

async function renderCanalesFreeView() {
  appEl.innerHTML = "";
  if (!canalesFreeAccountId) {
    appEl.appendChild(el("div", { class: "empty" }, "No hay cuentas dadas de alta todavía."));
    return;
  }
  appEl.appendChild(el("h1", {}, "Canales free"));
  appEl.appendChild(el("p", { class: "subtitle" }, "Solicitudes de unión pendientes de los canales free configurados en Configuración → Modelos."));

  const layout = el("div", { class: "canales-free-layout" });
  const channelsListEl = el("div", { class: "canales-free-channels" });
  const requestsEl = el("div", { class: "canales-free-requests" });
  layout.appendChild(channelsListEl);
  layout.appendChild(requestsEl);
  appEl.appendChild(layout);

  channelsListEl.appendChild(el("div", { class: "empty" }, "Cargando canales..."));
  let channels;
  try {
    const res = await api(`/accounts/${canalesFreeAccountId}/free-channels`);
    channels = res.channels;
  } catch (err) {
    channelsListEl.innerHTML = "";
    channelsListEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    return;
  }
  channelsListEl.innerHTML = "";
  if (channels.length === 0) {
    channelsListEl.appendChild(el("div", { class: "empty" }, "Esta cuenta no tiene canales free configurados todavía."));
    requestsEl.appendChild(el("div", { class: "empty" }, "Añádelos desde Configuración → Modelos → esta creadora → \"Canales free\"."));
    return;
  }
  if (!canalesFreeSelectedChannelId || !channels.some((c) => c.id === canalesFreeSelectedChannelId)) {
    canalesFreeSelectedChannelId = channels[0].id;
  }

  function renderChannelsList() {
    channelsListEl.innerHTML = "";
    for (const c of channels) {
      channelsListEl.appendChild(el("div", {
        class: "canales-free-channel-item" + (c.id === canalesFreeSelectedChannelId ? " active" : ""),
        onclick: () => {
          if (canalesFreeSelectedChannelId === c.id) return;
          canalesFreeSelectedChannelId = c.id;
          renderChannelsList();
          renderRequests();
        },
      }, [
        el("div", { class: "canales-free-channel-title" }, c.title),
        c.pendingCount ? el("span", { class: "canales-free-channel-badge" }, String(c.pendingCount)) : null,
      ]));
    }
  }

  // Estado de paginación de la página actualmente cargada: se guardan las
  // solicitudes ya traídas (requestsLoaded) más el cursor para pedir la
  // siguiente tanda ("Cargar más"), igual que hace Telegram con
  // offsetDate/offsetUserId - así un canal con miles de solicitudes (ver
  // "Mery Sweetie" con 1061 en el panel de referencia) no se corta en 200.
  let requestsLoaded = [];
  let requestsHasMore = false;
  let requestsNextOffsetDate = null;
  let requestsNextOffsetUserId = null;
  let requestsTotal = 0;

  async function fetchRequestsPage(channel, offsetDate, offsetUserId) {
    const qs = new URLSearchParams();
    if (offsetDate) qs.set("offsetDate", String(offsetDate));
    if (offsetUserId) qs.set("offsetUserId", offsetUserId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return api(`/accounts/${canalesFreeAccountId}/free-channels/${channel.id}/join-requests${suffix}`);
  }

  // reset=true: recarga desde cero (cambio de canal, "Actualizar"). false:
  // añade la siguiente página ("Cargar más") a lo ya mostrado.
  async function renderRequests(reset = true) {
    const channel = channels.find((c) => c.id === canalesFreeSelectedChannelId);
    if (!channel) return;
    if (reset) {
      requestsEl.innerHTML = "";
      requestsEl.appendChild(el("div", { class: "empty" }, "Cargando solicitudes..."));
      requestsLoaded = [];
      requestsNextOffsetDate = null;
      requestsNextOffsetUserId = null;
    }
    let res;
    try {
      res = await fetchRequestsPage(channel, reset ? null : requestsNextOffsetDate, reset ? null : requestsNextOffsetUserId);
    } catch (err) {
      requestsEl.innerHTML = "";
      requestsEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }
    requestsLoaded = reset ? res.requests : requestsLoaded.concat(res.requests);
    requestsHasMore = res.hasMore;
    requestsNextOffsetDate = res.nextOffsetDate;
    requestsNextOffsetUserId = res.nextOffsetUserId;
    requestsTotal = res.total;
    paintRequests(channel);
  }

  function paintRequests(channel) {
    requestsEl.innerHTML = "";
    const countLabel = requestsTotal > requestsLoaded.length
      ? `${requestsLoaded.length} de ${requestsTotal} pendientes`
      : `${requestsLoaded.length} pendiente${requestsLoaded.length === 1 ? "" : "s"}`;
    requestsEl.appendChild(el("div", { class: "section-title-row" }, [
      el("div", {}, [
        el("h2", {}, channel.title),
        el("div", { class: "hint" }, countLabel),
      ]),
      el("div", { class: "canales-free-header-actions" }, [
        el("button", { class: "secondary", onclick: () => renderRequests(true) }, "🔄 Actualizar"),
        requestsTotal > 0 ? el("button", { class: "danger", onclick: () => bulkDecide(channel, false) }, `Rechazar todas (${requestsTotal})`) : null,
        requestsTotal > 0 ? el("button", { class: "primary", onclick: () => bulkDecide(channel, true) }, `Aceptar todas (${requestsTotal})`) : null,
      ]),
    ]));
    if (requestsLoaded.length === 0) {
      requestsEl.appendChild(el("div", { class: "empty" }, "Sin solicitudes pendientes."));
      return;
    }
    for (const r of requestsLoaded) {
      const acceptBtn = el("button", { class: "primary" }, "Aceptar");
      const rejectBtn = el("button", { class: "danger" }, "Rechazar");
      async function decide(approve) {
        acceptBtn.disabled = true;
        rejectBtn.disabled = true;
        try {
          await api(`/accounts/${canalesFreeAccountId}/free-channels/${channel.id}/join-requests/decide`, {
            method: "POST",
            body: JSON.stringify({ userId: r.userId, accessHash: r.accessHash, approve }),
          });
          toast(approve ? "Solicitud aceptada" : "Solicitud rechazada");
          if (typeof channel.pendingCount === "number") channel.pendingCount = Math.max(0, channel.pendingCount - 1);
          requestsLoaded = requestsLoaded.filter((x) => x.userId !== r.userId);
          requestsTotal = Math.max(0, requestsTotal - 1);
          renderChannelsList();
          paintRequests(channel);
        } catch (err) {
          toast(err.message, true);
          acceptBtn.disabled = false;
          rejectBtn.disabled = false;
        }
      }
      acceptBtn.addEventListener("click", () => decide(true));
      rejectBtn.addEventListener("click", () => decide(false));
      requestsEl.appendChild(el("div", { class: "canales-free-request-row" }, [
        requesterAvatarEl(canalesFreeAccountId, r),
        el("div", { class: "canales-free-request-info" }, [
          el("div", { style: "font-weight:600" }, r.username ? `${r.name} @${r.username}` : r.name),
          r.about ? el("div", { class: "hint" }, r.about) : null,
        ]),
        el("div", { class: "canales-free-request-actions" }, [acceptBtn, rejectBtn]),
      ]));
    }
    if (requestsHasMore) {
      requestsEl.appendChild(el("div", { class: "canales-free-load-more" }, [
        el("button", { class: "secondary", onclick: () => renderRequests(false) }, "Cargar más solicitudes"),
      ]));
    }
  }

  // Aceptar/rechazar en bloque, repitiendo la llamada mientras el backend
  // diga que quedan más solicitudes por lotes (hasMore) — así funciona igual
  // si hay 5 solicitudes que si hay 5000.
  async function bulkDecide(channel, approve) {
    const verb = approve ? "aceptar" : "rechazar";
    if (!window.confirm(`¿${approve ? "Aceptar" : "Rechazar"} TODAS las solicitudes pendientes de "${channel.title}"? Esta acción no se puede deshacer.`)) return;
    const endpoint = approve ? "accept-all" : "reject-all";
    let hasMore = true;
    let totalDone = 0;
    while (hasMore) {
      try {
        const res = await api(`/accounts/${canalesFreeAccountId}/free-channels/${channel.id}/join-requests/${endpoint}`, { method: "POST" });
        totalDone += approve ? res.accepted : res.rejected;
        hasMore = res.hasMore;
      } catch (err) {
        toast(err.message, true);
        break;
      }
    }
    channel.pendingCount = 0;
    toast(`${totalDone} solicitudes ${approve ? "aceptadas" : "rechazadas"}`);
    renderChannelsList();
    await renderRequests(true);
  }

  renderChannelsList();
  await renderRequests(true);
}

// ---------- SFS (Shoutout For Shoutout) ----------
//
// Dos sub-apartados: "Chat" (los mismos chats de Telegram que Mensajes, con
// notas propias - ver renderMensajesView/renderSfsNotesPanel) y "Just
// Another Panel" (comprar vistas/miembros/reacciones... contra la API del
// panel SMM, ver src/api/jap.ts). Por ahora es solo para el dueño (sin
// reparto de permisos por trabajador todavía).

async function openSfs() {
  if (state.accounts.length === 0) {
    try {
      state.accounts = (await api("/accounts")).accounts;
    } catch {
      // se comprueba de nuevo mas abajo si sigue vacio
    }
  }
  if (!sfsAccountId || !state.accounts.some((a) => a.id === sfsAccountId)) {
    sfsAccountId = state.accounts[0] ? state.accounts[0].id : null;
  }
  renderSfsAccountList();
  await renderSfsSection();
}

function selectSfsAccount(id) {
  if (sfsAccountId === id) return;
  sfsAccountId = id;
  renderSfsAccountList();
  renderSfsSection();
}

function setSfsSubTab(tab) {
  if (sfsSubTab === tab) return;
  sfsSubTab = tab;
  renderSidenav(); // el chat colapsa la barra lateral, el panel JAP no
  renderSfsAccountList();
  renderSfsSection();
}

function renderSfsAccountList() {
  accountListEl.innerHTML = "";
  if (sfsSubTab === "jap") {
    // Just Another Panel es del panel entero, no hace falta elegir cuenta
    // para verlo (la cuenta del pedido se elige dentro del formulario).
    return;
  }
  accountListEl.appendChild(el("div", { class: "account-list-title" }, "Cuentas"));
  for (const acc of state.accounts) {
    accountListEl.appendChild(el("div", {
      class: "account-item" + (acc.id === sfsAccountId ? " active" : ""),
      onclick: () => selectSfsAccount(acc.id),
    }, [
      accountAvatarEl(acc.id, acc.label),
      el("div", { class: "account-name" }, acc.label),
    ]));
  }
}

async function renderSfsSection() {
  appEl.innerHTML = "";
  const tabsRow = el("div", { class: "informes-presets" }, [
    el("button", { class: "sm" + (sfsSubTab === "chat" ? " primary" : ""), onclick: () => setSfsSubTab("chat") }, "Chat"),
    el("button", { class: "sm" + (sfsSubTab === "jap" ? " primary" : ""), onclick: () => setSfsSubTab("jap") }, "Just Another Panel"),
    el("button", { class: "sm" + (sfsSubTab === "grupo" ? " primary" : ""), onclick: () => setSfsSubTab("grupo") }, "Grupo SFS"),
  ]);
  appEl.appendChild(tabsRow);

  const body = el("div", { class: "sfs-body" });
  appEl.appendChild(body);

  if (sfsSubTab === "chat") {
    if (!sfsAccountId) {
      body.appendChild(el("div", { class: "empty" }, "No hay cuentas dadas de alta todavía."));
      return;
    }
    await renderMensajesView(sfsAccountId, body, { sfsMode: true });
  } else if (sfsSubTab === "grupo") {
    if (!sfsAccountId) {
      body.appendChild(el("div", { class: "empty" }, "No hay cuentas dadas de alta todavía."));
      return;
    }
    await renderSfsGroupView(sfsAccountId, body);
  } else {
    await renderJapView(body);
  }
}

// ---------- SFS → "Grupo SFS": canal/grupo fijo por creadora para mandar
// mensajes sueltos sin tener que ir a buscarlo cada vez en "Chat". El canal
// elegido se guarda de forma permanente (Account.sfsGroupChatId/
// sfsGroupTitle), igual que la carpeta de "Chat" (ver sfsFolder) - al volver
// a esta pestaña con la misma creadora ya está listo para escribir. ----------

async function renderSfsGroupView(accountId, container) {
  container.innerHTML = "";
  const acc = state.accounts.find((a) => a.id === accountId);
  container.appendChild(el("h1", {}, "Grupo SFS"));
  container.appendChild(el("p", { class: "subtitle" }, "Elige el canal o grupo fijo donde coordinas los SFS de esta creadora, y reenvíale mensajes que ya existan en cualquier chat, con o sin remitente."));

  const groupSelect = el("select", { class: "filter-list-select" }, [el("option", { value: "" }, "Elige un canal/grupo...")]);
  container.appendChild(el("div", { class: "field" }, [el("label", {}, "Canal/grupo fijo (destino)"), groupSelect]));

  const sourceSelect = el("select", { class: "filter-list-select" }, [el("option", { value: "" }, "Elige un chat...")]);
  container.appendChild(el("div", { class: "field" }, [el("label", {}, "Chat de origen (de dónde sacar el mensaje)"), sourceSelect]));

  const hideSenderCheck = el("input", { type: "checkbox", checked: "checked" });
  container.appendChild(el("label", { class: "folder-checkbox-row" }, [hideSenderCheck, el("span", {}, "Ocultar remitente al reenviar (llega sin \"Reenviado de...\")")]));

  const messagesListEl = el("div", { class: "sfs-group-messages" });
  container.appendChild(messagesListEl);

  const savedChatId = acc?.sfsGroupChatId || "";
  let dialogs = [];

  // --- Canal/grupo fijo (destino): se guarda de forma permanente, igual que la carpeta de "Chat" ---
  const loadingOption = el("option", { value: "", disabled: true }, "Cargando canales/grupos...");
  groupSelect.appendChild(loadingOption);
  try {
    const res = await api(`/accounts/${accountId}/sfs-dialogs`);
    dialogs = res.dialogs || [];
    loadingOption.remove();
    if (dialogs.length === 0) {
      groupSelect.appendChild(el("option", { value: "", disabled: true }, "Esta cuenta no tiene grupos/canales en Telegram"));
    } else {
      for (const d of dialogs) {
        groupSelect.appendChild(el("option", { value: d.chatId }, d.title));
        sourceSelect.appendChild(el("option", { value: d.chatId }, d.title));
      }
      if (savedChatId && dialogs.some((d) => d.chatId === savedChatId)) {
        groupSelect.value = savedChatId;
      } else if (savedChatId) {
        // Guardado pero ya no aparece en la lista (p.ej. salió del grupo):
        // se deja elegido igualmente con el título guardado, para no perder
        // de vista cuál era, aunque haya que elegir otro para poder reenviar.
        groupSelect.appendChild(el("option", { value: savedChatId }, `${acc.sfsGroupTitle || savedChatId} (ya no disponible)`));
        groupSelect.value = savedChatId;
      }
    }
  } catch (err) {
    loadingOption.remove();
    groupSelect.appendChild(el("option", { value: "", disabled: true }, "Error al cargar canales/grupos"));
    toast("No se pudieron cargar los canales/grupos de Telegram: " + err.message, true);
  }

  groupSelect.addEventListener("change", () => {
    const chatId = groupSelect.value;
    const title = (dialogs.find((d) => d.chatId === chatId) || {}).title || groupSelect.options[groupSelect.selectedIndex]?.textContent || "";
    // Se guarda en segundo plano - si falla, se reintenta solo la próxima
    // vez que se cambie de canal fijo.
    api(`/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ sfsGroupChatId: chatId || null, sfsGroupTitle: chatId ? title : null }),
    }).then(() => {
      if (acc) {
        acc.sfsGroupChatId = chatId || null;
        acc.sfsGroupTitle = chatId ? title : null;
      }
    }).catch(() => {});
  });

  // --- Chat de origen: al elegirlo, se cargan sus últimos mensajes para poder reenviar uno ---
  async function loadSourceMessages(chatId) {
    messagesListEl.innerHTML = "";
    if (!chatId) return;
    messagesListEl.appendChild(el("div", { class: "empty" }, "Cargando mensajes..."));
    try {
      const res = await api(`/accounts/${accountId}/dialogs/${chatId}/messages?limit=60`);
      messagesListEl.innerHTML = "";
      const messages = (res.messages || []).slice().reverse(); // mas reciente primero, para elegir rapido
      if (messages.length === 0) {
        messagesListEl.appendChild(el("div", { class: "empty" }, "Este chat no tiene mensajes."));
        return;
      }
      for (const m of messages) {
        const preview = m.text
          ? (m.text.length > 160 ? m.text.slice(0, 160) + "…" : m.text)
          : (m.mediaType ? `[${m.mediaType}]` : "[mensaje sin texto]");
        const forwardBtn = el("button", { class: "sm primary" }, "Reenviar al grupo SFS");
        forwardBtn.addEventListener("click", async () => {
          if (!groupSelect.value) return toast("Elige antes un canal/grupo fijo", true);
          forwardBtn.disabled = true;
          try {
            await api(`/accounts/${accountId}/sfs-group/forward`, {
              method: "POST",
              body: JSON.stringify({ chatId, messageId: m.id, hideSender: hideSenderCheck.checked }),
            });
            toast("Mensaje reenviado al grupo SFS");
          } catch (err) {
            toast(err.message, true);
          } finally {
            forwardBtn.disabled = false;
          }
        });
        messagesListEl.appendChild(el("div", { class: "sfs-group-message-row" }, [
          el("div", { class: "sfs-group-message-meta" }, `${m.out ? "Enviado" : "Recibido"} · ${fmtDate(m.date)}`),
          el("div", { class: "sfs-group-message-text" }, preview),
          forwardBtn,
        ]));
      }
    } catch (err) {
      messagesListEl.innerHTML = "";
      messagesListEl.appendChild(el("div", { class: "empty" }, "Error al cargar mensajes: " + err.message));
    }
  }

  sourceSelect.addEventListener("change", () => loadSourceMessages(sourceSelect.value));
}

async function renderJapView(container) {
  container.innerHTML = "";
  container.appendChild(el("h1", {}, "Just Another Panel"));
  container.appendChild(el("p", { class: "subtitle" }, "Compra vistas, miembros, reacciones y otros servicios directamente desde el CRM."));

  const balanceBox = el("div", { class: "kpi-tile" }, [el("div", { class: "kpi-label" }, "Saldo del panel"), el("div", { class: "kpi-value" }, "Cargando...")]);
  container.appendChild(balanceBox);

  // Moneda del propio panel JAP (la misma que usan sus "rate" de servicio y
  // el "charge" de cada pedido) - normalmente USD. La agencia quiere ver
  // todo en euros aunque el panel cobre en otra moneda, así que se pide
  // aparte la tasa de cambio (GET /jap/eur-rate, cacheada en el backend) y
  // se convierte solo para PINTARLO aquí - lo que de verdad se guarda de
  // cada pedido (JapOrder.currency) sigue siendo la moneda real del panel.
  let japCurrency = "";
  let eurRate = null; // 1 unidad de japCurrency = eurRate euros
  function toEur(amount) {
    if (eurRate === null || amount === null || amount === undefined) return null;
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    return n * eurRate;
  }
  function fmtEur(amount) {
    const eur = toEur(amount);
    return eur !== null ? `${eur.toFixed(2)} €` : null;
  }
  /** "3.20 € (3.50 USD)" si hay tasa, o solo la moneda original si no se
   * pudo convertir - nunca se deja al chatter/admin sin ver ningún número
   * solo porque la conversión falló. */
  function fmtEurWithNative(amount, decimalsNative) {
    if (amount === null || amount === undefined || amount === "") return "-";
    const native = `${Number(amount).toFixed(decimalsNative ?? 2)} ${japCurrency}`;
    const eur = fmtEur(amount);
    return eur ? `${eur} (${native})` : native;
  }

  api("/jap/balance").then(async (res) => {
    japCurrency = res.currency || "USD";
    try {
      const rateRes = await api("/jap/eur-rate?currency=" + encodeURIComponent(japCurrency));
      eurRate = rateRes.rate;
    } catch {
      // sin tasa: se sigue enseñando todo en la moneda original del panel
    }
    balanceBox.querySelector(".kpi-value").textContent = fmtEurWithNative(res.balance);
    paintServiceOptions(serviceSearch.value);
    renderServiceInfo();
  }).catch((err) => {
    balanceBox.querySelector(".kpi-value").textContent = "-";
    balanceBox.appendChild(el("div", { class: "hint" }, err.message));
  });

  // Apuntes generales del panel (un único cuadro para todo JAP, no por
  // pedido ni por creadora): a diferencia del formulario de abajo, que se
  // limpia tras cada pedido, esto NUNCA se borra solo - queda guardado
  // siempre, se haga o no una compra.
  container.appendChild(renderAutosaveTextCard({
    title: "Apuntes",
    hint: "Notas generales de este panel (no se borran al hacer un pedido).",
    placeholder: "Escribe aquí lo que necesites recordar sobre Just Another Panel...",
    rows: 6,
    load: () => api("/jap/notes").then((res) => res.notes || ""),
    save: (value) => api("/jap/notes", { method: "PUT", body: JSON.stringify({ notes: value }) }),
  }));

  // --- Formulario de nuevo pedido ---
  const formBox = el("div", { class: "jap-order-form" });
  container.appendChild(formBox);
  formBox.appendChild(el("h2", {}, "Nuevo pedido"));

  const accountSelect = el("select", {}, [el("option", { value: "" }, "Sin creadora concreta (opcional)"), ...state.accounts.map((a) => el("option", { value: a.id }, a.label))]);
  const serviceSearch = el("input", { placeholder: "Buscar servicio (nombre, id o categoría)..." });
  const serviceSelect = el("select", {}, [el("option", { value: "" }, "Cargando servicios...")]);
  const linkInput = el("input", { placeholder: "Enlace (perfil, publicación...)" });
  const quantityInput = el("input", { type: "number", min: "1", placeholder: "Cantidad" });
  const submitBtn = el("button", { class: "primary" }, "Hacer pedido");
  // Ficha del servicio elegido: TODA la información que da el panel de JAP
  // sobre ese servicio (categoría, tipo, mín/máx, si admite refill/cancelar)
  // + el coste estimado de ESTE pedido en concreto, recalculado en vivo
  // según la cantidad que se vaya escribiendo - antes solo se veía "mín/máx/
  // precio por 1000" y había que hacer la cuenta a mano para saber cuánto
  // iba a costar de verdad.
  const serviceInfoEl = el("div", { class: "jap-service-info hidden" });

  formBox.appendChild(el("div", { class: "field" }, [el("label", {}, "Creadora"), accountSelect]));
  formBox.appendChild(el("div", { class: "field" }, [el("label", {}, "Buscar servicio"), serviceSearch]));
  formBox.appendChild(el("div", { class: "field" }, [el("label", {}, "Servicio"), serviceSelect]));
  formBox.appendChild(serviceInfoEl);
  formBox.appendChild(el("div", { class: "field" }, [el("label", {}, "Enlace"), linkInput]));
  formBox.appendChild(el("div", { class: "field" }, [el("label", {}, "Cantidad"), quantityInput]));
  formBox.appendChild(submitBtn);

  let allServices = [];
  function paintServiceOptions(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const filtered = !q ? allServices : allServices.filter((s) =>
      s.name.toLowerCase().includes(q) || String(s.service).includes(q) || (s.category || "").toLowerCase().includes(q)
    );
    serviceSelect.innerHTML = "";
    serviceSelect.appendChild(el("option", { value: "" }, "Elige un servicio..."));
    // Agrupadas por categoría (tal cual las manda JAP) para poder buscar a
    // ojo entre miles de servicios, en vez de una lista plana sin ningún
    // orden.
    const byCategory = new Map();
    for (const s of filtered.slice(0, 500)) {
      const cat = s.category || "Sin categoría";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(s);
    }
    for (const [cat, services] of byCategory) {
      const group = el("optgroup", { label: cat });
      for (const s of services) {
        const priceEur = fmtEur(s.rate);
        const priceLabel = priceEur ? `${priceEur}/1000` : `${s.rate} ${japCurrency}/1000`;
        group.appendChild(el("option", { value: s.service }, `#${s.service} · ${s.name} — ${priceLabel}`));
      }
      serviceSelect.appendChild(group);
    }
  }
  api("/jap/services").then((res) => {
    allServices = res.services || [];
    paintServiceOptions("");
  }).catch((err) => {
    serviceSelect.innerHTML = "";
    serviceSelect.appendChild(el("option", { value: "" }, "No se pudo cargar (" + err.message + ")"));
  });
  serviceSearch.addEventListener("input", () => paintServiceOptions(serviceSearch.value));

  function estimatedCost(svc, quantity) {
    const rate = Number(svc.rate);
    const qty = Number(quantity);
    if (!Number.isFinite(rate) || !Number.isFinite(qty) || qty <= 0) return null;
    return (rate * qty) / 1000;
  }

  function renderServiceInfo() {
    const svc = allServices.find((s) => String(s.service) === serviceSelect.value);
    if (!svc) {
      serviceInfoEl.classList.add("hidden");
      serviceInfoEl.innerHTML = "";
      return;
    }
    serviceInfoEl.classList.remove("hidden");
    serviceInfoEl.innerHTML = "";
    const priceEur = fmtEur(svc.rate);
    const rows = [
      ["Categoría", svc.category || "-"],
      ["Tipo", svc.type || "-"],
      ["Precio", priceEur ? `${priceEur} por cada 1000 (${svc.rate} ${japCurrency})` : `${svc.rate} ${japCurrency} por cada 1000`],
      ["Cantidad mínima", svc.min],
      ["Cantidad máxima", svc.max],
      ["Admite refill (repuesto si baja)", svc.refill ? "Sí" : "No"],
      ["Se puede cancelar", svc.cancel ? "Sí" : "No"],
    ];
    for (const [label, value] of rows) {
      serviceInfoEl.appendChild(el("div", { class: "jap-service-info-row" }, [
        el("span", { class: "jap-service-info-label" }, label + ":"),
        el("span", {}, String(value)),
      ]));
    }
    const cost = estimatedCost(svc, quantityInput.value);
    const costEur = cost !== null ? fmtEur(cost) : null;
    const costLabel = cost === null
      ? "Escribe la cantidad para calcularlo"
      : costEur
        ? `${costEur} (${cost.toFixed(4)} ${japCurrency})`
        : `${cost.toFixed(4)} ${japCurrency}`;
    serviceInfoEl.appendChild(el("div", { class: "jap-service-info-row jap-service-info-cost" }, [
      el("span", { class: "jap-service-info-label" }, "Coste estimado de este pedido:"),
      el("span", {}, costLabel),
    ]));
  }
  serviceSelect.addEventListener("change", renderServiceInfo);
  quantityInput.addEventListener("input", renderServiceInfo);

  submitBtn.addEventListener("click", async () => {
    const svc = allServices.find((s) => String(s.service) === serviceSelect.value);
    if (!svc) { toast("Elige un servicio", true); return; }
    if (!linkInput.value.trim()) { toast("Falta el enlace", true); return; }
    if (!quantityInput.value || Number(quantityInput.value) <= 0) { toast("Falta la cantidad", true); return; }
    const cost = estimatedCost(svc, quantityInput.value);
    const costEur = cost !== null ? fmtEur(cost) : null;
    const costText = cost === null ? "no calculable" : costEur ? `${costEur} (${cost.toFixed(4)} ${japCurrency})` : `${cost.toFixed(4)} ${japCurrency}`;
    const confirmed = await confirmModal({
      title: "Confirmar pedido",
      body: [
        el("div", {}, `#${svc.service} · ${svc.name}`),
        el("div", {}, `Cantidad: ${quantityInput.value}`),
        el("div", { style: "font-weight:600;margin-top:4px" }, `Coste estimado: ${costText}`),
        el("div", { class: "hint", style: "margin-top:8px" }, "¿Hacer el pedido?"),
      ],
      confirmLabel: "Hacer pedido",
    });
    if (!confirmed) return;
    submitBtn.disabled = true;
    try {
      await api("/jap/orders", {
        method: "POST",
        body: JSON.stringify({
          accountId: accountSelect.value || null,
          serviceId: Number(svc.service),
          serviceName: svc.name,
          link: linkInput.value.trim(),
          quantity: Number(quantityInput.value),
        }),
      });
      toast("Pedido realizado");
      linkInput.value = "";
      quantityInput.value = "";
      renderServiceInfo();
      await loadOrders();
    } catch (err) {
      toast(err.message, true);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // --- Historial de pedidos ---
  const historyBox = el("div", { class: "jap-order-history" });
  container.appendChild(historyBox);
  historyBox.appendChild(el("h2", {}, "Pedidos realizados"));
  const ordersListEl = el("div", {});
  historyBox.appendChild(ordersListEl);

  async function loadOrders() {
    ordersListEl.innerHTML = "";
    ordersListEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const { orders } = await api("/jap/orders");
      ordersListEl.innerHTML = "";
      if (orders.length === 0) {
        ordersListEl.appendChild(el("div", { class: "empty" }, "Todavía no se ha hecho ningún pedido."));
        return;
      }
      const table = el("table", { class: "work-hours-table" });
      const thead = el("thead", {}, el("tr", {}, ["Fecha", "Creadora", "Servicio", "Cantidad", "Coste", "Estado", "Quedan", ""].map((h) => el("th", {}, h))));
      const tbody = el("tbody", {});
      table.appendChild(thead);
      table.appendChild(tbody);
      for (const o of orders) {
        const refreshBtn = el("button", { class: "sm" }, "↻");
        refreshBtn.addEventListener("click", async () => {
          refreshBtn.disabled = true;
          try {
            await api(`/jap/orders/${o.id}/refresh`, { method: "POST" });
            await loadOrders();
          } catch (err) {
            toast(err.message, true);
          } finally {
            refreshBtn.disabled = false;
          }
        });
        // "Coste": lo que de verdad cobró el panel por este pedido (ya con
        // sus redondeos), no una estimación - se rellena solo al pedirlo
        // (ver POST /jap/orders en jap.ts) y se puede refrescar a mano con
        // "↻" si llegara a faltar.
        tbody.appendChild(el("tr", {}, [
          el("td", {}, fmtDate(o.createdAt)),
          el("td", {}, o.account ? o.account.label : "-"),
          el("td", {}, `#${o.serviceId} ${o.serviceName || ""}`),
          el("td", {}, String(o.quantity)),
          el("td", {}, o.charge ? fmtEurWithNative(o.charge) : "-"),
          el("td", {}, o.status),
          el("td", {}, o.remains || "-"),
          el("td", {}, refreshBtn),
        ]));
      }
      ordersListEl.appendChild(table);
    } catch (err) {
      ordersListEl.innerHTML = "";
      ordersListEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }
  await loadOrders();
}

// ---------- Programar posts (pestaña "Canales") ----------
//
// Publica UNA VEZ contenido de la bóveda de esta cuenta en un canal/grupo
// concreto de Telegram, en la fecha/hora que se elija (hora de la propia
// cuenta, igual que los horarios del Reenviador) - distinto del Reenviador
// porque no se repite: cada fila es un envío suelto. El backend
// (src/api/scheduledPosts.ts + src/engine/scheduledPostsEngine.ts) revisa
// cada minuto qué posts ya tocan y los publica solo.

async function openProgramarPostsView() {
  if (state.accounts.length === 0) {
    try {
      state.accounts = (await api("/accounts")).accounts;
    } catch {
      // se comprueba de nuevo mas abajo si sigue vacio
    }
  }
  if (!programarPostsAccountId || !state.accounts.some((a) => a.id === programarPostsAccountId)) {
    programarPostsAccountId = state.accounts[0] ? state.accounts[0].id : null;
  }
  renderProgramarPostsAccountList();
  await renderProgramarPostsView();
}

function selectProgramarPostsAccount(id) {
  if (programarPostsAccountId === id) return;
  programarPostsAccountId = id;
  renderProgramarPostsAccountList();
  renderProgramarPostsView();
}

function renderProgramarPostsAccountList() {
  accountListEl.innerHTML = "";
  accountListEl.appendChild(el("div", { class: "account-list-title" }, "Cuentas"));
  for (const acc of state.accounts) {
    accountListEl.appendChild(el("div", {
      class: "account-item" + (acc.id === programarPostsAccountId ? " active" : ""),
      onclick: () => selectProgramarPostsAccount(acc.id),
    }, [
      accountAvatarEl(acc.id, acc.label),
      el("div", { class: "account-name" }, acc.label),
    ]));
  }
}

/** Igual que fmtDate pero en la hora DE LA CUENTA (no la de quien mira el
 * panel): lo que se ve en la tabla tiene que coincidir exactamente con la
 * fecha/hora que se eligió al programar el post, que se pidió "hora de la
 * cuenta" en el formulario. */
function fmtInAccountTz(iso, timezone) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-ES", {
      timeZone: timezone,
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return new Date(iso).toLocaleString("es-ES");
  }
}

const PROGRAMAR_POSTS_STATUS_LABEL = { PENDING: "Pendiente", SENT: "Publicado", FAILED: "Falló", CANCELLED: "Cancelado" };
const PROGRAMAR_POSTS_STATUS_PILL = { PENDING: "warn", SENT: "ok", FAILED: "danger", CANCELLED: "off" };

async function renderProgramarPostsView() {
  appEl.innerHTML = "";
  if (!programarPostsAccountId) {
    appEl.appendChild(el("div", { class: "empty" }, "No hay cuentas dadas de alta todavía."));
    return;
  }
  const accountId = programarPostsAccountId;
  let account;
  try {
    account = (await api(`/accounts/${accountId}`)).account;
  } catch (err) {
    appEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    return;
  }

  appEl.appendChild(el("h1", {}, "Programar posts"));
  appEl.appendChild(el("p", { class: "subtitle" },
    programarPostsTab === "historias"
      ? `Publica una Historia de Telegram en el perfil de "${account.label}", en la fecha y hora exactas que elijas (hora de la cuenta: ${account.timezone}). Requiere que la cuenta tenga Telegram Premium.`
      : programarPostsTab === "publicadas"
      ? `Lo que "${account.label}" tiene publicado ahora mismo en sus canales de Telegram (Canales free), venga de "Programar posts" o publicado a mano.`
      : `Publica contenido de la bóveda en un canal/grupo de Telegram, en la fecha y hora exactas que elijas (hora de "${account.label}": ${account.timezone}).`));

  // Pestañas: las tres funcionan de verdad.
  const tabsRow = el("div", { class: "tabs" });
  const tabDefs = [
    { key: "historias", label: "Historias" },
    { key: "canales", label: "Canales" },
    { key: "publicadas", label: "Publicadas" },
  ];
  for (const t of tabDefs) {
    const tabEl = el("div", { class: "tab" + (t.key === programarPostsTab ? " active" : "") }, t.label);
    tabEl.addEventListener("click", () => {
      if (programarPostsTab === t.key) return;
      programarPostsTab = t.key;
      renderProgramarPostsView();
    });
    tabsRow.appendChild(tabEl);
  }
  appEl.appendChild(tabsRow);

  if (programarPostsTab === "publicadas") {
    await renderPublishedPostsSection(account);
    return;
  }

  const filterRow = el("div", { class: "section-title-row" }, [
    el("div", { class: "tabs", style: "margin-bottom:0" }, [
      el("div", {
        class: "tab" + (programarPostsStatusFilter === "PENDING" ? " active" : ""),
        onclick: () => { programarPostsStatusFilter = "PENDING"; renderProgramarPostsView(); },
      }, "Pendientes"),
      el("div", {
        class: "tab" + (programarPostsStatusFilter === "all" ? " active" : ""),
        onclick: () => { programarPostsStatusFilter = "all"; renderProgramarPostsView(); },
      }, "Todos"),
    ]),
    el("button", {
      class: "primary",
      onclick: () => programarPostsTab === "historias" ? openScheduleStoryModal(account) : openScheduleChannelPostModal(account),
    }, programarPostsTab === "historias" ? "+ Programar historia" : "+ Programar post"),
  ]);
  appEl.appendChild(filterRow);

  const tableWrap = el("div", {});
  appEl.appendChild(tableWrap);
  if (programarPostsTab === "historias") {
    await renderScheduledPostsTable(account, tableWrap, "STORY");
  } else {
    await renderScheduledPostsTable(account, tableWrap, "CHANNEL");
  }
}

let programarPostsPublishedDays = 7;

async function renderPublishedPostsSection(account) {
  const controlsRow = el("div", { class: "filters" });
  const daysSelect = el("select", {}, [
    el("option", { value: "1" }, "1 día"),
    el("option", { value: "3" }, "3 días"),
    el("option", { value: "7" }, "7 días"),
    el("option", { value: "15" }, "15 días"),
    el("option", { value: "30" }, "30 días"),
  ]);
  daysSelect.value = String(programarPostsPublishedDays);
  daysSelect.addEventListener("change", () => {
    programarPostsPublishedDays = Number(daysSelect.value);
    load();
  });
  const refreshBtn = el("button", {}, "Actualizar");
  controlsRow.appendChild(el("span", { class: "hint" }, "Publicado en los últimos"));
  controlsRow.appendChild(daysSelect);
  controlsRow.appendChild(refreshBtn);
  appEl.appendChild(controlsRow);

  const resultsEl = el("div", {});
  appEl.appendChild(resultsEl);

  async function load() {
    resultsEl.innerHTML = "";
    resultsEl.appendChild(el("div", { class: "empty" }, "Consultando Telegram..."));
    let posts, reason;
    try {
      const res = await api(`/accounts/${account.id}/published-posts?days=${programarPostsPublishedDays}`);
      posts = res.posts;
      reason = res.reason;
    } catch (err) {
      resultsEl.innerHTML = "";
      resultsEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }
    resultsEl.innerHTML = "";
    if (reason === "sin_canales") {
      resultsEl.appendChild(el("div", { class: "empty" }, "Esta cuenta no tiene canales configurados todavía. Añádelos en \"Canales free\"."));
      return;
    }
    if (posts.length === 0) {
      resultsEl.appendChild(el("div", { class: "empty" }, "No hay nada publicado en ese periodo."));
      return;
    }

    const tbody = el("tbody");
    for (const p of posts) {
      const delBtn = el("button", { class: "ghost danger" }, "Eliminar");
      delBtn.addEventListener("click", async () => {
        const ok = await confirmModal({
          title: "¿Eliminar este post de Telegram?",
          body: `Se borrará de verdad en "${p.chatTitle}", para todo el mundo. No se puede deshacer.`,
          confirmLabel: "Sí, eliminar",
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`/accounts/${account.id}/published-posts`, {
            method: "DELETE",
            body: JSON.stringify({ chatId: p.chatId, messageId: p.messageId }),
          });
          toast("Eliminado");
          load();
        } catch (err) {
          toast(err.message, true);
        }
      });
      tbody.appendChild(el("tr", {}, [
        el("td", {}, p.kind),
        el("td", {}, p.chatTitle),
        el("td", { style: "max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, p.text || "—"),
        el("td", {}, fmtInAccountTz(p.date, account.timezone)),
        el("td", {}, delBtn),
      ]));
    }
    const table = el("table", {}, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "Qué es"), el("th", {}, "Canal"), el("th", {}, "Texto"), el("th", {}, "Publicada"), el("th", {}, ""),
      ])),
      tbody,
    ]);
    resultsEl.appendChild(el("div", { class: "card" }, table));
  }

  refreshBtn.addEventListener("click", load);
  await load();
}

const STORY_PRIVACY_LABEL = { EVERYONE: "Todos", CONTACTS: "Contactos", CLOSE_FRIENDS: "Mejores amigos" };

async function renderScheduledPostsTable(account, container, kind) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: "empty" }, "Cargando..."));
  let posts;
  try {
    const res = await api(`/accounts/${account.id}/scheduled-posts?status=${programarPostsStatusFilter}&kind=${kind}`);
    posts = res.posts;
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    return;
  }
  container.innerHTML = "";
  const isStory = kind === "STORY";
  if (posts.length === 0) {
    container.appendChild(el("div", { class: "empty" },
      programarPostsStatusFilter === "PENDING"
        ? (isStory ? "No hay Historias programadas todavía. Usa \"+ Programar historia\"." : "No hay posts programados todavía. Usa \"+ Programar post\".")
        : "Sin resultados."));
    return;
  }

  const tbody = el("tbody");
  for (const p of posts) {
    let contentCount = 1;
    try { contentCount = JSON.parse(p.messageIds).length; } catch { /* deja 1 por defecto */ }

    const actionBtn = el("button", { class: "ghost" + (p.status === "PENDING" ? " danger" : "") },
      p.status === "PENDING" ? "Cancelar" : "Eliminar");
    actionBtn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: p.status === "PENDING" ? "¿Cancelar esto?" : "¿Quitar de la lista?",
        body: p.status === "PENDING"
          ? (isStory ? "La Historia no se publicará. No se puede deshacer." : `No se publicará en "${p.destinationTitle}". No se puede deshacer.`)
          : "Solo se quita de este listado, no afecta a lo ya publicado en Telegram.",
        confirmLabel: "Sí",
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/scheduled-posts/${p.id}`, { method: "DELETE" });
        toast("Hecho");
        renderScheduledPostsTable(account, container, kind);
      } catch (err) {
        toast(err.message, true);
      }
    });

    const thirdCol = isStory
      ? `${STORY_PRIVACY_LABEL[p.storyPrivacy] || p.storyPrivacy} · ${p.storyPeriodHours}h${p.storyPinned ? " · 📌 fijada" : ""}`
      : p.destinationTitle;

    tbody.appendChild(el("tr", {}, [
      el("td", {}, `${contentCount} archivo(s)`),
      el("td", {}, thirdCol),
      el("td", { style: "max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, p.previewText || "—"),
      el("td", {}, fmtInAccountTz(p.scheduledFor, account.timezone)),
      el("td", {}, el("span", { class: "pill " + (PROGRAMAR_POSTS_STATUS_PILL[p.status] || "") }, PROGRAMAR_POSTS_STATUS_LABEL[p.status] || p.status)),
      el("td", {}, actionBtn),
    ]));
  }

  const table = el("table", {}, [
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Contenido"), el("th", {}, isStory ? "Privacidad" : "Canal"), el("th", {}, "Texto"),
      el("th", {}, "Programado para"), el("th", {}, "Estado"), el("th", {}, ""),
    ])),
    tbody,
  ]);
  container.appendChild(el("div", { class: "card" }, table));
}

function openScheduleChannelPostModal(account) {
  const selectedMedia = []; // {id, caption, type} - misma forma que usa openVaultPickerModal
  let destination = null; // {chatId, title}

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, `Programar post — ${account.label}`));

    // --- destino: busca entre los grupos/canales reales de Telegram de
    // esta cuenta (mismo buscador que "Configurar canales..." de Canales
    // free), no hace falta que esten dados de alta en ningun sitio antes. ---
    const destChosenEl = el("div", { class: "hint" }, "Ningún canal/grupo elegido todavía.");
    const destSearchInput = el("input", { placeholder: "Buscar canal o grupo por nombre..." });
    const destResultsEl = el("div", { class: "script-manage-list", style: "max-height:170px;overflow:auto" });
    modal.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Canal/grupo destino"),
      destChosenEl, destSearchInput, destResultsEl,
    ]));

    let allChannels = [];
    api(`/accounts/${account.id}/free-channels/search`)
      .then((res) => { allChannels = res.results || []; renderDestResults(""); })
      .catch((err) => { destResultsEl.innerHTML = ""; destResultsEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message)); });

    function renderDestResults(q) {
      destResultsEl.innerHTML = "";
      const s = (q || "").trim().toLowerCase();
      const filtered = (s ? allChannels.filter((r) => r.title.toLowerCase().includes(s)) : allChannels).slice(0, 30);
      if (filtered.length === 0) {
        destResultsEl.appendChild(el("div", { class: "empty" }, "Sin resultados."));
        return;
      }
      for (const r of filtered) {
        const row = el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto;cursor:pointer" }, [
          el("div", {}, r.title),
          el("span", { class: "hint" }, "Elegir"),
        ]);
        row.addEventListener("click", () => {
          destination = { chatId: r.chatId, title: r.title };
          destChosenEl.textContent = `Elegido: ${r.title}`;
        });
        destResultsEl.appendChild(row);
      }
    }
    let destSearchTimer = null;
    destSearchInput.addEventListener("input", () => {
      clearTimeout(destSearchTimer);
      destSearchTimer = setTimeout(() => renderDestResults(destSearchInput.value), 200);
    });

    // --- contenido: mismo selector de la bóveda que Guiones/SFS ---
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Contenido (de la bóveda, hasta 10 - un álbum cuenta como uno solo)")]));
    const mediaGrid = el("div", { class: "content-items-grid" });
    modal.appendChild(mediaGrid);

    function syncPreviewText() {
      if (previewText.dataset.touched === "1") return;
      previewText.value = selectedMedia.map((m) => m.caption).filter(Boolean).join(" / ").slice(0, 300);
    }

    function renderMediaGrid() {
      mediaGrid.innerHTML = "";
      for (const m of selectedMedia) {
        let thumbInner;
        if (m.type === "audio") {
          thumbInner = el("div", { class: "content-item-thumb-empty" }, "🎧");
        } else {
          const thumbUrl = `/api/accounts/${account.id}/content-group/messages/${m.id}/thumb`;
          thumbInner = el("img", { src: thumbUrl, loading: "lazy", class: "content-item-thumb" });
          bindThumbRetry(thumbInner, thumbUrl);
        }
        const thumbWrap = el("div", { class: "content-item-thumb-wrap" }, thumbInner);
        const removeBtn = el("button", { type: "button", class: "content-item-fav-btn", title: "Quitar" }, "×");
        thumbWrap.appendChild(removeBtn);
        removeBtn.addEventListener("click", () => {
          const idx = selectedMedia.indexOf(m);
          if (idx >= 0) selectedMedia.splice(idx, 1);
          renderMediaGrid();
          syncPreviewText();
        });
        mediaGrid.appendChild(el("div", { class: "content-item-card" }, thumbWrap));
      }
      const addBtn = el("div", {
        class: "content-item-card",
        style: "cursor:pointer;align-items:center;justify-content:center;min-height:90px;font-size:22px",
      }, "+");
      addBtn.addEventListener("click", () => {
        openVaultPickerModal(account, selectedMedia, () => { renderMediaGrid(); syncPreviewText(); }, { max: 10 });
      });
      mediaGrid.appendChild(addBtn);
    }
    renderMediaGrid();

    // --- texto de la tabla (solo para identificarlo, no cambia lo que se publica) ---
    const previewText = el("textarea", { rows: 2, placeholder: "Se rellena solo con el texto del contenido elegido - puedes cambiarlo." });
    previewText.addEventListener("input", () => { previewText.dataset.touched = "1"; });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Texto (para identificar el post en la tabla)"), previewText]));

    // --- fecha/hora, en la timezone de la cuenta ---
    const dateInput = el("input", { type: "date" });
    const timeInput = el("input", { type: "time" });
    modal.appendChild(el("div", { class: "grid-2" }, [
      el("div", { class: "field" }, [el("label", {}, `Fecha (hora de "${account.label}", ${account.timezone})`), dateInput]),
      el("div", { class: "field" }, [el("label", {}, "Hora"), timeInput]),
    ]));

    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async (e) => {
          if (!destination) return toast("Elige un canal/grupo destino", true);
          if (selectedMedia.length === 0) return toast("Elige al menos un contenido de la bóveda", true);
          if (!dateInput.value || !timeInput.value) return toast("Elige la fecha y la hora", true);
          e.target.disabled = true;
          try {
            await api(`/accounts/${account.id}/scheduled-posts`, {
              method: "POST",
              body: JSON.stringify({
                destinationChatId: destination.chatId,
                destinationTitle: destination.title,
                messageIds: selectedMedia.map((m) => Number(m.id)),
                previewText: previewText.value,
                date: dateInput.value,
                time: timeInput.value,
              }),
            });
            toast("Post programado");
            close();
            renderProgramarPostsView();
          } catch (err) {
            toast(err.message, true);
            e.target.disabled = false;
          }
        },
      }, "Programar"),
    ]));
  }, { wide: true });
}

function openScheduleStoryModal(account) {
  const selectedMedia = []; // {id, caption, type} - una Historia lleva UN solo contenido

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, `Programar Historia — ${account.label}`));
    modal.appendChild(el("p", { class: "hint" },
      "Requiere que esta cuenta tenga Telegram Premium activo (Telegram lo exige para publicar Historias por API). Si no lo tiene, al llegar la hora aparecerá un error claro en la Consola en vez de publicarse."));

    // --- contenido: un solo elemento de la bóveda (sin álbumes) ---
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Contenido (de la bóveda, una sola foto o vídeo)")]));
    const mediaGrid = el("div", { class: "content-items-grid" });
    modal.appendChild(mediaGrid);

    function syncPreviewText() {
      if (previewText.dataset.touched === "1") return;
      previewText.value = (selectedMedia[0]?.caption || "").slice(0, 300);
    }

    function renderMediaGrid() {
      mediaGrid.innerHTML = "";
      for (const m of selectedMedia) {
        let thumbInner;
        if (m.type === "audio") {
          // Una Historia no puede ser un audio - se descarta si venía de un picker sin filtro de tipo.
          thumbInner = el("div", { class: "content-item-thumb-empty" }, "🎧");
        } else {
          const thumbUrl = `/api/accounts/${account.id}/content-group/messages/${m.id}/thumb`;
          thumbInner = el("img", { src: thumbUrl, loading: "lazy", class: "content-item-thumb" });
          bindThumbRetry(thumbInner, thumbUrl);
        }
        const thumbWrap = el("div", { class: "content-item-thumb-wrap" }, thumbInner);
        const removeBtn = el("button", { type: "button", class: "content-item-fav-btn", title: "Quitar" }, "×");
        thumbWrap.appendChild(removeBtn);
        removeBtn.addEventListener("click", () => {
          selectedMedia.length = 0;
          renderMediaGrid();
          syncPreviewText();
        });
        mediaGrid.appendChild(el("div", { class: "content-item-card" }, thumbWrap));
      }
      if (selectedMedia.length === 0) {
        const addBtn = el("div", {
          class: "content-item-card",
          style: "cursor:pointer;align-items:center;justify-content:center;min-height:90px;font-size:22px",
        }, "+");
        addBtn.addEventListener("click", () => {
          openVaultPickerModal(account, selectedMedia, () => { renderMediaGrid(); syncPreviewText(); }, { max: 1 });
        });
        mediaGrid.appendChild(addBtn);
      }
    }
    renderMediaGrid();

    // --- texto/caption de la Historia (este SÍ se publica, a diferencia
    // del texto de la tabla en "Canales" que es solo para identificarlo) ---
    const previewText = el("textarea", { rows: 2, placeholder: "Se rellena solo con el texto del contenido elegido - puedes cambiarlo." });
    previewText.addEventListener("input", () => { previewText.dataset.touched = "1"; });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Texto de la Historia (opcional)"), previewText]));

    // --- privacidad / duración / fijar ---
    const privacySelect = el("select", {}, [
      el("option", { value: "EVERYONE" }, "Todos"),
      el("option", { value: "CONTACTS" }, "Solo contactos"),
      el("option", { value: "CLOSE_FRIENDS" }, "Solo mejores amigos"),
    ]);
    const periodSelect = el("select", {}, [
      el("option", { value: "6" }, "6 horas (Premium)"),
      el("option", { value: "12" }, "12 horas (Premium)"),
      el("option", { value: "24" }, "24 horas"),
      el("option", { value: "48" }, "48 horas (Premium)"),
    ]);
    periodSelect.value = "24";
    const pinnedCheck = el("input", { type: "checkbox" });
    modal.appendChild(el("div", { class: "grid-2" }, [
      el("div", { class: "field" }, [el("label", {}, "Quién la ve"), privacySelect]),
      el("div", { class: "field" }, [el("label", {}, "Duración"), periodSelect]),
    ]));
    modal.appendChild(el("label", { class: "folder-checkbox-row" }, [pinnedCheck, el("span", {}, "Fijar en el perfil (además de expirar, se queda guardada)")]));

    // --- fecha/hora, en la timezone de la cuenta ---
    const dateInput = el("input", { type: "date" });
    const timeInput = el("input", { type: "time" });
    modal.appendChild(el("div", { class: "grid-2" }, [
      el("div", { class: "field" }, [el("label", {}, `Fecha (hora de "${account.label}", ${account.timezone})`), dateInput]),
      el("div", { class: "field" }, [el("label", {}, "Hora"), timeInput]),
    ]));

    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async (e) => {
          if (selectedMedia.length === 0) return toast("Elige una foto o vídeo de la bóveda", true);
          if (!dateInput.value || !timeInput.value) return toast("Elige la fecha y la hora", true);
          e.target.disabled = true;
          try {
            await api(`/accounts/${account.id}/scheduled-posts`, {
              method: "POST",
              body: JSON.stringify({
                kind: "STORY",
                messageIds: [Number(selectedMedia[0].id)],
                previewText: previewText.value,
                date: dateInput.value,
                time: timeInput.value,
                storyPrivacy: privacySelect.value,
                storyPeriodHours: Number(periodSelect.value),
                storyPinned: pinnedCheck.checked,
              }),
            });
            toast("Historia programada");
            close();
            renderProgramarPostsView();
          } catch (err) {
            toast(err.message, true);
            e.target.disabled = false;
          }
        },
      }, "Programar"),
    ]));
  }, { wide: true });
}

// ---------- vista principal de una cuenta ----------

async function renderAccountView(accountId) {
  appEl.innerHTML = "";
  const [{ account }, { campaigns }, { sourceGroups }, status, nextSend] = await Promise.all([
    api(`/accounts/${accountId}`),
    api(`/accounts/${accountId}/campaigns`),
    api(`/accounts/${accountId}/source-groups`),
    api(`/accounts/${accountId}/status`),
    api(`/accounts/${accountId}/next-send`).catch(() => null),
  ]);

  appEl.appendChild(el("h1", {}, account.label));
  appEl.appendChild(el("p", { class: "subtitle" }, `Conectada a Telegram · ${account.phoneNumber}`));

  appEl.appendChild(el("div", { class: "banner" },
    "Coge los últimos mensajes del tema del grupo origen y, según los horarios/ritmo de cada campaña, publica en los grupos y canales de las carpetas elegidas, desde esta cuenta. Si Telegram marca la cuenta (PeerFlood), se para sola y avisa por WhatsApp si está configurado."));

  appEl.appendChild(renderAccountStatusCard(account, status, campaigns, nextSend));

  // Campañas
  appEl.appendChild(el("div", { class: "section-title-row" }, [
    el("h2", {}, "Campañas (carpetas de Telegram)"),
    el("div", { style: "display:flex;gap:8px" }, [
      el("button", {
        class: "ghost",
        disabled: campaigns.length === 0 ? "true" : null,
        onclick: () => openCopyCampaignsModal(accountId, account.label, campaigns.length),
      }, "Copiar todas a otra modelo"),
      el("button", { class: "primary", onclick: () => openAddCampaignModal(accountId, sourceGroups) }, "+ Añadir carpeta"),
    ]),
  ]));
  appEl.appendChild(renderCampaignsTable(campaigns, account));

  // Orígenes
  appEl.appendChild(el("div", { class: "section-title-row" }, [
    el("h2", {}, "Orígenes configurados"),
    el("button", { onclick: () => openAddSourceGroupModal(accountId) }, "+ Nuevo origen"),
  ]));
  appEl.appendChild(renderSourceGroupsList(sourceGroups, accountId));

  // Horarios (resumen de campañas en modo FIXED)
  const fixedCampaigns = campaigns.filter((c) => c.scheduleMode === "FIXED");
  appEl.appendChild(el("div", { class: "section-title-row" }, [
    el("h2", {}, "Horarios de envío"),
    fixedCampaigns.length > 0
      ? el("button", { class: "primary", onclick: () => openScheduleModal(fixedCampaigns[0], campaigns, fixedCampaigns) }, "Editar horarios")
      : null,
  ]));
  if (fixedCampaigns.length === 0) {
    appEl.appendChild(el("div", { class: "empty" }, "Ninguna campaña está en modo \"Horarios fijos\" (usa el modo Aleatorio, o cámbialo desde Editar)."));
  } else {
    const card = el("div", { class: "card" });
    for (const c of fixedCampaigns) {
      const body = el("div", { style: "display:none;padding:4px 0 10px" });
      let loaded = false;
      const row = el("div", { class: "accordion-row" }, [
        el("span", {}, ["▸ ", c.folderName]),
        el("span", { class: "accordion-count" }, "cargando..."),
      ]);
      row.addEventListener("click", async () => {
        const open = body.style.display !== "none";
        body.style.display = open ? "none" : "block";
        row.firstChild.textContent = (open ? "▸ " : "▾ ") + c.folderName;
        if (!open && !loaded) {
          loaded = true;
          await renderScheduleSlotsInline(c.id, body);
        }
      });
      card.appendChild(row);
      card.appendChild(body);
      api(`/campaigns/${c.id}/schedule-slots`).then(({ slots }) => {
        const active = slots.filter((s) => s.active);
        if (active.length === 0) { row.lastChild.textContent = "Sin horarios"; return; }
        const times = active.map((s) => s.timeOfDay).sort();
        row.lastChild.textContent = `${active.length} horarios · de ${times[0]} a ${times[times.length - 1]}`;
      }).catch(() => { row.lastChild.textContent = ""; });
    }
    appEl.appendChild(card);
  }

  // Consola
  appEl.appendChild(el("div", { class: "section-title-row" }, [el("h2", {}, "Consola")]));
  appEl.appendChild(await renderConsole(accountId, campaigns));
}

function renderAccountStatusCard(account, status, campaigns, nextSend) {
  const activeCampaigns = campaigns.filter((c) => c.status === "ACTIVE").length;
  const totalDestinos = campaigns.reduce((sum, c) => sum + c._count.destinationChats, 0);

  // "Proximo envio" viene de /accounts/:id/next-send, ya calculado en la
  // hora DE LA CUENTA (nextSend.timeOfDay es "HH:mm" en su timezone, no en
  // la del navegador) - por eso se muestra tal cual, sin reformatear con la
  // hora local del que mira el panel.
  let nextSendText = "—";
  if (!account.reenviadorEnabled) {
    nextSendText = "Reenviador apagado";
  } else if (nextSend?.nextSend) {
    nextSendText = `${nextSend.nextSend.timeOfDay} ${nextSend.nextSend.when} (${nextSend.nextSend.folderName})`;
  } else if (nextSend?.reason === "sin_horarios") {
    nextSendText = "Sin horarios fijos configurados";
  }

  const statePill = !account.reenviadorEnabled
    ? el("span", { class: "pill off" }, [el("span", { class: "dot" }), "Apagado"])
    : account.health === "PEER_FLOOD_PAUSED"
    ? el("span", { class: "pill danger" }, [el("span", { class: "dot" }), "Pausado por PeerFlood"])
    : el("span", { class: "pill ok" }, [el("span", { class: "dot" }), "Encendido"]);

  const switchInput = el("input", { type: "checkbox" });
  switchInput.checked = account.reenviadorEnabled;
  switchInput.addEventListener("change", async (e) => {
    const turningOn = e.target.checked;
    e.target.disabled = true;
    const ok = await confirmModal({
      title: turningOn ? "¿Encender el reenviador?" : "¿Apagar el reenviador?",
      body: turningOn
        ? `Vas a ENCENDER el interruptor maestro de "${account.label}". Cualquier campaña ACTIVA de esta cuenta empezará a enviar automáticamente en su horario. Revisa antes que las campañas y destinos son correctos.`
        : `Vas a apagar el interruptor de "${account.label}". Se detendrán todos los envíos de inmediato.`,
      confirmLabel: turningOn ? "Sí, encender" : "Sí, apagar",
      danger: turningOn,
    });
    if (!ok) { e.target.checked = !turningOn; e.target.disabled = false; return; }
    try {
      await api(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ reenviadorEnabled: turningOn }) });
      toast(turningOn ? "Reenviador encendido" : "Reenviador apagado");
      renderAccountList();
      state.accounts = (await api("/accounts")).accounts;
      renderAccountList();
    } catch (err) {
      toast(err.message, true);
      e.target.checked = !turningOn;
    } finally {
      e.target.disabled = false;
    }
  });

  return el("div", { class: "card" }, [
    el("div", { class: "card-row" }, [
      statePill,
      el("div", { style: "display:flex;gap:10px;align-items:center" }, [
        el("label", { class: "switch" }, [switchInput, el("span", { class: "slider" })]),
        el("button", { onclick: () => openAccountSettingsModal(account) }, "Configurar cuenta"),
      ]),
    ]),
    el("div", { class: "status-grid" }, [
      statField("Campañas activas", `${activeCampaigns} / ${campaigns.length}`),
      statField("Destinos totales", String(totalDestinos)),
      statField("Zona horaria", account.timezone),
      statField("Próximo envío", nextSendText),
      statField("Enviados hoy", String(status.sentToday)),
      statField("Errores hoy", String(status.errorsToday)),
      statField("Aviso WhatsApp", account.notifyWhatsAppTo || "sin configurar"),
    ]),
  ]);
}

function statField(label, value) {
  return el("div", {}, [el("div", { class: "label" }, label), el("div", { class: "value" }, value)]);
}

function openAccountSettingsModal(account) {
  const timezone = el("input", { value: account.timezone });
  const notifyWhatsAppTo = el("input", { value: account.notifyWhatsAppTo || "", placeholder: "+34600111222" });
  const peerFloodPauseMinutes = el("input", { type: "number", value: account.peerFloodPauseMinutes });
  const softStartCycles = el("input", { type: "number", value: account.softStartCycles });
  const firstCycleSendCap = el("input", { type: "number", value: account.firstCycleSendCap });
  const firstCycleLinkFraction = el("input", { type: "number", step: "0.1", value: account.firstCycleLinkFraction });
  const missedSlotToleranceMinutes = el("input", { type: "number", value: account.missedSlotToleranceMinutes });

  let selectedExtraFolders = [];
  try { selectedExtraFolders = JSON.parse(account.extraMessageFolders || "[]"); } catch { selectedExtraFolders = []; }
  const foldersBox = el("div", { class: "folders-checkbox-list" }, el("div", { class: "empty" }, "Cargando carpetas de Telegram..."));

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Configurar cuenta"));
    modal.appendChild(el("p", { class: "hint" }, "PeerFlood (protección anti-baneo) aplica a todas las campañas de esta cuenta."));
    modal.appendChild(el("div", { class: "grid-2" }, [
      el("div", { class: "field" }, [el("label", {}, "Zona horaria (IANA, ej. Europe/Madrid)"), timezone]),
      el("div", { class: "field" }, [el("label", {}, "Aviso WhatsApp (E.164)"), notifyWhatsAppTo]),
    ]));
    modal.appendChild(el("h2", { style: "margin-top:6px" }, "PeerFlood"));
    modal.appendChild(el("div", { class: "grid-3" }, [
      el("div", { class: "field" }, [el("label", {}, "Pausa total (min)"), peerFloodPauseMinutes]),
      el("div", { class: "field" }, [el("label", {}, "Ciclos de arranque suave"), softStartCycles]),
      el("div", { class: "field" }, [el("label", {}, "Tope envíos 1er ciclo"), firstCycleSendCap]),
      el("div", { class: "field" }, [el("label", {}, "Fracción con enlace (0-1)"), firstCycleLinkFraction]),
      el("div", { class: "field" }, [el("label", {}, "Tolerancia horario perdido (min)"), missedSlotToleranceMinutes]),
    ]));
    modal.appendChild(el("h2", { style: "margin-top:6px" }, "Mensajes"));
    modal.appendChild(el("p", { class: "hint" },
      "Además de los chats privados, elige qué carpetas de Telegram (Posibles, Clientes, Grupo cliente, grupos restringidos...) quieres que también aparezcan en el listado de Mensajes."));
    modal.appendChild(foldersBox);
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async () => {
          try {
            await api(`/accounts/${account.id}`, {
              method: "PATCH",
              body: JSON.stringify({
                timezone: timezone.value,
                notifyWhatsAppTo: notifyWhatsAppTo.value || null,
                peerFloodPauseMinutes: Number(peerFloodPauseMinutes.value),
                softStartCycles: Number(softStartCycles.value),
                firstCycleSendCap: Number(firstCycleSendCap.value),
                firstCycleLinkFraction: Number(firstCycleLinkFraction.value),
                missedSlotToleranceMinutes: Number(missedSlotToleranceMinutes.value),
                extraMessageFolders: selectedExtraFolders,
              }),
            });
            toast("Configuración de cuenta guardada");
            close();
            renderAccountView(account.id);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "Guardar"),
    ]));
  });

  api(`/accounts/${account.id}/telegram-folders`)
    .then(({ folders }) => {
      foldersBox.innerHTML = "";
      if (folders.length === 0) {
        foldersBox.appendChild(el("div", { class: "empty" }, "Esta cuenta no tiene carpetas creadas en Telegram."));
        return;
      }
      for (const f of folders) {
        const checkbox = el("input", { type: "checkbox" });
        checkbox.checked = selectedExtraFolders.includes(f.title);
        checkbox.addEventListener("change", () => {
          selectedExtraFolders = checkbox.checked
            ? [...selectedExtraFolders, f.title]
            : selectedExtraFolders.filter((t) => t !== f.title);
        });
        foldersBox.appendChild(el("label", { class: "folder-checkbox-row" }, [
          checkbox,
          el("span", {}, `${f.title} (${f.chatCount})`),
        ]));
      }
    })
    .catch(() => {
      foldersBox.innerHTML = "";
      foldersBox.appendChild(el("div", { class: "empty" }, "No se pudieron cargar las carpetas de Telegram."));
    });
}

// ---------- tabla de campañas ----------

function renderCampaignsTable(campaigns, account) {
  if (campaigns.length === 0) {
    return el("div", { class: "empty" }, "Sin campañas todavía. Usa \"+ Añadir carpeta\" para crear la primera.");
  }
  const table = el("table", {}, [
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Carpeta"), el("th", {}, "Ritmo"), el("th", {}, "Origen"),
      el("th", {}, "Último envío"), el("th", {}, "Estado"), el("th", {}, "Acciones"),
    ])),
  ]);
  const tbody = el("tbody");
  for (const c of campaigns) {
    const ritmo = c.scheduleMode === "RANDOM"
      ? `cada ~${Math.round(c.cycleSeconds / 60)} min · ${c.minForeignMessagesBeforeRepeat} msj. ajenos`
      : "horarios fijos";
    const estadoPill = c.status === "ACTIVE"
      ? el("span", { class: "pill ok" }, [el("span", { class: "dot" }), "Activa"])
      : el("span", { class: "pill off" }, [el("span", { class: "dot" }), "Pausada"]);

    tbody.appendChild(el("tr", {}, [
      el("td", {}, [
        el("div", { class: "folder-name" }, c.folderName),
        el("div", { class: "muted" }, (() => {
          const excludedCount = (c.destinationChats || []).filter((d) => d.excluded).length;
          return `${c._count.destinationChats} destino(s)` + (excludedCount > 0 ? ` (${excludedCount} excluido${excludedCount === 1 ? "" : "s"})` : "");
        })()),
      ]),
      el("td", { class: "muted" }, ritmo),
      el("td", { class: "muted" }, c.sourceGroup.title),
      el("td", { class: "muted" }, fmtDate(c.lastSentAt)),
      el("td", {}, estadoPill),
      el("td", { class: "actions" }, [
        c.status === "ACTIVE"
          ? el("button", { class: "sm danger", onclick: () => toggleCampaign(c, false, account) }, "Pausar")
          : el("button", { class: "sm primary", onclick: () => toggleCampaign(c, true, account) }, "Activar"),
        el("button", { class: "sm", onclick: () => openManualSendModal(c, account) }, "Enviar manual"),
        el("button", { class: "sm", onclick: () => openEditCampaignModal(c) }, "Editar"),
        el("button", { class: "sm danger", onclick: () => deleteCampaign(c) }, "Quitar"),
      ]),
    ]));
  }
  table.appendChild(tbody);
  return el("div", { class: "card" }, table);
}

async function toggleCampaign(campaign, activate, account) {
  if (activate && !account.reenviadorEnabled) {
    const proceed = await confirmModal({
      title: "El interruptor maestro está apagado",
      body: `"${account.label}" tiene el reenviador apagado, así que aunque actives esta campaña no se enviará nada hasta que lo enciendas desde arriba. ¿Activar igualmente la campaña?`,
      confirmLabel: "Activar campaña igualmente",
    });
    if (!proceed) return;
  }
  const ok = await confirmModal({
    title: activate ? "¿Activar campaña?" : "¿Pausar campaña?",
    body: activate
      ? "La campaña empezará a enviar automáticamente según su ritmo/horarios. Revisa destinos y configuración antes de confirmar."
      : "Se detendrán los envíos automáticos de esta campaña.",
    confirmLabel: activate ? "Sí, activar" : "Sí, pausar",
    danger: activate,
  });
  if (!ok) return;
  try {
    await api(`/campaigns/${campaign.id}`, { method: "PATCH", body: JSON.stringify({ status: activate ? "ACTIVE" : "PAUSED" }) });
    toast(activate ? "Campaña activada" : "Campaña pausada");
    renderAccountView(state.currentAccountId);
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteCampaign(campaign) {
  const ok = await confirmModal({ title: "¿Eliminar esta campaña?", body: `Se borrará "${campaign.folderName}" y todos sus destinos. No se puede deshacer.`, confirmLabel: "Eliminar", danger: true });
  if (!ok) return;
  try {
    await api(`/campaigns/${campaign.id}`, { method: "DELETE" });
    toast("Campaña eliminada");
    renderAccountView(state.currentAccountId);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- modal: envío manual ----------
// "Enviar manual" del Reenviador: manda YA, sin esperar a ningún horario ni
// al ritmo aleatorio, el post que ocupa la posición elegida entre los
// mensajes recientes del origen ya configurado en esta campaña, a los
// destinos que se elijan (con casillas, para poder mandar solo a algunos en
// vez de a toda la carpeta). Reutiliza el mismo desplegable de posiciones
// (con preview de cada una) que "Horarios de envío".
function openManualSendModal(campaign, account) {
  openModal(async (modal, close) => {
    modal.appendChild(el("h3", {}, `Enviar manual — ${campaign.folderName}`));
    modal.appendChild(el("p", { class: "hint" },
      `Manda ahora mismo, fuera de cualquier horario, el post elegido (origen: "${campaign.sourceGroup.title}") a los destinos que marques de esta carpeta.`));

    if (!account.reenviadorEnabled) {
      modal.appendChild(el("p", { class: "hint", style: "color:var(--amber)" }, "El interruptor maestro del reenviador está apagado para esta cuenta, pero el envío manual funciona igualmente (es independiente del automático)."));
    }

    // --- destinos: casillas para elegir a cuales de la carpeta se manda ---
    const destinations = campaign.destinationChats || [];
    const destField = el("div", { class: "field" });
    destField.appendChild(el("label", {}, `Destinos (${destinations.length} en esta carpeta)`));
    const destChecks = [];
    if (destinations.length === 0) {
      destField.appendChild(el("p", { class: "hint" }, "Esta carpeta no tiene ningún destino configurado todavía."));
    } else {
      const destList = el("div", { class: "folders-checkbox-list" });
      for (const d of destinations) {
        const ck = el("input", { type: "checkbox" });
        // Por defecto, respeta lo marcado como "no enviar" en Editar campaña
        // (ver excluded) - se puede marcar a mano igualmente, es solo el
        // punto de partida.
        ck.checked = !d.excluded;
        destChecks.push({ id: d.id, checkbox: ck });
        destList.appendChild(el("label", { class: "folder-checkbox-row" }, [ck, el("span", {}, d.chatTitle + (d.excluded ? " (excluido del envío automático)" : ""))]));
      }
      destField.appendChild(destList);
      const allBtn = el("button", { type: "button", class: "sm" }, "Marcar todos");
      const noneBtn = el("button", { type: "button", class: "sm" }, "Marcar ninguno");
      allBtn.addEventListener("click", () => destChecks.forEach((d) => { d.checkbox.checked = true; }));
      noneBtn.addEventListener("click", () => destChecks.forEach((d) => { d.checkbox.checked = false; }));
      destField.appendChild(el("div", { style: "margin-top:6px" }, [allBtn, noneBtn]));
    }
    modal.appendChild(destField);

    const previewInfo = el("p", { class: "hint" }, "Detectando mensajes del origen...");
    modal.appendChild(previewInfo);

    const positionField = el("div", { class: "field" });
    modal.appendChild(positionField);

    let positionSelect = null;
    try {
      const res = await api(`/campaigns/${campaign.id}/schedule-slots/source-preview`);
      const previews = res.messages;
      if (previews.length > 0) {
        previewInfo.textContent = `El origen tiene ahora mismo ${previews.length} mensaje(s) detectado(s) (foto/fotos + texto), disponibles como posiciones 1–${previews.length}.`;
        positionSelect = el("select", {}, previews.map((p) =>
          el("option", { value: p.position }, `Posición ${p.position} — ${p.preview}${p.mediaCount ? ` (${p.mediaCount} foto/s)` : ""}`)
        ));
      } else {
        previewInfo.textContent = "No se detectaron mensajes recientes en el origen todavía.";
        positionSelect = el("input", { type: "number", value: "1", min: "1" });
      }
    } catch (err) {
      previewInfo.textContent = "No se pudieron detectar los mensajes del origen ahora mismo (revisa la conexión de la cuenta). Puedes poner la posición a mano.";
      positionSelect = el("input", { type: "number", value: "1", min: "1" });
    }
    positionField.appendChild(el("label", {}, "Posición a enviar"));
    positionField.appendChild(positionSelect);

    const resultBox = el("div", { style: "margin-top:10px" });
    modal.appendChild(resultBox);

    const sendBtn = el("button", { class: "primary" }, "Enviar ahora");
    if (destinations.length === 0) sendBtn.disabled = true;
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cerrar"),
      sendBtn,
    ]));

    sendBtn.addEventListener("click", async () => {
      const chosenIds = destChecks.filter((d) => d.checkbox.checked).map((d) => d.id);
      if (chosenIds.length === 0) return toast("Elige al menos un destino", true);
      const ok = await confirmModal({
        title: "¿Enviar ahora?",
        body: `Se manda ya, a mano, el post de la posición ${positionSelect.value} a ${chosenIds.length} destino(s) de "${campaign.folderName}". No se puede deshacer.`,
        confirmLabel: "Sí, enviar",
        danger: true,
      });
      if (!ok) return;
      sendBtn.disabled = true;
      sendBtn.textContent = "Enviando...";
      resultBox.innerHTML = "";
      try {
        const res = await api(`/campaigns/${campaign.id}/manual-send`, {
          method: "POST",
          body: JSON.stringify({ position: Number(positionSelect.value), destinationIds: chosenIds }),
        });
        const okCount = res.results.filter((r) => r.ok).length;
        resultBox.appendChild(el("p", { class: "hint" }, `Enviado a ${okCount}/${res.results.length} destino(s).`));
        for (const r of res.results) {
          resultBox.appendChild(el("div", { class: "muted", style: "font-size:12.5px" },
            (r.ok ? "✅ " : "❌ ") + r.chatTitle + (r.error ? ` — ${r.error}` : "")));
        }
        if (res.peerFloodPaused) {
          resultBox.appendChild(el("p", { class: "hint", style: "color:var(--red)" }, "Telegram marcó la cuenta (PeerFlood) durante el envío: se paró y quedó pausada."));
        }
        toast("Envío manual completado");
      } catch (err) {
        toast(err.message, true);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Enviar ahora";
      }
    });
  });
}

// ---------- modal: editar campaña ----------

function openEditCampaignModal(c) {
  const folderName = el("input", { value: c.folderName });
  const sendMode = el("select", {}, [
    el("option", { value: "FORWARD_NO_AUTHOR", selected: c.sendMode === "FORWARD_NO_AUTHOR" ? "" : undefined }, "Reenvío sin autor (conserva emoji premium)"),
    el("option", { value: "COPY_AS_OWN", selected: c.sendMode === "COPY_AS_OWN" ? "" : undefined }, "Copiar como propio"),
  ]);
  sendMode.value = c.sendMode;
  const scheduleMode = el("select", {}, [
    el("option", { value: "RANDOM" }, "Aleatorio"),
    el("option", { value: "FIXED" }, "Horarios fijos"),
  ]);
  scheduleMode.value = c.scheduleMode;
  const sendAlbums = el("input", { type: "checkbox" }); sendAlbums.checked = c.sendAlbums;
  const textOnlyAllowed = el("input", { type: "checkbox" }); textOnlyAllowed.checked = c.textOnlyAllowed;

  const cycleMinutes = el("input", { type: "number", value: Math.round(c.cycleSeconds / 60) });
  const minGap = el("input", { type: "number", value: c.minGapSeconds });
  const maxGap = el("input", { type: "number", value: c.maxGapSeconds });
  const batchSize = el("input", { type: "number", value: c.batchSize });
  const batchRestMin = el("input", { type: "number", value: c.batchRestMinSeconds });
  const batchRestMax = el("input", { type: "number", value: c.batchRestMaxSeconds });
  const activeFrom = el("input", { type: "time", value: c.activeFrom });
  const activeTo = el("input", { type: "time", value: c.activeTo });
  const minForeign = el("input", { type: "number", value: c.minForeignMessagesBeforeRepeat });

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Editar campaña"));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre de la carpeta"), folderName]));
    modal.appendChild(el("div", { class: "grid-2" }, [
      el("div", { class: "field" }, [el("label", {}, "Modo de envío"), sendMode]),
      el("div", { class: "field" }, [el("label", {}, "Modo de programación"), scheduleMode]),
    ]));
    modal.appendChild(el("div", { class: "checkbox-row" }, [sendAlbums, "Enviar álbumes completos"]));
    modal.appendChild(el("div", { class: "checkbox-row" }, [textOnlyAllowed, "Permitir mensajes solo de texto"]));
    modal.appendChild(el("h2", { style: "margin-top:10px" }, "Ritmo (modo Aleatorio)"));
    modal.appendChild(el("div", { class: "grid-3" }, [
      el("div", { class: "field" }, [el("label", {}, "Ciclo cada (min)"), cycleMinutes]),
      el("div", { class: "field" }, [el("label", {}, "Pausa mín. (s)"), minGap]),
      el("div", { class: "field" }, [el("label", {}, "Pausa máx. (s)"), maxGap]),
      el("div", { class: "field" }, [el("label", {}, "Tamaño de lote"), batchSize]),
      el("div", { class: "field" }, [el("label", {}, "Descanso mín. lote (s)"), batchRestMin]),
      el("div", { class: "field" }, [el("label", {}, "Descanso máx. lote (s)"), batchRestMax]),
      el("div", { class: "field" }, [el("label", {}, "Horario desde"), activeFrom]),
      el("div", { class: "field" }, [el("label", {}, "Horario hasta"), activeTo]),
      el("div", { class: "field" }, [el("label", {}, "Msj. ajenos para repetir"), minForeign]),
    ]));
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async () => {
          try {
            await api(`/campaigns/${c.id}`, {
              method: "PATCH",
              body: JSON.stringify({
                folderName: folderName.value,
                sendMode: sendMode.value,
                scheduleMode: scheduleMode.value,
                sendAlbums: sendAlbums.checked,
                textOnlyAllowed: textOnlyAllowed.checked,
                cycleSeconds: Number(cycleMinutes.value) * 60,
                minGapSeconds: Number(minGap.value),
                maxGapSeconds: Number(maxGap.value),
                batchSize: Number(batchSize.value),
                batchRestMinSeconds: Number(batchRestMin.value),
                batchRestMaxSeconds: Number(batchRestMax.value),
                activeFrom: activeFrom.value,
                activeTo: activeTo.value,
                minForeignMessagesBeforeRepeat: Number(minForeign.value),
              }),
            });
            toast("Campaña actualizada");
            close();
            renderAccountView(state.currentAccountId);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "Guardar"),
    ]));

    // Destinos de esta campaña, gestionables desde el mismo modal. La
    // casilla es "seleccionar grupos a los que NO enviar": desmarcarla
    // excluye ese grupo del envío automático (aleatorio u horarios fijos)
    // SIN borrarlo - se puede volver a marcar en cualquier momento, sin
    // tener que releer la carpeta de Telegram. "Quitar" en cambio lo borra
    // del todo (para un grupo que ya no existe, p.ej.).
    modal.appendChild(el("h2", { style: "margin-top:18px" }, `Destinos (${c.destinationChats.length})`));
    modal.appendChild(el("p", { class: "hint" }, "Desmarca los grupos a los que NO quieras que llegue el reenvío automático (se quedan guardados, solo se saltan al enviar)."));
    const destBulkRow = el("div", { style: "margin-bottom:6px" });
    const destMarkAll = el("button", { type: "button", class: "sm" }, "Marcar todos");
    const destMarkNone = el("button", { type: "button", class: "sm" }, "Marcar ninguno");
    // "Volver a detectar": vuelve a leer la carpeta de Telegram y añade los
    // chats que falten (sin tocar ni duplicar los que ya están) - para
    // cuando al crear la campaña se quedaron destinos sin detectar porque
    // Telegram todavía no los tenía en caché (típico justo tras reiniciar
    // el servidor), ver el aviso al crear la campaña en openModal de arriba.
    const destRedetect = el("button", { type: "button", class: "sm" }, "Volver a detectar destinos de la carpeta");
    destRedetect.addEventListener("click", async () => {
      destRedetect.disabled = true;
      const originalLabel = destRedetect.textContent;
      destRedetect.textContent = "Buscando en la carpeta...";
      try {
        const res = await api(`/accounts/${c.accountId}/telegram-folders/${encodeURIComponent(c.folderName)}/chats?force=1`);
        const resolved = res.chats.filter((ch) => ch.title !== "(no se pudo resolver)");
        const already = new Set(c.destinationChats.map((d) => d.chatId));
        const missing = resolved.filter((ch) => !already.has(ch.chatId));
        let added = 0;
        for (const chat of missing) {
          try {
            await api(`/campaigns/${c.id}/destinations`, {
              method: "POST",
              body: JSON.stringify({ chatId: chat.chatId, chatTitle: chat.title, topicId: null }),
            });
            added++;
          } catch { /* duplicado u otro fallo puntual: sigue con el resto */ }
        }
        const unresolvedCount = res.unresolvedCount || 0;
        if (added > 0) {
          toast(`${added} destino(s) nuevo(s) añadido(s)` + (unresolvedCount > 0 ? ` - ${unresolvedCount} todavía sin detectar, prueba otra vez en un rato` : ""));
          close();
          renderAccountView(state.currentAccountId);
        } else if (unresolvedCount > 0) {
          toast(`No se añadió ninguno nuevo - ${unresolvedCount} chat(s) de la carpeta siguen sin poder leerse desde Telegram, prueba otra vez en un rato`, true);
        } else {
          toast("Ya estaban todos los destinos de la carpeta añadidos");
        }
      } catch (err) {
        toast(err.message, true);
      } finally {
        destRedetect.disabled = false;
        destRedetect.textContent = originalLabel;
      }
    });
    destBulkRow.appendChild(destMarkAll);
    destBulkRow.appendChild(destMarkNone);
    destBulkRow.appendChild(destRedetect);
    modal.appendChild(destBulkRow);
    const destCheckboxes = [];
    const destList = el("div", {});
    async function setDestExcluded(d, excluded, checkbox) {
      checkbox.disabled = true;
      try {
        await api(`/destinations/${d.id}`, { method: "PATCH", body: JSON.stringify({ excluded }) });
        d.excluded = excluded;
      } catch (err) {
        toast(err.message, true);
        checkbox.checked = !excluded; // revierte la casilla si falló el guardado
      } finally {
        checkbox.disabled = false;
      }
    }
    for (const d of c.destinationChats) {
      const ck = el("input", { type: "checkbox", title: "Marcado = se le envía; desmarcado = excluido" });
      ck.checked = !d.excluded;
      ck.addEventListener("change", () => setDestExcluded(d, !ck.checked, ck));
      destCheckboxes.push(ck);
      destList.appendChild(el("div", { class: "card-row", style: "padding:6px 0;border-bottom:1px solid rgba(212,180,131,0.08)" }, [
        el("label", { class: "folder-checkbox-row", style: "flex:1" }, [ck, el("span", {}, d.chatTitle)]),
        el("button", { class: "sm danger", onclick: async () => {
          try { await api(`/destinations/${d.id}`, { method: "DELETE" }); toast("Destino eliminado"); close(); renderAccountView(state.currentAccountId); }
          catch (err) { toast(err.message, true); }
        } }, "Quitar"),
      ]));
    }
    destMarkAll.addEventListener("click", () => {
      c.destinationChats.forEach((d, i) => { destCheckboxes[i].checked = true; setDestExcluded(d, false, destCheckboxes[i]); });
    });
    destMarkNone.addEventListener("click", () => {
      c.destinationChats.forEach((d, i) => { destCheckboxes[i].checked = false; setDestExcluded(d, true, destCheckboxes[i]); });
    });
    modal.appendChild(destList);
  }, { wide: true });
}

// ---------- modal: añadir campaña (carpeta) con selector en vivo de Telegram ----------

async function openAddCampaignModal(accountId, sourceGroups) {
  if (sourceGroups.length === 0) {
    toast("Primero crea al menos un origen (botón \"+ Nuevo origen\")", true);
    return;
  }

  // Carpeta de Telegram de CUALQUIER cuenta/modelo, no solo de la que se
  // está viendo ahora: algunas agencias organizan las carpetas de destino
  // en una sola cuenta (p.ej. la principal) y las reutilizan desde las
  // campañas de las demás - antes solo se podían elegir las carpetas de la
  // propia cuenta de la campaña. Esto solo afecta a DÓNDE se buscan/leen
  // las carpetas: la campaña en sí se sigue creando y enviando desde
  // "accountId" como siempre (para que un chat funcione como destino, esa
  // cuenta tiene que estar en ese chat igualmente, sea cual sea la carpeta
  // de origen elegida aquí).
  let allAccounts = [{ id: accountId, label: "Esta cuenta" }];
  try {
    const res = await api("/accounts");
    if (res.accounts && res.accounts.length > 0) allAccounts = res.accounts;
  } catch {
    // si falla, nos quedamos solo con la cuenta actual
  }
  let folderAccountId = accountId;

  const folderInput = el("input", { placeholder: "Escribe para buscar las carpetas de Telegram..." });
  const suggestionsBox = el("div", { class: "suggestion-list", style: "display:none" });
  const folderAccountSelect = el(
    "select",
    {},
    allAccounts.map((a) => el("option", { value: a.id }, a.id === accountId ? `${a.label} (esta cuenta)` : a.label))
  );
  folderAccountSelect.value = accountId;
  let selectedFolderTitle = null;
  let foldersCache = null;

  async function loadFoldersForSelectedAccount() {
    foldersCache = null;
    folderInput.value = "";
    selectedFolderTitle = null;
    suggestionsBox.style.display = "none";
    try {
      toast("Leyendo carpetas de Telegram...");
      const { folders } = await api(`/accounts/${folderAccountId}/telegram-folders`);
      foldersCache = folders;
    } catch (err) {
      toast(err.message, true);
      foldersCache = [];
    }
  }

  folderAccountSelect.addEventListener("change", () => {
    folderAccountId = folderAccountSelect.value;
    foldersCache = null; // se recarga la próxima vez que se enfoque el buscador
    folderInput.value = "";
    selectedFolderTitle = null;
  });

  folderInput.addEventListener("focus", async () => {
    if (!foldersCache) {
      await loadFoldersForSelectedAccount();
    }
    renderSuggestions(folderInput.value);
  });
  folderInput.addEventListener("input", () => renderSuggestions(folderInput.value));

  function renderSuggestions(query) {
    if (!foldersCache) return;
    const q = query.toLowerCase();
    // Antes se cortaba en 12 resultados - con el buscador vacío (recién
    // enfocado, sin escribir nada todavía) eso dejaba fuera cualquier
    // carpeta a partir de la 13ª, y con cuentas con muchas carpetas
    // compartidas (ver DialogFilterChatlist en folders.ts) esto es justo lo
    // que hacía parecer que "faltaban carpetas" aunque el backend ya las
    // estuviera devolviendo todas. 200 es de sobra para cualquier cuenta.
    const matches = foldersCache.filter((f) => f.title.toLowerCase().includes(q)).slice(0, 200);
    suggestionsBox.innerHTML = "";
    if (matches.length === 0) {
      suggestionsBox.style.display = "none";
      return;
    }
    for (const f of matches) {
      suggestionsBox.appendChild(el("div", {
        class: "suggestion-item",
        onclick: () => {
          folderInput.value = f.title;
          selectedFolderTitle = f.title;
          suggestionsBox.style.display = "none";
        },
      }, [f.title, el("span", { class: "count" }, `${f.chatCount} chats`)]));
    }
    suggestionsBox.style.display = "block";
  }

  const sourceSelect = el("select", {}, sourceGroups.map((sg) => el("option", { value: sg.id }, sg.title)));
  const scheduleModeSelect = el("select", {}, [
    el("option", { value: "RANDOM" }, "Aleatorio (cada X minutos, con pausas al azar)"),
    el("option", { value: "FIXED" }, "Horarios fijos (tú eliges a qué hora manda cada uno)"),
  ]);
  const cycleMinutes = el("input", { type: "number", value: "45" });
  const cycleField = el("div", { class: "field" }, [el("label", {}, "Cada cuántos minutos publica"), cycleMinutes]);
  const minForeign = el("input", { type: "number", value: "7" });
  const destTopicId = el("input", { placeholder: "Deja vacío si no aplica" });
  const activateNow = el("input", { type: "checkbox" });
  const scheduleModeHint = el("p", { class: "hint" });

  function updateScheduleModeUI() {
    const isFixed = scheduleModeSelect.value === "FIXED";
    cycleField.style.display = isFixed ? "none" : "";
    scheduleModeHint.textContent = isFixed
      ? "Al crearla se abrirán los horarios para que añadas a qué hora (y qué mensaje) manda cada uno."
      : "Publica sola cada tantos minutos, con pausas al azar entre lotes (lo de abajo).";
  }
  scheduleModeSelect.addEventListener("change", updateScheduleModeUI);

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Añadir carpeta"));
    modal.appendChild(el("p", { class: "hint" }, "Busca la carpeta de Telegram tal y como la tienes organizada. Puedes elegir carpetas de cualquier cuenta/modelo, no solo de esta. Al guardar, se crean automáticamente todos sus chats como destinos."));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Buscar carpetas de la cuenta"), folderAccountSelect]));
    modal.appendChild(el("div", { class: "field suggestions" }, [
      el("label", {}, "Carpeta de Telegram"),
      folderInput,
      suggestionsBox,
    ]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Origen (de dónde se reenvía)"), sourceSelect]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Modo de programación"), scheduleModeSelect]));
    updateScheduleModeUI();
    modal.appendChild(scheduleModeHint);
    modal.appendChild(el("div", { class: "grid-2" }, [
      cycleField,
      el("div", { class: "field" }, [el("label", {}, "Mensajes ajenos para repetir"), minForeign]),
    ]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Tema del destino (si son foros; vacío = general)"), destTopicId]));
    modal.appendChild(el("div", { class: "checkbox-row" }, [activateNow, "Activar la campaña nada más crearla"]));
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async () => {
          const folderTitle = folderInput.value.trim();
          if (!folderTitle) return toast("Elige una carpeta de Telegram", true);
          try {
            const { campaign } = await api(`/accounts/${accountId}/campaigns`, {
              method: "POST",
              body: JSON.stringify({
                sourceGroupId: sourceSelect.value,
                folderName: folderTitle,
                scheduleMode: scheduleModeSelect.value,
                cycleSeconds: Number(cycleMinutes.value) * 60,
              }),
            });
            await api(`/campaigns/${campaign.id}`, {
              method: "PATCH",
              body: JSON.stringify({ minForeignMessagesBeforeRepeat: Number(minForeign.value) }),
            });

            toast("Campaña creada, cargando destinos de la carpeta...");
            let chats = [];
            let unresolvedCount = 0;
            try {
              const res = await api(`/accounts/${folderAccountId}/telegram-folders/${encodeURIComponent(folderTitle)}/chats`);
              chats = res.chats.filter((ch) => ch.title !== "(no se pudo resolver)");
              unresolvedCount = res.unresolvedCount || 0;
            } catch (err) {
              toast("No se pudieron leer los chats de la carpeta automáticamente: " + err.message, true);
            }
            for (const chat of chats) {
              try {
                await api(`/campaigns/${campaign.id}/destinations`, {
                  method: "POST",
                  body: JSON.stringify({
                    chatId: chat.chatId,
                    chatTitle: chat.title,
                    topicId: chat.isForum && destTopicId.value ? Number(destTopicId.value) : null,
                  }),
                });
              } catch (err) {
                // sigue con el resto aunque uno falle (p.ej. duplicado)
              }
            }

            close();
            if (unresolvedCount > 0) {
              toast(
                `Campaña "${folderTitle}" creada con ${chats.length} destino(s) - ${unresolvedCount} no se pudieron detectar todavía (Telegram aún no los tiene en caché, pasa más justo tras reiniciar el servidor). Abre "Editar" en esta campaña en un minuto y pulsa "Volver a detectar destinos de la carpeta" para añadirlos.`,
                true
              );
            } else {
              toast(`Campaña "${folderTitle}" creada con ${chats.length} destino(s)`);
            }

            if (activateNow.checked) {
              const { account } = await api(`/accounts/${accountId}`);
              await toggleCampaign(campaign, true, account);
            } else {
              renderAccountView(accountId);
            }

            // Horarios fijos: sin al menos un horario no manda nada, así
            // que se abren de una vez en vez de dejar que el usuario tenga
            // que encontrar por su cuenta el botón "Editar horarios".
            if (scheduleModeSelect.value === "FIXED") {
              try {
                const { campaigns: freshCampaigns } = await api(`/accounts/${accountId}/campaigns`);
                const freshCampaign = freshCampaigns.find((fc) => fc.id === campaign.id) || campaign;
                const fixedCampaigns = freshCampaigns.filter((fc) => fc.scheduleMode === "FIXED");
                openScheduleModal(freshCampaign, freshCampaigns, fixedCampaigns);
              } catch {
                // si falla, los horarios se pueden añadir luego desde "Horarios de envío"
              }
            }
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "Crear campaña"),
    ]));
  });
}

// ---------- modal: copiar TODAS las campañas de esta cuenta a otra modelo ----------

async function openCopyCampaignsModal(accountId, accountLabel, campaignCount) {
  let allAccounts = [];
  try {
    const res = await api("/accounts");
    allAccounts = (res.accounts || []).filter((a) => a.id !== accountId);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (allAccounts.length === 0) {
    toast("No hay otra cuenta a la que copiar las campañas.", true);
    return;
  }

  const targetSelect = el("select", {}, allAccounts.map((a) => el("option", { value: a.id }, a.label)));
  const sourceGroupSelect = el("select", {}, [el("option", { value: "" }, "Cargando orígenes...")]);
  sourceGroupSelect.disabled = true;

  async function loadTargetSourceGroups() {
    sourceGroupSelect.innerHTML = "";
    sourceGroupSelect.disabled = true;
    sourceGroupSelect.appendChild(el("option", { value: "" }, "Cargando orígenes..."));
    try {
      const { sourceGroups } = await api(`/accounts/${targetSelect.value}/source-groups`);
      sourceGroupSelect.innerHTML = "";
      if (sourceGroups.length === 0) {
        sourceGroupSelect.appendChild(el("option", { value: "" }, "Esa cuenta no tiene ningún origen todavía"));
        return;
      }
      for (const sg of sourceGroups) {
        sourceGroupSelect.appendChild(el("option", { value: sg.id }, sg.title));
      }
      sourceGroupSelect.disabled = false;
    } catch (err) {
      sourceGroupSelect.innerHTML = "";
      sourceGroupSelect.appendChild(el("option", { value: "" }, "Error cargando orígenes"));
      toast(err.message, true);
    }
  }
  targetSelect.addEventListener("change", loadTargetSourceGroups);
  await loadTargetSourceGroups();

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Copiar todas las campañas a otra modelo"));
    modal.appendChild(el("p", { class: "hint" },
      `Copia las ${campaignCount} campaña(s) de "${accountLabel}" (ajustes, horarios y destinos) a otra cuenta. Las campañas nuevas nacen en pausa - revísalas antes de activarlas.`));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Copiar a la cuenta/modelo"), targetSelect]));
    modal.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Origen que usarán las campañas copiadas"),
      sourceGroupSelect,
    ]));
    modal.appendChild(el("p", { class: "hint" }, "Las campañas están ligadas a un origen (de dónde se reenvía) de su propia cuenta, así que hace falta elegir cuál usar en la cuenta destino - los destinos (grupos/canales) y el resto de ajustes se copian tal cual."));
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async (e) => {
          if (!sourceGroupSelect.value) return toast("Elige el origen de la cuenta destino", true);
          e.target.disabled = true;
          try {
            const res = await api(`/accounts/${accountId}/campaigns/copy-to`, {
              method: "POST",
              body: JSON.stringify({ targetAccountId: targetSelect.value, targetSourceGroupId: sourceGroupSelect.value }),
            });
            toast(`${res.count} campaña(s) copiada(s), en pausa`);
            close();
          } catch (err) {
            toast(err.message, true);
            e.target.disabled = false;
          }
        },
      }, "Copiar campañas"),
    ]));
  });
}

// ---------- orígenes ----------

function renderSourceGroupsList(sourceGroups, accountId) {
  if (sourceGroups.length === 0) return el("div", { class: "empty" }, "Sin orígenes todavía.");
  const card = el("div", { class: "card" });
  for (const sg of sourceGroups) {
    card.appendChild(el("div", { class: "card-row", style: "padding:8px 0;border-bottom:1px solid rgba(212,180,131,0.08)" }, [
      el("div", {}, [
        el("div", { style: "font-weight:600;font-size:13.5px" }, sg.title),
        el("div", { class: "muted" }, `chatId: ${sg.chatId}${sg.topicId ? " · topicId: " + sg.topicId : ""} · ${sg.recentLimit} mensajes recientes`),
      ]),
      el("div", { style: "display:flex;gap:6px" }, [
        el("button", { class: "sm", onclick: () => checkOrigin(sg.id) }, "Comprobar origen"),
        el("button", { class: "sm", onclick: () => openEditSourceGroupModal(sg, accountId) }, "Editar"),
        el("button", { class: "sm danger", onclick: () => deleteSourceGroup(sg.id, accountId) }, "Eliminar"),
      ]),
    ]));
  }
  return card;
}

async function checkOrigin(id) {
  try {
    toast("Comprobando origen...");
    const res = await api(`/source-groups/${id}/check`, { method: "POST" });
    toast(`OK: ${res.postsFound} post(s) recientes encontrados en el origen`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteSourceGroup(id, accountId) {
  const ok = await confirmModal({ title: "¿Eliminar este origen?", body: "Esta acción no se puede deshacer.", confirmLabel: "Eliminar", danger: true });
  if (!ok) return;
  try {
    await api(`/source-groups/${id}`, { method: "DELETE" });
    toast("Origen eliminado");
    renderAccountView(accountId);
  } catch (err) {
    toast(err.message, true);
  }
}

function openAddSourceGroupModal(accountId) {
  const title = el("input", { placeholder: 'Ej. "SPAMS GRUPOS (verde - con enlace)"' });
  const chatId = el("input", { placeholder: "Ej. -1003465003140" });
  const topicId = el("input", { placeholder: "Deja vacío si no es un foro" });
  const recentLimit = el("input", { type: "number", value: "25", min: "1" });

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Nuevo origen"));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Título"), title]));
    modal.appendChild(el("div", { class: "grid-2" }, [
      el("div", { class: "field" }, [el("label", {}, "chatId"), chatId]),
      el("div", { class: "field" }, [el("label", {}, "topicId (opcional)"), topicId]),
    ]));
    modal.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Mensajes recientes del origen (nº de spams distintos que rota, ej. 25)"),
      recentLimit,
    ]));
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async () => {
          if (!title.value || !chatId.value) return toast("Rellena título y chatId", true);
          try {
            await api(`/accounts/${accountId}/source-groups`, {
              method: "POST",
              body: JSON.stringify({
                title: title.value,
                chatId: chatId.value,
                topicId: topicId.value ? Number(topicId.value) : null,
                recentLimit: Number(recentLimit.value) || 25,
              }),
            });
            toast("Origen creado");
            close();
            renderAccountView(accountId);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "Crear origen"),
    ]));
  });
}

function openEditSourceGroupModal(sg, accountId) {
  const title = el("input", { value: sg.title });
  const chatId = el("input", { value: sg.chatId });
  const topicId = el("input", { value: sg.topicId ?? "", placeholder: "Deja vacío si no es un foro" });
  const recentLimit = el("input", { type: "number", value: sg.recentLimit, min: "1" });

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Editar origen"));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Título"), title]));
    modal.appendChild(el("div", { class: "grid-2" }, [
      el("div", { class: "field" }, [el("label", {}, "chatId"), chatId]),
      el("div", { class: "field" }, [el("label", {}, "topicId (opcional)"), topicId]),
    ]));
    modal.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Mensajes recientes del origen (nº de spams distintos que rota, ej. 25)"),
      recentLimit,
    ]));
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      el("button", {
        class: "primary",
        onclick: async () => {
          try {
            await api(`/source-groups/${sg.id}`, {
              method: "PATCH",
              body: JSON.stringify({
                title: title.value,
                chatId: chatId.value,
                topicId: topicId.value ? Number(topicId.value) : null,
                recentLimit: Number(recentLimit.value) || 25,
              }),
            });
            toast("Origen actualizado");
            close();
            renderAccountView(accountId);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "Guardar"),
    ]));
  });
}

// ---------- horarios fijos ----------

function openScheduleModal(campaign, allCampaigns, folderPickerCampaigns) {
  openModal(async (modal, close) => {
    modal.appendChild(el("h3", {}, `Horarios de envío — ${campaign.folderName}`));
    modal.appendChild(el("p", { class: "hint" },
      "Cada fila manda, todos los días a esa hora, el post (foto/fotos + texto) que hoy ocupa esa posición entre los más recientes del origen (posición 1 = el más antiguo de ellos, la última posición el más nuevo). Así puedes repartir manualmente qué spam concreto va en cada horario, sin que se repita el mismo dentro de las 24h."));

    const previewInfo = el("p", { class: "hint", style: "margin-top:-10px" }, "Detectando mensajes del origen...");
    modal.appendChild(previewInfo);
    let previews = null; // se rellena abajo: [{position, preview, mediaCount}]
    try {
      const res = await api(`/campaigns/${campaign.id}/schedule-slots/source-preview`);
      previews = res.messages;
      previewInfo.textContent = previews.length > 0
        ? `El origen tiene ahora mismo ${previews.length} mensaje(s) detectado(s) (foto/fotos + texto), disponibles como posiciones 1–${previews.length}.`
        : "No se detectaron mensajes recientes en el origen todavía.";
    } catch (err) {
      previewInfo.textContent = "No se pudieron detectar los mensajes del origen ahora mismo (revisa la conexión de la cuenta). Puedes seguir poniendo la posición a mano.";
    }

    if (folderPickerCampaigns && folderPickerCampaigns.length > 1) {
      const folderSelect = el("select", {}, folderPickerCampaigns.map((c) => el("option", { value: c.id }, c.folderName)));
      folderSelect.value = campaign.id;
      folderSelect.addEventListener("change", () => {
        const next = folderPickerCampaigns.find((c) => c.id === folderSelect.value);
        close();
        openScheduleModal(next, allCampaigns, folderPickerCampaigns);
      });
      modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Carpeta"), folderSelect]));
    }

    const others = allCampaigns.filter((c) => c.id !== campaign.id);
    if (others.length > 0) {
      const copySelect = el("select", {}, [el("option", { value: "" }, "Elige una campaña..."), ...others.map((c) => el("option", { value: c.id }, c.folderName))]);
      modal.appendChild(el("div", { class: "card-row", style: "margin-bottom:16px" }, [
        el("div", { style: "flex:1" }, [el("label", {}, "Copiar horarios de otra campaña"), copySelect]),
        el("button", {
          onclick: async () => {
            if (!copySelect.value) return;
            try {
  const copyRes = await api(`/campaigns/${campaign.id}/schedule-slots/copy-from/${copySelect.value}`, { method: "POST" });
              toast(copyRes.appliedOffsetMinutes ? `Horarios copiados (desplazados +${copyRes.appliedOffsetMinutes} min para no coincidir con otra carpeta)` : "Horarios copiados");
              close();
              openScheduleModal(campaign, allCampaigns, folderPickerCampaigns);
            } catch (err) {
              toast(err.message, true);
            }
          },
        }, "Copiar"),
      ]));
    }

    const slotsContainer = el("div", {});
    modal.appendChild(slotsContainer);

    const newTime = el("input", { type: "time", value: "09:00" });
    const newPosition = previews && previews.length > 0
      ? el("select", { class: "position-select" }, previews.map((p) =>
          el("option", { value: p.position }, `Posición ${p.position} — ${p.preview}${p.mediaCount ? ` (${p.mediaCount} foto/s)` : ""}`)
        ))
      : el("input", { type: "number", value: "1", min: "1" });
    modal.appendChild(el("div", { class: "slot-add-row" }, [
      newTime, newPosition,
      el("button", {
        class: "primary sm",
        onclick: async () => {
          try {
            await api(`/campaigns/${campaign.id}/schedule-slots`, {
              method: "POST",
              body: JSON.stringify({ timeOfDay: newTime.value, position: Number(newPosition.value) }),
            });
            close();
            openScheduleModal(campaign, allCampaigns, folderPickerCampaigns);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "+ Añadir horario"),
      el("button", {
        class: "sm",
        onclick: async () => {
          try {
const genRes = await api(`/campaigns/${campaign.id}/schedule-slots/bulk-generate`, {
              method: "POST",
              body: JSON.stringify({
                intervalMinutes: 60,
                from: "00:00",
                to: "23:00",
                distinctMessages: previews && previews.length > 0 ? previews.length : undefined,
              }),
            });
            toast(genRes.appliedOffsetMinutes
              ? `Horarios generados cada hora, desplazados +${genRes.appliedOffsetMinutes} min para no coincidir con otra carpeta de esta cuenta`
              : "Horarios generados cada hora, cubriendo las 24h sin repetir el mismo spam");
            close();
            openScheduleModal(campaign, allCampaigns, folderPickerCampaigns);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "+ Añadir todos los horarios"),
      el("button", {
        class: "sm danger",
        onclick: async () => {
          const ok = await confirmModal({ title: "¿Quitar todos los horarios?", body: `Se borrarán todos los horarios de "${campaign.folderName}". No se puede deshacer.`, confirmLabel: "Quitar todos", danger: true });
          if (!ok) return;
          try {
            await api(`/campaigns/${campaign.id}/schedule-slots`, { method: "DELETE" });
            toast("Horarios eliminados");
            close();
            openScheduleModal(campaign, allCampaigns, folderPickerCampaigns);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "Quitar todos"),
    ]));

    // "Desplazar todos los horarios": mueve la hora de TODOS los horarios ya
    // creados el mismo número de minutos, sin tocar qué posición manda cada
    // uno ni si está activo - solo cambia el "a qué hora". Útil para pasar
    // de "en punto" a "y media" (o al revés) de golpe, en vez de editar
    // horario por horario.
    const shiftMinutes = el("input", { type: "number", value: "30", style: "width:80px" });
    modal.appendChild(el("div", { class: "card-row", style: "margin: 4px 0 16px" }, [
      el("div", { style: "flex:1" }, [el("label", {}, "Desplazar todos los horarios (minutos, negativo para atrasar)"), shiftMinutes]),
      el("button", {
        class: "sm",
        onclick: async () => {
          const mins = Number(shiftMinutes.value);
          if (!mins) return toast("Pon un número de minutos distinto de 0", true);
          try {
            await api(`/campaigns/${campaign.id}/schedule-slots/shift`, {
              method: "POST",
              body: JSON.stringify({ minutes: mins }),
            });
            toast(`Horarios desplazados ${mins > 0 ? "+" : ""}${mins} min`);
            close();
            openScheduleModal(campaign, allCampaigns, folderPickerCampaigns);
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, "Desplazar"),
    ]));

    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "primary", onclick: close }, "Cerrar")]));

    try {
      const { slots } = await api(`/campaigns/${campaign.id}/schedule-slots`);
      if (slots.length === 0) {
        slotsContainer.appendChild(el("div", { class: "empty" }, "Sin horarios todavía."));
      }
      const previewByPosition = new Map((previews || []).map((p) => [p.position, p]));
      const sortedSlots = [...slots].sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));
      for (const s of sortedSlots) {
        const activeCheckbox = el("input", { type: "checkbox" });
        activeCheckbox.checked = s.active;
        activeCheckbox.addEventListener("change", async () => {
          try { await api(`/schedule-slots/${s.id}`, { method: "PATCH", body: JSON.stringify({ active: activeCheckbox.checked }) }); }
          catch (err) { toast(err.message, true); }
        });
        const p = previewByPosition.get(s.position);
        const previewText = p ? `Posición ${s.position} — ${p.preview}${p.mediaCount ? ` (${p.mediaCount} foto/s)` : ""}` : `Posición ${s.position}`;
        slotsContainer.appendChild(el("div", { class: "slot-row" }, [
          el("span", {}, s.timeOfDay),
          el("span", { class: "slot-preview", title: previewText }, previewText),
          el("span", { class: "muted" }, s.lastRunDate ? `Último: ${s.lastRunDate}` : "Sin enviar aún"),
          el("label", { class: "slot-active-label" }, [activeCheckbox, "Activo"]),
          el("button", {
            class: "sm danger", onclick: async () => {
              try { await api(`/schedule-slots/${s.id}`, { method: "DELETE" }); close(); openScheduleModal(campaign, allCampaigns, folderPickerCampaigns); }
              catch (err) { toast(err.message, true); }
            },
          }, "Quitar"),
        ]));
      }
    } catch (err) {
      toast(err.message, true);
    }
  }, { wide: true });
}

async function renderScheduleSlotsInline(campaignId, container) {
  container.innerHTML = "Cargando...";
  try {
    const { slots } = await api(`/campaigns/${campaignId}/schedule-slots`);
    if (slots.length === 0) {
      container.innerHTML = "";
      container.appendChild(el("div", { class: "empty" }, "Sin horarios todavía."));
      return;
    }
    const sorted = [...slots].sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));
    const table = el("table", {}, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "Hora"), el("th", {}, "Posición"), el("th", {}, "Último disparo"), el("th", {}, "Estado"),
      ])),
    ]);
    const tbody = el("tbody");
    for (const s of sorted) {
      tbody.appendChild(el("tr", {}, [
        el("td", {}, s.timeOfDay),
        el("td", { class: "muted" }, `posición ${s.position}`),
        el("td", { class: "muted" }, s.lastRunDate || "—"),
        el("td", {}, s.active ? el("span", { class: "pill ok" }, [el("span", { class: "dot" }), "Activo"]) : el("span", { class: "pill off" }, [el("span", { class: "dot" }), "Inactivo"])),
      ]));
    }
    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("div", { class: "empty" }, "Error cargando horarios: " + err.message));
  }
}

// ---------- consola / logs ----------

const LOG_TABS = [
  { key: "", label: "Todo" },
  { key: "SENT", label: "Publicados" },
  { key: "ERROR", label: "Problemas" },
  { key: "WAIT", label: "Esperas" },
];

async function renderConsole(accountId, campaigns) {
  const wrapper = el("div", {});
  const tabsEl = el("div", { class: "tabs" });
  const campaignSelect = el("select", {}, [
    el("option", { value: "" }, "Todas las carpetas"),
    ...campaigns.map((c) => el("option", { value: c.id }, c.folderName)),
  ]);
  const searchInput = el("input", { placeholder: "Buscar texto...", style: "flex:1;min-width:160px" });
  const reloadBtn = el("button", { class: "dialogs-reload-btn", title: "Recargar" }, "🔄");
  const summary = el("div", { class: "console-summary" });
  const results = el("div", {});

  let currentLevel = "";
  for (const tab of LOG_TABS) {
    const tabEl = el("div", { class: "tab" + (tab.key === currentLevel ? " active" : "") }, tab.label);
    tabEl.addEventListener("click", () => {
      currentLevel = tab.key;
      [...tabsEl.children].forEach((c) => c.classList.remove("active"));
      tabEl.classList.add("active");
      load();
    });
    tabsEl.appendChild(tabEl);
  }

  async function load() {
    const params = new URLSearchParams();
    params.set("accountId", accountId);
    if (currentLevel) params.set("level", currentLevel);
    if (campaignSelect.value) params.set("campaignId", campaignSelect.value);
    if (searchInput.value) params.set("search", searchInput.value);
    params.set("limit", "150");
    const { logs, total, errorCount } = await api("/logs?" + params.toString());
    summary.textContent = `${total} registro(s) · ${errorCount} error(es) · se conservan 7 días`;
    results.innerHTML = "";
    if (logs.length === 0) {
      results.appendChild(el("div", { class: "empty" }, "Sin resultados."));
      return;
    }
    const card = el("div", { class: "card" });
    for (const l of logs) {
      // El motivo real del fallo (error de Telegram) se guarda aparte en
      // errorCode y antes se perdia: el mensaje generico ("fallo enviando
      // mensaje origen N") no decia POR QUE fallaba. Si hay errorCode se
      // muestra debajo, en una linea aparte para que se distinga del resto.
      const rowChildren = [
        el("span", { class: "log-time" }, fmtDate(l.createdAt)),
        el("span", { class: "log-level " + l.level }, l.level),
        el("span", { class: "log-campaign", title: l.folderName || "" }, l.folderName || "—"),
        el("span", { class: "log-folder" }, l.chatTitle || ""),
        el("span", {}, l.message),
      ];
      if (l.errorCode) {
        rowChildren.push(el("span", { class: "log-reason" }, l.errorCode));
      }
      card.appendChild(el("div", { class: "log-row" }, rowChildren));
    }
    results.appendChild(card);
  }

  campaignSelect.addEventListener("change", load);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  reloadBtn.addEventListener("click", async () => {
    reloadBtn.disabled = true;
    reloadBtn.classList.add("spinning");
    try {
      await load();
    } finally {
      reloadBtn.disabled = false;
      reloadBtn.classList.remove("spinning");
    }
  });

  wrapper.appendChild(tabsEl);
  wrapper.appendChild(el("div", { class: "filters" }, [campaignSelect, searchInput, reloadBtn]));
  wrapper.appendChild(summary);
  wrapper.appendChild(results);
  await load();
  return wrapper;
}

// ---------- Mensajes (chatear con los fans desde el panel) ----------

// Pestañas de chat abiertas por creadora: mensajesState se reconstruye ENTERO
// cada vez que se pinta una cuenta (p.ej. al cambiar de pestaña de modelo en
// Mensajes Pro), así que sin esto las pestañas de chat se perdían al volver
// a una creadora en la que ya tenías varias conversaciones abiertas. Vive
// fuera de mensajesState a propósito, para que sobreviva a esas
// reconstrucciones (se pierde solo al recargar la página del todo).
let chatTabsByAccount = new Map();

// Cache en memoria del navegador (se pierde solo al recargar la pagina del
// todo) para que volver a un chat o a una creadora ya vistos en esta misma
// sesion se pinte AL INSTANTE con lo ultimo que se sabia de ellos, mientras
// se pide en segundo plano lo mas reciente - en vez de vaciar el panel y
// mostrar "Cargando..." cada vez, que es como se sentia mas lento que el
// propio Telegram al saltar entre chats/creadoras o entre varias pestañas
// de chat abiertas a la vez. chatMessagesCache: clave "accountId:chatId" ->
// {messages, hasMore, signature}. dialogsCacheByAccount: clave
// "accountId:normal"|"accountId:sfs" -> {dialogsRaw, fanLists}.
const chatMessagesCache = new Map();
const dialogsCacheByAccount = new Map();
// Mismo porque, para la bandeja agregada "Mensajes Pro > Todas": antes
// SIEMPRE arrancaba en blanco con "Cargando..." y pedía las ~N cuentas
// enteras de cero cada vez que se entraba a esa pestaña, aunque se acabara
// de ver hace un minuto - así es como se notaba que "Todas" se recargaba
// de cero al salir y volver a entrar. allRows es solo un array (no un Map
// por cuenta) porque esta vista ya mezcla TODAS las cuentas en una sola
// lista ordenada por fecha.
let proAllRowsCache = null;
function cacheSetCapped(map, key, value, maxSize) {
  map.set(key, value);
  if (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

let mensajesState = {
  accountId: null,
  dialogs: [],
  currentChatId: null,
  currentChatTitle: null,
  pollTimer: null,
  dialogsRefreshTimer: null,
  eventSource: null,
  dialogsPane: null,
  dialogsListEl: null,
  chatPane: null,
  notesPane: null,
  liveDot: null,
  refreshDialogsTimer: null,
  dialogsSeq: 0,
  dialogsSearch: "",
  recentBuyers: new Set(),
  dialogsRaw: [], // lista sin filtrar (solo con la busqueda de texto aplicada por el servidor)
  fanLists: {}, // {chatId: "Posibles"|"Clientes"|...} para el filtro "Todas las listas"
  filterMode: "all", // "all" | "unread" | "priority"
  filterList: "", // valor de FAN_LISTS_FOR_FILTER, o "" (sin filtrar por lista)
  folders: null, // carpetas reales de Telegram de esta cuenta (cache, se piden una vez)
  folderSyncMap: null, // {"Posibles": "<nombre real en Telegram>", ...} (cache, se pide una vez)
  folderSyncMapFor: "", // accountId al que corresponde folderSyncMap actualmente
  folderChats: [], // chats de la carpeta real de Telegram que coincide con filterList
  folderChatsFor: "", // que valor de filterList corresponde a folderChats actualmente
  chatTabs: [], // {chatId, title}: chats de cliente abiertos a la vez dentro de esta creadora (como TeleCrew)
  activeChatTabKey: null,
  chatTabsBarEl: null,
};

function closeMensajesLiveConnection() {
  if (mensajesState.eventSource) {
    mensajesState.eventSource.close();
    mensajesState.eventSource = null;
  }
  if (mensajesState.pollTimer) {
    clearInterval(mensajesState.pollTimer);
    mensajesState.pollTimer = null;
  }
  if (mensajesState.dialogsRefreshTimer) {
    clearInterval(mensajesState.dialogsRefreshTimer);
    mensajesState.dialogsRefreshTimer = null;
  }
  clearTimeout(mensajesState.refreshDialogsTimer);
}

// "Mensajes" es ahora TODO Telegram (no solo fans): en cuentas grandes esto
// pueden ser miles de chats, asi que se pintan en tramos ("scroll infinito")
// en vez de todos de golpe.
const DIALOGS_PAGE_SIZE = 60;

async function renderMensajesView(accountId, container = appEl, opts = {}) {
  closeMensajesLiveConnection();
  mensajesState = {
    accountId, dialogs: [], currentChatId: null, currentChatTitle: null,
    pollTimer: null, dialogsRefreshTimer: null, eventSource: null, dialogsPane: null, dialogsListEl: null, chatPane: null, notesPane: null,
    liveDot: null, refreshDialogsTimer: null, dialogsSeq: 0, dialogsSearch: "",
    recentBuyers: new Set(),
    dialogsRaw: [], fanLists: {}, filterMode: "all", filterList: "",
    folders: null, folderChats: [], folderChatsFor: "",
    visibleCount: DIALOGS_PAGE_SIZE, globalSearchResults: [], globalSearchSeq: 0,
    layoutEl: null,
    chatTabs: [], activeChatTabKey: null, chatTabsBarEl: null,
    // "SFS" reutiliza este mismo motor de chat tal cual (mismos dialogos de
    // Telegram de Mensajes), solo cambia el panel de notas - ver
    // renderNotesPanel/renderSfsNotesPanel. sfsFolder/sfsFolderChatIds son el
    // filtro "solo esta carpeta de Telegram", propio de SFS (ver
    // applyDialogFilters).
    sfsMode: !!opts.sfsMode,
    sfsFolder: "",
    sfsFolderChatIds: null,
  };

  container.innerHTML = "";
  const layout = el("div", { class: "messages-layout" });
  const dialogsPane = el("div", { class: "dialogs-pane" });
  // .chat-pane pasa a ser una columna con dos pisos: la barra de pestañas de
  // chats abiertos a la vez (como TeleCrew) arriba, y debajo el propio chat
  // (cabecera + mensajes + composer), que sigue siendo exactamente lo que
  // renderChat() pinta - por eso mensajesState.chatPane sigue apuntando a
  // ESE div de dentro, no al exterior, y renderChat no se entera del cambio.
  const chatPane = el("div", { class: "chat-pane" });
  const chatTabsBarEl = el("div", { class: "chat-tabs-bar hidden" });
  const chatBodyEl = el("div", { class: "chat-pane-body" }, el("div", { class: "empty" }, "Elige una conversación de la izquierda."));
  chatPane.appendChild(chatTabsBarEl);
  chatPane.appendChild(chatBodyEl);
  // En escritorio las notas se ven por defecto (tercera columna, como
  // siempre). En móvil son una capa a pantalla completa (ver style.css), así
  // que tienen que arrancar cerradas -si no, tapan la lista/el chat desde el
  // primer momento-: el mismo botón 📝 de siempre las abre y las cierra.
  const notesPane = el("div", { class: "notes-pane" + (window.innerWidth <= 860 ? " notes-pane-hidden" : "") });
  const dialogsResizer = el("div", { class: "resize-handle", title: "Arrastra para cambiar el ancho" });
  const notesResizer = el("div", { class: "resize-handle", title: "Arrastra para cambiar el ancho" });
  layout.appendChild(dialogsPane);
  layout.appendChild(dialogsResizer);
  layout.appendChild(chatPane);
  layout.appendChild(notesResizer);
  layout.appendChild(notesPane);
  container.appendChild(layout);
  // Cada persona puede dejar más ancha la lista de chats o el panel de
  // notas, a su gusto - el ancho elegido se guarda en SU navegador (no es
  // algo de la cuenta ni se comparte con el resto del equipo), ver
  // initPanelResizer más abajo.
  initPanelResizer(dialogsResizer, "--dialogspane-w", "luxe_panel_w_dialogs", { min: 220, max: 520, default: 300 });
  initPanelResizer(notesResizer, "--notespane-w", "luxe_panel_w_notes", { min: 220, max: 520, default: 300 });

  mensajesState.layoutEl = layout;
  mensajesState.dialogsPane = dialogsPane;
  mensajesState.chatPane = chatBodyEl;
  mensajesState.chatTabsBarEl = chatTabsBarEl;
  mensajesState.notesPane = notesPane;

  // La cabecera (título, punto en vivo, buscador) se construye UNA sola vez:
  // los refrescos posteriores (mensajes en vivo, cambios de búsqueda) solo
  // tocan la lista de debajo, para que no parpadee ni "desaparezca".
  let searchTimer = null;
  const searchInput = el("input", { placeholder: "Buscar por nombre o texto..." });
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      mensajesState.dialogsSearch = searchInput.value;
      mensajesState.visibleCount = DIALOGS_PAGE_SIZE;
      loadDialogs(accountId);
      loadGlobalSearch(accountId, searchInput.value);
    }, 400);
  });
  const reloadDialogsBtn = el("button", { type: "button", class: "dialogs-reload-btn", title: "Recargar chats" }, "🔄");
  reloadDialogsBtn.addEventListener("click", async () => {
    reloadDialogsBtn.disabled = true;
    reloadDialogsBtn.classList.add("spinning");
    try {
      await loadDialogs(accountId, { force: true });
    } finally {
      reloadDialogsBtn.disabled = false;
      reloadDialogsBtn.classList.remove("spinning");
    }
  });
  dialogsPane.appendChild(el("div", { class: "dialogs-pane-header" }, [
    el("div", { style: "display:flex;align-items:center;gap:7px" }, [
      el("div", { class: "account-list-title", style: "padding:0" }, "Mensajes"),
      el("span", { class: "live-dot", title: "Conectando..." }),
      reloadDialogsBtn,
    ]),
    searchInput,
  ]));

  // --- Filtros: Todo / Sin leer / Prioridad + desplegable "Todas las listas" ---
  const allChip = el("button", { class: "filter-chip active" }, ["Todo ", el("span", { class: "filter-chip-count" }, "0")]);
  const unreadChip = el("button", { class: "filter-chip" }, ["Sin leer ", el("span", { class: "filter-chip-count" }, "0")]);
  const priorityChip = el("button", { class: "filter-chip" }, ["Prioridad ", el("span", { class: "filter-chip-count" }, "0")]);
  const listFilterSelect = el("select", { class: "filter-list-select" }, [el("option", { value: "" }, "Todas las listas")].concat(
    FAN_LISTS_FOR_FILTER.map((o) => el("option", { value: o.value }, o.label))
  ));

  function setFilterMode(mode) {
    mensajesState.filterMode = mode;
    mensajesState.filterList = "";
    listFilterSelect.value = "";
    mensajesState.visibleCount = DIALOGS_PAGE_SIZE;
    allChip.classList.toggle("active", mode === "all");
    unreadChip.classList.toggle("active", mode === "unread");
    priorityChip.classList.toggle("active", mode === "priority");
    applyDialogFilters();
  }
  allChip.addEventListener("click", () => setFilterMode("all"));
  unreadChip.addEventListener("click", () => setFilterMode("unread"));
  priorityChip.addEventListener("click", () => setFilterMode("priority"));
  listFilterSelect.addEventListener("change", () => {
    mensajesState.filterList = listFilterSelect.value;
    mensajesState.filterMode = "all";
    mensajesState.visibleCount = DIALOGS_PAGE_SIZE;
    allChip.classList.remove("active"); unreadChip.classList.remove("active"); priorityChip.classList.remove("active");
    loadFolderChatsForFilter(accountId, mensajesState.filterList);
    applyDialogFilters();
  });

  dialogsPane.appendChild(el("div", { class: "dialogs-filter-bar" }, [allChip, unreadChip, priorityChip]));
  dialogsPane.appendChild(el("div", { class: "dialogs-filter-bar" }, [listFilterSelect]));
  mensajesState.filterChips = { allChip, unreadChip, priorityChip };

  // --- SFS: mostrar solo los chats de una carpeta real de Telegram ---
  // La carpeta elegida se guarda en la cuenta (Account.sfsFolder), no solo
  // en memoria: al volver a esta creadora (o recargar la página) se
  // selecciona sola otra vez, sin tener que volver a elegirla.
  if (mensajesState.sfsMode) {
    const folderSelect = el("select", { class: "filter-list-select" }, [el("option", { value: "" }, "Todas las carpetas")]);
    dialogsPane.appendChild(el("div", { class: "dialogs-filter-bar" }, [folderSelect]));

    async function applyFolderChats(folderTitle, opts = {}) {
      mensajesState.sfsFolder = folderTitle;
      if (!folderTitle) {
        mensajesState.sfsFolderChatIds = null;
        applyDialogFilters();
        return;
      }
      folderSelect.disabled = true;
      try {
        const res = await api(`/accounts/${accountId}/telegram-folders/${encodeURIComponent(folderTitle)}/chats`);
        mensajesState.sfsFolderChatIds = new Set((res.chats || []).map((c) => c.chatId));
      } catch (err) {
        mensajesState.sfsFolderChatIds = new Set();
        if (!opts.silent) toast(err.message, true);
      } finally {
        folderSelect.disabled = false;
        applyDialogFilters();
      }
    }

    const savedFolder = (state.accounts.find((a) => a.id === accountId) || {}).sfsFolder || "";
    const loadingOption = el("option", { value: "", disabled: true }, "Cargando carpetas...");
    folderSelect.appendChild(loadingOption);
    api(`/accounts/${accountId}/telegram-folders`).then((res) => {
      loadingOption.remove();
      const folders = res.folders || [];
      if (folders.length === 0) {
        // Aviso real (no un simple "no hay nada que elegir" silencioso): si
        // esta cuenta de verdad no tiene carpetas creadas en Telegram, aqui
        // se ve claro en vez de parecer que el desplegable esta roto.
        folderSelect.appendChild(el("option", { value: "", disabled: true }, "Esta cuenta no tiene carpetas en Telegram"));
        return;
      }
      for (const f of folders) {
        folderSelect.appendChild(el("option", { value: f.title }, `${f.title} (${f.chatCount})`));
      }
      if (savedFolder) {
        folderSelect.value = savedFolder;
        applyFolderChats(savedFolder, { silent: true });
      }
    }).catch((err) => {
      loadingOption.remove();
      folderSelect.appendChild(el("option", { value: "", disabled: true }, "Error al cargar carpetas"));
      toast("No se pudieron cargar las carpetas de Telegram: " + err.message, true);
    });

    folderSelect.addEventListener("change", () => {
      const folderTitle = folderSelect.value;
      applyFolderChats(folderTitle);
      // Se guarda en segundo plano - si falla, la próxima vez que se elija
      // carpeta se reintenta igual, no hace falta avisar de esto.
      api(`/accounts/${accountId}`, { method: "PATCH", body: JSON.stringify({ sfsFolder: folderTitle || null }) })
        .then((res) => {
          const acc = state.accounts.find((a) => a.id === accountId);
          if (acc) acc.sfsFolder = folderTitle || null;
        })
        .catch(() => {});
    });
  }

  // Aviso "recuento sospechosamente bajo" (ver messages.ts): antes esto solo
  // se veía en los logs de Railway (a los que no siempre hay acceso a mano
  // cuando pasa), así que quedaba sin diagnosticar. Ahora, si Telegram
  // devuelve muy pocos chats en bruto para una cuenta en uso, se ve aquí
  // mismo con los números exactos.
  const debugBannerEl = el("div", { class: "dialogs-debug-banner hidden" });
  dialogsPane.appendChild(debugBannerEl);
  mensajesState.debugBannerEl = debugBannerEl;

  const dialogsListEl = el("div", { class: "dialogs-list" }, el("div", { class: "empty" }, "Cargando..."));
  // Scroll infinito: al acercarse al final de la lista, se AÑADE el
  // siguiente tramo de los chats ya traidos (sin volver a pedirselos a
  // Telegram, ya estan todos en mensajesState.dialogsRaw) - ver
  // appendMoreDialogRows: antes esto llamaba a applyDialogFilters(), que
  // reconstruye la lista ENTERA desde cero (todas las filas y avatares de
  // nuevo, aunque ya estuvieran pintados) solo para añadir unas pocas filas
  // más al final, y encima había que restaurar el scroll a mano porque el
  // rebuild lo resetea a 0. En una cuenta con miles de chats, bajar del
  // todo por la lista podia notarse a tirones por este motivo.
  dialogsListEl.addEventListener("scroll", () => {
    if (dialogsListEl.scrollTop + dialogsListEl.clientHeight < dialogsListEl.scrollHeight - 300) return;
    if (mensajesState.visibleCount >= mensajesState.dialogs.length) return;
    appendMoreDialogRows();
  });
  dialogsPane.appendChild(dialogsListEl);
  mensajesState.dialogsListEl = dialogsListEl;

  renderNotesPanel(notesPane, accountId, null, null);
  // Si ya habiamos visto esta creadora en esta misma sesion de navegador
  // (ver dialogsCacheByAccount), se pinta YA la ultima lista conocida -sin
  // esperar al servidor- y loadDialogs() de abajo sigue pidiendo lo mas
  // reciente igualmente para refrescarla; como loadDialogs ya mira si la
  // lista tiene contenido antes de mostrar "Cargando...", no vuelve a
  // vaciarla mientras tanto. Antes, cambiar de creadora SIEMPRE empezaba
  // desde una lista vacia aunque llevaras un minuto viendo esa misma cuenta.
  const cachedDialogs = dialogsCacheByAccount.get(`${accountId}:${mensajesState.sfsMode ? "sfs" : "normal"}`);
  if (cachedDialogs) {
    mensajesState.dialogsRaw = cachedDialogs.dialogsRaw;
    mensajesState.fanLists = cachedDialogs.fanLists;
    applyDialogFilters();
  }
  // Antes: se esperaba a que terminara la carga de la lista de chats ANTES de
  // abrir el stream en vivo y de restaurar las pestañas de chat abiertas, así
  // que al cambiar de creadora la conversación que tenías abierta salía vacía
  // (o desaparecía) hasta que Telegram contestaba y luego "volvía" sola. Ahora
  // todo arranca a la vez: la lista, el stream en vivo y el chat restaurado.
  const dialogsLoadPromise = Promise.all([loadDialogs(accountId), loadRecentBuyers(accountId)]);
  connectMensajesLiveStream(accountId);

  // Red de seguridad: ademas del botón 🔄 y de los eventos en vivo (SSE), la
  // lista se refresca sola cada 30s (silenciosa, sin "Cargando...") por si
  // se perdiera algún evento en vivo (sleep del navegador, red inestable...).
  mensajesState.dialogsRefreshTimer = setInterval(() => {
    if (mensajesState.accountId === accountId && mensajesState.dialogsListEl) {
      loadDialogs(accountId, { silent: true });
    }
  }, 30000);

  // Si esta creadora ya tenía pestañas de chat abiertas de antes (p.ej.
  // volviste de ver a otra modelo en Mensajes Pro), se restauran tal cual
  // se dejaron, con el mismo chat activo.
  let restoreTabsPromise = Promise.resolve();
  const storedTabs = chatTabsByAccount.get(accountId);
  if (storedTabs && storedTabs.chatTabs.length > 0) {
    mensajesState.chatTabs = storedTabs.chatTabs.map((t) => ({ ...t }));
    renderChatTabsBar();
    if (storedTabs.activeChatTabKey) {
      restoreTabsPromise = activateChatTab(storedTabs.activeChatTabKey);
    }
  }
  await Promise.all([dialogsLoadPromise, restoreTabsPromise]);
}

/** Guarda (en chatTabsByAccount) qué pestañas de chat hay abiertas ahora
 * mismo para la creadora activa, para poder restaurarlas si se vuelve a
 * ella más tarde. Se llama cada vez que chatTabs/activeChatTabKey cambian. */
function persistChatTabs() {
  if (!mensajesState.accountId) return;
  chatTabsByAccount.set(mensajesState.accountId, {
    chatTabs: mensajesState.chatTabs.map((t) => ({ ...t })),
    activeChatTabKey: mensajesState.activeChatTabKey,
  });
}

function normalizeForFolderMatch(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quita acentos
    .replace(/s\b/g, ""); // singulariza a lo bruto ("clientes" ~ "cliente")
}

/** Busca, entre las carpetas REALES de Telegram de la cuenta, la que mejor
 * coincide con el valor de una lista del CRM (ej. "Grupo cliente" -> carpeta
 * de Telegram "Grupos clientes"), para poder "llevar" a esa carpeta desde el
 * desplegable de Mensajes. */
function findMatchingFolderTitle(folders, listValue) {
  const targetWords = normalizeForFolderMatch(listValue).split(/\s+/).filter(Boolean);
  if (targetWords.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const f of folders) {
    const title = normalizeForFolderMatch(f.title);
    const score = targetWords.filter((w) => title.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = f.title; }
  }
  return bestScore > 0 ? best : null;
}

async function ensureAccountFoldersLoaded(accountId) {
  if (mensajesState.folders !== null) return mensajesState.folders;
  try {
    const { folders } = await api(`/accounts/${accountId}/telegram-folders`);
    mensajesState.folders = folders;
  } catch {
    mensajesState.folders = [];
  }
  return mensajesState.folders;
}

/** El mapa de Configuración → "Carpetas de Telegram" (Posibles/Clientes/
 * Grupo cliente/SFS/TW -> nombre real que tiene esa carpeta en Telegram de
 * ESTA cuenta, que puede ser cualquier cosa). Se pide una vez por cuenta. */
async function ensureAccountFolderSyncMapLoaded(accountId) {
  if (mensajesState.folderSyncMap && mensajesState.folderSyncMapFor === accountId) return mensajesState.folderSyncMap;
  try {
    const res = await api(`/accounts/${accountId}/folder-sync`);
    mensajesState.folderSyncMap = res.map || {};
  } catch {
    mensajesState.folderSyncMap = {};
  }
  mensajesState.folderSyncMapFor = accountId;
  return mensajesState.folderSyncMap;
}

/** Nombre real de la carpeta de Telegram que corresponde a una "lista"
 * (Posibles/Clientes/Grupo cliente/SFS/TW). Antes esto SOLO adivinaba por
 * parecido de palabras entre el valor de la lista y los nombres de las
 * carpetas reales (findMatchingFolderTitle) - si la cuenta tenia esa
 * carpeta renombrada en Telegram a algo sin ninguna palabra en comun (p.ej.
 * "Posibles" renombrada a "VIP"), no encontraba nada y la pestaña del
 * filtro se quedaba vacia aunque la carpeta existiera y tuviera chats, que
 * es justo el bug reportado ("Posibles" sin resultados). Ahora se mira
 * PRIMERO el nombre que la propia cuenta tiene configurado en
 * Configuración → Carpetas de Telegram (el mismo que ya usa el backend
 * para esto, ver folderSyncMap en messages.ts) y solo si no hay nada
 * configurado ahi se cae al adivinado por parecido, para cuentas antiguas
 * que nunca llegaron a configurarlo. */
async function resolveFolderTitleForList(accountId, listValue) {
  const syncMap = await ensureAccountFolderSyncMapLoaded(accountId);
  if (syncMap && syncMap[listValue]) return syncMap[listValue];
  const folders = await ensureAccountFoldersLoaded(accountId);
  return findMatchingFolderTitle(folders, listValue);
}

/** Al elegir una lista en "Todas las listas", ademas de filtrar por la
 * etiqueta del CRM, trae los chats de la carpeta real de Telegram con ese
 * mismo nombre (p.ej. "Clientes" o "Grupo cliente" -> los grupos
 * restringidos), para poder verlos aunque todavia no tengan nota puesta. */
async function loadFolderChatsForFilter(accountId, listValue) {
  if (!listValue) { mensajesState.folderChats = []; mensajesState.folderChatsFor = ""; return; }
  const folderTitle = await resolveFolderTitleForList(accountId, listValue);
  if (!folderTitle) { mensajesState.folderChats = []; mensajesState.folderChatsFor = listValue; return; }
  try {
    const { chats: chatsRaw } = await api(`/accounts/${accountId}/telegram-folders/${encodeURIComponent(folderTitle)}/chats`);
    if (mensajesState.filterList !== listValue) return; // el usuario ya cambio de lista mientras cargaba
    // El backend ya reintenta una vez los que no pudo resolver (cache de
    // Telegram fria); si aun asi alguno sigue sin resolverse, mejor
    // ocultarlo aqui que mostrar una fila confusa "(no se pudo resolver)"
    // sin nada que se pueda hacer con ella.
    const chats = chatsRaw.filter((c) => c.title !== "(no se pudo resolver)");
    mensajesState.folderChats = chats.map((c) => ({
      chatId: c.chatId,
      title: c.title,
      isUser: false,
      isGroup: true,
      unreadCount: 0,
      lastMessage: "",
      lastMessageDate: null,
      lastMessageOut: false,
    }));
    mensajesState.folderChatsFor = listValue;
    applyDialogFilters();
  } catch {
    mensajesState.folderChats = [];
    mensajesState.folderChatsFor = listValue;
  }
}

/** Aplica los filtros (Todo/Sin leer/Prioridad/lista) sobre la lista ya
 * traida del servidor (mensajesState.dialogsRaw) y pinta el resultado, sin
 * volver a pedirsela a Telegram. mensajesState.dialogs pasa a ser la lista
 * YA filtrada (la que esta realmente en pantalla), para que abrir un chat
 * por su posicion en el DOM siga funcionando bien. */
/** Construye el nodo de UNA fila de la lista de conversaciones. Se usa tanto
 * en el render completo (applyDialogFilters) como al pedir "más" con el
 * scroll infinito (appendMoreDialogRows) - antes ese segundo caso repetía
 * este mismo bloque de codigo con una copia pegada, con el riesgo de que un
 * cambio se aplicase en un sitio y se olvidase en el otro. */
/** Mini etiqueta(s) con el nombre de la(s) carpeta(s) REAL(es) de Telegram a
 * la que pertenece este chat (p.ej. "Clientes", "GRU Clientes"), tal y como
 * las manda el backend en d.folders (ver getChatFoldersMap en messages.ts) -
 * distinto de la "lista" propia del CRM. null si no está en ninguna. */
function folderTagsNode(folders) {
  if (!folders || folders.length === 0) return null;
  return el(
    "div",
    { class: "dialog-folder-tags" },
    folders.map((f) => el("span", { class: "dialog-folder-tag", title: `Carpeta de Telegram: ${f}` }, f))
  );
}

/** "@usuario" de Telegram del fan, si tiene uno puesto (ver username en
 * DialogSummary/dialogs.ts) - null si el chat es un grupo/canal o el fan no
 * tiene @usuario. */
function usernameTagNode(username) {
  if (!username) return null;
  return el("span", { class: "dialog-username-tag", title: "Usuario de Telegram" }, `@${username}`);
}

function buildDialogItemNode(d) {
  const kindTag =
    d.kind === "channel" ? el("span", { class: "dialog-group-tag", title: "Canal" }, " 📢")
    : d.kind === "group" ? el("span", { class: "dialog-group-tag", title: "Grupo/supergrupo" }, " 👥")
    : null;
  return el("div", {
    class: "dialog-item" + (d.chatId === mensajesState.currentChatId ? " active" : ""),
    "data-chat-id": d.chatId,
    onclick: () => openChat(mensajesState.accountId, d),
  }, [
    avatarEl(mensajesState.accountId, d.chatId, d.title),
    el("div", { style: "flex:1;min-width:0" }, [
      el("div", { class: "dialog-title" }, [
        d.title,
        kindTag,
        mensajesState.recentBuyers.has(d.chatId) ? el("span", { class: "dialog-flame", title: "Comprador reciente" }, " 🔥") : null,
      ]),
      usernameTagNode(d.username),
      folderTagsNode(d.folders),
      el("div", { class: "dialog-preview" }, (d.lastMessageOut ? "Tú: " : "") + (d.lastMessage || "")),
    ]),
    el("div", { class: "dialog-meta-col" }, [
      el("div", { class: "dialog-time" }, fmtDialogTime(d.lastMessageDate)),
      d.unreadCount > 0 ? el("div", { class: "dialog-unread" }, String(d.unreadCount)) : null,
    ]),
    dialogItemMenuBtn(mensajesState.accountId, d),
  ]);
}

/** Firma barata (una cadena) del tramo visible de la lista, para poder
 * saltarse un rebuild completo del DOM cuando, tras un refresco (evento en
 * vivo, el refresco silencioso de cada 30s...), el resultado es exactamente
 * el mismo de antes -algo muy habitual: la mayoria de refrescos no cambian
 * nada de lo que se ve-. Antes CADA refresco reconstruia TODOS los nodos de
 * la lista visible (con sus avatares) aunque nada hubiese cambiado de
 * verdad, lo cual era trabajo de sobra en cuentas con muchos chats y se
 * notaba como un parpadeo/tirón sutil cada vez que llegaba un mensaje. */
function dialogsRenderSignature(visible, extraLen) {
  let sig = mensajesState.filterMode + "|" + mensajesState.filterList + "|" + mensajesState.dialogsSearch + "|" + extraLen + "|";
  for (const d of visible) {
    sig += d.chatId + ":" + d.unreadCount + ":" + d.lastMessage + ":" + d.lastMessageDate + ":" + d.lastMessageOut + ":" + (d.folders || []).join(",") + ";";
  }
  return sig;
}

function applyDialogFilters() {
  const list = mensajesState.dialogsListEl;
  if (!list) return;
  const raw = mensajesState.dialogsRaw;

  const counts = { all: raw.length, unread: 0, priority: 0 };
  for (const d of raw) {
    if (d.unreadCount > 0) counts.unread++;
    if (mensajesState.fanLists[d.chatId] === "Prioridad") counts.priority++;
  }
  if (mensajesState.filterChips) {
    mensajesState.filterChips.allChip.querySelector(".filter-chip-count").textContent = String(counts.all);
    mensajesState.filterChips.unreadChip.querySelector(".filter-chip-count").textContent = String(counts.unread);
    mensajesState.filterChips.priorityChip.querySelector(".filter-chip-count").textContent = String(counts.priority);
  }

  let filtered = raw;
  if (mensajesState.filterMode === "unread") filtered = raw.filter((d) => d.unreadCount > 0);
  else if (mensajesState.filterMode === "priority") filtered = raw.filter((d) => mensajesState.fanLists[d.chatId] === "Prioridad");
  else if (mensajesState.filterList) {
    filtered = raw.filter((d) => mensajesState.fanLists[d.chatId] === mensajesState.filterList);
    // Ademas de los chats ya etiquetados con esta lista en el CRM, llevamos
    // tambien a la carpeta REAL de Telegram con el mismo nombre (si existe),
    // por ejemplo "Grupo cliente" -> los grupos restringidos con cada cliente.
    if (mensajesState.folderChatsFor === mensajesState.filterList && mensajesState.folderChats.length > 0) {
      const known = new Set(filtered.map((d) => d.chatId));
      for (const fc of mensajesState.folderChats) {
        if (!known.has(fc.chatId)) { filtered.push(fc); known.add(fc.chatId); }
      }
    }
  }

  // SFS: si hay una carpeta de Telegram elegida, se aplica encima de
  // cualquier otro filtro (Todo/Sin leer/Prioridad/lista).
  if (mensajesState.sfsMode && mensajesState.sfsFolderChatIds) {
    filtered = filtered.filter((d) => mensajesState.sfsFolderChatIds.has(d.chatId));
  }

  mensajesState.dialogs = filtered;

  if (filtered.length === 0 && mensajesState.globalSearchResults.length === 0) {
    list.innerHTML = "";
    list.appendChild(el("div", { class: "empty" }, raw.length === 0 ? (mensajesState.dialogsSearch ? "Sin resultados." : "Sin conversaciones.") : "Ningún chat coincide con este filtro."));
    mensajesState.lastRenderSignature = null;
    return;
  }
  // "Scroll infinito": Mensajes ahora es TODO Telegram (miles de chats en
  // cuentas grandes), asi que no se pintan todos de golpe -solo un primer
  // tramo, y el listener de scroll de abajo va pidiendo mas segun se baja-.
  const visible = filtered.slice(0, mensajesState.visibleCount);

  const signature = dialogsRenderSignature(visible, mensajesState.globalSearchResults.length);
  if (signature === mensajesState.lastRenderSignature) return; // nada cambio de verdad: no repintar
  mensajesState.lastRenderSignature = signature;

  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const d of visible) frag.appendChild(buildDialogItemNode(d));
  if (filtered.length > visible.length) {
    frag.appendChild(el("div", { class: "empty dialogs-loading-more" }, "Cargando más…"));
  }
  list.appendChild(frag);

  // Resultados del buscador global (chats con los que se habló alguna vez,
  // aunque no esten en la lista de arriba porque hace tiempo que no se
  // escriben) — solo tiene sentido mostrarlos cuando hay texto buscado.
  if (mensajesState.dialogsSearch && mensajesState.globalSearchResults.length > 0) {
    const known = new Set(raw.map((d) => d.chatId));
    const extra = mensajesState.globalSearchResults.filter((r) => !known.has(r.chatId));
    if (extra.length > 0) {
      list.appendChild(el("div", { class: "dialogs-section-label" }, "En otros chats de Telegram (fuera de la lista de arriba)"));
      for (const r of extra) {
        list.appendChild(el("div", {
          class: "dialog-item",
          onclick: () => openChat(mensajesState.accountId, r),
        }, [
          avatarEl(mensajesState.accountId, r.chatId, r.title),
          el("div", { style: "flex:1;min-width:0" }, [
            el("div", { class: "dialog-title" }, [
              r.title,
              r.kind !== "user" ? el("span", { class: "dialog-group-tag", title: "Grupo/canal" }, " 👥") : null,
            ]),
            el("div", { class: "dialog-preview" }, r.preview || ""),
          ]),
        ]));
      }
    }
  }
}

/** Scroll infinito, tramo siguiente: solo AÑADE las filas nuevas al final de
 * la lista ya pintada (ver comentario en el listener de scroll, más arriba),
 * en vez de reconstruir la lista entera de cero como hacía antes. */
function appendMoreDialogRows() {
  const list = mensajesState.dialogsListEl;
  if (!list) return;
  const prevVisibleCount = mensajesState.visibleCount;
  mensajesState.visibleCount += DIALOGS_PAGE_SIZE;
  const nextSlice = mensajesState.dialogs.slice(prevVisibleCount, mensajesState.visibleCount);

  const loadingMore = list.querySelector(".dialogs-loading-more");
  if (loadingMore) loadingMore.remove();

  const frag = document.createDocumentFragment();
  for (const d of nextSlice) frag.appendChild(buildDialogItemNode(d));
  if (mensajesState.visibleCount < mensajesState.dialogs.length) {
    frag.appendChild(el("div", { class: "empty dialogs-loading-more" }, "Cargando más…"));
  }
  list.appendChild(frag);

  // La firma que guarda applyDialogFilters (para saltarse rebuilds si nada
  // cambió) ya no describe lo que hay pintado ahora mismo -hay más filas-,
  // así que se actualiza aquí también con el tramo visible ampliado.
  mensajesState.lastRenderSignature = dialogsRenderSignature(
    mensajesState.dialogs.slice(0, mensajesState.visibleCount),
    mensajesState.globalSearchResults.length
  );
}

/** Escucha en tiempo real (SSE) los mensajes nuevos/editados de esta cuenta:
 * actualiza el chat abierto al instante y refresca la lista de conversaciones
 * (orden, vista previa, no leidos) sin que haya que recargar nada a mano. */
function connectMensajesLiveStream(accountId) {
  const es = new EventSource(`${API_BASE}/accounts/${accountId}/stream`);
  mensajesState.eventSource = es;

  es.addEventListener("open", () => setLiveStatus(true));
  es.addEventListener("error", () => setLiveStatus(false));
  es.onmessage = (ev) => {
    if (!ev.data) return;
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload.type !== "message" && payload.type !== "read") return;
    if (mensajesState.accountId !== accountId) return; // el usuario ya cambio de vista/cuenta

    setLiveStatus(true);

    // "read": el fan ha leído (al menos) hasta cierto punto de este chat -
    // si lo tenemos abierto, se vuelve a pedir la conversación para que los
    // ✓ pasen a ✓✓ al instante (el backend ya calcula "read" por mensaje,
    // ver GET .../messages). No lleva mas datos que el chatId, así que no
    // hay nada mas que hacer para este tipo de evento.
    if (payload.chatId === mensajesState.currentChatId && mensajesState.chatPane) {
      renderChat(accountId, payload.chatId, mensajesState.currentChatTitle, mensajesState.chatPane, true);
    }
    if (payload.type === "read") return;

    if (!payload.message.out) maybeNotifyNewMessage(accountId, payload.chatId, payload.message.text);

    // Se refresca la lista de conversaciones (orden/preview/no-leidos), con un
    // pequeño debounce para no repintar de golpe si llegan varios mensajes seguidos.
    // loadDialogs ya actualiza solo la lista (no la cabecera/buscador), asi que
    // no hay parpadeo ni "desaparece" nada.
    clearTimeout(mensajesState.refreshDialogsTimer);
    mensajesState.refreshDialogsTimer = setTimeout(() => {
      if (mensajesState.accountId === accountId && mensajesState.dialogsListEl) {
        loadDialogs(accountId, { silent: true });
      }
    }, 600);
  };

  // Red de seguridad por si el navegador cierra el stream (sleep, red inestable, etc.):
  // ademas de que EventSource reconecta solo, forzamos un refresco cada 20s.
  mensajesState.pollTimer = setInterval(() => {
    if (mensajesState.currentChatId && mensajesState.chatPane) {
      renderChat(accountId, mensajesState.currentChatId, mensajesState.currentChatTitle, mensajesState.chatPane, true);
    }
  }, 20000);
}

/** Aviso en pantalla con el nombre de la modelo cuando llega un mensaje
 * nuevo (ver Configuración → General → "Notificaciones"). Solo si el
 * navegador lo tiene permitido y la pestaña no esta al frente. */
function maybeNotifyNewMessage(accountId, chatId, text) {
  // Los avisos de mensajes nuevos los da ahora notifyIncomingMessage (más
  // abajo), alimentado por un único stream de TODAS las cuentas - así avisa
  // aunque no estés dentro de la cuenta (ni en Mensajes). Esta función queda
  // vacía a propósito para no duplicar el aviso.
  return;
  // eslint-disable-next-line no-unreachable
  try {
    const local = getLocalSettings();
    if (!local.notifications) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && mensajesState.currentChatId === chatId) return;
    const account = state.accounts.find((a) => a.id === accountId);
    const dialog = (mensajesState.dialogs || []).find((d) => d.chatId === chatId);
    const title = account ? account.label + (dialog ? " · " + dialog.title : "") : "Mensaje nuevo";
    const n = new Notification(title, { body: text || "[archivo adjunto]" });
    n.onclick = () => window.focus();
  } catch {
    // si el navegador bloquea las notificaciones, simplemente no se muestra
  }
}

/** Lo mismo que maybeNotifyNewMessage, pero para Mensajes Pro con varias
 * creadoras a la vez (ver /api/accounts/live-stream en el backend): aquí
 * solo cubrimos las cuentas que NO son la pestaña activa ahora mismo - si
 * lo es, ya la cubre connectMensajesLiveStream + maybeNotifyNewMessage de
 * esa pestaña (con su propio criterio de "¿se está viendo ya ese chat
 * exacto?"), y no conviene duplicar el aviso. Así, con 2, 4, 5 o 6 modelos
 * abiertas, salta la notificación de escritorio aunque el mensaje nuevo sea
 * de una creadora que no tienes delante en este momento - igual que
 * Telegram Desktop. */
function maybeNotifyProNewMessage(accountLabel, chatTitle, accountId, chatId, text, messageId) {
  notifyIncomingMessage({ accountId, accountLabel, chatId, chatTitle, text, messageId });
}

// ---------- Avisos de mensajes nuevos (todas las cuentas, cualquier sección)
// Antes solo avisaba la cuenta abierta (o, en Mensajes Pro, las pestañas), y
// los navegadores nunca llegaban a pedir permiso a los trabajadores (el
// interruptor está en Configuración, que ellos no ven) - así que los avisos
// "no salían" salvo estando dentro de la cuenta, y desaparecían solos al
// cabo de unos segundos. Ahora: un único stream de todas las cuentas
// permitidas, aviso de escritorio que se queda hasta que lo cierras, aviso
// dentro del panel, contador en el título de la pestaña y un pitido suave.
const notifyState = { es: null, seen: new Set(), unread: 0, baseTitle: null, lastSound: 0, banner: null };

function notifyUpdateTitle() {
  if (notifyState.baseTitle === null) notifyState.baseTitle = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = notifyState.unread > 0 ? `(${notifyState.unread}) ${notifyState.baseTitle}` : notifyState.baseTitle;
}

function notifyBeep() {
  try {
    const now = Date.now();
    if (now - notifyState.lastSound < 1500) return;
    notifyState.lastSound = now;
    if (getLocalSettings().sound === false) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = notifyState.audioCtx || (notifyState.audioCtx = new Ctx());
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    // Campanita suave de dos notas (sol -> do agudo), con un armonico para que
    // suene a campana y no a "pitido".
    const t0 = ctx.currentTime;
    const note = (freq, start, dur, vol) => {
      for (const [mult, v] of [[1, vol], [2, vol * 0.25]]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq * mult;
        gain.gain.setValueAtTime(0.0001, t0 + start);
        gain.gain.exponentialRampToValueAtTime(v, t0 + start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + start);
        osc.stop(t0 + start + dur + 0.05);
      }
    };
    note(784, 0, 0.45, 0.10);    // sol5
    note(1047, 0.13, 0.7, 0.10); // do6
  } catch {
    // sin audio disponible: no pasa nada
  }
}

function notifyIncomingMessage({ accountId, accountLabel, chatId, chatTitle, text, messageId }) {
  try {
    const key = `${accountId}:${chatId}:${messageId ?? text}`;
    if (notifyState.seen.has(key)) return;
    notifyState.seen.add(key);
    if (notifyState.seen.size > 500) notifyState.seen = new Set([...notifyState.seen].slice(-250));

    const viewingThisChat =
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      mensajesState.accountId === accountId &&
      mensajesState.currentChatId === chatId;
    if (viewingThisChat) return;

    const local = getLocalSettings();
    if (local.notifications === false) return;

    const account = (state.accounts || []).find((a) => a.id === accountId);
    const label = accountLabel || (account && account.label) || "Mensaje nuevo";
    const dialog = (mensajesState.dialogs || []).find((d) => d.chatId === chatId);
    const fan = chatTitle || (dialog && dialog.title) || "";
    const title = label + (fan ? " · " + fan : "");
    const body = text || "[archivo adjunto]";

    // Contador en el título mientras la pestaña no está a la vista
    if (document.visibilityState !== "visible" || !document.hasFocus()) {
      notifyState.unread += 1;
      notifyUpdateTitle();
    }
    notifyBeep();

    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification(title, {
        body,
        tag: `${accountId}:${chatId}`, // un mismo chat sustituye su aviso anterior en vez de apilarlos
        renotify: true,
        requireInteraction: true, // se queda hasta que lo cierres (antes desaparecía solo)
      });
      n.onclick = () => {
        try { window.focus(); } catch { /* ignorar */ }
        n.close();
        if (!window.location.pathname.startsWith("/mensajes-pro")) {
          goToChatFromDashboard(accountId, chatId, fan).catch(() => {});
        }
      };
    } else {
      notifyShowPermissionBanner();
    }
    if (document.visibilityState === "visible") toast(`💬 ${title}: ${body.slice(0, 80)}`);
  } catch {
    // los avisos nunca deben romper la app
  }
}

function notifyShowPermissionBanner() {
  if (notifyState.banner || typeof Notification === "undefined" || Notification.permission !== "default") return;
  const banner = el("div", { class: "notify-permission-banner" }, [
    el("span", {}, "🔔 Activa los avisos para enterarte de los mensajes nuevos aunque estés en otra cuenta o ventana."),
    el("button", {
      type: "button",
      class: "sm",
      onclick: async () => {
        try { await Notification.requestPermission(); } catch { /* ignorar */ }
        banner.remove();
        notifyState.banner = null;
      },
    }, "Activar avisos"),
    el("button", {
      type: "button",
      class: "sm ghost",
      onclick: () => { banner.remove(); notifyState.banner = null; },
    }, "Ahora no"),
  ]);
  document.body.appendChild(banner);
  notifyState.banner = banner;
}

function startGlobalMessageNotifications() {
  if (notifyState.es) return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { notifyState.unread = 0; notifyUpdateTitle(); }
  });
  window.addEventListener("focus", () => { notifyState.unread = 0; notifyUpdateTitle(); });
  if (typeof Notification !== "undefined" && Notification.permission === "default" && getLocalSettings().notifications !== false) {
    setTimeout(notifyShowPermissionBanner, 4000);
  }
  prefetchAllDialogs();
  const es = new EventSource(`${API_BASE}/accounts/live-stream`);
  notifyState.es = es;
  es.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    if (payload.type !== "message" || !payload.message || payload.message.out) return;
    if (payload.notify === false) return; // canales, grupos de +2 o silenciados
    const acc = (state.accounts || []).find((a) => a.id === payload.accountId);
    notifyIncomingMessage({
      accountId: payload.accountId,
      accountLabel: payload.accountLabel || (acc ? acc.label : ""),
      chatId: payload.chatId,
      chatTitle: payload.chatTitle,
      text: payload.message.text,
      messageId: payload.message.id,
    });
  };
}

/** Precarga en segundo plano la lista de chats de cada creadora (de una en
 * una, con pausa) para que el primer cambio a cada cuenta ya salga pintado
 * al instante desde dialogsCacheByAccount. */
let dialogsPrefetchStarted = false;
function prefetchAllDialogs() {
  if (dialogsPrefetchStarted) return;
  dialogsPrefetchStarted = true;
  setTimeout(async () => {
    const accs = (state.accounts || []).slice();
    for (const a of accs) {
      const key = `${a.id}:normal`;
      if (dialogsCacheByAccount.has(key)) continue;
      try {
        const [{ dialogs }, listsRes] = await Promise.all([
          api(`/accounts/${a.id}/dialogs`),
          api(`/accounts/${a.id}/fan-notes-lists`).catch(() => ({ lists: {} })),
        ]);
        if (!dialogsCacheByAccount.has(key)) {
          cacheSetCapped(dialogsCacheByAccount, key, { dialogsRaw: dialogs, fanLists: listsRes.lists || {} }, 20);
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, 6000);
}

/** Tras enviar un mensaje, la fila de ese chat en la lista pasa YA a mostrar
 * "Tú: <ese mensaje>" y sube arriba, sin esperar al refresco del servidor. */
function bumpDialogAfterSend(accountId, chatId, text) {
  try {
    const raw = mensajesState.dialogsRaw;
    if (mensajesState.accountId !== accountId || !raw) return;
    const idx = raw.findIndex((d) => d.chatId === chatId);
    if (idx < 0) return;
    const d = raw[idx];
    d.lastMessage = text;
    d.lastMessageOut = true;
    d.lastMessageDate = new Date().toISOString();
    d.unreadCount = 0;
    raw.splice(idx, 1);
    raw.unshift(d);
    applyDialogFilters();
  } catch {}
}

function setLiveStatus(live) {
  const dot = mensajesState.dialogsPane && mensajesState.dialogsPane.querySelector(".live-dot");
  if (!dot) return;
  dot.classList.toggle("live", !!live);
  dot.title = live ? "Sincronizado en tiempo real" : "Reconectando...";
}

/** "Comprador reciente": trae los chats a marcar con 🔥 (ver Configuración → General). */
async function loadRecentBuyers(accountId) {
  try {
    const { chatIds } = await api(`/accounts/${accountId}/recent-buyers`);
    if (mensajesState.accountId !== accountId) return;
    mensajesState.recentBuyers = new Set(chatIds);
    // Si la lista ya esta pintada, solo actualizamos los "flame badge" sin
    // recargar todo (loadDialogs ya se encarga si se llama por separado).
    if (mensajesState.dialogsListEl) {
      const items = [...mensajesState.dialogsListEl.querySelectorAll(".dialog-item")];
      const idx = new Map(mensajesState.dialogs.map((d, i) => [d.chatId, i]));
      for (const d of mensajesState.dialogs) {
        const item = items[idx.get(d.chatId)];
        if (!item) continue;
        const existing = item.querySelector(".dialog-flame");
        if (mensajesState.recentBuyers.has(d.chatId) && !existing) {
          const titleEl = item.querySelector(".dialog-title");
          if (titleEl) titleEl.appendChild(el("span", { class: "dialog-flame", title: "Comprador reciente" }, " 🔥"));
        } else if (!mensajesState.recentBuyers.has(d.chatId) && existing) {
          existing.remove();
        }
      }
    }
  } catch {
    // si falla, simplemente no se muestra la etiqueta esta vez
  }
}

async function loadDialogs(accountId, opts = {}) {
  const silent = !!opts.silent;
  const force = !!opts.force;
  // Se guarda el OBJETO de estado exacto de esta llamada (no solo el
  // contador dialogsSeq): renderMensajesView crea un mensajesState nuevo por
  // completo al cambiar de creadora y reinicia dialogsSeq a 0, asi que si
  // cambiabas rapido de cuenta (p.ej. Zoweey -> Lara) antes de que terminara
  // la peticion de Zoweey, su numero de secuencia podia coincidir por
  // casualidad con el de Lara y la respuesta vieja de Zoweey acababa
  // aplicandose sobre el mensajesState de Lara, mezclando chats de las dos
  // cuentas. Comprobando que "mensajesState" siga siendo ESTE MISMO objeto
  // (identidad, no solo el numero) y que la cuenta coincida, una respuesta
  // tardia de una cuenta/vista ya abandonada nunca puede colarse en otra.
  const myState = mensajesState;
  const list = myState.dialogsListEl;
  if (!list) return;
  const mySeq = ++myState.dialogsSeq;
  const search = myState.dialogsSearch;

  // Solo se muestra "Cargando..." si la lista esta realmente vacia todavia
  // (primera carga o resultado de busqueda nuevo); un refresco en vivo con
  // datos ya en pantalla no debe parpadear ni vaciarse un instante.
  const hasContent = list.querySelector(".dialog-item");
  if (!silent && !hasContent) {
    list.innerHTML = "";
    list.appendChild(el("div", { class: "empty" }, "Cargando..."));
  }

  const isStale = () => myState !== mensajesState || mySeq !== myState.dialogsSeq || myState.accountId !== accountId;

  try {
    const params = [];
    if (search) params.push(`search=${encodeURIComponent(search)}`);
    if (force) params.push("force=1");
    const qs = params.length ? `?${params.join("&")}` : "";
    // SFS ve TODOS los grupos/canales de la cuenta (no solo los chats de
    // fans de Mensajes): usa su propio endpoint, ver sfsChat.ts.
    const dialogsPath = myState.sfsMode ? "sfs-dialogs" : "dialogs";
    const [{ dialogs, debug }, listsRes] = await Promise.all([
      api(`/accounts/${accountId}/${dialogsPath}${qs}`),
      api(`/accounts/${accountId}/fan-notes-lists`).catch(() => ({ lists: {} })),
    ]);
    if (isStale()) return; // una peticion mas nueva (o un cambio de cuenta) ya tomo el relevo
    // El chat que se tiene abierto ahora mismo SIEMPRE se pinta como leido en
    // esta lista, pase lo que pase con lo que diga el servidor: markDialogRead
    // (al pedir sus mensajes) es "best-effort" y en el hueco entre que se abre
    // el chat y que esa escritura termina, un refresco de la lista como este
    // (en vivo, cada 3 min, o al recargar) podia pillar todavia el numero
    // viejo y "revivir" la burbuja de no-leido en un chat que se esta viendo
    // en este mismo instante - el chat activo no necesita preguntarle nada a
    // nadie para saber que esta leido.
    if (myState.currentChatId) {
      for (const d of dialogs) {
        if (d.chatId === myState.currentChatId) d.unreadCount = 0;
      }
    }
    myState.dialogsRaw = dialogs;
    myState.fanLists = listsRes.lists || {};
    // Cache por creadora (ver chatMessagesCache/dialogsCacheByAccount mas
    // arriba): la proxima vez que se vuelva a esta cuenta en la misma
    // sesion, renderMensajesView puede pintar esta lista al instante en vez
    // de vaciar el panel y esperar otra vez al servidor.
    cacheSetCapped(dialogsCacheByAccount, `${accountId}:${myState.sfsMode ? "sfs" : "normal"}`, { dialogsRaw: dialogs, fanLists: myState.fanLists }, 20);
    if (myState.debugBannerEl) {
      if (debug) {
        renderDialogsDebugBanner(myState.debugBannerEl, accountId, debug);
      } else {
        myState.debugBannerEl.classList.add("hidden");
        myState.debugBannerEl.innerHTML = "";
      }
    }
    applyDialogFilters();
  } catch (err) {
    if (isStale()) return;
    if (!silent || !hasContent) {
      list.innerHTML = "";
      list.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }
}

/** Pinta el aviso de "recuento bajo de chats" con un boton para ver, con
 * titulo y nº de miembros, la lista exacta de grupos/canales que Mensajes
 * esta descartando por ser grandes y no estar registrados - asi se puede
 * revisar a mano si alguno de esos deberia verse (y entonces registrarlo
 * como grupo restringido de cliente o meterlo en una carpeta marcada en
 * Configuración) en vez de adivinarlo a ciegas. */
function renderDialogsDebugBanner(bannerEl, accountId, debug) {
  bannerEl.classList.remove("hidden");
  bannerEl.innerHTML = "";
  const st = debug.telegramStats;
  const detail = st
    ? ` Telegram devolvió ${st.telegramTotal} en total; se quedaron ${st.kept} (descartados: ${st.excludedBigGroup} por ser grupo/canal grande sin registrar, ${st.excludedNoEntity} sin entidad).`
    : "";
  bannerEl.appendChild(
    el(
      "div",
      {},
      `⚠️ Recuento bajo (${debug.afterFilters} chats${debug.forceRefresh ? ", recarga forzada" : ""}).${detail} Pásale esto a soporte si no es lo esperado.`
    )
  );
  if (st && st.excludedBigGroup > 0) {
    const listBox = el("div", { class: "dialogs-debug-excluded hidden" });
    const toggleBtn = el(
      "button",
      {
        class: "sm",
        style: "margin-top:6px",
        onclick: async () => {
          if (!listBox.classList.contains("hidden")) {
            listBox.classList.add("hidden");
            return;
          }
          listBox.classList.remove("hidden");
          listBox.innerHTML = "Cargando...";
          try {
            const { excluded } = await api(`/accounts/${accountId}/dialogs/excluded`);
            listBox.innerHTML = "";
            if (!excluded || !excluded.length) {
              listBox.appendChild(el("div", { class: "empty" }, "No hay detalle disponible."));
              return;
            }
            for (const d of excluded) {
              listBox.appendChild(
                el(
                  "div",
                  { class: "dialogs-debug-excluded-row" },
                  `${d.kind === "channel" ? "📢" : "👥"} ${d.title} — ${d.participantsCount != null ? d.participantsCount + " miembros" : "tamaño desconocido"}`
                )
              );
            }
          } catch (err) {
            listBox.innerHTML = "";
            listBox.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
          }
        },
      },
      "Ver grupos/canales descartados"
    );
    bannerEl.appendChild(toggleBtn);
    bannerEl.appendChild(listBox);
  }
}

/** Buscador "de verdad": busca el texto en TODO el historial de Telegram de
 * la cuenta (no solo en los chats ya traidos por loadDialogs), para que un
 * chat con el que no se habla desde hace tiempo tambien aparezca. Se pinta
 * aparte, debajo de los resultados normales (ver applyDialogFilters). */
async function loadGlobalSearch(accountId, query) {
  const q = (query || "").trim();
  const mySeq = ++mensajesState.globalSearchSeq;
  // Con menos de 2 letras, la búsqueda global de Telegram (SearchGlobal) es
  // carísima y casi siempre inútil (demasiados resultados posibles) - antes
  // se disparaba igual con una sola letra, lo que hacía sentir el buscador
  // más lento de lo necesario nada más empezar a escribir. La lista normal
  // (loadDialogs, filtrado local sobre los chats ya cargados) sigue
  // funcionando desde la primera letra, sin este mínimo.
  if (!q || q.length < 2) {
    mensajesState.globalSearchResults = [];
    applyDialogFilters();
    return;
  }
  try {
    const { results } = await api(`/accounts/${accountId}/dialogs/search-global?q=${encodeURIComponent(q)}`);
    if (mySeq !== mensajesState.globalSearchSeq || mensajesState.accountId !== accountId) return;
    mensajesState.globalSearchResults = results || [];
    applyDialogFilters();
  } catch {
    // best-effort: si falla la busqueda global, se quedan solo los resultados normales
  }
}

/** En móvil, Mensajes/Mensajes Pro muestran una sola columna a la vez: al
 * abrir un chat, la lista se esconde y el chat pasa a ocupar toda la
 * pantalla (con un botón "‹" para volver). En escritorio esta clase no
 * cambia nada (las tres columnas siguen viéndose siempre). */
function closeMobileChat() {
  if (mensajesState.layoutEl) mensajesState.layoutEl.classList.remove("mobile-chat-open");
}

// ---------- Pestañas de chat dentro de una creadora (como TeleCrew): se
// puede tener varios clientes abiertos a la vez sin perder los demás -abrir
// uno nuevo NO cierra los otros, solo cambia cuál se ve-. ----------

/** Abre (o, si ya está abierto, simplemente activa) la pestaña de este chat. */
async function openChat(accountId, dialog) {
  if (accountId !== mensajesState.accountId) return; // pestaña de otra creadora ya no activa; no debería pasar
  if (!mensajesState.chatTabs.some((t) => t.chatId === dialog.chatId)) {
    mensajesState.chatTabs.push({ chatId: dialog.chatId, title: dialog.title });
  } else {
    // el titulo puede venir mas fresco esta vez (p.ej. desde busqueda global)
    const tab = mensajesState.chatTabs.find((t) => t.chatId === dialog.chatId);
    if (dialog.title) tab.title = dialog.title;
  }
  await activateChatTab(dialog.chatId, dialog.title);
}

function renderChatTabsBar() {
  const bar = mensajesState.chatTabsBarEl;
  if (!bar) return;
  bar.innerHTML = "";
  if (mensajesState.chatTabs.length === 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  for (const tab of mensajesState.chatTabs) {
    const closeBtn = el("span", {
      class: "chat-tab-close",
      onclick: (e) => { e.stopPropagation(); closeChatTab(tab.chatId); },
    }, "×");
    bar.appendChild(el("button", {
      type: "button",
      class: "chat-tab" + (tab.chatId === mensajesState.activeChatTabKey ? " active" : ""),
      onclick: () => activateChatTab(tab.chatId),
    }, [
      avatarEl(mensajesState.accountId, tab.chatId, tab.title),
      el("span", { class: "chat-tab-label" }, tab.title),
      closeBtn,
    ]));
  }
}

/** Cambia a un chat que YA está entre las pestañas abiertas (o lo pinta por
 * primera vez si se acaba de añadir desde openChat). No toca chatTabs. */
async function activateChatTab(chatId, titleMaybe) {
  const accountId = mensajesState.accountId;
  const tab = mensajesState.chatTabs.find((t) => t.chatId === chatId);
  const title = titleMaybe || (tab && tab.title) || mensajesState.currentChatTitle;

  if (mensajesState.pollTimer) { clearInterval(mensajesState.pollTimer); mensajesState.pollTimer = null; }
  mensajesState.currentChatId = chatId;
  mensajesState.currentChatTitle = title;
  mensajesState.activeChatTabKey = chatId;
  renderChatTabsBar();
  if (mensajesState.layoutEl) mensajesState.layoutEl.classList.add("mobile-chat-open");
  closeMobileNav();

  if (mensajesState.dialogsListEl) {
    [...mensajesState.dialogsListEl.querySelectorAll(".dialog-item")].forEach((el2) => el2.classList.remove("active"));
  }
  // Marca este item como activo y su contador como leido al instante (sin
  // esperar al servidor). Antes esto solo borraba el nodo del DOM: el
  // objeto en memoria (mensajesState.dialogs/dialogsRaw) se quedaba con el
  // numero viejo, así que cualquier repintado posterior desde ese mismo
  // estado (antes de que el servidor confirmase el 0, o en cualquier
  // repintado que no vuelva a pedir la lista) podía devolver la burbuja. Se
  // pone a 0 también en el objeto, en los dos sitios donde puede vivir
  // (dialogs es casi siempre el mismo objeto que dialogsRaw, pero por si el
  // filtrado alguna vez clona, se tocan los dos por seguridad).
  const items = mensajesState.dialogsListEl ? [...mensajesState.dialogsListEl.querySelectorAll(".dialog-item")] : [];
  const idx = mensajesState.dialogs.findIndex((d) => d.chatId === chatId);
  if (idx >= 0) {
    mensajesState.dialogs[idx].unreadCount = 0;
    if (items[idx]) {
      items[idx].classList.add("active");
      const unread = items[idx].querySelector(".dialog-unread");
      if (unread) unread.remove();
    }
  }
  const rawDialog = (mensajesState.dialogsRaw || []).find((d) => d.chatId === chatId);
  if (rawDialog) rawDialog.unreadCount = 0;

  renderNotesPanel(mensajesState.notesPane, accountId, chatId, title);
  await renderChat(accountId, chatId, title, mensajesState.chatPane);
  mensajesState.pollTimer = setInterval(() => renderChat(accountId, chatId, title, mensajesState.chatPane, true), 20000);
  persistChatTabs();
}

/** Cierra una pestaña de chat. Si era la activa, pasa a la última que quede
 * abierta, o al estado vacío ("Elige una conversación") si no queda ninguna. */
function closeChatTab(chatId) {
  mensajesState.chatTabs = mensajesState.chatTabs.filter((t) => t.chatId !== chatId);
  if (mensajesState.activeChatTabKey !== chatId) {
    renderChatTabsBar();
    persistChatTabs();
    return;
  }
  if (mensajesState.chatTabs.length > 0) {
    activateChatTab(mensajesState.chatTabs[mensajesState.chatTabs.length - 1].chatId); // ya guarda al terminar
    return;
  }
  if (mensajesState.pollTimer) { clearInterval(mensajesState.pollTimer); mensajesState.pollTimer = null; }
  mensajesState.currentChatId = null;
  mensajesState.currentChatTitle = null;
  mensajesState.activeChatTabKey = null;
  renderChatTabsBar();
  if (mensajesState.dialogsListEl) {
    [...mensajesState.dialogsListEl.querySelectorAll(".dialog-item")].forEach((el2) => el2.classList.remove("active"));
  }
  if (mensajesState.chatPane) {
    mensajesState.chatPane.innerHTML = "";
    mensajesState.chatPane.appendChild(el("div", { class: "empty" }, "Elige una conversación de la izquierda."));
  }
  renderNotesPanel(mensajesState.notesPane, mensajesState.accountId, null, null);
  if (mensajesState.layoutEl) mensajesState.layoutEl.classList.remove("mobile-chat-open");
  persistChatTabs();
}

/** Abre este chat en una pestaña/ventana NUEVA del navegador (aparte de
 * esta), como "Abrir en ventana nueva" de TeleCrew: útil para tener dos
 * conversaciones a pantalla completa una junto a otra. Va por un hash en la
 * URL (#cuenta:chat:titulo) que Mensajes Pro lee al arrancar (ver
 * renderMensajesProShell) para abrir directamente esa creadora y ese chat. */
function openChatInNewWindow(accountId, d) {
  const hash = `${accountId}:${d.chatId}:${encodeURIComponent(d.title || "")}`;
  window.open(window.location.origin + "/mensajes-pro#" + hash, "_blank");
}

/** "Eliminar chat" del menú ⋮: SOLO el admin (la cuenta luxe, o un
 * trabajador con rol "admin") lo ve/puede usarlo - ver el botón añadido
 * condicionalmente en toggleDialogItemMenu. No borra nada de verdad en
 * Telegram: guarda el chat como "oculto" para esa cuenta (tabla
 * HiddenDialog) y a partir de ahí GET /dialogs lo deja fuera de la lista
 * para TODO el equipo (chatters incluidos), no solo para quien lo eliminó. */
async function deleteDialogEverywhere(accountId, d) {
  if (!confirm(`¿Eliminar el chat con "${d.title}"?\n\nDesaparecerá de Mensajes para todo el equipo. La conversación en Telegram no se borra, solo se oculta en el CRM.`)) {
    return;
  }
  try {
    await api(`/accounts/${accountId}/dialogs/${d.chatId}`, { method: "DELETE" });
  } catch (err) {
    toast(err.message || "No se pudo eliminar el chat.", true);
    return;
  }
  toast("Chat eliminado.");
  if (mensajesState.accountId === accountId) {
    mensajesState.dialogsRaw = mensajesState.dialogsRaw.filter((x) => x.chatId !== d.chatId);
    if (mensajesState.currentChatId === d.chatId) closeChatTab(d.chatId);
    applyDialogFilters();
  }
}

/** "Marcar como no leído" del menú ⋮: mismo endpoint que ya usa el panel
 * (pone la conversación en negrita en el propio Telegram) + refresco
 * optimista del contador en la lista que se esté viendo ahora mismo. */
async function markDialogUnread(accountId, d, onDone) {
  try {
    await api(`/accounts/${accountId}/dialogs/${d.chatId}/mark-unread`, { method: "POST" });
  } catch (err) {
    toast(err.message || "No se pudo marcar como no leído.", true);
    return;
  }
  toast("Marcado como no leído.");
  d.unreadCount = Math.max(d.unreadCount || 0, 1);
  if (mensajesState.accountId === accountId) {
    const raw = mensajesState.dialogsRaw.find((x) => x.chatId === d.chatId);
    if (raw) raw.unreadCount = Math.max(raw.unreadCount || 0, 1);
    applyDialogFilters();
  }
  if (onDone) onDone();
}

// ---------- Menú "⋮" por conversación (Abrir en pestaña nueva / Abrir en
// ventana nueva / Marcar como no leído), igual que en TeleCrew. ----------

let openDialogMenuEl = null;
function closeDialogItemMenu() {
  if (openDialogMenuEl) { openDialogMenuEl.remove(); openDialogMenuEl = null; }
}
function toggleDialogItemMenu(e, accountId, d, openFn) {
  if (openDialogMenuEl) { closeDialogItemMenu(); return; }
  const doOpen = openFn || ((accId, dialog) => openChat(accId, dialog));
  const menu = el("div", { class: "dialog-item-menu" });
  menu.appendChild(el("button", { type: "button", onclick: () => { closeDialogItemMenu(); doOpen(accountId, d); } }, "Abrir en pestaña nueva"));
  menu.appendChild(el("button", { type: "button", onclick: () => { closeDialogItemMenu(); openChatInNewWindow(accountId, d); } }, "Abrir en ventana nueva"));
  menu.appendChild(el("button", { type: "button", onclick: () => { closeDialogItemMenu(); markDialogUnread(accountId, d); } }, "Marcar como no leído"));
  // "Eliminar chat": solo visible para el dueño/jefe (cuenta luxe) - un
  // Team líder tiene aquí el mismo perfil que un Chatter, ninguno de los
  // dos ve la opción.
  if (!state.currentWorker) {
    menu.appendChild(
      el(
        "button",
        { type: "button", class: "dialog-item-menu-danger", onclick: () => { closeDialogItemMenu(); deleteDialogEverywhere(accountId, d); } },
        "Eliminar chat"
      )
    );
  }
  document.body.appendChild(menu);
  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.top = rect.bottom + 4 + "px";
  const left = rect.right - 190;
  menu.style.left = Math.max(8, left) + "px";
  openDialogMenuEl = menu;
  setTimeout(() => document.addEventListener("click", function onDoc(ev) {
    if (menu.contains(ev.target)) return;
    closeDialogItemMenu();
    document.removeEventListener("click", onDoc);
  }), 0);
}

function dialogItemMenuBtn(accountId, d, openFn) {
  const btn = el("button", { type: "button", class: "dialog-item-menu-btn", title: "Más opciones" }, "⋮");
  btn.addEventListener("click", (e) => { e.stopPropagation(); toggleDialogItemMenu(e, accountId, d, openFn); });
  return btn;
}

// ---------- Iconos de la cabecera del chat (notas / galería / no leído /
// info del fan / grupo restringido), igual que la fila de botones del panel
// de referencia. ----------

/** "Última conexión" en el formato que usa el propio Telegram: relativo si
 * es reciente (minutos/horas), fecha si es más antigua, o la categoría que
 * de Telegram (p.ej. "hace poco") cuando no da la hora exacta. */
function formatLastSeenSubtitle(res) {
  if (res.lastSeenText === "En línea ahora") return "en línea ahora";
  if (res.lastSeenDate) {
    const diffMin = Math.floor((Date.now() - new Date(res.lastSeenDate).getTime()) / 60000);
    if (diffMin < 1) return "última conexión: justo ahora";
    if (diffMin < 60) return `última conexión: hace ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `última conexión: hace ${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `última conexión: hace ${diffD} d`;
    return `última conexión: ${fmtDate(res.lastSeenDate)}`;
  }
  if (res.lastSeenText) return res.lastSeenText.toLowerCase();
  return "última conexión desconocida";
}

/** Pide el nombre nuevo (como en TeleCrew: lápiz ✏️ junto al nombre del
 * fan) y lo guarda - el propio backend cambia el nombre TAMBIÉN en
 * Telegram (el contacto guardado por esta cuenta), no solo aquí en el CRM.
 * A propósito solo deja tocar el nombre (nada de teléfono/usuario/etc.). */
function editFanNameBtn(accountId, chatId, nameEl, currentTitleGetter) {
  const btn = el("button", { type: "button", class: "composer-icon-btn chat-header-edit-name-btn", title: "Editar nombre del fan" }, "✏️");
  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const current = currentTitleGetter();
    const nuevo = prompt("Nuevo nombre del cliente:", current);
    if (!nuevo || !nuevo.trim() || nuevo.trim() === current) return;
    btn.disabled = true;
    try {
      const res = await api(`/accounts/${accountId}/dialogs/${chatId}/fan-name`, {
        method: "POST",
        body: JSON.stringify({ name: nuevo.trim() }),
      });
      nameEl.textContent = res.title;
      // La lista de Mensajes (barra lateral) también usa este nombre - se
      // refresca en silencio para que se vea el cambio sin esperar al
      // siguiente refresco automático. (Vale tanto para Mensajes como para
      // Mensajes Pro: ambos comparten loadDialogs/mensajesState.)
      loadDialogs(accountId, { silent: true }).catch(() => {});
      toast("Nombre actualizado (también en Telegram)");
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/** Bloque "nombre + última conexión" de la cabecera del chat, igual que
 * Telegram lo muestra bajo el nombre del contacto. */
function buildChatHeaderNameBlock(accountId, chatId, title) {
  const subtitle = el("div", { class: "chat-header-subtitle" }, "");
  const nameEl = el("div", { style: "font-weight:600" }, title);
  const nameRow = el("div", { style: "display:flex;align-items:center;gap:6px;min-width:0" }, [
    el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, nameEl),
  ]);
  const block = el(
    "div",
    { style: "flex:1;min-width:0;cursor:pointer", title: "Ver grupos en común con este cliente" },
    [nameRow, subtitle]
  );
  // El lápiz de editar nombre NO debe abrir el modal de "grupos en común"
  // (tiene su propio click, con stopPropagation), así que se añade fuera
  // del listener de click del bloque entero.
  nameRow.appendChild(editFanNameBtn(accountId, chatId, nameEl, () => nameEl.textContent));
  block.addEventListener("click", () => openCommonGroupsModal(accountId, chatId, nameEl.textContent));
  api(`/accounts/${accountId}/dialogs/${chatId}/profile`)
    .then((res) => {
      // El pais sale siempre que se pueda deducir (aunque el fan tenga el
      // numero oculto en su privacidad), igual que hace el propio Telegram
      // y que TeleCrew: no hace falta abrir el icono ℹ️ para verlo. El
      // @usuario (si tiene uno puesto) va primero, es lo que mas rapido
      // identifica al fan si hay que buscarlo luego en el propio Telegram.
      const usernamePart = res.username ? `@${res.username}` : null;
      const countryPart = res.country ? `${res.country.flag} ${res.country.name}` : null;
      subtitle.textContent = [usernamePart, countryPart, formatLastSeenSubtitle(res)].filter(Boolean).join(" · ");
    })
    .catch(() => { subtitle.textContent = ""; });
  return block;
}

/** Al tocar el nombre/última conexión del cliente en la cabecera del chat:
 * si este cliente YA tiene su grupo restringido creado (el único donde
 * SOLO están la modelo y él, sin nadie más) vamos directos ahí - es lo que
 * de verdad se busca al tocar el nombre, igual que el botón 👥 de al lado.
 * Antes esto siempre abría la lista de "grupos en común" sin más (la misma
 * que Telegram muestra al tocar el nombre de un contacto), y como esa lista
 * no distingue cuál de esos grupos es el restringido, elegir cualquiera de
 * ahí podía llevar a un grupo compartido por casualidad con 3, 50 o 100
 * personas en vez de al grupo de solo los dos - el bug que se reportó como
 * "me lleva a un grupo al azar". Esa lista ahora solo se muestra cuando el
 * grupo restringido todavía no existe (para poder adoptar uno ya creado a
 * mano, o simplemente mirar qué más se comparte con el cliente). */
function openCommonGroupsModal(accountId, chatId, title) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, `Grupo con ${title}`));
    const body = el("div", {}, el("div", { class: "empty" }, "Cargando..."));
    modal.appendChild(body);
    api(`/accounts/${accountId}/dialogs/${chatId}/restricted-group`)
      .then((res) => {
        if (res.exists && res.groupChatId) {
          close();
          openChat(accountId, { chatId: res.groupChatId, title: res.groupTitle || `Grupo con ${title}` });
          return;
        }
        loadCommonGroupsIntoModal(accountId, chatId, title, body, close);
      })
      .catch(() => loadCommonGroupsIntoModal(accountId, chatId, title, body, close));
  });
}

/** Lista de "grupos en común" sin más (cualquier tamaño) - solo se enseña
 * cuando el cliente todavía no tiene su grupo restringido (ver arriba). */
function loadCommonGroupsIntoModal(accountId, chatId, title, body, close) {
  api(`/accounts/${accountId}/dialogs/${chatId}/common-groups`)
    .then((res) => {
      body.innerHTML = "";
      const groups = res.groups || [];
      if (!groups.length) {
        body.appendChild(el("div", { class: "empty" }, "Este cliente todavía no tiene grupo restringido. Pulsa 👥 en la cabecera del chat para crearlo."));
        return;
      }
      body.appendChild(el("div", { class: "hint" }, 'Este cliente todavía no tiene su grupo restringido (pulsa 👥 para crearlo). Si alguno de estos YA es su grupo de verdad (p.ej. lo creasteis a mano, o el chat del cliente se renombró con notas de venta y por eso no se detectó solo), pulsa "Usar este" para que el CRM lo recuerde y no vuelva a ofrecer crear uno nuevo.'));
      const list = el("div", { class: "common-groups-list" });
      groups.forEach((g) => {
        const row = el("div", { class: "common-group-row" });
        const openBtn = el("button", { type: "button", class: "common-group-row-open" }, g.title || "(sin nombre)");
        openBtn.addEventListener("click", () => {
          close();
          openChat(accountId, { chatId: g.chatId, title: g.title || `Grupo con ${title}` });
        });
        const useBtn = el("button", { type: "button", class: "ghost sm common-group-row-use", title: "Usar este grupo como el restringido de este cliente" }, "Usar este");
        useBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          useBtn.disabled = true;
          useBtn.textContent = "Usando...";
          try {
            await api(`/accounts/${accountId}/dialogs/${chatId}/restricted-group/adopt`, {
              method: "POST",
              body: JSON.stringify({ groupChatId: g.chatId, groupTitle: g.title || null }),
            });
            toast("Grupo asignado como el restringido de este cliente");
            close();
            openChat(accountId, { chatId: g.chatId, title: g.title || `Grupo con ${title}` });
          } catch (err) {
            toast(err.message, true);
            useBtn.disabled = false;
            useBtn.textContent = "Usar este";
          }
        });
        row.appendChild(openBtn);
        row.appendChild(useBtn);
        list.appendChild(row);
      });
      body.appendChild(list);
    })
    .catch((err) => {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "empty" }, err.message || "No se pudieron cargar los grupos en común."));
    });
}

/** Cuando Telegram no deja añadir al cliente directamente (privacidad), el
 * backend ya intenta mandarle el enlace de invitación por privado él solo
 * (linkSent=true: no hace falta hacer nada más). Solo si eso también falló
 * copiamos el enlace al portapapeles, como respaldo, para que el chatter
 * pueda pegárselo él mismo por privado. */
function copyInviteLinkAndToast(inviteLink, message, linkSent) {
  if (linkSent) {
    toast(message, true);
  } else if (inviteLink && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(inviteLink).then(
      () => toast(`${message} Enlace copiado al portapapeles.`, true),
      () => toast(`${message} Enlace: ${inviteLink}`, true)
    );
  } else if (inviteLink) {
    toast(`${message} Enlace: ${inviteLink}`, true);
  } else {
    toast(message, true);
  }
}

function chatHeaderIconBtn(icon, title, onClick) {
  const btn = el("button", { type: "button", class: "composer-icon-btn", title }, icon);
  btn.addEventListener("click", onClick);
  return btn;
}

function buildChatHeaderIconsRow(accountId, chatId, title) {
  const notesBtn = chatHeaderIconBtn("📝", "Notas del fan / de la modelo", () => {
    if (mensajesState.notesPane) mensajesState.notesPane.classList.toggle("notes-pane-hidden");
  });

  const galleryBtn = chatHeaderIconBtn("🖼️", "Galería: contenido enviado y recibido en este chat", () => {
    openGalleryModal(accountId, chatId, title);
  });

  const unreadBtn = chatHeaderIconBtn("📩", "Marcar como no leído", async () => {
    try {
      await api(`/accounts/${accountId}/dialogs/${chatId}/mark-unread`, { method: "POST" });
      toast("Marcado como no leído");
    } catch (err) {
      toast(err.message, true);
    }
  });

  const infoBtn = chatHeaderIconBtn("ℹ️", "País y fecha de registro del fan (lo que Telegram muestra aunque tenga el número oculto)", () => {
    openFanInfoModal(accountId, chatId, title);
  });

  // Solo aparece cuando el grupo restringido falla en meter al cliente
  // dentro (🔁 o 👥 más abajo): en vez de depender de que el cliente entre a
  // un grupo aparte, activa la misma protección de Telegram ("restringir
  // guardar contenido" - no puede reenviar ni guardar lo que se le mande)
  // directamente sobre ESTE chat privado de siempre. Empieza oculto.
  const noForwardsBtn = chatHeaderIconBtn(
    "🔒",
    "Activar \"Restringir guardar contenido\" en este chat (protege igual que el grupo, sin que el cliente tenga que entrar a ningún grupo)",
    async () => {
      noForwardsBtn.disabled = true;
      try {
        await api(`/accounts/${accountId}/dialogs/${chatId}/no-forwards`, { method: "POST" });
        toast("Restringir guardar contenido activado en este chat");
        noForwardsBtn.style.display = "none";
      } catch (err) {
        toast(err.message, true);
      } finally {
        noForwardsBtn.disabled = false;
      }
    }
  );
  noForwardsBtn.style.display = "none";

  const retryAddBtn = chatHeaderIconBtn("🔁", "Reintentar añadir al cliente a su grupo restringido", async () => {
    try {
      await api(`/accounts/${accountId}/dialogs/${chatId}/restricted-group/retry-add`, { method: "POST" });
      toast("Cliente añadido al grupo");
    } catch (err) {
      copyInviteLinkAndToast(err.data?.inviteLink, err.message, err.data?.linkSentToFan);
      noForwardsBtn.style.display = "";
    }
  });

  const goToGroupBtn = chatHeaderIconBtn("👥", "Ir al grupo restringido de este cliente (se crea si no existe)", async () => {
    goToGroupBtn.disabled = true;
    // Buscar si el grupo ya existe (cuando el cliente aun no tiene uno
    // guardado en el CRM) puede tardar varios segundos en cuentas con
    // muchos grupos - sin este aviso, el boton parecia "no hacer nada"
    // mientras tanto. En cuanto hay respuesta (o error) se quita solo.
    const prevIcon = goToGroupBtn.textContent;
    const loadingToastTimer = setTimeout(() => toast("Buscando/creando el grupo restringido, puede tardar unos segundos..."), 1200);
    goToGroupBtn.textContent = "⏳";
    try {
      const res = await api(`/accounts/${accountId}/dialogs/${chatId}/restricted-group`, {
        method: "POST",
        body: JSON.stringify({ fanTitle: title }),
      });
      if (res.fanAdded === false) {
        // No navegamos al grupo: el cliente no está dentro todavía, así que
        // no hay nada útil que hacer ahí. Nos quedamos en el chat privado de
        // siempre y dejamos visible el botón 🔒 justo aquí, como alternativa
        // que no depende de que el cliente entre a ningún grupo.
        copyInviteLinkAndToast(res.inviteLink, res.warning || "Grupo creado, pero el cliente no quedó dentro.", res.linkSentToFan);
        noForwardsBtn.style.display = "";
      } else {
        toast(res.created ? "Grupo restringido creado" : "Abriendo grupo restringido");
        openChat(accountId, { chatId: res.groupChatId, title: res.groupTitle || `Grupo con ${title}` });
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      clearTimeout(loadingToastTimer);
      goToGroupBtn.textContent = prevIcon;
      goToGroupBtn.disabled = false;
    }
  });

  return el("div", { class: "chat-header-icons" }, [notesBtn, galleryBtn, unreadBtn, infoBtn, retryAddBtn, goToGroupBtn, noForwardsBtn]);
}

function openFanInfoModal(accountId, chatId, title) {
  openModal((modal) => {
    modal.appendChild(el("h3", {}, `Información de ${title}`));
    const body = el("div", {}, el("div", { class: "empty" }, "Cargando..."));
    modal.appendChild(body);
    api(`/accounts/${accountId}/dialogs/${chatId}/profile`)
      .then((res) => {
        body.innerHTML = "";
        const box = el("div", { class: "fan-phone-box" });
        if (res.phone) {
          box.appendChild(el("div", { class: "fan-phone-number" }, res.phone));
          box.appendChild(el("div", { class: "fan-phone-country" }, res.country ? `${res.country.flag} ${res.country.name}` : "País no identificado"));
        } else {
          box.appendChild(el("div", { class: "fan-phone-number" }, "Sin número visible para esta cuenta."));
        }
        box.appendChild(el("div", { class: "hint", style: "margin-top:8px" },
          res.registeredApprox
            ? `Registrado en Telegram desde aprox. ${res.registeredApprox} (estimado a partir de su ID, Telegram no da esta fecha exacta).`
            : "No se pudo estimar la fecha de registro."));
        box.appendChild(el("div", { class: "hint", style: "margin-top:4px" },
          res.lastSeenDate ? `Última conexión: ${fmtDate(res.lastSeenDate)}` : (res.lastSeenText || "Última conexión desconocida")));
        body.appendChild(box);
        if (res.autoBlockedByCountry) {
          const blockBox = el("div", { class: "fan-phone-box", style: "margin-top:10px;border-color:rgba(226,104,91,0.4)" });
          blockBox.appendChild(el("div", { style: "font-weight:600;color:var(--red)" }, "🔒 Bloqueado automáticamente por país"));
          const unblockBtn = el("button", { class: "ghost", style: "margin-top:8px" }, "Desbloquear");
          unblockBtn.addEventListener("click", async () => {
            unblockBtn.disabled = true;
            try {
              await api(`/accounts/${accountId}/dialogs/${chatId}/unblock`, { method: "POST" });
              toast("Desbloqueado. No se le volverá a bloquear automáticamente.");
              blockBox.remove();
            } catch (err) {
              toast(err.message, true);
              unblockBtn.disabled = false;
            }
          });
          blockBox.appendChild(unblockBtn);
          body.appendChild(blockBox);
        }
      })
      .catch((err) => {
        body.innerHTML = "";
        body.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      });
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: () => modal.parentElement.remove() }, "Cerrar"),
    ]));
  });
}

function galleryItemEl(accountId, chatId, it) {
  const thumbWrap = el("div", { class: "content-item-thumb-wrap" });
  if (it.hasThumb) {
    const img = el("img", {
      class: "content-item-thumb",
      loading: "lazy",
      src: `${API_BASE}/accounts/${accountId}/dialogs/${chatId}/gallery/${it.id}/thumb`,
    });
    img.addEventListener("error", () => {
      thumbWrap.innerHTML = "";
      thumbWrap.appendChild(el("div", { class: "content-item-thumb-empty" }, "🖼️"));
    });
    thumbWrap.appendChild(img);
    if (it.type === "video") thumbWrap.appendChild(el("div", { class: "content-item-type-badge" }, "🎬"));
  } else {
    thumbWrap.appendChild(el("div", { class: "content-item-thumb-empty" }, "🎵"));
  }
  if (it.fromVault) thumbWrap.appendChild(el("div", { class: "content-item-count" }, "GRUPO"));
  const caption = el("div", { class: "content-item-caption" }, `${fmtDate(it.date)} · ${it.out ? "enviado" : "recibido"}`);
  const card = el("div", { class: "content-item-card" }, [thumbWrap, caption]);
  card.addEventListener("click", () => {
    const mediaUrl = `${API_BASE}/accounts/${accountId}/dialogs/${chatId}/gallery/${it.id}/media`;
    openModal((viewerModal) => {
      viewerModal.appendChild(el("h3", {}, it.out ? "Enviado" : "Recibido"));
      if (it.type === "video") viewerModal.appendChild(el("video", { src: mediaUrl, controls: "true", autoplay: "true" }));
      else viewerModal.appendChild(el("img", { src: mediaUrl }));
    });
  });
  return card;
}

function openGalleryModal(accountId, chatId, title) {
  openModal((modal) => {
    modal.appendChild(el("h3", {}, `Contenido enviado a ${title}`));
    const subtitle = el("p", { class: "hint" }, "Fotos y vídeos enviados y recibidos en este chat.");
    modal.appendChild(subtitle);
    const tabs = [
      { value: "all", label: "Todo" },
      { value: "vault", label: "De la bóveda" },
      { value: "photo", label: "Fotos" },
      { value: "video", label: "Vídeos" },
      { value: "audio", label: "Audios" },
    ];
    let currentTab = "all";
    const tabsRow = el("div", { class: "content-type-tabs" });
    const grid = el("div", { class: "content-items-grid" }, el("div", { class: "empty" }, "Cargando..."));

    async function loadTab() {
      grid.innerHTML = "";
      grid.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const { items } = await api(`/accounts/${accountId}/dialogs/${chatId}/gallery?tab=${currentTab}`);
        grid.innerHTML = "";
        subtitle.textContent = items.length === 1 ? "1 archivo" : `${items.length} archivos`;
        if (items.length === 0) {
          grid.appendChild(el("div", { class: "empty" }, "Sin contenido en esta pestaña."));
          return;
        }
        for (const it of items) grid.appendChild(galleryItemEl(accountId, chatId, it));
      } catch (err) {
        grid.innerHTML = "";
        grid.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    function renderTabs() {
      tabsRow.innerHTML = "";
      for (const t of tabs) {
        const chip = el("div", { class: "filter-chip" + (currentTab === t.value ? " active" : "") }, t.label);
        chip.addEventListener("click", () => { currentTab = t.value; renderTabs(); loadTab(); });
        tabsRow.appendChild(chip);
      }
    }

    renderTabs();
    modal.appendChild(tabsRow);
    modal.appendChild(grid);
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: () => modal.parentElement.remove() }, "Cerrar"),
    ]));
    loadTab();
  }, { wide: true });
}

/** Reintenta descargar una miniatura/archivo adjunto que falló la primera
 * vez (timeout, límite de descargas simultáneas - withGalleryThumbSlot en
 * messages.ts -, un fallo puntual de Telegram...) y esta vez SÍ trae los
 * bytes de verdad, devuelve esos bytes ya listos para usar (blob URL) en vez
 * de tirarlos. Antes, el reintento solo se usaba para "preguntar el motivo
 * del fallo" (con la función api(), que espera JSON) - si ese reintento en
 * realidad conseguía la imagen (una respuesta binaria, no JSON), api()
 * simplemente no lanzaba ningún error pero tampoco hacía nada útil con la
 * imagen ya descargada, así que SIEMPRE se acababa enseñando "no se pudo
 * cargar" (a veces sin ni un motivo, justo lo que se veía en el panel) aunque
 * el archivo en realidad sí se hubiera podido traer. */
async function fetchMediaOrReason(url, timeoutMs = 20_000) {
  // AbortController con tope de tiempo: sin esto, si el fetch se queda
  // colgado de verdad (p.ej. la cuenta tardando en reconectar con Telegram
  // del lado del servidor - ver getAccountClient en messages.ts, que en
  // estas rutas no tenia ningun timeout propio), esta función podía no
  // resolver NUNCA - y como el recuadro de error solo se pinta cuando esta
  // función termina, el hueco de la miniatura/archivo se quedaba
  // literalmente en blanco para siempre (ni foto ni aviso de error), que es
  // justo lo que se vio en el panel.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.ok) {
      const blob = await res.blob();
      return { ok: true, blobUrl: URL.createObjectURL(blob), mimeType: blob.type || "" };
    }
    let reason = `Error ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) reason = data.error;
    } catch {
      // la respuesta de error no era JSON (poco probable) - nos quedamos con "Error <status>"
    }
    return { ok: false, reason };
  } catch (err) {
    const reason = err && err.name === "AbortError" ? `Tardó demasiado en responder (${Math.round(timeoutMs / 1000)}s), vuelve a intentarlo.` : (err && err.message ? err.message : "");
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

function chatBubbleMediaEl(accountId, chatId, m) {
  const thumbUrl = `${API_BASE}/accounts/${accountId}/dialogs/${chatId}/gallery/${m.id}/thumb`;
  const mediaUrl = `${API_BASE}/accounts/${accountId}/dialogs/${chatId}/gallery/${m.id}/media`;

  if (m.mediaType === "audio") {
    return el("audio", { class: "chat-bubble-media-audio", src: mediaUrl, controls: "true" });
  }

  if (m.mediaType === "video") {
    // Antes: miniatura pequeña y, al hacer clic, una ventana/modal aparte que
    // descargaba el vídeo ENTERO a memoria (hasta 45s de espera) antes de
    // poder reproducir nada. El usuario pidió justo lo contrario: que cargue
    // más rápido y que se vea DENTRO del propio chat, nunca en una ventana
    // que se abre. Con un <video> nativo apuntando directo a la URL, el
    // propio navegador va pidiendo/reproduciendo por trozos (el backend ya
    // soporta "Range", ver messages.ts) en vez de esperar el archivo
    // completo, y el reproductor vive siempre dentro de la burbuja del chat.
    const wrap = el("div", { class: "chat-bubble-media-wrap chat-bubble-media-wrap-video" });
    const video = el("video", {
      class: "chat-bubble-media-video",
      poster: thumbUrl,
      controls: "true",
      preload: "metadata",
      playsinline: "true",
    });
    video.appendChild(el("source", { src: mediaUrl }));
    wrap.appendChild(video);
    function paintVideoError(reason) {
      wrap.innerHTML = "";
      const errBox = el("div", {
        class: "chat-bubble-media-empty chat-bubble-media-error",
        title: reason || "",
        style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;font-size:11px;text-align:center;padding:6px",
      }, [
        el("div", {}, "⚠️ No se pudo cargar el vídeo"),
        reason ? el("div", { style: "opacity:0.75;font-size:10px;word-break:break-word" }, reason) : null,
        el("div", { class: "chat-bubble-media-retry", style: "opacity:0.7;text-decoration:underline" }, "Toca para reintentar"),
      ]);
      errBox.addEventListener("click", (e) => {
        e.stopPropagation();
        retryingVideoAfterError = false;
        wrap.innerHTML = "";
        video.removeAttribute("src");
        video.innerHTML = "";
        video.appendChild(el("source", { src: mediaUrl + (mediaUrl.includes("?") ? "&" : "?") + "retry=" + Date.now() }));
        wrap.appendChild(video);
        video.load();
      });
      wrap.appendChild(errBox);
    }
    // Igual que en la foto: un primer fallo puede ser transitorio (hueco de
    // descarga ocupado, reconexión puntual con Telegram) y un segundo intento
    // sí trae el vídeo - antes esos bytes se desperdiciaban solo para mostrar
    // el motivo del fallo. Ahora, si el reintento SÍ funciona, se reproduce
    // ese vídeo (vía blob) en vez de enseñar un error que ya no es cierto.
    let retryingVideoAfterError = false;
    video.addEventListener("error", async () => {
      if (retryingVideoAfterError) return;
      retryingVideoAfterError = true;
      let reason = "";
      try {
        const res = await fetch(mediaUrl);
        if (res.ok) {
          const blob = await res.blob();
          video.innerHTML = "";
          video.src = URL.createObjectURL(blob);
          return;
        }
        const data = await res.json().catch(() => null);
        reason = (data && data.error) || `Error ${res.status}`;
      } catch (err) {
        reason = err && err.message ? err.message : "";
      }
      paintVideoError(reason);
    });
    return wrap;
  }

  if (m.mediaType === "photo") {
    // Igual que con el vídeo: antes se veía solo una miniatura pequeña y, al
    // hacer clic, se abría una ventana/modal aparte con la foto a tamaño
    // completo (tras otro fetch-a-blob). Ahora el clic simplemente amplía la
    // MISMA imagen dentro de la burbuja del chat (cambiando su "src" a la
    // version de resolucion completa la primera vez), sin ninguna ventana.
    const wrap = el("div", { class: "chat-bubble-media-wrap" });
    const img = el("img", { class: "chat-bubble-media-thumb", src: thumbUrl, loading: "lazy" });
    wrap.appendChild(img);
    let fullLoaded = false;
    let expanded = false;

    function paintPhotoError(reason) {
      wrap.innerHTML = "";
      const errBox = el("div", {
        class: "chat-bubble-media-empty chat-bubble-media-error",
        title: reason || "",
        style: "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;font-size:11px;text-align:center;padding:6px",
      }, [
        el("div", {}, "⚠️ No se pudo cargar"),
        reason ? el("div", { style: "opacity:0.75;font-size:10px;word-break:break-word" }, reason) : null,
        el("div", { class: "chat-bubble-media-retry", style: "opacity:0.7;text-decoration:underline" }, "Toca para reintentar"),
      ]);
      errBox.addEventListener("click", (e) => {
        e.stopPropagation();
        fullLoaded = false;
        expanded = false;
        retryingAfterError = false;
        wrap.className = "chat-bubble-media-wrap";
        wrap.innerHTML = "";
        img.src = thumbUrl + (thumbUrl.includes("?") ? "&" : "?") + "retry=" + Date.now();
        wrap.appendChild(img);
      });
      wrap.appendChild(errBox);
    }
    // Antes, si el <img> nativo fallaba, esto solo volvía a pedir la URL para
    // SABER el motivo (y enseñar el error) pero tiraba a la basura esos bytes
    // aunque esta segunda petición SÍ hubiera traído la imagen bien - cosa
    // que pasa a menudo (una descarga de Telegram falla la primera vez por un
    // hueco ocupado/una reconexión puntual, y la segunda ya funciona), asi
    // que se veia "No se pudo cargar" sin ningún motivo aunque la imagen SI
    // se hubiera podido cargar solo un instante después. Ahora, si este
    // segundo intento sí trae la imagen, se usa esa (vía blob) en vez de
    // desperdiciarla; solo se pinta el error si de verdad ha vuelto a fallar.
    let retryingAfterError = false;
    img.addEventListener("error", async () => {
      if (retryingAfterError) return; // evita bucles si el propio blob fallara al pintarse
      retryingAfterError = true;
      const failedSrc = img.src;
      let reason = "";
      try {
        const res = await fetch(failedSrc);
        if (res.ok) {
          const blob = await res.blob();
          img.src = URL.createObjectURL(blob);
          return;
        }
        const data = await res.json().catch(() => null);
        reason = (data && data.error) || `Error ${res.status}`;
      } catch (err) {
        reason = err && err.message ? err.message : "";
      }
      paintPhotoError(reason);
    });
    wrap.addEventListener("click", () => {
      if (!fullLoaded) {
        fullLoaded = true;
        wrap.classList.add("chat-bubble-media-wrap-full");
        img.classList.add("chat-bubble-media-full");
        img.src = mediaUrl; // resolucion completa, se pinta progresivamente sobre la misma imagen ya visible
      } else {
        expanded = !expanded;
        wrap.classList.toggle("chat-bubble-media-wrap-expanded", expanded);
      }
    });
    return wrap;
  }

  // Documento u otro tipo de archivo que classifyGalleryMedia (messages.ts)
  // no reconoce como foto/video/audio: por defecto, enlace de descarga - es
  // lo correcto para la inmensa mayoría (PDF, zip, audio sin portada...).
  // PERO como red de seguridad, si en realidad SÍ es una imagen o un vídeo
  // (un tipo de adjunto de Telegram poco común que esa función todavía no
  // contempla, en vez de intentar adivinar cada caso nuevo a mano) se
  // comprueba aquí el Content-Type real que devuelve el servidor y, si
  // resulta ser una imagen/vídeo de verdad, se sustituye el enlace por la
  // miniatura - así una foto real nunca se queda enseñando solo un botón de
  // descarga aunque el backend la haya clasificado mal.
  const slot = el("span", { style: "display:contents" });
  const link = el("a", { class: "chat-bubble-media-file", href: mediaUrl, target: "_blank", rel: "noopener" }, "📎 Ver archivo adjunto");
  slot.appendChild(link);
  (async () => {
    const probe = await fetchMediaOrReason(thumbUrl, 12_000);
    const isVisual = probe.ok && probe.mimeType && (probe.mimeType.startsWith("image/") || probe.mimeType.startsWith("video/"));
    if (!isVisual) return; // de verdad es un documento sin miniatura: se queda el enlace de siempre, sin ningún error (es lo esperado)
    const isVideo = probe.mimeType.startsWith("video/");
    slot.innerHTML = "";
    // Mismo criterio que arriba (foto/vídeo normales): se ve directamente
    // dentro del chat, nunca en una ventana aparte.
    if (isVideo) {
      const wrap = el("div", { class: "chat-bubble-media-wrap chat-bubble-media-wrap-video" });
      const video = el("video", {
        class: "chat-bubble-media-video",
        poster: probe.blobUrl,
        controls: "true",
        preload: "metadata",
        playsinline: "true",
      });
      video.appendChild(el("source", { src: mediaUrl }));
      wrap.appendChild(video);
      slot.appendChild(wrap);
    } else {
      const wrap = el("div", { class: "chat-bubble-media-wrap" });
      const img = el("img", { class: "chat-bubble-media-thumb", src: probe.blobUrl });
      wrap.appendChild(img);
      let fullLoaded = false;
      let expanded = false;
      wrap.addEventListener("click", () => {
        if (!fullLoaded) {
          fullLoaded = true;
          wrap.classList.add("chat-bubble-media-wrap-full");
          img.classList.add("chat-bubble-media-full");
          img.src = mediaUrl;
        } else {
          expanded = !expanded;
          wrap.classList.toggle("chat-bubble-media-wrap-expanded", expanded);
        }
      });
      slot.appendChild(wrap);
    }
  })();
  return slot;
}

/** "Hoy" / "Ayer" / "24 de septiembre" (con año solo si no es el actual) -
 * igual que la separacion por dia que pone Telegram entre mensajes. */
function fmtChatDayLabel(d) {
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return "Hoy";
  if (diffDays === 1) return "Ayer";
  return d.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function chatDateDivider(dateStr) {
  return el("div", { class: "chat-date-divider" }, el("span", {}, fmtChatDayLabel(new Date(dateStr))));
}

/** Añade los mensajes a `container` metiendo, como en la app de Telegram, una
 * "píldora" con el día (Hoy/Ayer/fecha) cada vez que cambia de un mensaje al
 * siguiente - mensajes en orden cronológico (mas antiguo primero). */
function appendChatMessagesWithDividers(container, messages, accountId, chatId) {
  let lastDay = null;
  for (const m of messages) {
    if (m.date) {
      const day = new Date(m.date).toDateString();
      if (day !== lastDay) {
        container.appendChild(chatDateDivider(m.date));
        lastDay = day;
      }
    }
    container.appendChild(chatBubble(m, accountId, chatId));
  }
}

function chatBubble(m, accountId, chatId) {
  const content = [];
  if (m.mediaType) content.push(chatBubbleMediaEl(accountId, chatId, m));
  if (m.text) content.push(el("div", { class: "chat-bubble-text" }, m.text));

  const footer = [el("div", { class: "chat-bubble-time" }, m.pending ? "" : fmtDate(m.date))];
  // Tick de enviado/leído (como Telegram/TeleCrew): solo en nuestros propios
  // mensajes (m.out) - un ✓ gris en cuanto se envía, ✓✓ en color de acento
  // en cuanto el backend confirma que el fan lo ha leído (m.read, ver
  // GET .../messages y UpdateReadHistoryOutbox en liveEvents.ts). Si nunca
  // llega ese aviso se queda en ✓ para siempre - no significa "no
  // entregado", solo "todavía sin confirmación de lectura".
  //
  // m.pending (burbuja optimista, ver el "send()" del composer): todavía no
  // hay confirmación de Telegram de que el mensaje salió, así que en vez del
  // tick se enseña un reloj - en cuanto el envío real termina, este bubble
  // se sustituye por el definitivo (con su tick normal), nunca se queda con
  // el reloj puesto para siempre.
  // Qué chatter lo mandó (m.sentBy, ver GET .../messages): va justo antes
  // de la hora, en la misma línea del tick - solo en nuestros propios
  // mensajes. m.pending usa currentChatterDisplayName() directamente (la
  // burbuja optimista no ha pasado aún por el backend, ver send() más
  // abajo); el resto usa lo que diga el servidor, que puede quedar vacío en
  // mensajes de antes de que esto existiera.
  if ((m.pending || m.out) && m.sentBy) {
    footer.push(el("span", { class: "chat-bubble-sentby" }, m.sentBy));
  }
  if (m.pending) {
    footer.push(el("span", { class: "chat-bubble-tick chat-bubble-tick-pending" }, "🕐"));
  } else if (m.out) {
    footer.push(el("span", { class: "chat-bubble-tick" + (m.read ? " read" : "") }, m.read ? "✓✓" : "✓"));
  }
  // Solo en SFS → Chat (mensajesState.sfsMode): cada mensaje se puede
  // reenviar directo al canal/grupo fijo de SFS (Account.sfsGroupChatId,
  // elegido en la pestaña "Grupo SFS"), ocultando siempre el remitente -
  // es justo lo que hacía falta para "Publicar como SFS" sin salir del
  // propio chat. En Mensajes normal no aparece: reenviar ahí no tiene
  // sentido (no hay canal/grupo fijo de destino).
  if (mensajesState.sfsMode) {
    const fwdBtn = el("button", { type: "button", class: "chat-bubble-sfs-forward", title: "Reenviar al grupo SFS (oculta remitente)" }, "↪ SFS");
    fwdBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const acc = state.accounts.find((a) => a.id === accountId);
      if (!acc || !acc.sfsGroupChatId) {
        toast('Antes elige un canal/grupo fijo en la pestaña "Grupo SFS"', true);
        return;
      }
      fwdBtn.disabled = true;
      try {
        await api(`/accounts/${accountId}/sfs-group/forward`, {
          method: "POST",
          body: JSON.stringify({ chatId, messageId: m.id, hideSender: true }),
        });
        toast(`Reenviado a "${acc.sfsGroupTitle || "el grupo SFS"}" sin remitente`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        fwdBtn.disabled = false;
      }
    });
    footer.push(fwdBtn);
  }
  // Borrar un mensaje enviado desde el CRM (solo los nuestros ya enviados).
  // Se borra también en Telegram y queda registrado en Informes → Dashboard →
  // Mensajes borrados (texto, fan, chatter que lo envió y quién lo borró).
  let bubbleEl = null;
  if (m.out && !m.pending && m.id != null) {
    const delBtn = el("button", { type: "button", class: "chat-bubble-delete", title: "Borrar mensaje (queda registrado)" }, "🗑");
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("¿Borrar este mensaje?\n\nSe borrará también para el fan en Telegram y quedará registrado en Informes → Dashboard → Mensajes borrados (con tu nombre).")) return;
      delBtn.disabled = true;
      try {
        await api(`/accounts/${accountId}/dialogs/${chatId}/messages/${m.id}`, {
          method: "DELETE",
          body: JSON.stringify({ text: m.text || "" }),
        });
        if (bubbleEl) bubbleEl.remove();
        toast("Mensaje borrado");
      } catch (err) {
        delBtn.disabled = false;
        toast(err.message, true);
      }
    });
    footer.push(delBtn);
  }
  content.push(el("div", { class: "chat-bubble-footer" }, footer));

  // Opacidad reducida mientras está "pendiente" (optimista, aún sin
  // confirmar por Telegram) - con estilo en línea para no tocar el CSS, se
  // quita sola en cuanto este bubble se sustituye por el definitivo.
  const bubbleAttrs = m.pending ? { class: "chat-bubble " + (m.out ? "out" : "in"), style: "opacity:0.6" } : { class: "chat-bubble " + (m.out ? "out" : "in") };
  bubbleEl = el("div", bubbleAttrs, content);
  return bubbleEl;
}

function makeLoadOlderBtn(accountId, chatId, title, chatPane) {
  const btn = el("div", { class: "load-older-btn" }, "Cargar mensajes anteriores");
  btn.addEventListener("click", async () => {
    btn.textContent = "Cargando...";
    await renderChat(accountId, chatId, title, chatPane, true, { loadOlder: true });
  });
  return btn;
}

/** Botón "‹" de volver a la lista, solo visible en móvil (ver
 * .chat-header-back-btn en style.css) - en escritorio no ocupa sitio. */
function chatHeaderBackBtn() {
  const btn = el("button", { type: "button", class: "chat-header-back-btn", title: "Volver a la lista" }, "‹");
  btn.addEventListener("click", closeMobileChat);
  return btn;
}

// Cada llamada a renderChat (abrir chat, el poll de 20s, un evento en vivo,
// o el refresco tras enviar un mensaje) puede solaparse con otra anterior
// que todavía esté esperando la respuesta del servidor - por ejemplo, al
// entrar en un chat se lanza el render "de verdad" y, si justo entonces
// llega un evento en vivo o el poll anterior aún no había terminado, una
// respuesta más VIEJA podía llegar despues y pisar el scroll/contenido que
// ya había pintado la más nueva. Eso es lo que se veía como "el scroll se
// vuelve loco" al entrar en un chat. Con este contador por chatPane, cada
// renderChat (salvo "cargar mensajes anteriores", que es una acción
// explícita del usuario) se identifica con un número creciente y, si al
// volver de la petición ya hay uno más nuevo en marcha, esta respuesta se
// descarta sin tocar el DOM ni el scroll.
function nextRenderToken(chatPane) {
  chatPane._renderToken = (chatPane._renderToken || 0) + 1;
  return chatPane._renderToken;
}

// Mantiene messagesEl.dataset.stickBottom al día mientras el usuario
// interactúa con el scroll a mano, en vez de recalcularlo solo en el
// instante en que llega cada respuesta del servidor (que podía leer una
// posición de scroll ya desfasada - p.ej. si el teclado del móvil había
// reducido el alto visible del chat). Se engancha una sola vez por
// elemento .chat-messages.
function bindChatScrollTracking(messagesEl) {
  if (messagesEl.dataset.scrollBound) return;
  messagesEl.dataset.scrollBound = "1";
  const updateStick = () => {
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    messagesEl.dataset.stickBottom = nearBottom ? "1" : "0";
  };
  messagesEl.addEventListener("scroll", updateStick);
  // Las miniaturas/fotos terminan de cargar DESPUÉS de pintar los mensajes,
  // lo que cambia scrollHeight una vez ya se había hecho scrollTop =
  // scrollHeight - por eso a veces el chat no quedaba pegado del todo abajo.
  // "load" no burbujea, así que se escucha en fase de captura.
  messagesEl.addEventListener("load", () => {
    if (messagesEl.dataset.stickBottom !== "0") {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }, true);
}

async function renderChat(accountId, chatId, title, chatPane, silent, opts = {}) {
  const loadOlder = !!opts.loadOlder;
  const forceScrollBottom = !!opts.forceScrollBottom;
  const renderToken = loadOlder ? null : nextRenderToken(chatPane);
  // Lo último que se sabe de esta conversación (de la caché al abrir, o lo
  // que traiga el fetch de más abajo en cuanto responda) - en un objeto
  // mutable (no una variable `messages` normal) para que la barra de
  // enviar, creada ANTES de que el fetch termine (ver ensureComposer más
  // abajo), pueda leer siempre el valor más reciente sin tener que
  // recrearse.
  const chatDataRef = { messages: [] };
  const ensureComposer = () => {
    if (chatPane.querySelector(".chat-composer")) return;
      const input = createRichComposerInput(accountId);
      const sendBtn = el("button", { class: "primary chat-send-btn", title: "Enviar" }, "➤");
      const previewBox = el("div", { class: "premium-preview hidden" });
      input._previewEl = previewBox;
      input.addEventListener("input", () => { syncPremiumEntities(input); refreshPremiumPreview(input); });
      const send = async () => {
        // No se recorta aqui (solo se comprueba que no este vacio): si un
        // script trajo emoji premium, sus offsets se calcularon sobre
        // input.value SIN recortar - el propio backend se encarga de
        // recortar el texto y desplazar las entidades a la vez, para que no
        // se desincronicen entre sí.
        const rawText = input.value;
        if (!rawText.trim()) return;
        const entities = input._premiumEntities && input._premiumEntities.length > 0 ? input._premiumEntities : undefined;
        input.value = "";
        input._lastValue = "";
        input._premiumEntities = [];
        refreshPremiumPreview(input);
        sendBtn.disabled = true;

        // Burbuja optimista: se pinta YA, sin esperar a que Telegram
        // confirme el envío (antes el mensaje no aparecía hasta que
        // terminaban DOS viajes de ida y vuelta a Telegram seguidos - el
        // propio envío y el recargar la conversación entera después). Se
        // añade directamente al DOM (no pasa por el `messages` de este
        // cierre, que sigue siendo "lo último que confirmó el servidor")
        // para no interferir con la detección de cambios de renderChat; el
        // renderChat de más abajo la sustituye sola por la burbuja de
        // verdad en cuanto hay respuesta.
        const messagesElNow = chatPane.querySelector(".chat-messages");
        let pendingBubble = null;
        if (messagesElNow) {
          pendingBubble = chatBubble(
            { text: rawText.trim(), out: true, date: new Date().toISOString(), pending: true, sentBy: currentChatterDisplayName() },
            accountId,
            chatId
          );
          messagesElNow.appendChild(pendingBubble);
          messagesElNow.scrollTop = messagesElNow.scrollHeight;
          messagesElNow.dataset.stickBottom = "1";
        }
        try {
          // lastFanMessageAt: el último mensaje del fan que ya teníamos
          // cargado en pantalla, para que el Dashboard de Informes pueda
          // calcular el "Tiempo de respuesta" sin tener que volver a pedirle
          // el historial a Telegram solo para eso.
          const lastIncoming = [...chatDataRef.messages].reverse().find((m) => !m.out && m.date);
          await api(`/accounts/${accountId}/dialogs/${chatId}/send`, {
            method: "POST",
            body: JSON.stringify({ text: rawText, chatTitle: title, lastFanMessageAt: lastIncoming ? lastIncoming.date : null, entities }),
          });
          bumpDialogAfterSend(accountId, chatId, rawText);
          // Trae la conversación de verdad (con el mensaje real ya dentro) y
          // de paso sustituye, al reconstruir todo el contenido, la burbuja
          // optimista de arriba por la definitiva.
          await renderChat(accountId, chatId, title, chatPane, true, { forceScrollBottom: true });
        } catch (err) {
          // El envío falló de verdad: quitamos la burbuja optimista (nunca
          // llegó a Telegram) y devolvemos el texto al cuadro de escritura
          // en vez de perderlo - antes, si el envío fallaba, el texto ya se
          // había borrado del input y solo quedaba el aviso del error.
          if (pendingBubble) pendingBubble.remove();
          input.value = rawText;
          input._lastValue = rawText;
          input._premiumEntities = entities || [];
          refreshPremiumPreview(input);
          input.focus();
          toast(err.message, true);
        } finally {
          sendBtn.disabled = false;
        }
      };
      sendBtn.addEventListener("click", send);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

      const scriptsBar = el("div", { class: "scripts-bar" });
      renderScriptsBar(scriptsBar, accountId, input);

      const folderBtn = el("button", { type: "button", class: "composer-icon-btn", title: "Contenido de la modelo" }, "📁");
      folderBtn.addEventListener("click", () => openContentLibraryModal(accountId, chatId, chatPane));

      const clockBtn = el("button", { type: "button", class: "composer-icon-btn", title: "Programar este mensaje" }, "🕐");
      clockBtn.addEventListener("click", () => openMessageScheduleModal(accountId, chatId, input, chatPane));

      const emojiBtn = el("button", { type: "button", class: "composer-icon-btn", title: "Emoji y letras premium" }, "🙂");
      emojiBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleEmojiPicker(emojiBtn, input, accountId, chatId); });

      const iconsRow = el("div", { class: "composer-icons-row" }, [folderBtn, clockBtn, emojiBtn]);

      const quickReplyPanel = renderQuickReplyPicker(iconsRow, accountId, chatId, input, () => renderChat(accountId, chatId, title, chatPane, true, { forceScrollBottom: true }));

      const composerWrap = el("div", { class: "chat-composer-wrap" }, [
        scriptsBar,
        quickReplyPanel,
        previewBox,
        el("div", { class: "chat-composer" }, [iconsRow, input, sendBtn]),
      ]);
      chatPane.appendChild(composerWrap);
  };
  if (!silent && !loadOlder) {
    const cached = chatMessagesCache.get(`${accountId}:${chatId}`);
    chatPane.innerHTML = "";
    chatPane.appendChild(el("div", { class: "chat-header" }, [
      chatHeaderBackBtn(),
      avatarEl(accountId, chatId, title),
      buildChatHeaderNameBlock(accountId, chatId, title),
      buildChatHeaderIconsRow(accountId, chatId, title),
    ]));
    if (cached) {
      // Ya vimos este chat antes en esta sesion de navegador (al abrirlo la
      // primera vez, o en un refresco silencioso anterior): se pinta YA con
      // lo ultimo que sabiamos, sin esperar al servidor. La peticion de mas
      // abajo sigue su curso igual que siempre para traer lo mas reciente -
      // si no hay nada nuevo, el chequeo de firma (mas abajo) no vuelve a
      // tocar el DOM; si hay algo nuevo, se repinta solo encima de esto.
      chatDataRef.messages = cached.messages;
      const cachedMessagesEl = el("div", { class: "chat-messages" });
      if (cached.hasMore && cached.messages.length > 0) {
        cachedMessagesEl.dataset.oldestId = cached.messages[0].id;
        cachedMessagesEl.appendChild(makeLoadOlderBtn(accountId, chatId, title, chatPane));
      }
      if (cached.messages.length === 0) {
        cachedMessagesEl.appendChild(el("div", { class: "empty" }, "Sin mensajes todavía."));
      } else {
        appendChatMessagesWithDividers(cachedMessagesEl, cached.messages, accountId, chatId);
      }
      cachedMessagesEl.dataset.msgSignature = cached.signature;
      chatPane.appendChild(cachedMessagesEl);
      bindChatScrollTracking(cachedMessagesEl);
      cachedMessagesEl.scrollTop = cachedMessagesEl.scrollHeight;
      cachedMessagesEl.dataset.stickBottom = "1";
    } else {
      chatPane.appendChild(el("div", { class: "chat-messages" }, el("div", { class: "empty" }, "Cargando conversación...")));
    }
    // La barra de enviar se crea YA, aquí mismo, sin esperar a que
    // responda Telegram (ver el comentario grande más abajo sobre por qué
    // esto se separó del resto del pintado) - así se puede escribir y
    // mandar un mensaje aunque el historial tarde en cargar.
    ensureComposer();
  }
  try {
    let url = `/accounts/${accountId}/dialogs/${chatId}/messages`;
    if (loadOlder) {
      const messagesEl = chatPane.querySelector(".chat-messages");
      const oldestId = messagesEl && messagesEl.dataset.oldestId;
      if (oldestId) url += `?offsetId=${oldestId}`;
    }
    const { messages, hasMore } = await api(url);
    if (mensajesState.currentChatId !== chatId) return; // el usuario cambio de chat mientras cargaba
    if (renderToken !== null && chatPane._renderToken !== renderToken) return; // hay un render más nuevo en marcha, esta respuesta ya es vieja

    if (loadOlder) {
      const messagesEl = chatPane.querySelector(".chat-messages");
      if (!messagesEl) return;
      const loadMoreBtn = messagesEl.querySelector(".load-older-btn");
      if (loadMoreBtn) loadMoreBtn.remove();
      const prevScrollHeight = messagesEl.scrollHeight;
      const frag = document.createDocumentFragment();
      appendChatMessagesWithDividers(frag, messages, accountId, chatId);
      if (hasMore && messages.length > 0) {
        messagesEl.dataset.oldestId = messages[0].id;
        messagesEl.prepend(makeLoadOlderBtn(accountId, chatId, title, chatPane));
      }
      messagesEl.prepend(frag);
      messagesEl.scrollTop = messagesEl.scrollHeight - prevScrollHeight;
      return;
    }

    let messagesEl = chatPane.querySelector(".chat-messages");
    // "¿Estaba el usuario pegado abajo?": se prefiere el valor que lleva el
    // propio listener de scroll (dataset.stickBottom, ver bindChatScrollTracking),
    // que se actualiza en tiempo real mientras el usuario se desplaza, en vez
    // de medirlo aquí mismo - medirlo justo en el instante en que responde el
    // servidor podía leer una posición de scroll ya desfasada (p.ej. con el
    // teclado del móvil abierto) y era la causa de que, a veces, el chat NO
    // bajara solo al llegar un mensaje.
    let wasNearBottom;
    if (messagesEl && messagesEl.dataset.stickBottom !== undefined) {
      wasNearBottom = messagesEl.dataset.stickBottom === "1";
    } else {
      wasNearBottom = messagesEl ? messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120 : true;
    }
    if (!messagesEl) {
      chatPane.innerHTML = "";
      chatPane.appendChild(el("div", { class: "chat-header" }, [
        chatHeaderBackBtn(),
        avatarEl(accountId, chatId, title),
        buildChatHeaderNameBlock(accountId, chatId, title),
        buildChatHeaderIconsRow(accountId, chatId, title),
      ]));
      messagesEl = el("div", { class: "chat-messages" });
      chatPane.appendChild(messagesEl);
    }
    bindChatScrollTracking(messagesEl);

    // El chat abierto se refresca cada 20s (red de seguridad) y con cada
    // mensaje en vivo de la cuenta (aunque sea de OTRO chat, hasta que se
    // filtra arriba) - la inmensa mayoria de esas veces el contenido no
    // cambio nada de verdad. Sin esto, cada uno de esos refrescos "silent"
    // volvia a montar TODAS las burbujas del historial visible (miniaturas
    // de fotos incluidas) desde cero, solo para acabar pintando exactamente
    // lo mismo que ya habia - trabajo de sobra que se notaba como un tirón
    // sutil cada 20 segundos en conversaciones con muchos mensajes.
    const msgSignature = messages.map((m) => `${m.id}:${m.text}:${m.out}:${m.mediaType || ""}`).join(";") + "|" + hasMore;
    // Se guarda SIEMPRE lo ultimo sabido de este chat (se repinte o no ahora
    // mismo), para que la proxima vez que se entre a el -o se vuelva a su
    // pestaña ya abierta- se pueda pintar al instante desde aqui en vez de
    // esperar otra vez al servidor (ver el bloque de "cached" mas arriba).
    chatDataRef.messages = messages;
    cacheSetCapped(chatMessagesCache, `${accountId}:${chatId}`, { messages, hasMore, signature: msgSignature }, 80);
    // IMPORTANTE: antes, cuando la firma no habia cambiado, la funcion
    // volvia aqui mismo (return) sin llegar NUNCA a la comprobacion/creacion
    // de la barra de enviar mensaje de mas abajo - eso no era un problema
    // mientras esa vuelta temprana solo pasaba en los refrescos "silent"
    // (la barra ya se habia creado en la apertura inicial), pero al añadir
    // el pintado instantaneo desde cache (arriba) empezo a pasar tambien en
    // la apertura NORMAL de un chat ya visto antes - y entonces la barra de
    // enviar mensajes nunca llegaba a crearse para ese chat. Ahora solo se
    // salta el RE-PINTADO de las burbujas si no cambio nada; la
    // comprobacion/creacion de la barra de enviar se hace SIEMPRE, haya
    // cambiado algo o no.
    const needsRepaint = messagesEl.dataset.msgSignature !== msgSignature;
    if (needsRepaint) {
      messagesEl.dataset.msgSignature = msgSignature;
      messagesEl.innerHTML = "";
      if (messages.length === 0) {
        messagesEl.appendChild(el("div", { class: "empty" }, "Sin mensajes todavía."));
      } else {
        if (hasMore) {
          messagesEl.dataset.oldestId = messages[0].id;
          messagesEl.appendChild(makeLoadOlderBtn(accountId, chatId, title, chatPane));
        }
        appendChatMessagesWithDividers(messagesEl, messages, accountId, chatId);
      }
    }
    if (forceScrollBottom || !silent || (needsRepaint && wasNearBottom)) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      messagesEl.dataset.stickBottom = "1";
    }

    ensureComposer();
  } catch (err) {
    if (!silent) {
      chatPane.innerHTML = "";
      chatPane.appendChild(el("div", { class: "empty" }, "Error cargando la conversación: " + err.message));
    }
  }
}

// ---------- Emoji picker (icono junto al cuadro de texto) ----------

const EMOJI_CATEGORIES = [
  {
    label: "Pícaros",
    emojis: ["🔥", "💦", "💋", "👅", "👀", "🍑", "🍆", "😏", "😈", "👿", "💄", "👙", "👗", "💃", "🕺", "🛏️", "🌙", "🥵", "😩", "🤤"],
  },
  {
    label: "Caras",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙",
      "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "😐", "😑", "😶", "🙄", "😬", "🤥", "😌", "😔", "😪",
      "🤤", "😴", "😷", "🤒", "🤕", "🤢", "🤮", "🤧", "🥵", "🥶", "🥴", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😕", "🙁",
      "☹️", "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥", "😢", "😭", "😱", "😖", "😣", "😞", "😓", "😩", "😫",
      "🥱", "😤", "😡", "😠", "🤬",
    ],
  },
  {
    label: "Gestos",
    emojis: ["👋", "🤚", "🖐️", "✋", "🖖", "👌", "🤌", "🤏", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆", "👇", "☝️", "👍", "👎", "✊", "👊", "🤛", "🤜", "👏", "🙌", "👐", "🤲", "🙏", "✍️", "💅", "🤳", "💪"],
  },
  {
    label: "Corazones",
    emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "💯", "💢", "💥", "💫", "✨", "🔥", "⭐", "🌟", "⚡", "💎", "👑", "🎉", "🎊", "🎁", "🔞", "✅", "❌", "❗", "❓"],
  },
  {
    label: "Animales",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐔", "🐧",
      "🐦", "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐴", "🦄", "🐝", "🦋", "🐢", "🐍", "🐙", "🦑", "🦀", "🐠", "🐬", "🐳", "🐋",
      "🦈", "🐊", "🦓", "🐘", "🐪", "🐫", "🦒", "🐕", "🐩", "🐈", "🦃", "🦚", "🦜", "🐇", "🌵", "🌲", "🌴", "🌱", "🌿", "🍀",
      "🌸", "🌹", "🌻", "🌼", "🌷", "💐", "🌊", "💧",
    ],
  },
  {
    label: "Comida",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🍈", "🍒", "🍑", "🥭", "🍍", "🥥", "🥑", "🍅", "🌽", "🥕", "🥐",
      "🍞", "🧀", "🥚", "🍳", "🥞", "🥓", "🍗", "🍔", "🍟", "🍕", "🌭", "🌮", "🌯", "🥗", "🍝", "🍜", "🍣", "🍱", "🍤", "🍙",
      "🍰", "🎂", "🧁", "🍭", "🍬", "🍫", "🍿", "🍩", "🍪", "🥜", "🍯", "🥛", "☕", "🍵", "🧃", "🥤", "🍺", "🍷", "🥂", "🍾",
    ],
  },
  {
    label: "Actividades",
    emojis: ["⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏓", "🏸", "🥊", "🎣", "🏋️", "🏄", "🏊", "🚴", "🏆", "🥇", "🎮", "🎲", "🎯", "🎳", "🎤", "🎧", "🎸", "🎹", "🎨", "🎬", "🎭", "💃", "🕺", "🎉"],
  },
  {
    label: "Objetos",
    emojis: [
      "📱", "💻", "⌨️", "🖥️", "📷", "📸", "🔍", "💡", "📔", "📝", "💰", "💴", "💵", "💶", "💷", "💸", "💳", "💹", "✉️", "📩",
      "📦", "✏️", "📁", "📅", "📌", "🔒", "🔑", "🔨", "⚙️", "🔗", "🛏️", "🚪", "🚿", "🛁", "🧴", "🚬", "🛒",
    ],
  },
  {
    label: "Banderas",
    emojis: ["🏳️", "🏴", "🚩", "🏳️‍🌈", "🇪🇸", "🇺🇸", "🇲🇽", "🇨🇴", "🇦🇷", "🇻🇪", "🇬🇧", "🇫🇷", "🇮🇹", "🇩🇪", "🇧🇷", "🇵🇹"],
  },
];

// Lista única plana con TODOS los emojis de arriba, sin categorías ni
// pestañas - el pedido explícito fue "una unica lista de TOOODOS los
// emojis... NADA MAS" tras el bug de que las pestañas de categoría cerraban
// el panel al pulsarlas. Deduplicada por si algún emoji aparece en más de
// una categoría de origen.
const ALL_EMOJIS = [...new Set(EMOJI_CATEGORIES.flatMap((c) => c.emojis))];

const RECENT_EMOJIS_KEY = "luxe_recent_emojis";
const RECENT_EMOJIS_MAX = 24;

function getRecentEmojis() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_EMOJIS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function pushRecentEmoji(emoji) {
  try {
    const list = getRecentEmojis().filter((e) => e !== emoji);
    list.unshift(emoji);
    localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(list.slice(0, RECENT_EMOJIS_MAX)));
  } catch {
    /* localStorage puede fallar (modo privado, cuota...) - no es crítico */
  }
}
const RECENT_PREMIUM_MAX = 32;
function getRecentPremium(accountId) {
  try {
    const v = JSON.parse(localStorage.getItem("luxe_recent_premium:" + accountId) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function pushRecentPremium(accountId, item) {
  try {
    const list = getRecentPremium(accountId).filter((e) => e.documentId !== item.documentId);
    list.unshift(item);
    localStorage.setItem("luxe_recent_premium:" + accountId, JSON.stringify(list.slice(0, RECENT_PREMIUM_MAX)));
  } catch {}
}
let openEmojiPanel = null;

function toggleEmojiPicker(anchorBtn, input, accountId, chatId) {
  if (openEmojiPanel) {
    openEmojiPanel.remove();
    openEmojiPanel = null;
    return;
  }
  const panel = el("div", { class: "emoji-picker" });
  const normalTabBtn = el("div", { class: "login-tab active" }, "Normal");
  const premiumTabBtn = el("div", { class: "login-tab" }, "Premium");
  panel.appendChild(el("div", { class: "login-tabs", style: "margin-bottom:8px" }, [normalTabBtn, premiumTabBtn]));
  const body = el("div", {});
  panel.appendChild(body);

  function insertEmoji(emoji) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + emoji.length;
    pushRecentEmoji(emoji);
  }

  function makeEmojiGrid(emojis) {
    const grid = el("div", { class: "emoji-picker-grid" });
    for (const emoji of emojis) {
      const btn = el("div", { class: "emoji-picker-item" }, emoji);
      btn.addEventListener("click", () => {
        insertEmoji(emoji);
        renderNormal(); // refresca "Recientes" con el que se acaba de usar
      });
      grid.appendChild(btn);
    }
    return grid;
  }

  // Sin pestañas de categorías: una sola lista con TODOS los emojis, y
  // arriba "Recientes" con los últimos usados (guardados en este navegador).
  function renderNormal() {
    body.innerHTML = "";
    const recent = getRecentEmojis();
    if (recent.length > 0) {
      body.appendChild(el("div", { class: "emoji-picker-section-label" }, "Recientes"));
      body.appendChild(makeEmojiGrid(recent));
    }
    body.appendChild(el("div", { class: "emoji-picker-section-label" }, "Todos"));
    body.appendChild(makeEmojiGrid(ALL_EMOJIS));
  }

  async function renderPremium() {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "emoji-picker-hint" },
      "Al hacer click se añade al cuadro de mensaje (puedes poner varios y escribir texto). Se envía con ➤. Solo se ve animado si esta cuenta tiene Telegram Premium."));
    // Primer apartado: los emojis premium usados hace poco EN ESTA creadora.
    const recentWrap = el("div", {});
    body.appendChild(recentWrap);
    const renderRecentPremium = () => {
      recentWrap.innerHTML = "";
      const recent = getRecentPremium(accountId);
      if (recent.length === 0) return;
      recentWrap.appendChild(el("div", { class: "emoji-picker-section-label" }, "Recientes"));
      const g = el("div", { class: "emoji-picker-grid" });
      for (const r of recent) {
        const item = el("img", {
          class: "emoji-picker-premium-item",
          src: `${API_BASE}/accounts/${accountId}/emoji-packs/${r.packId}/emoji-thumb/${r.documentId}`,
          loading: "lazy",
        });
        item.addEventListener("click", () => {
          insertPremiumEmojiIntoComposer(input, r.documentId, r.alt, r.packId, accountId);
          pushRecentPremium(accountId, r);
          renderRecentPremium();
        });
        g.appendChild(item);
      }
      recentWrap.appendChild(g);
    };
    renderRecentPremium();
    const gridWrap = el("div", {}, el("div", { class: "empty" }, "Cargando..."));
    body.appendChild(gridWrap);
    try {
      const { packs } = await api(`/accounts/${accountId}/emoji-packs`);
      if (packs.length === 0) {
        gridWrap.innerHTML = "";
        gridWrap.appendChild(el("div", { class: "empty" }, "Esta cuenta no tiene packs de emoji premium configurados (Configuración → Modelos)."));
        return;
      }
      gridWrap.innerHTML = "";
      // Con decenas de packs, cada uno se carga solo cuando se hace visible al
      // bajar (antes se pedian todos uno detras de otro y tardaba una eternidad).
      const loadPack = async (pack, packGrid) => {
        try {
          const { emojis } = await api(`/accounts/${accountId}/emoji-packs/${pack.id}/emojis`);
          for (const em of emojis) {
            const item = el("img", {
              class: "emoji-picker-premium-item",
              src: `${API_BASE}/accounts/${accountId}/emoji-packs/${pack.id}/emoji-thumb/${em.documentId}`,
              loading: "lazy",
            });
            item.addEventListener("click", () => {
              insertPremiumEmojiIntoComposer(input, em.documentId, em.alt, pack.id, accountId);
              pushRecentPremium(accountId, { documentId: em.documentId, alt: em.alt, packId: pack.id });
              renderRecentPremium();
            });
            packGrid.appendChild(item);
          }
        } catch {
          packGrid.appendChild(el("div", { class: "empty" }, "No se pudo cargar este pack."));
        }
      };
      const observer = "IntersectionObserver" in window
        ? new IntersectionObserver((entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              observer.unobserve(e.target);
              const fn = e.target._loadPack;
              if (fn) fn();
            }
          }, { root: body, rootMargin: "300px" })
        : null;
      for (const pack of packs) {
        const packGrid = el("div", { class: "emoji-picker-grid" });
        gridWrap.appendChild(el("div", { class: "hint", style: "margin:6px 0 2px" }, pack.title || pack.shortName));
        gridWrap.appendChild(packGrid);
        if (observer) {
          packGrid.style.minHeight = "36px";
          packGrid._loadPack = () => loadPack(pack, packGrid);
          observer.observe(packGrid);
        } else {
          await loadPack(pack, packGrid);
        }
      }
    } catch (err) {
      gridWrap.innerHTML = "";
      gridWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  normalTabBtn.addEventListener("click", () => {
    normalTabBtn.classList.add("active");
    premiumTabBtn.classList.remove("active");
    renderNormal();
  });
  premiumTabBtn.addEventListener("click", () => {
    premiumTabBtn.classList.add("active");
    normalTabBtn.classList.remove("active");
    renderPremium();
  });

  renderNormal();
  anchorBtn.parentElement.style.position = "relative";
  anchorBtn.parentElement.appendChild(panel);
  openEmojiPanel = panel;

  // Ojo: NO usar panel.contains(e.target) aquí. Varios clicks de dentro del
  // panel (elegir un emoji, cambiar "Recientes"...) reconstruyen el HTML
  // interno (innerHTML = "") antes de que este listener (en el document,
  // llega por bubbling DESPUÉS del listener propio del botón) se ejecute -
  // en ese momento e.target ya está desenganchado del árbol del DOM y
  // panel.contains(e.target) da false aunque el click fuera claramente
  // dentro del panel, cerrándolo por error. composedPath() sí vale: se
  // calcula al iniciar la propagación del evento, antes de cualquier
  // mutación del DOM que hagan los propios listeners.
  const closeOnOutsideClick = (e) => {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!path.includes(panel) && e.target !== anchorBtn) {
      panel.remove();
      openEmojiPanel = null;
      document.removeEventListener("click", closeOnOutsideClick);
    }
  };
  setTimeout(() => document.addEventListener("click", closeOnOutsideClick), 0);
}

// ---------- Programar mensaje (envio nativo programado de Telegram) ----------

function openMessageScheduleModal(accountId, chatId, input, chatPane) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Programar mensaje"));
    modal.appendChild(el("div", { class: "hint" }, "Telegram lo entrega automáticamente a la hora elegida, aunque el CRM esté apagado en ese momento."));

    const textArea = el("textarea", { rows: "4", placeholder: "Texto del mensaje..." }, input.value);
    textArea.value = input.value;
    const dateInput = el("input", { type: "date" });
    const timeInput = el("input", { type: "time" });
    const now = new Date(Date.now() + 5 * 60000);
    dateInput.value = now.toISOString().slice(0, 10);
    timeInput.value = now.toTimeString().slice(0, 5);

    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Mensaje"), textArea]));
    modal.appendChild(el("div", { class: "field sale-add-row" }, [
      el("div", { style: "flex:1" }, [el("label", {}, "Fecha"), dateInput]),
      el("div", { style: "flex:1" }, [el("label", {}, "Hora"), timeInput]),
    ]));

    const confirmBtn = el("button", { class: "primary" }, "Programar");
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      confirmBtn,
    ]));

    confirmBtn.addEventListener("click", async () => {
      const text = textArea.value.trim();
      if (!text) { toast("Escribe el mensaje a programar", true); return; }
      if (!dateInput.value || !timeInput.value) { toast("Elige fecha y hora", true); return; }
      const sendAt = new Date(`${dateInput.value}T${timeInput.value}:00`);
      confirmBtn.disabled = true;
      try {
        await api(`/accounts/${accountId}/dialogs/${chatId}/schedule`, {
          method: "POST",
          body: JSON.stringify({ text, sendAt: sendAt.toISOString() }),
        });
        toast("Mensaje programado para " + sendAt.toLocaleString("es-ES"));
        input.value = "";
        close();
      } catch (err) {
        toast(err.message, true);
      } finally {
        confirmBtn.disabled = false;
      }
    });
  });
}

// ---------- Contenido de la modelo (grupo con temas: sexting, fotos...) ----------

const CONTENT_TYPE_TABS = [
  { value: "all", label: "Todo" },
  { value: "photo", label: "Fotos" },
  { value: "video", label: "Vídeos" },
  { value: "audio", label: "Audios" },
];

function fmtContentDuration(sec) {
  if (sec === null || sec === undefined) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function contentTypeBadge(it) {
  if (it.type === "video") return "▶ " + (it.duration !== null ? fmtContentDuration(it.duration) : "vídeo");
  if (it.type === "audio") return "🎵 " + (it.duration !== null ? fmtContentDuration(it.duration) : "audio");
  return null;
}

function openContentLibraryModal(accountId, chatId, chatPane) {
  openModal(async (modal, close) => {
    modal.appendChild(el("h3", {}, "Contenido de la modelo"));
    const body = el("div", {});
    modal.appendChild(body);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cerrar")]));

    body.appendChild(el("div", { class: "empty" }, "Cargando..."));
    let group;
    try {
      const res = await api(`/accounts/${accountId}/content-group`);
      group = res.group;
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }

    if (!group) {
      renderGroupPicker();
    } else {
      renderLibrary(group);
    }

    function renderGroupPicker() {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "hint" }, "Todavía no has elegido el grupo de contenido de esta cuenta (el que tiene los temas: sexting, lencería, fotos...). Búscalo por nombre:"));
      const searchInput = el("input", { placeholder: "ej. Contenido Zoweey" });
      const resultsEl = el("div", { class: "scripts-manage-list" });
      body.appendChild(el("div", { class: "field" }, [el("label", {}, "Grupo"), searchInput]));
      body.appendChild(resultsEl);

      let searchTimer = null;
      async function doSearch() {
        resultsEl.innerHTML = "";
        resultsEl.appendChild(el("div", { class: "empty" }, "Buscando..."));
        try {
          const { groups } = await api(`/accounts/${accountId}/content-group/search?q=${encodeURIComponent(searchInput.value)}`);
          resultsEl.innerHTML = "";
          if (groups.length === 0) {
            resultsEl.appendChild(el("div", { class: "empty" }, "Sin resultados."));
          }
          for (const g of groups) {
            const row = el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto;cursor:pointer" });
            row.appendChild(el("div", {}, [el("div", { style: "font-weight:600" }, g.title), g.isForum ? el("div", { class: "hint" }, "Tiene temas ✓") : el("div", { class: "hint" }, "Sin temas (no vale)")]));
            const pickBtn = el("button", { class: "primary" }, "Elegir");
            pickBtn.disabled = !g.isForum;
            pickBtn.addEventListener("click", async () => {
              try {
                await api(`/accounts/${accountId}/content-group`, { method: "PUT", body: JSON.stringify({ chatId: g.chatId, title: g.title }) });
                toast("Grupo de contenido guardado");
                renderLibrary({ chatId: g.chatId, title: g.title });
              } catch (err) {
                toast(err.message, true);
              }
            });
            row.appendChild(pickBtn);
            resultsEl.appendChild(row);
          }
        } catch (err) {
          resultsEl.innerHTML = "";
          resultsEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
        }
      }
      searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 400); });
      doSearch();
    }

    async function renderLibrary(group) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "hint" }, "Grupo: " + (group.title || group.chatId) + " — haz click en un contenido para enviarlo a este chat."));

      const layout = el("div", { class: "content-library-layout" });
      body.appendChild(layout);

      const foldersPane = el("div", { class: "content-folders-pane" }, el("div", { class: "empty" }, "Cargando carpetas..."));
      const mainPane = el("div", { class: "content-main-pane" });
      layout.appendChild(foldersPane);
      layout.appendChild(mainPane);

      // filterMode: "topic" (un tema concreto) | "favorites"
      const libState = { topics: [], filterMode: null, activeTopic: null, activeType: "all", searchText: "", favCount: null };

      function renderFolders() {
        foldersPane.innerHTML = "";
        foldersPane.appendChild(el("div", { class: "content-folders-title" }, "CARPETAS"));
        const favRow = el(
          "div",
          { class: "content-folder-item" + (libState.filterMode === "favorites" ? " active" : ""), onclick: () => selectFavorites() },
          [el("span", {}, "⭐ Favoritos"), el("span", { class: "content-folder-count" }, libState.favCount === null ? "" : String(libState.favCount))]
        );
        foldersPane.appendChild(favRow);
        for (const t of libState.topics) {
          const active = libState.filterMode === "topic" && libState.activeTopic && libState.activeTopic.id === t.id;
          const row = el("div", { class: "content-folder-item" + (active ? " active" : ""), onclick: () => selectTopic(t) }, [
            el("span", {}, "🗂 " + t.title),
            el("span", { class: "content-folder-count" }, t.count === null ? "" : String(t.count)),
          ]);
          foldersPane.appendChild(row);
        }
      }

      async function loadFolders() {
        try {
          const [{ topics }, favRes] = await Promise.all([
            api(`/accounts/${accountId}/content-group/topics`),
            api(`/accounts/${accountId}/content-group/favorites`).catch(() => null),
          ]);
          libState.topics = topics;
          if (favRes) libState.favCount = favRes.items.length;
          renderFolders();
          if (topics.length > 0) selectTopic(topics[0]);
          else renderMain();
        } catch (err) {
          foldersPane.innerHTML = "";
          foldersPane.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
        }
      }

      function selectTopic(t) {
        libState.filterMode = "topic";
        libState.activeTopic = t;
        libState.activeType = "all";
        renderFolders();
        renderMain();
      }

      function selectFavorites() {
        libState.filterMode = "favorites";
        libState.activeTopic = null;
        renderFolders();
        renderMain();
      }

      function renderMain() {
        mainPane.innerHTML = "";
        const header = el("div", { class: "content-main-header" }, libState.filterMode === "favorites" ? "⭐ Favoritos" : libState.activeTopic ? libState.activeTopic.title : "");
        mainPane.appendChild(header);

        const searchInput = el("input", { placeholder: "Buscar por texto...", class: "content-search-input" });
        mainPane.appendChild(searchInput);

        const grid = el("div", { class: "content-items-grid" });
        const loadMoreRow = el("div", { class: "content-load-more-row" });

        let typeTabs = null;
        if (libState.filterMode === "topic") {
          typeTabs = el("div", { class: "content-type-tabs" });
          for (const tab of CONTENT_TYPE_TABS) {
            const chip = el("div", { class: "filter-chip" + (libState.activeType === tab.value ? " active" : "") }, tab.label);
            chip.addEventListener("click", () => {
              libState.activeType = tab.value;
              renderMain();
            });
            typeTabs.appendChild(chip);
          }
          mainPane.appendChild(typeTabs);
        }

        mainPane.appendChild(grid);
        mainPane.appendChild(loadMoreRow);

        function matchesSearch(it) {
          if (!libState.searchText) return true;
          return (it.caption || "").toLowerCase().includes(libState.searchText);
        }

        function applySearchVisibility() {
          for (const card of grid.children) {
            const caption = (card.dataset.caption || "").toLowerCase();
            card.style.display = !libState.searchText || caption.includes(libState.searchText) ? "" : "none";
          }
        }

        // Antes el buscador solo filtraba lo que ya estaba cargado (los
        // primeros 30 elementos de la carpeta): si lo que se buscaba estaba
        // más abajo, parecía que "no encontraba nada" sin más explicación.
        // Ahora, si no hay ningún resultado visible y todavía queda
        // contenido por cargar, seguimos pidiendo más tandas automáticamente
        // mientras se busca (con un tope, para no darle vueltas eternas a
        // Telegram si el texto no existe en ninguna parte).
        let searchSeq = 0;
        function anyCardVisible() {
          for (const card of grid.children) if (card.style.display !== "none") return true;
          return false;
        }
        async function autoContinueSearch(mySeq) {
          let rounds = 0;
          while (
            mySeq === searchSeq &&
            libState.searchText &&
            !anyCardVisible() &&
            lastHasMore &&
            lastNextOffsetId &&
            rounds < 10
          ) {
            rounds++;
            await loadPage(lastNextOffsetId);
            if (mySeq !== searchSeq) return;
            applySearchVisibility();
          }
        }
        searchInput.addEventListener("input", () => {
          libState.searchText = searchInput.value.trim().toLowerCase();
          applySearchVisibility();
          searchSeq++;
          if (libState.searchText) autoContinueSearch(searchSeq);
        });

        // Si falla la miniatura (por saturar a Telegram cuando el tema tiene
        // muchos archivos), la reintentamos un par de veces con espera antes
        // de rendirnos y mostrar el icono de "sin miniatura" en vez de que
        // el navegador pinte su icono roto feo.
        function bindThumbRetry(img, url) {
          let attempts = 0;
          img.addEventListener("error", () => {
            attempts++;
            if (attempts <= 3) {
              setTimeout(() => { img.src = url + "?r=" + Date.now() + attempts; }, 900 * attempts);
            } else {
              const fallback = el("div", { class: "content-item-thumb-empty" }, "🖼️");
              img.replaceWith(fallback);
            }
          });
        }

        async function toggleFavorite(it, favBtn, card) {
          try {
            const res = await api(`/accounts/${accountId}/content-group/favorites/toggle`, {
              method: "POST",
              body: JSON.stringify({ messageId: it.id, topicId: libState.activeTopic ? libState.activeTopic.id : undefined }),
            });
            it.isFavorite = res.favorite;
            if (favBtn) {
              favBtn.classList.toggle("active", res.favorite);
              favBtn.textContent = res.favorite ? "★" : "☆";
            }
            if (typeof libState.favCount === "number") {
              libState.favCount += res.favorite ? 1 : -1;
              const countEl = foldersPane.querySelector(".content-folder-item .content-folder-count");
              if (countEl) countEl.textContent = String(libState.favCount);
            }
            // Si estamos viendo favoritos y se quita uno, lo sacamos de la vista.
            if (libState.filterMode === "favorites" && !res.favorite && card) card.remove();
            return res.favorite;
          } catch (err) {
            toast(err.message, true);
            return it.isFavorite;
          }
        }

        function addCard(it) {
          const card = el("div", { class: "content-item-card" });
          card.dataset.caption = it.caption || "";
          const wrap = el("div", { class: "content-item-thumb-wrap" });
          if (it.hasThumb) {
            const thumbUrl = `${API_BASE}/accounts/${accountId}/content-group/messages/${it.id}/thumb`;
            const img = el("img", { src: thumbUrl, loading: "lazy", class: "content-item-thumb" });
            bindThumbRetry(img, thumbUrl);
            wrap.appendChild(img);
          } else {
            wrap.appendChild(el("div", { class: "content-item-thumb-empty" }, "📝"));
          }
          const badge = contentTypeBadge(it);
          if (badge) wrap.appendChild(el("div", { class: "content-item-type-badge" }, badge));
          if (it.mediaCount > 1) wrap.appendChild(el("div", { class: "content-item-count" }, "+" + it.mediaCount));
          // "YA ENVIADO": este contenido ya se le mando a ESTE fan en algun
          // momento (ver alreadySentToChat, calculado en el backend a
          // partir de ContentSendLog.sourceMessageId) - para que el chatter
          // no tenga que acordarse o ir a mirar el historial del chat antes
          // de volver a mandar algo.
          if (it.alreadySentToChat) wrap.appendChild(el("div", { class: "content-item-sent-badge" }, "YA ENVIADO"));
          wrap.appendChild(el("div", { class: "content-item-ver-overlay" }, "👁 VER"));

          const favBtn = el("button", { type: "button", class: "content-item-fav-btn" + (it.isFavorite ? " active" : ""), title: "Marcar como favorito" }, it.isFavorite ? "★" : "☆");
          favBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleFavorite(it, favBtn, card);
          });
          wrap.appendChild(favBtn);
          card.appendChild(wrap);

          if (it.caption) card.appendChild(el("div", { class: "content-item-caption" }, it.caption));
          card.addEventListener("click", () => {
            openContentViewer(it, favBtn, card);
          });
          grid.appendChild(card);
        }

        /** Vista grande al hacer click en un contenido: la foto/vídeo/audio
         * en grande, una nota interna (solo la ve el equipo) y los botones
         * de Cerrar / Favorito / Enviar, con la opción de mandarlo "para ver
         * una vez" (se autodestruye al abrirlo), igual que TeleCrew. */
        function openContentViewer(it, gridFavBtn, gridCard) {
          openModal((viewerModal, closeViewer) => {
            const titleRow = [it.caption || "Contenido"];
            if (it.alreadySentToChat) titleRow.push(el("span", { class: "content-item-sent-badge content-item-sent-badge-inline" }, "YA ENVIADO"));
            viewerModal.appendChild(el("h3", {}, titleRow));
            const mediaWrap = el("div", { class: "content-viewer-media-wrap" });
            if (!it.hasThumb) {
              // Mensaje de solo texto (sin foto/vídeo/audio): no hay nada
              // que previsualizar ni que enviar "para ver una vez".
              mediaWrap.appendChild(el("div", { class: "content-viewer-loading" }, "Este contenido es solo texto, sin foto ni vídeo."));
            } else {
              const mediaUrl = `${API_BASE}/accounts/${accountId}/content-group/messages/${it.id}/media`;
              const loadingMsg = el("div", { class: "content-viewer-loading" }, "Cargando vista previa... (puede tardar unos segundos si el archivo pesa)");
              mediaWrap.appendChild(loadingMsg);
              const clearLoading = () => loadingMsg.remove();
              let mediaEl;
              if (it.type === "video") {
                mediaEl = el("video", { src: mediaUrl, controls: "true", autoplay: "true" });
              } else if (it.type === "audio") {
                mediaEl = el("audio", { src: mediaUrl, controls: "true", autoplay: "true" });
              } else {
                mediaEl = el("img", { src: mediaUrl });
              }
              mediaEl.addEventListener(it.type === "video" || it.type === "audio" ? "loadeddata" : "load", clearLoading);
              mediaEl.addEventListener("error", () => { loadingMsg.textContent = "No se pudo cargar este contenido."; });
              mediaWrap.appendChild(mediaEl);
            }
            viewerModal.appendChild(mediaWrap);

            const body = el("div", { class: "content-viewer-body" });
            body.appendChild(el("div", { class: "content-viewer-note-label" }, "NOTA (ej. describir un audio o vídeo)"));
            const noteArea = el("textarea", { class: "content-viewer-note-textarea", placeholder: "Escribe una nota para identificar este contenido... Solo la ve el equipo, nunca el fan." }, it.note || "");
            const noteStatus = el("div", { class: "hint" }, "");
            let noteTimer = null;
            noteArea.addEventListener("input", () => {
              clearTimeout(noteTimer);
              noteStatus.textContent = "Escribiendo...";
              noteTimer = setTimeout(async () => {
                try {
                  await api(`/accounts/${accountId}/content-group/messages/${it.id}/note`, {
                    method: "PUT",
                    body: JSON.stringify({ note: noteArea.value }),
                  });
                  it.note = noteArea.value;
                  noteStatus.textContent = "Guardado";
                } catch (err) {
                  noteStatus.textContent = "";
                  toast(err.message, true);
                }
              }, 600);
            });
            body.appendChild(noteArea);
            body.appendChild(noteStatus);

            const onceCheckbox = el("input", { type: "checkbox" });
            if (it.hasThumb) {
              body.appendChild(
                el("label", { class: "content-viewer-once-row" }, [
                  onceCheckbox,
                  el("span", {}, "🔥 Enviar para ver una vez (se autodestruye al abrirlo)"),
                ])
              );
            }
            viewerModal.appendChild(body);

            const favBtn2 = el("button", { class: "ghost" }, it.isFavorite ? "★ Favorito" : "☆ Favorito");
            favBtn2.addEventListener("click", async () => {
              const fav = await toggleFavorite(it, gridFavBtn, gridCard);
              favBtn2.textContent = fav ? "★ Favorito" : "☆ Favorito";
            });
            const sendBtn = el("button", { class: "primary" }, "Enviar");
            sendBtn.addEventListener("click", async () => {
              sendBtn.disabled = true;
              sendBtn.textContent = "Enviando...";
              try {
                if (onceCheckbox.checked) {
                  await api(`/accounts/${accountId}/content-group/send-once`, {
                    method: "POST",
                    body: JSON.stringify({ chatId, messageId: it.id, sourceItemId: it.id }),
                  });
                } else {
                  await api(`/accounts/${accountId}/content-group/send`, {
                    method: "POST",
                    body: JSON.stringify({ chatId, messageIds: it.messageIds, sourceItemId: it.id }),
                  });
                }
                // Se marca YA como "YA ENVIADO" en la tarjeta, sin esperar a
                // que se vuelva a abrir la bóveda para que se note - "ver
                // una vez" se autodestruye en el chat, pero sigue contando
                // como enviado para este efecto.
                it.alreadySentToChat = true;
                if (gridCard) {
                  const existingBadge = gridCard.querySelector(".content-item-sent-badge");
                  if (!existingBadge) {
                    const wrap = gridCard.querySelector(".content-item-thumb-wrap");
                    if (wrap) wrap.appendChild(el("div", { class: "content-item-sent-badge" }, "YA ENVIADO"));
                  }
                }
                toast("Contenido enviado");
                closeViewer();
                close();
                renderChat(accountId, chatId, mensajesState.currentChatTitle, chatPane, true, { forceScrollBottom: true });
              } catch (err) {
                toast(err.message, true);
                sendBtn.disabled = false;
                sendBtn.textContent = "Enviar";
              }
            });
            viewerModal.appendChild(el("div", { class: "content-viewer-actions" }, [
              el("button", { class: "ghost", onclick: closeViewer }, "Cerrar"),
              favBtn2,
              sendBtn,
            ]));
          }, { wide: false });
        }

        let loadedAny = false;
        let lastHasMore = false;
        let lastNextOffsetId = null;
        async function loadPage(offsetId) {
          if (!offsetId) {
            grid.innerHTML = "";
            grid.appendChild(el("div", { class: "empty content-loading-placeholder" }, "Cargando..."));
          }
          loadMoreRow.innerHTML = "";
          loadMoreRow.appendChild(el("div", { class: "empty" }, "Cargando..."));
          try {
            let items, hasMore, nextOffsetId;
            if (libState.filterMode === "favorites") {
              const favQs = chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
              const res = await api(`/accounts/${accountId}/content-group/favorites${favQs}`);
              items = res.items;
              hasMore = false;
              nextOffsetId = null;
            } else {
              const params = new URLSearchParams();
              if (offsetId) params.set("offsetId", offsetId);
              if (libState.activeType !== "all") params.set("type", libState.activeType);
              // chatId: para que cada tarjeta venga marcada "YA ENVIADO" si
              // ya se le mando a ESTE fan antes (ver alreadySentToChat).
              if (chatId) params.set("chatId", chatId);
              const qs = params.toString() ? `?${params.toString()}` : "";
              const res = await api(`/accounts/${accountId}/content-group/topics/${libState.activeTopic.id}/items${qs}`);
              items = res.items;
              hasMore = res.hasMore;
              nextOffsetId = res.nextOffsetId;
            }
            loadMoreRow.innerHTML = "";
            const placeholder = grid.querySelector(".content-loading-placeholder");
            if (placeholder) placeholder.remove();
            if (!loadedAny && items.length === 0) {
              grid.appendChild(el("div", { class: "empty" }, libState.filterMode === "favorites" ? "Todavía no has marcado nada como favorito." : "Sin contenido en esta carpeta." ));
            }
            loadedAny = true;
            lastHasMore = hasMore;
            lastNextOffsetId = nextOffsetId;
            for (const it of items) addCard(it);
            applySearchVisibility();
            if (hasMore && nextOffsetId) {
              const moreBtn = el("button", { class: "ghost" }, "Cargar más contenido");
              moreBtn.addEventListener("click", () => loadPage(nextOffsetId));
              loadMoreRow.appendChild(moreBtn);
            }
          } catch (err) {
            loadMoreRow.innerHTML = "";
            const placeholder = grid.querySelector(".content-loading-placeholder");
            if (placeholder) placeholder.remove();
            if (!loadedAny) grid.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
            else toast(err.message, true);
          }
        }
        loadPage(null);
      }

      await loadFolders();
    }
  }, { wide: true });
}

// ---------- Scripts (mensajes guardados para insertar rapido) ----------

let scriptsCache = { accountId: null, scripts: null };

async function fetchScripts(accountId, force) {
  if (!force && scriptsCache.accountId === accountId && scriptsCache.scripts) return scriptsCache.scripts;
  const { scripts } = await api(`/accounts/${accountId}/scripts`);
  scriptsCache = { accountId, scripts };
  return scripts;
}

// ---------- Respuestas rápidas de Telegram Business ("Quick replies") ----------
// A diferencia de Scripts (que son nuestros, guardados en la base de datos),
// estas viven en la propia cuenta de Telegram (Ajustes → Negocio →
// Respuestas rápidas de la app oficial) - aqui solo se leen y se mandan,
// nunca se crean/editan/borran desde el CRM.

let quickRepliesCache = { accountId: null, shortcuts: null };

async function fetchQuickReplies(accountId, force) {
  if (!force && quickRepliesCache.accountId === accountId && quickRepliesCache.shortcuts) return quickRepliesCache.shortcuts;
  const { shortcuts } = await api(`/accounts/${accountId}/business-quick-replies`);
  quickRepliesCache = { accountId, shortcuts };
  return shortcuts;
}

/** Botón ⚡ + panel flotante de respuestas rápidas de Telegram Business,
 * para el composer del chat: se abre a mano con el botón o solo con
 * escribir "/" al principio del mensaje (igual que en la app oficial), y
 * filtra en vivo por lo que se escriba después de la barra. Elegir una la
 * manda entera (texto y/o fotos, lo que tenga el shortcut) de golpe - no se
 * inserta como texto, porque puede llevar contenido que un <input> de texto
 * no puede representar. */
function renderQuickReplyPicker(iconsRow, accountId, chatId, input, onSent) {
  const panel = el("div", { class: "scripts-panel hidden" });
  let shortcuts = null;
  let open = false;

  function paint(filterText) {
    panel.innerHTML = "";
    const f = (filterText || "").toLowerCase();
    const list = shortcuts || [];
    const filtered = f ? list.filter((s) => s.shortcut.toLowerCase().includes(f)) : list;
    if (filtered.length === 0) {
      panel.appendChild(el("div", { class: "empty" }, list.length === 0
        ? "Esta cuenta no tiene respuestas rápidas guardadas en Telegram (Ajustes → Negocio, en la app oficial - necesita Premium/Business)."
        : "Sin coincidencias."));
      return;
    }
    for (const s of filtered) {
      panel.appendChild(el("div", {
        class: "script-item",
        onclick: () => send(s),
      }, [
        el("div", { class: "script-item-title" }, "/" + s.shortcut),
        el("div", { class: "script-item-preview" }, s.preview || (s.count > 1 ? `${s.count} mensajes` : "1 mensaje")),
      ]));
    }
  }

  async function send(s) {
    close();
    try {
      await api(`/accounts/${accountId}/dialogs/${chatId}/send-business-quick-reply`, {
        method: "POST",
        body: JSON.stringify({ shortcutId: s.shortcutId }),
      });
      // Si el input solo tenia el "/algo" que abrio el panel, se limpia -
      // la respuesta rapida ya se manda entera por su cuenta.
      if (input.value.trim().startsWith("/")) input.value = "";
      toast("Respuesta rápida enviada");
      if (onSent) await onSent();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function close() {
    open = false;
    panel.classList.add("hidden");
  }

  async function openWithFilter(filterText) {
    open = true;
    panel.classList.remove("hidden");
    if (!shortcuts) {
      panel.innerHTML = "";
      panel.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        shortcuts = await fetchQuickReplies(accountId);
      } catch (err) {
        panel.innerHTML = "";
        panel.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
        return;
      }
    }
    paint(filterText);
  }

  const toggleBtn = el("button", { type: "button", class: "composer-icon-btn", title: "Respuestas rápidas de Telegram Business (o escribe \"/\")" }, "⚡");
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) { close(); return; }
    openWithFilter("");
  });
  iconsRow.appendChild(toggleBtn);

  // Escribir "/" al principio del mensaje abre el panel y filtra en vivo,
  // igual que la app oficial de Telegram Business.
  input.addEventListener("input", () => {
    const v = input.value;
    if (v.startsWith("/")) {
      if (!open) openWithFilter(v.slice(1));
      else if (shortcuts) paint(v.slice(1));
    } else if (open) {
      close();
    }
  });

  const closeOnOutsideClick = (e) => {
    if (open && !panel.contains(e.target) && e.target !== toggleBtn) close();
  };
  document.addEventListener("click", closeOnOutsideClick);

  return panel;
}

/** Mantiene alineadas las entidades de emoji premium (input._premiumEntities)
 * con el texto cuando se edita a mano el cuadro de mensaje: lo que se
 * escribe/borra ANTES de un emoji lo desplaza, y si se borra el propio emoji
 * se descarta su entidad. Compara el valor anterior con el nuevo. */
function syncPremiumEntities(input) {
  if (input._isRich) return; // la barra rica ya mantiene los emojis alineados por si sola
  const oldV = input._lastValue || "";
  const newV = input.value;
  input._lastValue = newV;
  if (oldV === newV || !input._premiumEntities || input._premiumEntities.length === 0) return;
  let p = 0;
  const minLen = Math.min(oldV.length, newV.length);
  while (p < minLen && oldV[p] === newV[p]) p++;
  let sfx = 0;
  while (sfx < minLen - p && oldV[oldV.length - 1 - sfx] === newV[newV.length - 1 - sfx]) sfx++;
  const delta = newV.length - oldV.length;
  const removedEnd = oldV.length - sfx;
  const kept = [];
  for (const e of input._premiumEntities) {
    if (e.offset + e.length <= p) kept.push(e);
    else if (e.offset >= removedEnd) kept.push({ ...e, offset: e.offset + delta });
  }
  input._premiumEntities = kept;
}

/** Barra de mensaje "rica": un div editable que se comporta como el <input>
 * de antes (value, selectionStart/End, setSelectionRange, focus, _premiumEntities)
 * pero ensena los emojis premium como imagen DENTRO de la propia barra.
 * Cada emoji premium es un nodo ".pe" (atomico) que cuenta como los
 * caracteres de su emoji normal equivalente, asi los offsets de las
 * entidades se calculan siempre sobre el texto plano que se envia.
 * Si algo fallase, volver al <input> de siempre: git checkout antes-barra-emojis-rica */
function createRichComposerInput(accountId) {
  const box = el("div", {
    class: "chat-composer-input chat-composer-editable",
    contenteditable: "true",
    role: "textbox",
    "data-placeholder": "Escribe un mensaje...",
    spellcheck: "true",
  });
  box._isRich = true;
  const isPe = (n) => n.nodeType === 1 && n.classList.contains("pe");
  const lenOf = (n) =>
    n.nodeType === 3 ? n.data.length : isPe(n) ? (n.dataset.alt || "").length : n.nodeName === "BR" ? 0 : (n.textContent || "").length;
  const textOf = (n) =>
    n.nodeType === 3 ? n.data.replace(/\u00a0/g, " ") : isPe(n) ? (n.dataset.alt || "") : n.nodeName === "BR" ? "" : (n.textContent || "").replace(/\u00a0/g, " ");
  const getValue = () => [...box.childNodes].map(textOf).join("");
  const getEnts = () => {
    const out = [];
    let t = 0;
    for (const c of box.childNodes) {
      const l = lenOf(c);
      if (isPe(c)) {
        out.push({ offset: t, length: l, documentId: c.dataset.doc, packId: c.dataset.pack || undefined, accountId: c.dataset.acc || undefined });
      }
      t += l;
    }
    return out;
  };
  const makePe = (e, alt) => {
    const acc = e.accountId || accountId;
    let n;
    if (e.packId && acc) {
      n = document.createElement("img");
      n.src = `${API_BASE}/accounts/${acc}/emoji-packs/${e.packId}/emoji-thumb/${e.documentId}`;
      n.draggable = false;
      n.alt = alt;
    } else {
      n = document.createElement("span");
      n.textContent = alt;
    }
    n.className = "pe";
    n.contentEditable = "false";
    n.dataset.doc = e.documentId;
    n.dataset.alt = alt;
    n.dataset.pack = e.packId || "";
    n.dataset.acc = acc || "";
    return n;
  };
  const setContent = (text, ents) => {
    box.innerHTML = "";
    const list = (ents || []).filter((e) => e && e.documentId && e.length > 0).sort((a, b) => a.offset - b.offset);
    let pos = 0;
    for (const e of list) {
      if (e.offset < pos || e.offset + e.length > text.length) continue;
      if (e.offset > pos) box.appendChild(document.createTextNode(text.slice(pos, e.offset)));
      box.appendChild(makePe(e, text.substr(e.offset, e.length)));
      pos = e.offset + e.length;
    }
    if (pos < text.length) box.appendChild(document.createTextNode(text.slice(pos)));
  };
  const offsetOf = (container, off) => {
    if (container === box) {
      let t = 0;
      for (let i = 0; i < off && i < box.childNodes.length; i++) t += lenOf(box.childNodes[i]);
      return t;
    }
    let t = 0;
    for (const c of box.childNodes) {
      if (c === container) return t + (c.nodeType === 3 ? off : off > 0 ? lenOf(c) : 0);
      if (c.contains && c.contains(container)) return t + (off > 0 ? lenOf(c) : 0);
      t += lenOf(c);
    }
    return t;
  };
  const posOf = (offset) => {
    let t = 0;
    const kids = [...box.childNodes];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const l = lenOf(c);
      if (c.nodeType === 3) {
        if (offset <= t + l) return [c, Math.max(0, offset - t)];
      } else {
        if (offset <= t) return [box, i];
        if (offset < t + l) return [box, i + 1];
      }
      t += l;
    }
    return [box, kids.length];
  };
  const getSel = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.anchorNode && box.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      return [offsetOf(r.startContainer, r.startOffset), offsetOf(r.endContainer, r.endOffset)];
    }
    const len = getValue().length;
    const last = box._lastSel || [len, len];
    return [Math.min(last[0], len), Math.min(last[1], len)];
  };
  const setSel = (a, b) => {
    const len = getValue().length;
    a = Math.max(0, Math.min(a, len));
    b = Math.max(a, Math.min(b, len));
    try {
      const r = document.createRange();
      const [n1, o1] = posOf(a);
      const [n2, o2] = posOf(b);
      r.setStart(n1, o1);
      r.setEnd(n2, o2);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {}
    box._lastSel = [a, b];
  };
  const adapt = (ents, oldV, newV) => {
    let p = 0;
    const minLen = Math.min(oldV.length, newV.length);
    while (p < minLen && oldV[p] === newV[p]) p++;
    let sfx = 0;
    while (sfx < minLen - p && oldV[oldV.length - 1 - sfx] === newV[newV.length - 1 - sfx]) sfx++;
    const delta = newV.length - oldV.length;
    const removedEnd = oldV.length - sfx;
    const kept = [];
    for (const e of ents) {
      if (e.offset + e.length <= p) kept.push(e);
      else if (e.offset >= removedEnd) kept.push({ ...e, offset: e.offset + delta });
    }
    return kept;
  };
  Object.defineProperties(box, {
    value: {
      get: getValue,
      set(v) {
        v = String(v == null ? "" : v);
        const oldV = getValue();
        if (oldV === v) return;
        setContent(v, adapt(getEnts(), oldV, v));
        box._lastSel = [v.length, v.length];
      },
    },
    _premiumEntities: {
      get: getEnts,
      set(list) { setContent(getValue(), list || []); },
    },
    selectionStart: {
      get() { return getSel()[0]; },
      set(v) { setSel(v, Math.max(v, getSel()[1])); },
    },
    selectionEnd: {
      get() { return getSel()[1]; },
      set(v) { setSel(Math.min(getSel()[0], v), v); },
    },
  });
  box.setSelectionRange = (a, b) => setSel(a, b);
  // Inserta texto (y, si se pasa, un emoji premium) reemplazando la seleccion.
  box._insertAt = (text, ent) => {
    const [s0, e0] = getSel();
    const v = getValue();
    const ents = getEnts()
      .filter((x) => x.offset + x.length <= s0 || x.offset >= e0)
      .map((x) => (x.offset >= e0 ? { ...x, offset: x.offset - (e0 - s0) + text.length } : x));
    if (ent) ents.push({ offset: s0, length: text.length, documentId: ent.documentId, packId: ent.packId, accountId: ent.accountId });
    setContent(v.slice(0, s0) + text + v.slice(e0), ents);
    setSel(s0 + text.length, s0 + text.length);
    box.dispatchEvent(new Event("input"));
  };
  const save = () => { box._lastSel = getSel(); };
  for (const ev of ["keyup", "mouseup", "blur", "input"]) box.addEventListener(ev, save);
  box.addEventListener("input", () => {
    if (!box.querySelector(".pe") && !(box.textContent || "").trim()) box.innerHTML = ""; // para que salga el placeholder
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault(); // una sola linea, como antes; el envio lo gestiona el otro listener
    if ((e.key === "Backspace" || e.key === "Delete") && !e.isComposing) {
      // Borrar un emoji premium vecino al cursor (el navegador no siempre lo hace solo).
      const [a, b] = getSel();
      if (a === b) {
        const ent = getEnts().find((x) => (e.key === "Backspace" ? x.offset + x.length === a : x.offset === a));
        if (ent) {
          e.preventDefault();
          const v = getValue();
          const rest = getEnts()
            .filter((x) => x !== ent && !(x.offset === ent.offset))
            .map((x) => (x.offset > ent.offset ? { ...x, offset: x.offset - ent.length } : x));
          setContent(v.slice(0, ent.offset) + v.slice(ent.offset + ent.length), rest);
          setSel(ent.offset, ent.offset);
          box.dispatchEvent(new Event("input"));
        }
      }
    }
  });
  box.addEventListener("paste", (e) => {
    e.preventDefault();
    const t = ((e.clipboardData || window.clipboardData).getData("text") || "").replace(/\s*\n\s*/g, " ");
    if (t) box._insertAt(t);
  });
  box.addEventListener("drop", (e) => e.preventDefault());
  return box;
}

/** Fila encima de la barra de mensaje que ENSENA los emojis premium elegidos
 * (la barra en si es un campo de texto y solo puede mostrar el emoji normal
 * equivalente). Click en uno para quitarlo. */
function refreshPremiumPreview(input) {
  const box = input._previewEl;
  if (!box || input._isRich) return;
  const ents = (input._premiumEntities || []).slice().sort((a, b) => a.offset - b.offset);
  box.innerHTML = "";
  box.classList.toggle("hidden", ents.length === 0);
  for (const e of ents) {
    const ch = input.value.substr(e.offset, e.length);
    const chip = e.packId && e.accountId
      ? el("img", {
          class: "premium-preview-item",
          title: "Quitar",
          src: `${API_BASE}/accounts/${e.accountId}/emoji-packs/${e.packId}/emoji-thumb/${e.documentId}`,
        })
      : el("span", { class: "premium-preview-item premium-preview-char", title: "Quitar" }, ch);
    chip.addEventListener("click", () => removePremiumEntity(input, e));
    box.appendChild(chip);
  }
}

function removePremiumEntity(input, e) {
  const list = input._premiumEntities || [];
  const idx = list.indexOf(e);
  if (idx < 0) return;
  list.splice(idx, 1);
  for (const x of list) if (x.offset > e.offset) x.offset -= e.length;
  input.value = input.value.slice(0, e.offset) + input.value.slice(e.offset + e.length);
  input._lastValue = input.value;
  refreshPremiumPreview(input);
  input.focus();
}

/** Mete un emoji premium en el cuadro de mensaje (en la posicion del cursor)
 * en vez de mandarlo: asi se puede escribir texto con el, o juntar varios
 * emojis premium, y enviar todo junto con el boton de enviar. */
function insertPremiumEmojiIntoComposer(input, documentId, alt, packId, accountId) {
  if (input._isRich) {
    input.focus();
    input._insertAt(alt || "🙂", { documentId, packId, accountId });
    return;
  }
  syncPremiumEntities(input);
  if (!input._premiumEntities) input._premiumEntities = [];
  const v = input.value;
  let pos = typeof input.selectionStart === "number" ? input.selectionStart : v.length;
  if (pos > v.length) pos = v.length;
  const ch = alt || "🙂";
  input.value = v.slice(0, pos) + ch + v.slice(pos);
  for (const e of input._premiumEntities) {
    if (e.offset >= pos) e.offset += ch.length;
  }
  input._premiumEntities.push({ offset: pos, length: ch.length, documentId, packId, accountId });
  input._lastValue = input.value;
  refreshPremiumPreview(input);
  input.focus();
  try { input.setSelectionRange(pos + ch.length, pos + ch.length); } catch {}
}

/** Inserta el texto de un script en el input del chat y, si tiene emoji
 * premium guardados, arrastra sus entidades a input._premiumEntities
 * (desplazadas por lo que ya hubiera escrito antes) para que el botón
 * Enviar las mande junto con el mensaje. Un input normal (<input>) no puede
 * guardar nada que no sea texto plano - por eso las entidades viven aparte,
 * como una propiedad del propio elemento, no dentro de input.value. */
function insertScriptIntoComposer(input, script) {
  if (input._isRich) {
    const prefix = input.value ? input.value + " " : "";
    const baseOffset = prefix.length;
    input.value = prefix + script.content; // conserva los emojis premium que ya hubiera
    const cur = input._premiumEntities;
    for (const e of script.entities || []) {
      cur.push({ offset: baseOffset + e.offset, length: e.length, documentId: e.documentId });
    }
    input._premiumEntities = cur;
    const end = input.value.length;
    input.focus();
    input.setSelectionRange(end, end);
    return;
  }
  const prefix = input.value ? input.value + " " : "";
  const baseOffset = prefix.length;
  syncPremiumEntities(input);
  input.value = prefix + script.content;
  input._lastValue = input.value;
  if (script.entities && script.entities.length > 0) {
    if (!input._premiumEntities) input._premiumEntities = [];
    for (const e of script.entities) {
      input._premiumEntities.push({ offset: baseOffset + e.offset, length: e.length, documentId: e.documentId });
    }
  }
  refreshPremiumPreview(input);
}

function renderScriptsBar(bar, accountId, input) {
  bar.innerHTML = "";
  const toggleBtn = el("button", { type: "button", class: "scripts-toggle" }, "💬 Scripts");
  const panel = el("div", { class: "scripts-panel hidden" });
  bar.appendChild(toggleBtn);
  bar.appendChild(panel);

  let open = false;
  async function refreshPanel() {
    panel.innerHTML = "";
    panel.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const scripts = await fetchScripts(accountId);
      panel.innerHTML = "";
      if (scripts.length === 0) {
        panel.appendChild(el("div", { class: "empty" }, "Aún no tienes scripts guardados."));
      } else {
        for (const s of scripts) {
          panel.appendChild(el("div", {
            class: "script-item",
            onclick: () => {
              insertScriptIntoComposer(input, s);
              input.focus();
              panel.classList.add("hidden");
              open = false;
            },
          }, [
            el("div", { class: "script-item-title" }, [s.title, (s.entities && s.entities.length > 0) ? " ✨" : ""]),
            el("div", { class: "script-item-preview" }, s.content.slice(0, 80)),
          ]));
        }
      }
      panel.appendChild(el("div", {
        class: "script-manage-link",
        onclick: (e) => { e.stopPropagation(); openScriptsManageModal(accountId, () => refreshPanel()); },
      }, "⚙ Gestionar scripts"));
    } catch (err) {
      panel.innerHTML = "";
      panel.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  toggleBtn.addEventListener("click", async () => {
    open = !open;
    panel.classList.toggle("hidden", !open);
    if (open) await refreshPanel();
  });
}

function openScriptsManageModal(accountId, onChange) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Scripts guardados"));
    modal.appendChild(el("div", { class: "hint" }, "Respuestas rápidas para insertar en cualquier chat de esta cuenta."));

    const listEl = el("div", { class: "scripts-manage-list" });
    modal.appendChild(listEl);

    // Emoji premium del script que se esta creando (si se elige uno "De la
    // bóveda"): igual que en cada fila ya guardada, van aparte del texto -
    // sus offsets ya vienen calculados desde el propio mensaje de la bóveda.
    let newEntities = [];
    const newEntitiesHint = el("div", { class: "hint" });
    function paintNewEntitiesHint() {
      newEntitiesHint.textContent = newEntities.length > 0 ? `✨ Este script llevará ${newEntities.length} emoji premium.` : "";
    }
    const titleInput = el("input", { placeholder: "Título (ej. Precio pack)" });
    const contentArea = el("textarea", { rows: "4", placeholder: "Texto del mensaje..." });
    const vaultBtn = el("button", { class: "ghost", type: "button" }, "📥 De la bóveda");
    vaultBtn.addEventListener("click", () => {
      openVaultTextPickerModal(accountId, (text, entities) => {
        contentArea.value = text;
        newEntities = entities || [];
        paintNewEntitiesHint();
      });
    });
    const addBtn = el("button", { class: "primary" }, "+ Añadir script");
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Título"), titleInput]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Mensaje"), contentArea, vaultBtn, newEntitiesHint]));
    modal.appendChild(addBtn);
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cerrar"),
    ]));

    async function refresh() {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const scripts = await fetchScripts(accountId, true);
        listEl.innerHTML = "";
        if (scripts.length === 0) {
          listEl.appendChild(el("div", { class: "empty" }, "Sin scripts todavía."));
        }
        for (const s of scripts) {
          const titleEl = el("input", { value: s.title });
          const contentEl = el("textarea", { rows: "2" }, s.content);
          contentEl.value = s.content;
          let rowEntities = s.entities || [];
          const rowHint = el("div", { class: "hint" }, rowEntities.length > 0 ? `✨ ${rowEntities.length} emoji premium` : "");
          const rowVaultBtn = el("button", { class: "ghost", type: "button", title: "Elegir texto de la bóveda" }, "📥");
          rowVaultBtn.addEventListener("click", () => {
            openVaultTextPickerModal(accountId, (text, entities) => {
              contentEl.value = text;
              rowEntities = entities || [];
              rowHint.textContent = rowEntities.length > 0 ? `✨ ${rowEntities.length} emoji premium` : "";
            });
          });
          const saveBtn = el("button", { class: "ghost" }, "Guardar");
          const delBtn = el("button", { class: "danger" }, "Eliminar");
          saveBtn.addEventListener("click", async () => {
            try {
              await api(`/scripts/${s.id}`, {
                method: "PATCH",
                body: JSON.stringify({ title: titleEl.value, content: contentEl.value, entities: rowEntities }),
              });
              toast("Script guardado");
              await refresh();
              if (onChange) onChange();
            } catch (err) {
              toast(err.message, true);
            }
          });
          delBtn.addEventListener("click", async () => {
            const ok = await confirmModal({ title: "Eliminar script", body: `¿Eliminar "${s.title}"?`, confirmLabel: "Eliminar", danger: true });
            if (!ok) return;
            try {
              await api(`/scripts/${s.id}`, { method: "DELETE" });
              toast("Script eliminado");
              await refresh();
              if (onChange) onChange();
            } catch (err) {
              toast(err.message, true);
            }
          });
          listEl.appendChild(el("div", { class: "script-manage-row" }, [
            titleEl,
            el("div", {}, [contentEl, rowHint]),
            el("div", { class: "script-manage-actions" }, [rowVaultBtn, saveBtn, delBtn]),
          ]));
        }
      } catch (err) {
        listEl.innerHTML = "";
        listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    addBtn.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      const content = contentArea.value.trim();
      if (!title || !content) { toast("Rellena título y mensaje", true); return; }
      try {
        await api(`/accounts/${accountId}/scripts`, { method: "POST", body: JSON.stringify({ title, content, entities: newEntities }) });
        titleInput.value = "";
        contentArea.value = "";
        newEntities = [];
        paintNewEntitiesHint();
        toast("Script añadido");
        await refresh();
        if (onChange) onChange();
      } catch (err) {
        toast(err.message, true);
      }
    });

    refresh();
  }, { wide: true });
}

function renderSfsNotesPanel(notesPane, accountId, chatId) {
  const tabsRow = el("div", { class: "login-tabs" }, [el("div", { class: "login-tab active" }, "Notas para SFS")]);
  const body = el("div", {});
  notesPane.appendChild(tabsRow);
  notesPane.appendChild(body);

  if (!chatId) {
    body.appendChild(el("div", { class: "empty" }, "Elige una conversación para ver sus notas."));
    return;
  }
  body.appendChild(el("div", { class: "hint" }, "Solo el equipo ve esto, nunca el fan. Independiente de las notas del fan de Mensajes."));

  const noteArea = el("textarea", { rows: 14, placeholder: "Escribe aquí lo que necesites recordar sobre este SFS..." });
  body.appendChild(el("div", { class: "field" }, [el("label", {}, "Notas para SFS"), noteArea]));
  noteArea.disabled = true;
  noteArea.value = "Cargando...";

  api(`/accounts/${accountId}/dialogs/${chatId}/sfs-note`).then((res) => {
    noteArea.disabled = false;
    noteArea.value = res.note || "";
  }).catch((err) => {
    noteArea.disabled = false;
    noteArea.value = "";
    toast(err.message, true);
  });

  let saveTimer = null;
  noteArea.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(`/accounts/${accountId}/dialogs/${chatId}/sfs-note`, {
          method: "PUT",
          body: JSON.stringify({ note: noteArea.value }),
        });
      } catch (err) {
        toast(err.message, true);
      }
    }, 600);
  });
}

function renderNotesPanel(notesPane, accountId, chatId, chatTitle) {
  notesPane.innerHTML = "";
  // "SFS" reutiliza este mismo chat/panel de Mensajes tal cual, pero con
  // notas propias (SfsNote, no FanNote): un textarea simple, sin listas, sin
  // ventas ni telefono - eso sigue siendo cosa de "Notas del fan".
  if (mensajesState.sfsMode) {
    renderSfsNotesPanel(notesPane, accountId, chatId);
    return;
  }
  let tab = "fan";
  // El texto de la pestaña de precios lleva el nombre de la creadora
  // ("PRECIOS (CLOE)") en vez del genérico "Precios modelo", para que se
  // vea claro de qué cuenta son esos precios cuando se tienen varias
  // creadoras abiertas en pestañas a la vez.
  const accountForTab = state.accounts.find((a) => a.id === accountId);
  const pricesTabLabel = accountForTab ? `PRECIOS (${accountForTab.label.toUpperCase()})` : "Precios modelo";
  const fanTabBtn = el("div", { class: "login-tab" + (tab === "fan" ? " active" : "") }, "Notas del fan");
  const modelTabBtn = el("div", { class: "login-tab" + (tab === "model" ? " active" : "") }, "Notas de la modelo");
  const pricesTabBtn = el("div", { class: "login-tab" + (tab === "prices" ? " active" : "") }, pricesTabLabel);
  const tabsRow = el("div", { class: "login-tabs" }, [fanTabBtn, modelTabBtn, pricesTabBtn]);
  const body = el("div", {});
  notesPane.appendChild(tabsRow);
  notesPane.appendChild(body);

  function fmtMoney(n) {
    return "$" + Number(n || 0).toFixed(2);
  }

  function renderFanTab() {
    body.innerHTML = "";
    if (!chatId) {
      body.appendChild(el("div", { class: "empty" }, "Elige una conversación para ver sus notas."));
      return;
    }
    body.appendChild(el("div", { class: "hint" }, "Solo el equipo ve esto, nunca el fan."));

    // --- Numero de telefono + pais detectado ---
    const phoneBox = el("div", { class: "fan-phone-box" }, "Detectando número...");
    body.appendChild(phoneBox);
    api(`/accounts/${accountId}/dialogs/${chatId}/profile`).then((res) => {
      if (!res.phone) {
        phoneBox.textContent = "Sin número visible para esta cuenta.";
        return;
      }
      phoneBox.innerHTML = "";
      phoneBox.appendChild(el("div", { class: "fan-phone-number" }, res.phone));
      phoneBox.appendChild(el("div", { class: "fan-phone-country" },
        res.country ? `${res.country.flag} ${res.country.name}` : "País no identificado"));
    }).catch(() => { phoneBox.textContent = "No se pudo leer el número."; });

    // --- Listas (etiqueta rapida) ---
    const listSelect = el("select", {}, FAN_LISTS.map((o) => el("option", { value: o.value }, o.label)));
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Lista"), listSelect]));
    listSelect.addEventListener("change", async () => {
      try {
        await api(`/accounts/${accountId}/dialogs/${chatId}/note`, {
          method: "PUT",
          body: JSON.stringify({ note: noteArea.value, list: listSelect.value || null, chatTitle }),
        });
        toast("Lista actualizada");
        // Mantiene el filtro "Todas las listas" / "Prioridad" de Mensajes al
        // dia sin esperar a la siguiente carga de la lista de conversaciones.
        if (mensajesState.accountId === accountId) {
          if (listSelect.value) mensajesState.fanLists[chatId] = listSelect.value;
          else delete mensajesState.fanLists[chatId];
          applyDialogFilters();
        }
      } catch (err) {
        toast(err.message, true);
      }
    });

    // --- Ventas realizadas ---
    const totalEl = el("div", { class: "fan-sales-total" }, "Vendido a este fan: $0.00");
    const salesListEl = el("div", { class: "fan-sales-list" });
    body.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Ventas realizadas"),
      totalEl,
      salesListEl,
    ]));

    async function loadSales() {
      salesListEl.innerHTML = "";
      salesListEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const { sales, total } = await api(`/accounts/${accountId}/dialogs/${chatId}/sales`);
        totalEl.textContent = `Vendido a este fan: ${fmtMoney(total)}`;
        salesListEl.innerHTML = "";
        if (sales.length === 0) {
          salesListEl.appendChild(el("div", { class: "empty" }, "Sin ventas registradas todavía."));
        }
        for (const s of sales) {
          const delBtn = el("button", { class: "sale-del", title: "Eliminar venta" }, "✕");
          delBtn.addEventListener("click", async () => {
            const ok = await confirmModal({ title: "Eliminar venta", body: `¿Eliminar la venta de ${fmtMoney(s.amount)}?`, confirmLabel: "Eliminar", danger: true });
            if (!ok) return;
            try {
              await api(`/accounts/${accountId}/sales/${s.id}`, { method: "DELETE" });
              toast("Venta eliminada");
              await loadSales();
              loadRecentBuyers(accountId);
            } catch (err) {
              toast(err.message, true);
            }
          });
          salesListEl.appendChild(el("div", { class: "sale-row" }, [
            el("div", { class: "sale-row-main" }, [
              el("div", { class: "sale-amount" }, fmtMoney(s.amount)),
              el("div", { class: "sale-meta" }, [
                fmtDate(s.date),
                s.paymentMethod ? " · " + s.paymentMethod : "",
                s.service ? " · " + s.service : "",
              ].join("")),
              s.soldBy ? el("div", { class: "sale-meta" }, "Vendido por: " + s.soldBy) : null,
            ]),
            delBtn,
          ]));
        }
      } catch (err) {
        salesListEl.innerHTML = "";
        salesListEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    // --- Formulario "registrar venta" (servicio y método de pago vienen de
    // Configuración → General → "Toda la agencia", para que el equipo elija
    // siempre de la misma lista) ---
    const serviceSelect = el("select", {}, [el("option", { value: "" }, "Servicio...")]);
    const methodSelect = el("select", {}, [el("option", { value: "" }, "Método de pago...")]);
    api("/settings/general").then((s) => {
      for (const opt of s.services || []) serviceSelect.appendChild(el("option", { value: opt }, opt));
      for (const opt of s.paymentMethods || []) methodSelect.appendChild(el("option", { value: opt }, opt));
    }).catch(() => {
      // si falla, el equipo puede seguir apuntando la venta sin servicio/metodo elegidos
    });
    const detailInput = el("input", { placeholder: "Detalle (opcional, obligatorio si el servicio es OTROS)" });
    // Precargado con quien tiene la sesión abierta ahora mismo (trabajador,
    // o la cuenta luxe si es el dueño) - antes se quedaba en blanco por
    // defecto y, si no se rellenaba a mano, la venta se guardaba sin
    // chatter asignado ("(sin asignar)" en Informes/Nóminas). Bloqueado para
    // cualquier chatter (ver createSoldBySelector): solo el dueño puede
    // reasignar la venta a otro nombre del equipo.
    const soldByInput = createSoldBySelector();
    const refInput = el("input", { placeholder: "Referencia de pago (opcional)" });
    const amountInput = el("input", { type: "number", step: "0.01", placeholder: "Importe" });
    const dateInput = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
    const addSaleBtn = el("button", { class: "primary" }, "+");

    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Servicio"), serviceSelect]));
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Método de pago"), methodSelect]));
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Detalle (opcional)"), detailInput]));
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Vendido por"), soldByInput]));
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Adjuntar pago (opcional)"), refInput]));
    body.appendChild(el("div", { class: "field sale-add-row" }, [
      el("div", { style: "flex:1" }, [el("label", {}, "Importe"), amountInput]),
      el("div", {}, [el("label", {}, "Fecha"), dateInput]),
      addSaleBtn,
    ]));

    addSaleBtn.addEventListener("click", async () => {
      const amount = Number(amountInput.value);
      if (!amount || amount <= 0) {
        toast("Pon un importe válido", true);
        return;
      }
      addSaleBtn.disabled = true;
      try {
        await api(`/accounts/${accountId}/dialogs/${chatId}/sales`, {
          method: "POST",
          body: JSON.stringify({
            amount,
            date: dateInput.value ? new Date(dateInput.value).toISOString() : undefined,
            service: serviceSelect.value || undefined,
            paymentMethod: methodSelect.value || undefined,
            detail: detailInput.value || undefined,
            soldBy: soldByInput.value || undefined,
            paymentRef: refInput.value || undefined,
            chatTitle,
          }),
        });
        serviceSelect.value = ""; detailInput.value = ""; refInput.value = ""; amountInput.value = "";
        methodSelect.value = "";
        toast("Venta registrada");
        await loadSales();
        loadRecentBuyers(accountId);
      } catch (err) {
        toast(err.message, true);
      } finally {
        addSaleBtn.disabled = false;
      }
    });

    // --- Notas libres, con autoguardado ---
    const noteArea = el("textarea", { rows: "8", placeholder: "Notas sobre este fan..." });
    const savedLabel = el("div", { class: "save-indicator" }, "");
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Notas"), noteArea, savedLabel]));

    let saveTimer = null;
    async function saveNote() {
      try {
        await api(`/accounts/${accountId}/dialogs/${chatId}/note`, {
          method: "PUT",
          body: JSON.stringify({ note: noteArea.value, list: listSelect.value || null, chatTitle }),
        });
        savedLabel.textContent = "Guardado";
      } catch (err) {
        savedLabel.textContent = "Error al guardar";
      }
    }
    noteArea.addEventListener("input", () => {
      savedLabel.textContent = "Guardando...";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNote, 900);
    });
    noteArea.addEventListener("blur", () => { clearTimeout(saveTimer); saveNote(); });

    api(`/accounts/${accountId}/dialogs/${chatId}/note`).then((res) => {
      noteArea.value = res.note || "";
      listSelect.value = res.list || "";
      savedLabel.textContent = "Guardado";
    }).catch(() => {});
    loadSales();
  }

  function renderModelTab() {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "hint" }, "Info general de esta cuenta/modelo (precios, forma de pago, etc.), visible en todas sus conversaciones."));
    const noteArea = el("textarea", { rows: "14", placeholder: "Info general de la modelo..." });
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Notas de la modelo"), noteArea]));
    const saveBtn = el("button", { class: "primary" }, "Guardar");
    body.appendChild(saveBtn);
    api(`/accounts/${accountId}/note`).then((res) => { noteArea.value = res.note || ""; }).catch(() => {});
    saveBtn.addEventListener("click", async () => {
      try {
        await api(`/accounts/${accountId}/note`, { method: "PUT", body: JSON.stringify({ note: noteArea.value }) });
        toast("Notas de la modelo guardadas");
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // "Precios modelo": igual que "Notas de la modelo" (una nota por cuenta,
  // visible en todas sus conversaciones) pero en su propio campo
  // (Account.pricesInfo, ya existente en Configuración -> Modelos -> esta
  // creadora) para no mezclar precios con el resto de notas generales.
  function renderPricesTab() {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "hint" }, "Precios/tarifas de esta modelo, visibles en todas sus conversaciones - lo mismo que Configuración → Modelos → esta creadora → Precios."));
    const priceArea = el("textarea", { rows: "14", placeholder: "Precios de esta modelo..." });
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Precios modelo"), priceArea]));
    const saveBtn = el("button", { class: "primary" }, "Guardar");
    body.appendChild(saveBtn);
    api(`/accounts/${accountId}/prices`).then((res) => { priceArea.value = res.prices || ""; }).catch(() => {});
    saveBtn.addEventListener("click", async () => {
      try {
        await api(`/accounts/${accountId}/prices`, { method: "PUT", body: JSON.stringify({ prices: priceArea.value }) });
        toast("Precios de la modelo guardados");
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  function setActiveTab(btn) {
    for (const b of [fanTabBtn, modelTabBtn, pricesTabBtn]) b.classList.toggle("active", b === btn);
  }
  fanTabBtn.addEventListener("click", () => {
    tab = "fan";
    setActiveTab(fanTabBtn);
    renderFanTab();
  });
  modelTabBtn.addEventListener("click", () => {
    tab = "model";
    setActiveTab(modelTabBtn);
    renderModelTab();
  });
  pricesTabBtn.addEventListener("click", () => {
    tab = "prices";
    setActiveTab(pricesTabBtn);
    renderPricesTab();
  });

  renderFanTab();
}

// ---------- Configuración (subapartados estilo TeleCrew) ----------

const CONFIG_SECTIONS = [
  { key: "modelos", label: "Modelos" },
  { key: "empleados", label: "Equipo" },
  { key: "seguridad", label: "Seguridad" },
  { key: "cuentas-telegram", label: "Cuentas de Telegram" },
  { key: "suscripcion", label: "Suscripción" },
  { key: "general", label: "General" },
];

function openConfiguracion() {
  renderConfigSubnav();
  renderConfigSection(state.configSection);
}

function renderConfigSubnav() {
  accountListEl.innerHTML = "";
  accountListEl.appendChild(el("div", { class: "account-list-title" }, "Configuración"));
  for (const s of CONFIG_SECTIONS) {
    accountListEl.appendChild(el("div", {
      class: "config-nav-item" + (s.key === state.configSection ? " active" : ""),
      onclick: () => {
        state.configSection = s.key;
        renderConfigSubnav();
        renderConfigSection(s.key);
      },
    }, s.label));
  }
}

function openEmojiPacksModal(accountId, label) {
  openModal(async (modal, close) => {
    modal.appendChild(el("h3", {}, "Emoji premium de " + label));
    modal.appendChild(el("div", { class: "hint" },
      "Pega el link de un pack de Telegram (ej. t.me/addemoji/paintown). Hasta 5 por cuenta. Solo se ven animados de verdad si esta cuenta tiene Telegram Premium."));

    const listEl = el("div", { class: "scripts-manage-list" });
    modal.appendChild(listEl);

    const input = el("input", { placeholder: "t.me/addemoji/nombre o solo el nombre" });
    const addBtn = el("button", { class: "primary" }, "+ Añadir");
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Nuevo pack"), input]));
    modal.appendChild(addBtn);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cerrar")]));

    async function refresh() {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const { packs } = await api(`/accounts/${accountId}/emoji-packs`);
        listEl.innerHTML = "";
        if (packs.length === 0) {
          listEl.appendChild(el("div", { class: "empty" }, "Sin packs todavía."));
        }
        for (const p of packs) {
          const delBtn = el("button", { class: "danger" }, "Eliminar");
          delBtn.addEventListener("click", async () => {
            const ok = await confirmModal({ title: "Eliminar pack", body: `¿Quitar "${p.title || p.shortName}"?`, confirmLabel: "Eliminar", danger: true });
            if (!ok) return;
            try {
              await api(`/emoji-packs/${p.id}`, { method: "DELETE" });
              toast("Pack eliminado");
              await refresh();
            } catch (err) {
              toast(err.message, true);
            }
          });
          listEl.appendChild(el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto" }, [
            el("div", {}, [el("div", { style: "font-weight:600" }, p.title || p.shortName), el("div", { class: "hint" }, "t.me/addemoji/" + p.shortName)]),
            delBtn,
          ]));
        }
      } catch (err) {
        listEl.innerHTML = "";
        listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    addBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) { toast("Pega un link o nombre de pack", true); return; }
      addBtn.disabled = true;
      try {
        await api(`/accounts/${accountId}/emoji-packs`, { method: "POST", body: JSON.stringify({ input: value }) });
        input.value = "";
        toast("Pack añadido");
        await refresh();
      } catch (err) {
        toast(err.message, true);
      } finally {
        addBtn.disabled = false;
      }
    });

    refresh();
  }, { wide: true });
}

function fmtCentsEUR(cents) {
  const n = (cents || 0) / 100;
  return (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",")) + " €";
}

function daysLeftUntil(dateStr) {
  if (!dateStr) return null;
  const ms = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/** Pantalla "Suscripción" de Configuración: mismo diseño y lógica que
 * TeleCrew (cuota por modelo con descuento a partir de 5, prueba gratis,
 * "Activar plan"/"Actualizar" con Stripe) - ver api/subscription.ts. */
async function renderSuscripcionSection() {
  appEl.innerHTML = "";
  appEl.appendChild(el("h1", {}, "Suscripción"));
  appEl.appendChild(el("p", { class: "subtitle" }, `Plan y facturación de ${state.isLegacyAgency ? "LUREQO" : (state.agencyBrandName || "tu agencia")}.`));

  // Si venimos de vuelta del Checkout/portal de Stripe, avisamos una vez y
  // limpiamos el parámetro de la URL para que no se repita al recargar.
  const params = new URLSearchParams(window.location.search);
  const suscripcionParam = params.get("suscripcion");
  if (suscripcionParam) {
    if (suscripcionParam === "ok") toast("¡Listo! Tu plan se está activando (puede tardar unos segundos en reflejarse).");
    else if (suscripcionParam === "cancelado") toast("No se completó el pago.", true);
    history.replaceState(null, "", window.location.pathname);
  }

  const container = el("div", {}, el("div", { class: "empty" }, "Cargando..."));
  appEl.appendChild(container);
  try {
    const res = await api("/subscription");
    container.innerHTML = "";
    if (res.isLegacyAgency) {
      container.appendChild(el("div", { class: "card empty" }, "LUREQO es tu propia agencia: no paga suscripción. Esta pantalla es la que ven las agencias que usan el CRM como servicio de pago."));
      return;
    }
    renderSubscriptionCards(container, res);
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
}

function renderSubscriptionCards(container, res) {
  // 1) Cómo se calcula la cuota.
  container.appendChild(
    el("div", { class: "card", style: "margin-bottom:16px" }, [
      el("div", { style: "font-weight:600;margin-bottom:8px" }, "Cómo se calcula la cuota"),
      el("ul", { style: "margin:0 0 10px 18px;padding:0;color:var(--cream-dim)" }, [
        el("li", {}, `Cada modelo (cuenta de Telegram conectada) cuesta ${fmtCentsEUR(res.priceUnder5Cents)} al mes.`),
        el("li", {}, `A partir de ${res.discountUnlockedAt} modelos, TODAS pasan a ${fmtCentsEUR(res.priceFrom5Cents)} al mes.`),
      ]),
      el("div", { style: "font-size:13px;color:var(--cream-faint)" },
        "Se paga una sola vez al mes, siempre el día 1. Al activar el plan se cobra solo la parte proporcional hasta el día 1 siguiente. Si añades una modelo a mitad de mes, solo se cobran los días que quedan, y ese importe se suma a la factura del día 1, sin cobros aparte. Si quitas una modelo, los días que sobran se descuentan igual."
      ),
    ])
  );

  // 2) Tus modelos + total.
  const modelsCard = el("div", { class: "card", style: "margin-bottom:16px" });
  modelsCard.appendChild(
    el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px" }, [
      el("div", { style: "font-weight:600" }, "Tus modelos"),
      el("div", { style: "color:var(--cream-faint);font-size:13px" }, `${res.modelsCount} modelo${res.modelsCount === 1 ? "" : "s"}`),
    ])
  );
  if (res.models.length === 0) {
    modelsCard.appendChild(el("div", { class: "empty" }, "Todavía no has conectado ninguna modelo (Configuración → Cuentas de Telegram)."));
  } else {
    for (const m of res.models) {
      modelsCard.appendChild(
        el("div", { style: "display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)" }, [
          el("div", {}, [
            el("span", { style: "font-weight:600" }, m.label),
            el("span", { style: "color:var(--cream-faint);font-size:13px" }, ` · ${m.connected ? "Conectada" : "Desactivada"}`),
          ]),
          el("div", {}, fmtCentsEUR(res.unitPriceCents)),
        ])
      );
    }
    modelsCard.appendChild(
      el("div", { style: "display:flex;justify-content:space-between;padding:10px 0 0;color:var(--cream-dim)" }, [
        el("div", {}, `${res.modelsCount} modelo${res.modelsCount === 1 ? "" : "s"} × ${fmtCentsEUR(res.unitPriceCents)}`),
        el("div", {}, fmtCentsEUR(res.totalCents)),
      ])
    );
    modelsCard.appendChild(
      el("div", { style: "display:flex;justify-content:space-between;font-weight:700;font-size:17px;padding-top:6px" }, [
        el("div", {}, "Total al mes"),
        el("div", {}, fmtCentsEUR(res.totalCents)),
      ])
    );
    if (res.modelsCount < res.discountUnlockedAt) {
      modelsCard.appendChild(
        el("div", { style: "font-size:13px;color:var(--cream-faint);margin-top:6px" },
          `Con ${res.discountUnlockedAt - res.modelsCount} modelo${res.discountUnlockedAt - res.modelsCount === 1 ? "" : "s"} más (${res.discountUnlockedAt} en total) todas pasan a ${fmtCentsEUR(res.priceFrom5Cents)} al mes.`)
      );
    }
  }
  container.appendChild(modelsCard);

  // 3) Estado del plan + acciones.
  const statusCard = el("div", { class: "card" });
  statusCard.appendChild(el("div", { style: "color:var(--cream-faint);font-size:13px" }, "Estado del plan"));
  statusCard.appendChild(el("div", { style: "font-weight:700;font-size:18px;margin-bottom:10px" }, state.agencyBrandName || "Tu agencia"));

  const status = res.subscriptionStatus;
  if (status === "active" || status === "trialing" && res.stripeConfigured) {
    // (caso real "trialing" de Stripe, no la prueba gratis local de abajo)
  }
  if (!status) {
    const daysLeft = daysLeftUntil(res.trialEndsAt);
    if (daysLeft !== null && daysLeft >= 0) {
      statusCard.appendChild(el("div", { style: "color:var(--cream-dim)" }, "La prueba termina"));
      statusCard.appendChild(el("div", { style: "font-weight:600;margin-bottom:12px" }, `${fmtDate(res.trialEndsAt)} · quedan ${daysLeft} día${daysLeft === 1 ? "" : "s"}`));
    } else {
      statusCard.appendChild(el("div", { style: "color:#c23b32;font-weight:600;margin-bottom:12px" }, "Tu prueba gratuita ha terminado."));
    }
  } else if (status === "active") {
    statusCard.appendChild(el("div", { style: "color:var(--green-ok, #2e7d32);font-weight:600" }, "✓ Plan activo"));
    if (res.currentPeriodEnd) {
      statusCard.appendChild(el("div", { style: "color:var(--cream-faint);font-size:13px;margin-bottom:12px" }, `Próximo cobro: ${fmtDate(res.currentPeriodEnd)}`));
    }
  } else if (status === "past_due") {
    statusCard.appendChild(el("div", { style: "color:#c23b32;font-weight:600;margin-bottom:12px" }, "⚠ No se pudo cobrar el último pago. Actualiza tu método de pago."));
  } else {
    statusCard.appendChild(el("div", { style: "color:#c23b32;font-weight:600;margin-bottom:12px" }, "Suscripción no activa."));
  }

  if (res.blockedReason) {
    statusCard.appendChild(el("div", { class: "hint", style: "color:#c23b32;margin-bottom:12px" }, res.blockedReason));
  }

  if (!res.stripeConfigured) {
    statusCard.appendChild(el("div", { class: "hint" }, "El cobro todavía no está activado en este servidor - habla con soporte."));
  } else {
    const btnRow = el("div", { style: "display:flex;gap:10px" });
    if (status !== "active") {
      const activateBtn = el("button", { class: "primary" }, "Activar plan ahora");
      activateBtn.addEventListener("click", async () => {
        activateBtn.disabled = true;
        try {
          const returnUrl = window.location.origin + window.location.pathname;
          const { url } = await api("/subscription/activate", { method: "POST", body: JSON.stringify({ returnUrl }) });
          window.location.href = url;
        } catch (err) {
          toast(err.message, true);
          activateBtn.disabled = false;
        }
      });
      btnRow.appendChild(activateBtn);
    }
    if (status) {
      const portalBtn = el("button", { class: "sm" }, "Actualizar");
      portalBtn.addEventListener("click", async () => {
        portalBtn.disabled = true;
        try {
          const returnUrl = window.location.origin + window.location.pathname;
          const { url } = await api("/subscription/portal", { method: "POST", body: JSON.stringify({ returnUrl }) });
          window.location.href = url;
        } catch (err) {
          toast(err.message, true);
          portalBtn.disabled = false;
        }
      });
      btnRow.appendChild(portalBtn);
    }
    statusCard.appendChild(btnRow);
  }
  container.appendChild(statusCard);

  container.appendChild(
    el("p", { class: "hint", style: "margin-top:10px" }, "Si vence el plan, la app se pausa y hay 3 días para renovarlo antes del bloqueo total.")
  );
}

function comingSoonCard(text) {
  return el("div", { class: "card empty" }, text);
}

async function renderConfigSection(key) {
  appEl.innerHTML = "";
  if (key === "modelos") {
    await renderModelosSection();
  } else if (key === "empleados") {
    await renderEquipoSection();
  } else if (key === "seguridad") {
    await renderSeguridadSection();
  } else if (key === "cuentas-telegram") {
    await renderTelegramAccountsSection();
  } else if (key === "suscripcion") {
    await renderSuscripcionSection();
  } else if (key === "general") {
    await renderGeneralConfigSection();
  }
}

// ---------- Informes (Dashboard/Ingresos/Grupos de promoción/Rendimiento/
// Horas trabajadas/Capturas, como en TeleCrew). De momento solo "Horas
// trabajadas" está construida de verdad; el resto son "próximamente" hasta
// que se decida qué datos concretos debe mostrar cada una. ----------

const INFORMES_SECTIONS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "ingresos", label: "Ingresos" },
  { key: "grupos-promocion", label: "Grupos de promoción" },
  { key: "rendimiento", label: "Rendimiento" },
  { key: "horas-trabajadas", label: "Horas trabajadas" },
  { key: "capturas", label: "Capturas" },
  // Antes vivía en Configuración → Nóminas; se traslada aquí (Informes) y se
  // renombra a petición de Aitor.
  { key: "nominas", label: "Nóminas Chatter's" },
  // Justo debajo de Nóminas Chatter's: hoja de pago de una MODELO (salario
  // fijo + bonificaciones por servicios personalizados), plantilla propia.
  { key: "nominas-modelos", label: "Nóminas Modelos" },
];

function openInformes() {
  renderInformesSubnav();
  renderInformesSection(state.informesSection);
}

function renderInformesSubnav() {
  accountListEl.innerHTML = "";
  accountListEl.appendChild(el("div", { class: "account-list-title" }, "Informes"));
  for (const s of INFORMES_SECTIONS) {
    accountListEl.appendChild(el("div", {
      class: "config-nav-item" + (s.key === state.informesSection ? " active" : ""),
      onclick: () => {
        state.informesSection = s.key;
        renderInformesSubnav();
        renderInformesSection(s.key);
      },
    }, s.label));
  }
}

async function renderInformesSection(key) {
  appEl.innerHTML = "";
  if (key === "dashboard") {
    await renderInformesDashboardSection();
  } else if (key === "ingresos") {
    await renderInformesIngresosSection();
  } else if (key === "grupos-promocion") {
    await renderGruposPromocionSection();
  } else if (key === "rendimiento") {
    await renderInformesRendimientoSection();
  } else if (key === "horas-trabajadas") {
    await renderHorasTrabajadasSection();
  } else if (key === "nominas") {
    await renderNominasSection();
  } else if (key === "nominas-modelos") {
    await renderModelPayrollSection();
  } else if (key === "capturas") {
    // Ya no es un "próximamente": es el mismo histórico de Configuración →
    // Seguridad (avisos de intento de captura + avisos de "sin fichar"), solo
    // que sin el aviso en vivo por SSE (eso se queda en Seguridad, pensado
    // para tenerlo abierto todo el día) - aquí es de solo consulta.
    await renderInformesCapturasSection();
  } else {
    const labels = { dashboard: "Dashboard", ingresos: "Ingresos", "grupos-promocion": "Grupos de promoción", rendimiento: "Rendimiento" };
    appEl.appendChild(el("h1", {}, labels[key] || key));
    appEl.appendChild(comingSoonCard("Próximamente: dime qué datos exactos quieres ver aquí y lo construimos."));
  }
}

/** Informes → Capturas: mismo histórico que Configuración → Seguridad
 * (avisos de intento de captura de pantalla + avisos de "sin fichar"), de
 * solo consulta - sin el EventSource en vivo, que se queda solo en
 * Seguridad. Reutiliza captureAttemptRow/fmtCaptureAttemptWhen tal cual. */
async function renderInformesCapturasSection() {
  appEl.appendChild(el("h1", {}, "Capturas"));
  appEl.appendChild(el("p", { class: "subtitle" },
    "Lo que había en pantalla cada vez que alguien intentó hacer una captura, y los avisos de trabajadores activos en el CRM sin haber fichado. Las capturas solo se detectan desde la app de escritorio de tu equipo (Equipo → Permisos, \"Puede entrar también desde el navegador\") - un sitio web no puede impedir ni saber que alguien ha hecho una captura de su propia pantalla."));

  const listEl = el("div", { class: "pd-history-list" }, el("div", { class: "empty" }, "Cargando..."));
  appEl.appendChild(el("div", { class: "section-title-row" }, [el("h2", {}, "Historial reciente")]));
  appEl.appendChild(listEl);

  try {
    const [{ attempts }, { alerts }] = await Promise.all([
      api("/security/capture-attempts"),
      api("/security/no-clock-in-alerts"),
    ]);
    const all = [...attempts, ...alerts].sort((a, b) => new Date(b.at) - new Date(a.at));
    listEl.innerHTML = "";
    if (all.length === 0) {
      listEl.appendChild(el("div", { class: "empty" }, "Ningún aviso registrado todavía."));
    } else {
      for (const a of all) listEl.appendChild(captureAttemptRow(a));
    }
  } catch (err) {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
}

/** Informes → Ingresos: ventas registradas (FanSale) en un rango de
 * fechas, con KPIs, comparación vs. el periodo anterior, gráfico de
 * ingresos por día, ranking de modelos, desglose por servicio/método de
 * pago y top fans. Todo viene de GET /api/informes/ingresos. */
function informesDateRangeISO(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function money(n) {
  return (n ?? 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

/** Formatea segundos como "19h 43m" / "3m 0s" / "33s", igual que la columna
 * "Tiempo de respuesta" del panel de referencia. */
function fmtResponseTime(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

/** Va directo a un chat concreto desde una fila del Dashboard: cambia a
 * Mensajes, selecciona la cuenta/creadora correcta y abre la conversación,
 * exactamente el enlace "Ir al chat →" del panel de referencia. */
async function goToChatFromDashboard(accountId, chatId, chatTitle) {
  state.currentView = "mensajes";
  renderSidenav();
  document.body.classList.remove("detector-pagos-mode");
  await selectAccount(accountId);
  openChat(accountId, { chatId, title: chatTitle || chatId });
}

/** Informes → Dashboard: TODOS los mensajes enviados por el equipo y todas
 * las ventas, de todas las cuentas juntas, más reciente primero — como el
 * Dashboard de TeleCrew. "Chatter" = trabajador (o la cuenta luxe si envía
 * el dueño); "Creadora" = la cuenta/modelo de Telegram. */
const DASHBOARD_RANGE_PRESETS = [
  { key: "7d", label: "Últimos 7 días", days: 7 },
  { key: "hoy", label: "Hoy", days: 1 },
  { key: "ayer", label: "Ayer", days: 1, yesterday: true },
  { key: "30d", label: "Últimos 30 días", days: 30 },
  { key: "todo", label: "Todo", days: null },
];

async function renderInformesDashboardSection(tab) {
  const current = tab || state.dashboardTab || "actividad";
  state.dashboardTab = current;
  appEl.innerHTML = "";
  appEl.appendChild(el("h1", {}, "Dashboard"));
  const tabs = el("div", { class: "dashboard-tabs" }, [
    ["actividad", "Actividad"],
    ["borrados", "Mensajes borrados"],
  ].map(([key, label]) => el("button", {
    type: "button",
    class: "dashboard-tab" + (key === current ? " active" : ""),
    onclick: () => renderInformesDashboardSection(key),
  }, label)));
  appEl.appendChild(tabs);
  if (current === "borrados") {
    await renderDeletedMessagesTab();
  } else {
    await renderInformesDashboardActivity();
  }
}

async function renderDeletedMessagesTab() {
  appEl.appendChild(el("p", { class: "subtitle" }, "Mensajes que los chatters (o el dueño) han borrado desde el CRM, tal y como se enviaron."));
  const dState = { range: "7d", q: "", chatter: "", accountId: "" };
  const searchInput = el("input", { placeholder: "Buscar por palabra...", class: "content-search-input", style: "min-width:220px" });
  const rangeSelect = el("select", {}, DASHBOARD_RANGE_PRESETS.map((p) => el("option", { value: p.key }, p.label)));
  const chatterSelect = el("select", {}, el("option", { value: "" }, "Todos los chatters"));
  const accountSelect = el("select", {}, el("option", { value: "" }, "Todas las creadoras"));
  appEl.appendChild(el("div", { class: "dashboard-filter-bar" }, [searchInput, rangeSelect, chatterSelect, accountSelect]));
  const tableWrap = el("div", { class: "work-hours-table-wrap" }, el("div", { class: "empty" }, "Cargando..."));
  appEl.appendChild(tableWrap);

  function rangeToDates(key) {
    const preset = DASHBOARD_RANGE_PRESETS.find((p) => p.key === key);
    if (!preset || preset.days === null) return {};
    const to = new Date();
    const from = new Date();
    if (preset.yesterday) {
      from.setDate(from.getDate() - 1);
      to.setDate(to.getDate() - 1);
    } else {
      from.setDate(from.getDate() - (preset.days - 1));
    }
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }

  const fmtDT = (v) => {
    if (!v) return [el("div", {}, "—")];
    const d = new Date(v);
    return [
      el("div", {}, d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })),
      el("div", { class: "hint" }, d.toLocaleDateString("es-ES")),
    ];
  };

  let optionsLoaded = false;
  let loadSeq = 0;
  async function load() {
    const mySeq = ++loadSeq;
    tableWrap.innerHTML = "";
    tableWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const { from, to } = rangeToDates(dState.range);
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (dState.q) qs.set("q", dState.q);
      if (dState.chatter) qs.set("chatter", dState.chatter);
      if (dState.accountId) qs.set("accountId", dState.accountId);
      const data = await api(`/informes/deleted-messages?${qs.toString()}`);
      if (mySeq !== loadSeq) return;
      if (!optionsLoaded) {
        for (const c of data.chatters) chatterSelect.appendChild(el("option", { value: c }, c));
        for (const a of data.accounts) accountSelect.appendChild(el("option", { value: a.id }, a.label));
        optionsLoaded = true;
      }
      tableWrap.innerHTML = "";
      if (data.rows.length === 0) {
        tableWrap.appendChild(el("div", { class: "empty" }, "Nadie ha borrado mensajes en este rango. Solo se registran los borrados hechos desde el CRM a partir de ahora."));
        return;
      }
      const table = el("table", { class: "work-hours-table dashboard-feed-table" });
      table.appendChild(el("thead", {}, el("tr", {}, [
        el("th", {}, "Borrado por"),
        el("th", {}, "Enviado por"),
        el("th", {}, "Creadora"),
        el("th", {}, "Fan"),
        el("th", {}, "Mensaje borrado"),
        el("th", {}, "Enviado"),
        el("th", {}, "Borrado"),
      ])));
      const tbody = el("tbody", {});
      for (const r of data.rows) {
        tbody.appendChild(el("tr", {}, [
          el("td", { style: "font-weight:600" }, r.borradoPor),
          el("td", {}, r.enviadoPor || "—"),
          el("td", {}, r.creadora),
          el("td", {}, r.fan),
          el("td", { class: "dashboard-deleted-msg", title: r.mensaje }, r.mensaje),
          el("td", {}, fmtDT(r.enviadoEn)),
          el("td", {}, fmtDT(r.borradoEn)),
        ]));
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      if (data.hasMore) {
        tableWrap.appendChild(el("div", { class: "hint", style: "margin-top:8px" }, "Hay más borrados de los que se muestran — afina la búsqueda o el rango de fechas."));
      }
    } catch (err) {
      if (mySeq !== loadSeq) return;
      tableWrap.innerHTML = "";
      tableWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { dState.q = searchInput.value.trim(); load(); }, 350);
  });
  rangeSelect.value = dState.range;
  rangeSelect.addEventListener("change", () => { dState.range = rangeSelect.value; load(); });
  chatterSelect.addEventListener("change", () => { dState.chatter = chatterSelect.value; load(); });
  accountSelect.addEventListener("change", () => { dState.accountId = accountSelect.value; load(); });
  await load();
}

async function renderInformesDashboardActivity() {
  appEl.appendChild(el("p", { class: "subtitle" }, "Todos los mensajes y ventas del equipo, de todas las cuentas, más recientes primero."));

  const dState = { range: "7d", q: "", chatter: "", accountId: "" };

  const searchInput = el("input", { placeholder: "Buscar por palabra...", class: "content-search-input", style: "min-width:220px" });
  const rangeSelect = el("select", {}, DASHBOARD_RANGE_PRESETS.map((p) => el("option", { value: p.key }, p.label)));
  const chatterSelect = el("select", {}, el("option", { value: "" }, "Todos los chatters"));
  const accountSelect = el("select", {}, el("option", { value: "" }, "Todas las creadoras"));

  const filterBar = el("div", { class: "dashboard-filter-bar" }, [searchInput, rangeSelect, chatterSelect, accountSelect]);
  appEl.appendChild(filterBar);

  const tableWrap = el("div", { class: "work-hours-table-wrap" }, el("div", { class: "empty" }, "Cargando..."));
  appEl.appendChild(tableWrap);

  function rangeToDates(key) {
    const preset = DASHBOARD_RANGE_PRESETS.find((p) => p.key === key);
    if (!preset || preset.days === null) return {};
    const to = new Date();
    const from = new Date();
    if (preset.yesterday) {
      from.setDate(from.getDate() - 1);
      to.setDate(to.getDate() - 1);
    } else {
      from.setDate(from.getDate() - (preset.days - 1));
    }
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }

  let optionsLoaded = false;
  let loadSeq = 0;

  async function load() {
    const mySeq = ++loadSeq;
    tableWrap.innerHTML = "";
    tableWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const { from, to } = rangeToDates(dState.range);
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (dState.q) qs.set("q", dState.q);
      if (dState.chatter) qs.set("chatter", dState.chatter);
      if (dState.accountId) qs.set("accountId", dState.accountId);
      const data = await api(`/informes/dashboard?${qs.toString()}`);
      if (mySeq !== loadSeq) return;

      if (!optionsLoaded) {
        for (const c of data.chatters) chatterSelect.appendChild(el("option", { value: c }, c));
        for (const a of data.accounts) accountSelect.appendChild(el("option", { value: a.id }, a.label));
        optionsLoaded = true;
      }

      tableWrap.innerHTML = "";
      if (data.rows.length === 0) {
        tableWrap.appendChild(el("div", { class: "empty" }, "Sin actividad en este rango. Los mensajes solo aparecen aquí desde que se activó esto — no hay forma de recuperar el historial de antes."));
        return;
      }

      const table = el("table", { class: "work-hours-table dashboard-feed-table" });
      table.appendChild(el("thead", {}, el("tr", {}, [
        el("th", {}, "Chatter"),
        el("th", {}, "Creadora"),
        el("th", {}, "Fan"),
        el("th", {}, "Acción"),
        el("th", {}, "Mensaje"),
        el("th", {}, "Enviado"),
        el("th", {}, "Tiempo de respuesta"),
        el("th", {}, ""),
      ])));
      const tbody = el("tbody", {});
      for (const r of data.rows) {
        const d = new Date(r.fecha);
        tbody.appendChild(el("tr", {}, [
          el("td", { style: "font-weight:600" }, r.chatter),
          el("td", {}, r.creadora),
          el("td", {}, r.fan),
          el("td", {}, el("span", { class: "pill " + (r.accion === "Venta" ? "info" : "ok") }, r.accion)),
          el("td", { class: "dashboard-feed-msg", title: r.mensaje }, r.mensaje),
          el("td", {}, [
            el("div", {}, d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })),
            el("div", { class: "hint" }, d.toLocaleDateString("es-ES")),
          ]),
          el("td", {}, fmtResponseTime(r.responseSeconds)),
          el("td", {}, el("a", { class: "link", onclick: () => goToChatFromDashboard(r.accountId, r.chatId, r.fan) }, "Ir al chat →")),
        ]));
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
      if (data.hasMore) {
        tableWrap.appendChild(el("div", { class: "hint", style: "margin-top:8px" }, "Hay más actividad de la que se muestra aquí — afina la búsqueda o el rango de fechas."));
      }
    } catch (err) {
      if (mySeq !== loadSeq) return;
      tableWrap.innerHTML = "";
      tableWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { dState.q = searchInput.value.trim(); load(); }, 350);
  });
  rangeSelect.value = dState.range;
  rangeSelect.addEventListener("change", () => { dState.range = rangeSelect.value; load(); });
  chatterSelect.addEventListener("change", () => { dState.chatter = chatterSelect.value; load(); });
  accountSelect.addEventListener("change", () => { dState.accountId = accountSelect.value; load(); });

  await load();
}

async function renderInformesIngresosSection() {
  appEl.appendChild(el("h1", {}, "Ingresos"));
  appEl.appendChild(el("p", { class: "subtitle" }, "Ventas registradas desde la ficha de cada fan, por rango de fechas."));

  const today = new Date().toISOString().slice(0, 10);
  const fromInput = el("input", { type: "date", value: today });
  const toInput = el("input", { type: "date", value: today });
  const modelSelect = el("select", {}, el("option", { value: "" }, "Todas las modelos"));
  const chatterSelect = el("select", {}, el("option", { value: "" }, "Todos los trabajadores"));
  const updateBtn = el("button", { class: "primary" }, "Actualizar");

  function setPreset(days) {
    const { from, to } = informesDateRangeISO(days);
    fromInput.value = from;
    toInput.value = to;
    load();
  }
  function setThisMonth() {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    fromInput.value = from.toISOString().slice(0, 10);
    toInput.value = today;
    load();
  }
  function setYesterday() {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const s = y.toISOString().slice(0, 10);
    fromInput.value = s;
    toInput.value = s;
    load();
  }

  const presetsBar = el("div", { class: "informes-presets" }, [
    el("button", { class: "sm", onclick: () => setPreset(1) }, "Hoy"),
    el("button", { class: "sm", onclick: setYesterday }, "Ayer"),
    el("button", { class: "sm", onclick: () => setPreset(7) }, "7 días"),
    el("button", { class: "sm", onclick: () => setPreset(30) }, "30 días"),
    el("button", { class: "sm", onclick: setThisMonth }, "Este mes"),
  ]);

  const topBar = el("div", { class: "work-hours-topbar" }, [
    el("div", { class: "field-inline" }, [modelSelect, chatterSelect]),
    el("div", { class: "field-inline" }, [fromInput, el("span", {}, "a"), toInput, updateBtn]),
  ]);

  appEl.appendChild(presetsBar);
  appEl.appendChild(topBar);

  const bodyWrap = el("div", { class: "empty" }, "Cargando...");
  appEl.appendChild(bodyWrap);

  let accountsLoaded = false;

  async function load() {
    updateBtn.disabled = true;
    bodyWrap.innerHTML = "";
    bodyWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const qs = new URLSearchParams({ from: fromInput.value, to: toInput.value });
      if (modelSelect.value) qs.set("accountId", modelSelect.value);
      if (chatterSelect.value) qs.set("chatter", chatterSelect.value);
      const data = await api(`/informes/ingresos?${qs.toString()}`);

      if (!accountsLoaded) {
        for (const a of data.accounts) {
          modelSelect.appendChild(el("option", { value: a.id }, a.label));
        }
        for (const c of data.chatters || []) {
          chatterSelect.appendChild(el("option", { value: c }, c));
        }
        accountsLoaded = true;
      }

      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(renderIngresosBody(data));
    } catch (err) {
      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    } finally {
      updateBtn.disabled = false;
    }
  }

  updateBtn.addEventListener("click", load);
  modelSelect.addEventListener("change", load);
  chatterSelect.addEventListener("change", load);
  await load();
}

function renderIngresosBody(data) {
  const wrap = el("div", {});
  const t = data.totals;
  const cmp = data.comparison;

  let cmpLine = null;
  if (cmp.comparisonPct !== null) {
    const up = cmp.comparisonPct >= 0;
    cmpLine = el("div", { class: "kpi-compare " + (up ? "up" : "down") },
      `${up ? "▲" : "▼"} ${Math.abs(cmp.comparisonPct).toFixed(1)}% vs ${money(cmp.prevIngresos)} antes`);
  }

  const kpis = el("div", { class: "kpi-grid" }, [
    kpiTile("Ingresos", money(t.ingresos), cmpLine),
    kpiTile("Ventas", String(t.ventas)),
    kpiTile("Ticket medio", money(t.ticketMedio)),
    kpiTile("Fans que pagaron", String(t.fansQuePagaron)),
    kpiTile("Venta más alta", money(t.ventaMasAlta)),
    kpiTile("Modelos con ingresos", `${t.modelosConIngresos} / ${t.totalModelos}`),
  ]);
  wrap.appendChild(kpis);

  wrap.appendChild(el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, "Ingresos por día"),
    renderDayChart(data.byDay),
  ]));

  const gridRow = el("div", { class: "informes-2col" }, [
    el("div", { class: "card" }, [
      el("h3", { class: "card-title" }, "Ranking de modelos"),
      renderRankingList(data.byModel, (row) => row.label, t.ingresos),
    ]),
    el("div", { class: "card" }, [
      el("h3", { class: "card-title" }, "Fans que más dejaron"),
      renderTopFansList(data.topFans),
    ]),
  ]);
  wrap.appendChild(gridRow);

  const gridRow2 = el("div", { class: "informes-2col" }, [
    el("div", { class: "card" }, [
      el("h3", { class: "card-title" }, "Por servicio"),
      renderRankingList(data.byService, (row) => row.label, t.ingresos),
    ]),
    el("div", { class: "card" }, [
      el("h3", { class: "card-title" }, "Por método de pago"),
      renderRankingList(data.byPaymentMethod, (row) => row.label, t.ingresos),
    ]),
  ]);
  wrap.appendChild(gridRow2);

  return wrap;
}

function kpiTile(label, value, extra) {
  const children = [el("div", { class: "kpi-label" }, label), el("div", { class: "kpi-value" }, value)];
  if (extra) children.push(extra);
  return el("div", { class: "kpi-tile" }, children);
}

function renderDayChart(byDay) {
  if (byDay.length === 0) return el("div", { class: "empty" }, "Sin ventas en este rango.");
  const max = Math.max(...byDay.map((d) => d.total), 0.01);
  return el("div", { class: "day-chart" }, byDay.map((d) =>
    el("div", { class: "day-chart-col", title: `${d.day}: ${money(d.total)}` }, [
      el("div", { class: "day-chart-bar", style: `height:${Math.max(2, (d.total / max) * 100)}%` }),
      el("div", { class: "day-chart-label" }, d.day.slice(5)),
    ])
  ));
}

function renderRankingList(rows, labelFn, total) {
  if (!rows || rows.length === 0) return el("div", { class: "empty" }, "Sin datos en este rango.");
  const max = Math.max(...rows.map((r) => r.total), 0.01);
  return el("div", { class: "ranking-list" }, rows.map((r) =>
    el("div", { class: "ranking-row" }, [
      el("div", { class: "ranking-row-top" }, [
        el("span", { class: "ranking-label" }, labelFn(r)),
        el("span", { class: "ranking-value" }, `${money(r.total)} · ${r.ventas} ${r.ventas === 1 ? "venta" : "ventas"}`),
      ]),
      el("div", { class: "ranking-bar-track" }, el("div", { class: "ranking-bar-fill", style: `width:${(r.total / max) * 100}%` })),
    ])
  ));
}

function renderTopFansList(topFans) {
  if (!topFans || topFans.length === 0) return el("div", { class: "empty" }, "Sin ventas en este rango.");
  return el("div", { class: "ranking-list" }, topFans.map((f, i) =>
    el("div", { class: "ranking-row" }, [
      el("div", { class: "ranking-row-top" }, [
        el("span", { class: "ranking-label" }, `${i + 1}. ${f.fanTitle}${f.modelLabel ? " · " + f.modelLabel : ""}`),
        el("span", { class: "ranking-value" }, `${money(f.total)} · ${f.ventas} ${f.ventas === 1 ? "venta" : "ventas"}`),
      ]),
    ])
  ));
}

/** Informes → Rendimiento de chatters: ventas agrupadas por "Vendido por"
 * (texto libre del formulario de registrar venta), con ranking y ticket
 * medio por chatter. Mismo patrón de fechas/presets que Ingresos. */
async function renderInformesRendimientoSection() {
  appEl.appendChild(el("h1", {}, "Rendimiento de chatters"));
  appEl.appendChild(el("p", { class: "subtitle" }, "Ventas agrupadas por quién las cerró (\"Vendido por\" al registrar la venta)."));

  const today = new Date().toISOString().slice(0, 10);
  const fromInput = el("input", { type: "date", value: today });
  const toInput = el("input", { type: "date", value: today });
  const modelSelect = el("select", {}, el("option", { value: "" }, "Todas las modelos"));
  const chatterSelect = el("select", {}, el("option", { value: "" }, "Todos los chatters"));
  const updateBtn = el("button", { class: "primary" }, "Actualizar");

  function setPreset(days) {
    const { from, to } = informesDateRangeISO(days);
    fromInput.value = from;
    toInput.value = to;
    load();
  }
  function setThisMonth() {
    const now = new Date();
    fromInput.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    toInput.value = today;
    load();
  }
  function setYesterday() {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const s = y.toISOString().slice(0, 10);
    fromInput.value = s;
    toInput.value = s;
    load();
  }

  appEl.appendChild(el("div", { class: "informes-presets" }, [
    el("button", { class: "sm", onclick: () => setPreset(1) }, "Hoy"),
    el("button", { class: "sm", onclick: setYesterday }, "Ayer"),
    el("button", { class: "sm", onclick: () => setPreset(7) }, "7 días"),
    el("button", { class: "sm", onclick: () => setPreset(30) }, "30 días"),
    el("button", { class: "sm", onclick: setThisMonth }, "Este mes"),
  ]));
  appEl.appendChild(el("div", { class: "work-hours-topbar" }, [
    el("div", { class: "field-inline" }, [modelSelect, chatterSelect]),
    el("div", { class: "field-inline" }, [fromInput, el("span", {}, "a"), toInput, updateBtn]),
  ]));

  const bodyWrap = el("div", { class: "empty" }, "Cargando...");
  appEl.appendChild(bodyWrap);

  let accountsLoaded = false;
  let chattersLoaded = false;

  async function load() {
    updateBtn.disabled = true;
    bodyWrap.innerHTML = "";
    bodyWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const qs = new URLSearchParams({ from: fromInput.value, to: toInput.value });
      if (modelSelect.value) qs.set("accountId", modelSelect.value);
      if (chatterSelect.value) qs.set("chatter", chatterSelect.value);
      const data = await api(`/informes/rendimiento?${qs.toString()}`);

      if (!accountsLoaded) {
        for (const a of data.accounts) modelSelect.appendChild(el("option", { value: a.id }, a.label));
        accountsLoaded = true;
      }
      // El listado de chatters no depende del rango de fechas elegido (ver
      // informes.ts), así que basta con rellenarlo una vez - eligiendo un
      // chatter sin ventas hoy no lo hace desaparecer del desplegable.
      if (!chattersLoaded) {
        for (const c of data.chatters || []) chatterSelect.appendChild(el("option", { value: c }, c));
        chattersLoaded = true;
      }

      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(renderRendimientoBody(data));
    } catch (err) {
      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    } finally {
      updateBtn.disabled = false;
    }
  }

  updateBtn.addEventListener("click", load);
  modelSelect.addEventListener("change", load);
  chatterSelect.addEventListener("change", load);
  await load();
}

function renderRendimientoBody(data) {
  const wrap = el("div", {});
  const t = data.totals;
  const cmp = data.comparison;

  let cmpLine = null;
  if (cmp.comparisonPct !== null) {
    const up = cmp.comparisonPct >= 0;
    cmpLine = el("div", { class: "kpi-compare " + (up ? "up" : "down") },
      `${up ? "▲" : "▼"} ${Math.abs(cmp.comparisonPct).toFixed(1)}% vs ${money(cmp.prevIngresos)} antes`);
  }

  wrap.appendChild(el("div", { class: "kpi-grid" }, [
    kpiTile("Ingresos (con chatter asignado)", money(t.ingresos), cmpLine),
    kpiTile("Ventas", String(t.ventas)),
    kpiTile("Chatters con ventas", String(t.chatters)),
    kpiTile("Ventas sin asignar", String(t.ventasSinAsignar),
      t.ventasSinAsignar > 0 ? el("div", { class: "kpi-compare" }, "sin \"Vendido por\"") : null),
  ]));

  wrap.appendChild(el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, "Ranking de chatters"),
    renderRankingList(data.byChatter, (row) => row.label, t.ingresos),
  ]));

  return wrap;
}

/** Informes → Grupos de promoción: admins EXTERNOS (nada que ver con
 * Configuración → Equipo) a los que se paga por promocionar en sus
 * grupos/canales de Telegram. Tres pestañas, como el panel de referencia:
 * "Clasificar grupos" (catálogo en vivo + asignar admin), "Precios" (matriz
 * admin × creadora) y "Veredicto" (ingresos/coste/ROI, pendiente de la
 * atribución de fans a grupos). */
async function renderGruposPromocionSection() {
  appEl.appendChild(el("h1", {}, "Grupos de promoción"));
  appEl.appendChild(el("p", { class: "subtitle" },
    "Admins externos que promocionan en sus grupos de Telegram: catálogo de grupos, precios y (próximamente) veredicto de rentabilidad."));

  const TABS = [
    { key: "clasificar", label: "Clasificar grupos" },
    { key: "precios", label: "Precios" },
    { key: "veredicto", label: "Veredicto" },
  ];
  let activeTab = "clasificar";
  const tabBar = el("div", { class: "informes-presets" });
  appEl.appendChild(tabBar);
  const content = el("div", {});
  appEl.appendChild(content);

  function renderTabBar() {
    tabBar.innerHTML = "";
    for (const t of TABS) {
      tabBar.appendChild(el("button", {
        class: "sm" + (activeTab === t.key ? " primary" : ""),
        onclick: () => { activeTab = t.key; renderTabBar(); renderContent(); },
      }, t.label));
    }
  }

  async function renderContent() {
    content.innerHTML = "";
    if (activeTab === "clasificar") {
      await renderGruposPromocionClasificar(content);
    } else if (activeTab === "precios") {
      await renderGruposPromocionPrecios(content);
    } else {
      await renderGruposPromocionVeredicto(content);
    }
  }

  renderTabBar();
  await renderContent();
}

/** Pestaña "Clasificar grupos": catálogo de los grupos/canales REALES de
 * Telegram de cada creadora, leídos en vivo y clasificados por admin. */
async function renderGruposPromocionClasificar(container) {
  // ---------- Admins: una caja por admin con su nº de grupos y su precio
  // "General" editable ahí mismo (igual que el panel de referencia:
  // "@Nombre (n) precio") ----------
  const adminsCard = el("div", { class: "card" });
  adminsCard.appendChild(el("h3", { class: "card-title" }, "Admins"));
  const adminBoxesEl = el("div", { class: "promo-admin-boxes" }, el("div", { class: "empty" }, "Cargando..."));
  adminsCard.appendChild(adminBoxesEl);
  const adminNameInput = el("input", { placeholder: "Nombre del admin..." });
  const addAdminBtn = el("button", {}, "+ Admin");
  adminsCard.appendChild(el("div", { class: "chip-add-row" }, [adminNameInput, addAdminBtn]));
  container.appendChild(adminsCard);

  // ---------- Carpetas propias del CRM (nada que ver con Telegram): igual
  // que los admins, pero sin precio - solo nombre y nº de grupos ----------
  const foldersCard = el("div", { class: "card" });
  foldersCard.appendChild(el("h3", { class: "card-title" }, "Carpetas"));
  const folderBoxesEl = el("div", { class: "promo-admin-boxes" }, el("div", { class: "empty" }, "Cargando..."));
  foldersCard.appendChild(folderBoxesEl);
  const folderNameInput = el("input", { placeholder: "Nombre de la carpeta..." });
  const addFolderBtn = el("button", {}, "+ Carpeta");
  foldersCard.appendChild(el("div", { class: "chip-add-row" }, [folderNameInput, addFolderBtn]));
  container.appendChild(foldersCard);

  // ---------- Herramientas: leer grupos, buscar, filtrar ----------
  const toolsCard = el("div", { class: "card" });
  const accountSelect = el("select", {}, el("option", { value: "" }, "Elige una creadora..."));
  const readOneBtn = el("button", { class: "sm" }, "Leer grupos de esta creadora");
  const readAllBtn = el("button", { class: "sm" }, "Leer todas las creadoras");
  const searchInput = el("input", { placeholder: "Buscar grupo por nombre..." });
  const onlyUnassignedChip = el("div", { class: "filter-chip" }, "Sin admin asignada");
  const onlyUnassignedFolderChip = el("div", { class: "filter-chip" }, "Sin carpeta asignada");
  toolsCard.appendChild(el("div", { class: "field-inline", style: "margin-bottom:10px" }, [accountSelect, readOneBtn, readAllBtn]));
  toolsCard.appendChild(el("div", { class: "field-inline" }, [searchInput, onlyUnassignedChip, onlyUnassignedFolderChip]));
  const readStatusEl = el("div", { class: "hint" }, "");
  toolsCard.appendChild(readStatusEl);
  container.appendChild(toolsCard);

  // ---------- Barra de selección múltiple (aparece al marcar checkboxes) ----------
  const bulkAdminSelect = el("select", {}, el("option", { value: "" }, "Sin admin asignada"));
  const bulkAssignBtn = el("button", { class: "sm primary" }, "Asignar a la selección");
  const bulkFolderSelect = el("select", {}, el("option", { value: "" }, "Sin carpeta asignada"));
  const bulkAssignFolderBtn = el("button", { class: "sm primary" }, "Asignar carpeta a la selección");
  const bulkCountEl = el("span", { class: "hint", style: "margin-right:8px" }, "");
  const bulkCancelBtn = el("button", { class: "sm ghost" }, "Cancelar selección");
  const bulkBar = el("div", { class: "field-inline promo-bulk-bar hidden" }, [bulkCountEl, bulkAdminSelect, bulkAssignBtn, bulkFolderSelect, bulkAssignFolderBtn, bulkCancelBtn]);
  container.appendChild(bulkBar);

  const tableWrap = el("div", { class: "work-hours-table-wrap" }, el("div", { class: "empty" }, "Cargando..."));
  container.appendChild(tableWrap);

  let admins = [];
  let folders = [];
  let onlyUnassigned = false;
  let onlyUnassignedFolder = false;
  let adminFilterId = ""; // clic en una caja de admin filtra la tabla por ese admin
  let folderFilterId = ""; // clic en una caja de carpeta filtra la tabla por esa carpeta
  const selectedIds = new Set(); // checkboxes marcados (selección múltiple)

  function updateBulkBar() {
    bulkBar.classList.toggle("hidden", selectedIds.size === 0);
    bulkCountEl.textContent = `${selectedIds.size} grupo(s) seleccionado(s)`;
  }

  async function loadAccounts() {
    try {
      const { accounts } = await api("/accounts");
      for (const a of accounts) accountSelect.appendChild(el("option", { value: a.id }, a.label));
    } catch (err) {
      toast("No se pudieron cargar las creadoras: " + err.message, true);
    }
  }

  async function loadAdmins() {
    adminBoxesEl.innerHTML = "";
    const prevBulkValue = bulkAdminSelect.value;
    try {
      const { admins: list } = await api("/promo-admins");
      admins = list;
      bulkAdminSelect.innerHTML = "";
      bulkAdminSelect.appendChild(el("option", { value: "" }, "Sin admin asignada"));
      for (const a of admins) bulkAdminSelect.appendChild(el("option", { value: a.id }, a.name));
      bulkAdminSelect.value = prevBulkValue;

      if (admins.length === 0) {
        adminBoxesEl.appendChild(el("div", { class: "empty" }, "Todavía no hay ningún admin dado de alta."));
      }
      for (const a of admins) {
        const nameEl = el("span", { class: "promo-admin-name" }, `${a.name} (${a.groupCount})`);
        const priceInput = el("input", {
          class: "promo-admin-price", type: "number", min: "0", step: "0.01",
          placeholder: "€/mes", value: a.generalPrice !== null && a.generalPrice !== undefined ? String(a.generalPrice) : "",
        });
        priceInput.addEventListener("click", (ev) => ev.stopPropagation());
        priceInput.addEventListener("change", async () => {
          const raw = priceInput.value.trim();
          try {
            await api("/promo-admin-prices", {
              method: "PATCH",
              body: JSON.stringify({ promoAdminId: a.id, accountId: null, priceMonthly: raw === "" ? null : Number(raw) }),
            });
            toast("Precio guardado");
          } catch (err) {
            toast(err.message, true);
          }
        });
        const editBtn = el("button", { class: "promo-admin-icon-btn", title: "Renombrar admin" }, "✏️");
        editBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const nuevo = prompt("Nuevo nombre del admin:", a.name);
          if (!nuevo || !nuevo.trim() || nuevo.trim() === a.name) return;
          try {
            await api(`/promo-admins/${a.id}`, { method: "PATCH", body: JSON.stringify({ name: nuevo.trim() }) });
            toast("Admin renombrado");
            await loadAdmins();
          } catch (err) {
            toast(err.message, true);
          }
        });
        const removeBtn = el("button", { class: "promo-admin-icon-btn", title: "Eliminar admin" }, "×");
        removeBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (!confirm(`¿Eliminar al admin "${a.name}"? Sus grupos quedarán "Sin admin asignada".`)) return;
          try {
            await api(`/promo-admins/${a.id}`, { method: "DELETE" });
            toast("Admin eliminado");
            if (adminFilterId === a.id) adminFilterId = "";
            await loadAdmins();
            await loadTable();
          } catch (err) {
            toast(err.message, true);
          }
        });
        const box = el("div", {
          class: "promo-admin-box" + (adminFilterId === a.id ? " active" : ""),
          onclick: () => {
            adminFilterId = adminFilterId === a.id ? "" : a.id;
            loadAdmins();
            loadTable();
          },
        }, [nameEl, priceInput, editBtn, removeBtn]);
        adminBoxesEl.appendChild(box);
      }
    } catch (err) {
      adminBoxesEl.innerHTML = "";
      adminBoxesEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  async function loadFolders() {
    folderBoxesEl.innerHTML = "";
    const prevBulkValue = bulkFolderSelect.value;
    try {
      const { folders: list } = await api("/promo-group-folders");
      folders = list;
      bulkFolderSelect.innerHTML = "";
      bulkFolderSelect.appendChild(el("option", { value: "" }, "Sin carpeta asignada"));
      for (const f of folders) bulkFolderSelect.appendChild(el("option", { value: f.id }, f.name));
      bulkFolderSelect.value = prevBulkValue;

      if (folders.length === 0) {
        folderBoxesEl.appendChild(el("div", { class: "empty" }, "Todavía no hay ninguna carpeta creada."));
      }
      for (const f of folders) {
        const nameEl2 = el("span", { class: "promo-admin-name" }, `${f.name} (${f.groupCount})`);
        const editBtn = el("button", { class: "promo-admin-icon-btn", title: "Renombrar carpeta" }, "✏️");
        editBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const nuevo = prompt("Nuevo nombre de la carpeta:", f.name);
          if (!nuevo || !nuevo.trim() || nuevo.trim() === f.name) return;
          try {
            await api(`/promo-group-folders/${f.id}`, { method: "PATCH", body: JSON.stringify({ name: nuevo.trim() }) });
            toast("Carpeta renombrada");
            await loadFolders();
          } catch (err) {
            toast(err.message, true);
          }
        });
        const removeBtn = el("button", { class: "promo-admin-icon-btn", title: "Eliminar carpeta" }, "×");
        removeBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (!confirm(`¿Eliminar la carpeta "${f.name}"? Sus grupos quedarán "Sin carpeta asignada".`)) return;
          try {
            await api(`/promo-group-folders/${f.id}`, { method: "DELETE" });
            toast("Carpeta eliminada");
            if (folderFilterId === f.id) folderFilterId = "";
            await loadFolders();
            await loadTable();
          } catch (err) {
            toast(err.message, true);
          }
        });
        const box = el("div", {
          class: "promo-admin-box" + (folderFilterId === f.id ? " active" : ""),
          onclick: () => {
            folderFilterId = folderFilterId === f.id ? "" : f.id;
            loadFolders();
            loadTable();
          },
        }, [nameEl2, editBtn, removeBtn]);
        folderBoxesEl.appendChild(box);
      }
    } catch (err) {
      folderBoxesEl.innerHTML = "";
      folderBoxesEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  addFolderBtn.addEventListener("click", async () => {
    const name = folderNameInput.value.trim();
    if (!name) return;
    addFolderBtn.disabled = true;
    try {
      await api("/promo-group-folders", { method: "POST", body: JSON.stringify({ name }) });
      folderNameInput.value = "";
      toast("Carpeta creada");
      await loadFolders();
    } catch (err) {
      toast(err.message, true);
    } finally {
      addFolderBtn.disabled = false;
    }
  });

  onlyUnassignedFolderChip.addEventListener("click", () => {
    onlyUnassignedFolder = !onlyUnassignedFolder;
    onlyUnassignedFolderChip.classList.toggle("active", onlyUnassignedFolder);
    loadTable();
  });

  bulkAssignFolderBtn.addEventListener("click", async () => {
    if (selectedIds.size === 0) return;
    bulkAssignFolderBtn.disabled = true;
    try {
      await api("/promo-groups/bulk-assign-folder", {
        method: "POST",
        body: JSON.stringify({ groupIds: [...selectedIds], promoGroupFolderId: bulkFolderSelect.value || null }),
      });
      toast(`Carpeta asignada a ${selectedIds.size} grupo(s)`);
      selectedIds.clear();
      updateBulkBar();
      await loadFolders();
      await loadTable();
    } catch (err) {
      toast(err.message, true);
    } finally {
      bulkAssignFolderBtn.disabled = false;
    }
  });

  addAdminBtn.addEventListener("click", async () => {
    const name = adminNameInput.value.trim();
    if (!name) return;
    addAdminBtn.disabled = true;
    try {
      await api("/promo-admins", { method: "POST", body: JSON.stringify({ name }) });
      adminNameInput.value = "";
      toast("Admin creado");
      await loadAdmins();
    } catch (err) {
      toast(err.message, true);
    } finally {
      addAdminBtn.disabled = false;
    }
  });

  onlyUnassignedChip.addEventListener("click", () => {
    onlyUnassigned = !onlyUnassigned;
    onlyUnassignedChip.classList.toggle("active", onlyUnassigned);
    loadTable();
  });

  readOneBtn.addEventListener("click", async () => {
    if (!accountSelect.value) { toast("Elige primero una creadora.", true); return; }
    readOneBtn.disabled = true;
    readStatusEl.textContent = "Leyendo los grupos de Telegram en vivo, puede tardar un poco...";
    try {
      const r = await api(`/promo-groups/read/${accountSelect.value}`, { method: "POST" });
      readStatusEl.textContent = `Listo: ${r.groupsFound} grupo(s)/canal(es) encontrados para "${r.label}".`;
      await loadAdmins();
      await loadTable();
    } catch (err) {
      readStatusEl.textContent = "";
      toast(err.message, true);
    } finally {
      readOneBtn.disabled = false;
    }
  });

  readAllBtn.addEventListener("click", async () => {
    if (!confirm("Se leerán en vivo los grupos de TODAS las creadoras, una detrás de otra (puede tardar varios minutos). ¿Continuar?")) return;
    readAllBtn.disabled = true;
    readStatusEl.textContent = "Leyendo los grupos de todas las creadoras, una detrás de otra...";
    try {
      const { results } = await api("/promo-groups/read-all", { method: "POST" });
      const ok = results.filter((r) => !r.error);
      const failed = results.filter((r) => r.error);
      readStatusEl.textContent = `Listo: ${ok.length} creadora(s) leídas correctamente` + (failed.length ? `, ${failed.length} con error (${failed.map((f) => f.label).join(", ")}).` : ".");
      await loadAdmins();
      await loadTable();
    } catch (err) {
      readStatusEl.textContent = "";
      toast(err.message, true);
    } finally {
      readAllBtn.disabled = false;
    }
  });

  let searchDebounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadTable, 300);
  });

  bulkCancelBtn.addEventListener("click", () => {
    selectedIds.clear();
    updateBulkBar();
    loadTable();
  });

  bulkAssignBtn.addEventListener("click", async () => {
    if (selectedIds.size === 0) return;
    bulkAssignBtn.disabled = true;
    try {
      await api("/promo-groups/bulk-assign", {
        method: "POST",
        body: JSON.stringify({ groupIds: [...selectedIds], promoAdminId: bulkAdminSelect.value || null }),
      });
      toast(`Admin asignado a ${selectedIds.size} grupo(s)`);
      selectedIds.clear();
      updateBulkBar();
      await loadAdmins();
      await loadTable();
    } catch (err) {
      toast(err.message, true);
    } finally {
      bulkAssignBtn.disabled = false;
    }
  });

  async function loadTable() {
    tableWrap.innerHTML = "";
    tableWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const qs = new URLSearchParams();
      if (searchInput.value.trim()) qs.set("search", searchInput.value.trim());
      if (onlyUnassigned) qs.set("onlyUnassigned", "true");
      if (onlyUnassignedFolder) qs.set("onlyUnassignedFolder", "true");
      const { groups: rawGroups } = await api(`/promo-groups?${qs.toString()}`);
      let filtered = adminFilterId ? rawGroups.filter((g) => g.promoAdminId === adminFilterId) : rawGroups;
      if (folderFilterId) filtered = filtered.filter((g) => g.promoGroupFolderId === folderFilterId);
      const groups = rawGroups;

      // Los grupos que ya no aparecen en este filtrado (búsqueda cambiada,
      // etc.) se sueltan de la selección para no "asignar a la selección"
      // grupos que ya no se ven en pantalla.
      const visibleIds = new Set(filtered.map((g) => g.id));
      for (const id of [...selectedIds]) if (!visibleIds.has(id)) selectedIds.delete(id);
      updateBulkBar();

      tableWrap.innerHTML = "";
      if (filtered.length === 0) {
        tableWrap.appendChild(el("div", { class: "empty" },
          groups.length === 0
            ? "Todavía no hay ningún grupo catalogado. Elige una creadora arriba y pulsa \"Leer grupos de esta creadora\"."
            : "Ningún grupo coincide con el filtro."));
        return;
      }
      const table = el("table", { class: "work-hours-table" });
      const selectAllCb = el("input", { type: "checkbox" });
      selectAllCb.addEventListener("change", () => {
        if (selectAllCb.checked) filtered.forEach((g) => selectedIds.add(g.id));
        else filtered.forEach((g) => selectedIds.delete(g.id));
        updateBulkBar();
        loadTable();
      });
      table.appendChild(el("thead", {}, el("tr", {}, [
        el("th", { style: "width:32px" }, selectAllCb),
        el("th", {}, "Grupo"),
        el("th", {}, "Tipo"),
        el("th", {}, "Miembros"),
        el("th", {}, "Modelos dentro"),
        el("th", { title: "Fans nuevos atribuidos a este grupo (histórico). Si el grupo tiene varias modelos dentro, se desglosa por modelo." }, "Hablaron"),
        el("th", { title: "De esos fans, cuántos han comprado alguna vez" }, "Compraron"),
        el("th", {}, "Conv."),
        el("th", { title: "Nº de ventas de esos fans (histórico)" }, "Ventas"),
        el("th", {}, "Admin"),
        el("th", {}, "Carpeta"),
      ])));
      const tbody = el("tbody", {});
      // Cuando el grupo tiene más de una modelo dentro, se desglosa el stat
      // pedido ("con esta modelo hablaron X, con esta otra Y") en vez de
      // mostrar solo el total combinado; con una sola modelo (o ninguna) se
      // deja el total tal cual, igual que antes.
      function statCell(g, fmt) {
        if (!g.porModelo || g.porModelo.length <= 1) return el("td", {}, fmt(g));
        return el("td", {}, el("div", { class: "promo-stat-breakdown" },
          g.porModelo.map((m) => el("div", {}, `${m.label}: ${fmt(m)}`))
        ));
      }
      for (const g of filtered) {
        const rowCb = el("input", { type: "checkbox", checked: selectedIds.has(g.id) ? "true" : null });
        rowCb.addEventListener("change", () => {
          if (rowCb.checked) selectedIds.add(g.id); else selectedIds.delete(g.id);
          updateBulkBar();
        });
        const adminSelect = el("select", {}, [
          el("option", { value: "" }, "Sin admin asignada"),
          ...admins.map((a) => el("option", { value: a.id, selected: a.id === g.promoAdminId ? "true" : null }, a.name)),
        ]);
        adminSelect.addEventListener("change", async () => {
          adminSelect.disabled = true;
          try {
            await api(`/promo-groups/${g.id}`, { method: "PATCH", body: JSON.stringify({ promoAdminId: adminSelect.value || null }) });
            toast("Guardado");
            await loadAdmins();
          } catch (err) {
            toast(err.message, true);
          } finally {
            adminSelect.disabled = false;
          }
        });
        const folderSelect = el("select", {}, [
          el("option", { value: "" }, "Sin carpeta asignada"),
          ...folders.map((f) => el("option", { value: f.id, selected: f.id === g.promoGroupFolderId ? "true" : null }, f.name)),
        ]);
        folderSelect.addEventListener("change", async () => {
          folderSelect.disabled = true;
          try {
            await api(`/promo-groups/${g.id}`, { method: "PATCH", body: JSON.stringify({ promoGroupFolderId: folderSelect.value || null }) });
            toast("Guardado");
            await loadFolders();
          } catch (err) {
            toast(err.message, true);
          } finally {
            folderSelect.disabled = false;
          }
        });
        tbody.appendChild(el("tr", {}, [
          el("td", {}, rowCb),
          el("td", { style: "font-weight:600" }, g.title),
          el("td", {}, g.isChannel ? "Canal" : "Grupo"),
          el("td", {}, String(g.memberCount)),
          el("td", {}, g.accounts.map((a) => a.label).join(", ") || "—"),
          statCell(g, (x) => String(x.hablaron)),
          statCell(g, (x) => String(x.compraron)),
          statCell(g, (x) => (x.conversion === null ? "-" : `${x.conversion.toFixed(1)}%`)),
          statCell(g, (x) => String(x.ventas)),
          el("td", {}, adminSelect),
          el("td", {}, folderSelect),
        ]));
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    } catch (err) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  await loadAccounts();
  await loadAdmins();
  await loadFolders();
  await loadTable();
}

/** Pestaña "Precios": matriz admin × creadora + columna "General" (el
 * precio que se usa si esa creadora no tiene uno propio cargado), y el
 * botón "Copiar precios de X a Y". */
async function renderGruposPromocionPrecios(container) {
  container.appendChild(el("h3", { class: "card-title" }, "Precios por admin y creadora"));
  container.appendChild(el("p", { class: "hint" },
    "Lo que te cobra cada admin por mes y por creadora. Carga una creadora entera, cópiala al resto y corrige solo las que cambien. \"General\" es el precio que se usa para las creadoras que no tengan uno propio: si a todas les cobra igual, con esa columna alcanza. Vacío = sin cargar (esa creadora no suma coste y el admin no puede tener veredicto todavía); 0 = gratis."));

  const fromSelect = el("select", {}, el("option", { value: "" }, "Elegir..."));
  const toSelect = el("select", {}, el("option", { value: "" }, "Elegir..."));
  const copyBtn = el("button", { class: "sm" }, "Copiar");
  container.appendChild(el("div", { class: "field-inline", style: "margin-bottom:14px" }, [
    el("span", {}, "Copiar precios de"), fromSelect, el("span", {}, "a"), toSelect, copyBtn,
  ]));

  const tableWrap = el("div", { class: "work-hours-table-wrap" }, el("div", { class: "empty" }, "Cargando..."));
  container.appendChild(tableWrap);

  async function load() {
    tableWrap.innerHTML = "";
    tableWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const { accounts, admins } = await api("/promo-admin-prices");

      if (!fromSelect.dataset.loaded) {
        for (const a of accounts) {
          fromSelect.appendChild(el("option", { value: a.id }, a.label));
          toSelect.appendChild(el("option", { value: a.id }, a.label));
        }
        fromSelect.dataset.loaded = "1";
      }

      tableWrap.innerHTML = "";
      if (admins.length === 0) {
        tableWrap.appendChild(el("div", { class: "empty" }, "Todavía no hay ningún admin dado de alta (pestaña \"Clasificar grupos\")."));
        return;
      }

      function priceInput(value, onSave) {
        const input = el("input", { type: "number", min: "0", step: "1", style: "width:90px", value: value === null || value === undefined ? "" : String(value) });
        input.addEventListener("change", async () => {
          input.disabled = true;
          try {
            const v = input.value.trim() === "" ? null : Number(input.value);
            await onSave(v);
            toast("Guardado");
          } catch (err) {
            toast(err.message, true);
          } finally {
            input.disabled = false;
          }
        });
        return input;
      }

      const table = el("table", { class: "work-hours-table" });
      table.appendChild(el("thead", {}, el("tr", {}, [
        el("th", {}, "Admin"),
        el("th", {}, "General"),
        ...accounts.map((a) => el("th", {}, a.label)),
      ])));
      const tbody = el("tbody", {});
      const generalTotal = admins.reduce((s, a) => s + (a.generalPrice || 0), 0);
      const accountTotals = accounts.map((acc) => admins.reduce((s, a) => s + (a.pricesByAccount[acc.id] || 0), 0));
      for (const a of admins) {
        const row = [
          el("td", { style: "font-weight:600" }, a.name),
          el("td", {}, priceInput(a.generalPrice, (v) => api("/promo-admin-prices", {
            method: "PATCH",
            body: JSON.stringify({ promoAdminId: a.id, accountId: null, priceMonthly: v }),
          }))),
        ];
        for (const acc of accounts) {
          row.push(el("td", {}, priceInput(a.pricesByAccount[acc.id] ?? null, (v) => api("/promo-admin-prices", {
            method: "PATCH",
            body: JSON.stringify({ promoAdminId: a.id, accountId: acc.id, priceMonthly: v }),
          }))));
        }
        tbody.appendChild(el("tr", {}, row));
      }
      tbody.appendChild(el("tr", { style: "font-weight:700; border-top:1px solid rgba(212,180,131,0.25)" }, [
        el("td", {}, "Total"),
        el("td", {}, money(generalTotal)),
        ...accountTotals.map((t) => el("td", {}, money(t))),
      ]));
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    } catch (err) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  copyBtn.addEventListener("click", async () => {
    if (!fromSelect.value || !toSelect.value) { toast("Elige las dos creadoras.", true); return; }
    if (fromSelect.value === toSelect.value) { toast("Elige dos creadoras distintas.", true); return; }
    copyBtn.disabled = true;
    try {
      const r = await api("/promo-admin-prices/copy", {
        method: "POST",
        body: JSON.stringify({ fromAccountId: fromSelect.value, toAccountId: toSelect.value }),
      });
      toast(`Copiados ${r.copied} precio(s)`);
      await load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      copyBtn.disabled = false;
    }
  });

  await load();
}

/** Pestaña "Veredicto": qué admin conviene seguir pagando y cuál cortar,
 * con KPIs arriba y export a PDF/Excel - como el panel de referencia. Las
 * atribuciones de fans a grupos son "de por vida" (ver liveEvents.ts); solo
 * las ventas se filtran por el rango elegido. */
async function renderGruposPromocionVeredicto(container) {
  container.appendChild(el("p", { class: "hint" },
    "Qué admin conviene seguir pagando y cuál cortar. Los ingresos son las ventas atribuidas a sus grupos en el período (el monto de cada venta se reparte entre los grupos en común del fan; la cantidad de ventas cuenta una sola vez por admin). El coste sale de su precio mensual × las modelos que están hoy dentro de sus grupos × los meses del periodo — más el detalle por grupo y por venta en el Excel."));

  const today = new Date().toISOString().slice(0, 10);
  const accountSelect = el("select", {}, el("option", { value: "" }, "Todas las creadoras"));
  const fromInput = el("input", { type: "date", value: informesDateRangeISO(30).from });
  const toInput = el("input", { type: "date", value: today });
  const updateBtn = el("button", { class: "primary" }, "Actualizar");
  const pdfBtn = el("button", { class: "sm" }, "Veredicto en PDF");
  const xlsxBtn = el("button", { class: "sm" }, "Excel con el detalle");

  function setPreset(days) {
    const { from, to } = informesDateRangeISO(days);
    fromInput.value = from;
    toInput.value = to;
    load();
  }
  container.appendChild(el("div", { class: "informes-presets" }, [
    el("button", { class: "sm", onclick: () => setPreset(7) }, "7 días"),
    el("button", { class: "sm", onclick: () => setPreset(30) }, "30 días"),
    el("button", { class: "sm", onclick: () => setPreset(90) }, "90 días"),
    pdfBtn, xlsxBtn,
  ]));
  container.appendChild(el("div", { class: "work-hours-topbar" }, [
    el("div", { class: "field-inline" }, [accountSelect]),
    el("div", { class: "field-inline" }, [el("span", {}, "Desde"), fromInput, el("span", {}, "Hasta"), toInput, updateBtn]),
  ]));

  api("/accounts").then(({ accounts }) => {
    for (const a of accounts) accountSelect.appendChild(el("option", { value: a.id }, a.label));
  }).catch(() => {});

  function exportUrl(kind) {
    const qs = new URLSearchParams({ from: fromInput.value, to: toInput.value });
    if (accountSelect.value) qs.set("accountId", accountSelect.value);
    return `${API_BASE}/promo-groups/veredicto/export.${kind}?${qs.toString()}`;
  }
  pdfBtn.addEventListener("click", () => window.open(exportUrl("pdf"), "_blank"));
  xlsxBtn.addEventListener("click", () => window.open(exportUrl("xlsx"), "_blank"));

  const bodyWrap = el("div", { class: "empty" }, "Cargando...");
  container.appendChild(bodyWrap);

  async function load() {
    updateBtn.disabled = true;
    bodyWrap.innerHTML = "";
    bodyWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const qs = new URLSearchParams({ from: fromInput.value, to: toInput.value });
      if (accountSelect.value) qs.set("accountId", accountSelect.value);
      const data = await api(`/promo-groups/veredicto?${qs.toString()}`);
      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(renderVeredictoBody(data, load));
    } catch (err) {
      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    } finally {
      updateBtn.disabled = false;
    }
  }

  updateBtn.addEventListener("click", load);
  accountSelect.addEventListener("change", load);
  await load();
}

function pct(n) {
  return n === null || n === undefined ? "—" : `${n.toFixed(1)}%`;
}

function ratioFmt(n) {
  return n === null || n === undefined ? "-" : `${n.toFixed(2)}x`;
}

function renderVeredictoBody(data, onReload) {
  const wrap = el("div", {});
  const t = data.totals;

  const kpis = [
    kpiTile("Fact. atribuida", money(t.ingresosAtribuidos)),
    kpiTile("Coste admins", money(t.costeAdmins)),
    kpiTile("Margen", money(t.margen)),
    kpiTile("ROI global", ratioFmt(t.ratioGlobal)),
    kpiTile("Clientes", String(t.clientes)),
  ];
  if (t.ingresosNoAtribuidos > 0) {
    kpis.push(kpiTile("SIN GRUPOS *", money(t.ingresosNoAtribuidos)));
  }
  wrap.appendChild(el("div", { class: "kpi-grid" }, kpis));

  const noteParts = [`Período de ${t.periodMonths} mes(es).`];
  if (t.adminsConVentasSinPrecio > 0) {
    noteParts.push(`⚠ ${t.adminsConVentasSinPrecio} admin(s) con ventas pero sin precio cargado — sin eso no hay veredicto (cárgalo en la pestaña "Precios").`);
  }
  if (t.ingresosNoAtribuidos > 0) {
    noteParts.push(`* SIN GRUPOS: ventas de fans que no llegaron por ningún grupo catalogado.`);
  }
  wrap.appendChild(el("p", { class: "hint" }, noteParts.join(" ")));

  if (data.rows.length === 0) {
    wrap.appendChild(el("div", { class: "card empty" }, "Todavía no hay ningún admin dado de alta (pestaña \"Clasificar grupos\")."));
    return wrap;
  }

  const table = el("table", { class: "work-hours-table" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", {}, "Admin"), el("th", {}, "Grupos"), el("th", {}, "Mod."), el("th", {}, "Precio"),
    el("th", {}, "Ingresos"), el("th", {}, "Coste"), el("th", {}, "Ratio"), el("th", {}, "Veredicto"),
    el("th", {}, "Hablaron"), el("th", {}, "Conv."), el("th", {}, "Comentario"),
  ])));
  const tbody = el("tbody", {});
  for (const r of data.rows) {
    let badge = "—";
    if (r.sinPrecio) badge = "SIN PRECIO";
    else if (r.sinVentas) badge = "SIN VENTAS";
    else badge = r.margen >= 0 ? "RENTABLE" : "NO RENTABLE";

    const commentInput = el("input", { value: r.comment || "", placeholder: "Nota...", style: "width:160px" });
    commentInput.addEventListener("change", async () => {
      commentInput.disabled = true;
      try {
        await api(`/promo-admins/${r.id}`, { method: "PATCH", body: JSON.stringify({ comment: commentInput.value }) });
        toast("Guardado");
      } catch (err) {
        toast(err.message, true);
      } finally {
        commentInput.disabled = false;
      }
    });

    tbody.appendChild(el("tr", {}, [
      el("td", { style: "font-weight:600" }, r.name),
      el("td", {}, String(r.grupos)),
      el("td", {}, String(r.creadoras)),
      el("td", {}, r.precio === null ? "-" : money(r.precio)),
      el("td", { style: "color:var(--gold-400)" }, money(r.ingresos)),
      el("td", {}, money(r.coste)),
      el("td", {}, ratioFmt(r.ratio)),
      el("td", {}, badge),
      el("td", {}, `${r.hablaron} · ${r.compraron} compr.`),
      el("td", {}, pct(r.conversion)),
      el("td", {}, commentInput),
    ]));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** Informes → Horas trabajadas: sesiones/inactividad/desconexiones por
 * trabajador, reconstruidas a partir de los latidos que manda el navegador
 * de cada trabajador (ver startWorkerHeartbeat). */
function fmtClockTeamSince(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

/** "A qué hora ha fichado cada trabajador" (Informes → Horas trabajadas):
 * estado EN VIVO de hoy, no un histórico por rango - por eso es una tabla
 * aparte de la de arriba (que sí es por rango de fechas), justo debajo. */
async function renderClockTeamTable() {
  const wrap = el("div", { class: "work-hours-table-wrap" }, el("div", { class: "empty" }, "Cargando..."));
  try {
    const { rows } = await api("/clock/team");
    wrap.innerHTML = "";
    if (rows.length === 0) {
      wrap.appendChild(el("div", { class: "empty" }, "Sin trabajadores todavía."));
      return wrap;
    }
    const table = el("table", { class: "work-hours-table" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "Worker"),
      el("th", {}, "Estado"),
      el("th", {}, "Fichó a las"),
      el("th", {}, "Descanso usado hoy"),
    ])));
    const tbody = el("tbody", {});
    for (const r of rows) {
      const estado = !r.clockedIn ? "🔴 Sin fichar" : (r.onBreak ? `☕ En descanso desde ${fmtClockTeamSince(r.breakSince)}` : "🟢 Fichado");
      tbody.appendChild(el("tr", {}, [
        el("td", { style: "font-weight:600" }, r.workerName),
        el("td", {}, estado),
        el("td", {}, r.clockedIn ? fmtClockTeamSince(r.clockedInSince) : "—"),
        el("td", {}, `${r.breakUsedMinutes} / ${r.breakBudgetMinutes} min`),
      ]));
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  } catch (err) {
    wrap.innerHTML = "";
    wrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
  return wrap;
}

async function renderHorasTrabajadasSection() {
  appEl.appendChild(el("h1", {}, "Horas trabajadas"));

  appEl.appendChild(el("div", { class: "section-title-row" }, [el("h2", {}, "Fichajes de hoy")]));
  appEl.appendChild(await renderClockTeamTable());
  appEl.appendChild(el("div", { class: "section-title-row", style: "margin-top:18px" }, [el("h2", {}, "Histórico por rango")]));

  const today = new Date().toISOString().slice(0, 10);
  const fromInput = el("input", { type: "date", value: today });
  const toInput = el("input", { type: "date", value: today });
  const workerSelect = el("select", {}, el("option", { value: "" }, "Todos los workers"));

  const disconnectInput = el("input", { type: "number", min: "1", style: "width:70px" });
  const breakInput = el("input", { type: "number", min: "0", style: "width:70px" });
  const saveSettingsBtn = el("button", { class: "primary" }, "Guardar");

  const topBar = el("div", { class: "work-hours-topbar" }, [
    el("div", { class: "field-inline" }, [workerSelect]),
    el("div", { class: "field-inline" }, [fromInput, el("span", {}, "a"), toInput]),
  ]);
  appEl.appendChild(topBar);

  const settingsBar = el("div", { class: "work-hours-settings" }, [
    el("label", {}, ["Minutos sin responder para considerar \"desconectado\": ", disconnectInput]),
    el("label", {}, ["Descanso permitido por día (minutos, se puede tomar de golpe o repartido): ", breakInput]),
    saveSettingsBtn,
  ]);
  appEl.appendChild(settingsBar);

  const tableWrap = el("div", { class: "work-hours-table-wrap" }, el("div", { class: "empty" }, "Cargando..."));
  appEl.appendChild(tableWrap);

  try {
    const { workers } = await api("/workers");
    for (const w of workers) {
      workerSelect.appendChild(el("option", { value: w.id }, w.name));
    }
  } catch (err) {
    toast("No se pudo cargar la lista de trabajadores: " + err.message, true);
  }

  try {
    const settings = await api("/work-hours/settings");
    disconnectInput.value = settings.disconnectMinutes;
    breakInput.value = settings.breakMinutes;
  } catch (err) {
    toast("No se pudieron cargar los ajustes: " + err.message, true);
  }

  saveSettingsBtn.addEventListener("click", async () => {
    saveSettingsBtn.disabled = true;
    try {
      await api("/work-hours/settings", {
        method: "PATCH",
        body: JSON.stringify({ disconnectMinutes: Number(disconnectInput.value), breakMinutes: Number(breakInput.value) }),
      });
      toast("Ajustes guardados");
      await loadTable();
    } catch (err) {
      toast(err.message, true);
    } finally {
      saveSettingsBtn.disabled = false;
    }
  });

  async function loadTable() {
    tableWrap.innerHTML = "";
    tableWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const qs = new URLSearchParams({ from: fromInput.value, to: toInput.value });
      if (workerSelect.value) qs.set("workerId", workerSelect.value);
      const { rows } = await api(`/work-hours?${qs.toString()}`);
      tableWrap.innerHTML = "";
      if (rows.length === 0) {
        tableWrap.appendChild(el("div", { class: "empty" }, "Sin trabajadores todavía."));
        return;
      }
      const table = el("table", { class: "work-hours-table" });
      table.appendChild(el("thead", {}, el("tr", {}, [
        el("th", {}, "Worker"),
        el("th", {}, "Horas trabajadas"),
        el("th", {}, "Inactivo con fans esperando"),
        el("th", {}, "Inactivo sin nada que responder"),
        el("th", {}, "Sesiones"),
        el("th", {}, "Desconexiones"),
      ])));
      const tbody = el("tbody", {});
      for (const r of rows) {
        tbody.appendChild(el("tr", {}, [
          el("td", { style: "font-weight:600" }, r.workerName),
          el("td", { style: "color:var(--gold-400)" }, r.hoursWorked),
          el("td", { style: "color:#8a6a28" }, r.idleWithFans),
          el("td", {}, r.idleNoFans),
          el("td", {}, String(r.sessions)),
          el("td", {}, String(r.disconnections)),
        ]));
      }
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    } catch (err) {
      tableWrap.innerHTML = "";
      tableWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  fromInput.addEventListener("change", loadTable);
  toInput.addEventListener("change", loadTable);
  workerSelect.addEventListener("change", loadTable);
  await loadTable();
}

// ---------- Guiones (guion de venta paso a paso, por categorías y por
// cuenta/modelo — distinto del botón rápido «Scripts» del chat). ----------

const GUION_STEP_TYPE_LABELS = { text: "TEXTO", pack: "PACK DE FOTOS/VÍDEOS", audio: "AUDIO" };

async function openGuiones() {
  let accounts;
  try {
    const res = await api("/accounts");
    accounts = res.accounts;
    state.accounts = accounts;
  } catch (err) {
    appEl.innerHTML = "";
    appEl.appendChild(el("div", { class: "card" }, "Error cargando modelos: " + err.message));
    return;
  }
  if (accounts.length === 0) {
    accountListEl.innerHTML = "";
    appEl.innerHTML = "";
    appEl.appendChild(el("div", { class: "empty" }, "Sin modelos todavía. Añade una cuenta desde \"Cuentas de Telegram\"."));
    return;
  }
  if (!state.guionesAccountId || !accounts.some((a) => a.id === state.guionesAccountId)) {
    state.guionesAccountId = accounts[0].id;
  }
  state.guionesCategoryId = null;
  await renderGuionesCategoriesNav(accounts);
  await renderGuionesList(accounts);
}

async function renderGuionesCategoriesNav(accounts) {
  accountListEl.innerHTML = "";
  accountListEl.appendChild(el("div", { class: "account-list-title" }, "Categorías"));

  let categories = [];
  try {
    const res = await api(`/accounts/${state.guionesAccountId}/guiones-categories`);
    categories = res.categories;
  } catch (err) {
    accountListEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    return;
  }

  const totalCount = categories.reduce((sum, c) => sum + c.count, 0);
  const items = [{ id: null, name: "Todos", count: totalCount }, ...categories];
  for (const c of items) {
    const row = el("div", {
      class: "config-nav-item" + (state.guionesCategoryId === c.id ? " active" : ""),
      onclick: async () => {
        state.guionesCategoryId = c.id;
        await renderGuionesCategoriesNav(accounts);
        await renderGuionesList(accounts);
      },
    }, [
      el("span", {}, c.name),
      el("span", { class: "hint" }, String(c.count)),
    ]);

    if (c.id !== null) {
      const controls = el("span", { class: "guiones-cat-controls" });

      const editBtn = el("button", { class: "ghost", title: "Renombrar" }, "✏️");
      editBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const newName = window.prompt("Nuevo nombre de la categoría:", c.name);
        if (newName === null) return;
        const trimmed = newName.trim();
        if (!trimmed || trimmed === c.name) return;
        try {
          await api(`/guiones-categories/${c.id}`, { method: "PATCH", body: JSON.stringify({ name: trimmed }) });
          await renderGuionesCategoriesNav(accounts);
          await renderGuionesList(accounts);
        } catch (err) {
          toast(err.message, true);
        }
      });

      const delBtn = el("button", { class: "ghost", title: "Eliminar categoría" }, "🗑️");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await confirmModal({
          title: "Eliminar categoría",
          body: `¿Eliminar "${c.name}"? Los guiones de esta categoría no se borran, quedan como "Sin categoría".`,
          confirmLabel: "Eliminar",
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`/guiones-categories/${c.id}`, { method: "DELETE" });
          if (state.guionesCategoryId === c.id) state.guionesCategoryId = null;
          await renderGuionesCategoriesNav(accounts);
          await renderGuionesList(accounts);
        } catch (err) {
          toast(err.message, true);
        }
      });

      controls.appendChild(editBtn);
      controls.appendChild(delBtn);
      row.appendChild(controls);
    }

    accountListEl.appendChild(row);
  }

  const addRow = el("div", { class: "config-nav-item guiones-add-category" });
  const addInput = el("input", { placeholder: "Nombre de la categoría...", style: "display:none" });
  const addLabel = el("span", {}, "+ Nueva categoría");
  addRow.appendChild(addLabel);
  addRow.appendChild(addInput);
  addRow.addEventListener("click", (e) => {
    if (e.target === addInput) return;
    addLabel.style.display = "none";
    addInput.style.display = "";
    addInput.focus();
  });
  const submit = async () => {
    const name = addInput.value.trim();
    if (!name) return;
    try {
      await api(`/accounts/${state.guionesAccountId}/guiones-categories`, { method: "POST", body: JSON.stringify({ name }) });
      await renderGuionesCategoriesNav(accounts);
    } catch (err) {
      toast(err.message, true);
    }
  };
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  addInput.addEventListener("blur", () => { if (!addInput.value.trim()) { addLabel.style.display = ""; addInput.style.display = "none"; } });
  accountListEl.appendChild(addRow);
}

function guionStepSummary(steps) {
  return steps.map((s) => GUION_STEP_TYPE_LABELS[s.type] || s.type).join(" → ");
}

async function renderGuionesList(accounts) {
  appEl.innerHTML = "";
  appEl.appendChild(el("h1", {}, "Guiones"));
  appEl.appendChild(el("p", { class: "subtitle" },
    "Textos, packs y audios ya preparados para vender paso a paso, con su precio orientativo. En el chat salen en el botón «Scripts»."));

  const accountSelect = el("select", {},
    accounts.map((a) => el("option", { value: a.id, selected: a.id === state.guionesAccountId ? "true" : null }, a.label))
  );
  accountSelect.addEventListener("change", async () => {
    state.guionesAccountId = accountSelect.value;
    state.guionesCategoryId = null;
    await renderGuionesCategoriesNav(accounts);
    await renderGuionesList(accounts);
  });

  const newBtn = el("button", { class: "primary" }, "+ Nuevo guion");
  newBtn.addEventListener("click", () => openGuionModal(accounts, null));

  appEl.appendChild(el("div", { class: "guiones-topbar" }, [accountSelect, newBtn]));

  const listWrap = el("div", { class: "guiones-list" }, el("div", { class: "empty" }, "Cargando..."));
  appEl.appendChild(listWrap);

  try {
    const qs = state.guionesCategoryId ? `?categoryId=${state.guionesCategoryId}` : "";
    const { guiones } = await api(`/accounts/${state.guionesAccountId}/guiones${qs}`);
    listWrap.innerHTML = "";
    listWrap.appendChild(el("div", { class: "guiones-list-header" }, [
      el("div", {}, state.guionesCategoryId ? "Guiones de esta categoría" : "Todos los guiones"),
      el("div", { class: "hint" }, guiones.length === 1 ? "1 guion" : `${guiones.length} guiones`),
    ]));
    if (guiones.length === 0) {
      listWrap.appendChild(el("div", { class: "empty" }, "Esta modelo todavía no tiene guiones. Crea el primero con «+ Nuevo guion»."));
      return;
    }
    for (const g of guiones) {
      const delBtn = el("button", { class: "ghost", title: "Eliminar" }, "🗑️");
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await confirmModal({ title: "Eliminar guion", body: `¿Eliminar "${g.name}"?`, confirmLabel: "Eliminar", danger: true });
        if (!ok) return;
        try {
          await api(`/guiones/${g.id}`, { method: "DELETE" });
          await renderGuionesList(accounts);
        } catch (err) {
          toast(err.message, true);
        }
      });
      const card = el("div", { class: "guion-card", onclick: () => openGuionModal(accounts, g) }, [
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { style: "font-weight:600" }, g.name),
          el("div", { class: "hint" }, guionStepSummary(g.steps) + (g.categoryName ? ` · ${g.categoryName}` : "")),
        ]),
        g.price !== null && g.price !== undefined ? el("div", { style: "color:var(--gold-400);font-weight:600" }, `${g.price}€`) : null,
        delBtn,
      ]);
      listWrap.appendChild(card);
    }
  } catch (err) {
    listWrap.innerHTML = "";
    listWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
}

/** Reintenta cargar una miniatura de la bóveda 2 veces (a veces Telegram
 * tarda o el hueco de descarga estaba lleno) y, si sigue sin llegar, la
 * cambia por un icono en vez de dejar el icono de imagen rota del navegador. */
function bindThumbRetry(img, url, fallbackIcon) {
  let attempts = 0;
  img.addEventListener("error", () => {
    attempts++;
    if (attempts <= 3) {
      setTimeout(() => { img.src = url + (url.includes("?") ? "&" : "?") + "r=" + Date.now() + attempts; }, 900 * attempts);
    } else {
      const fallback = el("div", { class: "content-item-thumb-empty" }, fallbackIcon || "🖼️");
      img.replaceWith(fallback);
    }
  });
}

/** Selector completo de la bóveda: carpetas con su color real de Telegram +
 * "Todos los medios", búsqueda, orden, tipo y selección múltiple — igual que
 * el panel de referencia. selectedMedia se muta en sitio (push/splice) y
 * onDone() se llama para refrescar el llamador. Usado por los pasos
 * "pack"/"audio" de Guiones. */
function openVaultPickerModal(acc, selectedMedia, onDone, opts) {
  const max = (opts && opts.max) || 10;
  const forcedType = opts && opts.typeFilter; // si se fija, no se muestran chips de tipo

  openModal(async (modal, close) => {
    modal.appendChild(el("h3", {}, "Elegir de la bóveda"));

    let group;
    try {
      group = (await api(`/accounts/${acc.id}/content-group`)).group;
    } catch (err) {
      modal.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }
    if (!group) {
      modal.appendChild(el("div", { class: "empty" }, "Esta modelo todavía no tiene bóveda de contenido conectada (ver \"Bóveda de contenido\" en Configuración)."));
      return;
    }

    let topics = [];
    try {
      topics = (await api(`/accounts/${acc.id}/content-group/topics`)).topics;
    } catch (err) {
      modal.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }
    const totalCount = topics.reduce((sum, t) => sum + (t.count || 0), 0);

    const pState = { folder: "all", typeFilter: forcedType || "all", sortDesc: true, search: "", items: [], hasMore: false, nextOffsetId: null, loading: false };

    const layout = el("div", { class: "content-library-layout" });
    modal.appendChild(layout);
    const foldersPane = el("div", { class: "content-folders-pane" });
    layout.appendChild(foldersPane);
    const mainPane = el("div", { class: "content-main-pane" });
    layout.appendChild(mainPane);

    function renderFolders() {
      foldersPane.innerHTML = "";
      const allRow = el("div", { class: "content-folder-item" + (pState.folder === "all" ? " active" : "") }, [
        el("span", { class: "content-folder-label" }, [el("span", { class: "content-folder-dot", style: "background:var(--gold-400)" }), "Todos los medios"]),
        el("span", { class: "content-folder-count" }, String(totalCount)),
      ]);
      allRow.addEventListener("click", () => { pState.folder = "all"; renderFolders(); loadPage(true); });
      foldersPane.appendChild(allRow);

      const favRow = el("div", { class: "content-folder-item" + (pState.folder === "favorites" ? " active" : "") },
        el("span", { class: "content-folder-label" }, [el("span", { class: "content-folder-dot", style: "background:var(--gold-400)" }), "⭐ Favoritos"]));
      favRow.addEventListener("click", () => { pState.folder = "favorites"; renderFolders(); loadPage(true); });
      foldersPane.appendChild(favRow);

      for (const t of topics) {
        const row = el("div", { class: "content-folder-item" + (pState.folder === t.id ? " active" : "") }, [
          el("span", { class: "content-folder-label" }, [el("span", { class: "content-folder-dot", style: `background:${t.color || "var(--cream-faint)"}` }), t.title]),
          el("span", { class: "content-folder-count" }, String(t.count ?? "")),
        ]);
        row.addEventListener("click", () => { pState.folder = t.id; renderFolders(); loadPage(true); });
        foldersPane.appendChild(row);
      }
    }
    renderFolders();

    const toolbar = el("div", { class: "vault-picker-toolbar" });
    const searchInput = el("input", { class: "content-search-input", placeholder: "Buscar por texto, nota..." });
    searchInput.addEventListener("input", () => { pState.search = searchInput.value.trim().toLowerCase(); renderGrid(); });
    toolbar.appendChild(searchInput);
    const sortSelect = el("select", {}, [
      el("option", { value: "desc" }, "Más nuevo primero"),
      el("option", { value: "asc" }, "Más antiguo primero"),
    ]);
    sortSelect.addEventListener("change", () => { pState.sortDesc = sortSelect.value === "desc"; renderGrid(); });
    toolbar.appendChild(sortSelect);
    mainPane.appendChild(toolbar);

    if (!forcedType) {
      const typeTabs = el("div", { class: "content-type-tabs" });
      const options = [["all", "Todo"], ["photo", "Fotos"], ["video", "Vídeos"]];
      for (const [val, label] of options) {
        const chip = el("div", { class: "filter-chip" + (pState.typeFilter === val ? " active" : "") }, label);
        chip.addEventListener("click", () => {
          pState.typeFilter = val;
          typeTabs.querySelectorAll(".filter-chip").forEach((c, i) => c.classList.toggle("active", options[i][0] === val));
          loadPage(true);
        });
        typeTabs.appendChild(chip);
      }
      mainPane.appendChild(typeTabs);
    }

    const countLabel = el("div", { class: "hint", style: "margin-bottom:8px" }, "");
    mainPane.appendChild(countLabel);
    const grid = el("div", { class: "content-items-grid" });
    mainPane.appendChild(grid);
    const loadMoreRow = el("div", { class: "content-load-more-row" });
    mainPane.appendChild(loadMoreRow);

    function matchesSearch(it) {
      if (!pState.search) return true;
      const hay = ((it.caption || "") + " " + (it.note || "")).toLowerCase();
      return hay.includes(pState.search);
    }

    function renderGrid() {
      grid.innerHTML = "";
      let list = pState.items.filter(matchesSearch);
      if (!pState.sortDesc) list = [...list].reverse();
      countLabel.textContent = pState.loading ? "Cargando..." : (pState.folder === "all" ? `${list.length} de ${totalCount}` : `${list.length} elemento(s)`);
      if (list.length === 0 && !pState.loading) {
        grid.appendChild(el("div", { class: "empty" }, "Sin contenido."));
        return;
      }
      for (const it of list) {
        const picked = selectedMedia.some((m) => m.id === String(it.id));
        let thumbInner;
        if (it.type === "audio") {
          thumbInner = el("div", { class: "content-item-thumb-empty content-item-audio-icon" }, "🎧");
        } else if (it.hasThumb) {
          const thumbUrl = `/api/accounts/${acc.id}/content-group/messages/${it.id}/thumb`;
          thumbInner = el("img", { src: thumbUrl, loading: "lazy", class: "content-item-thumb" });
          bindThumbRetry(thumbInner, thumbUrl, "🖼️");
        } else {
          thumbInner = el("div", { class: "content-item-thumb-empty" }, "🖼️");
        }
        const thumbWrap = el("div", { class: "content-item-thumb-wrap" }, thumbInner);
        if (it.type === "video") thumbWrap.appendChild(el("div", { class: "content-item-type-badge" }, "🎬"));
        if (it.type === "audio" && it.duration) thumbWrap.appendChild(el("div", { class: "content-item-type-badge" }, "🎧 " + fmtContentDuration(it.duration)));
        if (it.date) {
          const d = new Date(it.date);
          thumbWrap.appendChild(el("div", { class: "content-item-date-badge" }, d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })));
        }
        const card = el("div", { class: "content-item-card" + (picked ? " active" : "") }, thumbWrap);
        card.addEventListener("click", () => {
          const idx = selectedMedia.findIndex((m) => m.id === String(it.id));
          if (idx >= 0) {
            selectedMedia.splice(idx, 1);
          } else {
            if (max === 1) selectedMedia.length = 0;
            else if (selectedMedia.length >= max) { toast(`Máximo ${max} medios`, true); return; }
            selectedMedia.push({ id: String(it.id), caption: it.caption || "", type: it.type });
          }
          renderGrid();
        });
        grid.appendChild(card);
      }
    }

    async function loadPage(reset) {
      if (reset) { pState.items = []; pState.nextOffsetId = null; pState.hasMore = false; }
      pState.loading = true;
      renderGrid();
      loadMoreRow.innerHTML = "";
      try {
        let path;
        if (pState.folder === "favorites") {
          path = `/accounts/${acc.id}/content-group/favorites`;
        } else {
          const qs = new URLSearchParams();
          if (pState.typeFilter !== "all") qs.set("type", pState.typeFilter);
          if (pState.nextOffsetId) qs.set("offsetId", String(pState.nextOffsetId));
          path = pState.folder === "all"
            ? `/accounts/${acc.id}/content-group/all-items?${qs.toString()}`
            : `/accounts/${acc.id}/content-group/topics/${pState.folder}/items?${qs.toString()}`;
        }
        const res = await api(path);
        pState.items = pState.items.concat(res.items || []);
        pState.hasMore = !!res.hasMore;
        pState.nextOffsetId = res.nextOffsetId || null;
      } catch (err) {
        toast(err.message, true);
      } finally {
        pState.loading = false;
        renderGrid();
        loadMoreRow.innerHTML = "";
        if (pState.hasMore && pState.folder !== "favorites") {
          const moreBtn = el("button", { class: "ghost" }, "Cargar más contenido");
          moreBtn.addEventListener("click", () => loadPage(false));
          loadMoreRow.appendChild(moreBtn);
        }
      }
    }

    loadPage(true);

    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "primary", onclick: () => { onDone(); close(); } }, "Listo"),
    ]));
  }, { wide: true });
}

function guionStepMediaEl(account, step, onChange) {
  if (!step.media) step.media = [];
  const isAudio = step.type === "audio";
  const max = isAudio ? 1 : 10;
  const grid = el("div", { class: "content-items-grid" });

  function renderGrid() {
    grid.innerHTML = "";
    for (const m of step.media) {
      let thumbEl;
      if (m.type === "audio") {
        thumbEl = el("div", { class: "content-item-thumb-empty" }, "🎵");
      } else {
        const thumbUrl = `/api/accounts/${account.id}/content-group/messages/${m.id}/thumb`;
        thumbEl = el("img", { src: thumbUrl, loading: "lazy", class: "content-item-thumb" });
        bindThumbRetry(thumbEl, thumbUrl);
      }
      const thumbWrap = el("div", { class: "content-item-thumb-wrap" }, thumbEl);
      if (m.type === "video") thumbWrap.appendChild(el("div", { class: "content-item-type-badge" }, "🎬"));
      const removeBtn = el("button", { type: "button", class: "content-item-fav-btn", title: "Quitar" }, "×");
      thumbWrap.appendChild(removeBtn);
      removeBtn.addEventListener("click", () => {
        const idx = step.media.indexOf(m);
        if (idx >= 0) step.media.splice(idx, 1);
        renderGrid();
        onChange && onChange();
      });
      grid.appendChild(el("div", { class: "content-item-card" }, thumbWrap));
    }
    if (step.media.length < max) {
      const addBtn = el("div", {
        type: "button",
        class: "content-item-card",
        style: "cursor:pointer;align-items:center;justify-content:center;min-height:90px;font-size:22px",
      }, "+");
      addBtn.addEventListener("click", () => {
        openVaultPickerModal(account, step.media, () => { renderGrid(); onChange && onChange(); }, {
          max,
          typeFilter: isAudio ? "audio" : undefined,
        });
      });
      grid.appendChild(addBtn);
    }
  }
  renderGrid();
  return el("div", { class: "field" }, [
    el("label", {}, isAudio ? "Audio (elige de la bóveda)" : "Pack de fotos/vídeos (elige de la bóveda, hasta 10)"),
    grid,
  ]);
}

function guionStepCard(step, index, total, onRemove, onMove, account) {
  const typeLabel = GUION_STEP_TYPE_LABELS[step.type] || step.type;
  const controls = [
    step.type === "text" ? el("label", { class: "guion-step-premium" }, [
      el("input", {
        type: "checkbox",
        checked: step.premiumLetters ? "true" : null,
        onchange: (e) => { step.premiumLetters = e.target.checked; },
      }),
      " 😀 Letras premium",
    ]) : null,
    el("button", { type: "button", class: "ghost", disabled: index === 0 ? "true" : null, onclick: () => onMove(index, -1) }, "▲"),
    el("button", { type: "button", class: "ghost", disabled: index === total - 1 ? "true" : null, onclick: () => onMove(index, 1) }, "▼"),
    el("button", { type: "button", class: "ghost", onclick: () => onRemove(index) }, "✕"),
  ];

  const body = step.type === "text"
    ? el("textarea", {
        placeholder: "El mensaje tal como lo escribiría la modelo...",
        oninput: (e) => { step.text = e.target.value; },
      }, step.text || "")
    : guionStepMediaEl(account, step, null);

  return el("div", { class: "guion-step-card" }, [
    el("div", { class: "guion-step-header" }, [
      el("span", { class: "guion-step-number" }, String(index + 1)),
      el("span", { class: "guion-step-type" }, typeLabel),
      el("div", { class: "guion-step-controls" }, controls),
    ]),
    body,
  ]);
}

function openGuionModal(accounts, existing) {
  const account = accounts.find((a) => a.id === state.guionesAccountId);
  const steps = existing ? existing.steps.map((s) => ({ ...s })) : [{ type: "text", text: "", premiumLetters: false }];

  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, (existing ? "Editar guion" : "Nuevo guion") + " · " + (account ? account.label.toUpperCase() : "")));
    modal.appendChild(el("p", { class: "hint" },
      "Los pasos van en el orden en que el chatter los irá usando. Los textos se pegan en el cuadro de escribir; los packs y audios se envían tal cual."));

    const nameInput = el("input", { placeholder: "Ej. 1.88, Ducha completa...", value: existing?.name || "" });
    const categorySelect = el("select", {}, el("option", { value: "" }, "Sin categoría"));
    const priceInput = el("input", { type: "number", step: "0.01", placeholder: "—", value: existing?.price ?? "" });

    api(`/accounts/${state.guionesAccountId}/guiones-categories`).then((res) => {
      for (const c of res.categories) {
        categorySelect.appendChild(el("option", { value: c.id, selected: existing?.categoryId === c.id ? "true" : null }, c.name));
      }
    }).catch(() => {});

    modal.appendChild(el("div", { class: "guion-fields-row" }, [
      el("div", { class: "field" }, [el("label", {}, "Nombre"), nameInput]),
      el("div", { class: "field" }, [el("label", {}, "Categoría"), categorySelect]),
      el("div", { class: "field" }, [el("label", {}, "Precio orientativo (€)"), priceInput]),
    ]));

    modal.appendChild(el("div", { class: "hint", style: "margin-top:14px" }, "PASOS — EN ESTE ORDEN"));
    const stepsWrap = el("div", { class: "guion-steps-wrap" });
    modal.appendChild(stepsWrap);

    function renderSteps() {
      stepsWrap.innerHTML = "";
      steps.forEach((s, i) => {
        stepsWrap.appendChild(guionStepCard(s, i, steps.length,
          (idx) => { steps.splice(idx, 1); renderSteps(); },
          (idx, dir) => {
            const j = idx + dir;
            if (j < 0 || j >= steps.length) return;
            [steps[idx], steps[j]] = [steps[j], steps[idx]];
            renderSteps();
          },
          account
        ));
      });
    }
    renderSteps();

    const addTextBtn = el("button", { type: "button", class: "ghost" }, "💬 Texto");
    addTextBtn.addEventListener("click", () => { steps.push({ type: "text", text: "", premiumLetters: false }); renderSteps(); });
    const addPackBtn = el("button", { type: "button", class: "ghost" }, "🖼️ Pack de fotos/vídeos");
    addPackBtn.addEventListener("click", () => { steps.push({ type: "pack", media: [] }); renderSteps(); });
    const addAudioBtn = el("button", { type: "button", class: "ghost" }, "🎧 Audio");
    addAudioBtn.addEventListener("click", () => { steps.push({ type: "audio", media: [] }); renderSteps(); });
    modal.appendChild(el("div", { class: "guion-add-step-row" }, ["Añadir paso: ", addTextBtn, addPackBtn, addAudioBtn]));

    const saveBtn = el("button", { class: "primary" }, existing ? "Guardar cambios" : "Guardar guion");
    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { toast("Escribe el nombre del guion", true); return; }
      const body = {
        name,
        categoryId: categorySelect.value || null,
        price: priceInput.value === "" ? null : Number(priceInput.value),
        steps,
      };
      saveBtn.disabled = true;
      try {
        if (existing) {
          await api(`/guiones/${existing.id}`, { method: "PATCH", body: JSON.stringify(body) });
        } else {
          await api(`/accounts/${state.guionesAccountId}/guiones`, { method: "POST", body: JSON.stringify(body) });
        }
        close();
        await renderGuionesCategoriesNav(accounts);
        await renderGuionesList(accounts);
      } catch (err) {
        toast(err.message, true);
      } finally {
        saveBtn.disabled = false;
      }
    });
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      saveBtn,
    ]));
  }, { wide: true });
}

// ---------- Latido de actividad ("Horas trabajadas"): cada trabajador con
// sesión (Mensajes o Mensajes Pro) manda cada ~30s si ha interactuado
// desde el último latido y si en ese momento tenía fans sin leer, para que
// Informes → Horas trabajadas pueda reconstruir sesiones/inactividad. No
// se manda nada si nadie ha iniciado sesión como trabajador (el dueño con
// Basic Auth no manda latidos, no hace falta). ----------

let lastWorkerActivityAt = Date.now();
document.addEventListener("click", () => { lastWorkerActivityAt = Date.now(); });
document.addEventListener("keydown", () => { lastWorkerActivityAt = Date.now(); });

let workerHeartbeatTimer = null;
function startWorkerHeartbeat(accountIds) {
  if (workerHeartbeatTimer) return; // ya esta corriendo para esta sesión
  const send = async () => {
    let hasUnreadFans = false;
    try {
      const results = await Promise.all(
        (accountIds || []).map((id) => fetch(`/api/accounts/${id}/unread-summary`, { headers: { "Content-Type": "application/json" } }).then((r) => r.json()).catch(() => ({ relevantUnread: 0 })))
      );
      // relevantUnread ya deja fuera a los fans en carpetas como "SFS" o
      // "Time Waster" (ver /unread-summary en messages.ts) - solo cuenta
      // Posibles/Clientes/sin carpeta, que es lo que de verdad importa para
      // "¿el chatter tiene a alguien esperando respuesta?".
      hasUnreadFans = results.some((r) => (r.relevantUnread ?? r.totalUnread ?? 0) > 0);
    } catch {
      // si falla, simplemente se manda el latido sin ese dato
    }
    const active = Date.now() - lastWorkerActivityAt < 35000;
    fetch("/api/workers/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active, hasUnreadFans, view: state.currentView, accountId: state.currentAccountId || null }),
    }).catch(() => {});
  };
  send();
  workerHeartbeatTimer = setInterval(send, 30000);
}

// ---------- Configuración → Equipo (trabajadores con acceso limitado, al
// estilo del apartado "Empleados" de TeleCrew, sin compartir el número de
// Telegram de ninguna modelo) ----------

const WORKER_ROLE_LABELS = { admin: "Team líder", worker: "Chatter" };

const WORKER_EXTRA_PERMISSIONS = [
  { key: "vaultScreenshots", label: "Permitir capturas de pantalla también en la bóveda" },
  { key: "scheduleContent", label: "Subir/programar historias y posts" },
  { key: "quickReplies", label: "Añadir/editar respuestas rápidas" },
  { key: "sfsPackages", label: "Crear/editar/borrar paquetes SFS" },
  { key: "scripts", label: "Crear/editar/borrar guiones (Scripts)" },
];

const WEEKDAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

async function renderEquipoSection() {
  appEl.appendChild(el("h1", {}, "Equipo"));
  appEl.appendChild(el("p", { class: "subtitle" }, "Da acceso a trabajadoras/chatters solo a Mensajes y la bóveda (SFS), cuenta por cuenta, sin compartir el número de Telegram de la modelo."));

  // Gestionar el equipo es cosa únicamente de la cuenta luxe (la sesión de
  // /login de siempre, no un login de empleado aparte). Esta pantalla ni
  // siquiera debería ser alcanzable por un empleado (se queda con el panel
  // reducido a Mensajes/Mensajes Pro, ver renderWorkerRestrictedShell), pero
  // se deja este aviso por si acaso.
  if (!state.ownerSessionCookie) {
    const card = el("div", { class: "card" }, [
      el("p", {}, "Solo el dueño puede gestionar el equipo."),
    ]);
    appEl.appendChild(card);
    return;
  }

  const listWrap = el("div", { class: "scripts-manage-list" });
  const addBtn = el("button", { class: "primary" }, "+ Añadir empleado");
  appEl.appendChild(el("div", { class: "section-title-row" }, [el("h2", {}, "Empleados"), addBtn]));
  appEl.appendChild(listWrap);

  let accountsForPerms = state.accounts;
  async function ensureAccounts() {
    if (accountsForPerms && accountsForPerms.length > 0) return accountsForPerms;
    try {
      const res = await api("/accounts");
      accountsForPerms = res.accounts;
    } catch {
      accountsForPerms = [];
    }
    return accountsForPerms;
  }

  // Fila fija del Dueño/Jefe (la cuenta luxe): no es una fila de Worker de
  // verdad -no tiene permisos que conceder, ni se puede borrar ni
  // restablecer su contraseña desde aquí, ver /login-, así que se pinta
  // aparte, siempre la primera, solo para que quede claro en esta pantalla
  // que hay 3 roles (Dueño/Jefe, Team líder, Chatter) y no solo 2.
  function ownerRow() {
    return el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto auto auto;align-items:center" }, [
      el("div", {}, [
        el("div", { style: "font-weight:700;letter-spacing:0.02em" }, [
          (state.ownerName || "El dueño").toUpperCase() + " ",
          el("span", { class: "pill ok" }, "Dueño/Jefe"),
        ]),
        el("div", { class: "hint" }, "Acceso completo a todo el panel - se gestiona con las credenciales de /login, no desde aquí."),
      ]),
    ]);
  }

  async function refresh() {
    listWrap.innerHTML = "";
    listWrap.appendChild(ownerRow());
    listWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    let workers;
    try {
      const res = await api("/workers");
      workers = res.workers;
    } catch (err) {
      listWrap.innerHTML = "";
      listWrap.appendChild(ownerRow());
      listWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }
    listWrap.innerHTML = "";
    listWrap.appendChild(ownerRow());
    if (workers.length === 0) {
      listWrap.appendChild(el("div", { class: "empty" }, "Todavía no hay empleados dados de alta."));
    }
    const accounts = await ensureAccounts();
    for (const w of workers) {
      const grantedAccounts = [...new Set(w.permissions.map((p) => p.accountLabel))];

      const permsBtn = el("button", {}, "Permisos");
      permsBtn.addEventListener("click", () => openWorkerPermissionsModal(w, accounts, refresh));

      const resetBtn = el("button", {}, "Restablecer contraseña");
      resetBtn.addEventListener("click", () => openResetWorkerPasswordModal(w));

      // "Rendimiento personal" del dueño/jefe (ver openWorkerPerformanceModal
      // más abajo): mismos datos que "Mi rendimiento" del propio trabajador,
      // pero de este trabajador en concreto y en una ventana aparte, sin
      // salir de Equipo.
      const perfBtn = el("button", {}, "Rendimiento");
      perfBtn.addEventListener("click", () => openWorkerPerformanceModal(w.id, w.name));

      const delBtn = el("button", { class: "danger" }, "Borrar");
      delBtn.addEventListener("click", async () => {
        const ok = await confirmModal({ title: "Eliminar empleado", body: `¿Quitar a "${w.name}" (${w.email}) del equipo? Perderá el acceso al momento.`, confirmLabel: "Eliminar", danger: true });
        if (!ok) return;
        try {
          await api(`/workers/${w.id}`, { method: "DELETE" });
          toast("Empleado eliminado");
          await refresh();
        } catch (err) {
          toast(err.message, true);
        }
      });

      listWrap.appendChild(el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto auto auto auto;align-items:center" }, [
        el("div", {}, [
          el("div", { style: "font-weight:700;letter-spacing:0.02em" }, [
            w.name.toUpperCase() + " ",
            el("span", { class: "pill" }, WORKER_ROLE_LABELS[w.role] || w.role),
            w.active ? null : el("span", { class: "pill off", style: "margin-left:6px" }, "Desactivado"),
          ]),
          el("div", { class: "hint" }, w.email),
          el("div", { class: "hint" }, grantedAccounts.length > 0 ? grantedAccounts.join(", ") : "Sin cuentas concedidas todavía"),
        ]),
        perfBtn,
        resetBtn,
        permsBtn,
        delBtn,
      ]));
    }
  }

  addBtn.addEventListener("click", async () => openCreateWorkerModal(await ensureAccounts(), refresh));

  await refresh();
}

// ---------- Configuración → Seguridad (avisos de intento de captura de
// pantalla, ver desktop/ + src/api/security.ts) ----------

let securityStreamEs = null;

function fmtCaptureAttemptWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES") + " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function captureAttemptRow(a) {
  const icon = a.kind === "no_clock_in" ? "⏱️" : "📸";
  const label = a.kind === "no_clock_in" ? "sin fichar, activo en" : "intento de captura en";
  return el("div", { class: "sale-row" }, [
    el("div", { class: "sale-row-main" }, [
      el("div", { class: "sale-amount" }, `${icon} ${a.workerName} — ${label} ${a.view}`),
      el("div", { class: "sale-meta" }, fmtCaptureAttemptWhen(a.at)),
    ]),
  ]);
}

async function renderSeguridadSection() {
  appEl.appendChild(el("h1", {}, "Seguridad"));
  appEl.appendChild(el("p", { class: "subtitle" },
    "Avisos de intento de captura de pantalla desde la app de escritorio de tu equipo, y de trabajadores activos en el CRM sin haber fichado la entrada. Las capturas solo se detectan cuando el trabajador usa la app instalada (ver Equipo → Permisos, \"Puede entrar también desde el navegador\")."));

  const liveBanner = el("div", { class: "hidden" });
  appEl.appendChild(liveBanner);
  function flashLiveAttempt(a) {
    liveBanner.innerHTML = "";
    liveBanner.classList.remove("hidden");
    const isNoClockIn = a.kind === "no_clock_in";
    liveBanner.appendChild(el("div", { class: "card", style: "border-color:#e0455f" }, [
      el("div", { style: "font-weight:700" }, isNoClockIn ? "⏱️ Sin fichar, activo justo ahora" : "⚠️ Intento de captura justo ahora"),
      el("div", {}, `${a.workerName} — ${a.view} — ${fmtCaptureAttemptWhen(a.at)}`),
    ]));
    toast(isNoClockIn
      ? `⏱️ ${a.workerName} lleva más de 3 min en "${a.view}" sin fichar`
      : `⚠️ ${a.workerName} intentó capturar la pantalla en "${a.view}"`, true);
  }

  const listEl = el("div", { class: "pd-history-list" }, el("div", { class: "empty" }, "Cargando..."));
  appEl.appendChild(el("div", { class: "section-title-row" }, [el("h2", {}, "Historial reciente")]));
  appEl.appendChild(listEl);

  async function load() {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const [{ attempts }, { alerts }] = await Promise.all([
        api("/security/capture-attempts"),
        api("/security/no-clock-in-alerts"),
      ]);
      const all = [...attempts, ...alerts].sort((a, b) => new Date(b.at) - new Date(a.at));
      listEl.innerHTML = "";
      if (all.length === 0) {
        listEl.appendChild(el("div", { class: "empty" }, "Ningún aviso registrado todavía."));
        return;
      }
      for (const a of all) listEl.appendChild(captureAttemptRow(a));
    } catch (err) {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }
  await load();

  // Aviso en vivo mientras se tiene esta pantalla abierta - se cierra el
  // EventSource anterior si se vuelve a entrar aquí, para no acumular
  // conexiones sueltas.
  if (securityStreamEs) { try { securityStreamEs.close(); } catch { /* ya cerrado */ } }
  securityStreamEs = new EventSource(`${API_BASE}/security/stream`);
  securityStreamEs.onmessage = (ev) => {
    try {
      const a = JSON.parse(ev.data);
      flashLiveAttempt(a);
      load();
    } catch { /* evento raro, se ignora */ }
  };
}

function showGeneratedPasswordModal(worker, password) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Acceso de " + worker.name));
    modal.appendChild(el("p", { class: "hint" }, "Todavía no hay envío de correo de invitación configurado en el panel, así que comparte esto a mano (por ejemplo por Telegram o WhatsApp). La persona podrá cambiarla en cuanto entre."));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Email"), el("input", { value: worker.email, readonly: "readonly" })]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Contraseña temporal"), el("input", { value: password, readonly: "readonly" })]));
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "primary", onclick: close }, "Listo")]));
  });
}

function openCreateWorkerModal(accounts, onDone) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Añadir empleado"));
    modal.appendChild(el("p", { class: "hint" }, "Se le crea un acceso propio (email + contraseña), sin tocar ninguna cuenta de Telegram ni compartir el número de la modelo."));

    const nameInput = el("input", { placeholder: "Nombre" });
    const emailInput = el("input", { type: "email", placeholder: "Correo electrónico" });
    const roleSelect = el("select", {}, [
      el("option", { value: "worker" }, "Chatter"),
      el("option", { value: "admin" }, "Team líder (ve y gestiona todo, como el dueño)"),
    ]);

    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre"), nameInput]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Correo electrónico"), emailInput]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Rol"), roleSelect]));

    modal.appendChild(el("div", { class: "config-group-title" }, "Cuentas a las que tiene acceso"));
    const accountCbs = [];
    const accountsBox = el("div", { class: "field" });
    if (accounts.length === 0) {
      accountsBox.appendChild(el("div", { class: "empty" }, "No hay cuentas de Telegram dadas de alta todavía."));
    } else {
      for (const acc of accounts) {
        const cb = el("input", { type: "checkbox" });
        accountCbs.push({ accountId: acc.id, cb });
        accountsBox.appendChild(el("label", { class: "checkbox-row" }, [cb, acc.label]));
      }
    }
    modal.appendChild(accountsBox);

    const saveBtn = el("button", { class: "primary" }, "Añadir empleado");
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      saveBtn,
    ]));

    saveBtn.addEventListener("click", async () => {
      if (!nameInput.value.trim() || !emailInput.value.trim()) { toast("Escribe el nombre y el email", true); return; }
      saveBtn.disabled = true;
      const accountIds = accountCbs.filter((c) => c.cb.checked).map((c) => c.accountId);
      try {
        const res = await api("/workers", {
          method: "POST",
          body: JSON.stringify({ name: nameInput.value, email: emailInput.value, role: roleSelect.value, accountIds }),
        });
        toast("Empleado añadido");
        close();
        await onDone();
        if (res.generatedPassword) showGeneratedPasswordModal(res.worker, res.generatedPassword);
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
      }
    });
  });
}

function openResetWorkerPasswordModal(worker) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Restablecer contraseña · " + worker.name));
    modal.appendChild(el("p", { class: "hint" }, "Se genera una contraseña temporal nueva. La de ahora deja de funcionar en el momento."));
    const genBtn = el("button", { class: "primary" }, "Generar contraseña nueva");
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      genBtn,
    ]));
    genBtn.addEventListener("click", async () => {
      genBtn.disabled = true;
      try {
        const res = await api(`/workers/${worker.id}`, { method: "PUT", body: JSON.stringify({ generatePassword: true }) });
        close();
        if (res.generatedPassword) showGeneratedPasswordModal(worker, res.generatedPassword);
      } catch (err) {
        toast(err.message, true);
        genBtn.disabled = false;
      }
    });
  });
}

function openWorkerPermissionsModal(worker, accounts, onDone) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Permisos de " + worker.name.toUpperCase()));

    const roleSelect = el("select", {}, [
      el("option", { value: "worker" }, "Chatter"),
      el("option", { value: "admin" }, "Team líder (ve y gestiona todo, como el dueño)"),
    ]);
    roleSelect.value = worker.role;
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Rol:"), roleSelect]));

    // "Solo app de escritorio" por defecto (ver desktop/ + Seguridad): sin
    // marcar esta casilla, este trabajador solo puede entrar desde la app
    // instalada, nunca desde un navegador normal (Chrome, Safari...) - así
    // funcionan de verdad el bloqueo/aviso de capturas de pantalla. Se marca
    // solo si de verdad necesita entrar también desde un navegador (p.ej.
    // móvil sin la app todavía).
    const canUseBrowserCb = el("input", { type: "checkbox" });
    canUseBrowserCb.checked = !!worker.canUseBrowser;
    modal.appendChild(el("label", { class: "checkbox-row" }, [canUseBrowserCb, "Puede entrar también desde el navegador (no solo desde la app de escritorio)"]));

    // "Solo lectura": puede ver todo lo de siempre pero no puede hacer
    // ningún cambio (ni enviar mensajes, ni registrar ventas, ni fichar, ni
    // programar nada) - se bloquea en un único sitio en el servidor
    // (cualquier método que no sea GET), así que esta casilla cubre
    // absolutamente todo sin tener que marcar nada más.
    const readOnlyCb = el("input", { type: "checkbox" });
    readOnlyCb.checked = !!worker.readOnly;
    modal.appendChild(el("label", { class: "checkbox-row" }, [readOnlyCb, "Solo lectura: puede ver, pero no puede tocar ni cambiar nada"]));

    modal.appendChild(el("div", { class: "config-group-title" }, "Cuentas a las que tiene acceso:"));
    if (accounts.length === 0) {
      modal.appendChild(el("div", { class: "empty" }, "No hay cuentas de Telegram dadas de alta todavía."));
    }
    const existingAccountIds = new Set(worker.permissions.map((p) => p.accountId));
    const accountCbs = [];
    const accountsBox = el("div", { class: "field" });
    for (const acc of accounts) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = existingAccountIds.has(acc.id);
      accountCbs.push({ accountId: acc.id, accountLabel: acc.label, cb });
      accountsBox.appendChild(el("label", { class: "checkbox-row" }, [cb, acc.label]));
    }
    modal.appendChild(accountsBox);

    // "Días y modelos": solo un aviso visual (no quita acceso) de que cuenta
    // le toca cada día, igual que en TeleCrew. Se guarda para poder
    // enseñarlo, pero de momento no bloquea nada por sí solo.
    const schedule = { ...(worker.schedule || {}) };
    const scheduleBody = el("div", { class: "equipo-schedule-body hidden" });
    const scheduleToggle = el("div", { class: "config-nav-item", style: "cursor:pointer;user-select:none" }, "▸ DÍAS Y MODELOS");
    let scheduleOpen = false;
    scheduleToggle.addEventListener("click", () => {
      scheduleOpen = !scheduleOpen;
      scheduleToggle.textContent = (scheduleOpen ? "▾ " : "▸ ") + "DÍAS Y MODELOS";
      scheduleBody.classList.toggle("hidden", !scheduleOpen);
    });
    modal.appendChild(scheduleToggle);
    scheduleBody.appendChild(el("p", { class: "hint" }, "Marca qué cuentas le tocan cada día. Es solo un aviso: si entra en una cuenta que hoy no le toca, no se le quita el acceso."));
    for (const day of WEEKDAYS) {
      const dayChats = new Set(schedule[day] || []);
      const row = el("div", { class: "config-group-title" }, day);
      scheduleBody.appendChild(row);
      const chipsRow = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px" });
      for (const acc of accounts) {
        const chip = el("button", { class: "tab" + (dayChats.has(acc.id) ? " active" : ""), type: "button" }, acc.label);
        chip.addEventListener("click", () => {
          if (dayChats.has(acc.id)) dayChats.delete(acc.id); else dayChats.add(acc.id);
          schedule[day] = [...dayChats];
          chip.classList.toggle("active", dayChats.has(acc.id));
        });
        chipsRow.appendChild(chip);
      }
      scheduleBody.appendChild(chipsRow);
    }
    modal.appendChild(scheduleBody);

    // "Excepciones puntuales": permisos finos además de Mensajes/SFS, tal
    // cual TeleCrew. Se guardan ya (para no perder lo marcado), aunque de
    // momento el resto del panel todavía no las comprueba una a una.
    modal.appendChild(el("div", { class: "config-group-title" }, "Excepciones puntuales para este empleado:"));
    const extraPerms = { ...(worker.extraPermissions || {}) };
    const extraCbs = [];
    for (const p of WORKER_EXTRA_PERMISSIONS) {
      const cb = el("input", { type: "checkbox" });
      cb.checked = !!extraPerms[p.key];
      extraCbs.push({ key: p.key, cb });
      modal.appendChild(el("label", { class: "checkbox-row" }, [cb, p.label]));
    }

    const saveBtn = el("button", { class: "primary" }, "Guardar permisos");
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      saveBtn,
    ]));

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const permissions = [];
      const grantingSfs = roleSelect.value === "admin"; // SFS y Programar posts son solo para Team líder, nunca para un Chatter
      for (const c of accountCbs) {
        if (c.cb.checked) {
          permissions.push({ accountId: c.accountId, section: "mensajes" });
          if (grantingSfs) {
            permissions.push({ accountId: c.accountId, section: "sfs" });
            permissions.push({ accountId: c.accountId, section: "programar-posts" });
          }
          permissions.push({ accountId: c.accountId, section: "mensajes-pro" });
        }
      }
      const nextExtraPermissions = {};
      for (const c of extraCbs) nextExtraPermissions[c.key] = c.cb.checked;
      try {
        await api(`/workers/${worker.id}/permissions`, { method: "PUT", body: JSON.stringify({ permissions }) });
        await api(`/workers/${worker.id}`, {
          method: "PUT",
          body: JSON.stringify({ role: roleSelect.value, schedule, extraPermissions: nextExtraPermissions, canUseBrowser: canUseBrowserCb.checked, readOnly: readOnlyCb.checked }),
        });
        toast("Permisos guardados");
        close();
        await onDone();
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
      }
    });
  }, { wide: true });
}

// ---------- Configuración → Modelos (hub estilo TeleCrew: lista de
// creadoras + panel de configuración de la seleccionada) ----------

// Recuerda la última creadora seleccionada mientras dura la sesión del
// navegador, para no perder el sitio al cambiar de subapartado y volver.
let modelosSelectedId = null;

async function renderModelosSection() {
  appEl.appendChild(el("h1", {}, "Modelos"));
  appEl.appendChild(el("p", { class: "subtitle" }, "Selecciona una creadora para ver y editar su configuración."));

  let accounts;
  try {
    const res = await api("/accounts");
    accounts = res.accounts;
    state.accounts = accounts;
  } catch (err) {
    appEl.appendChild(el("div", { class: "card" }, "Error cargando modelos: " + err.message));
    return;
  }
  if (accounts.length === 0) {
    appEl.appendChild(el("div", { class: "empty" }, "Sin modelos todavía. Añade una cuenta desde \"Cuentas de Telegram\"."));
    return;
  }
  if (!modelosSelectedId || !accounts.some((a) => a.id === modelosSelectedId)) {
    modelosSelectedId = accounts[0].id;
  }

  const hub = el("div", { class: "modelos-hub" });
  const listEl = el("div", { class: "modelos-list" });
  const detailEl = el("div", { class: "modelos-detail" });
  hub.appendChild(listEl);
  hub.appendChild(detailEl);
  appEl.appendChild(hub);

  function renderList() {
    listEl.innerHTML = "";
    for (const acc of accounts) {
      const dotClass = statusDotClass(acc);
      listEl.appendChild(el("div", {
        class: "modelos-list-item" + (acc.id === modelosSelectedId ? " active" : ""),
        onclick: () => {
          if (modelosSelectedId === acc.id) return;
          modelosSelectedId = acc.id;
          renderList();
          renderDetail();
        },
      }, [
        accountAvatarEl(acc.id, acc.label),
        el("div", { class: "modelos-list-item-info" }, [
          el("div", { class: "modelos-list-item-name" }, acc.label),
          el("div", { class: "modelos-list-item-phone" }, acc.phoneNumber),
        ]),
        el("div", { class: "status-dot " + dotClass, title: statusDotTitle(acc) }),
      ]));
    }
  }

  function renderDetail() {
    detailEl.innerHTML = "";
    const acc = accounts.find((a) => a.id === modelosSelectedId);
    if (!acc) return;
    detailEl.appendChild(renderModeloDetailPanel(acc));
  }

  renderList();
  renderDetail();
}

function renderModeloDetailPanel(acc) {
  const wrap = el("div", { class: "modelos-detail-inner" });

  const pillClass = !acc.reenviadorEnabled ? "off" : acc.health === "PEER_FLOOD_PAUSED" ? "danger" : "ok";
  const pillText = !acc.reenviadorEnabled ? "Apagado" : acc.health === "PEER_FLOOD_PAUSED" ? "Pausado por PeerFlood" : "Encendido";

  wrap.appendChild(el("div", { class: "modelos-detail-header" }, [
    accountAvatarEl(acc.id, acc.label),
    el("div", { class: "modelos-detail-header-info" }, [
      el("h2", {}, acc.label),
      el("div", { class: "hint" }, `${acc.phoneNumber} · ${acc.timezone}`),
    ]),
    el("span", { class: "pill " + pillClass }, [el("span", { class: "dot" }), pillText]),
  ]));

  // 1) Notas de la modelo
  wrap.appendChild(renderAutosaveTextCard({
    title: "Notas de la modelo",
    hint: "Info general de esta cuenta/modelo (forma de pago, horarios, preferencias...), visible en todas sus conversaciones.",
    placeholder: "Info general de la modelo...",
    rows: 8,
    load: () => api(`/accounts/${acc.id}/note`).then((r) => r.note || ""),
    save: (value) => api(`/accounts/${acc.id}/note`, { method: "PUT", body: JSON.stringify({ note: value }) }),
  }));

  // 2) Precios
  wrap.appendChild(renderAutosaveTextCard({
    title: "Precios",
    hint: "Tarifas y paquetes de esta modelo, siempre a mano para cualquier chatter que la atienda.",
    placeholder: "Ej: Custom foto 10€ · Custom vídeo 20€ · Videollamada 15 min 40€...",
    rows: 8,
    load: () => api(`/accounts/${acc.id}/prices`).then((r) => r.prices || ""),
    save: (value) => api(`/accounts/${acc.id}/prices`, { method: "PUT", body: JSON.stringify({ prices: value }) }),
  }));

  // 3) Canales free
  wrap.appendChild(renderFreeChannelsCard(acc));

  // 4) SFS (intercambios con otras modelos): paquetes con medios de la
  // bóveda de esta cuenta + texto, listos para mandar en un clic. El envío
  // en un clic desde el chat y la publicación de un SFS recibido (⋮ →
  // "Publicar como SFS") quedan para cuando esto esté configurado y probado.
  wrap.appendChild(renderSfsPackagesCard(acc));

  // 5) Captura real de SFS: lo dejamos parado de momento (según lo hablado,
  // es un flujo distinto — la prueba de que el SFS pactado con otra modelo
  // se ha cumplido, no la vinculación de la cuenta).
  const captureCard = el("div", { class: "card" });
  captureCard.appendChild(el("h3", {}, "Captura real de SFS"));
  captureCard.appendChild(el("p", { class: "hint" },
    "Prueba de que se han cumplido las visitas acordadas de un SFS pactado con otra modelo (ej. \"SFS 100 visitas\" en el canal free)."));
  captureCard.appendChild(el("div", { class: "hint", style: "margin-top:6px" }, "Parado de momento."));
  wrap.appendChild(captureCard);

  // 6) Respuestas rápidas
  wrap.appendChild(renderQuickRepliesCard(acc));

  // 7) Emoji premium
  const emojiCard = el("div", { class: "card" });
  emojiCard.appendChild(el("h3", {}, "Emoji premium"));
  emojiCard.appendChild(el("p", { class: "hint" }, "Sets de emoji animados de Telegram (hasta 5) para usar en el chat. Solo se ven animados de verdad si esta cuenta tiene Telegram Premium."));
  const emojiBtn = el("button", {}, "Configurar emoji premium...");
  emojiBtn.addEventListener("click", () => openEmojiPacksModal(acc.id, acc.label));
  emojiCard.appendChild(emojiBtn);
  wrap.appendChild(emojiCard);

  // 8) Bloqueo automático por país
  wrap.appendChild(renderBlockedCountriesCard(acc));

  // 9) Carpetas de Telegram (sincronizar + excluir), Grupos restringidos
  // (cuenta ayudante), Bóveda de contenido, Colorear por carpeta e
  // Importar ventas / restaurar.
  wrap.appendChild(renderFolderSyncCard(acc));
  wrap.appendChild(renderRestrictedGroupHelperCard(acc));
  wrap.appendChild(renderExcludedFoldersCard(acc));
  wrap.appendChild(renderContentGroupCard(acc));

  const colorCard = el("div", { class: "card" });
  colorCard.appendChild(el("h3", {}, "Colorear por carpeta en \"Todos los medios\""));
  colorCard.appendChild(el("p", { class: "hint" }, "Útil con pocas carpetas. Con muchas, los colores se parecen entre sí y puede ser mejor desactivarlo."));
  const colorToggle = el("label", { class: "switch" }, [el("input", { type: "checkbox" }), el("span", { class: "slider" })]);
  const colorInput = colorToggle.querySelector("input");
  colorInput.checked = !!acc.contentColorByFolder;
  colorInput.addEventListener("change", async () => {
    colorInput.disabled = true;
    try {
      await api(`/accounts/${acc.id}/content-color-by-folder`, { method: "PUT", body: JSON.stringify({ enabled: colorInput.checked }) });
      toast("Guardado");
    } catch (err) {
      toast(err.message, true);
      colorInput.checked = !colorInput.checked;
    } finally {
      colorInput.disabled = false;
    }
  });
  colorCard.appendChild(colorToggle);
  wrap.appendChild(colorCard);

  const restoreCard = el("div", { class: "card" });
  restoreCard.appendChild(el("h3", {}, "Importar ventas / restaurar fans"));
  restoreCard.appendChild(el("p", { class: "hint" },
    "Es lo mismo que Cuentas de Telegram → tarjeta de la modelo → «♻️ Restaurar». Admite la copia de fans y los Excel viejos de «Exportar clientes»: recupera notas, listas y ventas sin duplicar, y los fans que aún no escribieron quedan en espera hasta que escriban."));
  restoreCard.appendChild(el("button", { onclick: () => toast("\"Restaurar\" estará disponible próximamente") }, "♻️ Restaurar desde copia..."));
  wrap.appendChild(restoreCard);

  return wrap;
}

/** Tarjeta de texto libre con autoguardado (indicador Guardando.../Guardado), reutilizable. */
function renderAutosaveTextCard({ title, hint, placeholder, rows, load, save }) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, title));
  if (hint) card.appendChild(el("p", { class: "hint" }, hint));
  const textarea = el("textarea", { rows: String(rows || 8), placeholder: placeholder || "" });
  const savedLabel = el("div", { class: "save-indicator" }, "");
  card.appendChild(el("div", { class: "field" }, [textarea, savedLabel]));

  let saveTimer = null;
  let loaded = false;
  async function doSave() {
    try {
      await save(textarea.value);
      savedLabel.textContent = "Guardado";
    } catch (err) {
      savedLabel.textContent = "Error al guardar";
    }
  }
  textarea.addEventListener("input", () => {
    if (!loaded) return;
    savedLabel.textContent = "Guardando...";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 900);
  });
  textarea.addEventListener("blur", () => {
    if (!loaded) return;
    clearTimeout(saveTimer);
    doSave();
  });

  load()
    .then((value) => {
      textarea.value = value;
      loaded = true;
      savedLabel.textContent = "Guardado";
    })
    .catch(() => { loaded = true; });

  return card;
}

/** Tarjeta "Canales free" del panel de una modelo: lista los canales configurados y abre el modal de búsqueda/gestión. */
function renderFreeChannelsCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Canales free"));
  card.appendChild(el("p", { class: "hint" },
    "Canales de Telegram de esta modelo con solicitud de unión activada. Las solicitudes pendientes de los canales que añadas aquí se podrán aceptar o rechazar sin salir del panel, desde \"Canales free\" en el menú."));
  const listEl = el("div", { class: "chip-list" });
  card.appendChild(listEl);
  const configBtn = el("button", {}, "Configurar canales...");
  card.appendChild(configBtn);

  async function refresh() {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const { channels } = await api(`/accounts/${acc.id}/free-channels`);
      listEl.innerHTML = "";
      if (channels.length === 0) {
        listEl.appendChild(el("div", { class: "empty" }, "Sin canales free configurados todavía."));
        return;
      }
      for (const c of channels) {
        const label = c.pendingCount ? `${c.title} · ${c.pendingCount} pendientes` : c.title;
        listEl.appendChild(el("div", { class: "chip" }, label));
      }
    } catch (err) {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  configBtn.addEventListener("click", () => openFreeChannelsConfigModal(acc, refresh));
  refresh();
  return card;
}

/** Modal de "Configurar canales..." de una modelo: buscar canales/grupos de Telegram de esa cuenta, añadirlos o quitarlos. */
function openFreeChannelsConfigModal(acc, onChange) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Canales free de " + acc.label));
    modal.appendChild(el("div", { class: "hint" },
      "Todos los canales/grupos de esta cuenta con solicitud de unión activada (Ajustes del canal → Miembros → Aprobar nuevos miembros). Los que llevan el nombre de la modelo aparecen primero."));

    const currentListEl = el("div", { class: "scripts-manage-list" });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Canales configurados"), currentListEl]));

    const searchInput = el("input", { placeholder: "Filtrar por nombre..." });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Añadir canal"), searchInput]));
    const resultsEl = el("div", { class: "scripts-manage-list" });
    modal.appendChild(resultsEl);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cerrar")]));

    async function refreshCurrent() {
      currentListEl.innerHTML = "";
      currentListEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const { channels } = await api(`/accounts/${acc.id}/free-channels`);
        currentListEl.innerHTML = "";
        if (channels.length === 0) {
          currentListEl.appendChild(el("div", { class: "empty" }, "Sin canales todavía."));
        }
        for (const c of channels) {
          const delBtn = el("button", { class: "danger" }, "Eliminar");
          delBtn.addEventListener("click", async () => {
            const ok = await confirmModal({ title: "Quitar canal", body: `¿Quitar "${c.title}" de los canales free?`, confirmLabel: "Quitar", danger: true });
            if (!ok) return;
            try {
              await api(`/free-channels/${c.id}`, { method: "DELETE" });
              toast("Canal quitado");
              await refreshCurrent();
              onChange();
            } catch (err) {
              toast(err.message, true);
            }
          });
          currentListEl.appendChild(el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto" }, [
            el("div", {}, c.title),
            delBtn,
          ]));
        }
      } catch (err) {
        currentListEl.innerHTML = "";
        currentListEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    let allResults = [];
    const modelNameLower = (acc.label || "").toLowerCase();

    function renderResults(q) {
      resultsEl.innerHTML = "";
      const s = (q || "").trim().toLowerCase();
      const filtered = s ? allResults.filter((r) => r.title.toLowerCase().includes(s)) : allResults;
      if (filtered.length === 0) {
        resultsEl.appendChild(el("div", { class: "empty" }, "Sin resultados."));
        return;
      }
      // Recomendados primero: los que llevan el nombre de la modelo en el título.
      const sorted = [...filtered].sort((a, b) => {
        const aMatch = modelNameLower && a.title.toLowerCase().includes(modelNameLower) ? 0 : 1;
        const bMatch = modelNameLower && b.title.toLowerCase().includes(modelNameLower) ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return a.title.localeCompare(b.title, "es");
      });
      for (const r of sorted) {
        const addBtn = el("button", { class: "primary" }, "+ Añadir");
        addBtn.addEventListener("click", async () => {
          addBtn.disabled = true;
          try {
            await api(`/accounts/${acc.id}/free-channels`, { method: "POST", body: JSON.stringify({ chatId: r.chatId, title: r.title }) });
            toast("Canal añadido");
            await refreshCurrent();
            onChange();
          } catch (err) {
            toast(err.message, true);
            addBtn.disabled = false;
          }
        });
        const recommended = modelNameLower && r.title.toLowerCase().includes(modelNameLower);
        resultsEl.appendChild(el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto" }, [
          el("div", {}, recommended ? [r.title, " ", el("span", { class: "hint" }, "★ recomendado")] : r.title),
          addBtn,
        ]));
      }
    }

    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderResults(searchInput.value), 200);
    });

    async function loadAll() {
      resultsEl.innerHTML = "";
      resultsEl.appendChild(el("div", { class: "empty" }, "Cargando canales..."));
      try {
        const { results } = await api(`/accounts/${acc.id}/free-channels/search`);
        allResults = results;
        renderResults(searchInput.value);
      } catch (err) {
        resultsEl.innerHTML = "";
        resultsEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    loadAll();
    refreshCurrent();
  }, { wide: true });
}

// ---------- Respuestas rápidas ----------

function renderQuickRepliesCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Respuestas rápidas"));
  card.appendChild(el("p", { class: "hint" }, "Textos hechos para que las chatters los manden con un clic desde el chat."));
  const configBtn = el("button", {}, "Configurar respuestas rápidas...");
  configBtn.addEventListener("click", () => openQuickRepliesModal(acc));
  card.appendChild(configBtn);
  return card;
}

function openQuickRepliesModal(acc) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Respuestas rápidas de " + acc.label));
    const listEl = el("div", { class: "scripts-manage-list" });
    modal.appendChild(listEl);
    const input = el("textarea", { rows: "3", placeholder: "Escribe el texto de la respuesta..." });
    const addBtn = el("button", { class: "primary" }, "+ Añadir");
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Nueva respuesta"), input]));
    modal.appendChild(addBtn);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cerrar")]));

    async function refresh() {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const { replies } = await api(`/accounts/${acc.id}/quick-replies`);
        listEl.innerHTML = "";
        if (replies.length === 0) {
          listEl.appendChild(el("div", { class: "empty" }, "Sin respuestas todavía."));
        }
        for (const r of replies) {
          const delBtn = el("button", { class: "danger" }, "Eliminar");
          delBtn.addEventListener("click", async () => {
            try {
              await api(`/quick-replies/${r.id}`, { method: "DELETE" });
              toast("Eliminada");
              await refresh();
            } catch (err) {
              toast(err.message, true);
            }
          });
          listEl.appendChild(el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto" }, [
            el("div", {}, r.text),
            delBtn,
          ]));
        }
      } catch (err) {
        listEl.innerHTML = "";
        listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    addBtn.addEventListener("click", async () => {
      const text = input.value.trim();
      if (!text) { toast("Escribe el texto de la respuesta", true); return; }
      addBtn.disabled = true;
      try {
        await api(`/accounts/${acc.id}/quick-replies`, { method: "POST", body: JSON.stringify({ text }) });
        input.value = "";
        toast("Respuesta añadida");
        await refresh();
      } catch (err) {
        toast(err.message, true);
      } finally {
        addBtn.disabled = false;
      }
    });

    refresh();
  }, { wide: true });
}

// ---------- Bloqueo automático por país ----------

function renderBlockedCountriesCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Bloqueo automático por país"));
  card.appendChild(el("p", { class: "hint" },
    "Cualquier fan que escriba por chat directo desde uno de estos países se bloqueará en Telegram en el momento en que mande el mensaje. El país es el del teléfono con el que se registró, aunque lo tenga oculto. Aplica solo a esta modelo."));

  const chipsEl = el("div", { class: "chip-list" });
  card.appendChild(chipsEl);

  const select = el("select");
  select.appendChild(el("option", { value: "" }, "Elegir país..."));
  const addBtn = el("button", { class: "danger" }, "Bloquear país");
  card.appendChild(el("div", { class: "chip-add-row" }, [select, addBtn]));
  card.appendChild(el("div", { class: "hint", style: "margin-top:8px" },
    "Si un fan bloqueado así se desbloquea a mano (ℹ️ en su chat → Desbloquear), no se le vuelve a bloquear."));

  let countries = [];
  let prefixes = [];

  function renderChips() {
    chipsEl.innerHTML = "";
    for (const prefix of prefixes) {
      const c = countries.find((x) => x.prefix === prefix);
      const label = c ? `${c.flag} ${c.name}` : prefix;
      const removeBtn = el("button", { class: "chip-remove", title: "Quitar" }, "×");
      removeBtn.addEventListener("click", () => save(prefixes.filter((p) => p !== prefix)));
      chipsEl.appendChild(el("div", { class: "chip" }, [label, removeBtn]));
    }
  }

  async function save(nextPrefixes) {
    try {
      await api(`/accounts/${acc.id}/blocked-countries`, { method: "PUT", body: JSON.stringify({ prefixes: nextPrefixes }) });
      prefixes = nextPrefixes;
      renderChips();
      toast("Guardado");
    } catch (err) {
      toast(err.message, true);
    }
  }

  addBtn.addEventListener("click", () => {
    const prefix = select.value;
    if (!prefix || prefixes.includes(prefix)) return;
    save([...prefixes, prefix]);
    select.value = "";
  });

  api(`/accounts/${acc.id}/blocked-countries`).then((res) => {
    countries = res.countries;
    prefixes = res.prefixes;
    for (const c of countries) select.appendChild(el("option", { value: c.prefix }, `${c.flag} ${c.name}`));
    renderChips();
  }).catch(() => {
    chipsEl.appendChild(el("div", { class: "empty" }, "Error cargando países."));
  });

  return card;
}

// ---------- Carpetas de Telegram: sincronizar automáticamente ----------

const FOLDER_SYNC_LISTS = [
  { key: "Clientes", label: "Cliente", defaultFolder: "Clientes" },
  { key: "Grupo cliente", label: "Grupo cliente", defaultFolder: "Gru Cliente" },
  { key: "Posibles", label: "Posibles", defaultFolder: "Posibles" },
  { key: "SFS", label: "SFS", defaultFolder: "SFS" },
  { key: "TW", label: "TW", defaultFolder: "Time Waster" },
];

function renderFolderSyncCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Carpetas de Telegram"));

  const enabledRow = el("label", { class: "folder-checkbox-row" }, [
    el("input", { type: "checkbox" }),
    el("span", {}, "Sincronizar carpetas automáticamente"),
  ]);
  const enabledInput = enabledRow.querySelector("input");
  card.appendChild(enabledRow);
  card.appendChild(el("p", { class: "hint" },
    "Encendido, el CRM mete en la carpeta de Telegram a quien entra en la lista (ej. los clientes nuevos en \"Clientes\"). Solo añade: nunca saca a nadie de una carpeta. Apagado, las listas solo leen las carpetas."));

  const rowsEl = el("div", { style: "display:flex;flex-direction:column;gap:8px;margin:10px 0" });
  card.appendChild(rowsEl);
  const statusEl = el("p", { class: "hint" }, "Leyendo carpetas de Telegram de esta cuenta...");
  card.appendChild(statusEl);

  // Antes esto era un <input> de texto libre donde había que escribir el
  // nombre EXACTO de la carpeta a mano - cualquier typo, mayúscula distinta
  // o espacio de más rompía la sincronización en silencio (el chat nunca
  // llegaba a la carpeta, sin ningún aviso de que el nombre no coincidía con
  // ninguna real). Ahora es un <select> con las carpetas de Telegram
  // leídas en vivo de la cuenta (mismo endpoint que usa el Reenviador para
  // elegir carpeta), así que solo se puede enlazar una carpeta que de
  // verdad existe.
  const selects = {};
  for (const l of FOLDER_SYNC_LISTS) {
    const select = el("select", {}, [el("option", { value: "" }, "Sin enlazar")]);
    selects[l.key] = select;
    rowsEl.appendChild(el("div", { class: "field", style: "display:grid;grid-template-columns:140px 1fr;align-items:center;gap:10px" }, [
      el("label", { style: "margin:0" }, l.label),
      select,
    ]));
  }

  const saveBtn = el("button", { class: "primary" }, "Guardar");
  saveBtn.disabled = true;
  card.appendChild(saveBtn);
  saveBtn.addEventListener("click", async () => {
    const map = {};
    for (const l of FOLDER_SYNC_LISTS) {
      const value = selects[l.key].value;
      if (value) map[l.key] = value;
    }
    saveBtn.disabled = true;
    try {
      await api(`/accounts/${acc.id}/folder-sync`, { method: "PUT", body: JSON.stringify({ enabled: enabledInput.checked, map }) });
      toast("Guardado");
    } catch (err) {
      toast(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  Promise.all([
    api(`/accounts/${acc.id}/folder-sync`),
    api(`/accounts/${acc.id}/telegram-folders`).catch(() => ({ folders: [] })),
  ]).then(([syncRes, foldersRes]) => {
    enabledInput.checked = !!syncRes.enabled;
    const realTitles = (foldersRes.folders || []).map((f) => f.title);

    for (const l of FOLDER_SYNC_LISTS) {
      const saved = syncRes.map[l.key] || "";
      const select = selects[l.key];
      // Si el valor guardado ya no corresponde a ninguna carpeta real de
      // Telegram (se borró/renombró la carpeta, o venía del antiguo campo de
      // texto libre con un nombre que nunca coincidió), se añade igualmente
      // como opción para no perderlo en silencio, marcado como "no
      // encontrada" - así se ve el problema en vez de que el select
      // simplemente vuelva a "Sin enlazar" sin explicación.
      const titles = saved && !realTitles.includes(saved) ? [...realTitles, saved] : realTitles;
      for (const title of titles) {
        select.appendChild(el("option", { value: title }, title === saved && !realTitles.includes(saved) ? `${title} (no encontrada)` : title));
      }
      select.value = saved;
    }

    if (realTitles.length === 0) {
      statusEl.textContent = "No se pudo leer ninguna carpeta de Telegram de esta cuenta ahora mismo (¿cuenta desconectada?). Puedes guardar igualmente lo que ya hubiera configurado, pero para enlazar una carpeta nueva hace falta que la cuenta esté conectada.";
    } else {
      statusEl.remove();
    }
    saveBtn.disabled = false;
  }).catch((err) => {
    statusEl.textContent = `No se pudo cargar: ${err.message}`;
  });

  return card;
}

// ---------- Grupos restringidos: cuenta ayudante ----------

function renderRestrictedGroupHelperCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Grupos restringidos"));
  card.appendChild(el("p", { class: "hint" }, "Cuenta ayudante (por si Telegram le bloquea a esta cuenta crear grupos)"));
  card.appendChild(el("p", { class: "hint" },
    "Si Telegram rechaza crear el grupo restringido desde esta cuenta (USER_RESTRICTED), se crea automáticamente con la cuenta elegida aquí, dejando a esta cuenta como admin."));

  const select = el("select");
  select.appendChild(el("option", { value: "" }, "Sin cuenta ayudante"));
  for (const other of state.accounts) {
    if (other.id === acc.id) continue;
    select.appendChild(el("option", { value: other.id }, other.label));
  }
  card.appendChild(select);

  select.addEventListener("change", async () => {
    try {
      await api(`/accounts/${acc.id}/restricted-group-helper`, { method: "PUT", body: JSON.stringify({ helperAccountId: select.value || null }) });
      toast("Guardado");
    } catch (err) {
      toast(err.message, true);
    }
  });

  api(`/accounts/${acc.id}/restricted-group-helper`).then((res) => {
    select.value = res.helperAccountId || "";
  }).catch(() => {});

  return card;
}

// ---------- Excluir carpeta de Telegram ----------

function renderExcludedFoldersCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Excluir carpeta de Telegram"));
  card.appendChild(el("p", { class: "hint" },
    "Marca las carpetas de Telegram de esta cuenta que quieras sacar de la lista de Mensajes del CRM (p.ej. una carpeta de equipo interno que no son fans). Los chatters/trabajadores no verán ningún chat de las carpetas marcadas."));

  const listEl = el("div", {});
  card.appendChild(listEl);
  const statusEl = el("div", { class: "hint" }, "Cargando carpetas de Telegram...");
  listEl.appendChild(statusEl);

  let excluded = [];
  let realFolders = null; // null = aún no sabemos si la lista en vivo cargó bien

  function isExcluded(title) {
    return excluded.some((x) => x.toLowerCase() === title.toLowerCase());
  }

  async function save(next) {
    try {
      await api(`/accounts/${acc.id}/excluded-folders`, { method: "PUT", body: JSON.stringify({ folders: next }) });
      excluded = next;
      toast("Guardado");
    } catch (err) {
      toast(err.message, true);
      render(); // revertir el checkbox visualmente si falló el guardado
    }
  }

  function toggle(title, checked) {
    if (checked) {
      if (!isExcluded(title)) save([...excluded, title]);
    } else {
      save(excluded.filter((x) => x.toLowerCase() !== title.toLowerCase()));
    }
  }

  function render() {
    listEl.innerHTML = "";
    if (realFolders === null) {
      listEl.appendChild(el("div", { class: "hint" }, "Cargando carpetas de Telegram..."));
      return;
    }
    if (realFolders.length === 0) {
      listEl.appendChild(el("div", { class: "hint" }, "Esta cuenta no tiene carpetas configuradas en Telegram."));
    }
    for (const f of realFolders) {
      const row = el("label", { class: "folder-checkbox-row" }, [
        el("input", { type: "checkbox", checked: isExcluded(f.title) ? "checked" : undefined }),
        el("span", {}, `${f.title} (${f.chatCount} chat${f.chatCount === 1 ? "" : "s"})`),
      ]);
      const checkboxInput = row.querySelector("input");
      checkboxInput.checked = isExcluded(f.title);
      checkboxInput.addEventListener("change", () => toggle(f.title, checkboxInput.checked));
      listEl.appendChild(row);
    }
    // Por si hay nombres guardados que ya no existen como carpeta real en
    // Telegram (se borró/renombró la carpeta allí) - se muestran aparte
    // para poder quitarlos, en vez de desaparecer en silencio.
    const knownTitles = new Set(realFolders.map((f) => f.title.toLowerCase()));
    const orphaned = excluded.filter((x) => !knownTitles.has(x.toLowerCase()));
    if (orphaned.length > 0) {
      listEl.appendChild(el("div", { class: "hint", style: "margin-top:10px" }, "Excluidas antes, ya no existen en Telegram:"));
      const chipsEl = el("div", { class: "chip-list" });
      for (const title of orphaned) {
        const removeBtn = el("button", { class: "chip-remove", title: "Quitar" }, "×");
        removeBtn.addEventListener("click", () => save(excluded.filter((x) => x !== title)));
        chipsEl.appendChild(el("div", { class: "chip" }, [title, removeBtn]));
      }
      listEl.appendChild(chipsEl);
    }
  }

  Promise.all([
    api(`/accounts/${acc.id}/excluded-folders`),
    api(`/accounts/${acc.id}/telegram-folders`),
  ]).then(([excludedRes, foldersRes]) => {
    excluded = excludedRes.folders || [];
    realFolders = foldersRes.folders || [];
    render();
  }).catch((err) => {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "hint" }, `No se pudieron cargar las carpetas de Telegram de esta cuenta (${err.message}). Prueba a recargar la página.`));
  });

  return card;
}

// ---------- Bóveda de contenido ----------

function renderContentGroupCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Bóveda de contenido"));
  card.appendChild(el("p", { class: "hint" },
    "Grupo de Telegram de donde se trae el contenido. Si no eliges uno, se busca automáticamente un grupo llamado exactamente \"Contenido para Telegram\"."));
  const statusEl = el("div", { class: "hint" }, "Cargando...");
  card.appendChild(statusEl);
  const changeBtn = el("button", {}, "Cambiar grupo...");
  card.appendChild(changeBtn);

  async function refresh() {
    try {
      const { group } = await api(`/accounts/${acc.id}/content-group`);
      statusEl.textContent = group ? `Grupo conectado: ${group.title || group.chatId}` : "Sin grupo elegido todavía (se busca \"Contenido para Telegram\" automáticamente).";
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
    }
  }

  changeBtn.addEventListener("click", () => openChangeContentGroupModal(acc, refresh));
  refresh();
  return card;
}

function openChangeContentGroupModal(acc, onChange) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Grupo de contenido de " + acc.label));
    modal.appendChild(el("div", { class: "hint" }, "Busca el grupo/canal con temas (sexting, lencería, fotos...) por nombre:"));
    const searchInput = el("input", { placeholder: "ej. Contenido Zoweey" });
    const resultsEl = el("div", { class: "scripts-manage-list" });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Grupo"), searchInput]));
    modal.appendChild(resultsEl);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cerrar")]));

    let searchTimer = null;
    async function doSearch() {
      resultsEl.innerHTML = "";
      resultsEl.appendChild(el("div", { class: "empty" }, "Buscando..."));
      try {
        const { groups } = await api(`/accounts/${acc.id}/content-group/search?q=${encodeURIComponent(searchInput.value)}`);
        resultsEl.innerHTML = "";
        if (groups.length === 0) {
          resultsEl.appendChild(el("div", { class: "empty" }, "Sin resultados."));
        }
        for (const g of groups) {
          const row = el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto;cursor:pointer" });
          row.appendChild(el("div", {}, [el("div", { style: "font-weight:600" }, g.title), g.isForum ? el("div", { class: "hint" }, "Tiene temas ✓") : el("div", { class: "hint" }, "Sin temas (no vale)")]));
          const pickBtn = el("button", { class: "primary" }, "Elegir");
          pickBtn.disabled = !g.isForum;
          pickBtn.addEventListener("click", async () => {
            try {
              await api(`/accounts/${acc.id}/content-group`, { method: "PUT", body: JSON.stringify({ chatId: g.chatId, title: g.title }) });
              toast("Grupo de contenido guardado");
              await onChange();
              close();
            } catch (err) {
              toast(err.message, true);
            }
          });
          row.appendChild(pickBtn);
          resultsEl.appendChild(row);
        }
      } catch (err) {
        resultsEl.innerHTML = "";
        resultsEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }
    searchInput.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 400); });
    doSearch();
  }, { wide: true });
}

// ---------- Paquetes SFS ----------

function renderSfsPackagesCard(acc) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "SFS (intercambios con otras modelos)"));
  card.appendChild(el("p", { class: "hint" },
    "Paquetes listos (medios + texto + enlace) que los chatters envían con un clic desde el chat. El SFS que nos manda la otra modelo se publica desde su mensaje (⋮ → Publicar como SFS)."));
  const configBtn = el("button", {}, "Configurar paquetes SFS...");
  configBtn.addEventListener("click", () => openSfsPackagesModal(acc));
  card.appendChild(configBtn);
  return card;
}

function openSfsPackagesModal(acc) {
  openModal((modal, close) => {
    renderList(modal, close);
  }, { wide: true });

  function renderList(modal, close) {
    modal.innerHTML = "";
    modal.appendChild(el("h3", {}, "Paquetes SFS · " + acc.label));
    modal.appendChild(el("div", { class: "hint" }, "Lo que se le manda a otra modelo al pactar un intercambio: un álbum con los medios y el texto + enlace debajo."));
    const listEl = el("div", { class: "scripts-manage-list" });
    modal.appendChild(listEl);
    const newBtn = el("button", { class: "primary" }, "+ Nuevo paquete");
    modal.appendChild(newBtn);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cerrar")]));

    async function refresh() {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const { packages } = await api(`/accounts/${acc.id}/sfs-packages`);
        listEl.innerHTML = "";
        if (packages.length === 0) {
          listEl.appendChild(el("div", { class: "empty" }, "Todavía no hay paquetes para esta creadora."));
        }
        for (const p of packages) {
          const delBtn = el("button", { class: "danger" }, "Eliminar");
          delBtn.addEventListener("click", async () => {
            const ok = await confirmModal({ title: "Eliminar paquete", body: `¿Eliminar el paquete "${p.name}"?`, confirmLabel: "Eliminar", danger: true });
            if (!ok) return;
            try {
              await api(`/sfs-packages/${p.id}`, { method: "DELETE" });
              toast("Paquete eliminado");
              await refresh();
            } catch (err) {
              toast(err.message, true);
            }
          });
          listEl.appendChild(el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto" }, [
            el("div", {}, [el("div", { style: "font-weight:600" }, p.name), el("div", { class: "hint" }, `${p.media.length} medio(s)`)]),
            delBtn,
          ]));
        }
      } catch (err) {
        listEl.innerHTML = "";
        listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    newBtn.addEventListener("click", () => renderEditor(modal, close));
    refresh();
  }

  function renderEditor(modal, close) {
    modal.innerHTML = "";
    modal.appendChild(el("h3", {}, "Paquetes SFS · " + acc.label));
    modal.appendChild(el("div", { class: "hint" }, "Lo que se le manda a otra modelo al pactar un intercambio: un álbum con los medios y el texto + enlace debajo."));

    const nameInput = el("input", { placeholder: "Ej. SFS estándar, SFS con vídeo..." });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre"), nameInput]));

    const selectedMedia = [];
    const mediaGrid = el("div", { class: "content-items-grid" });
    const addMediaBtn = el("div", {
      class: "content-item-card",
      style: "cursor:pointer;align-items:center;justify-content:center;min-height:90px;font-size:22px",
    }, "+");
    addMediaBtn.addEventListener("click", () => {
      if (selectedMedia.length >= 10) { toast("Máximo 10 medios por paquete", true); return; }
      openSfsMediaPickerModal(acc, selectedMedia, renderMediaGrid);
    });

    function renderMediaGrid() {
      mediaGrid.innerHTML = "";
      for (const m of selectedMedia) {
        const thumbUrl = `/api/accounts/${acc.id}/content-group/messages/${m.id}/thumb`;
        const thumbImg = el("img", { src: thumbUrl, loading: "lazy", class: "content-item-thumb" });
        bindThumbRetry(thumbImg, thumbUrl);
        const thumbWrap = el("div", { class: "content-item-thumb-wrap" }, [thumbImg]);
        if (m.type === "video") thumbWrap.appendChild(el("div", { class: "content-item-type-badge" }, "🎬"));
        const removeBtn = el("button", { class: "content-item-fav-btn", title: "Quitar" }, "×");
        thumbWrap.appendChild(removeBtn);
        removeBtn.addEventListener("click", () => {
          const idx = selectedMedia.indexOf(m);
          if (idx >= 0) selectedMedia.splice(idx, 1);
          renderMediaGrid();
        });
        mediaGrid.appendChild(el("div", { class: "content-item-card" }, thumbWrap));
      }
      if (selectedMedia.length < 10) mediaGrid.appendChild(addMediaBtn);
    }
    renderMediaGrid();

    modal.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Medios del álbum (fotos y vídeos, hasta 10) — en este orden"),
      mediaGrid,
      el("div", { class: "hint" }, "El primer medio es el que se ve grande en Telegram."),
    ]));

    const captionInput = el("textarea", { rows: "5", placeholder: "Mi amiga @usuario está dispuesta a portarse mal contigo... CANAL HOT https://t.me/..." });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Texto (pie del álbum)"), captionInput]));
    modal.appendChild(el("div", { class: "hint" }, "El enlace va dentro del texto. Máximo 1.024 caracteres como pie; más largo, el texto va en un mensaje aparte justo después."));

    const saveBtn = el("button", { class: "primary" }, "Guardar paquete");
    const cancelBtn = el("button", { onclick: () => renderList(modal, close) }, "Cancelar");
    modal.appendChild(el("div", { class: "actions" }, [saveBtn, cancelBtn]));

    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { toast("Ponle un nombre al paquete", true); return; }
      saveBtn.disabled = true;
      try {
        await api(`/accounts/${acc.id}/sfs-packages`, {
          method: "POST",
          body: JSON.stringify({ name, captionText: captionInput.value, media: selectedMedia }),
        });
        toast("Paquete guardado");
        renderList(modal, close);
      } catch (err) {
        toast(err.message, true);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
}

/** Picker ligero de medios de la bóveda (usado por paquetes SFS y por los pasos "pack"/"audio" de Guiones): elige una carpeta y toca los medios hasta `max` (por defecto 10), opcionalmente filtrando por `typeFilter` ("photo"/"video"/"audio"). */
function openSfsMediaPickerModal(acc, selectedMedia, onDone, opts) {
  const max = (opts && opts.max) || 10;
  const typeFilter = opts && opts.typeFilter;
  openModal(async (modal, close) => {
    modal.appendChild(el("h3", {}, "Elegir de la bóveda"));
    const body = el("div", {});
    modal.appendChild(body);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: () => { onDone(); close(); } }, "Listo")]));

    body.appendChild(el("div", { class: "empty" }, "Cargando carpetas..."));
    let group, topics;
    try {
      group = (await api(`/accounts/${acc.id}/content-group`)).group;
      if (!group) {
        body.innerHTML = "";
        body.appendChild(el("div", { class: "empty" }, "Esta modelo todavía no tiene bóveda de contenido conectada (ver \"Bóveda de contenido\" más arriba)."));
        return;
      }
      topics = (await api(`/accounts/${acc.id}/content-group/topics`)).topics;
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }
    body.innerHTML = "";
    if (topics.length === 0) {
      body.appendChild(el("div", { class: "empty" }, "Esa bóveda no tiene carpetas todavía."));
      return;
    }

    const select = el("select");
    for (const t of topics) select.appendChild(el("option", { value: t.id }, t.title));
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Carpeta"), select]));
    const grid = el("div", { class: "content-items-grid" });
    body.appendChild(grid);

    async function loadTopic(topicId) {
      grid.innerHTML = "";
      grid.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const qs = typeFilter ? `?type=${typeFilter}` : "";
        const { items } = await api(`/accounts/${acc.id}/content-group/topics/${topicId}/items${qs}`);
        grid.innerHTML = "";
        for (const it of items) {
          const picked = selectedMedia.some((m) => m.id === String(it.id));
          let thumbInner;
          if (it.hasThumb) {
            const thumbUrl = `/api/accounts/${acc.id}/content-group/messages/${it.id}/thumb`;
            thumbInner = el("img", { src: thumbUrl, loading: "lazy", class: "content-item-thumb" });
            bindThumbRetry(thumbInner, thumbUrl, it.type === "audio" ? "🎵" : "🖼️");
          } else {
            thumbInner = el("div", { class: "content-item-thumb-empty" }, it.type === "audio" ? "🎵" : "🖼️");
          }
          const thumbWrap = el("div", { class: "content-item-thumb-wrap" }, thumbInner);
          if (it.type === "video") thumbWrap.appendChild(el("div", { class: "content-item-type-badge" }, "🎬"));
          const card = el("div", { class: "content-item-card" + (picked ? " active" : "") }, thumbWrap);
          card.addEventListener("click", () => {
            const idx = selectedMedia.findIndex((m) => m.id === String(it.id));
            if (idx >= 0) {
              selectedMedia.splice(idx, 1);
              card.classList.remove("active");
            } else {
              if (max === 1) {
                selectedMedia.length = 0;
                grid.querySelectorAll(".content-item-card.active").forEach((c) => c.classList.remove("active"));
              } else if (selectedMedia.length >= max) {
                toast(`Máximo ${max} medios`, true);
                return;
              }
              selectedMedia.push({ id: String(it.id), caption: it.caption || "", type: it.type });
              card.classList.add("active");
            }
          });
          grid.appendChild(card);
        }
      } catch (err) {
        grid.innerHTML = "";
        grid.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    select.addEventListener("change", () => loadTopic(select.value));
    loadTopic(topics[0].id);
  }, { wide: true });
}

/** Selector de un mensaje de TEXTO de la bóveda (con sus emoji premium, si
 * los tiene) para usarlo como Script (ver openScriptsManageModal): elige
 * carpeta y toca uno de la lista. onPick(text, entities) se llama una vez y
 * cierra el modal. */
function openVaultTextPickerModal(accountId, onPick) {
  openModal(async (modal, close) => {
    modal.appendChild(el("h3", {}, "Elegir texto de la bóveda"));
    modal.appendChild(el("div", { class: "hint" }, "Elige un mensaje de texto ya guardado en la bóveda de contenido: si tiene emoji premium (letras/emoji animados), se guardan tal cual en el script."));
    const body = el("div", {});
    modal.appendChild(body);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cancelar")]));

    body.appendChild(el("div", { class: "empty" }, "Cargando carpetas..."));
    let group, topics;
    try {
      group = (await api(`/accounts/${accountId}/content-group`)).group;
      if (!group) {
        body.innerHTML = "";
        body.appendChild(el("div", { class: "empty" }, "Esta modelo todavía no tiene bóveda de contenido conectada (ver \"Bóveda de contenido\" en Configuración)."));
        return;
      }
      topics = (await api(`/accounts/${accountId}/content-group/topics`)).topics;
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      return;
    }
    body.innerHTML = "";
    if (topics.length === 0) {
      body.appendChild(el("div", { class: "empty" }, "Esa bóveda no tiene carpetas todavía."));
      return;
    }

    const select = el("select");
    for (const t of topics) select.appendChild(el("option", { value: t.id }, t.title));
    body.appendChild(el("div", { class: "field" }, [el("label", {}, "Carpeta"), select]));
    const listEl = el("div", { class: "scripts-manage-list", style: "max-height:320px;overflow:auto" });
    body.appendChild(listEl);

    async function loadTopic(topicId) {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const { items } = await api(`/accounts/${accountId}/content-group/topics/${topicId}/text-items`);
        listEl.innerHTML = "";
        if (items.length === 0) {
          listEl.appendChild(el("div", { class: "empty" }, "Esta carpeta no tiene mensajes de texto."));
          return;
        }
        for (const it of items) {
          const row = el("div", { class: "script-manage-row", style: "grid-template-columns:1fr auto;cursor:pointer" }, [
            el("div", {}, [
              el("div", { style: "white-space:pre-wrap;font-size:13px" }, it.preview + (it.text.length > it.preview.length ? "…" : "")),
              it.entities.length > 0 ? el("div", { class: "hint" }, `✨ ${it.entities.length} emoji premium`) : null,
            ]),
            el("button", { class: "primary" }, "Usar"),
          ]);
          row.addEventListener("click", () => {
            onPick(it.text, it.entities);
            close();
          });
          listEl.appendChild(row);
        }
      } catch (err) {
        listEl.innerHTML = "";
        listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    select.addEventListener("change", () => loadTopic(select.value));
    loadTopic(topics[0].id);
  }, { wide: true });
}

/** Chip-list editable (servicios / métodos de pago), igual que en el panel de referencia. */
function renderChipListCard({ title, hint, items, addPlaceholder, onAdd, onRemove, onReset }) {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, title));
  if (hint) card.appendChild(el("p", { class: "hint" }, hint));
  const listEl = el("div", { class: "chip-list" });
  card.appendChild(listEl);

  function renderChips(values) {
    listEl.innerHTML = "";
    for (const v of values) {
      const removeBtn = el("button", { class: "chip-remove", title: "Quitar" }, "×");
      removeBtn.addEventListener("click", async () => {
        removeBtn.disabled = true;
        try {
          renderChips(await onRemove(v));
        } catch (err) {
          toast(err.message, true);
          removeBtn.disabled = false;
        }
      });
      listEl.appendChild(el("div", { class: "chip" }, [v, removeBtn]));
    }
  }
  renderChips(items);

  const input = el("input", { placeholder: addPlaceholder });
  const addBtn = el("button", { class: "primary" }, "Añadir");
  const resetBtn = el("button", { class: "ghost" }, "Volver a los de fábrica");
  addBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) return;
    addBtn.disabled = true;
    try {
      renderChips(await onAdd(value.toUpperCase() === value ? value : value));
      input.value = "";
    } catch (err) {
      toast(err.message, true);
    } finally {
      addBtn.disabled = false;
    }
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
  resetBtn.addEventListener("click", async () => {
    resetBtn.disabled = true;
    try {
      renderChips(await onReset());
      toast("Restablecido");
    } catch (err) {
      toast(err.message, true);
    } finally {
      resetBtn.disabled = false;
    }
  });
  card.appendChild(el("div", { class: "chip-add-row" }, [input, addBtn, resetBtn]));
  return card;
}

// ---------- Informes → Nóminas Chatter's (antes vivía en Configuración → Nóminas) ----------
//
// Genera la hoja de pago (PDF) de un trabajador para una quincena/periodo:
// salario fijo + comisión (por defecto 10%) sobre TODO lo que haya vendido
// en ese periodo (todas las cuentas juntas, "Vendido por" en Detector de
// pagos/FanSale) + bonificación opcional. El cálculo de verdad lo hace el
// servidor (src/api/payroll.ts) al generar - aquí solo se enseña una vista
// previa antes de guardar.

function fmtDateInput(d) {
  // OJO: NUNCA usar d.toISOString().slice(0,10) aquí - toISOString() pasa la
  // fecha a UTC antes de formatearla, y new Date(y, m, dia) se crea a
  // medianoche en la ZONA HORARIA LOCAL del navegador. En España (UTC+1 o
  // UTC+2 en verano), medianoche del día 15 cae en UTC el día 14 a las 22h o
  // 23h - así que ese día 15 se convertía en "14" y los botones de quincena
  // (1-15 / 16-fin de mes) quedaban desplazados un día hacia atrás. Formatear
  // con los componentes LOCALES (año/mes/día tal cual, sin pasar por UTC)
  // evita el desfase.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Primer y último día de la quincena "actual" (1-15 o 16-fin de mes) del
 * mes que se pasa, para rellenar el periodo con un clic. */
function quincenaRange(base, half) {
  const y = base.getFullYear();
  const m = base.getMonth();
  if (half === 1) return { start: new Date(y, m, 1), end: new Date(y, m, 15) };
  return { start: new Date(y, m, 16), end: new Date(y, m + 1, 0) };
}

async function renderNominasSection() {
  appEl.appendChild(el("div", { class: "section-title-row" }, [el("h1", { style: "margin:0" }, "Nóminas Chatter's")]));
  appEl.appendChild(el("p", { class: "subtitle" }, "Genera la hoja de pago de un trabajador: salario fijo + comisión sobre lo vendido en el periodo, rellenando la plantilla real en Word."));

  const formCard = el("div", { class: "card" });
  appEl.appendChild(formCard);
  formCard.appendChild(el("h3", {}, "Generar nómina"));

  const workerSelect = el("select", {}, [el("option", { value: "" }, "Cargando trabajadores...")]);
  const roleInput = el("input", { placeholder: "Ej. Chatter" });
  const modelsInput = el("input", { placeholder: "Ej. Samara, Cloe, Zoweey y Mery" });
  const periodStartInput = el("input", { type: "date" });
  const periodEndInput = el("input", { type: "date" });
  const quincena1Btn = el("button", { class: "sm" }, "1ª quincena (mes actual)");
  const quincena2Btn = el("button", { class: "sm" }, "2ª quincena (mes actual)");
  const fixedSalaryInput = el("input", { type: "number", min: "0", step: "0.01", placeholder: "Salario fijo del periodo" });
  const commissionInput = el("input", { type: "number", min: "0", step: "0.1", value: "10" });
  const bonusInput = el("input", { type: "number", min: "0", step: "0.01", value: "0" });
  const paymentDateInput = el("input", { type: "date" });
  const paymentMethodInput = el("input", { placeholder: "Ej. Criptomonedas: USDC - POL" });
  const rememberDefaultsCheck = el("input", { type: "checkbox" });

  const calcBtn = el("button", { class: "sm" }, "Calcular ventas del periodo (CRM)");
  const addModelRowBtn = el("button", { class: "sm" }, "+ Añadir modelo");
  // Ventas por modelo: antes esto era un unico numero suelto ("ventas
  // manuales adicionales") sumado a lo que detectaba el CRM - el dueño
  // necesita poder anotar el total vendido por cada modelo a mano, con el
  // nombre editable y filas que se puedan añadir o quitar libremente (no
  // solo las cuentas de Telegram ya dadas de alta), asi que esto es ahora
  // una tabla editable en vez de un campo de solo lectura + un extra.
  const salesTableBox = el("div", {});
  const salesTotalsBox = el("div", { class: "hint", style: "margin:6px 0 10px;font-weight:600" }, "");
  const generateBtn = el("button", { class: "primary" }, "Generar nómina (PDF)");

  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Trabajador"), workerSelect]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Rol"), roleInput]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Modelos gestionadas"), modelsInput]));
  formCard.appendChild(el("div", { class: "field" }, [
    el("label", {}, "Periodo"),
    el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [periodStartInput, el("span", {}, "→"), periodEndInput, quincena1Btn, quincena2Btn]),
  ]));
  formCard.appendChild(el("div", { class: "field" }, [
    el("label", {}, "Ventas por modelo"),
    el("div", { class: "hint" }, "Escribe aquí el total vendido por cada modelo en este periodo: nombre y ventas totalmente editables, y puedes añadir o quitar filas. \"Calcular ventas del periodo\" las rellena automáticamente a partir del CRM (Vendido por), pero luego puedes corregirlas a mano."),
    el("div", { style: "display:flex;gap:8px;margin:8px 0" }, [calcBtn, addModelRowBtn]),
    salesTableBox,
    salesTotalsBox,
  ]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Salario fijo del periodo ($)"), fixedSalaryInput]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "% Comisión sobre ventas"), commissionInput]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Bonificación ($, opcional)"), bonusInput]));
  formCard.appendChild(el("div", { class: "field" }, [
    el("label", {}, "Fecha de pago"),
    paymentDateInput,
    el("div", { class: "hint" }, "Si la dejas en blanco, se pone la fecha en la que generes el PDF."),
  ]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Método de pago"), paymentMethodInput]));
  formCard.appendChild(el("label", { class: "folder-checkbox-row" }, [rememberDefaultsCheck, el("span", {}, "Recordar salario fijo y % de comisión como los de siempre de este trabajador")]));
  formCard.appendChild(generateBtn);

  let workers = [];
  let salesRows = []; // [{ id, label, amount }] - editable a mano, add/remove libre
  let nextSalesRowId = 1;

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function updateSalesTotals() {
    const totalSales = round2(salesRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0));
    const pct = Number(commissionInput.value) || 0;
    const commission = round2(totalSales * (pct / 100));
    salesTotalsBox.innerHTML = "";
    salesTotalsBox.appendChild(el("div", {}, `Ventas totales: ${totalSales.toFixed(2)} $  ·  Comisión (${pct}%): ${commission.toFixed(2)} $`));
  }

  function renderSalesRows() {
    salesTableBox.innerHTML = "";
    if (salesRows.length === 0) {
      salesTableBox.appendChild(el("div", { class: "empty", style: "padding:6px 0" }, "Sin modelos añadidas todavía. Usa \"Calcular ventas del periodo\" o \"+ Añadir modelo\"."));
    }
    for (const row of salesRows) {
      const nameInput = el("input", { placeholder: "Nombre de la modelo", value: row.label || "" });
      const amountInput = el("input", { type: "number", min: "0", step: "0.01", placeholder: "0.00", value: row.amount || "" });
      const delBtn = el("button", { class: "ghost", title: "Eliminar esta fila" }, "🗑️");
      nameInput.addEventListener("input", () => {
        row.label = nameInput.value;
      });
      amountInput.addEventListener("input", () => {
        row.amount = Number(amountInput.value) || 0;
        updateSalesTotals();
      });
      delBtn.addEventListener("click", () => {
        salesRows = salesRows.filter((r) => r.id !== row.id);
        renderSalesRows();
        updateSalesTotals();
      });
      salesTableBox.appendChild(el("div", { class: "sale-add-row", style: "margin-bottom:6px" }, [nameInput, amountInput, delBtn]));
    }
  }

  addModelRowBtn.addEventListener("click", () => {
    salesRows.push({ id: nextSalesRowId++, label: "", amount: 0 });
    renderSalesRows();
    updateSalesTotals();
  });
  commissionInput.addEventListener("input", updateSalesTotals);
  renderSalesRows();
  updateSalesTotals();

  quincena1Btn.addEventListener("click", () => {
    const r = quincenaRange(new Date(), 1);
    periodStartInput.value = fmtDateInput(r.start);
    periodEndInput.value = fmtDateInput(r.end);
  });
  quincena2Btn.addEventListener("click", () => {
    const r = quincenaRange(new Date(), 2);
    periodStartInput.value = fmtDateInput(r.start);
    periodEndInput.value = fmtDateInput(r.end);
  });

  try {
    const res = await api("/payroll/workers");
    workers = res.workers || [];
    workerSelect.innerHTML = "";
    workerSelect.appendChild(el("option", { value: "" }, "Elige un trabajador..."));
    for (const w of workers) {
      workerSelect.appendChild(el("option", { value: w.id }, `${w.name}${w.role ? " (" + w.role + ")" : ""}`));
    }
  } catch (err) {
    workerSelect.innerHTML = "";
    workerSelect.appendChild(el("option", { value: "" }, "Error al cargar trabajadores"));
    toast(err.message, true);
  }

  workerSelect.addEventListener("change", () => {
    const w = workers.find((x) => x.id === workerSelect.value);
    if (!w) return;
    // Antes esto ponia el valor "en crudo" guardado en el trabajador
    // ("worker"/"admin") tal cual, asi que para cualquier chatter normal el
    // campo Rol salia literalmente "worker" en vez de su nombre real - en
    // todo el resto del panel (Equipo, TeleCrew) ese mismo valor se traduce
    // siempre con WORKER_ROLE_LABELS ("worker" -> "Chatter", "admin" ->
    // "Team líder"), asi que aqui se hace igual.
    roleInput.value = (w.role && WORKER_ROLE_LABELS[w.role]) || w.role || "Chatter";
    modelsInput.value = (w.modelsManaged || []).join(", ");
    if (w.payrollFixedSalary != null) fixedSalaryInput.value = w.payrollFixedSalary;
    if (w.payrollCommissionPct != null) commissionInput.value = w.payrollCommissionPct;
    salesRows = [];
    renderSalesRows();
    updateSalesTotals();
  });

  calcBtn.addEventListener("click", async () => {
    const w = workers.find((x) => x.id === workerSelect.value);
    if (!w) return toast("Elige antes un trabajador", true);
    if (!periodStartInput.value || !periodEndInput.value) return toast("Elige el periodo (fecha inicio y fin)", true);
    if (salesRows.length > 0) {
      const ok = await confirmModal({
        title: "¿Sustituir las filas actuales?",
        body: "Esto reemplaza las filas de \"Ventas por modelo\" con lo detectado automáticamente en el CRM para este periodo. Lo que hayas escrito a mano se perderá.",
        confirmLabel: "Sustituir",
      });
      if (!ok) return;
    }
    calcBtn.disabled = true;
    try {
      const res = await api("/payroll/preview", {
        method: "POST",
        body: JSON.stringify({ workerName: w.name, periodStart: periodStartInput.value, periodEnd: periodEndInput.value }),
      });
      salesRows = (res.byAccount || []).map((r) => ({ id: nextSalesRowId++, label: r.accountLabel, amount: r.amount }));
      renderSalesRows();
      updateSalesTotals();
      if (salesRows.length === 0) toast("Sin ventas detectadas en el CRM para ese periodo - añade las filas a mano.");
    } catch (err) {
      toast(err.message, true);
    } finally {
      calcBtn.disabled = false;
    }
  });

  generateBtn.addEventListener("click", async () => {
    const w = workers.find((x) => x.id === workerSelect.value);
    if (!w) return toast("Elige antes un trabajador", true);
    if (!periodStartInput.value || !periodEndInput.value) return toast("Elige el periodo", true);
    if (!fixedSalaryInput.value) return toast("Falta el salario fijo del periodo", true);
    generateBtn.disabled = true;
    try {
      if (rememberDefaultsCheck.checked) {
        await api(`/payroll/workers/${w.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            payrollFixedSalary: Number(fixedSalaryInput.value),
            payrollCommissionPct: Number(commissionInput.value) || 10,
          }),
        }).catch(() => {});
      }
      const salesByAccount = salesRows
        .map((r) => ({ accountLabel: (r.label || "").trim(), amount: round2(r.amount) }))
        .filter((r) => r.accountLabel && r.amount);
      const { payroll } = await api("/payroll", {
        method: "POST",
        body: JSON.stringify({
          workerId: w.id,
          workerName: w.name,
          role: roleInput.value.trim() || null,
          modelsManaged: modelsInput.value.trim() || null,
          periodStart: periodStartInput.value,
          periodEnd: periodEndInput.value,
          fixedSalary: Number(fixedSalaryInput.value),
          commissionPct: Number(commissionInput.value) || 10,
          salesByAccount,
          bonus: Number(bonusInput.value) || 0,
          paymentDate: paymentDateInput.value || null,
          paymentMethod: paymentMethodInput.value.trim() || null,
        }),
      });
      toast(`Nómina de ${w.name} generada: ${payroll.totalAmount.toFixed(2)} $`);
      await downloadFileFromApi(`/payroll/${payroll.id}/pdf`, `nomina-${w.name}.pdf`).catch((err) => toast("Nómina guardada, pero no se pudo descargar el PDF: " + err.message, true));
      await renderNominasHistory(historyBox);
    } catch (err) {
      toast(err.message, true);
    } finally {
      generateBtn.disabled = false;
    }
  });

  const historyBox = el("div", {});
  appEl.appendChild(el("h2", {}, "Nóminas generadas"));
  appEl.appendChild(historyBox);
  await renderNominasHistory(historyBox);
}

async function renderNominasHistory(historyBox) {
  historyBox.innerHTML = "";
  historyBox.appendChild(el("div", { class: "empty" }, "Cargando..."));
  try {
    const { payrolls } = await api("/payroll");
    historyBox.innerHTML = "";
    if (payrolls.length === 0) {
      historyBox.appendChild(el("div", { class: "empty" }, "Todavía no se ha generado ninguna nómina."));
      return;
    }
    const table = el("table", { class: "work-hours-table" });
    table.appendChild(el("thead", {}, el("tr", {}, ["Trabajador", "Periodo", "Ventas", "Comisión", "Bonificación", "Total", "Generada", ""].map((h) => el("th", {}, h)))));
    const tbody = el("tbody", {});
    table.appendChild(tbody);
    for (const p of payrolls) {
      const pdfBtn = el("button", { class: "sm" }, "PDF");
      pdfBtn.addEventListener("click", () => {
        downloadFileFromApi(`/payroll/${p.id}/pdf`, `nomina-${p.workerName}.pdf`).catch((err) => toast(err.message, true));
      });
      const wordBtn = el("button", { class: "sm" }, "Word");
      wordBtn.addEventListener("click", () => {
        downloadFileFromApi(`/payroll/${p.id}/docx`, `nomina-${p.workerName}.docx`).catch((err) => toast(err.message, true));
      });
      const delBtn = el("button", { class: "sm danger" }, "Eliminar");
      delBtn.addEventListener("click", async () => {
        const ok = await confirmModal({ title: "¿Eliminar esta nómina?", body: `Se eliminará la nómina de "${p.workerName}" (${fmtQuincenaLabel(p.periodStart)}). No se puede deshacer.`, confirmLabel: "Eliminar", danger: true });
        if (!ok) return;
        try {
          await api(`/payroll/${p.id}`, { method: "DELETE" });
          toast("Nómina eliminada");
          await renderNominasHistory(historyBox);
        } catch (err) {
          toast(err.message, true);
        }
      });
      tbody.appendChild(el("tr", {}, [
        el("td", {}, p.workerName),
        el("td", {}, fmtQuincenaLabel(p.periodStart)),
        el("td", {}, `${Number(p.totalSales).toFixed(2)} $`),
        el("td", {}, `${Number(p.commissionAmount).toFixed(2)} $`),
        el("td", {}, `${Number(p.bonus).toFixed(2)} $`),
        el("td", { style: "font-weight:700" }, `${Number(p.totalAmount).toFixed(2)} $`),
        el("td", {}, fmtDate(p.createdAt)),
        el("td", {}, [pdfBtn, wordBtn, delBtn]),
      ]));
    }
    historyBox.appendChild(table);
  } catch (err) {
    historyBox.innerHTML = "";
    historyBox.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
}

// ---------- Informes → Nóminas Modelos (justo debajo de Nóminas Chatter's) ----------
//
// Hoja de pago de una MODELO: salario fijo que decide el dueño (no hay
// comisión calculada sobre ventas del CRM, a diferencia de Nóminas
// Chatter's) + bonificaciones sueltas por servicios personalizados
// (videollamadas, contenido a medida...) anotadas una a una, con su propia
// plantilla de Word (la que compartió Aitor: "HOJA DE PAGO MODELO - ...").

async function renderModelPayrollSection() {
  appEl.appendChild(el("div", { class: "section-title-row" }, [el("h1", { style: "margin:0" }, "Nóminas Modelos")]));
  appEl.appendChild(el("p", { class: "subtitle" }, "Genera la hoja de pago de una modelo: salario fijo + bonificaciones por servicios personalizados, rellenando su propia plantilla en Word."));

  const formCard = el("div", { class: "card" });
  appEl.appendChild(formCard);
  formCard.appendChild(el("h3", {}, "Generar nómina de modelo"));

  const accountSelect = el("select", {}, [el("option", { value: "" }, "Cargando modelos...")]);
  const collaboratorInput = el("input", { placeholder: "Nombre y apellidos real de la modelo" });
  const periodStartInput = el("input", { type: "date" });
  const periodEndInput = el("input", { type: "date" });
  const quincena1Btn = el("button", { class: "sm" }, "1ª quincena (mes actual)");
  const quincena2Btn = el("button", { class: "sm" }, "2ª quincena (mes actual)");
  const fixedSalaryInput = el("input", { type: "number", min: "0", step: "0.01", placeholder: "0.00" });
  const addBonusRowBtn = el("button", { class: "sm" }, "+ Añadir bonificación");
  const bonusTableBox = el("div", {});
  const totalsBox = el("div", { class: "hint", style: "margin:6px 0 10px;font-weight:600" }, "");
  const paymentDateInput = el("input", { type: "date" });
  const paymentMethodInput = el("input", { placeholder: "Ej. Criptomonedas: USDC - POL" });
  const rememberDefaultsCheck = el("input", { type: "checkbox" });
  const generateBtn = el("button", { class: "primary" }, "Generar nómina (PDF)");

  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Modelo"), accountSelect]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre del colaborador"), collaboratorInput]));
  formCard.appendChild(el("div", { class: "field" }, [
    el("label", {}, "Periodo"),
    el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [periodStartInput, el("span", {}, "→"), periodEndInput, quincena1Btn, quincena2Btn]),
  ]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Salario fijo del periodo ($)"), fixedSalaryInput]));
  formCard.appendChild(el("div", { class: "field" }, [
    el("label", {}, "Bonificaciones (servicios personalizados)"),
    el("div", { class: "hint" }, "Un concepto por fila (ej. \"Videollamada 20 min\") con su importe - añade, edita o quita las que hagan falta."),
    el("div", { style: "margin:8px 0" }, addBonusRowBtn),
    bonusTableBox,
    totalsBox,
  ]));
  formCard.appendChild(el("div", { class: "field" }, [
    el("label", {}, "Fecha de pago"),
    paymentDateInput,
    el("div", { class: "hint" }, "Si la dejas en blanco, se pone la fecha en la que generes el PDF."),
  ]));
  formCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Método de pago"), paymentMethodInput]));
  formCard.appendChild(el("label", { class: "folder-checkbox-row" }, [rememberDefaultsCheck, el("span", {}, "Recordar nombre del colaborador y salario fijo como los de siempre de esta modelo")]));
  formCard.appendChild(generateBtn);

  let accounts = [];
  let bonusRows = []; // [{ id, concept, amount }]
  let nextBonusRowId = 1;

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function updateTotals() {
    const fixedSalary = round2(fixedSalaryInput.value);
    const bonusTotal = round2(bonusRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0));
    const total = round2(fixedSalary + bonusTotal);
    totalsBox.innerHTML = "";
    totalsBox.appendChild(el("div", {}, `Bonificaciones: ${bonusTotal.toFixed(2)} $  ·  Total a pagar: ${total.toFixed(2)} $`));
  }

  function renderBonusRows() {
    bonusTableBox.innerHTML = "";
    if (bonusRows.length === 0) {
      bonusTableBox.appendChild(el("div", { class: "empty", style: "padding:6px 0" }, "Sin bonificaciones añadidas todavía."));
    }
    for (const row of bonusRows) {
      const conceptInput = el("input", { placeholder: "Ej. Videollamada 20 min", value: row.concept || "" });
      const amountInput = el("input", { type: "number", min: "0", step: "0.01", placeholder: "0.00", value: row.amount || "" });
      const delBtn = el("button", { class: "ghost", title: "Eliminar esta fila" }, "🗑️");
      conceptInput.addEventListener("input", () => {
        row.concept = conceptInput.value;
      });
      amountInput.addEventListener("input", () => {
        row.amount = Number(amountInput.value) || 0;
        updateTotals();
      });
      delBtn.addEventListener("click", () => {
        bonusRows = bonusRows.filter((r) => r.id !== row.id);
        renderBonusRows();
        updateTotals();
      });
      bonusTableBox.appendChild(el("div", { class: "sale-add-row", style: "margin-bottom:6px" }, [conceptInput, amountInput, delBtn]));
    }
  }

  addBonusRowBtn.addEventListener("click", () => {
    bonusRows.push({ id: nextBonusRowId++, concept: "", amount: 0 });
    renderBonusRows();
    updateTotals();
  });
  fixedSalaryInput.addEventListener("input", updateTotals);
  renderBonusRows();
  updateTotals();

  quincena1Btn.addEventListener("click", () => {
    const r = quincenaRange(new Date(), 1);
    periodStartInput.value = fmtDateInput(r.start);
    periodEndInput.value = fmtDateInput(r.end);
  });
  quincena2Btn.addEventListener("click", () => {
    const r = quincenaRange(new Date(), 2);
    periodStartInput.value = fmtDateInput(r.start);
    periodEndInput.value = fmtDateInput(r.end);
  });

  try {
    const res = await api("/model-payroll/accounts");
    accounts = res.accounts || [];
    accountSelect.innerHTML = "";
    accountSelect.appendChild(el("option", { value: "" }, "Elige una modelo..."));
    for (const a of accounts) {
      accountSelect.appendChild(el("option", { value: a.id }, a.label));
    }
  } catch (err) {
    accountSelect.innerHTML = "";
    accountSelect.appendChild(el("option", { value: "" }, "Error al cargar modelos"));
    toast(err.message, true);
  }

  accountSelect.addEventListener("change", () => {
    const a = accounts.find((x) => x.id === accountSelect.value);
    if (!a) return;
    collaboratorInput.value = a.modelPayrollCollaboratorName || "";
    if (a.modelPayrollFixedSalary != null) fixedSalaryInput.value = a.modelPayrollFixedSalary;
    updateTotals();
  });

  generateBtn.addEventListener("click", async () => {
    const a = accounts.find((x) => x.id === accountSelect.value);
    if (!a) return toast("Elige antes una modelo", true);
    if (!collaboratorInput.value.trim()) return toast("Falta el nombre del colaborador", true);
    if (!periodStartInput.value || !periodEndInput.value) return toast("Elige el periodo", true);
    generateBtn.disabled = true;
    try {
      if (rememberDefaultsCheck.checked) {
        await api(`/model-payroll/accounts/${a.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            collaboratorName: collaboratorInput.value.trim(),
            fixedSalary: Number(fixedSalaryInput.value) || 0,
          }),
        }).catch(() => {});
      }
      const bonuses = bonusRows
        .map((r) => ({ concept: (r.concept || "").trim(), amount: round2(r.amount) }))
        .filter((r) => r.concept && r.amount);
      const { payroll } = await api("/model-payroll", {
        method: "POST",
        body: JSON.stringify({
          accountId: a.id,
          stageName: a.label,
          collaboratorName: collaboratorInput.value.trim(),
          periodStart: periodStartInput.value,
          periodEnd: periodEndInput.value,
          fixedSalary: Number(fixedSalaryInput.value) || 0,
          bonuses,
          paymentDate: paymentDateInput.value || null,
          paymentMethod: paymentMethodInput.value.trim() || null,
        }),
      });
      toast(`Nómina de ${a.label} generada: ${payroll.totalAmount.toFixed(2)} $`);
      await downloadFileFromApi(`/model-payroll/${payroll.id}/pdf`, `nomina-modelo-${a.label}.pdf`).catch((err) => toast("Nómina guardada, pero no se pudo descargar el PDF: " + err.message, true));
      await renderModelPayrollHistory(historyBox);
    } catch (err) {
      toast(err.message, true);
    } finally {
      generateBtn.disabled = false;
    }
  });

  const historyBox = el("div", {});
  appEl.appendChild(el("h2", {}, "Nóminas de modelos generadas"));
  appEl.appendChild(historyBox);
  await renderModelPayrollHistory(historyBox);
}

async function renderModelPayrollHistory(historyBox) {
  historyBox.innerHTML = "";
  historyBox.appendChild(el("div", { class: "empty" }, "Cargando..."));
  try {
    const { payrolls } = await api("/model-payroll");
    historyBox.innerHTML = "";
    if (payrolls.length === 0) {
      historyBox.appendChild(el("div", { class: "empty" }, "Todavía no se ha generado ninguna nómina de modelo."));
      return;
    }
    const table = el("table", { class: "work-hours-table" });
    table.appendChild(el("thead", {}, el("tr", {}, ["Modelo", "Periodo", "Salario fijo", "Bonificaciones", "Total", "Generada", ""].map((h) => el("th", {}, h)))));
    const tbody = el("tbody", {});
    table.appendChild(tbody);
    for (const p of payrolls) {
      const pdfBtn = el("button", { class: "sm" }, "PDF");
      pdfBtn.addEventListener("click", () => {
        downloadFileFromApi(`/model-payroll/${p.id}/pdf`, `nomina-modelo-${p.stageName}.pdf`).catch((err) => toast(err.message, true));
      });
      const wordBtn = el("button", { class: "sm" }, "Word");
      wordBtn.addEventListener("click", () => {
        downloadFileFromApi(`/model-payroll/${p.id}/docx`, `nomina-modelo-${p.stageName}.docx`).catch((err) => toast(err.message, true));
      });
      const delBtn = el("button", { class: "sm danger" }, "Eliminar");
      delBtn.addEventListener("click", async () => {
        const ok = await confirmModal({ title: "¿Eliminar esta nómina?", body: `Se eliminará la nómina de "${p.stageName}" (${fmtQuincenaLabel(p.periodStart)}). No se puede deshacer.`, confirmLabel: "Eliminar", danger: true });
        if (!ok) return;
        try {
          await api(`/model-payroll/${p.id}`, { method: "DELETE" });
          toast("Nómina eliminada");
          await renderModelPayrollHistory(historyBox);
        } catch (err) {
          toast(err.message, true);
        }
      });
      tbody.appendChild(el("tr", {}, [
        el("td", {}, p.stageName),
        el("td", {}, fmtQuincenaLabel(p.periodStart)),
        el("td", {}, `${Number(p.fixedSalary).toFixed(2)} $`),
        el("td", {}, `${Number(p.bonusTotal).toFixed(2)} $`),
        el("td", { style: "font-weight:700" }, `${Number(p.totalAmount).toFixed(2)} $`),
        el("td", {}, fmtDate(p.createdAt)),
        el("td", {}, [pdfBtn, wordBtn, delBtn]),
      ]));
    }
    historyBox.appendChild(table);
  } catch (err) {
    historyBox.innerHTML = "";
    historyBox.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
}

async function renderGeneralConfigSection() {
  appEl.appendChild(el("h1", {}, "Configuración general"));

  appEl.appendChild(el("div", { class: "config-group-title" }, "TODA LA AGENCIA"));
  appEl.appendChild(el("p", { class: "subtitle" }, "Estos ajustes son los mismos para todas las modelos y para todo el equipo."));

  let settings;
  try {
    settings = await api("/settings/general");
  } catch (err) {
    appEl.appendChild(el("div", { class: "card empty" }, "Error cargando ajustes: " + err.message));
    return;
  }

  appEl.appendChild(renderChipListCard({
    title: "Servicios al apuntar una venta",
    hint: "Las opciones que ve el equipo en «Servicio» cuando apunta una venta. Las ventas ya apuntadas no cambian.",
    items: settings.services,
    addPlaceholder: "Nuevo servicio (ej. CUSTOM)",
    onAdd: async (value) => {
      const next = [...settings.services, value];
      settings = await api("/settings/general", { method: "PUT", body: JSON.stringify({ services: next }) });
      return settings.services;
    },
    onRemove: async (value) => {
      const next = settings.services.filter((s) => s !== value);
      settings = await api("/settings/general", { method: "PUT", body: JSON.stringify({ services: next }) });
      return settings.services;
    },
    onReset: async () => {
      settings = await api("/settings/general/services/reset", { method: "POST" });
      return settings.services;
    },
  }));

  appEl.appendChild(renderChipListCard({
    title: "Métodos de pago al apuntar una venta",
    hint: "Las opciones que ve el equipo en «Método de pago» cuando apunta una venta.",
    items: settings.paymentMethods,
    addPlaceholder: "Nuevo método (ej. WISE)",
    onAdd: async (value) => {
      const next = [...settings.paymentMethods, value];
      settings = await api("/settings/general", { method: "PUT", body: JSON.stringify({ paymentMethods: next }) });
      return settings.paymentMethods;
    },
    onRemove: async (value) => {
      const next = settings.paymentMethods.filter((s) => s !== value);
      settings = await api("/settings/general", { method: "PUT", body: JSON.stringify({ paymentMethods: next }) });
      return settings.paymentMethods;
    },
    onReset: async () => {
      settings = await api("/settings/general/payment-methods/reset", { method: "POST" });
      return settings.paymentMethods;
    },
  }));

  // --- Comprador reciente (🔥) ---
  const buyerCard = el("div", { class: "card" });
  buyerCard.appendChild(el("h3", {}, "Comprador reciente"));
  buyerCard.appendChild(el("p", { class: "hint" }, "Marca con 🔥 en la lista de chats a quien acaba de comprar. La etiqueta se pone sola con la venta y se quita sola al cumplirse los días."));
  const showFlameCb = el("input", { type: "checkbox" });
  showFlameCb.checked = settings.recentBuyerEnabled;
  buyerCard.appendChild(el("label", { class: "checkbox-row" }, [showFlameCb, "Mostrar la etiqueta"]));

  const modeEach = el("input", { type: "radio", name: "recentBuyerMode" });
  const modeFirst = el("input", { type: "radio", name: "recentBuyerMode" });
  modeEach.checked = settings.recentBuyerMode !== "first";
  modeFirst.checked = settings.recentBuyerMode === "first";
  buyerCard.appendChild(el("label", { class: "radio-row" }, [modeEach, el("span", {}, [
    el("span", { class: "radio-label-title" }, "Cada compra"),
    el("span", { class: "radio-label-hint" }, "Cualquier venta reinicia la cuenta: mientras siga comprando, sigue marcado."),
  ])]));
  buyerCard.appendChild(el("label", { class: "radio-row" }, [modeFirst, el("span", {}, [
    el("span", { class: "radio-label-title" }, "Solo la primera"),
    el("span", { class: "radio-label-hint" }, "Marca al comprador nuevo y ya: las compras siguientes no la vuelven a encender."),
  ])]));

  const daysInput = el("input", { type: "number", min: "1", value: String(settings.recentBuyerDays) });
  buyerCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Días que dura la etiqueta"), daysInput]));

  const saveBuyerBtn = el("button", { class: "primary" }, "Guardar");
  saveBuyerBtn.addEventListener("click", async () => {
    saveBuyerBtn.disabled = true;
    try {
      settings = await api("/settings/general", {
        method: "PUT",
        body: JSON.stringify({
          recentBuyerEnabled: showFlameCb.checked,
          recentBuyerMode: modeFirst.checked ? "first" : "each",
          recentBuyerDays: Number(daysInput.value) || 7,
        }),
      });
      toast("Guardado");
      if (mensajesState.accountId) loadRecentBuyers(mensajesState.accountId);
    } catch (err) {
      toast(err.message, true);
    } finally {
      saveBuyerBtn.disabled = false;
    }
  });
  buyerCard.appendChild(saveBuyerBtn);
  appEl.appendChild(buyerCard);

  // --- Este ordenador ---
  appEl.appendChild(el("div", { class: "config-group-title" }, "ESTE ORDENADOR"));
  appEl.appendChild(el("p", { class: "subtitle" }, "Ajustes de este ordenador. No cambian nada de las modelos ni del resto del equipo."));

  const local = getLocalSettings();

  const tzCard = el("div", { class: "card" });
  tzCard.appendChild(el("h3", {}, "Zona horaria"));
  tzCard.appendChild(el("p", { class: "hint" }, "Todas las horas y fechas de la app se muestran en esta zona horaria. Cada uno ve la hora que configura en su propio ordenador."));

  const tzSearchInput = el("input", { placeholder: "Buscar (ej. Madrid, Bangkok, Caracas)..." });
  tzCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Buscar"), tzSearchInput]));
  const tzSelect = el("select", { size: "8", class: "tz-select" });
  tzCard.appendChild(el("div", { class: "field" }, [el("label", {}, "Zona horaria"), tzSelect]));

  function renderTzOptions(filter) {
    tzSelect.innerHTML = "";
    const f = (filter || "").trim().toLowerCase();
    const matches = TIMEZONES.filter((tz) => tz.toLowerCase().replace(/_/g, " ").includes(f)).slice(0, 300);
    for (const tz of matches) {
      tzSelect.appendChild(el("option", { value: tz }, tz.replace(/_/g, " ")));
    }
    if (matches.includes(local.timezone)) tzSelect.value = local.timezone;
  }
  renderTzOptions("");
  tzSearchInput.addEventListener("input", () => renderTzOptions(tzSearchInput.value));

  const tzNowEl = el("div", { class: "hint" });
  function refreshTzNow() {
    const tz = tzSelect.value;
    if (!tz) { tzNowEl.textContent = ""; return; }
    try {
      tzNowEl.textContent = "Ahora mismo en " + tz.replace(/_/g, " ") + ": " + new Date().toLocaleString("es-ES", { timeZone: tz });
    } catch {
      tzNowEl.textContent = "Esa zona horaria no se reconoce.";
    }
  }
  refreshTzNow();
  tzSelect.addEventListener("change", refreshTzNow);
  tzCard.appendChild(tzNowEl);

  const saveTzBtn = el("button", { class: "primary" }, "Guardar zona horaria");
  saveTzBtn.addEventListener("click", () => {
    const value = tzSelect.value;
    if (!value) {
      toast("Elige una zona horaria de la lista", true);
      return;
    }
    setLocalSettings({ timezone: value });
    toast("Zona horaria guardada: " + value.replace(/_/g, " "));
  });
  tzCard.appendChild(saveTzBtn);
  appEl.appendChild(tzCard);

  const fmtCard = el("div", { class: "card" });
  fmtCard.appendChild(el("h3", {}, "Formato de hora"));
  const fmt24 = el("button", { class: local.hourFormat === "12" ? "ghost" : "primary" }, "24 h");
  const fmt12 = el("button", { class: local.hourFormat === "12" ? "primary" : "ghost" }, "12 h (AM/PM)");
  fmt24.addEventListener("click", () => { setLocalSettings({ hourFormat: "24" }); renderConfigSection("general"); });
  fmt12.addEventListener("click", () => { setLocalSettings({ hourFormat: "12" }); renderConfigSection("general"); });
  fmtCard.appendChild(el("div", { class: "device-fmt-toggle" }, [fmt24, fmt12]));
  appEl.appendChild(fmtCard);

  const notifCard = el("div", { class: "card" });
  notifCard.appendChild(el("h3", {}, "Notificaciones"));
  notifCard.appendChild(el("p", { class: "hint" }, "Aviso en pantalla con el nombre de la modelo cada vez que llega un mensaje nuevo (mientras la pestaña no esté al frente). Solo afecta a este ordenador."));
  const notifCb = el("input", { type: "checkbox" });
  notifCb.checked = local.notifications;
  notifCb.addEventListener("change", async () => {
    if (notifCb.checked && typeof Notification !== "undefined" && Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        toast("El navegador no ha dado permiso para notificaciones", true);
        notifCb.checked = false;
        setLocalSettings({ notifications: false });
        return;
      }
    }
    setLocalSettings({ notifications: notifCb.checked });
  });
  notifCard.appendChild(el("label", { class: "checkbox-row" }, [notifCb, "Mostrar notificaciones de mensajes nuevos"]));
  appEl.appendChild(notifCard);

  const cacheCard = el("div", { class: "card" });
  cacheCard.appendChild(el("h3", {}, "Caché de imágenes"));
  cacheCard.appendChild(el("p", { class: "hint" }, "Si alguna miniatura o foto se ve rota/cortada/borrosa, suele ser una respuesta vieja guardada en la caché de la app. Esto la vacía y recarga todo desde cero."));
  const clearCacheBtn = el("button", {}, "Vaciar caché y recargar");
  clearCacheBtn.addEventListener("click", async () => {
    clearCacheBtn.disabled = true;
    try {
      await api("/settings/clear-cache", { method: "POST" });
      toast("Caché vaciada, recargando...");
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      toast(err.message, true);
      clearCacheBtn.disabled = false;
    }
  });
  cacheCard.appendChild(clearCacheBtn);
  appEl.appendChild(cacheCard);

  appEl.appendChild(renderDiskUsageCard());
}

// --- Espacio del servidor (Railway) ---
// Cuánto disco ocupa DE VERDAD el contenedor donde corre el panel (código,
// node_modules...). No se muestra un "total"/"% usado": sin un Volumen de
// Railway configurado, el contenedor no tiene un tamaño de disco propio -
// solo el ocupado (sumado de verdad, archivo a archivo, cacheado 5 min en el
// servidor) es un dato real; un "total" ahí sería el disco entero de la
// máquina física que le tocara a Railway esa vez, compartida con otros
// clientes, y no significa nada sobre esta app. La base de datos es un
// servicio Postgres aparte de Railway y tampoco se mide aquí.
function renderDiskUsageCard() {
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", {}, "Espacio del servidor"));
  card.appendChild(el("p", { class: "hint" }, "Disco ocupado de verdad por el contenedor de Railway donde corre el panel (código, node_modules...). No hay un \"total\" fiable que mostrar: este proyecto no tiene un Volumen de Railway con un tamaño fijo. La base de datos es un servicio aparte y tampoco se mide aquí."));

  const valueEl = el("div", { style: "font-size:22px;font-weight:700;color:var(--gold-400)" }, "Cargando...");
  const metaEl = el("div", { class: "hint", style: "margin-top:4px" }, "");
  card.appendChild(valueEl);
  card.appendChild(metaEl);

  function fmtBytes(bytes) {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
    if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + " MB";
    return Math.round(bytes / 1024) + " KB";
  }

  async function load() {
    try {
      const d = await api("/settings/disk-usage");
      valueEl.textContent = fmtBytes(d.usedBytes);
      metaEl.textContent = "Medido " + fmtDate(new Date(d.measuredAt).toISOString());
    } catch (err) {
      valueEl.textContent = "Error";
      metaEl.textContent = err.message;
    }
  }
  load();
  const timer = setInterval(() => {
    if (!document.body.contains(card)) { clearInterval(timer); return; }
    load();
  }, 60000);

  return card;
}

// ---------- Cuentas de Telegram (alta de modelos: QR o código) ----------

async function renderTelegramAccountsSection() {
  appEl.appendChild(el("div", { class: "section-title-row" }, [
    el("h1", { style: "margin:0" }, "Cuentas de Telegram"),
  ]));
  appEl.appendChild(el("p", { class: "subtitle" }, "Cuentas de Telegram conectadas al panel. Añade una modelo nueva iniciando sesión con QR o con el código que le llega por Telegram."));

  const grid = el("div", { class: "tg-accounts-grid" });
  appEl.appendChild(grid);

  try {
    const { accounts } = await api("/accounts");
    state.accounts = accounts;
    for (const acc of accounts) {
      grid.appendChild(renderTelegramAccountCard(acc));
    }
  } catch (err) {
    toast(err.message, true);
  }

  grid.appendChild(el("div", {
    class: "add-account-card",
    onclick: () => openAddTelegramAccountModal(),
  }, "+ Iniciar sesión"));
}

function renderTelegramAccountCard(acc) {
  const pill = !acc.reenviadorEnabled
    ? el("span", { class: "pill off" }, [el("span", { class: "dot" }), "Inactiva"])
    : acc.health === "PEER_FLOOD_PAUSED"
    ? el("span", { class: "pill danger" }, [el("span", { class: "dot" }), "Pausada"])
    : el("span", { class: "pill ok" }, [el("span", { class: "dot" }), "Activa"]);

  const soon = (label) => el("button", { class: "sm", onclick: () => toast(`"${label}" estará disponible próximamente`) }, label);

  return el("div", { class: "tg-account-card" }, [
    accountAvatarEl(acc.id, acc.label, "avatar"),
    el("div", { class: "name" }, acc.label),
    el("div", { class: "admin-label" }, acc.phoneNumber),
    pill,
    el("div", { class: "actions-col" }, [
      el("button", { class: "sm", onclick: () => openAddTelegramAccountModal({ reconnectAccount: acc }) }, "Reconectar cuenta"),
      soon("Subir historia"),
      soon("Exportar clientes"),
      soon("Exportar time wasters"),
      soon("Copia de fans"),
      soon("Restaurar"),
      el("button", { class: "sm danger", onclick: () => deleteTelegramAccount(acc) }, "Eliminar cuenta"),
    ]),
  ]);
}

async function deleteTelegramAccount(acc) {
  const ok = await confirmModal({
    title: "¿Eliminar esta cuenta?",
    body: `Se eliminará "${acc.label}" (${acc.phoneNumber}) del panel junto con todas sus campañas, orígenes y logs. Esto NO cierra la sesión en el propio Telegram, pero el panel dejará de poder usarla. No se puede deshacer.`,
    confirmLabel: "Eliminar cuenta",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/accounts/${acc.id}`, { method: "DELETE" });
    toast("Cuenta eliminada");
    if (state.currentAccountId === acc.id) state.currentAccountId = null;
    renderConfigSection("cuentas-telegram");
  } catch (err) {
    toast(err.message, true);
  }
}

// reconnectAccount (opcional): cuenta YA existente que se quiere volver a
// iniciar sesión sin perder nada de lo configurado (campañas, notas SFS,
// carpeta guardada, grupos restringidos...). Como account-login/*/verify
// guarda por "upsert" sobre el teléfono (ver finalizeLogin en el backend),
// reconectar con el MISMO teléfono actualiza la fila existente en vez de
// crear una cuenta duplicada - por eso aquí se bloquea el campo teléfono al
// de la cuenta original en vez de dejarlo en blanco.
function openAddTelegramAccountModal(opts = {}) {
  const reconnectAccount = opts.reconnectAccount || null;
  let activeTab = "qr";
  let pollTimer = null;

  const accountName = el("input", { placeholder: "Ej. Zoweey" });
  if (reconnectAccount) accountName.value = reconnectAccount.label;

  // Tras un login con éxito: si era una reconexión, avisa si por lo que sea
  // el resultado fue una cuenta DISTINTA a la que se quería reconectar (se
  // escaneó/verificó con otro número) - eso significa que se ha creado o
  // actualizado una cuenta nueva en vez de la original, y conviene que se
  // note en vez de pasar desapercibido.
  function notifyLoginSuccess(accountId) {
    if (reconnectAccount) {
      if (accountId && accountId !== reconnectAccount.id) {
        toast(`Atención: se inició sesión con un número distinto al de "${reconnectAccount.label}" - se ha guardado como otra cuenta, no como una reconexión de esta.`, true);
      } else {
        toast(`"${reconnectAccount.label}" reconectada. Todo lo configurado se mantiene.`);
      }
    } else {
      toast(`Cuenta "${accountName.value.trim()}" añadida correctamente`);
    }
  }

  const qrTabBtn = el("div", { class: "login-tab active" }, "Código QR");
  const codeTabBtn = el("div", { class: "login-tab" }, "Código de Telegram");
  const tabsRow = el("div", { class: "login-tabs" }, [qrTabBtn, codeTabBtn]);

  const bodyContainer = el("div", {});

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function renderQrTab() {
    stopPolling();
    bodyContainer.innerHTML = "";
    const startBtn = el("button", { class: "primary", style: "width:100%" }, "Generar QR");
    const box = el("div", { class: "qr-box" });
    bodyContainer.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre de la cuenta"), accountName]));
    bodyContainer.appendChild(startBtn);
    bodyContainer.appendChild(box);

    startBtn.addEventListener("click", async () => {
      if (!accountName.value.trim()) return toast("Ponle un nombre a la cuenta", true);
      startBtn.disabled = true;
      box.innerHTML = "";
      try {
        const res = await api("/account-login/qr/start", {
          method: "POST",
          body: JSON.stringify({ accountName: accountName.value.trim() }),
        });
        renderQrWaiting(res.loginId, res.qrToken, box);
        pollTimer = setInterval(() => pollQrStatus(res.loginId, box), 2500);
      } catch (err) {
        toast(err.message, true);
      } finally {
        startBtn.disabled = false;
      }
    });
  }

  function renderQrWaiting(loginId, qrToken, box) {
    box.innerHTML = "";
    if (qrToken) {
      const imgUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(qrToken);
      box.appendChild(el("img", { src: imgUrl, alt: "Código QR de Telegram" }));
    }
    box.appendChild(el("div", { class: "qr-hint" }, "Abre Telegram en el móvil de la modelo → Ajustes → Dispositivos vinculados → Vincular dispositivo, y escanea este código."));
    if (reconnectAccount) {
      box.appendChild(el("div", { class: "qr-hint", style: "color:var(--red)" }, `Importante: escanea con la cuenta de Telegram de "${reconnectAccount.label}" (${reconnectAccount.phoneNumber}). Si escaneas con otro número, se creará una cuenta nueva en vez de reconectar esta.`));
    }
    box.appendChild(el("div", { class: "qr-status" }, "Esperando escaneo..."));
  }

  async function pollQrStatus(loginId, box) {
    try {
      const res = await api(`/account-login/qr/${loginId}/status`);
      if (res.status === "pending_password") {
        stopPolling();
        renderPasswordStep(loginId, "qr", box);
      } else if (res.status === "success") {
        stopPolling();
        notifyLoginSuccess(res.accountId);
        closeModal();
        state.configSection = "cuentas-telegram";
        renderConfigSection("cuentas-telegram");
      } else if (res.status === "error" || res.status === "expired") {
        stopPolling();
        box.appendChild(el("div", { class: "qr-status", style: "color:var(--red)" }, res.error || "El código QR ha caducado, genera uno nuevo."));
      }
    } catch (err) {
      stopPolling();
      box.appendChild(el("div", { class: "qr-status", style: "color:var(--red)" }, err.message));
    }
  }

  function renderPasswordStep(loginId, kind, box) {
    box.innerHTML = "";
    box.appendChild(el("div", { class: "qr-hint" }, "Esta cuenta tiene verificación en dos pasos. Introduce su contraseña de Telegram."));
    const pwd = el("input", { type: "password", placeholder: "Contraseña de verificación en dos pasos" });
    const submitBtn = el("button", { class: "primary", style: "width:100%;margin-top:10px" }, "Confirmar");
    submitBtn.addEventListener("click", async () => {
      if (!pwd.value) return toast("Introduce la contraseña", true);
      submitBtn.disabled = true;
      try {
        const pr = await api(`/account-login/${kind}/${loginId}/password`, {
          method: "POST",
          body: JSON.stringify({ password: pwd.value }),
        });
        notifyLoginSuccess(pr.accountId);
        closeModal();
        state.configSection = "cuentas-telegram";
        renderConfigSection("cuentas-telegram");
      } catch (err) {
        toast(err.message, true);
        submitBtn.disabled = false;
      }
    });
    box.appendChild(pwd);
    box.appendChild(submitBtn);
  }

  function renderCodeTab() {
    stopPolling();
    bodyContainer.innerHTML = "";
    const phone = el("input", { placeholder: "+34600111222" });
    if (reconnectAccount) {
      phone.value = reconnectAccount.phoneNumber;
      phone.readOnly = true;
    }
    bodyContainer.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre de la cuenta"), accountName]));
    bodyContainer.appendChild(el("div", { class: "field" }, [el("label", {}, "Teléfono"), phone]));
    if (reconnectAccount) {
      bodyContainer.appendChild(el("div", { class: "hint" }, "El teléfono está bloqueado al de esta cuenta para reconectar la misma, en vez de crear una nueva."));
    }
    const sendBtn = el("button", { class: "primary", style: "width:100%" }, "Enviar código");
    bodyContainer.appendChild(sendBtn);
    const stepBox = el("div", { class: "qr-box" });
    bodyContainer.appendChild(stepBox);

    sendBtn.addEventListener("click", async () => {
      if (!accountName.value.trim() || !phone.value.trim()) return toast("Rellena nombre y teléfono", true);
      sendBtn.disabled = true;
      try {
        const res = await api("/account-login/code/start", {
          method: "POST",
          body: JSON.stringify({ phone: phone.value.trim(), accountName: accountName.value.trim() }),
        });
        stepBox.innerHTML = "";
        stepBox.appendChild(el("div", { class: "qr-hint" }, "Telegram ha enviado un código a esa cuenta. Introdúcelo aquí."));
        const codeInput = el("input", { placeholder: "Código recibido" });
        const verifyBtn = el("button", { class: "primary", style: "width:100%;margin-top:10px" }, "Verificar código");
        verifyBtn.addEventListener("click", async () => {
          if (!codeInput.value.trim()) return toast("Introduce el código", true);
          verifyBtn.disabled = true;
          try {
            const vr = await api(`/account-login/code/${res.loginId}/verify`, {
              method: "POST",
              body: JSON.stringify({ code: codeInput.value.trim() }),
            });
            if (vr.status === "password_needed") {
              renderPasswordStep(res.loginId, "code", stepBox);
            } else {
              notifyLoginSuccess(vr.accountId);
              closeModal();
              state.configSection = "cuentas-telegram";
              renderConfigSection("cuentas-telegram");
            }
          } catch (err) {
            toast(err.message, true);
            verifyBtn.disabled = false;
          }
        });
        stepBox.appendChild(codeInput);
        stepBox.appendChild(verifyBtn);
      } catch (err) {
        toast(err.message, true);
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  qrTabBtn.addEventListener("click", () => {
    if (activeTab === "qr") return;
    activeTab = "qr";
    qrTabBtn.classList.add("active");
    codeTabBtn.classList.remove("active");
    renderQrTab();
  });
  codeTabBtn.addEventListener("click", () => {
    if (activeTab === "code") return;
    activeTab = "code";
    codeTabBtn.classList.add("active");
    qrTabBtn.classList.remove("active");
    renderCodeTab();
  });

  let closeModal = () => {};
  openModal((modal, close) => {
    closeModal = () => { stopPolling(); close(); };
    modal.appendChild(el("h3", {}, reconnectAccount ? `Reconectar "${reconnectAccount.label}"` : "Añadir cuenta"));
    modal.appendChild(el("p", { class: "hint" }, reconnectAccount
      ? "Vuelve a iniciar sesión en Telegram para esta cuenta sin perder nada de lo configurado (campañas, notas, carpetas, grupos restringidos...). Solo se renueva la sesión."
      : "La cuenta quedará guardada de forma segura (sesión cifrada) para usarla desde el Reenviador."));
    modal.appendChild(tabsRow);
    modal.appendChild(bodyContainer);
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: () => closeModal() }, "Cancelar"),
    ]));
    renderQrTab();
  });
}

// ---------- Equipo: login de trabajadores ----------
//
// Capa AÑADIDA sobre el candado general del panel (Basic Auth, que sigue
// pidiéndose para todo el sitio exactamente igual que antes). Si nadie ha
// iniciado sesión como trabajador, el panel se comporta 100% como hasta
// hoy (el dueño, solo con el Basic Auth). Si hay una sesión de trabajador
// con rol "worker", el panel se reduce a Mensajes (+ bóveda/SFS dentro del
// chat) y solo para las cuentas que se le hayan concedido en
// Configuración → Equipo. Un trabajador con rol "admin" ve todo, igual que
// el dueño.

async function fetchWorkerSession() {
  try {
    const res = await api("/auth/me");
    state.currentWorker = res.worker || null;
    state.workerPermissions = res.permissions || [];
    // Sin cookie de trabajador (el dueño, cuenta luxe) "/auth/me" no manda
    // worker, pero sí este nombre - se usa para precargar "Vendido por" al
    // registrar una venta (ver openSaleModal/renderSalesCard en Mensajes),
    // igual que ya se precarga con el nombre del trabajador cuando lo hay.
    state.ownerName = res.ownerName || null;
    // Multi-agencia: solo el súper-admin (PANEL_USERNAME/PANEL_PASSWORD de
    // Railway, ver utils/auth.ts) ve la sección "Agencias" del menú.
    state.isSuperAdmin = !!res.isSuperAdmin;
    // "Viendo como otra agencia" (ver Agencias → "Ver datos"): solo tiene
    // sentido para el súper-admin - para cualquier otra sesión (dueño de una
    // agencia nueva, o ausente) se trata como "true" (su propia agencia) a
    // propósito, para que el aviso de renderSidenav nunca se enseñe de más.
    state.viewingOwnAgency = res.viewingOwnAgency !== false;
    // Marca blanca: isLegacyAgency no viene cuando no hay sesión en
    // absoluto (visitante anónimo, p.ej. a punto de caer en /login) - se
    // trata como "true" (marca de LUXE) a propósito, porque ese portal es
    // compartido por todas las agencias y todavía no se sabe quién va a
    // entrar.
    state.isLegacyAgency = res.isLegacyAgency !== undefined ? !!res.isLegacyAgency : true;
    state.agencyBrandName = res.agencyName || null;
    state.isReadOnlyWorker = !!res.readOnly;
  } catch {
    state.currentWorker = null;
    state.workerPermissions = [];
    state.ownerName = null;
    state.isSuperAdmin = false;
    state.viewingOwnAgency = true;
    state.isLegacyAgency = true;
    state.agencyBrandName = null;
    state.isReadOnlyWorker = false;
  }
  applyBranding();
}

/** Marca blanca: pinta el título de la pestaña, el favicon, y el
 * logo/nombre de marca (barra lateral + topbar móvil) según de quién es la
 * sesión actual - SOLO tu propia agencia (legacy-agency) ve "LUREQO
 * MANAGEMENT" y su logo real; cualquier otra agencia, o uno de sus
 * trabajadores, ve el nombre de SU agencia y ningún logo. Se llama una vez
 * al final de fetchWorkerSession() (nada más saber de quién es la sesión),
 * así que cubre tanto el panel completo del dueño como el panel reducido
 * de un trabajador - los dos comparten el mismo index.html/barra lateral.
 */
function applyBranding() {
  const isLegacy = state.isLegacyAgency;
  const brandName = isLegacy ? "LUREQO" : (state.agencyBrandName || "Panel");

  document.title = isLegacy ? "LUREQO — Panel" : `${brandName} — Panel`;

  const favicon = document.getElementById("faviconLink");
  if (favicon) favicon.href = isLegacy ? "/assets/logo.png" : "data:,";

  const topbarLogo = document.getElementById("mobileTopbarLogo");
  const topbarTitle = document.getElementById("mobileTopbarTitle");
  if (topbarLogo) {
    if (isLegacy) {
      topbarLogo.src = "/assets/logo.png";
      topbarLogo.classList.remove("hidden");
    } else {
      topbarLogo.removeAttribute("src");
      topbarLogo.classList.add("hidden");
    }
  }
  if (topbarTitle) topbarTitle.textContent = brandName;

  const brandBlock = document.getElementById("brandBlock");
  const brandLogo = document.getElementById("brandLogo");
  const brandText = document.getElementById("brandText");
  if (brandBlock) {
    brandBlock.setAttribute("data-tooltip", brandName);
    // Sin logo propio (cualquier agencia que no sea la tuya): una inicial
    // dentro de un círculo neutro, para que la barra colapsada (ver
    // Mensajes) no se quede con un hueco vacío donde iría el logo.
    const existingInitial = brandBlock.querySelector(".brand-initial");
    if (existingInitial) existingInitial.remove();
    if (!isLegacy) {
      brandBlock.insertBefore(
        el("div", { class: "brand-initial" }, (brandName.trim()[0] || "?").toUpperCase()),
        brandBlock.firstChild
      );
    }
  }
  if (brandLogo) {
    if (isLegacy) {
      brandLogo.src = "/assets/logo.png";
      brandLogo.alt = "LUREQO";
      brandLogo.classList.remove("hidden");
    } else {
      brandLogo.removeAttribute("src");
      brandLogo.alt = "";
      brandLogo.classList.add("hidden");
    }
  }
  if (brandText) {
    brandText.innerHTML = "";
    if (isLegacy) {
      brandText.appendChild(el("div", { class: "brand-title" }, "LUREQO"));
      brandText.appendChild(el("div", { class: "brand-title" }, "CRM"));
    } else {
      // Nombre de la agencia en 1-2 líneas (partido por palabras, como el
      // de LUXE) para que quepa igual en la barra lateral.
      const words = brandName.split(" ").filter(Boolean);
      if (words.length > 1) {
        const mid = Math.ceil(words.length / 2);
        brandText.appendChild(el("div", { class: "brand-title" }, words.slice(0, mid).join(" ")));
        brandText.appendChild(el("div", { class: "brand-title" }, words.slice(mid).join(" ")));
      } else {
        brandText.appendChild(el("div", { class: "brand-title" }, brandName));
      }
    }
  }
}

/** Nombre para precargar "Vendido por": el del trabajador logueado, o si no
 * hay ninguno (sesión del dueño), el nombre de la cuenta luxe. */
function currentChatterDisplayName() {
  return (state.currentWorker && state.currentWorker.name) || state.ownerName || "";
}

/** Desplegable "Vendido por" del formulario de registrar venta (Mensajes,
 * Mensajes Pro, y "Registrar venta" desde Pagos): para un chatter normal
 * (sesión de trabajador con rol "worker") queda BLOQUEADO en su propio
 * nombre, sin poder tocarlo. El dueño (cuenta luxe, sin cookie de
 * trabajador) Y cualquier trabajador con rol "admin" -esto incluye a
 * quien entra a Mensajes Pro con una cuenta de admin, no solo al dueño-
 * pueden elegir entre el equipo entero, para poder apuntar una venta a
 * nombre de otro chatter. El backend vuelve a exigir esto mismo por su
 * cuenta (ver POST /accounts/:id/dialogs/:chatId/sales en messages.ts),
 * así que aunque alguien manipulase la petición a mano tampoco se lo
 * saltaría. */
function createSoldBySelector() {
  const own = currentChatterDisplayName();
  const select = el("select", {}, [el("option", { value: own }, own)]);
  select.value = own;
  if (state.currentWorker) {
    // Cualquier trabajador (Chatter o Team líder): fijo a su propio
    // nombre, sin poder cambiarlo - ver el mismo perfil aplicado en el
    // backend (messages.ts, al registrar la venta).
    select.disabled = true;
    select.title = "Solo el dueño puede cambiar quién vendió.";
    return select;
  }
  // Dueño (cuenta luxe): se rellena con TODO el equipo (activos e
  // inactivos - puede seguir apuntando una venta a nombre de alguien que
  // ya no esté activo, por si hace falta corregir algo antiguo) para poder
  // reasignar la venta. Si la propia cuenta luxe
  // también está dada de alta como empleado en el Equipo (con su propio
  // nombre, p.ej. "Aitor"), no sale duplicada aparte como "Cuenta luxe":
  // se compara sin mayúsculas/espacios y se deja solo el nombre de verdad
  // que usa el Equipo. Si falla (o no hay ningún empleado dado de alta),
  // se queda con la única opción propia ya precargada arriba.
  api("/workers").then((res) => {
    const names = [];
    const seen = new Set();
    const addName = (n) => {
      const key = (n || "").trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      names.push(n);
    };
    for (const w of res.workers || []) addName(w.name);
    addName(own);
    const ownKey = own.trim().toLowerCase();
    const matched = names.find((n) => n.trim().toLowerCase() === ownKey) || own;
    select.innerHTML = "";
    for (const name of names) select.appendChild(el("option", { value: name }, name));
    select.value = matched;
  }).catch(() => {
    // sigue con la única opción propia (ver arriba) - no bloquea el registro de la venta
  });
  return select;
}

// ---------- "Fichar" (entrada/salida/descanso): un cuadrado en el propio
// menú lateral del trabajador, justo debajo de "Cerrar sesión" - no
// flotante. Como sidenavEl.innerHTML = "" se vacía y repinta en cada
// cambio de vista (ver renderWorkerNav), el nodo se crea UNA sola vez
// (startClockWidget) y se vuelve a colgar (mismo nodo, se mueve solo) cada
// vez que el menú se repinta, para no perder su temporizador de sondeo ni
// crear uno nuevo cada vez. Ver api/clock.ts. ----------

let clockWidgetEl = null;
let clockWidgetTimer = null;
let clockWidgetBusy = false;

function fmtClockSince(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function stopClockWidget() {
  if (clockWidgetTimer) { clearInterval(clockWidgetTimer); clockWidgetTimer = null; }
  if (clockWidgetEl && clockWidgetEl.parentNode) clockWidgetEl.parentNode.removeChild(clockWidgetEl);
  clockWidgetEl = null;
}

/** Cuelga el cuadrado de fichar (creándolo la primera vez) al final del
 * menú lateral, justo después de "Cerrar sesión" - se llama al final de
 * cada renderWorkerNav(). */
function attachClockWidget() {
  if (!clockWidgetEl) {
    clockWidgetEl = el("div", { class: "clock-widget" }, el("div", { class: "empty" }, "Cargando..."));
    refreshClockWidget();
    clockWidgetTimer = setInterval(refreshClockWidget, 30000);
  }
  sidenavEl.appendChild(clockWidgetEl);
}

async function refreshClockWidget() {
  if (!clockWidgetEl) return;
  let status;
  try {
    status = await api("/clock/status");
  } catch {
    return; // si falla (ej. sesión caducada), se deja el widget como estaba
  }
  clockWidgetEl.innerHTML = "";

  const clockSquare = el("button", {
    class: "clock-square" + (status.clockedIn ? " clocked-in" : ""),
  }, [
    el("span", { class: "clock-square-icon" }, status.clockedIn ? "🟢" : "🔴"),
    el("span", { class: "clock-square-label" }, status.clockedIn ? "Fichar salida" : "Fichar entrada"),
    el("span", { class: "clock-square-since" },
      status.clockedIn ? `Desde ${fmtClockSince(status.clockedInSince)}` : "Sin fichar"),
  ]);
  clockSquare.addEventListener("click", async () => {
    if (clockWidgetBusy) return;
    clockWidgetBusy = true;
    clockSquare.disabled = true;
    try {
      await api(`/clock/${status.clockedIn ? "out" : "in"}`, { method: "POST" });
      await refreshClockWidget();
    } catch (err) {
      toast(err.message, true);
    } finally {
      clockWidgetBusy = false;
    }
  });
  clockWidgetEl.appendChild(clockSquare);

  const breakBtn = el("button", { class: "clock-break-btn" + (status.onBreak ? " on-break" : "") },
    status.onBreak ? `☕ Terminar descanso (${fmtClockSince(status.breakSince)})` : `☕ Descanso (${status.breakRemainingMinutes} min)`);
  breakBtn.disabled = !status.clockedIn || (!status.onBreak && status.breakRemainingMinutes <= 0);
  breakBtn.addEventListener("click", async () => {
    if (clockWidgetBusy) return;
    clockWidgetBusy = true;
    breakBtn.disabled = true;
    try {
      await api(`/clock/break/${status.onBreak ? "end" : "start"}`, { method: "POST" });
      await refreshClockWidget();
    } catch (err) {
      toast(err.message, true);
    } finally {
      clockWidgetBusy = false;
    }
  });
  clockWidgetEl.appendChild(breakBtn);
}

async function workerLogout() {
  stopClockWidget();
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {
    // si falla la llamada, igualmente mandamos a la pantalla de login
  }
  window.location.href = "/";
}

async function renderWorkerRestrictedShell() {
  document.body.classList.remove("worker-login-mode");
  state.currentView = "mensajes";
  startGlobalMessageNotifications();

  const permittedAccountIds = [...new Set(
    state.workerPermissions.filter((p) => p.section === "mensajes").map((p) => p.accountId)
  )];

  // "SFS": la única pestaña extra de un Team líder (role "admin") frente a
  // un Chatter - nunca visible para un Chatter, aunque por datos antiguos
  // le quedara algún WorkerPermission de "sfs" suelto (el rol manda, ver
  // requireSectionAccess en utils/auth.ts). Solo el sub-apartado "Chat" +
  // "Grupo SFS" (reenviar sin desvelar quién lo manda) - "Just Another
  // Panel" (comprar vistas/miembros de verdad, dinero real) se queda fuera,
  // reservado al dueño en la vista completa de SFS.
  const isTeamLead = !!state.currentWorker && state.currentWorker.role === "admin";
  const permittedSfsAccountIds = [...new Set(
    state.workerPermissions.filter((p) => p.section === "sfs").map((p) => p.accountId)
  )];
  let workerSfsAccountId = null;
  let workerSfsSubTab = "chat"; // "chat" | "grupo"

  // "Programar posts": la otra pestaña extra de un Team líder frente a un
  // Chatter (junto con SFS de arriba) - reutiliza tal cual las funciones ya
  // existentes de la vista completa (openProgramarPostsView/
  // renderProgramarPostsView/renderProgramarPostsAccountList), solo que
  // aquí se apunta state.accounts a las cuentas con el permiso
  // "programar-posts" concedido en vez de a todas.
  const permittedProgramarPostsAccountIds = [...new Set(
    state.workerPermissions.filter((p) => p.section === "programar-posts").map((p) => p.accountId)
  )];

  // "Pagos": a diferencia de Mensajes/Mensajes Pro/SFS, no depende de ningún
  // permiso por cuenta (WorkerPermission) - cualquier chatter puede entrar,
  // pero solo ve los ingresos del día en curso (el backend lo obliga igual
  // en /api/incoming-payments, no solo aquí en el frontend). El admin sigue
  // viendo el histórico completo con filtros desde la vista normal de Pagos
  // (renderPagosShell), a la que solo se llega con la barra lateral completa.
  function renderWorkerNav() {
    // Igual que en el panel del dueño/jefe (renderSidenav): dentro de
    // "Mensajes" (y, para un Team líder, dentro de SFS → Chat) la barra se
    // minimiza a solo iconos, con el nombre como tooltip al pasar el ratón.
    const collapsed = state.currentView === "mensajes" || (state.currentView === "sfs" && workerSfsSubTab === "chat");
    if (sidebarEl) sidebarEl.classList.toggle("sidebar-collapsed", collapsed);
    sidenavEl.innerHTML = "";
    // "Solo lectura" (Equipo → Permisos): aviso fijo arriba del todo para que
    // quede claro por qué los botones de enviar/guardar no funcionan - el
    // bloqueo de verdad está en el servidor, esto es solo para que no
    // parezca que el panel está roto.
    if (state.isReadOnlyWorker) {
      const tooltipAttrs = collapsed ? { "data-tooltip": "Solo lectura" } : {};
      sidenavEl.appendChild(el("div", { class: "nav-item read-only-banner", ...tooltipAttrs }, [
        el("span", { class: "nav-icon" }, "👁️"),
        el("span", { class: "nav-label" }, "Solo lectura"),
      ]));
    }
    sidenavEl.appendChild(el("a", {
      class: "nav-item" + (state.currentView === "mensajes" ? " active" : ""),
      href: "#",
      ...(collapsed ? { "data-tooltip": "Mensajes" } : {}),
      onclick: (e) => { e.preventDefault(); closeMobileNav(); showWorkerMensajesView(); },
    }, [
      el("span", { class: "nav-icon" }, "💬"),
      el("span", { class: "nav-label" }, "Mensajes"),
    ]));
    sidenavEl.appendChild(el("a", {
      class: "nav-item",
      href: "#",
      ...(collapsed ? { "data-tooltip": "Mensajes Pro" } : {}),
      onclick: (e) => { e.preventDefault(); closeMobileNav(); window.open("/mensajes-pro", "_blank"); },
    }, [
      el("span", { class: "nav-icon" }, "⭐"),
      el("span", { class: "nav-label" }, "Mensajes Pro"),
    ]));
    sidenavEl.appendChild(el("a", {
      class: "nav-item" + (state.currentView === "pagos" ? " active" : ""),
      href: "#",
      ...(collapsed ? { "data-tooltip": "Pagos" } : {}),
      onclick: (e) => { e.preventDefault(); closeMobileNav(); showWorkerPagosView(); },
    }, [
      el("span", { class: "nav-icon" }, "💳"),
      el("span", { class: "nav-label" }, "Pagos"),
    ]));
    sidenavEl.appendChild(el("a", {
      class: "nav-item" + (state.currentView === "nominas" ? " active" : ""),
      href: "#",
      ...(collapsed ? { "data-tooltip": "Nóminas" } : {}),
      onclick: (e) => { e.preventDefault(); closeMobileNav(); showWorkerNominasView(); },
    }, [
      el("span", { class: "nav-icon" }, "🧾"),
      el("span", { class: "nav-label" }, "Nóminas"),
    ]));
    sidenavEl.appendChild(el("a", {
      class: "nav-item" + (state.currentView === "rendimiento" ? " active" : ""),
      href: "#",
      ...(collapsed ? { "data-tooltip": "Mi rendimiento" } : {}),
      onclick: (e) => { e.preventDefault(); closeMobileNav(); showWorkerPerformanceView(); },
    }, [
      el("span", { class: "nav-icon" }, "📈"),
      el("span", { class: "nav-label" }, "Mi rendimiento"),
    ]));
    if (isTeamLead) {
      sidenavEl.appendChild(el("a", {
        class: "nav-item" + (state.currentView === "sfs" ? " active" : ""),
        href: "#",
        ...(collapsed ? { "data-tooltip": "SFS" } : {}),
        onclick: (e) => { e.preventDefault(); closeMobileNav(); showWorkerSfsView(); },
      }, [
        el("span", { class: "nav-icon" }, "🔁"),
        el("span", { class: "nav-label" }, "SFS"),
      ]));
      sidenavEl.appendChild(el("a", {
        class: "nav-item" + (state.currentView === "programar-posts" ? " active" : ""),
        href: "#",
        ...(collapsed ? { "data-tooltip": "Programar posts" } : {}),
        onclick: (e) => { e.preventDefault(); closeMobileNav(); showWorkerProgramarPostsView(); },
      }, [
        el("span", { class: "nav-icon" }, "🗓️"),
        el("span", { class: "nav-label" }, "Programar posts"),
      ]));
    }
    sidenavEl.appendChild(el("a", {
      class: "nav-item" + (state.currentView === "ayuda" ? " active" : ""),
      href: "#",
      ...(collapsed ? { "data-tooltip": "Ayuda" } : {}),
      onclick: (e) => { e.preventDefault(); closeMobileNav(); showWorkerAyudaView(); },
    }, [
      el("span", { class: "nav-icon" }, "❓"),
      el("span", { class: "nav-label" }, "Ayuda"),
    ]));
    navRerender = renderWorkerNav;
    sidenavEl.appendChild(buildThemeNavItem(collapsed));
    sidenavEl.appendChild(el("a", {
      class: "nav-item worker-logout-item",
      href: "#",
      ...(collapsed ? { "data-tooltip": "Cerrar sesión" } : {}),
      onclick: (e) => { e.preventDefault(); workerLogout(); },
    }, [
      el("span", { class: "nav-icon" }, "🚪"),
      el("span", { class: "nav-label" }, "Cerrar sesión"),
    ]));
    attachClockWidget();
  }

  async function showWorkerMensajesView() {
    state.currentView = "mensajes";
    renderWorkerNav();
    accountListEl.innerHTML = "";
    accountListEl.appendChild(el("div", { class: "account-list-title" }, state.currentWorker.name));

    if (permittedAccountIds.length === 0) {
      appEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes acceso a ninguna cuenta. Pide a tu agencia que te lo conceda desde Configuración → Equipo."));
      return;
    }
    try {
      const { accounts } = await api("/accounts");
      state.accounts = accounts.filter((a) => permittedAccountIds.includes(a.id));
      renderAccountList();
      if (state.accounts.length > 0) {
        await selectAccount(state.accounts[0].id);
      } else {
        appEl.innerHTML = "";
        appEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes acceso a ninguna cuenta. Pide a tu agencia que te lo conceda desde Configuración → Equipo."));
      }
    } catch (err) {
      appEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "card" }, "Error cargando cuentas: " + err.message));
    }
  }

  function showWorkerPagosView() {
    state.currentView = "pagos";
    renderWorkerNav();
    accountListEl.innerHTML = "";
    appEl.innerHTML = "";
    renderWorkerPagosView(appEl);
  }

  function showWorkerAyudaView() {
    state.currentView = "ayuda";
    renderWorkerNav();
    accountListEl.innerHTML = "";
    appEl.innerHTML = "";
    renderAyudaView(appEl);
  }

  function showWorkerNominasView() {
    state.currentView = "nominas";
    renderWorkerNav();
    accountListEl.innerHTML = "";
    appEl.innerHTML = "";
    renderWorkerNominasView(appEl);
  }

  function showWorkerPerformanceView() {
    state.currentView = "rendimiento";
    renderWorkerNav();
    accountListEl.innerHTML = "";
    appEl.innerHTML = "";
    renderWorkerPerformanceView(appEl);
  }

  async function showWorkerSfsView() {
    if (!isTeamLead) return; // por si se llega a llamar desde algún sitio inesperado
    state.currentView = "sfs";
    renderWorkerNav();
    appEl.innerHTML = "";

    if (permittedSfsAccountIds.length === 0) {
      accountListEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes acceso a SFS en ninguna cuenta. Pide a tu agencia que te lo conceda desde Configuración → Equipo."));
      return;
    }
    try {
      const { accounts } = await api("/accounts");
      state.accounts = accounts.filter((a) => permittedSfsAccountIds.includes(a.id));
    } catch (err) {
      accountListEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "card" }, "Error cargando cuentas: " + err.message));
      return;
    }
    if (state.accounts.length === 0) {
      accountListEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes acceso a SFS en ninguna cuenta. Pide a tu agencia que te lo conceda desde Configuración → Equipo."));
      return;
    }
    if (!workerSfsAccountId || !state.accounts.some((a) => a.id === workerSfsAccountId)) {
      workerSfsAccountId = state.accounts[0].id;
    }
    renderWorkerSfsAccountList();
    await renderWorkerSfsSection();
  }

  async function showWorkerProgramarPostsView() {
    if (!isTeamLead) return; // por si se llega a llamar desde algún sitio inesperado
    state.currentView = "programar-posts";
    renderWorkerNav();
    appEl.innerHTML = "";

    if (permittedProgramarPostsAccountIds.length === 0) {
      accountListEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes acceso a Programar posts en ninguna cuenta. Pide a tu agencia que te lo conceda desde Configuración → Equipo."));
      return;
    }
    try {
      const { accounts } = await api("/accounts");
      state.accounts = accounts.filter((a) => permittedProgramarPostsAccountIds.includes(a.id));
    } catch (err) {
      accountListEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "card" }, "Error cargando cuentas: " + err.message));
      return;
    }
    if (state.accounts.length === 0) {
      accountListEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes acceso a Programar posts en ninguna cuenta. Pide a tu agencia que te lo conceda desde Configuración → Equipo."));
      return;
    }
    if (!programarPostsAccountId || !state.accounts.some((a) => a.id === programarPostsAccountId)) {
      programarPostsAccountId = state.accounts[0].id;
    }
    renderProgramarPostsAccountList();
    await renderProgramarPostsView();
  }

  function selectWorkerSfsAccount(id) {
    if (workerSfsAccountId === id) return;
    workerSfsAccountId = id;
    renderWorkerSfsAccountList();
    renderWorkerSfsSection();
  }

  function setWorkerSfsSubTab(tab) {
    if (workerSfsSubTab === tab) return;
    workerSfsSubTab = tab;
    renderWorkerNav(); // el chat colapsa la barra lateral, el grupo no
    renderWorkerSfsAccountList();
    renderWorkerSfsSection();
  }

  function renderWorkerSfsAccountList() {
    accountListEl.innerHTML = "";
    accountListEl.appendChild(el("div", { class: "account-list-title" }, "Cuentas"));
    for (const acc of state.accounts) {
      accountListEl.appendChild(el("div", {
        class: "account-item" + (acc.id === workerSfsAccountId ? " active" : ""),
        onclick: () => selectWorkerSfsAccount(acc.id),
      }, [
        accountAvatarEl(acc.id, acc.label),
        el("div", { class: "account-name" }, acc.label),
      ]));
    }
  }

  async function renderWorkerSfsSection() {
    appEl.innerHTML = "";
    const tabsRow = el("div", { class: "informes-presets" }, [
      el("button", { class: "sm" + (workerSfsSubTab === "chat" ? " primary" : ""), onclick: () => setWorkerSfsSubTab("chat") }, "Chat"),
      el("button", { class: "sm" + (workerSfsSubTab === "grupo" ? " primary" : ""), onclick: () => setWorkerSfsSubTab("grupo") }, "Grupo SFS"),
    ]);
    appEl.appendChild(tabsRow);
    const body = el("div", { class: "sfs-body" });
    appEl.appendChild(body);
    if (!workerSfsAccountId) return;
    if (workerSfsSubTab === "grupo") {
      await renderSfsGroupView(workerSfsAccountId, body);
    } else {
      await renderMensajesView(workerSfsAccountId, body, { sfsMode: true });
    }
  }

  if (permittedAccountIds.length > 0) startWorkerHeartbeat(permittedAccountIds);
  renderWorkerNav();
  await showWorkerMensajesView();
}

// ---------- Mensajes Pro ----------
// Ventana/pestaña aparte (siempre abierta con window.open, nunca dentro de
// la app normal - ver goToView/renderWorkerRestrictedShell) con una barra
// de pestañas propia: "Todas" (bandeja combinada de todas las creadoras a
// las que se tenga acceso) + una pestaña por creadora, añadidas con "+".
// Por dentro reutiliza tal cual renderMensajesView/renderChat/openChat (el
// mismo motor que "Mensajes"), apuntando a /pro/api en vez de /api -por
// eso API_BASE es variable-, así que tiene exactamente las mismas
// funciones (grupos restringidos, notas, ventas, guiones...) sin duplicar
// ese código.
let mensajesProState = null;

// ---------- Portal de inicio de sesión del dueño (/login) ----------
//
// Sustituye al cuadro nativo de usuario/contraseña del navegador (Basic
// Auth) por una pantalla propia, con el logo, que guarda la sesión en una
// cookie de larga duración (ver OWNER_COOKIE en utils/auth.ts) para no
// tener que volver a escribir las credenciales cada vez. Las credenciales
// siguen siendo las mismas de PANEL_USERNAME/PANEL_PASSWORD en Railway.

async function ownerLogout() {
  try {
    await api("/auth/owner-logout", { method: "POST" });
  } catch {
    // si falla la llamada, igualmente mandamos a /login
  }
  window.location.href = "/login";
}

/**
 * Portal de login. Mismo formulario y mismo backend (POST
 * /api/auth/unified-login) para los dos casos - la única diferencia es
 * cosmética: branded=false (ver /login2 en init()) quita el logo, el
 * nombre "LUREQO" y el título/favicon de la pestaña, para que
 * una agencia que no sea la tuya pueda compartir un acceso que no lleve
 * ninguna marca de LUXE. Las credenciales y el backend son EXACTAMENTE los
 * mismos en los dos - /login2 no es un login "más débil", solo uno sin
 * logos.
 */
function renderOwnerLoginScreen(options = {}) {
  const branded = options.branded !== false;
  document.body.classList.add("owner-login-mode");
  sidenavEl.innerHTML = "";
  accountListEl.innerHTML = "";
  appEl.innerHTML = "";

  if (!branded) {
    document.title = "Iniciar sesión";
    const favicon = document.getElementById("faviconLink");
    if (favicon) favicon.href = "data:,";
  }

  // Login único para todo el mundo: la cuenta luxe (usuario/contraseña de
  // Railway) y cualquier empleado (su email/contraseña) entran por el mismo
  // formulario. El backend (POST /api/auth/unified-login) prueba primero
  // las credenciales de la cuenta luxe y, si no coinciden, las de un
  // empleado — así ya no hace falta un portal /equipo aparte.
  const userInput = el("input", { type: "text", placeholder: "Usuario o email", autocomplete: "username", autofocus: "true" });
  const passInput = el("input", { type: "password", placeholder: "Contraseña", autocomplete: "current-password" });
  const errorEl = el("div", { class: "owner-login-error hidden" });
  const submitBtn = el("button", { class: "primary", type: "submit" }, "Entrar");

  const form = el("form", { class: "owner-login-card" }, [
    branded ? el("div", { class: "owner-login-logo-ring" }, el("img", { src: "/assets/logo.png", class: "owner-login-logo", alt: "LUREQO" })) : null,
    el("h1", {}, branded ? "LUREQO" : "Iniciar sesión"),
    el("p", { class: "hint" }, "Introduce tus credenciales para entrar al panel. Si eres del equipo, usa el email y la contraseña que te haya dado tu agencia."),
    el("div", { class: "field" }, [el("label", {}, "Usuario o email"), userInput]),
    el("div", { class: "field" }, [el("label", {}, "Contraseña"), passInput]),
    errorEl,
    submitBtn,
    el("p", { class: "owner-login-footnote" }, "La sesión se mantiene iniciada en este navegador."),
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    submitBtn.disabled = true;
    submitBtn.textContent = "Entrando...";
    try {
      await api("/auth/unified-login", {
        method: "POST",
        body: JSON.stringify({ identifier: userInput.value, password: passInput.value }),
      });
      window.location.href = "/";
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
      submitBtn.disabled = false;
      submitBtn.textContent = "Entrar";
    }
  });

  appEl.appendChild(el("div", { class: "owner-login-screen" }, [
    el("div", { class: "owner-login-glow" }),
    form,
  ]));
}

async function renderMensajesProShell() {
  document.body.classList.remove("worker-login-mode");
  document.body.classList.add("mensajes-pro-mode");
  sidenavEl.innerHTML = "";
  accountListEl.innerHTML = "";
  appEl.innerHTML = "";

  // Esta primera llamada SÍ va por /api normal (todavía no hemos cambiado
  // API_BASE): es la única ruta de Mensajes Pro que no cuelga del prefijo
  // /pro, ver messagesPro.ts.
  let accounts = [];
  try {
    const res = await api("/mensajes-pro/accounts");
    accounts = res.accounts || [];
  } catch (err) {
    appEl.appendChild(el("div", { class: "card" }, "No se pudo abrir Mensajes Pro: " + err.message));
    return;
  }
  if (accounts.length === 0) {
    appEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes acceso a ninguna cuenta en Mensajes Pro. Pídele a tu agencia que te lo conceda desde Configuración → Equipo."));
    return;
  }

  // A partir de aquí TODO lo que pida cuentas/chats va por /pro/api (mismo
  // motor de Mensajes, con su propio permiso "mensajes-pro").
  API_BASE = "/pro/api";

  startWorkerHeartbeat(accounts.map((a) => a.id));

  mensajesProState = {
    accounts,
    openTabs: [{ key: "all", label: "Todas" }],
    activeKey: "all",
  };

  // Mensajes Pro se abre en su propia pestaña/ventana del navegador (ver
  // "opensWindow" en SECTIONS), así que no hay sidenav ni "‹" para volver al
  // panel normal - este botón hace justo eso: te devuelve a "/", donde el
  // panel decide solo (según haya o no sesión) qué pantalla tocaba.
  const backBtn = el("button", {
    type: "button", class: "pro-back-btn", title: "Volver al panel",
    onclick: () => { window.location.href = "/"; },
  }, ["‹", el("span", {}, "Volver al panel")]);
  const tabBar = el("div", { class: "pro-tab-bar" });
  const contentEl = el("div", { class: "pro-tab-content" });
  appEl.appendChild(el("div", { class: "pro-shell" }, [
    el("div", { class: "pro-tab-bar-row" }, [backBtn, tabBar]),
    contentEl,
  ]));

  function renderProTabBar() {
    tabBar.innerHTML = "";
    for (const tab of mensajesProState.openTabs) {
      const closeBtn = tab.key !== "all"
        ? el("span", {
            class: "pro-tab-close",
            onclick: (e) => { e.stopPropagation(); closeProTab(tab.key); },
          }, "×")
        : null;
      const icon = tab.key === "all"
        ? el("div", { class: "pro-tab-all-icon" }, "💬")
        : accountAvatarEl(tab.key, tab.label);
      const unreadBadge = tab.unread > 0 ? el("span", { class: "pro-tab-unread" }, String(tab.unread)) : null;
      tabBar.appendChild(el("button", {
        class: "pro-tab" + (tab.key === mensajesProState.activeKey ? " active" : ""),
        onclick: () => selectProTab(tab.key),
      }, [icon, el("span", { class: "pro-tab-label" }, tab.label), unreadBadge, closeBtn]));
    }
    tabBar.appendChild(el("button", { class: "pro-tab-add", title: "Añadir creadora", onclick: (e) => toggleProAddMenu(e) }, "+"));
  }

  // Insignias de "sin leer" por pestaña, igual que en el nav normal: se
  // pide una vez por cuenta y se reparte entre la pestaña de esa creadora y
  // el total de "Todas", sin bloquear el pintado inicial de la barra.
  // Antes pedía /accounts/:id/unread-summary UNA VEZ POR CUENTA en paralelo,
  // cada vez que llegaba un mensaje de cualquier creadora o se cambiaba de
  // pestaña - con varias cuentas abiertas eso disparaba una ráfaga de
  // peticiones a la vez, que competía por el límite de conexiones del
  // navegador con las dos conexiones en vivo que Mensajes Pro ya mantiene
  // siempre abiertas (live-stream + la de la pestaña activa) y dejaba el
  // panel "colgado" justo al entrar a una conversación. Ahora es UNA sola
  // petición para todas las cuentas (ver /api/accounts/unread-summary-bulk),
  // con un pequeño debounce para no repetirla sin necesidad si llegan varios
  // mensajes seguidos.
  let unreadBadgesRefreshTimer = null;
  function refreshProTabUnreadBadges() {
    clearTimeout(unreadBadgesRefreshTimer);
    unreadBadgesRefreshTimer = setTimeout(() => {
      api(`/accounts/unread-summary-bulk`)
        .then((res) => {
          const byAccount = res.byAccount || {};
          const total = Object.values(byAccount).reduce((sum, n) => sum + n, 0);
          for (const tab of mensajesProState.openTabs) {
            tab.unread = tab.key === "all" ? total : (byAccount[tab.key] || 0);
          }
          renderProTabBar();
        })
        .catch(() => { /* las insignias son solo un extra, que no tumben nada si falla */ });
    }, 1200); // margen mayor: con mensajes frecuentes de varias creadoras a la vez, no hace falta repintar la barra tan seguido
  }

  // Notificaciones de escritorio de TODAS las creadoras a la vez (ver
  // maybeNotifyProNewMessage y /api/accounts/live-stream en el backend):
  // una sola conexión en vivo, aparte de la del tab bar (esa solo cubre la
  // pestaña activa), que vive mientras esté abierta esta pestaña/ventana de
  // Mensajes Pro - no hace falta cerrarla a mano al cambiar de pestaña
  // interna (a diferencia de closeMensajesLiveConnection), porque no
  // depende de qué creadora se esté mirando ahora mismo.
  let liveNotifyEs = null;
  function startLiveNotifications() {
    if (liveNotifyEs) { try { liveNotifyEs.close(); } catch { /* ya cerrado */ } }
    liveNotifyEs = new EventSource(`${API_BASE}/accounts/live-stream`);
    liveNotifyEs.onmessage = (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      if (payload.type !== "message" || payload.message.out) return;
      const acc = accounts.find((a) => a.id === payload.accountId);
      if (payload.notify !== false) maybeNotifyProNewMessage(acc ? acc.label : "LUXE", payload.chatTitle, payload.accountId, payload.chatId, payload.message.text, payload.message.id);
      refreshProTabUnreadBadges();
    };
  }

  let addMenuEl = null;
  function closeProAddMenu() {
    if (addMenuEl) { addMenuEl.remove(); addMenuEl = null; }
  }
  function toggleProAddMenu(e) {
    if (addMenuEl) { closeProAddMenu(); return; }
    const menu = el("div", { class: "pro-tab-add-menu" });
    const already = new Set(mensajesProState.openTabs.map((t) => t.key));
    const pending = accounts.filter((a) => !already.has(a.id));
    if (pending.length === 0) {
      menu.appendChild(el("div", { class: "pro-tab-add-empty" }, "Ya tienes todas abiertas"));
    }
    for (const acc of pending) {
      menu.appendChild(el("button", { onclick: () => { openProAccountTab(acc); closeProAddMenu(); } }, [accountAvatarEl(acc.id, acc.label), acc.label]));
    }
    document.body.appendChild(menu);
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = rect.bottom + 6 + "px";
    menu.style.left = rect.left + "px";
    addMenuEl = menu;
    setTimeout(() => document.addEventListener("click", function onDoc(ev) {
      if (menu.contains(ev.target)) return;
      closeProAddMenu();
      document.removeEventListener("click", onDoc);
    }), 0);
  }

  function openProAccountTab(acc) {
    if (!mensajesProState.openTabs.some((t) => t.key === acc.id)) {
      mensajesProState.openTabs.push({ key: acc.id, label: acc.label });
      refreshProTabUnreadBadges();
    }
    selectProTab(acc.id);
  }

  function closeProTab(key) {
    mensajesProState.openTabs = mensajesProState.openTabs.filter((t) => t.key !== key);
    if (mensajesProState.activeKey === key) {
      selectProTab("all");
    } else {
      renderProTabBar();
    }
  }

  async function selectProTab(key) {
    mensajesProState.activeKey = key;
    renderProTabBar();
    closeMensajesLiveConnection(); // cierra la conexion en vivo de la pestaña anterior, si tenia
    stopProAllViewAutoRefresh(); // por si la pestaña anterior era "Todas"
    contentEl.innerHTML = "";
    if (key === "all") {
      await renderMensajesProAllView(accounts, contentEl, openProChatFromAll);
    } else {
      await renderMensajesView(key, contentEl);
    }
    refreshProTabUnreadBadges();
  }

  // Desde "Todas": abrir un chat concreto de una creadora abre (o
  // reutiliza) su pestaña y entra directo a ese chat, igual que si lo
  // hubieras abierto tú a mano desde ahí.
  async function openProChatFromAll(accountId, dialog) {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;
    if (!mensajesProState.openTabs.some((t) => t.key === acc.id)) {
      mensajesProState.openTabs.push({ key: acc.id, label: acc.label });
      refreshProTabUnreadBadges();
    }
    mensajesProState.activeKey = acc.id;
    renderProTabBar();
    contentEl.innerHTML = "";
    await renderMensajesView(acc.id, contentEl);
    await openChat(acc.id, dialog);
  }

  renderProTabBar();
  refreshProTabUnreadBadges();
  startLiveNotifications();

  // "Abrir en ventana nueva" (menú ⋮ de una conversación) trae aquí un hash
  // #cuenta:chat:titulo - si viene, se abre esa creadora y ese chat directos
  // en vez de la bandeja "Todas", igual que si se hubiera hecho a mano.
  const hashParts = window.location.hash.slice(1).split(":");
  const [hashAccountId, hashChatId, hashTitleEnc] = hashParts;
  const hashAcc = hashAccountId ? accounts.find((a) => a.id === hashAccountId) : null;
  if (hashAcc) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    mensajesProState.openTabs.push({ key: hashAcc.id, label: hashAcc.label });
    mensajesProState.activeKey = hashAcc.id;
    renderProTabBar();
    contentEl.innerHTML = "";
    await renderMensajesView(hashAcc.id, contentEl);
    if (hashChatId) {
      await openChat(hashAcc.id, { chatId: hashChatId, title: hashTitleEnc ? decodeURIComponent(hashTitleEnc) : hashChatId });
    }
    refreshProTabUnreadBadges();
  } else {
    await selectProTab("all");
  }
}

// Temporizador del refresco automático cada 30s de la bandeja "Todas" de
// Mensajes Pro - vive fuera de la función porque hay que poder pararlo al
// cambiar de pestaña (ver selectProTab/stopProAllViewAutoRefresh), y esta
// vista no tiene un "estado" propio como mensajesState.
let proAllViewRefreshTimer = null;
function stopProAllViewAutoRefresh() {
  if (proAllViewRefreshTimer) {
    clearInterval(proAllViewRefreshTimer);
    proAllViewRefreshTimer = null;
  }
}

/** Bandeja "Todas": junta los chats de todas las cuentas accesibles en una
 * sola lista (mas recientes primero), cada uno con una etiqueta de qué
 * creadora es. Version simple a proposito -de un vistazo y para saltar al
 * chat correcto-; la vista completa (filtros, notas, ventas...) de cada
 * creadora sigue siendo su propia pestaña. Se recarga sola cada 30s (ademas
 * del botón "🔄 Recargar") para que no haga falta cambiar de pestaña y
 * volver para ver chats nuevos de cualquier creadora. */
async function renderMensajesProAllView(accounts, container, onOpenChat) {
  container.innerHTML = "";
  const wrap = el("div", { class: "pro-all-view" });
  const reloadBtn = el("button", { type: "button", class: "dialogs-reload-btn", title: "Recargar chats" }, "🔄");
  const header = el("div", { class: "dialogs-pane-header" }, [
    el("div", { style: "display:flex;align-items:center;gap:7px" }, [
      el("div", { class: "account-list-title", style: "padding:0" }, "Todas las modelos"),
      reloadBtn,
    ]),
  ]);
  const searchInput = el("input", { placeholder: "Buscar por nombre o creadora..." });
  const listEl = el("div", { class: "dialogs-list pro-all-list" }, el("div", { class: "empty" }, "Cargando..."));
  wrap.appendChild(header);
  wrap.appendChild(el("div", { class: "dialogs-filter-bar" }, [searchInput]));
  wrap.appendChild(listEl);
  container.appendChild(wrap);

  // Si ya se entró antes a "Todas" en esta misma sesión de navegador, se
  // pinta YA con lo último que se sabía (en vez de "Cargando...") mientras
  // la carga de verdad sigue su curso por debajo - draw() está definido más
  // abajo, así que esto solo deja la lista lista para cuando se llame.
  let allRows = proAllRowsCache || [];

  // Tope de tiempo POR CUENTA, mucho mas corto que el de /dialogs en el
  // servidor (120s, pensado para la vista normal de una sola creadora tras
  // un despliegue en frio). "Todas" pide TODAS las cuentas a la vez: sin
  // este tope, bastaba con que UNA sola cuenta se quedara colgada/lenta
  // (conexion recien reconectando, muchos chats, etc.) para que la bandeja
  // entera se quedara en "Cargando..." hasta 2 minutos, aunque el resto de
  // cuentas hubieran respondido en segundos - esto es justo lo que se veia
  // como "Mensajes Pro > Todas no carga o va extremadamente lento". Ahora
  // una cuenta lenta simplemente se deja fuera de esta carga (vuelve a
  // intentarse en el siguiente refresco automatico/manual) en vez de
  // bloquear a las demas.
  const PER_ACCOUNT_TIMEOUT_MS = 12_000;

  // Antes se repintaba la lista ENTERA (listEl.innerHTML = "" + reconstruir
  // todos los <div>) cada vez que se llamaba a draw() - incluido el refresco
  // silencioso de cada 30s de mas abajo, que la mayoria de las veces no trae
  // ningun cambio real. Con varias decenas de chats eso es un parpadeo
  // notable y perdida de scroll cada 30s aunque no haya pasado nada, que es
  // justo lo que se nota como "va menos fluido que Infloww". Ahora se
  // calcula una firma barata de lo que tocaria pintar (que chats, en que
  // orden, con que no-leidos/fecha) y si es IGUAL a la ultima vez, no se
  // toca el DOM para nada - el refresco de 30s solo repinta de verdad
  // cuando algo cambio de verdad.
  let lastDrawnSignature = null;
  function rowsSignature(rows) {
    return rows.map((d) => `${d.accountId}:${d.chatId}:${d.unreadCount}:${d.lastMessageDate}:${d.lastMessageOut ? 1 : 0}`).join("|");
  }
  function draw(filterText) {
    const s = (filterText || "").toLowerCase();
    const rows = s
      ? allRows.filter((d) => d.title.toLowerCase().includes(s) || d.accountLabel.toLowerCase().includes(s) || (d.lastMessage || "").toLowerCase().includes(s))
      : allRows;
    const signature = s + "\u0001" + rowsSignature(rows);
    if (signature === lastDrawnSignature) return;
    lastDrawnSignature = signature;
    listEl.innerHTML = "";
    if (rows.length === 0) {
      listEl.appendChild(el("div", { class: "empty" }, "Sin conversaciones."));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const d of rows) {
      frag.appendChild(el("div", {
        class: "dialog-item",
        onclick: () => onOpenChat(d.accountId, d),
      }, [
        avatarEl(d.accountId, d.chatId, d.title),
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { class: "dialog-title" }, [d.title, el("span", { class: "pro-account-pill" }, d.accountLabel)]),
          usernameTagNode(d.username),
          folderTagsNode(d.folders),
          el("div", { class: "dialog-preview" }, (d.lastMessageOut ? "Tú: " : "") + (d.lastMessage || "")),
        ]),
        el("div", { class: "dialog-meta-col" }, [
          el("div", { class: "dialog-time" }, fmtDialogTime(d.lastMessageDate)),
          d.unreadCount > 0 ? el("div", { class: "dialog-unread" }, String(d.unreadCount)) : null,
        ]),
        dialogItemMenuBtn(d.accountId, d, (accId, dialog) => onOpenChat(accId, dialog)),
      ]));
    }
    listEl.appendChild(frag);
  }

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => draw(searchInput.value), 250);
  });
  // Si había caché, esto pinta la bandeja entera AL INSTANTE (nada de
  // "Cargando...") mientras la carga de verdad de abajo sigue su curso en
  // segundo plano - antes "Todas" siempre arrancaba en blanco, aunque se
  // acabara de ver hace un momento.
  draw("");

  async function loadAllRows(force) {
    const results = await Promise.all(
      accounts.map(async (acc) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PER_ACCOUNT_TIMEOUT_MS);
        try {
          const { dialogs } = await api(`/accounts/${acc.id}/dialogs${force ? "?force=1" : ""}`, { signal: controller.signal });
          // /dialogs ya viene filtrado del backend a chats con fans + grupos
          // restringidos de verdad (nada de spam) - se listan todos, igual
          // que en la vista normal de esa creadora.
          return dialogs.map((d) => ({ ...d, accountId: acc.id, accountLabel: acc.label }));
        } catch {
          return []; // una cuenta caida/lenta/desconectada no debe tirar abajo el resto de "Todas"
        } finally {
          clearTimeout(timer);
        }
      })
    );
    allRows = results.flat().sort((a, b) => new Date(b.lastMessageDate || 0) - new Date(a.lastMessageDate || 0));
    proAllRowsCache = allRows;
  }

  try {
    await loadAllRows(false);
    draw(searchInput.value);
  } catch (err) {
    if (allRows.length === 0) {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "No se pudo cargar la bandeja: " + err.message));
      return;
    }
    // Ya había algo pintado desde caché - se deja eso visible en vez de
    // tapar una bandeja que de hecho sirve con un mensaje de error.
    toast("No se pudo actualizar la bandeja: " + err.message, true);
  }

  reloadBtn.addEventListener("click", async () => {
    reloadBtn.disabled = true;
    reloadBtn.classList.add("spinning");
    try {
      await loadAllRows(true);
      draw(searchInput.value);
    } catch (err) {
      toast(err.message, true);
    } finally {
      reloadBtn.disabled = false;
      reloadBtn.classList.remove("spinning");
    }
  });

  // Red de seguridad: ademas del botón, la bandeja "Todas" se refresca sola
  // cada 30s (silenciosamente, sin el spinner del botón) para que un chat
  // nuevo de cualquier creadora aparezca sin tener que cambiar de pestaña.
  stopProAllViewAutoRefresh();
  proAllViewRefreshTimer = setInterval(async () => {
    try {
      await loadAllRows(false);
      draw(searchInput.value);
    } catch {
      // fallo puntual: se reintenta solo en el siguiente ciclo de 30s
    }
  }, 30000);
}

// ---------- arranque ----------

// ---------- App de escritorio (Electron, ver carpeta desktop/) ----------
// Si esto corre dentro de la app empaquetada, su preload.js expone este
// puente. Cuando la app detecta Impr Pant/Alt+Impr Pant a nivel de sistema
// operativo (fuera del alcance de cualquier navegador normal), avisa aquí y
// se manda al backend en qué sección estaba el trabajador en ese momento
// (ver security.ts, Configuración → Seguridad). Si no existe (navegador
// normal, o el dueño usando el panel de siempre) esto no hace nada.
if (window.luxeDesktop && typeof window.luxeDesktop.onCaptureAttempt === "function") {
  window.luxeDesktop.onCaptureAttempt(() => {
    const view = state.currentView || "desconocido";
    const accountId = state.currentAccountId || null;
    api("/security/capture-attempt", { method: "POST", body: JSON.stringify({ view, accountId }) }).catch(() => {
      // best effort: si falla el aviso no debe romper nada más del panel
    });
  });
}

async function init() {
  await fetchWorkerSession();

  // Mensajes Pro vive en su propia URL, en una ventana/pestaña aparte de la
  // app normal (para el dueño/admin y para un trabajador con ese permiso
  // por igual - el propio backend decide qué cuentas le tocan a cada uno).
  if (window.location.pathname.startsWith("/mensajes-pro")) {
    await renderMensajesProShell();
    return;
  }

  // Cualquier trabajador con sesión válida (empleado): panel reducido a
  // Mensajes y Mensajes Pro, siempre, da igual la URL por la que haya
  // entrado. Antes esto solo pasaba con role "worker" -un trabajador
  // "admin" se colaba al panel completo de administrador-, pero ahora
  // gestionar el equipo es cosa únicamente de la cuenta luxe (ver
  // Configuración → Equipo), así que TODO empleado, tenga el rol que tenga,
  // se queda solo con Mensajes/Mensajes Pro.
  if (state.currentWorker) {
    await renderWorkerRestrictedShell();
    return;
  }

  // Portal de inicio de sesión (sustituye al cuadro nativo de
  // usuario/contraseña del navegador). Se consulta ANTES de intentar cargar
  // nada del panel, para no dejar el sidenav a medio pintar si no hay
  // sesión.
  let ownerStatus = { authenticated: false };
  try {
    ownerStatus = await api("/auth/owner-status");
  } catch {
    // si ni siquiera esto responde, se trata como "sin sesión" (ver abajo)
  }
  // "/login2": el MISMO formulario y el MISMO backend que "/login" (ver
  // renderOwnerLoginScreen), sin ningún logo ni el nombre "LUREQO
  // MANAGEMENT" - un acceso igual de válido para compartir con una agencia
  // que no sea la tuya, sin que vean tu marca ni al entrar.
  if (window.location.pathname === "/login" || window.location.pathname === "/login2") {
    if (ownerStatus.authenticated) { window.location.href = "/"; return; }
    renderOwnerLoginScreen({ branded: window.location.pathname !== "/login2" });
    return;
  }
  if (!ownerStatus.authenticated) {
    window.location.href = "/login";
    return;
  }
  state.ownerSessionCookie = !!ownerStatus.viaCookie;
  try {
    const shadow = await api("/settings/shadow-mode");
    state.shadowModeEnabled = !!shadow.enabled;
  } catch {
    // si falla, se deja en false (el interruptor sigue funcionando: el
    // siguiente toggleShadowMode() vuelve a intentarlo)
  }

  renderSidenav();
  startGlobalMessageNotifications();
  try {
    const { accounts } = await api("/accounts");
    state.accounts = accounts;
    renderAccountList();
    if (accounts.length === 0) {
      appEl.innerHTML = "";
      appEl.appendChild(el("div", { class: "empty" }, "No hay cuentas dadas de alta todavía. Se añaden desde la Terminal (login:account:prod)."));
      return;
    }
    await selectAccount(accounts[0].id);
  } catch (err) {
    appEl.innerHTML = "";
    appEl.appendChild(el("div", { class: "card" }, "Error cargando el panel: " + err.message));
  }
}

// ---------- Detector de pagos ----------
// Vigila los mensajes que escribe el equipo (el remitente) de todas las
// cuentas en busca de datos de pago (IBAN, PayPal, Bizum, cripto, enlaces
// de Stripe/Revolut...) - nunca los que escribe el fan -, avisa por
// WhatsApp (número de "Aviso WhatsApp" de Configurar cuenta, mismo Twilio
// que los avisos de PeerFlood) y guarda un historial. "Nuestros métodos de
// pago" y los "Filtros de texto" son para que NO avise de los datos
// propios de la agencia: si el filtro coincide con el mensaje, no avisa.

let paymentDetectorState = {
  tab: "historial",
  historyAccountFilter: "all",
  showSilenced: false,
  counts: { rules: 0, filters: 0, muted: 0 },
};

async function openPaymentDetectorView() {
  if (state.accounts.length === 0) {
    try { state.accounts = (await api("/accounts")).accounts; } catch { /* se comprueba otra vez mas abajo */ }
  }
  accountListEl.innerHTML = "";
  renderPaymentDetectorShell();
}

const PAYMENT_DETECTOR_TABS = [
  { key: "historial", label: "Historial" },
  { key: "own-methods", label: "Nuestros métodos de pago" },
  { key: "rules", label: "Reglas" },
  { key: "filters", label: "Filtros de texto" },
  { key: "muted", label: "Chats silenciados" },
  { key: "test", label: "Probar" },
];

function renderPaymentDetectorShell() {
  appEl.innerHTML = "";
  const header = el("div", { class: "pd-header" }, [
    el("div", {}, [
      el("h1", {}, "Detector de pagos"),
      el("p", { class: "subtitle" }, "Vigila IBAN, PayPal, cripto, correos y demás en los mensajes de tus modelos y avisa por WhatsApp."),
    ]),
  ]);
  appEl.appendChild(header);

  const tabBar = el("div", { class: "pd-tab-bar" });
  const bodyEl = el("div", { class: "pd-tab-body" });
  appEl.appendChild(tabBar);
  appEl.appendChild(bodyEl);

  function renderTabBar() {
    tabBar.innerHTML = "";
    for (const t of PAYMENT_DETECTOR_TABS) {
      let countLabel = "";
      if (t.key === "rules") countLabel = ` (${paymentDetectorState.counts.rules})`;
      if (t.key === "filters") countLabel = ` (${paymentDetectorState.counts.filters})`;
      if (t.key === "muted") countLabel = ` (${paymentDetectorState.counts.muted})`;
      tabBar.appendChild(el("button", {
        type: "button",
        class: "pd-tab" + (paymentDetectorState.tab === t.key ? " active" : ""),
        onclick: () => { paymentDetectorState.tab = t.key; renderTabBar(); renderTabBody(); },
      }, t.label + countLabel));
    }
  }

  async function renderTabBody() {
    bodyEl.innerHTML = "";
    bodyEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      if (paymentDetectorState.tab === "historial") await renderPaymentHistoryTab(bodyEl);
      else if (paymentDetectorState.tab === "own-methods") await renderPaymentOwnMethodsTab(bodyEl);
      else if (paymentDetectorState.tab === "rules") await renderPaymentRulesTab(bodyEl, renderTabBar);
      else if (paymentDetectorState.tab === "filters") await renderPaymentFiltersTab(bodyEl, renderTabBar);
      else if (paymentDetectorState.tab === "muted") await renderPaymentMutedTab(bodyEl, renderTabBar);
      else if (paymentDetectorState.tab === "test") await renderPaymentTestTab(bodyEl);
    } catch (err) {
      bodyEl.innerHTML = "";
      bodyEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  // Numeritos de las pestañas: en paralelo, sin bloquear la primera pintada.
  Promise.all([
    api("/payment-detector/rules").then((r) => { paymentDetectorState.counts.rules = r.rules.length; }).catch(() => {}),
    api("/payment-detector/text-filters").then((r) => { paymentDetectorState.counts.filters = r.filters.length; }).catch(() => {}),
    api("/payment-detector/muted-chats").then((r) => { paymentDetectorState.counts.muted = r.chats.length; }).catch(() => {}),
  ]).then(renderTabBar);

  renderTabBar();
  renderTabBody();
}

// ---- Historial ----

async function renderPaymentHistoryTab(container) {
  container.innerHTML = "";
  const accountSelect = el("select", {}, [el("option", { value: "all" }, "Todas")].concat(
    state.accounts.map((a) => el("option", { value: a.id }, a.label))
  ));
  accountSelect.value = paymentDetectorState.historyAccountFilter;
  const showSilencedCk = el("input", { type: "checkbox" });
  showSilencedCk.checked = paymentDetectorState.showSilenced;
  const refreshBtn = el("button", { type: "button" }, "Actualizar");
  const clearBtn = el("button", { type: "button", class: "danger" }, "Borrar historial");

  container.appendChild(el("div", { class: "pd-toolbar" }, [
    el("div", { class: "pd-toolbar-left" }, [
      el("label", { class: "pd-inline-field" }, ["Modelo", accountSelect]),
      el("label", { class: "pd-inline-field" }, [showSilencedCk, "Mostrar también lo silenciado por filtros"]),
      refreshBtn,
    ]),
    el("div", { class: "pd-toolbar-right" }, [clearBtn]),
  ]));

  const listEl = el("div", { class: "pd-history-list" }, el("div", { class: "empty" }, "Cargando..."));
  container.appendChild(listEl);

  async function load() {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const q = `?accountId=${paymentDetectorState.historyAccountFilter}&includeSilenced=${paymentDetectorState.showSilenced ? "1" : "0"}`;
      const { events } = await api(`/payment-detector/history${q}`);
      listEl.innerHTML = "";
      if (events.length === 0) {
        listEl.appendChild(el("div", { class: "empty" }, "Sin avisos todavía."));
        return;
      }
      for (const ev of events) listEl.appendChild(paymentHistoryCard(ev, load));
    } catch (err) {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  accountSelect.addEventListener("change", () => { paymentDetectorState.historyAccountFilter = accountSelect.value; load(); });
  showSilencedCk.addEventListener("change", () => { paymentDetectorState.showSilenced = showSilencedCk.checked; load(); });
  refreshBtn.addEventListener("click", load);
  clearBtn.addEventListener("click", async () => {
    if (!confirm("¿Borrar todo el historial" + (paymentDetectorState.historyAccountFilter === "all" ? "" : " de esta modelo") + "?")) return;
    try {
      await api("/payment-detector/history/clear", { method: "POST", body: JSON.stringify({ accountId: paymentDetectorState.historyAccountFilter }) });
      load();
    } catch (err) { toast(err.message, true); }
  });

  await load();
}

function paymentHistoryCard(ev, onChange) {
  const card = el("div", { class: "pd-history-card" });

  const whoLine = ev.senderOut ? "lo escribió el equipo" : "lo mandó el fan";
  const headerRight = [];
  if (!ev.hasWhatsAppDestination) {
    headerRight.push(el("span", { class: "pd-pill pd-pill-warn" }, "Sin destinos de WhatsApp configurados"));
  }
  const dismissBtn = el("button", { type: "button", class: "pd-dismiss-btn", title: "Descartar" }, "×");
  dismissBtn.addEventListener("click", async () => {
    try { await api(`/payment-detector/history/${ev.id}`, { method: "DELETE" }); card.remove(); } catch (err) { toast(err.message, true); }
  });
  headerRight.push(dismissBtn);

  card.appendChild(el("div", { class: "pd-history-card-top" }, [
    el("div", { class: "pd-history-card-title" }, `${ev.accountLabel} · ${ev.chatTitle || ev.chatId}`),
    el("div", { class: "pd-history-card-header-right" }, headerRight),
  ]));
  card.appendChild(el("div", { class: "pd-history-card-meta" }, `${fmtDate(ev.createdAt)} · ${whoLine}, escrito desde Telegram`));
  card.appendChild(el("div", { class: "pd-pill" }, `${ev.ruleName}: ${ev.matchedText}`));
  if (ev.silenced) card.appendChild(el("div", { class: "pd-pill pd-pill-muted" }, "Silenciado por un filtro de texto / nuestros métodos de pago"));

  const textEl = el("div", { class: "pd-history-card-text" }, ev.messageText || "");
  const isLong = (ev.messageText || "").length > 220;
  if (isLong) textEl.classList.add("pd-clamped");
  card.appendChild(textEl);

  const actions = el("div", { class: "pd-history-card-actions" });
  if (isLong) {
    const verBtn = el("button", { type: "button" }, "Ver todo");
    verBtn.addEventListener("click", () => {
      textEl.classList.toggle("pd-clamped");
      verBtn.textContent = textEl.classList.contains("pd-clamped") ? "Ver todo" : "Ver menos";
    });
    actions.appendChild(verBtn);
  }
  const goBtn = el("button", { type: "button" }, "Ir al chat");
  goBtn.addEventListener("click", () => {
    const hash = `${ev.accountId}:${ev.chatId}:${encodeURIComponent(ev.chatTitle || "")}`;
    window.open(window.location.origin + "/mensajes-pro#" + hash, "_blank");
  });
  const silenceBtn = el("button", { type: "button" }, "Silenciar este chat");
  silenceBtn.addEventListener("click", async () => {
    try {
      await api(`/payment-detector/history/${ev.id}/mute-chat`, { method: "POST" });
      toast("Chat silenciado.");
      if (onChange) onChange();
    } catch (err) { toast(err.message, true); }
  });
  const oursBtn = el("button", { type: "button" }, "Es nuestro, no avisar más");
  oursBtn.addEventListener("click", async () => {
    try {
      await api(`/payment-detector/history/${ev.id}/mark-ours`, { method: "POST" });
      toast("Añadido a nuestros métodos de pago.");
      card.remove();
    } catch (err) { toast(err.message, true); }
  });
  actions.appendChild(goBtn);
  actions.appendChild(silenceBtn);
  actions.appendChild(oursBtn);
  card.appendChild(actions);

  return card;
}

// ---- Nuestros métodos de pago ----

async function renderPaymentOwnMethodsTab(container) {
  container.innerHTML = "";
  container.appendChild(el("p", { class: "pd-help" }, "Pega aquí los datos de pago de la agencia tal cual: IBAN, enlaces de PayPal, Revolut o Stripe, número de Bizum, wallets... Cuando alguien mande uno de estos datos, el detector no avisa; solo avisa de los que no estén aquí. No hace falta tocar ninguna regla."));
  const { text } = await api("/payment-detector/own-methods");
  const textarea = el("textarea", { class: "pd-own-methods-textarea", rows: "10" });
  textarea.value = text;
  container.appendChild(textarea);
  container.appendChild(el("ul", { class: "pd-help-list" }, [
    el("li", {}, "Tienen que ser los datos exactos (el enlace, el número, la cuenta); poner solo «PayPal» o «Bizum» no sirve."),
    el("li", {}, "Da igual con o sin espacios, y de un enlace también se reconoce su final (el usuario) si tiene 5 caracteres o más."),
    el("li", {}, "Desde el Historial, el botón «Es nuestro, no avisar más» añade aquí el dato de ese aviso con un clic."),
    el("li", {}, "Para comprobarlo, pega el mensaje en la pestaña «Probar»: no debe saltar."),
  ]));
  const saveBtn = el("button", { type: "button", class: "primary" }, "Guardar");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await api("/payment-detector/own-methods", { method: "PUT", body: JSON.stringify({ text: textarea.value }) });
      toast("Guardado.");
    } catch (err) {
      toast(err.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });
  container.appendChild(saveBtn);
}

// ---- Reglas ----

async function renderPaymentRulesTab(container, onCountsChange) {
  container.innerHTML = "";
  container.appendChild(el("p", { class: "pd-help" }, "Si un mensaje que escribe el equipo coincide con alguna de estas reglas, se guarda en el historial y se avisa por WhatsApp (lo que escribe el fan no se vigila). Se aplican a todas las modelos de la agencia, en chats directos y grupos de venta. Si el mensaje también coincide con «Nuestros métodos de pago» o con un filtro de texto activo, se guarda igual pero no avisa."));
  const newBtn = el("button", { type: "button", class: "primary" }, "Nueva regla");
  container.appendChild(newBtn);
  const table = el("table", { class: "pd-table" });
  container.appendChild(table);

  async function load() {
    const { rules } = await api("/payment-detector/rules");
    table.innerHTML = "";
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "NOMBRE"), el("th", {}, "PATRÓN"), el("th", {}, "BUSCA EN"), el("th", {}, "EDITADO"), el("th", {}, "ESTADO"), el("th", {}, "ACCIONES"),
    ])));
    const tbody = el("tbody");
    for (const r of rules) {
      const searchIn = [r.searchText && "texto", r.searchCaption && "pie del archivo", r.searchFilename && "nombre del archivo"].filter(Boolean).join(", ") || "—";
      const toggleBtn = el("button", { type: "button" }, r.active ? "Pausar" : "Activar");
      toggleBtn.addEventListener("click", async () => {
        await api(`/payment-detector/rules/${r.id}`, { method: "PATCH", body: JSON.stringify({ active: !r.active }) });
        load();
      });
      const editBtn = el("button", { type: "button" }, "Editar");
      editBtn.addEventListener("click", () => openPaymentRuleModal(r, load));
      const delBtn = el("button", { type: "button", class: "danger" }, "Eliminar");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`¿Eliminar la regla "${r.name}"?`)) return;
        await api(`/payment-detector/rules/${r.id}`, { method: "DELETE" });
        paymentDetectorState.counts.rules--;
        if (onCountsChange) onCountsChange();
        load();
      });
      tbody.appendChild(el("tr", {}, [
        el("td", {}, r.name),
        el("td", { class: "pd-table-pattern" }, r.pattern),
        el("td", {}, searchIn),
        el("td", {}, r.edited ? "sí" : "no"),
        el("td", {}, el("span", { class: "pd-status-badge" + (r.active ? " active" : "") }, r.active ? "Activa" : "Pausada")),
        el("td", { class: "pd-table-actions" }, [toggleBtn, editBtn, delBtn]),
      ]));
    }
    table.appendChild(tbody);
  }

  newBtn.addEventListener("click", () => openPaymentRuleModal(null, () => {
    paymentDetectorState.counts.rules++;
    if (onCountsChange) onCountsChange();
    load();
  }));

  await load();
}

function openPaymentRuleModal(rule, onSaved) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, rule ? "Editar regla" : "Nueva regla"));
    const nameInput = el("input", { value: rule ? rule.name : "" });
    const patternInput = el("input", { value: rule ? rule.pattern : "", placeholder: "Expresión regular, ej. \\bbizum\\b" });
    const textCk = el("input", { type: "checkbox" }); textCk.checked = rule ? rule.searchText : true;
    const captionCk = el("input", { type: "checkbox" }); captionCk.checked = rule ? rule.searchCaption : true;
    const filenameCk = el("input", { type: "checkbox" }); filenameCk.checked = rule ? rule.searchFilename : true;

    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre"), nameInput]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Patrón (expresión regular)"), patternInput]));
    modal.appendChild(el("div", { class: "field" }, [
      el("label", {}, "Busca en"),
      el("label", { class: "pd-inline-field" }, [textCk, "Texto"]),
      el("label", { class: "pd-inline-field" }, [captionCk, "Pie de archivo"]),
      el("label", { class: "pd-inline-field" }, [filenameCk, "Nombre de archivo"]),
    ]));
    const saveBtn = el("button", { class: "primary" }, "Guardar");
    modal.appendChild(saveBtn);

    saveBtn.addEventListener("click", async () => {
      const body = {
        name: nameInput.value.trim(), pattern: patternInput.value,
        searchText: textCk.checked, searchCaption: captionCk.checked, searchFilename: filenameCk.checked,
      };
      if (!body.name || !body.pattern) { toast("Falta el nombre o el patrón.", true); return; }
      saveBtn.disabled = true;
      try {
        if (rule) await api(`/payment-detector/rules/${rule.id}`, { method: "PATCH", body: JSON.stringify(body) });
        else await api("/payment-detector/rules", { method: "POST", body: JSON.stringify(body) });
        close();
        if (onSaved) onSaved();
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
      }
    });
  });
}

// ---- Filtros de texto ----

async function renderPaymentFiltersTab(container, onCountsChange) {
  container.innerHTML = "";
  container.appendChild(el("p", { class: "pd-help" }, "Un filtro de texto silencia un mensaje aunque una regla haya coincidido: sirve para lo propio de la agencia (vuestro PayPal, vuestro IBAN, vuestro Revolut...). Queda registrado como «silenciado» en el historial."));
  const newBtn = el("button", { type: "button", class: "primary" }, "Nuevo filtro");
  container.appendChild(newBtn);
  const table = el("table", { class: "pd-table" });
  container.appendChild(table);

  async function load() {
    const { filters } = await api("/payment-detector/text-filters");
    table.innerHTML = "";
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", {}, "NOMBRE"), el("th", {}, "DATO"), el("th", {}, "EDITADO"), el("th", {}, "ESTADO"), el("th", {}, "ACCIONES"),
    ])));
    const tbody = el("tbody");
    for (const f of filters) {
      const toggleBtn = el("button", { type: "button" }, f.active ? "Pausar" : "Activar");
      toggleBtn.addEventListener("click", async () => {
        await api(`/payment-detector/text-filters/${f.id}`, { method: "PATCH", body: JSON.stringify({ active: !f.active }) });
        load();
      });
      const editBtn = el("button", { type: "button" }, "Editar");
      editBtn.addEventListener("click", () => openPaymentFilterModal(f, load));
      const delBtn = el("button", { type: "button", class: "danger" }, "Eliminar");
      delBtn.addEventListener("click", async () => {
        if (!confirm(`¿Eliminar el filtro "${f.name}"?`)) return;
        await api(`/payment-detector/text-filters/${f.id}`, { method: "DELETE" });
        paymentDetectorState.counts.filters--;
        if (onCountsChange) onCountsChange();
        load();
      });
      tbody.appendChild(el("tr", {}, [
        el("td", {}, f.name),
        el("td", { class: "pd-table-pattern" }, f.pattern),
        el("td", {}, f.edited ? "sí" : "no"),
        el("td", {}, el("span", { class: "pd-status-badge" + (f.active ? " active" : "") }, f.active ? "Activa" : "Pausada")),
        el("td", { class: "pd-table-actions" }, [toggleBtn, editBtn, delBtn]),
      ]));
    }
    table.appendChild(tbody);
  }

  newBtn.addEventListener("click", () => openPaymentFilterModal(null, () => {
    paymentDetectorState.counts.filters++;
    if (onCountsChange) onCountsChange();
    load();
  }));

  await load();
}

function openPaymentFilterModal(filter, onSaved) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, filter ? "Editar filtro" : "Nuevo filtro"));
    const nameInput = el("input", { value: filter ? filter.name : "" });
    const patternInput = el("input", { value: filter ? filter.pattern : "", placeholder: "Ej. Paypal.me/TuUsuario" });
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Nombre"), nameInput]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Dato a reconocer como nuestro"), patternInput]));
    const saveBtn = el("button", { class: "primary" }, "Guardar");
    modal.appendChild(saveBtn);
    saveBtn.addEventListener("click", async () => {
      const body = { name: nameInput.value.trim(), pattern: patternInput.value.trim() };
      if (!body.name || !body.pattern) { toast("Falta el nombre o el dato.", true); return; }
      saveBtn.disabled = true;
      try {
        if (filter) await api(`/payment-detector/text-filters/${filter.id}`, { method: "PATCH", body: JSON.stringify(body) });
        else await api("/payment-detector/text-filters", { method: "POST", body: JSON.stringify(body) });
        close();
        if (onSaved) onSaved();
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
      }
    });
  });
}

// ---- Chats silenciados ----

async function renderPaymentMutedTab(container, onCountsChange) {
  container.innerHTML = "";
  container.appendChild(el("p", { class: "pd-help" }, "En un chat silenciado no se avisa ni se guarda nada aunque una regla coincida. Lo más cómodo es silenciar desde el historial («Silenciar este chat»); aquí también se puede añadir a mano con el id de Telegram del fan o del grupo."));

  const accountSelect = el("select", {}, state.accounts.map((a) => el("option", { value: a.id }, a.label)));
  const chatIdInput = el("input", { placeholder: "123456789 o -100..." });
  const nameInput = el("input", { placeholder: "" });
  const addBtn = el("button", { class: "primary" }, "Silenciar");
  container.appendChild(el("div", { class: "pd-muted-form" }, [
    el("div", { class: "field" }, [el("label", {}, "Modelo"), accountSelect]),
    el("div", { class: "field" }, [el("label", {}, "Id de Telegram del chat"), chatIdInput]),
    el("div", { class: "field" }, [el("label", {}, "Nombre (opcional)"), nameInput]),
    addBtn,
  ]));

  const listEl = el("div", { class: "pd-muted-list" });
  container.appendChild(listEl);

  async function load() {
    const { chats } = await api("/payment-detector/muted-chats");
    listEl.innerHTML = "";
    if (chats.length === 0) { listEl.appendChild(el("div", { class: "empty" }, "No hay chats silenciados.")); return; }
    for (const c of chats) {
      const removeBtn = el("button", { type: "button", class: "danger" }, "Quitar");
      removeBtn.addEventListener("click", async () => {
        await api(`/payment-detector/muted-chats/${c.id}`, { method: "DELETE" });
        paymentDetectorState.counts.muted--;
        if (onCountsChange) onCountsChange();
        load();
      });
      listEl.appendChild(el("div", { class: "pd-muted-row" }, [
        el("div", {}, `${c.accountLabel} · ${c.chatTitle || c.chatId}`),
        removeBtn,
      ]));
    }
  }

  addBtn.addEventListener("click", async () => {
    if (!accountSelect.value || !chatIdInput.value.trim()) { toast("Falta la modelo o el id de chat.", true); return; }
    addBtn.disabled = true;
    try {
      await api("/payment-detector/muted-chats", {
        method: "POST",
        body: JSON.stringify({ accountId: accountSelect.value, chatId: chatIdInput.value.trim(), chatTitle: nameInput.value.trim() || undefined }),
      });
      chatIdInput.value = ""; nameInput.value = "";
      paymentDetectorState.counts.muted++;
      if (onCountsChange) onCountsChange();
      load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      addBtn.disabled = false;
    }
  });

  await load();
}

// ---- Probar ----

async function renderPaymentTestTab(container) {
  container.innerHTML = "";
  container.appendChild(el("p", { class: "pd-help" }, "Escribe un mensaje como lo mandaría un fan o un chatter y mira qué reglas saltarían, si algún filtro lo silenciaría y cómo quedaría el aviso de WhatsApp. No se guarda ni se avisa nada."));
  const textarea = el("textarea", { class: "pd-test-textarea", rows: "6", placeholder: "ej. te paso mi cuenta ES91 2100 0418 4502 0005 1332" });
  const mediaCk = el("input", { type: "checkbox" });
  const filenameInput = el("input", { placeholder: "opcional" });
  const testBtn = el("button", { class: "primary" }, "Probar");
  const resultEl = el("div", { class: "pd-test-result" });

  container.appendChild(textarea);
  container.appendChild(el("div", { class: "pd-test-row" }, [
    el("label", { class: "pd-inline-field" }, [mediaCk, "Va con foto/archivo (el texto es el pie)"]),
    el("div", { class: "field" }, [el("label", {}, "Nombre del archivo"), filenameInput]),
    testBtn,
  ]));
  container.appendChild(resultEl);

  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    resultEl.innerHTML = "";
    try {
      const { matches } = await api("/payment-detector/test", {
        method: "POST",
        body: JSON.stringify({ text: textarea.value, filename: filenameInput.value.trim() || undefined, hasMedia: mediaCk.checked }),
      });
      if (matches.length === 0) {
        resultEl.appendChild(el("div", { class: "empty" }, "Ninguna regla salta con este mensaje."));
      } else {
        for (const m of matches) {
          resultEl.appendChild(el("div", { class: "pd-test-match" }, [
            el("span", { class: "pd-pill" }, `${m.ruleName}: ${m.matchedText}`),
            m.silenced
              ? el("span", { class: "pd-pill pd-pill-muted" }, "Silenciado (dato propio) — no avisaría")
              : el("span", { class: "pd-pill pd-pill-warn" }, "Avisaría por WhatsApp (si hay algún destino configurado en «Conectar WhatsApp»)"),
          ]));
        }
      }
    } catch (err) {
      resultEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    } finally {
      testBtn.disabled = false;
    }
  });
}

// ---------- Pagos (Cuentas de cobro: Stripe / PayPal) ----------
// Lo que entra por las cuentas de Stripe y PayPal de la agencia (o de
// modelos concretas), traído solo de lectura (ver src/payments/paymentSync.ts
// en el backend) para poder adjuntar cada pago a una venta (FanSale) ya
// registrada o registrar una nueva sin tener que ir a mirar Stripe/PayPal a
// mano. Usa el mismo ancho completo que Detector de pagos/Conectar WhatsApp.

const pagosState = {
  tab: "ingresos", // "ingresos" | "cuentas"
  search: "",
  gateway: "all",
  paymentAccountId: "all",
  from: "",
  to: "",
  onlyUnlinked: false,
};

async function openPagosView() {
  if (state.accounts.length === 0) {
    try { state.accounts = (await api("/accounts")).accounts; } catch { /* se comprueba otra vez mas abajo */ }
  }
  accountListEl.innerHTML = "";
  renderPagosShell();
}

function renderPagosShell() {
  appEl.innerHTML = "";
  const syncAllBtn = el("button", { type: "button" }, "Sincronizar ahora");
  const header = el("div", { class: "pd-header" }, [
    el("div", {}, [
      el("h1", {}, "Pagos"),
      el("p", { class: "subtitle" }, "Lo que entra por las cuentas de Stripe y PayPal de la agencia. Adjunta cada pago a su venta: una venta con pago queda confirmada."),
    ]),
    syncAllBtn,
  ]);
  appEl.appendChild(header);

  const tabBar = el("div", { class: "pd-tab-bar" });
  const bodyEl = el("div", { class: "pd-tab-body" });
  appEl.appendChild(tabBar);
  appEl.appendChild(bodyEl);

  const TABS = [{ key: "ingresos", label: "Ingresos" }, { key: "cuentas", label: "Cuentas de cobro" }];
  function renderTabBar() {
    tabBar.innerHTML = "";
    for (const t of TABS) {
      tabBar.appendChild(el("button", {
        type: "button",
        class: "pd-tab" + (pagosState.tab === t.key ? " active" : ""),
        onclick: () => { pagosState.tab = t.key; renderTabBar(); renderTabBody(); },
      }, t.label));
    }
  }
  async function renderTabBody() {
    bodyEl.innerHTML = "";
    bodyEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      if (pagosState.tab === "ingresos") await renderIngresosTab(bodyEl);
      else await renderCuentasDeCobroTab(bodyEl);
    } catch (err) {
      bodyEl.innerHTML = "";
      bodyEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  syncAllBtn.addEventListener("click", async () => {
    syncAllBtn.disabled = true;
    syncAllBtn.textContent = "Sincronizando...";
    try {
      const { accounts } = await api("/payment-accounts");
      await Promise.all(accounts.filter((a) => a.active).map((a) => api(`/payment-accounts/${a.id}/sync`, { method: "POST" }).catch(() => {})));
      toast("Cuentas de cobro sincronizadas");
      renderTabBody();
    } finally {
      syncAllBtn.disabled = false;
      syncAllBtn.textContent = "Sincronizar ahora";
    }
  });

  renderTabBar();
  renderTabBody();
}

function fmtMoneyEUR(amount, currency) {
  try {
    return new Intl.NumberFormat("es-ES", { style: "currency", currency: currency || "EUR" }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency || "EUR"}`;
  }
}

// ---- Ingresos ----

async function renderIngresosTab(container) {
  container.innerHTML = "";

  const { accounts: paymentAccounts } = await api("/payment-accounts").catch(() => ({ accounts: [] }));

  const searchInput = el("input", { placeholder: "Buscar por pagador o importe", value: pagosState.search });
  const gatewaySelect = el("select", {}, [
    el("option", { value: "all" }, "Stripe y PayPal"),
    el("option", { value: "stripe" }, "Solo Stripe"),
    el("option", { value: "paypal" }, "Solo PayPal"),
  ]);
  gatewaySelect.value = pagosState.gateway;
  const accountSelect = el("select", {}, [el("option", { value: "all" }, "Todas las cuentas de cobro")].concat(
    paymentAccounts.map((a) => el("option", { value: a.id }, a.label + (a.active ? "" : " (eliminada)")))
  ));
  accountSelect.value = pagosState.paymentAccountId;
  const fromInput = el("input", { type: "date", value: pagosState.from });
  const toInput = el("input", { type: "date", value: pagosState.to });
  const onlyUnlinkedCk = el("input", { type: "checkbox" });
  onlyUnlinkedCk.checked = pagosState.onlyUnlinked;

  container.appendChild(el("div", { class: "pd-toolbar" }, [
    el("div", { class: "pd-toolbar-left", style: "flex-wrap:wrap;gap:8px" }, [
      searchInput, gatewaySelect, accountSelect,
      el("span", {}, "Del"), fromInput, el("span", {}, "al"), toInput,
      el("label", { class: "pd-inline-field" }, [onlyUnlinkedCk, "Solo sin adjuntar"]),
    ]),
  ]));

  const listEl = el("div", { class: "pd-history-list" }, el("div", { class: "empty" }, "Cargando..."));
  container.appendChild(listEl);

  let searchTimer = null;
  async function load() {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const params = new URLSearchParams();
      if (pagosState.search) params.set("search", pagosState.search);
      if (pagosState.gateway !== "all") params.set("gateway", pagosState.gateway);
      if (pagosState.paymentAccountId !== "all") params.set("paymentAccountId", pagosState.paymentAccountId);
      if (pagosState.from) params.set("from", pagosState.from);
      if (pagosState.to) params.set("to", pagosState.to);
      if (pagosState.onlyUnlinked) params.set("onlyUnlinked", "1");
      const { payments } = await api(`/incoming-payments?${params.toString()}`);
      listEl.innerHTML = "";
      if (payments.length === 0) {
        listEl.appendChild(el("div", { class: "empty" }, "Sin ingresos todavía. Conecta una cuenta de cobro en la pestaña de al lado."));
        return;
      }
      for (const p of payments) listEl.appendChild(incomingPaymentRow(p, load));
    } catch (err) {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { pagosState.search = searchInput.value; load(); }, 400);
  });
  gatewaySelect.addEventListener("change", () => { pagosState.gateway = gatewaySelect.value; load(); });
  accountSelect.addEventListener("change", () => { pagosState.paymentAccountId = accountSelect.value; load(); });
  fromInput.addEventListener("change", () => { pagosState.from = fromInput.value; load(); });
  toInput.addEventListener("change", () => { pagosState.to = toInput.value; load(); });
  onlyUnlinkedCk.addEventListener("change", () => { pagosState.onlyUnlinked = onlyUnlinkedCk.checked; load(); });

  load();
}

function incomingPaymentRow(p, reload) {
  const syncBtn = el("button", { type: "button" }, "Sincronizar venta");
  const registerBtn = el("button", { type: "button", class: "primary" }, "Registrar venta");
  const unlinkBtn = el("button", { type: "button", class: "ghost" }, "Quitar de la venta");
  // "Ir al chat"/"Quitar de la venta" en un pago ya adjuntado: solo el
  // dueño/jefe (sin cookie de trabajador) los ve - un Team líder tiene aquí
  // el mismo perfil que un Chatter, mismo criterio que "Eliminar chat" en
  // Mensajes. En la práctica esta fila (incomingPaymentRow) ya solo la ve
  // el dueño hoy (un trabajador, tenga el rol que tenga, se queda con el
  // panel reducido de renderWorkerRestrictedShell, que pinta los pagos con
  // renderWorkerPagosView, sin ningún botón de acción) - se deja esta
  // comprobación igual por si algún día se llega a ver esta vista fuera de ahí.
  const isAdmin = !state.currentWorker;
  const goToChatBtn = el("button", { type: "button", class: "ghost" }, "Ir al chat");

  // Antes, con una sola venta candidata (mismo importe y fecha cercana), se
  // adjuntaba sola sin preguntar - y si no había ninguna que coincidiera
  // exacto (comisión descontada, fecha distinta...), se mandaba directo a
  // "Registrar venta" aunque la venta de verdad YA estuviera registrada.
  // Ahora siempre se abre la ventana con las últimas ventas sin adjuntar
  // para elegir a mano, haya o no una coincidencia exacta de importe.
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    try {
      const { candidates } = await api(`/incoming-payments/${p.id}/candidates`);
      const chosen = await pickSaleCandidateModal(candidates, p, reload);
      if (!chosen) return;
      await api(`/incoming-payments/${p.id}/link`, { method: "POST", body: JSON.stringify({ saleId: chosen.id }) });
      toast("Pago adjuntado a la venta");
      reload();
    } catch (err) {
      toast(err.message, true);
    } finally {
      syncBtn.disabled = false;
    }
  });

  registerBtn.addEventListener("click", () => openRegisterSaleFromPaymentModal(p, reload));
  unlinkBtn.addEventListener("click", async () => {
    try {
      await api(`/incoming-payments/${p.id}/unlink`, { method: "POST" });
      toast("Pago desvinculado de la venta");
      reload();
    } catch (err) {
      toast(err.message, true);
    }
  });
  if (p.linkedSale) {
    goToChatBtn.addEventListener("click", () => goToChatFromDashboard(p.linkedSale.accountId, p.linkedSale.chatId));
  }

  return el("div", { class: "sale-row" }, [
    el("div", { class: "sale-row-main" }, [
      el("div", { class: "sale-amount" }, [
        (p.payerName || p.payerEmail || "(sin nombre)") + "  ",
        el("span", { class: "pd-pill" + (p.linkedSale ? " pd-pill-muted" : " pd-pill-warn") }, p.linkedSale ? "ADJUNTADO" : "LIBRE"),
      ]),
      el("div", { class: "sale-meta" }, `${fmtDate(p.occurredAt)} · ${p.paymentAccount.kind === "stripe" ? "Stripe" : "PayPal"} «${p.paymentAccount.label}»${p.paymentAccount.active ? "" : " (eliminada)"}`),
      p.linkedSale ? el("div", { class: "sale-meta" }, linkedSaleMetaLine(p.linkedSale)) : null,
    ]),
    el("div", { style: "text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px" }, [
      el("div", { class: "sale-amount" }, fmtMoneyEUR(p.amount, p.currency)),
      el("div", { style: "display:flex;gap:6px" },
        p.linkedSale ? (isAdmin ? [goToChatBtn, unlinkBtn] : []) : [syncBtn, registerBtn]),
    ]),
  ]);
}

/** A qué cliente (chat) está enlazada una venta ya adjuntada - se enseña
 * tanto al admin como al chatter (ver incomingPaymentRow y
 * workerPaymentRow), aunque solo el admin tenga además el botón "Ir al
 * chat". El título puede faltar si esa cuenta/chat todavía no se cargó
 * nunca en Mensajes (ver CachedDialog en paymentAccounts.ts). */
function linkedSaleMetaLine(linkedSale) {
  if (!linkedSale) return null;
  const client = linkedSale.chatTitle || "(cliente sin nombre en caché todavía)";
  return `Enlazado a: ${client}${linkedSale.accountLabel ? " · " + linkedSale.accountLabel : ""}`;
}

/** Vista de "Pagos" para un chatter (trabajador con rol "worker"): solo
 * lectura de fechas/cuenta de cobro (eso lo tiene el admin en la vista
 * normal, ver renderIngresosTab) porque solo hay un rango posible - hoy. No
 * hace falta pedirlo aquí: /api/incoming-payments ya fuerza "solo hoy" en
 * el backend para cualquier trabajador que no sea admin, pase lo que pase
 * en la query, así que ni siquiera se manda from/to. Sí puede enlazar un
 * pago con una venta ya registrada ("por una vez": una vez enlazado, solo
 * el admin puede deshacerlo, ver incomingPaymentRow) - pero no crear una
 * venta nueva ni ver "Ir al chat", que siguen siendo del admin. */
async function renderWorkerPagosView(container) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: "pd-header" }, [
    el("div", {}, [
      el("h1", {}, "Pagos de hoy"),
      el("p", { class: "subtitle" }, "Lo que ha entrado hoy por las cuentas de Stripe y PayPal de la agencia."),
    ]),
  ]));
  const listEl = el("div", { class: "pd-history-list" }, el("div", { class: "empty" }, "Cargando..."));
  container.appendChild(listEl);

  async function load() {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const { payments } = await api("/incoming-payments");
      listEl.innerHTML = "";
      if (payments.length === 0) {
        listEl.appendChild(el("div", { class: "empty" }, "Todavía no ha entrado ningún pago hoy."));
        return;
      }
      for (const p of payments) listEl.appendChild(workerPaymentRow(p, load));
    } catch (err) {
      listEl.innerHTML = "";
      listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }
  await load();
}

function workerPaymentRow(p, reload) {
  const syncBtn = el("button", { type: "button" }, "Sincronizar venta");
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    try {
      const { candidates } = await api(`/incoming-payments/${p.id}/candidates`);
      // `null` en vez de `reload` como tercer argumento: sin eso,
      // pickSaleCandidateModal ofrece también "Registrar venta nueva", y un
      // chatter solo puede enlazar con una venta que YA exista (creada por
      // el chatter en el chat del cliente), no crear una desde Pagos.
      const chosen = await pickSaleCandidateModal(candidates, p, null);
      if (!chosen) return;
      await api(`/incoming-payments/${p.id}/link`, { method: "POST", body: JSON.stringify({ saleId: chosen.id }) });
      toast("Pago enlazado a la venta");
      reload();
    } catch (err) {
      toast(err.message, true);
    } finally {
      syncBtn.disabled = false;
    }
  });

  const linkedLine = linkedSaleMetaLine(p.linkedSale);
  return el("div", { class: "sale-row" }, [
    el("div", { class: "sale-row-main" }, [
      el("div", { class: "sale-amount" }, [
        (p.payerName || p.payerEmail || "(sin nombre)") + "  ",
        el("span", { class: "pd-pill" + (p.linkedSale ? " pd-pill-muted" : " pd-pill-warn") }, p.linkedSale ? "ADJUNTADO" : "LIBRE"),
      ]),
      el("div", { class: "sale-meta" }, `${fmtDate(p.occurredAt)} · ${p.paymentAccount.kind === "stripe" ? "Stripe" : "PayPal"} «${p.paymentAccount.label}»`),
      linkedLine ? el("div", { class: "sale-meta" }, linkedLine) : null,
    ]),
    el("div", { style: "text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px" }, [
      el("div", { class: "sale-amount" }, fmtMoneyEUR(p.amount, p.currency)),
      p.linkedSale ? null : syncBtn,
    ]),
  ]);
}

// "Nóminas" del propio trabajador: de solo lectura, solo las que la
// agencia (el dueño real, ver payroll.ts) ya le ha generado a ÉL - no hay
// ningún botón de crear/editar/borrar aquí, eso sigue siendo cosa exclusiva
// de Informes → Nóminas Chatter's, al que un trabajador no llega.
async function renderWorkerNominasView(container) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: "pd-header" }, [
    el("div", {}, [
      el("h1", {}, "Mis nóminas"),
      el("p", { class: "subtitle" }, "Las nóminas que la agencia ya te ha generado. Aquí solo puedes verlas y descargarlas."),
    ]),
  ]));
  const listEl = el("div", { class: "pd-history-list" }, el("div", { class: "empty" }, "Cargando..."));
  container.appendChild(listEl);
  try {
    const { payrolls } = await api("/payroll/mine");
    listEl.innerHTML = "";
    if (payrolls.length === 0) {
      listEl.appendChild(el("div", { class: "empty" }, "Todavía no tienes ninguna nómina generada."));
      return;
    }
    for (const p of payrolls) listEl.appendChild(workerPayrollRow(p));
  } catch (err) {
    listEl.innerHTML = "";
    listEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
}

function workerPayrollRow(p) {
  const pdfBtn = el("button", { type: "button", class: "sm" }, "PDF");
  pdfBtn.addEventListener("click", () => {
    downloadFileFromApi(`/payroll/${p.id}/pdf`, `nomina-${p.periodEnd.slice(0, 10)}.pdf`).catch((err) => toast(err.message, true));
  });
  const wordBtn = el("button", { type: "button", class: "sm" }, "Word");
  wordBtn.addEventListener("click", () => {
    downloadFileFromApi(`/payroll/${p.id}/docx`, `nomina-${p.periodEnd.slice(0, 10)}.docx`).catch((err) => toast(err.message, true));
  });
  const paidLine = p.paymentDate
    ? `Pagada el ${fmtDate(p.paymentDate)}${p.paymentMethod ? " · " + p.paymentMethod : ""}`
    : "Todavía sin marcar como pagada";
  return el("div", { class: "sale-row" }, [
    el("div", { class: "sale-row-main" }, [
      el("div", { class: "sale-amount" }, fmtQuincenaLabel(p.periodStart)),
      el("div", { class: "sale-meta" },
        `Salario fijo ${Number(p.fixedSalary).toFixed(2)} $ + ${p.commissionPct}% comisión ` +
        `(${Number(p.commissionAmount).toFixed(2)} $ sobre ${Number(p.totalSales).toFixed(2)} $ en ventas)` +
        (Number(p.bonus) ? ` · Bonificación ${Number(p.bonus).toFixed(2)} $` : "")),
      el("div", { class: "sale-meta" }, paidLine),
    ]),
    el("div", { style: "text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px" }, [
      el("div", { class: "sale-amount" }, `${Number(p.totalAmount).toFixed(2)} $`),
      el("div", { style: "display:flex;gap:6px" }, [pdfBtn, wordBtn]),
    ]),
  ]);
}

// ---------- Rendimiento personal ----------
// Se ve en DOS sitios con la MISMA pieza (renderPerformanceBody):
//  - El propio trabajador, en su panel restringido ("Mi rendimiento",
//    GET /api/performance/mine) - ver renderWorkerPerformanceView más abajo.
//  - El dueño/jefe, desde Configuración → Equipo, con un botón "Rendimiento"
//    por fila (GET /api/performance/:workerId) - ver openWorkerPerformanceModal
//    más abajo y renderEquipoSection.
// Reutiliza los mismos helpers que Informes (money, kpiTile, fmtResponseTime).

function performanceDateRangeISO(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function renderPerformanceBody(data) {
  const cmp = data.comparison;
  let cmpLine = null;
  if (cmp.comparisonPct !== null) {
    const up = cmp.comparisonPct >= 0;
    cmpLine = el("div", { class: "kpi-compare " + (up ? "up" : "down") },
      `${up ? "▲" : "▼"} ${Math.abs(cmp.comparisonPct).toFixed(1)}% vs ${money(cmp.prevIngresos)} antes`);
  }
  return el("div", { class: "kpi-grid" }, [
    kpiTile("Ingresos", money(data.ventas.ingresos), cmpLine),
    kpiTile("Nº de ventas", String(data.ventas.numVentas)),
    kpiTile("Ticket medio", money(data.ventas.ticketMedio)),
    kpiTile("Horas trabajadas", data.horas.hoursWorked),
    kpiTile("Sesiones", String(data.horas.sessions)),
    kpiTile("Desconexiones", String(data.horas.disconnections)),
    kpiTile("Mensajes enviados", String(data.mensajes.total)),
    kpiTile("Tiempo de respuesta medio", fmtResponseTime(data.mensajes.avgResponseSeconds)),
  ]);
}

/** Barra de presets (7/30/90 días) + rango a mano, igual que en Informes →
 * Ingresos - `onChange(from, to)` se llama al elegir cualquiera de las dos
 * cosas, para que quien la usa decida qué hacer con el rango nuevo (recargar
 * /performance/mine o /performance/:workerId, según el caso). */
function performanceRangeBar(onChange) {
  const { from: defaultFrom, to: defaultTo } = performanceDateRangeISO(30);
  const fromInput = el("input", { type: "date", value: defaultFrom });
  const toInput = el("input", { type: "date", value: defaultTo });
  const updateBtn = el("button", { class: "primary" }, "Actualizar");

  function setPreset(days) {
    const { from, to } = performanceDateRangeISO(days);
    fromInput.value = from;
    toInput.value = to;
    onChange(from, to);
  }

  const presetsBar = el("div", { class: "informes-presets" }, [
    el("button", { class: "sm", onclick: () => setPreset(7) }, "7 días"),
    el("button", { class: "sm", onclick: () => setPreset(30) }, "30 días"),
    el("button", { class: "sm", onclick: () => setPreset(90) }, "90 días"),
  ]);
  const topBar = el("div", { class: "work-hours-topbar" }, [
    el("div", { class: "field-inline" }, [fromInput, el("span", {}, "a"), toInput, updateBtn]),
  ]);
  updateBtn.addEventListener("click", () => onChange(fromInput.value, toInput.value));

  return { bar: el("div", {}, [presetsBar, topBar]), fromInput, toInput };
}

/** "Mi rendimiento" del propio trabajador (panel restringido): solo SUS
 * propios datos, con el mismo rango de fechas que el resto de Informes. */
async function renderWorkerPerformanceView(container) {
  container.innerHTML = "";
  container.appendChild(el("div", { class: "pd-header" }, [
    el("div", {}, [
      el("h1", {}, "Mi rendimiento"),
      el("p", { class: "subtitle" }, "Tus ventas, horas trabajadas y mensajes enviados en el periodo elegido."),
    ]),
  ]));

  const bodyWrap = el("div", { class: "empty" }, "Cargando...");

  async function load(from, to) {
    bodyWrap.innerHTML = "";
    bodyWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
    try {
      const qs = new URLSearchParams({ from, to });
      const data = await api(`/performance/mine?${qs.toString()}`);
      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(renderPerformanceBody(data));
    } catch (err) {
      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
    }
  }

  const { bar, fromInput, toInput } = performanceRangeBar(load);
  container.appendChild(bar);
  container.appendChild(bodyWrap);
  await load(fromInput.value, toInput.value);
}

/** Vista del dueño/jefe desde Configuración → Equipo: el rendimiento de UN
 * trabajador concreto, en una ventana modal para no salir de la pantalla de
 * Equipo. */
function openWorkerPerformanceModal(workerId, workerName) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Rendimiento de " + workerName));
    const bodyWrap = el("div", { class: "empty" }, "Cargando...");

    async function load(from, to) {
      bodyWrap.innerHTML = "";
      bodyWrap.appendChild(el("div", { class: "empty" }, "Cargando..."));
      try {
        const qs = new URLSearchParams({ from, to });
        const data = await api(`/performance/${workerId}?${qs.toString()}`);
        bodyWrap.innerHTML = "";
        bodyWrap.appendChild(renderPerformanceBody(data));
      } catch (err) {
        bodyWrap.innerHTML = "";
        bodyWrap.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
      }
    }

    const { bar, fromInput, toInput } = performanceRangeBar(load);
    modal.appendChild(bar);
    modal.appendChild(bodyWrap);
    modal.appendChild(el("div", { class: "actions" }, [el("button", { class: "ghost", onclick: close }, "Cerrar")]));
    load(fromInput.value, toInput.value);
  }, { wide: true });
}

/** Ventana de "Sincronizar venta": siempre enseña las últimas ventas sin
 * adjuntar (venga o no alguna con el mismo importe exacto, ver
 * /incoming-payments/:id/candidates) para elegir a mano cuál es - antes,
 * con una sola coincidencia exacta se adjuntaba sola sin preguntar, y sin
 * ninguna se mandaba directo a "Registrar venta" (podía acabar duplicando
 * una venta que YA estaba registrada con otro importe o fecha). Las que sí
 * coinciden en importe llegan marcadas y primero en la lista (candidates ya
 * viene ordenado así desde el backend). `payment`/`reload` son opcionales:
 * si se pasan, se ofrece también "Registrar venta nueva" por si de verdad
 * no está entre las últimas ventas de la lista. */
function pickSaleCandidateModal(candidates, payment, reload) {
  return new Promise((resolve) => {
    openModal((modal, close) => {
      modal.appendChild(el("h3", {}, "Últimas ventas sin adjuntar"));
      const introText = payment
        ? `Elige a cuál de estas ventas corresponde este pago de ${fmtMoneyEUR(payment.amount, payment.currency)} (${payment.payerName || payment.payerEmail || "sin nombre"}, ${fmtDate(payment.occurredAt)}):`
        : "Elige a cuál de estas ventas sin adjuntar corresponde este pago:";
      modal.appendChild(el("div", { style: "font-size:13px;color:var(--cream-dim);margin-bottom:10px" }, introText));
      if (candidates.length === 0) {
        modal.appendChild(el("div", { class: "empty" }, "Todavía no hay ninguna venta sin adjuntar."));
      }
      for (const c of candidates) {
        const btn = el("button", { type: "button", class: "sale-row", style: "width:100%;text-align:left;cursor:pointer" }, [
          el("div", { class: "sale-row-main" }, [
            el("div", { class: "sale-amount" }, [
              fmtMoneyEUR(c.amount, "EUR") + "  ",
              c.exactAmountMatch ? el("span", { class: "pd-pill" }, "MISMO IMPORTE") : null,
            ]),
            el("div", { class: "sale-meta" }, `${c.accountLabel} · ${fmtDate(c.date)}${c.service ? " · " + c.service : ""}${c.soldBy ? " · " + c.soldBy : ""}`),
          ]),
        ]);
        btn.addEventListener("click", () => { close(); resolve(c); });
        modal.appendChild(btn);
      }
      const actions = [el("button", { class: "ghost", onclick: () => { close(); resolve(null); } }, "Cancelar")];
      if (payment && reload) {
        actions.unshift(el("button", {
          type: "button",
          onclick: () => { close(); resolve(null); openRegisterSaleFromPaymentModal(payment, reload); },
        }, "No está en la lista: registrar venta nueva"));
      }
      modal.appendChild(el("div", { class: "actions" }, actions));
    }, { wide: true });
  });
}

// Registrar una venta nueva directamente desde un ingreso: hay que elegir
// primero la cuenta (modelo) y el chat/fan exactos (aquí no venimos de
// dentro de un chat abierto, a diferencia de "Vendido a este fan" en
// Mensajes), y luego es el mismo formulario/endpoint de siempre
// (POST /accounts/:id/dialogs/:chatId/sales) con el importe, la fecha y la
// referencia de pago ya precargados del propio ingreso.
function openRegisterSaleFromPaymentModal(payment, reload) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Registrar venta"));
    modal.appendChild(el("div", { style: "font-size:13px;color:var(--cream-dim);margin-bottom:10px" },
      `${fmtMoneyEUR(payment.amount, payment.currency)} · ${payment.payerName || payment.payerEmail || "(sin nombre)"} · ${fmtDate(payment.occurredAt)}`));

    const accountSelect = el("select", {}, [el("option", { value: "" }, "Elige la modelo...")].concat(
      state.accounts.map((a) => el("option", { value: a.id }, a.label))
    ));
    const chatSearchInput = el("input", { placeholder: "Busca al fan por nombre...", disabled: true });
    const chatResultsEl = el("div", { class: "fan-sales-list" });
    let selectedChat = null;

    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Modelo"), accountSelect]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Fan"), chatSearchInput, chatResultsEl]));

    let searchTimer = null;
    accountSelect.addEventListener("change", () => {
      chatSearchInput.disabled = !accountSelect.value;
      chatSearchInput.value = "";
      chatResultsEl.innerHTML = "";
      selectedChat = null;
    });
    chatSearchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = chatSearchInput.value.trim();
      if (!q || !accountSelect.value) { chatResultsEl.innerHTML = ""; return; }
      searchTimer = setTimeout(async () => {
        try {
          const { results } = await api(`/accounts/${accountSelect.value}/dialogs/search-global?q=${encodeURIComponent(q)}`);
          chatResultsEl.innerHTML = "";
          for (const r of (results || []).slice(0, 8)) {
            const row = el("div", { class: "sale-row", style: "cursor:pointer" }, [
              el("div", { class: "sale-row-main" }, [el("div", { class: "sale-amount" }, r.title)]),
            ]);
            row.addEventListener("click", () => {
              selectedChat = r;
              chatSearchInput.value = r.title;
              chatResultsEl.innerHTML = "";
            });
            chatResultsEl.appendChild(row);
          }
        } catch { /* sin resultados, se deja la lista vacia */ }
      }, 350);
    });

    const serviceSelect = el("select", {}, [el("option", { value: "" }, "Servicio...")]);
    const methodSelect = el("select", {}, [el("option", { value: "" }, "Método de pago...")]);
    api("/settings/general").then((s) => {
      for (const opt of s.services || []) serviceSelect.appendChild(el("option", { value: opt }, opt));
      for (const opt of s.paymentMethods || []) methodSelect.appendChild(el("option", { value: opt }, opt));
    }).catch(() => {});
    // Bloqueado para cualquier chatter, igual que en Mensajes (ver createSoldBySelector).
    const soldByInput = createSoldBySelector();

    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Servicio"), serviceSelect]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Método de pago"), methodSelect]));
    modal.appendChild(el("div", { class: "field" }, [el("label", {}, "Vendido por"), soldByInput]));

    const saveBtn = el("button", { class: "primary" }, "Registrar venta");
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cancelar"),
      saveBtn,
    ]));

    saveBtn.addEventListener("click", async () => {
      if (!accountSelect.value || !selectedChat) {
        toast("Elige la modelo y busca al fan de la lista", true);
        return;
      }
      saveBtn.disabled = true;
      try {
        const { sale } = await api(`/accounts/${accountSelect.value}/dialogs/${selectedChat.chatId}/sales`, {
          method: "POST",
          body: JSON.stringify({
            amount: payment.amount,
            date: payment.occurredAt,
            service: serviceSelect.value || undefined,
            paymentMethod: methodSelect.value || undefined,
            soldBy: soldByInput.value || undefined,
            paymentRef: payment.externalId,
            chatTitle: selectedChat.title,
          }),
        });
        await api(`/incoming-payments/${payment.id}/link`, { method: "POST", body: JSON.stringify({ saleId: sale.id }) });
        toast("Venta registrada y pago adjuntado");
        close();
        reload();
      } catch (err) {
        toast(err.message, true);
        saveBtn.disabled = false;
      }
    });
  }, { wide: true });
}

// ---- Cuentas de cobro ----

async function renderCuentasDeCobroTab(container) {
  container.innerHTML = "";

  const { accounts: paymentAccounts } = await api("/payment-accounts");

  if (paymentAccounts.length > 0) {
    const listEl = el("div", { class: "pd-history-list" });
    for (const a of paymentAccounts) {
      const syncBtn = el("button", { type: "button" }, "Sincronizar");
      const disconnectBtn = el("button", { type: "button", class: "danger" }, "Desconectar");
      syncBtn.addEventListener("click", async () => {
        syncBtn.disabled = true;
        try {
          await api(`/payment-accounts/${a.id}/sync`, { method: "POST" });
          toast("Sincronizada");
          renderCuentasDeCobroTab(container);
        } catch (err) {
          toast(err.message, true);
        } finally {
          syncBtn.disabled = false;
        }
      });
      disconnectBtn.addEventListener("click", async () => {
        const ok = await confirmModal({ title: "Desconectar cuenta de cobro", body: `¿Desconectar «${a.label}»? Los ingresos ya traídos se quedan en el historial.`, confirmLabel: "Desconectar", danger: true });
        if (!ok) return;
        try {
          await api(`/payment-accounts/${a.id}`, { method: "DELETE" });
          toast("Cuenta de cobro desconectada");
          renderCuentasDeCobroTab(container);
        } catch (err) {
          toast(err.message, true);
        }
      });
      const statusLine = a.active
        ? (a.lastSyncError
            ? `⚠️ Error al sincronizar: ${a.lastSyncError}`
            : (a.lastSyncedAt ? `Sincronizada por última vez: ${fmtDate(a.lastSyncedAt)}` : "Sin sincronizar todavía"))
        : "Desconectada";
      listEl.appendChild(el("div", { class: "sale-row" }, [
        el("div", { class: "sale-row-main" }, [
          el("div", { class: "sale-amount" }, `${a.kind === "stripe" ? "💳 Stripe" : "🅿️ PayPal"} · ${a.label}${a.sandbox ? " (pruebas)" : ""}`),
          el("div", { class: "sale-meta" }, [
            a.scope === "agency" ? "Toda la agencia" : `Solo: ${a.accountIds.map((id) => (state.accounts.find((acc) => acc.id === id) || {}).label || id).join(", ")}`,
            " · " + statusLine,
          ].join("")),
        ]),
        a.active ? el("div", { style: "display:flex;gap:6px" }, [syncBtn, disconnectBtn]) : null,
      ]));
    }
    container.appendChild(listEl);
  }

  container.appendChild(el("div", { style: "margin-top:18px" }));
  container.appendChild(renderConnectPaymentAccountForm(() => renderCuentasDeCobroTab(container)));
}

function renderConnectPaymentAccountForm(onConnected) {
  const wrap = el("div", { class: "pd-connect-box" });
  wrap.appendChild(el("h3", {}, "Conectar una cuenta de cobro"));
  wrap.appendChild(el("p", { class: "pd-help" }, "Conecta aquí las cuentas donde cobra tu agencia. TeleCrew solo lee los pagos que entran (no puede mover dinero) y los enseña en «Ingresos» para adjuntarlos a las ventas. Puedes conectar varias: una de toda la agencia, una por modelo, o las dos cosas."));

  const stripeTabBtn = el("button", { type: "button", class: "pd-tab active" }, "Stripe");
  const paypalTabBtn = el("button", { type: "button", class: "pd-tab" }, "PayPal");
  wrap.appendChild(el("div", { class: "pd-tab-bar", style: "margin-bottom:14px" }, [stripeTabBtn, paypalTabBtn]));

  const formBody = el("div", {});
  wrap.appendChild(formBody);
  let kind = "stripe";

  const keyInput = el("input", { placeholder: "rk_live_..." });
  const clientIdInput = el("input", { placeholder: "Client ID" });
  const secretInput = el("input", { placeholder: "Secret", type: "password" });
  const sandboxCk = el("input", { type: "checkbox" });
  const labelInput = el("input", { placeholder: "Nombre (ej. Stripe agencia)" });
  const scopeAgencyRadio = el("input", { type: "radio", name: "pagos-scope", checked: true });
  const scopeModelsRadio = el("input", { type: "radio", name: "pagos-scope" });
  const modelsCheckboxes = state.accounts.map((a) => {
    const ck = el("input", { type: "checkbox", value: a.id, disabled: true });
    return { account: a, ck };
  });

  function renderStripeForm() {
    formBody.innerHTML = "";
    formBody.appendChild(el("div", { class: "pd-help" }, [
      el("b", {}, "1 · DE DÓNDE SACAR LA CLAVE"),
      el("ol", { style: "margin:6px 0 0 18px;padding:0" }, [
        el("li", {}, ["Entra en ", el("b", {}, "dashboard.stripe.com"), " con la cuenta que cobra y ve a Desarrolladores → Claves de API."]),
        el("li", {}, ["Pulsa «Crear clave restringida» y ponle de nombre «TeleCrew (solo lectura)»."]),
        el("li", {}, ["Deja todos los permisos en «Ninguno» y pon en «Lectura» solo estos cuatro: Charges, Payment Intents, Balance transactions (para ver la comisión) y Customers (para el nombre del pagador). Nunca «Escritura»."]),
        el("li", {}, ["Crea la clave, cópiala (empieza por ", el("code", {}, "rk_live_"), ", Stripe solo la enseña una vez) y pégala aquí abajo."]),
      ]),
    ]));
    formBody.appendChild(el("div", { class: "field" }, [el("label", {}, "2 · PÉGALA AQUÍ"), keyInput]));
    appendScopeFields(formBody, `Nombre (ej. Stripe agencia)`);
  }

  function renderPaypalForm() {
    formBody.innerHTML = "";
    formBody.appendChild(el("div", { class: "pd-help" }, [
      el("b", {}, "1 · DE DÓNDE SACAR LAS CREDENCIALES"),
      el("ol", { style: "margin:6px 0 0 18px;padding:0" }, [
        el("li", {}, ["Hace falta una cuenta ", el("b", {}, "PayPal Business"), ". Entra en developer.paypal.com → «Log in to Dashboard» con la cuenta que cobra."]),
        el("li", {}, ["Arriba a la derecha cambia de «Sandbox» a «Live». Ve a Apps & Credentials → Create App, tipo «Merchant», nombre «TeleCrew»."]),
        el("li", {}, ["Dentro de la app, en «Features», marca «Transaction Search» y guarda. Es el único permiso que hace falta y solo deja leer el historial."]),
        el("li", {}, ["Copia el Client ID y el Secret («Show») y pégalos aquí abajo."]),
        el("li", {}, ["Ten paciencia con PayPal: tarda hasta 9 horas en activar ese permiso (mientras tanto verás un error de sincronización) y hasta 3 horas en enseñar cada pago nuevo."]),
      ]),
    ]));
    formBody.appendChild(el("div", { class: "field" }, [el("label", {}, "2 · PÉGALAS AQUÍ"), clientIdInput, secretInput]));
    formBody.appendChild(el("label", { class: "pd-inline-field" }, [sandboxCk, "Son credenciales de pruebas («Sandbox»), no de la cuenta real"]));
    appendScopeFields(formBody, `Nombre (ej. PayPal Zoweey)`);
  }

  function appendScopeFields(container2, placeholder) {
    labelInput.placeholder = placeholder;
    const modelsListEl = el("div", { style: "margin:6px 0 0 22px;display:flex;flex-direction:column;gap:4px" },
      modelsCheckboxes.map(({ account, ck }) => el("label", { class: "pd-inline-field" }, [ck, account.label]))
    );
    container2.appendChild(el("div", { class: "field", style: "margin-top:10px" }, [
      el("label", {}, "3 · NOMBRE Y A QUIÉN CORRESPONDE"),
      labelInput,
      el("p", { class: "pd-help" }, "El nombre sale en cada ingreso, para saber dónde entró el dinero. Las modelos deciden quién ve sus pagos: un chatter solo ve los de las cuentas de cobro de toda la agencia y los de las modelos que lleva."),
      el("label", { class: "pd-inline-field" }, [scopeAgencyRadio, "Es de toda la agencia (cobran aquí todas las modelos)"]),
      el("label", { class: "pd-inline-field" }, [scopeModelsRadio, "Es solo de estas modelos:"]),
      modelsListEl,
    ]));
  }

  scopeAgencyRadio.addEventListener("change", () => modelsCheckboxes.forEach(({ ck }) => (ck.disabled = true)));
  scopeModelsRadio.addEventListener("change", () => modelsCheckboxes.forEach(({ ck }) => (ck.disabled = false)));

  const connectBtn = el("button", { type: "button", class: "primary" }, "Comprobar y conectar");
  wrap.appendChild(el("div", { class: "actions" }, [connectBtn]));

  stripeTabBtn.addEventListener("click", () => {
    kind = "stripe"; stripeTabBtn.classList.add("active"); paypalTabBtn.classList.remove("active"); renderStripeForm();
  });
  paypalTabBtn.addEventListener("click", () => {
    kind = "paypal"; paypalTabBtn.classList.add("active"); stripeTabBtn.classList.remove("active"); renderPaypalForm();
  });

  connectBtn.addEventListener("click", async () => {
    if (!labelInput.value.trim()) { toast("Ponle un nombre a la cuenta de cobro", true); return; }
    const scopeModels = scopeModelsRadio.checked;
    const chosenAccountIds = modelsCheckboxes.filter(({ ck }) => ck.checked).map(({ account }) => account.id);
    if (scopeModels && chosenAccountIds.length === 0) { toast("Elige al menos una modelo", true); return; }
    if (kind === "stripe" && !keyInput.value.trim()) { toast("Pega la clave restringida de Stripe", true); return; }
    if (kind === "paypal" && (!clientIdInput.value.trim() || !secretInput.value.trim())) { toast("Pega el Client ID y el Secret de PayPal", true); return; }

    connectBtn.disabled = true;
    connectBtn.textContent = "Comprobando...";
    try {
      await api("/payment-accounts", {
        method: "POST",
        body: JSON.stringify({
          kind,
          label: labelInput.value.trim(),
          scope: scopeModels ? "models" : "agency",
          accountIds: chosenAccountIds,
          sandbox: sandboxCk.checked,
          restrictedKey: keyInput.value.trim() || undefined,
          clientId: clientIdInput.value.trim() || undefined,
          secret: secretInput.value.trim() || undefined,
        }),
      });
      toast("Cuenta de cobro conectada. Trayendo los pagos...");
      onConnected();
    } catch (err) {
      toast(err.message, true);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = "Comprobar y conectar";
    }
  });

  renderStripeForm();
  return wrap;
}

// ---------- Conectar WhatsApp ----------
// Vinculación por QR (como WhatsApp Web) de un único WhatsApp para toda la
// agencia - el backend usa Baileys porque la API oficial de WhatsApp
// Business no permite escanear un QR ni mandar a grupos normales (ver
// whatsapp/waClient.ts). Lo usan el Detector de pagos ("A quién avisar") y
// el aviso de ventas a los grupos de seguimiento de cada modelo.

let waStatusPollTimer = null;
function stopWaStatusPoll() {
  if (waStatusPollTimer) { clearInterval(waStatusPollTimer); waStatusPollTimer = null; }
}

async function openWhatsAppView() {
  if (state.accounts.length === 0) {
    try { state.accounts = (await api("/accounts")).accounts; } catch { /* se comprueba otra vez mas abajo */ }
  }
  accountListEl.innerHTML = "";
  renderWhatsAppShell();
}

async function renderWhatsAppShell() {
  appEl.innerHTML = "";
  const refreshBtn = el("button", { type: "button" }, "Actualizar");
  appEl.appendChild(el("div", { class: "pd-header card-row" }, [
    el("div", {}, [
      el("h1", {}, "Conectar WhatsApp"),
      el("p", { class: "subtitle" }, "El WhatsApp de la agencia: avisos de pagos sospechosos y bloqueos, y los personalizados a los grupos de seguimiento."),
    ]),
    refreshBtn,
  ]));

  const grid = el("div", { class: "wa-top-grid" });
  appEl.appendChild(grid);
  const linkCard = el("div", { class: "card" });
  const destCard = el("div", { class: "card" });
  grid.appendChild(linkCard);
  grid.appendChild(destCard);

  const salesCard = el("div", { class: "card" });
  appEl.appendChild(salesCard);

  let lastStatus = null;

  async function renderAll(status) {
    let groups = null;
    if (status.status === "connected") {
      try { groups = (await api("/whatsapp/groups")).groups; } catch { groups = null; }
    }
    let settings = {}, accounts = [];
    try {
      const res = await api("/whatsapp/settings");
      settings = res.settings;
      accounts = res.accounts;
    } catch (err) {
      toast(err.message, true);
    }

    renderWaLinkCard(linkCard, status);
    renderWaDestCard(destCard, settings, groups);
    renderWaSalesCard(salesCard, groups, settings, accounts);
    lastStatus = status;
  }

  refreshBtn.addEventListener("click", async () => {
    try { await renderAll(await api("/whatsapp/status")); } catch (err) { toast(err.message, true); }
  });

  stopWaStatusPoll();
  waStatusPollTimer = setInterval(async () => {
    if (state.currentView !== "whatsapp") { stopWaStatusPoll(); return; }
    try {
      const status = await api("/whatsapp/status");
      // Solo se vuelve a pintar del todo si cambia algo (evita que el QR
      // parpadee o se pierda lo que se esté escribiendo en la textarea de
      // destinos en cada sondeo, cada 2.5s).
      if (!lastStatus || status.status !== lastStatus.status || status.qrDataUrl !== lastStatus.qrDataUrl) {
        await renderAll(status);
      }
    } catch { /* red caída momentáneamente: se reintenta en el siguiente sondeo */ }
  }, 2500);

  try {
    await renderAll(await api("/whatsapp/status"));
  } catch (err) {
    appEl.appendChild(el("div", { class: "empty" }, "Error: " + err.message));
  }
}

function renderWaLinkCard(container, status) {
  container.innerHTML = "";
  const pillClass =
    status.status === "connected" ? "pill ok" :
    status.status === "disconnected" ? "pill off" : "pill warn";
  const pillLabel =
    status.status === "connected" ? (status.phoneNumber ? `Conectado · +${status.phoneNumber}` : "Conectado") :
    status.status === "qr" ? "Escanea el QR" :
    status.status === "connecting" ? "Conectando…" : "Sin vincular";

  container.appendChild(el("div", { class: "card-row" }, [
    el("h3", {}, "Vinculación"),
    el("span", { class: pillClass }, pillLabel),
  ]));

  if (status.status === "connected") {
    container.appendChild(el("p", { class: "pd-help" }, "El WhatsApp ya está vinculado. Se reconecta solo aunque se reinicie el panel."));
    const disconnectBtn = el("button", { type: "button", class: "danger" }, "Desconectar");
    disconnectBtn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: "Desconectar WhatsApp",
        body: "Se cerrará la sesión (como quitar el dispositivo vinculado desde el móvil de Ajustes → Dispositivos vinculados) y hará falta escanear un QR nuevo para volver a conectar.",
        confirmLabel: "Desconectar",
        danger: true,
      });
      if (!ok) return;
      try {
        await api("/whatsapp/disconnect", { method: "POST" });
        toast("WhatsApp desconectado");
        renderWhatsAppShell();
      } catch (err) { toast(err.message, true); }
    });
    container.appendChild(disconnectBtn);
    return;
  }

  container.appendChild(el("p", { class: "pd-help" }, "Pulsa «Conectar» para que aparezca el QR y escanéalo con el teléfono de la agencia (no hace falta que sea el de una modelo)."));
  const connecting = status.status === "connecting" || status.status === "qr";
  const connectBtn = el("button", { type: "button", class: "primary" }, connecting ? "Conectando…" : "Conectar");
  connectBtn.disabled = connecting;
  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    connectBtn.textContent = "Conectando…";
    try {
      await api("/whatsapp/connect", { method: "POST" });
      // El QR llega solo, lo recoge el sondeo en marcha en cuanto Baileys lo entregue.
    } catch (err) {
      toast(err.message, true);
      connectBtn.disabled = false;
      connectBtn.textContent = "Conectar";
    }
  });
  container.appendChild(connectBtn);

  const box = el("div", { class: "qr-box" });
  if (status.status === "qr" && status.qrDataUrl) {
    box.appendChild(el("img", { src: status.qrDataUrl, alt: "Código QR de WhatsApp" }));
    box.appendChild(el("div", { class: "qr-hint" }, "Abre WhatsApp en el móvil de la agencia → Ajustes → Dispositivos vinculados → Vincular un dispositivo, y escanea este código."));
    box.appendChild(el("div", { class: "qr-status" }, "Esperando escaneo..."));
  } else if (status.status === "connecting") {
    box.appendChild(el("div", { class: "qr-status" }, "Conectando…"));
  }
  container.appendChild(box);

  if (status.lastError) {
    container.appendChild(el("p", { class: "pd-help", style: "color:var(--red)" }, status.lastError));
  }
}

function renderWaDestCard(container, settings, groups) {
  container.innerHTML = "";
  container.appendChild(el("h3", {}, "A quién avisar"));
  container.appendChild(el("p", { class: "pd-help" }, "Avisos de pagos sospechosos y de cuentas bloqueadas o marcadas por Telegram."));
  container.appendChild(el("p", { class: "pd-help" }, "Un destino por línea: un grupo de WhatsApp (elígelo abajo) o un número con prefijo de país (por ejemplo +34612345678). Lo normal es un grupo de administradores."));

  const textarea = el("textarea", { rows: "6", style: "width:100%" }, settings.paymentDestinations || "");
  container.appendChild(textarea);

  const saveBtn = el("button", { type: "button", class: "primary" }, "Guardar destinos");
  const chooseBtn = el("button", { type: "button" }, "Elegir un grupo");
  const testBtn = el("button", { type: "button" }, "Enviar prueba");
  container.appendChild(el("div", { class: "pd-table-actions", style: "margin-top:10px" }, [saveBtn, chooseBtn, testBtn]));

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await api("/whatsapp/payment-destinations", { method: "PUT", body: JSON.stringify({ destinations: textarea.value }) });
      toast("Destinos guardados");
    } catch (err) { toast(err.message, true); } finally { saveBtn.disabled = false; }
  });

  chooseBtn.addEventListener("click", () => {
    if (!groups) return toast("Conecta el WhatsApp para ver la lista de tus grupos.", true);
    openWaGroupPickerModal(groups, (group) => {
      const current = textarea.value.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!current.includes(group.id)) current.push(group.id);
      textarea.value = current.join("\n");
    });
  });

  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    try {
      await api("/whatsapp/test", { method: "POST", body: JSON.stringify({ target: "payment" }) });
      toast("Prueba enviada");
    } catch (err) { toast(err.message, true); } finally { testBtn.disabled = false; }
  });
}

function openWaGroupPickerModal(groups, onPick) {
  openModal((modal, close) => {
    modal.appendChild(el("h3", {}, "Elegir un grupo"));
    if (groups.length === 0) {
      modal.appendChild(el("p", { class: "pd-help" }, "Este WhatsApp no tiene ningún grupo todavía."));
    } else {
      const list = el("div", { class: "wa-group-list" });
      for (const g of groups) {
        const item = el("button", { type: "button", class: "wa-group-item" }, g.subject);
        item.addEventListener("click", () => { onPick(g); close(); });
        list.appendChild(item);
      }
      modal.appendChild(list);
    }
    modal.appendChild(el("div", { class: "actions" }, [
      el("button", { class: "ghost", onclick: close }, "Cerrar"),
    ]));
  });
}

// Desplegable de grupo reutilizado en "Todos los trabajadores" y en cada
// modelo: si el grupo guardado ya no sale en la lista de ahora mismo (sin
// conexión, o ya no se está en él), se añade igualmente como opción para
// no perder lo guardado sin querer al pulsar "Guardar".
function waGroupSelect(groups, selectedId) {
  const options = [el("option", { value: "" }, "— Sin grupo —")];
  const list = groups || [];
  let found = !selectedId;
  for (const g of list) {
    options.push(el("option", { value: g.id }, g.subject));
    if (g.id === selectedId) found = true;
  }
  if (selectedId && !found) options.push(el("option", { value: selectedId }, selectedId));
  const select = el("select", {}, options);
  select.value = selectedId || "";
  return select;
}

function renderWaSalesCard(container, groups, settings, accounts) {
  container.innerHTML = "";
  container.appendChild(el("h3", {}, "Grupos de seguimiento de las modelos"));
  container.appendChild(el("p", { class: "pd-help" }, "Cada vez que un chatter apunta un personalizado (videollamada, foto, vídeo, audio...), se manda solo con el mensaje de siempre al grupo de todos los trabajadores y al grupo de seguimiento de esa modelo. Abajo eliges en cuáles salen el precio y quién lo vendió. Esto va aparte de los avisos de arriba: los pagos sospechosos y los bloqueos de Telegram siguen yendo solo a «A quién avisar»."));

  const enableCk = el("input", { type: "checkbox" });
  enableCk.checked = !!settings.notifySalesToGroups;
  container.appendChild(el("label", { class: "pd-inline-field" }, [enableCk, "Mandar los personalizados a estos grupos"]));

  const allPriceCk = el("input", { type: "checkbox" }); allPriceCk.checked = !!settings.allGroupIncludePrice;
  const allSoldCk = el("input", { type: "checkbox" }); allSoldCk.checked = !!settings.allGroupIncludeSoldBy;
  const modelPriceCk = el("input", { type: "checkbox" }); modelPriceCk.checked = !!settings.modelGroupIncludePrice;
  const modelSoldCk = el("input", { type: "checkbox" }); modelSoldCk.checked = !!settings.modelGroupIncludeSoldBy;

  const table = el("table", { class: "pd-table" }, [
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Qué más lleva el mensaje"), el("th", {}, "Grupo de todos"), el("th", {}, "Grupos de las modelos"),
    ])),
    el("tbody", {}, [
      el("tr", {}, [el("td", {}, "Precio"), el("td", {}, allPriceCk), el("td", {}, modelPriceCk)]),
      el("tr", {}, [el("td", {}, "Quién lo vendió"), el("td", {}, allSoldCk), el("td", {}, modelSoldCk)]),
    ]),
  ]);
  container.appendChild(table);

  if (!groups) {
    container.appendChild(el("p", { class: "pd-help", style: "color:var(--amber)" }, "Conecta el WhatsApp para ver la lista de tus grupos. Lo que ya estaba guardado se conserva."));
  }

  const rows = [];
  const groupRowsWrap = el("div", { class: "wa-group-rows" });

  const allSelect = waGroupSelect(groups, settings.allWorkersGroupId);
  const allProbarBtn = el("button", { type: "button" }, "Probar");
  allProbarBtn.addEventListener("click", async () => {
    allProbarBtn.disabled = true;
    try {
      await api("/whatsapp/test", { method: "POST", body: JSON.stringify({ target: "all-workers" }) });
      toast("Prueba enviada");
    } catch (err) { toast(err.message, true); } finally { allProbarBtn.disabled = false; }
  });
  groupRowsWrap.appendChild(el("div", { class: "wa-group-row" }, [
    el("div", { class: "wa-group-row-label" }, [el("strong", {}, "Todos los trabajadores"), el("div", { class: "muted" }, "Recibe los de todas las modelos")]),
    allSelect,
    allProbarBtn,
  ]));

  for (const acc of accounts) {
    const sel = waGroupSelect(groups, acc.salesTrackingWhatsAppGroupId);
    const probarBtn = el("button", { type: "button" }, "Probar");
    probarBtn.addEventListener("click", async () => {
      probarBtn.disabled = true;
      try {
        await api("/whatsapp/test", { method: "POST", body: JSON.stringify({ target: "account", accountId: acc.id }) });
        toast("Prueba enviada");
      } catch (err) { toast(err.message, true); } finally { probarBtn.disabled = false; }
    });
    groupRowsWrap.appendChild(el("div", { class: "wa-group-row" }, [
      el("div", { class: "wa-group-row-label" }, acc.label),
      sel,
      probarBtn,
    ]));
    rows.push({ accountId: acc.id, select: sel });
  }
  container.appendChild(groupRowsWrap);

  const saveAllBtn = el("button", { type: "button", class: "primary", style: "margin-top:14px" }, "Guardar");
  saveAllBtn.addEventListener("click", async () => {
    saveAllBtn.disabled = true;
    try {
      const accountGroups = {};
      for (const r of rows) accountGroups[r.accountId] = r.select.value || null;
      await api("/whatsapp/sales-settings", {
        method: "PUT",
        body: JSON.stringify({
          notifySalesToGroups: enableCk.checked,
          allWorkersGroupId: allSelect.value || null,
          allGroupIncludePrice: allPriceCk.checked,
          allGroupIncludeSoldBy: allSoldCk.checked,
          modelGroupIncludePrice: modelPriceCk.checked,
          modelGroupIncludeSoldBy: modelSoldCk.checked,
          accountGroups,
        }),
      });
      toast("Guardado");
    } catch (err) { toast(err.message, true); } finally { saveAllBtn.disabled = false; }
  });
  container.appendChild(saveAllBtn);

  container.appendChild(el("p", { class: "pd-help", style: "margin-top:14px" }, "Los avisos salen desde este WhatsApp hacia los destinos de arriba cada vez que el Detector de pagos encuentra algo. Si no hay ningún destino, el detector sigue guardando el historial pero no avisa."));
}

init();
