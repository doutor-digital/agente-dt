#!/usr/bin/env bash
# PROVA DE SILÊNCIO da importação do histórico (Instagram/Messenger -> CRM), numa instalação DESCARTÁVEL do Chatwoot no SEU computador:
# Postgres e Redis próprios, banco vazio (nenhum dado de paciente, nenhuma ligação com a produção), webhook + automação ligados, sem
# worker. Mede o que dispara numa criação normal (controle positivo), roda a importação de verdade com fixtures no lugar da Meta e
# confere zero eventos / jobs / HTTP / e-mail / notificações, conversas vivas idênticas, idempotência, nome do Messenger e a chegada
# de mensagem nova depois. Apaga tudo no fim.   Uso:  bash ops/crm-historico-social/testar-silencio.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMG="${IMG:-chatwoot/chatwoot:v4.19.1-ce}"
NET=hs-silencio; PG=hs-silencio-pg; RD=hs-silencio-redis
TRAB="$(mktemp -d)"
limpar() { docker rm -f "$PG" "$RD" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$TRAB"; }
trap limpar EXIT
limpar >/dev/null 2>&1; TRAB="$(mktemp -d)"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=teste -e POSTGRES_USER=postgres -e POSTGRES_DB=chatwoot pgvector/pgvector:pg16 >/dev/null
docker run -d --name "$RD" --network "$NET" redis:7.4-alpine >/dev/null 2>&1 || docker run -d --name "$RD" --network "$NET" redis:alpine >/dev/null
for i in $(seq 1 90); do [ "$(docker logs "$PG" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && docker exec "$PG" psql -U postgres -d chatwoot -Atc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
cat > "$TRAB/env" <<ENV
RAILS_ENV=production
SECRET_KEY_BASE=teste-silencio-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
POSTGRES_HOST=$PG
POSTGRES_USERNAME=postgres
POSTGRES_PASSWORD=teste
POSTGRES_DATABASE=chatwoot
REDIS_URL=redis://$RD:6379
FRONTEND_URL=http://teste.invalid
ENABLE_ACCOUNT_SIGNUP=false
INSTALLATION_ENV=docker
DISABLE_DATABASE_ENVIRONMENT_CHECK=1
ENV
rodar() { docker run --rm --network "$NET" --env-file "$TRAB/env" -v "$AQUI":/t:ro -v "$TRAB":/work "$@"; }
echo "1/7 criando o banco vazio (schema do Chatwoot)"
rodar "$IMG" bundle exec rails db:schema:load 2>&1 | grep -v -E "^\s*$|^[WIDE], \[" | tail -3
FALHOU=0
fase() { # $1 = número, $2 = rótulo
  echo "== $2"
  rodar -e FASE="$1" "$IMG" bundle exec rails runner /t/silencio-teste.rb 2>&1 | grep -v -E "^\s*$|^[WIDE], \[|INFO: Sidekiq|warning:" | tee "$TRAB/raw$1" | grep -E "^(PASSOU|FALHOU|RESULTADO|controle|durante|LOG|REG|Error|.*rror)" | sed -E 's/^REG .*/REG (registro de ids, omitido aqui)/' | tee "$TRAB/saida$1"
  grep -q "TUDO PASSOU" "$TRAB/saida$1" || FALHOU=1
}
fase 1 "2/7 semeia, controle positivo, seco, importação, conferência"
fase 2 "3/7 segunda rodada (idempotência) + mensagem velha que aparece depois"
fase 3 "4/7 rotina dos John Doe do Messenger"
fase 4 "5/7 mensagem nova chega pelo caminho normal depois da importação"
cat "$TRAB/raw1" "$TRAB/raw2" | grep '^REG ' > "$TRAB/registro.jsonl"
fase 5 "6/7 desfazer com o registro de ids (seco e de verdade)"
fase 6 "7/7 parâmetros ruins (limite 0, corte tarde demais) são recusados"
echo; [ "$FALHOU" = 0 ] && echo "PROVA DE SILÊNCIO: TUDO PASSOU" || echo "PROVA DE SILÊNCIO: HOUVE FALHA (veja acima)"
exit "$FALHOU"
