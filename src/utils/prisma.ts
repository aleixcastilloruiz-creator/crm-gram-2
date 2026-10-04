import { PrismaClient } from "@prisma/client";

// Singleton de Prisma para evitar abrir demasiadas conexiones en dev
// (ts-node-dev recarga el modulo en cada cambio de archivo).
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
