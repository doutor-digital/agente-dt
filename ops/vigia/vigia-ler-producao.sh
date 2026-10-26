#!/usr/bin/env bash
# PORTA DE LEITURA DA PRODUÇÃO — a única que o auditor tem.
#
# O auditor é um agente: a regra "nunca aplique nada" tem que estar no código, não só no texto do
# prompt. Este script é a ÚNICA entrada de produção liberada para ele na lista de ferramentas, e aqui
# dentro só existem verbos de leitura. Qualquer outra coisa é recusada e registrada.
#
# Uso:
#   vigia-ler-producao.sh sql "select ..."        consulta no banco do agente (só SELECT/WITH)
#   vigia-ler-producao.sh logs <servico> <min>    log de serviço do Swarm (só leitura)
#   vigia-ler-producao.sh inspect <servico>       quando o container subiu e qual sha da imagem
#   vigia-ler-producao.sh automacoes <slug>       estado das chaves da unidade (tela × .env)
#   vigia-ler-producao.sh medir <slug> <rotulo>   roda o medidor do vigia de novo, agora
#   vigia-ler-producao.sh env <CHAVE>            valor de uma chave de comportamento (nunca credencial)
set -uo pipefail
VPS="${VIGIA_VPS:-root@89.116.214.130}"
RAIZ="${VIGIA_RAIZ_VPS:-/root/vigia-petropolis}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$VPS")

recusa() { echo "RECUSADO: $1" >&2; exit 2; }
[ $# -ge 1 ] || recusa "sem verbo"
verbo="$1"; shift

case "$verbo" in
  sql)
    sql="${1:-}"
    # Só leitura: tem que começar em SELECT/WITH e não pode trazer um segundo comando.
    printf '%s' "$sql" | grep -qiE '^[[:space:]]*(select|with)[[:space:]]' || recusa "só SELECT/WITH"
    printf '%s' "$sql" | grep -qiE '\b(insert|update|delete|drop|alter|create|truncate|grant|copy|vacuum)\b' && recusa "verbo de escrita no SQL"
    printf '%s' "$sql" | grep -q ';.*[^[:space:]]' && recusa "mais de um comando"
    # a consulta vai codificada: aspas e acento dentro do SQL não quebram o comando remoto
    b64=$(printf '%s' "$sql" | base64 -w0)
    "${SSH[@]}" "CID=\$(docker ps --filter name=ddagentdb_db --format '{{.ID}}'|head -1); echo $b64 | base64 -d | docker exec -i \"\$CID\" psql -U agente -d agente_dt -A -F'|' -v ON_ERROR_STOP=1 -f -"
    ;;
  logs)
    serv="${1:-ddagent_agent}"; min="${2:-30}"
    [[ "$serv" =~ ^[a-z0-9_-]+$ && "$min" =~ ^[0-9]+$ ]] || recusa "serviço ou janela inválidos"
    "${SSH[@]}" "docker service logs --since ${min}m --raw --tail 2000 $serv"
    ;;
  inspect)
    serv="${1:-ddagent_agent}"
    [[ "$serv" =~ ^[a-z0-9_-]+$ ]] || recusa "serviço inválido"
    "${SSH[@]}" "CID=\$(docker ps --filter name=$serv --format '{{.ID}}'|head -1); docker inspect -f '{{.Created}} {{.Config.Image}}' \"\$CID\""
    ;;
  automacoes)
    slug="${1:-doutor-hernia-petropolis}"
    [[ "$slug" =~ ^[a-z0-9-]+$ ]] || recusa "slug inválido"
    "${SSH[@]}" "CID=\$(docker ps --filter name=ddagentdb_db --format '{{.ID}}'|head -1); docker exec -i \"\$CID\" psql -U agente -d agente_dt -A -F'|' -c \"select a.automacao, a.estado, a.atualizado_em from unit_automacoes a join units u on u.id=a.unit_id where u.slug='$slug' order by 1\""
    ;;
  env)
    # O auditor precisa ver PORTÃO de configuração (ex.: FRANQUIA_REVISAO_SECO) — sem isso ele
    # conclui por eliminação e erra, o que já aconteceu na primeira prova (26/10). Só chaves de
    # comportamento: qualquer nome que cheire a credencial é recusado, e nada de `env` inteiro.
    chave="${1:-}"
    [[ "$chave" =~ ^[A-Z][A-Z0-9_]{2,40}$ ]] || recusa "nome de chave inválido"
    printf '%s' "$chave" | grep -qiE 'TOKEN|SECRET|KEY|PASS|SENHA|CRED|DSN|URL|WEBHOOK|DATABASE' && recusa "essa chave pode ser credencial — não passa por aqui"
    printf '%s' "$chave" | grep -qE '_(SECO|SLUGS|LIGADO_SLUGS|MODO|LIMITE|TETO|ENABLED|OFF|ON)$|^(NODE_ENV|LOG_LEVEL|TZ)$' || recusa "só chaves de comportamento (*_SECO, *_SLUGS, *_TETO, NODE_ENV, LOG_LEVEL, TZ)"
    "${SSH[@]}" "CID=\$(docker ps --filter name=ddagent_agent --format '{{.ID}}'|head -1); docker exec -i \"\$CID\" printenv $chave || echo '(não definida)'"
    ;;
  medir)
    slug="${1:-doutor-hernia-petropolis}"; rotulo="${2:-Petrópolis}"
    [[ "$slug" =~ ^[a-z0-9-]+$ ]] || recusa "slug inválido"
    "${SSH[@]}" "CID=\$(docker ps --filter name=ddagent_agent --format '{{.ID}}'|head -1); docker exec -i -w /repo/backend -e LOG_LEVEL=fatal -e VIGIA_SLUG=$slug -e VIGIA_ROTULO_UNIDADE='$rotulo' -e VIGIA_PROFUNDO=1 -e VIGIA_TETO_LEITURAS=60 \"\$CID\" node --input-type=module - < $RAIZ/medir-unidade.mjs"
    ;;
  *)
    recusa "verbo '$verbo' não existe nesta porta (só sql, logs, inspect, automacoes, medir)"
    ;;
esac
