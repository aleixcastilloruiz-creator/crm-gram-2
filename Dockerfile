# Build por etapas: compila TypeScript en una imagen "builder" y deja solo
# lo necesario para ejecutar en la imagen final (mas ligera y segura).

FROM node:20-alpine AS builder
WORKDIR /app

# Prisma necesita OpenSSL para cargar correctamente el query engine en Alpine.
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json* ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- imagen final ---
FROM node:20-alpine
WORKDIR /app

# Dependencias nativas requeridas por Prisma en Alpine.
RUN apk add --no-cache openssl libc6-compat
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push && node dist/index.js"]
