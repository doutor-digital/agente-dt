#!/usr/bin/env bash
# MONTA UMA CLÍNICA NOVA NO CRM, passo a passo, a partir de ops/kit-unidade/unidades/<slug>.yaml. Roda no host da VPS (onde o repo e o Docker estão).
# SEM sudo, SEM colar segredo: tudo que é segredo é lido de arquivo (modo 600) ou do contêiner do agente, e nunca é impresso.
#
#   bash ops/kit-unidade/nova-unidade-joao.sh <slug>                  # 1) confere tudo e mostra o PLANO em SECO (não grava nada)
#   bash ops/kit-unidade/nova-unidade-joao.sh <slug> --aplicar        # 2) executa etapa por etapa, perguntando antes de cada uma
#   bash ops/kit-unidade/nova-unidade-joao.sh <slug> --aplicar --ligar-robo   # 3) (só depois do teste da Sofia) liga o robô na caixa
#
# O que o script lê (nada disso aparece na tela):
#   /root/segredos/chatwoot-platform.token   o Platform App (criar-platform-app-joao.sh)        -> CHATWOOT_PLATFORM_TOKEN
#   /root/.chatwoot-conector-token           o conector da conta de REFERÊNCIA (Parauapebas)    -> CHATWOOT_API_TOKEN  (só leitura)
#   env do contêiner ddagent_agent           DATABASE_URL, KAPSO_API_KEY, MCP_URL_PUBLICA, CHATWOOT_URL, CHATWOOT_CONTA_ID
# O que o script grava: os segredos GERADOS (token do conector da clínica, token do robô) em $KIT_SEGREDOS_DIR (modo 700/600, padrão /root/segredos/kit).
# Depois do --aplicar o relatório lista o que fica manual (cofre -> env do serviço + reinício, subdomínio, pastas, franquia, número).
#
# NÃO FOI RODADO por quem escreveu (não tinha acesso à VPS). A primeira execução é o SECO (sem --aplicar).
set -euo pipefail
umask 077

SLUG="${1:-}"
[ -n "$SLUG" ] || { echo "uso: nova-unidade-joao.sh <slug> [--aplicar] [--ligar-robo] [--sobrescrever]"; exit 2; }
shift || true
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
QUESTIONARIO="$AQUI/unidades/$SLUG.yaml"
[ -f "$QUESTIONARIO" ] || { echo "ERRO: não achei $QUESTIONARIO (a skill /nova-unidade cria esse arquivo)."; exit 1; }

PLATAFORMA="${ARQUIVO_PLATAFORMA:-/root/segredos/chatwoot-platform.token}"
REFERENCIA="${ARQUIVO_REFERENCIA:-/root/.chatwoot-conector-token}"
export KIT_SEGREDOS_DIR="${KIT_SEGREDOS_DIR:-/root/segredos/kit}"

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo)
AGENTE="$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$AGENTE" ] || { echo "ERRO: não achei o contêiner ddagent_agent neste host."; exit 1; }
# lê UMA variável do contêiner sem imprimir
doagente() { docker exec "$AGENTE" printenv "$1" 2>/dev/null || true; }

DATABASE_URL="$(doagente DATABASE_URL)"; export DATABASE_URL
[ -n "$DATABASE_URL" ] || { echo "ERRO: o contêiner do agente não tem DATABASE_URL."; exit 1; }
export CHATWOOT_URL="$(doagente CHATWOOT_URL)" CHATWOOT_CONTA_ID="$(doagente CHATWOOT_CONTA_ID)" MCP_URL_PUBLICA="$(doagente MCP_URL_PUBLICA)"
KAPSO_API_KEY="$(doagente KAPSO_API_KEY)"; export KAPSO_API_KEY
[ -r "$REFERENCIA" ] && { CHATWOOT_API_TOKEN="$(cat "$REFERENCIA")"; export CHATWOOT_API_TOKEN; } || { echo "aviso: sem $REFERENCIA — etiquetas, atributos e automações da conta nova NÃO terão o molde de Parauapebas."; }
if [ -r "$PLATAFORMA" ]; then CHATWOOT_PLATFORM_TOKEN="$(cat "$PLATAFORMA")"; export CHATWOOT_PLATFORM_TOKEN
else echo "aviso: sem $PLATAFORMA — rode antes bash ops/kit-unidade/criar-platform-app-joao.sh (sem isso a conta não é criada)."; fi
mkdir -p "$KIT_SEGREDOS_DIR"; chmod 700 "$KIT_SEGREDOS_DIR"

cd "$RAIZ/backend"
exec pnpm exec tsx src/scripts/nova-unidade.ts "$QUESTIONARIO" "$@"
