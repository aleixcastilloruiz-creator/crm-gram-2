"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Version rapida: dado el nombre de la cuenta y el chatId de UN chat con
 * temas/topics, lista solo esos temas (sin recorrer todas las carpetas).
 *
 *   npm run topics:account:prod
 */
require("dotenv/config");
const telegram_1 = require("telegram");
// @ts-ignore
const input_1 = __importDefault(require("input"));
const prisma_1 = require("../utils/prisma");
const connectionPool_1 = require("./connectionPool");
async function main() {
    const label = await input_1.default.text("Nombre de la cuenta (ej. ZOWEEY): ");
    const account = await prisma_1.prisma.account.findFirst({ where: { label } });
    if (!account) {
        console.error(`No existe ninguna cuenta con el nombre "${label}"`);
        process.exit(1);
    }
    const chatId = await input_1.default.text("chatId del chat con temas (ej. -1003834308637): ");
    const client = await (0, connectionPool_1.getAccountClient)(account);
    const result = await client.invoke(new telegram_1.Api.channels.GetForumTopics({
        channel: chatId,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic: 0,
        limit: 100,
    }));
    console.log(`\n=== Temas (topics) de ${chatId} ===`);
    for (const topic of result.topics ?? []) {
        if (topic.className !== "ForumTopic")
            continue;
        console.log(`   - "${topic.title}"  (topicId: ${topic.id})`);
    }
    await prisma_1.prisma.$disconnect();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=topicsCli.js.map