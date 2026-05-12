# Agente DT — Kommo Automation MVP

Automação inteligente para o CRM **Kommo** com **LangGraph.js + Claude (Anthropic)**, persistência em **PostgreSQL (Prisma)** e dashboard **React + Tailwind** estilo **AgentGPT Terminal**.

```
┌──────────┐  webhook   ┌──────────────┐  invoke   ┌──────────────┐  HTTP   ┌─────────┐
│  Kommo   ├───────────►│  Express API ├──────────►│  LangGraph   ├────────►│  Kommo  │
└──────────┘  (ACK 200) └──────┬───────┘  thread   │  ReAct loop  │  tools  │   API   │
                               │                   └──────┬───────┘         └─────────┘
                               │ trace + steps            │ checkpoint
                               ▼                          ▼
                        ┌──────────────────────────────────────┐
                        │  Postgres  (Prisma + PostgresSaver)  │
                        └──────────────┬───────────────────────┘
                                       │  REST /api/traces
                                       ▼
                              ┌─────────────────┐
                              │  React Dashboard│  "AgentGPT Terminal"
                              └─────────────────┘
```

## Arquitetura

```
agente-dt/
├── backend/
│   ├── prisma/schema.prisma         # ExecutionTrace + ExecutionStep + tabelas do PostgresSaver
│   └── src/
│       ├── services/
│       │   └── kommo.service.ts     # HTTP puro (axios) — addTag, moveStage, getLead
│       ├── agent/
│       │   ├── state.ts             # Annotation do State do LangGraph
│       │   ├── tools.ts             # Tools com schema Zod
│       │   ├── graph.ts             # StateGraph + PostgresSaver
│       │   └── trace-recorder.ts    # Adapter para persistir steps no Postgres
│       ├── controllers/
│       │   ├── webhook.controller.ts # ACK 200 imediato + agente em background
│       │   └── traces.controller.ts  # API consumida pelo dashboard
│       ├── routes/api.routes.ts
│       ├── lib/{env,logger,prisma}.ts
│       └── server.ts
└── frontend/
    └── src/
        ├── App.tsx
        ├── components/
        │   ├── Sidebar.tsx          # histórico de webhooks
        │   ├── StatsHeader.tsx      # KPIs (latência média, taxa de sucesso)
        │   ├── ExecutionTrace.tsx   # console principal — feed do raciocínio
        │   └── TraceStep.tsx        # 1 step do feed (ícone + título + payload)
        ├── hooks/usePolling.ts
        ├── lib/api.ts
        └── types/api.ts
```

### Separação de responsabilidades

| Camada | Responsabilidade | NÃO conhece |
|---|---|---|
| `services/kommo.service.ts` | HTTP com Kommo | LangGraph, Prisma |
| `agent/` | Decisão da IA + execução do grafo | Express, Prisma direto |
| `controllers/` | Borda HTTP — ACK + dispatch | Modelo, prompt |
| `prisma/` | Persistência | Lógica de negócio |
| `frontend/` | Visualização | Backend interno |

---

## Stack & versões

| Camada | Tecnologia | Versão |
|---|---|---|
| Runtime | Node.js | 22+ (testado em 24) |
| Backend | TypeScript, Express 5, LangGraph.js, Prisma 6 | Latest 2026 |
| LLM | Anthropic Claude Opus 4.7 | `claude-opus-4-7` |
| Checkpointer | `@langchain/langgraph-checkpoint-postgres` | 0.1 |
| Frontend | React 19, Vite 7, Tailwind CSS v4 | Latest |
| UI | Lucide React, Framer Motion | Latest |
| DB | PostgreSQL | 15+ |

---

## Setup

### 1. Pré-requisitos

- Node.js ≥ 22
- **pnpm ≥ 9** (`npm i -g pnpm` ou `corepack enable && corepack prepare pnpm@latest --activate`)
- PostgreSQL ≥ 15 (local ou Docker)
- Conta Kommo com **Long-Lived Access Token** ([docs](https://developers.kommo.com/docs/long-lived-access-token))
- API Key Anthropic ([console.anthropic.com](https://console.anthropic.com))

### 2. Banco de dados

Suba um Postgres local (exemplo Docker):

```bash
docker run --name agente-dt-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
docker exec -it agente-dt-pg psql -U postgres -c "CREATE DATABASE agente_dt;"
```

### 3. Instalar (workspace pnpm)

A partir da raiz do projeto, **uma única instalação** cobre backend e frontend:

```bash
pnpm install
```

O `postinstall` do backend roda `prisma generate` automaticamente.

### 4. Configurar `.env` do backend

```bash
cp backend/.env.example backend/.env   # preencha KOMMO_*, ANTHROPIC_API_KEY, DATABASE_URL
```

### 5. Migrar o banco

```bash
pnpm prisma:migrate              # alias para o backend
# ou diretamente:
pnpm --filter agente-dt-backend run prisma:migrate
```

> **Importante:** as tabelas do `PostgresSaver` (`checkpoints`, `checkpoint_writes`, `checkpoint_blobs`) são criadas automaticamente no boot pelo `checkpointer.setup()`. Não rode `migrate` para elas — o LangGraph é dono.

### 6. Subir em dev (backend + frontend em paralelo)

```bash
pnpm dev
```

- Backend: `http://localhost:3001`
- Dashboard: `http://localhost:5173` (Vite proxia `/api` → `:3001`)

Se preferir rodar separadamente:

```bash
pnpm dev:backend     # só backend
pnpm dev:frontend    # só frontend
```

### Scripts do workspace

| Comando | O que faz |
|---|---|
| `pnpm install` | Instala todas as deps (backend + frontend) com store compartilhado |
| `pnpm dev` | Roda backend e frontend em paralelo (`pnpm -r --parallel run dev`) |
| `pnpm build` | Build de todos os pacotes |
| `pnpm lint` | Type-check (`tsc --noEmit`) em todos os pacotes |
| `pnpm prisma:migrate` | `prisma migrate dev` no backend |
| `pnpm prisma:studio` | Abre Prisma Studio |
| `pnpm --filter agente-dt-backend add <pkg>` | Adiciona dep só ao backend |
| `pnpm --filter agente-dt-frontend add <pkg>` | Adiciona dep só ao frontend |

---

## Testando o webhook

Sem precisar de Kommo configurado, dispare um webhook de teste:

```bash
curl -X POST http://localhost:3001/api/webhooks/kommo \
  -H "Content-Type: application/json" \
  -d '{"leadId": 12345, "message": "Cliente disse que tem orçamento aprovado e quer fechar essa semana."}'
```

Resposta imediata:

```json
{ "ok": true, "traceId": "clxxx..." }
```

Abra o dashboard — você verá a execução aparecer na sidebar e o **Console de Raciocínio** ir preenchendo os steps em tempo real (📥 → 🧠 → 🛠️ → ⚡ → ✅).

---

## Configurando o webhook real no Kommo

1. No painel do Kommo: **Configurações → Integrações → Webhooks**.
2. URL: `https://seu-dominio.com/api/webhooks/kommo` (use ngrok em dev).
3. Eventos: `Lead criado`, `Lead atualizado`, ou outros relevantes.
4. Salve.

A Kommo passa a postar `application/x-www-form-urlencoded` — o backend já está preparado.

---

## Lógica de engenharia — destaques

### Como o State transita no LangGraph (`backend/src/agent/graph.ts`)

```
START
  ↓ (input: leadId, messages=[HumanMessage])
agent (node)              ← chama Claude com tools bound
  ↓
shouldContinue? ─── tool_calls? ──► tools (node) ──► agent (loop ReAct)
  ↓ texto puro
END
```

Cada transição grava um checkpoint no Postgres com o State serializado. O `thread_id` = `lead-{leadId}` faz a conversa ser **contínua entre webhooks** — o agente lembra do que respondeu da última vez.

### ACK rápido (`backend/src/controllers/webhook.controller.ts`)

A Kommo timeoutsa em 30s. Padrão:

1. Valida payload (Zod).
2. Cria `ExecutionTrace` (status `RUNNING`).
3. **`res.status(200).json(...)`** — devolve em < 100ms.
4. `void processAgent(...).catch(...)` — agente roda em background.

### Observabilidade (`backend/src/agent/trace-recorder.ts`)

Cada nó/tool grava um `ExecutionStep` no Postgres com `kind`, `title`, `payload` e `latencyMs`. O frontend faz polling e renderiza esses steps como o feed animado tipo AgentGPT.

---

## Roadmap pós-MVP

- [ ] Substituir polling por SSE / WebSocket para o detalhe do trace
- [ ] Deduplicação de webhooks por `X-Webhook-Id`
- [ ] Tool `consultar_lead` que enriquece o contexto antes da decisão
- [ ] Rate limit por IP no endpoint público
- [ ] Auth do dashboard (atualmente público — só rode atrás de VPN)
- [ ] Replay de trace (re-executar do checkpoint)
- [ ] Métricas Prometheus em `/metrics`

---

## Licença

Privado — uso interno DT.
