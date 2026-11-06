# Build context: repository root (docker compose sets it).
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build -w apps/web
EXPOSE 5173
# `vite preview` serves the static build and proxies /api to UNBLUR_API_URL.
CMD ["npx", "-w", "apps/web", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
