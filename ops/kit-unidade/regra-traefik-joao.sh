#!/usr/bin/env bash
# ACRESCENTA O SUBDOMÍNIO DA CLÍNICA NA REGRA DO TRAEFIK do serviço chatwoot_franquias (o proxy dos CRMs das clínicas). Roda no host do Swarm.
#
#   bash ops/kit-unidade/regra-traefik-joao.sh demo --so-conferir     # mostra a regra e o que mudaria
#   bash ops/kit-unidade/regra-traefik-joao.sh demo                    # acrescenta Host(`demo.doutordigitalconsultoria.com`)
#
# Idempotente: se o Host já está na regra, não mexe. Só ACRESCENTA (nunca tira nem troca um Host que já existe). O DNS curinga *.doutordigitalconsultoria.com
# já aponta para a VPS e o Traefik emite o certificado sozinho (letsencryptresolver). Regra de roteamento não é segredo: o script a imprime inteira.
#
# NÃO FOI RODADO por quem escreveu (não tinha acesso à VPS): a primeira execução é com --so-conferir.
set -euo pipefail

SUB="${1:-}"
[ -n "$SUB" ] || { echo "uso: regra-traefik-joao.sh <subdominio> [--so-conferir]"; exit 2; }
[[ "$SUB" =~ ^[a-z0-9]{3,40}$ ]] || { echo "subdomínio inválido (minúsculas e dígitos, 3 a 40): $SUB"; exit 2; }
SO_CONFERIR=0
[ "${2:-}" = "--so-conferir" ] && SO_CONFERIR=1
DOMINIO="${DOMINIO_DOS_CRMS:-doutordigitalconsultoria.com}"
SERVICO="${SERVICO_DO_PROXY:-chatwoot_franquias}"
HOST="$SUB.$DOMINIO"

docker service inspect "$SERVICO" >/dev/null 2>&1 || { echo "ERRO: serviço $SERVICO não existe neste Swarm."; exit 1; }
# a etiqueta da regra: traefik.http.routers.<nome>.rule
CHAVE="$(docker service inspect "$SERVICO" --format '{{range $k, $v := .Spec.Labels}}{{$k}}{{"\n"}}{{end}}' | grep -E '^traefik\.http\.routers\..+\.rule$' | head -1 || true)"
[ -n "$CHAVE" ] || { echo "ERRO: não achei a etiqueta traefik.http.routers.*.rule no serviço $SERVICO."; exit 1; }
ATUAL="$(docker service inspect "$SERVICO" --format "{{index .Spec.Labels \"$CHAVE\"}}")"
echo "regra atual ($CHAVE):"
echo "  $ATUAL"

if printf '%s' "$ATUAL" | grep -qF "Host(\`$HOST\`)"; then
  echo "OK: $HOST já está na regra. Nada a fazer."
  exit 0
fi
NOVA="$ATUAL || Host(\`$HOST\`)"
echo "regra nova:"
echo "  $NOVA"
if [ "$SO_CONFERIR" = "1" ]; then echo "SÓ CONFERIR: nada foi alterado."; exit 0; fi

docker service update --label-add "$CHAVE=$NOVA" "$SERVICO" >/dev/null
echo "PRONTO: $HOST acrescentado. O Traefik pega a regra em segundos e emite o certificado no primeiro acesso."
echo "CONFIRA: curl -sI https://$HOST/ | head -3"
