#!/bin/bash
# Prova o "Reservar envio" v3 num Postgres descartável (docker): 1 LeadSubmitted por clique, o seco não queima o envio,
# e o que já saiu nunca volta. Não toca em produção. Uso: n8n/capi-conversoes/teste-reservar-envio.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
C=capi-teste-$$
docker run -d --rm --name "$C" -e POSTGRES_PASSWORD=x postgres:16-alpine >/dev/null
trap 'docker rm -f "$C" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 40); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done
sleep 1
P(){ docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }
P <<'SQL'
CREATE TABLE capi_envios (
  id bigserial PRIMARY KEY, event_id text NOT NULL UNIQUE, event_name text NOT NULL, unidade text, pixel_id text,
  ctwa_clid text, telefone text, kommo_lead_id text, wamid text, status text NOT NULL DEFAULT 'reservado',
  http_status int, resposta jsonb, enviado_em timestamptz, valor numeric(14,2), reservado_em timestamptz NOT NULL DEFAULT now());
SQL
# R <event_id> <event_name> <clid ou vazio> <telefone ou vazio> <lead>
Q(){ [ -n "$1" ] && echo "'$1'" || echo NULL; }
R(){ { echo "PREPARE r(text,text,text,text,text,text,text,text,numeric) AS"; sed 's/^--.*$//' "${SQL:-$AQUI/reservar-envio.v3.sql}" | sed 's/;\s*$//'; echo ";";
  echo "EXECUTE r('$1','$2','balsas','ds',$(Q "$3"),$(Q "$4"),'$5',NULL,NULL);"; } | P | grep -vE '^(PREPARE|INSERT)' | tr -d '\n' || true; }
MARCA(){ P -c "UPDATE capi_envios SET status='$2', enviado_em=now() WHERE event_id='$1'"  >/dev/null; }
ok=0; fail=0
T(){ if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "  ok   $1"; else fail=$((fail+1)); echo "  FALHOU $1 (esperado '$3', veio '$2')"; fi; }

T "1o Lead do clique reserva"                         "$(R quente-1 LeadSubmitted CLID-A 5599111 1)" "quente-1"
MARCA quente-1 enviado
T "2o cartao com o MESMO clid: bloqueado"            "$(R quente-2 LeadSubmitted CLID-A 5599111 2)" ""
T "outro clid: passa"                                 "$(R quente-3 LeadSubmitted CLID-B 5599222 3)" "quente-3"
T "AddToCart do mesmo clid nao e bloqueado"          "$(R agendado-2 AddToCart CLID-A 5599111 2)" "agendado-2"
T "o proprio cartao ja enviado nao volta (UNIQUE)"   "$(R quente-1 LeadSubmitted CLID-A 5599111 1)" ""
MARCA quente-3 simulado
T "outro cartao no clid so SIMULADO nao bloqueia"    "$(R quente-4 LeadSubmitted CLID-B 5599222 4)" "quente-4"
MARCA quente-4 falhou
T "simulado volta a reservar (seco nao queima)"      "$(R quente-3 LeadSubmitted CLID-B 5599222 3)" "quente-3"
MARCA quente-3 simulado
T "falhou do outro cartao nao bloqueia"              "$(R quente-5 LeadSubmitted CLID-B 5599222 5)" "quente-5"
# Status (sem clid): vale o mesmo telefone
T "Status 1o: reserva"                                "$(R quente-6 LeadSubmitted '' 5599333 6)" "quente-6"
MARCA quente-6 enviado
T "Status: outro cartao, mesmo telefone: bloqueado"  "$(R quente-7 LeadSubmitted '' 5599333 7)" ""
T "Status: telefone diferente passa"                  "$(R quente-8 LeadSubmitted '' 5599444 8)" "quente-8"
T "Status nao e bloqueado por lead com clid"         "$(R quente-9 LeadSubmitted '' 5599111 9)" "quente-9"
P -c "INSERT INTO capi_envios(event_id,event_name,ctwa_clid,status,reservado_em) VALUES ('quente-10','LeadSubmitted','CLID-C','reservado',now()-interval '2 hours')" >/dev/null
T "reservado pendurado ha +1h nao bloqueia"          "$(R quente-11 LeadSubmitted CLID-C 5599555 11)" "quente-11"
echo "== $ok ok, $fail falhas"; [ "$fail" = 0 ]
