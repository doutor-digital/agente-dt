#!/usr/bin/env bash
# CRIA O «PLATFORM APP» DO CHATWOOT (uma vez) — o token que deixa o kit criar contas e usuários. Roda na VPS, no host do Swarm, como você
# (sem sudo, sem colar nada). O token vai DIRETO para um arquivo modo 600 e NUNCA é impresso nem passa por /tmp.
#
#   chmod +x ops/kit-unidade/criar-platform-app-joao.sh
#   bash ops/kit-unidade/criar-platform-app-joao.sh                 # cria (ou confere) o Platform App
#   bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir   # só diz o que existe, não cria nada
#
# Idempotente: se o arquivo do token já existe e o Chatwoot o aceita, não faz nada. Se existe e o Chatwoot RECUSA, para e pede decisão (não cria outro
# por cima sozinho). Variáveis opcionais: CHATWOOT_URL (padrão https://atendimento.doutordigitalconsultoria.com), ARQUIVO_DO_TOKEN
# (padrão /root/segredos/chatwoot-platform.token), NOME_DO_APP (padrão «Kit de unidade»).
#
# NÃO FOI RODADO por quem escreveu (não tinha acesso à VPS): a primeira execução é com --so-conferir.
set -euo pipefail
umask 077

URL="${CHATWOOT_URL:-https://atendimento.doutordigitalconsultoria.com}"
ARQUIVO="${ARQUIVO_DO_TOKEN:-/root/segredos/chatwoot-platform.token}"
NOME="${NOME_DO_APP:-Kit de unidade}"
SO_CONFERIR=0
[ "${1:-}" = "--so-conferir" ] && SO_CONFERIR=1

# O contêiner MAIS NOVO do chatwoot_rails (no rolling update `head -1` pegaria o antigo)
container() { docker ps --filter "name=chatwoot_rails" --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2; }

# O Chatwoot aceita este token? (a plataforma responde 404 para conta que não existe e 401 para token ruim)
aceita() {
  local codigo
  codigo="$(curl -s -o /dev/null -w '%{http_code}' -H "api_access_token: $(cat "$ARQUIVO")" "$URL/platform/api/v1/accounts/0" || true)"
  [ "$codigo" = "404" ] || [ "$codigo" = "200" ]
}

if [ -s "$ARQUIVO" ]; then
  if aceita; then
    echo "OK: o Platform App já existe e o Chatwoot aceita o token em $ARQUIVO. Nada a fazer."
    exit 0
  fi
  echo "ATENÇÃO: $ARQUIVO existe mas o Chatwoot RECUSA o token. Não vou criar outro por cima sozinho."
  echo "Confira no Super Admin do Chatwoot (Platform Apps) e apague o arquivo à mão se for o caso."
  exit 1
fi

C="$(container)"
if [ -z "$C" ]; then
  echo "ERRO: não achei o contêiner chatwoot_rails neste host (docker ps). Rode no host do Swarm onde o Chatwoot está."
  exit 1
fi
if [ "$SO_CONFERIR" = "1" ]; then
  echo "SÓ CONFERIR: não há token em $ARQUIVO; o contêiner do Chatwoot é $C. Rodando sem --so-conferir, crio o Platform App «$NOME» e gravo o token no arquivo (modo 600, sem imprimir)."
  exit 0
fi

mkdir -p "$(dirname "$ARQUIVO")"
# o token sai do rails direto para o arquivo — nunca para a tela. (sem -t: a saída é só o token).
# a linha com o token leva o marcador TOKEN: (o rails pode imprimir avisos antes); só ela vai para o arquivo
docker exec "$C" bundle exec rails runner "app = PlatformApp.find_or_create_by!(name: '${NOME//\'/}'); puts 'TOKEN:' + app.access_token.token" | sed -n 's/^TOKEN://p' | tail -n1 > "$ARQUIVO"
chmod 600 "$ARQUIVO"
if [ ! -s "$ARQUIVO" ]; then rm -f "$ARQUIVO"; echo "ERRO: o rails não devolveu token."; exit 1; fi
if aceita; then
  echo "PRONTO: Platform App «$NOME» criado; token em $ARQUIVO (modo 600, não impresso)."
  echo "PRÓXIMO: bash ops/kit-unidade/unidades/clinica-demonstracao-joao.sh   (ele lê este arquivo)"
else
  echo "ERRO: criei o app mas o Chatwoot não aceitou o token. Confira o Super Admin (Platform Apps)."; exit 1
fi
