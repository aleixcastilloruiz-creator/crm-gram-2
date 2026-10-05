# Build por etapas: compila TypeScript en una imagen "builder" y deja solo
# lo necesario para ejecutar en la imagen final (mas ligera y segura).

FROM node:20-alpine AS builder
WORKDIR /app
# git hace falta para "npm install": alguna dependencia de Baileys se
# resuelve contra un repositorio git, y la imagen alpine no trae git de
# serie - sin esto npm falla con "spawn git ENOENT" al intentar tirar de él.
RUN apk add --no-cache openssl git

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
# Mismo motivo que en la etapa builder: git hace falta para que "npm
# install" pueda resolver esa dependencia de Baileys.
# libreoffice (+ fuentes) es para "Nóminas → PDF": convierte de verdad el
# .docx ya rellenado a PDF (via el binario "soffice" que llama
# src/api/payroll.ts), en vez de dibujar un PDF parecido a mano - es pesado
# (unos cientos de MB mas de imagen y build algo mas lento), pero es la
# unica forma fiable de que el PDF salga IDENTICO a la plantilla de Word.
RUN apk add --no-cache openssl git libreoffice ttf-dejavu font-noto-emoji fontconfig
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY public ./public
# Plantillas de documentos (p.ej. la de Nóminas, templates/payroll-template.docx):
# no es código TypeScript, así que tsc no la toca - hay que copiarla a mano.
COPY templates ./templates

EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/index.js"]
