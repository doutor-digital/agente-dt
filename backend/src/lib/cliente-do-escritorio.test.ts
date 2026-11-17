import test from 'node:test';
import assert from 'node:assert/strict';
import { portaClienteDoEscritorio, notaClienteDoEscritorio, calarClienteEstado, type PortaDeps } from './cliente-do-escritorio.js';
import { conferenciaPorRegraDeCliente, regraDeClienteDoAmbiente, type PortaDoKommo } from './disparo/conferencia.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';
import type { SituacaoNaFranquia } from './disparo/regras.js';

const unit = { id: 'u1', slug: 'magalhaes-advocacia' };
const FONE = '(63) 99102-1043';
const REGRA = regraDeClienteDoAmbiente('magalhaes-advocacia', {
  DISPARO_REGRA_CLIENTE: 'magalhaes-advocacia=14026239,13964971/108260519,13964971/142',
} as NodeJS.ProcessEnv);

function deps(situacao: SituacaoNaFranquia | Error, estado: 'ligado' | 'seco' | 'desligado' = 'ligado') {
  const calls = { conferiu: 0, notas: [] as string[], marcou: 0 };
  const d: PortaDeps = {
    estado,
    regra: REGRA,
    telefone: async () => FONE,
    conferir: async () => {
      calls.conferiu += 1;
      if (situacao instanceof Error) throw situacao;
      return situacao;
    },
    jaAvisou: async () => false,
    anotar: async (_id, texto) => {
      calls.notas.push(texto);
      return { id: 9 };
    },
    marcou: async () => {
      calls.marcou += 1;
    },
  };
  return { d, calls };
}

test('a regra do teste é a do disparo (funil Jurídico inteiro, Contrato assinado, ganho)', () => {
  assert.ok(REGRA);
  assert.ok(REGRA.funis.has(14026239));
  assert.ok(REGRA.etapas.has('13964971/108260519'));
  assert.ok(REGRA.etapas.has('13964971/142'));
});

test('chave desligada: nem lê o cartão', async () => {
  const { d, calls } = deps('ja-cliente', 'desligado');
  assert.equal(await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d), null);
  assert.equal(calls.conferiu, 0);
});

test('ligada + já é cliente: cala e deixa UMA nota', async () => {
  const { d, calls } = deps('ja-cliente');
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'Dr, e o meu processo?' }, d);
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, true);
  assert.equal(calls.notas.length, 1);
  assert.match(calls.notas[0], /CLIENTE do escritório/);
  assert.match(calls.notas[0], /meu processo/);
  assert.equal(calls.marcou, 1);
});

test('o Kommo criou a nota mas não devolveu o id: marca o aviso do dia (senão sairia uma nota por mensagem)', async () => {
  const { d, calls } = deps('ja-cliente');
  d.anotar = async (_id, texto) => {
    calls.notas.push(texto);
    return null;
  };
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.anotou, true);
  assert.equal(calls.marcou, 1);
});

test('ligada, mas já avisou hoje: cala sem repetir a nota', async () => {
  const { d, calls } = deps('ja-cliente');
  d.jaAvisou = async () => true;
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, false);
  assert.equal(calls.notas.length, 0);
});

test('só no papel: decide que calaria, mas não escreve nada (o webhook só registra neste estado)', async () => {
  const { d, calls } = deps('ja-cliente', 'seco');
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.estado, 'seco');
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, false);
  assert.equal(calls.notas.length, 0);
  assert.equal(calls.marcou, 0);
});

test('só `livre` deixa a IA seguir', async () => {
  const { d } = deps('livre');
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.calar, false);
});

test('FALHA FECHADA: Kommo indisponível (429), erro na leitura e cartão sumido CALAM, sem nota', async () => {
  for (const s of ['indisponivel', 'lead-inexistente'] as const) {
    const a = deps(s);
    const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, a.d);
    assert.equal(r?.calar, true, s);
    assert.equal(r?.anotou, false, s);
    assert.equal(a.calls.notas.length, 0, s);
  }
  const b = deps(new Error('429'));
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, b.d);
  assert.equal(r?.calar, true);
  assert.equal(r?.situacao, 'falhou');
  assert.equal(b.calls.notas.length, 0);
});

test('FALHA FECHADA: chave ligada sem regra da unidade CALA (e diz que faltou a regra); nem lê o Kommo', async () => {
  const { d, calls } = deps('livre');
  d.regra = null;
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.calar, true);
  assert.equal(r?.situacao, 'sem-regra');
  assert.equal(calls.conferiu, 0);
});

test('FALHA FECHADA: telefone do cartão ilegível ou erro ao lê-lo CALA (a conferência recebe telefone vazio e não prova nada)', async () => {
  const recebido: string[] = [];
  const { d } = deps('livre');
  d.telefone = async () => 'abc';
  d.conferir = async (p) => (recebido.push(p.telefone), p.telefone ? 'livre' : 'indisponivel');
  assert.equal((await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d))?.calar, true);
  assert.deepEqual(recebido, ['']);
  d.telefone = async () => {
    throw new Error('429');
  };
  assert.equal((await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d))?.calar, true);
});

test('a conferência recebe o telefone do cartão normalizado (13 dígitos), não o texto do Kommo', async () => {
  const recebido: string[] = [];
  const { d } = deps('livre');
  d.conferir = async (p) => (recebido.push(p.telefone), 'livre');
  await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.deepEqual(recebido, ['5563991021043']);
});

// ─── a conferência de verdade (a do disparo, com #322) contra um Kommo falso ──────────────────────────────────────────────────
const JURIDICO = 14026239;
const COMERCIAL = 13964971;
const LEAD_NOVO = 108260499;

function kommoFalso(opcoes: { contatosDoMundo: Array<{ id: number; telefones: string[]; leadIds: number[] }>; falha?: 'getLead' | 'lista' | 'busca' }): PortaDoKommo {
  const cartoes: Record<number, { pipeline_id: number; status_id: number }> = {
    10: { pipeline_id: COMERCIAL, status_id: LEAD_NOVO }, // o cartão novo, criado pelo WhatsApp
    5: { pipeline_id: JURIDICO, status_id: 108260623 }, // o cartão antigo do cliente, em outro contato
  };
  return {
    getLead: async (id) => {
      if (opcoes.falha === 'getLead') throw new Error('kommo 429');
      return { id, ...cartoes[id], _embedded: { contacts: [{ id: 2 }] } };
    },
    leadsDoContato: async (c) => (c === 2 ? [10] : []),
    contatosPorTelefone: async () => {
      if (opcoes.falha === 'busca') throw new Error('kommo 429');
      return opcoes.contatosDoMundo;
    },
    listLeadsPorIds: async (ids) => {
      if (opcoes.falha === 'lista') throw new Error('kommo 429');
      return ids.filter((i) => cartoes[i]).map((i) => ({ id: i, ...cartoes[i] }));
    },
  };
}

const COM_O_NOVO = { id: 2, telefones: ['+55 63 99102-1043'], leadIds: [10] };
const comKommo = (k: PortaDoKommo) => ({ ...deps('livre').d, conferir: conferenciaPorRegraDeCliente(unit, REGRA!, k) });

test('CONTATO DUPLICADO com o mesmo telefone: o antigo tem cartão no Jurídico, o novo (do WhatsApp) não — a Sophia CALA e deixa a nota', async () => {
  const d = comKommo(kommoFalso({ contatosDoMundo: [COM_O_NOVO, { id: 1, telefones: ['63 99102-1043'], leadIds: [5] }] }));
  const notas: string[] = [];
  d.anotar = async (_i, t) => (notas.push(t), { id: 1 });
  const r = await portaClienteDoEscritorio({ unit, leadId: 10, humanMessage: 'e o meu processo?' }, d);
  assert.equal(r?.situacao, 'ja-cliente');
  assert.equal(r?.calar, true);
  assert.equal(notas.length, 1);
});

test('contato duplicado com telefone escrito diferente (dígito a mais, hífen invisível U+00AD): também CALA', async () => {
  for (const tel of ['63 99102-1043 1', '63 99102\u00AD-1043', '(63) 9 9102-1043']) {
    const d = comKommo(kommoFalso({ contatosDoMundo: [COM_O_NOVO, { id: 1, telefones: [tel], leadIds: [5] }] }));
    const r = await portaClienteDoEscritorio({ unit, leadId: 10, humanMessage: 'oi' }, d);
    assert.equal(r?.calar, true, tel);
  }
});

test('lead de verdade: sem outro contato com o telefone, a conferência prova `livre` e a Sophia SEGUE', async () => {
  const r = await portaClienteDoEscritorio({ unit, leadId: 10, humanMessage: 'oi' }, comKommo(kommoFalso({ contatosDoMundo: [COM_O_NOVO] })));
  assert.equal(r?.situacao, 'livre');
  assert.equal(r?.calar, false);
});

test('429 do Kommo em QUALQUER ponto da conferência (cartão, busca por telefone, leitura dos outros cartões): CALA', async () => {
  for (const falha of ['getLead', 'busca', 'lista'] as const) {
    const contatosDoMundo = [COM_O_NOVO, { id: 1, telefones: ['63 99102-1043'], leadIds: [5] }];
    const r = await portaClienteDoEscritorio({ unit, leadId: 10, humanMessage: 'oi' }, comKommo(kommoFalso({ contatosDoMundo, falha })));
    assert.equal(r?.calar, true, falha);
    assert.equal(r?.anotou, false, falha);
  }
});

test('BANCO FORA: a chave não nasce desligada para quem tem regra de cliente no servidor (falha fechada); depois que o banco responde, vale o que ele disse', () => {
  const antes = process.env.DISPARO_REGRA_CLIENTE;
  process.env.DISPARO_REGRA_CLIENTE = 'magalhaes-advocacia=14026239';
  try {
    _esquecerOBancoParaTeste();
    assert.equal(calarClienteEstado('magalhaes-advocacia', undefined), 'ligado'); // banco mudo + regra no servidor
    assert.equal(calarClienteEstado('doutor-hernia-salto', undefined), 'desligado'); // sem regra: nada muda nas outras
    _semearParaTeste([]); // o banco respondeu e a tela nunca falou
    assert.equal(calarClienteEstado('magalhaes-advocacia', undefined), 'desligado');
    _semearParaTeste([{ slug: 'magalhaes-advocacia', automacao: 'calar-cliente-do-escritorio', estado: 'seco' }]);
    assert.equal(calarClienteEstado('magalhaes-advocacia', undefined), 'seco');
  } finally {
    if (antes === undefined) delete process.env.DISPARO_REGRA_CLIENTE;
    else process.env.DISPARO_REGRA_CLIENTE = antes;
    _esquecerOBancoParaTeste();
  }
});

test('falha ao deixar a nota não destrava a IA: segue calada', async () => {
  const { d } = deps('ja-cliente');
  d.anotar = async () => {
    throw new Error('429');
  };
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, false);
});

test('a chave nasce desligada (nada muda no deploy) e liga pela lista do ambiente', () => {
  assert.equal(calarClienteEstado('magalhaes-advocacia', undefined), 'desligado');
  assert.equal(calarClienteEstado('magalhaes-advocacia', 'magalhaes-advocacia'), 'ligado');
  assert.equal(calarClienteEstado('doutor-hernia-salto', 'magalhaes-advocacia'), 'desligado');
});

test('a nota é curta e corta a fala longa', () => {
  const n = notaClienteDoEscritorio('x'.repeat(500));
  assert.ok(n.length < 300);
  assert.match(n, /…/);
});
