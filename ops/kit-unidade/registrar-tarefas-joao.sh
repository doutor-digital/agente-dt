#!/usr/bin/env bash
# REGISTRA A ABA «TAREFAS» (Dashboard App, dentro da conversa) em TODAS as contas do CRM que já existem. Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho).
#
#   bash ops/kit-unidade/registrar-tarefas-joao.sh --so-conferir   # PRIMEIRO: diz, conta por conta, se a aba existe. Não escreve nada.
#   bash ops/kit-unidade/registrar-tarefas-joao.sh                 # cria a que falta (as contas que já têm ficam como estão; roda duas vezes sem duplicar)
#
# As contas NOVAS já nascem com a aba pelo kit (abrir-clinica-joao.sh). O item «Tarefas» do menu da esquerda não precisa disto: vem do menu.js.
# Pré-requisito: o contêiner do agente já ter o deploy deste PR (o script recusa, dizendo o motivo, se não tiver).
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
for a in "$@"; do
  case "$a" in
    --so-conferir) ;;
    *) echo "argumento desconhecido: $a (use só --so-conferir)"; exit 2 ;;
  esac
done

# cada argumento vai entre aspas para a VPS (nada é interpretado lá): %q do bash
ARGS=""
for a in "$@"; do ARGS+=" $(printf '%q' "$a")"; done

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo); tudo vai como COMANDO do ssh, nunca como script no stdin
REMOTO="A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2); [ -n \"\$A\" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }; docker exec \$A test -f /repo/backend/dist/scripts/registrar-tarefas.js || { echo 'ERRO: o contêiner ainda não tem o script (backend/dist/scripts/registrar-tarefas.js): publique o deploy do PR antes.'; exit 1; }; docker exec -w /repo/backend \$A node dist/scripts/registrar-tarefas.js$ARGS"
exec ssh -i "$CHAVE" -o ConnectTimeout=15 "$VPS" "$REMOTO"
