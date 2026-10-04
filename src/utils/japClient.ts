// Cliente minimo para "Just Another Panel" (panel SMM de compra de
// vistas/miembros/reacciones etc). JAP usa el mismo esquema de API que casi
// todos los paneles SMM del mercado ("SMM Panel API v2"): POST
// application/x-www-form-urlencoded a un unico endpoint, con "key" (API key
// del panel) + "action" indicando que se pide. No hace falta ninguna
// libreria: usamos el fetch global de Node.
//
// La API key se guarda como variable de entorno JAP_API_KEY en Railway (el
// usuario todavia no la tiene - la sacara aparte). Sin ella, cualquier
// llamada falla con un mensaje claro en vez de reventar.

const JAP_API_URL = "https://justanotherpanel.com/api/v2";

export class JapNotConfiguredError extends Error {
  constructor() {
    super("Falta configurar JAP_API_KEY en las variables de entorno.");
    this.name = "JapNotConfiguredError";
  }
}

function getApiKey(): string {
  const key = process.env.JAP_API_KEY;
  if (!key) throw new JapNotConfiguredError();
  return key;
}

async function callJap(params: Record<string, string | number>): Promise<any> {
  const key = getApiKey();
  const body = new URLSearchParams();
  body.set("key", key);
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));

  const res = await fetch(JAP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Just Another Panel respondió con error HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data && typeof data === "object" && "error" in data) {
    throw new Error(`Just Another Panel: ${(data as any).error}`);
  }
  return data;
}

export interface JapService {
  service: number;
  name: string;
  type: string;
  category: string;
  rate: string;
  min: string;
  max: string;
  refill: boolean;
  cancel: boolean;
}

export async function japGetServices(): Promise<JapService[]> {
  const data = await callJap({ action: "services" });
  return Array.isArray(data) ? data : [];
}

export async function japGetBalance(): Promise<{ balance: string; currency: string }> {
  return callJap({ action: "balance" });
}

export async function japPlaceOrder(serviceId: number, link: string, quantity: number): Promise<{ order: number }> {
  return callJap({ action: "add", service: serviceId, link, quantity });
}

export interface JapOrderStatus {
  charge: string;
  start_count: string;
  status: string;
  remains: string;
  currency: string;
}

export async function japGetOrderStatus(japOrderId: string): Promise<JapOrderStatus> {
  return callJap({ action: "status", order: japOrderId });
}

export async function japGetOrdersStatus(japOrderIds: string[]): Promise<Record<string, JapOrderStatus>> {
  if (japOrderIds.length === 0) return {};
  return callJap({ action: "status", orders: japOrderIds.join(",") });
}
