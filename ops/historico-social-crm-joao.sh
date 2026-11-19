#!/usr/bin/env bash
# IMPORTA O HISTÓRICO do Instagram Direct (caixa 7) e do Messenger (caixa 8) da conta 1 (Doutor Hérnia Parauapebas) para o CRM.
# Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho). O dado de paciente NÃO sai da VPS: o código roda dentro do contêiner chatwoot_rails
# (rails runner), lê a Meta de lá e grava direto nas tabelas, SEM callbacks do Chatwoot (nenhuma automação, webhook, notificação ou
# mensagem para fora). Na tela e nos logs: só ids e contagens — nunca nome, @usuário, telefone, texto ou token.
#
#   bash ops/historico-social-crm-joao.sh --so-conferir            # 1º: conta tudo (Meta e banco, só leitura) e NÃO grava nada
#   bash ops/historico-social-crm-joao.sh --limite=5               # piloto: grava só as 5 primeiras conversas de cada caixa
#   bash ops/historico-social-crm-joao.sh                          # o lote inteiro
#   opções: --caixa=7 | --caixa=8 (padrão: as duas)   --corte=AAAA-MM-DDTHH:MM:SSZ (padrão: início da rodada − 15 min; mensagem
#           mais nova que o corte é «viva» e fica para o webhook)   --ritmo=0.7 (segundos entre chamadas à Meta)
#
#   DESFAZER (usa o registro de ids que cada rodada deixa no log):
#   bash ops/historico-social-crm-joao.sh --desfazer=historico-social-AAAAMMDD-HHMMSS-gravar.txt              # só mostra o que desfaria
#   bash ops/historico-social-crm-joao.sh --desfazer=ARQ --confirmo-apagar                                       # desfaz (APAGA as linhas criadas)
#
# O processo sobrevive à queda do ssh (roda desacoplado na VPS); o log fica em /root/kit/logs/historico-social-<data>-<modo>.txt e
# esta tela só o acompanha — se cair, é só rodar de novo `--acompanhar=<arquivo>`. Repetir é seguro: mensagem já importada (source_id da
# Meta) é pulada. Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASTA="$AQUI/crm-historico-social"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
[ -f "$PASTA/importar-historico-social.rb" ] || { echo "RECUSO: não achei $PASTA (rode de dentro do repositório)"; exit 1; }

SECO=0; CAIXAS="7,8"; LIMITE=""; CORTE=""; RITMO=""; DESFAZER=""; CONFIRMO=0; ACOMPANHAR=""
for a in "$@"; do
  case "$a" in
    --so-conferir) SECO=1 ;;
    --caixa=7|--caixa=8) CAIXAS="${a#--caixa=}" ;;
    --limite=[0-9]*) [[ "$a" =~ ^--limite=[0-9]+$ ]] || { echo "opção inválida: $a"; exit 2; }; LIMITE="${a#--limite=}" ;;
    --corte=*) [[ "$a" =~ ^--corte=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "opção inválida: $a (use --corte=2026-11-19T14:00:00Z)"; exit 2; }; CORTE="${a#--corte=}" ;;
    --ritmo=*) [[ "$a" =~ ^--ritmo=[0-9](\.[0-9]+)?$ ]] || { echo "opção inválida: $a"; exit 2; }; RITMO="${a#--ritmo=}" ;;
    --desfazer=*) [[ "$a" =~ ^--desfazer=historico-social-[0-9]{8}-[0-9]{6}-gravar\.txt$ ]] || { echo "opção inválida: $a (nome do arquivo de log de uma rodada que GRAVOU, ex.: historico-social-20261119-153000-gravar.txt)"; exit 2; }; DESFAZER="${a#--desfazer=}" ;;
    --confirmo-apagar) CONFIRMO=1 ;;
    --acompanhar=*) [[ "$a" =~ ^--acompanhar=historico-social-[0-9]{8}-[0-9]{6}-[a-z]+\.txt$ ]] || { echo "opção inválida: $a"; exit 2; }; ACOMPANHAR="${a#--acompanhar=}" ;;
    *) echo "opção inválida: $a (use --so-conferir, --limite=N, --caixa=7|8, --corte=..., --ritmo=..., --desfazer=ARQ [--confirmo-apagar], --acompanhar=ARQ)"; exit 2 ;;
  esac
done

SSH=(ssh -i "$CHAVE" -o ConnectTimeout=15 -o ServerAliveInterval=20 "$VPS")

acompanhar() { # $1 = nome do log na VPS
  local log="/root/kit/logs/$1" desde=0 saiu=0 tmp
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  echo "acompanhando $log (Ctrl-C só para de olhar; a rodada continua na VPS)"
  while true; do
    # arquivo temporário (e não $(...)): a substituição de comando come os \n do fim e o contador de bytes erraria
    if "${SSH[@]}" "tail -c +$((desde + 1)) $log 2>/dev/null | head -c 200000" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      grep -v '^REG ' "$tmp" || true
      desde=$((desde + $(wc -c < "$tmp")))
      grep -qE '^LOG ([0-9:]+ )?FIM' "$tmp" && saiu=1
    fi
    [ "$saiu" = 1 ] && break
    sleep 10
  done
  echo "REGISTRO (ids, para desfazer) no log da VPS: /root/kit/logs/$1"
}

if [ -n "$ACOMPANHAR" ]; then acompanhar "$ACOMPANHAR"; exit 0; fi

# 1) leva o código para a VPS
tar czf - -C "$PASTA" historico_social.rb importar-historico-social.rb corrigir-nomes-messenger.rb rodar-na-vps.sh \
  | "${SSH[@]}" 'mkdir -p /root/kit/crm-historico-social /root/kit/logs && tar xzf - -C /root/kit/crm-historico-social && chmod +x /root/kit/crm-historico-social/rodar-na-vps.sh'

STAMP="$(date +%Y%m%d-%H%M%S)"
ENVS="CAIXAS=$CAIXAS"
if [ -n "$DESFAZER" ]; then
  LOGNOME="historico-social-$STAMP-desfazer.txt"
  [ "$CONFIRMO" = 1 ] && GR="GRAVAR=1" || GR="GRAVAR=0"
  echo "DESFAZER ($([ "$CONFIRMO" = 1 ] && echo 'VAI APAGAR' || echo 'só mostra')) com o registro de $DESFAZER"
  # o registro (linhas REG) é entregue ao contêiner por cópia de arquivo, nunca pela linha de comando
  REMOTO="cp /root/kit/logs/$DESFAZER /root/kit/crm-historico-social/registro.jsonl && setsid nohup /root/kit/crm-historico-social/rodar-na-vps.sh /root/kit/logs/$LOGNOME importar-historico-social.rb MODO=desfazer REGISTRO=/tmp/crm-historico-social/registro.jsonl $GR > /dev/null 2>&1 < /dev/null &"
else
  if [ "$SECO" = 1 ]; then MODO="conferir"; GR="GRAVAR=0"; else MODO="gravar"; GR="GRAVAR=1"; fi
  LOGNOME="historico-social-$STAMP-$MODO.txt"
  [ -n "$LIMITE" ] && ENVS="$ENVS LIMITE_CONVERSAS=$LIMITE"
  [ -n "$CORTE" ] && ENVS="$ENVS CORTE=$CORTE"
  [ -n "$RITMO" ] && ENVS="$ENVS RITMO=$RITMO"
  echo "$([ "$SECO" = 1 ] && echo 'CONFERÊNCIA EM SECO (só lê, não grava nada)' || echo 'GRAVANDO no CRM') — caixas $CAIXAS${LIMITE:+, limite $LIMITE conversas por caixa}"
  REMOTO="setsid nohup /root/kit/crm-historico-social/rodar-na-vps.sh /root/kit/logs/$LOGNOME importar-historico-social.rb $GR $ENVS > /dev/null 2>&1 < /dev/null &"
fi
"${SSH[@]}" "$REMOTO"
sleep 3
acompanhar "$LOGNOME"
