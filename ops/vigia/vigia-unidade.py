#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VIGIA DE UNIDADE — o relógio. Mede de hora em hora, compara com a última medida e só fala quando PIORA.

Desenho aprovado pela dona em 24/10 e pedido de novo hoje (26/10): "uma IA de auditoria conversando
com a equipe de TI, sem eu precisar ficar digitando o que precisa ser corrigido". A corrente é:

    contagem SEM IA (medir-unidade.mjs, dentro do ddagent_agent)
      → piorou?  não → SILÊNCIO TOTAL (nenhuma mensagem, nenhum agente acordado)
      → piorou?  sim → alerta curto no Telegram da GESTÃO  +  ficha na fila do auditor
      → o auditor (agente) investiga, escreve a ficha e prepara o PR. Ele NUNCA aplica.

O VIGIA VIGIA O SISTEMA, NÃO AS PESSOAS. Nenhum alerta nomeia SDR, nenhum número por pessoa sai daqui,
e nada vai para o grupo das meninas — só para o canal da gestão. Decisão do João e da dona: monitorar
pessoa por nome destrói a equipe e cria risco trabalhista. Está no código e está no texto do alerta.

USO (padrão é SECO: imprime o que mandaria e não manda nada):
  vigia-unidade.py                       # passo de hora em hora, seco
  vigia-unidade.py --profundo            # passo fundo (1×/dia, de manhã): mede também 2, 5, 6 e 8
  vigia-unidade.py --enviar              # manda de verdade (exige VIGIA_TELEGRAM_CHAT no ambiente)
  vigia-unidade.py --slug outra-unidade --rotulo Caxias

ONDE MORA (VPS de produção 89.116.214.130, como root — o host não tem node, o container tem):
  /root/vigia-petropolis/medir-unidade.mjs     o medidor
  /root/vigia-petropolis/vigia-unidade.py      este arquivo
  /root/vigia-petropolis/estado.json           o placar da última rodada
  /root/vigia-petropolis/fila/                 fichas esperando o auditor
  /root/.vigia-petropolis.env                  chmod 600: VIGIA_TELEGRAM_CHAT=... (destino da gestão)

SEGREDO: o token do Telegram é lido do ambiente do próprio container e entregue ao curl pelo STDIN
(`curl --config -`). Nunca vai por argumento — `argv` aparece no `ps` e no log.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

RAIZ = os.environ.get("VIGIA_RAIZ", "/root/vigia-petropolis")
MEDIDOR = os.path.join(RAIZ, "medir-unidade.mjs")
ESTADO = os.path.join(RAIZ, "estado.json")
FILA = os.path.join(RAIZ, "fila")
ENV_ARQUIVO = os.environ.get("VIGIA_ENV_ARQUIVO", "/root/.vigia-petropolis.env")
# Teto de investigações por dia: um dia ruim não pode virar maratona de custo.
TETO_AUDITORIAS_DIA = int(os.environ.get("VIGIA_TETO_AUDITORIAS", "3"))
# Quando o vigia roda de outra máquina (teste), prefixa tudo com ssh. Vazio = já está na VPS.
VIA_SSH = os.environ.get("VIGIA_SSH", "").strip()

# Ordem em que os contadores aparecem no alerta — do que dói no paciente para o que dói no dado.
ORDEM = [
    "1_sem_resposta_15min",
    "2_madrugada_sem_retomada",
    "3_cobranca_injusta",
    "9_arquivo_sem_andar",
    "7_ligada_mas_seca",
    "8_avaliacoes_7dias",
    "4_tarefas_vencidas",
    "5_responsavel_integracao",
    "6_sem_campo_unidade",
]

# A frase que vai para a gestão, em português de gente. {v} = valor de agora, {a} = valor de antes.
FRASES = {
    "1_sem_resposta_15min": "{v} paciente(s) sem resposta há mais de 15 min no plantão de hoje (antes: {a})",
    "2_madrugada_sem_retomada": "{v} lead(s) que entraram de madrugada e ninguém retomou até as 9h (antes: {a})",
    "3_cobranca_injusta": "{v} paciente(s) ouviram \"não tive retorno\" tendo respondido antes (antes: {a})",
    "9_arquivo_sem_andar": "{v} paciente(s) mandaram exame/foto e o cartão não andou em 24 h (antes: {a})",
    "7_ligada_mas_seca": "{v} automação(ões) aparecem \"Ligada\" na tela e estão rodando só no papel (antes: {a})",
    "8_avaliacoes_7dias": "só {v} avaliação(ões) marcada(s) para os próximos 7 dias (antes: {a})",
    "4_tarefas_vencidas": "{v} tarefas abertas e vencidas na conta (antes: {a})",
    "5_responsavel_integracao": "{v} cartões do mês ainda com o robô como responsável (antes: {a})",
    "6_sem_campo_unidade": "{v} cartões do mês sem a unidade de atendimento preenchida (antes: {a})",
}


def sh(args, entrada=None, timeout=900):
    """Roda um comando e devolve (codigo, saida). Nunca levanta por código != 0."""
    try:
        p = subprocess.run(args, input=entrada, capture_output=True, timeout=timeout)
        return p.returncode, (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return 124, "tempo esgotado"
    except Exception as e:  # noqa: BLE001
        return 1, str(e)


def ler_env_arquivo(path):
    """Lê o arquivo 600 com o destino do alerta. Sem ele, o vigia fica em seco — e diz por quê."""
    val = {}
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                for linha in f:
                    m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", linha)
                    if m:
                        val[m.group(1)] = m.group(2).strip("'\"")
    except OSError:
        pass
    return val


def comando_docker(sufixo):
    """Monta o comando, com ou sem ssh na frente. `sufixo` é a linha de shell que roda na VPS."""
    if VIA_SSH:
        return ["ssh", "-o", "BatchMode=yes", VIA_SSH, sufixo]
    return ["bash", "-lc", sufixo]


def medir(slug, rotulo, profundo, janela_h, teto_leituras):
    """Roda o medidor DENTRO do container do agente e devolve o JSON. Só leitura."""
    with open(MEDIDOR, "rb") as f:
        codigo = f.read()
    ambiente = (
        f"-e LOG_LEVEL=fatal -e VIGIA_SLUG={slug} -e VIGIA_ROTULO_UNIDADE={rotulo} "
        f"-e VIGIA_HORAS_TALKS={janela_h} -e VIGIA_TETO_LEITURAS={teto_leituras} "
        + ("-e VIGIA_PROFUNDO=1 " if profundo else "")
    )
    linha = (
        "CID=$(docker ps --filter name=ddagent_agent --format '{{.ID}}' | head -1); "
        f"docker exec -i -w /repo/backend {ambiente}\"$CID\" node --input-type=module -"
    )
    cod, out = sh(comando_docker(linha), entrada=codigo)
    m = re.search(r"#VIGIA-JSON#(.*?)#FIM#", out, re.S)
    if not m:
        return None, f"o medidor não devolveu JSON (código {cod}): {out[-400:]}"
    try:
        return json.loads(m.group(1)), None
    except json.JSONDecodeError as e:
        return None, f"JSON inválido: {e}"


def carregar_estado():
    try:
        with open(ESTADO, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def gravar_estado(estado):
    os.makedirs(RAIZ, exist_ok=True)
    tmp = ESTADO + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(estado, f, ensure_ascii=False, indent=1)
    os.replace(tmp, ESTADO)
    os.chmod(ESTADO, 0o600)


def piorou(cid, agora, antes, detalhe):
    """
    Piorou = o número andou para o lado ruim E cruzou a linha. Igual = silêncio.

    O contador 3 (cobrança injusta) é exceção combinada: tolerância ZERO, então qualquer cartão
    NOVO na lista é alerta, mesmo que o total não mude.
    """
    if agora is None:
        return False, ""
    limiar = detalhe.get("limiar", 0)
    abaixo = detalhe.get("direcao") == "abaixo"
    cruzou = agora < limiar if abaixo else agora > limiar
    if antes is None:
        return False, ""  # primeira medida é linha de base, nunca alerta
    andou = agora < antes if abaixo else agora > antes
    return (andou and cruzou), ("abaixo da linha" if abaixo else "acima da linha")


def cartoes_de(detalhe):
    saida = []
    for c in detalhe.get("cartoes", []) or []:
        saida.append(c.get("cartao") if isinstance(c, dict) else c)
    return [c for c in saida if c]


def montar_alerta(unidade, novidades, medida):
    linhas = [f"Vigia · {unidade} · {dt.datetime.now().strftime('%d/%m %H:%M')}", ""]
    for n in novidades:
        linhas.append(f"• {n['frase']}")
        if n["cartoes"]:
            linhas.append(f"  cartões: {', '.join(str(c) for c in n['cartoes'][:5])}")
    linhas += [
        "",
        "A ficha já foi para o auditor: ele investiga, escreve e prepara a correção."
        " Você só responde ✅ ou ❌.",
        "",
        "Este vigia olha o sistema, não as pessoas: nenhum nome e nenhum número individual sai daqui.",
    ]
    if medida.get("tetoAtingido"):
        linhas.append("(a rodada bateu no teto de leituras — o número pode estar por baixo)")
    return "\n".join(linhas)


def token_do_telegram():
    """O token sai do ambiente do próprio container e NUNCA passa por argumento de linha de comando."""
    linha = (
        "CID=$(docker ps --filter name=ddagent_agent --format '{{.ID}}' | head -1); "
        "docker exec -i \"$CID\" printenv TELEGRAM_BOT_TOKEN"
    )
    cod, out = sh(comando_docker(linha), timeout=60)
    tok = (out or "").strip().splitlines()[-1].strip() if out else ""
    return tok if cod == 0 and re.match(r"^\d+:[A-Za-z0-9_-]{20,}$", tok) else None


def enviar_telegram(texto, chat):
    """
    Manda pelo curl com a URL (que carrega o token) vindo por STDIN — `curl --config -`.
    Nada de segredo em `argv`: `ps` e log de shell não veem o token. O corpo vai num arquivo 600
    dentro de /root (nunca em /tmp, que o reboot esvazia e já custou um token de franquia).
    """
    tok = token_do_telegram()
    if not tok:
        return False, "sem TELEGRAM_BOT_TOKEN no container"
    os.makedirs(RAIZ, exist_ok=True)
    corpo = os.path.join(RAIZ, ".corpo-alerta.json")
    with open(corpo, "w", encoding="utf-8") as f:
        json.dump({"chat_id": chat, "text": texto[:3500], "disable_web_page_preview": True}, f, ensure_ascii=False)
    os.chmod(corpo, 0o600)
    config = (
        f'url = "https://api.telegram.org/bot{tok}/sendMessage"\n'
        'header = "Content-Type: application/json; charset=utf-8"\n'
        f'data = "@{corpo}"\n'
    )
    try:
        cod, out = sh(["curl", "-s", "-S", "--max-time", "20", "--config", "-"], entrada=config.encode("utf-8"), timeout=40)
    finally:
        try:
            os.remove(corpo)
        except OSError:
            pass
    ok = cod == 0 and '"ok":true' in out
    # a resposta de erro do Telegram não traz o token, mas o cinto não custa nada
    return ok, ("enviado" if ok else out.replace(tok, "***")[:200])


def enfileirar_auditoria(unidade, slug, novidades, medida, seco):
    """
    Uma ficha por contador que piorou. O auditor lê daqui — é a porta entre o relógio e a IA.
    Teto por dia para um dia ruim não virar maratona de custo.
    """
    os.makedirs(FILA, exist_ok=True)
    hoje = dt.date.today().isoformat()
    ja_hoje = len([n for n in os.listdir(FILA) if n.startswith(hoje)])
    criadas = []
    for n in novidades:
        if ja_hoje + len(criadas) >= TETO_AUDITORIAS_DIA:
            criadas.append({"recusada": n["contador"], "motivo": f"teto de {TETO_AUDITORIAS_DIA} investigações/dia"})
            break
        ficha = {
            "em": dt.datetime.now().isoformat(timespec="seconds"),
            "unidade": unidade,
            "slug": slug,
            "contador": n["contador"],
            "frase": n["frase"],
            "valor": n["valor"],
            "valorAnterior": n["anterior"],
            "cartoes": n["cartoes"][:20],
            "detalhe": n["detalhe"],
            "regra": "o auditor MEDE, EXPLICA e PREPARA. Não aplica nada em produção, não escreve no CRM, "
                     "não liga chave e não nomeia pessoa.",
            "estado": "pendente",
        }
        caminho = os.path.join(FILA, f"{hoje}-{dt.datetime.now().strftime('%H%M%S')}-{n['contador']}.json")
        if not seco:
            with open(caminho, "w", encoding="utf-8") as f:
                json.dump(ficha, f, ensure_ascii=False, indent=1)
            os.chmod(caminho, 0o600)
        criadas.append({"ficha": caminho, "contador": n["contador"], "gravada": not seco})
    return criadas


def main():
    ap = argparse.ArgumentParser(description="Vigia de unidade: mede, compara e só fala quando piora.")
    ap.add_argument("--slug", default=os.environ.get("VIGIA_SLUG", "doutor-hernia-petropolis"))
    ap.add_argument("--rotulo", default=os.environ.get("VIGIA_ROTULO_UNIDADE", "Petrópolis"))
    ap.add_argument("--profundo", action="store_true", help="mede também 2, 5, 6 e 8 (1×/dia)")
    ap.add_argument("--janela", type=int, default=12, help="horas de conversa na varredura")
    ap.add_argument("--teto-leituras", type=int, default=120)
    ap.add_argument("--enviar", action="store_true", help="manda de verdade (padrão: seco)")
    ap.add_argument("--fichas", action="store_true",
                    help="grava as fichas da fila mesmo em seco (ensaio do auditor; não manda nada)")
    ap.add_argument("--estado", default=ESTADO)
    args = ap.parse_args()

    globals()["ESTADO"] = args.estado
    cfg = ler_env_arquivo(ENV_ARQUIVO)
    chat = (os.environ.get("VIGIA_TELEGRAM_CHAT") or cfg.get("VIGIA_TELEGRAM_CHAT") or "").strip()
    seco = not args.enviar or not chat

    medida, erro = medir(args.slug, args.rotulo, args.profundo, args.janela, args.teto_leituras)
    if erro or not medida or not medida.get("ok"):
        print(f"[vigia] NÃO MEDIU: {erro or medida.get('erros')}")
        return 1

    estado = carregar_estado()
    anterior = estado.get("contadores", {})
    novidades = []
    placar = {}
    for cid in ORDEM:
        d = medida["contadores"].get(cid)
        if not d:
            continue
        valor = d.get("valor")
        if valor is None:
            placar[cid] = anterior.get(cid)  # não medido nesta rodada: o placar antigo continua valendo
            continue
        antes = anterior.get(cid)
        placar[cid] = valor
        ruim, _ = piorou(cid, valor, antes, d)
        # contador 3: tolerância zero — cartão novo alerta mesmo com o total igual
        novos_cartoes = []
        if cid == "3_cobranca_injusta":
            vistos = set(estado.get("cobrancaVistos", []))
            novos_cartoes = [c for c in cartoes_de(d) if c not in vistos]
            if novos_cartoes:
                ruim = True
        if ruim:
            novidades.append({
                "contador": cid,
                "valor": valor,
                "anterior": antes,
                "frase": FRASES.get(cid, cid + ": {v} (antes: {a})").format(v=valor, a="—" if antes is None else antes),
                "cartoes": novos_cartoes or cartoes_de(d),
                "detalhe": {k: v for k, v in d.items() if k not in ("cartoes",)},
            })

    unidade = args.rotulo
    print(f"[vigia] {unidade} · passo {medida['passo']} · {medida['leituras']} conversas lidas · "
          f"{medida['cartoesNaJanela']} cartões na janela")
    for cid in ORDEM:
        d = medida["contadores"].get(cid, {})
        v = d.get("valor")
        print(f"  {cid:28s} {('—' if v is None else v)!s:>6}   antes={anterior.get(cid)}   "
              f"{d.get('naoMedido', '')}")

    if not novidades:
        print("[vigia] nada piorou — silêncio total (nenhuma mensagem, nenhum agente acordado)")
    else:
        texto = montar_alerta(unidade, novidades, medida)
        print("\n[vigia] ALERTA" + (" (SECO — não enviado)" if seco else "") + ":\n" + texto)
        fichas = enfileirar_auditoria(unidade, args.slug, novidades, medida, seco and not args.fichas)
        print(f"[vigia] fila do auditor: {json.dumps(fichas, ensure_ascii=False)}")
        if not seco:
            ok, detalhe = enviar_telegram(texto, chat)
            print(f"[vigia] telegram: {'ok' if ok else 'FALHOU'} ({detalhe})")
        elif not chat:
            print("[vigia] seco porque VIGIA_TELEGRAM_CHAT não está definido — a dona ainda não disse o destino")

    estado["contadores"] = placar
    estado["ultimaEm"] = medida["em"]
    estado["ultimoPasso"] = medida["passo"]
    if "3_cobranca_injusta" in medida["contadores"]:
        vistos = set(estado.get("cobrancaVistos", [])) | set(cartoes_de(medida["contadores"]["3_cobranca_injusta"]))
        estado["cobrancaVistos"] = sorted(vistos)[-500:]
    if not seco:
        gravar_estado(estado)
    else:
        print("[vigia] seco: o placar NÃO foi gravado")
    return 0


if __name__ == "__main__":
    sys.exit(main())
