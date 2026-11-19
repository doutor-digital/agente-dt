#!/usr/bin/env bash
# ROTINA DOS «JOHN DOE» DO MESSENGER (caixa 8 da conta 1): a cada 10 min, na VPS, troca o nome «John Doe» pelo nome real da pessoa
# (a Meta nega o perfil ao Chatwoot, mas entrega o nome na conversa da página). Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho).
# Mora no CRON DA VPS (/etc/cron.d/crm-nomes-messenger -> /root/kit/crm-historico-social/nomes-messenger-cron.sh -> rails runner no
# contêiner chatwoot_rails). Só ids e contagens no log (/root/kit/logs/nomes-messenger.log). Sem nome de paciente em lugar nenhum.
#
#   bash ops/nomes-messenger-crm-joao.sh --so-conferir   # leva o código, roda UMA vez em seco (conta os «John Doe» e os que teriam nome); não grava nem liga cron
#   bash ops/nomes-messenger-crm-joao.sh --ligar         # leva o código e liga o cron de 10 em 10 min (sem sudo: é root da VPS)
#   bash ops/nomes-messenger-crm-joao.sh --desligar      # tira o cron (o código fica em /root/kit/crm-historico-social)
#   bash ops/nomes-messenger-crm-joao.sh --status        # cron ligado? últimas linhas do log
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail
VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASTA="$AQUI/crm-historico-social"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
[ $# -eq 1 ] || { echo "uso: $0 --so-conferir | --ligar | --desligar | --status"; exit 2; }
SSH=(ssh -i "$CHAVE" -o ConnectTimeout=15 "$VPS")
CRON=/etc/cron.d/crm-nomes-messenger

levar() {
  tar czf - -C "$PASTA" historico_social.rb corrigir-nomes-messenger.rb nomes-messenger-cron.sh \
    | "${SSH[@]}" 'mkdir -p /root/kit/crm-historico-social /root/kit/logs && tar xzf - -C /root/kit/crm-historico-social && chmod +x /root/kit/crm-historico-social/nomes-messenger-cron.sh'
}

case "$1" in
  --so-conferir)
    levar
    "${SSH[@]}" 'R=$(docker ps --filter name=chatwoot_rails --format "{{.CreatedAt}}|{{.ID}}" | sort -r | head -1 | cut -d"|" -f2); [ -n "$R" ] || { echo "ERRO: sem contêiner chatwoot_rails"; exit 1; }; docker exec "$R" mkdir -p /tmp/crm-historico-social && docker cp /root/kit/crm-historico-social/. "$R:/tmp/crm-historico-social/" >/dev/null && docker exec -e GRAVAR=0 -e CAIXA=8 -e DIAS=0 -e MAXIMO=50 "$R" bundle exec rails runner /tmp/crm-historico-social/corrigir-nomes-messenger.rb 2>&1 | grep -E "^LOG "'
    echo "(seco: nada foi gravado e nenhum cron foi ligado)"
    ;;
  --ligar)
    levar
    "${SSH[@]}" "printf '%s\n' '# Corrige os John Doe do Messenger (CRM Doutor Digital). Código: /root/kit/crm-historico-social. Parar sem desinstalar: touch /root/kit/crm-historico-social/PARAR' '*/10 * * * * root /usr/bin/flock -n /var/lock/crm-nomes-messenger.lock /root/kit/crm-historico-social/nomes-messenger-cron.sh >> /root/kit/logs/nomes-messenger.log 2>&1' > $CRON && chmod 644 $CRON && echo 'cron ligado:' && cat $CRON"
    echo "Acompanhe: bash ops/nomes-messenger-crm-joao.sh --status  (a 1ª linha aparece em até 10 min)"
    ;;
  --desligar)
    "${SSH[@]}" "rm -f $CRON && echo 'cron desligado (código mantido em /root/kit/crm-historico-social)'"
    ;;
  --status)
    "${SSH[@]}" "if [ -f $CRON ]; then echo 'cron: LIGADO'; else echo 'cron: desligado'; fi; [ -e /root/kit/crm-historico-social/PARAR ] && echo 'arquivo PARAR existe (cron não faz nada)'; tail -n 8 /root/kit/logs/nomes-messenger.log 2>/dev/null || echo '(sem log ainda)'"
    ;;
  *) echo "opção inválida: $1 (use --so-conferir, --ligar, --desligar ou --status)"; exit 2 ;;
esac
