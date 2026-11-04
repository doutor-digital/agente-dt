#!/usr/bin/env bash
# Importa o workflow "DD · Alertas grupo (simples)" no n8n de PRODUÇÃO, DESATIVADO. Não ativa, não mexe em mais nada.
#
# Rode NA VPS de produção (89.116.214.130, host "portainer"), como root, sem sudo:
#   scp n8n/alertas-grupo-simples/{workflow.json,importar.sh} root@89.116.214.130:/root/
#   ssh root@89.116.214.130 'chmod +x /root/importar.sh && bash /root/importar.sh'
#
# Idempotente: se o workflow já existe (mesmo nome) e está INATIVO, atualiza; se estiver ATIVO, recusa (não mexo em fluxo no ar).
# Segredos (chave da Evolution, segredo do webhook) nunca vão por argumento: a chave é lida do contêiner da Evolution,
# o segredo é gerado aqui e guardado em /root/.alerta-grupo.env (chmod 600).
set -euo pipefail
cd "$(dirname "$0")"
NOME='DD · Alertas grupo (simples)'
[ -f workflow.json ] || { echo "falta workflow.json ao lado deste script" >&2; exit 1; }
[ -f /root/.n8n-api.env ] || { echo "falta /root/.n8n-api.env (esta é a VPS de produção?)" >&2; exit 1; }
set -a; . /root/.n8n-api.env; set +a
: "${N8N_API_URL:?}" "${N8N_API_KEY:?}"

# chave da Evolution: do contêiner (sem -i, sem stdin: não engole o resto do script)
EVO_CID=$(docker ps -q --filter name=evolution_api --filter status=running | head -1)
[ -n "$EVO_CID" ] || { echo "contêiner evolution_api não encontrado" >&2; exit 1; }
EVO_KEY=$(docker exec "$EVO_CID" printenv AUTHENTICATION_API_KEY </dev/null | tr -d '\r\n')
[ "${#EVO_KEY}" -ge 16 ] || { echo "chave da Evolution vazia/curta" >&2; exit 1; }

# segredo do webhook: reaproveita se já existe (a URL no Kommo continua valendo)
if [ -s /root/.alerta-grupo.env ]; then . /root/.alerta-grupo.env; fi
if [ -z "${ALERTA_GRUPO_SEGREDO:-}" ]; then
  ALERTA_GRUPO_SEGREDO=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  umask 077; printf 'ALERTA_GRUPO_SEGREDO=%s\n' "$ALERTA_GRUPO_SEGREDO" > /root/.alerta-grupo.env; chmod 600 /root/.alerta-grupo.env
fi

TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
EVO_KEY="$EVO_KEY" SEG="$ALERTA_GRUPO_SEGREDO" python3 - workflow.json "$TMP" <<'PY'
import json, os, sys
w = json.load(open(sys.argv[1]))
def sub(o):
    if isinstance(o, str):
        return o.replace('__EVOLUTION_APIKEY__', os.environ['EVO_KEY']).replace('__SEGREDO_WEBHOOK__', os.environ['SEG'])
    if isinstance(o, list): return [sub(x) for x in o]
    if isinstance(o, dict): return {k: sub(v) for k, v in o.items()}
    return o
w = sub(w)
body = {k: w[k] for k in ('name', 'nodes', 'connections', 'settings')}
json.dump(body, open(sys.argv[2], 'w'), ensure_ascii=False)
PY

api() { curl -sS -m 30 -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' "$@"; }
EXISTE=$(api "$N8N_API_URL/workflows?limit=250" | python3 -c "
import json,sys
nome=sys.argv[1]
d=json.load(sys.stdin).get('data',[])
m=[w for w in d if w['name']==nome]
print(m[0]['id']+' '+str(m[0].get('active')) if m else '')" "$NOME")

if [ -z "$EXISTE" ]; then
  ID=$(api -X POST "$N8N_API_URL/workflows" --data-binary @"$TMP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  echo "criado: $ID (DESATIVADO)"
else
  ID=${EXISTE% *}; ATIVO=${EXISTE#* }
  if [ "$ATIVO" = "True" ]; then echo "workflow $ID já está ATIVO — não mexo. Desative no n8n e rode de novo." >&2; exit 2; fi
  api -X PUT "$N8N_API_URL/workflows/$ID" --data-binary @"$TMP" >/dev/null
  echo "atualizado: $ID (continua DESATIVADO)"
fi

# prova: lê de volta e confere que está inativo e sem placeholder
api "$N8N_API_URL/workflows/$ID" | python3 -c "
import json,sys
w=json.load(sys.stdin); s=json.dumps(w)
print('id      :', w['id']); print('ativo   :', w['active']); print('nós     :', len(w['nodes']))
print('placeholders restantes:', s.count('__EVOLUTION_APIKEY__')+s.count('__SEGREDO_WEBHOOK__'))
assert w['active'] is False"
echo
echo "URL do webhook para o Kommo (quando for ligar): https://webhook-n8n.doutordigitalconsultoria.com/webhook/alerta-grupo?k=$ALERTA_GRUPO_SEGREDO"
echo "(o segredo fica em /root/.alerta-grupo.env; não cole em chat)"
