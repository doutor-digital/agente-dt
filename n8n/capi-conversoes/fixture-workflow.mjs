// Workflow mínimo no molde dos 18 do n8n (mesmos nomes de nó e as âncoras de SQL que o aplicar-v3 espera).
export const CONFIG_V2 = `const cfg = {
  testEventCode: '',
  pipelineId: '13843399',
  janelaDias: 7,
  unidade: 'balsas',
  statusQualificacao: '106820287',
  // v2: cadeia de eventos por etapa (backfill) e etapas pré-agendamento onde Quente = Lead — gerado em 2026-09-08
  cadeia: {"142": ["quente", "agendado"]},
  preAgendado: ["106820083","106820287"],

};
return $input.all().map((item) => ({ json: { ...item.json, cfg, origem: 'relogio' } }));`;

const SQL_REENVIO = `SELECT 1 FROM capi_envios v
WHERE v.status = 'falhou'
  AND v.unidade = 'balsas'
  AND v.event_id ~ '^(msg|quente|agendado|compareceu|ganho)-'
  AND v.reservado_em > now() - interval '24 hours'`;

export function workflow(extra = {}) {
  const nos = {
    Config: { jsCode: CONFIG_V2 },
    'Classificar etapa': { jsCode: '// v2' },
    'Montar evento': { jsCode: '// v2' },
    'Buscar telefone e nome': { operation: 'executeQuery', query: 'SELECT 1', options: { queryReplacement: '={{ [1] }}' } },
    'Rehidratar evento': { jsCode: "const porId = new Map($('Montar evento').all().map((i) => [i.json.event_id, i.json]));\nconst saida = [];\nfor (const item of $input.all()) {\n  const evento = porId.get(item.json.event_id);\n  if (evento) saida.push({ json: evento });\n}\nreturn saida;" },
    'Reservar envio': { operation: 'executeQuery', query: 'INSERT ...' },
    'Cliques e reenvios': { operation: 'executeQuery', query: SQL_REENVIO },
    'Modo teste (nao chama a Meta)?': { conditions: { conditions: [{ leftValue: "={{ $('Config').first().json.cfg.dryRun }}" }] } },
  };
  for (const k of extra.semNo ?? []) delete nos[k];
  return {
    name: 'DD · CTWA → Meta CAPI · Conversões (Balsas)',
    nodes: Object.entries(nos).map(([name, parameters]) => ({ name, parameters })),
    connections: extra.semLigacao ? {} : { 'Rehidratar evento': { main: [[{ node: 'Modo teste (nao chama a Meta)?', type: 'main', index: 0 }]] } },
  };
}

