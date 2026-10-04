import "dotenv/config";
import Fastify from "fastify";
import { registerLogsRoutes } from "./api/logs";
import { startOrchestrator } from "./engine/orchestrator";
import { closeAllAccountClients } from "./telegram/connectionPool";
import { prisma } from "./utils/prisma";

const LOG_RETENTION_DAYS = 7;

async function purgeOldLogs() {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.sendLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) console.log(`[cleanup] borrados ${count} logs con mas de ${LOG_RETENTION_DAYS} dias`);
}

async function main() {
  const app = Fastify({ logger: true });
  await registerLogsRoutes(app);

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });

  await startOrchestrator();

  await purgeOldLogs();
  setInterval(purgeOldLogs, 6 * 60 * 60 * 1000); // cada 6h

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} recibido, cerrando conexiones de Telegram...`);
    await closeAllAccountClients();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
