#!/usr/bin/env bash
# Roda NA VPS (quem chama é ops/historico-social-crm-joao.sh, que também copia esta pasta para /root/kit/crm-historico-social).
# Copia o código para dentro do contêiner chatwoot_rails MAIS NOVO (no rolling update `head -1` pegaria o antigo) e roda o script Ruby
# com `rails runner`. Uma rodada por vez (flock). A saída inteira vai para o arquivo de log que o chamador indicou (só ids e contagens).
#   uso: rodar-na-vps.sh <arquivo-de-log> <script.rb> [VAR=valor ...]
set -uo pipefail
LOG="$1"; SCRIPT="$2"; shift 2
[[ "$LOG" =~ ^/root/kit/logs/[A-Za-z0-9._-]+$ ]] || { echo "log inválido"; exit 2; }
[[ "$SCRIPT" =~ ^[a-z-]+\.rb$ ]] || { echo "script inválido"; exit 2; }
DIR=/root/kit/crm-historico-social
exec 9>/var/lock/crm-historico-social.lock
flock -n 9 || { echo "LOG outra rodada da importação está em andamento — não inicio outra" > "$LOG"; echo "LOG FIM" >> "$LOG"; exit 1; }
R="$(docker ps --filter name=chatwoot_rails --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$R" ] || { echo "LOG ERRO: não achei o contêiner chatwoot_rails" > "$LOG"; echo "LOG FIM" >> "$LOG"; exit 1; }
ENVS=()
for v in "$@"; do [[ "$v" =~ ^[A-Z_]+=[A-Za-z0-9:.,+_/-]*$ ]] && ENVS+=(-e "$v"); done
docker exec "$R" mkdir -p /tmp/crm-historico-social && docker cp "$DIR/." "$R:/tmp/crm-historico-social/" >/dev/null || { echo "LOG ERRO: não consegui copiar o código para o contêiner" > "$LOG"; echo "LOG FIM" >> "$LOG"; exit 1; }
# só o que importa: o Rails joga muito aviso no meio; as linhas LOG/REG são nossas. (grep sem buffer)
docker exec "${ENVS[@]}" "$R" bundle exec rails runner "/tmp/crm-historico-social/$SCRIPT" 2>&1 | grep --line-buffered -E '^(LOG|REG) ' > "$LOG"
echo "LOG FIM do processo (código ${PIPESTATUS[0]})" >> "$LOG"
