#!/usr/bin/env bash
# Monta a versão para o Firefox numa pasta: os mesmos arquivos da extensão, com o manifest e o fundo.js daqui.
# Uso: bash firefox/montar.sh <pasta-de-saída>
set -euo pipefail
cd "$(dirname "$0")/.."
saida="${1:?informe a pasta de saída}"
rm -rf "$saida" && mkdir -p "$saida"
for f in *.js *.html *.css README.md; do cp "$f" "$saida/"; done
cp firefox/manifest.json firefox/fundo.js "$saida/"
echo "versão Firefox em $saida"
