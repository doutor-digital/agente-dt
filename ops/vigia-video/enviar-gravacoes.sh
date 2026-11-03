#!/usr/bin/env bash
# Vigia de vídeo — lado do PC que grava.
#
# Acha gravações do OBS (MKV) que JÁ TERMINARAM, roda a triagem (movimento + folhas + clipes leves) e envia SÓ o pacote
# (eventos.json, resumo.md, folhas/, clipes/, meta.json) ao servidor. O vídeo original NUNCA sai deste computador e este
# script NUNCA apaga nada (nem o vídeo, nem o pacote local).
#
# Uso (sem sudo):   chmod +x enviar-gravacoes.sh && bash enviar-gravacoes.sh [--simular] [--sem-enviar]
#   --simular     só lista o que faria (quais gravações estão prontas, quais esperam e por quê); não roda nada
#   --sem-enviar  gera o pacote em $VIGIA_TRABALHO mas não envia nem marca como enviada
#
# Configuração por variável de ambiente (no cron, veja o README):
#   VIGIA_DESTINO     OBRIGATÓRIA (menos com --simular). Onde cai o pacote, no formato do rsync:
#                       vigia@89.116.214.130:        (chave restrita com rrsync: o caminho é relativo a /srv/vigia)
#                       vigia@89.116.214.130:/srv/vigia/   (sem rrsync)
#                       /tmp/destino-de-teste/       (pasta local, para testar)
#   VIGIA_ORIGEM      pasta das gravações            (padrão ~/Vídeos/vigia)
#   VIGIA_TRABALHO    onde ficam os pacotes locais   (padrão ~/.cache/vigia-video)
#   VIGIA_ESTADO      marcas de "já enviada"         (padrão ~/.local/state/vigia-video)
#   VIGIA_SSH_CHAVE   chave ssh só de envio          (padrão ~/.ssh/vigia_envio)
#   VIGIA_PARADO_SEG  segundos sem escrita para valer como terminada (padrão 300)
#   VIGIA_TENTATIVAS  falhas de TRIAGEM seguidas antes de desistir de uma gravação (padrão 3); falha de envio sempre tenta de novo
#
# Nome do arquivo (OBS: Configurações → Avançado → Gravação → Formatação do nome de arquivo, formato MKV):
#   %CCYY-%MM-%DD_%hh-%mm-%ss_caixa      ->  2026-11-03_08-00-00_caixa.mkv
# O que vem depois do 3º "_" é o nome da câmera: minúsculas, números e hífen, sem acento nem espaço.
set -euo pipefail

SIMULAR=0
SEM_ENVIAR=0
for a in "$@"; do
  case "$a" in
    --simular) SIMULAR=1 ;;
    --sem-enviar) SEM_ENVIAR=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $a (use --simular, --sem-enviar ou --help)" >&2; exit 2 ;;
  esac
done

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIGEM="${VIGIA_ORIGEM:-$HOME/Vídeos/vigia}"
TRABALHO="${VIGIA_TRABALHO:-$HOME/.cache/vigia-video}"
ESTADO="${VIGIA_ESTADO:-$HOME/.local/state/vigia-video}"
CHAVE="${VIGIA_SSH_CHAVE:-$HOME/.ssh/vigia_envio}"
PARADO_SEG="${VIGIA_PARADO_SEG:-300}"
TENTATIVAS="${VIGIA_TENTATIVAS:-3}"
DESTINO="${VIGIA_DESTINO:-}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

for c in ffmpeg ffprobe python3 rsync flock; do
  command -v "$c" >/dev/null || { log "ERRO: falta o programa '$c' (sudo apt install ffmpeg python3 rsync util-linux — instalar é com você)"; exit 1; }
done
command -v fuser >/dev/null || command -v lsof >/dev/null || { log "ERRO: preciso de fuser (pacote psmisc) ou lsof para saber se o OBS ainda está gravando; sem isso eu poderia enviar uma gravação aberta"; exit 1; }
[ "$SIMULAR" = 1 ] || [ "$SEM_ENVIAR" = 1 ] || [ -n "$DESTINO" ] || { log "ERRO: defina VIGIA_DESTINO (veja o cabeçalho deste script)"; exit 1; }
[ -d "$ORIGEM" ] || { log "pasta de gravações não existe: $ORIGEM (nada a fazer)"; exit 0; }

mkdir -p "$ESTADO/enviados" "$ESTADO/falhas" "$TRABALHO"

# uma rodada por vez: a triagem de 10 h pode passar de 15 min e o cron chega de novo
exec 9>"$ESTADO/trava"
flock -n 9 || { log "já existe uma rodada em andamento; saio"; exit 0; }

# a gravação está aberta por algum programa (o OBS)?
em_uso() {
  if command -v fuser >/dev/null; then fuser -s -- "$1" 2>/dev/null && return 0; fi
  if command -v lsof >/dev/null; then lsof -- "$1" >/dev/null 2>&1 && return 0; fi
  return 1
}

REGEX='^([0-9]{4})-([0-9]{2})-([0-9]{2})_([0-9]{2})-([0-9]{2})-([0-9]{2})_([a-z0-9][a-z0-9-]{0,38})\.mkv$'
feitas=0

shopt -s nullglob
for arq in "$ORIGEM"/*.mkv; do
  nome="$(basename "$arq")"
  if [[ ! "$nome" =~ $REGEX ]]; then
    log "ignorada (nome fora do formato AAAA-MM-DD_hh-mm-ss_camera.mkv): $nome"
    continue
  fi
  data="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
  hh="${BASH_REMATCH[4]}"; mm="${BASH_REMATCH[5]}"; ss="${BASH_REMATCH[6]}"
  camera="${BASH_REMATCH[7]}"
  pacote_id="${data}_${hh}${mm}"
  inicio="${data} ${hh}:${mm}:${ss}"

  [ -e "$ESTADO/enviados/$nome" ] && continue

  nfalhas=0
  [ -e "$ESTADO/falhas/$nome" ] && nfalhas="$(wc -l < "$ESTADO/falhas/$nome")"
  if [ "$nfalhas" -ge "$TENTATIVAS" ]; then
    log "desisti de $nome após $nfalhas falhas (último erro em $ESTADO/falhas/$nome; apague esse arquivo para tentar de novo)"
    continue
  fi

  if em_uso "$arq"; then log "espera: $nome ainda está aberta (OBS gravando)"; continue; fi
  idade=$(( $(date +%s) - $(stat -c %Y "$arq") ))
  if [ "$idade" -lt "$PARADO_SEG" ]; then log "espera: $nome mexida há ${idade}s (< ${PARADO_SEG}s)"; continue; fi
  if [ ! -s "$arq" ]; then log "ignorada: $nome está vazia"; continue; fi

  if [ "$SIMULAR" = 1 ]; then log "PRONTA (faria a triagem e o envio): $nome -> $camera/$pacote_id"; continue; fi

  pacote="$TRABALHO/$camera/$pacote_id"
  assinatura="$(stat -c '%s:%Y' "$arq")"   # tamanho:mtime do vídeo; muda se a gravação mudar
  if [ -s "$pacote/.triagem-ok" ] && [ "$(cat "$pacote/.triagem-ok")" = "$assinatura" ]; then
    # só o envio falhou antes: a triagem (cara, ffmpeg sobre horas de vídeo) não se repete
    log "triagem de $nome já pronta em $pacote; só envio"
  else
    # pacote COMPLETO de outra triagem (o vídeo mudou): sai do caminho por RENOME, sem apagar, para folhas/clipes velhos não irem junto.
    # (pacote parcial de uma triagem que falhou é reaproveitado: o mesmo vídeo regera os mesmos nomes por cima)
    if [ -e "$pacote/.triagem-ok" ]; then mv -- "$pacote" "$pacote.antigo-$(date +%s)"; fi
    log "triagem de $nome (câmera $camera, início $inicio)"
    mkdir -p "$pacote"
    if ! nice -n 19 ionice -c 3 python3 -I "$AQUI/triagem.py" "$arq" --saida "$pacote" --rapido --clipes \
          --inicio-gravacao "$inicio" > "$pacote/triagem.log" 2>&1; then
      log "FALHOU a triagem de $nome (veja $pacote/triagem.log)"
      echo "$(date '+%F %T') triagem" >> "$ESTADO/falhas/$nome"
      continue
    fi
    echo "$assinatura" > "$pacote/.triagem-ok"
  fi

  if [ "$SEM_ENVIAR" = 1 ]; then log "pronto em $pacote (--sem-enviar: não enviei)"; continue; fi

  # o pacote vai SEM o meta.json; o meta.json vai por último e é o que faz o conector listar a gravação
  # (envio interrompido no meio nunca aparece como gravação pronta)
  ssh_cmd="ssh -i '$CHAVE' -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30"
  rs=(rsync -aR --partial --chmod=D755,F644 -e "$ssh_cmd")
  if ! python3 -I - "$pacote" "$camera" "$inicio" "$nome" <<'PY'
import json, os, sys, datetime
pacote, camera, inicio, arquivo = sys.argv[1:5]
ev = json.load(open(os.path.join(pacote, "eventos.json")))
meta = {"versao": 1, "camera": camera, "inicio_gravacao": inicio.replace(" ", "T"), "arquivo_origem": arquivo,
        "duracao_seg": ev["duracao_seg"], "eventos": len(ev["eventos"]),
        "gerado_em": datetime.datetime.now().astimezone().isoformat(timespec="seconds")}
json.dump(meta, open(os.path.join(pacote, "meta.json.novo"), "w"), ensure_ascii=False, indent=1)
PY
  then
    log "FALHOU ao montar o meta de $nome"; echo "$(date '+%F %T') meta" >> "$ESTADO/falhas/$nome"; continue
  fi
  mv -f "$pacote/meta.json.novo" "$pacote/meta.json"   # arquivo temporário do próprio script
  if ( cd "$TRABALHO" \
       && "${rs[@]}" --exclude='meta.json' --exclude='.triagem-ok' --exclude='triagem.log' --exclude='envio.log' --exclude='movimento.tsv' "./$camera/$pacote_id" "$DESTINO" \
       && "${rs[@]}" "./$camera/$pacote_id/meta.json" "$DESTINO" ) > "$pacote/envio.log" 2>&1; then
    date '+%F %T' > "$ESTADO/enviados/$nome"
    log "ENVIADA: $nome -> $DESTINO$camera/$pacote_id"
    feitas=$((feitas + 1))
  else
    # falha de ENVIO (rede fora, servidor reiniciando) não conta para desistir: a triagem já está pronta e a próxima rodada só reenvia
    log "FALHOU o envio de $nome; tento de novo na próxima rodada (veja $pacote/envio.log)"
  fi
done

log "fim da rodada: $feitas gravação(ões) enviada(s)"
