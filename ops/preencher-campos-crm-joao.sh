#!/usr/bin/env bash
# PREENCHE OS CAMPOS VAZIOS do CRM (Chatwoot de Parauapebas, caixa 3 = WhatsApp oficial) — LOTE 2: etapa, funil, motivo e qualificação, a partir
# do cartão do Kommo (só leitura), da agenda da franquia (o que o chatwoot-agenda já gravou) e da classificação da Sofia (últimos 30 dias).
# Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho), mas o PROCESSO roda NA VPS, desligado do ssh (nohup/setsid): se a conexão cair, ele segue — a guarda
# das marcas da régua (12 min) e o registro para desfazer não se perdem. A saída não tem nome, telefone nem texto de paciente.
#
#   bash ops/preencher-campos-crm-joao.sh --so-conferir          # 1º: mostra, por conversa, campo (vazio) → valor + regra. NÃO grava nada
#   bash ops/preencher-campos-crm-joao.sh                        # depois: grava (até 150 conversas por vez; --max=N muda)
#   bash ops/preencher-campos-crm-joao.sh --acompanhar=NOME      # reata o acompanhamento de uma execução que está na VPS (ou já terminou)
#   bash ops/preencher-campos-crm-joao.sh --desfazer=ARQUIVO     # devolve ao que era, a partir do arquivo de uma gravação anterior
#   opções: --conversas=12,34 (só estas)  --caixa=3  --max=150  --guarda=12 (minutos de guarda das marcas)  --mesmo-na-janela
#
# ONDE FICA: o log (com as linhas «REG {…}», o registro para desfazer) é gravado NA VPS em /root/kit/logs/NOME.log, terminando com «FIM rc=N»;
# e uma cópia é feita aqui em ~/crm-campos-NOME.log ao acompanhar. Acompanhar à mão: ssh -i ~/.ssh/doutordigital_vps root@VPS tail -f /root/kit/logs/NOME.log
# JANELA: rode FORA de segunda a sábado 08–20h de Belém (a régua só fala nesse horário; fora dela qualquer regra que se acorde por engano não sai na hora)
# e o Kommo está mais folgado (~900 buscas). Dentro da janela o comando que GRAVA recusa, a não ser com --mesmo-na-janela; o --so-conferir só avisa.
# Gravando, o processo fica ~12 minutos depois do último campo «guardando» as marcas da régua; o acompanhamento termina em «FIM».
# Só preenche campo VAZIO (nunca sobrescreve). Antes de cada campo, grava as «marcas» que impedem a régua de falar com o paciente e a Meta de
# receber evento de conversão (ver backend/src/lib/chatwoot-campos-retroativos.ts). Repetir é seguro.
# Pré-requisito: o deploy do PR que traz o script já ter subido (o script recusa, dizendo o motivo, se o contêiner não tiver o arquivo).
# Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
SSH=(ssh -i "$CHAVE" -o ConnectTimeout=15 -o ServerAliveInterval=30)
DIR_REMOTO=/root/kit/logs

# só as opções conhecidas, no formato certo (nada é interpretado na VPS)
ARGS=""
SECO=0
DESFAZER=""
ACOMPANHAR=""
NA_JANELA=0
for a in "$@"; do
  if [[ "$a" == "--so-conferir" ]]; then
    SECO=1; ARGS+=" $(printf '%q' "$a")"
  elif [[ "$a" == "--mesmo-na-janela" ]]; then
    NA_JANELA=1
  elif [[ "$a" =~ ^--caixa=[0-9]+$ || "$a" =~ ^--max=[0-9]+$ || "$a" =~ ^--guarda=[0-9]+$ || "$a" =~ ^--conversas=[0-9]+(,[0-9]+)*$ ]]; then
    ARGS+=" $(printf '%q' "$a")"
  elif [[ "$a" == --desfazer=* ]]; then
    DESFAZER="${a#--desfazer=}"
    [ -r "$DESFAZER" ] || { echo "RECUSO: não consigo ler o arquivo do registro: $DESFAZER"; exit 2; }
    ARGS+=" --desfazer"
  elif [[ "$a" =~ ^--acompanhar=[A-Za-z0-9._-]+$ ]]; then
    ACOMPANHAR="${a#--acompanhar=}"
  else
    echo "opção inválida: $a (use --so-conferir, --desfazer=ARQUIVO, --acompanhar=NOME, --conversas=1,2, --caixa=N, --max=N, --guarda=MIN, --mesmo-na-janela)"; exit 2
  fi
done
[ -z "$DESFAZER" ] || [ "$SECO" = 0 ] || { echo "RECUSO: --desfazer não combina com --so-conferir"; exit 2; }

acompanhar() { # NOME → mostra o log da VPS até o «FIM», guarda cópia local, devolve o código do processo
  local nome="$1" local_log="$HOME/crm-campos-$1.log" rc
  echo "acompanhando $DIR_REMOTO/$nome.log (cópia em $local_log). Se o ssh cair, o processo continua na VPS: bash $0 --acompanhar=$nome"
  set +e
  "${SSH[@]}" "$VPS" "F=$DIR_REMOTO/$nome.log; [ -f \$F ] || { echo 'ERRO: não achei '\$F; exit 1; }; tail -n +1 -f \$F & T=\$!; until grep -q '^FIM rc=' \$F; do sleep 3; done; sleep 1; kill \$T 2>/dev/null; true" 2>&1 | tee "$local_log"
  set -e
  rc=$("${SSH[@]}" "$VPS" "grep -o '^FIM rc=[0-9]*' $DIR_REMOTO/$nome.log | tail -1 | cut -d= -f2" 2>/dev/null || true)
  echo
  echo "conversas por regra (linhas do relatório):"
  grep -oE '\[(etapa-kommo|motivo-kommo|tratamento-kommo|compareceu-agenda|qualificacao-sofia|espera-kommo)' "$local_log" | sort | uniq -c || true
  if [ -z "$rc" ]; then echo "ATENÇÃO: a conexão caiu antes do «FIM»; o processo segue na VPS. Reate com: bash $0 --acompanhar=$nome"; return 4; fi
  [ "$rc" = 0 ] || echo "ATENÇÃO: terminou com código $rc (veja as linhas ERRO/FALHOU/AVISO em $local_log)"
  return "$rc"
}

if [ -n "$ACOMPANHAR" ]; then
  acompanhar "$ACOMPANHAR"; exit $?
fi

# a janela da régua (segunda a sábado, 08–20h de Belém): quem GRAVA espera ela fechar
DIA=$(TZ=America/Belem date +%u); HORA=$((10#$(TZ=America/Belem date +%H)))
if [ "$DIA" != 7 ] && [ "$HORA" -ge 8 ] && [ "$HORA" -lt 20 ]; then
  if [ "$SECO" = 1 ]; then
    echo "AVISO: agora é horário da régua em Belém (seg–sáb 08–20h). O --so-conferir só lê, mas o Kommo está em uso; o ideal é rodar à noite."
  elif [ "$NA_JANELA" = 0 ]; then
    echo "RECUSO: agora é horário da régua em Belém (seg–sáb 08–20h). Fora dele, qualquer regra acordada por engano não sai na hora e o Kommo fica livre."
    echo "Rode depois das 20h, ou aos domingos, ou repita com --mesmo-na-janela se você assume o risco."
    exit 3
  fi
fi

NOME="preencher-campos-$(date +%Y%m%d-%H%M%S)$([ "$SECO" = 1 ] && echo -seco || true)"
FLAG_I=""; ENTRADA=""
if [ -n "$DESFAZER" ]; then
  FLAG_I="-i"; ENTRADA="< $DIR_REMOTO/$NOME.entrada"
  "${SSH[@]}" "$VPS" "mkdir -p $DIR_REMOTO && cat > $DIR_REMOTO/$NOME.entrada" < "$DESFAZER"
fi

# O processo sobe na VPS desligado do ssh (setsid + nohup), com a saída num arquivo de lá. A regra do `docker exec -i` dentro de `bash -s` engolir o
# script não pega aqui: o stdin do docker exec é redirecionado (arquivo ou /dev/null).
"${SSH[@]}" "$VPS" bash -s <<REMOTO
set -e
mkdir -p $DIR_REMOTO
A=\$(docker ps --filter 'name=ddagent_agent' --format '{{.CreatedAt}}|{{.ID}}' | sort -r | head -1 | cut -d'|' -f2)
[ -n "\$A" ] || { echo 'ERRO: não achei o contêiner ddagent_agent'; exit 1; }
docker exec "\$A" test -f /repo/backend/dist/scripts/preencher-campos-crm.js || { echo 'ERRO: o contêiner ainda não tem o script (backend/dist/scripts/preencher-campos-crm.js): publique o deploy do PR antes.'; exit 1; }
nohup setsid bash -c "docker exec $FLAG_I -w /repo/backend \$A node dist/scripts/preencher-campos-crm.js$ARGS ${ENTRADA:-</dev/null}; echo \"FIM rc=\\\$?\"" > $DIR_REMOTO/$NOME.log 2>&1 < /dev/null &
sleep 1
echo "iniciado na VPS: $DIR_REMOTO/$NOME.log"
REMOTO
echo "Para acompanhar de outro terminal: ssh -i $CHAVE $VPS tail -f $DIR_REMOTO/$NOME.log"
acompanhar "$NOME"
