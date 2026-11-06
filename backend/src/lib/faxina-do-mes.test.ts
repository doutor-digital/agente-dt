/**
 * Faxina do mês: cada passo, com Kommo falso. Prova: seco não grava nada; tarefa de pessoa fica intocada; os tetos valem;
 * o freio do Kommo (429/403) para a unidade; conta dividida não junta chat; relatório em português com «faria» no seco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KommoLead, KommoPipeline, KommoTarefa } from '../services/kommo.service.js';
import type { PortaKommo } from './entrada-automatica.js';
import type { ResumoDaRodada } from './entrada-automatica.js';
import type { Estado } from './automacoes-estado.js';
import { duplicadosPelaEntradaAutomatica } from './faxina-duplicados.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import {
  DIAS_ETIQUETA_PRESA,
  DIAS_TAREFA_VELHA,
  MAX_ETIQUETAS_TIRADAS,
  MAX_TAREFAS_FECHADAS,
  RESULTADO_DA_TAREFA,
  criadaPorRobo,
  etapasDaUnidade,
  etiquetaPesquisavel,
  faxinaDaUnidade,
  janelaDaFaxina,
  linhaDaUnidade,
  detalhesDaUnidade,
  montarRelatorio,
  tarefaVelhaDeRobo,
  type CtxFaxina,
  type DepsDaFaxina,
  type ResultadoEtapas,
  type ResultadoMotivos,
} from './faxina-do-mes.js';

const AGORA = 1_800_000_000;
const PIPELINES: KommoPipeline[] = [
  { id: 1, name: 'COMERCIAL', is_main: true, statuses: [{ id: 143, name: 'PERDIDO', sort: 11000 }, { id: 100, name: 'EM QUALIFICAÇÃO', sort: 20, type: 0 }, { id: 99, name: 'Entrada', sort: 10, type: 1 }, { id: 142, name: 'GANHO', sort: 10000 }] },
];
const DIA = 86_400;

const tarefa = (id: number, extra: Partial<KommoTarefa> = {}): KommoTarefa => ({
  id,
  text: 'ALERTA · timbo · [GUIA] Novo lead em QUALIFICAÇÃO',
  complete_till: AGORA - (DIAS_TAREFA_VELHA + 5) * DIA,
  is_completed: false,
  created_by: 0,
  ...extra,
});

interface Gravacoes {
  vinculos: Array<[string, number]>;
  fechadas: Array<[number, string]>;
  etiquetasTiradas: Array<[number, string]>;
  etapasPedidas: number;
  motivosPedidos: number;
  leituras: string[];
  /** quantas vezes a faxina chamou aceitarEntrada (tem de ser SEMPRE 0) */
  aceites: number;
}

function montar(
  o: {
    entradas?: Array<{ uid: string; leadId: number; contatoId: number; categoria: string; criadoEm: number }>;
    tarefas?: KommoTarefa[];
    etiquetas?: string[];
    cartoesDaEtiqueta?: Record<string, KommoLead[]>;
    falhaAoFechar?: (id: number) => Error | null;
    falhaAoListarTarefas?: Error;
    etapas?: ResultadoEtapas;
    motivos?: ResultadoMotivos;
    contatos?: Array<{ id: number; telefones: string[]; leadIds: number[] }>;
    cartoes?: Array<{ id: number; status_id: number; pipeline_id: number }>;
    /** erro por chamada da porta do #233: 'telefones' | 'busca' | 'leads' | 'vincular' */
    falhaNaPorta?: Partial<Record<'telefones' | 'busca' | 'leads' | 'vincular', unknown>>;
    estoqueNaConta?: Estado;
    resumoDoWorker?: { em: number; resumo: ResumoDaRodada } | null;
  } = {},
) {
  const g: Gravacoes = { vinculos: [], fechadas: [], etiquetasTiradas: [], etapasPedidas: 0, motivosPedidos: 0, leituras: [], aceites: 0 };
  const contatos = o.contatos ?? [];
  const deps: DepsDaFaxina = {
    kommo: {
      listarTarefas: async () => {
        if (o.falhaAoListarTarefas) throw o.falhaAoListarTarefas;
        return { tarefas: o.tarefas ?? [], completa: true };
      },
      fecharTarefa: async (id, texto) => {
        const e = o.falhaAoFechar?.(id);
        if (e) throw e;
        g.fechadas.push([id, texto]);
      },
      listLeadTags: async () => (o.etiquetas ?? []).map((name, i) => ({ id: i + 1, name })),
      listLeadsComEtiqueta: async (nome) => o.cartoesDaEtiqueta?.[nome] ?? [],
      removeTag: async (id, tag) => void g.etiquetasTiradas.push([id, tag]),
    },
    duplicados: (c) => {
      const falha = (k: 'telefones' | 'busca' | 'leads' | 'vincular') => {
        if (o.falhaNaPorta?.[k]) throw o.falhaNaPorta[k];
      };
      const porta: PortaKommo = {
        async listarEntrada() {
          g.leituras.push('listarEntrada');
          return { itens: (o.entradas ?? []).map((e) => ({ pipelineId: 1, ...e })), completa: true };
        },
        async telefonesDoContato(id) {
          falha('telefones');
          return contatos.find((x) => x.id === id)?.telefones ?? [];
        },
        async buscarContatosPorTelefone(texto) {
          falha('busca');
          const k = texto.replace(/\D/g, '');
          return contatos.filter((x) => x.telefones.some((t) => t.replace(/\D/g, '').endsWith(k))).map((x) => ({ id: x.id, telefones: x.telefones, leadIds: x.leadIds }));
        },
        async listLeadsPorIds(ids) {
          falha('leads');
          return (o.cartoes ?? []).filter((x) => ids.includes(x.id)) as KommoLead[];
        },
        async listPipelines() {
          return PIPELINES;
        },
        async vincularEntrada(uid, id) {
          falha('vincular');
          g.vinculos.push([uid, id]);
        },
        async aceitarEntrada() {
          g.aceites++;
          return { leadId: 1 };
        },
        async addLeadNote() {
          return { id: 1 };
        },
      };
      return duplicadosPelaEntradaAutomatica({
        kommo: porta,
        unit: { id: 'u1', slug: 'timbo' },
        gravar: c.modo === 'ligado',
        estadoDoEstoqueNaConta: o.estoqueNaConta ?? 'desligado',
        ultimoResumoDoWorker: () => o.resumoDoWorker ?? null,
        agora: () => AGORA * 1000,
        pausa: async () => undefined,
      });
    },
    etapas: async () => {
      g.etapasPedidas++;
      return o.etapas ?? { automacoes: [], camposGravados: 0, semCartao: 0 };
    },
    motivos: async () => {
      g.motivosPedidos++;
      return o.motivos ?? { estado: 'desligado', executou: false, gravados: 0, gravaria: 0 };
    },
    pausa: async () => undefined,
  };
  return { deps, g };
}

const ctx = (extra: Partial<CtxFaxina> = {}): CtxFaxina => ({
  slug: 'timbo',
  nome: 'Timbó',
  subdominio: 'timbosc',
  modo: 'ligado',
  cuidaDaConta: true,
  contaDividida: false,
  agoraEpoch: AGORA,
  ...extra,
});

// ─── passo 2: tarefas ─────────────────────────────────────────────────────────────────────────────

test('tarefa de robô vencida há mais de 30 dias é concluída, com resultado explicando', async () => {
  const { deps, g } = montar({ tarefas: [tarefa(1), tarefa(2, { text: '[Contato: Ana] quer horário bem cedo' }), tarefa(3, { text: 'CONFERIR HORÁRIO · timbo · x' })] });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.fechadas.map((f) => f[0]), [1, 2, 3]);
  assert.equal(g.fechadas[0][1], RESULTADO_DA_TAREFA);
  assert.equal(r.tarefas.fechadas, 3);
});

test('TAREFA DE PESSOA NUNCA: created_by de usuário, ausente, ou robô sem marca de alerta ficam intocados', async () => {
  const { deps, g } = montar({
    tarefas: [
      tarefa(1, { created_by: 15905863 }), // gente, com texto que parece alerta
      tarefa(2, { created_by: undefined }), // não sabemos quem criou = pessoa
      tarefa(3, { created_by: null }),
      tarefa(4, { created_by: 0, text: 'Ligar para o paciente amanhã' }), // robô, mas sem marca
      tarefa(5, { text: 'ALERTA · timbo · x', complete_till: AGORA - 10 * DIA }), // robô, mas recente
      tarefa(6, { is_completed: true }),
    ],
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.fechadas, []);
  assert.equal(r.tarefas.fechadas, 0);
  assert.equal(r.tarefas.deRoboSemMarca, 1, 'a de robô sem marca é só contada, para o relatório');
  assert.equal(criadaPorRobo({ created_by: 0 }), true);
  assert.equal(criadaPorRobo({ created_by: undefined }), false);
  assert.equal(tarefaVelhaDeRobo(tarefa(9), AGORA), true);
  assert.equal(tarefaVelhaDeRobo(tarefa(9, { created_by: 3 }), AGORA), false);
});

test('teto de tarefas: fecha MAX_TAREFAS_FECHADAS e diz quantas sobraram para o mês seguinte', async () => {
  const todas = Array.from({ length: MAX_TAREFAS_FECHADAS + 12 }, (_, i) => tarefa(i + 1));
  const { deps, g } = montar({ tarefas: todas });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(g.fechadas.length, MAX_TAREFAS_FECHADAS);
  assert.equal(r.tarefas.sobraram, 12);
});

test('três falhas seguidas ao concluir encerram o passo (não martela o Kommo)', async () => {
  const { deps, g } = montar({ tarefas: Array.from({ length: 10 }, (_, i) => tarefa(i + 1)), falhaAoFechar: () => new Error('500') });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(g.fechadas.length, 0);
  assert.equal(r.tarefas.falhas, 3);
  assert.equal(r.tarefas.sobraram, 7);
  assert.ok(r.erros.some((e) => e.startsWith('tarefas:')));
});

// ─── SECO não grava nada ──────────────────────────────────────────────────────────────────────────

test('SECO: nenhum vínculo, nenhuma tarefa, nenhuma etiqueta; conta o que FARIA', async () => {
  const velha = Date.now() / 1000 - 30 * DIA;
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
    contatos: [
      { id: 1, telefones: ['47 98818-8666'], leadIds: [10] },
      { id: 2, telefones: ['47 98818-8666'], leadIds: [500] },
    ],
    cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }],
    tarefas: [tarefa(1), tarefa(2)],
    etiquetas: ['▶ Boas-vindas'],
    cartoesDaEtiqueta: { '▶ Boas-vindas': [{ id: 77, name: 'x', status_id: 1, pipeline_id: 1, updated_at: ctx().agoraEpoch - 20 * DIA }] },
  });
  void velha;
  const r = await faxinaDaUnidade(ctx({ modo: 'seco' }), deps);
  assert.deepEqual(g.vinculos, []);
  assert.deepEqual(g.fechadas, []);
  assert.deepEqual(g.etiquetasTiradas, []);
  assert.equal(r.duplicados.juntados, 1, 'diz que juntaria');
  assert.equal(r.tarefas.fechadas, 2);
  assert.equal(r.etiquetas.removidas, 1);
  const linha = linhaDaUnidade(r, 'outubro');
  assert.match(linha, /só no papel, nada foi gravado/);
  assert.match(linha, /faria juntar 1 duplicado/);
  assert.match(linha, /faria fechar 2 tarefas velhas/);
});

test('LIGADO: vincula, conclui e tira etiqueta de verdade', async () => {
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
    contatos: [
      { id: 1, telefones: ['47 98818-8666'], leadIds: [10] },
      { id: 2, telefones: ['47 98818-8666'], leadIds: [500] },
    ],
    cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }],
    tarefas: [tarefa(1)],
    etiquetas: ['▶ Boas-vindas'],
    cartoesDaEtiqueta: { '▶ Boas-vindas': [{ id: 77, name: 'x', status_id: 1, pipeline_id: 1, updated_at: AGORA - 20 * DIA }] },
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.vinculos, [['u1', 500]]);
  assert.deepEqual(g.fechadas.map((f) => f[0]), [1]);
  assert.deepEqual(g.etiquetasTiradas, [[77, '▶ Boas-vindas']]);
  assert.match(linhaDaUnidade(r, 'outubro'), /^Timbó, outubro: 1 duplicado juntado · 1 tarefa velha fechada · 0 etapas corrigidas \(última varredura\) · 1 etiqueta ▶ presa tirada · 0 precisam da equipe$/);
});

// ─── passo 1: casos que vão para a equipe e conta dividida ───────────────────────────────────────

test('ambíguo vai para a equipe com link do cartão; nada é vinculado', async () => {
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
    contatos: [
      { id: 1, telefones: ['47 98818-8666'], leadIds: [10] },
      { id: 2, telefones: ['47 98818-8666'], leadIds: [500] },
      { id: 3, telefones: ['47 98818-8666'], leadIds: [600] },
    ],
    cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }, { id: 600, status_id: 100, pipeline_id: 1 }],
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.vinculos, []);
  assert.equal(r.duplicados.equipe.length, 1);
  assert.match(detalhesDaUnidade(r).join('\n'), /https:\/\/timbosc\.kommo\.com\/leads\/detail\/500/);
  assert.match(linhaDaUnidade(r, 'outubro'), /1 precisa da equipe/);
});

test('conta dividida (Petrópolis × Caxias): NÃO junta chat — o cartão não diz de qual unidade é', async () => {
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
    contatos: [{ id: 1, telefones: ['47 98818-8666'], leadIds: [10] }, { id: 2, telefones: ['47 98818-8666'], leadIds: [500] }],
    cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }],
    tarefas: [tarefa(1)],
  });
  const r = await faxinaDaUnidade(ctx({ contaDividida: true }), deps);
  assert.deepEqual(g.vinculos, []);
  assert.ok(r.duplicados.pulado);
  assert.equal(g.fechadas.length, 1, 'tarefas de robô da conta continuam valendo');
});

test('a irmã da conta (cuidaDaConta=false) não repete tarefas, etiquetas nem duplicados; só as automações dela', async () => {
  const { deps, g } = montar({ tarefas: [tarefa(1)], etiquetas: ['▶ Boas-vindas'] });
  await faxinaDaUnidade(ctx({ cuidaDaConta: false }), deps);
  assert.equal(g.fechadas.length, 0);
  assert.equal(g.etapasPedidas, 1);
  assert.equal(g.motivosPedidos, 1);
});

// ─── passo 5: etiquetas ▶ ─────────────────────────────────────────────────────────────────────────

test('etiqueta ▶: só a PRESA (cartão parado há 7 dias) sai; a recente fica; a sem cartão é só relatada', async () => {
  const { deps, g } = montar({
    etiquetas: ['▶ Boas-vindas', '▶ Retomada', '▶', 'Outra etiqueta'],
    cartoesDaEtiqueta: {
      '▶ Boas-vindas': [
        { id: 1, name: 'a', status_id: 1, pipeline_id: 1, updated_at: AGORA - (DIAS_ETIQUETA_PRESA + 1) * DIA },
        { id: 2, name: 'b', status_id: 1, pipeline_id: 1, updated_at: AGORA - 2 * DIA },
      ],
    },
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.etiquetasTiradas, [[1, '▶ Boas-vindas']]);
  assert.deepEqual(r.etiquetas.semUso, ['▶ Retomada']);
  assert.deepEqual(r.etiquetas.naoPesquisadas, ['▶'], '«▶» sozinha não é pesquisável: dito, não adivinhado');
  assert.equal(etiquetaPesquisavel('Outra etiqueta'), false, 'só etiqueta ▶ entra');
});

test('teto de etiquetas: tira MAX_ETIQUETAS_TIRADAS e conta as que sobraram', async () => {
  const cartoes = Array.from({ length: MAX_ETIQUETAS_TIRADAS + 4 }, (_, i) => ({ id: i + 1, name: 'x', status_id: 1, pipeline_id: 1, updated_at: AGORA - 30 * DIA }));
  const { deps, g } = montar({ etiquetas: ['▶ Boas-vindas'], cartoesDaEtiqueta: { '▶ Boas-vindas': cartoes } });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(g.etiquetasTiradas.length, MAX_ETIQUETAS_TIRADAS);
  assert.equal(r.etiquetas.sobraram, 4);
});

// ─── o freio do Kommo e a independência dos passos ───────────────────────────────────────────────

test('falha comum ao tirar etiqueta (400/404) aparece no relatório e NÃO é chamada de freio do Kommo', async () => {
  const { deps } = montar({
    etiquetas: ['▶ Boas-vindas'],
    cartoesDaEtiqueta: { '▶ Boas-vindas': Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: 'x', status_id: 1, pipeline_id: 1, updated_at: AGORA - 30 * DIA })) },
  });
  deps.kommo.removeTag = async () => { throw Object.assign(new Error('400 cartão excluído'), { status: 400 }); };
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.ok(r.erros.some((e) => /^etiquetas: 3 falhas seguidas/.test(e)));
  assert.equal(r.avisos.some((a) => /pediu calma/.test(a)), false);
  assert.equal(r.etiquetas.removidas, 0);
});

test('ALERTA CLÍNICO nunca é fechado: nos dois formatos (atual e antigo), vai para «precisam da equipe» com link', async () => {
  const atual = 'ALERTA · timbo · [Contato: Ana] LIGAR AGORA — URGENTE: paciente com sinal de alerta clínico (perda de força). A IA parou e passou o atendimento para a equipe — ligar para o paciente agora.';
  const antigo = '[Contato: Wellington] URGENTE: paciente relata perda de controle da urina';
  const { deps, g } = montar({
    tarefas: [
      tarefa(1, { text: atual, entity_id: 111, entity_type: 'leads' }),
      tarefa(2, { text: antigo, entity_id: 222, entity_type: 'leads' }),
      tarefa(3, { text: 'ALERTA · timbo · red flag: dormência nas pernas', entity_id: 333, entity_type: 'leads' }),
      tarefa(4), // guia comum: fecha
    ],
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.fechadas.map((f) => f[0]), [4], 'só o guia comum');
  assert.deepEqual(r.tarefas.alertasClinicos.map((a) => a.cartaoId), [111, 222, 333]);
  const d = detalhesDaUnidade(r).join('\n');
  assert.match(d, /timbosc\.kommo\.com\/leads\/detail\/111 \(ALERTA CLÍNICO/);
  assert.match(d, /leads\/detail\/222/);
  assert.match(linhaDaUnidade(r, 'outubro'), /3 precisam da equipe/);
  assert.equal(tarefaVelhaDeRobo(tarefa(9, { text: atual }), AGORA), false);
});

const um = (n: number) => ({ uid: `u${n}`, leadId: 10 + n, contatoId: 1 + n * 10, categoria: 'chats', criadoEm: 1 });
const contatosDoUm = [
  { id: 1, telefones: ['47 98818-8666'], leadIds: [10] },
  { id: 2, telefones: ['47 98818-8666'], leadIds: [500] },
];

test('regra de telefone é a do #233: SEM DDD de um lado NÃO vincula (vincular errado não tem volta)', async () => {
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
    contatos: [{ id: 1, telefones: ['+55 47 98818-8666'], leadIds: [10] }, { id: 2, telefones: ['98818-8666'], leadIds: [500] }, { id: 3, telefones: ['+55 11 98818-8666'], leadIds: [600] }],
    cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }, { id: 600, status_id: 100, pipeline_id: 1 }],
  });
  await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.vinculos, [], 'nem o contato sem DDD nem o de outro DDD casam');
});

test('cartão FECHADO não segura nem vincula: lead de entrada velho sem par aberto fica na caixa (não é aceito)', async () => {
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
    contatos: contatosDoUm,
    cartoes: [{ id: 500, status_id: 143, pipeline_id: 1 }],
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.vinculos, []);
  assert.equal(r.duplicados.semCartao, 1);
});

test('nunca ACEITA lead de entrada, seja velho sem par ou RECENTE sem par: aceitarEntrada nunca é chamada (contador, não r.erros)', async () => {
  for (const modo of ['ligado', 'seco'] as const) {
    const { deps, g } = montar({
      entradas: [
        { uid: 'velho', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }, // estoque, sem par
        { uid: 'novo', leadId: 11, contatoId: 3, categoria: 'chats', criadoEm: AGORA - 30 * 60 }, // recente, sem par
      ],
      contatos: [{ id: 1, telefones: ['47 98818-8666'], leadIds: [10] }, { id: 3, telefones: ['47 97777-1111'], leadIds: [11] }],
    });
    await faxinaDaUnidade(ctx({ modo }), deps);
    assert.equal(g.aceites, 0, modo);
    assert.deepEqual(g.vinculos, []);
  }
});

test('lead RECENTE (menos de 120 min) não é da faxina: fica para o worker de 3 em 3 minutos', async () => {
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: AGORA - 30 * 60 }],
    contatos: contatosDoUm,
    cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }],
  });
  await faxinaDaUnidade(ctx(), deps);
  assert.deepEqual(g.vinculos, []);
});

test('entrada-estoque JÁ ligada (ou em papel) na conta: a faxina NÃO roda de novo, só relata o resumo do worker', async () => {
  for (const estoqueNaConta of ['ligado', 'seco'] as const) {
    const { deps, g } = montar({
      estoqueNaConta,
      entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
      contatos: contatosDoUm,
      cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }],
      resumoDoWorker: { em: AGORA * 1000 - 12 * 60_000, resumo: { unit: 'timbo', vinculados: 7, vincularia: 4, ambiguos: 2, semParVelho: 9, adiados: 0, semTelefone: 0, erros: 0, listaTruncada: false, encerrouCedo: null } as never },
    });
    const r = await faxinaDaUnidade(ctx(), deps);
    assert.deepEqual(g.leituras, [], 'não leu a caixa');
    assert.deepEqual(g.vinculos, []);
    assert.equal(r.duplicados.juntados, 0, 'a rodada de 3 minutos do worker NÃO entra no balanço da faxina');
    assert.match(r.avisos.join('\n'), /a faxina não rodou de novo, só relata a última rodada dela \(há 12 min\)/);
    assert.match(r.avisos.join('\n'), estoqueNaConta === 'ligado' ? /7 vinculados/ : /4 vincularia/);
    assert.match(r.avisos.join('\n'), /2 chats com mais de um cartão aberto/);
    assert.match(r.avisos.join('\n'), /não o balanço do mês/);
  }
  const sem = montar({ estoqueNaConta: 'ligado' });
  const r2 = await faxinaDaUnidade(ctx(), sem.deps);
  assert.match(r2.avisos.join('\n'), /ainda não rodou desde o último reinício/);
});

test('contato apagado (404 ao ler): conta como erro daquele lead, NÃO aciona o freio, os outros passos seguem', async () => {
  const { deps, g } = montar({
    entradas: [um(1)],
    contatos: contatosDoUm,
    falhaNaPorta: { telefones: Object.assign(new Error('404'), { status: 404 }) },
    tarefas: [tarefa(1)],
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(r.duplicados.falhas, 1);
  assert.match(detalhesDaUnidade(r).join('\n'), /1 chats deram erro/);
  assert.equal(r.interrompida, false);
  assert.equal(g.fechadas.length, 1);
  assert.equal(g.etapasPedidas, 1);
});

test('429/5xx/rede na fila de entrada É freio: a unidade para e fica interrompida (retomada depois)', async () => {
  for (const status of [429, 502, undefined]) {
    const { deps, g } = montar({
      entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
      contatos: contatosDoUm,
      falhaNaPorta: { busca: Object.assign(new Error(String(status)), { status }) },
      tarefas: [tarefa(1)],
    });
    const r = await faxinaDaUnidade(ctx(), deps);
    assert.ok(r.avisos.some((a) => /pediu calma/.test(a)), String(status));
    assert.equal(r.interrompida, true);
    assert.equal(g.fechadas.length, 0);
    assert.equal(g.etapasPedidas, 0);
  }
});

test('403 (token sem escopo/administrador) na fila de entrada: aviso, mas NÃO trava os outros passos da unidade', async () => {
  const { deps, g } = montar({
    entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }],
    contatos: contatosDoUm,
    falhaNaPorta: { busca: Object.assign(new Error('403'), { status: 403 }) },
    tarefas: [tarefa(1)],
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.ok(r.avisos.some((a) => /parou cedo/.test(a)));
  assert.equal(r.interrompida, false, '403 de token é só aviso: a unidade conclui e ganha a trava mensal (refazer não adiantaria)');
  assert.equal(g.fechadas.length, 1, 'e os outros passos da unidade rodam');
  assert.equal(r.avisos.some((a) => /pediu calma/.test(a)), false);
});

test('429 do Kommo: a unidade PARA (não chama etapas, motivos nem etiquetas) e o aviso aparece', async () => {
  const freio = Object.assign(new Error('429'), { status: 429 });
  const { deps, g } = montar({ falhaAoListarTarefas: freio, etiquetas: ['▶ Boas-vindas'] });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(g.etapasPedidas, 0);
  assert.equal(g.motivosPedidos, 0);
  assert.equal(g.etiquetasTiradas.length, 0);
  assert.ok(r.avisos.some((a) => /pediu calma/.test(a)));
});

test('erro comum num passo (não é freio): os outros seguem', async () => {
  const { deps, g } = montar({ falhaAoListarTarefas: new Error('timeout') });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(g.etapasPedidas, 1);
  assert.equal(g.motivosPedidos, 1);
  assert.ok(r.erros.some((e) => e.startsWith('tarefas:')));
});

// ─── passo 3 e 4 no relatório ─────────────────────────────────────────────────────────────────────

test('automação de etapa DESLIGADA só relata: diz que não mexeu e o que o papel dizia; ligada diz quantas moveu', async () => {
  const etapas: ResultadoEtapas = {
    automacoes: [
      { id: 'parados', nome: 'Parados e estoques parados', estado: 'desligado', executou: false, movidos: 0, moveria: 9 },
      { id: 'franquia-sync', nome: 'Sincronizador da franquia e revisão dos agendados velhos', estado: 'ligado', executou: true, movidos: 8, moveria: 0 },
    ],
    camposGravados: 14,
    semCartao: 3,
  };
  const { deps } = montar({ etapas });
  const r = await faxinaDaUnidade(ctx(), deps);
  const d = detalhesDaUnidade(r).join('\n');
  assert.match(d, /Parados e estoques parados está desligada nesta unidade: não mexi \(a última leitura no papel dizia que moveria 9\)/);
  assert.match(d, /Sincronizador da franquia e revisão dos agendados velhos moveu 8/);
  assert.match(d, /14 gravados pelo sincronizador/);
  assert.match(linhaDaUnidade(r, 'outubro'), /8 etapas corrigidas \(última varredura\)/);
});

test('automação que não deu número: o relatório mostra a nota REAL (sem resumo / velha demais), nunca «faria pedir uma passada» (a faxina não pede passada)', async () => {
  const etapas: ResultadoEtapas = {
    automacoes: [
      { id: 'parados', nome: 'Parados e estoques parados', estado: 'ligado', executou: false, movidos: 0, moveria: 0, nota: 'sem resumo de varredura (ainda não varreu desde o último reinício do servidor, ou a última falhou)' },
      { id: 'franquia-sync', nome: 'Sincronizador', estado: 'ligado', executou: false, movidos: 0, moveria: 0, nota: 'a última varredura foi há 600 min: velha demais para contar' },
    ],
    camposGravados: 0,
    semCartao: 0,
  };
  for (const modo of ['seco', 'ligado'] as const) {
    const { deps } = montar({ etapas, motivos: { estado: 'ligado', executou: false, gravados: 0, gravaria: 0, nota: 'está ligada; a faxina em só no papel não a dispara' } });
    const r = await faxinaDaUnidade(ctx({ modo }), deps);
    const d = detalhesDaUnidade(r).join('\n');
    assert.doesNotMatch(d, /faria pedir/);
    assert.match(d, /Parados e estoques parados sem número desta vez \(sem resumo de varredura/);
    assert.match(d, /Sincronizador sem número desta vez \(a última varredura foi há 600 min: velha demais para contar\)/);
    assert.match(d, /motivo de perda: não rodou \(está ligada; a faxina em só no papel não a dispara\)/);
  }
});

test('automação DESLIGADA: o «moveria» dela (histórico de 30 dias do papel) NÃO entra na linha da unidade nem no TOTAL; o detalhe só cita', async () => {
  const etapas: ResultadoEtapas = {
    automacoes: [
      { id: 'parados', nome: 'Parados e estoques parados', estado: 'desligado', executou: false, movidos: 0, moveria: 40 },
      { id: 'franquia-sync', nome: 'Sincronizador', estado: 'seco', executou: true, movidos: 0, moveria: 3 },
    ],
    camposGravados: 0,
    semCartao: 0,
  };
  for (const modo of ['ligado', 'seco'] as const) {
    const { deps } = montar({ etapas });
    const r = await faxinaDaUnidade(ctx({ modo }), deps);
    assert.deepEqual(etapasDaUnidade(r), { movidas: 0, moveria: 3 });
    const linha = linhaDaUnidade(r, 'outubro');
    assert.doesNotMatch(linha, /43/);
    assert.match(linha, modo === 'seco' ? /3 etapas que as automações em papel moveriam/ : /\(\+3 no papel\)/);
    assert.match(detalhesDaUnidade(r).join('\n'), /Parados e estoques parados está desligada nesta unidade: não mexi \(a última leitura no papel dizia que moveria 40\)/);
    const [m] = montarRelatorio([r], { mes: 'outubro' });
    assert.match(m, /ETAPAS \(última varredura das automações, não é a faxina\): 0 movidas de verdade · 3 moveriam \(só no papel\)/);
  }
});

// ─── janela, relatório e catálogo ─────────────────────────────────────────────────────────────────

test('janela: dia 1, entre 2h e 7h de São Paulo; no dia 1 o relatório fala do mês que acabou', () => {
  const dentro = janelaDaFaxina(new Date('2026-12-01T05:30:00Z')); // 02:30 em SP
  assert.equal(dentro.dentro, true);
  assert.equal(dentro.chaveDoMes, '2026-12');
  assert.equal(dentro.mesDoRelatorio, 'novembro');
  assert.equal(janelaDaFaxina(new Date('2026-12-01T02:30:00Z')).dentro, false, '23:30 do dia 30 em SP');
  assert.equal(janelaDaFaxina(new Date('2026-12-01T10:30:00Z')).dentro, false, '07:30 em SP: tarde demais para começar unidade');
  assert.equal(janelaDaFaxina(new Date('2026-12-02T05:30:00Z')).dentro, false, 'dia 2');
  assert.equal(janelaDaFaxina(new Date('2027-01-01T05:30:00Z')).mesDoRelatorio, 'dezembro', 'virada de ano');
  assert.equal(janelaDaFaxina(new Date('2026-11-15T15:00:00Z')).mesDoRelatorio, 'novembro', 'fora do dia 1, o mês corrente');
});

test('relatório: total da rede, erro por unidade e quebra em mensagens sem partir unidade', async () => {
  const { deps } = montar({ tarefas: [tarefa(1), tarefa(2)] });
  const a = await faxinaDaUnidade(ctx(), deps);
  const b = await faxinaDaUnidade(ctx({ slug: 'mossoro', nome: 'Mossoró' }), montar({ falhaAoListarTarefas: new Error('x') }).deps);
  const [um] = montarRelatorio([a, b], { mes: 'outubro' });
  assert.match(um, /TOTAL DA REDE \(2 unidades: 2 ligadas, 0 só no papel\)\nGRAVADO pela faxina \(2 unidades ligadas\): 0 duplicados juntados · 2 tarefas velhas fechadas/);
  assert.match(um, /Com erro em: Mossoró/);

  const muitas = Array.from({ length: 60 }, (_, i) => ({ ...a, slug: `u${i}`, nome: `Unidade ${i}`, avisos: ['x'.repeat(200)] }));
  const msgs = montarRelatorio(muitas, { mes: 'outubro' });
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.length < 3600, 'cabe no Telegram (o envio corta em 3500)');
  assert.match(msgs[msgs.length - 1], /TOTAL DA REDE \(60 unidades: 60 ligadas, 0 só no papel\)/);
  assert.equal(msgs.join('\n').match(/Unidade 7,/g)?.length, 1, 'cada unidade aparece uma vez');
});

test('relatório: bloco enorme não gera mensagem só com cabeçalho; rodapé com muitos nomes é encurtado', async () => {
  const { deps } = montar({ tarefas: [tarefa(1)] });
  const base = await faxinaDaUnidade(ctx(), deps);
  const gigante = { ...base, avisos: Array.from({ length: 60 }, () => 'y'.repeat(200)) };
  const nomes = Array.from({ length: 80 }, (_, i) => `Unidade ${i}`);
  const msgs = montarRelatorio([gigante, base], { mes: 'outubro', naoComecaram: nomes });
  for (const m of msgs) {
    assert.ok(m.length < 3600);
    assert.ok(m.replace(/^Faxina do mês, outubro[^\n]*/, '').trim().length > 0, 'nenhuma mensagem só com cabeçalho');
  }
  assert.match(msgs.join('\n'), /e mais 65/);
});

test('relatório: sem total (lotes intermediários) não traz TOTAL nem lista de quem não começou', async () => {
  const { deps } = montar();
  const a = await faxinaDaUnidade(ctx(), deps);
  const [m] = montarRelatorio([a], { mes: 'outubro', semTotal: true, naoComecaram: ['X'], totalDe: [a, a] });
  assert.doesNotMatch(m, /TOTAL DA REDE|Não deu tempo/);
});

test('relatório em seco anuncia, no alto, que nada foi gravado', async () => {
  const { deps } = montar({ tarefas: [tarefa(1)] });
  const r = await faxinaDaUnidade(ctx({ modo: 'seco' }), deps);
  const [m] = montarRelatorio([r], { mes: 'outubro', quando: 'sob-demanda' });
  assert.match(m, /^Faxina do mês, outubro \(SÓ NO PAPEL: nada foi gravado no Kommo, o que segue é o que ela FARIA\) - rodada sob demanda/);
  assert.match(m, /TOTAL DA REDE \(1 unidade: 0 ligadas, 1 só no papel\)/);
  assert.match(m, /SÓ NO PAPEL, nada gravado \(1 unidade\): faria juntar 0 duplicados · faria fechar 1 tarefa velha · tiraria 0 etiquetas ▶/);
  assert.doesNotMatch(m, /GRAVADO pela faxina/);
});

test('catálogo: faxina-do-mes nasce DESLIGADA, tem seco e exige seco antes de ligar', () => {
  assert.deepEqual(verificarCatalogo(), []);
  const a = automacaoPorId('faxina-do-mes');
  assert.ok(a);
  assert.equal(a.chave, 'FAXINA_DO_MES_SLUGS');
  assert.equal(a.quandoVazio, 'desligado');
  assert.equal(a.temSeco, true);
  assert.equal(a.exigeSecoAntes, true);
  assert.ok(AUTOMACOES.filter((x) => x.id === 'faxina-do-mes').length === 1);
});

// ─── passo 1 sobre o `rodarConta` do #233: mapeamento do resumo ──────────────────────────────────

import { ehFreioDoKommo, resumoParaRelatorio } from './faxina-duplicados.js';

const resumoDe = (extra: Partial<ResumoDaRodada> = {}): ResumoDaRodada =>
  ({ unit: 'timbo', lidos: 0, foraDeEscopo: 0, aguardando: 0, jaVistos: 0, avaliados: 0, vinculados: 0, aceitos: 0, vincularia: 0, aceitaria: 0, ambiguos: 0, semParVelho: 0, semTelefone: 0, jaResolvidos: 0, adiados: 0, erros: 0, listaTruncada: false, encerrouCedo: null, ...extra });

test('freio: 429/5xx/rede e falha ao LER a caixa são freio; 403/401 de token e perda de liderança não (mas deixam a unidade incompleta)', () => {
  assert.equal(ehFreioDoKommo('o Kommo falhou (429, 5xx ou rede): a conta descansa 5 minutos e tento de novo'), true);
  assert.equal(ehFreioDoKommo('não consegui ler o Kommo: KommoApiError: listarEntrada: 429'), true);
  assert.equal(ehFreioDoKommo('não consegui ler o Kommo: KommoApiError: listarEntrada: status code 403'), false);
  assert.equal(ehFreioDoKommo('o Kommo recusou uma leitura (403: token sem escopo de contatos?): a conta descansa por 1 hora'), false);
  for (const msg of ['o worker foi parado no meio da rodada', 'o Kommo recusou uma leitura (403)', 'três erros seguidos que não passam sozinhos (token sem direito?)']) {
    const r = resumoParaRelatorio(resumoDe({ encerrouCedo: msg }), true);
    assert.equal(r.incompleto, false, `${msg}: só aviso, não interrompe`);
    assert.equal(r.freio, false, msg);
    assert.ok(r.avisos.some((a) => a.includes(msg)));
  }
  assert.equal(resumoParaRelatorio(resumoDe({ encerrouCedo: 'o Kommo falhou (429, 5xx ou rede): a conta descansa' }), true).incompleto, true);
  assert.equal(resumoParaRelatorio(resumoDe(), true).incompleto, false);
});

test('mapeamento: teto da faxina vira aviso; sem telefone não vira "Kommo não deixou ler"; ambíguos repetidos viram um link só', () => {
  const r = resumoParaRelatorio(resumoDe({ avaliados: 100, vinculados: 60, semTelefone: 200, ambiguos: 5 }), true, [{ cartoes: [9, 8] }, { cartoes: [8, 9] }, { cartoes: [7] }]);
  assert.match(r.avisos.join('\n'), /bateu o teto \(100 chats olhados, 60 vínculos\)/);
  assert.match(r.avisos.join('\n'), /200 chats sem telefone no contato ficaram na caixa/);
  assert.match(r.avisos.join('\n'), /2 chats com mais de um cartão aberto no mesmo telefone ficaram na caixa, sem link/);
  assert.equal(r.equipe.length, 2, 'o par {8,9} aparece uma vez');
  assert.equal(r.juntados, 60);
});

test('seco: o resumo do #233 em «seco» conta vincularia como «juntaria» e nada é escrito', async () => {
  const { deps, g } = montar({ entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }], contatos: contatosDoUm, cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }] });
  const r = await faxinaDaUnidade(ctx({ modo: 'seco' }), deps);
  assert.deepEqual(g.vinculos, []);
  assert.equal(r.duplicados.juntados, 1);
});

// ─── relatório: GRAVADO × SÓ NO PAPEL nunca se misturam ─────────────────────────────────────────

test('rede MISTA: Timbó ligada + Mossoró em papel — o total separa o GRAVADO do «faria», nada vira «a juntar» para o que foi feito', async () => {
  const t = montar({ entradas: [{ uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 }], contatos: contatosDoUm, cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }], tarefas: [tarefa(1), tarefa(2)], etiquetas: ['▶ Boas-vindas'], cartoesDaEtiqueta: { '▶ Boas-vindas': [{ id: 77, name: 'x', status_id: 1, pipeline_id: 1, updated_at: AGORA - 20 * DIA }] } });
  const m = montar({ tarefas: [tarefa(5), tarefa(6), tarefa(7)] });
  const timbo = await faxinaDaUnidade(ctx(), t.deps);
  const mossoro = await faxinaDaUnidade(ctx({ slug: 'mossoro', nome: 'Mossoró', modo: 'seco' }), m.deps);
  assert.equal(t.g.fechadas.length, 2);
  assert.equal(m.g.fechadas.length, 0);
  const [msg] = montarRelatorio([timbo, mossoro], { mes: 'outubro' });
  assert.match(msg, /TOTAL DA REDE \(2 unidades: 1 ligadas, 1 só no papel\)/);
  assert.match(msg, /GRAVADO pela faxina \(1 unidade ligada\): 1 duplicado juntado · 2 tarefas velhas fechadas · 1 etiqueta ▶ tirada/);
  assert.match(msg, /SÓ NO PAPEL, nada gravado \(1 unidade\): faria juntar 0 duplicados · faria fechar 3 tarefas velhas · tiraria 0 etiquetas ▶/);
  assert.doesNotMatch(msg, /\ba (juntar|fechar|tirar)\b/);
  assert.match(msg, /PRECISAM DA EQUIPE \(todas as unidades\): 0/);
});

test('linha em SECO não soma «já movidas de verdade» pelas automações com «moveria»', async () => {
  const etapas: ResultadoEtapas = {
    automacoes: [
      { id: 'parados', nome: 'Parados', estado: 'ligado', executou: true, movidos: 6, moveria: 0 },
      { id: 'franquia-sync', nome: 'Sincronizador', estado: 'seco', executou: true, movidos: 0, moveria: 4 },
    ],
    camposGravados: 0,
    semCartao: 0,
  };
  const { deps } = montar({ etapas });
  const r = await faxinaDaUnidade(ctx({ modo: 'seco' }), deps);
  const linha = linhaDaUnidade(r, 'outubro');
  assert.match(linha, /4 etapas que as automações em papel moveriam/);
  assert.match(linha, /6 etapas já movidas de verdade pelas próprias automações \(última varredura, não é a faxina\)/);
  assert.doesNotMatch(linha, /10 etapas/);
  const [m] = montarRelatorio([r], { mes: 'outubro' });
  assert.match(m, /ETAPAS \(última varredura das automações, não é a faxina\): 6 movidas de verdade · 4 moveriam \(só no papel\)/);
});

test('unidade retomada aparece duas vezes nos lotes, mas o TOTAL conta só a última rodada dela', async () => {
  const { deps } = montar({ tarefas: [tarefa(1), tarefa(2)] });
  const a = await faxinaDaUnidade(ctx(), deps);
  const b = { ...a, tarefas: { ...a.tarefas, fechadas: 5 } };
  const msgs = montarRelatorio([b], { mes: 'outubro', totalDe: [a, b] });
  assert.match(msgs.join('\n'), /5 tarefas velhas fechadas/);
  assert.doesNotMatch(msgs.join('\n'), /7 tarefas/);
});

test('perdeu a liderança entre os passos: para na hora (nem tarefas, nem etapas, nem etiquetas) e fica interrompida', async () => {
  const { deps, g } = montar({ tarefas: [tarefa(1)], etiquetas: ['▶ Boas-vindas'] });
  deps.lider = () => false;
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(g.fechadas.length, 0);
  assert.equal(g.etapasPedidas, 0);
  assert.equal(r.interrompida, true);
  assert.ok(r.avisos.some((a) => /perdeu a liderança/.test(a)));
});

test('perdeu a liderança no meio das tarefas: para de fechar e conta as que sobraram', async () => {
  const { deps, g } = montar({ tarefas: Array.from({ length: 10 }, (_, i) => tarefa(i + 1)) });
  let n = 0;
  deps.lider = () => n++ < 6; // checagens: passo 2 (1), passo 3... só até a 4ª tarefa
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.ok(g.fechadas.length > 0 && g.fechadas.length < 10);
  assert.equal(r.tarefas.fechadas + r.tarefas.sobraram, 10);
  assert.equal(r.interrompida, true);
});

test('lista de etiquetas cortada em 1.000: avisa', async () => {
  const nomes = Array.from({ length: 1000 }, (_, i) => `Etiqueta ${i}`);
  const { deps } = montar({ etiquetas: nomes });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.ok(r.avisos.some((a) => /mais de 1000 etiquetas/.test(a)));
});

test('chats adiados (mesmo telefone na mesma rodada) são chamados de adiados, não de «teto»', async () => {
  const { deps } = montar({
    entradas: [
      { uid: 'u1', leadId: 10, contatoId: 1, categoria: 'chats', criadoEm: 1 },
      { uid: 'u2', leadId: 11, contatoId: 3, categoria: 'chats', criadoEm: 2 },
    ],
    contatos: [...contatosDoUm, { id: 3, telefones: ['47 98818-8666'], leadIds: [11] }],
    cartoes: [{ id: 500, status_id: 100, pipeline_id: 1 }],
  });
  const r = await faxinaDaUnidade(ctx(), deps);
  assert.equal(r.duplicados.sobraram, 1);
  assert.match(detalhesDaUnidade(r).join('\n'), /1 chats adiados \(outro chat do mesmo telefone foi tratado agora\)/);
});
