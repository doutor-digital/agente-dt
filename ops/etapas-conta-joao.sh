#!/usr/bin/env bash
# TROCA AS ETAPAS do CRM de Timbó (conta 3) para os nomes da Kommo: a lista dos atributos «etapa» e «etapa_tratamento», a etapa de cada conversa (as ~750: importadas e novas) e as
# PASTAS (filtros salvos) que filtram por etapa; e grava o mapa em unit_chatwoot.etapas. Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho). Dado de paciente não sai da VPS: o banco do CRM é lido
# por psql dentro da VPS e só ids, etapas e etiquetas passam para a decisão; na tela e nos logs: só contagens e ids. Nada é gravado com callbacks (sem webhook, régua, notificação ou mensagem).
#
#   ANTES (pré-requisitos): o deploy do PR (backend/dist/scripts/etapas-conta.js) e a IMPORTAÇÃO da Kommo terminada. Rode FORA do horário de pico (a régua do CRM está em seco em Timbó).
#
#   bash ops/etapas-conta-joao.sh --so-conferir        # lê e mostra o que trocaria (contagens «de → para», pastas, listas). NÃO grava nada. Rode e confira antes de gravar
#   bash ops/etapas-conta-joao.sh                      # grava (uma transação no banco do CRM; depois o mapa). O registro de ids/valores de antes fica no log da VPS
#
#   DESFAZER (usa o registro do log da rodada que gravou):
#   bash ops/etapas-conta-joao.sh --desfazer=etapas-conta-AAAAMMDD-HHMMSS-gravar.txt                       # só mostra o que desfaria
#   bash ops/etapas-conta-joao.sh --desfazer=ARQ --confirmo-apagar                                          # desfaz (o único DELETE é a etiqueta esperando-humano que a migração pôs)
#   opções: --conta=3  --unidade=doutor-hernia-timbo   --acompanhar=ARQ (volta a olhar um log)
#
# O que NUNCA é feito: tirar etiqueta (a conferir-etapa fica; a equipe tira ao conferir), mexer em conversa que a equipe já mudou desde que o plano foi lido (cada UPDATE vale só se o valor de antes
# ainda é o mesmo), reclassificar pela Kommo uma conversa que a equipe já mexeu (só renomeia).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASTA="$AQUI/etapas-conta"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
[ -f "$PASTA/rodar-na-vps.sh" ] || { echo "RECUSO: não achei $PASTA (rode de dentro do repositório)"; exit 1; }

SECO=0; CONTA="3"; UNIDADE="doutor-hernia-timbo"; DESFAZER=""; CONFIRMO=0; ACOMPANHAR=""
for a in "$@"; do
  case "$a" in
    --so-conferir) SECO=1 ;;
    --conta=*) [[ "$a" =~ ^--conta=[1-9][0-9]*$ ]] || { echo "opção inválida: $a"; exit 2; }; CONTA="${a#--conta=}" ;;
    --unidade=*) [[ "$a" =~ ^--unidade=[a-z0-9-]{3,50}$ ]] || { echo "opção inválida: $a"; exit 2; }; UNIDADE="${a#--unidade=}" ;;
    --desfazer=*) [[ "$a" =~ ^--desfazer=etapas-conta-[0-9]{8}-[0-9]{6}-gravar\.txt$ ]] || { echo "opção inválida: $a (nome do log de uma rodada que GRAVOU)"; exit 2; }; DESFAZER="${a#--desfazer=}" ;;
    --confirmo-apagar) CONFIRMO=1 ;;
    --acompanhar=*) [[ "$a" =~ ^--acompanhar=etapas-conta-[0-9]{8}-[0-9]{6}-[a-z]+\.txt$ ]] || { echo "opção inválida: $a"; exit 2; }; ACOMPANHAR="${a#--acompanhar=}" ;;
    *) echo "opção inválida: $a (use --so-conferir, --conta=N, --unidade=slug, --desfazer=ARQ [--confirmo-apagar], --acompanhar=ARQ)"; exit 2 ;;
  esac
done
[ "$CONTA" -gt 1 ] || { echo "RECUSO: a conta 1 (Parauapebas) fica como está, sempre."; exit 2; }
if [ -n "$ACOMPANHAR" ]; then [ "$SECO$CONFIRMO" = 00 ] && [ -z "$DESFAZER" ] || { echo "RECUSO: --acompanhar não combina com outras opções"; exit 2; }; fi
[ "$CONFIRMO" = 1 ] && [ -z "$DESFAZER" ] && { echo "RECUSO: --confirmo-apagar só vale junto de --desfazer=<log>."; exit 2; }
[ -n "$DESFAZER" ] && [ "$SECO" = 1 ] && { echo "RECUSO: --desfazer já é só-mostrar sem --confirmo-apagar; não combina com --so-conferir."; exit 2; }

SSH=(ssh -i "$CHAVE" -o ConnectTimeout=15 -o ServerAliveInterval=20 "$VPS")

acompanhar() { # $1 = nome do log na VPS
  local log="/root/kit/logs/$1" desde=0 saiu=0 tmp mortos=0 vivo
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  echo "acompanhando $log (Ctrl-C só para de olhar; a rodada continua na VPS)"
  while true; do
    if "${SSH[@]}" "tail -c +$((desde + 1)) $log 2>/dev/null | head -c 200000" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      grep -v '^REG ' "$tmp" || true
      desde=$((desde + $(wc -c < "$tmp")))
      grep -qE '^LOG FIM do processo' "$tmp" && saiu=1
    fi
    [ "$saiu" = 1 ] && break
    vivo="$("${SSH[@]}" "pgrep -f '[r]odar-na-vps.sh /root/kit/logs/$1' > /dev/null && echo s || echo n" 2>/dev/null || echo s)"
    if [ "$vivo" = n ]; then mortos=$((mortos + 1)); else mortos=0; fi
    if [ "$mortos" -ge 3 ]; then echo "O processo na VPS terminou SEM escrever o fim. Olhe o log (/root/kit/logs/$1) antes de rodar de novo; o registro do que já foi gravado está lá."; break; fi
    sleep 5
  done
  echo "REGISTRO (valores de antes, para desfazer) no log da VPS: /root/kit/logs/$1"
  [ "$mortos" -ge 3 ] && return 3
  local cod
  cod="$(grep -oE 'LOG FIM do processo \(código [0-9]+\)' "$tmp" | tail -1 | grep -oE '[0-9]+' || true)"
  return "${cod:-0}"
}

if [ -n "$ACOMPANHAR" ]; then acompanhar "$ACOMPANHAR"; exit $?; fi

# 1) leva o código para a VPS
tar czf - -C "$PASTA" extrair.sql rodar-na-vps.sh \
  | "${SSH[@]}" 'mkdir -p /root/kit/etapas-conta /root/kit/logs && tar xzf - -C /root/kit/etapas-conta && chmod +x /root/kit/etapas-conta/rodar-na-vps.sh'

STAMP="$(date +%Y%m%d-%H%M%S)"
VARS="UNIDADE=$UNIDADE CONTA=$CONTA"
if [ -n "$DESFAZER" ]; then
  MODO="desfazer"; LOGNOME="etapas-conta-$STAMP-desfazer.txt"
  VARS="$VARS REGISTRO=$DESFAZER CONFIRMO=$CONFIRMO"
  echo "DESFAZER ($([ "$CONFIRMO" = 1 ] && echo 'VAI APLICAR' || echo 'só mostra')) com o registro de $DESFAZER"
elif [ "$SECO" = 1 ]; then
  MODO="conferir"; LOGNOME="etapas-conta-$STAMP-conferir.txt"
  echo "CONFERÊNCIA EM SECO — unidade $UNIDADE (conta $CONTA): nada é gravado"
else
  MODO="gravar"; LOGNOME="etapas-conta-$STAMP-gravar.txt"
  echo "GRAVANDO as etapas da conta $CONTA ($UNIDADE) com os nomes da Kommo"
fi
"${SSH[@]}" "setsid nohup /root/kit/etapas-conta/rodar-na-vps.sh /root/kit/logs/$LOGNOME $MODO $VARS > /dev/null 2>&1 < /dev/null &"
sleep 3
acompanhar "$LOGNOME"
exit $?
