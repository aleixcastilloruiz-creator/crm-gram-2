/**
 * Version rapida: dado el nombre de la cuenta y el chatId de UN chat con
 * temas/topics, lista solo esos temas (sin recorrer todas las carpetas).
 *
 *   npm run topics:account:prod
 */
import "dotenv/config";
import { Api } from "telegram";
// @ts-ignore
import input from "input";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "./connectionPool";

async function main() {
  const label = await input.text("Nombre de la cuenta (ej. ZOWEEY): ");
  const account = await prisma.account.findFirst({ where: { label } });
  if (!account) {
    console.error(`No existe ninguna cuenta con el nombre "${label}"`);
    process.exit(1);
  }

  const chatId = await input.text("chatId del chat con temas (ej. -1003834308637): ");

  const client = await getAccountClient(account);
  const result = await client.invoke(
    new Api.channels.GetForumTopics({
      channel: chatId,
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit: 100,
    })
  );

  console.log(`\n=== Temas (topics) de ${chatId} ===`);
  for (const topic of (result as any).topics ?? []) {
    if (topic.className !== "ForumTopic") continue;
    console.log(`   - "${topic.title}"  (topicId: ${topic.id})`);
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
