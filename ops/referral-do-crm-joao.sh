#!/usr/bin/env bash
# RECUPERA O ANÚNCIO das conversas do CRM que ficaram sem etiqueta `anuncio`, sem a nota «Veio do anúncio» e sem Origem (Chatwoot trouxe o
# referral e o servidor ignorou, 14–17/11/2026). Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho). Não imprime nome nem telefone, nem segredo.
#
#   bash ops/referral-do-crm-joao.sh --so-conferir     # 1º: só lista (conversa, data, id do anúncio, o que falta) — não grava nada
#   bash ops/referral-do-crm-joao.sh                   # depois: guarda + etiqueta + nota + origem das que faltam
#   opções: --desde=AAAA-MM-DD (padrão 2026-11-13, a véspera do bug)  --caixa=3
#
# Pré-requisito: o deploy do PR que corrige o referral já ter subido (o script recusa, dizendo o motivo, se o contêiner não tiver o arquivo).
# Repetir é seguro: conversa já guardada é reaplicada (etiqueta + origem, que só preenchem o que falta), sem nota nova — rodar de novo conserta o que falhou. Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }

# só as opções conhecidas, no formato certo (nada é interpretado na VPS)
ARGS=""
for a in "$@"; do
  if [[ "$a" == "--so-conferir" || "$a" =~ ^--caixa=[0-9]+$ || "$a" =~ ^--desde=[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    ARGS+=" $(printf '%q' "$a")"
  else
    echo "opção inválida: $a (use --so-conferir, --caixa=N, --desde=AAAA-MM-DD)"; exit 2
  fi
done

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo); tudo vai como COMANDO do ssh, nunca como script no stdin
REMOTO="A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2); [ -n \"\$A\" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }; docker exec \$A test -f /repo/backend/dist/scripts/referral-do-crm-retroativo.js || { echo 'ERRO: o contêiner ainda não tem o script (backend/dist/scripts/referral-do-crm-retroativo.js): publique o deploy do PR antes.'; exit 1; }; docker exec -w /repo/backend \$A node dist/scripts/referral-do-crm-retroativo.js$ARGS"
exec ssh -i "$CHAVE" -o ConnectTimeout=15 "$VPS" "$REMOTO"
