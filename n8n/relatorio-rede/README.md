# Relatório da rede · 18h

Relatório diário para a chefe, com **todas as unidades**, juntando a **franquia** (agenda e tratamentos) com o **Kommo** (leads novos).

> **Estado: NADA ESTÁ NO AR.** O código está no repositório sem commit, o workflow está desligado e em modo teste, e nenhuma mensagem foi enviada a ninguém. Este documento existe para você conferir **antes** de qualquer coisa ser disparada.

---

## 1. O que será disparado

| # | Mensagem | Quando | Para quem | Quando NÃO sai |
|---|---|---|---|---|
| **1** | **O relatório** (texto abaixo) | Segunda a sábado, **18:00** (Brasília) | **Modo teste:** só o João (`5563991021043`), com a etiqueta 🧪 TESTE.<br>**Modo produção:** a chefe (número ou grupo a preencher) | Se o backend falhar por inteiro, a chefe não recebe nada |
| **2** | **Aviso de relatório incompleto** | Junto com a nº 1, **só se** alguma fonte falhou | **Sempre o João**, nunca a chefe | Se tudo respondeu |
| **3** | **Aviso de falha total** | Quando a chamada ao backend falha (401, 500, timeout) | **Sempre o João** | Se o relatório saiu |

Uma execução normal manda **2 mensagens à chefe**: o placar do dia e a análise dos últimos 7 dias. Se alguma fonte falhar, o João recebe um aviso à parte. Nunca manda mensagem a paciente.

### Como a mensagem 1 fica (dados fictícios — só o formato)

```
📊 *RELATÓRIO DA REDE · 30/09 · 18h*

*REDE · 6 unidades*
Leads novos: 41
Avaliações: 25 marcadas · 17 atendidas · 6 faltas · 2 em aberto · 0 desmarcadas
Comparecimento: 74% (17 de 23)
Sessões: 84 atendidas · 7 faltas · 0 em aberto
Tratamentos fechados hoje: 4 · R$ 10.000
Amanhã: 23 avaliações · 0 sessões

*POR UNIDADE*
*Balsas* · 4 leads · aval. 2/3 (1 falta) · sessões 12/12 · amanhã 3 aval.
*Canaã* · franquia indisponível · 3 leads
*Imperatriz* · 11 leads · aval. 5/8 (2 faltas) · sessões 31/34 · trat. 2 (R$ 5.200) · amanhã 7 aval.
...

*ATENÇÃO*
• Canaã: agenda da franquia não respondeu (403: IP nao autorizado)
• Sem franquia conectada, fora deste relatório: Petrópolis, Divinópolis

Como ler: "aval. 3/4" = 3 atendidas de 4 marcadas. Em aberto = marcado ou confirmado, sem desfecho até as 18h.
Fonte: agenda e tratamentos da franquia; leads do Kommo.
```

O arquivo completo, gerado pelo próprio código, está em [EXEMPLO-DO-TEXTO.txt](EXEMPLO-DO-TEXTO.txt). Só negrito com `*`: sem itálico, sem título com `#`.

---

## 2. O que cada número significa

| Número | De onde vem | Regra |
|---|---|---|
| **Leads novos** | Kommo | Leads com `created_at` entre 00:00 e 23:59 de hoje, no fuso da clínica |
| **Avaliações / Sessões / Retornos** | Franquia (agenda) | Agendamentos de **hoje**, separados pela categoria |
| **Marcadas** | Franquia | Tudo de hoje que **não** foi desmarcado nem remarcado |
| **Atendidas** | Franquia | Situação *Atendido* |
| **Faltas** | Franquia | Situação *Não compareceu* |
| **Em aberto** | Franquia | Agendado, confirmado, aguardando, atrasado ou sem situação. Ainda sem desfecho |
| **Desmarcadas** | Franquia | *Desmarcado* e *Remarcado* (saíram do dia, não entram em "marcadas") |
| **Comparecimento** | Franquia | `atendidas ÷ (atendidas + faltas)`. Quem está em aberto **não entra na conta**. Sem nenhum desfecho mostra "—", não "0%" |
| **Tratamentos fechados hoje** | Franquia | Tratamento **criado hoje** e não cancelado. O valor é a soma do campo `price` |
| **Amanhã** | Franquia | Agendados para amanhã, por categoria, sem os desmarcados |

**No placar do dia, nenhum número de comparecimento vem do Kommo.** O CRM depende de marcação manual e sai errado; a franquia é a verdade clínica. É a mesma regra do relatório das 20h da Imperatriz.

### A análise dos últimos 7 dias (mensagem 2)

Pedido da chefe: leads quentes e qualificados, quem agendou e faltou, principal objeção, pagamento antecipado. **Isso só existe no cartão do Kommo** (a franquia não guarda), então vem dos campos do cartão, numa janela de 7 dias. Um dia só teria amostra de 0, 1 ou 2 casos.

| Número | Campo do cartão | Regra |
|---|---|---|
| **Leads, quentes, mornos, frios** | `★ Qualificação (Quente/Morno/Frio)` | Leads **criados** nos 7 dias |
| **Consultas do período** | `◷ Data da Consulta` + `✓ Situação da consulta` | Cartões com data da consulta nos 7 dias. A situação é copiada da franquia pelo sincronizador |
| **Com comprovante** | `✓ Consulta pg antecipado` = Sim | **Pagou** de fato |
| **Disseram que iam pagar** | `¤ Pagamento antecipado` = Sim | Só a intenção. **Não conta como pago** |
| **Comparecimento: pagou × não pagou** | comprovante × situação | atendidas ÷ (atendidas + faltas) em cada grupo |
| **Principal objeção** | `⊘ Motivo do não agendamento` | Top 3 dos leads criados, **sempre com "registrado em X de Y"** |
| **Por que faltaram** | `⊘ Motivo do no-show` | Só das faltas |
| **Por que não fecharam** | `⊘ Motivo de não fechamento do tratamento` | Só dos atendidos |

**Por que a cobertura aparece ao lado de cada motivo.** Medido na Serra em 30/09 (só leitura): o motivo do não agendamento estava **vazio em 131 de 132 leads**. Mostrar "principal objeção: Sem interesse" sem dizer que só 1 lead tinha o motivo seria enganar a chefe. Quando ninguém registrou, o texto diz "ninguém registrou o motivo (0 de N)".

**Por que "pagou" é o comprovante.** Na Serra, as 6 consultas com "vai pagar = Sim" tinham "comprovante = Não", e todas foram desmarcadas. Somar os dois campos esconderia isso.

**Limites:** o Kommo não filtra por campo personalizado (testado: dá 400). Por isso as consultas saem dos cartões **mexidos** nos 7 dias; uma consulta cujo cartão ninguém tocou no período fica de fora. Unidade sem o sincronizador ligado tem a situação digitada pela equipe.

### O que o relatório NÃO tem (de propósito, para não inventar)
- Motivos extraídos das conversas por IA (só o que a equipe registra no campo).
- Leads perdidos e agendados por origem de anúncio (existem no relatório das 20h da Imperatriz; não foram portados para a rede).
- Receita do mês, comparação com dias anteriores, ranking entre unidades.
- Qualquer dado de paciente individual: nome, telefone, queixa.

---

## 3. Quais unidades entram

Entra toda unidade que tenha, ao mesmo tempo: **ativa**, **franquia ligada**, **token da franquia**. Uma linha por clínica: `*-resgate`, `*-tratamento` e `*-financeiro` dividem a conta da unidade principal e não são contadas de novo.

Ficam **sempre de fora**: `default` (Instituto Trauma, não é Doutor Hérnia) e `laboratorio-kommo`.

As ativas sem franquia aparecem numa linha do bloco ATENÇÃO, para a chefe saber que não é esquecimento.

> **Lista exata: ainda não sei.** Ela depende do banco de produção, que eu não li. Para ver a lista real sem disparar nada, veja o passo 2 do roteiro de teste (`GET /api/cerebro/unidades`). Pela memória de 25/08 o token da franquia existia em 9 de 14 contas; as mais novas (Bebedouro, Boituva, Olímpia, Taubaté, Boa Vista) podem ter entrado depois.

---

## 4. Credenciais

**Nenhum valor de credencial está neste repositório nem nesta documentação.** Nenhuma delas existe na máquina de desenvolvimento: ficam na VPS de produção. Você precisa criar duas no n8n (tipo **Header Auth**):

| Nome no n8n | Header | Valor | Onde está o valor |
|---|---|---|---|
| `Agente · chave de serviço (x-internal-key)` | `x-internal-key` | o valor de `INTERNAL_API_KEY` | Variável de ambiente do serviço do backend (stack na VPS). É a mesma que o n8n já usa na faxina das 20h, então **reaproveite a credencial que já existe lá** |
| `Evolution · alertas2 (apikey)` | `apikey` | a `AUTHENTICATION_API_KEY` da Evolution | Variável do serviço `evolution_api` na VPS. Reaproveite a que os alertas SDR já usam |

**O que só você tem e eu preciso de você:**

| Dado | Para quê |
|---|---|
| **Número ou grupo da chefe** | `destinoChefe` no nó Config. Número: `55` + DDD + número, só dígitos. Grupo: o JID terminado em `@g.us` |
| Confirmar que o número **alertas2 está no grupo**, se for grupo | A Evolution só entrega em grupo de que o número participa |

Depois de criar, abra os nós **Gerar relatório** e **Enviar WhatsApp** e selecione a credencial (o arquivo vem com marcador `PREENCHER` no lugar do id).

---

## 5. Swagger: testar a rota sem deploy e sem tocar em produção

Dois jeitos, e o primeiro já funciona agora:

**A · Servidor de teste local (dados fictícios).** Sobe na sua máquina e abre o Swagger pronto para clicar em *Test Request*:

```
cd backend && npx tsx src/scripts/relatorio-rede-mock.ts
→ http://localhost:3999/docs      Authentication → ChaveDeServico → chave-de-teste-local
```

O cálculo, o texto, a montagem da resposta, o contrato e os erros (`401`, `400`, `404`) são **o mesmo código da rota real**. Só os números são de mentira. Duas unidades falham de propósito (Taubaté: Kommo fora; Canaã: franquia fora) para você ver o relatório **incompleto** sem esperar uma falha de verdade. Não lê banco, não chama a franquia nem o Kommo, não envia WhatsApp.

**B · Swagger de produção.** O backend já serve `/api/docs` (Scalar) e `/api/openapi.json`, gerados das rotas reais. A rota nova aparece lá com parâmetros, cabeçalho e formato da resposta. **Só depois do deploy** — hoje ela não existe em produção.

**Postman / Insomnia / Bruno:** importe [openapi-relatorio-rede.json](openapi-relatorio-rede.json). Tem os dois servidores (local e produção).

> O Swagger do navegador aponta para o servidor local sem problema (mesma origem). Apontar a tela local para produção é bloqueado por CORS; para isso use o Postman ou o `/api/docs` da própria produção.

---

## 6. Roteiro de teste — só avance se o anterior passou

Nada aqui manda mensagem à chefe. Os passos 1 a 3 não mandam mensagem a ninguém.

| Passo | O que fazer | O que você deve ver |
|---|---|---|
| **0** | Swagger local (seção 5A): clique nos casos de erro e no relatório incompleto | Você vê o formato e o contrato sem depender de nada |
| **1** | No repo: `cd backend && npx tsx --test src/lib/relatorio-rede.test.ts` | `pass 37 · fail 0` |
| **2** | Com a chave em mãos, da VPS ou de qualquer lugar: `curl -s -H "x-internal-key: $CHAVE" https://agente-vps.doutordigitalconsultoria.com/api/cerebro/unidades` | A lista de unidades com `franquiaLigada`. **Esta é a lista que define quem entra no relatório** |
| **3** | **Uma unidade só**, texto puro: `curl -s -H "x-internal-key: $CHAVE" "…/api/relatorios/rede-diaria?unidades=doutor-hernia-serra&formato=texto"` | O bloco de uma unidade |
| **4** | **Confira na mão:** abra a agenda da franquia da mesma unidade (`/agendamentos`, filtrando hoje) e compare **atendidas, faltas e marcadas** com o texto do passo 3 | Os números batem. **Se não bater, pare aqui.** É o teste que importa |
| **5** | Mesmo comando sem `unidades=` (a rede inteira) | O texto completo, em até alguns minutos. Olhe o bloco ATENÇÃO |
| **6** | Importe `relatorio-rede-18h.json` no n8n, preencha as duas credenciais, deixe `modo = teste`, clique em **Rodar agora (teste)** | Chega **no seu WhatsApp** com 🧪 TESTE no topo |
| **7** | Só depois de aprovar: `destinoChefe` preenchido, `modo = producao`, ative o workflow | A chefe recebe às 18h |

Para conferir um dia já passado, use `&data=AAAA-MM-DD` — útil no passo 4 se você testar de manhã.

### Por que não dá para testar tudo na sua máquina
A API da franquia **recusa IPs que não sejam da VPS de produção** (403). Por isso os passos 3 a 5 só funcionam chamando o backend que já está na VPS. Os números do passo 1 são testados com dados de mentira.

---

## 7. Riscos e limites que eu conheço

1. **A rota nunca rodou contra dados reais.** O cálculo e o texto estão testados com dados fictícios (37 testes). A coleta real (franquia + Kommo) só se prova nos passos 3 a 5.
2. **Valor do tratamento:** soma o campo `price`. Se na franquia `price` for o valor total do plano e não o fechado hoje, o número fica correto para "tratamentos fechados hoje", mas vale confirmar com uma unidade no passo 4.
3. **Kommo já bloqueou esta VPS por rajada de chamadas.** O relatório chama com no máximo 2 unidades ao mesmo tempo e 400 ms de pausa. Se ainda assim o Kommo devolver 403, aquela unidade sai com "leads do Kommo não responderam", sem derrubar o resto.
4. **Uma franquia lenta não trava o relatório:** cada unidade tem teto de 120 s. Estourou, ela entra no bloco ATENÇÃO.
5. **Às 18h ainda há consulta em aberto.** Por isso "em aberto" aparece separado e não entra no comparecimento. O número final do dia só existe depois das 18h.
6. **Limite de 1.000 leads por unidade por dia** no Kommo (4 páginas de 250). Improvável de ser atingido, mas não medi o maior dia de nenhuma unidade; se um dia passar disso, o número sai menor e sem aviso.
7. **Sábado:** o disparo é de segunda a sábado porque não sei quais unidades abrem no sábado. Sábado sem agenda sai com zeros. Se preferir segunda a sexta, troque `1-6` por `1-5` em `build-workflow.mjs` e gere de novo.
8. **Tempo de resposta e proxy:** a rota pode levar de 1 a alguns minutos. O n8n espera até 15 min, mas não sei se o proxy da VPS na frente do backend corta a conexão antes. Se o passo 5 do teste cair em 504/502, é isso, e a saída é o n8n chamar unidade por unidade em vez de uma vez.

---

## 8. Como desfazer

- **Antes de importar:** nada a desfazer, nada está no ar.
- **Depois de importar, workflow desligado:** apague o workflow no n8n.
- **Backend:** é uma rota nova, de leitura. Não muda nenhuma rota existente (mais uma linha em `api.routes.ts`). Reverter = remover essa linha.

---

## 9. Arquivos

| Arquivo | O que é |
|---|---|
| [backend/src/lib/relatorio-rede.ts](../../backend/src/lib/relatorio-rede.ts) | Cálculo e texto. Nenhuma chamada de rede |
| [backend/src/lib/relatorio-rede.test.ts](../../backend/src/lib/relatorio-rede.test.ts) | 37 testes |
| [backend/src/scripts/relatorio-rede-mock.ts](../../backend/src/scripts/relatorio-rede-mock.ts) | Servidor de teste local com Swagger (dados fictícios) |
| [backend/src/docs/openapi.ts](../../backend/src/docs/openapi.ts) | Contrato detalhado das rotas de chave de serviço (já existia; ganhou a seção Relatórios) |
| [openapi-relatorio-rede.json](openapi-relatorio-rede.json) | O contrato exportado, para Postman/Insomnia/Bruno |
| [backend/src/controllers/relatorio-rede.controller.ts](../../backend/src/controllers/relatorio-rede.controller.ts) | Liga o cálculo à franquia e ao Kommo |
| `backend/src/routes/api.routes.ts` (linha 318) | A rota |
| `build-workflow.mjs` → `relatorio-rede-18h.json` | O workflow do n8n (edite o gerador, não o JSON) |
| [ANALISE-DAS-ROTAS.md](ANALISE-DAS-ROTAS.md) | Cada chamada, com custo e falhas |
| [EXEMPLO-DO-TEXTO.txt](EXEMPLO-DO-TEXTO.txt) | O texto completo, com dados fictícios |
