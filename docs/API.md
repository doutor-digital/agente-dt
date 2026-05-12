# Agente DT — API Reference

> Versão `0.1.0` · Base URL: `http://localhost:3001/api`

Backend de automação Kommo CRM. Recebe webhooks, decide ação via LangGraph + Claude, executa no Kommo e expõe traces de observabilidade para o dashboard.

---

## Sumário

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | [`/webhooks/kommo`](#post-webhookskommo) | Recebe evento do Kommo. ACK 200 imediato. |
| `GET`  | [`/traces`](#get-traces) | Lista execuções recentes (sidebar do dashboard). |
| `GET`  | [`/traces/{id}`](#get-tracesid) | Detalhe de uma execução + steps. |
| `GET`  | [`/stats`](#get-stats) | KPIs agregados (header do dashboard). |
| `GET`  | [`/health`](#get-health) | Health check. |

Autenticação: **nenhuma** no MVP. Rode atrás de VPN/Tailscale ou adicione middleware.

Content-Type: `application/json` para todos os endpoints. O webhook do Kommo também aceita `application/x-www-form-urlencoded`.

---

## `POST /webhooks/kommo`

Entrada principal do sistema. Disparado pelo Kommo a cada evento configurado (lead criado, etapa alterada, etc).

**Comportamento:**

1. Valida payload.
2. Cria um `ExecutionTrace` (status `RUNNING`).
3. Responde `200` em < 100 ms.
4. Dispara o agente em background (fire-and-forget).

> ⚠️ Kommo timeoutsa em 30 s. **Nunca** processe sincronamente aqui.

### Request — body (formato Kommo)

```json
{
  "leads": {
    "add":    [{ "id": 12345 }],
    "update": [{ "id": 12345 }],
    "status": [{ "id": 12345 }]
  }
}
```

### Request — body (formato de teste)

```json
{
  "leadId": 12345,
  "message": "Cliente disse que tem orçamento aprovado."
}
```

| Campo | Tipo | Obrig. | Descrição |
|---|---|---|---|
| `leadId` | `number` | sim¹ | ID do lead. |
| `message` | `string` | não | Mensagem que vai pro `HumanMessage` do grafo. |
| `leads.add[].id` | `number` | sim¹ | ID do lead (formato Kommo). |
| `leads.update[].id` | `number` | sim¹ | Idem. |

¹ Pelo menos um identificador de lead precisa estar presente.

### Response — `200 OK`

```json
{
  "ok": true,
  "traceId": "clx9k2a3b0001abcd"
}
```

### Response — `400`

```json
{ "ok": false, "error": "leadId not found in payload" }
```

### Exemplo

```bash
curl -X POST http://localhost:3001/api/webhooks/kommo \
  -H "Content-Type: application/json" \
  -d '{"leadId":12345,"message":"Tem orçamento aprovado, quer fechar essa semana"}'
```

---

## `GET /traces`

Lista as últimas execuções (sem os steps). Usado pela sidebar.

### Query params

| Param | Tipo | Default | Descrição |
|---|---|---|---|
| `limit` | `number` | `50` | Máx `200`. |

### Response — `200 OK`

```json
{
  "traces": [
    {
      "id": "clx9k2a3b0001abcd",
      "threadId": "lead-12345",
      "leadId": "12345",
      "status": "SUCCESS",
      "latencyMs": 2143,
      "createdAt": "2026-05-12T14:32:01.123Z",
      "iaDecision": "Apliquei tag Quente: orçamento aprovado + urgência."
    }
  ]
}
```

---

## `GET /traces/{id}`

Detalhe completo de uma execução, com todos os `steps` ordenados por `sequence`.

### Path params

| Param | Tipo | Descrição |
|---|---|---|
| `id` | `string` (cuid) | ID retornado em `POST /webhooks/kommo`. |

### Response — `200 OK`

```json
{
  "trace": {
    "id": "clx9k2a3b0001abcd",
    "threadId": "lead-12345",
    "leadId": "12345",
    "status": "SUCCESS",
    "latencyMs": 2143,
    "input":     { "leadId": 12345, "message": "..." },
    "iaDecision":"Apliquei tag Quente.",
    "errorMessage": null,
    "createdAt": "2026-05-12T14:32:01.123Z",
    "updatedAt": "2026-05-12T14:32:03.266Z",
    "steps": [
      {
        "id": "stp_01", "sequence": 1, "kind": "WEBHOOK_RECEIVED",
        "title": "Payload recebido do Kommo (Lead ID 12345)",
        "payload": { "leadId": 12345 }, "latencyMs": null,
        "createdAt": "2026-05-12T14:32:01.124Z"
      },
      {
        "id": "stp_02", "sequence": 2, "kind": "THINKING",
        "title": "IA analisando intenção (Claude)",
        "payload": { "model": "claude-opus-4-7" }, "latencyMs": 1820,
        "createdAt": "2026-05-12T14:32:02.944Z"
      },
      {
        "id": "stp_03", "sequence": 3, "kind": "TOOL_CALL",
        "title": "Decisão: aplicar tag \"Quente\" no lead 12345",
        "payload": { "leadId": 12345, "tag": "Quente" }, "latencyMs": null,
        "createdAt": "2026-05-12T14:32:02.945Z"
      },
      {
        "id": "stp_04", "sequence": 4, "kind": "KOMMO_ACTION",
        "title": "Tag \"Quente\" aplicada no Kommo",
        "payload": { "leadId": 12345, "tag": "Quente" }, "latencyMs": 312,
        "createdAt": "2026-05-12T14:32:03.257Z"
      },
      {
        "id": "stp_05", "sequence": 5, "kind": "COMPLETED",
        "title": "Execução concluída em 2143ms",
        "payload": null, "latencyMs": 2143,
        "createdAt": "2026-05-12T14:32:03.266Z"
      }
    ]
  }
}
```

### Response — `404`

```json
{ "error": "trace not found" }
```

---

## `GET /stats`

Métricas agregadas para o header do dashboard.

### Response — `200 OK`

```json
{
  "total": 184,
  "success": 171,
  "failed": 9,
  "running": 4,
  "successRate": 0.929,
  "avgLatencyMs": 1987
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `total` | `number` | Total de execuções no banco. |
| `success` / `failed` / `running` | `number` | Contagem por status. |
| `successRate` | `0..1` | Fração de sucesso sobre o total. |
| `avgLatencyMs` | `number` | Média (ms) considerando apenas `SUCCESS`. |

---

## `GET /health`

```json
{ "ok": true, "ts": "2026-05-12T14:32:00.000Z" }
```

---

# Modelos

## `ExecutionTrace`

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `string` (cuid) | PK. |
| `threadId` | `string` | `lead-{leadId}`. Chave da memória do LangGraph. |
| `leadId` | `string` | ID do lead Kommo. |
| `status` | [`TraceStatus`](#tracestatus) | Estado atual. |
| `latencyMs` | `number \| null` | Duração total. `null` enquanto `RUNNING`. |
| `input` | `Json` | Payload original do webhook. |
| `iaDecision` | `Json \| null` | Resposta textual final do agente. |
| `errorMessage` | `string \| null` | Preenchido se `FAILED`. |
| `createdAt`, `updatedAt` | `ISO 8601` | Timestamps. |

## `ExecutionStep`

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `string` (cuid) | PK. |
| `traceId` | `string` | FK → `ExecutionTrace`. |
| `sequence` | `number` | Ordem estável dentro do trace (1, 2, 3…). |
| `kind` | [`StepKind`](#stepkind) | Tipo do passo. |
| `title` | `string` | Texto exibido no feed do dashboard. |
| `payload` | `Json \| null` | Detalhe expansível. |
| `latencyMs` | `number \| null` | Duração desse passo. |
| `createdAt` | `ISO 8601` | Timestamp. |

---

# Enums

## `TraceStatus`

| Valor | Quando |
|---|---|
| `RUNNING` | Agente ainda processando. |
| `SUCCESS` | Concluído sem exceção. |
| `FAILED`  | Lançou erro não-tratado. |

## `StepKind`

| Kind | Ícone | Significado |
|---|---|---|
| `WEBHOOK_RECEIVED` | 📥 | Payload chegou. Primeiro step de todo trace. |
| `THINKING`         | 🧠 | LLM (Claude) raciocinando. |
| `TOOL_CALL`        | 🛠️ | LLM decidiu chamar uma tool. |
| `TOOL_RESULT`      | ↩️ | Tool respondeu (reservado — uso futuro). |
| `KOMMO_ACTION`     | ⚡ | Ação efetivada no Kommo (addTag / moveStage). |
| `COMPLETED`        | ✅ | Encerramento OK. |
| `ERROR`            | ❌ | Falha em algum nó. |

---

# Tools do agente

O grafo expõe duas tools que a LLM pode invocar:

### `aplicar_tag`

| Param | Tipo | Obrig. | Descrição |
|---|---|---|---|
| `leadId` | `number` | sim | ID do lead. |
| `tag` | `string` | sim | Nome da tag (`"Quente"`, `"Frio"`, …). |

Chama `KommoService.addTag()` → `PATCH /leads/{id}` com `_embedded.tags`.

### `mover_etapa`

| Param | Tipo | Obrig. | Descrição |
|---|---|---|---|
| `leadId` | `number` | sim | ID do lead. |
| `statusId` | `number` | sim | ID da etapa destino. |
| `pipelineId` | `number` | não | Pipeline destino (se mover entre funis). |

Chama `KommoService.moveStage()` → `PATCH /leads/{id}` com `status_id` (e `pipeline_id` opcional).

---

# Fluxo de execução

```
Kommo ──webhook──▶ POST /webhooks/kommo
                         │
                         ├─ valida + cria ExecutionTrace
                         ├─ ACK 200 (< 100ms)
                         └─ background ▼
                                       │
                  ┌──────── LangGraph (ReAct loop) ────────┐
                  │                                          │
                  ▼                                          │
              ┌───────┐  tool_calls?  ┌───────────────┐     │
   START ───▶ │ agent │ ────────────▶ │   tools       │ ────┘
              └───────┘  yes          │ (aplicar_tag, │
                  │ no                │  mover_etapa) │
                  ▼                   └───────────────┘
                 END                       │
                                           ▼
                                     Kommo API
```

Cada nó grava um `ExecutionStep`. PostgresSaver persiste o State a cada transição — `thread_id = lead-{leadId}` torna a conversa **contínua** entre webhooks do mesmo lead.

---

# Códigos de erro

| Status | Quando |
|---|---|
| `200` | Sucesso (inclui ACK do webhook). |
| `400` | Payload inválido / lead ID ausente. |
| `404` | Trace não encontrado em `GET /traces/{id}`. |
| `500` | Falha não-tratada do servidor. Veja logs (`pino`). |

Falhas do **agente** (erro do Claude, erro de rede com Kommo) não viram `500` — são gravadas como `ExecutionTrace.status = FAILED` com `errorMessage`. O webhook já recebeu `200`.

---

# Variáveis de ambiente

| Var | Obrig. | Default | Descrição |
|---|---|---|---|
| `DATABASE_URL` | sim | — | URL Postgres. |
| `KOMMO_SUBDOMAIN` | sim | — | `{subdomain}.kommo.com`. |
| `KOMMO_ACCESS_TOKEN` | sim | — | Long-Lived Access Token. |
| `ANTHROPIC_API_KEY` | sim | — | Chave Anthropic. |
| `ANTHROPIC_MODEL` | não | `claude-opus-4-7` | Modelo Claude. |
| `PORT` | não | `3001` | Porta HTTP. |
| `LOG_LEVEL` | não | `info` | `fatal`…`trace`. |
| `FRONTEND_ORIGIN` | não | `http://localhost:5173` | Origem permitida no CORS. |
| `NODE_ENV` | não | `development` | Ambiente. |

---

# Cheatsheet pnpm

```bash
pnpm install                 # instala tudo (workspace)
pnpm dev                     # backend + frontend em paralelo
pnpm dev:backend             # só backend
pnpm dev:frontend            # só frontend
pnpm prisma:migrate          # migrate dev
pnpm prisma:studio           # Prisma Studio
pnpm lint                    # tsc --noEmit em todos os pacotes
pnpm build                   # build de produção

# Adicionar dep só em um pacote
pnpm --filter agente-dt-backend add <pkg>
pnpm --filter agente-dt-frontend add <pkg>
```
