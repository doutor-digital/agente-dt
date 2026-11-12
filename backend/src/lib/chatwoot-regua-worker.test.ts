/**
 * O ciclo da régua do Chatwoot com portas falsas (sem banco, sem rede): seco só deixa nota privada, ligado manda de verdade,
 * nunca repete, desfaz o registro quando a nota/mensagem falha, respeita os tetos e não toca em nada se a listagem falhar.
 * Datas: 2026-11-16 é segunda; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automacaoPorId, verificarCatalogo } from './automacoes.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { cicloDaCaixa, finalDoTelefone, numeroDaGerente, MAX_ETIQUETAS_POR_CICLO, MAX_MENSAGENS_POR_CICLO, type Armazem, type Chat, type DepsDoCiclo, type LinhaVista } from './chatwoot-regua-worker.js';
import type { DadosDaUnidade, MensagemResumo, Mudanca } from './chatwoot-regua.js';

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const unix = (s: string) => Math.floor(new Date(s).getTime() / 1000);

function bruta(id: number, o: { attrs?: Record<string, unknown>; labels?: string[]; ultima?: { tipo: number; autor: number; privada?: boolean }; nome?: string } = {}) {
  return {
    id,
    created_at: unix('2026-10-01T12:00:00Z'),
    labels: o.labels ?? [],
    custom_attributes: o.attrs ?? {},
    meta: { sender: { name: o.nome ?? 'Maria da Silva', phone_number: '+5594999990000' }, assignee: { name: 'Ana' } },
    last_non_activity_message: o.ultima ? { message_type: o.ultima.tipo, private: o.ultima.privada ?? false, created_at: unix('2026-11-16T10:00:00Z'), sender: { id: o.ultima.autor, type: 'user' } } : null,
  };
}

function armazemFalso() {
  const vistos: LinhaVista[] = [];
  const disparos: Array<{ caixa: number; conversationId: number; regra: string; chave: string; modo: string; texto: string }> = [];
  const armazem: Armazem = {
    async vistos() {
      return vistos.map((v) => ({ ...v }));
    },
    async salvar(_caixa, mudancas: Array<Mudanca & { conversationId: number }>) {
      for (const m of mudancas) {
        const i = vistos.findIndex((v) => v.conversationId === m.conversationId && v.campo === m.campo);
        if (m.tipo === 'remover') {
          if (i >= 0) vistos.splice(i, 1);
        } else if (m.tipo === 'atualizar') {
          if (i >= 0) vistos[i] = { ...vistos[i]!, valor: m.valor, desde: m.desde, inicial: false };
        } else if (i < 0) {
          vistos.push({ conversationId: m.conversationId, campo: m.campo, valor: m.valor, desde: m.desde, inicial: m.inicial });
        }
      }
    },
    async feitos() {
      return disparos.map((d) => ({ conversationId: d.conversationId, regra: d.regra, chave: d.chave }));
    },
    async registrar(l) {
      if (disparos.some((d) => d.conversationId === l.conversationId && d.regra === l.regra && d.chave === l.chave)) return false;
      disparos.push(l);
      return true;
    },
    async desfazer(conversationId, regra, chave) {
      const i = disparos.findIndex((d) => d.conversationId === conversationId && d.regra === regra && d.chave === chave);
      if (i >= 0) disparos.splice(i, 1);
    },
  };
  return { armazem, vistos, disparos };
}

function chatFalso(
  conversas: () => unknown[],
  o: { falhaAoEscrever?: () => unknown; falhaAoListar?: boolean; ultimaPublica?: MensagemResumo | null } = {},
) {
  const mensagens: Array<{ id: number; texto: string; privada: boolean }> = [];
  const etiquetas: Array<{ id: number; lista: string[] }> = [];
  const atributos: Array<{ id: number; attrs: Record<string, unknown> }> = [];
  const prioridades: Array<{ id: number; p: string }> = [];
  const atribuicoes: Array<{ id: number; agente: number }> = [];
  const buscasDaUltima: number[] = [];
  const chat: Chat = {
    async atribuir(id, agente) {
      atribuicoes.push({ id, agente });
    },
    async atributos(id, attrs) {
      atributos.push({ id, attrs });
    },
    async prioridade(id, p) {
      prioridades.push({ id, p });
    },
    async ultimaPublica(id) {
      buscasDaUltima.push(id);
      return o.ultimaPublica ?? null;
    },
    async pagina(_caixa, pagina) {
      if (o.falhaAoListar) throw new Error('Chatwoot fora do ar');
      const todas = conversas();
      return todas.slice((pagina - 1) * 25, pagina * 25);
    },
    async mensagem(id, texto, privada) {
      const f = o.falhaAoEscrever?.();
      if (f) throw f;
      mensagens.push({ id, texto, privada });
    },
    async etiquetas(id, lista) {
      etiquetas.push({ id, lista });
    },
  };
  return { chat, mensagens, etiquetas, atributos, prioridades, atribuicoes, buscasDaUltima };
}

const deps = (armazem: Armazem, chat: Chat): DepsDoCiclo => ({ armazem, chat, pausa: async () => undefined });
const CONSULTA = { etapa: 'Agendado', situacao_consulta: 'Confirmado', data_consulta: '2026-11-17', hora_consulta: '14:30' };
const VESPERA = new Date('2026-11-16T17:30:00Z'); // consulta de 17/11 14:30 Belém, 24 h antes

test('catálogo: a automação existe, tem seco e passa na verificação', () => {
  const a = automacaoPorId('chatwoot-regua');
  assert.ok(a);
  assert.equal(a!.temSeco, true);
  assert.equal(a!.quandoVazio, 'desligado');
  assert.equal(a!.risco, 'manda-mensagem');
  assert.deepEqual(verificarCatalogo(), []);
  assert.equal(CAIXAS_REGUA[2], 'doutor-hernia-parauapebas');
});

test('seco: deixa NOTA PRIVADA com o texto, registra, e no ciclo seguinte não repete', async () => {
  const { armazem, disparos } = armazemFalso();
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  // partida 10 min antes
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  assert.equal(mensagens.length, 0);
  const r = await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, VESPERA);
  assert.equal(r.disparos, 1);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, true);
  assert.ok(mensagens[0]!.texto.startsWith('🧪 [SECO] Régua «consulta-vespera» — enviaria agora:\n\nOlá, Maria. A sua consulta é amanhã.'));
  assert.equal(disparos.length, 1);
  assert.equal(disparos[0]!.modo, 'seco');
  const r2 = await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(r2.disparos, 0);
  assert.equal(mensagens.length, 1);
});

test('ligado: manda a mensagem PÚBLICA, com o texto puro', async () => {
  const { armazem, disparos } = armazemFalso();
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, false);
  assert.ok(mensagens[0]!.texto.startsWith('Olá, Maria. A sua consulta é amanhã.'));
  assert.ok(!mensagens[0]!.texto.includes('SECO'));
  assert.equal(disparos[0]!.modo, 'ligado');
});

// ── item 31: sem dobrar com o Kommo ──
const comKommo = (armazem: Armazem, chat: Chat, kommo: DepsDoCiclo['kommo']): DepsDoCiclo => ({ armazem, chat, pausa: async () => undefined, kommo });

test('finalDoTelefone: 8 últimos dígitos, com e sem 9 e +55', () => {
  assert.equal(finalDoTelefone('+5594999990000'), '99990000');
  assert.equal(finalDoTelefone('559499990000'), '99990000');
  assert.equal(finalDoTelefone('123'), null);
  assert.equal(finalDoTelefone(undefined), null);
});

test('ligado + cartão ATIVO no Kommo: não manda ao paciente, só nota privada, e não tenta de novo', async () => {
  const { armazem, disparos } = armazemFalso();
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const telefones: string[] = [];
  const kommo = async (t: string) => (telefones.push(t), { leadId: 777 });
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  const r = await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(r.disparos, 0);
  assert.equal(r.noKommo, 1);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, true);
  assert.ok(mensagens[0]!.texto.startsWith('🛑 Régua «consulta-vespera» — NÃO enviei'));
  assert.ok(mensagens[0]!.texto.includes('lead 777'));
  assert.deepEqual(telefones, ['+5594999990000']);
  assert.equal(disparos.length, 1);
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'ligado', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(mensagens.length, 1);
});

test('ligado + sem cartão ativo no Kommo: manda normal', async () => {
  const { armazem } = armazemFalso();
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const kommo = async () => null;
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, false);
});

test('ligado + Kommo fora do ar: NÃO manda, não registra (tenta no próximo ciclo)', async () => {
  const { armazem, disparos } = armazemFalso();
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const kommo = async (): Promise<{ leadId: number } | null> => {
    throw new Error('403');
  };
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(mensagens.length, 0);
  assert.equal(disparos.length, 0);
});

test('seco + cartão ativo no Kommo: a nota diz que NÃO enviaria', async () => {
  const { armazem } = armazemFalso();
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const kommo = async () => ({ leadId: 5 });
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(comKommo(armazem, chat, kommo), 2, 'x', 'seco', U, VESPERA);
  assert.equal(mensagens.length, 1);
  assert.ok(mensagens[0]!.texto.startsWith('🧪 [SECO] Régua «consulta-vespera» — NÃO enviaria: o paciente tem cartão ativo'));
});

test('seco que falha ao deixar a nota desfaz o registro e tenta no ciclo seguinte', async () => {
  const { armazem, disparos } = armazemFalso();
  let quebrar = true;
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: CONSULTA })], { falhaAoEscrever: () => (quebrar ? new Error('timeout') : null) });
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  const r = await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, VESPERA);
  assert.equal(r.falhas, 1);
  assert.equal(disparos.length, 0);
  quebrar = false;
  const r2 = await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(r2.disparos, 1);
  assert.equal(mensagens.length, 1);
});

test('ligado: recusa do Chatwoot (4xx) desfaz; erro sem resposta (pode ter ido) NÃO desfaz', async () => {
  for (const [erro, ficou] of [[Object.assign(new Error('422'), { status: 422 }), 0], [new Error('timeout'), 1]] as const) {
    const { armazem, disparos } = armazemFalso();
    const { chat } = chatFalso(() => [bruta(1, { attrs: CONSULTA })], { falhaAoEscrever: () => erro });
    await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
    await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'ligado', U, VESPERA);
    assert.equal(disparos.length, ficou);
  }
});

test('campo faltando: o seco deixa UMA nota dizendo o que falta; o ligado não manda nem registra', async () => {
  const semNome = { attrs: CONSULTA, nome: '+5594999990000' }; // contato sem nome: o texto pede o primeiro nome
  const antes = new Date(VESPERA.getTime() - 600_000);
  const seco = armazemFalso();
  const c1 = chatFalso(() => [bruta(1, semNome)]);
  await cicloDaCaixa(deps(seco.armazem, c1.chat), 2, 'x', 'seco', U, antes);
  await cicloDaCaixa(deps(seco.armazem, c1.chat), 2, 'x', 'seco', U, VESPERA);
  await cicloDaCaixa(deps(seco.armazem, c1.chat), 2, 'x', 'seco', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(c1.mensagens.length, 1);
  assert.equal(c1.mensagens[0]!.texto, '🧪 [SECO] Régua «consulta-vespera» — NÃO enviaria agora, falta: nome do contato.');
  assert.equal(seco.disparos[0]!.regra, 'consulta-vespera!falta');

  const lig = armazemFalso();
  const c2 = chatFalso(() => [bruta(1, semNome)]);
  await cicloDaCaixa(deps(lig.armazem, c2.chat), 2, 'x', 'ligado', U, antes);
  await cicloDaCaixa(deps(lig.armazem, c2.chat), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(c2.mensagens.length, 0);
  assert.equal(lig.disparos.length, 0);
});

test('1º ciclo: o estoque que já estava em Perdido não dispara regra de entrada, nem depois', async () => {
  const { armazem } = armazemFalso();
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: { etapa: 'Perdido' } })]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T12:00:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-18T12:00:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-20T12:00:00Z'));
  assert.equal(mensagens.length, 0);
});

test('entrou em Perdido DEPOIS da partida: a nota do 48h sai 48 h depois', async () => {
  const { armazem } = armazemFalso();
  let etapa = '';
  const { chat, mensagens } = chatFalso(() => [bruta(1, { attrs: etapa ? { etapa } : {} })]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T12:00:00Z'));
  etapa = 'Perdido';
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T12:10:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-18T12:00:00Z'));
  assert.equal(mensagens.length, 0);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-18T12:10:00Z'));
  assert.equal(mensagens.length, 1);
  assert.match(mensagens[0]!.texto, /«followup-48h»/);
});

test('duas cópias do servidor: o registro único segura a segunda', async () => {
  const { armazem } = armazemFalso();
  const a = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const b = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  await cicloDaCaixa(deps(armazem, a.chat), 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  // as duas leem o mesmo estado e disputam o registro
  const feitosVazios: Armazem = { ...armazem, feitos: async () => [] };
  await Promise.all([cicloDaCaixa(deps(feitosVazios, a.chat), 2, 'x', 'seco', U, VESPERA), cicloDaCaixa(deps(feitosVazios, b.chat), 2, 'x', 'seco', U, VESPERA)]);
  assert.equal(a.mensagens.length + b.mensagens.length, 1);
});

test('teto por ciclo: só MAX mensagens saem; o resto fica para o ciclo seguinte', async () => {
  const total = MAX_MENSAGENS_POR_CICLO + 5;
  const { armazem } = armazemFalso();
  const lista = Array.from({ length: total }, (_, i) => bruta(100 + i, { attrs: CONSULTA }));
  const { chat, mensagens } = chatFalso(() => lista);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, VESPERA);
  assert.equal(mensagens.length, MAX_MENSAGENS_POR_CICLO);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(mensagens.length, total);
});

test('listagem que falha: aborta sem tocar na memória', async () => {
  const { armazem, vistos } = armazemFalso();
  const { chat } = chatFalso(() => [], { falhaAoListar: true });
  await assert.rejects(() => cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z')), /fora do ar/);
  assert.equal(vistos.length, 0);
});

test('etiqueta respondeu-pelo-celular: põe com a lista completa, tira, e respeita o teto', async () => {
  const { armazem } = armazemFalso();
  const lista = [
    bruta(1, { labels: ['quente'], ultima: { tipo: 1, autor: 7 } }), // celular → põe
    bruta(2, { labels: ['respondeu-pelo-celular', 'quente'], ultima: { tipo: 1, autor: 2 } }), // outro agente → tira
    bruta(3, { labels: ['respondeu-pelo-celular'], ultima: { tipo: 0, autor: 9 } }), // paciente escreveu → fica
    bruta(4, { labels: ['respondeu-pelo-celular'], ultima: { tipo: 1, autor: 2, privada: true } }), // nota do seco → fica
  ];
  const { chat, etiquetas } = chatFalso(() => lista);
  const r = await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  assert.equal(r.etiquetas, 2);
  assert.deepEqual(etiquetas, [
    { id: 1, lista: ['quente', 'respondeu-pelo-celular'] },
    { id: 2, lista: ['quente'] },
  ]);

  const muitas = Array.from({ length: MAX_ETIQUETAS_POR_CICLO + 7 }, (_, i) => bruta(500 + i, { ultima: { tipo: 1, autor: 7 } }));
  const m = chatFalso(() => muitas);
  const r2 = await cicloDaCaixa(deps(armazemFalso().armazem, m.chat), 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  assert.equal(r2.etiquetas, MAX_ETIQUETAS_POR_CICLO);
});

test('grupo e o bot do Evolution ficam de fora', async () => {
  const { armazem, vistos } = armazemFalso();
  const grupo = { ...bruta(7, { attrs: CONSULTA }), meta: { sender: { name: 'Grupo', identifier: '1203@g.us' } } };
  const bot = { ...bruta(8, { attrs: CONSULTA }), meta: { sender: { name: 'Evolution', phone_number: '+123456' } } };
  const { chat, mensagens } = chatFalso(() => [grupo, bot]);
  const r = await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, VESPERA);
  assert.equal(r.conversas, 0);
  assert.equal(mensagens.length, 0);
  assert.deepEqual(vistos.map((v) => v.conversationId), [0]); // só a linha de partida
});

// ── regras internas (quente parado, sem resposta 24 h, pendência de «Fechou») ──────────────────────

const QUALIFICA = { etapa: 'Sofia qualifica', qualificacao: 'Quente' };
// última mensagem (nossa) em 2026-11-16 10:00 UTC; +24 h = 17/11 10:00 UTC (07:00 Belém, janela fechada) → 11:00 UTC abre
const DEPOIS_DE_24H = new Date('2026-11-17T11:30:00Z');

test('interna em seco: só nota «faria agora», nenhuma ação', async () => {
  const { armazem } = armazemFalso();
  const { chat, mensagens, etiquetas, atributos, prioridades } = chatFalso(() => [bruta(5, { attrs: { etapa: 'Sofia qualifica' }, ultima: { tipo: 1, autor: 2 } })]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, new Date('2026-11-16T10:30:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, DEPOIS_DE_24H);
  const nota = mensagens.find((m) => m.texto.includes('sem-resposta-24h'));
  assert.ok(nota, 'deixou a nota do seco');
  assert.equal(nota!.privada, true);
  assert.ok(nota!.texto.startsWith('🧪 [SECO] Régua «sem-resposta-24h» — faria agora:'));
  assert.equal(etiquetas.length, 0);
  assert.equal(atributos.length, 0);
  assert.equal(prioridades.length, 0);
});

test('interna ligada: nota PRIVADA (nunca ao paciente) + etiqueta, motivo e etapa Perdido mantendo os outros atributos', async () => {
  const { armazem } = armazemFalso();
  const { chat, mensagens, etiquetas, atributos } = chatFalso(() => [
    bruta(6, { attrs: { etapa: 'Esperando humano', qualificacao: 'Morno', unidade: 'x' }, labels: ['morno'], ultima: { tipo: 1, autor: 2 } }),
  ]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'ligado', U, new Date('2026-11-16T10:30:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'ligado', U, DEPOIS_DE_24H);
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, true);
  assert.ok(mensagens[0]!.texto.startsWith('🤖 Régua «sem-resposta-24h»:'));
  assert.deepEqual(etiquetas.at(-1)!.lista, ['morno', 'sem-resposta']);
  assert.deepEqual(atributos[0]!.attrs, { etapa: 'Perdido', qualificacao: 'Morno', unidade: 'x', motivo_nao_agendamento: 'Não interagiu' });
});

test('interna: quente parado 3 h ligado sobe a prioridade para urgente', async () => {
  const { armazem } = armazemFalso();
  const { chat, prioridades, mensagens } = chatFalso(() => [bruta(7, { attrs: QUALIFICA, ultima: { tipo: 0, autor: 99 } })]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'ligado', U, new Date('2026-11-16T10:30:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'ligado', U, new Date('2026-11-16T13:10:00Z'));
  assert.deepEqual(prioridades, [{ id: 7, p: 'urgent' }]);
  assert.ok(mensagens[0]!.texto.includes('Lead QUENTE parado há 3 h'));
});

test('interna: quente parado vai para a GERENTE da caixa e avisa no WhatsApp dela (quando configurado)', async () => {
  const { armazem } = armazemFalso();
  const { chat, atribuicoes } = chatFalso(() => [bruta(7, { attrs: QUALIFICA, ultima: { tipo: 0, autor: 99 } })]);
  const avisos: Array<{ texto: string; chave: string }> = [];
  const d: DepsDoCiclo = { ...deps(armazem, chat), avisarGerente: async (texto, chave) => avisos.push({ texto, chave }) };
  await cicloDaCaixa(d, 2, 'doutor-hernia-parauapebas', 'ligado', U, new Date('2026-11-16T10:30:00Z'));
  await cicloDaCaixa(d, 2, 'doutor-hernia-parauapebas', 'ligado', U, new Date('2026-11-16T13:10:00Z'));
  assert.deepEqual(atribuicoes, [{ id: 7, agente: 4 }]);
  assert.equal(avisos.length, 1);
  assert.ok(avisos[0]!.texto.startsWith('🔥 Lead QUENTE parado há 3 h (Doutor Hérnia Parauapebas): Maria da Silva.'));
  assert.equal(avisos[0]!.chave, 'quente-7');
});

test('numeroDaGerente: lê o par slug=número da env; número inválido ou slug ausente = null', () => {
  const env = 'doutor-hernia-parauapebas=5594999990000, outra=abc';
  assert.equal(numeroDaGerente('doutor-hernia-parauapebas', env), '5594999990000');
  assert.equal(numeroDaGerente('outra', env), null);
  assert.equal(numeroDaGerente('x', env), null);
  assert.equal(numeroDaGerente('x', undefined), null);
});

test('interna: última mensagem é NOTA → busca a última pública (a nota do seco não zera o tempo de parado)', async () => {
  const { armazem } = armazemFalso();
  const publica: MensagemResumo = { saida: true, privada: false, autorId: 2, autorTipo: 'user', criadaEm: new Date('2026-11-16T10:00:00Z') };
  const { chat, buscasDaUltima, mensagens } = chatFalso(() => [bruta(8, { attrs: { etapa: 'Sofia qualifica' }, ultima: { tipo: 1, autor: 2, privada: true } })], { ultimaPublica: publica });
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, new Date('2026-11-16T10:30:00Z'));
  await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, DEPOIS_DE_24H);
  assert.ok(buscasDaUltima.includes(8));
  assert.ok(mensagens.some((m) => m.texto.includes('sem-resposta-24h')));
});
