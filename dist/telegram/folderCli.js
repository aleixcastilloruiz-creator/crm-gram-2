"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Version rapida: lista solo los chats de UNA carpeta (por nombre), en vez
 * de recorrer todas las carpetas de la cuenta (que es lento con cuentas
 * con muchos contactos).
 *
 *   npm run folder:account:prod
 */
require("dotenv/config");
// @ts-ignore
const input_1 = __importDefault(require("input"));
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("./connectionPool");
const folders_1 = require("./folders");
async function main() {
    const label = await input_1.default.text("Nombre de la cuenta (ej. ZOWEEY): ");
    const account = await prisma_1.prisma.account.findFirst({ where: { label } });
    if (!account) {
        console.error(`No existe ninguna cuenta con el nombre "${label}"`);
        process.exit(1);
    }
    const folderNameQuery = await input_1.default.text("Nombre (o parte del nombre) de la carpeta a listar: ");
    const client = await (0, connectionPool_1.getAccountClient)(account);
    const folders = await (0, folders_1.listAccountFolders)(client);
    const match = folders.find((f) => f.title.toLowerCase().includes(folderNameQuery.toLowerCase()));
    if (!match) {
        console.log(`\nNo se encontro ninguna carpeta que contenga "${folderNameQuery}". Carpetas disponibles:`);
        for (const f of folders)
            console.log(`   - ${f.title}`);
        process.exit(1);
    }
    console.log(`\n[Carpeta] ${match.title} - ${match.chatIds.length} chats`);
    for (const chatId of match.chatIds) {
        try {
            const entity = await client.getEntity(chatId);
            const title = entity.title ?? entity.username ?? entity.firstName ?? chatId;
            const isForum = entity.forum === true;
            console.log(`   - ${title}  (chatId: ${chatId})${isForum ? "  [tiene temas/topics]" : ""}`);
        }
        catch {
            console.log(`   - (no se pudo resolver)  (chatId: ${chatId})`);
        }
    }
    await prisma_1.prisma.$disconnect();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=folderCli.js.map