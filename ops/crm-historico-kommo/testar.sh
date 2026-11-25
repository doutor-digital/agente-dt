#!/usr/bin/env bash
# Testes da parte pura do importador da Kommo (contrato da linha, variantes do telefone, ordem). Não precisa de Ruby no PC: usa a imagem do Chatwoot.
#   bash ops/crm-historico-kommo/testar.sh
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec docker run --rm -v "$AQUI":/t:ro -w /t "${IMG:-chatwoot/chatwoot:v4.19.1-ce}" ruby kommo_historico_test.rb
