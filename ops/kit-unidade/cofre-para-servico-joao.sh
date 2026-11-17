#!/usr/bin/env bash
# LEVA AS CHAVES DA CLÍNICA NOVA DO COFRE PARA O SERVIÇO DO AGENTE e reinicia o serviço (é quando o servidor passa a conhecer a conta).
#
#   (na VPS, como root, de /root/kit)
#   bash ops/kit-unidade/cofre-para-servico-joao.sh DEMO --so-conferir     # só mostra o que falta; não muda nada
#   bash ops/kit-unidade/cofre-para-servico-joao.sh DEMO                   # grava no .env (com cópia) e atualiza o serviço ddagent_agent
#   bash ops/kit-unidade/cofre-para-servico-joao.sh SERRA --sem-ia         # clínica SEM assistente (assistente.quer: false): não há robô Sofia, então só a chave da conta
#
# O que faz: lê CHATWOOT_API_TOKEN_<SUFIXO> e CHATWOOT_SOFIA_BOT_TOKEN_<SUFIXO> do cofre do kit (/root/segredos/kit), acrescenta no
# /opt/doutordigital/agente-dt/.env (o próximo deploy continua com elas) e põe as duas no serviço que está no ar (mesma imagem, só o env).
# NENHUM VALOR É IMPRESSO NEM VAI NA LINHA DE COMANDO (ps): a comparação é feita no próprio bash e o docker recebe `--env-add NOME`
# (sem valor), lendo o valor do ambiente. Chave que já está no .env com o mesmo valor não é regravada; com valor DIFERENTE, o script PARA.
# NÃO rode com deploy em andamento nem com o kit rodando (o script recusa se achar /run/kit-segredos.* no contêiner).
# A troca de contêiner leva ~3 min (start_period + monitor do Swarm).
set -euo pipefail
umask 077
SUF="${1:-}"
SO_CONFERIR=0
SEM_IA=0
for a in "${@:2}"; do
  case "$a" in
    --so-conferir) SO_CONFERIR=1 ;;
    --sem-ia) SEM_IA=1 ;;
    *) echo "argumento desconhecido: $a (use --so-conferir e/ou --sem-ia)"; exit 2 ;;
  esac
done
[[ "$SUF" =~ ^[A-Z0-9_]+$ ]] || { echo "uso: bash cofre-para-servico-joao.sh <SUFIXO> [--so-conferir] [--sem-ia]   (ex.: DEMO)"; exit 2; }

COFRE="${KIT_SEGREDOS_DIR:-/root/segredos/kit}"
ENVF="${AGENTE_ENV_ARQUIVO:-/opt/doutordigital/agente-dt/.env}"
SVC="${AGENTE_SERVICO:-ddagent_agent}"
NOMES=("CHATWOOT_API_TOKEN_$SUF")
# clínica COM assistente também leva a chave do robô Sofia; SEM assistente (--sem-ia) o robô nem existe, e exigir a chave dele travaria a abertura num laço
[ "$SEM_IA" = 1 ] || NOMES+=("CHATWOOT_SOFIA_BOT_TOKEN_$SUF")
# o contêiner MAIS NOVO do serviço (no rolling update `head -1` pegaria o antigo)
conteiner() { docker ps --filter "name=$SVC" --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2; }

[ -f "$ENVF" ] || { echo "não achei $ENVF"; exit 1; }
docker service inspect "$SVC" >/dev/null 2>&1 || { echo "não achei o serviço $SVC"; exit 1; }
for n in "${NOMES[@]}"; do
  [ -s "$COFRE/$n" ] || { echo "FALTA no cofre: $COFRE/$n (o kit rodou com --aplicar?)"; exit 1; }
done

# o env do serviço no ar, linha a linha, comparado no bash (sem grep com o valor na linha de comando)
mapfile -t ENV_SERVICO < <(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}')
no_servico() { local alvo="$1=$2" l; for l in "${ENV_SERVICO[@]}"; do [ "$l" = "$alvo" ] && return 0; done; return 1; }
# a ÚLTIMA linha NOME=… do .env (é a que vale no env_file): TEM=1 e ATUAL=valor
ler_env() { TEM=0; ATUAL=""; local l; while IFS= read -r l || [ -n "$l" ]; do if [ "${l%%=*}" = "$1" ]; then TEM=1; ATUAL="${l#*=}"; fi; done < "$ENVF"; }

FALTA_ENV=()
FALTA_SVC=()
for n in "${NOMES[@]}"; do
  v="$(cat "$COFRE/$n")"
  ler_env "$n"
  if [ "$TEM" = 1 ]; then
    if [ "$ATUAL" = "$v" ]; then e=".env já tem (igual ao cofre)"
    else echo "PARO: $n está no .env com valor DIFERENTE do cofre. Confira à mão (não troco sozinho)."; exit 1; fi
  else e=".env sem ela"; FALTA_ENV+=("$n"); fi
  if no_servico "$n" "$v"; then s="serviço já tem"; else s="serviço sem ela"; FALTA_SVC+=("$n"); fi
  echo "  $n: $e · $s"
done
unset v ATUAL ENV_SERVICO

if [ ${#FALTA_ENV[@]} -eq 0 ] && [ ${#FALTA_SVC[@]} -eq 0 ]; then echo "NADA A FAZER: o serviço já conhece a conta $SUF."; exit 0; fi
if [ "$SO_CONFERIR" = 1 ]; then echo "SÓ CONFERIR: nada foi mudado. Rodando sem --so-conferir, gravo no .env (com cópia) e atualizo o serviço (troca de contêiner, ~3 min)."; exit 0; fi

if [ ${#FALTA_SVC[@]} -gt 0 ]; then
  C="$(conteiner)"
  if [ -n "$C" ] && [ "$(docker exec "$C" sh -c 'ls -d /run/kit-segredos.* 2>/dev/null | wc -l' 2>/dev/null || echo 0)" != "0" ]; then
    echo "PARO: o kit está rodando (há /run/kit-segredos.* no contêiner $C). Trocar o contêiner agora perderia o token que o Chatwoot entrega uma vez só. Rode depois que o kit terminar."
    exit 1
  fi
fi

if [ ${#FALTA_ENV[@]} -gt 0 ]; then
  BAK="$ENVF.bak-$(date +%d-%m-%H%M)-cofre-$SUF"
  cp -p "$ENVF" "$BAK"
  [ -n "$(tail -c1 "$ENVF")" ] && printf '\n' >> "$ENVF"
  for n in "${FALTA_ENV[@]}"; do printf '%s=%s\n' "$n" "$(cat "$COFRE/$n")" >> "$ENVF"; done
  echo "  .env: acrescentei ${FALTA_ENV[*]} (cópia em $BAK)"
fi

if [ ${#FALTA_SVC[@]} -eq 0 ]; then echo "PRONTO. O serviço já tinha as chaves; só o .env foi completado."; exit 0; fi

echo "  serviço: atualizando $SVC (mesma imagem; espera ficar de pé, ~3 min)…"
(
  # o valor vai pelo AMBIENTE do comando docker; na linha de comando só o NOME
  ARGS=()
  for n in "${FALTA_SVC[@]}"; do export "$n=$(cat "$COFRE/$n")"; ARGS+=(--env-add "$n"); done
  docker service update --detach=false --quiet "${ARGS[@]}" "$SVC" >/dev/null
)

C="$(conteiner)"
[ -n "$C" ] || { echo "ERRO: não achei contêiner do $SVC depois da troca. Rode: docker service ps $SVC"; exit 1; }
SAUDE="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}' "$C" 2>/dev/null || echo desconhecido)"
[ "$SAUDE" = healthy ] || [ "$SAUDE" = sem-healthcheck ] || { echo "ERRO: o contêiner novo $C está «$SAUDE». Rode: docker service ps $SVC"; exit 1; }
FALTOU=0
for n in "${NOMES[@]}"; do
  if docker exec "$C" sh -c "test -n \"\${$n:-}\""; then echo "  $n: presente no contêiner (valor não impresso)"
  else echo "  $n: AUSENTE no contêiner"; FALTOU=1; fi
done
[ "$FALTOU" = 0 ] || { echo "ERRO: o serviço subiu sem as chaves. Nada de «pronto»: confira com  docker service inspect $SVC  (sem imprimir valores)."; exit 1; }
echo "  erros graves no log desde a troca: $(docker service logs --since 3m "$SVC" 2>&1 | grep -c '"level":50' || true)"
echo "PRONTO. A conta $SUF passa a valer para o servidor (as automações dela seguem em SECO)."
