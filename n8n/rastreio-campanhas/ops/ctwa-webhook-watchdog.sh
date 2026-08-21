#!/usr/bin/env bash
# Watchdog da inscrição de webhook CTWA no app da Meta.
#
# Problema que ele resolve: qualquer clique em "Listen for test event" no nó
# WhatsApp Trigger faz o n8n executar `DELETE /{app_id}/subscriptions` no teardown
# da sessão de teste — mesmo quando a tentativa falhou. A inscrição de produção
# some e NADA avisa: o n8n continua dizendo "ativo", e o rastreio fica cego até
# alguém reparar que parou de gravar atribuição.
#
# Aqui a inscrição é reposta direto na Graph API, sem desativar/reativar o
# workflow: a rota do n8n continua de pé o tempo todo; o que se perdeu foi só o
# registro do lado da Meta.
#
# Instalado em /root/ctwa-webhook-watchdog.sh na VPS, com segredos em
# /root/.ctwa-webhook.env (chmod 600). Cron:
#   */2 * * * * /usr/bin/flock -n /tmp/ctwa-wd.lock /root/ctwa-webhook-watchdog.sh >> /root/ctwa-webhook-watchdog.log 2>&1

set -uo pipefail

# APP_ID, APP_SECRET, VERIFY_TOKEN, CALLBACK_ESPERADO
# shellcheck disable=SC1091
. /root/.ctwa-webhook.env

GRAPH="https://graph.facebook.com/v23.0"
TOKEN="${APP_ID}|${APP_SECRET}"

log() { echo "$(date '+%F %T') $*"; }

callback_atual() {
  curl -sS --max-time 15 "${GRAPH}/${APP_ID}/subscriptions?access_token=${TOKEN}" \
    | jq -r '.data[]? | select(.object == "whatsapp_business_account") | .callback_url' \
    | head -1
}

# 1) A rota do n8n está de pé? Se o workflow estiver parado, a Meta rejeitaria o
#    registro na verificação — melhor gritar do que tentar e falhar em silêncio.
#    O GET de verificação não gera execução no n8n, então isso não polui o histórico.
desafio="watchdog-$$-$(date +%s)"
resposta=$(curl -sS --max-time 15 \
  "${CALLBACK_ESPERADO}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${desafio}")

if [ "$resposta" != "$desafio" ]; then
  log "FALHA: o endpoint do n8n não devolveu o desafio — workflow parado ou verify_token mudou."
  log "       resposta: ${resposta:0:160}"
  exit 1
fi

# 2) A Meta ainda aponta para ele?
atual=$(callback_atual)

if [ "$atual" = "$CALLBACK_ESPERADO" ]; then
  exit 0   # silêncio quando está tudo certo — o log só guarda anomalia
fi

log "INSCRIÇÃO DIVERGENTE — atual='${atual:-<nenhuma>}'"
log "  restaurando para ${CALLBACK_ESPERADO}"

# `verify_token` TEM de ser o id do nó no n8n: é contra ele que o nó compara o
# handshake. Qualquer outro valor faz a Meta receber 200 sem o challenge e recusar.
retorno=$(curl -sS --max-time 30 -X POST "${GRAPH}/${APP_ID}/subscriptions" \
  -d "object=whatsapp_business_account" \
  --data-urlencode "callback_url=${CALLBACK_ESPERADO}" \
  -d "verify_token=${VERIFY_TOKEN}" \
  -d "fields=messages" \
  -d "include_values=true" \
  -d "access_token=${TOKEN}")

depois=$(callback_atual)

if [ "$depois" = "$CALLBACK_ESPERADO" ]; then
  log "  RESTAURADA (retorno da Meta: ${retorno})"
  exit 0
fi

log "  FALHA AO RESTAURAR — retorno da Meta: ${retorno}"
log "  callback após a tentativa: '${depois:-<nenhuma>}'"
exit 1
