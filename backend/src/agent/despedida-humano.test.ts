import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';

import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { AUTOMACOES } from '../lib/automacoes.js';
import { REGRA_DESPEDIDA } from '../lib/sem-resposta-worker.js';
import type { KommoTarefa } from '../services/kommo.service.js';
import type { Fala } from './repeticao.js';
import { pacienteEncerrou, renderPacienteEncerrou, empurraHorario, semEmpurrarHorario, DESPEDIDA_CURTA } from './paciente-encerrou.js';
import { avaliarChamadaFinal } from './cta-final.js';
import {
  AUTOMACAO_DESPEDIDA_HUMANO,
  PRAZO_TAREFA_S,
  TAREFA_VELHA_MS,
  decidirDespedida,
  detectarDespedida,
  estadoDaDespedidaHumano,
  iaTerminouPerguntando,
  textoDaNota,
  textoDaTarefa,
  turnoFicouEmSilencio,
  type DepsDaDespedida,
} from './despedida-humano.js';

const TIMBO = 'doutor-hernia-timbo';
const unit = { id: 'u-timbo', slug: TIMBO, name: 'Doutor Hérnia Timbó' } as unknown as Unit;
const AGORA = new Date('2026-11-06T15:00:00Z');

const ia = (texto: string): Fala => ({ papel: 'ia', texto });
const pac = (texto: string): Fala => ({ papel: 'paciente', texto });

/** A conversa real de Timbó (06/11/2026): a Sofia deu o preço, o paciente adiou. */
const CASO_REAL: Fala[] = [
  pac('Oi, quanto custa a consulta?'),
  ia('A consulta é R$ 250,00, com avaliação completa da coluna. Posso ver um horário pra você?'),
  pac('Obrigada, entro em contato para agendar logo mais'),
];

// ── o caso real e as variações de adiamento / despedida ─────────────────────────────────────────

test('o caso real de Timbó: "Obrigada, entro em contato para agendar logo mais" é adiamento', () => {
  const d = detectarDespedida(CASO_REAL);
  assert.equal(d?.tipo, 'adiou');
  assert.equal(d?.fala, 'Obrigada, entro em contato para agendar logo mais');
  // e o detector antigo NÃO via isto: era por isso que a Sofia respondia "Combinado então!"
  assert.equal(pacienteEncerrou(CASO_REAL), null);
});

for (const fala of [
  'Agora não vou querer, obrigada',
  'agora não',
  'Vou pensar e te falo',
  'vou pensar',
  'Depois eu vejo, obrigado',
  'Mais pra frente eu marco',
  'Por enquanto não, obrigada',
  'No momento não',
  'Entrarei em contato quando eu decidir',
  'Vou conversar com meu marido, depois te aviso',
  'Amanhã eu te chamo',
  'Qualquer coisa eu te chamo, obrigado!',
  'Não vou querer marcar agora',
]) {
  test(`adiamento: "${fala}"`, () => {
    assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00.'), pac(fala)])?.tipo, 'adiou');
  });
}

for (const fala of ['Ok obrigada', 'Obrigado!', 'Muito obrigada pelas informações 🙏', 'Valeu', 'Tchau, até mais']) {
  test(`despedida simples depois de informação (sem pergunta da IA): "${fala}"`, () => {
    const d = detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00, com avaliação completa.'), pac(fala)]);
    assert.equal(d?.tipo, 'agradeceu');
  });
}

// ── falsos positivos ────────────────────────────────────────────────────────────────────────────

test('"Obrigada" respondendo a uma PERGUNTA da Sofia não é despedida', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00. Posso ver um horário pra você? ☺️'), pac('Obrigada')]), null);
  assert.equal(detectarDespedida([pac('oi'), ia('Qual período fica melhor?'), pac('Ok obrigado')]), null);
});

test('"Sim, obrigado" é resposta', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('Posso ver um horário pra você?'), pac('Sim, obrigado')]), null);
  assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250.'), pac('Sim, obrigada')]), null);
});

test('cumprimento sozinho não é despedida', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('Oi! Como posso ajudar?'), pac('Bom dia')]), null);
  assert.equal(detectarDespedida([pac('Boa tarde')]), null);
});

test('"ok" que só concorda depois de a IA ter fechado não aciona (nada novo a avisar)', () => {
  const falas = [pac('oi'), ia('Qualquer coisa é só me chamar por aqui!'), pac('Ok')];
  assert.equal(pacienteEncerrou(falas), 'concordou');
  assert.equal(detectarDespedida(falas), null);
});

test('primeira mensagem: ninguém a que se despedir', () => {
  assert.equal(detectarDespedida([pac('Obrigada, vou pensar')]), null);
  assert.equal(detectarDespedida([pac('obrigada')]), null);
});

test('pergunta ou pedido junto com o adiamento é conversa, não despedida', () => {
  const base = [pac('oi'), ia('A consulta é R$ 250,00.')];
  assert.equal(detectarDespedida([...base, pac('Agora não, mas qual o endereço?')]), null);
  assert.equal(detectarDespedida([...base, pac('Agora não consigo, pode ser quinta às 14h')]), null);
  assert.equal(detectarDespedida([...base, pac('Vou pensar, me passa o endereço')]), null);
  assert.equal(detectarDespedida([...base, pac('Obrigada. Tem estacionamento?')]), null);
});

test('irritação ("para de me mandar mensagem") é outro caso: não aciona aqui', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00.'), pac('Pare de me mandar mensagem, que chato')]), null);
});

test('mensagem longa é conversa', () => {
  const longa = 'Obrigada pela explicação, entro em contato. ' + 'Na verdade eu tenho uma dor há muito tempo e já fiz vários exames, '.repeat(4);
  assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00.'), pac(longa)]), null);
});

test('rajada do paciente no mesmo turno: vale o que ele disse seguido', () => {
  const d = detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00.'), pac('Obrigada'), pac('vou pensar')]);
  assert.equal(d?.tipo, 'adiou');
});

test('iaTerminouPerguntando: pergunta no fim (com emoji) conta; pergunta no meio não', () => {
  assert.equal(iaTerminouPerguntando('Posso ver um horário pra você? ☺️'), true);
  assert.equal(iaTerminouPerguntando('Posso ver um horário?'), true);
  assert.equal(iaTerminouPerguntando('Quer marcar? Fico à disposição.'), false);
  assert.equal(iaTerminouPerguntando('A consulta é R$ 250.'), false);
  assert.equal(iaTerminouPerguntando(null), false);
});

// ── a decisão (efeitos) ─────────────────────────────────────────────────────────────────────────

interface Chamadas {
  tarefas: Array<{ leadId: number; texto: string; completeAt: number; responsavel: number | null }>;
  notas: string[];
  marcas: Date[];
  simulacoes: Array<{ acao: string; alvo: string; leadId: number }>;
  passos: Array<{ kind: string; title: string }>;
  leituras: string[];
}

function montar(over: Partial<DepsDaDespedida> = {}, estado: { marca?: Date | null; iaFalou?: boolean; abertas?: KommoTarefa[] } = {}) {
  const c: Chamadas = { tarefas: [], notas: [], marcas: [], simulacoes: [], passos: [], leituras: [] };
  let marca = estado.marca ?? null;
  const deps: DepsDaDespedida = {
    agora: () => AGORA,
    avisoDeHoje: async () => {
      c.leituras.push('avisoDeHoje');
      return !!marca && AGORA.getTime() - marca.getTime() < 24 * 3600_000;
    },
    marcaEm: async () => marca,
    iaFalouDepois: async () => estado.iaFalou ?? false,
    tarefasAbertas: async () => {
      c.leituras.push('tarefasAbertas');
      return estado.abertas ?? [];
    },
    cartao: async () => {
      c.leituras.push('cartao');
      return { nome: 'Maria Souza', responsavel: 4242 };
    },
    criarTarefa: async (_u, leadId, texto, completeAt, responsavel) => {
      c.tarefas.push({ leadId, texto, completeAt, responsavel });
    },
    anotar: async (_u, _l, texto) => {
      c.notas.push(texto);
      return true;
    },
    marcar: async (_u, _l, quando) => {
      marca = quando;
      c.marcas.push(quando);
    },
    simular: (_u, _a, s) => c.simulacoes.push({ acao: s.acao, alvo: s.alvo, leadId: s.leadId }),
    ...over,
  };
  const recorder = {
    step: async (a: { kind: string; title: string }) => {
      c.passos.push({ kind: a.kind, title: a.title });
    },
  };
  return { c, deps, recorder: recorder as never };
}

const entrada = (recorder: never, over: Record<string, unknown> = {}) => ({
  unit,
  leadId: 777,
  estado: 'ligado' as const,
  falas: CASO_REAL,
  temConsulta: false,
  recorder,
  ...over,
});

test('LIGADO + caso real: Sofia em silêncio, tarefa ALERTA com prazo e responsável, nota, marca do dia', async () => {
  const { c, deps, recorder } = montar();
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(c.tarefas.length, 1);
  const t = c.tarefas[0];
  assert.match(t.texto, /^ALERTA · doutor-hernia-timbo · \[DESPEDIDA\] \[Contato: Maria Souza\] Paciente adiou e ainda não marcou — vale um contato humano\./);
  assert.match(t.texto, /Última fala: "Obrigada, entro em contato para agendar logo mais"\. A Sofia não respondeu\.$/);
  assert.equal(t.leadId, 777);
  assert.equal(t.responsavel, 4242);
  assert.equal(t.completeAt, Math.floor(AGORA.getTime() / 1000) + PRAZO_TAREFA_S);
  assert.equal(c.notas.length, 1);
  assert.match(c.notas[0], /ficou em silêncio\. Tarefa criada para a equipe\./);
  assert.equal(c.marcas.length, 1);
  assert.ok(c.passos.some((p) => p.kind === 'KOMMO_ACTION'));
});

test('LIGADO + agradeceu sem adiar: também avisa', async () => {
  const { c, deps, recorder } = montar();
  const falas = [pac('oi'), ia('A consulta é R$ 250,00.'), pac('Ok, muito obrigada!')];
  const r = await decidirDespedida(entrada(recorder, { falas }), deps);
  assert.equal(r.acao, 'silenciar');
  assert.match(c.tarefas[0].texto, /Paciente agradeceu\/se despediu e ainda não marcou/);
});

test('LIGADO + consulta marcada: responde como hoje, sem tarefa, sem tocar no Kommo', async () => {
  const { c, deps, recorder } = montar();
  const r = await decidirDespedida(entrada(recorder, { temConsulta: true }), deps);
  assert.equal(r.acao, 'responder');
  assert.deepEqual(c.tarefas, []);
  assert.deepEqual(c.notas, []);
  assert.deepEqual(c.marcas, []);
  assert.deepEqual(c.leituras, []);
});

test('LIGADO + não é despedida: responde, sem tocar em nada', async () => {
  const { c, deps, recorder } = montar();
  const falas = [pac('oi'), ia('A consulta é R$ 250,00. Posso ver um horário?'), pac('Pode sim, obrigada')];
  const r = await decidirDespedida(entrada(recorder, { falas }), deps);
  assert.equal(r.acao, 'responder');
  assert.deepEqual(c.leituras, []);
  assert.deepEqual(c.tarefas, []);
});

test('DESLIGADO: nada é lido, nada é escrito, a Sofia responde (comportamento idêntico ao de hoje)', async () => {
  const { c, deps, recorder } = montar();
  const r = await decidirDespedida(entrada(recorder, { estado: 'desligado' }), deps);
  assert.equal(r.acao, 'responder');
  assert.deepEqual(c, { tarefas: [], notas: [], marcas: [], simulacoes: [], passos: [], leituras: [] });
});

test('SECO: registra "alertaria", não escreve no Kommo e a Sofia responde como hoje', async () => {
  const { c, deps, recorder } = montar();
  const r = await decidirDespedida(entrada(recorder, { estado: 'seco' }), deps);
  assert.equal(r.acao, 'responder');
  assert.equal(r.motivo, 'só no papel');
  assert.deepEqual(c.tarefas, []);
  assert.deepEqual(c.notas, []);
  assert.deepEqual(c.marcas, []);
  assert.deepEqual(c.leituras, []);
  assert.equal(c.simulacoes.length, 1);
  assert.equal(c.simulacoes[0].acao, 'alertaria');
  assert.equal(c.simulacoes[0].leadId, 777);
  assert.match(c.passos[0].title, /só no papel.*ficaria em silêncio e avisaria a equipe/);
});

test('SECO + consulta marcada: nem simula', async () => {
  const { c, deps, recorder } = montar();
  await decidirDespedida(entrada(recorder, { estado: 'seco', temConsulta: true }), deps);
  assert.deepEqual(c.simulacoes, []);
});

test('1 aviso por cartão por dia: o segundo "obrigada" sem a Sofia ter falado depois segue em silêncio, SEM tarefa nova', async () => {
  const { c, deps, recorder } = montar({}, { marca: new Date(AGORA.getTime() - 3600_000), iaFalou: false });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(r.acao === 'silenciar' && r.alertou, false);
  assert.deepEqual(c.tarefas, []);
  assert.deepEqual(c.notas, []);
});

test('1 aviso por dia: se a Sofia FALOU depois do aviso, a despedida nova não cala (não há aviso novo): responde como hoje', async () => {
  const { c, deps, recorder } = montar({}, { marca: new Date(AGORA.getTime() - 3600_000), iaFalou: true });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'responder');
  assert.deepEqual(c.tarefas, []);
});

test('depois de 24 h o aviso vale de novo', async () => {
  const { c, deps, recorder } = montar({}, { marca: new Date(AGORA.getTime() - 25 * 3600_000) });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(c.tarefas.length, 1);
});

test('duas despedidas seguidas no mesmo minuto: só a primeira cria tarefa (a marca é gravada antes do próximo turno)', async () => {
  const { c, deps, recorder } = montar();
  const a = await decidirDespedida(entrada(recorder), deps);
  const b = await decidirDespedida(entrada(recorder), deps);
  assert.equal(a.acao, 'silenciar');
  assert.equal(b.acao, 'silenciar');
  assert.equal(c.tarefas.length, 1);
});

test('já há tarefa aberta da equipe no cartão: não empilha, a Sofia fica em silêncio e a nota diz o porquê', async () => {
  const aberta: KommoTarefa = { id: 1, text: 'Ligar para o paciente', is_completed: false, complete_till: Math.floor(AGORA.getTime() / 1000) + 3600, entity_id: 777, entity_type: 'leads' };
  const { c, deps, recorder } = montar({}, { abertas: [aberta] });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.deepEqual(c.tarefas, []);
  assert.match(c.notas[0], /Já há tarefa aberta da equipe neste cartão\./);
  assert.equal(c.marcas.length, 1);
});

test('tarefa aberta mas vencida há mais de 3 dias é lixo antigo: não segura o aviso', async () => {
  const velha: KommoTarefa = { id: 2, is_completed: false, complete_till: Math.floor((AGORA.getTime() - TAREFA_VELHA_MS - 3600_000) / 1000) };
  const { c, deps, recorder } = montar({}, { abertas: [velha] });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(c.tarefas.length, 1);
});

test('não consegui ler as tarefas do cartão: segue e cria a minha (melhor um aviso a mais que silêncio)', async () => {
  const { c, deps, recorder } = montar({
    tarefasAbertas: async () => {
      throw new Error('503');
    },
  });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(c.tarefas.length, 1);
});

test('FALHA ao criar a tarefa: a Sofia NÃO fica muda — responde como hoje, sem marca, e o erro fica no rastro', async () => {
  const { c, deps, recorder } = montar({
    criarTarefa: async () => {
      throw new Error('Kommo 500');
    },
  });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'responder');
  assert.match(r.motivo, /tarefa falhou: Kommo 500/);
  assert.deepEqual(c.marcas, [], 'sem marca: o próximo turno tenta de novo');
  assert.deepEqual(c.notas, []);
  const erro = c.passos.find((p) => p.kind === 'ERROR');
  assert.ok(erro, 'erro visível no rastro');
  assert.match(erro!.title, /FALHOU.*ninguém foi avisado/);
});

test('sem o cartão (nome/responsável): a tarefa sai assim mesmo, sem responsável', async () => {
  const { c, deps, recorder } = montar({ cartao: async () => null });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(c.tarefas[0].responsavel, null);
  assert.doesNotMatch(c.tarefas[0].texto, /\[Contato:/);
});

test('imprevisto na decisão (dependência explode): responde como hoje, nunca lança', async () => {
  const { deps, recorder } = montar({
    avisoDeHoje: async () => {
      throw new Error('banco caiu');
    },
  });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'responder');
  assert.match(r.motivo, /imprevisto/);
});

test('sem leadId válido: responde', async () => {
  const { c, deps, recorder } = montar();
  const r = await decidirDespedida(entrada(recorder, { leadId: 0 }), deps);
  assert.equal(r.acao, 'responder');
  assert.deepEqual(c.tarefas, []);
});

test('o texto da tarefa mascara dado pessoal e é curto', () => {
  const t = textoDaTarefa({
    slug: TIMBO,
    contato: null,
    despedida: { tipo: 'adiou', fala: 'Vou pensar, meu telefone é (47) 99988-7766 e o CPF 529.982.247-25 ' + 'x'.repeat(300) },
  });
  assert.doesNotMatch(t, /99988/);
  assert.doesNotMatch(t, /529\.982/);
  assert.ok(t.length < 400);
  assert.match(textoDaNota({ tipo: 'agradeceu', fala: 'obrigada' }, 'aviso_de_hoje'), /A equipe já foi avisada hoje\./);
});

// ── a chave: catálogo e estado ──────────────────────────────────────────────────────────────────

test('catálogo: despedida-humano nasce DESLIGADA, tem modo seco e cria tarefa', () => {
  const a = AUTOMACOES.find((x) => x.id === AUTOMACAO_DESPEDIDA_HUMANO);
  assert.ok(a);
  assert.equal(a!.chave, 'DESPEDIDA_HUMANO_SLUGS');
  assert.equal(a!.quandoVazio, 'desligado');
  assert.equal(a!.temSeco, true);
  assert.equal(a!.risco, 'cria-tarefa');
});

test('estado: sem chave, TODA unidade (inclusive Timbó) está desligada; ligada só onde listada ou gravada na tela', () => {
  _semearParaTeste([]);
  assert.equal(estadoDaDespedidaHumano(TIMBO, {}), 'desligado');
  assert.equal(estadoDaDespedidaHumano('doutor-hernia-serra', { DESPEDIDA_HUMANO_SLUGS: '' }), 'desligado');
  assert.equal(estadoDaDespedidaHumano(TIMBO, { DESPEDIDA_HUMANO_SLUGS: TIMBO }), 'ligado');
  assert.equal(estadoDaDespedidaHumano('doutor-hernia-serra', { DESPEDIDA_HUMANO_SLUGS: TIMBO }), 'desligado');
  _semearParaTeste([{ slug: TIMBO, automacao: AUTOMACAO_DESPEDIDA_HUMANO, estado: 'seco' }]);
  assert.equal(estadoDaDespedidaHumano(TIMBO, {}), 'seco');
  assert.equal(estadoDaDespedidaHumano('doutor-hernia-serra', {}), 'desligado');
  _semearParaTeste([]);
});

test('a marca do aviso é a mesma que o alerta de "sem resposta" lê', () => {
  assert.equal(REGRA_DESPEDIDA, 'despedida_humano');
});

// ── desligado = comportamento IDÊNTICO ao de hoje (a regra de despedida curta do João não foi tocada) ───

test('regra de despedida curta (paciente-encerrou) continua igual: "Obrigado" → bloco, corte do empurrão e juiz da pergunta final', () => {
  const falas = [pac('oi'), ia('A consulta é R$ 250,00.'), pac('Ok obrigada')];
  assert.equal(pacienteEncerrou(falas), 'agradeceu');
  assert.match(renderPacienteEncerrou(falas), /Responda CURTO \(1 a 2 frases\) e caloroso/);
  const agora = '2026-11-06T10:00:00';
  const comEmpurrao = 'Eu que agradeço! Posso ver um horário pra você, fica melhor às 14h ou 16h?';
  assert.equal(empurraHorario(comEmpurrao, agora), true);
  assert.equal(semEmpurrarHorario(comEmpurrao, agora, 'agradeceu'), 'Eu que agradeço!');
  assert.equal(semEmpurrarHorario('Posso ver um horário pra você, fica melhor às 14h?', agora, 'agradeceu'), DESPEDIDA_CURTA);
  assert.deepEqual(avaliarChamadaFinal('Eu que agradeço!', { pacienteEncerrou: true }), { precisaRefazer: false, motivo: null });
});

test('o caso real: com a chave desligada a decisão é "responder" e nenhum efeito acontece — a Sofia segue como hoje', async () => {
  const { c, deps, recorder } = montar();
  const r = await decidirDespedida(entrada(recorder, { estado: estadoDaDespedidaHumano(TIMBO, {}) }), deps);
  assert.equal(r.acao, 'responder');
  assert.equal(c.tarefas.length + c.notas.length + c.marcas.length + c.simulacoes.length + c.passos.length + c.leituras.length, 0);
});

// ── silêncio no grafo: canais que mandariam texto de espera ─────────────────────────────────────

test('turnoFicouEmSilencio: última mensagem é do paciente = silêncio; resposta ou ferramenta = não', () => {
  assert.equal(turnoFicouEmSilencio([new AIMessage('oi'), new HumanMessage('obrigada')]), true);
  assert.equal(turnoFicouEmSilencio([new HumanMessage('obrigada'), new AIMessage('de nada')]), false);
  assert.equal(turnoFicouEmSilencio([new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'x', args: {} }] }), new ToolMessage({ content: 'ok', tool_call_id: 'a' })]), false);
  assert.equal(turnoFicouEmSilencio([]), false);
  assert.equal(turnoFicouEmSilencio(undefined), false);
});
