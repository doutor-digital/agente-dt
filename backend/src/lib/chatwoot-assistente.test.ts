/**
 * Assistente da atendente (v1, só leitura): a conversa que o modelo lê, a Central de Ajuda, o teto por dia, as duas ferramentas
 * (agenda REAL por porta falsa) e o que sai do modelo (nota para a atendente, horário que não veio da agenda).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import {
  artigosPublicados,
  criarTeto,
  ferramentasDaAssistente,
  horariosCitados,
  horariosForaDaAgenda,
  linhasDaConversa,
  melhoresArtigos,
  separarNota,
  sugerirResposta,
  tirarDuvida,
  transcricaoDaConversa,
  type DepsDaAssistente,
  type RastroDaAssistente,
} from './chatwoot-assistente.js';
import { notaDaTranscricao } from './chatwoot-ia.js';

const unit = { id: 'u1', slug: 'doutor-hernia-parauapebas', name: 'Doutor Hérnia Parauapebas', category: 'outro', spineEnabled: true, spineToken: 'tok', spineAiPaused: false, spineAgendaDays: [0, 1, 2, 3, 4, 5, 6] } as unknown as Unit;
const m = (tipo: number, content: string, o: Record<string, unknown> = {}) => ({ message_type: tipo, content, private: false, ...o });
const rastroVazio = (): RastroDaAssistente => ({ fontes: new Set(), horariosDaAgenda: new Set() });
const respostaDoModelo = (reply: string) => ({ ok: true as const, reply, actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'fake', iterations: 1, totalLatencyMs: 1, tokens: { prompt: 1, completion: 1, total: 2 }, costUsd: null } });

function deps(o: Partial<DepsDaAssistente> = {}): DepsDaAssistente {
  return {
    rodarTeste: (async () => respostaDoModelo('ok')) as unknown as DepsDaAssistente['rodarTeste'],
    grade: async () => ({ erro: null, slots: [] }),
    contaDividida: async () => null,
    ajuda: async () => [],
    hoje: () => '2026-11-16',
    ...o,
  };
}

test('conversa: só o que o paciente vê, de quem é cada fala, áudio pela transcrição, sem aviso do sistema', () => {
  const payload = {
    payload: [
      m(1, 'Olá! Aqui é da Doutor Hérnia.'),
      m(0, 'oi, tenho dor na lombar'),
      m(1, 'combinar com a gerente', { private: true }),
      m(0, '', { attachments: [{ file_type: 'audio' }] }),
      m(1, notaDaTranscricao('faz seis meses que dói'), { private: true }),
      m(2, 'Atribuído a Fulana'),
      m(0, '', { attachments: [{ file_type: 'image' }] }),
    ],
  };
  assert.deepEqual(linhasDaConversa(payload), [
    { de: 'atendente', texto: 'Olá! Aqui é da Doutor Hérnia.' },
    { de: 'paciente', texto: 'oi, tenho dor na lombar' },
    { de: 'paciente', texto: '[áudio] faz seis meses que dói' },
    { de: 'paciente', texto: '[anexo]' },
  ]);
  assert.equal(transcricaoDaConversa(linhasDaConversa(payload)).split('\n')[1], 'Paciente: oi, tenho dor na lombar');
  // só as últimas
  const muitas = Array.from({ length: 50 }, (_, i) => m(0, `msg ${i}`));
  const ultimas = linhasDaConversa(muitas, 30);
  assert.equal(ultimas.length, 30);
  assert.equal(ultimas[29]!.texto, 'msg 49');
  assert.deepEqual(linhasDaConversa(null), []);
});

test('Central de Ajuda: só artigo publicado; acha pelo título e pelo corpo; sem palavra em comum, nada', () => {
  const artigos = artigosPublicados({
    payload: [
      { id: 1, title: 'Como marcar um lead como perdido', status: 'published', content: 'Abra a conversa, mude a etapa para Perdido e escolha o motivo.' },
      { id: 2, title: 'Rascunho: horário de almoço', status: 'draft', content: 'perdido perdido perdido' },
      { id: 3, title: 'Como passar para a gerente', status: 'published', content: 'Use a etiqueta esperando-humano.' },
      { id: 4, title: 'Arquivado', status: 'archived', content: 'x' },
    ],
  });
  assert.deepEqual(artigos.map((a) => a.id), [1, 3]);
  assert.deepEqual(melhoresArtigos(artigos, 'como marco perdido?').map((a) => a.id), [1]);
  assert.deepEqual(melhoresArtigos(artigos, 'passar para a gerente').map((a) => a.id), [3]);
  assert.deepEqual(melhoresArtigos(artigos, 'qual é a cor do céu'), []);
  assert.deepEqual(melhoresArtigos(artigos, '??'), []);
});

test('teto: por pessoa e por dia; outro dia zera; chamada devolvida não conta', () => {
  const t = criarTeto(2);
  assert.equal(t.gastar('ana', '2026-11-16').ok, true);
  assert.equal(t.gastar('ana', '2026-11-16').ok, true);
  assert.equal(t.gastar('ana', '2026-11-16').ok, false);
  assert.equal(t.gastar('bia', '2026-11-16').ok, true);
  assert.equal(t.gastar('ana', '2026-11-17').ok, true);
  t.devolver('ana', '2026-11-17');
  t.devolver('ana', '2026-11-17');
  assert.equal(t.gastar('ana', '2026-11-17').ok, true);
  assert.equal(t.gastar('ana', '2026-11-17').ok, true);
  assert.equal(t.gastar('ana', '2026-11-17').ok, false);
});

test('nota para a atendente sai do texto; aspas e horários', () => {
  assert.deepEqual(separarNota('Oi, tudo bem?\n\nNOTA: confira o convênio antes.'), { texto: 'Oi, tudo bem?', nota: 'confira o convênio antes.' });
  assert.deepEqual(separarNota('Só o texto.'), { texto: 'Só o texto.', nota: null });
  assert.deepEqual(horariosCitados('Tenho 9h, 10h30 e 14:00. A consulta custa R$ 350 em 2026.').sort(), ['09:00', '10:30', '14:00']);
  assert.deepEqual(horariosForaDaAgenda('Pode ser às 9h ou às 15h?', new Set(['09:00'])), ['15:00']);
  assert.deepEqual(horariosForaDaAgenda('Sem horário aqui.', new Set()), []);
});

test('horarios_livres: lê a grade REAL (leitura), só livre, respeita turno, avança até achar vaga e nunca cita o que não veio da grade', async () => {
  const lidos: string[] = [];
  const d = deps({
    grade: async (_u, dia) => {
      lidos.push(dia);
      if (dia === '2026-11-17') return { erro: null, slots: [{ time: '08:00', status: 'ocupado' }, { time: '08:30', status: 'incerto' }] };
      if (dia === '2026-11-18') return { erro: null, slots: [{ time: '08:00', status: 'livre' }, { time: '09:30', status: 'livre' }, { time: '14:00', status: 'livre' }, { time: '15:00', status: 'bloqueado' }] };
      return { erro: null, slots: [] };
    },
  });
  const rastro = rastroVazio();
  const [horarios] = ferramentasDaAssistente(unit, d, rastro);
  assert.equal(horarios!.name, 'horarios_livres');
  const out = String(await horarios!.invoke({ data: '2026-11-17', turno: 'manha' }));
  assert.match(out, /2026-11-18[^|]*: 08:00, 09:30/);
  assert.doesNotMatch(out, /14:00|15:00|08:30/);
  assert.deepEqual(lidos.slice(0, 2), ['2026-11-17', '2026-11-18']);
  assert.deepEqual([...rastro.horariosDaAgenda].sort(), ['08:00', '09:30']);
  assert.ok(rastro.fontes.has('agenda da clínica'));
  // data no passado → começa em hoje
  lidos.length = 0;
  await horarios!.invoke({ data: '2026-01-05' });
  assert.equal(lidos[0], '2026-11-16');
});

test('horarios_livres: agenda fora do ar, pausada, desconectada ou dividida → manda NÃO citar horário', async () => {
  const cenarios: Array<[string, Unit, Partial<DepsDaAssistente>, RegExp]> = [
    ['erro da agenda', unit, { grade: async () => ({ erro: 'timeout', slots: [] }) }, /NÃO cite horários/],
    ['pausada', { ...unit, spineAiPaused: true } as Unit, {}, /PAUSADA.*NÃO cite horários/],
    ['sem agenda', { ...unit, spineEnabled: false } as Unit, {}, /não está conectada.*NÃO cite horários/],
    ['dividida', unit, { contaDividida: async () => 'dividida' }, /dividida.*NÃO cite horários/],
  ];
  for (const [nome, u, o, esperado] of cenarios) {
    const rastro = rastroVazio();
    const [horarios] = ferramentasDaAssistente(u, deps(o), rastro);
    const out = String(await horarios!.invoke({ data: '2026-11-17' }));
    assert.match(out, esperado, nome);
    assert.equal(rastro.horariosDaAgenda.size, 0, nome);
  }
});

test('buscar_na_ajuda: devolve o artigo e marca a fonte; sem artigo, manda não inventar', async () => {
  const d = deps({ ajuda: async () => [{ id: 1, titulo: 'Como marcar perdido', texto: 'Mude a etapa para Perdido.' }] });
  const rastro = rastroVazio();
  const [, ajuda] = ferramentasDaAssistente(unit, d, rastro);
  assert.equal(ajuda!.name, 'buscar_na_ajuda');
  assert.match(String(await ajuda!.invoke({ pergunta: 'como marco perdido' })), /Mude a etapa para Perdido/);
  assert.ok(rastro.fontes.has('ajuda: Como marcar perdido'));
  assert.match(String(await ajuda!.invoke({ pergunta: 'receita de bolo' })), /Nenhum artigo.*NÃO invente/);
  // Central de Ajuda fora do ar não derruba a resposta
  const [, ajudaQuebrada] = ferramentasDaAssistente(unit, deps({ ajuda: async () => { throw new Error('fora'); } }), rastroVazio());
  assert.match(String(await ajudaQuebrada!.invoke({ pergunta: 'como marco perdido' })), /Nenhum artigo/);
});

test('sugerir: o modelo recebe só as duas ferramentas de LEITURA, a conversa e a ordem de escrever para a atendente; a nota sai à parte', async () => {
  let visto: { preambulo?: string; ferramentas: string[]; messages: unknown } | null = null;
  const d = deps({
    rodarTeste: (async (_u: Unit, messages: unknown, opts: { ferramentas: (b: unknown) => Array<{ name: string }>; preambulo?: string }) => {
      visto = { preambulo: opts.preambulo, ferramentas: opts.ferramentas({ onCall: () => undefined, tz: 'x' }).map((t) => t.name), messages };
      return respostaDoModelo('"Oi, Maria! Temos horário sim."\n\nNOTA: confirme o convênio.');
    }) as unknown as DepsDaAssistente['rodarTeste'],
  });
  const r = await sugerirResposta(d, { unit, linhas: [{ de: 'paciente', texto: 'tem horário?' }], nomeDoPaciente: 'Maria' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.texto, 'Oi, Maria! Temos horário sim.');
  assert.equal(r.nota, 'confirme o convênio.');
  assert.deepEqual(visto!.ferramentas, ['horarios_livres', 'buscar_na_ajuda']);
  assert.match(visto!.preambulo!, /ATENDENTE HUMANA/);
  assert.match(visto!.preambulo!, /Paciente: tem horário\?/);
  assert.match(visto!.preambulo!, /NÃO manda mensagem a ninguém e NÃO altera nada/);
  // citou 15h sem ter lido a agenda → aviso
  assert.equal(r.avisos.length, 0);
  const d2 = deps({ rodarTeste: (async () => respostaDoModelo('Posso às 15h?')) as unknown as DepsDaAssistente['rodarTeste'] });
  const r2 = await sugerirResposta(d2, { unit, linhas: [{ de: 'paciente', texto: 'oi' }], nomeDoPaciente: '' });
  assert.ok(r2.ok && r2.avisos.length === 1 && /15:00/.test(r2.avisos[0]!));
});

test('modelo sem chave ou fora do ar vira erro claro, sem texto de depuração', async () => {
  const sem = deps({ rodarTeste: (async () => ({ ok: false, status: 400, error: 'openai_not_configured' })) as unknown as DepsDaAssistente['rodarTeste'] });
  assert.deepEqual(await sugerirResposta(sem, { unit, linhas: [], nomeDoPaciente: '' }), { ok: false, status: 503, error: 'a IA desta unidade ainda não está configurada' });
  const caiu = deps({ rodarTeste: (async () => ({ ok: false, status: 500, error: 'playground_failed', message: 'segredo interno' })) as unknown as DepsDaAssistente['rodarTeste'] });
  const r = await tirarDuvida(caiu, { unit, falas: [{ role: 'user', content: 'qual o valor?' }] });
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), /segredo/);
});
