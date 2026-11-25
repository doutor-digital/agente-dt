#!/usr/bin/env bash
# Roda NA VPS (quem chama é ops/historico-kommo-crm-joao.sh, que também copia esta pasta para /root/kit/crm-historico-kommo).
# 1) o EXPORTADOR (Node, contêiner do agente) lê a Kommo de Timbó e deixa um JSONL no /tmp do próprio contêiner;
# 2) o arquivo passa por um pipe de tar direto para o contêiner chatwoot_rails (NÃO fica em disco do hospedeiro) e o IMPORTADOR (Ruby, rails runner) grava;
# 3) os arquivos com dado de paciente são APAGADOS dos dois contêineres no fim (e se der erro no meio: trap).
# Dado de paciente nunca sai da VPS. A saída inteira vai para o log (só as linhas LOG/REG; nunca nome, telefone ou texto).
#   uso: rodar-na-vps.sh <arquivo-de-log> <conferir|gravar|desfazer> [VAR=valor ...]
#   variáveis: UNIDADE CONTA CAIXA LIMITE GRAVAR(0|1) COMPLETO(0|1) REGISTRO(só desfazer, nome do arquivo no hospedeiro)
set -uo pipefail
LOG="$1"; MODO="$2"; shift 2
[[ "$LOG" =~ ^/root/kit/logs/[A-Za-z0-9._-]+$ ]] || { echo "log inválido"; exit 2; }
[[ "$MODO" =~ ^(conferir|gravar|desfazer)$ ]] || { echo "modo inválido"; exit 2; }
for v in "$@"; do [[ "$v" =~ ^[A-Z_]+=[A-Za-z0-9._,/-]*$ ]] || { echo "variável inválida"; exit 2; }; export "$v"; done
UNIDADE="${UNIDADE:-doutor-hernia-timbo}"; CONTA="${CONTA:-3}"
[[ "$UNIDADE" =~ ^[a-z0-9-]{3,50}$ && "$CONTA" =~ ^[0-9]+$ && "${CAIXA:-0}" =~ ^[0-9]+$ && "${LIMITE:-1}" =~ ^[1-9][0-9]*$ ]] || { echo "parâmetro inválido"; exit 2; }
DIR=/root/kit/crm-historico-kommo
exec 9>/var/lock/crm-historico-kommo.lock
fim() { echo "LOG FIM do processo (código ${1:-0})" >> "$LOG"; }
if ! flock -n 9; then echo "LOG outra rodada da importação da Kommo está em andamento — não inicio outra" > "$LOG"; fim 1; exit 1; fi
: > "$LOG"
saida() { grep --line-buffered -E '^(LOG|REG) ' >> "$LOG"; }
A="$(docker ps --filter name=ddagent_agent --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
R="$(docker ps --filter name=chatwoot_rails --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$R" ] || { echo "LOG ERRO: não achei o contêiner chatwoot_rails" >> "$LOG"; fim 1; exit 1; }
STAMP="$(date +%Y%m%d%H%M%S)-$$"
ARQ="kommo-export-$STAMP.jsonl"
limpar() {
  [ -n "${A:-}" ] && docker exec "$A" rm -f "/tmp/$ARQ" >/dev/null 2>&1
  docker exec "$R" rm -f "/tmp/crm-historico-kommo/$ARQ" >/dev/null 2>&1
}
trap limpar EXIT
docker exec "$R" mkdir -p /tmp/crm-historico-kommo && docker cp "$DIR/." "$R:/tmp/crm-historico-kommo/" >/dev/null || { echo "LOG ERRO: não copiei o código para o contêiner do CRM" >> "$LOG"; fim 1; exit 1; }
ENVR=(-e "CONTA=$CONTA")
[ -n "${CAIXA:-}" ] && [ "${CAIXA}" != 0 ] && ENVR+=(-e "CAIXA=$CAIXA")
[ -n "${LIMITE:-}" ] && ENVR+=(-e "LIMITE_CARTOES=$LIMITE")
rails() { docker exec "${ENVR[@]}" "$@" "$R" bundle exec rails runner /tmp/crm-historico-kommo/importar-kommo-historico.rb 2>&1 | saida; return "${PIPESTATUS[0]}"; }

if [ "$MODO" = desfazer ]; then
  [[ "${REGISTRO:-}" =~ ^historico-kommo-[0-9]{8}-[0-9]{6}-gravar\.txt$ ]] || { echo "LOG ERRO: REGISTRO inválido" >> "$LOG"; fim 2; exit 2; }
  docker cp "/root/kit/logs/$REGISTRO" "$R:/tmp/crm-historico-kommo/registro.jsonl" >/dev/null || { echo "LOG ERRO: não achei o registro" >> "$LOG"; fim 1; exit 1; }
  rails -e MODO=desfazer -e REGISTRO=/tmp/crm-historico-kommo/registro.jsonl -e "GRAVAR=${GRAVAR:-0}"; RC=$?
  docker exec "$R" rm -f /tmp/crm-historico-kommo/registro.jsonl >/dev/null 2>&1
  fim "$RC"; exit "$RC"
fi

# a caixa do WhatsApp tem de existir ANTES de ler a Kommo inteira (o importador a exige): o próprio importador confere (MODO=checar) e explica
if [ "$MODO" = gravar ] || [ "${COMPLETO:-0}" = 1 ]; then
  rails -e MODO=checar -e GRAVAR=0 || { fim 1; exit 1; }
fi

[ -n "$A" ] || { echo "LOG ERRO: não achei o contêiner ddagent_agent" >> "$LOG"; fim 1; exit 1; }
docker exec "$A" test -f /repo/backend/dist/scripts/kommo-historico-exportar.js || { echo "LOG ERRO: o contêiner do agente ainda não tem o exportador (backend/dist/scripts/kommo-historico-exportar.js): publique o deploy do PR antes." >> "$LOG"; fim 1; exit 1; }
EXP=(node dist/scripts/kommo-historico-exportar.js "--unidade=$UNIDADE")
[ -n "${LIMITE:-}" ] && EXP+=("--limite=$LIMITE")

if [ "$MODO" = conferir ] && [ "${COMPLETO:-0}" != 1 ]; then
  docker exec -w /repo/backend "$A" "${EXP[@]}" --so-conferir 2>&1 | saida; RC="${PIPESTATUS[0]}"
  fim "$RC"; exit "$RC"
fi

docker exec -w /repo/backend "$A" "${EXP[@]}" "--saida=/tmp/$ARQ" 2>&1 | saida; RC="${PIPESTATUS[0]}"
[ "$RC" = 0 ] || { fim "$RC"; exit "$RC"; }
# o arquivo vai de um contêiner ao outro por um pipe de tar, sem passar por arquivo do hospedeiro
docker cp "$A:/tmp/$ARQ" - | docker cp - "$R:/tmp/crm-historico-kommo/" >/dev/null 2>&1 || { echo "LOG ERRO: não consegui levar o arquivo ao contêiner do CRM" >> "$LOG"; fim 1; exit 1; }
rails -e "ARQUIVO=/tmp/crm-historico-kommo/$ARQ" -e "GRAVAR=$([ "$MODO" = gravar ] && echo 1 || echo 0)"; RC=$?
fim "$RC"; exit "$RC"
