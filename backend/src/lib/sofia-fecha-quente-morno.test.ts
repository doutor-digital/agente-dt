/**
 * Sofia fecha Quente/Morno só com recusa explícita (decisão do João, 26/10, pela análise do item 5).
 * As frases são as REAIS dos 36 `fechar_lead(lost)` de 18–26/10 (ops/demandas/2026-10-26-item-5-analise-propostas.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirFechamentoDaSofia, type OpcoesDaDecisaoDaSofia } from './trava-perda.js';
import {
  ETIQUETAS_DE_NAO_CONTATAR,
  RETOMAR_EM_DIAS,
  classificarFala,
  etiquetaDeNaoContatar,
  etiquetarNaoContatar,
  falasDoUltimoTurno,
  levarParaEsperaComRetomada,
  type ClasseDaFala,
} from './sofia-fecha-quente-morno.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';

// ── o que o paciente disse (frases reais da análise; # = linha da tabela) ──
const CASOS: Array<[string, ClasseDaFala]> = [
  // pedido para parar de receber
  ['não me perturbe mais', 'parar-contato'], // #1
  ['não quero receber', 'parar-contato'], // #4
  ['não quero mais saber', 'parar-contato'], // #27
  ['pare de mandar mensagem', 'parar-contato'],
  ['SAIR', 'parar-contato'],
  // recusa explícita
  ['pode encerrar', 'recusa'], // #3, #7, #23, #25, #35
  ['obrigado, já resolvi', 'recusa'], // #5
  ['não tem como eu ir', 'recusa'], // #6
  ['não vou fazer a consulta mais não', 'recusa'], // #8
  ['não tenho mais interesse, obrigada', 'recusa'], // #12
  ['vou tentar lugares que aceitem meu plano', 'recusa'], // #14
  ['não tenho interesse em saber mais', 'recusa'], // #15
  ['não vou marcar, preciso de neurocirurgião', 'recusa'], // #16
  ['não, obrigada', 'recusa'], // #17
  ['número errado', 'recusa'], // #18
  ['já agendei numa ortoclínica perto de casa', 'recusa'], // #19
  ['não estou precisando, pode cancelar o horário', 'recusa'], // #20
  ['já estou resolvendo pelo convênio', 'recusa'], // #21
  ['vou deixar minha vaga para outro', 'recusa'], // #22
  ['já passei no médico', 'recusa'], // #24
  ['não mais', 'recusa'], // #26
  ['não estou precisando mais', 'recusa'], // #29
  ['não, obrigada, pensei que era ortopedista', 'recusa'], // #30
  ['vou procurar outro que atenda o plano', 'recusa'], // #31
  ['não vou… melhor assim', 'recusa'], // #32
  ['já estou sendo atendida pelo plano em outro lugar', 'recusa'], // #33 (fala de plano e mesmo assim é decisão)
  ['achei fisio que aceita o plano', 'recusa'], // #36
  // objeção / adiamento
  ['acho que não dá pra mim, não tenho condição', 'objecao'], // #2 (financeiro)
  ['no momento não vou querer, tenho plano de saúde', 'objecao'], // #9 (convênio)
  ['então vou deixar', 'objecao'], // #11
  ['deixa pra lá', 'objecao'], // #13
  ['no momento estou bem', 'objecao'], // #34
  ['estou meio apertado, vou ver e retorno', 'objecao'],
  // óbito
  ['a paciente faleceu', 'obito'], // #28
  ['minha mãe faleceu semana passada', 'obito'],
  // sem sinal
  ['oi, bom dia', 'indefinida'],
  ['', 'indefinida'],
];

for (const [frase, esperado] of CASOS) {
  test(`fala «${frase || '(vazia)'}» → ${esperado}`, () => {
    assert.equal(classificarFala([frase]), esperado);
  });
}

test('a última fala que decide manda: objeção e depois recusa = recusa; recusa e depois objeção = objeção', () => {
  assert.equal(classificarFala(['tenho plano de saúde', 'então não quero mais']), 'recusa');
  assert.equal(classificarFala(['não quero', 'no momento não tenho como, depois eu vejo']), 'objecao');
});

test('«dor de morte» não é óbito', () => {
  assert.notEqual(classificarFala(['é uma dor de morte, não aguento mais']), 'obito');
});

test('falasDoUltimoTurno: só o que o paciente escreveu desde a última resposta nossa, na ordem', () => {
  const msgs = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'Olá!' },
    { role: 'user', content: 'tenho plano' },
    { role: 'user', content: 'então não quero' },
  ];
  assert.deepEqual(falasDoUltimoTurno(msgs), ['tenho plano', 'então não quero']);
  assert.deepEqual(falasDoUltimoTurno([{ role: 'assistant', content: 'oi' }]), []);
});

// ── a decisão (cartão + fala) ──
const campo = (field_name: string, value: unknown) => ({ field_id: 1, field_name, values: [{ value }] });
function leadDe(temperatura: 'Quente' | 'Morno' | 'Frio' | null, extra: { campos?: ReturnType<typeof campo>[]; tags?: string[] } = {}): KommoLead {
  return {
    id: 1,
    name: 'Paciente',
    pipeline_id: 1,
    status_id: 12,
    responsible_user_id: 55,
    custom_fields_values: [...(temperatura ? [campo('★ Qualificação (Quente/Morno/Frio)', temperatura)] : []), ...(extra.campos ?? [])],
    _embedded: { tags: (extra.tags ?? []).map((name, i) => ({ id: i + 1, name })), contacts: [] },
  } as unknown as KommoLead;
}
const kommoCom = (lead: KommoLead) => ({ getLead: async () => lead, listPipelines: async () => [{ id: 1, name: 'COMERCIAL' }] }) as unknown as Pick<KommoClient, 'getLead' | 'listPipelines'>;
const falando = (...frases: string[]): OpcoesDaDecisaoDaSofia => ({ ultimasFalas: async () => frases });

test('Morno + objeção (plano de saúde): NÃO fecha — vai para EM ESPERA com «Retomar em», sem tarefa', async () => {
  const d = await decidirFechamentoDaSofia(kommoCom(leadDe('Morno')), 1, falando('no momento não vou querer, tenho plano de saúde'));
  assert.equal(d.tipo, 'recusa');
  if (d.tipo !== 'recusa') return;
  assert.equal(d.recusa.motivo, 'sem recusa explícita');
  assert.equal(d.recusa.levarParaEspera, true);
  assert.equal(d.recusa.avisarEquipe, false);
});

test('Quente (só pela etiqueta) + objeção financeira: NÃO fecha', async () => {
  const d = await decidirFechamentoDaSofia(kommoCom(leadDe(null, { tags: ['Quente'] })), 1, falando('acho que não dá pra mim, não tenho condição'));
  assert.equal(d.tipo, 'recusa');
});

test('Quente/Morno + fala indefinida ou conversa que não deu para ler: NÃO fecha (só recusa explícita fecha)', async () => {
  assert.equal((await decidirFechamentoDaSofia(kommoCom(leadDe('Morno')), 1, falando('oi'))).tipo, 'recusa');
  assert.equal((await decidirFechamentoDaSofia(kommoCom(leadDe('Quente')), 1, falando())).tipo, 'recusa');
  const quebrada = await decidirFechamentoDaSofia(kommoCom(leadDe('Quente')), 1, { ultimasFalas: async () => { throw new Error('banco fora'); } });
  assert.equal(quebrada.tipo, 'recusa');
});

test('conversa que não deu para ler: RECUSA sem mexer no cartão (nada de EM ESPERA, nada de tarefa) — para Quente/Morno e para Frio', async () => {
  for (const t of ['Quente', 'Morno', 'Frio', null] as const) {
    const d = await decidirFechamentoDaSofia(kommoCom(leadDe(t)), 1, { ultimasFalas: async () => { throw new Error('banco fora'); } });
    assert.equal(d.tipo, 'recusa', String(t));
    if (d.tipo !== 'recusa') continue;
    assert.equal(d.recusa.motivo, 'conversa ilegível');
    assert.equal(d.recusa.levarParaEspera, undefined, 'não grava EM ESPERA');
    assert.equal(d.recusa.avisarEquipe, false);
  }
});

test('Quente/Morno + recusa explícita: fecha (10 dos 15 Quente/Morno eram recusa clara)', async () => {
  for (const frase of ['já agendei numa ortoclínica perto de casa', 'não tenho mais interesse, obrigada', 'já estou sendo atendida pelo plano em outro lugar', 'pode encerrar']) {
    assert.deepEqual(await decidirFechamentoDaSofia(kommoCom(leadDe('Morno')), 1, falando(frase)), { tipo: 'segue', naoContatar: false }, frase);
  }
});

test('Frio e sem qualificação seguem como estão: fecham até com objeção ou sem sinal (0 dos 21 foram erro)', async () => {
  for (const t of ['Frio', null] as const) {
    assert.deepEqual(await decidirFechamentoDaSofia(kommoCom(leadDe(t)), 1, falando('no momento estou bem')), { tipo: 'segue', naoContatar: false });
    assert.deepEqual(await decidirFechamentoDaSofia(kommoCom(leadDe(t)), 1, falando()), { tipo: 'segue', naoContatar: false });
  }
});

test('pedido para parar de receber: fecha E pede a etiqueta de não contatar (Quente/Morno ou não)', async () => {
  for (const t of ['Morno', 'Frio', null] as const) {
    assert.deepEqual(await decidirFechamentoDaSofia(kommoCom(leadDe(t)), 1, falando('não quero receber')), { tipo: 'segue', naoContatar: true }, String(t));
  }
  assert.deepEqual(await decidirFechamentoDaSofia(kommoCom(leadDe('Morno')), 1, falando('não me perturbe mais')), { tipo: 'segue', naoContatar: true });
});

test('óbito: não fecha (qualquer temperatura), tarefa para a equipe ao responsável', async () => {
  for (const t of ['Morno', 'Frio']) {
    const d = await decidirFechamentoDaSofia(kommoCom(leadDe(t as 'Morno')), 1, falando('a paciente faleceu'));
    assert.equal(d.tipo, 'recusa');
    if (d.tipo !== 'recusa') continue;
    assert.equal(d.recusa.motivo, 'assunto sensível');
    assert.equal(d.recusa.avisarEquipe, true);
    assert.equal(d.recusa.responsavelId, 55);
    assert.match(d.recusa.textoDaTarefa ?? '', /falecimento/);
  }
});

test('consulta futura/pagamento seguram antes de olhar a fala; sem `ultimasFalas` Quente/Morno ficam como no #128', async () => {
  const pago = leadDe('Morno', { tags: ['$ · Pagou antecipado'] });
  const d = await decidirFechamentoDaSofia(kommoCom(pago), 1, falando('pode encerrar'));
  assert.equal(d.tipo === 'recusa' && d.recusa.motivo, 'pagou o antecipado');
  assert.deepEqual(await decidirFechamentoDaSofia(kommoCom(leadDe('Morno')), 1), { tipo: 'segue', naoContatar: false });
});

// ── executar a espera ──
const ESPERA = { pipelineId: 1, statusId: 11 };
const funis = { comercialId: 1, idDe: (f: string, e: string) => (f === 'COMERCIAL' && e === 'EM ESPERA' ? ESPERA : null) };
const esquema = (campos: Record<string, number>) => ({ campoPorNome: (n: string) => campos[n] ?? null });
const AGORA = 1_800_000_000;
function kommoDeEscrita(falhaMover = false) {
  const escritas: Array<{ campo: number; tipo: string; valor: unknown }> = [];
  const movidos: number[] = [];
  const kommo = {
    setLeadCustomFieldValue: async (_l: number, campo: number, tipo: string, valor: unknown) => void escritas.push({ campo, tipo, valor }),
    moveStage: async (m: { statusId: number }) => {
      if (falhaMover) throw new Error('Kommo recusou');
      movidos.push(m.statusId);
    },
  } as unknown as Pick<KommoClient, 'moveStage' | 'setLeadCustomFieldValue'>;
  return { kommo, escritas, movidos };
}
const unit = { id: 'u-espera', slug: 'teste' };

test('EM ESPERA: grava «Retomar em» daqui a 30 dias e o motivo, depois move', async () => {
  const { kommo, escritas, movidos } = kommoDeEscrita();
  const r = await levarParaEsperaComRetomada({ unit, kommo, funis, esquema: esquema({ '◷ Retomar em': 7, '⊘ Motivo da espera': 8 }), cartao: { id: 1, pipeline_id: 1, status_id: 12 }, agoraEpoch: AGORA });
  assert.deepEqual(r, { naEspera: true, retomada: true });
  assert.deepEqual(movidos, [ESPERA.statusId]);
  const retomar = escritas.find((e) => e.campo === 7);
  assert.equal(retomar?.tipo, 'date');
  assert.equal(retomar?.valor, new Date((AGORA + RETOMAR_EM_DIAS * 86_400) * 1000).toISOString());
  assert.equal(RETOMAR_EM_DIAS, 30);
  assert.deepEqual(escritas.find((e) => e.campo === 8), { campo: 8, tipo: 'select', valor: 'Outro' });
});

test('EM ESPERA: já estando lá não move (só renova a retomada); conta sem o campo move sem «Retomar em»; sem a etapa ou fora do COMERCIAL não mexe', async () => {
  const a = kommoDeEscrita();
  assert.deepEqual(await levarParaEsperaComRetomada({ unit, kommo: a.kommo, funis, esquema: esquema({ '◷ Retomar em': 7 }), cartao: { id: 1, pipeline_id: 1, status_id: ESPERA.statusId }, agoraEpoch: AGORA }), { naEspera: true, retomada: true });
  assert.equal(a.movidos.length, 0);
  const b = kommoDeEscrita();
  assert.deepEqual(await levarParaEsperaComRetomada({ unit, kommo: b.kommo, funis, esquema: esquema({}), cartao: { id: 1, pipeline_id: 1, status_id: 12 }, agoraEpoch: AGORA }), { naEspera: true, retomada: false });
  const c = kommoDeEscrita();
  assert.deepEqual(await levarParaEsperaComRetomada({ unit, kommo: c.kommo, funis: { ...funis, idDe: () => null }, esquema: esquema({}), cartao: { id: 1, pipeline_id: 1, status_id: 12 }, agoraEpoch: AGORA }), { naEspera: false, retomada: false });
  const d = kommoDeEscrita();
  assert.deepEqual(await levarParaEsperaComRetomada({ unit, kommo: d.kommo, funis, esquema: esquema({ '◷ Retomar em': 7 }), cartao: { id: 1, pipeline_id: 2, status_id: 12 }, agoraEpoch: AGORA }), { naEspera: false, retomada: false }, 'cartão do TRATAMENTO: nada');
  assert.equal(d.escritas.length, 0);
});

test('EM ESPERA: o Kommo recusar o movimento NÃO vira «naEspera» (quem chama não promete o que não fez)', async () => {
  const { kommo } = kommoDeEscrita(true);
  const r = await levarParaEsperaComRetomada({ unit, kommo, funis, esquema: esquema({ '◷ Retomar em': 7 }), cartao: { id: 1, pipeline_id: 1, status_id: 12 }, agoraEpoch: AGORA });
  assert.equal(r.naEspera, false);
});

// ── a etiqueta de não contatar ──
const tagsDe = (...nomes: string[]) => ({ listLeadTags: async () => nomes.map((name, id) => ({ id, name })) }) as unknown as Pick<KommoClient, 'listLeadTags'>;

test('etiqueta de não contatar: a que a conta já usa — NO_FOLLOW_UP; Rio Verde (sem ela) cai em NAO_PERTURBAR; lista ilegível = NO_FOLLOW_UP', async () => {
  assert.equal(await etiquetaDeNaoContatar({ id: 'c1' }, tagsDe('Quente', 'NAO_PERTURBAR', 'NO_FOLLOW_UP', 'Fluxo · Opt-out WhatsApp')), 'NO_FOLLOW_UP');
  assert.equal(await etiquetaDeNaoContatar({ id: 'c2' }, tagsDe('Fluxo · Opt-out WhatsApp', 'NAO_PERTURBAR', 'Fluxo · Não perturbar')), 'NAO_PERTURBAR');
  assert.equal(await etiquetaDeNaoContatar({ id: 'c3' }, tagsDe('Fluxo · Opt-out WhatsApp')), 'Fluxo · Opt-out WhatsApp');
  assert.equal(await etiquetaDeNaoContatar({ id: 'c4' }, { listLeadTags: async () => { throw new Error('429'); } } as never), 'NO_FOLLOW_UP');
  assert.deepEqual([...ETIQUETAS_DE_NAO_CONTATAR], ['NO_FOLLOW_UP', 'NAO_PERTURBAR', 'Fluxo · Opt-out WhatsApp']);
});

test('etiquetarNaoContatar aplica a etiqueta no cartão; falha de Kommo devolve null sem lançar', async () => {
  const postas: Array<{ leadId: number; tags: string[] }> = [];
  const kommo = { ...tagsDe('NO_FOLLOW_UP'), addTag: async (a: { leadId: number; tags: string[] }) => void postas.push(a) } as unknown as Pick<KommoClient, 'listLeadTags' | 'addTag'>;
  assert.equal(await etiquetarNaoContatar({ id: 'c5', slug: 't' }, kommo, 9), 'NO_FOLLOW_UP');
  assert.deepEqual(postas, [{ leadId: 9, tags: ['NO_FOLLOW_UP'] }]);
  const ruim = { ...tagsDe('NO_FOLLOW_UP'), addTag: async () => { throw new Error('Kommo fora'); } } as unknown as Pick<KommoClient, 'listLeadTags' | 'addTag'>;
  assert.equal(await etiquetarNaoContatar({ id: 'c6', slug: 't' }, ruim, 9), null);
});

// ── achados do sênior no #134: uma frase por teste ──
const NAO_E_PARAR: Array<[string, ClasseDaFala]> = [
  ['me passa o pix para enviar o comprovante', 'indefinida'],
  ['pode pedir para me ligarem amanhã? agora não posso', 'objecao'],
  ['qual o numero para ligar', 'indefinida'],
  ['vcs nao me mandaram nada ainda', 'indefinida'],
  ['nao incomoda nao, pode mandar', 'indefinida'],
  ['isso não me incomoda', 'indefinida'],
];
for (const [frase, esperado] of NAO_E_PARAR) {
  test(`NÃO é pedido de parar: «${frase}» → ${esperado}`, () => {
    assert.equal(classificarFala([frase]), esperado);
  });
}
for (const frase of ['para de me mandar mensagem', 'pare de mandar', 'parem de ligar', 'não me mande mais mensagem', 'não me ligue mais', 'não me perturbe mais', 'não quero receber', 'não quero mais saber', 'pode parar de me chamar']) {
  test(`é pedido de parar: «${frase}»`, () => {
    assert.equal(classificarFala([frase]), 'parar-contato');
  });
}

test('«não quero mais» → Sofia «Posso encerrar?» → «sim»: a leitura junta o turno anterior e é RECUSA (Morno fecha, não vai a EM ESPERA)', async () => {
  const msgs = [
    { role: 'user', content: 'não quero mais' },
    { role: 'assistant', content: 'Tem certeza? Posso encerrar?' },
    { role: 'user', content: 'sim' },
  ];
  assert.deepEqual(falasDoUltimoTurno(msgs), ['não quero mais', 'sim']);
  assert.equal(classificarFala(falasDoUltimoTurno(msgs)), 'recusa');
  assert.deepEqual(await decidirFechamentoDaSofia(kommoCom(leadDe('Morno')), 1, { ultimasFalas: async () => falasDoUltimoTurno(msgs) }), { tipo: 'segue', naoContatar: false });
});

test('«sim» sozinho, sem recusa antes (era a resposta a outra pergunta): continua sem decidir — Quente/Morno não fecham', () => {
  assert.equal(classificarFala(falasDoUltimoTurno([{ role: 'assistant', content: 'Quer que eu veja um horário?' }, { role: 'user', content: 'sim' }])), 'indefinida');
});

test('se a última palavra é da Sofia (ainda não há fala nova do paciente), não há fala para decidir', () => {
  assert.deepEqual(falasDoUltimoTurno([{ role: 'user', content: 'não quero mais' }, { role: 'assistant', content: 'Posso encerrar?' }]), []);
});

const NAO_E_RECUSA: Array<[string, ClasseDaFala]> = [
  ['já fiz o pix', 'indefinida'],
  ['já marquei com vocês semana que vem', 'indefinida'],
  ['não quero fazer agora, está caro', 'objecao'],
  ['nao, obrigado. quem sabe depois', 'objecao'],
  ['já fiz fisioterapia e não resolveu, vocês aceitam unimed?', 'objecao'],
  ['não quero agora, talvez mês que vem', 'objecao'],
  ['Não quero mais, tá muito caro', 'objecao'],
];
for (const [frase, esperado] of NAO_E_RECUSA) {
  test(`NÃO é recusa: «${frase}» → ${esperado}`, () => {
    assert.equal(classificarFala([frase]), esperado);
  });
}
for (const frase of ['já agendei numa ortoclínica perto de casa', 'já passei no médico', 'já fui em outra clínica e vou continuar lá']) {
  test(`continua sendo recusa (foi para outro): «${frase}»`, () => {
    assert.equal(classificarFala([frase]), 'recusa');
  });
}

for (const frase of ['eu luto com essa dor há anos, mas agora não dá', 'luto todo dia para conseguir levantar']) {
  test(`«luto» do verbo lutar NÃO é óbito: «${frase}»`, () => {
    assert.notEqual(classificarFala([frase]), 'obito');
  });
}
for (const frase of ['estou de luto', 'meu pai morreu', 'houve um falecimento na família', 'foi a óbito']) {
  test(`é óbito: «${frase}»`, () => {
    assert.equal(classificarFala([frase]), 'obito');
  });
}
