FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* bun.lock* ./
RUN npm install --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache wget

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json vite.config.ts tsconfig.json wrangler.jsonc ./
COPY src ./src
COPY scripts ./scripts
COPY config ./config

EXPOSE 3000

CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0", "--port", "3000"]
