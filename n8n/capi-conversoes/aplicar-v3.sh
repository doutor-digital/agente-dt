#!/bin/bash
# PRODUÇÃO — aplica a v3 dos nós CAPI ("pediu horário" + Status com page_id + 1 LeadSubmitted por clique) em UM
# workflow "DD · CTWA → Meta CAPI · Conversões (<unidade>)" via API do n8n (recarrega sem reiniciar).
# Pensado para rodar na VPS de produção (89.116.214.130), ao lado do capi-aplicar-v2.sh, com esta pasta copiada.
#
# Uso:  aplicar-v3.sh --unidade Balsas [--seco] [--pediu desligado|seco|ligado] [--status desligado|seco|ligado]
#                     [--page-id 1234567890] [--tag "IA · Pediu horário"]
#   --unidade  obrigatório. Casa com o NOME do workflow, com maiúscula ("Balsas", não "balsas"). Uma por vez, de
#              propósito: ligar é uma unidade por vez, com ok do João.
#   --desfazer ARQ   volta o workflow ao export ARQ (o backup que este script guarda em backup-capi-v3-*/<id>.json).
#   --seco     NÃO grava nada: baixa o workflow, guarda o backup, monta os nós novos e mostra o que mudaria.
#   --pediu / --status  modo de cada recurso novo. Em branco = PRESERVA o que o workflow já tem (nasce 'desligado').
#              'seco' = decide e grava 'simulado' em capi_envios, SEM chamar a Meta. 'ligado' = manda de verdade.
#   Sem nenhuma flag de modo, a v3 é byte a byte a v2 no comportamento (só ganha a trava de 1 Lead por clique e o
#   reaproveitamento do clique pelo id do cartão).
#
# CUIDADO: depois da v3, NÃO rode o capi-aplicar-v2.sh nesta unidade — ele troca o "Classificar etapa" de volta para a
# v2 e o "pediu horário" some em silêncio. Para etapa nova no funil, rode a v2 e depois ESTE script de novo.
set -euo pipefail
SECO=0; UNID=""; PEDIU=""; STATUS=""; PAGE=""; TAG=""; DESFAZER=""
while [ $# -gt 0 ]; do case "$1" in
  --seco) SECO=1 ;; --unidade) UNID="$2"; shift ;; --pediu) PEDIU="$2"; shift ;; --status) STATUS="$2"; shift ;;
  --page-id) PAGE="$2"; shift ;; --tag) TAG="$2"; shift ;; --desfazer) DESFAZER="$2"; shift ;; *) echo "flag desconhecida: $1"; exit 1 ;; esac; shift; done
[ -z "$UNID" ] && { echo "faltou --unidade (uma por vez)"; exit 1; }
[[ "$UNID" =~ ^[[:alnum:]\ çãõáéíóúâêôÇÃÕÁÉÍÓÚÂÊÔ-]+$ ]] || { echo "nome de unidade com caractere estranho"; exit 1; }

AQUI="$(cd "$(dirname "$0")" && pwd)"
. "${N8N_API_ENV:-/root/.n8n-api.env}"                       # N8N_API_URL e N8N_API_KEY (600) — nunca impressos
H=${HOMOLOG:-/root/homolog}; BK=$H/backup-capi-v3-$(date +%F-%H%M); mkdir -p "$BK" $H/out
N8N=$(docker ps -q -f name=n8n_n8n_editor | head -1); PG=$(docker ps -q -f name=postgres_postgres | head -1)
# credenciais do banco do n8n lidas SEM eval (senha com $, espaço ou aspas não pode virar comando) e passadas ao docker sem ir na linha de comando
DBU=$(docker exec "$N8N" printenv DB_POSTGRESDB_USER); DBN=$(docker exec "$N8N" printenv DB_POSTGRESDB_DATABASE); export PGPASSWORD; PGPASSWORD=$(docker exec "$N8N" printenv DB_POSTGRESDB_PASSWORD)
QN(){ docker exec -e PGPASSWORD "$PG" psql -U "$DBU" -d "$DBN" -tA -F'|' -c "$1"; }
api(){ curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' "$@"; }

LINHAS=$(QN "SELECT id||'|'||name FROM workflow_entity WHERE name LIKE 'DD · CTWA → Meta CAPI%' AND active AND name LIKE '%($UNID)%'")
[ -z "$LINHAS" ] && { echo "nenhum workflow ativo com ($UNID) no nome"; exit 1; }
[ "$(echo "$LINHAS" | wc -l)" -ne 1 ] && { echo "mais de um workflow casa com ($UNID):"; echo "$LINHAS"; exit 1; }
IFS='|' read -r wid wname <<< "$LINHAS"
echo "== $wname ($wid)  backup em $BK"

if [ -n "$DESFAZER" ]; then
  # o arquivo tem de ser o export DESTE workflow: o PUT leva nome, nós e ligações do arquivo, e um backup de outra
  # unidade jogaria as conversões de uma no dataset da outra
  python3 - "$DESFAZER" "$wid" "$wname" "$BK/put.json" <<'PY' || { echo "   recusado: $DESFAZER não é o export deste workflow"; exit 1; }
import json,sys
arq,wid,wname,dest=sys.argv[1:5]
wf=json.load(open(arq))
if wf.get('id')!=wid or wf.get('name')!=wname: raise SystemExit(1)
OK={'saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'}
body={'name':wf['name'],'nodes':wf['nodes'],'connections':wf['connections'],'settings':{k:v for k,v in (wf.get('settings') or {}).items() if k in OK}}
if wf.get('staticData') is not None: body['staticData']=wf['staticData']
json.dump(body,open(dest,'w'),ensure_ascii=False)
PY
  [ "$SECO" = 1 ] && { echo "   --seco: o desfazer de $DESFAZER seria aceito; nada foi gravado"; exit 0; }
  code=$(api -o "$BK/resp-desfazer.json" -w '%{http_code}' -X PUT --data-binary @"$BK/put.json" "$N8N_API_URL/workflows/$wid")
  echo "   desfeito com $DESFAZER -> HTTP $code"; [ "$code" = 200 ] || { echo "   ERRO: o n8n não aceitou o desfazer — o workflow NÃO voltou"; exit 1; }; exit 0
fi

api -o "$BK/$wid.json" "$N8N_API_URL/workflows/$wid"
python3 -c "import json,sys; j=json.load(open('$BK/$wid.json')); assert j.get('nodes'), 'GET sem nodes'" || { echo "backup inválido — parei"; exit 1; }

docker exec "$N8N" mkdir -p /tmp/capi-v3
for f in aplicar-v3.mjs classificar-etapa.v3.js montar-evento.v3.js buscar-clique.v3.sql reservar-envio.v3.sql; do docker cp "$AQUI/$f" "$N8N:/tmp/capi-v3/$f" >/dev/null; done
docker cp "$BK/$wid.json" "$N8N:/tmp/capi-v3/wf.json" >/dev/null
docker exec -e WF_JSON=/tmp/capi-v3/wf.json -e OUT_JSON=/tmp/capi-v3/nodes.json -e DIR=/tmp/capi-v3 \
  -e PEDIU_MODO="$PEDIU" -e STATUS_MODO="$STATUS" -e PAGE_ID="$PAGE" -e TAG="$TAG" "$N8N" node /tmp/capi-v3/aplicar-v3.mjs < /dev/null
docker cp "$N8N:/tmp/capi-v3/nodes.json" "$BK/nodes-novos.json" >/dev/null

if [ "$SECO" = 1 ]; then
  python3 - "$BK/$wid.json" "$BK/nodes-novos.json" <<'PY'
import json,sys
a={n['name']:n for n in json.load(open(sys.argv[1]))['nodes']}; b={n['name']:n for n in json.load(open(sys.argv[2]))}
for k in b:
    if json.dumps(a.get(k,{}).get('parameters'),sort_keys=True)!=json.dumps(b[k]['parameters'],sort_keys=True): print('   muda:',k)
PY
  echo "   --seco: nada foi gravado. Backup em $BK/$wid.json"; exit 0
fi

python3 - "$BK/$wid.json" "$BK/nodes-novos.json" "$BK/put.json" <<'PY'
import json,sys
wf=json.load(open(sys.argv[1])); nodes=json.load(open(sys.argv[2]))
OK={'saveExecutionProgress','saveManualExecutions','saveDataErrorExecution','saveDataSuccessExecution','executionTimeout','errorWorkflow','timezone','executionOrder'}
body={'name':wf['name'],'nodes':nodes,'connections':wf['connections'],'settings':{k:v for k,v in (wf.get('settings') or {}).items() if k in OK}}
if wf.get('staticData') is not None: body['staticData']=wf['staticData']
json.dump(body,open(sys.argv[3],'w'),ensure_ascii=False)
PY
code=$(api -o "$BK/resp.json" -w '%{http_code}' -X PUT --data-binary @"$BK/put.json" "$N8N_API_URL/workflows/$wid")
ok=$(python3 -c "import json; j=json.load(open('$BK/resp.json')); c=next((n['parameters']['jsCode'] for n in j.get('nodes',[]) if n['name']=='Classificar etapa'),''); print('v3 gravado' if 'v3, cadeia com backfill' in c else 'v3 NAO encontrado: '+str(j)[:200])" 2>/dev/null || echo "resposta do n8n ilegível (HTTP $code)")
echo "   PUT -> HTTP $code · $ok"
[ "$code" = 200 ] && [ "$ok" = "v3 gravado" ] || { echo "   ERRO: a v3 NÃO foi aplicada (workflow segue como estava). Backup: $BK/$wid.json"; exit 1; }
echo "   desfazer: $0 --unidade \"$UNID\" --desfazer $BK/$wid.json"
