-- Tabelas do rastreio de campanhas CTWA (WhatsApp -> Kommo).
--
-- Podem viver no banco do agente-dt ou em um schema/banco separado — o
-- workflow só precisa de uma credencial Postgres apontando para cá.
--
--   psql "$DATABASE_URL" -f schema.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- Eventos recebidos da Meta. Serve para DUAS coisas ao mesmo tempo:
--   1. auditoria do payload bruto;
--   2. deduplicação — `wamid` é UNIQUE, e o workflow usa
--      `ON CONFLICT ... RETURNING (xmax = 0)` para descobrir, na mesma escrita,
--      se o evento é novo ou uma reentrega da Meta.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ctwa_eventos (
  id                   bigserial primary key,
  wamid                text        not null unique,
  telefone             text,
  telefone_digits      text,
  waba_id              text,
  phone_number_id      text,
  ad_id                text,
  ctwa_clid            text,
  primeiro_contato_em  timestamptz,
  recebido_em          timestamptz not null default now(),
  repeticoes           integer     not null default 0,
  ultima_repeticao_em  timestamptz,
  payload              jsonb
);

create index if not exists ctwa_eventos_telefone_idx on ctwa_eventos (telefone_digits);
create index if not exists ctwa_eventos_recebido_idx on ctwa_eventos (recebido_em desc);
create index if not exists ctwa_eventos_ad_idx       on ctwa_eventos (ad_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Trilha de execução: um registro por decisão tomada pelo workflow.
--
-- status:
--   sucesso     campos gravados no lead
--   preservado  lead já tinha atribuição — nada foi sobrescrito
--   criado      lead criado pelo rastreio (KOMMO_CREATE_IF_MISSING=true)
--   duplicado   reentrega da Meta, ignorada
--   ignorado    mensagem sem referral de anúncio
--   orfao       nenhum lead encontrado depois do backoff — reconciliar depois
--   falha       erro de integração (Kommo/Graph/assinatura)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ctwa_logs (
  id                bigserial primary key,
  criado_em         timestamptz not null default now(),
  wamid             text,
  telefone          text,
  etapa             text not null,   -- assinatura | extracao | dedup | kommo
  status            text not null,
  kommo_lead_id     bigint,
  kommo_contact_id  bigint,
  detalhe           text,
  payload           jsonb
);

create index if not exists ctwa_logs_criado_idx on ctwa_logs (criado_em desc);
create index if not exists ctwa_logs_status_idx on ctwa_logs (status, criado_em desc);
create index if not exists ctwa_logs_wamid_idx  on ctwa_logs (wamid);

-- ─────────────────────────────────────────────────────────────────────────────
-- Consultas de operação
-- ─────────────────────────────────────────────────────────────────────────────

-- Saúde das últimas 24h.
--   select status, count(*) from ctwa_logs
--   where criado_em > now() - interval '24 hours' group by status order by 2 desc;

-- Órfãos a reconciliar (lead não existia quando o anúncio chegou).
--   select l.criado_em, l.telefone, l.payload->>'campanhaNome' as campanha, l.detalhe
--   from ctwa_logs l
--   where l.status = 'orfao' and l.criado_em > now() - interval '7 days'
--     and not exists (
--       select 1 from ctwa_logs s
--       where s.wamid = l.wamid and s.status in ('sucesso', 'criado')
--     )
--   order by l.criado_em desc;

-- Reentregas suspeitas (a Meta insistindo => algum 200 não está saindo a tempo).
--   select wamid, telefone, repeticoes, ultima_repeticao_em from ctwa_eventos
--   where repeticoes > 2 order by ultima_repeticao_em desc limit 50;
