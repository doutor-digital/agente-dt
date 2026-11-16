---
name: nova-unidade
description: Monta uma clínica nova no CRM da Doutor Digital. Faz as perguntas do questionário (AskUserQuestion), grava ops/kit-unidade/unidades/<slug>.yaml e o roteiro <slug>-joao.sh, confere em SECO e mostra o plano e o que fica manual. Use quando o João disser "/nova-unidade", "nova clínica", "fechou um franqueado", "montar a unidade X" ou "clínica de demonstração". NÃO aplica nada em produção.
---

# /nova-unidade

Você monta a **clínica nova no CRM** (uma conta própria no Chatwoot por clínica). Seu trabalho: perguntar, escrever o questionário, conferir **em seco** e entregar ao João o roteiro. **Quem aplica em produção é o João** (o classificador barra escrita em produção, e conta/usuário/segredo não são seus).

## Regras que não mudam
- **Segredo nunca entra no questionário nem na conversa.** Onde há token, pergunte o **nome da variável** (`META_ADS_TOKEN_<SUFIXO>`), nunca o valor. Se a pessoa colar um token, não repita: peça para apagar e siga.
- **Questionário de clínica REAL tem dado pessoal** (e-mail das atendentes, chave Pix, telefone) e **NÃO vai para o GitHub**: grave em **`~/Kommo-Integracao/_replicacao/kit-unidade/privado/<slug>.yaml`** — um caminho FIXO **fora do repositório** (a sessão trabalha num worktree descartável: dentro do checkout a única cópia sumiria; fora, ela nem passa pelo git). Crie a pasta com `mkdir -p -m 700 ~/Kommo-Integracao/_replicacao/kit-unidade/privado` e o arquivo com modo 600 (`chmod 600`); o `levar-kit-para-vps.sh --questionario` recusa pasta/arquivo mais abertos. NUNCA em `unidades/<slug>.yaml` nem dentro do repositório (se o slug existir nos dois lugares o kit recusa). Só a demonstração (`@example.com`, sem dado de verdade) fica versionada em `unidades/`.
- **Não rode `--aplicar`.** Você roda só o seco (`--offline`, sem tocar em banco nem Chatwoot).
- **Não invente dado de clínica.** Endereço, link do mapa, preços e horários viram frase dita ao paciente e texto de modelo aprovado na Meta. Pergunte; se a pessoa não sabe, anote como pendência (não preencha "de exemplo" numa clínica real).
- Demonstração: `whatsapp.modo: demonstracao` (sem número, sem WABA; modelos da Meta em seco; caixa do tipo API) e e-mails `@example.com`. A «Clínica Demonstração» já existe em `ops/kit-unidade/unidades/clinica-demonstracao.yaml` (slug `clinica-demonstracao`, subdomínio `demo`).

## Antes de perguntar: «já veio pelo formulário?»
Pergunte ao João (AskUserQuestion) se o dono da clínica **já preencheu o formulário** (`/nova-clinica/<código>`; o João recebe um aviso no WhatsApp com o id). Se sim, **não faça as perguntas abaixo**: o questionário é gerado
na VPS a partir do formulário. Entregue o comando do João: `bash ops/kit-unidade/abrir-clinica-joao.sh <slug> --do-formulario <id> --so-conferir` e depois sem a flag; o que faltar (`PENDENTE`) ele completa com `--set … --refazer`.
Se ainda não preencheu, ofereça criar o link: `bash ops/kit-unidade/convite-clinica-joao.sh --rotulo "<nome>"` (o link aparece uma vez; ele manda direto no WhatsApp do dono — nunca cole o link no chat). Só então, se o João preferir
responder ele mesmo, siga as perguntas abaixo.

## Perguntas, nesta ordem (use AskUserQuestion; uma rodada por bloco)
1. **Clínica de verdade ou demonstração?** (define `whatsapp.modo`; em demonstração pule a pergunta 8.)
2. **Nome, cidade e UF** da clínica; você deriva o **slug** (`doutor-hernia-<cidade>` para a rede; kebab-case, confirme).
3. **Endereço completo** e **link do "Como chegar"** (https). Avise: vão no texto dos modelos da Meta; trocar depois exige modelo novo.
4. **Subdomínio** do CRM (`<sub>.doutordigitalconsultoria.com`, só minúsculas e dígitos, sem hífen).
5. **Horários**: dias da semana (0=domingo…6), início, fim, almoço (opcional), duração da consulta.
6. **Profissionais**: nome, função (`fisioterapeuta`/`medico`) e, se souber, o id na franquia (`franquia_staff_id`).
7. **Valores**: consulta no dia; consulta antecipada; **sinal Pix** (opcional; exige o antecipado); aceita antecipado? Chave Pix e favorecido (opcionais, sensíveis).
8. **WhatsApp (só clínica de verdade)**: número oficial (`+55…`), `kapso_phone_number_id`, `waba_id`, prefixo dos modelos (ex.: `serra_`), conexão (`coexistencia` ou `numero-novo`).
9. **Atendentes**: nome, e-mail e função (`gerente` — exatamente 1 —, `secretaria`, `sdr`, `observador`) e o e-mail do usuário "📱 Celular da unidade" (opcional). Nome da caixa e do time.
10. **Franquia**: `id_company` e o **nome** da variável do token (`FRANQUIA_TOKEN_<SUFIXO>`).
11. **Meta**: `ad_account` (`act_…`), Business Manager e o sufixo — as 3 variáveis têm o mesmo sufixo (`META_ADS_TOKEN_`/`META_ADS_CONTA_`/`META_DATASET_ID_<SUFIXO>`).
12. **Sofia**: nome da IA e tom (`friendly` padrão).

## O que você produz
1. O questionário: clínica real → `~/Kommo-Integracao/_replicacao/kit-unidade/privado/<slug>.yaml` (fora do repositório); demonstração → `ops/kit-unidade/unidades/<slug>.yaml`. Forma: `ops/kit-unidade/unidades/clinica-demonstracao.yaml` / `ops/kit-unidade/questionario.exemplo.yaml`.
2. `ops/kit-unidade/unidades/<slug>-joao.sh` — uma linha: `exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../nova-unidade-joao.sh" <slug> "$@"` (copie `clinica-demonstracao-joao.sh` e troque o slug; `chmod +x`).
3. **Confira em seco**, de dentro de `backend/`:
   `pnpm exec tsx src/scripts/nova-unidade.ts $HOME/Kommo-Integracao/_replicacao/kit-unidade/privado/<slug>.yaml --offline`   (demonstração: `…/unidades/<slug>.yaml`)
   Se o questionário for inválido, corrija com a pessoa (as mensagens dizem o campo). Mostre o plano **resumido**: o que cria em cada sistema.

## O que você entrega no fim (curto)
- O plano em seco e **o que fica MANUAL**: Platform App (1ª vez), `KIT_SEGREDOS_DIR`, número/Kapso (clínica real), subdomínio (`regra-traefik-joao.sh <sub>`), cofre → env do serviço `ddagent_agent` + reinício, pastas de cada atendente, token e turnos da franquia, ativar a unidade.
- **O comando único do João** (do computador dele, não da VPS): `bash ops/kit-unidade/abrir-clinica-joao.sh <slug>` (antes, `--so-conferir`). Ele leva o kit e o questionário privado, confere, mostra o plano, pergunta «aplicar?» uma vez e encadeia Platform App → `--aplicar` → Traefik → cofre→serviço → resumo do que falta. Entregue ESTE comando; a lista abaixo é o que ele encadeia (para quem precisar rodar um passo só).
- Os comandos **do João**, na ordem (copie do `clinica-demonstracao-joao.sh`; a VPS não tem cópia do repositório, então primeiro `levar-kit-para-vps.sh`, e **clínica real** também `levar-kit-para-vps.sh --questionario <slug>`, que manda só o arquivo privado para a VPS em modo 600; os scripts rodam de `/root/kit`): `criar-platform-app-joao.sh` (uma vez) → `<slug>-joao.sh` (seco) → `<slug>-joao.sh --aplicar` → `regra-traefik-joao.sh <sub>` → cofre/reinício → teste da Sofia → `--ligar-robo` (só depois).
- O que **não foi provado**: nada foi aplicado; a prova contra o Chatwoot/Kapso de verdade só vem do primeiro `--aplicar`.
