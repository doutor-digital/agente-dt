# Vigia de vídeo

A gerente analisa, no claude.ai, gravações de câmera de 10+ horas feitas no OBS, à procura de comportamento suspeito
(mexer em caixa, gaveta ou estoque; movimento fora do horário; câmera tampada).

Duas verdades que desenham tudo: o claude.ai **não recebe vídeo de GB** (anexo é de dezenas de MB) e o Claude **não vê vídeo,
só imagem**. Por isso o vídeo **nunca sobe**. O computador que grava mede o movimento, e só o que importa viaja:

```
OBS grava MKV ──► enviar-gravacoes.sh (cron, 15 em 15 min, neste Linux)
                    │  1. espera a gravação TERMINAR (OBS fechou o arquivo + 5 min sem escrita)
                    │  2. triagem.py --rapido --clipes  (ffmpeg: movimento 1x/s → eventos → folha 4x3 + clipe 480p por evento)
                    │  3. rsync só do PACOTE (eventos.json, resumo.md, folhas/, clipes/, meta.json por último)
                    ▼
        servidor de produção: /srv/vigia/<camera>/<AAAA-MM-DD_HHMM>/      (o vídeo original fica aqui, intocado)
                    │  montado SOMENTE LEITURA no container do backend (/vigia)
                    ▼
        conector mcp-doutordigital:  video_gravacoes → video_folhas (IMAGEM) → video_clipe (link de 15–30 min)
                    ▼
        claude.ai (skill vigiar-video-conector): nota 0–3 por evento → a pessoa abre o clipe e decide
```

## O que tem aqui

| Arquivo | Para quê |
|---|---|
| `triagem.py` | A triagem (python stdlib + ffmpeg). **Fonte única** (a skill local `~/.claude/skills/vigiar-video` pode apontar para cá). |
| `enviar-gravacoes.sh` | O que o cron roda: acha gravação pronta, faz a triagem, envia o pacote, marca como enviada. Nunca apaga nada. |
| `gerar-video-sintetico.sh` / `teste-ponta-a-ponta.sh` | Prova local sem servidor: vídeo de teste com 2 janelas de movimento até a pasta de destino (inclui envio que falha e não refaz a triagem). |
| `test_triagem.py` | Testes da lógica pura (limiar automático, agrupamento, movimento por hora): `python3 -I test_triagem.py`. |
| `skill-claude-ai/SKILL.md` | O roteiro para o claude.ai usar as 3 ferramentas. `vigiar-video-conector.zip` é o upload pronto. |
| `gerar-zip-da-skill.sh` | Refaz o zip depois de editar o `SKILL.md`. |

Lado do conector (backend): `backend/src/mcp-remoto/video.ts` (+ `video.test.ts`).

## 1. OBS: três ajustes (uma vez, por câmera/perfil)

1. **Formato MKV** (Configurações → Saída → Gravação → Formato). MKV não se perde se o OBS ou a máquina cair; MP4 sim.
2. **Nome do arquivo** (Configurações → Avançado → Gravação → *Formatação do nome de arquivo*):

   ```
   %CCYY-%MM-%DD_%hh-%mm-%ss_caixa
   ```
   gera `2026-11-03_08-00-00_caixa.mkv`. O que vem depois do 3º `_` é o **nome da câmera**: minúsculas, números e hífen, sem
   acento nem espaço (`caixa`, `estoque`, `porta-fundos`). Nome fora desse formato é ignorado (e o log diz qual).
   A hora do nome é a do **relógio deste computador**: é essa que aparece no relatório.
3. **Intervalo de quadro-chave = 2 s** (Saída → Gravação → Codificador → *Intervalo de quadro-chave*). O `--rapido` lê só os
   quadros-chave; com 2 s a triagem fica precisa e 5 a 20 vezes mais rápida.

Pasta de gravação: `~/Vídeos/vigia/`. Uma gravação por arquivo; pode virar o arquivo a cada X horas (divisão automática do OBS) ou
parar e começar de novo: cada arquivo é uma gravação.

## 2. Neste computador (você roda, sem sudo)

Pré-requisitos: `ffmpeg`, `python3`, `rsync`, `fuser` (pacote `psmisc`) ou `lsof`. Se faltar, o script diz qual.

```bash
cd ~/agente-dt/ops/vigia-video
chmod +x *.sh triagem.py

# prova local, sem servidor (gera um vídeo de 4 min com 2 trechos de movimento e confere tudo):
bash teste-ponta-a-ponta.sh

# ver o que o script faria com as gravações reais, sem rodar nada:
bash enviar-gravacoes.sh --simular

# gerar o pacote de uma gravação real sem enviar (confira as folhas em ~/.cache/vigia-video/):
bash enviar-gravacoes.sh --sem-enviar
```

**Chave de envio** (uma chave só para isto, que só alcança `/srv/vigia`):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/vigia_envio -N '' -C 'vigia-envio'
cat ~/.ssh/vigia_envio.pub        # entregue ESTA linha (a pública) ao devops, passo 3.2 abaixo
```

**Cron (não instalado por mim; instale quando o servidor estiver pronto):**

```bash
mkdir -p ~/.local/state/vigia-video
crontab -e
```
```cron
# vigia de vídeo: a cada 15 min; nice/ionice dentro do script para não atrapalhar o OBS
*/15 * * * * VIGIA_DESTINO='vigia@89.116.214.130:' /bin/bash /home/joaoof/agente-dt/ops/vigia-video/enviar-gravacoes.sh >> /home/joaoof/.local/state/vigia-video/vigia.log 2>&1
```

- Duas rodadas nunca se atropelam (`flock`): se a triagem de 10 h passar de 15 min, o cron seguinte só diz "já existe uma rodada".
- "Terminou" = nenhum programa com o arquivo aberto (`fuser`/`lsof`) **e** sem escrita há 5 min (`VIGIA_PARADO_SEG`).
- A TRIAGEM falhou 3 vezes seguidas (`VIGIA_TENTATIVAS`): desiste daquela gravação e avisa no log; para tentar de novo apague
  `~/.local/state/vigia-video/falhas/<arquivo>`. Falha de ENVIO (rede fora, servidor reiniciando) nunca faz desistir: a triagem já está
  pronta e cada rodada só tenta reenviar.
- Marca de "já enviada": `~/.local/state/vigia-video/enviados/<arquivo>`. Apagar a marca reenvia (idempotente).
- Os pacotes locais ficam em `~/.cache/vigia-video/` (alguns MB cada). O script não apaga nem eles nem os vídeos. Se o vídeo mudar
  e a triagem precisar ser refeita, o pacote antigo é só RENOMEADO para `<pacote>.antigo-<hora>` (nada some; apague à mão se quiser).
- Se só o envio falhar (rede, chave), a rodada seguinte NÃO refaz a triagem: reaproveita o pacote pronto e tenta enviar de novo.
- O log cresce sem parar: `logrotate` ou apague de vez em quando.
- `~/.cache/vigia-video/` também cresce (nada o limpa). Com 10 h de câmera por dia são dezenas de MB por gravação: de tempos em tempos
  liste (`find ~/.cache/vigia-video -mindepth 2 -maxdepth 2 -mtime +60 -print`) e apague o que já foi enviado, depois de conferir.
- Tamanho: 10 h de câmera com movimento normal dão algumas centenas de eventos; cada folha tem ~20 KB e cada clipe 0,3 a 3 MB
  (clipe é cortado em 180 s; o evento mais longo avisa "o clipe é só o começo").

## 3. Infra (devops) — **nada disto foi executado**

Ordem importa: **diretório e chave primeiro, volume e variáveis depois**. O `docker-compose.yml` **não** foi alterado neste PR
de propósito: um bind mount para uma pasta que não existe no host derruba a tarefa do Swarm no deploy.

### 3.1 Diretório no host de produção (89.116.214.130)

```bash
sudo useradd --create-home --shell /bin/bash vigia          # usuário só para receber os pacotes
sudo mkdir -p /srv/vigia
sudo chown vigia:vigia /srv/vigia
sudo chmod 755 /srv/vigia                                   # o container lê (arquivos chegam 644 e pastas 755 pelo --chmod do script)
```

### 3.2 Chave ssh de envio, só com acesso a esse diretório

No `~vigia/.ssh/authorized_keys` (modo 600, dono `vigia`), uma linha, com a **chave pública** do passo 2:

```
restrict,command="/usr/bin/rrsync /srv/vigia" ssh-ed25519 AAAA...resto... vigia-envio
```

- `restrict` desliga shell, pty e redirecionamentos; `rrsync` limita o rsync a `/srv/vigia` (o caminho no cliente passa a ser
  relativo a essa pasta, por isso `VIGIA_DESTINO='vigia@89.116.214.130:'`). Confira o caminho do binário (`command -v rrsync`;
  em rsync < 3.2.4 fica em `/usr/share/doc/rsync/scripts/rrsync`) e, se a sua versão aceitar, use `rrsync -wo /srv/vigia`
  (só escrita: a chave não lê nada de volta).
- **Não provado aqui:** testei o envio só para uma pasta local. O primeiro envio real prova o `rrsync` + o `-R` do script. Se o
  rrsync da máquina recusar algum argumento, o log do cron mostra a mensagem do rsync.

### 3.3 Volume somente leitura no serviço Swarm do backend

Em `docker-compose.yml`, serviço `agent` (sintaxe longa; **só depois** do 3.1):

```yaml
    volumes:
      - type: bind
        source: /srv/vigia
        target: /vigia
        read_only: true
```
O backend nunca escreve nessa pasta (o código só abre arquivos para leitura), e o volume `:ro` garante.
O Swarm roda 1 réplica no mesmo host, então o bind local basta.

### 3.4 Variáveis (`/opt/doutordigital/agente-dt/.env`, hoje à mão; não há segredo novo)

```
MCP_VIDEO_EMAILS=doutordigitalconsultoria@gmail.com
VIGIA_DIR=/vigia
# opcional (padrão 30): VIGIA_RETENCAO_DIAS=30
```
- `MCP_VIDEO_EMAILS`: e-mails de usuários **ativos do console** que veem as ferramentas (a gerente entra no conector com essa conta
  compartilhada; se ela passar a ter login próprio, acrescente o e-mail). Sem a variável (ou sem `VIGIA_DIR`) as ferramentas
  **não existem** para ninguém e a rota do clipe nem é registrada.
- A chave do link do clipe é **derivada** de `SESSION_JWT_SECRET` (HMAC com rótulo próprio): nenhuma chave nova para guardar.
  Trocar `SESSION_JWT_SECRET` invalida os links em aberto (vencem em 15–30 min de qualquer jeito).
- Conferir que o usuário existe e está ativo (só leitura):
  `select email, is_active, role from users where lower(email) = 'doutordigitalconsultoria@gmail.com';`

### 3.5 Log de acesso do Traefik

O token do clipe viaja no caminho da URL (`/vigia/clipe/<token>/...`) e vale 15–30 min. Se o access log do Traefik estiver
ligado, o token fica gravado nele; veja o mesmo cuidado da PR do cofre de arquivos (`--accesslog.fields.names.RequestPath=drop`
e `RequestLine=drop`, conferindo os nomes na versão em uso). O backend também registra `req.url` no nível `debug`; em produção o
nível é `info`.

### 3.6 Retenção e limpeza

O conector **só lista e só abre** pacotes dos últimos `VIGIA_RETENCAO_DIAS` dias (30). O que passou disso **continua no disco**
até alguém limpar. A limpeza é manual e em dois passos (primeiro olhar, depois apagar, com o ok do João):

```bash
# 1) listar o que sairia (35 dias = 30 + margem; NADA é apagado)
find /srv/vigia -mindepth 2 -maxdepth 2 -type d -mtime +35 -print | sort
du -sh /srv/vigia
# 2) só depois do ok: apagar (guarde a lista do passo 1)
find /srv/vigia -mindepth 2 -maxdepth 2 -type d -mtime +35 -exec rm -rf -- {} +
```
Conta de espaço: ~20 KB por folha + clipes; um dia de câmera movimentada fica em dezenas de MB. Ver com `du` na primeira semana.

## 4. O que NÃO está provado (até o deploy e o primeiro envio real)

- O envio por `ssh` com `rrsync` até `/srv/vigia` (testei com destino local).
- O volume no container e a leitura em produção (`VIGIA_DIR` apontando para o bind).
- Que o claude.ai **mostra** a imagem devolvida pela ferramenta ao modelo (o conteúdo é o `image` padrão do MCP; teste:
  `video_folhas` com um evento e perguntar ao Claude o que ele vê).
- Que o navegador da gerente toca o clipe pelo link (o servidor responde `video/mp4` com Range; H.264 sem áudio, toca em qualquer navegador).
- Triagem de 10 h de vídeo real (provei 4 min sintéticos; o `--rapido` em 10 h leva minutos, mas não medi). Câmera com muito
  ruído à noite pode gerar eventos demais: `triagem.py --limiar` / `--juntar` (veja a skill local).

## 5. Privacidade

Imagem de câmera de funcionário é dado pessoal (LGPD) e gravação de funcionário exige aviso. Só a gerente e o João veem; cada
chamada às ferramentas e cada abertura de clipe fica em `mcp_auditoria` (quem, qual gravação/evento, IP). O relatório da skill
**descreve o que se vê, nunca acusa**: não é prova; quem decide é a pessoa, vendo o clipe.
