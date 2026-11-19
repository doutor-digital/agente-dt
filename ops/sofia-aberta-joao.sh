#!/usr/bin/env bash
# ACERTA o que já está em «Pendentes» no CRM (caixa do WhatsApp oficial): abre as conversas e põe a etiqueta roxa `sofia-atendendo` nas que a
# Sofia ainda atende (atividade nas últimas 24 h, sem pausa/humano/interno). NÃO manda mensagem a ninguém: só status e etiqueta.
# Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho). Não imprime nome nem telefone, nem segredo.
#
#   bash ops/sofia-aberta-joao.sh --so-conferir     # 1º: só lista (conversa → o que faria) — não grava nada
#   bash ops/sofia-aberta-joao.sh                   # depois: abre + etiqueta
#   opções: --caixa=3  --etiquetar-horas=24
#
# ATENÇÃO: conversa aberta entra no rodízio da caixa — quem estiver online recebe as que abrirem (e é avisada). Por isso o --so-conferir primeiro.
# Pré-requisito: o deploy do PR «Sofia atendendo» já ter subido (o script recusa, dizendo o motivo, se o contêiner não tiver o arquivo).
# Repetir é seguro. Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }

# só as opções conhecidas, no formato certo (nada é interpretado na VPS)
ARGS=""
for a in "$@"; do
  if [[ "$a" == "--so-conferir" || "$a" =~ ^--caixa=[0-9]{1,6}$ || "$a" =~ ^--etiquetar-horas=[0-9]{1,4}$ ]]; then
    ARGS+=" $(printf '%q' "$a")"
  else
    echo "opção inválida: $a (use --so-conferir, --caixa=N, --etiquetar-horas=N)"; exit 2
  fi
done

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo); tudo vai como COMANDO do ssh, nunca como script no stdin
REMOTO="A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2); [ -n \"\$A\" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }; docker exec \$A test -f /repo/backend/dist/scripts/sofia-aberta-retroativo.js || { echo 'ERRO: o contêiner ainda não tem o script (backend/dist/scripts/sofia-aberta-retroativo.js): publique o deploy do PR antes.'; exit 1; }; docker exec -w /repo/backend \$A node dist/scripts/sofia-aberta-retroativo.js$ARGS"
exec ssh -i "$CHAVE" -o ConnectTimeout=15 "$VPS" "$REMOTO"
