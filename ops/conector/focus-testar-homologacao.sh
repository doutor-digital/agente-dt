#!/bin/bash
# Reenvia o DPS MÍNIMO de Açailândia à HOMOLOGAÇÃO da Focus NFe (nunca produção) e confere se o erro E1235 do ambiente nacional ainda existe (26/11/2026).
#
#   bash ~/Kommo-Integracao/_replicacao/focus-testar-homologacao.sh              # envia 1 nota de teste (dados fictícios), acompanha até 90 s e diz o resultado
#   bash ~/Kommo-Integracao/_replicacao/focus-testar-homologacao.sh --sem-aliquota   # igual, mas SEM o campo da alíquota do ISS (para ver se o ADN prefere a omissão com Simples)
#   bash ~/Kommo-Integracao/_replicacao/focus-testar-homologacao.sh --cancelar       # se a nota for AUTORIZADA, cancela em seguida (teste do cancelamento)
#   --serie=N   série da DPS do teste (padrão 9999, para não mexer na numeração da série 1 que o conector usa; se a Focus/ADN recusar a série, use --serie=1)
#
# O bloqueio: toda nota enviada em homologação termina em erro_autorizacao E1235 («The element 'infDPS' … has invalid child element 'serv' … expected: 'indDest'»), porque o ambiente
# nacional pede `indDest` direto em infDPS e o gerador da Focus (NT-009 pacote 1) o coloca dentro de IBSCBS. Este script prova, no MESMO dia em que a Focus corrigir, que a nota passou a autorizar.
#
# Saída (código de retorno):  0 = AUTORIZADA (E1235 SUMIU: pode provar PDF/XML/cancelamento e liberar o PR #500)
#                             6 = AUTORIZADA, mas o cancelamento (--cancelar) NÃO foi aceito
#                             3 = E1235 AINDA PRESENTE (nada mudou)    4 = outro erro (o texto exato é impresso)    5 = sem resposta final em 90 s    1 = problema local (token etc.)
# Lê o token de HOMOLOGAÇÃO em ~/Kommo-Integracao/_replicacao/focus_nfe_tokens.txt (FOCUS_TOKEN_HOMOLOGACAO_ACAILANDIA) e NUNCA o imprime. O endereço é fixo: homologacao.focusnfe.com.br.
# Dados 100% FICTÍCIOS do tomador (CPF de exemplo válido). Cada rodada gera uma referência e um número de DPS novos. A nota de homologação não tem validade fiscal.
set -euo pipefail
ARQ="${FOCUS_TOKENS_ARQUIVO:-$HOME/Kommo-Integracao/_replicacao/focus_nfe_tokens.txt}"
python3 -I - "$ARQ" "$@" <<'PY'
import base64, json, re, sys, time, urllib.request, urllib.error, datetime, random
arq, args = sys.argv[1], sys.argv[2:]
SEM_ALIQ = "--sem-aliquota" in args
CANCELAR = "--cancelar" in args
SERIE = 9999
for a in args:
    if a.startswith("--serie=") and a[8:].isdigit() and 1 <= int(a[8:]) <= 49999:
        SERIE = int(a[8:]); continue
    if a not in ("--sem-aliquota", "--cancelar"):
        print("argumento desconhecido:", a); sys.exit(1)
tok = ""
try:
    for l in open(arq, encoding="utf-8"):
        l = l.strip()
        if l.startswith("FOCUS_TOKEN_HOMOLOGACAO_ACAILANDIA="):
            tok = l.split("=", 1)[1].strip().strip('"').strip("'")
except OSError:
    print("ERRO: não achei", arq); sys.exit(1)
if not re.fullmatch(r"[A-Za-z0-9]{16,64}", tok):
    print("ERRO: FOCUS_TOKEN_HOMOLOGACAO_ACAILANDIA vazio ou com formato estranho."); sys.exit(1)
BASE = "https://homologacao.focusnfe.com.br"          # fixo: este script nunca fala com produção
AUTH = "Basic " + base64.b64encode((tok + ":").encode()).decode()

def chamar(metodo, caminho, corpo=None):
    req = urllib.request.Request(BASE + caminho, method=metodo, data=json.dumps(corpo).encode() if corpo is not None else None)
    req.add_header("Authorization", AUTH); req.add_header("Accept", "application/json"); req.add_header("User-Agent", "dd-conector-teste/1.0")
    if corpo is not None: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
    except Exception as e: return 0, type(e).__name__
def limpa(t): return t.replace(tok, "[token]")

agora = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3)))
ref = "ddteste" + format(int(time.time()), "x") + str(random.randint(10, 99))
corpo = {
    "data_emissao": (agora - datetime.timedelta(seconds=60)).strftime("%Y-%m-%dT%H:%M:%S-03:00"),
    "serie_dps": SERIE, "numero_dps": random.randint(1, 899999),
    "data_competencia": agora.strftime("%Y-%m-%d"), "emitente_dps": 1, "codigo_municipio_emissora": 2100055,
    "cnpj_prestador": "63130582000140", "inscricao_municipal_prestador": "1000000007142",
    "codigo_opcao_simples_nacional": 3, "regime_tributario_simples_nacional": 1, "regime_especial_tributacao": 0,
    "cpf_tomador": "52998224725", "razao_social_tomador": "PACIENTE FICTICIO DE TESTE",
    "codigo_municipio_prestacao": "2100055", "codigo_tributacao_nacional_iss": "040802", "codigo_nbs": "123019200",
    "descricao_servico": "Serviços de fisioterapia", "valor_servico": 1, "tributacao_iss": 1, "tipo_retencao_iss": 1,
    "finalidade_emissao": 0, "consumidor_final": 1, "indicador_destinatario": 0,
    "ibs_cbs_situacao_tributaria": "000", "ibs_cbs_classificacao_tributaria": "000001", "indicador_total_tributacao": 0,
}
if not SEM_ALIQ: corpo["percentual_aliquota_relativa_municipio"] = 0
print("Homologação · referência", ref, "· série", SERIE, "· alíquota:", "omitida" if SEM_ALIQ else "0")
st, txt = chamar("POST", "/v2/nfsen?ref=" + ref, corpo)
print("POST /v2/nfsen ->", st, limpa(txt)[:300].replace("\n", " "))
if st not in (200, 201, 202): print("A Focus recusou já no envio (pré-validação síncrona)."); sys.exit(4)
final = None
for i in range(30):
    time.sleep(3)
    st, txt = chamar("GET", "/v2/nfsen/" + ref)
    try: j = json.loads(txt)
    except Exception: j = {}
    s = j.get("status")
    if s and s != "processando_autorizacao": final = j; break
if not final: print("Sem resposta final em 90 s (ainda processando_autorizacao)."); sys.exit(5)
if final.get("status") == "autorizado":
    print("RESULTADO: AUTORIZADA — o E1235 SUMIU. Número", final.get("numero"), "| código de verificação", "sim" if final.get("codigo_verificacao") else "não", "| PDF", "sim" if final.get("url_danfse") else "não", "| XML", "sim" if final.get("caminho_xml_nota_fiscal") else "não")
    if CANCELAR:
        st, txt = chamar("DELETE", "/v2/nfsen/" + ref, {"justificativa": "Teste de homologação: cancelamento da nota de prova"})
        print("CANCELAR ->", st, limpa(txt)[:300].replace("\n", " "))
        try: cancelou = st == 200 and json.loads(txt).get("status") == "cancelado"
        except Exception: cancelou = False
        if not cancelou: print("A nota foi autorizada, mas o CANCELAMENTO NÃO foi aceito (veja a resposta acima)."); sys.exit(6)
    sys.exit(0)
erros = final.get("erros") or []
texto = limpa(json.dumps(erros, ensure_ascii=False))
print("RESULTADO:", final.get("status"), texto[:700])
if any(e.get("codigo") == "E1235" for e in erros if isinstance(e, dict)): print("E1235 AINDA PRESENTE: o ambiente nacional ainda recusa o DPS; nada mudou."); sys.exit(3)
sys.exit(4)
PY
