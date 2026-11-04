# DD · Alertas grupo (simples)

Alertas de WhatsApp para o **grupo da unidade**, em versão pequena e de pouco volume, para não ser banido de novo
(o histórico do 9119 está em `project_numero_novo_antiban`). Substitui, na prática, o fluxo antigo
`DD · Alertas SDR` (`K33m9ZYNA6R3h2j0`), que **fica como está, desativado**.

> **Estado: entregue DESATIVADO.** Sem chip não há remetente. Nada foi criado no Kommo.

## O que passa (só 3 tipos; o resto é descartado)

| Tipo | Texto da tarefa que o reconhece | Quando sai |
|---|---|---|
| **Paciente sem resposta** | `aguardando há …`, `sem resposta`, `ninguém respondeu` (tarefas do SLA e do alerta de 5 min) | **Resumo** a cada 15 min (:00 :15 :30 :45), 1 mensagem por grupo listando nome, há quanto tempo e link do cartão. Nada se a lista estiver vazia |
| **Bandeira vermelha** | `sinal de alerta`, `bandeira vermelha`, `red flag`, `🚩` (o texto real do backend é `LIGAR AGORA — URGENTE: paciente com sinal de alerta clínico (…)`, em `sinal-de-alerta.ts`) | Na hora (20–90 s). Se chegar entre 21h e 7h, **fica guardada e sai às 7h** |
| **Consulta agendada pela IA** | `CONSULTA AGENDADA PELA I.A` (texto fixo de `agenda-tools.ts`) | Na hora (20–90 s). À noite é descartada |

**Atenção — o 3º tipo hoje NÃO chega.** Desde 21/09 a tool `agendar_consulta` grava uma **nota** no cartão, não uma tarefa
`ALERTA ·`; o webhook `add_task` não dispara com nota. Para esse tipo funcionar é preciso uma de duas coisas (decisão do João,
nenhuma foi feita): (a) o backend voltar a criar a tarefa (a tarefa "tampava o chat", por isso saiu); ou (b) assinar no Kommo o
evento de **nota adicionada** apontando para o mesmo `/webhook/alerta-grupo` — o código já lê qualquer chave `…[text]` e
`…[element_id]`, mas o formato exato do payload de nota **não foi visto**, e a nota hoje não começa com `ALERTA`, então o filtro
a descartaria. Ou seja: (b) pede um ajuste de 1 linha depois de ver o primeiro payload.

O que a mensagem **nunca** leva: trecho da conversa e motivo clínico. Só nome, o que aconteceu em uma frase, tempo e link do cartão.

## Limites (todos no static data do próprio workflow)

- **1 alerta por paciente (lead) e por tipo a cada 2 h.**
- **Silêncio 21h–7h** (Brasília): resumo e "agendada" são descartados; bandeira vermelha espera até as 7h.
- **Teto de 6 mensagens por hora por grupo**; passou do teto, o que está pronto espera a hora virar (expira em 3 h / 40 min).
- **Atraso aleatório de 20–90 s** antes de cada envio, **nunca 2 envios no mesmo minuto**, com "digitando…" de 1,5–4 s.
- Resumo mostra no máximo 8 pacientes; o cabeçalho varia entre 3 textos.
- Só **Açailândia**. Outra unidade com os 3 tipos é descartada e fica no log (`sem rota`).

### Por que o atraso não é um nó Wait (desvio consciente do pedido)

O n8n grava o static data **inteiro** no fim de cada execução que o alterou (conferido em `workflow-runner.js` /
`execution-lifecycle-hooks.js` da 2.29.9), e uma execução retomada de um Wait **não** recarrega o static data. Um Wait de 20–90 s
seguraria um retrato velho e, ao terminar, apagaria o que outras execuções gravaram nesse intervalo (e um Wait até as 7h apagaria
10 horas). Por isso o "Wait" é um horário (`quando`) guardado na fila; o gatilho de **1 minuto** só despacha o que já venceu.
Efeito: o atraso real fica entre 20 s e ~2,5 min.

## Como funciona (2 caminhos, 5 nós)

```
Webhook alerta-grupo ──► Entrada (classifica, rota, silêncio, dedupe, enfileira)         (static data)
A cada minuto ─────────► Despachar (resumo de 15 min, teto, silêncio, 1 envio) ──► Evolution sendText
```

- A **instância** está numa constante no topo do nó *Despachar*: `INSTANCIA = 'alertas3'`. Os grupos, a menção e o número de teste
  estão no topo do nó *Entrada* (`UNITS`, `SUBS`, `TEST_NUM`).
- Menção: só na bandeira vermelha, e só se `mention` da unidade estiver preenchido (Açailândia: o número do mapa antigo; `''` para tirar).
- O segredo do webhook vai na URL (`?k=…`): quem não tem o segredo recebe `recusado` e nada é enfileirado. O `importar.sh` gera o
  segredo e guarda em `/root/.alerta-grupo.env` (600). A chave da Evolution é lida do contêiner na hora de importar; **não está neste repositório**.
- Execuções de sucesso não são guardadas (o gatilho roda 1440×/dia); as de erro sim. O histórico útil fica em `staticData.global.log`
  (últimas 120 linhas) e `staticData.global.contagem` (por dia: `enviado_total:<grupo>`, `enviado:<tipo>`, `silencio:*`, `dedupe:*`, `sem_rota:*`).

## Testar com 🧪 (nunca vai para grupo)

Tarefa de texto `ALERTA · 🧪 [Contato: Teste X] Lead aguardando há 2 horas e ninguém respondeu.` (ou com `LIGAR AGORA … sinal de alerta clínico`)
na conta de Açailândia, ou por `curl` direto no webhook (ver abaixo). Vai **só** para o número do João (`TEST_NUM`), com o cabeçalho `🧪 TESTE`,
funciona para qualquer unidade e a qualquer hora, não conta no teto nem no dedupe, e o resumo sai em ~1–2 min em vez de esperar os 15.

```bash
# na VPS de produção, com o workflow ATIVO e o segredo do /root/.alerta-grupo.env
. /root/.alerta-grupo.env
curl -sS -X POST "https://webhook-n8n.doutordigitalconsultoria.com/webhook/alerta-grupo?k=$ALERTA_GRUPO_SEGREDO" \
  --data-urlencode 'task[add][0][text]=ALERTA · 🧪 [Contato: Teste X] Lead aguardando há 2 horas e ninguém respondeu.' \
  --data-urlencode 'task[add][0][element_id]=1' --data-urlencode 'account[subdomain]=doutorherniaacailandia'
```

## Ligar a 2ª unidade (1 por dia, depois de medir)

1. Em `src/entrada.js`, no `UNITS`, some uma linha com o `jid` do grupo **"Mkt | Dr Hérnia <cidade>"** copiado do mapa do fluxo antigo
   (`K33m9ZYNA6R3h2j0`, nó *Extrair alerta*) — o `SUBS` já tem o subdomínio de todas as contas.
2. `node n8n/alertas-grupo-simples/build.mjs && node --test n8n/alertas-grupo-simples/test.mjs`, depois editar o mesmo código no nó *Entrada* do n8n (ou rodar `importar.sh` com o workflow desativado).
3. O chip novo precisa estar **no grupo** da unidade. 4. Assinar o `add_task` na conta Kommo dela (checklist abaixo). 5. Teste 🧪 saindo daquela conta.

## Checklist para ligar (quando o chip estiver conectado)

1. **Chip**: comprado e esquentado 7 dias (WhatsApp Business com foto/nome/recado, conversa real, número salvo pela equipe). Não é o 9117 do financeiro.
2. **Evolution de produção** (`https://evolution.doutordigitalconsultoria.com/manager/`): criar a instância **`alertas3`** (o nome tem que ser o da constante `INSTANCIA`) e escanear o QR com o chip. Não mexer na `alertas2`.
3. Pôr o chip no grupo **"Mkt | Dr Hérnia Açailândia"** (jid `120363399681615902@g.us`). Não listar todos os grupos da instância (429 em 08/10).
4. **Importar** (se ainda não estiver no n8n): `scp n8n/alertas-grupo-simples/{workflow.json,importar.sh} root@89.116.214.130:/root/` e `ssh root@89.116.214.130 'chmod +x /root/importar.sh && bash /root/importar.sh'` — importa **desativado**, imprime o id e a URL do webhook.
5. **Ativar só o workflow** (sem webhook no Kommo ainda): n8n → ativar, ou `curl -X POST -H "X-N8N-API-KEY: …" $N8N_API_URL/workflows/<id>/activate`. Sem webhook no Kommo ninguém o chama.
6. **Teste 🧪 → João** (curl acima). Esperado: 1 mensagem `🧪 TESTE …` no WhatsApp do João em até ~2,5 min, vinda do chip novo. Conferir `log` no static data.
7. **Kommo de Açailândia** (`doutorherniaacailandia`): `GET /api/v4/webhooks` e olhar o que já existe. Criar `POST /api/v4/webhooks` com `{"destination":"https://webhook-n8n.doutordigitalconsultoria.com/webhook/alerta-grupo?k=<segredo>","settings":["add_task"]}`.
   O webhook antigo `…/webhook/alerta-sdr` daquela conta **continua apontando para o fluxo antigo (desativado, responde 404)**: não duplica enquanto o `K33m9ZYNA6R3h2j0` ficar desativado. Se o João preferir, remover o antigo (**só com o ok dele**). Nunca ativar os dois ao mesmo tempo.
8. Um 🧪 pela conta Kommo de verdade (tarefa manual `ALERTA · 🧪 …` no cartão de teste) para provar o caminho Kommo → n8n.
9. **Medir 2 dias**: `curl -sS -H "X-N8N-API-KEY: $N8N_API_KEY" $N8N_API_URL/workflows/<id> | python3 -c "import json,sys; d=json.load(sys.stdin)['staticData']['global']; print(json.dumps(d['contagem'],indent=1)); print(*d['log'][-30:],sep='\n')"`. Meta: poucas dezenas de mensagens/dia no grupo, nunca mais que 6 por hora. Só depois, a 2ª unidade.

Se a instância `alertas3` cair: a mensagem já reservada se perde (o envio não tem retry de propósito — sem laço de reconexão) e a execução com erro fica salva
no n8n. Reconectar é manual, no máximo 1×/hora. O vigia dos robôs deveria olhar `connectionState` da `alertas3` (não feito).

## Arquivos

- `workflow.json` — gerado; **não editar à mão**. `node build.mjs` o recria a partir de `src/*.js`.
- `src/entrada.js`, `src/despachar.js`, `src/comum.js` — o código dos nós (o `comum` é colado nos dois).
- `test.mjs` — `node --test n8n/alertas-grupo-simples/test.mjs` (18 casos: relógio e sorteio falsos).
- `importar.sh` — importa desativado na VPS de produção.

## Limites conhecidos

- **Corrida no static data**: duas tarefas ALERTA dos 3 tipos chegando na mesma centena de milissegundos podem fazer uma ser perdida (o n8n regrava o objeto inteiro). Medido localmente: dois `curl` colados perderam um; com 2 s de intervalo, nenhum. Com algumas dezenas de eventos por dia a chance é da ordem de 1 em 600 dias; se o volume crescer, trocar a fila por *Data Table* do n8n ou Redis.
- Tarefas que não são dos 3 tipos não escrevem nada (só leem), então não competem.
