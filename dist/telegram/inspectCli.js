"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Script de solo lectura para inspeccionar una cuenta ya dada de alta:
 * lista sus carpetas (folders) con los chats que contiene cada una, y si
 * le das el ID de un chat que sea un "foro" (con temas/topics), lista sus
 * temas. No modifica nada, solo sirve para encontrar los IDs correctos
 * antes de crear el SourceGroup y la Campaign.
 *
 *   npm run inspect:account:prod
 */
require("dotenv/config");
const telegram_1 = require("telegram");
// @ts-ignore
const input_1 = __importDefault(require("input"));
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("./connectionPool");
const folders_1 = require("./folders");
async function main() {
    const label = await input_1.default.text("Nombre de la cuenta a inspeccionar (ej. ZOWEEY): ");
    const account = await prisma_1.prisma.account.findFirst({ where: { label } });
    if (!account) {
        console.error(`No existe ninguna cuenta con el nombre "${label}"`);
        process.exit(1);
    }
    const client = await (0, connectionPool_1.getAccountClient)(account);
    console.log(`\nConectado como cuenta "${account.label}" (${account.phoneNumber})\n`);
    console.log("=== Carpetas (folders) ===");
    const folders = await (0, folders_1.listAccountFolders)(client);
    for (const folder of folders) {
        console.log(`\n[Carpeta] ${folder.title} (id interno ${folder.id}) - ${folder.chatIds.length} chats`);
        for (const chatId of folder.chatIds) {
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
    }
    const inspectTopics = await input_1.default.text("\nPega el chatId de un chat con temas para listar sus topics (o deja vacio para saltar): ");
    if (inspectTopics) {
        const result = await client.invoke(new telegram_1.Api.channels.GetForumTopics({
            channel: inspectTopics,
            offsetDate: 0,
            offsetId: 0,
            offsetTopic: 0,
            limit: 100,
        }));
        console.log(`\n=== Temas (topics) de ${inspectTopics} ===`);
        for (const topic of result.topics ?? []) {
            if (topic.className !== "ForumTopic")
                continue;
            console.log(`   - "${topic.title}"  (topicId: ${topic.id})`);
        }
    }
    await prisma_1.prisma.$disconnect();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=inspectCli.js.map