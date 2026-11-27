#!/bin/bash
# Focus NFe (nota fiscal de serviço, NFS-e NACIONAL) de Açailândia no conector (26/11/2026). Quem roda é o João; este script NÃO é executado pela equipe.
#
#   bash ~/Kommo-Integracao/_replicacao/ligar-focus-acailandia.sh                        # simulação em HOMOLOGAÇÃO: prova o token na Focus e mostra o que gravaria (token mascarado)
#   bash ~/Kommo-Integracao/_replicacao/ligar-focus-acailandia.sh --executar             # grava no .env da VPS (backup) e aplica no serviço, em HOMOLOGAÇÃO
#   bash ~/Kommo-Integracao/_replicacao/ligar-focus-acailandia.sh --executar --registrar-webhook   # TAMBÉM cadastra o gatilho (webhook) da Focus para nota autorizada
#   bash ~/Kommo-Integracao/_replicacao/ligar-focus-acailandia.sh --producao --serie=N [--numero-inicial=M] --executar  # PRODUÇÃO (NOTA REAL): só com o token de produção e a série escolhida com a contabilidade
#   bash ~/Kommo-Integracao/_replicacao/ligar-focus-acailandia.sh --desligar [--executar]          # TIRA FOCUS_NFE_UNIDADES, o token, o ambiente e a série do .env e do serviço
#
# O PADRÃO É HOMOLOGAÇÃO (ambiente de teste da Focus, sem validade fiscal). Produção só com --producao explícito, com o token de PRODUÇÃO (FOCUS_TOKEN_PRODUCAO_ACAILANDIA) e --serie=N.
# O token de um ambiente não vale no outro: o script prova o token no ambiente escolhido ANTES de mandar qualquer coisa à VPS, e se a Focus o recusar nada é gravado.
#
# O que lê (modo 600, nunca é impresso):  ~/Kommo-Integracao/_replicacao/focus_nfe_tokens.txt
#   FOCUS_TOKEN_HOMOLOGACAO_ACAILANDIA, FOCUS_TOKEN_PRODUCAO_ACAILANDIA   (o FOCUS_TOKEN_PRINCIPAL_CONTA, se houver, NUNCA é usado nem enviado à VPS)
# O que grava no .env da VPS:
#   FOCUS_NFE_UNIDADES=doutor-hernia-acailandia    (a lista que liga: vazia = tudo desligado; o código só emite nas unidades da lista)
#   FOCUS_NFE_TOKEN_ACAILANDIA                      (o token do ambiente escolhido)
#   FOCUS_NFE_AMBIENTE_ACAILANDIA=homologacao|producao
#   FOCUS_NFE_SERIE_DPS_ACAILANDIA                  (só com --serie=N; obrigatória em produção; em homologação o código usa a série 1)
#   FOCUS_NFE_WEBHOOK_SEGREDO                       (32+ caracteres: GERADO na VPS só se ainda não existir e MANTIDO nas rodadas seguintes; nunca impresso)
# Os dados fiscais da unidade (CNPJ, município IBGE, inscrição municipal, cTribNac 04.08.02, NBS, texto do serviço) estão no código (focus-nfe-perfis.ts), não no .env, e foram informados pelo João
# em 26/11/2026. A ALÍQUOTA DO ISS padrão é 0: decisão do João em 26/11 (Simples, ISS no DAS); SEM confirmação escrita da contabilidade. O resumo de cada nota mostra essa origem.
# O perfil só vale para o CNPJ e o município dele: não configure FOCUS_NFE_CNPJ_/FOCUS_NFE_MUNICIPIO_ com outro valor (a unidade deixa de emitir).
# SÉRIE EM PRODUÇÃO: a clínica TAMBÉM emite NFS-e pelo Emissor Nacional (portal). A série de produção de Açailândia vem do PERFIL (serieDpsProducao em focus-nfe-perfis.ts, escolhida pelo João e pela
# contabilidade, DIFERENTE da usada no portal), não do .env: --serie só vale se for IGUAL à do perfil; enquanto o perfil não a definir, o conector não emite em produção.
# NÚMERO DA DPS: o conector segue o próximo número que a Focus guarda para a série; em PRODUÇÃO, se ele não puder ser lido, a emissão é recusada, a menos que você passe --numero-inicial=N
# (o número de partida combinado com a contabilidade, sem repetir um já usado no Asaas/portal).
# TOKEN NA LINHA DE COMANDO DA VPS: `docker service update --env-add FOCUS_NFE_TOKEN_…=…` coloca o token na linha de comando do docker por instantes e `docker service inspect` o mostra (é o
# mesmo desenho dos scripts da Pluggy e da InfinitePay; o docker não tem outra forma de mudar a variável de um serviço sem recriá-lo). Quem tem acesso root à VPS já o lê do .env. Não há como evitar sem mexer no deploy.
#
# DECLARATIVO: o estado final é o que o script grava. Rodar de novo troca o conjunto (ex. voltar de produção para homologação remove a série).
# Pré-requisito: o código do PR da Focus já estar no ar (merge + deploy); sem ele as variáveis não fazem nada. A tabela focus_notas nasce no deploy (migração).
# Depois de ligar, confira pelo conector (sessão de quem altera cartões): focus_dados_fiscais (prova o token, mostra o que falta) — e só então focus_preparar_nota.
# A cópia deste script também está no repositório (ops/conector/ligar-focus-acailandia.sh) para revisão; a que o João roda fica em ~/Kommo-Integracao/_replicacao/.
set -euo pipefail
EXEC=0; DESLIGAR=0; PRODUCAO=0; REGISTRAR_WH=0; SERIE=""; NUMINI=""
for a in "$@"; do
  case "$a" in
    --executar) EXEC=1 ;;
    --desligar) DESLIGAR=1 ;;
    --producao) PRODUCAO=1 ;;
    --registrar-webhook) REGISTRAR_WH=1 ;;
    --serie=*)
      SERIE="${a#--serie=}"
      if ! [[ "$SERIE" =~ ^[0-9]{1,5}$ ]] || [ "$SERIE" -lt 1 ] || [ "$SERIE" -gt 49999 ]; then echo "ERRO: --serie precisa ser um número de 1 a 49999 (a faixa da API da Focus)."; exit 2; fi ;;
    --numero-inicial=*)
      NUMINI="${a#--numero-inicial=}"
      if ! [[ "$NUMINI" =~ ^[0-9]{1,9}$ ]] || [ "$NUMINI" -lt 1 ]; then echo "ERRO: --numero-inicial precisa ser um inteiro a partir de 1."; exit 2; fi ;;
    *) echo "argumento desconhecido: $a"; exit 2 ;;
  esac
done

VPS=root@89.116.214.130; KEY=~/.ssh/doutordigital_vps
DIR=~/Kommo-Integracao/_replicacao
ARQ="${FOCUS_TOKENS_ARQUIVO:-$DIR/focus_nfe_tokens.txt}"        # a variável só serve para testar o script com valores de mentira
SLUG=doutor-hernia-acailandia
CNPJ=63130582000140
ORIGEM_PUBLICA="${FOCUS_ORIGEM_PUBLICA:-https://agente-vps.doutordigitalconsultoria.com}"
# o que --executar DECLARA (grava ou tira); o segredo do webhook é mantido de propósito (o endereço cadastrado na Focus depende dele)
VARS_LIGAR=(FOCUS_NFE_UNIDADES FOCUS_NFE_TOKEN_ACAILANDIA FOCUS_NFE_AMBIENTE_ACAILANDIA FOCUS_NFE_SERIE_DPS_ACAILANDIA FOCUS_NFE_NUMERO_INICIAL_ACAILANDIA)
TMPD=~/.cache/focus-env; mkdir -p "$TMPD"; chmod 700 "$TMPD"
LINHAS="$TMPD/linhas.env"; : > "$LINHAS"; chmod 600 "$LINHAS"
RESP="$TMPD/resp.json"
trap 'rm -f "$LINHAS" "$RESP"' EXIT

mascara() { local v="$1"; if [ "${#v}" -le 8 ]; then printf '…'; else printf '…%s' "${v: -4}"; fi; }

# o remoto: espera a atualização rolante terminar e sobrar UMA tarefa desejada (nunca "o primeiro da lista": com a antiga ainda de pé ele seria a ANTIGA)
ESPERA_REMOTA='
OK=0
for i in $(seq 1 45); do
  mapfile -t TAREFAS < <(docker service ps ddagent_agent --filter desired-state=running --format "{{.ID}}")
  EST=$(docker service inspect --format "{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}sem-atualizacao{{end}}" ddagent_agent)
  if [ "${#TAREFAS[@]}" = "1" ] && { [ "$EST" = "completed" ] || [ "$EST" = "sem-atualizacao" ]; }; then OK=1; break; fi
  sleep 2
done
if [ $OK -ne 1 ]; then echo "AVISO: a atualização do serviço não terminou em 90 s (tarefas desejadas: ${#TAREFAS[@]}, estado: $EST). Não conferi o contêiner: veja docker service ps ddagent_agent."; exit 0; fi
C=$(docker inspect --format "{{.Status.ContainerStatus.ContainerID}}" "${TAREFAS[0]}")
'

# roda no servidor: a espera acima + o que vier pela entrada (heredoc COM aspas, para $C e os $() serem avaliados lá). O script remoto vai pela entrada do ssh, sem `docker exec -i`.
remoto_conferir() { { printf 'set -euo pipefail\n%s\n' "$ESPERA_REMOTA"; cat; } | ssh -i $KEY -o BatchMode=yes $VPS "bash -s"; }

# ------------------------------------------------------------------ desligar (não precisa de token nenhum)
if [ $DESLIGAR -eq 1 ]; then
  echo "Vai REMOVER da VPS, do .env e do serviço ddagent_agent: ${VARS_LIGAR[*]}"
  echo "(FOCUS_NFE_WEBHOOK_SEGREDO fica no .env de propósito: o gatilho cadastrado na Focus depende dele. As notas já emitidas continuam no banco e na Focus.)"
  if [ $EXEC -ne 1 ]; then echo "(simulação: nada removido. Para remover: --desligar --executar)"; exit 0; fi
  ssh -i $KEY -o BatchMode=yes $VPS "bash -s -- ${VARS_LIGAR[*]}" <<'REMOTO'
set -euo pipefail
cd /opt/doutordigital/agente-dt
F=.env; BAK="$F.bak-$(date +%Y%m%d-%H%M)-antes-desligar-focus"
cp -p "$F" "$BAK"
ARGS=()
for k in "$@"; do sed -i "/^${k}=/d" "$F"; ARGS+=(--env-rm "$k"); done
sed -i '/^# 26\/11\/2026: Focus NFe/d' "$F"
if ! ( set -eu; set -a; . "./$F" ) >/dev/null 2>&1; then
  cp -p "$BAK" "$F"; echo "CONFERÊNCIA FALHOU: o .env não carrega no bash. Restaurei o backup ($BAK). Nada mudou."; exit 1
fi
echo "[1] .env sem as variáveis da Focus (backup: /opt/doutordigital/agente-dt/$BAK)"
docker service update --quiet "${ARGS[@]}" ddagent_agent >/dev/null
REMOTO
  # a conferência no contêiner novo vai numa 2ª chamada, para o `docker service update` acima já ter terminado
  remoto_conferir <<'EOS'
echo "[2] no contêiner novo: FOCUS_NFE_UNIDADES presente=$(docker exec "$C" sh -c 'test -n "$FOCUS_NFE_UNIDADES" && echo SIM || echo nao') (nao = desligada)"
EOS
  echo "PRONTO. Para voltar a ligar: rode este script de novo sem --desligar. Backup do .env na VPS: .env.bak-…-antes-desligar-focus."
  exit 0
fi

# ------------------------------------------------------------------ ligar: ler e validar o token (nada é impresso sem máscara)
[ $PRODUCAO -eq 1 ] || [ -z "$NUMINI" ] || { echo "ERRO: --numero-inicial só vale com --producao (em homologação o conector segue o número da Focus). Nada foi feito."; exit 1; }
if [ $PRODUCAO -eq 1 ]; then
  AMB=producao; CHAVE_NO_ARQUIVO=FOCUS_TOKEN_PRODUCAO_ACAILANDIA; BASE="${FOCUS_API_PRODUCAO:-https://api.focusnfe.com.br}"
  [ -n "$SERIE" ] || { echo "ERRO: produção exige --serie=N (a série da DPS escolhida com a contabilidade; o conector não adivinha). Nada foi feito."; exit 1; }
else
  AMB=homologacao; CHAVE_NO_ARQUIVO=FOCUS_TOKEN_HOMOLOGACAO_ACAILANDIA; BASE="${FOCUS_API_HOMOLOGACAO:-https://homologacao.focusnfe.com.br}"
fi
[ -f "$ARQ" ] || { echo "ERRO: não achei $ARQ. Rode primeiro: bash $DIR/focus-guardar-token.sh"; exit 1; }
TOK=""
mapfile -t LINHAS_ARQ < "$ARQ"
for l in "${LINHAS_ARQ[@]}"; do
  l="${l%$'\r'}"
  case "$l" in ''|'#'*) continue ;; esac
  case "$l" in *=*) ;; *) continue ;; esac
  k="${l%%=*}"; v="${l#*=}"
  v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  v="$(printf '%s' "$v" | tr -d '[:space:]')"
  if [ "$k" = "$CHAVE_NO_ARQUIVO" ]; then TOK="$v"; fi
done
unset LINHAS_ARQ l k v
[[ "$TOK" =~ ^[A-Za-z0-9]{16,64}$ ]] || { echo "ERRO: $CHAVE_NO_ARQUIVO vazio ou com formato estranho no arquivo de tokens (letras e números, 16 a 64). Nada foi feito."; exit 1; }

# provar o token no ambiente escolhido ANTES de mandar qualquer coisa à VPS: GET de uma referência que não existe (404 = token aceito; 401/403 = recusado). Não cria nada.
# o token vai pela entrada do curl (-K -), nunca na linha de comando (ps) nem em arquivo fora de $TMPD
echo "Conferindo o token na Focus ($AMB; nada é gravado ainda)..."
CODIGO=$(printf 'user = "%s:"\n' "$TOK" | curl -sS -m 25 -K - -o "$RESP" -w '%{http_code}' -H 'Accept: application/json' "$BASE/v2/nfsen/ddprovadotokeninexistente" || echo 000)
case "$CODIGO" in
  404) echo "OK: a Focus aceitou o token de $AMB (404 de uma referência inexistente é o esperado)." ;;
  401|403) echo "ERRO: a Focus RECUSOU o token ($CODIGO). Confira se é o token de $AMB desta empresa (homologação e produção têm tokens diferentes) em focus_nfe_tokens.txt. Nada foi gravado."; exit 1 ;;
  *) echo "ERRO: resposta inesperada da Focus (HTTP $CODIGO) ao provar o token. Nada foi gravado."; exit 1 ;;
esac
rm -f "$RESP"

# ------------------------------------------------------------------ linhas do .env (carregam no bash E no env_file do docker: sem espaço nem aspas)
{
  printf 'FOCUS_NFE_UNIDADES=%s\n' "$SLUG"
  printf 'FOCUS_NFE_TOKEN_ACAILANDIA=%s\n' "$TOK"
  printf 'FOCUS_NFE_AMBIENTE_ACAILANDIA=%s\n' "$AMB"
  if [ -n "$SERIE" ]; then printf 'FOCUS_NFE_SERIE_DPS_ACAILANDIA=%s\n' "$SERIE"; fi
  if [ -n "$NUMINI" ]; then printf 'FOCUS_NFE_NUMERO_INICIAL_ACAILANDIA=%s\n' "$NUMINI"; fi
} >> "$LINHAS"
( set -eu; . "$LINHAS" ) || { echo "ERRO: as linhas não carregam no bash; nada foi feito."; exit 1; }

echo
if [ "$AMB" = "producao" ]; then
  echo "ATENÇÃO — PRODUÇÃO: as notas emitidas depois disto são REAIS (valor fiscal e tributário)."
else
  echo "HOMOLOGAÇÃO: notas de teste, sem validade fiscal."
fi
echo "Vai gravar no .env da VPS (o token aparece mascarado):"
echo "   FOCUS_NFE_UNIDADES=$SLUG"
echo "   FOCUS_NFE_TOKEN_ACAILANDIA=$(mascara "$TOK")  (${#TOK} caracteres)"
echo "   FOCUS_NFE_AMBIENTE_ACAILANDIA=$AMB"
if [ -n "$SERIE" ]; then echo "   FOCUS_NFE_SERIE_DPS_ACAILANDIA=$SERIE"; else echo "   (sem --serie: FOCUS_NFE_SERIE_DPS_ACAILANDIA será REMOVIDA do .env e do serviço, se existir; em homologação o código usa a série 1)"; fi
if [ -n "$NUMINI" ]; then echo "   FOCUS_NFE_NUMERO_INICIAL_ACAILANDIA=$NUMINI"; else echo "   (sem --numero-inicial: FOCUS_NFE_NUMERO_INICIAL_ACAILANDIA será REMOVIDA; em produção a emissão exige ler o próximo número na Focus)"; fi
echo "   (FOCUS_NFE_WEBHOOK_SEGREDO: GERADO na VPS só se ainda não existir; se já existe, é mantido; nunca aparece aqui)"
if [ $REGISTRAR_WH -eq 1 ]; then echo "   (gatilho: vai cadastrar na Focus ($AMB) o evento nfsen apontando para $ORIGEM_PUBLICA/focus-nfe/webhook/$SLUG/<assinatura>, se ainda não existir)"; fi
unset TOK
if [ $EXEC -ne 1 ]; then echo "(simulação: nada gravado. Para gravar: --executar)"; exit 0; fi

# ------------------------------------------------------------------ gravar na VPS
scp -q -i $KEY -o BatchMode=yes "$LINHAS" $VPS:/root/.focus-linhas-novas.env
ssh -i $KEY -o BatchMode=yes $VPS "bash -s -- $REGISTRAR_WH $SLUG $CNPJ $ORIGEM_PUBLICA $AMB ${VARS_LIGAR[*]}" <<'REMOTO'
set -euo pipefail
NOVAS=/root/.focus-linhas-novas.env
REG="$1"; SLUG="$2"; CNPJ="$3"; ORIGEM="$4"; AMB="$5"; shift 5
chmod 600 "$NOVAS"
cd /opt/doutordigital/agente-dt
F=.env; BAK="$F.bak-$(date +%Y%m%d-%H%M)-antes-focus"
cp -p "$F" "$BAK"
# estado final DECLARATIVO: sai toda variável da Focus antiga e entram as novas (o que não está nas novas, como a série sem --serie, é tirado do serviço também)
for k in "$@"; do sed -i "/^${k}=/d" "$F"; done
sed -i '/^# 26\/11\/2026: Focus NFe/d' "$F"
printf '\n# 26/11/2026: Focus NFe (nota fiscal de serviço, NFS-e Nacional) de Açailândia no conector\n' >> "$F"
cat "$NOVAS" >> "$F"
# o segredo do webhook: gera UMA vez (aleatório, 32 bytes), mantém se já existe, nunca imprime o valor
gerar() { if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; fi; }
ATUAL=$(awk -F= '/^FOCUS_NFE_WEBHOOK_SEGREDO=/{v=substr($0,length($1)+2)} END{print v}' "$F")
if [ "${#ATUAL}" -ge 32 ]; then
  echo "[seg] FOCUS_NFE_WEBHOOK_SEGREDO: já existe (${#ATUAL} caracteres), MANTIDO"
else
  sed -i '/^FOCUS_NFE_WEBHOOK_SEGREDO=/d' "$F"
  printf 'FOCUS_NFE_WEBHOOK_SEGREDO=%s\n' "$(gerar)" >> "$F"
  echo "[seg] FOCUS_NFE_WEBHOOK_SEGREDO: GERADO agora (64 caracteres)"
fi
unset ATUAL
if ! ( set -eu; set -a; . "./$F" ) >/dev/null 2>&1; then
  cp -p "$BAK" "$F"; rm -f "$NOVAS"
  echo "CONFERÊNCIA FALHOU: o .env não carrega no bash. Restaurei o backup ($BAK). Nada mudou."; exit 1
fi
echo "[1] .env atualizado e conferido (backup: /opt/doutordigital/agente-dt/$BAK)"
ADD=(); RM=()
while IFS= read -r l; do if [ -n "$l" ]; then ADD+=(--env-add "$l"); fi; done < "$NOVAS"
SEG=$(awk -F= '/^FOCUS_NFE_WEBHOOK_SEGREDO=/{v=substr($0,length($1)+2)} END{print v}' "$F")
ADD+=(--env-add "FOCUS_NFE_WEBHOOK_SEGREDO=$SEG")
for k in "$@"; do if ! grep -q "^${k}=" "$NOVAS"; then RM+=(--env-rm "$k"); fi; done
docker service update --quiet "${ADD[@]}" ${RM[@]+"${RM[@]}"} ddagent_agent >/dev/null
# o gatilho: cadastra SÓ se ainda não existe (a Focus repete a notificação se o endereço falhar; um gatilho duplicado dobraria os avisos). O token vem do arquivo de linhas novas e não vai para a linha de comando.
if [ "$REG" = "1" ]; then
  BASE="https://homologacao.focusnfe.com.br"; [ "$AMB" = "producao" ] && BASE="https://api.focusnfe.com.br"
  TOKL=$(awk -F= '/^FOCUS_NFE_TOKEN_ACAILANDIA=/{v=substr($0,length($1)+2)} END{print v}' "$NOVAS")
  # a assinatura do endereço: o MESMO cálculo do conector (HMAC-SHA256 de "focus-nfe|<unidade>" com o segredo, 32 primeiros caracteres); o segredo vai por variável de ambiente, não pela linha de comando
  ASSIN=$(SEG="$SEG" SLUG="$SLUG" python3 -I -c 'import hmac, hashlib, os; print(hmac.new(os.environ["SEG"].encode(), ("focus-nfe|" + os.environ["SLUG"]).encode(), hashlib.sha256).hexdigest()[:32])')
  URL="$ORIGEM/focus-nfe/webhook/$SLUG/$ASSIN"
  LISTA=$(printf 'user = "%s:"\n' "$TOKL" | curl -sS -m 25 -K - -H 'Accept: application/json' "$BASE/v2/hooks" || echo '')
  if printf '%s' "$LISTA" | grep -qF "$URL"; then
    echo "[3] gatilho nfsen: JÁ cadastrado na Focus ($AMB) com este endereço (não cadastrei de novo)"
  elif printf '%s' "$LISTA" | grep -q '"event" *: *"nfsen"'; then
    echo "[3] gatilho nfsen: JÁ existe OUTRO gatilho nfsen na Focus ($AMB) com endereço diferente. NÃO cadastrei o novo (dobraria os avisos): confira no painel da Focus e apague o antigo, ou me avise."
  else
    COD=$(printf 'user = "%s:"\n' "$TOKL" | curl -sS -m 25 -K - -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H 'Accept: application/json' --data-binary "{\"event\":\"nfsen\",\"cnpj\":\"$CNPJ\",\"url\":\"$URL\"}" "$BASE/v2/hooks" || echo 000)
    echo "[3] gatilho nfsen: cadastro na Focus ($AMB) respondeu HTTP $COD (200 = criado)"
  fi
  unset TOKL ASSIN URL LISTA SEG
fi
rm -f "$NOVAS"
REMOTO
remoto_conferir <<'EOS'
# confere SEM imprimir o token: só se existe e quantos caracteres tem; o ambiente aparece (não é segredo)
echo "[2] no contêiner novo: unidades=[$(docker exec "$C" printenv FOCUS_NFE_UNIDADES || true)] ambiente=[$(docker exec "$C" printenv FOCUS_NFE_AMBIENTE_ACAILANDIA || true)] serie=[$(docker exec "$C" printenv FOCUS_NFE_SERIE_DPS_ACAILANDIA || true)]"
echo "[2] no contêiner novo: token presente=$(docker exec "$C" sh -c 'test -n "$FOCUS_NFE_TOKEN_ACAILANDIA" && echo SIM || echo nao') tamanho=$(docker exec "$C" sh -c 'printf %s "$FOCUS_NFE_TOKEN_ACAILANDIA" | wc -c')"
echo "[2] no contêiner novo: segredo do webhook presente=$(docker exec "$C" sh -c 'test -n "$FOCUS_NFE_WEBHOOK_SEGREDO" && echo SIM || echo nao') tamanho=$(docker exec "$C" sh -c 'printf %s "$FOCUS_NFE_WEBHOOK_SEGREDO" | wc -c')"
EOS
echo "PRONTO. Confira pelo conector (sessão de quem altera cartões): focus_dados_fiscais (prova o token e mostra o que ainda falta) e depois focus_preparar_nota."
echo "Para desfazer: bash $DIR/ligar-focus-acailandia.sh --desligar --executar   (ou restaure o .env.bak-…-antes-focus e rode docker service update --env-rm das variáveis FOCUS_NFE_*)."
