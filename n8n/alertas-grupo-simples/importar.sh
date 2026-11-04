#!/usr/bin/env bash
# Importa o workflow "DD · Alertas grupo (simples)" no n8n de PRODUÇÃO, DESATIVADO. Não ativa, não mexe em mais nada.
#
# Rode NA VPS de produção (89.116.214.130, host "portainer"), como root, sem sudo:
#   scp n8n/alertas-grupo-simples/{workflow.json,importar.sh} root@89.116.214.130:/root/
#   ssh root@89.116.214.130 'chmod +x /root/importar.sh && bash /root/importar.sh'
#
# Idempotente: se o workflow já existe (mesmo nome) e está INATIVO, atualiza; se estiver ATIVO, recusa (não mexo em fluxo no ar).
# Segredos nunca vão por argumento nem para o repositório:
#  - a chave da Evolution vira uma CREDENCIAL do n8n (Header Auth "apikey"), criada uma vez; o id fica em /root/.alerta-grupo.env.
#    Por padrão é lida do contêiner da Evolution (chave MESTRA: controla todas as instâncias). Quando a instância alertas3 existir,
#    prefira o token DA INSTÂNCIA: grave-o num arquivo chmod 600 e rode com EVOLUTION_APIKEY_ARQUIVO=/caminho antes de criar a credencial.
#  - o segredo do webhook é gerado aqui e guardado em /root/.alerta-grupo.env (chmod 600).
set -euo pipefail
cd "$(dirname "$0")"
NOME='DD · Alertas grupo (simples)'
NOME_CRED='DD · Evolution (apikey) · alertas grupo'
BASE="${URL_BASE_WEBHOOK:-https://webhook-n8n.doutordigitalconsultoria.com}"
[ -f workflow.json ] || { echo "falta workflow.json ao lado deste script" >&2; exit 1; }
[ -f /root/.n8n-api.env ] || { echo "falta /root/.n8n-api.env (esta é a VPS de produção?)" >&2; exit 1; }
set -a; . /root/.n8n-api.env; set +a
: "${N8N_API_URL:?}" "${N8N_API_KEY:?}"

umask 077
ENV_FILE=/root/.alerta-grupo.env
ALERTA_GRUPO_SEGREDO=''; ALERTA_GRUPO_CRED_ID=''
[ -s "$ENV_FILE" ] && . "$ENV_FILE"
if [ -z "$ALERTA_GRUPO_SEGREDO" ]; then
  ALERTA_GRUPO_SEGREDO=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi
gravar_env() { printf 'ALERTA_GRUPO_SEGREDO=%s\nALERTA_GRUPO_CRED_ID=%s\n' "$ALERTA_GRUPO_SEGREDO" "$ALERTA_GRUPO_CRED_ID" > "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
gravar_env

TMP=$(mktemp); TMP2=$(mktemp); chmod 600 "$TMP" "$TMP2"; trap 'rm -f "$TMP" "$TMP2"' EXIT
api() { curl -sS -f -m 30 -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' "$@"; }

# ---- credencial da Evolution (uma vez) ----
if [ -z "$ALERTA_GRUPO_CRED_ID" ]; then
  if [ -n "${EVOLUTION_APIKEY_ARQUIVO:-}" ]; then
    EVO_KEY=$(tr -d '\r\n' < "$EVOLUTION_APIKEY_ARQUIVO"); ORIGEM="token da instância ($EVOLUTION_APIKEY_ARQUIVO)"
  else
    EVO_CID=$(docker ps -q --filter name=evolution_api --filter status=running | head -1)
    [ -n "$EVO_CID" ] || { echo "contêiner evolution_api não encontrado" >&2; exit 1; }
    EVO_KEY=$(docker exec "$EVO_CID" printenv AUTHENTICATION_API_KEY </dev/null | tr -d '\r\n'); ORIGEM="chave MESTRA da Evolution (troque pelo token da alertas3 quando ela existir)"
  fi
  [ "${#EVO_KEY}" -ge 16 ] || { echo "chave da Evolution vazia/curta" >&2; exit 1; }
  EVO_KEY="$EVO_KEY" NOME_CRED="$NOME_CRED" python3 - "$TMP2" <<'PY'
import json, os, sys
json.dump({'name': os.environ['NOME_CRED'], 'type': 'httpHeaderAuth', 'data': {'name': 'apikey', 'value': os.environ['EVO_KEY']}}, open(sys.argv[1], 'w'))
PY
  ALERTA_GRUPO_CRED_ID=$(api -X POST "$N8N_API_URL/credentials" --data-binary @"$TMP2" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  : > "$TMP2"; unset EVO_KEY
  gravar_env
  echo "credencial criada: $ALERTA_GRUPO_CRED_ID — $ORIGEM"
else
  echo "credencial já existe: $ALERTA_GRUPO_CRED_ID (para trocar a chave: apague-a no n8n e a linha ALERTA_GRUPO_CRED_ID de $ENV_FILE)"
fi

# ---- workflow ----
SEG="$ALERTA_GRUPO_SEGREDO" CRED="$ALERTA_GRUPO_CRED_ID" URLENVIO="$BASE/webhook/alerta-grupo-envio?k=$ALERTA_GRUPO_SEGREDO" python3 - workflow.json "$TMP" <<'PY'
import json, os, sys
w = json.load(open(sys.argv[1]))
troca = {'__SEGREDO_WEBHOOK__': os.environ['SEG'], '__URL_ENVIO__': os.environ['URLENVIO'], '__CRED_EVOLUTION_ID__': os.environ['CRED']}
def sub(o):
    if isinstance(o, str):
        for k, v in troca.items(): o = o.replace(k, v)
        return o
    if isinstance(o, list): return [sub(x) for x in o]
    if isinstance(o, dict): return {k: sub(v) for k, v in o.items()}
    return o
w = sub(w)
json.dump({k: w[k] for k in ('name', 'nodes', 'connections', 'settings')}, open(sys.argv[2], 'w'), ensure_ascii=False)
PY

EXISTE=$(api "$N8N_API_URL/workflows?limit=250" | python3 -c "
import json,sys
nome=sys.argv[1]
m=[w for w in json.load(sys.stdin).get('data',[]) if w['name']==nome]
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

# prova: lê de volta; inativo, sem placeholder e SEM a chave da Evolution em nenhum nó
api "$N8N_API_URL/workflows/$ID" | python3 -c "
import json,sys
w=json.load(sys.stdin); s=json.dumps(w)
print('id      :', w['id']); print('ativo   :', w['active']); print('nós     :', len(w['nodes']))
print('placeholders restantes:', s.count('__EVOLUTION')+s.count('__SEGREDO')+s.count('__URL_ENVIO')+s.count('__CRED'))
print('nó Evolution usa credencial:', [n.get('credentials') for n in w['nodes'] if n['name']=='Evolution sendText'][0] is not None)
assert w['active'] is False"
echo
echo "URL do webhook para o Kommo (quando for ligar): $BASE/webhook/alerta-grupo?k=$ALERTA_GRUPO_SEGREDO"
echo "(o segredo fica em $ENV_FILE; não cole em chat)"
