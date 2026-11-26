/**
 * A prévia do dia da régua: o que ela MANDARIA nas próximas 24 h, sem telefone, sem gravar nada — e igual ao que o worker de fato mandaria.
 * Datas: 2026-11-16 é segunda; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previaDaCaixa, previaDaConversa, formatarPrevia } from './chatwoot-regua-previa.js';
import { cicloDaCaixa, type Armazem, type Chat, type LinhaVista } from './chatwoot-regua-worker.js';
import { conversaDoChatwoot, type ConversaRegua, type DadosDaUnidade, type Visto } from './chatwoot-regua.js';

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const Z = (s: string) => new Date(s);
const unix = (s: string) => Math.floor(Z(s).getTime() / 1000);
const AGORA = Z('2026-11-16T12:00:00Z'); // segunda 09:00 em Belém

function conv(attrs: Record<string, unknown>, nome = 'maria da silva'): ConversaRegua {
  return { id: 10, nome, etiquetas: [], attrs, criadaEm: Z('2026-10-01T12:00:00Z'), atendente: 'Ana', ultima: null, telefone: '+5594999990000' };
}
const vistos = new Map<string, Visto>([['_visto', { valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false }]]);
const AMANHA = { etapa: 'Agendado', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-17', hora_consulta: '15:00' };

test('prévia de uma conversa: o que sairia, com modelo, primeiro nome, horário e quando — e nada de telefone', () => {
  const memoria = { vistos, feitos: new Set<string>() };
  const l = previaDaConversa(conv(AMANHA), memoria, AGORA, 24, U);
  assert.equal(l.length, 1);
  assert.equal(l[0]!.regra, 'consulta-vespera');
  assert.equal(l[0]!.modelo, 'parau_consulta_lembrete_vespera');
  assert.equal(l[0]!.nome, 'Maria');
  assert.equal(l[0]!.horario, '17/11 às 15:00');
  assert.equal(l[0]!.saiEm.toISOString(), '2026-11-16T18:00:00.000Z'); // 24 h antes das 15:00 de 17/11, dentro da janela de 08h às 20h
  assert.equal(l[0]!.interna, false);
  assert.deepEqual(l[0]!.faltando, []);
  assert.equal(JSON.stringify(l).includes('5594'), false, 'nenhum telefone na prévia');
  assert.equal(memoria.feitos.size, 0, 'a memória de quem chama não é alterada');
});

test('a janela da prévia: 48 h mostra também o «hoje» e o preparo do dia seguinte; o que já foi mandado não aparece', () => {
  const memoria = { vistos, feitos: new Set<string>() };
  assert.deepEqual(previaDaConversa(conv(AMANHA), memoria, AGORA, 48, U).map((x) => x.regra), ['consulta-vespera', 'consulta-dia', 'consulta-preparo']);
  const feito = { vistos, feitos: new Set(['consulta-vespera|2026-11-17T15:00']) };
  assert.deepEqual(previaDaConversa(conv(AMANHA), feito, AGORA, 48, U).map((x) => x.regra), ['consulta-dia', 'consulta-preparo']);
});

test('robô desligado na tela «Robôs» não aparece; contato sem nome aparece (nome vazio ou saudação); campo que falta aparece dizendo o que falta', () => {
  const memoria = { vistos, feitos: new Set<string>() };
  assert.deepEqual(previaDaConversa(conv(AMANHA), memoria, AGORA, 48, U, undefined, new Set(['consulta-dia'])).map((x) => x.regra), ['consulta-vespera', 'consulta-preparo']);
  const semNome = previaDaConversa(conv(AMANHA, '+55 94 99999-0000'), memoria, AGORA, 24, U);
  assert.equal(semNome.length, 1);
  assert.equal(semNome[0]!.interna, false);
  const U_FALTA: DadosDaUnidade = { ...U, nome: '', textos: { parau_consulta_lembrete_vespera: 'Olá, {{contact.name}}. {{lead.cf.2450736}} {{lead.cf.2450798}}' } };
  const falta = previaDaConversa(conv(AMANHA), memoria, AGORA, 24, U_FALTA);
  assert.deepEqual(falta.map((x) => x.faltando), [['nome da unidade']]);
});

// ── a caixa inteira, e igual ao worker ─────────────────────────────────────────────────────────────

function bruta(id: number, attrs: Record<string, unknown>, telefone: string) {
  return {
    id,
    created_at: unix('2026-10-01T12:00:00Z'),
    last_activity_at: unix('2026-11-15T12:00:00Z'),
    labels: [],
    custom_attributes: attrs,
    meta: { sender: { name: 'Maria da Silva', phone_number: telefone }, assignee: { name: 'Ana' } },
    last_non_activity_message: null,
  };
}

function fabrica() {
  const linhasVistas: LinhaVista[] = [];
  const disparos: Array<{ conversationId: number; regra: string; chave: string; modo: string }> = [];
  const escritas: string[] = [];
  const armazem: Armazem = {
    async vistos() {
      return linhasVistas.map((v) => ({ ...v }));
    },
    async salvar(_c, ms) {
      escritas.push(`salvar:${ms.length}`);
      for (const m of ms) if (m.tipo === 'criar') linhasVistas.push({ conversationId: m.conversationId, campo: m.campo, valor: m.valor, desde: m.desde, inicial: m.inicial });
    },
    async feitos() {
      return disparos.map((d) => ({ conversationId: d.conversationId, regra: d.regra, chave: d.chave }));
    },
    async registrar(l) {
      if (disparos.some((d) => d.conversationId === l.conversationId && d.regra === l.regra && d.chave === l.chave)) return false;
      disparos.push(l);
      escritas.push(`registrar:${l.regra}`);
      return true;
    },
    async desfazer() {
      escritas.push('desfazer');
    },
  };
  const mensagens: Array<{ id: number; texto: string }> = [];
  const chat = {
    async pagina(_c: number, p: number) {
      return p === 1 ? lista : [];
    },
    async ultimaPublica() {
      return null;
    },
    async mensagem(id: number, texto: string) {
      mensagens.push({ id, texto });
    },
    async ultimaDoPaciente() {
      return null;
    },
    async templatesAprovados() {
      return new Map<string, number | null>();
    },
    async etiquetas() {},
    async atributos() {},
    async prioridade() {},
    async atribuir() {},
  } as unknown as Chat;
  let lista: unknown[] = [];
  return { armazem, chat, mensagens, disparos, escritas, define: (l: unknown[]) => (lista = l) };
}

test('a caixa inteira: a prévia só LÊ (nenhuma escrita) e mostra exatamente o que o worker mandaria nessas 24 h', async () => {
  const conversas = [
    bruta(1, { ...AMANHA }, '+5594999990001'), // véspera amanhã 15:00
    bruta(2, { ...AMANHA, situacao_consulta: 'Confirmado', etapa: 'Confirmado' }, '+5594999990002'), // já confirmou
    bruta(3, { etapa: 'Perdido' }, '+5594999990003'), // sem consulta: nada novo
    bruta(4, { etapa: 'Agendado', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-17', hora_consulta: '09:30' }, '+5594999990004'), // 09:30 amanhã
  ];
  // a memória das conversas já existe (o worker as viu antes)
  const f = fabrica();
  f.define(conversas);
  for (const c of conversas) {
    const cv = conversaDoChatwoot(c)!;
    await f.armazem.salvar(2, [{ conversationId: cv.id, tipo: 'criar', campo: '_visto', valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false }, ...(['etapa', 'situacao_consulta'] as const).flatMap((campo) => (cv.attrs[campo] ? [{ conversationId: cv.id, tipo: 'criar' as const, campo, valor: String(cv.attrs[campo]), desde: Z('2026-11-10T12:00:00Z'), inicial: false }] : []))]);
  }
  const antes = f.escritas.length;
  const r = await previaDaCaixa({ armazem: f.armazem, chat: f.chat }, 2, U, AGORA, 24);
  assert.equal(f.escritas.length, antes, 'a prévia não gravou nada (nem a memória da régua, nem registro de disparo)');
  assert.equal(f.mensagens.length, 0, 'e não mandou nem nota');
  assert.equal(r.conversas, 4);

  // o worker, de verdade, de 10 em 10 min nas mesmas 24 h (modo ligado, caixa de Evolution: sem janela de 24 h)
  const w = fabrica();
  w.define(conversas);
  // a mesma memória
  for (const c of conversas) {
    const cv = conversaDoChatwoot(c)!;
    await w.armazem.salvar(2, [{ conversationId: cv.id, tipo: 'criar', campo: '_visto', valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false }, ...(['etapa', 'situacao_consulta'] as const).flatMap((campo) => (cv.attrs[campo] ? [{ conversationId: cv.id, tipo: 'criar' as const, campo, valor: String(cv.attrs[campo]), desde: Z('2026-11-10T12:00:00Z'), inicial: false }] : []))]);
  }
  const base = w.disparos.length;
  for (let t = AGORA.getTime(); t <= AGORA.getTime() + 24 * 3600_000; t += 10 * 60_000) {
    await cicloDaCaixa({ armazem: w.armazem, chat: w.chat, pausa: async () => undefined }, 2, 'x', 'ligado', U, new Date(t));
  }
  const doWorker = w.disparos.slice(base).filter((d) => d.modo === 'ligado').map((d) => `${d.conversationId}|${d.regra}`).sort();
  const daPrevia = r.linhas.filter((l) => !l.interna && !l.noKommo && l.faltando.length === 0).map((l) => `${l.conversa}|${l.regra}`).sort();
  assert.deepEqual(daPrevia, doWorker, 'a prévia e o worker concordam, mensagem a mensagem');
  assert.ok(daPrevia.length >= 2, 'o cenário tem o que mostrar');
});

test('a prévia confere o Kommo (só leitura) e marca quem NÃO receberia; Kommo que falha é dito, não escondido', async () => {
  const f = fabrica();
  f.define([bruta(1, { ...AMANHA }, '+5594999990001'), bruta(4, { ...AMANHA }, '+5594999990004')]);
  await f.armazem.salvar(2, [1, 4].map((id) => ({ conversationId: id, tipo: 'criar' as const, campo: '_visto', valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false })));
  const r = await previaDaCaixa(
    { armazem: f.armazem, chat: f.chat, kommo: async (tel) => { if (tel.endsWith('0004')) throw new Error('Kommo fora'); return { leadId: 1 }; } },
    2,
    U,
    AGORA,
    24,
  );
  assert.equal(r.linhas.find((l) => l.conversa === 1)!.noKommo, true);
  assert.equal(r.linhas.find((l) => l.conversa === 4)!.noKommo, false);
  assert.equal(r.linhas.find((l) => l.conversa === 4)!.semConferirKommo, true);
  assert.equal(r.semConferirKommo, 1);
  const texto = formatarPrevia(r, 'x', AGORA, 24);
  assert.match(texto, /NÃO manda: cartão ativo no Kommo/);
  assert.match(texto, /NÃO manda até conferir o Kommo/);
  assert.match(texto, /Mandaria 0 mensagem/, 'sem conferir o Kommo o ligado não manda: a contagem não as inclui');
  assert.match(texto, /não consegui conferir o Kommo para 1 conversa/);
  assert.doesNotMatch(texto, /5594/);
});

test('campo faltando e cartão no Kommo: a linha diz o que falta (o worker só confere o Kommo de quem falaria)', async () => {
  const f = fabrica();
  f.define([bruta(1, { ...AMANHA }, '+5594999990001')]);
  await f.armazem.salvar(2, [{ conversationId: 1, tipo: 'criar' as const, campo: '_visto', valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false }]);
  const faltando: DadosDaUnidade = { ...U, nome: '', textos: { parau_consulta_lembrete_vespera: 'Olá, {{contact.name}}. {{lead.cf.2450736}} {{lead.cf.2450798}}' } };
  let consultasAoKommo = 0;
  const r = await previaDaCaixa({ armazem: f.armazem, chat: f.chat, kommo: async () => { consultasAoKommo++; return { leadId: 1 }; } }, 2, faltando, AGORA, 24);
  assert.deepEqual(r.linhas.map((l) => [l.faltando, l.noKommo]), [[['nome da unidade'], false]]);
  assert.equal(consultasAoKommo, 0);
});
