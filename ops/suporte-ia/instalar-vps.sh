#!/usr/bin/env bash
# Instala o AGENTE DE SUPORTE 24 h na VPS (roda como ROOT; quem chama é o ~/Kommo-Integracao/_replicacao/instalar-suporte-ia.sh do PC).
# Lê da ENTRADA PADRÃO duas linhas: o token do GitHub (fine-grained, só o repo agente-dt) e a chave do trabalhador.
# Pode rodar de novo: atualiza o trabalhador, a configuração e as unidades do systemd sem apagar nada do usuário.
#
# Isolamento:
#   - usuário `suporte-ia` sem sudo e sem grupo docker; só enxerga a própria casa (ProtectHome=tmpfs + BindPaths);
#   - /opt/doutordigital (o .env da produção), /root, /home/joaoof e o socket do Docker ficam INACESSÍVEIS ao serviço;
#   - o trabalhador fica em /opt/suporte-ia (dono root: o agente não consegue alterar o próprio trabalhador);
#   - os segredos ficam em /etc/suporte-ia.env (só root lê; o systemd entrega ao processo do trabalhador, que NÃO os passa ao Claude);
#   - cerca: 2 GB de memória, 1 CPU, prioridade baixa; se estourar, morre o agente, nunca a Sofia.
set -euo pipefail
trap 'echo "!! o instalador parou na linha $LINENO (comando: $BASH_COMMAND)"' ERR
[ "$(id -u)" = 0 ] || { echo "precisa ser root"; exit 1; }
AQUI="$(cd "$(dirname "$0")" && pwd)"
U=suporte-ia
H=/home/$U
read -r TOKEN
read -r CHAVE
[ -n "$TOKEN" ] && [ ${#CHAVE} -ge 24 ] || { echo "faltou o token do GitHub ou a chave do trabalhador"; exit 1; }

echo "-- usuário $U"
id "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"
gpasswd -d "$U" docker >/dev/null 2>&1 || true
gpasswd -d "$U" sudo >/dev/null 2>&1 || true
chmod 750 "$H"

echo "-- Node 24 em /opt/node-24 (copiado do do João, só leitura para os outros)"
if [ ! -x /opt/node-24/bin/node ]; then
  SRC=/home/joaoof/.nvm/versions/node/v24.14.1
  [ -x "$SRC/bin/node" ] || { echo "não achei o Node 24 em $SRC"; exit 1; }
  cp -a "$SRC" /opt/node-24
fi
# o npm/pnpm/corepack chamam `node` pelo PATH (#!/usr/bin/env node): sem isto o npm falha calado (visto em 09/11)
export PATH=/opt/node-24/bin:$PATH
if [ ! -x /opt/node-24/bin/pnpm ]; then
  saida=$(npm i -g pnpm@9.15.0 --prefix /opt/node-24 2>&1) || { echo "   falhou instalar o pnpm:"; printf '%s\n' "$saida" | tail -8; exit 1; }
fi
chown -R root:root /opt/node-24 && chmod -R a+rX,go-w /opt/node-24
echo "   node $(/opt/node-24/bin/node -v), pnpm $(/opt/node-24/bin/pnpm -v 2>/dev/null || echo '?')"

echo "-- Claude Code para o $U"
if [ ! -x "$H/.local/bin/claude" ]; then
  saida=$(su - "$U" -c 'curl -fsSL https://claude.ai/install.sh | bash' 2>&1) || { echo "   o instalador do Claude Code falhou:"; printf '%s\n' "$saida" | tail -8; exit 1; }
fi
[ -x "$H/.local/bin/claude" ] && echo "   $(su - "$U" -c "$H/.local/bin/claude --version" 2>/dev/null | head -1)" || { echo "   o Claude Code não ficou em $H/.local/bin/claude"; exit 1; }

echo "-- cópia do repositório (só leitura do GitHub: o push é com o token, pelo trabalhador)"
if [ ! -d "$H/agente-dt/.git" ]; then
  su - "$U" -c "git clone -q https://github.com/doutor-digital/agente-dt.git $H/agente-dt"
fi
su - "$U" -c "cd $H/agente-dt && git config user.name 'Agente de Suporte DD' && git config user.email 'suporte-ia@doutordigitalconsultoria.com' && git fetch -q origin"

echo "-- trabalhador em /opt/suporte-ia (dono root)"
install -d -o root -g root -m 755 /opt/suporte-ia
install -o root -g root -m 644 "$AQUI/trabalhador.mjs" /opt/suporte-ia/trabalhador.mjs

echo "-- configuração em /etc/suporte-ia.env (600, root)"
umask 077
{
  echo "SUPORTE_API=https://agente-vps.doutordigitalconsultoria.com/api"
  echo "SUPORTE_CLAUDE_CHAVE=$CHAVE"
  echo "GITHUB_TOKEN=$TOKEN"
  echo "REPO_DIR=$H/agente-dt"
  echo "CLAUDE_BIN=$H/.local/bin/claude"
  echo "PATH=/opt/node-24/bin:$H/.local/bin:/usr/local/bin:/usr/bin:/bin"
  echo "TEMPO_MAX_MIN=40"
} > /etc/suporte-ia.env
chmod 600 /etc/suporte-ia.env
umask 022

echo "-- systemd: serviço + timer de 2 em 2 minutos"
cat > /etc/systemd/system/suporte-ia.service <<UNIT
[Unit]
Description=Agente de suporte 24 h (Claude Code, usuário isolado)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$U
Group=$U
EnvironmentFile=/etc/suporte-ia.env
WorkingDirectory=$H
ExecStart=/opt/node-24/bin/node /opt/suporte-ia/trabalhador.mjs
TimeoutStartSec=55min
Nice=10
MemoryMax=2G
MemorySwapMax=0
CPUQuota=100%
OOMScoreAdjust=900
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=tmpfs
BindPaths=$H
ReadWritePaths=$H
InaccessiblePaths=-/opt/doutordigital -/root -/var/run/docker.sock -/run/docker.sock -/etc/suporte-ia.env
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UNIT
cat > /etc/systemd/system/suporte-ia.timer <<'UNIT'
[Unit]
Description=Agente de suporte 24 h: olha a fila a cada 2 minutos

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now suporte-ia.timer >/dev/null
echo "   timer: $(systemctl is-active suporte-ia.timer)"

if [ -s "$H/.claude/.credentials.json" ]; then
  echo "-- login do Claude: OK (arquivo de credencial presente)"
else
  echo "-- login do Claude: FALTA. Rode uma vez:  ssh -t root@89.116.214.130 'su - $U -c ~/.local/bin/claude'  e entre com /login"
fi
echo "PRONTO na VPS. O agente só trabalha quando SUPORTE_CLAUDE=ligado no backend (até lá a fila responde 'nada a fazer')."
