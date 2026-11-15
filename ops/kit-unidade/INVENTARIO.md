# Inventário: o que hoje é específico de Parauapebas (ou de uma caixa)

Levantado em 14/11/2026 sobre `origin/main` (5c57b365). Linhas = `origin/main`, antes deste PR. Coluna **PR** diz o que este PR já tira
do código (`migrado`) e o que fica para a Fase 2 (`fase 2`). Fora do código só entrou o que dá para saber por scripts em
`~/Kommo-Integracao/_replicacao/` e pela memória do projeto; **nada foi consultado em produção**, então "como está" é o que está escrito, não medido.

Medida do problema (grep em `origin/main`, sem testes): `parau_` / `Parauapebas` aparece em **42 linhas de `chatwoot-regua.ts`**, 35 de
`chatwoot-regua-textos.ts` e em 15 outros arquivos de `backend/src`; os 33 textos dos modelos levam o endereço, o mapa e o nome da clínica dentro.

## A. Dentro do código

| # | O quê | Onde (arquivo:linha) | PR |
|---|---|---|---|
| 1 | caixa → unidade (`CAIXAS_REGUA` {2,3}) | `lib/chatwoot-regua.ts:21` (lido por ~14 módulos: pausa, etiquetas, resolver, ia, agenda, duplicados, worker, funil, assistente, aprendizados) | migrado |
| 2 | caixas WhatsApp Cloud (`CAIXAS_CLOUD` {3}) e de histórico (`CAIXAS_HISTORICO` {4}) | `chatwoot-regua.ts:29`, `:43`; usados em `funil.controller.ts:283,750`, `kapso-referral.ts:47`, `chatwoot-regua-worker.ts:454` | migrado |
| 3 | gerente da caixa (`GERENTE_DA_CAIXA` {2:4,3:4}) | `chatwoot-regua.ts:83` (usado em `chatwoot-regua-worker.ts:575`) | migrado |
| 4 | usuário "📱 Celular" (`USUARIO_CELULAR = 7`) | `chatwoot-regua.ts:85` (usado em `:804` e `chatwoot-pausa.ts:55`) | migrado (`ehUsuarioCelular`; a constante fica só como legado) |
| 5 | prefixo dos modelos `parau_` em ~40 regras e no nome enviado à Meta | `chatwoot-regua.ts:388,472-502,555-698`; `chatwoot-regua-worker.ts:521-548` | migrado no envio (`nomeDoModeloNaMeta`); o nome BASE `parau_*` segue como id lógico da regra (renomear mexe em 40 linhas que outros PRs editam) |
| 6 | 33 textos dos modelos com nome, cidade, endereço e mapa de Parauapebas | `lib/chatwoot-regua-textos.ts:7-40` (endereço: `:13`, `:38`; mapa: `:13`, `:38`; "Doutor Hérnia Parauapebas": `:8,22-26,35`; "unidade Parauapebas": `:27`) | migrado (`TEXTOS_BASE` derivado + `textosDaUnidade`; o arquivo de textos não mudou) |
| 7 | idioma dos modelos `pt_BR` | `chatwoot-regua.ts:31` | fica (igual para todas) |
| 8 | meta de agendamentos por dia (`{2:5,3:5}`) | `lib/chatwoot-hoje.ts:21` | migrado |
| 9 | instância do Evolution → caixa (`parauapebas-unidade`) | `lib/chatwoot-lida.ts:20` | migrado |
| 10 | caixa → unidade + WABA (CAPI) | `lib/chatwoot-capi.ts:40` (WABA 2146287749563217) | migrado |
| 11 | número do Kapso padrão `1212928641906230` | `controllers/kapso-proxy.controller.ts:37`, `lib/kapso-referral.ts:41` (duas cópias da mesma função) | migrado (config + env acrescenta) |
| 12 | sufixo das variáveis da Meta (`META_ADS_TOKEN_<SUF>`, `META_ADS_CONTA_`, `META_DATASET_ID_`, `META_CAPI_TOKEN_`) | `chatwoot-capi.ts:159-169`, `chatwoot-gestor.ts:782-793`, `chatwoot-origem.ts:71`, `lib/meta-anuncios.ts:5` | migrado (sufixo vem da config; o NOME da variável segue a convenção) |
| 13 | listas de unidades ligadas por automação (`CHATWOOT_{REGUA,IA,AGENDA,DUPLICADOS,CAPI,ORIGEM,ASSISTENTE}_SLUGS`) | `lib/automacoes.ts:945-1015` + `lib/automacoes-estado.ts` | já é por unidade: `unit_automacoes` vence a env; o kit grava as 6 em **seco** |
| 14 | textos das automações dizem "Hoje só a caixa da Parauapebas / caixa 3" | `lib/automacoes.ts:950,964,1006` (descrição na tela) | fase 2 (só texto) |
| 15 | `CHATWOOT_CONTA_ID` / `CHATWOOT_API_TOKEN`: UMA conta (id 1) para todas | `mcp-remoto/chatwoot.ts:59` | **muda (decisão de 15/11)**: uma INSTALAÇÃO do Chatwoot com várias CONTAS, uma por clínica vendida; Parauapebas segue na conta 1. `unit_chatwoot.conta_id`, token por conta `CHATWOOT_API_TOKEN_<SUFIXO>` (sem ele, o global). Ver os PRs «conta por clínica» |
| 16 | fuso fixo de Belém (UTC-3) em régua, Hoje e Gestor | `chatwoot-regua.ts:95,222`, `chatwoot-hoje.ts:17`, `chatwoot-gestor.ts:23` | **fase 2** — unidade fora de UTC-3 (ex.: Boa Vista, UTC-4) erraria a janela 08–20 h e a data da consulta |
| 17 | campos `{{lead.cf.2450736}}`… (ids de campo do Kommo de Parauapebas usados como nomes de variável dos modelos) | `chatwoot-regua.ts:402-430`; `chatwoot-regua-textos.ts` | fase 2 (é só nome de variável; vira `{{1}}` na Meta) |
| 18 | `ID_COMPANY_POR_SLUG` (id da unidade na franquia) | `lib/franquia-tela.ts:22` (Parauapebas: 131) | fase 2 (unidade nova precisa de linha aqui ou do campo no banco) |
| 19 | rótulo "Cidade/UF" do cartão | `lib/unidade-no-cartao.ts:35,49` (`VALOR_POR_UNIDADE`) | fase 2 (hoje cai no nome da unidade se faltar) |
| 20 | lista de unidades de campanha | `lib/campanha/campanhas.ts:31` | fase 2 (campanha é escolhida à mão) |
| 21 | rastreio de campanhas (Kommo+Meta): um JSON por unidade | `n8n/rastreio-campanhas/ops/unidades/parauapebas.json`, `provisionar.json`, `inventario.json`, `build-unidades.mjs` | fora do escopo (é o rastreio do Kommo; a CAPI do Chatwoot não usa) |
| 22 | tabela `units` (≈100 colunas): identidade, agenda (`spine_*`), pagamento (`pix_key`, `sinal_pix_centavos`, `accepts_advance_payment`), endereço (`clinic_address`, `clinic_map_url`), persona e fontes (`persona_*`, `source_negocio`, `source_produtos`), `system_prompt`, `spine_token` | `prisma/schema.prisma` model `Unit` | o kit preenche (sem tocar em token) |
| 23 | prompt da Sofia por unidade: `system_prompt` (+ `source_*`), roteiro da Sofia 2.0 com R$ 350/250/50 escritos no texto, `{unidade}` | fora do repo: `_replicacao/sofia2/bloco-conversa.md` + `novos/<slug>.txt` | migrado (molde versionado em `ops/kit-unidade/molde-sofia/`, preços e cidade como marcadores) |
| 24 | catálogo de automações | `lib/automacoes.ts` (`AUTOMACOES`) | o kit lê daqui os ids `chatwoot-*` com seco |

Já eram por unidade (sem trabalho): rede de unidades na Sofia (`agent/rede-doutor-hernia.ts` lê `units`), `unit_automacoes`, `unit_crm_compartilhado`.

## B. Fora do código: Chatwoot (conta 1, `atendimento.doutordigitalconsultoria.com`)

Da CONTA (uma vez; unidade nova só confere): etiquetas (≥19 que o código lê + `perdido-*`), atributos de conversa (≥23 que o código lê; Parauapebas tem os ids 14–29 e `programa` id 36), atributo de contato `interno`, 8 automações da conta (ids 1–8: só etiqueta/prioridade/nota), `DASHBOARD_SCRIPTS` (menu e Funil), webhook da conta, `WHATSAPP_CLOUD_BASE_URL` nos serviços `chatwoot_rails` e `chatwoot_sidekiq` (`ligar-kapso-chatwoot.sh`), marca/idioma.

Da UNIDADE (o que o script monta): caixa de WhatsApp Cloud via Kapso (hoje caixa 3; a 2 é o Evolution `parauapebas-unidade`, `ligar-parauapebas-chatwoot.sh`; a 4 é histórico importado), time, agentes (Cleia gerente id 4, Maria Heloisa 5, Lorena 6, Celular 7, Suzanne 1, Conector Claude, Painel Lia) e `inbox_members`, revezamento automático da caixa, 10 pastas (CustomFilter) por atendente, mensagens prontas e macros, robô Sofia (Agent Bot 1, `set_agent_bot` na caixa 3 + `CHATWOOT_SOFIA_COMO_BOT`/`CHATWOOT_SOFIA_BOT_TOKEN`).

## C. Fora do código: Meta / Kapso

Número oficial 98442-0153 em coexistência (phone_number_id `1212928641906230`, WABA `2146287749563217`) · 33 modelos `parau_*` aprovados (+ `parau_rotina_retomada`, criado 14/11 via Kapso) · dataset da CAPI da WABA · app e token da Meta de Parauapebas (`_replicacao/meta_app_parauapebas.txt`, `meta_token_chatwoot_parauapebas.txt`) · webhook do Kapso.

## D. Fora do código: VPS

Env do serviço `ddagent_agent` (`CHATWOOT_API_TOKEN`, `CHATWOOT_CONTA_ID`, `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_IDS`, `META_ADS_TOKEN_PARAUAPEBAS`, `META_ADS_CONTA_PARAUAPEBAS`, `META_DATASET_ID_PARAUAPEBAS`, listas `CHATWOOT_*_SLUGS`) · `/root/segredos` · serviço `chatwoot_franquias` (nginx → `chatwoot_rails:3000`, `/root/chatwoot-marca/franquias-nginx.conf`) com a regra Traefik `Host(...)` por subdomínio (DNS curinga `*` já aponta para a VPS; certificado `letsencryptresolver`) · linha da unidade em `units` e `unit_automacoes` no banco.

## E. O que o kit faz com isto

* Uma tabela por unidade (`unit_chatwoot` + `unit_chatwoot_caixa`), lida no boot com semente de Parauapebas (ver `chatwoot-unidades.ts`).
* Um questionário (`questionario.schema.json` / `questionario.exemplo.yaml`) com só o que é da unidade ou sensível.
* O script `backend/src/scripts/nova-unidade.ts`: seco mostra o plano dos blocos A.22, B, C e D; `--aplicar` executa hoje só o banco.
