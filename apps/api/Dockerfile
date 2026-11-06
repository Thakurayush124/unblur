# Build context: repository root (docker compose sets it).
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/api --include-workspace-root --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build -w apps/api && npm prune --omit=dev
ENV PORT=4000
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
