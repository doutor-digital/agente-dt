#!/usr/bin/env bash
# LEVA OS «MODELOS GERAIS» DO KOMMO DE UMA UNIDADE PARA AS RESPOSTAS PRONTAS DO CRM DELA. Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho).
#
#   bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug>                  # PADRÃO = só conferir: LÊ o Kommo e o CRM e mostra o plano. Não escreve nada.
#   bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug> --so-conferir    # o mesmo, explícito
#   bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug> --aplicar        # cria no CRM os que faltam (casa pelo atalho: não duplica, não sobrescreve)
#
# Só escreve na conta PRÓPRIA da unidade no CRM (nunca na conta 1). Os modelos do WhatsApp (da Meta) NÃO entram aqui: o Chatwoot os sincroniza da WABA sozinho.
# Pré-requisito: o contêiner do agente já ter o deploy do PR (o script recusa, dizendo o motivo, se não tiver).
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
SLUG=""
for a in "$@"; do
  case "$a" in
    --so-conferir|--aplicar) ;;
    -*) echo "argumento desconhecido: $a (use --so-conferir ou --aplicar)"; exit 2 ;;
    *) [[ "$a" =~ ^[a-z0-9][a-z0-9-]{1,60}$ ]] || { echo "slug inválido: $a"; exit 2; }; [ -z "$SLUG" ] || { echo "mais de um slug"; exit 2; }; SLUG="$a" ;;
  esac
done
[ -n "$SLUG" ] || { echo "uso: bash ops/kit-unidade/importar-modelos-kommo-joao.sh <slug> [--so-conferir | --aplicar]"; exit 2; }

# cada argumento vai entre aspas para a VPS (nada é interpretado lá): %q do bash
ARGS=""
for a in "$@"; do ARGS+=" $(printf '%q' "$a")"; done

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo); tudo vai como COMANDO do ssh, nunca como script no stdin
REMOTO="A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2); [ -n \"\$A\" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }; docker exec \$A test -f /repo/backend/dist/scripts/importar-modelos-kommo.js || { echo 'ERRO: o contêiner ainda não tem o script (backend/dist/scripts/importar-modelos-kommo.js): publique o deploy do PR antes.'; exit 1; }; docker exec -w /repo/backend \$A node dist/scripts/importar-modelos-kommo.js$ARGS"
exec ssh -i "$CHAVE" -o ConnectTimeout=15 "$VPS" "$REMOTO"
