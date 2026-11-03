#!/usr/bin/env bash
# Refaz vigiar-video-conector.zip (para subir em claude.ai → Configurações → Capacidades → Skills → Enviar skill).
# O zip tem UMA pasta na raiz (vigiar-video-conector/) com o SKILL.md dentro, como o claude.ai exige. Datas fixas: o mesmo
# SKILL.md gera sempre os mesmos bytes (o diff do zip só muda quando o texto muda).
#
# Uso: bash gerar-zip-da-skill.sh [SAIDA.zip]      (padrão: ao lado deste script)
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAIDA="${1:-$AQUI/vigiar-video-conector.zip}"
python3 -I - "$AQUI/skill-claude-ai/SKILL.md" "$SAIDA" <<'PY'
import re, sys, zipfile
fonte, saida = sys.argv[1:3]
texto = open(fonte, encoding="utf-8").read()
m = re.match(r"---\nname: ([a-z0-9-]+)\ndescription: .+\n---\n", texto)
if not m:
    sys.exit("SKILL.md sem o cabeçalho name/description esperado")
nome = m.group(1)
info = zipfile.ZipInfo(f"{nome}/SKILL.md", date_time=(2026, 11, 3, 0, 0, 0))
info.compress_type = zipfile.ZIP_DEFLATED
info.external_attr = 0o644 << 16
with zipfile.ZipFile(saida, "w") as z:
    z.writestr(info, texto.encode("utf-8"))
print(f"ok: {saida} ({nome}/SKILL.md)")
PY
