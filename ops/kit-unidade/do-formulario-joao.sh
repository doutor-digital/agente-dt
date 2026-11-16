#!/usr/bin/env bash
# GERA O QUESTIONÁRIO PRIVADO DE UMA CLÍNICA A PARTIR DO FORMULÁRIO que o franqueado preencheu (https://agente.../nova-clinica/<codigo>). Roda NA VPS, como root,
# de /root/kit — normalmente quem chama é o abrir-clinica-joao.sh (`--do-formulario`), do computador do João.
#
#   bash ops/kit-unidade/do-formulario-joao.sh <codigo|id|slug> --so-conferir          # lê o banco e mostra o que falta; não grava nada
#   bash ops/kit-unidade/do-formulario-joao.sh <codigo|id|slug> [--set caminho=valor]... [--sobrescrever]
#
# <ref>: o id do formulário (aparece no aviso e em `convite-clinica-joao.sh --listar`), o slug sugerido (se for único) ou o próprio código do link.
# O que o dono do formulário não soube dizer (ids do Kapso e do WhatsApp Business, às vezes o código da franquia e a conta de anúncios) o João completa com
# `--set` (lista fechada: whatsapp.kapso_phone_number_id, whatsapp.waba_id, franquia.id_company, meta.ad_account, meta.business_manager_id, unidade.slug,
# chatwoot.subdominio, whatsapp.prefixo_modelos, whatsapp.numero_oficial, sufixo). Nada de editar YAML à mão.
#
# O questionário tem DADO PESSOAL (e-mail das atendentes, Pix, telefone): é gerado DENTRO do contêiner (onde está o banco), copiado para
# unidades/privado/<slug>.yaml aqui (pasta 700, arquivo 600) e apagado do contêiner no fim (mesmo se der erro). O conteúdo nunca é impresso.
# Se já existe um questionário DIFERENTE com esse slug, para (use --sobrescrever: o antigo fica guardado como <slug>.yaml.anterior-<data>, nada é apagado).
#
# Roda com `bash arquivo`; nunca `ssh … 'bash -s' < arquivo` (o `docker exec` engoliria o resto do script).
# NÃO FOI RODADO por quem escreveu (não tinha acesso à VPS): a primeira execução é com --so-conferir.
set -euo pipefail
umask 077

REF="${1:-}"
[[ "$REF" =~ ^[A-Za-z0-9_-]{3,60}$ ]] || { echo "uso: do-formulario-joao.sh <codigo|id|slug> [--so-conferir] [--set caminho=valor]... [--sobrescrever]"; exit 2; }
shift
SO_CONFERIR=0; SOBRESCREVER=0; SETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --so-conferir) SO_CONFERIR=1 ;;
    --sobrescrever) SOBRESCREVER=1 ;;
    --set) shift; [[ "${1:-}" =~ ^[a-z_]+(\.[a-z_]+)?=[A-Za-z0-9_.+-]+$ ]] || { echo "--set precisa ser caminho=valor, sem espaço (ex.: --set whatsapp.waba_id=123)"; exit 2; }; SETS+=(--set "$1") ;;
    *) echo "argumento desconhecido: $1"; exit 2 ;;
  esac
  shift
done

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIVADO="$AQUI/unidades/privado"
RAIZ_NO_CONTEINER="/repo"

AGENTE="$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$AGENTE" ] || { echo "ERRO: não achei o contêiner ddagent_agent neste host (docker ps). Rode no host do Swarm, como root."; exit 1; }
docker exec "$AGENTE" test -f "$RAIZ_NO_CONTEINER/backend/dist/scripts/do-formulario.js" </dev/null || { echo "ERRO: o contêiner ainda não tem o importador do formulário (backend/dist/scripts/do-formulario.js): publique o deploy do PR antes."; exit 1; }

PASTA="/run/kit-formulario.$$"
limpar() { docker exec "$AGENTE" rm -rf "$PASTA" </dev/null >/dev/null 2>&1 || true; [ -z "${TEMP:-}" ] || rm -f "$TEMP"; }
trap limpar EXIT

rodar() { docker exec -w "$RAIZ_NO_CONTEINER/backend" "$AGENTE" node dist/scripts/do-formulario.js "$REF" "$@" </dev/null 2>&1; }

RC=0
if [ "$SO_CONFERIR" = "1" ]; then
  OUT="$(rodar --so-conferir ${SETS[@]+"${SETS[@]}"})" || RC=$?
  printf '%s\n' "$OUT"
  exit "$RC"
fi

OUT="$(rodar --saida "$PASTA" ${SETS[@]+"${SETS[@]}"})" || RC=$?
printf '%s\n' "$OUT"
[ "$RC" -eq 0 ] || exit "$RC"
SLUG="$(printf '%s\n' "$OUT" | sed -n 's/^KIT_RESUMO slug=\([a-z0-9-]*\) .*/\1/p' | head -1)"
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$ ]] || { echo "ERRO: o importador não devolveu o slug (KIT_RESUMO)."; exit 1; }

if [ -f "$AQUI/unidades/$SLUG.yaml" ]; then
  echo "ERRO: o slug $SLUG também existe em $AQUI/unidades/ (versionado). Escolha outro com --set unidade.slug=…"; exit 1
fi
mkdir -p "$PRIVADO"; chmod 700 "$PRIVADO"
TEMP="$PRIVADO/.chegando.$SLUG.$$"
docker cp "$AGENTE:$PASTA/$SLUG.yaml" "$TEMP" >/dev/null
chmod 600 "$TEMP"
DESTINO="$PRIVADO/$SLUG.yaml"
if [ -f "$DESTINO" ]; then
  if cmp -s "$TEMP" "$DESTINO"; then
    echo "OK: $DESTINO já está igual ao gerado do formulário. Nada a fazer."
    exit 0
  fi
  if [ "$SOBRESCREVER" != "1" ]; then
    echo "PARO: já existe um questionário DIFERENTE para $SLUG em $DESTINO (alguém completou ou editou). Nada foi trocado."
    echo "Para refazer do formulário (com seus --set), rode de novo com --sobrescrever: o antigo fica guardado ao lado."
    exit 1
  fi
  GUARDA="$DESTINO.anterior-$(date +%Y%m%d-%H%M%S)"
  mv "$DESTINO" "$GUARDA"; chmod 600 "$GUARDA"
  echo "O questionário anterior ficou guardado em $GUARDA (modo 600)."
fi
mv "$TEMP" "$DESTINO"
TEMP=""
echo "PRONTO: $DESTINO (modo 600; o conteúdo não é impresso)."
