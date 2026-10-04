# LUXE CRM — Railway

Paquete completo: backend + interfaz web. La interfaz funcional existente se conserva y se le aplica una nueva capa visual responsive; las rutas/API del backend se mantienen.

## Variables obligatorias
- DATABASE_URL
- PANEL_USERNAME
- PANEL_PASSWORD
- TELEGRAM_API_ID
- TELEGRAM_API_HASH
- SESSION_ENCRYPTION_KEY

Según las funciones activadas también pueden ser necesarias credenciales de Twilio/WhatsApp u otros servicios.

## Railway
Despliega todo como un único servicio. El backend sirve `public/index.html`, `public/app.js`, `public/style.css` y `public/modern.css` desde el mismo dominio.

`/health` devuelve JSON para comprobar que el proceso responde.

Al abrir `/` debe aparecer el panel web.
