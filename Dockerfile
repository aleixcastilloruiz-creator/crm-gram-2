FROM node:20-alpine AS build
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install --no-audit --no-fund
WORKDIR /app
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY frontend ./frontend
RUN npx prisma generate
RUN npm run build
RUN npm --prefix frontend run build

FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY package*.json ./
EXPOSE 8080
CMD ["node","dist/index.js"]
