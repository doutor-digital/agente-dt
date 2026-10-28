import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KommoLead, KommoLeadCustomField, KommoPipeline } from '../../services/kommo.service.js';
import { montarContextoDoCartao } from './contexto.js';
import { montarPrompt, interpretarResposta } from './prompt.js';
import { responderAoCopiloto, type ChamarModelo } from './responder.js';
import { triarSugestoes } from './triagem.js';

const funis: KommoPipeline[] = [{ id: 1, name: 'COMERCIAL', statuses: [{ id: 10, name: 'EM QUALIFICAÇÃO' }, { id: 11, name: 'AGENDADO' }, { id: 12, name: 'Etapa estranha' }] }];
const defs: KommoLeadCustomField[] = [
  { id: 1, name: '★ Qualificação (Quente/Morno/Frio)', type: 'select', code: null, enums: [{ id: 1, value: 'Quente' }, { id: 2, value: 'Morno' }, { id: 3, value: 'Frio' }] },
];
function lead(statusId: number, campos: Array<[string, string]> = []): KommoLead {
  return {
    id: 99, name: 'Maria Souza', status_id: statusId, pipeline_id: 1,
    custom_fields_values: campos.map(([n, v], i) => ({ field_id: i + 1, field_name: n, values: [{ value: v }] })),
  };
}
const conversa = [{ quem: 'paciente' as const, texto: 'dor lombar desde segunda' }, { quem: 'clinica' as const, texto: 'temos amanhã às 10h' }];
const modelo = (obj: unknown): ChamarModelo => async () => ({ texto: typeof obj === 'string' ? obj : JSON.stringify(obj), promptTokens: 500, completionTokens: 80 });

test('o contexto lê só campos do dicionário e acha a etapa', () => {
  const c = montarContextoDoCartao(lead(10, [['✎ Queixa', 'dor lombar'], ['Campo Que Não É Do Padrão', 'x']]), funis, defs);
  assert.equal(c.etapa, 'EM QUALIFICAÇÃO');
  assert.equal(c.valores['✎ Queixa'], 'dor lombar');
  assert.equal(c.valores['◷ Data da Consulta'], null);
  assert.ok(!('Campo Que Não É Do Padrão' in c.valores));
  assert.deepEqual(c.opcoes['★ Qualificação (Quente/Morno/Frio)'], ['Quente', 'Morno', 'Frio']);
});

test('etapa desconhecida: o dicionário não conhece e o contexto diz isso', () => {
  assert.equal(montarContextoDoCartao(lead(12), funis, defs).etapa, null);
});

test('o prompt lista só campos da pessoa para sugerir e marca os que chegam sozinhos', () => {
  const ctx = montarContextoDoCartao(lead(10), funis, defs);
  const { system, user } = montarPrompt({ ctx, conversa, pergunta: 'quais campos preencho?' });
  assert.match(system, /Você NÃO grava nada/);
  assert.match(user, /Campos da pessoa nesta etapa/);
  assert.match(user, /✎ Queixa \| atual: \(vazio\)/);
  assert.match(user, /◷ Data da Consulta: chega sozinho/);
  assert.ok(!/utm_/.test(user), 'campo técnico não vai para o prompt');
});

test('interpretarResposta aguenta lixo, cerca de código e campo faltando', () => {
  assert.equal(interpretarResposta('isso não é json'), null);
  assert.equal(interpretarResposta('{"sugestoes": []}'), null);
  const r = interpretarResposta('```json\n{"resposta":"ok","sugestoes":[{"campo":"✎ Queixa","valor":"dor","porque":"conversa"},{"campo":"","valor":"x"},42]}\n```');
  assert.equal(r?.resposta, 'ok');
  assert.equal(r?.sugestoes.length, 1);
});

test('ADVERSARIAL: a IA sugere campo automático, técnico, inventado, já preenchido e fora da lista — nada disso passa', async () => {
  const ctx = montarContextoDoCartao(lead(10, [['✎ Queixa', 'dor cervical']]), funis, defs);
  const { saida } = await responderAoCopiloto(
    modelo({
      resposta: 'Preencha estes campos.',
      sugestoes: [
        { campo: '◷ Data da Consulta', valor: '29/10 10h', porque: 'está na conversa' },
        { campo: 'utm_source', valor: 'instagram', porque: 'anúncio' },
        { campo: 'Campo Inventado', valor: 'x', porque: '' },
        { campo: '✎ Queixa', valor: 'dor lombar', porque: 'conversa' },
        { campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'Fervendo', porque: '' },
        { campo: '¤ Valor pago / entrada', valor: '250', porque: '' },
      ],
    }),
    { ctx, conversa, pergunta: 'quais campos?' },
  );
  assert.equal(saida.sugestoes.length, 0, JSON.stringify(saida.sugestoes));
  assert.equal(saida.naoSugeri.length, 6);
  const motivo = (campo: string) => saida.naoSugeri.find((n) => n.campo === campo)?.motivo ?? '';
  assert.match(motivo('◷ Data da Consulta'), /chega sozinho/);
  assert.match(motivo('✎ Queixa'), /não sobrescrevo/);
  assert.match(motivo('★ Qualificação (Quente/Morno/Frio)'), /opção da lista/);
  assert.match(motivo('¤ Valor pago / entrada'), /GANHO/);
});

test('sugestões boas passam, e a IA repetindo o mesmo campo conta uma vez só', () => {
  const ctx = montarContextoDoCartao(lead(10), funis, defs);
  const { aceitas } = triarSugestoes(
    [
      { campo: '✎ Queixa', valor: 'dor lombar há 4 dias', porque: 'mensagem das 13h17' },
      { campo: '✎ queixa', valor: 'outra coisa', porque: '' },
      { campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'Quente', porque: 'aceitou o horário' },
    ],
    ctx,
  );
  assert.deepEqual(aceitas.map((a) => a.campo), ['✎ Queixa', '★ Qualificação (Quente/Morno/Frio)']);
});

test('modelo devolve lixo: resposta de desculpa, sem sugestão e sem quebrar', async () => {
  const ctx = montarContextoDoCartao(lead(10), funis, defs);
  const { saida } = await responderAoCopiloto(modelo('desculpe, não sei'), { ctx, conversa, pergunta: 'oi' });
  assert.match(saida.resposta, /Não consegui responder/);
  assert.equal(saida.sugestoes.length, 0);
});

test('etapa fora do padrão: avisa e não sugere nada', async () => {
  const ctx = montarContextoDoCartao(lead(12), funis, defs);
  const { saida } = await responderAoCopiloto(modelo({ resposta: 'ok', sugestoes: [{ campo: '✎ Queixa', valor: 'dor', porque: '' }] }), { ctx, conversa, pergunta: 'oi' });
  assert.equal(saida.sugestoes.length, 0);
  assert.match(saida.aviso ?? '', /não está no padrão/);
});

test('o uso de tokens volta para o registro de custo', async () => {
  const ctx = montarContextoDoCartao(lead(10), funis, defs);
  const { uso } = await responderAoCopiloto(modelo({ resposta: 'ok', sugestoes: [] }), { ctx, conversa, pergunta: 'oi' });
  assert.deepEqual(uso, { promptTokens: 500, completionTokens: 80 });
});

test('a IA responde pelo CÓDIGO do campo (C1…) e o nome certo é recuperado, mesmo que ela abrevie o nome', async () => {
  const ctx = montarContextoDoCartao(lead(10), funis, defs);
  const { codigos } = montarPrompt({ ctx, conversa, pergunta: 'x' });
  const codQualif = Object.entries(codigos).find(([, n]) => n.startsWith('★ Qualificação'))![0];
  const { saida } = await responderAoCopiloto(modelo({ resposta: 'ok', sugestoes: [{ campo: codQualif, valor: 'Quente', porque: 'aceitou o horário' }] }), { ctx, conversa, pergunta: 'quais campos?' });
  assert.deepEqual(saida.sugestoes.map((s) => s.campo), ['★ Qualificação (Quente/Morno/Frio)']);
});

test('o prompt lista todos os campos automáticos, para a IA poder explicar "origem chega sozinha"', () => {
  const ctx = montarContextoDoCartao(lead(10), funis, defs);
  const { user } = montarPrompt({ ctx, conversa, pergunta: 'x' });
  assert.match(user, /Campos que chegam sozinhos/);
  assert.match(user, /chega sozinho \(vem da agenda da franquia\)/);
});
