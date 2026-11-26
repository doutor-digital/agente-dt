/**
 * O ciclo da régua do Chatwoot com portas falsas (sem banco, sem rede): seco só deixa nota privada, ligado manda de verdade,
 * nunca repete, desfaz o registro quando a nota/mensagem falha, respeita os tetos e não toca em nada se a listagem falhar.
 * Datas: 2026-11-16 é segunda; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automacaoPorId, verificarCatalogo } from './automacoes.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { chaveDoTelefone, mesmoTelefone } from './chatwoot-lida.js';
import { cicloDaCaixa, finalDoTelefone, paramsDoTemplate, SUFIXO_SEM_TEMPLATE, type EnvioTemplate, numeroDaGerente, avisoDaGerenteDoBanco, MAX_ETIQUETAS_POR_CICLO, MAX_MENSAGENS_POR_CICLO, quemFalaPorTelefone, type Armazem, type Chat, type DepsDoCiclo, type LinhaVista } from './chatwoot-regua-worker.js';
import type { DadosDaUnidade, MensagemResumo, Mudanca } from './chatwoot-regua.js';

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const unix = (s: string) => Math.floor(new Date(s).getTime() / 1000);

function bruta(id: number, o: { attrs?: Record<string, unknown>; labels?: string[]; ultima?: { tipo: number; autor: number; privada?: boolean; quando?: string }; nome?: string; telefone?: string } = {}) {
  return {
    id,
    created_at: unix('2026-10-01T12:00:00Z'),
    labels: o.labels ?? [],
    custom_attributes: o.attrs ?? {},
    meta: { sender: { name: o.nome ?? 'Maria da Silva', phone_number: o.telefone ?? (id <= 1 ? '+5594999990000' : `+55949${String(90000000 + id).slice(-8)}`) }, assignee: { name: 'Ana' } },
    last_non_activity_message: o.ultima ? { message_type: o.ultima.tipo, private: o.ultima.privada ?? false, created_at: unix(o.ultima.quando ?? '2026-11-16T10:00:00Z'), sender: { id: o.ultima.autor, type: 'user' } } : null,
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
  o: {
    falhaAoEscrever?: () => unknown;
    falhaAoListar?: boolean;
    ultimaPublica?: MensagemResumo | null;
    /** quando o paciente escreveu por último, segundo o histórico (usado quando a listagem não traz mensagem dele) */
    ultimaDoPaciente?: Date | null;
    /** templates aprovados na caixa (lista de nomes, ou nome → quantos {{n}} o corpo tem na Meta); um Error = não deu para ler */
    aprovados?: string[] | Record<string, number | null> | Error;
  } = {},
) {
  const mensagens: Array<{ id: number; texto: string; privada: boolean; template?: EnvioTemplate }> = [];
  const buscasDoPaciente: number[] = [];
  let leiturasDeTemplates = 0;
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
    async mensagem(id, texto, privada, template) {
      const f = o.falhaAoEscrever?.();
      if (f) throw f;
      mensagens.push({ id, texto, privada, template });
    },
    async ultimaDoPaciente(id) {
      buscasDoPaciente.push(id);
      return o.ultimaDoPaciente ?? null;
    },
    async templatesAprovados() {
      leiturasDeTemplates++;
      if (o.aprovados instanceof Error) throw o.aprovados;
      const a = o.aprovados ?? [];
      return new Map<string, number | null>(Array.isArray(a) ? a.map((n) => [n, null] as const) : Object.entries(a));
    },
    async etiquetas(id, lista) {
      etiquetas.push({ id, lista });
    },
  };
  return { chat, mensagens, etiquetas, atributos, prioridades, atribuicoes, buscasDaUltima, buscasDoPaciente, leituras: () => leiturasDeTemplates };
}

const deps = (armazem: Armazem, chat: Chat): DepsDoCiclo => ({ armazem, chat, pausa: async () => undefined });
const CONSULTA = { etapa: 'Agendado', situacao_consulta: 'Agendado', data_consulta: '2026-11-17', hora_consulta: '14:30' };
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
  const r = await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, new Date('2026-11-16T17:20:00Z')); // o usuário «celular» é DA UNIDADE: o slug é o dela
  assert.equal(r.etiquetas, 2);
  assert.deepEqual(etiquetas, [
    { id: 1, lista: ['quente', 'respondeu-pelo-celular'] },
    { id: 2, lista: ['quente'] },
  ]);

  const muitas = Array.from({ length: MAX_ETIQUETAS_POR_CICLO + 7 }, (_, i) => bruta(500 + i, { ultima: { tipo: 1, autor: 7 } }));
  const m = chatFalso(() => muitas);
  const r2 = await cicloDaCaixa(deps(armazemFalso().armazem, m.chat), 2, 'doutor-hernia-parauapebas', 'seco', U, new Date('2026-11-16T17:20:00Z'));
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

// ── caixa 3 (WhatsApp Cloud): texto com a janela de 24 h aberta, template com ela fechada ──────────────
// Véspera da consulta de 17/11 14:30 (Belém): o ciclo roda 16/11 17:30Z. O modelo é parau_consulta_lembrete_vespera: {{1}} nome, {{2}} data e hora.
const VESP = 'parau_consulta_lembrete_vespera';
const ANTES_DA_VESPERA = new Date('2026-11-16T17:20:00Z');
const MARIA = { nome: 'Maria', quando: '17/11 às 14:30' };
const SLUG = 'doutor-hernia-parauapebas';
/** a última mensagem da listagem é do paciente, de 16/11 10:00Z (7 h 30 antes do ciclo): janela aberta */
const PACIENTE_HOJE = { tipo: 0, autor: 55 };
/** a última mensagem da listagem é da clínica: a janela depende do histórico (`ultimaDoPaciente`) */
const CLINICA = { tipo: 1, autor: 2 };

async function doisCiclos(modo: 'seco' | 'ligado', caixa: number, chatO: Parameters<typeof chatFalso>[1], conversa: Parameters<typeof bruta>[1] = { attrs: CONSULTA, ultima: CLINICA }) {
  const arm = armazemFalso();
  const c = chatFalso(() => [bruta(1, conversa)], chatO);
  await cicloDaCaixa(deps(arm.armazem, c.chat), caixa, SLUG, modo, U, ANTES_DA_VESPERA);
  const resumo = await cicloDaCaixa(deps(arm.armazem, c.chat), caixa, SLUG, modo, U, VESPERA);
  return { ...arm, ...c, resumo };
}

test('cloud, janela ABERTA (o paciente escreveu há 7 h): vai o TEXTO, sem olhar template nenhum', async () => {
  const { mensagens, leituras, buscasDoPaciente, resumo, disparos } = await doisCiclos('ligado', 3, { aprovados: [VESP] }, { attrs: CONSULTA, ultima: PACIENTE_HOJE });
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, false);
  assert.equal(mensagens[0]!.template, undefined);
  assert.ok(mensagens[0]!.texto.startsWith('Olá, Maria. A sua consulta é amanhã.'));
  assert.equal(leituras(), 0);
  assert.deepEqual(buscasDoPaciente, []); // a própria listagem já dizia quando o paciente escreveu
  assert.equal(resumo.disparos, 1);
  assert.equal(resumo.comTemplate, 0);
  assert.equal(disparos[0]!.regra, 'consulta-vespera');
});

test('cloud, janela FECHADA (último recado do paciente há 2 dias): vai o TEMPLATE com {{1}}=nome e {{2}}=data e hora', async () => {
  const { mensagens, resumo, disparos, buscasDoPaciente, leituras } = await doisCiclos('ligado', 3, { aprovados: [VESP, 'outro'], ultimaDoPaciente: new Date('2026-11-14T10:00:00Z') });
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, false);
  assert.deepEqual(mensagens[0]!.template, { nome: VESP, idioma: 'pt_BR', variaveis: [MARIA.nome, MARIA.quando] });
  assert.ok(mensagens[0]!.texto.startsWith('Olá, Maria. A sua consulta é amanhã.')); // o que aparece na conversa
  assert.deepEqual(buscasDoPaciente, [1]);
  assert.equal(leituras(), 1);
  assert.equal(resumo.disparos, 1);
  assert.equal(resumo.comTemplate, 1);
  assert.equal(disparos[0]!.regra, 'consulta-vespera');
  assert.ok(disparos[0]!.texto.startsWith(`[template ${VESP}] Olá, Maria.`));
  // o que o Chatwoot 4.19.1 recebe
  assert.deepEqual(paramsDoTemplate(mensagens[0]!.template!), {
    name: VESP,
    language: 'pt_BR',
    content_mode: 'rendered',
    processed_params: { body: { '1': 'Maria', '2': '17/11 às 14:30' } },
  });
});

test('cloud: paciente que NUNCA escreveu, ou escreveu há mais de 24 h na própria listagem, também recebe o template', async () => {
  const nunca = await doisCiclos('ligado', 3, { aprovados: [VESP], ultimaDoPaciente: null });
  assert.equal(nunca.mensagens[0]!.template?.nome, VESP);
  const velha = await doisCiclos('ligado', 3, { aprovados: [VESP] }, { attrs: CONSULTA, ultima: { tipo: 0, autor: 55, quando: '2026-11-14T10:00:00Z' } });
  assert.equal(velha.mensagens[0]!.template?.nome, VESP);
  assert.deepEqual(velha.buscasDoPaciente, []);
});

test('cloud, janela fechada e template NÃO aprovado: não manda, deixa UMA nota por chave e, aprovado, manda no ciclo seguinte', async () => {
  const opcoes = { aprovados: ['outro'] as string[], ultimaDoPaciente: new Date('2026-11-14T10:00:00Z') };
  const arm = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA, ultima: CLINICA })], opcoes);
  await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, ANTES_DA_VESPERA);
  const r1 = await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, VESPERA);
  assert.equal(c.mensagens.length, 1);
  assert.equal(c.mensagens[0]!.privada, true);
  assert.equal(c.mensagens[0]!.template, undefined);
  assert.equal(c.mensagens[0]!.texto, `🤖 Régua «consulta-vespera»: template ${VESP} ainda não aprovado na Meta — não enviei`);
  assert.equal(arm.disparos[0]!.regra, `consulta-vespera${SUFIXO_SEM_TEMPLATE}`);
  assert.equal(r1.semTemplate, 1);
  assert.equal(r1.disparos, 0);
  // não repete a nota
  const r2 = await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(c.mensagens.length, 1);
  assert.equal(r2.semTemplate, 0);
  // aprovou na Meta (e o Chatwoot sincronizou): vai o template, dentro do atraso máximo da regra
  opcoes.aprovados = [VESP];
  const r3 = await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, new Date(VESPERA.getTime() + 1_200_000));
  assert.equal(r3.comTemplate, 1);
  assert.equal(c.mensagens.length, 2);
  assert.equal(c.mensagens[1]!.template?.nome, VESP);
  assert.equal(c.mensagens[1]!.privada, false);
  assert.deepEqual(arm.disparos.map((d) => d.regra), [`consulta-vespera${SUFIXO_SEM_TEMPLATE}`, 'consulta-vespera']);
});

test('cloud: template aprovado na Meta com outro número de variáveis que o da régua NÃO sai (uma nota, sem mandar valor trocado)', async () => {
  const errado = await doisCiclos('ligado', 3, { aprovados: { [VESP]: 3 }, ultimaDoPaciente: null });
  assert.equal(errado.mensagens.length, 1);
  assert.equal(errado.mensagens[0]!.privada, true);
  assert.equal(errado.mensagens[0]!.template, undefined);
  assert.equal(errado.mensagens[0]!.texto, `🤖 Régua «consulta-vespera»: template ${VESP} na Meta pede 3 variável(is) e a régua tem 2 — não enviei`);
  const certo = await doisCiclos('ligado', 3, { aprovados: { [VESP]: 2 }, ultimaDoPaciente: null });
  assert.equal(certo.mensagens[0]!.template?.nome, VESP);
});

test('cloud, janela fechada: nota que falha desfaz o registro (a nota sai no ciclo seguinte)', async () => {
  let quebrar = true;
  const arm = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA, ultima: CLINICA })], { aprovados: [], ultimaDoPaciente: null, falhaAoEscrever: () => (quebrar ? new Error('timeout') : null) });
  await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, ANTES_DA_VESPERA);
  const r1 = await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, VESPERA);
  assert.equal(r1.falhas, 1);
  assert.equal(arm.disparos.length, 0);
  quebrar = false;
  await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(c.mensagens.length, 1);
});

test('cloud, campo faltando: ligado não manda nada (nem texto nem template) e nem consulta janela ou template', async () => {
  const semNome = { attrs: CONSULTA, nome: '+5594999990000', ultima: CLINICA };
  const { mensagens, disparos, leituras, buscasDoPaciente } = await doisCiclos('ligado', 3, { aprovados: [VESP], ultimaDoPaciente: null }, semNome);
  assert.equal(mensagens.length, 0);
  assert.equal(disparos.length, 0);
  assert.equal(leituras(), 0);
  assert.deepEqual(buscasDoPaciente, []);
  // seco: a nota de sempre dizendo o que falta
  const seco = await doisCiclos('seco', 3, { aprovados: [VESP], ultimaDoPaciente: null }, semNome);
  assert.equal(seco.mensagens[0]!.texto, '🧪 [SECO] Régua «consulta-vespera» — NÃO enviaria agora, falta: nome do contato.');
});

test('cloud, SECO: a nota diz se iria como TEXTO ou como TEMPLATE (com {{1}}=…), e avisa se o template não está aprovado', async () => {
  const aberta = await doisCiclos('seco', 3, { aprovados: [], ultimaDoPaciente: null }, { attrs: CONSULTA, ultima: PACIENTE_HOJE });
  assert.equal(aberta.mensagens[0]!.privada, true);
  assert.ok(aberta.mensagens[0]!.texto.startsWith('🧪 [SECO] Régua «consulta-vespera» — enviaria agora, como TEXTO (janela de 24 h aberta):\n\nOlá, Maria.'));

  const fechada = await doisCiclos('seco', 3, { aprovados: [VESP], ultimaDoPaciente: new Date('2026-11-14T10:00:00Z') });
  assert.equal(fechada.mensagens.length, 1);
  assert.equal(fechada.mensagens[0]!.privada, true);
  assert.equal(fechada.mensagens[0]!.template, undefined); // seco nunca manda template
  assert.ok(
    fechada.mensagens[0]!.texto.startsWith(`🧪 [SECO] Régua «consulta-vespera» — enviaria agora pelo template ${VESP} com {{1}}=Maria, {{2}}=17/11 às 14:30 (janela de 24 h fechada):\n\nOlá, Maria.`),
  );
  assert.ok(!fechada.mensagens[0]!.texto.includes('não está aprovado'));
  assert.equal(fechada.disparos[0]!.regra, 'consulta-vespera'); // registra a regra normal: o seco não repete

  const semAprovar = await doisCiclos('seco', 3, { aprovados: [], ultimaDoPaciente: null });
  assert.ok(semAprovar.mensagens[0]!.texto.includes(`pelo template ${VESP}`));
  assert.ok(semAprovar.mensagens[0]!.texto.includes(`⚠️ O template ${VESP} ainda não está aprovado na Meta`));
});

test('caixa que NÃO é WhatsApp Cloud (2, Evolution): sempre texto, mesmo com o paciente sem escrever há dias; não olha janela nem template', async () => {
  const { mensagens, leituras, buscasDoPaciente, resumo } = await doisCiclos('ligado', 2, { aprovados: [], ultimaDoPaciente: null });
  assert.equal(mensagens.length, 1);
  assert.equal(mensagens[0]!.privada, false);
  assert.equal(mensagens[0]!.template, undefined);
  assert.ok(mensagens[0]!.texto.startsWith('Olá, Maria. A sua consulta é amanhã.'));
  assert.equal(leituras(), 0);
  assert.deepEqual(buscasDoPaciente, []);
  assert.equal(resumo.comTemplate, 0);
  // e o seco da caixa 2 segue com a nota de sempre
  const seco = await doisCiclos('seco', 2, { aprovados: [], ultimaDoPaciente: null });
  assert.ok(seco.mensagens[0]!.texto.startsWith('🧪 [SECO] Régua «consulta-vespera» — enviaria agora:\n\nOlá, Maria.'));
});

test('cloud: não deu para ler a janela ou a lista de templates → ligado não manda e não registra; tenta no ciclo seguinte', async () => {
  const opcoes: Parameters<typeof chatFalso>[1] = { aprovados: new Error('Kapso 502'), ultimaDoPaciente: null };
  const arm = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA, ultima: CLINICA })], opcoes);
  await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, ANTES_DA_VESPERA);
  await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, VESPERA);
  assert.equal(c.mensagens.length, 0);
  assert.equal(arm.disparos.length, 0);
  opcoes.aprovados = [VESP];
  const r = await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(r.comTemplate, 1);
  assert.equal(c.mensagens.length, 1);
});

test('cloud: cartão ativo no Kommo continua mandando na frente (só nota) e nem chega a olhar template', async () => {
  const arm = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA, ultima: CLINICA })], { aprovados: [VESP], ultimaDoPaciente: null });
  const kommo = async () => ({ leadId: 9 });
  await cicloDaCaixa(comKommo(arm.armazem, c.chat, kommo), 3, SLUG, 'ligado', U, ANTES_DA_VESPERA);
  const r = await cicloDaCaixa(comKommo(arm.armazem, c.chat, kommo), 3, SLUG, 'ligado', U, VESPERA);
  assert.equal(r.noKommo, 1);
  assert.equal(c.mensagens[0]!.privada, true);
  assert.equal(c.mensagens[0]!.template, undefined);
  assert.equal(c.leituras(), 0);
});

test('cloud: o Chatwoot recusar o template (4xx) desfaz o registro; erro sem resposta (pode ter ido) NÃO desfaz', async () => {
  for (const [erro, ficou] of [[Object.assign(new Error('422'), { status: 422 }), 0], [new Error('timeout'), 1]] as const) {
    const arm = armazemFalso();
    const c = chatFalso(() => [bruta(1, { attrs: CONSULTA, ultima: CLINICA })], { aprovados: [VESP], ultimaDoPaciente: null, falhaAoEscrever: () => erro });
    await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, ANTES_DA_VESPERA);
    await cicloDaCaixa(deps(arm.armazem, c.chat), 3, SLUG, 'ligado', U, VESPERA);
    assert.equal(arm.disparos.length, ficou);
  }
});

test('paramsDoTemplate: sem variáveis não manda processed_params; as chaves são "1", "2"… como texto', () => {
  assert.deepEqual(paramsDoTemplate({ nome: 'parau_x', idioma: 'pt_BR', variaveis: [] }), { name: 'parau_x', language: 'pt_BR', content_mode: 'rendered' });
  assert.deepEqual(paramsDoTemplate({ nome: 'parau_x', idioma: 'pt_BR', variaveis: ['a', 'b', 'c'] }).processed_params, { body: { '1': 'a', '2': 'b', '3': 'c' } });
});

test('UNIFICAÇÃO: conversa de arquivo (etiqueta historico, parada antes do corte) a régua não toca; mexeu depois do corte, volta a valer', async () => {
  const { armazem } = armazemFalso();
  const arquivo = { ...bruta(1, { attrs: { ...CONSULTA, data_consulta: '2026-09-21' }, labels: ['historico'] }), last_activity_at: unix('2026-10-20T12:00:00Z') };
  const voltou = { ...bruta(2, { attrs: CONSULTA, labels: ['historico'] }), last_activity_at: unix('2026-11-16T10:00:00Z') };
  const { chat, mensagens } = chatFalso(() => [arquivo, voltou]);
  const r = await cicloDaCaixa(deps(armazem, chat), 2, 'doutor-hernia-parauapebas', 'seco', U, VESPERA);
  assert.equal(r.conversas, 1, 'só a que voltou a ter atividade entra no ciclo');
  assert.ok(mensagens.every((m) => m.id !== 1), 'nada sai para a conversa de arquivo');
});

test('UNIFICAÇÃO: conversa do histórico que ACORDA com etapa antiga (Perdido) não dispara nada — o estado antigo é ponto de partida', async () => {
  const { armazem, disparos } = armazemFalso();
  // a régua já tinha partida antes (não é a 1ª vez da caixa)
  const viva = bruta(9, { attrs: CONSULTA });
  const { chat, mensagens } = chatFalso(() => [viva]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T13:00:00Z'));
  const antes = mensagens.length;
  const acordou = { ...bruta(10, { attrs: { etapa: 'Perdido', motivo_perda: 'Sem retorno' }, labels: ['historico'] }), created_at: unix('2026-11-20T12:00:00Z'), last_activity_at: unix('2026-11-20T12:00:00Z') };
  const { chat: chat2, mensagens: m2 } = chatFalso(() => [viva, acordou]);
  for (const quando of ['2026-11-20T13:00:00Z', '2026-11-22T13:00:00Z', '2026-11-25T13:00:00Z']) {
    await cicloDaCaixa(deps(armazem, chat2), 2, 'x', 'seco', U, new Date(quando));
  }
  assert.ok(m2.every((m) => m.id !== 10), 'nada (nem nota de seco) para a conversa do histórico que acordou');
  assert.ok(disparos.every((d) => d.conversationId !== 10));
  assert.ok(antes >= 0);
});

test('UNIFICAÇÃO (controle): a MESMA conversa sem a etiqueta historico, nascida depois da partida, dispara a sequência de Perdido', async () => {
  const { armazem } = armazemFalso();
  const viva = bruta(9, { attrs: CONSULTA });
  const { chat } = chatFalso(() => [viva]);
  await cicloDaCaixa(deps(armazem, chat), 2, 'x', 'seco', U, new Date('2026-11-16T13:00:00Z'));
  const nova = { ...bruta(11, { attrs: { etapa: 'Perdido', motivo_perda: 'Sem retorno' } }), created_at: unix('2026-11-20T12:00:00Z'), last_activity_at: unix('2026-11-20T12:00:00Z') };
  const { chat: chat2, mensagens: m2 } = chatFalso(() => [viva, nova]);
  for (const quando of ['2026-11-20T13:00:00Z', '2026-11-22T13:00:00Z', '2026-11-25T13:00:00Z']) {
    await cicloDaCaixa(deps(armazem, chat2), 2, 'x', 'seco', U, new Date(quando));
  }
  assert.ok(m2.some((m) => m.id === 11), 'sem a etiqueta, a régua age (prova que o teste de cima não passa à toa)');
});

// ── histórico com consulta de pé: o worker passa a enxergar, e não dobra com o Kommo ──

const HIST_CONSULTA = { etapa: 'Agendado', situacao_consulta: 'Agendado', data_consulta: '2026-11-17', hora_consulta: '14:30' };

test('conversa do histórico parada, mas com consulta de pé: lembrete sai (ligado); com consulta velha (mais de 35 dias) segue fora', async () => {
  const f = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: HIST_CONSULTA, labels: ['historico'] }), bruta(2, { attrs: { ...HIST_CONSULTA, data_consulta: '2026-10-10' }, labels: ['historico'] })]);
  await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  const r = await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(r.conversas, 1);
  assert.equal(c.mensagens.length, 1);
  assert.equal(c.mensagens[0]!.id, 1);
  assert.equal(c.mensagens[0]!.privada, false);
  assert.match(c.mensagens[0]!.texto, /A sua consulta é amanhã/);
});

test('conversa do histórico com consulta de pé + cartão ativo no Kommo: NÃO manda ao paciente, só a nota (não dobra com os robôs de lá)', async () => {
  const f = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: HIST_CONSULTA, labels: ['historico'] })]);
  const kommo = async () => ({ leadId: 321 });
  await cicloDaCaixa(comKommo(f.armazem, c.chat, kommo), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  const r = await cicloDaCaixa(comKommo(f.armazem, c.chat, kommo), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(r.noKommo, 1);
  assert.equal(r.disparos, 0);
  assert.equal(c.mensagens.length, 1);
  assert.equal(c.mensagens[0]!.privada, true);
  assert.match(c.mensagens[0]!.texto, /cartão ativo no Kommo da unidade \(lead 321\)/);
});

// ── mesmo telefone: só a conversa de atividade mais recente fala com o paciente ──

test('mesmo telefone: histórico (data velha) + viva (data nova) → só a viva manda; se o histórico for o mais recente, é ele', async () => {
  const tel = '+5594999990000';
  const hist = (atv: string) => ({ ...bruta(1, { attrs: { ...HIST_CONSULTA, data_consulta: '2026-11-17', hora_consulta: '14:30' }, labels: ['historico'], telefone: tel }), last_activity_at: unix(atv) });
  const viva = (atv: string) => ({ ...bruta(2, { attrs: CONSULTA, telefone: tel }), last_activity_at: unix(atv) });
  for (const [quem, atvHist, atvViva] of [[2, '2026-10-20T12:00:00Z', '2026-11-16T10:00:00Z'], [1, '2026-11-16T11:00:00Z', '2026-11-16T10:00:00Z']] as const) {
    const f = armazemFalso();
    const c = chatFalso(() => [hist(atvHist), viva(atvViva)]);
    await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
    const r = await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, VESPERA);
    assert.equal(r.conversas, 2, 'as duas seguem no ciclo (memória em dia)');
    assert.deepEqual(c.mensagens.map((m) => m.id), [quem], 'mas só a mais recente fala');
  }
});

test('quemFalaPorTelefone: com e sem o 9 é a mesma pessoa; empate fica com o id maior; sem telefone fala; telefones diferentes falam; irmãs listadas', () => {
  const x = (id: number, telefone: string, atividade: number) => ({ c: { id, telefone } as any, atividade });
  const r = quemFalaPorTelefone([x(1, '+5594999745062', 5), x(2, '+559499745062', 9), x(3, '+5594988887777', 1), x(4, '', 1), x(5, '', 1), x(6, '+5594999745062', 9)]);
  assert.deepEqual([...r.entries()].filter(([, v]) => v.fala).map(([id]) => id).sort(), [3, 4, 5, 6]);
  assert.deepEqual(r.get(6)!.irmas.sort(), [1, 2]);
  assert.deepEqual(r.get(3)!.irmas, []);
});

test('chaveDoTelefone agrupa exatamente como mesmoTelefone da agenda (DDI+DDD e 8 últimos dígitos)', () => {
  const t = ['+5594999745062', '+559499745062', '559499745062', '+5594988887777', '+5511999745062', '123', '', '+55949997450'];
  for (const a of t) for (const b of t) {
    const k = chaveDoTelefone(a);
    const l = chaveDoTelefone(b);
    assert.equal(mesmoTelefone(a, b), k !== null && l !== null && k === l, `${a} x ${b}`);
  }
});

test('troca de A para B (mesmo telefone, mesma consulta): A mandou a véspera; B vira a mais recente e NÃO manda de novo', async () => {
  const tel = '+5594999990000';
  const f = armazemFalso();
  let comB = false;
  const A = () => ({ ...bruta(1, { attrs: CONSULTA, telefone: tel }), last_activity_at: unix('2026-11-16T10:00:00Z') });
  const B = () => ({ ...bruta(2, { attrs: CONSULTA, telefone: tel }), last_activity_at: unix('2026-11-16T17:31:00Z') });
  const c = chatFalso(() => (comB ? [A(), B()] : [A()]));
  await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, VESPERA);
  assert.deepEqual(c.mensagens.map((m) => m.id), [1]);
  comB = true;
  for (const min of [10, 20, 30]) await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date(VESPERA.getTime() + min * 60_000));
  assert.deepEqual(c.mensagens.map((m) => m.id), [1], 'B não repete o que A já mandou');
  assert.ok(f.vistos.some((v) => v.conversationId === 2), 'B tem memória própria desde o 1º ciclo em que apareceu');
});

test('conversa fora da fala continua com a memória em dia: Perdido que ela ganhou semanas atrás NÃO vira «novo» quando ela volta a ser a mais recente', async () => {
  const tel = '+5594999990000';
  const f = armazemFalso();
  let fase = 1;
  const A = () => ({
    ...bruta(1, { attrs: fase === 1 ? { etapa: 'Agendado' } : { etapa: 'Perdido', motivo_nao_agendamento: 'Sem interesse' }, telefone: tel }),
    last_activity_at: unix(fase === 3 ? '2026-12-10T11:00:00Z' : '2026-11-10T10:00:00Z'),
  });
  const B = () => ({ ...bruta(2, { attrs: {}, telefone: tel }), last_activity_at: unix(fase === 3 ? '2026-11-20T10:00:00Z' : '2026-11-15T10:00:00Z') });
  const c = chatFalso(() => [A(), B()]);
  const ciclo = (q: string) => cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date(q));
  await ciclo('2026-11-16T12:00:00Z'); // partida
  fase = 2;
  await ciclo('2026-11-17T12:00:00Z'); // A ganha Perdido, mas B é quem fala
  const etapaA = f.vistos.find((v) => v.conversationId === 1 && v.campo === 'etapa')!;
  assert.equal(etapaA.valor, 'Perdido');
  assert.equal(etapaA.desde.toISOString(), '2026-11-17T12:00:00.000Z', 'a memória registrou QUANDO ela virou Perdido, mesmo sem falar');
  assert.equal(c.mensagens.length, 0);
  fase = 3; // semanas depois A volta a ser a mais recente
  await ciclo('2026-12-10T12:00:00Z');
  await ciclo('2026-12-12T13:00:00Z'); // 48 h depois da volta
  assert.equal(c.mensagens.length, 0, 'não dispara o reengajamento de 48 h por um estado de semanas atrás');
});

test('conversa que NÃO fala (mesmo telefone) não escreve nada — nem regra interna vencida, nem etiqueta do celular; a viva continua falando', async () => {
  const tel = '+5594999990000';
  const f = armazemFalso();
  const quente = { etapa: 'Sofia qualifica', qualificacao: 'Quente' };
  // A (velha) tem quente-parado vencido, sem-resposta de 24 h e uma saída do celular (etiqueta); B (viva) é a que fala e tem o mesmo quente-parado
  const A = () => ({ ...bruta(1, { attrs: quente, telefone: tel, ultima: { tipo: 1, autor: 7, quando: '2026-11-15T09:00:00Z' } }), last_activity_at: unix('2026-11-10T10:00:00Z') });
  const B = () => ({ ...bruta(2, { attrs: quente, telefone: tel, ultima: { tipo: 0, autor: 9, quando: '2026-11-16T10:00:00Z' } }), last_activity_at: unix('2026-11-16T10:00:00Z') });
  const c = chatFalso(() => [A(), B()]);
  await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T11:00:00Z'));
  const r1 = await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T13:10:00Z'));
  const r2 = await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T13:20:00Z'));
  assert.equal(r1.conversas, 2, 'as duas seguem no ciclo (memória)');
  assert.ok(c.mensagens.every((m) => m.id === 2), 'A não escreve nenhuma mensagem/nota');
  assert.ok(c.mensagens.some((m) => m.id === 2 && /lead-quente-parado/.test(m.texto)), 'B, que fala, roda a interna');
  assert.ok(c.etiquetas.every((e) => e.id !== 1), 'nenhuma etiqueta em A');
  assert.ok(c.atributos.every((a) => a.id !== 1) && c.prioridades.every((p) => p.id !== 1) && c.atribuicoes.every((a) => a.id !== 1), 'nem atributos, prioridade ou atribuição em A');
  assert.equal(c.buscasDaUltima.includes(1), false, 'nem leituras extras de A');
  assert.ok(f.disparos.every((d) => d.conversationId === 2));
  assert.ok(f.vistos.some((v) => v.conversationId === 1), 'a memória de A segue atualizada');
  assert.equal(r2.disparos, 0, 'B não repete');
});

// ── sessão da agenda no worker: Kommo e um telefone, uma conversa ──

const SESSAO_AMANHA = { categoria_consulta: 'Sessão', data_consulta: '2026-11-17', hora_consulta: '14:30', situacao_consulta: 'Agendado' };

test('sessão da agenda (ligado): manda o texto de sessão, uma vez; com cartão ativo no Kommo só deixa a nota', async () => {
  const f1 = armazemFalso();
  const c1 = chatFalso(() => [bruta(1, { attrs: SESSAO_AMANHA })]);
  await cicloDaCaixa(deps(f1.armazem, c1.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(deps(f1.armazem, c1.chat), 2, 'x', 'ligado', U, VESPERA);
  await cicloDaCaixa(deps(f1.armazem, c1.chat), 2, 'x', 'ligado', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(c1.mensagens.length, 1);
  assert.equal(c1.mensagens[0]!.privada, false);
  assert.match(c1.mensagens[0]!.texto, /^Olá, Maria\. A sua sessão é amanhã\./);

  const f2 = armazemFalso();
  const c2 = chatFalso(() => [bruta(1, { attrs: SESSAO_AMANHA })]);
  const kommo = async () => ({ leadId: 55 });
  await cicloDaCaixa(comKommo(f2.armazem, c2.chat, kommo), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  const r = await cicloDaCaixa(comKommo(f2.armazem, c2.chat, kommo), 2, 'x', 'ligado', U, VESPERA);
  assert.equal(r.noKommo, 1);
  assert.equal(c2.mensagens.length, 1);
  assert.equal(c2.mensagens[0]!.privada, true);
  assert.match(c2.mensagens[0]!.texto, /cartão ativo no Kommo da unidade \(lead 55\)/);
});

test('sessão da agenda: duas conversas do mesmo telefone → só a mais recente fala, e a outra não escreve nada', async () => {
  const tel = '+5594999990000';
  const f = armazemFalso();
  const A = () => ({ ...bruta(1, { attrs: SESSAO_AMANHA, telefone: tel, labels: ['historico'] }), last_activity_at: unix('2026-11-12T10:00:00Z') });
  const B = () => ({ ...bruta(2, { attrs: SESSAO_AMANHA, telefone: tel }), last_activity_at: unix('2026-11-16T10:00:00Z') });
  const c = chatFalso(() => [A(), B()]);
  await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(deps(f.armazem, c.chat), 2, 'x', 'ligado', U, VESPERA);
  assert.deepEqual(c.mensagens.map((m) => m.id), [2]);
  assert.match(c.mensagens[0]!.texto, /A sua sessão é amanhã/);
});

// ── tela «Robôs»: robô desligado, tempo e modelo configurados ──

const ajustesDe = (o: { desligados?: string[]; tempoMin?: Record<string, number>; modelos?: Record<string, string> }): DepsDoCiclo['ajustes'] => async () => ({
  desligados: new Set(o.desligados ?? []),
  regua: { tempoMin: new Map(Object.entries(o.tempoMin ?? {})), modelos: new Map(Object.entries(o.modelos ?? {})) },
});
const comAjustes = (armazem: Armazem, chat: Chat, ajustes: DepsDoCiclo['ajustes']): DepsDoCiclo => ({ armazem, chat, pausa: async () => undefined, ajustes });

test('robô DESLIGADO na tela: não envia, não deixa nota, não registra, conta em «desligados»; ligado de novo (dentro do prazo) sai', async () => {
  const f = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const desligado = comAjustes(f.armazem, c.chat, ajustesDe({ desligados: ['consulta-vespera'] }));
  await cicloDaCaixa(desligado, 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  const r = await cicloDaCaixa(desligado, 2, 'x', 'ligado', U, VESPERA);
  assert.equal(r.desligados, 1);
  assert.equal(r.disparos, 0);
  assert.equal(c.mensagens.length, 0, 'nem mensagem nem nota');
  assert.equal(f.disparos.length, 0, 'nada registrado');
  // outro robô da mesma conversa segue normal (consulta-dia não está desligado)
  const r2 = await cicloDaCaixa(desligado, 2, 'x', 'ligado', U, new Date('2026-11-17T14:35:00Z')); // 3 h antes das 14:30 de Belém
  assert.equal(r2.disparos, 1);
  assert.match(c.mensagens[0]!.texto, /Bom dia/);
  // religou: a véspera ainda estava dentro do prazo? (2 h) — aqui já passou, então não sai atrasada
  const ligado = comAjustes(f.armazem, c.chat, ajustesDe({}));
  const r3 = await cicloDaCaixa(ligado, 2, 'x', 'ligado', U, new Date('2026-11-16T17:40:00Z'));
  assert.equal(r3.desligados, 0);
  assert.equal(c.mensagens.filter((m) => /é amanhã/.test(m.texto)).length, 1, 'religado dentro do prazo: sai');
});

test('robô desligado também vale no SECO (nenhuma nota) e para as regras internas', async () => {
  const f = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const d = comAjustes(f.armazem, c.chat, ajustesDe({ desligados: ['consulta-vespera'] }));
  await cicloDaCaixa(d, 2, 'x', 'seco', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(d, 2, 'x', 'seco', U, VESPERA);
  assert.equal(c.mensagens.length, 0);
});

test('tempo configurado: o lembrete sai no novo horário, não no de fábrica', async () => {
  const f = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  // véspera de 48 h em vez de 24 h: 17/11 14:30 Belém menos 48 h = 15/11 14:30 (domingo, janela fechada); 12 h antes = 17/11 02:30 (fechada) — usa 6 h
  const d = comAjustes(f.armazem, c.chat, ajustesDe({ tempoMin: { 'consulta-vespera': 6 * 60 } }));
  await cicloDaCaixa(d, 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(d, 2, 'x', 'ligado', U, VESPERA); // no horário de fábrica (24 h antes): NÃO sai
  assert.equal(c.mensagens.length, 0);
  await cicloDaCaixa(d, 2, 'x', 'ligado', U, new Date('2026-11-17T11:35:00Z')); // 6 h antes das 14:30 Belém = 08:30 Belém = 11:30Z
  assert.equal(c.mensagens.length, 1);
  assert.match(c.mensagens[0]!.texto, /A sua consulta é amanhã/);
});

test('modelo trocado na tela: o worker manda o texto do modelo novo (e continua exigindo o template aprovado na Meta)', async () => {
  const f = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const d = comAjustes(f.armazem, c.chat, ajustesDe({ modelos: { 'consulta-vespera|parau_consulta_lembrete_vespera': 'parau_sessao_lembrete_vespera' } }));
  await cicloDaCaixa(d, 2, 'x', 'ligado', U, new Date('2026-11-16T17:20:00Z'));
  await cicloDaCaixa(d, 2, 'x', 'ligado', U, VESPERA);
  assert.equal(c.mensagens.length, 1);
  assert.match(c.mensagens[0]!.texto, /^Olá, Maria\. A sua sessão é amanhã/);
});

test('se a configuração não puder ser lida, o ciclo NÃO roda (nunca mandar achando que está ligado o que foi desligado)', async () => {
  const f = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: CONSULTA })]);
  const quebrado: DepsDoCiclo['ajustes'] = async () => { throw new Error('banco fora'); };
  await assert.rejects(cicloDaCaixa(comAjustes(f.armazem, c.chat, quebrado), 2, 'x', 'ligado', U, VESPERA), /banco fora/);
  assert.equal(c.mensagens.length, 0);
  assert.equal(f.vistos.length, 0, 'nem a memória foi tocada');
});

test('lead quente parado: sem CHATWOOT_GERENTE_WHATSAPP, o número da gerente vem de crm_tarefa_zap — SÓ com a demora LIGADA (em seco nada novo sai)', async () => {
  const env = { EVOLUTION_ALERT_URL: 'https://evo.exemplo.test/send', EVOLUTION_ALERT_HEADER: 'apikey', EVOLUTION_ALERT_VALUE: 'segredo' };
  const enviados: Array<{ numero: string; texto: string }> = [];
  const enviar = async (a: { numero: string; texto: string }) => (enviados.push({ numero: a.numero, texto: a.texto }), true);
  const consultas: Array<[number, number]> = [];
  const numero = async (conta: number, caixa: number) => (consultas.push([conta, caixa]), '5594999990001');
  const com = (modo: string) => avisoDaGerenteDoBanco('doutor-hernia-parauapebas', 3, 1, { modo: () => modo, numero, env, enviar: enviar as never })!;
  for (const modo of ['seco', 'desligado']) assert.equal(await com(modo)('🔥 Lead QUENTE', 'quente-7'), false, modo);
  assert.deepEqual([enviados.length, consultas.length], [0, 0], 'em seco/desligado nem consulta o banco');
  assert.equal(await com('ligado')('🔥 Lead QUENTE parado há 3 h: Maria.', 'quente-7'), true);
  assert.deepEqual(enviados, [{ numero: '5594999990001', texto: '🔥 Lead QUENTE parado há 3 h: Maria.' }]);
  assert.deepEqual(consultas, [[1, 3]]);
  // gerente sem número cadastrado: não sai (e não lança)
  const semNumero = avisoDaGerenteDoBanco('doutor-hernia-parauapebas', 3, 1, { modo: () => 'ligado', numero: async () => null, env, enviar: enviar as never })!;
  assert.equal(await semNumero('x', 'k'), false);
  assert.equal(enviados.length, 1);
  // sem o canal dos alertas ou sem a conta: nem monta
  assert.equal(avisoDaGerenteDoBanco('x', 3, 1, { env: {} }), undefined);
  assert.equal(avisoDaGerenteDoBanco('x', 3, undefined, { env }), undefined);
});

test('paciente já CONFIRMADO: o worker manda a véspera sem a pergunta (data, endereço e mapa), uma vez só, e registra a regra de véspera como feita', async () => {
  const confirmada = { etapa: 'Confirmado', situacao_consulta: 'Confirmado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-17', hora_consulta: '14:30' };
  const arm = armazemFalso();
  const c = chatFalso(() => [bruta(1, { attrs: confirmada })]);
  await cicloDaCaixa(deps(arm.armazem, c.chat), 2, 'x', 'ligado', U, new Date(VESPERA.getTime() - 600_000));
  await cicloDaCaixa(deps(arm.armazem, c.chat), 2, 'x', 'ligado', U, VESPERA);
  await cicloDaCaixa(deps(arm.armazem, c.chat), 2, 'x', 'ligado', U, new Date(VESPERA.getTime() + 600_000));
  assert.equal(c.mensagens.length, 1);
  assert.equal(c.mensagens[0]!.privada, false);
  assert.match(c.mensagens[0]!.texto, /^Olá, Maria\. Passando para lembrar: a sua consulta é amanhã\.\nData e horário: 17\/11 às 14:30\nEndereço: /);
  assert.doesNotMatch(c.mensagens[0]!.texto, /\?/);
  assert.deepEqual(arm.disparos.map((d) => `${d.regra}|${d.modo}`), ['consulta-vespera|ligado']);
});

test('paciente CONFIRMADO na caixa oficial com a janela FECHADA: se o «sem pedido» não está aprovado na Meta, vai o template ORIGINAL (com data, endereço e mapa); aprovado, vai o «sem pedido»; nenhum aprovado, só a nota', async () => {
  const SEM = 'parau_consulta_lembrete_vespera_confirmada';
  const confirmada = { attrs: { ...CONSULTA, situacao_consulta: 'Confirmado', etapa: 'Confirmado' }, ultima: CLINICA };
  const fechada = new Date('2026-11-14T10:00:00Z');
  // só o original aprovado
  const a = await doisCiclos('ligado', 3, { aprovados: [VESP], ultimaDoPaciente: fechada }, confirmada);
  assert.equal(a.mensagens.length, 1);
  assert.deepEqual(a.mensagens[0]!.template, { nome: VESP, idioma: 'pt_BR', variaveis: ['Maria', '17/11 às 14:30'] });
  assert.match(a.mensagens[0]!.texto, /^Olá, Maria\. A sua consulta é amanhã\./);
  assert.match(a.mensagens[0]!.texto, /Endereço: /);
  assert.equal(a.resumo.disparos, 1);
  assert.equal(a.resumo.semTemplate, 0);
  assert.ok(a.disparos[0]!.texto.startsWith(`[template ${VESP}] `));
  // os dois aprovados: vai o «sem pedido», sem a pergunta
  const b = await doisCiclos('ligado', 3, { aprovados: [VESP, SEM], ultimaDoPaciente: fechada }, confirmada);
  assert.deepEqual(b.mensagens[0]!.template, { nome: SEM, idioma: 'pt_BR', variaveis: ['Maria', '17/11 às 14:30'] });
  assert.doesNotMatch(b.mensagens[0]!.texto, /\?/);
  // nenhum aprovado: nota «sem template», nada ao paciente
  const c = await doisCiclos('ligado', 3, { aprovados: [], ultimaDoPaciente: fechada }, confirmada);
  assert.equal(c.mensagens.length, 1);
  assert.equal(c.mensagens[0]!.privada, true);
  assert.equal(c.resumo.semTemplate, 1);
  assert.equal(c.resumo.disparos, 0);
  // janela ABERTA: texto livre, o «sem pedido»
  const d = await doisCiclos('ligado', 3, { aprovados: [], ultimaDoPaciente: new Date('2026-11-16T10:00:00Z') }, { ...confirmada, ultima: PACIENTE_HOJE });
  assert.equal(d.mensagens[0]!.template, undefined);
  assert.doesNotMatch(d.mensagens[0]!.texto, /\?/);
});
