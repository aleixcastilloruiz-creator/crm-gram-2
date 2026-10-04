"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Script interactivo para crear (o actualizar) el SourceGroup y una
 * Campaign de prueba para una cuenta ya dada de alta, sin tener que usar
 * Prisma Studio. Pensado para la primera prueba piloto: crea la campaña
 * en modo RANDOM, en pausa (status PAUSED) y con la cuenta con el
 * interruptor maestro apagado, para revisarlo todo antes de activar nada.
 *
 *   npm run seed:campaign:prod
 */
require("dotenv/config");
// @ts-ignore - el paquete "input" no trae tipos propios
const input_1 = __importDefault(require("input"));
const prisma_1 = require("../utils/prisma");
async function main() {
    const label = await input_1.default.text("Nombre de la cuenta (ej. ZOWEEY): ");
    const account = await prisma_1.prisma.account.findFirst({ where: { label } });
    if (!account) {
        console.error(`No existe ninguna cuenta con el nombre "${label}"`);
        process.exit(1);
    }
    console.log("\n--- Origen (de donde se reenvia el spam) ---");
    const sourceTitle = await input_1.default.text('Titulo del origen (ej. "Contenido Zoweey - SPAMS GRUPOS"): ');
    const sourceChatId = await input_1.default.text("chatId del grupo/canal origen (ej. -100123456789): ");
    const sourceTopicIdRaw = await input_1.default.text("topicId del tema (deja vacio si no es un foro): ");
    const sourceTopicId = sourceTopicIdRaw ? Number(sourceTopicIdRaw) : null;
    const existingSourceGroup = await prisma_1.prisma.sourceGroup.findFirst({
        where: { accountId: account.id, chatId: sourceChatId, topicId: sourceTopicId },
    });
    const sourceGroup = existingSourceGroup
        ? await prisma_1.prisma.sourceGroup.update({
            where: { id: existingSourceGroup.id },
            data: { title: sourceTitle },
        })
        : await prisma_1.prisma.sourceGroup.create({
            data: {
                accountId: account.id,
                title: sourceTitle,
                chatId: sourceChatId,
                topicId: sourceTopicId,
            },
        });
    console.log("\n--- Campaña de prueba (empieza en PAUSA) ---");
    const folderName = await input_1.default.text('Nombre de la campaña (ej. "PRUEBA PILOTO"): ');
    const campaign = await prisma_1.prisma.campaign.create({
        data: {
            accountId: account.id,
            sourceGroupId: sourceGroup.id,
            folderName,
            status: "PAUSED",
            scheduleMode: "RANDOM",
        },
    });
    console.log("\n--- Destino de prueba (solo UNO, para probar con cuidado) ---");
    const destTitle = await input_1.default.text("Titulo del chat destino (para identificarlo en los logs): ");
    const destChatId = await input_1.default.text("chatId del chat destino: ");
    const destTopicIdRaw = await input_1.default.text("topicId del destino (deja vacio si no aplica): ");
    const destTopicId = destTopicIdRaw ? Number(destTopicIdRaw) : null;
    await prisma_1.prisma.campaignDestination.create({
        data: {
            campaignId: campaign.id,
            chatId: destChatId,
            chatTitle: destTitle,
            topicId: destTopicId,
        },
    });
    console.log(`\nListo. Campaña "${folderName}" creada en PAUSA, con 1 destino de prueba.`);
    console.log(`Cuenta: interruptor maestro (reenviadorEnabled) = ${account.reenviadorEnabled}`);
    console.log("\nRevisalo todo con calma antes de activar nada.");
    await prisma_1.prisma.$disconnect();
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=seedCampaignCli.js.map