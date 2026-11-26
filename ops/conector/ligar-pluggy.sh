#!/bin/bash
# Pluggy (Open Finance, SÓ LEITURA) no conector (26/11/2026). Quem roda é o João; este script NÃO é executado pela equipe.
#
#   bash ~/Kommo-Integracao/_replicacao/ligar-pluggy.sh --empresa=doutor-digital                # simulação: confere tudo na Pluggy e mostra o que gravaria (valores mascarados)
#   bash ~/Kommo-Integracao/_replicacao/ligar-pluggy.sh --empresa=doutor-digital --executar     # grava no .env da VPS (backup) e aplica no serviço
#   bash ~/Kommo-Integracao/_replicacao/ligar-pluggy.sh --desligar                              # simulação do desligamento
#   bash ~/Kommo-Integracao/_replicacao/ligar-pluggy.sh --desligar --executar                   # TIRA as variáveis do .env e do serviço (docker service update --env-rm)
#
# Opções:
#   --empresa=SLUG        a empresa/unidade do conector dona dos itens (ex. doutor-digital). Vale para todos os itens do arquivo.
#   --empresa=SLUG:N      só para o item de número N (1 = o primeiro de PLUGGY_ITEM_IDS). Use quando os bancos são de empresas diferentes;
#                         então CADA item precisa de uma empresa (por N, ou por um --empresa=SLUG geral). Nunca por pergunta no terminal.
#   --apelido=N:TEXTO     um nome curto para o item N (letras, números, _ . - ; sem espaço). Aparece nos avisos do Telegram. Opcional.
#
# O que lê (modo 600, nunca é impresso):
#   ~/Kommo-Integracao/_replicacao/pluggy_credenciais.txt     PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_IDS (o pluggy-guardar-e-testar.sh cria)
#   ~/Kommo-Integracao/_replicacao/pluggy_webhook_secret.txt  o segredo whsec_… do webhook (opcional: sem ele o webhook fica desligado)
# O que grava no .env da VPS:  PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITENS, PLUGGY_WEBHOOK_SECRET.
#
# Antes de mandar qualquer coisa à VPS, o script prova as credenciais em POST /auth e cada item em GET /items/{id}; se algo falhar, NADA é gravado.
# Pré-requisito: o código do PR da Pluggy já estar no ar (merge + deploy); sem ele as variáveis não fazem nada.
# O script é DECLARATIVO: o estado final é o que ele grava. Rodar de novo troca o conjunto inteiro (variáveis antigas do mesmo nome saem do .env).
# Webhook (cadastrar no Dashboard da Pluggy, depois de ligar): https://agente-vps.doutordigitalconsultoria.com/api/webhooks/pluggy
# Troca do segredo do webhook sem perder evento: ponha o segredo ANTIGO em PLUGGY_WEBHOOK_SECRET_PREVIOUS (docker service update --env-add) antes de gerar o novo; este script não mexe nele.
# A cópia deste script também está no repositório (ops/conector/ligar-pluggy.sh) para revisão; a que o João roda fica em ~/Kommo-Integracao/_replicacao/.
set -euo pipefail
EXEC=0; DESLIGAR=0
EMPRESA_GERAL=""
declare -A EMPRESA_DO_ITEM=() APELIDO_DO_ITEM=()
for a in "$@"; do
  case "$a" in
    --executar) EXEC=1 ;;
    --desligar) DESLIGAR=1 ;;
    --empresa=*)
      v="${a#--empresa=}"
      if [[ "$v" =~ ^([a-z0-9][a-z0-9-]{1,63}):([1-9][0-9]?)$ ]]; then EMPRESA_DO_ITEM["${BASH_REMATCH[2]}"]="${BASH_REMATCH[1]}"
      elif [[ "$v" =~ ^[a-z0-9][a-z0-9-]{1,63}$ ]]; then EMPRESA_GERAL="$v"
      else echo "ERRO: --empresa precisa ser o slug (minúsculas, números e hífen) ou SLUG:N. Recebi um valor fora desse formato."; exit 2; fi ;;
    --apelido=*)
      v="${a#--apelido=}"
      if [[ "$v" =~ ^([1-9][0-9]?):([A-Za-z0-9_.-]{1,40})$ ]]; then APELIDO_DO_ITEM["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
      else echo "ERRO: --apelido precisa ser N:TEXTO, com TEXTO só de letras, números, _ . - (até 40, sem espaço)."; exit 2; fi ;;
    *) echo "argumento desconhecido: $a"; exit 2 ;;
  esac
done

VPS=root@89.116.214.130; KEY=~/.ssh/doutordigital_vps
DIR=~/Kommo-Integracao/_replicacao
ARQ="${PLUGGY_CREDENCIAIS_ARQUIVO:-$DIR/pluggy_credenciais.txt}"      # as variáveis PLUGGY_*_ARQUIVO só servem para testar o script com valores de mentira
ARQ_WH="${PLUGGY_WEBHOOK_ARQUIVO:-$DIR/pluggy_webhook_secret.txt}"
API="${PLUGGY_API_URL:-https://api.pluggy.ai}"
# o que --executar DECLARA (grava ou tira); PLUGGY_WEBHOOK_SECRET_PREVIOUS (segredo antigo, na troca do segredo) é manual e só o --desligar remove
VARS_LIGAR=(PLUGGY_CLIENT_ID PLUGGY_CLIENT_SECRET PLUGGY_ITENS PLUGGY_WEBHOOK_SECRET)
VARS_DA_PLUGGY=("${VARS_LIGAR[@]}" PLUGGY_WEBHOOK_SECRET_PREVIOUS)
TMPD=~/.cache/pluggy-env; mkdir -p "$TMPD"; chmod 700 "$TMPD"
LINHAS="$TMPD/linhas.env"; : > "$LINHAS"; chmod 600 "$LINHAS"
CAB="$TMPD/cab.txt"; RESP="$TMPD/resp.json"
trap 'rm -f "$LINHAS" "$CAB" "$RESP"' EXIT

mascara() { local v="$1"; if [ "${#v}" -le 8 ]; then printf '…'; else printf '…%s' "${v: -4}"; fi; }

# ------------------------------------------------------------------ desligar (não precisa de credencial nenhuma)
if [ $DESLIGAR -eq 1 ]; then
  echo "Vai REMOVER da VPS, do .env e do serviço ddagent_agent: ${VARS_DA_PLUGGY[*]}"
  echo "(a leitura bancária e o webhook voltam a responder como se a Pluggy nunca tivesse sido ligada)"
  if [ $EXEC -ne 1 ]; then echo "(simulação: nada removido. Para remover: --desligar --executar)"; exit 0; fi
  ssh -i $KEY -o BatchMode=yes $VPS "bash -s -- ${VARS_DA_PLUGGY[*]}" <<'REMOTO'
set -euo pipefail
cd /opt/doutordigital/agente-dt
F=.env; BAK="$F.bak-$(date +%Y%m%d-%H%M)-antes-desligar-pluggy"
cp -p "$F" "$BAK"
ARGS=()
for k in "$@"; do sed -i "/^${k}=/d" "$F"; ARGS+=(--env-rm "$k"); done
sed -i '/^# 26\/11\/2026: Pluggy (leitura/d' "$F"
if ! ( set -eu; set -a; . "./$F" ) >/dev/null 2>&1; then
  cp -p "$BAK" "$F"; echo "CONFERÊNCIA FALHOU: o .env não carrega no bash. Restaurei o backup ($BAK). Nada mudou."; exit 1
fi
echo "[1] .env sem as variáveis da Pluggy (backup: /opt/doutordigital/agente-dt/$BAK)"
docker service update --quiet "${ARGS[@]}" ddagent_agent >/dev/null
# a atualização é rolante (start-first): espera terminar e sobrar UMA tarefa desejada. Nunca se escolhe "o primeiro da lista": com a antiga ainda de pé ele seria a ANTIGA.
OK=0
for i in $(seq 1 45); do
  mapfile -t TAREFAS < <(docker service ps ddagent_agent --filter desired-state=running --format '{{.ID}}')
  EST=$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}sem-atualizacao{{end}}' ddagent_agent)
  if [ "${#TAREFAS[@]}" = "1" ] && { [ "$EST" = "completed" ] || [ "$EST" = "sem-atualizacao" ]; }; then OK=1; break; fi
  sleep 2
done
if [ $OK -ne 1 ]; then echo "AVISO: a atualização do serviço não terminou em 90 s (tarefas desejadas: ${#TAREFAS[@]}, estado: $EST). Não conferi o contêiner: veja 'docker service ps ddagent_agent'."; exit 0; fi
C=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "${TAREFAS[0]}")
for k in "$@"; do
  echo "[2] no contêiner novo: $k presente=$(docker exec "$C" sh -c "test -n \"\$$k\" && echo SIM || echo nao")"
done
REMOTO
  echo "PRONTO. Para voltar a ligar: rode este script de novo com --empresa=… --executar. Backup do .env na VPS: .env.bak-…-antes-desligar-pluggy."
  exit 0
fi

# ------------------------------------------------------------------ ligar: ler e validar os arquivos (nada é impresso sem máscara)
[ -f "$ARQ" ] || { echo "ERRO: não achei $ARQ. Rode primeiro: bash $DIR/pluggy-guardar-e-testar.sh"; exit 1; }
ID=""; SEC=""; ITENS_BRUTO=""
mapfile -t LINHAS_ARQ < "$ARQ"
for l in "${LINHAS_ARQ[@]}"; do
  l="${l%$'\r'}"
  case "$l" in ''|'#'*) continue ;; esac
  case "$l" in *=*) ;; *) continue ;; esac
  k="${l%%=*}"; v="${l#*=}"
  v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  v="$(printf '%s' "$v" | tr -d '[:space:]')"
  case "$k" in
    PLUGGY_CLIENT_ID) ID="$v" ;;
    PLUGGY_CLIENT_SECRET) SEC="$v" ;;
    PLUGGY_ITEM_IDS) ITENS_BRUTO="$v" ;;
  esac
done
unset LINHAS_ARQ l k v
UUID='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ "$ID" =~ $UUID ]] || { echo "ERRO: PLUGGY_CLIENT_ID vazio ou fora do formato (um UUID). Nada foi feito."; exit 1; }
[[ "$SEC" =~ ^[A-Za-z0-9_.-]{16,200}$ ]] || { echo "ERRO: PLUGGY_CLIENT_SECRET vazio ou com caracteres estranhos. Nada foi feito."; exit 1; }
[ -n "$ITENS_BRUTO" ] || { echo "ERRO: PLUGGY_ITEM_IDS vazio (copie o id de cada banco no Dashboard da Pluggy). Nada foi feito."; exit 1; }
mapfile -t ITEM_IDS < <(printf '%s' "$ITENS_BRUTO" | tr ',' '\n')
[ "${#ITEM_IDS[@]}" -ge 1 ] && [ "${#ITEM_IDS[@]}" -le 5 ] || { echo "ERRO: de 1 a 5 itens (o Meu Pluggy gratuito aceita até 5). Achei ${#ITEM_IDS[@]}. Nada foi feito."; exit 1; }
for i in "${!ITEM_IDS[@]}"; do
  [[ "${ITEM_IDS[$i]}" =~ $UUID ]] || { echo "ERRO: o item $((i+1)) não é um UUID. Nada foi feito."; exit 1; }
  for j in "${!ITEM_IDS[@]}"; do [ "$j" -lt "$i" ] && [ "${ITEM_IDS[$j],,}" = "${ITEM_IDS[$i],,}" ] && { echo "ERRO: o item $((i+1)) repete o item $((j+1)). Nada foi feito."; exit 1; }; done
done
# a empresa de CADA item vem de flag, nunca de pergunta nem de palpite
for n in "${!EMPRESA_DO_ITEM[@]}"; do [ "$n" -le "${#ITEM_IDS[@]}" ] || { echo "ERRO: --empresa=…:$n aponta um item que não existe (são ${#ITEM_IDS[@]}). Nada foi feito."; exit 1; }; done
for n in "${!APELIDO_DO_ITEM[@]}"; do [ "$n" -le "${#ITEM_IDS[@]}" ] || { echo "ERRO: --apelido=$n:… aponta um item que não existe (são ${#ITEM_IDS[@]}). Nada foi feito."; exit 1; }; done
ENTRADAS=()
for i in "${!ITEM_IDS[@]}"; do
  n=$((i+1)); emp="${EMPRESA_DO_ITEM[$n]:-$EMPRESA_GERAL}"
  [ -n "$emp" ] || { echo "ERRO: de qual empresa é o item $n (…${ITEM_IDS[$i]: -6})? Diga com --empresa=SLUG (todos) ou --empresa=SLUG:$n. Nada foi feito."; exit 1; }
  ent="$emp:${ITEM_IDS[$i],,}"; if [ -n "${APELIDO_DO_ITEM[$n]:-}" ]; then ent="$ent:${APELIDO_DO_ITEM[$n]}"; fi
  ENTRADAS+=("$ent")
done
ITENS_ENV="$(IFS=,; printf '%s' "${ENTRADAS[*]}")"

WH=""
if [ -f "$ARQ_WH" ]; then
  WH="$(tr -d '[:space:]' < "$ARQ_WH")"
  [[ "$WH" =~ ^whsec_[A-Za-z0-9+/=_-]{16,200}$ ]] || { echo "ERRO: o arquivo do webhook não tem um segredo no formato whsec_… (só letras, números e + / = _ -). Nada foi feito."; exit 1; }
fi

# ------------------------------------------------------------------ provar na Pluggy ANTES de mandar qualquer coisa à VPS
# o segredo vai pela entrada do curl (here-string), nunca na linha de comando (ps) nem em arquivo fora de $TMPD
echo "Conferindo na Pluggy (nada é gravado ainda)..."
CODIGO=$(curl -sS -m 25 -o "$RESP" -w '%{http_code}' -X POST "$API/auth" -H 'Content-Type: application/json' -H 'Accept: application/json' --data-binary @- <<< "{\"clientId\":\"$ID\",\"clientSecret\":\"$SEC\"}" || echo 000)
if [ "$CODIGO" != "200" ] || ! grep -q '"apiKey"' "$RESP"; then
  echo "ERRO: a Pluggy recusou o Client ID/Secret (HTTP $CODIGO). Confira pluggy_credenciais.txt (o secret vence em 180 dias). Nada foi gravado."
  [ "$CODIGO" = "403" ] && echo "      (403 pode ser a lista de IPs da aplicação: ela só deixa o IP do servidor entrar.)"
  exit 1
fi
APIKEY=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["apiKey"])' "$RESP")
rm -f "$RESP"
( umask 077; printf 'X-API-KEY: %s\n' "$APIKEY" > "$CAB" ); unset APIKEY
echo "OK: Client ID e Secret aceitos pela Pluggy."
for i in "${!ITEM_IDS[@]}"; do
  n=$((i+1))
  CODIGO=$(curl -sS -m 25 -o "$RESP" -w '%{http_code}' -H "@$CAB" -H 'Accept: application/json' "$API/items/${ITEM_IDS[$i]}" || echo 000)
  if [ "$CODIGO" != "200" ]; then echo "ERRO: o item $n (…${ITEM_IDS[$i]: -6}) não foi achado na Pluggy (HTTP $CODIGO). Nada foi gravado."; exit 1; fi
  python3 -I - "$RESP" "$n" "${EMPRESA_DO_ITEM[$n]:-$EMPRESA_GERAL}" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
print(f"- item {sys.argv[2]}: {(j.get('connector') or {}).get('name','?')} | status {j.get('status','?')} | última sincronização {j.get('lastUpdatedAt') or j.get('updatedAt') or '?'} | consentimento até {j.get('consentExpiresAt') or '?'} | empresa {sys.argv[3]}")
PY
done
rm -f "$RESP" "$CAB"

# ------------------------------------------------------------------ linhas do .env (carregam no bash E no env_file do docker: sem espaço nem aspas)
{
  printf 'PLUGGY_CLIENT_ID=%s\n' "$ID"
  printf 'PLUGGY_CLIENT_SECRET=%s\n' "$SEC"
  printf 'PLUGGY_ITENS=%s\n' "$ITENS_ENV"
  if [ -n "$WH" ]; then printf 'PLUGGY_WEBHOOK_SECRET=%s\n' "$WH"; fi
} >> "$LINHAS"
( set -eu; . "$LINHAS" ) || { echo "ERRO: as linhas não carregam no bash; nada foi feito."; exit 1; }

echo
echo "Vai gravar no .env da VPS (valores mascarados):"
echo "   PLUGGY_CLIENT_ID=$(mascara "$ID")"
echo "   PLUGGY_CLIENT_SECRET=$(mascara "$SEC")  (${#SEC} caracteres)"
mascarados=()
for e in "${ENTRADAS[@]}"; do
  emp="${e%%:*}"; resto="${e#*:}"; iid="${resto%%:*}"; ap=""; [[ "$resto" == *:* ]] && ap="${resto#*:}"
  mascarados+=("$emp:…${iid: -6}${ap:+:$ap}")
done
echo "   PLUGGY_ITENS=$(IFS=,; printf '%s' "${mascarados[*]}")"
if [ -n "$WH" ]; then echo "   PLUGGY_WEBHOOK_SECRET=whsec_$(mascara "${WH#whsec_}")"; else echo "   (sem $ARQ_WH: o webhook fica DESLIGADO — a rota responde 404 — e PLUGGY_WEBHOOK_SECRET será REMOVIDA se existir)"; fi
unset ID SEC WH
if [ $EXEC -ne 1 ]; then echo "(simulação: nada gravado. Para gravar: --executar)"; exit 0; fi

# ------------------------------------------------------------------ gravar na VPS
scp -q -i $KEY -o BatchMode=yes "$LINHAS" $VPS:/root/.pluggy-linhas-novas.env
ssh -i $KEY -o BatchMode=yes $VPS "bash -s -- ${VARS_LIGAR[*]}" <<'REMOTO'
set -euo pipefail
NOVAS=/root/.pluggy-linhas-novas.env
chmod 600 "$NOVAS"
cd /opt/doutordigital/agente-dt
F=.env; BAK="$F.bak-$(date +%Y%m%d-%H%M)-antes-pluggy"
cp -p "$F" "$BAK"
# estado final DECLARATIVO: sai toda variável da Pluggy antiga e entram as novas (o que não está nas novas, como o webhook sem arquivo, fica de fora e é tirado do serviço)
ADD=(); RM=()
for k in "$@"; do sed -i "/^${k}=/d" "$F"; done
sed -i '/^# 26\/11\/2026: Pluggy (leitura/d' "$F"
printf '\n# 26/11/2026: Pluggy (leitura bancária, só leitura) no conector\n' >> "$F"
cat "$NOVAS" >> "$F"
for k in "$@"; do if grep -q "^${k}=" "$NOVAS"; then :; else RM+=(--env-rm "$k"); fi; done
mapfile -t LINHAS_NOVAS < "$NOVAS"
for l in "${LINHAS_NOVAS[@]}"; do if [ -n "$l" ]; then ADD+=(--env-add "$l"); fi; done
if ! ( set -eu; set -a; . "./$F" ) >/dev/null 2>&1; then
  cp -p "$BAK" "$F"; rm -f "$NOVAS"
  echo "CONFERÊNCIA FALHOU: o .env não carrega no bash. Restaurei o backup ($BAK). Nada mudou."; exit 1
fi
echo "[1] .env atualizado e conferido (backup: /opt/doutordigital/agente-dt/$BAK)"
docker service update --quiet "${ADD[@]}" ${RM[@]+"${RM[@]}"} ddagent_agent >/dev/null
rm -f "$NOVAS"
# atualização rolante (start-first): espera terminar e sobrar UMA tarefa desejada. Nunca "o primeiro da lista": com a antiga ainda de pé, ele seria a ANTIGA.
OK=0
for i in $(seq 1 45); do
  mapfile -t TAREFAS < <(docker service ps ddagent_agent --filter desired-state=running --format '{{.ID}}')
  EST=$(docker service inspect --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{else}}sem-atualizacao{{end}}' ddagent_agent)
  if [ "${#TAREFAS[@]}" = "1" ] && { [ "$EST" = "completed" ] || [ "$EST" = "sem-atualizacao" ]; }; then OK=1; break; fi
  sleep 2
done
if [ $OK -ne 1 ]; then echo "AVISO: a atualização do serviço não terminou em 90 s (tarefas desejadas: ${#TAREFAS[@]}, estado: $EST). Não conferi o contêiner: veja 'docker service ps ddagent_agent'."; exit 0; fi
# o contêiner da tarefa NOVA (a única desejada), não o primeiro de `docker ps`
C=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "${TAREFAS[0]}")
# confere SEM imprimir segredo: só se existe, e quantos caracteres tem
for k in PLUGGY_CLIENT_ID PLUGGY_CLIENT_SECRET PLUGGY_WEBHOOK_SECRET; do
  echo "[2] no contêiner novo: $k presente=$(docker exec "$C" sh -c "test -n \"\$$k\" && echo SIM || echo nao") tamanho=$(docker exec "$C" sh -c "printf %s \"\$$k\" | wc -c")"
done
echo "[2] PLUGGY_ITENS: $(docker exec "$C" sh -c 'printf %s "$PLUGGY_ITENS" | tr "," "\n" | wc -l') item(ns) configurado(s)"
REMOTO
echo "PRONTO. Confira pelo conector (sessão de quem altera cartões): pluggy_contas com testar=true (prova as credenciais e mostra a última sincronização de cada banco)."
echo "Webhook (opcional): cadastre no Dashboard da Pluggy a URL https://agente-vps.doutordigitalconsultoria.com/api/webhooks/pluggy (eventos item/updated e item/error, ou todos) com o MESMO segredo whsec_."
echo "Para desfazer: bash $DIR/ligar-pluggy.sh --desligar --executar   (ou restaure o .env.bak-…-antes-pluggy e rode docker service update --env-rm das variáveis PLUGGY_*)."
