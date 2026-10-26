-- Devolve o evento classificado + o clique do cartão (telefone, nome, hora, clid).
--
-- v3 (26/10/2026). Tudo sai numa linha só — um SELECT com subconsultas escalares devolve SEMPRE exatamente uma
-- linha por item de entrada, mesmo quando não acha nada; isso mantém o alinhamento com a entrada sem reparear
-- por índice depois (que é o que embaralha evento de um lead com o clique de outro).
--
-- Parâmetros: $1 event_name, $2 event_id, $3 event_time, $4 ctwa_clid do CARTÃO, $5 kommo_lead_id,
--             $6 pipeline_id, $7 valor, $8 unidade (cfg.unidade), $9 via, $10 _seco
--
-- Duas fontes para achar o clique, nesta ordem:
--  1) o ctwa_clid que o cartão carrega (o caminho de sempre);
--  2) só se o cartão NÃO tem clid: o clique que o fluxo de Rastreio já amarrou a ESTE cartão
--     (ctwa_logs.kommo_lead_id, gravado quando o Rastreio escreveu nele — não é busca por telefone, não adivinha
--     de quem é). Cobre dois buracos medidos em 8 semanas: o anúncio de Status (clique sem clid) e o cartão que
--     não recebeu o clid que existe (37 Lead perdidos).
--     Se o cartão teve mais de um clique, vale o MAIS RECENTE com clid; sem nenhum com clid, o mais recente.
WITH direto AS (
  SELECT e.ctwa_clid, e.telefone, e.primeiro_contato_em, e.payload
    FROM ctwa_eventos e
   WHERE NULLIF($4, '') IS NOT NULL AND e.ctwa_clid = $4
   ORDER BY e.primeiro_contato_em
   LIMIT 1
), do_cartao AS (
  SELECT e.ctwa_clid, e.telefone, e.primeiro_contato_em, e.payload
    FROM ctwa_logs l
    JOIN ctwa_eventos e ON e.wamid = l.wamid
   WHERE NULLIF($4, '') IS NULL
     AND NULLIF($5, '') IS NOT NULL
     AND l.kommo_lead_id = NULLIF($5, '')::bigint
     AND l.unidade = $8
     AND l.etapa = 'kommo' AND l.status = 'sucesso'
   ORDER BY (e.ctwa_clid IS NOT NULL) DESC, e.primeiro_contato_em DESC
   LIMIT 1
), clique AS (
  SELECT * FROM direto
  UNION ALL
  SELECT * FROM do_cartao
  LIMIT 1
)
SELECT $1::text    AS event_name,
       $2::text    AS event_id,
       $3::bigint  AS event_time,
       COALESCE(NULLIF($4, ''), (SELECT ctwa_clid FROM clique))                    AS ctwa_clid,
       $5::text    AS kommo_lead_id,
       $6::text    AS pipeline_id,
       $7::numeric AS valor,
       $9::text    AS via,
       ($10::text = 'true') AS _seco,
       NULL::text  AS wamid,
       (SELECT telefone FROM clique)                                               AS telefone,
       (SELECT payload #>> '{contacts,0,profile,name}' FROM clique)                AS nome,
       (SELECT extract(epoch FROM primeiro_contato_em)::bigint FROM clique)        AS clique_em,
       EXISTS (SELECT 1 FROM clique)                                               AS clique_encontrado;
