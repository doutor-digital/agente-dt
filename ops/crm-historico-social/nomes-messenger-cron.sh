#!/usr/bin/env bash
# Roda NA VPS, a cada 10 min, pelo /etc/cron.d/crm-nomes-messenger (instalado por ops/nomes-messenger-crm-joao.sh --ligar).
# Corrige os «John Doe» da caixa do Messenger (nome real vem da conversa da página). Barato: pergunta ao Postgres se existe candidato e
# SÓ ENTÃO acorda o Rails (~10 s de boot). Nos 10 min "cheios" (minuto < 10 = 1x por hora) olha contatos dos últimos 3 dias; nas demais,
# só os das últimas 2 h — quem a Meta não nomeia não vira 144 consultas por dia. Uma linha de log por execução (só contagens).
# Para parar sem desinstalar:  touch /root/kit/crm-historico-social/PARAR   (apague o arquivo para voltar).
set -uo pipefail
DIR=/root/kit/crm-historico-social
CAIXA="${CAIXA:-8}"
agora() { date -u +%Y-%m-%dT%H:%M:%SZ; }
[ -e "$DIR/PARAR" ] && { echo "$(agora) nomes-messenger: PARADO (arquivo PARAR)"; exit 0; }
HORAS=2; [ "$(date +%-M)" -lt 10 ] && HORAS=72
P="$(docker ps --filter name=chatwoot_postgres --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
R="$(docker ps --filter name=chatwoot_rails --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$P" ] && [ -n "$R" ] || { echo "$(agora) nomes-messenger: não achei os contêineres do Chatwoot"; exit 0; }
U="$(docker exec "$P" printenv POSTGRES_USER)"; D="$(docker exec "$P" printenv POSTGRES_DB)"
N="$(docker exec "$P" psql -U "$U" -d "$D" -Atc "select count(distinct c.id) from contacts c join contact_inboxes ci on ci.contact_id=c.id where ci.inbox_id=$CAIXA and (c.name='John Doe' or btrim(c.name)='') and c.created_at > (now() at time zone 'utc') - interval '$HORAS hours'" 2>/dev/null)"
if ! [[ "${N:-x}" =~ ^[0-9]+$ ]]; then echo "$(agora) nomes-messenger: não consegui perguntar ao Postgres"; exit 0; fi
if [ "$N" = 0 ]; then echo "$(agora) nomes-messenger: candidatos=0 (janela ${HORAS}h)"; exit 0; fi
docker exec "$R" mkdir -p /tmp/crm-historico-social && docker cp "$DIR/." "$R:/tmp/crm-historico-social/" >/dev/null 2>&1 || { echo "$(agora) nomes-messenger: não copiei o código"; exit 0; }
GRAVAR=1; [ "${SECO:-0}" = 1 ] && GRAVAR=0 # SECO=1 bash nomes-messenger-cron.sh  = ensaio à mão, não grava
SAIDA="$(docker exec -e GRAVAR="$GRAVAR" -e CAIXA="$CAIXA" -e HORAS="$HORAS" -e MAXIMO=30 "$R" bundle exec rails runner /tmp/crm-historico-social/corrigir-nomes-messenger.rb 2>&1 | grep -E '^(LOG|REG) ')"
printf '%s\n' "$SAIDA" | grep '^LOG ' | tail -3
# o log não cresce sem fim
if [ -f /root/kit/logs/nomes-messenger.log ] && [ "$(wc -l < /root/kit/logs/nomes-messenger.log)" -gt 20000 ]; then tail -n 10000 /root/kit/logs/nomes-messenger.log > /root/kit/logs/nomes-messenger.log.tmp && mv /root/kit/logs/nomes-messenger.log.tmp /root/kit/logs/nomes-messenger.log; fi
