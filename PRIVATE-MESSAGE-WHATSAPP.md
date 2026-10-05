# Avisos de mensajes privados por WhatsApp

Cuando un cliente escribe en un chat privado 1:1 de Telegram, el CRM envia un aviso al numero `Account.notifyWhatsAppTo` configurado para esa cuenta.

No se envian avisos por grupos, supergrupos ni canales, ni por mensajes enviados por la propia cuenta.

El envio reutiliza la integracion de Twilio ya existente (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`).

El texto incluye cuenta, nombre/username del cliente y una vista previa del mensaje.
