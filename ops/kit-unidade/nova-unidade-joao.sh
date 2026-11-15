#!/usr/bin/env bash
# MONTA UMA CLÍNICA NOVA NO CRM, passo a passo, a partir de ops/kit-unidade/unidades/<slug>.yaml. Roda no HOST DA VPS como root (é quem fala com o Docker),
# mas o kit roda DENTRO do contêiner ddagent_agent: lá estão o código publicado, o node e o ambiente dele (banco, Chatwoot, Kapso). O host não tem node/pnpm
# e não alcança o banco (a rede do Swarm é interna) — por isso nada do kit roda aqui fora.
#
#   bash ops/kit-unidade/nova-unidade-joao.sh <slug> --so-conferir          # só confere o que precisa existir; não copia nem roda nada
#   bash ops/kit-unidade/nova-unidade-joao.sh <slug>                        # 1) SECO: mostra o PLANO (não grava nada)
#   bash ops/kit-unidade/nova-unidade-joao.sh <slug> --aplicar              # 2) executa etapa por etapa, perguntando antes de cada uma
#   bash ops/kit-unidade/nova-unidade-joao.sh <slug> --aplicar --ligar-robo # 3) (só depois do teste da Sofia) liga o robô na caixa
#
# ONDE RODAR: na VPS, de /root/kit (a VPS não tem cópia do repositório: leve a pasta com ops/kit-unidade/levar-kit-para-vps.sh, na sua máquina). Os caminhos
# vêm do endereço deste arquivo, então funciona de /root/kit/ops/kit-unidade.
#
# NÃO PUBLIQUE DEPLOY ENQUANTO O KIT RODA: os segredos gerados (o token do conector da clínica, que o Chatwoot entrega UMA vez só, e o do robô) ficam em
# /run/kit-segredos.<pid> DENTRO do contêiner até o fim; trocar o contêiner (deploy, rolling update, reinício) no meio os perderia. Só saem dali quando o script termina.
# Se o contêiner foi trocado no meio: o usuário conector da clínica ficou criado sem token guardado — apague-o no Super Admin do Chatwoot e rode de novo.
#
# RODE COM `bash arquivo` NO SEU TERMINAL — nunca `ssh … 'bash -s' < este-arquivo`: o `docker exec -i` lê o stdin e engoliria o resto do script.
# Sem terminal (cron, pipe) só vale com `--sim` (sem perguntas), depois de ler o plano.
#
# Segredo: o token do Platform App é lido do arquivo e passado ao contêiner SEM valor na linha de comando (`-e NOME`); os segredos GERADOS (token do
# conector da clínica, do robô) caem em /run/kit-segredos DENTRO do contêiner e, ao fim (mesmo se der erro), são copiados para $KIT_SEGREDOS_DIR neste host
# (padrão /root/segredos/kit, pasta 700, arquivos 600) e APAGADOS do contêiner. Nada passa por /tmp, nada é impresso.
# O contêiner precisa já ter este kit: o deploy do PR com `dist/scripts/nova-unidade.js`. O molde da Sofia e o questionário são copiados para ele (não são segredo).
#
# NÃO FOI RODADO por quem escreveu (não tinha acesso à VPS). A primeira execução é com --so-conferir.
set -euo pipefail
umask 077

SLUG="${1:-}"
[ -n "$SLUG" ] || { echo "uso: nova-unidade-joao.sh <slug> [--so-conferir] [--aplicar] [--sim] [--ligar-robo] [--sobrescrever]"; exit 2; }
shift || true
SO_CONFERIR=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--so-conferir" ]; then SO_CONFERIR=1; else ARGS+=("$a"); fi
done

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# O questionário de clínica REAL tem dado pessoal (e-mail das atendentes, chave Pix, telefone) e NÃO vai para o GitHub: fica em unidades/privado/ (fora do git; chega à VPS
# por `levar-kit-para-vps.sh --questionario <slug>`). Procura primeiro em unidades/ (a demonstração, versionada) e depois em unidades/privado/.
PUBLICO="$AQUI/unidades/$SLUG.yaml"
PRIVADO="$AQUI/unidades/privado/$SLUG.yaml"
if [ -f "$PUBLICO" ] && [ -f "$PRIVADO" ]; then
  echo "ERRO: o slug $SLUG existe nos DOIS lugares — não sei qual vale:"; echo "  $PUBLICO"; echo "  $PRIVADO"; echo "Apague um deles (a clínica real fica só em privado/)."; exit 1
fi
QUESTIONARIO="$PUBLICO"; [ -f "$QUESTIONARIO" ] || QUESTIONARIO="$PRIVADO"
[ -f "$QUESTIONARIO" ] || { echo "ERRO: não achei o questionário de $SLUG em $PUBLICO nem em $PRIVADO (a skill /nova-unidade cria o arquivo; clínica real chega por levar-kit-para-vps.sh --questionario $SLUG)."; exit 1; }
PLATAFORMA="${ARQUIVO_PLATAFORMA:-/root/segredos/chatwoot-platform.token}"
COFRE_DO_HOST="${KIT_SEGREDOS_DIR:-/root/segredos/kit}"
# um cofre POR RODADA ($$ = o pid deste script): duas rodadas ao mesmo tempo (duas clínicas) não se apagam nem misturam segredos
COFRE_NO_CONTEINER="/run/kit-segredos.$$"
RAIZ_NO_CONTEINER="/repo"

# o contêiner MAIS NOVO do agente (no rolling update `head -1` pegaria o antigo)
AGENTE="$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$AGENTE" ] || { echo "ERRO: não achei o contêiner ddagent_agent neste host (docker ps). Rode no host do Swarm, como root."; exit 1; }
# `</dev/null`: nenhum docker exec que não seja o da tela pode ler o stdin
conteiner() { docker exec "$AGENTE" "$@" </dev/null; }

echo "contêiner do agente: ${AGENTE:0:12}"
conteiner test -f "$RAIZ_NO_CONTEINER/backend/dist/scripts/nova-unidade.js" || { echo "ERRO: o contêiner ainda não tem o kit (backend/dist/scripts/nova-unidade.js): publique o deploy do PR da fase 2 antes."; exit 1; }
echo "kit no contêiner: ok"
if [ -r "$PLATAFORMA" ]; then echo "Platform App: token em $PLATAFORMA (ok)"; else echo "aviso: sem $PLATAFORMA — o seco funciona, mas a conta NÃO é criada: rode antes bash ops/kit-unidade/criar-platform-app-joao.sh"; fi
echo "cofre dos segredos gerados: $COFRE_DO_HOST (no contêiner: $COFRE_NO_CONTEINER)"
if [ "$SO_CONFERIR" = "1" ]; then echo "SÓ CONFERIR: nada foi copiado nem executado."; exit 0; fi

TEM_APLICAR=0; TEM_SIM=0
for a in ${ARGS[@]+"${ARGS[@]}"}; do
  [ "$a" = "--aplicar" ] && TEM_APLICAR=1
  [ "$a" = "--sim" ] && TEM_SIM=1
done
TTY=()
if [ -t 0 ] && [ -t 1 ]; then
  TTY=(-it)
elif [ "$TEM_APLICAR" = "1" ] && [ "$TEM_SIM" = "0" ]; then
  echo "ERRO: sem terminal só dá para aplicar com --sim (sem perguntas), depois de ler o plano."; exit 2
fi

# A LIMPEZA vem ANTES da primeira cópia: se qualquer passo falhar depois de o questionário (e-mails, Pix, telefone) entrar no contêiner do serviço, ele sai de lá, e os
# segredos gerados voltam ao host. Os `docker cp`/`exec` da limpeza toleram o que ainda não existe.
voltar() {
  # o questionário (pode ter dado pessoal) também não fica no contêiner
  docker exec "$AGENTE" rm -f "$RAIZ_NO_CONTEINER/ops/kit-unidade/unidades/$SLUG.yaml" </dev/null >/dev/null 2>&1 || true
  docker cp "$AGENTE:$COFRE_NO_CONTEINER/." "$COFRE_DO_HOST/" >/dev/null 2>&1 || true
  if [ -d "$COFRE_DO_HOST" ]; then chmod 700 "$COFRE_DO_HOST"; chmod 600 "$COFRE_DO_HOST"/* 2>/dev/null || true; fi
  docker exec "$AGENTE" rm -rf "$COFRE_NO_CONTEINER" </dev/null >/dev/null 2>&1 || true
}
trap voltar EXIT

# questionário e molde da Sofia para dentro do contêiner (o questionário de clínica real tem dado pessoal: sai de lá no EXIT)
conteiner mkdir -p "$RAIZ_NO_CONTEINER/ops/kit-unidade/unidades"
docker cp "$AQUI/molde-sofia" "$AGENTE:$RAIZ_NO_CONTEINER/ops/kit-unidade/" >/dev/null
docker cp "$QUESTIONARIO" "$AGENTE:$RAIZ_NO_CONTEINER/ops/kit-unidade/unidades/$SLUG.yaml" >/dev/null

# o cofre: ida (o que já foi gerado antes, para a 2ª rodada reaproveitar); a volta é o `voltar` acima (sempre, mesmo com erro)
mkdir -p "$COFRE_DO_HOST"; chmod 700 "$COFRE_DO_HOST"
conteiner sh -c "mkdir -p $COFRE_NO_CONTEINER && chmod 700 $COFRE_NO_CONTEINER"
if [ -n "$(ls -A "$COFRE_DO_HOST" 2>/dev/null)" ]; then docker cp "$COFRE_DO_HOST/." "$AGENTE:$COFRE_NO_CONTEINER/" >/dev/null; fi

if [ -r "$PLATAFORMA" ]; then CHATWOOT_PLATFORM_TOKEN="$(cat "$PLATAFORMA")"; export CHATWOOT_PLATFORM_TOKEN; fi
# `-e NOME` (sem valor): o docker pega do ambiente deste processo; o valor não aparece na linha de comando nem no ps
docker exec ${TTY[@]+"${TTY[@]}"} -e CHATWOOT_PLATFORM_TOKEN -e KIT_ADMINS_DD -e "KIT_SEGREDOS_DIR=$COFRE_NO_CONTEINER" -w "$RAIZ_NO_CONTEINER/backend" "$AGENTE" \
  node dist/scripts/nova-unidade.js "$RAIZ_NO_CONTEINER/ops/kit-unidade/unidades/$SLUG.yaml" ${ARGS[@]+"${ARGS[@]}"}
