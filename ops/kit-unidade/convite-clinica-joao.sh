#!/usr/bin/env bash
# CRIA (ou lista, ou encerra) O LINK DO FORMULÁRIO que o franqueado preenche sozinho. Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho; não precisa estar na VPS).
#
#   bash ops/kit-unidade/convite-clinica-joao.sh --rotulo "Dra. Fulana (Serra)"          # cria e mostra o link UMA vez (uso único, vale 14 dias)
#   bash ops/kit-unidade/convite-clinica-joao.sh --rotulo "..." --dias 7 --por suzanne.mychelly1@gmail.com
#   bash ops/kit-unidade/convite-clinica-joao.sh --listar                                # convites e se já foram preenchidos (sem os códigos)
#   bash ops/kit-unidade/convite-clinica-joao.sh --revogar <id>                          # encerra um convite que ainda não foi usado (não apaga)
#
# O link é o segredo: mande só para a pessoa, direto no WhatsApp dela. Não cole em grupo nem no chat do Claude. O banco guarda só o hash: o link não dá para reimprimir.
# Pré-requisito: o contêiner do agente já ter o formulário publicado (o script recusa, dizendo o motivo, se não tiver).
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
[ $# -gt 0 ] || { echo 'uso: bash ops/kit-unidade/convite-clinica-joao.sh --rotulo "para quem é" [--dias 14] [--por email]  |  --listar  |  --revogar <id>'; exit 2; }
[ -t 0 ] && [ -t 1 ] || { echo "RECUSO: rode num terminal de verdade (o link aparece na tela uma vez só)."; exit 1; }

# cada argumento vai entre aspas para a VPS (nada é interpretado lá): %q do bash
ARGS=""
for a in "$@"; do ARGS+=" $(printf '%q' "$a")"; done

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo); tudo vai como COMANDO do ssh, nunca como script no stdin
REMOTO="A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2); [ -n \"\$A\" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }; docker exec \$A test -f /repo/backend/dist/scripts/convite-nova-clinica.js || { echo 'ERRO: o contêiner ainda não tem o formulário (backend/dist/scripts/convite-nova-clinica.js): publique o deploy do PR antes.'; exit 1; }; docker exec -it -w /repo/backend \$A node dist/scripts/convite-nova-clinica.js$ARGS"
exec ssh -t -i "$CHAVE" -o ConnectTimeout=15 "$VPS" "$REMOTO"
