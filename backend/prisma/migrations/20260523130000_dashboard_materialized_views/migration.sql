-- Materialized views pro dashboard executivo.
--
-- PROBLEMA: dashboardHandler dispara ~18 queries em paralelo, várias delas
-- table-scans sobre messages/llm_calls/execution_traces. Em unidades com
-- volume já dá pra notar latência, e o custo cresce O(N×days).
--
-- ABORDAGEM: pré-agregar TUDO que é somável por dia em mv_unit_daily.
-- O handler lê SUM/AVG sobre uma janela de dias em vez de varrer as tabelas
-- de fatos. Canais ganham view separada porque mudam a granularidade.
--
-- O QUE FICA LIVE no handler (não cabe em agregado diário simples):
--   - uniqueLeads / weekendLeads (DISTINCT lead_id ao longo da janela)
--   - answeredConversations (NOT EXISTS sobre messages)
--   - unansweredQuestions (correlação NOT EXISTS dentro de 60min)
--   - handoffCount (joins execution_traces × execution_steps com title match)
--   - convsByHour / peakHour (precisa granularidade horária)
--   - funnel (vem da API do Kommo, não do banco)
--
-- REFRESH: cron in-process a cada 5min (REFRESH MATERIALIZED VIEW CONCURRENTLY).
-- CONCURRENTLY exige UNIQUE INDEX — declarado abaixo.
--
-- TRADEOFF: dados de "hoje" ficam stale até o próximo refresh (max 5min).
-- Aceitável pra dashboard executivo — usuários não esperam tempo real.

-- ---------------------------------------------------------------------------
-- mv_unit_daily — grain (unit_id, day). Cobre KPIs somáveis + série temporal.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW "mv_unit_daily" AS
WITH msg_daily AS (
  SELECT
    c."unit_id"                                             AS unit_id,
    DATE_TRUNC('day', m."created_at")::date                 AS day,
    COUNT(*)                                                AS msgs_total,
    COUNT(*) FILTER (WHERE m."role" = 'user')               AS msgs_user,
    COUNT(*) FILTER (WHERE m."role" = 'assistant')          AS msgs_assistant,
    COUNT(DISTINCT m."conversation_id")                     AS active_conversations
  FROM "messages" m
  JOIN "conversations" c ON c."id" = m."conversation_id"
  GROUP BY 1, 2
),
conv_created AS (
  SELECT
    "unit_id",
    DATE_TRUNC('day', "created_at")::date AS day,
    COUNT(*)                              AS new_conversations
  FROM "conversations"
  GROUP BY 1, 2
),
conv_converted AS (
  SELECT
    "unit_id",
    DATE_TRUNC('day', "converted_at")::date AS day,
    COUNT(*)                                AS converted_count
  FROM "conversations"
  WHERE "converted_at" IS NOT NULL
  GROUP BY 1, 2
),
llm_daily AS (
  SELECT
    "unit_id",
    DATE_TRUNC('day', "created_at")::date AS day,
    SUM("cost_usd")                       AS llm_cost_usd,
    COUNT(*)                              AS llm_calls_count,
    SUM("total_tokens")                   AS llm_tokens_total
  FROM "llm_calls"
  WHERE "unit_id" IS NOT NULL
  GROUP BY 1, 2
),
trace_daily AS (
  -- latency_sum_ms / latency_trace_count permitem média ponderada no read:
  -- AVG(latency) na janela = SUM(latency_sum_ms) / SUM(latency_trace_count).
  -- Filtra apenas SUCCESS com latency válida (espelha o handler atual).
  SELECT
    "unit_id",
    DATE_TRUNC('day', "created_at")::date AS day,
    COUNT(*)                              AS traces_total,
    SUM("latency_ms") FILTER (WHERE "status" = 'SUCCESS' AND "latency_ms" IS NOT NULL) AS latency_sum_ms,
    COUNT(*)          FILTER (WHERE "status" = 'SUCCESS' AND "latency_ms" IS NOT NULL) AS latency_trace_count
  FROM "execution_traces"
  WHERE "unit_id" IS NOT NULL
  GROUP BY 1, 2
),
all_keys AS (
  SELECT unit_id, day FROM msg_daily
  UNION SELECT unit_id, day FROM conv_created
  UNION SELECT unit_id, day FROM conv_converted
  UNION SELECT unit_id, day FROM llm_daily
  UNION SELECT unit_id, day FROM trace_daily
)
SELECT
  k.unit_id,
  k.day,
  COALESCE(m.msgs_total,             0)::bigint              AS msgs_total,
  COALESCE(m.msgs_user,              0)::bigint              AS msgs_user,
  COALESCE(m.msgs_assistant,         0)::bigint              AS msgs_assistant,
  COALESCE(m.active_conversations,   0)::bigint              AS active_conversations,
  COALESCE(cn.new_conversations,     0)::bigint              AS new_conversations,
  COALESCE(cc.converted_count,       0)::bigint              AS converted_count,
  COALESCE(ll.llm_cost_usd,          0)::numeric(14, 6)      AS llm_cost_usd,
  COALESCE(ll.llm_calls_count,       0)::bigint              AS llm_calls_count,
  COALESCE(ll.llm_tokens_total,      0)::bigint              AS llm_tokens_total,
  COALESCE(tr.traces_total,          0)::bigint              AS traces_total,
  COALESCE(tr.latency_sum_ms,        0)::bigint              AS latency_sum_ms,
  COALESCE(tr.latency_trace_count,   0)::bigint              AS latency_trace_count
FROM all_keys k
LEFT JOIN msg_daily      m  USING (unit_id, day)
LEFT JOIN conv_created   cn USING (unit_id, day)
LEFT JOIN conv_converted cc USING (unit_id, day)
LEFT JOIN llm_daily      ll USING (unit_id, day)
LEFT JOIN trace_daily    tr USING (unit_id, day);

-- UNIQUE INDEX é REQUISITO pra REFRESH MATERIALIZED VIEW CONCURRENTLY.
-- Também serve como índice de leitura — filtro por (unit_id, day) é o
-- access path principal do handler.
CREATE UNIQUE INDEX "mv_unit_daily_pk" ON "mv_unit_daily" (unit_id, day);

-- ---------------------------------------------------------------------------
-- mv_unit_daily_channel — grain (unit_id, day, channel). Breakdown por canal.
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW "mv_unit_daily_channel" AS
SELECT
  c."unit_id"                                            AS unit_id,
  DATE_TRUNC('day', m."created_at")::date                AS day,
  COALESCE(NULLIF(c."channel", ''), 'unknown')           AS channel,
  COUNT(*)                                               AS msgs_total,
  COUNT(*) FILTER (WHERE m."role" = 'user')              AS msgs_user
FROM "messages" m
JOIN "conversations" c ON c."id" = m."conversation_id"
GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX "mv_unit_daily_channel_pk"
  ON "mv_unit_daily_channel" (unit_id, day, channel);
