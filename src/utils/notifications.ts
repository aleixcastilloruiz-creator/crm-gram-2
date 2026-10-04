/**
 * Envio de avisos por WhatsApp usando la API de Twilio.
 *
 * Por que Twilio y no una libreria "gratis" de WhatsApp: las opciones no
 * oficiales (whatsapp-web.js, APIs gratuitas de terceros) dependen de
 * automatizar la web de WhatsApp o de servicios de terceros sin garantia;
 * se rompen con cualquier cambio de WhatsApp y no tienen soporte. Como
 * pediste que esto "funcione bien y no de fallos", Twilio (canal oficial
 * de WhatsApp Business, con SLA) es la opcion fiable. Cuesta unos
 * centimos por mensaje de aviso, nada relevante al volumen que vamos a
 * mandar (solo avisos de pausa, no el spam en si).
 *
 * Setup (una vez):
 * 1. Crea cuenta en https://www.twilio.com/whatsapp
 * 2. Activa el sandbox de WhatsApp para probar ya mismo (gratis), o pide
 *    tu numero de WhatsApp Business propio para produccion (proceso de
 *    verificacion de Meta, lo gestiona Twilio).
 * 3. Copia Account SID y Auth Token del dashboard de Twilio a .env.
 * 4. TWILIO_WHATSAPP_FROM es el numero de Twilio en formato
 *    "whatsapp:+14155238886" (el del sandbox, o el tuyo en produccion).
 * 5. En cada Account (modelo) del CRM, guarda tu propio numero en
 *    notifyWhatsAppTo (a quien le llega el aviso, normalmente tu numero).
 */

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // ej "whatsapp:+14155238886"

export async function sendWhatsAppNotification(toE164: string, text: string): Promise<void> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    console.warn("[notifications] Twilio no configurado (TWILIO_ACCOUNT_SID/AUTH_TOKEN/WHATSAPP_FROM); aviso no enviado:", text);
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

  const body = new URLSearchParams({
    From: TWILIO_WHATSAPP_FROM,
    To: `whatsapp:${toE164}`,
    Body: text,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error(`[notifications] Twilio respondio ${res.status}: ${detail}`);
    }
  } catch (err) {
    // El aviso es best-effort: un fallo de WhatsApp no debe tumbar el motor
    console.error("[notifications] error enviando WhatsApp:", err);
  }
}
