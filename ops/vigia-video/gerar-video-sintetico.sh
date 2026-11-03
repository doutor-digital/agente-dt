#!/usr/bin/env bash
# Gera um vídeo sintético para testar o vigia de ponta a ponta: fundo cinza parado e um retângulo branco que se move
# em DUAS janelas de tempo (padrão: 40-70 s e 150-170 s). Keyframe a cada 2 s, como o OBS recomendado no README.
#
# Uso: bash gerar-video-sintetico.sh SAIDA.mkv [duracao_seg=240]
set -euo pipefail
saida="${1:?uso: gerar-video-sintetico.sh SAIDA.mkv [duracao_seg]}"
dur="${2:-240}"
# overlay (não drawbox: no drawbox o "t" da expressão é a espessura, não o tempo)
filtro="[0:v][1:v]overlay=x='20+mod(t*90,480)':y=120:enable='between(t,40,70)+between(t,150,170)'"
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x303030:s=640x360:r=10:d=${dur}" \
  -f lavfi -i "color=c=white:s=90x90:r=10:d=${dur}" -filter_complex "$filtro" \
  -c:v libx264 -g 20 -pix_fmt yuv420p "$saida"
echo "ok: $saida (${dur}s, movimento em 40-70s e 150-170s)"
