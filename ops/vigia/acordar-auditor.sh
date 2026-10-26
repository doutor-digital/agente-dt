#!/usr/bin/env bash
# ACORDA O AUDITOR quando o vigia enfileira ficha.
#
# POR QUE AQUI E NÃO NA VPS (medido em 26/10/2026, não suposto):
#   • 89.116.214.130 não tem o CLI do Claude e não tem node no host (`which claude` vazio,
#     `node -v` = command not found). O node só existe DENTRO dos containers.
#   • a máquina do João tem `claude` 2.1.261 em ~/.local/bin e um crontab de usuário que já roda
#     (cérebro das 17h, backup da memória de hora em hora).
#   • o CLI não tem subcomando de agendamento próprio (`claude --help`: agents, auth, mcp... sem
#     `schedule`), então "agente agendado na nuvem" só existe pela rotina do app, que não é cron
#     que eu consiga ligar daqui.
#   → logo: o relógio fica na VPS (cron + vigia-unidade.py) e o AUDITOR acorda aqui, pelo cron do
#     usuário. Se a máquina estiver desligada, a fila espera na VPS — nenhuma ficha se perde.
#
# TETO DE CUSTO: por quantidade (VIGIA_TETO_AUDITORIAS, padrão 3/dia) e por dinheiro
# (VIGIA_TETO_CUSTO_DIA, padrão US$ 5,00/dia). Cada investigação grava quanto custou em
# ~/.vigia-petropolis/custo.jsonl — sem isso, "a IA tá cara" vira discussão sem número.
set -uo pipefail

VPS="${VIGIA_VPS:-root@89.116.214.130}"
RAIZ_VPS="${VIGIA_RAIZ_VPS:-/root/vigia-petropolis}"
LOCAL="${VIGIA_LOCAL:-$HOME/.vigia-petropolis}"
WT="${VIGIA_WORKTREE:-$HOME/wt-vigia}"
PROMPT="${VIGIA_PROMPT:-$WT/ops/vigia/auditor.md}"
PORTA="${VIGIA_PORTA:-$WT/ops/vigia/vigia-ler-producao.sh}"
TETO_DIA="${VIGIA_TETO_AUDITORIAS:-3}"
# Medido na primeira investigação de verdade (26/10, contador 7): US$ 2,07 e 9 min com sonnet em
# esforço médio. O teto de dinheiro existe porque o teto de quantidade sozinho não protege: três
# investigações grandes num dia ruim passam de US$ 6.
TETO_CUSTO="${VIGIA_TETO_CUSTO_DIA:-6.00}"
MODELO="${VIGIA_MODELO:-sonnet}"
ESFORCO="${VIGIA_ESFORCO:-medium}"
CLAUDE="${VIGIA_CLAUDE:-$HOME/.local/bin/claude}"

mkdir -p "$LOCAL/fichas" "$LOCAL/feitas"
LEDGER="$LOCAL/custo.jsonl"
hoje=$(date +%F)

gasto_hoje() { awk -v d="$hoje" -F'"' '$0 ~ d {for(i=1;i<=NF;i++) if($i=="custo"){split($0,a,"\"custo\":");split(a[2],b,",");s+=b[1]}} END{printf "%.4f", s+0}' "$LEDGER" 2>/dev/null; }
feitas_hoje() { ls "$LOCAL/feitas" 2>/dev/null | grep -c "^$hoje" ; }

# A fila mora na VPS (é lá que o relógio bate). VIGIA_FILA_LOCAL existe para ensaio e para o dia em
# que o vigia inteiro rodar numa máquina só.
if [ -n "${VIGIA_FILA_LOCAL:-}" ]; then
  pendentes=$(ls -1 "$VIGIA_FILA_LOCAL"/*.json 2>/dev/null || true)
else
  pendentes=$(ssh -o BatchMode=yes -o ConnectTimeout=15 "$VPS" "ls -1 $RAIZ_VPS/fila/*.json 2>/dev/null" || true)
fi
[ -z "$pendentes" ] && { echo "[auditor] fila vazia — nada a fazer"; exit 0; }

while read -r remoto; do
  [ -z "$remoto" ] && continue
  nome=$(basename "$remoto")
  [ -e "$LOCAL/feitas/$nome" ] && continue

  n=$(feitas_hoje); g=$(gasto_hoje)
  if [ "${n:-0}" -ge "$TETO_DIA" ]; then
    echo "[auditor] teto de $TETO_DIA investigações/dia atingido — $nome fica para amanhã"; break
  fi
  if awk -v g="$g" -v t="$TETO_CUSTO" 'BEGIN{exit !(g+0 >= t+0)}'; then
    echo "[auditor] teto de US\$ $TETO_CUSTO/dia atingido (gasto: US\$ $g) — $nome fica para amanhã"; break
  fi

  if [ -n "${VIGIA_FILA_LOCAL:-}" ]; then
    cp "$remoto" "$LOCAL/fichas/$nome"
  else
    scp -q -o BatchMode=yes "$VPS:$remoto" "$LOCAL/fichas/$nome" || { echo "[auditor] não consegui trazer $nome"; continue; }
  fi
  echo "[auditor] investigando $nome (hoje: $n investigações, US\$ $g)"

  # VIGIA_SECO=1: prova a corrente inteira sem abrir PR (foi assim que ela foi medida em 26/10).
  extra=""
  ferramentas=(Read Grep Glob Write Edit TodoWrite "Bash(git *)" "Bash(gh pr *)" "Bash($PORTA *)")
  if [ "${VIGIA_SECO:-0}" = "1" ]; then
    extra="

MODO PROVA (seco): escreva a ficha em ops/vigia/fichas/ e PARE. Não crie branch, não faça commit e
não abra PR — nesta rodada o objetivo é provar a corrente e medir o custo."
    ferramentas=(Read Grep Glob Write Edit TodoWrite "Bash($PORTA *)")
  fi

  pergunta="$(cat "$PROMPT")

\`\`\`json
$(cat "$LOCAL/fichas/$nome")
\`\`\`

A porta de leitura da produção é: $PORTA
O worktree para a ficha e o PR é: $WT (branch própria, nunca main)$extra"

  saida="$LOCAL/fichas/${nome%.json}.resposta.json"
  ( cd "$WT" && "$CLAUDE" -p "$pergunta" \
      --model "$MODELO" \
      --effort "$ESFORCO" \
      --output-format json \
      --permission-prompts none \
      --mcp-config '{"mcpServers":{}}' --strict-mcp-config \
      --allowedTools "${ferramentas[@]}" \
    ) > "$saida" 2>"$LOCAL/fichas/${nome%.json}.erro.txt"

  custo=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("total_cost_usd",0))' "$saida" 2>/dev/null || echo 0)
  printf '{"em":"%s","ficha":"%s","custo":%s,"modelo":"%s"}\n' "$(date -Is)" "$nome" "${custo:-0}" "$MODELO" >> "$LEDGER"
  : > "$LOCAL/feitas/$nome"
  echo "[auditor] $nome terminou — custou US\$ ${custo:-0}"
done <<< "$pendentes"
