# Образ MCP-сервера для Claude Code на сервере с панелью (Docker там уже есть, Node.js не нужен).
#   docker run -i --rm -e REMNAWAVE_BASE_URL -e REMNAWAVE_API_TOKEN ghcr.io/<owner>/remnawave-mcp:3.4
#
# CONTRACT_VERSION — описание API под конкретную версию панели (пусто = из package.json, т.е. текущая стабильная).

# 1) сборка: TypeScript → JavaScript. Выполняется на платформе сборщика — результат одинаков для amd64/arm64.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build

# 2) итоговый образ: только собранный код и зависимости для запуска
FROM node:22-alpine
ARG CONTRACT_VERSION=
LABEL org.opencontainers.image.title="remnawave-mcp" \
      org.opencontainers.image.description="MCP server for Remnawave 3.x panels: read-only, secrets hidden, client data pseudonymized" \
      org.opencontainers.image.source="https://github.com/3APA3A-3AHO3A/remnawave-mcp" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && if [ -n "$CONTRACT_VERSION" ]; then \
      npm i "@remnawave/backend-contract@$CONTRACT_VERSION" --save-exact --omit=dev --ignore-scripts --no-audit --no-fund; \
    fi \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
# не от root
USER node
ENTRYPOINT ["node", "dist/index.js"]
