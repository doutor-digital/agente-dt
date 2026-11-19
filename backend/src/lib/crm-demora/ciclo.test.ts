/**
 * O ciclo da «demora a responder», com banco, Chatwoot e WhatsApp DE MENTIRA (em memória). O que se prova aqui:
 *  - SECO nunca escreve: nem no paciente, nem no CRM, nem no WhatsApp — só anota «mandaria…» (regra com ~seco), uma vez, e o ligado nasce limpo;
 *  - LIGADO: 5 min = mensagem de espera ao paciente; 10 min = WhatsApp a quem está com a conversa + nota com menção; 30 min = WhatsApp à gerente;
 *    cada um UMA vez por espera (o ciclo seguinte, outra cópia do servidor e a própria mensagem de espera no histórico não repetem);
 *  - o CUIDADO CENTRAL: depois da mensagem de espera a conta da equipe continua (os avisos de 10 e 30 min saem); resposta humana a zera;
 *  - a equipe que responde entre a listagem e o envio (a conversa é relida) segura tudo;
 *  - SAIR, Sofia atendendo, fora do horário, sem número (a gerente recebe) e o teto de saídas.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../prisma.js';

Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });

const C = await import('./ciclo.js');
const M = await import('./marca.js');
const T = await import('../crm-tarefas/regras.js');
type Estado = import('../automacoes-estado.js').Estado;
type UnidadeDaDemora = import('./ciclo.js').UnidadeDaDemora;

const FUSO = 'America/Sao_Paulo';
/** terça 18/11/2026, 15:00 em São Paulo */
const BASE = T.localParaUtc('2026-11-18T15:00', FUSO)!;
const CTX = { conta: { url: 'https://crm.exemplo.test', conta: 1, token: 'tk-secreto-nao-sai' } } as never;

let agora = BASE;
const em = (minutosDepoisDaBase: number) => Math.floor((BASE.getTime() + minutosDepoisDaBase * 60_000) / 1000);
let mid = 0;

interface Conv {
  id: number;
  status: string;
  labels: string[];
  assignee: { id: number; name: string } | null;
  nome: string;
  mensagens: any[];
  etapa?: string;
}
let convs: Conv[] = [];

const P = (min: number, content = 'quero marcar uma consulta') => ({ id: ++mid, message_type: 0, private: false, content, created_at: em(min), sender: { type: 'contact', id: 55 } });
const HUMANO = (min: number) => ({ id: ++mid, message_type: 1, private: false, content: 'Oi!', created_at: em(min), sender: { id: 4, type: 'user', name: 'Cleia' } });
const ECO = (min: number) => ({ id: ++mid, message_type: 1, private: false, content: 'pelo celular', created_at: em(min), sender: null, content_attributes: { external_echo: true } });
const SOFIA = (min: number) => ({ id: ++mid, message_type: 1, private: false, content: 'Posso ajudar?', created_at: em(min), sender: { id: 1, type: 'agent_bot' } });

function conv(o: Partial<Conv> & { mensagens: any[] }): Conv {
  const c: Conv = { id: 40, status: 'open', labels: [], assignee: { id: 5, name: 'Maria Heloisa Sabino' }, nome: 'Maria Silva', ...o };
  convs.push(c);
  return c;
}
const raw = (c: Conv) => {
  const ultima = c.mensagens.filter((m) => m.message_type !== 2).at(-1);
  return {
    id: c.id,
    status: c.status,
    labels: c.labels,
    inbox_id: 3,
    custom_attributes: c.etapa ? { etapa: c.etapa } : {},
    meta: { sender: { id: 55, name: c.nome, phone_number: '+5594999990000' }, assignee: c.assignee },
    last_activity_at: Math.max(...c.mensagens.map((m) => Number(m.created_at))),
    last_non_activity_message: ultima ?? null,
  };
};

interface Saidas {
  espera: Array<{ conversa: number; texto: string }>;
  notas: Array<{ conversa: number; texto: string }>;
  zaps: Array<{ numero: string; texto: string }>;
}
let saidas: Saidas;
let sair: Date | null | 'erro' = null;
let zapFunciona = true;
let relidas = 0;

/** o usuário do Chatwoot por onde sai a mensagem de espera: o conector da conta 1 é o 2; o de outra conta pode ser qualquer id */
let conector = 2;
function mundo(modo: Estado, o: { iaLigada?: boolean; gerente?: number | null; aoRelerDepoisDaListagem?: () => void } = {}) {
  const u: UnidadeDaDemora = {
    slug: 'doutor-hernia-parauapebas',
    nome: 'Doutor Hérnia Parauapebas',
    fuso: FUSO,
    modo,
    iaLigada: o.iaLigada ?? false,
    ctx: CTX,
    caixas: [{ id: 3, oficial: true, gerente: o.gerente === undefined ? 4 : o.gerente }],
  };
  return {
    async unidades() {
      return [u];
    },
    async listar() {
      return convs.filter((c) => c.status === 'open' || c.status === 'pending').map(raw);
    },
    async conversa(_: unknown, id: number) {
      relidas++;
      o.aoRelerDepoisDaListagem?.();
      return raw(convs.find((c) => c.id === id)!);
    },
    async mensagens(_: unknown, id: number) {
      return convs.find((c) => c.id === id)!.mensagens.map((m) => ({ ...m }));
    },
    async pediuSair() {
      if (sair === 'erro') throw new Error('Chatwoot fora do ar');
      return sair;
    },
    async mandarEspera(_u: unknown, _ctx: unknown, id: number, texto: string) {
      saidas.espera.push({ conversa: id, texto });
      // o Chatwoot grava a mensagem na conversa: o ciclo seguinte a enxerga (e tem de ignorá-la)
      convs.find((c) => c.id === id)!.mensagens.push({ id: ++mid, message_type: 1, private: false, content: texto, created_at: Math.floor(agora.getTime() / 1000), sender: { id: conector, type: 'user' } });
      return { id: mid };
    },
    async nota(_: unknown, id: number, texto: string) {
      saidas.notas.push({ conversa: id, texto });
    },
    async zap(numero: string, texto: string) {
      saidas.zaps.push({ numero, texto });
      return zapFunciona;
    },
    agora: () => agora,
    pausa: async () => undefined,
    env: {},
  };
}

interface Linha {
  caixa: number;
  conversationId: number;
  regra: string;
  chave: string;
  modo: string;
  texto: string;
}
let banco: Linha[] = [];
let zaps: Record<number, { telefone: string; nome: string }> = {};
function armazem() {
  return {
    async registrar(l: Linha) {
      if (banco.some((x) => x.caixa === l.caixa && x.conversationId === l.conversationId && x.regra === l.regra && x.chave === l.chave)) return false;
      banco.push(l);
      return true;
    },
    async desfazer(l: { caixa: number; conversationId: number; regra: string; chave: string }) {
      banco = banco.filter((x) => !(x.caixa === l.caixa && x.conversationId === l.conversationId && x.regra === l.regra && x.chave === l.chave));
    },
    async numeroDoAgente(_conta: number, agenteId: number) {
      return zaps[agenteId] ?? null;
    },
  };
}

let memoria = C.novaMemoriaDaDemora();
const ciclo = (modo: Estado, o: Parameters<typeof mundo>[1] = {}, mem = memoria) => C.rodarCicloDaDemora({ armazem: armazem(), mundo: mundo(modo, o), memoria: mem });
const regras = () => banco.map((l) => l.regra).sort();
const nada = () => assert.deepEqual(saidas, { espera: [], notas: [], zaps: [] }, 'nada podia ter saído');

beforeEach(() => {
  agora = BASE;
  convs = [];
  banco = [];
  zaps = { 4: { telefone: '5594999990001', nome: 'Cleia Rodrigues' }, 5: { telefone: '5594999990002', nome: 'Maria Heloisa Sabino' } };
  saidas = { espera: [], notas: [], zaps: [] };
  sair = null;
  zapFunciona = true;
  relidas = 0;
  memoria = C.novaMemoriaDaDemora();
  conector = 2;
});

const avanca = (minutos: number) => void (agora = new Date(agora.getTime() + minutos * 60_000));

// ── SECO ─────────────────────────────────────────────────────────────────────────────────────────

test('SECO: decide tudo e só anota «mandaria…» (regra ~seco), uma vez — nada vai ao paciente, ao CRM nem ao WhatsApp', async () => {
  conv({ mensagens: [P(-6)] });
  let r = await ciclo('seco');
  assert.equal(r.simulados.espera, 1);
  assert.deepEqual(regras(), ['demora-espera~seco']);
  assert.match(banco[0]!.texto, /mandaria ao paciente.*Oi, Maria! Recebemos sua mensagem/);
  avanca(5); // 11 min
  r = await ciclo('seco');
  assert.equal(r.simulados['aviso-10'], 1);
  avanca(20); // 31 min
  r = await ciclo('seco');
  assert.equal(r.simulados['aviso-30'], 1);
  assert.deepEqual(regras(), ['demora-aviso-10~seco', 'demora-aviso-30~seco', 'demora-espera~seco']);
  // repetir o ciclo (e reiniciar o servidor: memória nova) não repete nada
  await ciclo('seco');
  await ciclo('seco', {}, C.novaMemoriaDaDemora());
  assert.equal(banco.length, 3);
  nada();
});

test('SECO não trava o LIGADO: ao ligar, a mesma espera ainda recebe o aviso de verdade (regra sem o sufixo)', async () => {
  conv({ mensagens: [P(-12)] });
  await ciclo('seco');
  assert.equal(banco.every((l) => l.regra.endsWith('~seco')), true);
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 1, 'o WhatsApp do aviso de 10 min saiu');
  assert.ok(regras().includes('demora-aviso-10'));
});

test('SECO e o portão do «ligado»: unidade desligada não lê nem anota nada', async () => {
  conv({ mensagens: [P(-12)] });
  const r = await ciclo('desligado');
  assert.equal(r.unidades, 0);
  assert.equal(banco.length, 0);
  nada();
});

// ── LIGADO: os três passos ───────────────────────────────────────────────────────────────────────

test('LIGADO: aos 5 min vai a mensagem de espera ao paciente, uma vez; antes disso, nada', async () => {
  conv({ mensagens: [P(-4)] });
  await ciclo('ligado');
  nada();
  avanca(1.5); // 5,5 min
  await ciclo('ligado');
  assert.deepEqual(saidas.espera, [{ conversa: 40, texto: 'Oi, Maria! Recebemos sua mensagem 😊 Já já alguém da equipe te responde.' }]);
  assert.equal(saidas.zaps.length, 0, 'ainda não são 10 min');
  await ciclo('ligado');
  await ciclo('ligado', {}, C.novaMemoriaDaDemora());
  assert.equal(saidas.espera.length, 1, 'uma vez só');
});

test('CUIDADO CENTRAL: a mensagem de espera zera o aguardando do Chatwoot, mas a conta da equipe segue — 10 e 30 min saem depois dela', async () => {
  conv({ mensagens: [P(-6)] });
  await ciclo('ligado');
  assert.equal(saidas.espera.length, 1);
  avanca(5); // 11 min — a mensagem de espera já está no histórico da conversa
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 1, 'o aviso de 10 min saiu mesmo com a nossa mensagem de espera no histórico');
  assert.deepEqual(saidas.zaps[0]!.numero, '5594999990002', 'quem está com a conversa (Maria Heloisa)');
  assert.match(saidas.zaps[0]!.texto, /⏰ Maria Silva está esperando resposta há 11 min/);
  assert.match(saidas.zaps[0]!.texto, /https:\/\/crm\.exemplo\.test\/app\/accounts\/1\/conversations\/40/);
  assert.equal(saidas.notas.length, 1);
  assert.match(saidas.notas[0]!.texto, /^🔔 \[@Maria\]\(mention:\/\/user\/5\/Maria\) ⏰ Maria Silva está esperando resposta há 11 min/);
  avanca(20); // 31 min
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 2);
  assert.equal(saidas.zaps[1]!.numero, '5594999990001', 'o de 30 min vai para a gerente (Cleia)');
  assert.match(saidas.zaps[1]!.texto, /há 31 min — com Maria/);
  assert.equal(saidas.espera.length, 1, 'e a mensagem ao paciente continua uma só');
  // nada se repete
  for (let i = 0; i < 3; i++) await ciclo('ligado');
  assert.deepEqual([saidas.espera.length, saidas.zaps.length, saidas.notas.length], [1, 2, 1]);
});

test('CUIDADO CENTRAL (conta de clínica): se o conector não é o usuário 2, só a MARCA da mensagem de espera impede de tomá-la por resposta da equipe', async () => {
  conector = 31;
  conv({ mensagens: [P(-6)] });
  await ciclo('ligado');
  assert.equal(saidas.espera.length, 1);
  avanca(5);
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 1, 'o aviso de 10 min sai: a mensagem de espera do usuário 31 não zerou a espera da equipe');
  avanca(20);
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 2);
});

test('a equipe responde (usuário do CRM ou celular): a espera acaba; se o paciente voltar, é outra espera com avisos novos', async () => {
  const c = conv({ mensagens: [P(-12)] });
  c.mensagens.push(ECO(-11)); // respondeu pelo celular
  await ciclo('ligado');
  nada();
  c.mensagens.push(P(-2));
  avanca(10); // o paciente escreveu há 12 min
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 1, 'aviso de 10 min da NOVA espera');
  assert.equal(saidas.espera.length, 1, 'mensagem de espera ao paciente');
  c.mensagens.push(HUMANO(avancado(-0.5)));
  c.mensagens.push(P(avancado(-0.25)));
  avanca(13);
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 2, 'terceira espera: outro aviso de 10 min');
  assert.equal(saidas.espera.length, 1, 'mas a mensagem de espera é 1× por conversa por dia');
  assert.equal(regras().filter((r) => r === 'demora-aviso-10').length, 2);
});
/** minutos desde a base até agora + `d` (para escrever mensagens «a partir de agora» no teste) */
const avancado = (d: number) => (agora.getTime() - BASE.getTime()) / 60_000 + d;

test('a equipe responde ENTRE a listagem e o envio: a conversa é relida e nada sai', async () => {
  const c = conv({ mensagens: [P(-12)] });
  await ciclo('ligado', { aoRelerDepoisDaListagem: () => c.mensagens.push(HUMANO(avancado(-0.5))) });
  assert.ok(relidas >= 1, 'releu antes de agir');
  nada();
  assert.equal(banco.length, 0, 'e não registrou nada');
});

test('duas cópias do servidor ao mesmo tempo: sai uma vez só', async () => {
  conv({ mensagens: [P(-12)] });
  await Promise.all([ciclo('ligado', {}, C.novaMemoriaDaDemora()), ciclo('ligado', {}, C.novaMemoriaDaDemora())]);
  assert.equal(saidas.espera.length, 1);
  assert.equal(saidas.zaps.length, 1);
  assert.equal(saidas.notas.length, 1);
});

// ── destinos ─────────────────────────────────────────────────────────────────────────────────────

test('sem responsável, ou responsável sem WhatsApp: o aviso de 10 min vai para a gerente (e a nota menciona a gerente)', async () => {
  conv({ id: 41, assignee: null, mensagens: [P(-12)] });
  conv({ id: 42, assignee: { id: 6, name: 'Lorena Pereira' }, mensagens: [P(-12)] }); // Lorena não tem número
  conv({ id: 43, assignee: { id: 2, name: 'Sofia' }, mensagens: [P(-12)] }); // o conector não é «quem atende»
  await ciclo('ligado');
  assert.deepEqual(saidas.zaps.map((z) => z.numero), ['5594999990001', '5594999990001', '5594999990001']);
  const menc = saidas.notas.map((n) => n.texto.match(/mention:\/\/user\/(\d+)/)?.[1]);
  assert.deepEqual(menc, ['4', '6', '4'], 'a menção vai para quem está com a conversa (Lorena), senão a gerente');
});

test('nem o responsável nem a gerente têm WhatsApp: só a nota com menção; o aviso de 30 min espera o número (não registra)', async () => {
  zaps = {};
  conv({ mensagens: [P(-32)] });
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 0);
  assert.equal(saidas.notas.length, 1);
  assert.ok(!regras().includes('demora-aviso-30'), 'sem número não registra: quando o cadastro sair, ainda dentro do prazo, o aviso sai');
  zaps = { 4: { telefone: '5594999990001', nome: 'Cleia' } };
  await ciclo('ligado');
  assert.deepEqual(saidas.zaps.map((z) => z.numero), ['5594999990001'], 'agora a gerente tem número');
});

test('10 e 30 min vencidos juntos para o MESMO número: um WhatsApp só (o de 30 min)', async () => {
  conv({ assignee: { id: 4, name: 'Cleia Rodrigues' }, mensagens: [P(-32)] });
  await ciclo('ligado');
  assert.equal(saidas.zaps.length, 1);
  assert.match(saidas.zaps[0]!.texto, /há 32 min — com Cleia/);
  assert.equal(saidas.notas.length, 1, 'a nota com menção sai do mesmo jeito');
  assert.deepEqual(regras().filter((r) => r.startsWith('demora-aviso')), ['demora-aviso-10', 'demora-aviso-10-nota', 'demora-aviso-30']);
});

test('o WhatsApp que falha não vira «feito»: o ciclo seguinte tenta de novo; nota que saiu não se repete', async () => {
  conv({ mensagens: [P(-30)] });
  zapFunciona = false;
  zaps = { 5: { telefone: '5594999990002', nome: 'Maria' } };
  let r = await ciclo('ligado');
  assert.equal(r.falhas >= 1, true);
  zapFunciona = true;
  r = await ciclo('ligado');
  assert.equal(saidas.zaps.filter((z) => z.numero === '5594999990002').length, 2, 'tentou de novo e agora foi');
  assert.equal(r.feitos['aviso-10'], 1);
});

// ── as travas ────────────────────────────────────────────────────────────────────────────────────

test('o paciente que pediu SAIR não recebe a mensagem de espera (a equipe ainda é avisada); não deu para conferir SAIR = não manda', async () => {
  conv({ mensagens: [P(-12)] });
  sair = new Date();
  await ciclo('ligado');
  assert.equal(saidas.espera.length, 0);
  assert.equal(saidas.zaps.length, 1);
  sair = 'erro';
  conv({ id: 41, mensagens: [P(-12)] });
  const r = await ciclo('ligado');
  assert.equal(saidas.espera.length, 0);
  assert.ok(Object.keys(r.barrados).some((k) => k.includes('SAIR')));
  assert.equal(banco.filter((l) => l.regra === 'demora-espera').length, 0, 'e não registrou: tenta no próximo ciclo');
});

test('com a Sofia atendendo: nada sai até ela travar; depois só o aviso à equipe', async () => {
  conv({ labels: ['sofia-atendendo'], mensagens: [P(-12)] });
  await ciclo('ligado');
  nada();
  avanca(5); // 17 min: a Sofia travou
  await ciclo('ligado');
  assert.equal(saidas.espera.length, 0, 'nunca a mensagem ao paciente por cima da Sofia');
  assert.equal(saidas.zaps.length, 1);
});

test('a Sofia passou a conversa há 9 min depois de 30 min de papo: a espera é de 9 min (só a mensagem de espera), não de 39', async () => {
  const passou = { id: ++mid, message_type: 1, private: true, content: '🙋 A Sofia passou esta conversa para você: pediu humano', created_at: em(-9), sender: { id: 2, type: 'user' } };
  conv({ labels: ['esperando-humano'], mensagens: [P(-40), SOFIA(-39), P(-12), SOFIA(-11), passou] });
  await ciclo('ligado');
  assert.equal(saidas.espera.length, 1);
  assert.equal(saidas.zaps.length, 0, 'ainda não são 10 min desde a passagem');
  assert.equal(saidas.notas.length, 0);
});

test('conversa que não é de paciente: contato interno, grupo, resolvida, caixa fora do horário — nada sai', async () => {
  conv({ id: 41, labels: ['interno'], mensagens: [P(-35)] });
  conv({ id: 42, labels: ['historico'], mensagens: [P(-35)] });
  conv({ id: 43, status: 'resolved', mensagens: [P(-35)] });
  await ciclo('ligado');
  nada();
  // 21h: fora do horário
  convs = [];
  conv({ id: 44, mensagens: [P(-12)] });
  agora = T.localParaUtc('2026-11-18T21:00', FUSO)!;
  convs[0]!.mensagens = [{ ...P(0), created_at: Math.floor(agora.getTime() / 1000) - 12 * 60 }];
  await ciclo('ligado');
  nada();
});

test('passo atrasado demais (servidor parado) não sai', async () => {
  conv({ mensagens: [P(-300)] });
  await ciclo('ligado');
  nada();
});

test('o teto de saídas por ciclo: o excesso espera o ciclo seguinte (nada se perde, nada vaza)', async () => {
  for (let i = 0; i < 20; i++) conv({ id: 100 + i, mensagens: [P(-12)] });
  const r = await ciclo('ligado');
  assert.ok(r.saidas <= C.MAX_SAIDAS_POR_CICLO, `saídas ${r.saidas}`);
  assert.ok(r.noTeto > 0);
  const antes = saidas.espera.length;
  await ciclo('ligado');
  assert.ok(saidas.espera.length > antes, 'o ciclo seguinte continua de onde parou');
  for (let i = 0; i < 6; i++) await ciclo('ligado');
  assert.equal(saidas.espera.length, 20);
  assert.equal(new Set(saidas.espera.map((e) => e.conversa)).size, 20, 'cada conversa recebeu uma vez');
});

test('a mensagem de espera já no histórico de hoje (o banco perdeu a linha) não é mandada de novo', async () => {
  const c = conv({ mensagens: [P(-12)] });
  c.mensagens.push({ id: ++mid, message_type: 1, private: false, content: M.textoDaEspera('Maria'), created_at: em(-6), sender: { id: 2, type: 'user' } });
  const r = await ciclo('ligado');
  assert.equal(saidas.espera.length, 0);
  assert.equal(r.barrados['espera: já mandou hoje'], 1);
});

test('uma falha de leitura numa conversa não derruba as outras', async () => {
  conv({ id: 41, mensagens: [P(-12)] });
  conv({ id: 42, mensagens: [P(-12)] });
  const m = mundo('ligado');
  const original = m.mensagens;
  m.mensagens = async (ctx: unknown, id: number) => {
    if (id === 41) throw new Error('Chatwoot 500');
    return original(ctx, id);
  };
  const r = await C.rodarCicloDaDemora({ armazem: armazem(), mundo: m, memoria });
  assert.equal(r.falhas, 1);
  assert.equal(saidas.espera.filter((e) => e.conversa === 42).length, 1);
});
