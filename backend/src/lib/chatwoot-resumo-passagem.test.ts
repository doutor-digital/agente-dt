/**
 * O «Resumo» da nota de passagem para a equipe: só o que a conversa JÁ diz (atributos) ou o que o paciente escreveu (trechos e palavras-chave).
 * Sem IA, sem inventar; sem nada confiável, sem resumo — e a nota fica exatamente como era.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumoDaPassagem } from './chatwoot-resumo-passagem.js';
import { passarParaEquipeNoChatwoot, type PortaDoChatwoot } from './chatwoot-sofia.js';

const u = (content: string) => ({ role: 'user' as const, content });
const s = (content: string) => ({ role: 'assistant' as const, content });

test('resumo de uma linha: queixa, dia/período, preço e a última fala — tudo vindo do que o paciente escreveu', () => {
  const r = resumoDaPassagem({
    falas: [u('Oi, tenho dor na lombar há 2 meses'), s('Entendi! Quer ver horários?'), u('qual o valor? pode ser quinta à tarde'), s('Posso sim'), u('quero falar com uma pessoa')],
  });
  assert.equal(r, 'Resumo: dor na lombar há 2 meses · mencionou quinta, à tarde · perguntou preço · última fala: «quero falar com uma pessoa»');
});

test('atributos da conversa entram como estão (consulta e qualificação); «faz 3 semanas» vira «há 3 semanas»', () => {
  const r = resumoDaPassagem({
    attrs: { data_consulta: '2026-11-27', hora_consulta: '09:30', situacao_consulta: 'Agendado', qualificacao: 'Quente' },
    falas: [u('dor de cabeça faz 3 semanas')],
  });
  assert.equal(r, 'Resumo: dor de cabeça há 3 semanas · consulta agendado 27/11 às 09:30 · qualificação Quente · última fala: «dor de cabeça faz 3 semanas»');
});

test('não inventa: sem dor, sem dia, sem preço no que o paciente disse, nada disso aparece; fala do assistente não conta', () => {
  const r = resumoDaPassagem({ falas: [s('A consulta custa R$ 350, quinta à tarde tem vaga. Tem dor na coluna?'), u('ok, obrigado')] });
  assert.equal(r, 'Resumo: última fala: «ok, obrigado»');
  assert.equal(resumoDaPassagem({ falas: [] }), null);
  assert.equal(resumoDaPassagem({ falas: [u('[áudio]'), u('[anexo]')] }), null);
  assert.equal(resumoDaPassagem({}), null);
});

test('«falou de preço» (sem pergunta), convênio e exame; última fala cortada; dor sem lugar não vira queixa', () => {
  const longa = 'x'.repeat(300);
  const r = resumoDaPassagem({ falas: [u('o valor é muito alto'), u('vocês aceitam plano de saúde'), u('tenho a ressonância aqui'), u(longa)] })!;
  assert.match(r, /falou de preço · falou de convênio\/plano · falou de exame · última fala: «x{100,}…»$/);
  assert.doesNotMatch(r, /queixa|perguntou/);
  assert.equal(resumoDaPassagem({ falas: [u('dor')] }), 'Resumo: última fala: «dor»');
});

function chat() {
  const notas: string[] = [];
  const c: PortaDoChatwoot = {
    conversa: async () => ({ id: 1, nome: '', telefone: '+55', attrs: {}, etiquetas: [], grupo: false, interno: false }),
    gravarAtributos: async () => {},
    adicionarEtiquetas: async () => {},
    nota: async (_i, t) => void notas.push(t),
    publica: async () => ({ usuario: null }),
    valoresDoAtributo: async () => ['Esperando humano'],
    etiquetasDaConta: async () => [],
  };
  return { c, notas };
}

test('a nota de passagem ganha o resumo na linha de baixo; sem resumo ela é a de sempre', async () => {
  const a = chat();
  await passarParaEquipeNoChatwoot(a.c, { conversa: 1, etapa: '', motivo: 'pediu atendente', resumo: 'Resumo: dor na lombar há 2 meses · perguntou preço' });
  assert.equal(a.notas[0], '🙋 Sofia passou esta conversa para a equipe: pediu atendente\nResumo: dor na lombar há 2 meses · perguntou preço');
  const b = chat();
  await passarParaEquipeNoChatwoot(b.c, { conversa: 1, etapa: '', motivo: 'pediu atendente' });
  await passarParaEquipeNoChatwoot(b.c, { conversa: 1, etapa: '', motivo: 'pediu atendente', resumo: null });
  assert.deepEqual(b.notas, ['🙋 Sofia passou esta conversa para a equipe: pediu atendente', '🙋 Sofia passou esta conversa para a equipe: pediu atendente']);
});

test('ponta a ponta: o pausar_ia da rodada deixa a nota com o resumo do que a Sofia sabe (falas e atributos da conversa)', async () => {
  const { DynamicStructuredTool } = await import('@langchain/core/tools');
  const { z } = await import('zod');
  const { rodarSofiaDoChatwoot } = await import('./chatwoot-sofia.js');
  const nada = (nome: string) => new DynamicStructuredTool({ name: nome, description: nome, schema: z.object({ leadId: z.number().optional() }), func: async () => 'ok' });
  const a = chat();
  const r = await rodarSofiaDoChatwoot(
    {
      unit: { id: 'u', slug: 'x', name: 'Clínica', category: 'saude', sourceProdutos: '', systemPrompt: '' } as never,
      falas: [u('tenho dor na lombar há 2 meses'), s('Entendi'), u('quanto custa? quero falar com uma pessoa')],
      conversa: 9,
      modo: 'ligado',
      lida: { id: 9, nome: 'M', telefone: '+5594999990000', attrs: { qualificacao: 'Morno' }, etiquetas: [], grupo: false, interno: false },
      chat: a.c,
    },
    {
      ferramentas: {
        construirAgenda: () => ({ consultar_horarios: nada('consultar_horarios'), buscar_paciente: nada('buscar_paciente'), cadastrar_paciente: nada('cadastrar_paciente'), agendar_consulta: nada('agendar_consulta'), remarcar_consulta: nada('remarcar_consulta'), cancelar_consulta: nada('cancelar_consulta') }),
        contaDividida: async () => null,
        grade: async () => ({ erro: null, slots: [] }),
        consulta: async () => null,
      },
      rodarTeste: (async (_u: unknown, _f: unknown, opts: any) => {
        const tools = opts.ferramentas({ onCall: () => undefined, tz: 'America/Belem' }) as Array<{ name: string; invoke: (x: unknown) => Promise<string> }>;
        await tools.find((t) => t.name === 'pausar_ia')!.invoke({ motivo: 'pediu atendente' });
        return { ok: true as const, reply: 'Já chamo a equipe!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } };
      }) as never,
    },
  );
  assert.equal(r!.passouParaEquipe, true);
  assert.equal(a.notas.length, 1);
  assert.equal(
    a.notas[0],
    '🙋 Sofia passou esta conversa para a equipe: pediu atendente\nResumo: dor na lombar há 2 meses · perguntou preço · qualificação Morno · última fala: «quanto custa? quero falar com uma pessoa»',
  );
});
