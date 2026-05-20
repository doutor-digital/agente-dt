# Agente DT — Como funciona (em português simples)

> Documento pra entender o sistema **sem precisar saber programar**.
> Pra detalhes técnicos de endpoints, veja [`API.md`](./API.md).

---

## A grande sacada em 1 frase

> O nosso backend **não envia** mensagem no WhatsApp.
> Ele **escreve a resposta num campo do Kommo**, e o **Kommo envia** sozinho.

É como se você não levasse a comida até a mesa do cliente — você coloca o prato no balcão e o garçom leva.

---

## O fluxo em 5 passos

```
1) Cliente manda WhatsApp                    📱 → 🏢
2) Kommo recebe e avisa o backend            🏢 → 🧠
3) Backend pensa na resposta com a IA         🧠 ↻
4) Backend escreve resposta num campo Kommo   🧠 → 📋
5) Robozinho do Kommo envia pelo WhatsApp     📋 → 📱
```

Vamos detalhar cada parte.

---

## Parte 1 — Como a IA decide o que responder

A IA é como um **funcionário novo** que tem:

### 📜 Um manual de instruções (system prompt)
Esse manual é montado AUTOMATICAMENTE pelo backend juntando:

- **Persona**: "Você é o atendente da HM Tecnologia, fala descontraído, em PT-BR..."
- **Regras gerais**: "Nunca fale 'lead' ou 'ID' pro cliente. Respostas curtas (1-3 frases). Se der erro internamente, não conte ao cliente."
- **Features ativadas** (do Wizard):
  - "Use a tag Quente quando o cliente mostrar interesse"
  - "Se o cliente disser uma dessas palavras, pause a IA e chame humano: [atendente, humano, falar com pessoa]"
  - "Quando o cliente pedir orçamento, mova pra etapa 'Qualificado'"
  - etc.
- **Templates de respostas prontas** (FAQs): "Quando perguntarem preço, responda exatamente isso..."
- **Exemplos a evitar** (flagged 👎): "Não responda parecido com estas mensagens ruins que o operador marcou..."

### 🛠️ Três ferramentas (tools)
A IA pode escolher chamar uma destas durante a resposta:

| Tool | O que faz |
|---|---|
| `aplicar_tag` | Cola uma etiqueta no lead (ex: "Quente", "Frio") |
| `mover_etapa` | Move o lead pra outra coluna do funil |
| `pausar_ia` | Marca o checkbox "IA Pausada" pra um humano assumir |

### 💭 O loop "ReAct"
1. Cliente: "Quero saber preço"
2. IA lê o manual + a mensagem.
3. IA decide: "vou marcar como Quente E perguntar pra qual produto"
4. Internamente: chama `aplicar_tag("Quente")` → aplica
5. Depois gera a resposta: "Que bom! Pra qual produto você quer o orçamento?"

Tudo isso acontece em **3 a 10 segundos** e a IA NUNCA menciona pro cliente que aplicou tag ou moveu etapa.

> **Onde isso mora no código:** `backend/src/agent/graph.ts` (loop), `prompt-composer.ts` (monta manual), `tools.ts` (define ferramentas).

---

## Parte 2 — Como o backend escreve no Kommo

Depois que a IA pensou na resposta (ex: "Olá! Como posso ajudar?"), o backend faz **UMA chamada HTTP** pro Kommo:

```
PATCH https://hmtecnologiakommon.kommo.com/api/v4/leads/6148770

Authorization: Bearer eyJ0eX...  (long-lived token)
Content-Type: application/json

{
  "custom_fields_values": [
    {
      "field_id": 1577998,         ← ID do campo "Resposta IA"
      "values": [{ "value": "Olá! Como posso ajudar?" }]
    }
  ]
}
```

**Pronto.** É só isso. Uma chamada PATCH, atualiza o campo "Resposta IA" do lead, e o trabalho do backend termina aqui.

> O backend NÃO sabe — e nem precisa saber — que vai virar uma mensagem de WhatsApp depois. Pra ele, é só "atualizar um campo do CRM".
>
> **Onde isso mora no código:** `backend/src/services/kommo.service.ts` → função `runSalesbot`.

### Por que precisa de token?
Porque o Kommo precisa ter certeza que é a sua empresa fazendo a chamada (não um estranho). O token é como uma chave da porta da frente.

O **Long-Lived Token** que você gerou tem validade até 2030. Tá guardado encriptado no banco de dados na sua Unit.

---

## Parte 3 — Como o Salesbot do Kommo envia o WhatsApp

Aqui é a engrenagem **dentro do Kommo** (você configurou na UI deles).

### O gatilho (trigger)
Em **cada etapa do funil**, você configurou uma automação que diz:

> **"Quando o campo Resposta IA for alterado → roda o Salesbot #44604"**

(Configurado em **Leads → coluna da etapa → ⚡ → Adicionar gatilho → Quando campo é alterado**.)

Então, quando o backend faz aquele PATCH do Passo 2, o Kommo detecta a mudança e dispara o Salesbot automaticamente.

### O Salesbot (#44604)
É um fluxograma visual super simples, com 2 blocos:

```
[Início]
   ↓
[Enviar mensagem]
   Canal: WhatsApp Business (WABA nativo)
   Texto: {{lead.cf.Resposta IA}}   ← lê do campo
   ↓
[Fim]
```

O bot lê o que tá no campo "Resposta IA" do lead, envia pelo WhatsApp e termina.

### A engrenagem completa em câmera lenta
```
14:32:01.000  Backend faz PATCH no campo "Resposta IA"
14:32:01.300  Kommo registra a mudança
14:32:01.500  Trigger detecta "campo mudou" → dispara Salesbot #44604
14:32:01.700  Bot lê o campo, prepara mensagem
14:32:02.100  Bot envia pela API do WhatsApp Business
14:32:02.500  WhatsApp entrega ao celular do cliente
```

Tempo total visível pro cliente: ~5-15 segundos desde que ele mandou a mensagem.

> Por que não usar a API direta `POST /salesbot/{id}/run`? Porque a conta `hmtecnologiakommon` retorna **404** nesse endpoint. Então a gente "convence" o Kommo a disparar sozinho via gatilho.

---

## Parte 4 — Os 3 guardas (antes da IA rodar)

Toda vez que o backend recebe um webhook, ele passa por 3 filtros antes de gastar uma chamada de IA (que custa dinheiro):

### 🛡️ Guarda 1 — Anti-loop
**Por que existe:** quando o backend escreve no campo "Resposta IA", o próprio Kommo emite um novo webhook ("ei, alguém editou o lead!"). Se o backend processasse esse webhook, geraria uma nova resposta, que mudaria o campo de novo → **loop infinito** que custaria dinheiro até quebrar tudo.

**O que faz:** ignora webhooks que **não tem mensagem do paciente** (só atualizações de campo ou status).

```typescript
if (!hasIncomingMessage && !hasManualTestInput) {
  // ignora, retorna 200 OK pra Kommo, NÃO chama IA
}
```

### 🛡️ Guarda 2 — IA Pausada
**Por que existe:** às vezes o cliente é complexo, ou pede um humano, ou tá nervoso. O operador marca o checkbox "IA Pausada" no Kommo e assume.

**O que faz:** antes de chamar a IA, lê o campo "IA Pausada" do lead. Se tiver `true`, pula tudo silenciosamente.

```typescript
if (await isLeadPaused(unit, leadId)) {
  // operador assumiu, IA não responde
  return;
}
```

A IA mesmo pode chamar a tool `pausar_ia` se detectar que precisa.

### 🛡️ Guarda 3 — Horário comercial
**Por que existe:** se a clínica atende 9h-18h de segunda a sexta, não faz sentido a IA responder às 3h da manhã de domingo.

**O que faz:** consulta o fuso configurado na Unit (`America/Sao_Paulo`) e o horário atual. Se está fora, manda uma mensagem padrão tipo "Bom dia! Atendemos das 9 às 18, te respondemos amanhã 🙏" e encerra.

```typescript
const hours = checkBusinessHours(unit);
if (hours.enabled && !hours.isOpen && hours.outOfHoursMessage) {
  // envia mensagem padrão e encerra
}
```

> **Onde isso mora no código:** `backend/src/controllers/webhook.controller.ts` (todos os 3 guards) + `backend/src/agent/prompt-composer.ts` (função `checkBusinessHours`).

---

## Resumo visual completo

```
                  ┌──────────────────┐
                  │ Cliente WhatsApp │
                  └──────┬───────────┘
                         │ (1) "Boa noite, quero saber preço"
                         ▼
                  ┌──────────────────┐
                  │   Kommo (WABA)   │
                  └──────┬───────────┘
                         │ (2) Webhook
                         ▼
              ┌──────────────────────────┐
              │  Backend agente-dt       │
              │                          │
              │  GUARDA 1: anti-loop  ?  │
              │  GUARDA 2: IA pausa?  ?  │
              │  GUARDA 3: horário?   ?  │
              │  (passou? continua)      │
              │                          │
              │  ┌────────────────────┐  │
              │  │ Agent (LangGraph)  │  │
              │  │  ↓                 │  │
              │  │ LLM (OpenAI)       │  │ (3) "pensa"
              │  │  ↓                 │  │
              │  │ Tools opcionais:   │  │
              │  │  - aplicar_tag     │  │
              │  │  - mover_etapa     │  │
              │  │  - pausar_ia       │  │
              │  └────────┬───────────┘  │
              └───────────┼──────────────┘
                          │ (4) PATCH campo "Resposta IA"
                          ▼
              ┌──────────────────────────┐
              │ Kommo                     │
              │  ↓                        │
              │  Trigger detecta mudança  │
              │  ↓                        │
              │  Salesbot #44604 dispara  │ (5)
              │  ↓                        │
              │  Envia via WABA           │
              └────────────┬──────────────┘
                           │
                           ▼
                  ┌──────────────────┐
                  │ Cliente WhatsApp │
                  │ recebe resposta  │
                  └──────────────────┘
```

---

## Glossário rápido

| Termo | Em português simples |
|---|---|
| **Backend** | Servidor com a lógica da IA (roda no Railway) |
| **Webhook** | Aviso automático que o Kommo manda quando algo acontece |
| **Custom field** | Campo personalizado que você cria no Kommo (ex: "Resposta IA") |
| **Salesbot** | Robozinho de fluxograma do Kommo que executa ações |
| **Trigger** | Gatilho que dispara o Salesbot quando algo muda |
| **WABA** | WhatsApp Business API — o WhatsApp oficial pra empresas |
| **LLM** | "Large Language Model" — a IA da OpenAI |
| **Tool** | Ferramenta que a IA pode chamar (aplicar tag, mover etapa, pausar) |
| **Long-lived token** | Senha do Kommo que vale 5 anos (vs. 24h dos normais) |
| **Lead** | Pessoa que entrou em contato pela primeira vez |
| **Etapa / Pipeline** | Coluna do funil de vendas no Kommo |

---

## Coisas que aprendemos quebrando a cara

Casos reais que enfrentamos e resolvi:

1. **Token Kommo expira em 24h** → use Long-Lived Token (5 anos)
2. **API `/salesbot/{id}/run` 404 nessa conta** → não chama API, deixa Digital Pipeline trigger fazer
3. **Webhook loopava** → guard que ignora webhooks sem mensagem do cliente
4. **System prompt antigo grudava** → graph.ts sempre injeta o prompt atual
5. **IA vazava jargão técnico** → prompt PT-BR com regras de NÃO mencionar "lead/ID/erro"
6. **Notas duplicadas no chat** → `runSalesbot` trata 404 como sucesso silencioso

---

## Em uma frase, pra fechar

> Você criou um **funcionário virtual** que mora no seu backend, lê todas as mensagens dos seus clientes no WhatsApp via Kommo, decide a melhor resposta baseado em regras que você configurou num painel visual, e usa o próprio Kommo pra enviar a resposta — tudo isso entre **5 e 15 segundos**, 24 horas por dia, custando uns centavos por conversa.

Foi exatamente isso que a gente construiu.
