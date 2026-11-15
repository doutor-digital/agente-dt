#!/usr/bin/env bash
# LEVA A PASTA ops/kit-unidade PARA A VPS. Roda na SUA máquina (dentro do repositório agente-dt), não na VPS. Manda o que está em origin/main, por tar sobre ssh,
# para /root/kit na VPS. (Na VPS há cópias do repositório em /home/joaoof/agente-dt e /home/suporte-ia/agente-dt — são de outros usos e podem estar em outro
# commit —; só /opt/doutordigital/agente-dt, onde mora o stack, NÃO tem cópia: lá só existe o docker-compose.yml. /root/kit é o caminho recomendado para o kit.)
#
#   bash ops/kit-unidade/levar-kit-para-vps.sh --so-conferir   # lista o que seria enviado; não abre o ssh
#   bash ops/kit-unidade/levar-kit-para-vps.sh                 # envia
#   bash ops/kit-unidade/levar-kit-para-vps.sh --questionario <slug> [--so-conferir]   # manda SÓ o questionário de uma clínica real (ver abaixo)
#
# A pasta da VPS (DESTINO/ops/kit-unidade) é SUBSTITUÍDA por inteiro (chega numa pasta temporária ao lado e só então troca): script apagado ou renomeado no repositório
# não sobra lá. Só essa pasta é trocada; o cofre dos segredos (/root/segredos/kit) e o resto de /root/kit não são tocados.
#
# DEPOIS, na VPS (como root):   cd /root/kit && bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir   (e os demais scripts, de /root/kit)
# Os scripts descobrem as pastas pelo próprio endereço (dirname), então funcionam de /root/kit/ops/kit-unidade.
#
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps), DESTINO (padrão /root/kit), REF (padrão origin/main).
# Nada de segredo passa por aqui: o kit são scripts, molde da Sofia e questionários.
#
# QUESTIONÁRIO DE CLÍNICA REAL (e-mail das atendentes, chave Pix, telefone = dado pessoal) NÃO está no GitHub: fica em ops/kit-unidade/unidades/privado/<slug>.yaml na SUA máquina
# (pasta no .gitignore). `--questionario <slug>` manda SÓ esse arquivo para DESTINO/ops/kit-unidade/unidades/privado/ na VPS, modo 600 (não troca a pasta do kit). A troca da
# pasta do kit preserva o que já está em unidades/privado/ na VPS.
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
DESTINO="${DESTINO:-/root/kit}"
REF="${REF:-origin/main}"
SO_CONFERIR=0
QUESTIONARIO=""
# argumento desconhecido é RECUSADO (nada de enviar o que não era para enviar por causa de um erro de digitação)
while [ $# -gt 0 ]; do
  case "$1" in
    --so-conferir) SO_CONFERIR=1 ;;
    --questionario) shift; QUESTIONARIO="${1:-}"; [ -n "$QUESTIONARIO" ] || { echo "--questionario precisa do slug"; exit 2; } ;;
    *) echo "argumento desconhecido: $1 (use --so-conferir e/ou --questionario <slug>)"; exit 2 ;;
  esac
  shift
done

[[ "$DESTINO" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "DESTINO inválido: $DESTINO"; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "ERRO: rode dentro do repositório agente-dt (na sua máquina)."; exit 1; }
# `git archive ops/kit-unidade` é relativo à pasta onde se está: entra na RAIZ do repositório antes (rodar de dentro de ops/ ou backend/ também funciona)
cd "$(git rev-parse --show-toplevel)"
git fetch -q origin
git rev-parse --verify -q "$REF" >/dev/null || { echo "ERRO: $REF não existe (git fetch origin)."; exit 1; }

# ── só o QUESTIONÁRIO de uma clínica REAL (dado pessoal: não está no git; vai pela sua máquina para a VPS, modo 600) ──
if [ -n "$QUESTIONARIO" ]; then
  [[ "$QUESTIONARIO" =~ ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$ ]] || { echo "slug inválido: $QUESTIONARIO"; exit 2; }
  ORIGEM="ops/kit-unidade/unidades/privado/$QUESTIONARIO.yaml"
  [ -f "$ORIGEM" ] || { echo "ERRO: não achei $ORIGEM (a skill /nova-unidade grava a clínica real aí)."; exit 1; }
  git check-ignore -q "$ORIGEM" || { echo "ERRO: $ORIGEM NÃO está ignorado pelo git (unidades/privado/ no .gitignore): não vou mexer com dado pessoal fora do lugar combinado."; exit 1; }
  echo "enviando SÓ o questionário $QUESTIONARIO ($(wc -c < "$ORIGEM") bytes; o conteúdo não é impresso) para $VPS:$DESTINO/ops/kit-unidade/unidades/privado/ (modo 600)"
  if [ "$SO_CONFERIR" = "1" ]; then echo "SÓ CONFERIR: nada foi enviado."; exit 0; fi
  [ -r "$CHAVE" ] || { echo "ERRO: não achei a chave ssh $CHAVE (CHAVE_SSH)."; exit 1; }
  P="$DESTINO/ops/kit-unidade/unidades/privado"
  ssh -i "$CHAVE" "$VPS" "set -e; umask 077; mkdir -p '$P'; chmod 700 '$P'; cat > '$P/$QUESTIONARIO.yaml.chegando'; chmod 600 '$P/$QUESTIONARIO.yaml.chegando'; mv '$P/$QUESTIONARIO.yaml.chegando' '$P/$QUESTIONARIO.yaml'" < "$ORIGEM"
  echo "PRONTO: $P/$QUESTIONARIO.yaml na VPS (modo 600)."
  echo "PRÓXIMO (na VPS, como root):  cd $DESTINO && bash ops/kit-unidade/nova-unidade-joao.sh $QUESTIONARIO --so-conferir"
  exit 0
fi

echo "enviando ops/kit-unidade de $REF ($(git rev-parse --short "$REF")) para $VPS:$DESTINO"
if [ "$SO_CONFERIR" = "1" ]; then
  git archive "$REF" ops/kit-unidade | tar -t | grep -v '/$' | sed 's/^/  /'
  echo "SÓ CONFERIR: nada foi enviado."
  exit 0
fi
[ -r "$CHAVE" ] || { echo "ERRO: não achei a chave ssh $CHAVE (CHAVE_SSH)."; exit 1; }

# `tar` sobre ssh: sem `docker exec -i` nem `bash -s` no meio (que engoliriam o stdin)
# O tar chega numa pasta TEMPORÁRIA ao lado e a pasta do kit é trocada por inteiro (nada de arquivo velho sobrando)
git archive "$REF" ops/kit-unidade | ssh -i "$CHAVE" "$VPS" "set -e; D='$DESTINO'; T=\"\$D/.chegando.\$\$\"; rm -rf \"\$T\"; mkdir -p \"\$T\" \"\$D/ops\"; tar -x -C \"\$T\"; if [ -d \"\$D/ops/kit-unidade/unidades/privado\" ]; then mkdir -p \"\$T/ops/kit-unidade/unidades\"; mv \"\$D/ops/kit-unidade/unidades/privado\" \"\$T/ops/kit-unidade/unidades/privado\"; fi; rm -rf \"\$D/ops/kit-unidade\"; mv \"\$T/ops/kit-unidade\" \"\$D/ops/kit-unidade\"; rm -rf \"\$T\""
ssh -i "$CHAVE" "$VPS" "ls '$DESTINO/ops/kit-unidade' | head -20" </dev/null
echo "PRONTO: o kit está em $DESTINO/ops/kit-unidade na VPS."
echo "PRÓXIMO (na VPS, como root):  cd $DESTINO && bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir"
