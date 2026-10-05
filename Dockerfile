FROM node:20-alpine AS backend-builder
WORKDIR /app
RUN apk add --no-cache openssl git
COPY package.json package-lock.json* ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS frontend-builder
WORKDIR /app
RUN npm install
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache openssl git libreoffice ttf-dejavu font-noto-emoji fontconfig
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=backend-builder /app/dist ./dist
COPY --from=backend-builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY --from=frontend-builder /app/dist ./public
COPY public/legacy ./public/legacy
COPY templates ./templates
EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/index.js"]
