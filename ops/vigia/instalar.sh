#!/usr/bin/env bash
# INSTALA o vigia na VPS de produção. NÃO liga cron nenhum: copia, ajusta permissão e imprime as
# linhas de cron para o João colar quando quiser. Rodar da máquina dele (precisa da chave do root).
#
#   bash ops/vigia/instalar.sh            # copia e imprime o que falta fazer
#   bash ops/vigia/instalar.sh --conferir # só confere o que já está lá
set -uo pipefail
VPS="${VIGIA_VPS:-root@89.116.214.130}"
RAIZ="${VIGIA_RAIZ_VPS:-/root/vigia-petropolis}"
AQUI="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "--conferir" ]; then
  ssh -o BatchMode=yes "$VPS" "ls -la $RAIZ 2>/dev/null; echo '--- cron do vigia:'; crontab -l | grep -c vigia-unidade"
  exit 0
fi

ssh -o BatchMode=yes "$VPS" "mkdir -p $RAIZ/fila && chmod 700 $RAIZ $RAIZ/fila"
scp -q -o BatchMode=yes "$AQUI/medir-unidade.mjs" "$AQUI/vigia-unidade.py" "$VPS:$RAIZ/"
ssh -o BatchMode=yes "$VPS" "chmod 700 $RAIZ/vigia-unidade.py; chmod 600 $RAIZ/medir-unidade.mjs; ls -la $RAIZ"

cat <<'FIM'

Copiado. O que FALTA (nada disso foi feito por este script):

1) O destino do alerta, que a dona ainda não definiu. Na VPS, com chmod 600:
     printf 'VIGIA_TELEGRAM_CHAT=<id do canal da gestão>\n' > /root/.vigia-petropolis.env
     chmod 600 /root/.vigia-petropolis.env
   Sem esse arquivo o vigia roda e NÃO manda nada (fica em seco e diz o porquê).

2) Uma rodada de ensaio, em seco, para ver o placar de hoje:
     /usr/bin/python3 /root/vigia-petropolis/vigia-unidade.py --profundo

3) O cron — colar no `crontab -e` do root SÓ quando a decisão (1) estiver tomada:
     # vigia de Petrópolis: de hora em hora no plantão (passo leve, ~1 min)
     7 8-19 * * 1-6 /usr/bin/flock -n /tmp/vigia-petropolis.lock /usr/bin/python3 /root/vigia-petropolis/vigia-unidade.py --enviar >> /root/vigia-petropolis/vigia.log 2>&1
     # passo fundo, 1×/dia às 9h05 (mede madrugada, estoque do mês e avaliações)
     5 9 * * 1-6 /usr/bin/flock -w 300 /tmp/vigia-petropolis.lock /usr/bin/python3 /root/vigia-petropolis/vigia-unidade.py --profundo --enviar >> /root/vigia-petropolis/vigia.log 2>&1

4) O auditor acorda na MÁQUINA DO JOÃO (a VPS não tem o CLI do Claude). No `crontab -e` dele:
     */20 8-19 * * 1-6 /home/joaoof/wt-vigia/ops/vigia/acordar-auditor.sh >> /home/joaoof/.vigia-petropolis/auditor.log 2>&1

FIM
