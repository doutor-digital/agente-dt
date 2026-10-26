# CAPI de conversões (n8n) — v3: "pediu horário", Status com `page_id`, 1 Lead por clique

Os 18 workflows `DD · CTWA → Meta CAPI · Conversões (<unidade>)` vivem **só no n8n** (não há gerador no repo). Esta pasta
versiona o que a v3 troca neles e o script que aplica. **Nada aqui roda sozinho: o PR não muda produção.** Quem aplica é o
João, uma unidade por vez (Balsas primeiro).

## O que muda (decisão do João, 26/10/2026 — revoga "Lead só com Quente", de 24/09)

| # | Mudança | Onde |
|---|---|---|
| 1 | `LeadSubmitted` também quando o paciente chega ao ponto de marcar horário (etiqueta **"IA · Pediu horário"** no cartão) | `classificar-etapa.v3.js` + backend (`src/lib/pediu-horario.ts`) |
| 2 | Anúncio de **Status** (sem `ctwa_clid`) deixa de ser descartado: sai por `page_id` + `ph` em hash | `montar-evento.v3.js`, `buscar-clique.v3.sql` |
| 3 | `ph` com 55 — **conferido**, ver abaixo; nada a trocar | `montar-evento.v3.js` (testes) |
| 4 | No máximo **1 `LeadSubmitted` por clique** (por telefone, nos Status) | `reservar-envio.v3.sql` |
| 5 | Cartão que não recebeu o `ctwa_clid` que existe em `ctwa_eventos` (37 Lead em 8 semanas) passa a achar o clique pelo **id do cartão** | `buscar-clique.v3.sql` |

### 1. "Pediu horário": por que esta fonte

Medido em Balsas, 30 dias, 297 leads de anúncio:

* o campo `◷ Preferência de horário` (que a Sofia grava) estava preenchido em **1** cartão; `⬢ Intenção = Agendar` em **3** — sem volume;
* texto do paciente não serve: a mensagem pronta do anúncio já diz "quero agendar uma avaliação" e "boa tarde" casa com "tarde";
* **a Sofia achar horário CONFIRMADO para oferecer** (`consultar_horarios`, ≥ 1 horário) é o momento em que ela sabe que o paciente quer marcar e que há vaga. É o sinal que existe, é barato, e não inventa Lead para quem só disse "oi".

O recado vai por **etiqueta no cartão** (o n8n já lê o cartão a cada webhook): sem endpoint novo, sem chave, a SDR vê o que a máquina viu, e quem escreve é **um só** (a Sofia) — o n8n nunca grava de volta. **O backend precisa estar no ar com a automação `capi-pediu-horario` ligada na unidade** (PR separado, nasce em "só no papel").

Regras do n8n:

* mesmo `event_id` do Quente (`quente-<cartão>`): quem chegar primeiro manda, o UNIQUE de `capi_envios` segura o outro;
* só em etapa pré-agendamento (`cfg.preAgendado`); de AGENDADO em diante a cadeia da v2 já emite o Lead;
* etiqueta de exclusão (`Alerta · Mora fora`, `Fora do escopo`) anula o sinal;
* `event_time` = hora de atualização do cartão (nunca depois de agora, nunca antes do clique); **só vale até 7 dias depois do clique** — é a regra da meta "Maximizar leads por mensagens";
* **unidades sem IA** (só SDR) não têm quem ponha a etiqueta: continuam pelo Quente, sem mudança.

### 2. Status

Caminho oficial da Meta para mensagens sem clique: `page_id` + `whatsapp_business_account_id` + ≥ 1 dado de cliente em hash. **Sem `page_id` a Meta rejeita.** Só sai se (todas): a unidade tem `cfg.status.pageId`; o cartão tem clique amarrado em `ctwa_eventos` (prova que veio de anúncio e dá telefone e hora); o evento é de até 7 dias depois do clique. Fora disso o descarte continua `sem_ctwa_clid`, como na v2 (as contagens não mudam). Motivos novos em `capi_descartes`: `status_fora_7d_do_clique`, `status_sem_telefone`, `pediu_fora_7d_do_clique`, `pediu_sem_hora_do_clique`, `clique_no_futuro`.

Não documentado pela Meta (parte 1 do estudo): se o Brasil está no subconjunto de países do caminho sem clique. Por isso o Status nasce **desligado**, passa por **seco** e só então **ligado em uma unidade**, olhando `capi_envios.http_status/resposta`.

### 3. `ph` com 55

O telefone vem do `wa_id` da conversa (`ctwa_eventos.telefone`). Medido em 30 dias (toda a rede, `ctwa_eventos`): 6.375 de 6.382 linhas têm 12–13 dígitos começando em 55; as 7 restantes (35…, 59…, 25…, 51…, 34…) são número de fora ou malformado. O código **não** chuta DDI em número de fora (marcaria a pessoa errada). Testes travam `ph = sha256("55…")`.

## Como aplicar (produção, na VPS, com ok do João)

```bash
scp -r n8n/capi-conversoes root@89.116.214.130:/root/homolog/capi-v3     # ou git pull do repo na VPS
cd /root/homolog/capi-v3
./aplicar-v3.sh --unidade Balsas --seco                  # 1) não grava: backup + mostra quais nós mudam
./aplicar-v3.sh --unidade Balsas --pediu seco            # 2) grava a v3; "pediu horário" em SECO (grava 'simulado', não chama a Meta)
# ...olhar capi_envios (status='simulado', event_id 'quente-…') por 1–2 dias...
./aplicar-v3.sh --unidade Balsas --pediu ligado          # 3) liga o "pediu horário"
./aplicar-v3.sh --unidade Balsas --status seco   --page-id <ID_DA_PAGINA>   # 4) Status em seco
./aplicar-v3.sh --unidade Balsas --status ligado                           # 5) Status de verdade
./aplicar-v3.sh --unidade Balsas --desfazer /root/homolog/backup-capi-v3-<data>/<id>.json   # volta tudo
```

* O nome da unidade casa com o nome do workflow, **com maiúscula** ("Balsas", não "balsas"), uma por vez.
* Modo em branco **preserva** o que já está ligado: rodar o script de novo não desliga nada.
* **Não rode `capi-aplicar-v2.sh` depois da v3** na mesma unidade: ele troca o "Classificar etapa" de volta para a v2 e o "pediu horário" some em silêncio. Etapa nova no funil: rode a v2 e depois este script de novo.
* O script guarda o backup em `/root/homolog/backup-capi-v3-<data>/` e imprime como desfazer.

### O que o script troca em cada workflow (todos os 18 conferidos, só leitura)
`Config` (acrescenta `pediuHorario` e `status`, preserva `cadeia`/`preAgendado`), `Classificar etapa`, `Montar evento`, `Buscar telefone e nome` (SQL + parâmetros), `Reservar envio` (SQL), `Cliques e reenvios` (acrescenta `AND v.ctwa_clid IS NOT NULL`: o relógio só sabe remontar com clid; o Status que falhou volta no próximo webhook do cartão) e o IF `Modo teste` (passa a olhar também `_seco`, mantendo o `dryRun` global). Se qualquer nó faltar ou a âncora do SQL de reenvio tiver mudado, o script **falha alto e não grava**.

## Como provar depois de ligar (não é código mesclado que prova)

```sql
-- seco: o que teria saído
SELECT event_id, status, ctwa_clid IS NULL AS status_ad, reservado_em FROM capi_envios
 WHERE unidade='balsas' AND event_name='LeadSubmitted' AND status='simulado' ORDER BY reservado_em DESC;
-- ligado: o que a Meta respondeu (HTTP 200 e events_received:1; 400 = ver 'resposta')
SELECT event_id, http_status, resposta FROM capi_envios WHERE unidade='balsas' AND event_name='LeadSubmitted'
 AND enviado_em > now() - interval '1 day' ORDER BY enviado_em DESC;
-- regravação: mais de 1 por lead na mesma varredura é bug (deve vir vazio)
SELECT kommo_lead_id, count(*) FROM capi_envios WHERE event_name='LeadSubmitted' AND status='enviado' GROUP BY 1 HAVING count(*)>1;
-- mais de 1 por clique (deve vir vazio daqui para frente; 1 caso antigo em Araguaína)
SELECT ctwa_clid, count(*) FROM capi_envios WHERE event_name='LeadSubmitted' AND status='enviado' AND ctwa_clid IS NOT NULL
   AND enviado_em > '2026-10-26' GROUP BY 1 HAVING count(*)>1;
```
E no Gerenciador de Eventos do dataset da unidade: o `LeadSubmitted` aparece, e (Status) o evento sem `ctwa_clid` é aceito. Só depois de 7 dias dá para ver se a Meta atribuiu.

## Testes

```bash
node --test n8n/capi-conversoes/*.test.mjs        # Node >= 20: 54 testes — nós de código (31), montador (15), aplicar-v3.sh com docker/curl de mentira (8)
n8n/capi-conversoes/teste-reservar-envio.sh       # Postgres descartável no docker: 1 Lead por clique (15 casos)
python3 n8n/capi-conversoes/previa-pediu-horario.py --dias 30 --unidade balsas   # NA VPS, só leitura
```
Contra a v2 os testes novos **falham** (15 de 26 nos nós, na primeira rodada; 3 dos 15 no SQL): `buscar-clique.v3.sql` foi executado só-leitura contra
produção para 3 cartões reais (um Status, um com clid recuperado pelo id do cartão, um inexistente).

## Armadilhas já conhecidas

* **Dois escritores do mesmo campo:** o n8n não grava no cartão; a etiqueta só tem o agente como autor.
* **Seco que grava:** o `_seco` cobre o caminho novo (IF "Modo teste") e o SQL só reaproveita `simulado`; o Quente de sempre **não** é afetado pelo seco do "pediu horário".
* **Etapa/ALTA:** nada aqui mexe em etapa nem em campo do cartão.
* **Vigia (`capi-vigia`)** não conhece o "pediu horário": se o webhook da Kommo falhar, o Lead só sai no próximo evento do cartão. Extensão fica como próximo passo.
* **`event_time` do "pediu horário" = `updated_at` do cartão.** Se o webhook da hora da etiqueta se perder e o cartão for editado dias depois, a hora anda para frente (e o evento pode cair no corte de 7 dias do clique: perde-se o Lead, nunca se manda um fora do prazo). O ideal é a hora em que a etiqueta foi posta (`GET /events`), a um custo de uma chamada por candidato — fica para depois de provar o volume.
* **1 Lead por clique** é checado antes do INSERT, sem trava: dois cartões do mesmo clique reservando no mesmo milissegundo passam os dois (1 caso em 90 dias). O conserto de verdade é um índice único parcial (DDL em produção; o par antigo de Araguaína precisa ser resolvido antes) — com ok do João.
* **`event_time = agora` nos eventos de funil** (AddToCart/InitiateCheckout/Purchase) continua como estava — ~43% dos IC/Purchase chegam com clique > 7 dias (estudo de volume). Fora do escopo deste PR.
