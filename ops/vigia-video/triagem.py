#!/usr/bin/env python3
"""Triagem de vídeo longo (OBS, câmera fixa) para revisão por IA.

1. Mede movimento 1x por segundo com o ffmpeg (sem OpenCV).
2. Junta os segundos com movimento em EVENTOS.
3. Para cada evento, gera uma "folha de contato" (grade de quadros) em JPG
   + um índice com o horário de cada quadro.

Uso:
  python3 triagem.py VIDEO.mkv --saida PASTA [--rapido] [--limiar 0.01]
                     [--inicio-gravacao "2026-11-03 08:00:00"] [--clipes]

Saídas em PASTA/:
  movimento.tsv   segundo -> nota de movimento (todos os segundos)
  eventos.json    lista de eventos com início/fim/pico e o arquivo da folha
  resumo.md       tabela legível + linha do tempo da atividade por hora
  folhas/evento_0001.jpg ...
  clipes/evento_0001.mp4 ...   (só com --clipes: 480p, sem áudio, leves)

Fonte única: este arquivo (ops/vigia-video/ do repo agente-dt). Os caminhos dentro de eventos.json são
RELATIVOS à pasta de saída, para o pacote poder ser copiado para outro lugar (o conector lê de lá).
"""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from datetime import datetime, timedelta


def hms(seg):
    seg = int(seg)
    return f"{seg // 3600:02d}:{seg % 3600 // 60:02d}:{seg % 60:02d}"


def duracao(video):
    """Duração em segundos, ou None quando o contêiner não informa (MKV do OBS fechado à força)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", video],
        capture_output=True, text=True, check=True).stdout.strip()
    try:
        d = float(out)
        return d if d > 0 else None
    except ValueError:
        return None


def medir_movimento(video, saida, rapido):
    """Uma nota de mudança de cena por segundo (0 = parado)."""
    meta = os.path.join(saida, "_scene.txt")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats"]
    if rapido:
        cmd += ["-skip_frame", "nokey"]  # só quadros-chave: muito mais rápido
    cmd += ["-threads", "0", "-i", video, "-an", "-sn",
            "-vf", f"fps=1,scale=320:-2,format=gray,select='gte(scene\\,0)',"
                   f"metadata=print:file={meta}",
            "-f", "null", "-"]
    print("medindo movimento (pode demorar; --rapido acelera)...", file=sys.stderr)
    subprocess.run(cmd, check=True)
    notas, t = [], None
    with open(meta) as f:
        for linha in f:
            m = re.search(r"pts_time:([\d.]+)", linha)
            if m:
                t = float(m.group(1))
                continue
            m = re.search(r"lavfi\.scene_score=([\d.]+)", linha)
            if m and t is not None:
                notas.append((t, float(m.group(1))))
    os.remove(meta)
    # os 2 primeiros segundos têm artefato de início do encoder
    return [(t, 0.0 if t < 2 else s) for t, s in notas]


def limiar_auto(notas):
    # nota 0 exata = quadro repetido (no --rapido, entre quadros-chave): não é ruído, ignora
    vals = [s for _, s in notas if s > 0]
    if not vals:
        return 0.01
    med = statistics.median(vals)
    mad = statistics.median([abs(v - med) for v in vals])
    # Valores quase IDÊNTICOS e altos não são ruído de câmera (ruído é disperso e baixo): é o próprio movimento. Acontece com vídeo
    # limpo ou no --rapido, onde só aparecem os quadros-chave e a mediana dos não nulos já é o movimento; "mediana + 8 MAD" ficava
    # acima dele e escondia tudo (achado no teste sintético, 03/11). O limiar vai para o meio entre zero e esse nível.
    if med >= 0.02 and mad < 0.1 * med:
        return max(0.004, 0.5 * med)
    # ruído da câmera/compressão fica abaixo disso; movimento real fica acima
    return max(0.004, med + 8 * (mad or 0.0005))


def agrupar(notas, limiar, juntar_seg, margem):
    ativos = [t for t, s in notas if s >= limiar]
    pico = {t: s for t, s in notas}
    eventos = []
    for t in ativos:
        if eventos and t - eventos[-1]["fim"] <= juntar_seg:
            eventos[-1]["fim"] = t
        else:
            eventos.append({"inicio": t, "fim": t})
    for e in eventos:
        seg = [pico[t] for t in ativos if e["inicio"] <= t <= e["fim"]]
        e["pico"] = round(max(seg), 4)
        e["segundos_com_movimento"] = len(seg)
        e["inicio"] = max(0.0, e["inicio"] - margem)
        e["fim"] = e["fim"] + margem
    return eventos


def folha(video, e, arq, colunas, linhas):
    n = colunas * linhas
    dur = max(1.0, e["fim"] - e["inicio"])
    passo = dur / n
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", f"{e['inicio']:.2f}", "-t", f"{dur:.2f}", "-i", video, "-an",
         "-vf", f"fps=1/{passo:.4f},scale=480:-2,tile={colunas}x{linhas}:padding=4:color=white",
         "-frames:v", "1", "-q:v", "4", arq],
        check=True)
    return [round(e["inicio"] + i * passo, 1) for i in range(n)]


def clipe(video, e, arq, max_seg):
    """Trecho do evento em 480p, h264 crf 30, sem áudio. Devolve a duração gravada (cortada em max_seg)."""
    dur = min(max(1.0, e["fim"] - e["inicio"]), max_seg)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", f"{e['inicio']:.2f}", "-t", f"{dur:.2f}", "-i", video, "-an", "-sn",
         "-vf", "scale=-2:480", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", arq],
        check=True)
    return dur


def movimento_por_hora(notas, limiar, total, base):
    """Segundos com movimento por hora. Com a hora real do começo, a hora é a do RELÓGIO; sem ela, a do vídeo."""
    cont = {}
    for t, s in notas:
        if s >= limiar:
            chave = int((base + timedelta(seconds=t)).strftime("%Y%m%d%H")) if base else int(t // 3600)
            cont[chave] = cont.get(chave, 0) + 1
    out = []
    if base:
        h = base.replace(minute=0, second=0, microsecond=0)
        fim = base + timedelta(seconds=total)
        while h <= fim:
            out.append({"hora": h.strftime("%Y-%m-%dT%H:00"), "segundos": cont.get(int(h.strftime("%Y%m%d%H")), 0)})
            h += timedelta(hours=1)
    else:
        for h in range(int(total // 3600) + 1):
            out.append({"hora": f"video+{h:02d}h", "segundos": cont.get(h, 0)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--saida", required=True)
    ap.add_argument("--rapido", action="store_true",
                    help="decodifica só quadros-chave (5-20x mais rápido, menos preciso)")
    ap.add_argument("--limiar", type=float, default=None,
                    help="nota mínima de movimento (padrão: automático pelo ruído do vídeo)")
    ap.add_argument("--juntar", type=float, default=20,
                    help="segundos parados que ainda contam como o mesmo evento")
    ap.add_argument("--margem", type=float, default=5)
    ap.add_argument("--grade", default="4x3", help="colunas x linhas da folha")
    ap.add_argument("--clipes", action="store_true",
                    help="gera também um clipe leve (480p, sem áudio) por evento")
    ap.add_argument("--clipe-max", type=float, default=180,
                    help="segundos máximos de cada clipe (evento mais longo é cortado no começo)")
    ap.add_argument("--inicio-gravacao", default=None,
                    help='hora real do começo do vídeo, ex. "2026-11-03 08:00:00"')
    a = ap.parse_args()

    os.makedirs(os.path.join(a.saida, "folhas"), exist_ok=True)
    total = duracao(a.video)
    notas = medir_movimento(a.video, a.saida, a.rapido)
    if total is None:  # sem duração no cabeçalho: vale o último segundo medido
        total = (notas[-1][0] + 1) if notas else 0.0
    with open(os.path.join(a.saida, "movimento.tsv"), "w") as f:
        f.write("segundo\tnota\n")
        for t, s in notas:
            f.write(f"{t:.0f}\t{s:.4f}\n")

    limiar = a.limiar if a.limiar is not None else limiar_auto(notas)
    eventos = agrupar(notas, limiar, a.juntar, a.margem)
    col, lin = (int(x) for x in a.grade.lower().split("x"))
    base = datetime.strptime(a.inicio_gravacao, "%Y-%m-%d %H:%M:%S") if a.inicio_gravacao else None

    if a.clipes:
        os.makedirs(os.path.join(a.saida, "clipes"), exist_ok=True)
    for i, e in enumerate(eventos, 1):
        arq = os.path.join(a.saida, "folhas", f"evento_{i:04d}.jpg")
        e["id"] = i
        e["folha"] = f"folhas/evento_{i:04d}.jpg"
        e["quadros_seg"] = folha(a.video, e, arq, col, lin)
        e["inicio_hms"], e["fim_hms"] = hms(e["inicio"]), hms(e["fim"])
        if base:
            e["hora_real"] = (base + timedelta(seconds=e["inicio"])).strftime("%d/%m %H:%M:%S")
        if a.clipes:
            d = clipe(a.video, e, os.path.join(a.saida, "clipes", f"evento_{i:04d}.mp4"), a.clipe_max)
            e["clipe"] = f"clipes/evento_{i:04d}.mp4"
            e["clipe_seg"] = round(d, 1)
            e["clipe_cortado"] = (e["fim"] - e["inicio"]) > a.clipe_max
        print(f"\rfolhas: {i}/{len(eventos)}", end="", file=sys.stderr)
    print(file=sys.stderr)

    with open(os.path.join(a.saida, "eventos.json"), "w") as f:
        json.dump({"video": os.path.basename(a.video), "duracao_seg": total,
                   "limiar": limiar, "grade": a.grade, "rapido": a.rapido,
                   "inicio_gravacao": a.inicio_gravacao,
                   "movimento_por_hora": movimento_por_hora(notas, limiar, total, base),
                   "eventos": eventos},
                  f, ensure_ascii=False, indent=1)

    # atividade por hora do VÍDEO (para achar movimento em horário que deveria estar vazio)
    por_hora = {}
    for t, s in notas:
        if s >= limiar:
            por_hora[int(t // 3600)] = por_hora.get(int(t // 3600), 0) + 1
    with open(os.path.join(a.saida, "resumo.md"), "w") as f:
        f.write(f"# Triagem de {os.path.basename(a.video)}\n\n")
        f.write(f"- Duração: {hms(total)} · limiar: {limiar:.4f} · eventos: {len(eventos)}\n")
        f.write(f"- Segundos com movimento: {sum(por_hora.values())} de {len(notas)}\n\n")
        f.write("## Movimento por hora do vídeo\n\n| hora | seg. com movimento |\n|---|---|\n")
        for h in range(int(total // 3600) + 1):
            f.write(f"| {h:02d}h | {por_hora.get(h, 0)} |\n")
        f.write("\n## Eventos\n\n| # | início | fim | dur. | pico | hora real |\n|---|---|---|---|---|---|\n")
        for e in eventos:
            f.write(f"| {e['id']} | {e['inicio_hms']} | {e['fim_hms']} | "
                    f"{int(e['fim'] - e['inicio'])}s | {e['pico']} | {e.get('hora_real', '')} |\n")
    print(f"ok: {len(eventos)} eventos, limiar {limiar:.4f} -> {a.saida}/resumo.md")


if __name__ == "__main__":
    main()
