#!/bin/bash
# Roda o teste de SQL do resumo de qualidade da Sofia contra um Postgres DESCARTÁVEL (docker local).
#   1. sobe postgres:16-alpine em 127.0.0.1:55432, banco "teste";
#   2. cria as tabelas com `prisma db push` (NUNCA `migrate dev`); só no banco descartável;
#   3. roda src/lib/qualidade-ia/consulta.sql.test.ts com o fuso da sessão em UTC e depois em America/Sao_Paulo;
#   4. apaga o container.
# Uso (de dentro de backend/):  ./scripts/teste-sql-qualidade-ia.sh
# Não toca em produção e não lê nenhum .env: as variáveis abaixo são fictícias.
set -euo pipefail

NOME="pg-qualidade-ia-teste"
PORTA="${PORTA_TESTE:-55432}"
URL="postgresql://postgres:teste@127.0.0.1:${PORTA}/teste"

limpar() { docker rm -f "$NOME" >/dev/null 2>&1 || true; }
trap limpar EXIT
limpar

docker run -d --rm --name "$NOME" -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=teste -p "127.0.0.1:${PORTA}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$NOME" pg_isready -U postgres -d teste >/dev/null 2>&1 && break
  sleep 1
done
sleep 2

export KOMMO_CLIENT_ID=x KOMMO_CLIENT_SECRET=x KOMMO_REDIRECT_URI=http://x KOMMO_SUBDOMAIN=x \
  KOMMO_ACCESS_TOKEN=ficticio-xxxxxxxx OPENAI_API_KEY=ficticio-xxxxxxxxxx \
  SESSION_JWT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx LOG_LEVEL=fatal

DATABASE_URL="$URL" pnpm exec prisma db push --skip-generate >/dev/null

for FUSO in UTC America/Sao_Paulo; do
  docker exec "$NOME" psql -U postgres -d teste -qc "ALTER DATABASE teste SET timezone TO '${FUSO}'"
  echo "== sessão do Postgres em ${FUSO}"
  TESTE_POSTGRES_URL="$URL" TESTE_POSTGRES_FUSO="$FUSO" pnpm exec tsx --test src/lib/qualidade-ia/consulta.sql.test.ts
done
