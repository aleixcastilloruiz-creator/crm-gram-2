"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
require("dotenv/config");
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
// @ts-ignore - el paquete "input" no trae tipos propios
const input_1 = __importDefault(require("input"));
const client_1 = require("./client");
const prisma_1 = require("../utils/prisma");
const crypto_1 = require("../utils/crypto");
async function main() {
    if (!client_1.apiId || !client_1.apiHash) {
        console.error("Configura TELEGRAM_API_ID y TELEGRAM_API_HASH en .env antes de continuar.");
        process.exit(1);
    }
    const label = await input_1.default.text("Nombre de la modelo/cuenta (ej. Zoweey): ");
    const timezone = (await input_1.default.text("Zona horaria [Europe/Madrid]: ")) || "Europe/Madrid";
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(""), client_1.apiId, client_1.apiHash, {
        connectionRetries: 5,
    });
    await client.start({
        phoneNumber: async () => await input_1.default.text("Numero de telefono (con prefijo, ej +34...): "),
        password: async () => await input_1.default.password("Password de verificacion en dos pasos (si aplica): "),
        phoneCode: async () => await input_1.default.text("Codigo recibido por Telegram: "),
        onError: (err) => console.error(err),
    });
    const sessionString = client.session.save();
    const me = await client.getMe();
    const phoneNumber = me.phone ? `+${me.phone}` : "unknown";
    await prisma_1.prisma.account.upsert({
        where: { phoneNumber },
        update: {
            label,
            timezone,
            sessionString: (0, crypto_1.encryptSecret)(sessionString),
            health: "OK",
        },
        create: {
            label,
            phoneNumber,
            timezone,
            sessionString: (0, crypto_1.encryptSecret)(sessionString),
        },
    });
    console.log(`Cuenta "${label}" (${phoneNumber}) guardada correctamente.`);
    await client.disconnect();
    await prisma_1.prisma.$disconnect();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=loginCli.js.map