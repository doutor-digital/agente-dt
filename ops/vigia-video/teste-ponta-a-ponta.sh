#!/usr/bin/env bash
# Teste de ponta a ponta do lado do PC, sem servidor: vídeo sintético -> enviar-gravacoes.sh -> pasta de destino local.
# Confere: gravação em andamento e nome fora do formato NÃO entram; a pronta gera exatamente os 2 eventos esperados; o
# pacote chega com meta.json por último; rodar de novo não reenvia. Deixa o pacote em $PASTA/destino para o teste do conector.
#
# Uso: bash teste-ponta-a-ponta.sh [PASTA_DE_TRABALHO]   (padrão: um diretório temporário novo; nada é apagado)
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASTA="${1:-$(mktemp -d -t vigia-e2e-XXXXXX)}"
[ ! -e "$PASTA/estado" ] || { echo "FALHOU: $PASTA já tem estado de um teste anterior; use uma pasta nova (ou nenhuma, que eu crio)" >&2; exit 1; }
mkdir -p "$PASTA/origem"
falha() { echo "FALHOU: $*" >&2; exit 1; }

bash "$AQUI/gerar-video-sintetico.sh" "$PASTA/origem/2026-11-03_08-00-00_caixa.mkv" 240
cp "$PASTA/origem/2026-11-03_08-00-00_caixa.mkv" "$PASTA/origem/2026-11-03_09-00-00_estoque.mkv"
cp "$PASTA/origem/2026-11-03_08-00-00_caixa.mkv" "$PASTA/origem/Gravacao-qualquer.mkv"
touch -d '2 hours ago' "$PASTA/origem/2026-11-03_08-00-00_caixa.mkv" "$PASTA/origem/Gravacao-qualquer.mkv"
# 09h00_estoque fica com a data de agora: "mexida há poucos segundos" (OBS ainda gravando)

# o limite de "terminou" fica alto: a triagem do primeiro vídeo não pode fazer o "recente" envelhecer no meio do teste
export VIGIA_PARADO_SEG=3000
export VIGIA_ORIGEM="$PASTA/origem" VIGIA_TRABALHO="$PASTA/trabalho" VIGIA_ESTADO="$PASTA/estado" VIGIA_DESTINO="$PASTA/destino/"

echo "--- simulação"
saida="$(bash "$AQUI/enviar-gravacoes.sh" --simular)"; echo "$saida"
grep -q "PRONTA.*2026-11-03_08-00-00_caixa.mkv -> caixa/2026-11-03_0800" <<<"$saida" || falha "a gravação terminada deveria estar pronta"
grep -q "espera: 2026-11-03_09-00-00_estoque.mkv" <<<"$saida" || falha "a gravação recente deveria esperar"
grep -q "ignorada (nome fora do formato.*Gravacao-qualquer.mkv" <<<"$saida" || falha "o nome fora do formato deveria ser ignorado"

echo "--- envio que falha (destino impossível): a triagem fica pronta e não se repete na próxima rodada"
falhou="$(VIGIA_DESTINO=/proc/nao-existe/ bash "$AQUI/enviar-gravacoes.sh")"; echo "$falhou"
grep -q "FALHOU o envio de 2026-11-03_08-00-00_caixa.mkv" <<<"$falhou" || falha "o envio para destino impossível deveria falhar"
[ ! -e "$PASTA/estado/enviados/2026-11-03_08-00-00_caixa.mkv" ] || falha "marcou como enviada uma gravação que falhou"

echo "--- envio"
reenvio="$(bash "$AQUI/enviar-gravacoes.sh")"; echo "$reenvio"
grep -q "já pronta em .*; só envio" <<<"$reenvio" || falha "a triagem foi refeita depois de uma falha só de envio"
D="$PASTA/destino/caixa/2026-11-03_0800"
for f in eventos.json resumo.md meta.json folhas/evento_0001.jpg folhas/evento_0002.jpg clipes/evento_0001.mp4 clipes/evento_0002.mp4; do
  [ -s "$D/$f" ] || falha "faltou $f no destino"
done
[ ! -e "$D/folhas/evento_0003.jpg" ] || falha "evento a mais (falso positivo)"
[ ! -e "$PASTA/destino/estoque" ] || falha "a gravação recente foi enviada"

python3 -I - "$D" <<'PY'
import json, sys
d = sys.argv[1]
ev = json.load(open(d + "/eventos.json"))
meta = json.load(open(d + "/meta.json"))
assert meta["camera"] == "caixa" and meta["inicio_gravacao"] == "2026-11-03T08:00:00", meta
assert len(ev["eventos"]) == 2, [e["id"] for e in ev["eventos"]]
for e, (ini, fim) in zip(ev["eventos"], [(40, 70), (150, 170)]):
    assert e["inicio"] <= ini + 2 and e["fim"] >= fim - 2, (e["id"], e["inicio"], e["fim"])
    assert e["folha"].startswith("folhas/") and e["clipe"].startswith("clipes/"), e
    assert len(e["quadros_seg"]) == 12
assert "/" not in ev["video"]
horas = {h["hora"]: h["segundos"] for h in ev["movimento_por_hora"]}
assert horas["2026-11-03T08:00"] > 0, horas
print("eventos:", [(e["id"], round(e["inicio"]), round(e["fim"]), e["hora_real"]) for e in ev["eventos"]])
print("movimento por hora:", horas)
PY

echo "--- segunda rodada não reenvia"
bash "$AQUI/enviar-gravacoes.sh" | tee "$PASTA/segunda.log"
grep -q "0 gravação(ões) enviada(s)" "$PASTA/segunda.log" || falha "reenviou a mesma gravação"
echo "OK. Pacote de teste em: $D"
