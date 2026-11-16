#!/usr/bin/env bash
# CRIA UM USUÁRIO DA DOUTOR DIGITAL NO CRM (Chatwoot) e o põe como ADMINISTRADOR em TODAS as contas (todas as clínicas).
#
#   (na VPS, como root)
#   bash criar-usuario-dd-joao.sh --so-conferir                       # mostra as contas e o que esse e-mail tem em cada uma; não muda nada
#   bash criar-usuario-dd-joao.sh                                     # cria (se não existe) e dá administrador nas contas que faltam
#   EMAIL_NOVO=outra@pessoa.com NOME_NOVO="Fulana · Doutor Digital" bash criar-usuario-dd-joao.sh --so-conferir
#
# Sem SMTP o convite por e-mail não chega: por isso o usuário nasce CONFIRMADO, com uma senha forte gerada AQUI, gravada em
# /root/segredos/crm-<e-mail>.senha (modo 600) e NUNCA impressa. Para entrar: `cat` do arquivo no servidor, login, e troque a senha no Perfil.
# Se o usuário JÁ EXISTE, a senha dele NÃO é mexida (só ganha administrador onde falta). Papel de quem já está numa conta como agente vira administrador.
# Não cria Platform App nem permissão de plataforma sobre este usuário (o token do kit nunca pode entrar como ele).
set -euo pipefail
umask 077
EMAIL_NOVO="${EMAIL_NOVO:-doutordigitalconsultoria@gmail.com}"
NOME_NOVO="${NOME_NOVO:-João · Doutor Digital}"
SO_CONFERIR=0
for arg in "$@"; do
  case "$arg" in
    --so-conferir) SO_CONFERIR=1 ;;
    *) echo "argumento desconhecido: $arg (use só --so-conferir)"; exit 2 ;;
  esac
done
[[ "$EMAIL_NOVO" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "e-mail inválido: $EMAIL_NOVO"; exit 2; }
SENHA_ARQ="/root/segredos/crm-${EMAIL_NOVO//[^A-Za-z0-9._-]/_}.senha"

# O contêiner MAIS NOVO do chatwoot_rails (no rolling update `head -1` pegaria o antigo)
C="$(docker ps --filter "name=chatwoot_rails" --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)"
[ -n "$C" ] || { echo "ERRO: não achei o contêiner chatwoot_rails neste host."; exit 1; }

# O código Ruby não leva segredo: a senha entra pelo ambiente do `docker exec` (-e SENHA_NOVA, sem valor na linha de comando).
read -r -d '' RUBY <<'RB' || true
email = ENV.fetch('EMAIL_NOVO'); nome = ENV.fetch('NOME_NOVO')
u = User.find_by(email: email)
contas = Account.order(:id).to_a
puts "LINHA: usuário #{email}: #{u ? "já existe (id #{u.id})" : 'não existe'}"
contas.each do |a|
  au = u && AccountUser.find_by(account_id: a.id, user_id: u.id)
  puts "LINHA: conta #{a.id} (#{a.name}): #{au ? au.role : 'sem acesso'}"
end
if ENV['SO_CONFERIR'] == '1'
  puts 'FIM:conferido'
  exit 0
end
criado = false
unless u
  s = ENV.fetch('SENHA_NOVA')
  u = User.new(name: nome, email: email, password: s, password_confirmation: s)
  u.skip_confirmation!
  u.save!
  criado = true
  puts "LINHA: CRIADO o usuário #{u.id} (#{nome}), já confirmado"
end
contas.each do |a|
  au = AccountUser.find_or_initialize_by(account_id: a.id, user_id: u.id)
  if au.new_record?
    au.role = :administrator
    au.save!
    puts "LINHA: conta #{a.id} (#{a.name}): agora ADMINISTRADOR"
  elsif au.role.to_s != 'administrator'
    antes = au.role
    au.update!(role: :administrator)
    puts "LINHA: conta #{a.id} (#{a.name}): era #{antes}, agora ADMINISTRADOR"
  else
    puts "LINHA: conta #{a.id} (#{a.name}): já era administrador"
  end
end
puts(criado ? 'FIM:senha-usada' : 'FIM:senha-nao-usada')
RB

if [ "$SO_CONFERIR" = 1 ]; then
  SAIDA="$(EMAIL_NOVO="$EMAIL_NOVO" NOME_NOVO="$NOME_NOVO" SO_CONFERIR=1 docker exec -e EMAIL_NOVO -e NOME_NOVO -e SO_CONFERIR "$C" bundle exec rails runner "$RUBY" 2>&1)" || { echo "ERRO no rails:"; printf '%s\n' "$SAIDA" | tail -5; exit 1; }
  printf '%s\n' "$SAIDA" | sed -n 's/^LINHA: /  /p'
  echo "SÓ CONFERIR: nada foi mudado. Rodando sem --so-conferir, crio o usuário (se faltar) e dou administrador nas contas que faltam."
  exit 0
fi

mkdir -p /root/segredos && chmod 700 /root/segredos
NOVA=0
if [ ! -s "$SENHA_ARQ" ]; then
  # forte e dentro da regra do Chatwoot (maiúscula, minúscula, número e símbolo)
  printf 'Dd9!%s\n' "$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20)" > "$SENHA_ARQ"
  chmod 600 "$SENHA_ARQ"
  NOVA=1
fi
SAIDA="$(EMAIL_NOVO="$EMAIL_NOVO" NOME_NOVO="$NOME_NOVO" SENHA_NOVA="$(head -1 "$SENHA_ARQ")" docker exec -e EMAIL_NOVO -e NOME_NOVO -e SENHA_NOVA "$C" bundle exec rails runner "$RUBY" 2>&1)" || {
  echo "ERRO no rails (nada impresso da senha):"; printf '%s\n' "$SAIDA" | grep -v "Dd9!" | tail -5
  [ "$NOVA" = 1 ] && rm -f "$SENHA_ARQ"
  exit 1
}
printf '%s\n' "$SAIDA" | sed -n 's/^LINHA: /  /p'
if printf '%s\n' "$SAIDA" | grep -q '^FIM:senha-usada'; then
  echo "PRONTO. Senha em $SENHA_ARQ (modo 600, não impressa)."
  echo "ENTRAR: veja a senha com   cat $SENHA_ARQ   , entre em https://atendimento.doutordigitalconsultoria.com com $EMAIL_NOVO,"
  echo "        TROQUE a senha no Perfil e depois apague o arquivo:   rm $SENHA_ARQ"
else
  [ "$NOVA" = 1 ] && rm -f "$SENHA_ARQ"
  echo "PRONTO. O usuário já existia: a senha dele NÃO foi mexida."
fi
