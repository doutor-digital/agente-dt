import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  agendarRevisaoDeSaida,
  estadoDaRevisora,
  LimiteDaRevisora,
  montarEntrada,
  precosDaUnidade,
  revisarSaida,
  type DependenciasDaRevisora,
  type PedidoDeRevisao,
} from './revisora-de-saida.service.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from '../lib/automacoes-estado.js';
import { guardarStatusDoTurno } from '../lib/revisora-de-saida-contexto.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from '../lib/automacoes.js';

const FICHA = 'A CONSULTA: R$ 350 no dia, ou R$ 250 com pagamento antecipado. O sinal de R$ 50 garante o horário.';

const unidade = (over: Partial<Unit> = {}): Unit =>
  ({
    id: 'u1',
    slug: 'caxias',
    name: 'Doutor Hérnia Caxias',
    sourceProdutos: FICHA,
    systemPrompt: '',
    anthropicApiKey: null,
    businessHoursTimezone: 'America/Sao_Paulo',
    spineTimezone: null,
    clinicAddress: 'Rua A, 10',
    pixKey: null,
    ...over,
  }) as unknown as Unit;

const pedido = (over: Partial<PedidoDeRevisao> = {}): PedidoDeRevisao => ({
  unit: unidade(),
  leadId: 777,
  traceId: 'trace-1',
  conversationId: 'conv-1',
  textoEnviado: 'Oi! Me conta onde está doendo?',
  mensagensDoGrafo: [],
  status: null,
  ...over,
});

interface Registro {
  gravadas: any[];
  chamadas: any[];
  papel: any[];
  modelo: Array<{ system: string; user: string; prazoMs: number }>;
}

function deps(
  resposta: string | Error,
  over: Partial<DependenciasDaRevisora> = {},
  agora = new Date('2026-11-18T17:30:00Z'), // 14:30 em São Paulo
): { d: DependenciasDaRevisora; r: Registro } {
  const r: Registro = { gravadas: [], chamadas: [], papel: [], modelo: [] };
  const d: DependenciasDaRevisora = {
    carregarMensagens: async () => [{ role: 'user', content: 'oi', createdAt: new Date(agora.getTime() - 60_000) }],
    chamarModelo: async (_e, system, user, _u, prazoMs) => {
      r.modelo.push({ system, user, prazoMs });
      if (resposta instanceof Error) throw resposta;
      return { text: resposta, promptTokens: 1500, completionTokens: 40, stopReason: 'end_turn', raw: {} };
    },
    gravar: async (data) => void r.gravadas.push(data),
    registrarChamada: (p) => void r.chamadas.push(p),
    registrarNoPapel: (_u, leadId, c) => void r.papel.push({ leadId, c }),
    agora: () => agora,
    ...over,
  };
  return { d, r };
}

const APROVA = '{"veredito":"aprova","violacoes":[]}';
const BARRA_SEM_CUSTO = '{"veredito":"barraria","violacoes":[{"regra":"sem_custo","motivo":"disse que a consulta é grátis","trecho":"sem custo"}]}';

beforeEach(() => _esquecerOBancoParaTeste());
afterEach(() => _esquecerOBancoParaTeste());

// ── catálogo ──────────────────────────────────────────────────────────────────────────────────────

test('catálogo: a revisora nasce em SECO com a rede toda (quandoVazio seco, temSeco), e o catálogo continua válido', () => {
  const a = automacaoPorId('revisora-de-saida');
  assert.ok(a, 'está no catálogo, senão fica invisível na tela');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'seco');
  assert.equal(a.chave, 'REVISORA_SAIDA_SLUGS');
  assert.deepEqual(verificarCatalogo(AUTOMACOES), []);
});

test('estado: sem ninguém gravar nada (banco vazio e sem variável) a revisora roda SECA em qualquer unidade', () => {
  _semearParaTeste([]);
  assert.equal(estadoDaRevisora('caxias', {}), 'seco');
  assert.equal(estadoDaRevisora('qualquer-outra', {}), 'seco');
});

test('estado: a tela desliga por unidade, e a outra segue seca', () => {
  _semearParaTeste([{ slug: 'caxias', automacao: 'revisora-de-saida', estado: 'desligado' }]);
  assert.equal(estadoDaRevisora('caxias', {}), 'desligado');
  assert.equal(estadoDaRevisora('petropolis', {}), 'seco');
});

// ── a revisão ─────────────────────────────────────────────────────────────────────────────────────

test('aprova: grava UMA linha com veredito aprova, sem regras, com custo e modelo', async () => {
  const { d, r } = deps(APROVA);
  const out = await revisarSaida(pedido(), d);
  assert.equal(out.veredito, 'aprova');
  assert.equal(r.gravadas.length, 1);
  const g = r.gravadas[0];
  assert.deepEqual([g.veredito, g.regras, g.modo, g.leadId, g.unitId, g.traceId], ['aprova', [], 'seco', '777', 'u1', 'trace-1']);
  assert.equal(g.textoEnviado, 'Oi! Me conta onde está doendo?');
  assert.equal(g.provedor, 'openai');
  assert.equal(g.modelo, 'gpt-4o-mini');
  assert.equal(g.promptTokens, 1500);
  assert.ok(Number(g.costUsd) > 0, 'o custo é calculado');
  assert.equal(g.erro, null);
  assert.equal(r.papel.length, 0, 'aprovou: nada na tela');
});

test('barraria: grava a regra, o motivo e o trecho; a tela «só no papel» recebe', async () => {
  const { d, r } = deps(BARRA_SEM_CUSTO);
  const out = await revisarSaida(pedido({ textoEnviado: 'A avaliação é sem custo, pode vir!' }), d);
  assert.equal(out.veredito, 'barraria');
  const g = r.gravadas[0];
  assert.deepEqual(g.regras, ['sem_custo']);
  assert.equal(g.violacoes[0].motivo, 'disse que a consulta é grátis');
  assert.equal(g.violacoes[0].origem, 'modelo');
  assert.equal(r.papel.length, 1);
  assert.equal(r.papel[0].leadId, 777);
});

test('o modelo recebe o prazo de 8 s, o texto enviado, a hora local e a tabela da unidade', async () => {
  const { d, r } = deps(APROVA);
  await revisarSaida(pedido({ textoEnviado: 'R$ 250 garantindo com sinal de R$ 250 antecipado' }), d);
  const m = r.modelo[0]!;
  assert.equal(m.prazoMs, 8000);
  assert.match(m.user, /R\$ 250 garantindo com sinal de R\$ 250 antecipado/);
  assert.match(m.user, /quarta-feira, 14:30/);
  assert.match(m.user, /Consulta: R\$ 350 no dia/);
  assert.match(m.system, /preco_contraditorio/);
});

test('JSON quebrado do modelo: sem_veredito + erro, NUNCA barraria', async () => {
  const { d, r } = deps('{"veredito":"barraria","violacoes":[{"regra":"sem_cus');
  const out = await revisarSaida(pedido(), d);
  assert.equal(out.veredito, 'sem_veredito');
  assert.equal(out.falhouOProvedor, false, 'o provedor respondeu; só o formato falhou');
  assert.equal(r.gravadas[0].veredito, 'sem_veredito');
  assert.equal(r.gravadas[0].erro, 'resposta_invalida');
  assert.deepEqual(r.gravadas[0].regras, []);
  assert.equal(r.papel.length, 0);
});

test('resposta cortada (max_tokens/refusal) é sem veredito mesmo que o JSON pareça bom', async () => {
  for (const stop of ['max_tokens', 'refusal']) {
    const { d, r } = deps(APROVA, {
      chamarModelo: async () => ({ text: BARRA_SEM_CUSTO, promptTokens: 10, completionTokens: 700, stopReason: stop, raw: {} }),
    });
    const out = await revisarSaida(pedido(), d);
    assert.equal(out.veredito, 'sem_veredito', stop);
    assert.match(r.gravadas[0].erro, new RegExp(`resposta_cortada:${stop}`));
  }
});

test('erro/timeout do provedor: sem_veredito, erro gravado, falhouOProvedor, e nada lança', async () => {
  const { d, r } = deps(new Error('revisora: sem resposta em 8000 ms'));
  const out = await revisarSaida(pedido(), d);
  assert.equal(out.veredito, 'sem_veredito');
  assert.equal(out.falhouOProvedor, true);
  assert.match(r.gravadas[0].erro, /sem resposta em 8000 ms/);
  assert.equal(r.chamadas[0].status, 'error', 'a falha do provedor também fica no llm_calls');
});

test('bom dia às 14h30: o CÓDIGO barra a regra 8 mesmo com o modelo fora do ar', async () => {
  const { d, r } = deps(new Error('provedor caiu'));
  const out = await revisarSaida(pedido({ textoEnviado: 'Bom dia! Como posso ajudar?' }), d);
  assert.equal(out.veredito, 'barraria');
  assert.deepEqual(r.gravadas[0].regras, ['cumprimento_fora_de_hora']);
  assert.equal(r.gravadas[0].violacoes[0].origem, 'codigo');
  assert.match(r.gravadas[0].erro, /provedor caiu/, 'o erro do modelo continua registrado');
});

test('bom dia + modelo aprova: a regra de código vale (fuso da unidade: Boa Vista 13h30 também é fora)', async () => {
  const { d, r } = deps(APROVA);
  await revisarSaida(pedido({ unit: unidade({ businessHoursTimezone: 'America/Boa_Vista' }), textoEnviado: 'Bom dia!' }), d);
  assert.deepEqual(r.gravadas[0].regras, ['cumprimento_fora_de_hora']);
});

test('falha NOSSA ao montar a entrada (ficha mal formada) não é falha do provedor: sem chamar o modelo, sem alimentar o disjuntor, e a regra 8 ainda roda', async () => {
  const { d, r } = deps(APROVA);
  const ruim = unidade();
  Object.defineProperty(ruim, 'sourceProdutos', { get: () => { throw new Error('ficha explodiu'); } });
  const out = await revisarSaida(pedido({ unit: ruim, textoEnviado: 'Bom dia!' }), d);
  assert.equal(out.falhouOProvedor, false);
  assert.equal(r.modelo.length, 0);
  assert.equal(r.chamadas.length, 0, 'nada foi pago');
  assert.match(r.gravadas[0].erro, /entrada_falhou: ficha explodiu/);
  assert.deepEqual(r.gravadas[0].regras, ['cumprimento_fora_de_hora']);
});

test('resposta fora do formato gasta token mas NÃO é falha do provedor no llm_calls (status success, motivo em errorMessage)', async () => {
  const { d, r } = deps('lixo');
  await revisarSaida(pedido(), d);
  assert.equal(r.chamadas[0].status, 'success');
  assert.equal(r.chamadas[0].errorMessage, 'resposta_invalida');
  assert.equal(r.chamadas[0].traceId, null, 'fora do custo do turno e do teto por conversa');
});

test('falha ao GRAVAR não lança (a resposta já saiu) e a revisão ainda devolve o desfecho', async () => {
  const { d } = deps(BARRA_SEM_CUSTO, {
    gravar: async () => {
      throw new Error('banco fora');
    },
  });
  const out = await revisarSaida(pedido(), d);
  assert.equal(out.veredito, 'barraria');
});

test('falha ao carregar as falas: segue sem elas e marca o início como não visível', async () => {
  const { d, r } = deps(APROVA, {
    carregarMensagens: async () => {
      throw new Error('select falhou');
    },
  });
  const out = await revisarSaida(pedido(), d);
  assert.equal(out.veredito, 'aprova');
  assert.match(r.modelo[0]!.user, /primeira resposta/);
});

test('chave Anthropic da unidade → o pedido vai ao Haiku 5.5 e a linha diz isso', async () => {
  const { d, r } = deps(APROVA);
  await revisarSaida(pedido({ unit: unidade({ anthropicApiKey: 'sk-ant-xyz' } as Partial<Unit>) }), d);
  assert.deepEqual([r.gravadas[0].provedor, r.gravadas[0].modelo], ['anthropic', 'claude-haiku-5-5']);
  assert.equal(r.chamadas[0].provider, 'anthropic');
  assert.equal(r.chamadas[0].requestBody.revisora, true);
});

test('o status do paciente e as ferramentas do turno chegam à revisora', async () => {
  const { d, r } = deps(APROVA);
  await revisarSaida(
    pedido({
      status: { emTratamento: true, jaAtendido: false, consultaMarcada: null },
      mensagensDoGrafo: [
        { getType: () => 'human', content: 'oi' },
        { getType: () => 'ai', content: '', tool_calls: [{ name: 'consultar_horarios', id: 'a' }] },
        { getType: () => 'tool', content: 'quinta 9h', tool_call_id: 'a' },
      ],
    }),
    d,
  );
  assert.match(r.modelo[0]!.user, /JÁ TEM TRATAMENTO/);
  assert.match(r.modelo[0]!.user, /consultar_horarios → quinta 9h/);
});

test('o texto enviado é gravado inteiro (até 4000) para dar para ler o que o paciente recebeu', async () => {
  const { d, r } = deps(APROVA);
  await revisarSaida(pedido({ textoEnviado: 'x'.repeat(9000) }), d);
  assert.equal(r.gravadas[0].textoEnviado.length, 4000);
});

// ── tabela de preço e sinal ───────────────────────────────────────────────────────────────────────

test('precosDaUnidade: sinal declarado na ficha ("sinal de R$ 50") entra mesmo sem a flag', () => {
  assert.deepEqual(precosDaUnidade(unidade()), { noDia: 350, antecipado: 250, sinal: 50, restoNoDia: 200 });
});

test('precosDaUnidade: sinal pela flag sinalPixCentavos; sem sinal na ficha nem flag = null', () => {
  const comFlag = unidade({ sourceProdutos: 'R$ 350 no dia, ou R$ 250 com pagamento antecipado.', sinalPixCentavos: 5000 } as Partial<Unit>);
  assert.deepEqual(precosDaUnidade(comFlag), { noDia: 350, antecipado: 250, sinal: 50, restoNoDia: 200 });
  const semSinal = unidade({ sourceProdutos: 'R$ 350 no dia, ou R$ 250 com pagamento antecipado.' });
  assert.deepEqual(precosDaUnidade(semSinal), { noDia: 350, antecipado: 250, sinal: null, restoNoDia: null });
  assert.equal(precosDaUnidade(unidade({ sourceProdutos: 'sem preços aqui' })), null);
});

test('montarEntrada: falas do banco entram sem a resposta recém-gravada, com autor da equipe', async () => {
  const agora = new Date('2026-11-18T17:30:00Z');
  const { d } = deps(APROVA, {
    carregarMensagens: async () => [
      { role: 'assistant', content: 'Oi! Me conta onde está doendo?', createdAt: agora },
      { role: 'assistant', content: 'Pode vir amanhã às 9h', meta: { autor: 'equipe' }, createdAt: new Date(agora.getTime() - 120_000) },
      { role: 'user', content: 'posso ir amanhã?', createdAt: new Date(agora.getTime() - 180_000) },
    ],
  });
  const e = await montarEntrada(pedido(), d);
  assert.deepEqual(e.falas.map((f) => [f.autor, f.haMin]), [['paciente', 3], ['equipe', 2]]);
  assert.equal(e.hora.hora, 14);
  assert.equal(e.endereco, 'Rua A, 10');
});

// ── limites ───────────────────────────────────────────────────────────────────────────────────────

test('limite: acima de N em voo a revisão é PULADA, e vaga liberada volta a servir', () => {
  const l = new LimiteDaRevisora(2, 5, 1000);
  assert.equal(l.pedir('a', 0).ok, true);
  assert.equal(l.pedir('b', 0).ok, true);
  const nao = l.pedir('a', 0);
  assert.deepEqual(nao, { ok: false, motivo: 'muitas_em_voo' });
  l.terminou('a', false, 0);
  assert.equal(l.pedir('a', 0).ok, true);
  assert.equal(l.puladasTotal, 1);
});

test('disjuntor: N falhas SEGUIDAS do provedor abrem por 1 min; sucesso no meio zera', () => {
  const l = new LimiteDaRevisora(10, 3, 60_000);
  for (let i = 0; i < 2; i++) { l.pedir('a', 0); assert.equal(l.terminou('a', true, 0).abriu, false); }
  l.pedir('a', 0); l.terminou('a', false, 0); // sucesso zera
  for (let i = 0; i < 2; i++) { l.pedir('a', 0); assert.equal(l.terminou('a', true, 0).abriu, false); }
  l.pedir('a', 0);
  assert.equal(l.terminou('a', true, 1_000).abriu, true);
  assert.deepEqual(l.pedir('a', 2_000), { ok: false, motivo: 'disjuntor_aberto' });
  assert.equal(l.pedir('a', 61_001).ok, true, 'passou a pausa: tenta de novo');
});

test('disjuntor é POR UNIDADE: a chave ruim de uma não silencia as outras, e o sucesso das outras não segura a dela fechada', () => {
  const l = new LimiteDaRevisora(10, 3, 60_000);
  // alterna: a unidade ruim falha, as boas têm sucesso no meio — com disjuntor único ele nunca abriria
  for (let i = 0; i < 3; i++) {
    l.pedir('salto', 0);
    l.terminou('salto', true, 0);
    l.pedir('caxias', 0);
    l.terminou('caxias', false, 0);
  }
  assert.deepEqual(l.pedir('salto', 1_000), { ok: false, motivo: 'disjuntor_aberto' });
  assert.equal(l.pedir('caxias', 1_000).ok, true);
  assert.equal(l.pedir('petropolis', 1_000).ok, true);
});

// ── a porta de entrada: nada vaza para o paciente, estado manda ───────────────────────────────────

const esperar = () => new Promise((res) => setTimeout(res, 20));

test('porta: devolve void na hora, sem esperar o modelo, e grava depois', async () => {
  _semearParaTeste([]);
  let solta!: () => void;
  const travado = new Promise<void>((res) => (solta = res));
  const { d, r } = deps(APROVA, {
    chamarModelo: async () => {
      await travado;
      return { text: APROVA, promptTokens: 1, completionTokens: 1, stopReason: 'end_turn', raw: {} };
    },
  });
  const t0 = Date.now();
  const ret = agendarRevisaoDeSaida({ unit: unidade(), leadId: 1, traceId: 'tp1', conversationId: 'c', textoEnviado: 'Oi', mensagensDoGrafo: [] }, d);
  assert.equal(ret, undefined);
  assert.ok(Date.now() - t0 < 50);
  assert.equal(r.gravadas.length, 0, 'ainda não gravou: o modelo está pendurado');
  solta();
  await esperar();
  assert.equal(r.gravadas.length, 1);
});

test('porta: unidade DESLIGADA na tela não chama o modelo nem grava, mas consome a marca do grafo', async () => {
  _semearParaTeste([{ slug: 'caxias', automacao: 'revisora-de-saida', estado: 'desligado' }]);
  const { d, r } = deps(APROVA);
  guardarStatusDoTurno('tp2', { emTratamento: true, jaAtendido: false, consultaMarcada: null });
  agendarRevisaoDeSaida({ unit: unidade(), leadId: 1, traceId: 'tp2', conversationId: 'c', textoEnviado: 'Oi', mensagensDoGrafo: [] }, d);
  await esperar();
  assert.equal(r.modelo.length, 0);
  assert.equal(r.gravadas.length, 0);
});

test('porta: estado LIGADO ainda só registra (roda como seco)', async () => {
  _semearParaTeste([{ slug: 'caxias', automacao: 'revisora-de-saida', estado: 'ligado' }]);
  const { d, r } = deps(BARRA_SEM_CUSTO);
  agendarRevisaoDeSaida({ unit: unidade(), leadId: 1, traceId: 'tp3', conversationId: 'c', textoEnviado: 'sem custo', mensagensDoGrafo: [] }, d);
  await esperar();
  assert.equal(r.gravadas.length, 1);
  assert.equal(r.gravadas[0].modo, 'seco');
});

test('porta: o status guardado pelo grafo chega à revisora', async () => {
  _semearParaTeste([]);
  const { d, r } = deps(APROVA);
  guardarStatusDoTurno('tp4', { emTratamento: true, jaAtendido: true, consultaMarcada: null });
  agendarRevisaoDeSaida({ unit: unidade(), leadId: 1, traceId: 'tp4', conversationId: 'c', textoEnviado: 'Oi', mensagensDoGrafo: [] }, d);
  await esperar();
  assert.match(r.modelo[0]!.user, /JÁ TEM TRATAMENTO/);
});

test('porta: texto vazio não revisa; dependência que explode na hora não lança para quem chamou', async () => {
  _semearParaTeste([]);
  const { d, r } = deps(APROVA);
  agendarRevisaoDeSaida({ unit: unidade(), leadId: 1, traceId: 'tp5', conversationId: 'c', textoEnviado: '   ', mensagensDoGrafo: [] }, d);
  await esperar();
  assert.equal(r.modelo.length, 0);
  assert.doesNotThrow(() =>
    agendarRevisaoDeSaida({ unit: null as unknown as Unit, leadId: 1, traceId: 'tp6', conversationId: 'c', textoEnviado: 'Oi', mensagensDoGrafo: [] }, d),
  );
});
