/**
 * Script interactivo para dar de alta una cuenta (modelo) nueva.
 * Se ejecuta a mano, UNA VEZ por cuenta, desde tu propio terminal:
 *
 *   npm run login:account
 *
 * Pide telefono, codigo OTP (y password de verificacion en dos pasos si la
 * cuenta lo tiene activado) y guarda el session string CIFRADO en la base
 * de datos, asociado a la etiqueta que le des (ej. "Zoweey").
 *
 * Nadie mas que tu introduce el codigo: por diseño, esto no se puede
 * automatizar por completo, porque el OTP lo manda Telegram al propio
 * numero de telefono de la cuenta.
 */
import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
// @ts-ignore - el paquete "input" no trae tipos propios
import input from "input";
import { apiId, apiHash } from "./client";
import { prisma } from "../utils/prisma";
import { encryptSecret } from "../utils/crypto";

async function main() {
  if (!apiId || !apiHash) {
    console.error("Configura TELEGRAM_API_ID y TELEGRAM_API_HASH en .env antes de continuar.");
    process.exit(1);
  }

  const label = await input.text("Nombre de la modelo/cuenta (ej. Zoweey): ");
  const timezone = (await input.text("Zona horaria [Europe/Madrid]: ")) || "Europe/Madrid";

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Numero de telefono (con prefijo, ej +34...): "),
    password: async () => await input.password("Password de verificacion en dos pasos (si aplica): "),
    phoneCode: async () => await input.text("Codigo recibido por Telegram: "),
    onError: (err) => console.error(err),
  });

  const sessionString = client.session.save() as unknown as string;
  const me = await client.getMe();
  const phoneNumber = (me as any).phone ? `+${(me as any).phone}` : "unknown";

  await prisma.account.upsert({
    where: { phoneNumber },
    update: {
      label,
      timezone,
      sessionString: encryptSecret(sessionString),
      health: "OK",
    },
    create: {
      label,
      phoneNumber,
      timezone,
      sessionString: encryptSecret(sessionString),
    },
  });

  console.log(`Cuenta "${label}" (${phoneNumber}) guardada correctamente.`);
  await client.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
