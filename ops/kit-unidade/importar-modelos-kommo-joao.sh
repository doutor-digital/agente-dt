#!/usr/bin/env bash
# LEVA OS «MODELOS GERAIS» DO KOMMO DE UMA UNIDADE PARA AS RESPOSTAS PRONTAS DO CRM DELA. Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho).
#
#   bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug>                  # PADRÃO = só conferir: LÊ o Kommo e o CRM e mostra o plano. Não escreve nada.
#   bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug> --so-conferir    # o mesmo, explícito
#   bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug> --aplicar        # cria no CRM os que faltam (casa pelo atalho: não duplica, não sobrescreve)
#   bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug> --arquivo <backup.json> [--so-conferir | --aplicar]
#        # os modelos vêm de um BACKUP em JSON (ex.: as 18 respostas apagadas do Kommo de Timbó em 27/10), NÃO da API do Kommo. Mesmas regras.
#        # O arquivo vai por ssh na ENTRADA do comando (stdin do `node` no contêiner): NÃO passa pelo GitHub, NÃO é gravado em /tmp nem em nenhum lugar da
#        # VPS (então não há o que apagar depois). Exige modo 600 no seu computador (chmod 600 arquivo): recusa se outro usuário puder ler.
#
# Só escreve na conta PRÓPRIA da unidade no CRM (nunca na conta 1). `--aplicar` RECUSA unidade sem token PRÓPRIO do CRM (cairia no token global); conferir pode. Os modelos do WhatsApp (da Meta) NÃO entram aqui: o Chatwoot os sincroniza da WABA sozinho.
# Pré-requisito: o contêiner do agente já ter o deploy do PR (o script recusa, dizendo o motivo, se não tiver).
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
SLUG=""; ARQ=""; MODO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --so-conferir|--aplicar) [ -z "$MODO" ] || [ "$MODO" = "$1" ] || { echo "--so-conferir e --aplicar juntos: escolha um"; exit 2; }; MODO="$1" ;;
    --arquivo) shift; ARQ="${1:-}"; [ -n "$ARQ" ] || { echo "--arquivo precisa do caminho do JSON"; exit 2; } ;;
    -*) echo "argumento desconhecido: $1 (use --so-conferir, --aplicar ou --arquivo <json>)"; exit 2 ;;
    *) [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,60}$ ]] || { echo "slug inválido: $1"; exit 2; }; [ -z "$SLUG" ] || { echo "mais de um slug"; exit 2; }; SLUG="$1" ;;
  esac
  shift
done
[ -n "$SLUG" ] || { echo "uso: bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug> [--so-conferir | --aplicar] [--arquivo <backup.json>]"; exit 2; }

ARGS=" $(printf '%q' "$SLUG")"
[ -z "$MODO" ] || ARGS+=" $MODO"
ENTRADA=/dev/null
if [ -n "$ARQ" ]; then
  [ -f "$ARQ" ] && [ -r "$ARQ" ] || { echo "RECUSO: não achei o arquivo $ARQ"; exit 1; }
  PERM="$(stat -c '%a' "$ARQ")"
  [[ "$PERM" =~ ^[0-7]?[0-7]00$ ]] || { echo "RECUSO: $ARQ está com modo $PERM; outro usuário poderia ler. Rode: chmod 600 \"$ARQ\""; exit 1; }
  [ "$(stat -c '%s' "$ARQ")" -le 1000000 ] || { echo "RECUSO: $ARQ tem mais de 1.000.000 bytes (não é um backup de modelos)"; exit 1; }
  ENTRADA="$ARQ"
  ARGS+=" --arquivo -"
fi

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo); tudo vai como COMANDO do ssh, nunca como script no stdin
DOCKER_I=""; [ -z "$ARQ" ] || DOCKER_I="-i"
REMOTO="DOCKER_I='$DOCKER_I'; A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2); [ -n \"\$A\" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }; docker exec \$A test -f /repo/backend/dist/scripts/importar-modelos-kommo.js || { echo 'ERRO: o contêiner ainda não tem o script (backend/dist/scripts/importar-modelos-kommo.js): publique o deploy do PR antes.'; exit 1; }; docker exec \$DOCKER_I -w /repo/backend \$A node dist/scripts/importar-modelos-kommo.js$ARGS"
exec ssh -i "$CHAVE" -o ConnectTimeout=15 "$VPS" "$REMOTO" < "$ENTRADA"
