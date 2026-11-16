#!/usr/bin/env bash
# LEVA AS CHAVES DA CLÍNICA NOVA DO COFRE PARA O SERVIÇO DO AGENTE e reinicia o serviço (é quando o servidor passa a conhecer a conta).
#
#   (na VPS, como root)
#   bash cofre-para-servico-joao.sh DEMO --so-conferir     # só mostra o que falta; não muda nada
#   bash cofre-para-servico-joao.sh DEMO                   # grava no .env (com cópia antes) e atualiza o serviço ddagent_agent
#
# O que faz: lê CHATWOOT_API_TOKEN_<SUFIXO> e CHATWOOT_SOFIA_BOT_TOKEN_<SUFIXO> do cofre do kit (/root/segredos/kit), acrescenta no
# /opt/doutordigital/agente-dt/.env (o próximo deploy continua com elas) e põe as duas no serviço que está no ar (mesma imagem, só o env).
# NENHUM VALOR É IMPRESSO. Chave que já está no .env com o mesmo valor não é regravada; com valor DIFERENTE, o script para (confira à mão).
# Não rode com deploy em andamento.
set -euo pipefail
umask 077
SUF="${1:-}"
SO_CONFERIR=0
[ "${2:-}" = "--so-conferir" ] && SO_CONFERIR=1
if [ -n "${2:-}" ] && [ "$SO_CONFERIR" = 0 ]; then echo "argumento desconhecido: $2"; exit 2; fi
[[ "$SUF" =~ ^[A-Z0-9_]+$ ]] || { echo "uso: bash cofre-para-servico-joao.sh <SUFIXO> [--so-conferir]   (ex.: DEMO)"; exit 2; }

COFRE="${KIT_SEGREDOS_DIR:-/root/segredos/kit}"
ENVF=/opt/doutordigital/agente-dt/.env
SVC=ddagent_agent
NOMES=("CHATWOOT_API_TOKEN_$SUF" "CHATWOOT_SOFIA_BOT_TOKEN_$SUF")

[ -f "$ENVF" ] || { echo "não achei $ENVF"; exit 1; }
docker service inspect "$SVC" >/dev/null 2>&1 || { echo "não achei o serviço $SVC"; exit 1; }
for n in "${NOMES[@]}"; do
  [ -s "$COFRE/$n" ] || { echo "FALTA no cofre: $COFRE/$n (o kit rodou com --aplicar?)"; exit 1; }
done

ENV_SERVICO=$(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}')
FALTA_ENV=()
FALTA_SVC=()
for n in "${NOMES[@]}"; do
  v=$(cat "$COFRE/$n")
  if grep -q "^$n=" "$ENVF"; then
    if [ "$(grep "^$n=" "$ENVF" | tail -1 | cut -d= -f2-)" = "$v" ]; then e=".env já tem (igual ao cofre)"
    else echo "PARO: $n está no .env com valor DIFERENTE do cofre. Confira à mão (não troco sozinho)."; exit 1; fi
  else e=".env sem ela"; FALTA_ENV+=("$n"); fi
  if printf '%s\n' "$ENV_SERVICO" | grep -qxF "$n=$v"; then s="serviço já tem"; else s="serviço sem ela"; FALTA_SVC+=("$n"); fi
  echo "  $n: $e · $s"
done
unset ENV_SERVICO v

if [ ${#FALTA_ENV[@]} -eq 0 ] && [ ${#FALTA_SVC[@]} -eq 0 ]; then echo "NADA A FAZER: o serviço já conhece a conta $SUF."; exit 0; fi
if [ "$SO_CONFERIR" = 1 ]; then echo "SÓ CONFERIR: nada foi mudado. Rodando sem --so-conferir, gravo no .env (com cópia) e atualizo o serviço (reinicia ~1 min)."; exit 0; fi

if [ ${#FALTA_ENV[@]} -gt 0 ]; then
  BAK="$ENVF.bak-$(date +%d-%m-%H%M)-cofre-$SUF"
  cp -p "$ENVF" "$BAK"
  [ -n "$(tail -c1 "$ENVF")" ] && printf '\n' >> "$ENVF"
  for n in "${FALTA_ENV[@]}"; do printf '%s=%s\n' "$n" "$(cat "$COFRE/$n")" >> "$ENVF"; done
  echo "  .env: acrescentei ${FALTA_ENV[*]} (cópia em $BAK)"
fi

if [ ${#FALTA_SVC[@]} -gt 0 ]; then
  ARGS=()
  for n in "${FALTA_SVC[@]}"; do ARGS+=(--env-add "$n=$(cat "$COFRE/$n")"); done
  echo "  serviço: atualizando $SVC (mesma imagem; espera ficar de pé)…"
  docker service update --detach=false --quiet "${ARGS[@]}" "$SVC" >/dev/null
  unset ARGS
fi

sleep 20
C=$(docker ps -q -f name="$SVC" -f health=healthy | head -1)
[ -n "$C" ] && echo "  contêiner novo de pé e saudável: $C" || echo "  ATENÇÃO: não achei contêiner saudável ainda; rode: docker service ps $SVC"
for n in "${NOMES[@]}"; do
  [ -n "$C" ] && docker exec "$C" sh -c "test -n \"\${$n:-}\"" && echo "  $n: presente no contêiner (valor não impresso)"
done
echo "  erros graves no log desde a troca: $(docker service logs --since 2m "$SVC" 2>&1 | grep -c '"level":50' || true)"
echo "PRONTO. A conta $SUF passa a valer para o servidor (as automações dela seguem em SECO)."
