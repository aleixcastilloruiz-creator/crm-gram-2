"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptSecret = encryptSecret;
exports.decryptSecret = decryptSecret;
const crypto_1 = __importDefault(require("crypto"));
// Cifrado simetrico (AES-256-GCM) para guardar los session strings de
// Telegram en la base de datos en reposo. La clave sale de
// SESSION_ENCRYPTION_KEY (32 bytes en base64). Nunca guardes session strings
// en claro: dan acceso total a la cuenta de Telegram, sin password ni OTP.
function getKey() {
    const b64 = process.env.SESSION_ENCRYPTION_KEY;
    if (!b64) {
        throw new Error("Falta SESSION_ENCRYPTION_KEY en el entorno. Generala con: " +
            "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    }
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) {
        throw new Error("SESSION_ENCRYPTION_KEY debe decodificar a 32 bytes");
    }
    return key;
}
function encryptSecret(plainText) {
    const key = getKey();
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}
function decryptSecret(payload) {
    const key = getKey();
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) {
        throw new Error("Formato de secreto cifrado invalido");
    }
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
}
//# sourceMappingURL=crypto.js.map