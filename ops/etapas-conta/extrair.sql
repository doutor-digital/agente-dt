-- O que a migração das etapas precisa ler do banco do Chatwoot: SÓ ids, etapas, etiquetas e a 1ª linha da nota da importação («Na Kommo: funil › etapa»).
-- Nada de nome, telefone ou texto de paciente. Uso: psql -At -v conta=3 -f extrair.sql  (uma linha de JSON na saída)
select json_build_object(
  'listasAntes', json_build_object(
    'etapa', (select attribute_values::json from custom_attribute_definitions where account_id = :conta and attribute_key = 'etapa' and attribute_model = 0 limit 1),
    'etapa_tratamento', (select attribute_values::json from custom_attribute_definitions where account_id = :conta and attribute_key = 'etapa_tratamento' and attribute_model = 0 limit 1)
  ),
  'conversas', (
    select coalesce(json_agg(json_build_object(
      'id', c.id,
      'etapa', c.custom_attributes->>'etapa',
      'etapa_tratamento', c.custom_attributes->>'etapa_tratamento',
      'funil', c.custom_attributes->>'funil',
      'etiquetas', (select coalesce(json_agg(t.name), '[]'::json) from taggings g join tags t on t.id = g.tag_id where g.taggable_type = 'Conversation' and g.taggable_id = c.id and g.context = 'labels'),
      'kommo', c.additional_attributes->>'kommo_lead_id',
      'nota', (select substring(m.content from 'Na Kommo: [^\n]*') from messages m where m.conversation_id = c.id and m.private and m.content like '%Na Kommo:%' order by m.id limit 1)
    ) order by c.id), '[]'::json)
    from conversations c where c.account_id = :conta
  ),
  'pastas', (select coalesce(json_agg(json_build_object('id', f.id, 'name', f.name, 'query', f.query) order by f.id), '[]'::json) from custom_filters f where f.account_id = :conta)
);
