import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Estado } from '../automacoes-estado.js';
import { ErroDaAgenda, type AgendaDoEscritorio, type EventoNovo } from './agenda.js';
import { agendarAtendimento, consultarHorarios, encaminharAoThiago, type Deps, type PedidoDeAgendamento } from './atendimento.js';
import { instante, intervalosOcupados } from './horarios.js';
import type { ChaveDoAdvogado } from './config.js';

// Só dados inventados. A rede inteira é simulada: nenhum teste toca a Tramitação, o Kommo ou o WhatsApp.

const AMANDA = '5500000000001';
const THIAGO = '5500000000002';
const GRUPO = '120363000000000000@g.us';
const ETAPA = { pipelineId: 11, statusId: 22 };
const CHAVES = ['SOPHIA_GRUPO_INTERNO', 'SOPHIA_ADVOGADOS', 'SOPHIA_ETAPA_ANALISE_AGENDADA', 'SOPHIA_MEET_URL'] as const;
const guardado: Record<string, string | undefined> = {};

function configurar(sobrescrever: Partial<Record<(typeof CHAVES)[number], string | null>> = {}) {
  const base: Record<(typeof CHAVES)[number], string> = {
    SOPHIA_GRUPO_INTERNO: JSON.stringify({ esc: GRUPO }),
    SOPHIA_ADVOGADOS: JSON.stringify({ esc: { amanda: { numero: AMANDA }, victor: { numero: '5500000000003' }, thiago: { numero: THIAGO } } }),
    SOPHIA_ETAPA_ANALISE_AGENDADA: JSON.stringify({ esc: ETAPA }),
    SOPHIA_MEET_URL: JSON.stringify({ esc: 'https://meet.example/escritorio' }),
  };
  for (const k of CHAVES) {
    const v = sobrescrever[k] === undefined ? base[k] : sobrescrever[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  for (const k of CHAVES) guardado[k] = process.env[k];
  configurar();
});
afterEach(() => {
  for (const k of CHAVES) {
    if (guardado[k] === undefined) delete process.env[k];
    else process.env[k] = guardado[k];
  }
});

const AGORA = instante('2026-11-18', '05:00'); // quarta-feira

interface Rastro {
  criados: Array<{ adv: ChaveDoAdvogado; evento: EventoNovo }>;
  movidos: Array<{ leadId: number; destino: { pipelineId: number; statusId: number } }>;
  grupo: Array<{ grupo: string; texto: string; mencionar: string[] }>;
  simulados: Array<{ acao: string; alvo: string }>;
  passos: Array<{ tipo: string; titulo: string }>;
  avisos: Set<string>;
  cartoes: number;
}

function montar(opc: { estado?: Estado; ocupado?: Partial<Record<ChaveDoAdvogado, Array<{ start: string; end: string }>>>; jaExiste?: boolean; falhaLeitura?: ChaveDoAdvogado[]; falhaCriar?: boolean; grupoFalha?: boolean; moverFalha?: boolean; moverResultado?: 'moveu' | 'ja_na_etapa' | 'fora_do_funil' | 'terminal' } = {}) {
  const r: Rastro = { criados: [], movidos: [], grupo: [], simulados: [], passos: [], avisos: new Set(), cartoes: 0 };
  const agenda: AgendaDoEscritorio = {
    async ocupacao(adv) {
      if (opc.falhaLeitura?.includes(adv.chave)) throw new ErroDaAgenda('fora do ar');
      return intervalosOcupados(opc.ocupado?.[adv.chave] ?? []);
    },
    async jaExiste() {
      return opc.jaExiste ?? false;
    },
    async criar(adv, evento) {
      if (opc.falhaCriar) throw new ErroDaAgenda('Tramitação 422');
      r.criados.push({ adv: adv.chave, evento });
      return { id: 'atv_1' };
    },
  };
  const deps: Deps = {
    slug: 'esc',
    estado: () => opc.estado ?? 'ligado',
    agenda,
    agora: () => AGORA,
    telefoneDoLead: async () => '+5500000000009',
    mover: async (leadId, destino) => {
      if (opc.moverFalha) throw new Error('Kommo 400');
      r.movidos.push({ leadId, destino });
      return opc.moverResultado ?? 'moveu';
    },
    mandarNoGrupo: async (grupo, texto, mencionar) => {
      if (opc.grupoFalha) return false;
      r.grupo.push({ grupo, texto, mencionar });
      return true;
    },
    linkDoCartao: (id) => `https://exemplo.kommo.com/leads/detail/${id}`,
    jaAvisou: async (_l, chave) => r.avisos.has(chave),
    marcarAviso: async (_l, chave) => void r.avisos.add(chave),
    registrar: async (tipo, titulo) => void r.passos.push({ tipo, titulo }),
    simular: (_l, acao, alvo) => void r.simulados.push({ acao, alvo }),
    pedirCartaoDeChegada: () => void r.cartoes++,
    carimbo: () => '(Agenda consultada em 18/11/2026 às 05:00, horário da clínica.)',
  };
  return { deps, r };
}

const pedido = (extra: Partial<PedidoDeAgendamento> = {}): PedidoDeAgendamento => ({
  leadId: 777,
  nomeDoCliente: 'Maria de Teste Souza',
  cidade: 'Araguaína',
  estado: 'TO',
  caso: 'auxílio-doença cortado',
  temLaudoEExames: true,
  situacaoNoInss: 'benefício cessado',
  data: '2026-11-18',
  hora: '09:00',
  ...extra,
});

// ── consultar_horarios ──────────────────────────────────────────────────────────────────────────────────────────

test('consultar: devolve 2 horários reais no formato que as travas do grafo leem, com carimbo; ocupado não é oferecido', async () => {
  const { deps } = montar({ ocupado: { amanda: [{ start: '2026-11-18T08:00:00-03:00', end: '2026-11-18T08:50:00-03:00' }], victor: [{ start: '2026-11-18T08:00:00-03:00', end: '2026-11-18T09:50:00-03:00' }] } });
  const r = await consultarHorarios(deps, {});
  assert.equal(r.ok, true);
  assert.match(r.texto, /Horários CONFIRMADOS com a clínica em quarta-feira, 18\/11\/2026 \(2026-11-18\): 09:00, 14:00\. /);
  assert.match(r.texto, /Agenda consultada em 18\/11\/2026/);
  assert.doesNotMatch(r.texto, /08:00/, "08:00 está ocupado para os dois");
});

test('consultar: agenda ilegível = NENHUM horário (nada inventado) e a ordem de passar à equipe', async () => {
  const falhou = montar({ falhaLeitura: ['amanda', 'victor'] });
  const r = await consultarHorarios(falhou.deps, {});
  assert.equal(r.ok, false);
  assert.match(r.texto, /NÃO cite nenhum horário/);
  assert.doesNotMatch(r.texto, /Horários CONFIRMADOS/);
  assert.ok(falhou.r.passos.some((p) => p.tipo === 'ERROR'));
});

test('consultar: um advogado fora do ar não derruba o outro; horário só do que foi lido', async () => {
  const { deps } = montar({ falhaLeitura: ['amanda'] });
  const r = await consultarHorarios(deps, {});
  assert.equal(r.ok, true);
  assert.match(r.texto, /Dr\. Victor/);
  assert.doesNotMatch(r.texto, /Dra\. Amanda/);
});

test('consultar: turno da tarde só devolve tarde', async () => {
  const { deps } = montar();
  const r = await consultarHorarios(deps, { turno: 'tarde' });
  assert.match(r.texto, /\(2026-11-18\): 14:00\. /);
  assert.doesNotMatch(r.texto, /: (08|09|10|11):00/);
});

// ── agendar: seco ───────────────────────────────────────────────────────────────────────────────────────────────

for (const estado of ['seco', 'desligado'] as const) {
  test(`agendar em ${estado}: NADA sai — sem evento, sem mover cartão, sem grupo, sem cartão de chegada`, async () => {
    const { deps, r } = montar({ estado });
    const res = await agendarAtendimento(deps, pedido());
    assert.equal(r.criados.length, 0);
    assert.equal(r.movidos.length, 0);
    assert.equal(r.grupo.length, 0);
    assert.equal(r.cartoes, 0);
    if (estado === 'seco') {
      assert.equal(res.ok, true);
      assert.match(res.texto, /^Atendimento marcado para/, 'a trava "reservado sem marcar" reconhece');
      assert.match(res.texto, /MODO SECO/);
      // decide e registra: trace + tela de simulações
      assert.deepEqual(r.simulados.map((s) => s.alvo), ['tramitacao:evento', 'etapa:4 - Análise agendada', 'grupo:aviso-do-agendamento']);
      assert.ok(r.passos.some((p) => /só no papel/.test(p.titulo)));
    } else {
      assert.equal(res.ok, false);
      assert.deepEqual(r.simulados, []);
    }
  });
}

// ── agendar: ligado ─────────────────────────────────────────────────────────────────────────────────────────────

test('agendar ligado, presencial: evento no padrão, cartão na etapa, grupo marcando o advogado, cartão de chegada', async () => {
  const { deps, r } = montar();
  const res = await agendarAtendimento(deps, pedido({ advogado: 'amanda' }));
  assert.equal(res.ok, true);
  assert.match(res.texto, /^Atendimento marcado para quarta-feira, 18\/11\/2026 às 09:00 com Dra\. Amanda, presencial no escritório/);
  assert.equal(r.criados.length, 1);
  const { adv, evento } = r.criados[0]!;
  assert.equal(adv, 'amanda');
  assert.equal(evento.titulo, 'Atendimento - Maria de Teste Souza (Dra Amanda)');
  assert.equal(evento.inicio, instante('2026-11-18', '09:00'));
  assert.equal(evento.fim, instante('2026-11-18', '09:50'));
  assert.match(evento.descricao, /Presencial \(no escritório\)/);
  assert.match(evento.descricao, /Contato: \+5500000000009/, 'o telefone só vai para a Tramitação');
  assert.deepEqual(r.movidos, [{ leadId: 777, destino: ETAPA }]);
  assert.equal(r.grupo.length, 1);
  assert.equal(r.grupo[0]!.grupo, GRUPO);
  assert.deepEqual(r.grupo[0]!.mencionar, [AMANDA]);
  assert.match(r.grupo[0]!.texto, /👤 Cliente: Maria\n/);
  assert.match(r.grupo[0]!.texto, /👩‍⚖️ @5500000000001/);
  assert.doesNotMatch(r.grupo[0]!.texto, /5500000000009|Souza/, 'nem telefone nem sobrenome no grupo');
  assert.equal(r.cartoes, 1);
});

test('agendar ligado, outra cidade: online com o link do Meet configurado, sem cartão de chegada', async () => {
  const { deps, r } = montar();
  const res = await agendarAtendimento(deps, pedido({ cidade: 'Palmas', estado: 'TO' }));
  assert.match(res.texto, /online pelo Google Meet\. Link do Google Meet: https:\/\/meet\.example\/escritorio/);
  assert.equal(r.cartoes, 0);
  assert.match(r.criados[0]!.evento.descricao, /Google Meet: https:\/\/meet\.example\/escritorio/);
  assert.match(r.grupo[0]!.texto, /· online/);
});

test('agendar ligado, online SEM link configurado: a Sophia diz que a equipe envia o link', async () => {
  configurar({ SOPHIA_MEET_URL: null });
  const { deps } = montar();
  const res = await agendarAtendimento(deps, pedido({ cidade: 'Palmas' }));
  assert.match(res.texto, /link do Google Meet ainda não está configurado: diga que a equipe envia o link/);
});

test('agendar: sem o advogado informado, o sistema escolhe quem está livre', async () => {
  const { deps, r } = montar({ ocupado: { amanda: [{ start: '2026-11-18T09:00:00-03:00', end: '2026-11-18T09:50:00-03:00' }] } });
  await agendarAtendimento(deps, pedido());
  assert.equal(r.criados[0]!.adv, 'victor');
  assert.deepEqual(r.grupo[0]!.mencionar, ['5500000000003']);
});

test('agendar: horário ocupado, fora da grade, no passado ou em fim de semana é recusado e NADA é criado', async () => {
  const ocupa = { amanda: [{ start: '2026-11-18T09:00:00-03:00', end: '2026-11-18T09:50:00-03:00' }] };
  for (const [extra, quando] of [
    [{ advogado: 'amanda' as const }, 'ocupado'],
    [{ hora: '09:30' }, 'fora da grade'],
    [{ hora: '12:00' }, 'almoço'],
    [{ data: '2026-11-21', hora: '09:00' }, 'sábado'],
    [{ data: '2026-11-17', hora: '09:00' }, 'passado'],
    [{ data: '2026-12-25', hora: '09:00' }, 'feriado'],
  ] as const) {
    const { deps, r } = montar({ ocupado: ocupa });
    const res = await agendarAtendimento(deps, pedido(extra));
    assert.equal(res.ok, false, quando);
    assert.match(res.texto, /RECUSADO/, quando);
    assert.equal(r.criados.length + r.movidos.length + r.grupo.length, 0, quando);
  }
});

test('agendar: sem conseguir ler a agenda, NÃO agenda (falha fechada)', async () => {
  const { deps, r } = montar({ falhaLeitura: ['amanda'] });
  const res = await agendarAtendimento(deps, pedido({ advogado: 'amanda' }));
  assert.equal(res.ok, false);
  assert.match(res.texto, /NÃO agendei/);
  assert.equal(r.criados.length, 0);
});

test('agendar: evento não criado na Tramitação = nada confirmado, cartão e grupo intocados', async () => {
  const { deps, r } = montar({ falhaCriar: true });
  const res = await agendarAtendimento(deps, pedido());
  assert.equal(res.ok, false);
  assert.match(res.texto, /NÃO está agendado/);
  assert.doesNotMatch(res.texto, /^Atendimento marcado/);
  assert.equal(r.movidos.length + r.grupo.length + r.cartoes, 0);
});

test('agendar: cartão ou grupo falham DEPOIS do evento — o horário está na agenda, o aviso interno diz o que faltou, sem derrubar', async () => {
  const { deps, r } = montar({ moverFalha: true, grupoFalha: true });
  const res = await agendarAtendimento(deps, pedido());
  assert.equal(res.ok, true);
  assert.equal(r.criados.length, 1);
  assert.match(res.texto, /Interno, não diga ao cliente: cartão não movido; grupo não avisado/);
  assert.ok(r.passos.filter((p) => p.tipo === 'ERROR').length >= 2);
});

test('agendar: sem grupo ou sem etapa configurados, o evento sai e o resto fica registrado como pendente', async () => {
  configurar({ SOPHIA_GRUPO_INTERNO: null, SOPHIA_ETAPA_ANALISE_AGENDADA: null });
  const { deps, r } = montar();
  const res = await agendarAtendimento(deps, pedido());
  assert.equal(r.criados.length, 1);
  assert.equal(r.movidos.length + r.grupo.length, 0);
  assert.match(res.texto, /cartão não movido[\s\S]*grupo não avisado/);
});

test('agendar: chamada repetida (evento já na agenda) não cria outro nem avisa o grupo de novo', async () => {
  const { deps, r } = montar({ jaExiste: true });
  const um = await agendarAtendimento(deps, pedido({ advogado: 'amanda' }));
  assert.equal(um.ok, true);
  assert.equal(r.criados.length, 0, 'não duplica o evento');
  assert.equal(r.grupo.length, 1);
  await agendarAtendimento(deps, pedido({ advogado: 'amanda' }));
  assert.equal(r.grupo.length, 1, 'o grupo não recebe o mesmo aviso duas vezes');
  assert.equal(r.criados.length, 0);
});

// ── Dr. Thiago ──────────────────────────────────────────────────────────────────────────────────────────────────

test('Dr. Thiago ligado: NÃO agenda, marca o Dr. Thiago no grupo com o resumo e o link do cartão; uma vez só por cartão', async () => {
  const { deps, r } = montar();
  const res = await encaminharAoThiago(deps, { leadId: 5, nomeDoCliente: 'Carlos de Teste', cidade: 'Palmas', resumo: 'dívida tributária da empresa', motivo: 'tributario' });
  assert.equal(res.ok, true);
  assert.match(res.texto, /^Dr\. Thiago avisado/);
  assert.match(res.texto, /NÃO ofereça horário e NÃO agende/);
  assert.equal(r.criados.length + r.movidos.length, 0);
  assert.equal(r.grupo.length, 1);
  assert.deepEqual(r.grupo[0]!.mencionar, [THIAGO]);
  assert.match(r.grupo[0]!.texto, /Motivo: caso tributário/);
  assert.match(r.grupo[0]!.texto, /leads\/detail\/5/);
  assert.match(r.grupo[0]!.texto, /você consegue ligar para ele/);
  await encaminharAoThiago(deps, { leadId: 5, nomeDoCliente: 'Carlos', resumo: 'de novo', motivo: 'pediu_thiago' });
  assert.equal(r.grupo.length, 1);
});

test('Dr. Thiago em seco: registra e não manda; sem grupo ou grupo fora do ar: não promete que ele liga', async () => {
  const seco = montar({ estado: 'seco' });
  const a = await encaminharAoThiago(seco.deps, { leadId: 5, nomeDoCliente: 'Carlos', resumo: 'x', motivo: 'pediu_thiago' });
  assert.equal(a.ok, true);
  assert.equal(seco.r.grupo.length, 0);
  assert.deepEqual(seco.r.simulados.map((s) => s.alvo), ['grupo:aviso-dr-thiago']);

  const fora = montar({ grupoFalha: true });
  const b = await encaminharAoThiago(fora.deps, { leadId: 5, nomeDoCliente: 'Carlos', resumo: 'x', motivo: 'pediu_thiago' });
  assert.equal(b.ok, false);
  assert.match(b.texto, /NÃO prometa que ele vai ligar/);

  configurar({ SOPHIA_GRUPO_INTERNO: null });
  const sem = montar();
  const c = await encaminharAoThiago(sem.deps, { leadId: 5, nomeDoCliente: 'Carlos', resumo: 'x', motivo: 'tributario' });
  assert.equal(c.ok, false);
  assert.equal(sem.r.grupo.length, 0);
});
