#!/usr/bin/env bash
# IMPORTA O HISTÓRICO DA KOMMO de Timbó para o CRM de Timbó (conta 3 do Chatwoot): escopo B do João (25/11/2026) — TODOS os cartões ABERTOS
# (Comercial e Tratamento) + os GANHOS e PERDIDOS dos últimos 6 meses. Cada cartão vira um contato (nome + telefone), uma conversa RESOLVIDA com a
# etiqueta `historico`, os atributos do CRM (funil, etapa, consulta…), uma NOTA-resumo e as últimas 50 mensagens.
# Roda no COMPUTADOR DO JOÃO (faz o ssh sozinho). Dado de paciente NÃO sai da VPS: a Kommo é lida de dentro do contêiner do agente, o arquivo
# passa direto para o contêiner do CRM (sem arquivo no hospedeiro) e é apagado no fim; nada é gravado com callbacks (sem notificação, evento,
# webhook nem mensagem para o paciente). Na tela e nos logs: só ids e contagens.
#
#   ORDEM: o importador RECUSA se a conta ainda não tem a caixa do WhatsApp (os contatos têm de casar com os que ela vai criar). Rode DEPOIS do Kapso.
#
#   bash ops/historico-kommo-crm-joao.sh --so-conferir               # só lê a Kommo e conta (cartões por etapa, mensagens, duração); funciona ANTES da caixa
#   bash ops/historico-kommo-crm-joao.sh --so-conferir --completo    # lê TUDO e confere contra o CRM (contatos novos/reaproveitados…); exige a caixa
#   bash ops/historico-kommo-crm-joao.sh --limite=5                  # piloto: grava só os 5 cartões mais recentes
#   bash ops/historico-kommo-crm-joao.sh                             # o lote inteiro
#   opções: --caixa=N (se a conta tiver mais de uma de WhatsApp)   --conta=3   --unidade=doutor-hernia-timbo
#
#   DESFAZER (usa o registro de ids que cada rodada deixa no log):
#   bash ops/historico-kommo-crm-joao.sh --desfazer=historico-kommo-AAAAMMDD-HHMMSS-gravar.txt                      # só mostra o que desfaria
#   bash ops/historico-kommo-crm-joao.sh --desfazer=ARQ --confirmo-apagar                                           # desfaz (APAGA as linhas criadas)
#
# Pré-requisito: o deploy do PR que traz o exportador (backend/dist/scripts/kommo-historico-exportar.js); o script recusa, dizendo o motivo, se faltar.
# O processo sobrevive à queda do ssh (roda desacoplado na VPS); o log fica em /root/kit/logs/historico-kommo-<data>-<modo>.txt e esta tela só o
# acompanha (`--acompanhar=<arquivo>` para voltar a olhar). Repetir é seguro: cartão já importado (id do cartão da Kommo) só ganha mensagem nova
# (atributo e etiqueta nunca são escritos em conversa que já existe). Variáveis: VPS (padrão root@89.116.214.130), CHAVE_SSH (padrão ~/.ssh/doutordigital_vps).
set -euo pipefail

VPS="${VPS:-root@89.116.214.130}"
CHAVE="${CHAVE_SSH:-$HOME/.ssh/doutordigital_vps}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASTA="$AQUI/crm-historico-kommo"
[[ "$VPS" =~ ^[A-Za-z0-9._@-]+$ ]] || { echo "VPS inválida: $VPS"; exit 2; }
[ -r "$CHAVE" ] || { echo "RECUSO: não achei a chave ssh em $CHAVE. Este comando roda no computador do João (que tem a chave da VPS), não aqui."; exit 1; }
[ -f "$PASTA/importar-kommo-historico.rb" ] || { echo "RECUSO: não achei $PASTA (rode de dentro do repositório)"; exit 1; }

SECO=0; COMPLETO=0; LIMITE=""; CAIXA=""; CONTA="3"; UNIDADE="doutor-hernia-timbo"; DESFAZER=""; CONFIRMO=0; ACOMPANHAR=""
for a in "$@"; do
  case "$a" in
    --so-conferir) SECO=1 ;;
    --completo) COMPLETO=1 ;;
    --limite=*) [[ "$a" =~ ^--limite=[1-9][0-9]*$ ]] || { echo "opção inválida: $a (use um número maior que zero; 0 NÃO significa «sem limite» — para o lote inteiro tire a opção)"; exit 2; }; LIMITE="${a#--limite=}" ;;
    --caixa=*) [[ "$a" =~ ^--caixa=[1-9][0-9]*$ ]] || { echo "opção inválida: $a"; exit 2; }; CAIXA="${a#--caixa=}" ;;
    --conta=*) [[ "$a" =~ ^--conta=[1-9][0-9]*$ ]] || { echo "opção inválida: $a"; exit 2; }; CONTA="${a#--conta=}" ;;
    --unidade=*) [[ "$a" =~ ^--unidade=[a-z0-9-]{3,50}$ ]] || { echo "opção inválida: $a"; exit 2; }; UNIDADE="${a#--unidade=}" ;;
    --desfazer=*) [[ "$a" =~ ^--desfazer=historico-kommo-[0-9]{8}-[0-9]{6}-gravar\.txt$ ]] || { echo "opção inválida: $a (nome do log de uma rodada que GRAVOU, ex.: historico-kommo-20261126-153000-gravar.txt)"; exit 2; }; DESFAZER="${a#--desfazer=}" ;;
    --confirmo-apagar) CONFIRMO=1 ;;
    --acompanhar=*) [[ "$a" =~ ^--acompanhar=historico-kommo-[0-9]{8}-[0-9]{6}-[a-z]+\.txt$ ]] || { echo "opção inválida: $a"; exit 2; }; ACOMPANHAR="${a#--acompanhar=}" ;;
    *) echo "opção inválida: $a (use --so-conferir [--completo], --limite=N, --caixa=N, --conta=N, --unidade=slug, --desfazer=ARQ [--confirmo-apagar], --acompanhar=ARQ)"; exit 2 ;;
  esac
done

# combinações inválidas são RECUSADAS (uma opção que «não se aplica» não pode virar outra coisa em silêncio: --completo sozinho gravaria)
if [ -n "$ACOMPANHAR" ]; then
  [ "$SECO$COMPLETO$CONFIRMO" = 000 ] && [ -z "$LIMITE$CAIXA$DESFAZER" ] || { echo "RECUSO: --acompanhar não combina com outras opções (só olha um log que já existe)"; exit 2; }
fi
[ "$COMPLETO" = 1 ] && [ "$SECO" != 1 ] && { echo "RECUSO: --completo só vale junto de --so-conferir (sozinho GRAVARIA o lote inteiro). Para gravar, rode sem --completo."; exit 2; }
[ "$CONFIRMO" = 1 ] && [ -z "$DESFAZER" ] && { echo "RECUSO: --confirmo-apagar só vale junto de --desfazer=<log>."; exit 2; }
if [ -n "$DESFAZER" ]; then
  [ "$SECO" = 1 ] && { echo "RECUSO: --desfazer já é só-mostrar sem --confirmo-apagar; não combina com --so-conferir."; exit 2; }
  [ "$COMPLETO" = 1 ] && { echo "RECUSO: --desfazer não combina com --completo."; exit 2; }
  [ -n "$LIMITE" ] && { echo "RECUSO: --desfazer desfaz a rodada INTEIRA do log; não combina com --limite."; exit 2; }
fi

SSH=(ssh -i "$CHAVE" -o ConnectTimeout=15 -o ServerAliveInterval=20 "$VPS")

acompanhar() { # $1 = nome do log na VPS
  local log="/root/kit/logs/$1" desde=0 saiu=0 tmp mortos=0 vivo
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  echo "acompanhando $log (Ctrl-C só para de olhar; a rodada continua na VPS)"
  while true; do
    if "${SSH[@]}" "tail -c +$((desde + 1)) $log 2>/dev/null | head -c 200000" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      grep -v '^REG ' "$tmp" || true
      desde=$((desde + $(wc -c < "$tmp")))
      grep -qE '^LOG FIM do processo' "$tmp" && saiu=1
    fi
    [ "$saiu" = 1 ] && break
    # o processo na VPS morreu sem escrever o FIM (reinício, OOM, kill)? 3 conferências seguidas sem ele: avisa e para de esperar
    vivo="$("${SSH[@]}" "pgrep -f '[r]odar-na-vps.sh /root/kit/logs/$1' > /dev/null && echo s || echo n" 2>/dev/null || echo s)"
    if [ "$vivo" = n ]; then mortos=$((mortos + 1)); else mortos=0; fi
    if [ "$mortos" -ge 3 ]; then echo "O processo na VPS terminou SEM escrever o fim. Olhe o log (/root/kit/logs/$1) antes de rodar de novo; o registro de ids do que já foi gravado está lá."; break; fi
    sleep 10
  done
  echo "REGISTRO (ids, para desfazer) no log da VPS: /root/kit/logs/$1"
  # o código de saída do script é o do processo na VPS (0 = deu certo): quem encadeia comandos não pode achar que sucesso foi falha, nem o contrário
  [ "$mortos" -ge 3 ] && return 3
  local cod
  cod="$(grep -oE 'LOG FIM do processo \(código [0-9]+\)' "$tmp" | tail -1 | grep -oE '[0-9]+' || true)"
  return "${cod:-0}"
}

if [ -n "$ACOMPANHAR" ]; then acompanhar "$ACOMPANHAR"; exit $?; fi

# o exportador faz ~1.300 chamadas à Kommo em ~25 min, no MESMO token do atendimento ao vivo (a Sofia e a equipe): rode FORA do expediente
if [ -z "$DESFAZER" ]; then
  H="$(date +%H)"
  if [ "$H" -ge 7 ] && [ "$H" -lt 19 ]; then
    echo "ATENÇÃO: são ${H}h. O exportador usa o mesmo token da Kommo do atendimento ao vivo (cerca de 1.300 chamadas em ~25 min): prefira rodar à NOITE ou de madrugada."
    if [ -t 0 ]; then read -r -p "Continuar mesmo assim? [s/N] " R; [[ "$R" =~ ^[sS]$ ]] || { echo "ok, não rodei."; exit 0; }; fi
  fi
fi

# 1) leva o código para a VPS
tar czf - -C "$PASTA" kommo_historico.rb importar-kommo-historico.rb rodar-na-vps.sh \
  | "${SSH[@]}" 'mkdir -p /root/kit/crm-historico-kommo /root/kit/logs && tar xzf - -C /root/kit/crm-historico-kommo && chmod +x /root/kit/crm-historico-kommo/rodar-na-vps.sh'

STAMP="$(date +%Y%m%d-%H%M%S)"
VARS="UNIDADE=$UNIDADE CONTA=$CONTA"
[ -n "$CAIXA" ] && VARS="$VARS CAIXA=$CAIXA"
[ -n "$LIMITE" ] && VARS="$VARS LIMITE=$LIMITE"
if [ -n "$DESFAZER" ]; then
  MODO="desfazer"; LOGNOME="historico-kommo-$STAMP-desfazer.txt"
  [ "$CONFIRMO" = 1 ] && VARS="$VARS GRAVAR=1" || VARS="$VARS GRAVAR=0"
  VARS="$VARS REGISTRO=$DESFAZER"
  echo "DESFAZER ($([ "$CONFIRMO" = 1 ] && echo 'VAI APAGAR' || echo 'só mostra')) com o registro de $DESFAZER"
elif [ "$SECO" = 1 ]; then
  MODO="conferir"; LOGNOME="historico-kommo-$STAMP-conferir.txt"
  [ "$COMPLETO" = 1 ] && VARS="$VARS COMPLETO=1"
  echo "CONFERÊNCIA EM SECO$([ "$COMPLETO" = 1 ] && echo ' COMPLETA (lê tudo e confere contra o CRM)' || echo ' (só lê a Kommo e conta)') — unidade $UNIDADE${LIMITE:+, limite $LIMITE cartões}"
else
  MODO="gravar"; LOGNOME="historico-kommo-$STAMP-gravar.txt"
  echo "GRAVANDO no CRM (conta $CONTA) — unidade $UNIDADE${LIMITE:+, limite $LIMITE cartões}"
fi
"${SSH[@]}" "setsid nohup /root/kit/crm-historico-kommo/rodar-na-vps.sh /root/kit/logs/$LOGNOME $MODO $VARS > /dev/null 2>&1 < /dev/null &"
sleep 3
acompanhar "$LOGNOME"
exit $?
