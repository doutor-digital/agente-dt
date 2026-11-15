#!/usr/bin/env bash
# LEVA A PASTA ops/kit-unidade PARA A VPS. Roda na SUA máquina (dentro do repositório agente-dt), não na VPS. Manda o que está em origin/main, por tar sobre ssh,
# para /root/kit na VPS. (Na VPS há cópias do repositório em /home/joaoof/agente-dt e /home/suporte-ia/agente-dt — são de outros usos e podem estar em outro
# commit —; só /opt/doutordigital/agente-dt, onde mora o stack, NÃO tem cópia: lá só existe o docker-compose.yml. /root/kit é o caminho recomendado para o kit.)
#
#   bash ops/kit-unidade/levar-kit-para-vps.sh --so-conferir   # lista o que seria enviado; não abre o ssh
#   bash ops/kit-unidade/levar-kit-para-vps.sh                 # envia
#
# A pasta da VPS (DESTINO/ops/kit-unidade) é SUBSTITUÍDA por inteiro (chega numa pasta temporária ao lado e só então troca): script apagado ou renomeado no repositório
# não sobra lá. Só essa pasta é trocada; o cofre dos segredos (/root/segredos/kit) e o resto de /root/kit não são tocados.
#
# DEPOIS, na VPS (como root):   cd /root/kit && bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir   (e os demais scripts, de /root/kit)
# Os scripts descobrem as pastas pelo próprio endereço (dirname), então funcionam de /root/kit/ops/kit-unidade.
#
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps), DESTINO (padrão /root/kit), REF (padrão origin/main).
# Nada de segredo passa por aqui: o kit são scripts, molde da Sofia e questionários.
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
DESTINO="${DESTINO:-/root/kit}"
REF="${REF:-origin/main}"
SO_CONFERIR=0
[ "${1:-}" = "--so-conferir" ] && SO_CONFERIR=1

[[ "$DESTINO" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "DESTINO inválido: $DESTINO"; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "ERRO: rode dentro do repositório agente-dt (na sua máquina)."; exit 1; }
# `git archive ops/kit-unidade` é relativo à pasta onde se está: entra na RAIZ do repositório antes (rodar de dentro de ops/ ou backend/ também funciona)
cd "$(git rev-parse --show-toplevel)"
git fetch -q origin
git rev-parse --verify -q "$REF" >/dev/null || { echo "ERRO: $REF não existe (git fetch origin)."; exit 1; }

echo "enviando ops/kit-unidade de $REF ($(git rev-parse --short "$REF")) para $VPS:$DESTINO"
if [ "$SO_CONFERIR" = "1" ]; then
  git archive "$REF" ops/kit-unidade | tar -t | grep -v '/$' | sed 's/^/  /'
  echo "SÓ CONFERIR: nada foi enviado."
  exit 0
fi
[ -r "$CHAVE" ] || { echo "ERRO: não achei a chave ssh $CHAVE (CHAVE_SSH)."; exit 1; }

# `tar` sobre ssh: sem `docker exec -i` nem `bash -s` no meio (que engoliriam o stdin)
# O tar chega numa pasta TEMPORÁRIA ao lado e a pasta do kit é trocada por inteiro (nada de arquivo velho sobrando)
git archive "$REF" ops/kit-unidade | ssh -i "$CHAVE" "$VPS" "set -e; D='$DESTINO'; T=\"\$D/.chegando.\$\$\"; rm -rf \"\$T\"; mkdir -p \"\$T\" \"\$D/ops\"; tar -x -C \"\$T\"; rm -rf \"\$D/ops/kit-unidade\"; mv \"\$T/ops/kit-unidade\" \"\$D/ops/kit-unidade\"; rm -rf \"\$T\""
ssh -i "$CHAVE" "$VPS" "ls '$DESTINO/ops/kit-unidade' | head -20" </dev/null
echo "PRONTO: o kit está em $DESTINO/ops/kit-unidade na VPS."
echo "PRÓXIMO (na VPS, como root):  cd $DESTINO && bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir"
