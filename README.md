# LUREQO — Motor "Reenviador"

Backend del motor de reenvío/publicación automática para Telegram: multi-cuenta,
multi-campaña (carpetas de destino), modo Aleatorio y modo Horarios fijos,
con protección anti-baneo (PeerFlood) y consola de logs.

Diseño propio, construido a partir de los requisitos funcionales que
describiste (no es una copia del código ni de la interfaz de ningún
producto de terceros).

## 0. Despliegue con Docker (recomendado para un VPS)

Desde la raíz del proyecto (donde está `docker-compose.yml`, un nivel por
encima de esta carpeta):

```bash
cp .env.example .env
# rellena POSTGRES_PASSWORD, TELEGRAM_API_ID, TELEGRAM_API_HASH, SESSION_ENCRYPTION_KEY
# (genera SESSION_ENCRYPTION_KEY con: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

docker compose up -d --build
```

Esto levanta 3 contenedores: `db` (Postgres), `backend` (el motor, puerto
4000) y `adminer` (interfaz web para ver la base de datos sin instalar
nada, en `http://tu-servidor:8080` — sistema PostgreSQL, servidor `db`,
usuario `luxe`, base de datos `lureqo_crm`).

Para dar de alta una cuenta (login de Telegram) dentro del contenedor ya
desplegado:

```bash
docker compose run --rm backend npm run login:account:prod
```

Ver logs en vivo del motor:

```bash
docker compose logs -f backend
```

Cualquier VPS con Docker instalado sirve (Hetzner, DigitalOcean, etc.). Si
prefieres correrlo en tu propio Mac/PC en vez de un VPS, funciona igual,
pero entonces solo estará "vivo" mientras el ordenador esté encendido y
conectado.

## 1. Alternativa: instalación manual sin Docker

- Node.js 18+
- PostgreSQL (local o en la nube, ej. Neon/Supabase/RDS)
- Credenciales de API de Telegram: https://my.telegram.org → "API development tools"
  (son las credenciales de *tu aplicación*, se usan para todas las cuentas/modelos)

## 2. Instalación

```bash
cd backend
npm install
cp .env.example .env
# Rellena TELEGRAM_API_ID, TELEGRAM_API_HASH, DATABASE_URL
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# pega el resultado en SESSION_ENCRYPTION_KEY dentro de .env

npx prisma migrate dev --name init
npm run prisma:generate
```

## 3. Dar de alta una cuenta (modelo)

Cada cuenta se autentica UNA VEZ, a mano, desde tu propio terminal (el
código OTP lo manda Telegram al número de la cuenta, así que esto no se
puede automatizar del todo — ni yo ni nadie externo introduce ese código
por ti):

```bash
npm run login:account
```

Te pedirá: nombre de la modelo, zona horaria, teléfono, código OTP y
password de verificación en dos pasos si la cuenta lo tiene activado.
Al terminar, la sesión queda guardada cifrada en la base de datos.

## 4. Configurar orígenes y campañas

Por ahora la forma más rápida de configurar orígenes/campañas/horarios es
con **Prisma Studio** (interfaz visual sobre la base de datos, sin código):

```bash
npx prisma studio
```

Ahí puedes crear:
- Un `SourceGroup` por cuenta (grupo/tema origen del que se reenvía)
- Una o varias `Campaign` (= carpeta de destino) con su modo (`RANDOM` /
  `FIXED`), ritmo, y sus `CampaignDestination` (chats destino)
- Si usas modo `FIXED`: sus `ScheduleSlot` (puedes generarlos en bloque con
  la función `generateFixedSchedule` de `src/engine/fixedEngine.ts` desde
  un script, en vez de crearlos uno a uno)
- En `Account`, pon `reenviadorEnabled = true` para encender el interruptor
  maestro de esa cuenta (equivale al botón "Encender reenviador"; con esto
  en `false` no se envía nada aunque las campañas estén "Activa")
- También en `Account`, `notifyWhatsAppTo` = tu número en formato E.164
  (ej. `+34600111222`) para recibir los avisos por WhatsApp

Construir un panel web (React) para hacer esto con clics, en vez de Prisma
Studio, es el siguiente paso natural — dímelo cuando quieras que lo monte.

## 5. Arrancar el motor

```bash
npm run dev
```

Esto levanta la API (puerto 4000 por defecto) y el orquestador: un loop
por cada campaña Aleatorio activa, y un tick cada minuto para las
campañas de Horarios fijos.

## 6. Consultar la consola de logs

```
GET http://localhost:4000/api/logs?accountId=...&level=ERROR&search=...
GET http://localhost:4000/api/accounts/:id/status
```

## Notas importantes

- **Riesgo de baneo**: esto automatiza cuentas de usuario reales de
  Telegram (MTProto/userbot), lo cual va contra los Términos de Servicio
  de Telegram. El motor incluye jitter, lotes con descanso y manejo de
  PeerFlood con arranque suave para reducir el riesgo, pero el riesgo de
  que Telegram limite o banee un número no desaparece del todo.
- **Seguridad**: los `sessionString` de Telegram se guardan cifrados
  (AES-256-GCM) con `SESSION_ENCRYPTION_KEY`. Quien tenga esa clave y la
  base de datos tiene control total de las cuentas — trátala como una
  contraseña maestra (no la subas a git, rota si se filtra).
- Este backend es solo el motor. Para un panel de control como el de la
  referencia que me pasaste, falta el frontend (React) — puedo montarlo a
  continuación conectado a esta misma API.
- **Avisos por WhatsApp**: van vía Twilio (canal oficial de WhatsApp
  Business), no vía una librería no oficial — ver el paso a paso en
  `src/utils/notifications.ts`. El sandbox de Twilio es gratis y sirve
  para probar ya mismo; para producción hace falta verificar un número de
  WhatsApp Business (lo gestiona Twilio, unos días de proceso).
- **"Horario perdido"**: si un slot de horario fijo se pasa de la hora por
  más del margen de tolerancia (`missedSlotToleranceMinutes`, 60 min por
  defecto) — porque el reenviador estaba apagado, pausado por PeerFlood, o
  el proceso se reinició — no se manda tarde: se marca como perdido en la
  consola y se avisa por WhatsApp, y no se reintenta hasta el día
  siguiente.
- **Conexión por cuenta**: cada cuenta mantiene UNA conexión persistente a
  Telegram (`src/telegram/connectionPool.ts`), compartida por todas sus
  campañas (Aleatorio y Horarios fijos), en vez de reconectar en cada
  ciclo. Importante para varias cuentas con varias campañas cada una: evita
  abrir/cerrar conexiones sin necesidad y acercarte más de lo debido a los
  límites de Telegram. Las conexiones se cierran de forma ordenada al parar
  el proceso (`SIGTERM`/`SIGINT`, lo que manda Railway en cada despliegue).
