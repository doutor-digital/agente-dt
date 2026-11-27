import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { FALLBACK_INDISPONIVEL } from '../agent/llm-policy.js';
import {
  ehFraseDeQueda,
  trechoSemResposta,
  ligadaAQueda,
  passoDeAgendaOuPix,
  roboFalouDepoisDoPedido,
  retomarConversa,
  executar,
  resumir,
  MAX_MENSAGENS_NO_TURNO,
  type CandidataDaQueda,
  type DepsDaExecucao,
  type MensagemDaConversa,
} from './retomar-apos-queda.js';
import type { ConversaLida, ResultadoRetomada, TurnoPerdido } from './recuperar-turnos.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import { consumirNaoEntregueDetalhe, renderEntregaFalha, marcarNaoEntregue, limparNaoEntregues } from '../agent/entrega-falha.js';

const UNIT = { id: 'u1', slug: 'doutor-hernia-taubate', kommoSubdomain: 'taubate', isActive: true } as unknown as Unit;
const t0 = new Date('2026-11-27T09:00:00Z');
const em = (min: number) => new Date(t0.getTime() + min * 60_000);

const m = (role: string, content: string, min: number, traceId: string | null = null): MensagemDaConversa => ({ role, content, createdAt: em(min), traceId });

function pedido(id: string, min: number): TurnoPerdido {
  return { traceId: id, unitId: 'u1', leadId: '777', criadoEm: em(min), input: {} };
}

function candidata(extra: Partial<CandidataDaQueda> = {}): CandidataDaQueda {
  return {
    conversaId: 'conv1',
    unitId: 'u1',
    unitSlug: UNIT.slug,
    leadId: '777',
    canal: 'kommo_chat',
    quedaEm: em(1),
    tracesDaQueda: ['t1'],
    pedidos: [pedido('t1', 0)],
    ignoradas: 0,
    ...extra,
  };
}

function oficial(direcao: 'entrada' | 'saida', min: number, extra: Partial<MensagemOficial> = {}): MensagemOficial {
  return {
    id: `${direcao}-${min}`,
    em: em(min),
    direcao,
    autor: direcao === 'entrada' ? 'paciente' : 'equipe',
    autorNome: direcao === 'entrada' ? 'Paciente' : 'Melissa',
    texto: direcao === 'entrada' ? 'oi' : 'Olá, aqui é a recepção.',
    anexo: null,
    status: null,
    ...extra,
  };
}

interface Mundo {
  conversaAndou: boolean;
  unit: Unit | null;
  kommo: ConversaLida | null;
  pausada: boolean;
  etapa: string | null | 'lanca';
  fora: boolean;
  agendaOuPix: boolean;
  avaliacao: (t: TurnoPerdido) => { naoRetomar: ResultadoRetomada } | { ctx: unknown };
  vez: 'ganhou' | 'perdeu' | 'incerto';
  tarefaLanca: boolean;
  tarefaJaExistia: boolean;
  agendarResultado: (t: TurnoPerdido) => ResultadoRetomada;
  // o que aconteceu
  tarefas: string[];
  agendados: string[];
  avisos: string[];
  reivindicados: string[];
  quedaDeNovo: boolean;
}

function mundo(over: Partial<Mundo> = {}): { w: Mundo; deps: DepsDaExecucao } {
  const w: Mundo = {
    conversaAndou: false,
    unit: UNIT,
    kommo: { msgs: [oficial('entrada', 0), oficial('saida', 0.5, { autor: 'sofia', texto: FALLBACK_INDISPONIVEL })], equipeComAPalavra: false, naoConferi: false },
    pausada: false,
    etapa: null,
    fora: false,
    agendaOuPix: false,
    avaliacao: () => ({ ctx: 'ctx' }),
    vez: 'ganhou',
    tarefaLanca: false,
    tarefaJaExistia: false,
    agendarResultado: () => 'retomado',
    tarefas: [],
    agendados: [],
    avisos: [],
    reivindicados: [],
    quedaDeNovo: false,
    ...over,
  };
  const deps: DepsDaExecucao = {
    agora: () => em(30),
    unidadeDona: async () => w.unit,
    conversaAndou: async () => w.conversaAndou,
    traceTeveAgendaOuPix: async () => w.agendaOuPix,
    lerConversa: async () => {
      if (!w.kommo) throw new Error('kommo fora');
      return w.kommo;
    },
    iaPausada: async () => w.pausada,
    etapaFechada: async () => {
      if (w.etapa === 'lanca') throw new Error('kommo fora');
      return w.etapa;
    },
    foraDoHorario: () => w.fora,
    avaliar: async (t) => w.avaliacao(t),
    reivindicar: async (id) => {
      if (w.vez === 'ganhou') w.reivindicados.push(id);
      return w.vez;
    },
    liberarReivindicacao: async () => undefined,
    plantarAviso: (_u, leadId) => void w.avisos.push(leadId),
    agendar: async (t) => {
      w.agendados.push(t.traceId);
      return w.agendarResultado(t);
    },
    criarTarefa: async (_u, t) => {
      if (w.tarefaLanca) throw new Error('Kommo 500');
      w.tarefas.push(t.traceId);
      return w.tarefaJaExistia ? 'ja_existia' : 'criada';
    },
    esperarTurno: async () => true,
    respondeuComQueda: async () => w.quedaDeNovo,
  };
  return { w, deps };
}

// ── a parte pura ─────────────────────────────────────────────────────────────────────────────────────

test('ehFraseDeQueda: a frase de queda (com ou sem acento de espaço) e só ela', () => {
  assert.equal(ehFraseDeQueda(FALLBACK_INDISPONIVEL), true);
  assert.equal(ehFraseDeQueda(`  ${FALLBACK_INDISPONIVEL}\n`), true);
  assert.equal(ehFraseDeQueda('Opa, tive uma instabilidade rapidinha aqui. Manda de novo?'), true);
  assert.equal(ehFraseDeQueda('Oi! Posso ajudar?'), false);
});

test('trechoSemResposta: só é candidata quem TERMINA na frase de queda', () => {
  assert.equal(trechoSemResposta([m('user', 'oi', 0), m('assistant', FALLBACK_INDISPONIVEL, 1), m('user', 'alô?', 2)]), null);
  assert.equal(trechoSemResposta([m('user', 'oi', 0), m('assistant', 'Olá!', 1)]), null);
  assert.equal(trechoSemResposta([]), null);
});

test('trechoSemResposta: o trecho começa depois da última fala de verdade do assistente (as quedas não contam como resposta)', () => {
  const r = trechoSemResposta([
    m('user', 'oi', 0, 'a'),
    m('assistant', 'Oiê! Que bom te receber.', 1, 'a'),
    m('user', 'dor no braço', 2, 'b'),
    m('assistant', FALLBACK_INDISPONIVEL, 3, 'b'),
    m('user', 'vai até o pescoço', 4, 'c'),
    m('user', 'faz um mês', 5, 'd'),
    m('assistant', FALLBACK_INDISPONIVEL, 6, 'c'),
  ])!;
  assert.deepEqual(r.pacientes.map((p) => p.content), ['dor no braço', 'vai até o pescoço', 'faz um mês']);
  assert.equal(r.quedas.length, 2);
});

test('trechoSemResposta: fala do assistente SEM trace (equipe importada do Kommo, ou o aviso automático do WhatsApp Business) NÃO fecha o trecho', () => {
  // Caso real (Rio Verde 7978600): o paciente escreveu 07:37:27, o app respondeu o aviso de horário 07:37:35, a Sofia deu a queda 07:37:51.
  const r = trechoSemResposta([
    m('user', 'Olá, tudo bem? Estava navegando no site', 0, 'a'),
    m('assistant', '⏰ Nosso horário de atendimento é de segundas à sexta-feiras, 07h às 19h', 0.1, null),
    m('assistant', FALLBACK_INDISPONIVEL, 0.4, 'a'),
  ])!;
  assert.deepEqual(r.pacientes.map((p) => p.content), ['Olá, tudo bem? Estava navegando no site']);
});

test('ligadaAQueda: o dono do burst e os satélites coalescidos nele; nada além', () => {
  const quedas = new Set(['dono']);
  assert.equal(ligadaAQueda({ id: 'dono', iaDecision: 'texto' }, quedas), true);
  assert.equal(ligadaAQueda({ id: 'sat', iaDecision: '__coalesced_into__:dono' }, quedas), true);
  assert.equal(ligadaAQueda({ id: 'sat2', iaDecision: '__coalesced_into__:outro' }, quedas), false);
  assert.equal(ligadaAQueda({ id: 'solta', iaDecision: 'Resposta de verdade' }, quedas), false);
  assert.equal(ligadaAQueda({ id: 'x', iaDecision: null }, quedas), false);
});

test('passoDeAgendaOuPix: ferramenta de agenda/Pix conta; ruído do turno não', () => {
  assert.equal(passoDeAgendaOuPix({ kind: 'TOOL_CALL', title: 'Decisão: consultar_horarios(data=2026-11-28)' }), true);
  assert.equal(passoDeAgendaOuPix({ kind: 'TOOL_RESULT', title: 'Consulta marcada: 2026-11-28 08:00 (idSchedule 9)' }), true);
  assert.equal(passoDeAgendaOuPix({ kind: 'TOOL_CALL', title: 'Decisão: gerar_sinal_pix(leadId=1)' }), true);
  assert.equal(passoDeAgendaOuPix({ kind: 'TOOL_CALL', title: 'Decisão: aplicar tag "Quente" no lead 1' }), false);
  assert.equal(passoDeAgendaOuPix({ kind: 'ERROR', title: '⏱️ IA indisponível — principal e plano B falharam' }), false);
  // o texto "agenda" num passo que não é de ferramenta (ex.: o título do webhook) não decide
  assert.equal(passoDeAgendaOuPix({ kind: 'WEBHOOK_RECEIVED', title: 'Mensagem: "quero agendar"' }), false);
});

test('roboFalouDepoisDoPedido: a PRÓPRIA frase de queda não é robô falando; um lembrete é', () => {
  const queda = oficial('saida', 1, { autor: 'sofia', texto: FALLBACK_INDISPONIVEL });
  assert.equal(roboFalouDepoisDoPedido([oficial('entrada', 0), queda], em(0)), false);
  const lembrete = oficial('saida', 2, { autor: 'sofia', texto: 'Lembrete: sua consulta é amanhã às 9h.' });
  assert.equal(roboFalouDepoisDoPedido([oficial('entrada', 0), queda, lembrete], em(0)), true);
});

// ── as regras de decisão, em ordem ───────────────────────────────────────────────────────────────────

test('simulação (padrão): decide REINJETAR mas não reivindica, não planta aviso, não agenda, não cria tarefa', async () => {
  const { w, deps } = mundo();
  const r = await retomarConversa(deps, candidata(), false);
  assert.equal(r.acao, 'reinjetar');
  assert.equal(r.efeito, 'simulado');
  assert.deepEqual([w.reivindicados, w.avisos, w.agendados, w.tarefas], [[], [], [], []]);
});

test('a conversa andou depois da queda → fecha (o fluxo normal já cuidou), nada é gravado', async () => {
  const { w, deps } = mundo({ conversaAndou: true });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['fechar', 'conversa_andou_depois_da_queda']);
  assert.deepEqual([w.reivindicados, w.agendados, w.tarefas], [[], [], []]);
});

test('sem mensagem do paciente ligada à queda → fecha', async () => {
  const { deps } = mundo();
  const r = await retomarConversa(deps, candidata({ pedidos: [] }), true);
  assert.deepEqual([r.acao, r.motivo], ['fechar', 'sem_mensagem_do_paciente_ligada_a_queda']);
});

test('unidade inativa ou cartão sem dona → fecha', async () => {
  const { deps } = mundo({ unit: null });
  assert.equal((await retomarConversa(deps, candidata(), true)).motivo, 'unidade_ou_lead_invalido');
});

test('canal que não é o Kommo → TAREFA, nunca reinjeção (só o webhook do Kommo reentra no agente)', async () => {
  const { w, deps } = mundo();
  const r = await retomarConversa(deps, candidata({ canal: 'chatwoot' }), true);
  assert.deepEqual([r.acao, r.motivo], ['tarefa', 'canal_sem_reinjecao_segura:chatwoot']);
  assert.deepEqual(w.tarefas, ['t1']);
  assert.deepEqual(w.agendados, []);
});

test('a equipe respondeu o pedido VELHO mas não o novo: só o novo volta (cada pedido é julgado sozinho)', async () => {
  const { w, deps } = mundo({
    kommo: { msgs: [oficial('entrada', 0), oficial('saida', 1), oficial('entrada', 2)], equipeComAPalavra: false, naoConferi: false },
  });
  const r = await retomarConversa(deps, candidata({ pedidos: [pedido('t1', 0), pedido('t2', 2)], tracesDaQueda: ['t1', 't2'] }), true);
  assert.equal(r.acao, 'reinjetar');
  assert.deepEqual(w.agendados, ['t2']);
});

test('a EQUIPE respondeu depois do pedido (fala humana no Kommo) → fecha SEM tarefa e sem reinjetar', async () => {
  const { w, deps } = mundo({
    kommo: { msgs: [oficial('entrada', 0), oficial('saida', 0.5, { autor: 'sofia', texto: FALLBACK_INDISPONIVEL }), oficial('saida', 5)], equipeComAPalavra: true, naoConferi: false },
  });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['fechar', 'equipe_respondeu_depois_do_pedido']);
  assert.deepEqual([w.tarefas, w.agendados], [[], []]);
});

test('resposta automática do WhatsApp Business não conta como a equipe (aviso do sistema)', async () => {
  const { deps } = mundo({
    kommo: {
      msgs: [oficial('entrada', 0), oficial('saida', 0.2, { texto: 'Agradecemos o seu contato! Nosso atendimento é de segunda a sexta, das 8h às 18h.', autorNome: 'WhatsApp Business' })],
      equipeComAPalavra: false,
      naoConferi: false,
    },
  });
  const r = await retomarConversa(deps, candidata(), false);
  assert.notEqual(r.motivo, 'equipe_respondeu_depois_do_pedido');
});

test('IA pausada (unidade, lead ou caixinha) → fecha', async () => {
  const { w, deps } = mundo({ pausada: true });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['fechar', 'ia_pausada']);
  assert.deepEqual([w.tarefas, w.agendados], [[], []]);
});

test('etapa fechada (ALTA, ganho, fora da allowlist) → fecha, com a razão no detalhe', async () => {
  const { deps } = mundo({ etapa: 'etapa calada: ALTA' });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo, r.detalhe], ['fechar', 'etapa_fechada', 'etapa calada: ALTA']);
});

test('não consegui ler a etapa → TAREFA (na dúvida, a recepção decide)', async () => {
  const { deps } = mundo({ etapa: 'lanca' });
  const r = await retomarConversa(deps, candidata(), false);
  assert.deepEqual([r.acao, r.motivo], ['tarefa', 'nao_consegui_ler_a_etapa']);
});

test('Kommo não leu a conversa → TAREFA, não resposta', async () => {
  const { w, deps } = mundo({ kommo: null });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['tarefa', 'nao_consegui_conferir_o_kommo']);
  assert.deepEqual([w.tarefas, w.agendados], [['t1'], []]);
});

test('não consegui conferir a caixinha "Pausar IA" → TAREFA', async () => {
  const { deps } = mundo({ kommo: { msgs: [], equipeComAPalavra: false, naoConferi: true } });
  assert.equal((await retomarConversa(deps, candidata(), false)).motivo, 'nao_consegui_conferir_o_kommo');
});

test('a equipe tinha a palavra (falou antes da queda, sem devolver à Sofia) → TAREFA', async () => {
  const { deps } = mundo({ kommo: { msgs: [oficial('entrada', 0)], equipeComAPalavra: true, naoConferi: false } });
  assert.equal((await retomarConversa(deps, candidata(), false)).motivo, 'equipe_na_conversa');
});

test('um robô (lembrete) falou depois do pedido → TAREFA', async () => {
  const { deps } = mundo({
    kommo: {
      msgs: [oficial('entrada', 0), oficial('saida', 0.5, { autor: 'sofia', texto: FALLBACK_INDISPONIVEL }), oficial('saida', 3, { autor: 'sofia', texto: 'Lembrete: sua consulta é amanhã.' })],
      equipeComAPalavra: false,
      naoConferi: false,
    },
  });
  assert.equal((await retomarConversa(deps, candidata(), false)).motivo, 'robo_falou_depois_do_pedido');
});

test('fora do horário da unidade → só TAREFA (o turno normal mandaria "fora do horário")', async () => {
  const { w, deps } = mundo({ fora: true });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo, r.efeito], ['tarefa', 'fora_do_horario', 'feito']);
  assert.deepEqual([w.tarefas, w.agendados, w.reivindicados], [['t1'], [], []]);
});

test('o trace da queda já tinha chamado agenda ou Pix → TAREFA, nunca reinjeta', async () => {
  const { w, deps } = mundo({ agendaOuPix: true });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['tarefa', 'trace_da_queda_tinha_agenda_ou_pix']);
  assert.deepEqual(w.agendados, []);
});

test(`mais de ${MAX_MENSAGENS_NO_TURNO} mensagens sem resposta não cabem num turno → TAREFA`, async () => {
  const { deps } = mundo();
  const pedidos = Array.from({ length: MAX_MENSAGENS_NO_TURNO + 1 }, (_, i) => pedido(`t${i}`, i * 0.01));
  assert.equal((await retomarConversa(deps, candidata({ pedidos }), false)).motivo, 'mais_de_20_mensagens_sem_resposta');
});

test('uma mensagem que a recuperação do deploy manda para tarefa (resposta a lembrete) leva a conversa toda para a TAREFA', async () => {
  const { w, deps } = mundo({
    avaliacao: (t) => (t.traceId === 't2' ? { naoRetomar: 'tarefa:pode_ser_resposta_a_lembrete' } : { ctx: 'ctx' }),
  });
  const r = await retomarConversa(deps, candidata({ pedidos: [pedido('t1', 0), pedido('t2', 0.5)], tracesDaQueda: ['t1', 't2'] }), true);
  assert.deepEqual([r.acao, r.motivo], ['tarefa', 'pode_ser_resposta_a_lembrete']);
  // a tarefa leva a ÚLTIMA mensagem; ninguém foi agendado, nada foi reivindicado
  assert.deepEqual([w.tarefas, w.agendados, w.reivindicados], [['t2'], [], []]);
});

test('encerramento repetido ("ok, obrigado") descarta só essa mensagem; as outras voltam', async () => {
  const { w, deps } = mundo({ avaliacao: (t) => (t.traceId === 't2' ? { naoRetomar: 'descartado:encerramento_repetido' } : { ctx: 'ctx' }) });
  const r = await retomarConversa(deps, candidata({ pedidos: [pedido('t1', 0), pedido('t2', 0.5)], tracesDaQueda: ['t1', 't2'] }), true);
  assert.equal(r.acao, 'reinjetar');
  assert.deepEqual(w.agendados, ['t1']);
});

test('todas as mensagens descartadas → fecha com o motivo', async () => {
  const { deps } = mundo({ avaliacao: () => ({ naoRetomar: 'descartado:encerramento_repetido' }) });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['fechar', 'encerramento_repetido']);
});

test('com --aplicar: reivindica UMA vez, planta o aviso e volta as mensagens da mais nova para a mais velha', async () => {
  const { w, deps } = mundo();
  const r = await retomarConversa(deps, candidata({ pedidos: [pedido('t1', 0), pedido('t2', 0.2), pedido('t3', 0.4)], tracesDaQueda: ['t1', 't2', 't3'] }), true);
  assert.deepEqual([r.acao, r.efeito], ['reinjetar', 'feito']);
  assert.deepEqual(w.reivindicados, ['conv1']);
  assert.deepEqual(w.avisos, ['777']);
  assert.deepEqual(w.agendados, ['t3', 't2', 't1']);
});

test('a reivindicação já era de outro (já retomada) → fecha, não reinjeta de novo', async () => {
  const { w, deps } = mundo({ vez: 'perdeu' });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['fechar', 'ja_retomada_antes']);
  assert.deepEqual([w.agendados, w.avisos], [[], []]);
});

test('o banco não confirmou a reivindicação → ADIADO: não reinjeta (resposta em dobro é pior que atraso)', async () => {
  const { w, deps } = mundo({ vez: 'incerto' });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.efeito], ['reinjetar', 'adiado']);
  assert.deepEqual([w.agendados, w.avisos], [[], []]);
});

test('burst cheio ou falha ao agendar → TAREFA para a recepção (a reivindicação fica gasta)', async () => {
  const { w, deps } = mundo({ agendarResultado: () => 'tarefa:burst_cheio' });
  const r = await retomarConversa(deps, candidata(), true);
  assert.equal(r.acao, 'tarefa');
  assert.match(r.motivo, /^falha_ao_retomar:/);
  assert.deepEqual(w.tarefas, ['t1']);
});

test('a tarefa que o Kommo recusa é FALHOU (aparece no relatório, não some)', async () => {
  const { deps } = mundo({ fora: true, tarefaLanca: true });
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.efeito], ['tarefa', 'falhou']);
});

test('tarefa que já existia (alerta de sem-resposta) não duplica: o resultado diz', async () => {
  const { deps } = mundo({ fora: true, tarefaJaExistia: true });
  const r = await retomarConversa(deps, candidata(), true);
  assert.equal(r.detalhe, 'a tarefa já existia');
});

test('a conversa anda ENTRE a decisão e a ação (a Sofia respondeu um recado novo) → fecha sem reivindicar nem criar tarefa', async () => {
  const { w, deps } = mundo({ fora: true });
  let chamadas = 0;
  deps.conversaAndou = async () => ++chamadas > 1; // livre na 1ª conferência, andou na 2ª (a de antes de agir)
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.motivo], ['fechar', 'conversa_andou_depois_da_queda']);
  assert.deepEqual([w.tarefas, w.reivindicados], [[], []]);
});

test('erro inesperado numa conversa não derruba a execução: vira TAREFA falhou', async () => {
  const { deps } = mundo();
  deps.unidadeDona = async () => {
    throw new Error('banco caiu');
  };
  const r = await retomarConversa(deps, candidata(), true);
  assert.deepEqual([r.acao, r.efeito, r.motivo], ['tarefa', 'falhou', 'erro_inesperado']);
});

// ── a execução ───────────────────────────────────────────────────────────────────────────────────────

test('executar em simulação: nada é esperado nem gravado; o resumo conta por ação, motivo e unidade', async () => {
  const { w, deps } = mundo();
  const a = candidata({ conversaId: 'a', pedidos: [pedido('ta', 0)] });
  const b = candidata({ conversaId: 'b', leadId: '888', pedidos: [pedido('tb', 0)] });
  const resumo = await executar(deps, [a, b], { aplicar: false, paralelo: 2 });
  assert.equal(resumo.interrompida, false);
  assert.deepEqual(resumo.porAcao, { reinjetar: 2 });
  assert.deepEqual([w.agendados, w.reivindicados, w.tarefas], [[], [], []]);
  assert.deepEqual(resumo.porUnidade, { [UNIT.slug]: { reinjetar: 2 } });
});

test('executar --aplicar: se a IA voltar a mandar a frase de queda, PARA — as conversas seguintes ficam intactas', async () => {
  const { w, deps } = mundo();
  deps.respondeuComQueda = async () => true;
  const cs = ['a', 'b', 'c', 'd'].map((id) => candidata({ conversaId: id, pedidos: [pedido(`t${id}`, 0)] }));
  const resumo = await executar(deps, cs, { aplicar: true, paralelo: 1 });
  assert.equal(resumo.interrompida, true);
  assert.equal(resumo.resultados.length, 1);
  assert.equal(resumo.resultados[0]!.efeito, 'falhou');
  assert.deepEqual(w.reivindicados, ['a']);
});

test('executar --aplicar: espera o turno terminar de cada conversa retomada', async () => {
  const { deps } = mundo();
  const esperadas: string[][] = [];
  deps.esperarTurno = async (ids) => {
    esperadas.push(ids);
    return true;
  };
  await executar(deps, [candidata({ conversaId: 'a', pedidos: [pedido('t1', 0), pedido('t2', 0.1)] })], { aplicar: true, paralelo: 1 });
  assert.deepEqual(esperadas, [['t1', 't2']]);
});

test('resumir: conta por ação e motivo', () => {
  const r = resumir([
    { conversaId: 'a', unidade: 'x', leadId: '1', mensagens: 1, acao: 'fechar', motivo: 'ia_pausada', efeito: 'nada' },
    { conversaId: 'b', unidade: 'x', leadId: '2', mensagens: 1, acao: 'fechar', motivo: 'ia_pausada', efeito: 'nada' },
    { conversaId: 'c', unidade: 'y', leadId: '3', mensagens: 1, acao: 'tarefa', motivo: 'fora_do_horario', efeito: 'simulado' },
  ]);
  assert.deepEqual(r.porMotivo, { 'fechar:ia_pausada': 2, 'tarefa:fora_do_horario': 1 });
  assert.deepEqual(r.porUnidade, { x: { fechar: 2 }, y: { tarefa: 1 } });
});

// ── o aviso que o turno retomado lê ──────────────────────────────────────────────────────────────────

test('o aviso de queda diz para responder tudo, não pedir para mandar de novo e não repetir o aviso; vale uma vez só', () => {
  limparNaoEntregues();
  marcarNaoEntregue('u1', 777, FALLBACK_INDISPONIVEL, Date.now(), 'queda');
  const presa = consumirNaoEntregueDetalhe('u1', 777);
  assert.equal(presa?.motivo, 'queda');
  const bloco = renderEntregaFalha(presa!.texto, presa!.motivo);
  assert.match(bloco, /TODAS as mensagens/);
  assert.match(bloco, /NÃO peça para ele mandar de novo/);
  assert.match(bloco, /desculpa a demora/);
  assert.match(bloco, /Opa, tive uma instabilidade/); // o aviso que ele recebeu vai citado, para o modelo reconhecer
  assert.equal(consumirNaoEntregueDetalhe('u1', 777), null);
});
