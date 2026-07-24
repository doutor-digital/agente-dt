# syntax=docker/dockerfile:1
#
# Imagem do BACKEND do agente-dt (Node 22 + pnpm monorepo + LangGraph + Prisma).
# Context de build = raiz do repo (o pnpm-lock/workspace vivem aqui).
#
# v1 é single-stage de propósito: o node_modules do pnpm usa symlinks pro store,
# e copiá-lo entre estágios quebra. Fica maior, mas sobe 100%. Dá pra fatiar em
# multi-stage depois (pnpm deploy / node-linker=hoisted) quando estabilizar.
FROM node:22-slim

# corepack → pnpm na versão do packageManager. curl → healthcheck do Swarm
# (start-first depende dele). openssl → engine do Prisma.
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Instala só as deps do backend, com cache de camada: só refaz quando o manifesto
# muda, não a cada commit de código.
# Manifestos dos DOIS pacotes do workspace (backend + frontend) — o
# --frozen-lockfile precisa enxergar o workspace inteiro, mesmo instalando só o
# backend via --filter. Só os package.json (frontend não é copiado nem buildado).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN pnpm install --filter=agente-dt-backend --frozen-lockfile

# Código + build (prisma generate roda no postinstall também; explícito aqui p/
# garantir o client antes do tsc). NÃO roda migrate no build (não há banco).
COPY backend/ backend/
WORKDIR /repo/backend
RUN pnpm exec prisma generate \
 && pnpm exec tsc -p tsconfig.json

ENV NODE_ENV=production \
    PORT=8080 \
    TZ=America/Sao_Paulo

EXPOSE 8080

# migrate deploy é idempotente (advisory lock) — seguro no start-first, só o
# container novo aplica; o antigo já está migrado.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/server.js"]
