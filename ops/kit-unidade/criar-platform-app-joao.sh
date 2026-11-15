#!/usr/bin/env bash
# CRIA O «PLATFORM APP» DO CHATWOOT (uma vez) e DÁ A ELE ACESSO aos usuários que já existem (a Doutor Digital) — o token que deixa o kit criar contas e usuários.
# Roda na VPS, no host do Swarm, como root (sem colar nada). O token vai DIRETO para um arquivo modo 600 e NUNCA é impresso nem passa por /tmp.
#
#   bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir   # só diz o que existe e o que faltaria; não cria nada
#   bash ops/kit-unidade/criar-platform-app-joao.sh                 # cria (ou confere) o Platform App e o acesso aos usuários
#   bash ops/kit-unidade/criar-platform-app-joao.sh --emails suzanne@x.com,joao@x.com,conector@x.com   # outra lista de usuários
#
# POR QUE O ACESSO AOS USUÁRIOS: um Platform App só enxerga e mexe no que tem «permissão» (PlatformAppPermissible). Sem a permissão sobre os usuários que já
# existem (Suzanne, João e o Conector Claude), o passo «conta» do kit não consegue pôr a Doutor Digital como administradora da conta nova. A conta e o usuário
# conector que o próprio app CRIA já nascem com permissão; os antigos precisam desta etapa.
#
# Lista de usuários: EMAILS_DOS_ADMINISTRADORES (abaixo, preencha UMA vez), ou a variável de ambiente, ou --emails. Sem lista, --so-conferir mostra os
# administradores da conta 1 (e-mails, não segredo) para você copiar.
#
# Idempotente: se o arquivo do token já existe e o Chatwoot o aceita, não recria o app; a permissão de cada usuário só é criada se ainda não existe.
# Se o arquivo existe e o Chatwoot RECUSA, para e pede decisão (não cria outro por cima sozinho). Variáveis opcionais: CHATWOOT_URL (padrão
# https://atendimento.doutordigitalconsultoria.com), ARQUIVO_DO_TOKEN (padrão /root/segredos/chatwoot-platform.token), NOME_DO_APP (padrão «Kit de unidade»).
#
# NÃO FOI RODADO por quem escreveu (não tinha acesso à VPS): a primeira execução é com --so-conferir.
set -euo pipefail
umask 077

# ── preencha UMA vez: os e-mails dos usuários que o Platform App precisa enxergar (Suzanne, João, Conector Claude) ──
EMAILS_DOS_ADMINISTRADORES=()

URL="${CHATWOOT_URL:-https://atendimento.doutordigitalconsultoria.com}"
ARQUIVO="${ARQUIVO_DO_TOKEN:-/root/segredos/chatwoot-platform.token}"
NOME="${NOME_DO_APP:-Kit de unidade}"
SO_CONFERIR=0
EMAILS_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --so-conferir) SO_CONFERIR=1 ;;
    --emails) shift; EMAILS_ARG="${1:-}" ;;
    *) echo "argumento desconhecido: $1"; exit 2 ;;
  esac
  shift || true
done
# a lista: --emails vence a variável de ambiente, que vence a lista do topo
if [ -n "$EMAILS_ARG" ]; then LISTA="$EMAILS_ARG"
elif [ -n "${EMAILS_DOS_ADMINISTRADORES_ENV:-}" ]; then LISTA="$EMAILS_DOS_ADMINISTRADORES_ENV"
else LISTA="$(IFS=,; echo "${EMAILS_DOS_ADMINISTRADORES[*]:-}")"; fi
LISTA="$(printf '%s' "$LISTA" | tr -d '[:space:]')"
if [ -n "$LISTA" ]; then
  # só e-mail «de verdade» entra (a lista vai para o ambiente do rails, nunca para dentro do código Ruby)
  IFS=',' read -ra PARA_CONFERIR <<< "$LISTA"
  for e in "${PARA_CONFERIR[@]}"; do
    [[ "$e" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "e-mail inválido na lista: $e"; exit 2; }
  done
fi

# O contêiner MAIS NOVO do chatwoot_rails (no rolling update `head -1` pegaria o antigo)
container() { docker ps --filter "name=chatwoot_rails" --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2; }

# O Chatwoot aceita este token? (a plataforma responde 404 para conta que não existe e 401 para token ruim)
# O cabeçalho vai por ARQUIVO (`-H @arquivo`): o token não fica na linha de comando, que qualquer usuário do host vê no `ps`. O arquivo do cabeçalho fica ao
# lado do token (mesma pasta, modo 600) e é apagado em seguida — nunca em /tmp.
aceita() {
  local codigo cab="$ARQUIVO.cab"
  { printf 'api_access_token: '; cat "$ARQUIVO"; } > "$cab"
  codigo="$(curl -s -o /dev/null -w '%{http_code}' -H "@$cab" "$URL/platform/api/v1/accounts/0" || true)"
  rm -f "$cab"
  [ "$codigo" = "404" ] || [ "$codigo" = "200" ]
}

C="$(container)"
if [ -z "$C" ]; then
  echo "ERRO: não achei o contêiner chatwoot_rails neste host (docker ps). Rode no host do Swarm onde o Chatwoot está."
  exit 1
fi

# ── 1. o Platform App e o token ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
APP_EXISTE=0
if [ -s "$ARQUIVO" ]; then
  if aceita; then
    echo "OK: o Platform App já existe e o Chatwoot aceita o token em $ARQUIVO."
    APP_EXISTE=1
  else
    echo "ATENÇÃO: $ARQUIVO existe mas o Chatwoot RECUSA o token. Não vou criar outro por cima sozinho."
    echo "Confira no Super Admin do Chatwoot (Platform Apps) e apague o arquivo à mão se for o caso."
    exit 1
  fi
elif [ "$SO_CONFERIR" = "1" ]; then
  echo "SÓ CONFERIR: não há token em $ARQUIVO. Sem --so-conferir, crio o Platform App «$NOME» e gravo o token no arquivo (modo 600, sem imprimir)."
else
  mkdir -p "$(dirname "$ARQUIVO")"
  # o token sai do rails direto para o arquivo — nunca para a tela. (sem -t: a saída é só o token).
  # a linha com o token leva o marcador TOKEN: (o rails pode imprimir avisos antes); só ela vai para o arquivo
  docker exec "$C" bundle exec rails runner "app = PlatformApp.find_or_create_by!(name: '${NOME//\'/}'); puts 'TOKEN:' + app.access_token.token" | sed -n 's/^TOKEN://p' | tail -n1 > "$ARQUIVO"
  chmod 600 "$ARQUIVO"
  if [ ! -s "$ARQUIVO" ]; then rm -f "$ARQUIVO"; echo "ERRO: o rails não devolveu token."; exit 1; fi
  if aceita; then
    echo "PRONTO: Platform App «$NOME» criado; token em $ARQUIVO (modo 600, não impresso)."
    APP_EXISTE=1
  else
    echo "ERRO: criei o app mas o Chatwoot não aceitou o token. Confira o Super Admin (Platform Apps)."; exit 1
  fi
fi

# ── 2. o acesso do app aos usuários que já existem ───────────────────────────────────────────────────────────────────────────────────────────────────────
# O Ruby recebe os e-mails e o modo por VARIÁVEL DE AMBIENTE (nunca dentro do texto do código) e imprime só linhas «PERM:<e-mail>:<situação>» — sem token.
RUBY='
app = PlatformApp.find_by(name: ENV.fetch("KIT_NOME_DO_APP"))
aplicar = ENV["KIT_MODO"] == "aplicar"
emails = ENV.fetch("KIT_EMAILS", "").split(",").map(&:strip).reject(&:empty?)
if emails.empty?
  User.joins(:account_users).where(account_users: { account_id: 1, role: AccountUser.roles[:administrator] }).distinct.pluck(:email).sort.each { |e| puts "ADMIN:#{e}" }
end
emails.each do |e|
  u = User.find_by(email: e.downcase)
  if u.nil? then puts "PERM:#{e}:usuario-inexistente"; next end
  if app.nil? then puts "PERM:#{e}:app-ausente"; next end
  tem = PlatformAppPermissible.exists?(platform_app_id: app.id, permissible_type: "User", permissible_id: u.id)
  if tem then puts "PERM:#{e}:ja-tem"
  elsif aplicar
    PlatformAppPermissible.create!(platform_app_id: app.id, permissible_type: "User", permissible_id: u.id)
    puts "PERM:#{e}:criada"
  else puts "PERM:#{e}:faltaria"
  end
end
'
MODO="aplicar"; [ "$SO_CONFERIR" = "1" ] && MODO="conferir"
SAIDA="$(docker exec -e "KIT_EMAILS=$LISTA" -e "KIT_MODO=$MODO" -e "KIT_NOME_DO_APP=$NOME" "$C" bundle exec rails runner "$RUBY" </dev/null | sed -n 's/^\(PERM\|ADMIN\)://p' || true)"
if [ -z "$LISTA" ]; then
  echo "ACESSO AOS USUÁRIOS: nenhuma lista de e-mails (EMAILS_DOS_ADMINISTRADORES no topo do script, EMAILS_DOS_ADMINISTRADORES_ENV ou --emails)."
  if [ -n "$SAIDA" ]; then echo "Administradores da conta 1 (copie os que precisam):"; printf '%s\n' "$SAIDA" | sed 's/^/  - /'; fi
  [ "$SO_CONFERIR" = "1" ] && exit 0
  echo "SEM essa lista o passo «conta» do kit não consegue pôr a Doutor Digital como administradora da conta nova."; exit 1
fi
if [ -z "$SAIDA" ]; then echo "ERRO: o rails não respondeu sobre os usuários (docker exec ou rails runner falhou). Nada foi alterado além do que está acima."; exit 1; fi
FALTA=0
while IFS= read -r linha; do
  [ -n "$linha" ] || continue
  email="${linha%:*}"; situ="${linha##*:}"
  case "$situ" in
    ja-tem) echo "  $email: o app já tem acesso." ;;
    criada) echo "  $email: acesso CRIADO." ;;
    faltaria) echo "  $email: FALTA o acesso (sem --so-conferir eu crio)."; FALTA=1 ;;
    app-ausente) echo "  $email: o app ainda não existe (sem --so-conferir eu crio o app e o acesso)."; FALTA=1 ;;
    usuario-inexistente) echo "  $email: NÃO existe usuário com esse e-mail no Chatwoot — confira o e-mail."; FALTA=1 ;;
    *) echo "  $email: $situ"; FALTA=1 ;;
  esac
done <<< "$SAIDA"
if [ "$SO_CONFERIR" = "1" ]; then echo "SÓ CONFERIR: nada foi criado."; exit 0; fi
if [ "$FALTA" = "1" ]; then echo "ATENÇÃO: algum usuário da lista não ficou com acesso (veja acima)."; exit 1; fi
[ "$APP_EXISTE" = "1" ] && echo "PRÓXIMO: levar o kit para a VPS (ops/kit-unidade/levar-kit-para-vps.sh) e rodar o nova-unidade-joao.sh de /root/kit."
