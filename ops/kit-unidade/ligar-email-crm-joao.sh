#!/usr/bin/env bash
# LIGA O E-MAIL DO CRM (convite de atendente, «esqueci a senha») pelo Gmail da Doutor Digital, com uma SENHA DE APP do Google.
#
# Antes: no Google da Doutor Digital, com a verificação em duas etapas ligada, crie a senha de app em https://myaccount.google.com/apppasswords
# (nome: «CRM»). O Google mostra 16 letras — elas vão direto para o prompt deste script, nunca para chat, arquivo ou print.
#
#   (do SEU computador — o -t é o que deixa o script pedir a senha sem mostrar)
#   ssh -t -i ~/.ssh/doutordigital_vps root@89.116.214.130 'bash /root/kit/ops/kit-unidade/ligar-email-crm-joao.sh --so-conferir'
#   ssh -t -i ~/.ssh/doutordigital_vps root@89.116.214.130 'bash /root/kit/ops/kit-unidade/ligar-email-crm-joao.sh'
#
# O que faz: testa o login no Gmail com a senha (se o Google recusar, NADA é gravado); grava SMTP_* e MAILER_SENDER_EMAIL no /root/chatwoot.env
# (cópia antes; o próximo `docker stack deploy` do Chatwoot já sobe com eles) e reinicia SÓ o chatwoot_sidekiq — é ele que manda os e-mails
# (o Chatwoot envia por fila). O CRM (chatwoot_rails) NÃO sai do ar. A senha nunca é impressa e nunca vai na linha de comando (ps): entra no
# docker pelo ambiente (`--env-add NOME`, sem valor). Se o arquivo já tem e-mail configurado, o script PARA (não troca sozinho).
set -euo pipefail
umask 077
REMETENTE="${REMETENTE:-doutordigitalconsultoria@gmail.com}"
REMETENTE="${REMETENTE,,}"
ENVF="${CHATWOOT_ENV_ARQUIVO:-/root/chatwoot.env}"
SVC=chatwoot_sidekiq
SO_CONFERIR=0
for a in "$@"; do
  case "$a" in
    --so-conferir) SO_CONFERIR=1 ;;
    *) echo "argumento desconhecido: $a (use só --so-conferir)"; exit 2 ;;
  esac
done
[[ "$REMETENTE" =~ ^[a-z0-9._%+-]+@gmail\.com$ ]] || { echo "este script é para Gmail: $REMETENTE"; exit 2; }
[ -f "$ENVF" ] || { echo "não achei $ENVF"; exit 1; }
docker service inspect "$SVC" >/dev/null 2>&1 || { echo "não achei o serviço $SVC"; exit 1; }
# o contêiner MAIS NOVO do rails (no rolling update `head -1` pegaria o antigo): é nele que o teste de login roda
RAILS="$(docker ps --filter "name=chatwoot_rails" --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$RAILS" ] || { echo "não achei o contêiner chatwoot_rails neste host"; exit 1; }

if grep -qE '^(SMTP_[A-Z_]+|MAILER_SENDER_EMAIL)=' "$ENVF"; then
  echo "PARO: $ENVF JÁ tem e-mail configurado ($(grep -oE '^(SMTP_[A-Z_]+|MAILER_SENDER_EMAIL)=' "$ENVF" | tr -d = | tr '\n' ' '))."
  echo "Não troco sozinho. Para trocar a senha de app: faça uma cópia do arquivo, apague essas linhas e rode de novo."
  exit 1
fi
NO_SVC="$(docker service inspect "$SVC" --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep -cE '^SMTP_ADDRESS=' || true)"
echo "  $ENVF: sem e-mail configurado"
echo "  serviço $SVC: e-mail $([ "$NO_SVC" -gt 0 ] && echo 'JÁ configurado' || echo 'não configurado')"
echo "  vai ficar: remetente «Doutor Digital <$REMETENTE>», smtp.gmail.com:587 (STARTTLS)"
if [ "$SO_CONFERIR" = 1 ]; then
  echo "SÓ CONFERIR: nada foi mudado. Sem --so-conferir eu peço a senha de app (não aparece na tela), testo no Gmail, gravo e reinicio só o envio de e-mails."
  exit 0
fi
[ -t 0 ] || { echo "Preciso de um terminal para pedir a senha sem mostrar: rode com  ssh -t  (veja o topo do arquivo)."; exit 2; }

printf 'Cole a SENHA DE APP do Google (16 letras; não aparece na tela) e tecle Enter: '
IFS= read -rs SENHA; echo
SENHA="${SENHA// /}"
[[ "$SENHA" =~ ^[A-Za-z]{16}$ ]] || { unset SENHA; echo "Isso não parece uma senha de app do Google (16 letras). Nada foi gravado."; exit 1; }
export SMTP_TESTE_USUARIO="$REMETENTE" SMTP_TESTE_SENHA="$SENHA"

# 1) o Google aceita? (só login, não manda e-mail)
TESTE="$(docker exec -e SMTP_TESTE_USUARIO -e SMTP_TESTE_SENHA "$RAILS" bundle exec ruby -rnet/smtp -e '
  s = Net::SMTP.new("smtp.gmail.com", 587); s.enable_starttls; s.open_timeout = 15; s.read_timeout = 15
  begin
    s.start(helo: "gmail.com", user: ENV["SMTP_TESTE_USUARIO"], secret: ENV["SMTP_TESTE_SENHA"], authtype: :plain) { puts "SMTP_OK" }
  rescue => e
    puts "SMTP_FALHOU #{e.class}"
  end' 2>&1 | grep -E '^SMTP_(OK|FALHOU)' | tail -1 || true)"
unset SMTP_TESTE_USUARIO SMTP_TESTE_SENHA
if [ "$TESTE" != "SMTP_OK" ]; then
  unset SENHA
  echo "O Gmail RECUSOU o login (${TESTE:-sem resposta}). Nada foi gravado. Confira a senha de app (e se a verificação em duas etapas está ligada) e rode de novo."
  exit 1
fi
echo "  Gmail aceitou o login."

# 2) grava no arquivo do Chatwoot (com cópia)
BAK="$ENVF.bak-$(date +%d-%m-%H%M)-email"
cp -p "$ENVF" "$BAK"
[ -n "$(tail -c1 "$ENVF")" ] && printf '\n' >> "$ENVF"
{
  printf 'MAILER_SENDER_EMAIL=Doutor Digital <%s>\n' "$REMETENTE"
  printf 'SMTP_ADDRESS=smtp.gmail.com\nSMTP_PORT=587\nSMTP_DOMAIN=gmail.com\nSMTP_AUTHENTICATION=plain\nSMTP_ENABLE_STARTTLS_AUTO=true\nSMTP_OPENSSL_VERIFY_MODE=peer\n'
  printf 'SMTP_USERNAME=%s\n' "$REMETENTE"
  printf 'SMTP_PASSWORD=%s\n' "$SENHA"
} >> "$ENVF"
echo "  $ENVF: gravado (cópia em $BAK)"

# 3) põe no sidekiq que está no ar — valores pelo AMBIENTE do docker (--env-add NOME, sem valor na linha de comando)
NOMES=(MAILER_SENDER_EMAIL SMTP_ADDRESS SMTP_PORT SMTP_DOMAIN SMTP_AUTHENTICATION SMTP_ENABLE_STARTTLS_AUTO SMTP_OPENSSL_VERIFY_MODE SMTP_USERNAME SMTP_PASSWORD)
echo "  reiniciando só o envio de e-mails ($SVC)…"
(
  export MAILER_SENDER_EMAIL="Doutor Digital <$REMETENTE>" SMTP_ADDRESS=smtp.gmail.com SMTP_PORT=587 SMTP_DOMAIN=gmail.com SMTP_AUTHENTICATION=plain \
         SMTP_ENABLE_STARTTLS_AUTO=true SMTP_OPENSSL_VERIFY_MODE=peer SMTP_USERNAME="$REMETENTE" SMTP_PASSWORD="$SENHA"
  ARGS=(); for n in "${NOMES[@]}"; do ARGS+=(--env-add "$n"); done
  docker service update --detach=false --quiet "${ARGS[@]}" "$SVC" >/dev/null
)
unset SENHA

# 4) confere: o contêiner novo está de pé e tem as variáveis (só os NOMES)
C="$(docker ps --filter "name=$SVC" --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$C" ] || { echo "ATENÇÃO: não achei o contêiner novo do $SVC. Rode: docker service ps $SVC"; exit 1; }
FALTA=0
for n in "${NOMES[@]}"; do
  docker exec "$C" sh -c "test -n \"\${$n:-}\"" || { echo "  AUSENTE no contêiner: $n"; FALTA=1; }
done
[ "$FALTA" = 0 ] || { echo "ERRO: o envio de e-mails subiu sem a configuração completa."; exit 1; }
echo "PRONTO. E-mail do CRM ligado (remetente $REMETENTE). Teste: tela «Esqueci a senha» do CRM com doutordigitalconsultoria@gmail.com — o e-mail chega em 1–2 min."
echo "O CRM (chatwoot_rails) pega a configuração no próximo deploy do Chatwoot; para mandar e-mail ele não precisa (quem manda é o $SVC)."
