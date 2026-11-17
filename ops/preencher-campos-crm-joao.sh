#!/usr/bin/env bash
# PREENCHE OS CAMPOS VAZIOS do CRM (Chatwoot de Parauapebas, caixa 3 = WhatsApp oficial) — LOTE 2: etapa, funil, motivo e qualificação, a partir
# do cartão do Kommo (só leitura), da agenda da franquia (o que o chatwoot-agenda já gravou) e da classificação da Sofia (últimos 30 dias).
# Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho). A saída não tem nome, telefone nem texto de paciente: só número da conversa, campo, valor e regra.
#
#   bash ops/preencher-campos-crm-joao.sh --so-conferir          # 1º: mostra, por conversa, campo (vazio) → valor + regra. NÃO grava nada
#   bash ops/preencher-campos-crm-joao.sh                        # depois: grava (até 150 conversas por vez; --max=N muda)
#   bash ops/preencher-campos-crm-joao.sh --desfazer=ARQUIVO     # devolve ao que era, a partir do arquivo de uma gravação anterior
#   opções: --conversas=12,34 (só estas)  --caixa=3  --max=150  --guarda=12 (minutos que o script fica reafirmando as marcas depois de gravar)
#
# A saída é guardada em ~/crm-campos-AAAAMMDD-HHMMSS[-seco].log; as linhas «REG {…}» dela são o registro para desfazer.
# Gravando, o script fica ~12 minutos depois do último campo "guardando" as marcas da régua (um ciclo dela leva minutos e pode apagar a marca de
# quem listou antes de a gente gravar): NÃO feche o terminal antes de ver «guarda terminada».
# Só preenche campo VAZIO (nunca sobrescreve). Antes de cada campo, grava as «marcas» que impedem a régua de falar com o paciente e a Meta de
# receber evento de conversão (ver backend/src/lib/chatwoot-campos-retroativos.ts). Repetir é seguro.
# Pré-requisito: o deploy do PR que traz o script já ter subido (o script recusa, dizendo o motivo, se o contêiner não tiver o arquivo).
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }

# só as opções conhecidas, no formato certo (nada é interpretado na VPS)
ARGS=""
SECO=0
DESFAZER=""
for a in "$@"; do
  if [[ "$a" == "--so-conferir" ]]; then
    SECO=1; ARGS+=" $(printf '%q' "$a")"
  elif [[ "$a" =~ ^--caixa=[0-9]+$ || "$a" =~ ^--max=[0-9]+$ || "$a" =~ ^--guarda=[0-9]+$ || "$a" =~ ^--conversas=[0-9]+(,[0-9]+)*$ ]]; then
    ARGS+=" $(printf '%q' "$a")"
  elif [[ "$a" == --desfazer=* ]]; then
    DESFAZER="${a#--desfazer=}"
    [ -r "$DESFAZER" ] || { echo "RECUSO: não consigo ler o arquivo do registro: $DESFAZER"; exit 2; }
    ARGS+=" --desfazer"
  else
    echo "opção inválida: $a (use --so-conferir, --desfazer=ARQUIVO, --conversas=1,2, --caixa=N, --max=N, --guarda=MIN)"; exit 2
  fi
done
[ -z "$DESFAZER" ] || [ "$SECO" = 0 ] || { echo "RECUSO: --desfazer não combina com --so-conferir"; exit 2; }

SUFIXO=""; [ "$SECO" = 1 ] && SUFIXO="-seco"
LOG="$HOME/crm-campos-$(date +%Y%m%d-%H%M%S)${SUFIXO}.log"
# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo); tudo vai como COMANDO do ssh, nunca como script no stdin.
# Só o --desfazer usa o stdin (as linhas REG), por isso é o único com `docker exec -i`.
FLAG_I=""; [ -n "$DESFAZER" ] && FLAG_I="-i"
REMOTO="A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2); [ -n \"\$A\" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }; docker exec \$A test -f /repo/backend/dist/scripts/preencher-campos-crm.js || { echo 'ERRO: o contêiner ainda não tem o script (backend/dist/scripts/preencher-campos-crm.js): publique o deploy do PR antes.'; exit 1; }; docker exec $FLAG_I -w /repo/backend \$A node dist/scripts/preencher-campos-crm.js$ARGS"

echo "guardando a saída em $LOG"
# o script de dentro sai com 1 quando há falha: o resumo abaixo tem de sair mesmo assim (é quando mais se precisa dele)
set +e
if [ -n "$DESFAZER" ]; then
  ssh -i "$CHAVE" -o ConnectTimeout=15 -o ServerAliveInterval=30 "$VPS" "$REMOTO" < "$DESFAZER" 2>&1 | tee "$LOG"
  RC=${PIPESTATUS[0]}
else
  ssh -i "$CHAVE" -o ConnectTimeout=15 -o ServerAliveInterval=30 "$VPS" "$REMOTO" 2>&1 < /dev/null | tee "$LOG"
  RC=${PIPESTATUS[0]}
fi
set -e
echo
echo "conversas por regra (linhas do relatório):"
grep -oE '\[(etapa-kommo|motivo-kommo|tratamento-kommo|compareceu-agenda|qualificacao-sofia|espera-kommo)' "$LOG" | sort | uniq -c || true
[ "$RC" = 0 ] || echo "ATENÇÃO: terminou com código $RC (veja as linhas ERRO/FALHOU/AVISO em $LOG)"
exit "$RC"
