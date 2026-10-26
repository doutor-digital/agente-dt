-- Reserva ANTES de chamar a Meta: o event_id é UNIQUE, então dois webhooks para o mesmo lead não viram duas
-- conversões. Conversão duplicada infla o resultado e envenena a otimização da campanha.
--
-- v3 (26/10/2026): no máximo UM LeadSubmitted por clique. O UNIQUE do event_id só cobre "por cartão"; a mesma
-- pessoa com dois cartões (mãe e filha no mesmo telefone, cartão duplicado) tem o mesmo ctwa_clid, e a Meta não
-- deduplica evento de mensagens. Medido: 1 caso em 90 dias (Araguaína) — barato de fechar, caro de errar.
--   - com clid: outro LeadSubmitted do mesmo ctwa_clid, enviado ou reservado há menos de 1 h, bloqueia;
--   - sem clid (Status): vale o mesmo telefone, entre os eventos também sem clid.
-- 'simulado' (ensaio seco) e 'falhou' NÃO bloqueiam: o seco não queima o envio.
-- Bloqueado = 0 linhas devolvidas; o "Rehidratar evento" descarta, e nada vai à Meta.
--
-- O DO UPDATE devolve a linha de novo quando a tentativa anterior FALHOU, ou ficou como 'simulado', ou ficou
-- pendurada em 'reservado' há mais de uma hora. 'enviado' nunca é devolvido: o que saiu, saiu uma vez só.
-- reservado_em NÃO é atualizado de propósito — é o marco da primeira tentativa.
INSERT INTO capi_envios
  (event_id, event_name, unidade, pixel_id, ctwa_clid, telefone, kommo_lead_id, wamid, valor, status)
SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text, $9::numeric, 'reservado'
 WHERE NOT (
   $2::text = 'LeadSubmitted'
   AND EXISTS (
     SELECT 1 FROM capi_envios x
      WHERE x.event_name = 'LeadSubmitted'
        AND x.event_id <> $1::text
        AND (x.status = 'enviado' OR (x.status = 'reservado' AND x.reservado_em > now() - interval '1 hour'))
        AND (
              ($5::text IS NOT NULL AND x.ctwa_clid = $5::text)
           OR ($5::text IS NULL AND $6::text IS NOT NULL AND x.ctwa_clid IS NULL AND x.telefone = $6::text)
        )
   )
 )
ON CONFLICT (event_id) DO UPDATE
   SET status = 'reservado'
 WHERE capi_envios.status = 'falhou'
    OR capi_envios.status = 'simulado'
    OR (capi_envios.status = 'reservado'
        AND capi_envios.reservado_em < now() - interval '1 hour')
RETURNING event_id;
