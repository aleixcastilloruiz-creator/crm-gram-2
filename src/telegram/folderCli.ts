/**
 * Version rapida: lista solo los chats de UNA carpeta (por nombre), en vez
 * de recorrer todas las carpetas de la cuenta (que es lento con cuentas
 * con muchos contactos).
 *
 *   npm run folder:account:prod
 */
import "dotenv/config";
// @ts-ignore
import input from "input";
import { prisma } from "../utils/prisma";
import { getAccountClient } from "./connectionPool";
import { listAccountFolders } from "./folders";

async function main() {
  const label = await input.text("Nombre de la cuenta (ej. ZOWEEY): ");
  const account = await prisma.account.findFirst({ where: { label } });
  if (!account) {
    console.error(`No existe ninguna cuenta con el nombre "${label}"`);
    process.exit(1);
  }

  const folderNameQuery = await input.text("Nombre (o parte del nombre) de la carpeta a listar: ");

  const client = await getAccountClient(account);
  const folders = await listAccountFolders(client);
  const match = folders.find((f) => f.title.toLowerCase().includes(folderNameQuery.toLowerCase()));

  if (!match) {
    console.log(`\nNo se encontro ninguna carpeta que contenga "${folderNameQuery}". Carpetas disponibles:`);
    for (const f of folders) console.log(`   - ${f.title}`);
    process.exit(1);
  }

  console.log(`\n[Carpeta] ${match.title} - ${match.chatIds.length} chats`);
  for (const chatId of match.chatIds) {
    try {
      const entity = await client.getEntity(chatId);
      const title = (entity as any).title ?? (entity as any).username ?? (entity as any).firstName ?? chatId;
      const isForum = (entity as any).forum === true;
      console.log(`   - ${title}  (chatId: ${chatId})${isForum ? "  [tiene temas/topics]" : ""}`);
    } catch {
      console.log(`   - (no se pudo resolver)  (chatId: ${chatId})`);
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
