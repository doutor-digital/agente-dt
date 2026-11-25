#!/usr/bin/env bash
# Roda NA VPS (quem chama é ops/etapas-conta-joao.sh). Troca as etapas de uma conta do CRM para os nomes da Kommo: lista dos atributos, etapa de cada conversa e as pastas (filtros salvos),
# mais o mapa em unit_chatwoot.etapas. Banco do Chatwoot por psql (SEM callbacks: nada de webhook, régua nem notificação); decisão pelo Node do contêiner do agente (testado).
# Dado de paciente não entra: o extrato tem só id, etapa, etiquetas e a 1ª linha da nota. A saída (LOG/REG) leva só contagens e ids.
#   uso: rodar-na-vps.sh <arquivo-de-log> <conferir|gravar|desfazer> [VAR=valor ...]    variáveis: UNIDADE CONTA REGISTRO (só desfazer) CONFIRMO (0|1, só desfazer)
set -uo pipefail
LOG="$1"; MODO="$2"; shift 2
[[ "$LOG" =~ ^/root/kit/logs/[A-Za-z0-9._-]+$ ]] || { echo "log inválido"; exit 2; }
recusa() { echo "LOG RECUSADO: $1" > "$LOG"; echo "LOG FIM do processo (código 2)" >> "$LOG"; exit 2; }
[[ "$MODO" =~ ^(conferir|gravar|desfazer)$ ]] || recusa "modo inválido"
for v in "$@"; do [[ "$v" =~ ^[A-Z_]+=[A-Za-z0-9._,/-]*$ ]] || recusa "variável inválida"; export "$v"; done
UNIDADE="${UNIDADE:-doutor-hernia-timbo}"; CONTA="${CONTA:-3}"
[[ "$UNIDADE" =~ ^[a-z0-9-]{3,50}$ && "$CONTA" =~ ^[0-9]+$ ]] || recusa "parâmetro inválido"
[ "$CONTA" -gt 1 ] || recusa "a conta 1 (Parauapebas) é recusada sempre"
DIR=/root/kit/etapas-conta
exec 9>/var/lock/etapas-conta.lock
fim() { echo "LOG FIM do processo (código ${1:-0})" >> "$LOG"; }
if ! flock -n 9; then echo "LOG outra rodada das etapas está em andamento — não inicio outra" > "$LOG"; fim 1; exit 1; fi
: > "$LOG"
saida() { grep --line-buffered -E '^(LOG|REG) ' >> "$LOG"; }
A="$(docker ps --filter name=ddagent_agent --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
P="$(docker ps --filter name=chatwoot_postgres --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$A" ] && [ -n "$P" ] || { echo "LOG ERRO: não achei os contêineres do agente e do banco do CRM" >> "$LOG"; fim 1; exit 1; }
docker exec "$A" test -f /repo/backend/dist/scripts/etapas-conta.js || { echo "LOG ERRO: o contêiner do agente ainda não tem o script (backend/dist/scripts/etapas-conta.js): publique o deploy do PR antes" >> "$LOG"; fim 1; exit 1; }
NODE=(docker exec -i -w /repo/backend "$A" node dist/scripts/etapas-conta.js)
psqlr() { docker exec -i "$P" sh -c 'psql -U "$POSTGRES_USER" -d chatwoot -X -At -v ON_ERROR_STOP=1 "$@"' sh "$@"; }
TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT

if [ "$MODO" = desfazer ]; then
  [[ "${REGISTRO:-}" =~ ^etapas-conta-[0-9]{8}-[0-9]{6}-gravar\.txt$ ]] || { echo "LOG ERRO: REGISTRO inválido" >> "$LOG"; fim 2; exit 2; }
  [ -r "/root/kit/logs/$REGISTRO" ] || { echo "LOG ERRO: não achei o registro" >> "$LOG"; fim 1; exit 1; }
  grep '^REG ' "/root/kit/logs/$REGISTRO" > "$TMP/reg.txt"
  "${NODE[@]}" desfazer "--unidade=$UNIDADE" < "$TMP/reg.txt" > "$TMP/saida.txt" 2>&1; RC=$?
  saida < "$TMP/saida.txt"; grep '^SQL ' "$TMP/saida.txt" | sed 's/^SQL //' > "$TMP/desfazer.sql"
  echo "LOG DESFAZER linhas de SQL: $(wc -l < "$TMP/desfazer.sql") (o único DELETE é a etiqueta esperando-humano que a migração pôs)" >> "$LOG"
  if [ "$RC" != 0 ]; then fim "$RC"; exit "$RC"; fi
  if [ "${CONFIRMO:-0}" != 1 ]; then echo "LOG só mostrei: nada foi desfeito (rode com --confirmo-apagar)" >> "$LOG"; fim 0; exit 0; fi
  psqlr -v "conta=$CONTA" < "$TMP/desfazer.sql" >> "$LOG" 2>&1 || { echo "LOG ERRO: o SQL do desfazer falhou (nada foi aplicado: é uma transação)" >> "$LOG"; fim 1; exit 1; }
  "${NODE[@]}" mapa-restaurar "--unidade=$UNIDADE" --gravar < "$TMP/reg.txt" 2>&1 | saida
  echo "LOG desfeito" >> "$LOG"; fim 0; exit 0
fi

# 1) o extrato (só ids, etapas, etiquetas e a linha da nota) e o plano
psqlr -v "conta=$CONTA" < "$DIR/extrair.sql" > "$TMP/extrato.json" 2> "$TMP/erro.txt" || { echo "LOG ERRO: o extrato falhou: $(head -c 300 "$TMP/erro.txt")" >> "$LOG"; fim 1; exit 1; }
"${NODE[@]}" mapa-ler "--unidade=$UNIDADE" 2>&1 | saida
"${NODE[@]}" plano "--unidade=$UNIDADE" "--conta=$CONTA" < "$TMP/extrato.json" > "$TMP/plano.txt" 2>&1; RC=$?
grep -E '^LOG ' "$TMP/plano.txt" | sed 's/^LOG /LOG /' >> "$LOG"
if [ "$RC" != 0 ]; then fim "$RC"; exit "$RC"; fi
grep '^SQL ' "$TMP/plano.txt" | sed 's/^SQL //' > "$TMP/migrar.sql"
if [ "$MODO" = conferir ]; then
  echo "LOG EM SECO: nada foi gravado. SQL que rodaria: $(wc -l < "$TMP/migrar.sql") linhas (uma transação)." >> "$LOG"
  fim 0; exit 0
fi

# 2) grava: o registro (valor de antes de cada linha) vai para o log ANTES; o SQL é uma transação só; depois o mapa
grep '^REG ' "$TMP/plano.txt" >> "$LOG"
"${NODE[@]}" mapa-gravar "--unidade=$UNIDADE" 2>&1 | saida   # só mostra e registra o valor de antes do mapa
psqlr -v "conta=$CONTA" < "$TMP/migrar.sql" >> "$LOG" 2>&1 || { echo "LOG ERRO: o SQL falhou (nada foi aplicado: é uma transação). O mapa NÃO foi gravado." >> "$LOG"; fim 1; exit 1; }
echo "LOG SQL aplicado (listas, conversas, etiquetas e pastas)" >> "$LOG"
"${NODE[@]}" mapa-gravar "--unidade=$UNIDADE" --gravar 2>&1 | saida
echo "LOG mapa gravado em unit_chatwoot.etapas (o agente relê em até 1 minuto)" >> "$LOG"
fim 0
