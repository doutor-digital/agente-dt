#!/usr/bin/env bash
# ABRE UMA CLÍNICA NOVA NO CRM COM UM COMANDO SÓ. Roda no COMPUTADOR DO JOÃO (dentro do repositório agente-dt), NÃO na VPS: ele mesmo faz o ssh, então não há como
# rodar no lugar errado. Cada passo na VPS vai por `ssh -t … "comando"` (com terminal, para as perguntas por etapa funcionarem) — nunca por `ssh … 'bash -s'` com o
# script no stdin (o `docker exec -i` engoliria o resto).
#
#   bash ops/kit-unidade/abrir-clinica-joao.sh <slug> --so-conferir   # só olha: não envia nada, não muda nada (nem local, nem na VPS)
#   bash ops/kit-unidade/abrir-clinica-joao.sh <slug>                 # o caminho todo (pergunta UMA vez «aplicar?» depois de mostrar o plano)
#
# O QUE FAZ, NESTA ORDEM (cada passo para o comando inteiro se falhar, dizendo o que fazer):
#   1  confere esta máquina (chave ssh, repositório, questionário da clínica) e que a VPS responde
#   2  leva o kit para /root/kit na VPS (levar-kit-para-vps.sh; clínica real: leva também o questionário privado, modo 600)
#   3  conferências na VPS (nova-unidade-joao.sh --so-conferir; regra-traefik-joao.sh --so-conferir; criar-platform-app-joao.sh --so-conferir)
#   4  plano em SECO (nada é gravado)
#   5  pergunta «aplicar?» — a ÚNICA pergunta deste comando
#   6  criar-platform-app-joao.sh (idempotente) → nova-unidade-joao.sh --aplicar (as perguntas de cada etapa continuam)
#   7  regra-traefik-joao.sh <subdomínio> → cofre-para-servico-joao.sh <SUFIXO> (reinicia o serviço ddagent_agent, ~1 min)
#   8  resumo do que falta (número, modelos na Meta, franquia, teste da Sofia…)
#
# IDEMPOTENTE: rodar de novo não quebra nem duplica — cada script da VPS já é seguro de repetir (levar troca a pasta inteira; a conta/caixa/time que existem são
# reconhecidos; a regra do Traefik só acrescenta o que falta; o cofre só grava o que não está igual).
#
# SEGREDO: este script não lê nem imprime nenhum. Do questionário ele extrai só o subdomínio, o sufixo e o modo (demonstração/real); o resto (e-mails, Pix, telefone)
# não é impresso. NÃO cole token/senha em lugar nenhum: os tokens gerados ficam no cofre da VPS (/root/segredos/kit) e vão de lá para o serviço.
#
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps), DESTINO (padrão /root/kit), KIT_PRIVADO_DIR.
set -Eeuo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
DESTINO="${DESTINO:-/root/kit}"
PRIVADO_DIR="${KIT_PRIVADO_DIR:-$HOME/Kommo-Integracao/_replicacao/kit-unidade/privado}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SLUG=""
SO_CONFERIR=0
for a in "$@"; do
  case "$a" in
    --so-conferir) SO_CONFERIR=1 ;;
    -*) echo "argumento desconhecido: $a (use só <slug> e --so-conferir)"; exit 2 ;;
    *) if [ -z "$SLUG" ]; then SLUG="$a"; else echo "mais de um slug: $SLUG e $a"; exit 2; fi ;;
  esac
done
[ -n "$SLUG" ] || { echo "uso: bash ops/kit-unidade/abrir-clinica-joao.sh <slug> [--so-conferir]   (ex.: clinica-demonstracao)"; exit 2; }
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$ ]] || { echo "slug inválido: $SLUG (minúsculas, dígitos e hífen)"; exit 2; }
[[ "$DESTINO" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "DESTINO inválido: $DESTINO"; exit 2; }
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }

PASSO="início"
AJUDA=""
# Qualquer comando que falhar cai aqui: diz ONDE parou e o que fazer, e sai. (set -e + ERR trap; as mensagens específicas vêm em $AJUDA.)
parou() {
  local rc=$?
  trap - ERR
  echo
  echo "PAREI no passo «$PASSO» (código $rc). Nada depois dele foi feito."
  [ -n "$AJUDA" ] && echo "O que fazer: $AJUDA"
  echo "Depois é só rodar o MESMO comando de novo: nada se duplica."
  exit "$rc"
}
trap parou ERR

passo() { PASSO="$1"; AJUDA="${2:-}"; echo; echo "━━ $1"; }

# ── 1. esta máquina ─────────────────────────────────────────────────────────────────────────────────────
passo "1. conferir esta máquina" "este comando é para o SEU computador, não para a VPS. Se está na VPS, rode direto os scripts de /root/kit (README.md do kit)."
if [ ! -r "$CHAVE" ]; then
  echo "RECUSO: não achei a chave ssh em $CHAVE."
  echo "Este comando roda no computador do João, que tem a chave da VPS. Aqui não tem — então não vou tentar (CHAVE_SSH aponta outra chave)."
  PASSO="chave ssh"; AJUDA="rode no computador que tem ~/.ssh/doutordigital_vps, ou exporte CHAVE_SSH=<caminho da chave>."
  false
fi
if [ "$SO_CONFERIR" = "0" ] && { [ ! -t 0 ] || [ ! -t 1 ]; } && [ "${ABRIR_SEM_TERMINAL:-}" != "1" ]; then
  PASSO="terminal"; AJUDA="rode num terminal de verdade (as perguntas por etapa precisam dele). Use --so-conferir se só quer olhar."
  echo "RECUSO: sem terminal não dá para aplicar."
  false
fi
git -C "$AQUI" rev-parse --git-dir >/dev/null 2>&1 || { AJUDA="rode de dentro do repositório agente-dt (na sua máquina)."; false; }
cd "$(git -C "$AQUI" rev-parse --show-toplevel)"
git fetch -q origin
git rev-parse --verify -q origin/main >/dev/null || { AJUDA="git fetch origin (a branch origin/main não existe)."; false; }
if ! git diff --quiet origin/main -- ops/kit-unidade; then
  echo "AVISO: ops/kit-unidade aqui difere de origin/main. A VPS recebe a versão de origin/main (é o que o levar-kit-para-vps.sh manda), não esta."
fi

PUBLICO="ops/kit-unidade/unidades/$SLUG.yaml"
PRIVADO="$PRIVADO_DIR/$SLUG.yaml"
if [ -f "$PUBLICO" ] && [ -f "$PRIVADO" ]; then
  echo "o slug $SLUG existe nos DOIS lugares — não sei qual vale:"; echo "  $PUBLICO"; echo "  $PRIVADO"
  AJUDA="apague um deles (a clínica real fica só no privado)."; false
fi
if [ -f "$PUBLICO" ]; then
  QUESTIONARIO="$PUBLICO"; REAL=0
  git cat-file -e "origin/main:$PUBLICO" 2>/dev/null || { echo "o questionário $PUBLICO não está em origin/main, então a VPS não o receberia."; AJUDA="mescle o PR que o traz (ou grave a clínica real no privado)."; false; }
elif [ -f "$PRIVADO" ]; then
  QUESTIONARIO="$PRIVADO"; REAL=1
else
  echo "não achei o questionário de $SLUG em $PUBLICO nem em $PRIVADO."
  AJUDA="gere com a skill /nova-unidade (ou com o formulário do franqueado) e rode de novo."; false
fi
# só estas 3 coisas saem do questionário (nenhuma é dado pessoal); o resto nunca é lido nem impresso
campo() { # secao chave -> valor sem comentário, aspas e espaços
  awk -v sec="$1" -v key="$2" '
    /^[A-Za-z_]+:/ { s=$1; sub(/:.*/, "", s); atual=s; next }
    atual==sec { l=$0; sub(/^[ \t]+/, "", l); if (index(l, key ":")==1) { v=substr(l, length(key)+2); sub(/[ \t]+#.*$/, "", v); gsub(/^[ \t"]+|[ \t"]+$/, "", v); print v; exit } }' "$QUESTIONARIO"
}
SUB="$(campo chatwoot subdominio)"
TOKEN_META="$(campo meta token_env)"
MODO="$(campo whatsapp modo)"
[[ "$SUB" =~ ^[a-z0-9]{3,40}$ ]] || { echo "subdomínio do questionário inválido ou ausente («$SUB»): minúsculas e dígitos, 3 a 40."; AJUDA="corrija chatwoot.subdominio no questionário."; false; }
[[ "$TOKEN_META" =~ ^META_ADS_TOKEN_[A-Z0-9_]+$ ]] || { echo "meta.token_env inválido ou ausente («$TOKEN_META»): precisa ser META_ADS_TOKEN_<SUFIXO>."; AJUDA="corrija meta.token_env no questionário."; false; }
SUF="${TOKEN_META#META_ADS_TOKEN_}"
[ "$MODO" = "demonstracao" ] && TIPO="demonstração" || TIPO="clínica de verdade"
echo "clínica: $SLUG · $TIPO · subdomínio $SUB.doutordigitalconsultoria.com · sufixo das chaves $SUF"
if [ "$REAL" = "1" ]; then echo "questionário: privado (modo 600, vai direto para a VPS; não passa pelo GitHub)"; else echo "questionário: ops/kit-unidade/unidades/$SLUG.yaml (versionado, sem dado de verdade)"; fi

SSH=(ssh -i "$CHAVE" -o ConnectTimeout=15 -o ServerAliveInterval=30)
# `-t` + comando: terminal para as perguntas; o script NUNCA vai pelo stdin.
remoto() { "${SSH[@]}" -t "$VPS" "cd '$DESTINO' && $1"; }
levar() { CHAVE_SSH="$CHAVE" VPS="$VPS" DESTINO="$DESTINO" KIT_PRIVADO_DIR="$PRIVADO_DIR" bash "$AQUI/levar-kit-para-vps.sh" "$@"; }

passo "1b. a VPS responde?" "confira a internet e a chave (ssh -i $CHAVE $VPS). Se a chave tem senha, o ssh vai perguntar."
# shellcheck disable=SC2016  # o $(hostname) é para a VPS expandir, não esta máquina
"${SSH[@]}" "$VPS" 'echo "conectou em $(hostname)"' </dev/null

# ── --so-conferir: só olha ──────────────────────────────────────────────────────────────────────────────
if [ "$SO_CONFERIR" = "1" ]; then
  passo "2. o que seria enviado" "rode git fetch origin e tente de novo."
  levar --so-conferir
  [ "$REAL" = "1" ] && levar --questionario "$SLUG" --so-conferir
  passo "3. como a VPS está agora (só leitura)" "confira a conexão ssh."
  # só `test -s`: nenhum arquivo de segredo é lido, só se existe e não está vazio
  sondar() { if "${SSH[@]}" "$VPS" "$2" </dev/null; then echo "  $1: sim"; else echo "  $1: não"; fi; }
  K="$DESTINO/ops/kit-unidade"
  sondar "kit em $DESTINO" "test -s '$K/nova-unidade-joao.sh'"
  sondar "questionário de $SLUG na VPS" "test -s '$K/unidades/$SLUG.yaml' || test -s '$K/unidades/privado/$SLUG.yaml'"
  sondar "Platform App (token do Chatwoot)" "test -s /root/segredos/chatwoot-platform.token"
  sondar "chave da conta no cofre (CHATWOOT_API_TOKEN_$SUF)" "test -s '/root/segredos/kit/CHATWOOT_API_TOKEN_$SUF'"
  echo
  echo "SÓ CONFERIR: nada foi enviado nem mudado. Para abrir a clínica de verdade:  bash ops/kit-unidade/abrir-clinica-joao.sh $SLUG"
  trap - ERR
  exit 0
fi

# ── 2. leva o kit ───────────────────────────────────────────────────────────────────────────────────────
passo "2. levar o kit para a VPS" "rode: bash ops/kit-unidade/levar-kit-para-vps.sh --so-conferir (e veja a mensagem de erro dele)."
levar
if [ "$REAL" = "1" ]; then
  passo "2b. levar o questionário privado (modo 600)" "o questionário precisa estar em $PRIVADO, pasta 700 e arquivo 600 (chmod 700 pasta; chmod 600 arquivo)."
  levar --questionario "$SLUG"
fi

# ── 3. conferências ─────────────────────────────────────────────────────────────────────────────────────
passo "3a. o Platform App existe?" "rode de novo; se persistir, na VPS: bash $DESTINO/ops/kit-unidade/criar-platform-app-joao.sh --so-conferir"
remoto "bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir"
passo "3b. o contêiner do agente tem o kit?" "se disser que falta dist/scripts/nova-unidade.js: o deploy do PR da fase 2 precisa estar publicado antes."
remoto "bash ops/kit-unidade/nova-unidade-joao.sh '$SLUG' --so-conferir"
passo "3c. a regra do subdomínio (só olhar)" "se disser que o serviço chatwoot_franquias não existe, confira se o ssh caiu no host do Swarm."
remoto "bash ops/kit-unidade/regra-traefik-joao.sh '$SUB' --so-conferir"

# ── 4. plano em seco ────────────────────────────────────────────────────────────────────────────────────
passo "4. plano em SECO (nada é gravado)" "leia a mensagem acima: o questionário tem campo inválido (a mensagem diz qual). Corrija e rode de novo."
remoto "bash ops/kit-unidade/nova-unidade-joao.sh '$SLUG'"

# ── 5. a ÚNICA pergunta ─────────────────────────────────────────────────────────────────────────────────
PASSO="5. aplicar?"; AJUDA=""
echo
echo "━━ 5. aplicar?"
echo "Vou, nesta ordem: criar a conta/caixa/time/atendentes de «$SLUG» no CRM (o kit ainda pergunta antes de cada etapa),"
echo "acrescentar $SUB.doutordigitalconsultoria.com no proxy e levar as chaves da conta do cofre para o serviço ddagent_agent (REINICIA o serviço, ~1 min)."
echo "Não publique deploy enquanto isso roda."
printf 'Digite  aplicar  para seguir (qualquer outra coisa cancela, sem mudar nada): '
RESP=""
read -r RESP || RESP=""
if [ "$RESP" != "aplicar" ]; then
  echo "Cancelado. Nada foi aplicado (o kit já está na VPS; isso não muda nada no CRM)."
  trap - ERR
  exit 0
fi

# ── 6. aplica ───────────────────────────────────────────────────────────────────────────────────────────
passo "6a. Platform App (cria só se ainda não existir)" "na VPS: bash $DESTINO/ops/kit-unidade/criar-platform-app-joao.sh --so-conferir  (ele diz o que está errado)."
remoto "bash ops/kit-unidade/criar-platform-app-joao.sh"
passo "6b. criar a clínica no CRM (perguntas por etapa)" "leia o erro acima. Se você respondeu «não» a uma etapa, rode o comando de novo e responda «sim»: o que já existe é reconhecido."
remoto "bash ops/kit-unidade/nova-unidade-joao.sh '$SLUG' --aplicar"

# ── 7. subdomínio e chaves ──────────────────────────────────────────────────────────────────────────────
passo "7a. subdomínio no proxy" "na VPS: bash $DESTINO/ops/kit-unidade/regra-traefik-joao.sh $SUB --so-conferir"
remoto "bash ops/kit-unidade/regra-traefik-joao.sh '$SUB'"
passo "7b. chaves da conta: cofre → serviço" "se faltar chave no cofre, a etapa «conta» do passo 6b não rodou: rode o comando de novo e responda «sim» a ela. Se disser valor DIFERENTE no .env, confira à mão (não troco sozinho)."
remoto "bash ops/kit-unidade/cofre-para-servico-joao.sh '$SUF' --so-conferir"
remoto "bash ops/kit-unidade/cofre-para-servico-joao.sh '$SUF'"

# ── 8. o que falta ──────────────────────────────────────────────────────────────────────────────────────
PASSO="resumo"; AJUDA=""
trap - ERR
echo
echo "━━ PRONTO: «$SLUG» está criada no CRM ($TIPO). O que ainda FALTA (nada disso é automático):"
n=1
falta() { echo "  $n. $1"; n=$((n+1)); }
if [ "$MODO" = "demonstracao" ]; then
  falta "NÚMERO/MODELOS: não se aplicam (demonstração: caixa API, modelos em seco). Para virar clínica de verdade: modo real, número e WABA no questionário, e rodar este comando de novo."
else
  falta "NÚMERO: conectar o número oficial ao Kapso (coexistência ou número novo) — quem tem o celular da clínica."
  falta "MODELOS NA META: conferir em Kapso → Modelos (ficam pendentes de minutos a 48 h até a Meta aprovar)."
fi
falta "ATENDENTES: cada uma aceita o convite por e-mail e define a senha; só então cria as 10 pastas dela."
falta "FRANQUIA: gravar o token da API da franquia (units.spine_token), ligar spine_enabled e definir os turnos por profissional."
falta "CONFERIR NO CRM: abrir https://$SUB.doutordigitalconsultoria.com/ (o certificado sai no primeiro acesso)."
falta "TESTE DA SOFIA: rodar os testes de prompt da unidade e o dono ler as respostas ANTES de ligar."
falta "SÓ DEPOIS DO TESTE, ligar o robô:  ssh -t -i $CHAVE $VPS \"cd $DESTINO && bash ops/kit-unidade/nova-unidade-joao.sh '$SLUG' --aplicar --ligar-robo\""
falta "AUTOMAÇÕES ficam em SECO por 24 h; a unidade nasce inativa — ativar na tela da unidade quando tudo estiver de pé."
