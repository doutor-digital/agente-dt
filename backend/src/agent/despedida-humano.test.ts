import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { AUTOMACAO_DESPEDIDA_HUMANO as ID_DA_AUTOMACAO } from '../lib/despedida-humano-estado.js';
import { AUTOMACOES } from '../lib/automacoes.js';
import { REGRA_DESPEDIDA } from '../lib/aviso-dedupe.js';
import type { KommoTarefa } from '../services/kommo.service.js';
import type { Fala } from './repeticao.js';
import { pacienteEncerrou, renderPacienteEncerrou, empurraHorario, semEmpurrarHorario, DESPEDIDA_CURTA } from './paciente-encerrou.js';
import { avaliarChamadaFinal } from './cta-final.js';
import {
  AUTOMACAO_DESPEDIDA_HUMANO,
  PRAZO_TAREFA_S,
  decidirDespedida,
  detectarDespedida,
  estadoDaDespedidaHumano,
  iaTerminouPerguntando,
  tarefaDaEquipeSegura,
  temSinalOuUrgencia,
  textoDaNota,
  textoDaTarefa,
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

test('depois que a Sofia se calou, a mensagem NOVA do paciente não herda o adiamento antigo: ela responde', () => {
  const calada = [pac('oi'), ia('A consulta é R$ 250,00. Posso ver um horário pra você?'), pac('Obrigada, entro em contato para agendar logo mais')];
  assert.equal(detectarDespedida(calada)?.tipo, 'adiou');
  // uma hora depois, sem a Sofia ter falado: as duas falas seguem no mesmo bloco sem resposta
  assert.equal(detectarDespedida([...calada, pac('Quero marcar sexta de manhã')]), null);
  assert.equal(detectarDespedida([...calada, pac('Qual o endereço da clínica')]), null);
  // e dois "obrigada" seguidos continuam sendo só despedida
  assert.equal(detectarDespedida([...calada, pac('ok obrigada 🙏')])?.tipo, 'adiou');
});

test('pergunta de um turno que falhou (sem resposta) + "obrigada": a pergunta ainda deve ser respondida', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00.'), pac('Aceita convênio'), pac('obrigada')]), null);
});

test('"agora não" respondendo a pergunta da Sofia, ou fala longa, é informação — não adiamento', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('Você está com dor agora?'), pac('Agora não')]), null);
  assert.equal(detectarDespedida([pac('oi'), ia('Você tem exames recentes?'), pac('Agora não tenho em mãos, mas fiz ressonância')]), null);
  assert.equal(detectarDespedida([pac('oi'), ia('Você pretende operar?'), pac('Não vou fazer cirurgia, só tratar')]), null);
  // "agora não vou querer" respondendo a uma oferta dela é RECUSA, não adiamento: a Sofia responde
  assert.equal(detectarDespedida([pac('oi'), ia('Posso ver um horário?'), pac('Agora não vou querer')]), null);
  // o adiamento inequívoco vale mesmo depois de uma pergunta dela
  assert.equal(detectarDespedida([pac('oi'), ia('Posso ver um horário?'), pac('Vou pensar')])?.tipo, 'adiou');
});

test('a Sofia tinha PEDIDO algo (sem "?"): "ok obrigada" é resposta, não despedida', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('Me envie o comprovante do Pix por aqui, por favor.'), pac('Ok obrigada')]), null);
  assert.equal(detectarDespedida([pac('oi'), ia('Vou confirmar com a equipe e já te retorno.'), pac('Ok obrigada')]), null);
});

test('negociar horário sem "h" ("só posso às 9") é conversa', () => {
  assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00.'), pac('Depois eu vejo, só posso às 9')]), null);
  assert.equal(detectarDespedida([pac('oi'), ia('A consulta é R$ 250,00.'), pac('Agora não consigo de manhã, só às 14')]), null);
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
  assert.equal(iaTerminouPerguntando('Quer marcar? Fico à disposição.'), true, 'pergunta + frase curta continua sendo pergunta');
  assert.equal(iaTerminouPerguntando('Quer marcar a consulta? Se preferir, posso explicar com calma como funciona o atendimento aqui na clínica.'), false);
  assert.equal(iaTerminouPerguntando('A consulta é R$ 250.'), false);
  assert.equal(iaTerminouPerguntando(null), false);
});

// ── a decisão (efeitos) ─────────────────────────────────────────────────────────────────────────

interface Chamadas {
  tarefas: Array<{ leadId: number; texto: string; completeAt: number; responsavel: number | null }>;
  notas: string[];
  marcas: Date[];
  ultimas: Date[];
  simulacoes: Array<{ acao: string; alvo: string; leadId: number }>;
  passos: Array<{ kind: string; title: string }>;
  leituras: string[];
}

function montar(over: Partial<DepsDaDespedida> = {}, estado: { marca?: Date | null; iaFalou?: boolean; abertas?: KommoTarefa[] } = {}) {
  const c: Chamadas = { tarefas: [], notas: [], marcas: [], ultimas: [], simulacoes: [], passos: [], leituras: [] };
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
    marcarUltima: async (_u, _l, quando) => {
      c.ultimas.push(quando);
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
  consultaDesconhecida: false,
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
  assert.match(t.texto, /Última mensagem: "Obrigada, entro em contato para agendar logo mais"\. A Sofia não respondeu\.$/);
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
  assert.deepEqual(c, { tarefas: [], notas: [], marcas: [], ultimas: [], simulacoes: [], passos: [], leituras: [] });
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

const emSegundos = (ms: number) => Math.floor(ms / 1000);
const alertaAberta = (over: Partial<KommoTarefa> = {}): KommoTarefa => ({
  id: 1,
  text: 'ALERTA · doutor-hernia-timbo · [Contato: Ana] Paciente sem resposta há 6 min. Responda agora.',
  is_completed: false,
  complete_till: emSegundos(AGORA.getTime()) + 1800,
  entity_id: 777,
  entity_type: 'leads',
  ...over,
});

test('já há tarefa de ALERTA aberta, não vencida, no cartão: não empilha, a Sofia fica em silêncio e a nota diz o porquê', async () => {
  const { c, deps, recorder } = montar({}, { abertas: [alertaAberta()] });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.deepEqual(c.tarefas, []);
  assert.match(c.notas[0], /Já há tarefa aberta da equipe neste cartão\./);
  assert.equal(c.marcas.length, 1);
});

test('tarefa que NÃO segura o aviso (cria tarefa nova): vencida, DESPEDIDA ignorada ontem, de robô, longe ou sem prazo', async () => {
  const agora = emSegundos(AGORA.getTime());
  const casos: Array<[string, KommoTarefa]> = [
    ['ALERTA vencida há 2 h', alertaAberta({ complete_till: agora - 7200 })],
    ['DESPEDIDA de ontem que ninguém fechou', alertaAberta({ text: 'ALERTA · doutor-hernia-timbo · [DESPEDIDA] Paciente adiou…', complete_till: agora - 86_400 })],
    ['lembrete de robô com prazo à frente', alertaAberta({ text: 'Ligar para o paciente', complete_till: agora + 3600 })],
    ['ALERTA com prazo daqui a 7 dias', alertaAberta({ complete_till: agora + 7 * 86_400 })],
    ['ALERTA sem prazo', alertaAberta({ complete_till: null })],
    ['ALERTA já concluída', alertaAberta({ is_completed: true })],
  ];
  for (const [nome, tarefa] of casos) {
    const { c, deps, recorder } = montar({}, { abertas: [tarefa] });
    const r = await decidirDespedida(entrada(recorder), deps);
    assert.equal(r.acao, 'silenciar', nome);
    assert.equal(c.tarefas.length, 1, `${nome}: a tarefa nova sai (a nota sozinha não notifica ninguém)`);
  }
});

test('tarefaDaEquipeSegura: só ALERTA aberta, não vencida, até 24 h à frente', () => {
  const agora = emSegundos(AGORA.getTime());
  assert.equal(tarefaDaEquipeSegura([alertaAberta()], AGORA), true);
  assert.equal(tarefaDaEquipeSegura([alertaAberta({ text: '  alerta · x · y' })], AGORA), true);
  assert.equal(tarefaDaEquipeSegura([alertaAberta({ complete_till: agora - 1 })], AGORA), false);
  assert.equal(tarefaDaEquipeSegura([alertaAberta({ complete_till: agora + 7200 + 5 })], AGORA), false);
  assert.equal(tarefaDaEquipeSegura([alertaAberta({ complete_till: agora + 7200 })], AGORA), true);
  assert.equal(tarefaDaEquipeSegura([], AGORA), false);
});

test('despedida repetida (aviso recente, Sofia não falou): regrava só a marca da ÚLTIMA fala calada, NUNCA a do aviso (a janela de 6 h conta da tarefa)', async () => {
  const { c, deps, recorder } = montar({}, { marca: new Date(AGORA.getTime() - 3600_000), iaFalou: false });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.deepEqual(c.tarefas, []);
  assert.deepEqual(c.ultimas, [AGORA]);
  assert.deepEqual(c.marcas, [], 'a marca do aviso não desliza a cada "ok"');
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
  assert.match(textoDaNota({ tipo: 'agradeceu', fala: 'obrigada' }, 'ja_existia'), /Já há tarefa aberta da equipe/);
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

// ── os casos do sênior (#240), frases literais ──────────────────────────────────────────────────

const PRECO: Fala[] = [pac('oi, quanto custa?'), ia('A consulta é R$ 250,00, com avaliação completa.')];
const PRECO_COM_PERGUNTA: Fala[] = [pac('oi, quanto custa?'), ia('A consulta é R$ 250,00. Posso ver um horário pra você?')];

test('1. SINAL DE ALERTA, dor ou urgência junto do adiamento: NUNCA silêncio (a Sofia responde, o passe de sinal cuida)', async () => {
  for (const fala of [
    'vou pensar, mas tô perdendo a força na perna',
    'vou pensar. não estou segurando o xixi desde ontem',
    'Obrigada. Depois eu falo, a boca ficou torta agora',
    'vou pensar, tô com muita dor',
    'quando eu conseguir andar eu vou, a dor tá insuportável',
  ]) {
    for (const base of [PRECO, PRECO_COM_PERGUNTA]) {
      assert.equal(detectarDespedida([...base, pac(fala)]), null, fala);
    }
    const { c, deps, recorder } = montar();
    const r = await decidirDespedida(entrada(recorder, { falas: [...PRECO, pac(fala)] }), deps);
    assert.equal(r.acao, 'responder', fala);
    assert.deepEqual(c.tarefas, []);
    assert.deepEqual(c.marcas, []);
  }
  // o sinal numa fala ANTERIOR do mesmo bloco sem resposta também vale
  assert.equal(detectarDespedida([...PRECO, pac('estou perdendo a força na perna'), pac('vou pensar')]), null);
  // negado não é sinal: "não tenho dor" continua... mas dor mencionada é conservador (responde)
  assert.equal(temSinalOuUrgencia(['vou pensar, obrigada']), false);
  assert.equal(temSinalOuUrgencia(['tô perdendo a força na perna']), true);
});

test('2. adiamento fraco também respeita o que a Sofia PEDIU (o exame)', () => {
  const pediuExame: Fala[] = [pac('oi'), ia('Para eu adiantar, me envie o exame por aqui, por favor.')];
  assert.equal(detectarDespedida([...pediuExame, pac('agora não posso falar, mais tarde te mando o exame')]), null);
  const pediuComPergunta: Fala[] = [pac('oi'), ia('Pode me mandar o exame por aqui? Assim já adianto.')];
  assert.equal(detectarDespedida([...pediuComPergunta, pac('agora não posso falar, mais tarde te mando o exame')]), null);
  // sem pedido da Sofia, "agora não" curto continua sendo adiamento
  assert.equal(detectarDespedida([...PRECO, pac('agora não, obrigada')])?.tipo, 'adiou');
});

test('3. pergunta com a linha de botões, ou pergunta + frase curta, ainda é pergunta', () => {
  const dor: Fala[] = [pac('oi'), ia('Tá sentindo dor neste momento? Me conta.')];
  assert.equal(detectarDespedida([...dor, pac('no momento não, obrigada')]), null);
  const botoes: Fala[] = [pac('oi'), ia('Qual período fica melhor pra você?\n[[botoes: Manhã | Tarde]]')];
  assert.equal(detectarDespedida([...botoes, pac('Agora não')]), null);
  assert.equal(detectarDespedida([...botoes, pac('Obrigada')]), null);
  const botoesSemInterrogacao: Fala[] = [pac('oi'), ia('Prefere manhã ou tarde\n[[botoes: Manhã | Tarde]]')];
  assert.equal(detectarDespedida([...botoesSemInterrogacao, pac('Obrigada')]), null);
  assert.equal(iaTerminouPerguntando('Qual período?\n[[botoes: Manhã | Tarde]]'), true);
  assert.equal(iaTerminouPerguntando('Tá sentindo dor neste momento? Me conta.'), true);
  assert.equal(iaTerminouPerguntando('A consulta é R$ 250.\n'), false);
});

test('4. queixa lida como adiamento: "mais pra frente"/"em outro momento" sem verbo de marcar não é adiamento', () => {
  for (const fala of ['Dói mais pra frente, perto da virilha', 'Já tive essa crise em outro momento', 'vou verificar se tenho o exame', 'vou verificar com o convênio']) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
  }
  // com verbo de marcar/voltar, é adiamento
  assert.equal(detectarDespedida([...PRECO, pac('Mais pra frente eu marco')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('eu vejo isso mais pra frente')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Em outro momento eu volto a falar com vocês')])?.tipo, 'adiou');
});

test('5. "como/qual" e o resto da frase: o PADRÃO É RESPONDER (na lista branca, sobra conteúdo = Sofia responde)', () => {
  // antes eram adiamento; com a lista branca "como fica minha agenda" / "qual dia fica melhor" é resto, e responder é o lado seguro
  assert.equal(detectarDespedida([...PRECO, pac('vou ver como fica minha agenda e te retorno')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Depois eu vejo qual dia fica melhor')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Vou pensar, mas qual o endereço')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Agora não. Como funciona o pagamento')]), null);
  // e a forma limpa continua adiando
  assert.equal(detectarDespedida([...PRECO, pac('Depois eu vejo')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('vou ver e te retorno')])?.tipo, 'adiou');
});

test('6. "ok"/👍 depois do adiamento continuam a despedida (o caso da Stefany); agradecimento ANTES do adiamento não anula', () => {
  const calada = [...PRECO_COM_PERGUNTA, pac('Obrigada, entro em contato para agendar logo mais')];
  assert.equal(detectarDespedida(calada)?.tipo, 'adiou');
  for (const ok of ['ok', 'Ok 👍', '👍', 'tá bom', 'blz', 'combinado']) {
    assert.equal(detectarDespedida([...calada, pac(ok)])?.tipo, 'adiou', ok);
  }
  // "sim"/"não" soltos não são continuação
  assert.equal(detectarDespedida([...calada, pac('sim')]), null);
  // agradecimento antes, mesmo depois de pergunta da Sofia
  assert.equal(detectarDespedida([...PRECO_COM_PERGUNTA, pac('Obrigada!'), pac('Vou pensar e te retorno')])?.tipo, 'adiou');
  // outras formas de adiar
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada, vou me organizar e te chamo')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('vou deixar pra outro mês')])?.tipo, 'adiou');
  // "Não, obrigada" a "Posso ajudar em mais algo?"
  const oferta: Fala[] = [pac('oi'), ia('A consulta é R$ 250,00. Posso ajudar em mais alguma coisa?')];
  assert.equal(detectarDespedida([...oferta, pac('Não, obrigada')])?.tipo, 'agradeceu');
  assert.equal(detectarDespedida([...oferta, pac('Sim, obrigada')]), null);
  // pergunta que NÃO é oferta de ajuda: "Não, obrigada" é resposta
  assert.equal(detectarDespedida([...PRECO_COM_PERGUNTA, pac('Não, obrigada')]), null);
});

test('11. o texto da tarefa deixa a citação do paciente depois de "Última mensagem:" (o roteador n8n corta dali, dado de saúde)', () => {
  const t = textoDaTarefa({ slug: TIMBO, contato: 'Ana', despedida: { tipo: 'adiou', fala: 'vou pensar' } });
  assert.match(t, /^ALERTA · doutor-hernia-timbo · \[DESPEDIDA\] /);
  assert.match(t, / Última mensagem: "vou pensar"\. A Sofia não respondeu\.$/);
  assert.equal(t.replace(/ltima mensagem:.*$/i, '').includes('vou pensar'), false);
});

test('aviso de hoje MAS velho (mais de 6 h) e a Sofia não falou: não garante que alguém olhou — a tarefa vigente segura, ou nasce tarefa nova', async () => {
  const marca = new Date(AGORA.getTime() - 10 * 3600_000);
  const a = montar({}, { marca, iaFalou: false });
  const r = await decidirDespedida(entrada(a.recorder), a.deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(a.c.tarefas.length, 1, 'tarefa nova');
  const b = montar({}, { marca, iaFalou: false, abertas: [alertaAberta()] });
  const r2 = await decidirDespedida(entrada(b.recorder), b.deps);
  assert.equal(r2.acao, 'silenciar');
  assert.deepEqual(b.c.tarefas, [], 'a ALERTA vigente segura');
});

test('a tarefa foi criada mas a marca/nota falhou: a Sofia segue CALADA (senão o paciente leva o "combinado" e a equipe a tarefa)', async () => {
  const { c, deps, recorder } = montar({
    marcar: async () => {
      throw new Error('banco caiu');
    },
  });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(c.tarefas.length, 1);
});

test('revisão: pedido junto SEM "?" no mesmo recado do adiamento — a Sofia responde', () => {
  for (const fala of [
    'Vou pensar. Pode passar o endereço',
    'Vou pensar, mande o endereço',
    'Vou pensar. Aceita cartão',
    'Vou pensar. Aceitam Unimed',
    'Vou pensar, vocês ficam onde',
    'Vou pensar, quero o endereço',
    'Entrarei em contato, obrigada. Preciso do endereço',
    'Vou pensar nesse horário, mas quero marcar sexta',
    'Vou pensar no valor, mas já quero agendar',
  ]) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
  }
});

test('revisão: "obrigada" a um pedido da Sofia sem "?" é resposta, não despedida', () => {
  for (const ultima of [
    'Me conta qual o melhor dia pra você.',
    'Me fala seu nome completo, por favor.',
    'Se quiser, me diz o melhor período.',
    'Qual a sua cidade',
    'Posso ajudar? Se preferir, explico a avaliação.',
  ]) {
    for (const fala of ['Obrigada', 'Ok obrigado']) {
      assert.equal(detectarDespedida([pac('oi'), ia(ultima), pac(fala)]), null, `${ultima} / ${fala}`);
    }
  }
});

test('revisão: "não vou querer" um item/horário específico não adia a consulta toda', () => {
  assert.equal(detectarDespedida([...PRECO, pac('Não vou querer o exame, só a consulta')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Não vou marcar pra hoje, só amanhã')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Não vou querer marcar agora')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Não vou querer, obrigada')])?.tipo, 'adiou');
});

test('revisão: dor/urgência com outras palavras também responde', () => {
  for (const fala of ['Vou pensar, tô sofrendo muito', 'Vou pensar, tô com muito incômodo e não consigo dormir', 'depois eu vejo, tá travada minha coluna', 'vou pensar, sinto uma fisgada', 'vou pensar, queimação na perna']) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
  }
});

test('revisão: "agora não" que INFORMA ("agora não tenho exame", "agora não tenho como pagar") não é adiamento', () => {
  assert.equal(detectarDespedida([...PRECO, pac('agora não tenho exame')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('agora não tenho como pagar')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('agora não, obrigada')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Agora não.')])?.tipo, 'adiou');
});

test('o id da automação é UMA definição só (agente e alerta de sem resposta leem a mesma)', () => {
  assert.equal(ID_DA_AUTOMACAO, AUTOMACAO_DESPEDIDA_HUMANO);
});

// ── LISTA BRANCA (2ª reprovação do #240): o que SOBRA depois de tirar despedida + cortesia + desculpa benigna ────────────────

test('LISTA BRANCA: urgência fora de qualquer léxico NUNCA vira silêncio (frases literais do sênior)', async () => {
  for (const fala of [
    'to no hospital, depois eu marco',
    'depois eu falo, tô internada',
    'Agora não, tô no pronto atendimento',
    'não tô aguentando mais, depois eu vejo',
    'minha coluna travou, depois eu vejo',
    'a hérnia estourou, vou pensar',
    'Tô de cama, depois eu falo',
    'tô muito mal, depois eu vejo',
    'nem consigo sentar, vou pensar',
    'mais tarde eu falo, minha perna formigando',
    'Obrigada, vou pensar 😭',
    'vou pensar 🚑',
  ]) {
    for (const base of [PRECO, PRECO_COM_PERGUNTA]) assert.equal(detectarDespedida([...base, pac(fala)]), null, fala);
    const { c, deps, recorder } = montar();
    const r = await decidirDespedida(entrada(recorder, { falas: [...PRECO, pac(fala)] }), deps);
    assert.equal(r.acao, 'responder', fala);
    assert.deepEqual(c.tarefas, [], fala);
    assert.deepEqual(c.marcas, [], fala);
  }
});

test('LISTA BRANCA: o caso da Stefany e as formas limpas CALAM, com cortesia e desculpa benigna', () => {
  for (const fala of [
    'Obrigada, entro em contato para agendar logo mais',
    'obrigada! depois eu vejo',
    'Vou pensar, obrigado 🙏',
    'estou no trabalho agora, depois eu vejo, obrigada',
    'to dirigindo, mais tarde eu falo',
    'agora estou sem tempo, entro em contato depois',
    'não posso falar agora, entro em contato mais tarde',
    'Valeu, qualquer coisa eu te chamo',
    'Muito obrigada pelas informações, vou pensar',
  ]) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)])?.tipo, 'adiou', fala);
  }
  // e o "ok"/👍 que vem depois não acorda a Sofia
  const calada = [...PRECO_COM_PERGUNTA, pac('Obrigada, entro em contato para agendar logo mais')];
  for (const ok of ['ok', '👍', 'Ok 👍', 'tá bom', 'combinado', 'obrigada 🙏']) {
    assert.equal(detectarDespedida([...calada, pac(ok)])?.tipo, 'adiou', ok);
  }
  // emoji de aflição depois do "ok" acorda
  assert.equal(detectarDespedida([...calada, pac('😭')]), null);
  assert.equal(detectarDespedida([...calada, pac('ok 🤕')]), null);
});

test('2. cumprimento DEPOIS da despedida fecha o bloco: a Sofia responde', () => {
  const calada = [...PRECO_COM_PERGUNTA, pac('Obrigada, entro em contato para agendar logo mais')];
  assert.equal(detectarDespedida([...calada, pac('Bom dia')]), null);
  assert.equal(detectarDespedida([...calada, pac('Boa tarde, tudo bem')]), null);
  assert.equal(detectarDespedida([...calada, pac('oi')]), null);
  assert.equal(detectarDespedida([...calada, pac('ok'), pac('Boa tarde')]), null);
  assert.equal(detectarDespedida([...calada, pac('Quero marcar sexta')]), null);
  assert.equal(detectarDespedida([...calada, pac('sim')]), null);
});

test('3. resposta a pergunta de triagem não é adiamento: verbo genérico ("faço/vejo") só vale se a Sofia NÃO perguntou', () => {
  const triagem: Fala[] = [pac('oi'), ia('Você já fez algum exame?')];
  assert.equal(detectarDespedida([...triagem, pac('Ainda não, depois eu faço')]), null);
  assert.equal(detectarDespedida([...triagem, pac('Depois eu faço')]), null);
  assert.equal(detectarDespedida([...triagem, pac('depois eu vejo')]), null);
  assert.equal(detectarDespedida([...triagem, pac('Agora não')]), null);
  // o inequívoco vale mesmo depois de pergunta
  assert.equal(detectarDespedida([...triagem, pac('Vou pensar')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...triagem, pac('Entro em contato depois')])?.tipo, 'adiou');
  // sem pergunta da Sofia, o genérico vale
  assert.equal(detectarDespedida([...PRECO, pac('depois eu vejo')])?.tipo, 'adiou');
});

test('4. a janela de 6 h conta da TAREFA: aviso velho + "ok" não é renovado, o "ok" não desliza a marca do aviso', async () => {
  const marca = new Date(AGORA.getTime() - 7 * 3600_000);
  const { c, deps, recorder } = montar({}, { marca, iaFalou: false });
  const r = await decidirDespedida(entrada(recorder), deps);
  assert.equal(r.acao, 'silenciar');
  assert.equal(c.tarefas.length, 1, 'a tarefa original venceu sem tarefa nova: nasce a nova');
  // dentro de 6 h: só a marca da última fala é regravada
  const b = montar({}, { marca: new Date(AGORA.getTime() - 2 * 3600_000), iaFalou: false });
  await decidirDespedida(entrada(b.recorder), b.deps);
  assert.deepEqual(b.c.marcas, []);
  assert.deepEqual(b.c.ultimas, [AGORA]);
});

test('franquia fora do ar / cartão diz que já agendou: "sem consulta no prompt" NÃO é "ainda não marcou" — a Sofia responde (também em seco)', async () => {
  for (const estado of ['ligado', 'seco'] as const) {
    const { c, deps, recorder } = montar();
    const r = await decidirDespedida(entrada(recorder, { estado, consultaDesconhecida: true }), deps);
    assert.equal(r.acao, 'responder');
    assert.match(r.motivo, /não sei se há consulta marcada/);
    assert.deepEqual(c.tarefas, []);
    assert.deepEqual(c.simulacoes, []);
  }
});

test('LISTA BRANCA: varredura — adiamento/agradecimento + QUALQUER conteúdo (clínico, urgência, dinheiro, luto) na mesma fala = a Sofia responde', () => {
  const adia = ['vou pensar', 'depois eu vejo', 'obrigada', 'entro em contato', 'agora não', 'obrigado, vou pensar', 'mais tarde eu falo'];
  const conteudo = [
    'tô internada', 'tô no hospital', 'tô de cama', 'tô muito mal', 'nem consigo sentar', 'nem consigo andar', 'a dor aumentou',
    'estourou', 'travou', 'tô passando mal', 'desmaiei', 'não consigo levantar', 'tô sem sentir a perna', 'tô com febre',
    'tô sangrando', 'tô com falta de ar', 'fui operada ontem', 'tô com covid', 'meu pai morreu', 'perdi meu emprego',
    'tô sem dinheiro', 'tô sem condições', 'tô triste', 'tô desesperado', 'não aguento mais', 'chamei o samu', 'caí da escada',
    'minha mãe está internada', 'o convênio negou', 'achei caro', 'vocês atendem sábado', 'meu cpf é 123', 'tenho exame de 2019',
  ];
  let n = 0;
  for (const a of adia) {
    for (const c of conteudo) {
      for (const fala of [`${a}, ${c}`, `${c}, ${a}`, `${a}. ${c}`]) {
        n++;
        assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
        assert.equal(detectarDespedida([...PRECO_COM_PERGUNTA, pac(fala)]), null, fala);
        // e em duas mensagens seguidas
        assert.equal(detectarDespedida([...PRECO, pac(a), pac(c)]), null, `${a} | ${c}`);
      }
    }
  }
  assert.ok(n > 600);
});

test('revisão (3º code-review): emoticon de texto triste = resto; sorriso = cortesia', () => {
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada :(')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Vou pensar :( :(')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('obrigada T_T')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada :)')])?.tipo, 'agradeceu');
  assert.equal(detectarDespedida([...PRECO, pac('Vou pensar :D')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada <3')])?.tipo, 'agradeceu');
});

test('revisão: "não consigo falar/digitar" pode ser sintoma — só "não posso falar AGORA" é desculpa benigna', () => {
  for (const fala of ['Obrigada, não consigo falar', 'Obrigada, não consigo digitar', 'Vou pensar, não consigo falar', 'Obrigada, não posso responder']) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
  }
  assert.equal(detectarDespedida([...PRECO, pac('não posso falar agora, entro em contato depois')])?.tipo, 'adiou');
});

test('revisão: depois de "posso ajudar em mais algo?", só o "não" INTEIRO é despedida', () => {
  const oferta: Fala[] = [pac('oi'), ia('A consulta é R$ 250,00. Posso ajudar em mais alguma coisa?')];
  assert.equal(detectarDespedida([...oferta, pac('Não, obrigada')])?.tipo, 'agradeceu');
  assert.equal(detectarDespedida([...oferta, pac('Não precisa, obrigada')])?.tipo, 'agradeceu');
  for (const fala of ['Não tá bom, obrigada', 'Não entendi, obrigada', 'Não é só isso, obrigada']) {
    assert.equal(detectarDespedida([...oferta, pac(fala)]), null, fala);
  }
});

test('revisão: o sinal que só aparece no bloco <conversa_oficial> (falasDoTurno) também passa pela lista branca e pelo sinal', async () => {
  // o HumanMessage diz só "Obrigada, vou pensar"; o bloco traz uma fala dele que a Sofia ainda não viu
  const doTurno = ['perdi a força na perna e não sinto o pé\nObrigada, vou pensar'];
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada, vou pensar')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada, vou pensar')], doTurno), null);
  const { c, deps, recorder } = montar();
  const r = await decidirDespedida(entrada(recorder, { falas: [...PRECO, pac('Obrigada, vou pensar')], falasDoPaciente: doTurno }), deps);
  assert.equal(r.acao, 'responder');
  assert.match(r.motivo, /sinal de alerta/);
  assert.deepEqual(c.tarefas, []);
  // fala do bloco que não é sinal mas é conteúdo: também responde
  const r2 = await decidirDespedida(entrada(recorder, { falas: [...PRECO, pac('Obrigada, vou pensar')], falasDoPaciente: ['qual o endereço\nObrigada, vou pensar'] }), deps);
  assert.equal(r2.acao, 'responder');
});

test('revisão: a marca do aviso não grava no banco mas a tarefa existe — a memória do processo segura o próximo "ok" (sem tarefa em dobro)', async () => {
  const { DEPS_PADRAO } = await import('./despedida-humano.js');
  const { prisma } = await import('../lib/prisma.js');
  const original = Object.getOwnPropertyDescriptor(prisma, 'cardAlert');
  Object.defineProperty(prisma, 'cardAlert', {
    value: {
      findUnique: async () => null,
      upsert: async () => {
        throw new Error('banco caiu');
      },
    },
    configurable: true,
  });
  try {
    const u = { id: 'u-mem', slug: 'x' } as unknown as Unit;
    assert.equal(await DEPS_PADRAO.avisoDeHoje(u, 4242), false);
    await DEPS_PADRAO.marcar(u, 4242, new Date());
    assert.equal(await DEPS_PADRAO.avisoDeHoje(u, 4242), true, 'a memória segura');
    assert.ok(await DEPS_PADRAO.marcaEm(u, 4242));
  } finally {
    if (original) Object.defineProperty(prisma, 'cardAlert', original);
  }
});

// ── 4ª reprovação do #240: falsos positivos nas frases de adiamento ─────────────────────────────

test('FP 1. "para agendar/marcar" sozinho é o pedido de quem QUER marcar: a Sofia responde', () => {
  const ajuda: Fala[] = [pac('oi'), ia('Oi! Como posso te ajudar?')];
  for (const fala of ['Para agendar', 'É para agendar', 'para marcar consulta', 'Quero para agendar', 'para marcar a consulta', 'Para agendar, obrigada']) {
    assert.equal(detectarDespedida([...ajuda, pac(fala)]), null, fala);
    assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
  }
  // colado a um verbo de voltar, é a despedida
  assert.equal(detectarDespedida([...PRECO, pac('entro em contato para agendar')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada, entro em contato para marcar a consulta')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Obrigada, entro em contato para agendar logo mais')])?.tipo, 'adiou');
});

test('FP 2. "retorno" é substantivo em clínica; "volto", "te ligo" sozinhos não são promessa: exigem "eu" ou tempo', () => {
  const ajuda: Fala[] = [pac('oi'), ia('Oi! Como posso te ajudar?')];
  for (const fala of ['É retorno', 'retorno', 'volto', 'te ligo', 'te retorno', 'Obrigada, é retorno', 'consulta de retorno']) {
    assert.equal(detectarDespedida([...ajuda, pac(fala)]), null, fala);
    assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
  }
  for (const fala of ['eu te retorno', 'retorno depois', 'depois eu volto', 'eu volto', 'mais tarde te ligo', 'eu te ligo', 'vou pensar e te retorno', 'volto a falar com vocês', 'Obrigada, te aviso']) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)])?.tipo, 'adiou', fala);
  }
});

test('FP 3. "quando puder" / "vou ver" respondem pergunta ou pedido da Sofia — não são adiamento', () => {
  const horario: Fala[] = [pac('oi'), ia('Qual o melhor horário pra te ligar?')];
  assert.equal(detectarDespedida([...horario, pac('Quando puder')]), null);
  assert.equal(detectarDespedida([...horario, pac('quando puder, obrigada')]), null);
  const exame: Fala[] = [pac('oi'), ia('Para eu adiantar, me envie o exame por aqui, por favor.')];
  assert.equal(detectarDespedida([...exame, pac('Ok vou ver')]), null);
  assert.equal(detectarDespedida([...exame, pac('vou ver')]), null);
  const exameComPergunta: Fala[] = [pac('oi'), ia('Pode me mandar o exame por aqui?')];
  assert.equal(detectarDespedida([...exameComPergunta, pac('Ok vou ver')]), null);
  // sem pedido da Sofia, continuam valendo
  assert.equal(detectarDespedida([...PRECO, pac('quando puder eu volto')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('Ok vou ver')])?.tipo, 'adiou');
  assert.equal(detectarDespedida([...PRECO, pac('quando puder, obrigada')])?.tipo, 'adiou');
});

test('"Não vou querer, obrigada" respondendo a uma oferta é recusa: a Sofia responde (não vira "adiou")', () => {
  const oferta: Fala[] = [pac('oi'), ia('Quer que eu te mande a localização da clínica?')];
  assert.equal(detectarDespedida([...oferta, pac('Não vou querer, obrigada')]), null);
  assert.equal(detectarDespedida([...PRECO, pac('Não vou querer, obrigada')])?.tipo, 'adiou');
});

test('pré-processamento barato: letra final repetida, nome da persona e interjeição não são conteúdo', () => {
  for (const fala of ['Obrigadaa', 'Obrigada Sofia', 'Ah ta, obrigada', 'Valeuuu', 'obrigado dra sofia', 'Hmm ok obrigada']) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)])?.tipo, 'agradeceu', fala);
  }
  // e continuam fora (ficam para depois, a Sofia responde): esposo, vou me programar, vou ver minha agenda
  for (const fala of ['vou conversar com meu esposo', 'vou me programar', 'vou ver minha agenda']) {
    assert.equal(detectarDespedida([...PRECO, pac(fala)]), null, fala);
  }
});
