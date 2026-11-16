/**
 * Disparo pelo CRM (origem «chatwoot» do motor de disparo): filtro, público e exclusões, o Porto (envio pela conversa, só caixa
 * WhatsApp oficial), o modo SECO (nada sai), os freios do motor (janela, teto do TIER, parada por SAIR) e quem aprova.
 * O motor em si (`rodarUnidade`) é o do Kommo e tem os testes dele; aqui se prova que a origem nova passa por ele e não o contorna.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { criarContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { FREIOS_PADRAO } from './disparo/freios.js';
import { rodarUnidade, type Destino, type DadosDeGravacao, type OndaNoLote, type Porto } from './disparo/lote.js';
import { filtroSchema, passaNoFiltro, resumoDoFiltro, type ConversaDoPublico, type Filtro } from './disparo/chatwoot/filtro.js';
import { calcularPublico, conversaDoPublico, situacaoPeloCrm, type DepsDoPublico } from './disparo/chatwoot/publico.js';
import { caixaWhatsappOficial, modeloDaCaixa } from './disparo/chatwoot/canal.js';
import { portoChatwoot, modoDoDisparoNoCrm, idDaMensagem, type OndaDaRodada } from './disparo/chatwoot/porto.js';
import { freiosComOTier, quemAprova, tetoDoTier, administradoresDD } from './disparo/chatwoot/ajuste.js';
import { aprovarOndaChatwoot } from './disparo/chatwoot/onda.js';
import { impressaoDaOnda } from './disparo/modelo.js';
import { definicaoDaOnda, aprovarOnda } from './disparo/onda.js';
import { chaveDaPessoa, textoFinal } from './disparo/regras.js';

const originais = new Map<string, PropertyDescriptor | undefined>();
function falso(modelo: string, metodos: Record<string, unknown>): void {
  if (!originais.has(modelo)) originais.set(modelo, Object.getOwnPropertyDescriptor(prisma, modelo));
  Object.defineProperty(prisma, modelo, { value: metodos, configurable: true, writable: true });
}
afterEach(() => {
  mock.restoreAll();
  for (const [modelo, d] of originais) {
    if (d) Object.defineProperty(prisma, modelo, d);
    else delete (prisma as unknown as Record<string, unknown>)[modelo];
  }
  originais.clear();
  delete process.env.CHATWOOT_DISPARO_SLUGS;
  delete process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE;
  delete process.env.KIT_ADMINS_DD;
});

// Quarta 21/10/2026, 09h30 em São Paulo (dentro da janela do motor).
const AGORA = new Date(Date.UTC(2026, 9, 21, 12, 30));
const SEG = (d: Date) => Math.floor(d.getTime() / 1000);
const dias = (n: number) => new Date(AGORA.getTime() - n * 86_400_000);
const fone = (n: number) => `+559499100${String(n).padStart(4, '0')}`;

/** Uma conversa crua da listagem do Chatwoot. */
const cru = (id: number, o: Record<string, unknown> = {}, sender: Record<string, unknown> = {}) => ({
  id,
  inbox_id: 3,
  status: 'open',
  labels: [] as string[],
  custom_attributes: { etapa: 'Perdido' },
  created_at: SEG(dias(90)),
  last_activity_at: SEG(dias(40)),
  last_non_activity_message: { message_type: 1, private: false, created_at: SEG(dias(40)), sender: { id: 1, type: 'user' } },
  meta: { sender: { id: 1000 + id, name: `${NOMES[(id - 1) % 12]} Silva`, phone_number: fone(id), ...sender }, assignee: null },
  ...o,
});

const NOMES = ['Ana', 'Bia', 'Cris', 'Duda', 'Edu', 'Fabi', 'Gabi', 'Hugo', 'Iara', 'Joao', 'Kelly', 'Lia'];
const FILTRO: Filtro = filtroSchema.parse({ caixa: 3, atributos: { etapa: ['Perdido'] } });

function depsDoPublico(conversas: unknown[], o: Partial<DepsDoPublico> = {}): DepsDoPublico & { chamadas: { sair: number[]; franquia: number[]; paginas: number } } {
  const chamadas = { sair: [] as number[], franquia: [] as number[], paginas: 0 };
  return {
    chamadas,
    pagina: async (_caixa, p) => (chamadas.paginas++, conversas.slice((p - 1) * 25, p * 25)),
    ultimaPublica: async () => null,
    pediuSair: async (c) => (chamadas.sair.push(c.id), null),
    recentes: async () => new Set(),
    franquia: async (_e, c) => (chamadas.franquia.push(c.id), 'livre'),
    agora: () => AGORA,
    ...o,
  };
}

// ── o filtro ────────────────────────────────────────────────────────────────────────────────────────────────────

test('filtro: etiquetas (qualquer/todas/excluir) e atributos da conversa; atributos diferentes se somam', () => {
  const c = (o: Record<string, unknown>) => conversaDoPublico(cru(1, o))!;
  const f = (x: Record<string, unknown>) => filtroSchema.parse({ caixa: 3, ...x });
  const a = c({ labels: ['lead-frio', 'Anuncio'], custom_attributes: { etapa: 'Perdido', funil: 'Comercial' } });
  assert.equal(passaNoFiltro(a, f({ etiquetasIncluir: ['lead-frio', 'outra'] }), AGORA.getTime()), true, 'qualquer uma basta');
  assert.equal(passaNoFiltro(a, f({ etiquetasIncluir: ['lead-frio', 'outra'], todasAsEtiquetas: true }), AGORA.getTime()), false, 'todas: falta uma');
  assert.equal(passaNoFiltro(a, f({ etiquetasIncluir: ['ANUNCIO'] }), AGORA.getTime()), true, 'etiqueta sem diferença de caixa');
  assert.equal(passaNoFiltro(a, f({ etiquetasExcluir: ['anuncio'] }), AGORA.getTime()), false);
  assert.equal(passaNoFiltro(a, f({ atributos: { etapa: ['Frio', 'perdido'] } }), AGORA.getTime()), true);
  assert.equal(passaNoFiltro(a, f({ atributos: { etapa: ['Perdido'], funil: ['Tratamento'] } }), AGORA.getTime()), false, 'os dois atributos precisam bater');
  assert.equal(passaNoFiltro(a, f({ atributos: { situacao_consulta: ['Agendado'] } }), AGORA.getTime()), false, 'atributo que a conversa não tem não passa');
});

test('filtro: «sem interação há X dias» conta a última mensagem PÚBLICA — a nota privada (inclusive a do seco da régua) não é interação', () => {
  const f = filtroSchema.parse({ caixa: 3, semInteracaoDias: 30 });
  const antiga = conversaDoPublico(cru(1))!; // última mensagem pública há 40 dias
  assert.equal(passaNoFiltro(antiga, f, AGORA.getTime()), true);
  const recente = conversaDoPublico(cru(2, { last_non_activity_message: { message_type: 0, private: false, created_at: SEG(dias(2)) } }))!;
  assert.equal(passaNoFiltro(recente, f, AGORA.getTime()), false);
  // a última da listagem é uma nota de ontem: só a atividade diz «ontem»; a mensagem pública achada por fora (há 40 dias) é a que vale
  const comNota = conversaDoPublico(cru(3, { last_activity_at: SEG(dias(1)), last_non_activity_message: { message_type: 1, private: true, created_at: SEG(dias(1)) } }))!;
  assert.equal(passaNoFiltro(comNota, f, AGORA.getTime()), false, 'sem a leitura por fora, vale a atividade (lado seguro: não entra)');
  assert.equal(passaNoFiltro(comNota, f, AGORA.getTime(), dias(40)), true, 'com a mensagem pública achada por fora, entra');
});

test('filtro: o esquema recusa caixa torta, atributo com nome torto e excesso; e o resumo não leva telefone nem nome', () => {
  assert.equal(filtroSchema.safeParse({ caixa: 0 }).success, false);
  assert.equal(filtroSchema.safeParse({ caixa: 3, atributos: { 'Etapa; DROP': ['x'] } }).success, false);
  assert.equal(filtroSchema.safeParse({ caixa: 3, atributos: { etapa: [] } }).success, false);
  assert.equal(filtroSchema.safeParse({ caixa: 3, semInteracaoDias: -1 }).success, false);
  assert.equal(filtroSchema.safeParse({ caixa: 3, etiquetasIncluir: Array.from({ length: 21 }, (_, i) => `e${i}`) }).success, false);
  const r = resumoDoFiltro(filtroSchema.parse({ caixa: 3, etiquetasIncluir: ['lead-frio'], atributos: { etapa: ['Perdido', 'Frio'] }, semInteracaoDias: 30 }));
  assert.match(r, /lead-frio/);
  assert.match(r, /etapa = Perdido ou Frio/);
  assert.match(r, /30\+ dias/);
});

// ── o público e as exclusões automáticas ────────────────────────────────────────────────────────────────────────

test('público: cada exclusão automática sai com o seu motivo, e a contagem fecha', async () => {
  const lista = [
    cru(1), // elegível
    cru(2, { labels: ['sem-follow-up'] }),
    cru(3, {}, { custom_attributes: { interno: true } }),
    cru(4), // pediu SAIR
    cru(5), // consulta marcada na franquia
    cru(6, {}, { phone_number: '+55949100' }), // telefone que não é celular com DDD
    cru(7, {}, { name: '123' }), // nome que não serve para saudação
    cru(8, {}, { phone_number: fone(1) }), // mesmo telefone da 1, conversa MAIS ANTIGA
    cru(9), // recebeu outro disparo há pouco
    cru(10, { meta: { sender: { id: 1010, identifier: '1203@g.us', name: 'Grupo', phone_number: fone(10) } } }), // grupo
    cru(11, { labels: ['historico'], custom_attributes: { etapa: 'Fechou' } }), // fora do filtro (etapa)
    cru(12, { inbox_id: 6 }), // outra caixa: nem é lida
  ];
  lista[7]!.last_activity_at = SEG(dias(80)); // a 8 é a conversa velha do telefone da 1
  const d = depsDoPublico(lista, {
    pediuSair: async (c) => (c.id === 4 ? dias(3) : null),
    franquia: async (_e, c) => (c.id === 5 ? 'consulta-futura' : 'livre'),
    recentes: async () => new Set([chaveDaPessoa(fone(9).slice(1))]), // a chave da conversa 9 (DDD + 8 últimos dígitos)
  });
  const r = await calcularPublico(FILTRO, d, { completo: true });
  assert.deepEqual(r.elegiveis.map((e) => e.conversaId), [1], 'só a conversa 1 sobra');
  assert.equal(r.elegiveis[0]!.contatoId, 1001);
  assert.equal(r.elegiveis[0]!.nome, 'Ana', 'o primeiro nome vem validado');
  assert.deepEqual(r.fora, {
    'nao-e-paciente': 1,
    'sem-follow-up': 1,
    interno: 1,
    'pediu-sair': 1,
    'consulta-futura': 1,
    'telefone-invalido': 1,
    'nome-invalido': 1,
    'outra-conversa': 1,
    'recebeu-disparo-recente': 1,
  });
  assert.equal(r.lidas, 11, '11 conversas da caixa 3 (a da caixa 6 não é lida)');
  assert.equal(r.noFiltro, 9, 'passaram no filtro: 1..9 (o grupo não vira conversa; a 11 tem outra etapa)');
  assert.equal(r.truncada, false);
  assert.equal(r.parcial, false);
});

test('público: a contagem rápida (completo:false) NÃO lê mensagens nem a franquia, e diz que é parcial', async () => {
  const d = depsDoPublico([cru(1), cru(2), cru(3)]);
  const r = await calcularPublico(FILTRO, d, { completo: false });
  assert.equal(r.elegiveis.length, 3);
  assert.equal(r.parcial, true);
  assert.deepEqual(d.chamadas.sair, [], 'nenhuma leitura de SAIR na contagem rápida');
  assert.deepEqual(d.chamadas.franquia, [], 'nenhuma consulta à franquia na contagem rápida');
});

test('público: leitura de SAIR que FALHA não vira «não pediu» — a pessoa fica de fora (na dúvida, não manda)', async () => {
  const d = depsDoPublico([cru(1), cru(2)], {
    pediuSair: async (c) => {
      if (c.id === 2) throw new Error('CRM fora do ar');
      return null;
    },
  });
  const r = await calcularPublico(FILTRO, d, { completo: true });
  assert.deepEqual(r.elegiveis.map((e) => e.conversaId), [1]);
  assert.equal(r.fora['sair-indisponivel'], 1);
});

test('público: franquia indisponível não manda (a mesma regra do motor); unidade sem agenda usa a etapa do CRM', async () => {
  const d = depsDoPublico([cru(1), cru(2)], { franquia: async (_e, c) => (c.id === 2 ? 'indisponivel' : 'livre') });
  const r = await calcularPublico(FILTRO, d, { completo: true });
  assert.deepEqual(r.elegiveis.map((e) => e.conversaId), [1]);
  assert.equal(r.fora['franquia-indisponivel'], 1);
  assert.equal(situacaoPeloCrm({ etapa: 'Agendado' }), 'consulta-futura');
  assert.equal(situacaoPeloCrm({ etapa: 'Perdido', etapa_tratamento: 'Em tratamento' }), 'tratamento-aberto');
  assert.equal(situacaoPeloCrm({ etapa: 'Fechou' }), 'ja-cliente');
  assert.equal(situacaoPeloCrm({ etapa: 'Perdido', etapa_tratamento: 'Alta', funil: 'Tratamento' }), 'livre', 'alta não é tratamento aberto');
  assert.equal(situacaoPeloCrm({ etapa: 'Perdido' }), 'livre');
});

test('público: a leitura que chega ao teto de páginas vem marcada como truncada', async () => {
  const sempre = Array.from({ length: 25 }, (_, i) => cru(i + 1));
  let n = 0;
  const d = depsDoPublico([], { pagina: async () => sempre.map((c) => ({ ...c, id: ++n })) });
  const r = await calcularPublico(FILTRO, d, { completo: false });
  assert.equal(r.truncada, true);
});

// ── a caixa e os modelos ────────────────────────────────────────────────────────────────────────────────────────

const ctxCom = (corpos: Record<string, unknown>, enviados: string[] = []) =>
  criarContextoChatwoot(
    { url: 'https://crm.exemplo.test', conta: 1, token: 'tk-secreto' },
    {
      fetch: (async (url: string, o: { method?: string; body?: string }) => {
        const caminho = new URL(String(url)).pathname.replace('/api/v1/accounts/1/', '');
        enviados.push(`${o.method ?? 'GET'} ${caminho} ${o.body ?? ''}`.trim());
        const corpo = corpos[caminho];
        return { ok: corpo !== undefined, status: corpo !== undefined ? 200 : 404, text: async () => JSON.stringify(corpo ?? { error: 'x' }) } as Response;
      }) as unknown as typeof fetch,
    },
  );

test('caixa: só Channel::Whatsapp serve — o canal de API registrado como «cloud» (Clínica Demonstração) é recusado', async () => {
  const ctx = ctxCom({ inboxes: { payload: [{ id: 3, name: 'WhatsApp', channel_type: 'Channel::Whatsapp', provider: 'whatsapp_cloud' }, { id: 6, name: 'API', channel_type: 'Channel::Api' }] } });
  assert.deepEqual(await caixaWhatsappOficial(ctx, 3), { ok: true, nome: 'WhatsApp', provedor: 'whatsapp_cloud' });
  const api = await caixaWhatsappOficial(ctx, 6);
  assert.equal(api.ok, false);
  assert.match((api as { motivo: string }).motivo, /Channel::Api/);
  assert.equal((await caixaWhatsappOficial(ctx, 99)).ok, false, 'caixa que não existe na conta');
});

test('modelos: só APROVADOS com corpo de texto e variáveis {{1}}… em ordem; mídia, nome e botão com parâmetro são marcados como não dá', () => {
  const base = { name: 'parau_reativacao', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING' };
  const corpo = (text: string, extra: unknown[] = []) => ({ ...base, components: [{ type: 'BODY', text }, ...extra] });
  assert.equal(modeloDaCaixa({ ...base, status: 'PAUSED', components: [{ type: 'BODY', text: 'Oi' }] }), null, 'não aprovado nem aparece');
  const ok = modeloDaCaixa(corpo('Oi {{1}}, aqui é a {{2}}.'))!;
  assert.equal(ok.variaveis, 2);
  assert.equal(ok.problema, null);
  assert.match(modeloDaCaixa(corpo('Oi {{nome}}'))!.problema ?? '', /nome/);
  assert.match(modeloDaCaixa(corpo('Oi {{2}}'))!.problema ?? '', /em ordem/);
  assert.match(modeloDaCaixa(corpo('Oi', [{ type: 'HEADER', format: 'IMAGE' }]))!.problema ?? '', /mídia/);
  assert.match(modeloDaCaixa(corpo('Oi', [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://x.com/{{1}}' }] }]))!.problema ?? '', /botão/);
  assert.equal(modeloDaCaixa(corpo('Oi', [{ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sair' }] }]))!.problema, null, 'resposta rápida não pede parâmetro');
});

// ── o Porto: envio pela conversa ────────────────────────────────────────────────────────────────────────────────

const UNIDADE = { id: 'u1', slug: 'doutor-hernia-parauapebas', name: 'Doutor Hérnia Parauapebas', isActive: true, spineToken: 'spine', spineTimezone: 'America/Belem' } as unknown as Unit;
const UNIDADE_SEM_AGENDA = { ...UNIDADE, spineToken: null } as unknown as Unit;
const INFO: OndaDaRodada = { caixa: 3, conta: 1, template: 'parau_reativacao', idioma: 'pt_BR', textoModelo: 'Oi {{1}}, tudo bem?', variaveis: ['primeiroNome'] };
const ONDA: OndaNoLote = { id: 'o1', campanhaId: 'c1', campanhaNome: 'Reativação', aprovadaEm: new Date(AGORA.getTime() - 3_600_000), aprovadaModo: 'ligado', template: INFO.template, idioma: INFO.idioma, textoModelo: INFO.textoModelo, variaveis: INFO.variaveis, cabecalho: null };

function destino(n: number): Destino {
  return { id: `d${n}`, ondaId: 'o1', campanhaId: 'c1', unitId: 'u1', telefone: fone(n).slice(1), chave: chaveDaPessoa(fone(n).slice(1)), nome: `Pessoa${n}`, nomeCompleto: `Pessoa${n} Silva`, kommoLeadId: null, conversaChatwoot: 100 + n, contatoChatwoot: 1000 + n };
}

/** O Porto do Kommo, de mentira, que só guarda o que o motor grava e conta a fila. */
function baseFalso(opcoes: { quantos?: number; sairam?: number; naHora?: number; noDia?: number; teste?: string[] | null; agora?: Date } = {}) {
  const todos = Array.from({ length: opcoes.quantos ?? 3 }, (_, i) => destino(i + 1));
  const estados = new Map<string, Omit<DadosDeGravacao, 'estado'> & { estado: string }>(todos.map((d) => [d.id, { estado: 'pendente' }]));
  const chamadas = { pausas: [] as string[], concluidas: [] as string[], avisos: [] as string[] };
  const porto: Porto = {
    agora: () => opcoes.agora ?? AGORA,
    modoDaUnidade: () => 'desligado', // o Porto do CRM tem de trocar isto
    listaDeTeste: () => (opcoes.teste ? new Set(opcoes.teste) : null),
    contarNaJanela: async (_u, desde) => (AGORA.getTime() - desde.getTime() <= 3_600_000 ? (opcoes.naHora ?? 0) : (opcoes.noDia ?? 0)),
    pendentes: async (_o, modo, limite) => todos.filter((d) => estados.get(d.id)!.estado === 'pendente' && (modo === 'ligado' || !estados.get(d.id)!.simuladoEm)).slice(0, limite),
    sobram: async () => todos.filter((d) => estados.get(d.id)!.estado === 'pendente').length,
    quantosSairam: async () => opcoes.sairam ?? 0,
    ultimosResultados: async () => [],
    ondaAprovada: async () => true,
    reivindicar: async (id) => (Object.assign(estados.get(id)!, { estado: 'enviando', enviadoEm: AGORA }), true),
    gravar: async (id, dados) => void Object.assign(estados.get(id)!, dados),
    pausarOndas: async (_u, _c, motivo) => void chamadas.pausas.push(motivo),
    pausarOnda: async (_id, motivo) => void chamadas.pausas.push(motivo),
    devolverParaAprovacao: async () => undefined,
    concluirOnda: async (id) => void chamadas.concluidas.push(id),
    pediuSair: async () => false,
    franquia: async () => 'indisponivel', // o Porto do CRM tem de trocar isto (não há cartão do Kommo)
    enviar: async () => {
      throw new Error('o envio do KOMMO nunca pode ser chamado pela origem do CRM');
    },
    espelhar: async () => {
      throw new Error('a nota no Kommo nunca pode ser escrita pela origem do CRM');
    },
    pausarNumero: async () => ({ unidades: ['x'], ondas: [] }),
    avisar: async (t) => void chamadas.avisos.push(t),
    linkDoPainel: () => 'https://kommo.painel/x',
    limiteDeTaxa: async () => 0,
    dormir: async () => undefined,
    log: () => undefined,
  };
  return { porto, estados, chamadas, todos };
}

function portoDoCrm(o: { base?: ReturnType<typeof baseFalso>; unidade?: Unit; caixaOk?: boolean; mandar?: (corpo: Record<string, unknown>, conversa: number) => unknown; saiu?: (conversa: number) => Date | null; conversa?: (id: number) => unknown; modeloOk?: { ok: boolean; motivo?: string; transitorio?: true }; recebeuDesde?: (unitId: string, chave: string, ondaId: string, desde: Date) => Promise<number> } = {}) {
  const base = o.base ?? baseFalso();
  // o Porto do CRM conta falhas e limite de taxa no banco (só as ondas dele): aqui, um banco sem histórico
  falso('disparoDestinatario', { findMany: async () => [], count: async () => 0 });
  falso('disparoLimite', { deleteMany: async () => ({ count: 0 }), upsert: async () => ({ seguidas: 1 }) });
  const enviados: Array<{ conversa: number; corpo: Record<string, unknown> }> = [];
  const unidade = o.unidade ?? UNIDADE;
  const porto = portoChatwoot({
    base: base.porto,
    unidades: new Map([['u1', unidade]]),
    ondas: new Map([['o1', INFO]]),
    ctxDaUnidade: () => criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' }),
    caixaOficial: async (_c, caixa) => (o.caixaOk === false ? { ok: false, motivo: `a caixa ${caixa} é do canal Channel::Api` } : { ok: true, nome: 'WhatsApp', provedor: 'whatsapp_cloud' }),
    conferirModelo: async () => (o.modeloOk ?? { ok: true }) as never,
    conversa: async (_c, id) => (o.conversa ? o.conversa(id) : cru(id - 100, { id }, { id: 1000 + (id - 100), phone_number: fone(id - 100) })),
    pedidoDeSaida: async (_c, conversa) => (o.saiu ? o.saiu(conversa) : null),
    mandar: async (_c, conversa, corpo) => {
      enviados.push({ conversa, corpo });
      return o.mandar ? o.mandar(corpo, conversa) : { id: 5000 + conversa };
    },
    franquiaDaUnidade: () => async () => 'livre',
    contarEnvios: (ids, desde, modo) => base.porto.contarNaJanela(ids[0]!, desde, modo),
    recebeuDesde: o.recebeuDesde ?? (async () => 0),
    agora: () => AGORA,
  });
  return { porto, base, enviados };
}

/** Liga a unidade E põe a unidade na lista de teste PRÓPRIA do CRM (`slug=*`): o que um teste de envio real precisa. */
function ligar(): void {
  process.env.CHATWOOT_DISPARO_SLUGS = UNIDADE.slug;
  process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE = `${UNIDADE.slug}=*`;
}
const sem_pausa = { ...FREIOS_PADRAO, pausaMs: 0 };
const U_LOTE = { id: 'u1', slug: UNIDADE.slug, nome: UNIDADE.name, fuso: 'America/Sao_Paulo' };

test('MODO: nasce SECO em toda unidade (sem variável nem linha no banco); só a lista do ambiente liga — e só a unidade listada', () => {
  assert.equal(modoDoDisparoNoCrm('doutor-hernia-parauapebas'), 'seco');
  assert.equal(modoDoDisparoNoCrm('clinica-demonstracao'), 'seco');
  assert.equal(modoDoDisparoNoCrm('qualquer-unidade-nova'), 'seco');
  assert.equal(modoDoDisparoNoCrm('doutor-hernia-parauapebas', { CHATWOOT_DISPARO_SLUGS: 'outra' } as never), 'seco', 'estar em OUTRA lista não liga esta');
  // o catálogo declara a automação, com modo seco e seco de fábrica
  return import('./automacoes.js').then(({ automacaoPorId }) => {
    const a = automacaoPorId('chatwoot-disparo')!;
    assert.equal(a.temSeco, true);
    assert.equal(a.quandoVazio, 'seco');
    assert.equal(a.risco, 'manda-mensagem');
    assert.equal(a.exigeSecoAntes, true);
  });
});

test('SECO: monta, decide e grava quem RECEBERIA — e NÃO manda nada (nem pelo CRM, nem pelo Kommo), nem escreve nota', async () => {
  const t = portoDoCrm();
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.equal(r.modo, 'seco');
  assert.equal(r.receberia, 3);
  assert.equal(r.mandou, 0);
  assert.deepEqual(t.enviados, [], 'POST de mensagem NUNCA em seco');
  for (const e of t.base.estados.values()) {
    assert.equal(e.estado, 'pendente');
    assert.ok(e.simuladoEm, 'o «receberia» ficou gravado');
    assert.equal(e.wamid, undefined);
  }
  assert.deepEqual(t.base.chamadas.concluidas, [], 'seco não conclui a onda');
});

test('SECO vale para o caminho NOVO: mesmo com a caixa errada ou o modelo reprovado, em seco nenhum envio é tentado', async () => {
  for (const o of [{ caixaOk: false }, { modeloOk: { ok: false, motivo: 'reprovado' } }]) {
    const t = portoDoCrm(o);
    await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
    assert.deepEqual(t.enviados, []);
  }
});

test('LIGADO sem a unidade na lista de teste (DISPARO_LISTA_DE_TESTE): ninguém recebe — a trava do motor vale para a origem nova', async () => {
  process.env.CHATWOOT_DISPARO_SLUGS = UNIDADE.slug; // ligada, mas SEM entrada em CHATWOOT_DISPARO_LISTA_DE_TESTE
  const t = portoDoCrm();
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.match(r.parou ?? '', /sem lista de teste/);
  assert.deepEqual(t.enviados, []);
});

test('LIGADO: manda PELA CONVERSA do CRM com template_params (modelo, idioma, variáveis), sem content_mode que reescreva, e guarda o id da mensagem', async () => {
  ligar();
  const t = portoDoCrm({ base: baseFalso({ quantos: 2 }) });
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.equal(r.modo, 'ligado');
  assert.equal(r.mandou, 2);
  assert.deepEqual(t.enviados.map((e) => e.conversa), [101, 102], 'cada um na SUA conversa');
  const primeiro = t.enviados[0]!.corpo;
  assert.equal(primeiro.content, 'Oi Pessoa1, tudo bem?', 'a mensagem que aparece na conversa é o texto final');
  assert.equal(primeiro.message_type, 'outgoing');
  assert.equal(primeiro.private, false);
  assert.deepEqual(primeiro.template_params, { name: 'parau_reativacao', language: 'pt_BR', content_mode: 'rendered', processed_params: { body: { 1: 'Pessoa1' } } });
  assert.equal(t.base.estados.get('d1')!.estado, 'enviado');
  assert.equal(t.base.estados.get('d1')!.wamid, 'cw:5101');
  assert.equal(idDaMensagem('cw:5101'), 5101);
  assert.equal(idDaMensagem('wamid.HBgM'), null);
  assert.deepEqual(t.base.chamadas.concluidas, ['o1'], 'a lista inteira enviada conclui a onda');
});

test('LIGADO: a Clínica Demonstração (canal API registrado como «cloud») NUNCA recebe um envio — descartado com o motivo, e `enviar` direto também recusa', async () => {
  ligar();
  const t = portoDoCrm({ caixaOk: false, base: baseFalso({ quantos: 2 }) });
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.equal(r.mandou, 0);
  assert.deepEqual(t.enviados, []);
  assert.equal(t.base.estados.get('d1')!.estado, 'descartado');
  assert.match(t.base.estados.get('d1')!.motivo ?? '', /Channel::Api/);
  // quem chamasse `enviar` sem passar pela reconferência também é barrado
  const direto = await t.porto.enviar(ONDA, destino(1), ['Pessoa1']);
  assert.equal(direto.ok, false);
  assert.equal(direto.incerto, false);
  assert.deepEqual(t.enviados, []);
});

test('LIGADO: quem escreveu SAIR no CRM (na conversa ou em outra do contato) é barrado como «saiu» e não recebe', async () => {
  ligar();
  const t = portoDoCrm({ base: baseFalso({ quantos: 3 }), saiu: (conversa) => (conversa === 102 ? dias(2) : null) });
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.equal(r.saiu, 1);
  assert.equal(r.mandou, 2);
  assert.deepEqual(t.enviados.map((e) => e.conversa), [101, 103]);
  assert.equal(t.base.estados.get('d2')!.estado, 'saiu');
});

test('LIGADO: parada por SAIR é a do motor — passou de 3 SAIR, a campanha para e ninguém mais recebe', async () => {
  ligar();
  const t = portoDoCrm({ base: baseFalso({ quantos: 3, sairam: 4 }) });
  const pausas: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  falso('disparoOnda', { updateMany: async (a: (typeof pausas)[number]) => (pausas.push(a), { count: 1 }) });
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.equal(r.parou, 'parada por SAIR');
  assert.deepEqual(t.enviados, []);
  assert.equal(pausas.length, 1, 'a pausa vale só para as ondas do CRM da unidade');
  assert.equal(pausas[0]!.where.origem, 'chatwoot');
  assert.equal(pausas[0]!.data.pausaCausa, 'sair');
  assert.equal(t.base.chamadas.avisos.length, 1, 'e o João é avisado (Telegram)');
});

test('LIGADO: leitura do CRM que falha (SAIR/conversa) ADIA a pessoa — não manda e não descarta', async () => {
  ligar();
  const t = portoDoCrm({
    base: baseFalso({ quantos: 1 }),
    conversa: () => {
      throw Object.assign(new Error('Chatwoot 500'), { status: 500 });
    },
  });
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.equal(r.adiados, 1);
  assert.deepEqual(t.enviados, []);
  assert.equal(t.base.estados.get('d1')!.estado, 'pendente');
  assert.match(t.base.estados.get('d1')!.motivo ?? '', /^adiado/);
});

test('reconferir: conversa apagada, telefone que mudou, sem-follow-up e interno viram descarte com o motivo; unidade sem agenda usa a etapa do CRM', async () => {
  const caso = async (conversa: (id: number) => unknown, unidade?: Unit) => {
    const t = portoDoCrm({ conversa, unidade });
    return t.porto.reconferir!(destino(1));
  };
  const bom = (extra: Record<string, unknown> = {}, sender: Record<string, unknown> = {}) => cru(1, { id: 101, ...extra }, { phone_number: fone(1), ...sender });
  assert.equal(await caso(() => bom()), null, 'a conversa de sempre passa');
  const apagada = await caso(() => {
    throw Object.assign(new Error('x'), { status: 404 });
  });
  assert.equal(apagada?.tipo, 'barrou');
  assert.match((apagada as { motivo: string }).motivo, /não existe mais/);
  assert.match(((await caso(() => bom({}, { phone_number: fone(77) }))) as { motivo: string }).motivo, /telefone/);
  assert.match(((await caso(() => bom({ labels: ['sem-follow-up'] }))) as { motivo: string }).motivo, /sem-follow-up/);
  assert.match(((await caso(() => bom({}, { custom_attributes: { interno: true } }))) as { motivo: string }).motivo, /interno/);
  assert.match(((await caso(() => bom({ inbox_id: 9 }))) as { motivo: string }).motivo, /saiu da caixa/);
  assert.equal(await caso(() => bom({ custom_attributes: { etapa: 'Agendado' } }), UNIDADE), null, 'com agenda da franquia a etapa não decide (a franquia decide)');
  assert.match(((await caso(() => bom({ custom_attributes: { etapa: 'Agendado' } }), UNIDADE_SEM_AGENDA)) as { motivo: string }).motivo, /paciente pela etapa/);
});

test('reconferir: conta da onda diferente da conta da unidade, ou caixa de OUTRA unidade, são descartadas antes de qualquer leitura', async () => {
  const outra = portoChatwoot({
    base: baseFalso().porto,
    unidades: new Map([['u1', UNIDADE]]),
    ondas: new Map([['o1', { ...INFO, conta: 2 }]]),
    ctxDaUnidade: () => criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' }),
    conversa: async () => {
      throw new Error('não podia ler');
    },
  });
  assert.match(((await outra.reconferir!(destino(1))) as { motivo: string }).motivo, /conta do CRM/);
  const caixaAlheia = portoChatwoot({
    base: baseFalso().porto,
    unidades: new Map([['u1', UNIDADE]]),
    ondas: new Map([['o1', { ...INFO, caixa: 20 }]]),
    ctxDaUnidade: () => criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' }),
  });
  assert.match(((await caixaAlheia.reconferir!(destino(1))) as { motivo: string }).motivo, /não é desta unidade/);
});

test('reconferir: modelo que a Meta/CRM reprovou depois da aprovação PAUSA a onda (sem retomada) e adia; falha só de leitura NÃO pausa', async () => {
  const t = portoDoCrm({ modeloOk: { ok: false, motivo: 'o modelo parau_reativacao (pt_BR) não está aprovado nesta caixa' } });
  const v = await t.porto.reconferir!(destino(1));
  assert.equal(v?.tipo, 'adiar');
  assert.equal(t.base.chamadas.pausas.length, 1);
  const leitura = portoDoCrm({ modeloOk: { ok: false, motivo: 'não consegui ler', transitorio: true } });
  assert.equal((await leitura.porto.reconferir!(destino(1)))?.tipo, 'adiar');
  assert.equal(leitura.base.chamadas.pausas.length, 0, 'não conseguir ler o CRM não é defeito do modelo');
});

test('enviar: 4xx do CRM = recusa definitiva; sem resposta/5xx/sem id = INCERTO (nunca reenvia sozinho); 429 = limite de taxa', async () => {
  const com = (erro: unknown) => portoDoCrm({
    mandar: () => {
      if (erro instanceof Error) throw erro;
      return erro;
    },
  });
  const quatro = await com(Object.assign(new Error('Chatwoot 422'), { status: 422 })).porto.enviar(ONDA, destino(1), ['Ana']);
  assert.deepEqual([quatro.ok, quatro.incerto, quatro.limiteDeTaxa], [false, false, undefined]);
  const cinco = await com(Object.assign(new Error('Chatwoot 502'), { status: 502 })).porto.enviar(ONDA, destino(1), ['Ana']);
  assert.deepEqual([cinco.ok, cinco.incerto], [false, true]);
  const tempo = await com(new Error('timeout')).porto.enviar(ONDA, destino(1), ['Ana']);
  assert.equal(tempo.incerto, true);
  const semId = await com({ ok: true }).porto.enviar(ONDA, destino(1), ['Ana']);
  assert.deepEqual([semId.ok, semId.incerto], [false, true]);
  const taxa = await com(Object.assign(new Error('Chatwoot 429'), { status: 429 })).porto.enviar(ONDA, destino(1), ['Ana']);
  assert.equal(taxa.limiteDeTaxa, true);
  const ok = await com({ id: 77 }).porto.enviar(ONDA, destino(1), ['Ana']);
  assert.deepEqual([ok.ok, ok.wamid], [true, 'cw:77']);
});

test('o Porto do CRM NÃO escreve nota no Kommo, não aponta para o painel do Kommo e franquia só vale com agenda', async () => {
  const t = portoDoCrm();
  await t.porto.espelhar(destino(1), 'texto'); // o `espelhar` do Kommo (que lançaria no falso) NÃO é chamado
  assert.equal(t.porto.linkDoPainel('o1'), null);
  assert.equal(await t.porto.franquia(destino(1)), 'livre', 'com franquia: a conferência (falsa) devolve livre');
  assert.equal(await portoDoCrm({ unidade: UNIDADE_SEM_AGENDA }).porto.franquia(destino(1)), 'livre', 'sem agenda: a etapa do CRM já foi conferida em `reconferir`');
});

// ── os freios do motor, com o teto do número ────────────────────────────────────────────────────────────────────

test('TIER: o teto por hora e por 24 h nunca passa do TIER do número; sem TIER ou TIER_UNLIMITED valem só os freios do motor', () => {
  assert.equal(tetoDoTier('TIER_250'), 250);
  assert.equal(tetoDoTier('TIER_1K'), 1000);
  assert.equal(tetoDoTier('TIER_10K'), 10_000);
  assert.equal(tetoDoTier('TIER_UNLIMITED'), null);
  assert.equal(tetoDoTier('lixo'), null);
  assert.equal(tetoDoTier(null), null);
  const f = { ...FREIOS_PADRAO, tetoPorDia: 400, tetoPorHora: 300 };
  assert.deepEqual([freiosComOTier(f, 'TIER_250').tetoPorDia, freiosComOTier(f, 'TIER_250').tetoPorHora], [250, 250]);
  assert.deepEqual([freiosComOTier(FREIOS_PADRAO, 'TIER_250').tetoPorDia, freiosComOTier(FREIOS_PADRAO, 'TIER_250').tetoPorHora], [100, 30], 'o teto do motor, mais baixo, continua valendo');
  assert.equal(freiosComOTier(f, null), f);
});

test('teto: conta SÓ o que saiu pela origem do CRM, nas unidades que dividem o MESMO número do Kapso (o do Kommo é outro número)', async () => {
  const wheres: Array<Record<string, unknown>> = [];
  falso('unitChatwoot', {
    findUnique: async () => ({ kapsoPhoneNumberId: '1212' }),
    findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }],
  });
  falso('disparoDestinatario', { count: async (a: { where: Record<string, unknown> }) => (wheres.push(a.where), 7) });
  const porto = portoChatwoot({ base: baseFalso().porto, unidades: new Map(), ondas: new Map() });
  assert.equal(await porto.contarNaJanela('u1', AGORA, 'ligado'), 7);
  assert.deepEqual(wheres[0]!.unitId, { in: ['u1', 'u2'] });
  assert.deepEqual(wheres[0]!.onda, { origem: 'chatwoot' });
  assert.ok('enviadoEm' in wheres[0]!, 'ligado conta o envio');
  await porto.contarNaJanela('u1', AGORA, 'seco');
  assert.ok('simuladoEm' in wheres[1]!, 'seco conta o «receberia»');
});

test('LIGADO: o teto por 24 h para a onda (o motor reconta antes de cada envio); fora da janela de horário não sai nada', async () => {
  ligar();
  const cheio = portoDoCrm({ base: baseFalso({ quantos: 3, noDia: 100 }) });
  const r = await rodarUnidade(cheio.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.match(r.parou ?? '', /teto atingido/);
  assert.deepEqual(cheio.enviados, []);
  const noite = portoDoCrm({ base: baseFalso({ quantos: 3, agora: new Date(Date.UTC(2026, 9, 21, 6, 0)) }) });
  const r2 = await rodarUnidade(noite.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.match(r2.parou ?? '', /fora da janela/);
  assert.deepEqual(noite.enviados, []);
  const sabado = portoDoCrm({ base: baseFalso({ quantos: 3, agora: new Date(Date.UTC(2026, 9, 24, 14, 0)) }) });
  assert.equal((await rodarUnidade(sabado.porto, sem_pausa, U_LOTE, [ONDA])).parou, 'sábado');
});

// ── quem aprova ─────────────────────────────────────────────────────────────────────────────────────────────────

test('APROVAÇÃO: por padrão só administrador da Doutor Digital; a administradora da clínica só com o ajuste ligado; agente nunca', () => {
  process.env.KIT_ADMINS_DD = 'suzanne.mychelly1@gmail.com, doutordigitalconsultoria@gmail.com';
  const desligado = { gerenteAprova: false, tierDoNumero: null };
  const ligado = { gerenteAprova: true, tierDoNumero: null };
  assert.deepEqual(administradoresDD(), ['suzanne.mychelly1@gmail.com', 'doutordigitalconsultoria@gmail.com']);
  assert.deepEqual(quemAprova({ email: 'Suzanne.Mychelly1@gmail.com', papel: 'administrator' }, desligado), { ok: true, como: 'administrador-dd' });
  assert.deepEqual(quemAprova({ email: 'doutordigitalconsultoria@gmail.com', papel: 'agent' }, desligado), { ok: true, como: 'administrador-dd' });
  assert.equal(quemAprova({ email: 'gerente@clinica.com', papel: 'administrator' }, desligado).ok, false, 'desligado de fábrica: a gerente não aprova');
  assert.deepEqual(quemAprova({ email: 'gerente@clinica.com', papel: 'administrator' }, ligado), { ok: true, como: 'administradora-da-clinica' });
  assert.equal(quemAprova({ email: 'atendente@clinica.com', papel: 'agent' }, ligado).ok, false, 'agente nunca aprova');
  assert.equal(quemAprova({ email: null, papel: 'administrator' }, desligado).ok, false);
  assert.equal(quemAprova({ email: 'gerente@clinica.com', papel: null }, ligado).ok, false);
});

function ondaDoCrm(extra: Record<string, unknown> = {}) {
  const pessoas = [{ chave: 'c1', nome: 'Ana' }];
  const base = { id: 'o1', campanhaId: 'c', unitId: 'u1', estado: 'montada', origem: 'chatwoot', contaChatwoot: 1, caixaChatwoot: 3, template: 'parau_reativacao', idioma: 'pt_BR', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], cabecalho: null, oferta: null, total: 1, ...extra };
  const impressao = impressaoDaOnda(definicaoDaOnda(base), pessoas);
  return { pessoas, onda: { ...base, impressao, unit: { id: 'u1', slug: UNIDADE.slug, metaPhoneNumberId: null } }, impressao };
}

test('aprovarOndaChatwoot: confere total + impressão e o modelo no CRM; grava quem aprovou e o modo da unidade (seco)', async () => {
  process.env.KIT_ADMINS_DD = 'suzanne.mychelly1@gmail.com';
  const { pessoas, onda, impressao } = ondaDoCrm();
  const gravado: Array<Record<string, unknown>> = [];
  falso('disparoOnda', { findUnique: async () => onda, updateMany: async (a: { data: Record<string, unknown> }) => (gravado.push(a.data), { count: 1 }) });
  falso('disparoDestinatario', { findMany: async () => pessoas });
  falso('disparoLimite', { deleteMany: async () => ({ count: 0 }) });
  const deps = { conferir: async () => ({ ok: true as const }), ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }), ajuste: async () => ({ gerenteAprova: false, tierDoNumero: null }) };
  const ok = await aprovarOndaChatwoot('o1', { email: 'suzanne.mychelly1@gmail.com', papel: 'administrator', total: 1, impressao }, deps);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(gravado[0]!.estado, 'aprovada');
  assert.equal(gravado[0]!.aprovadaPor, 'suzanne.mychelly1@gmail.com');
  assert.equal(gravado[0]!.aprovadaModo, 'seco', 'aprovada com a unidade em seco: o motor devolve para nova aprovação ao ligar');
  gravado.length = 0;
  const gerente = await aprovarOndaChatwoot('o1', { email: 'gerente@clinica.com', papel: 'administrator', total: 1, impressao }, deps);
  assert.deepEqual([gerente.ok, (gerente as { status: number }).status], [false, 403]);
  const total = await aprovarOndaChatwoot('o1', { email: 'suzanne.mychelly1@gmail.com', papel: 'administrator', total: 2, impressao }, deps);
  assert.deepEqual([total.ok, (total as { status: number }).status], [false, 409], 'total diferente do que a tela mostrou');
  const texto = await aprovarOndaChatwoot('o1', { email: 'suzanne.mychelly1@gmail.com', papel: 'administrator', total: 1, impressao: 'outra' }, deps);
  assert.deepEqual([texto.ok, (texto as { status: number }).status], [false, 409], 'impressão diferente');
  const modelo = await aprovarOndaChatwoot('o1', { email: 'suzanne.mychelly1@gmail.com', papel: 'administrator', total: 1, impressao }, { ...deps, conferir: async () => ({ ok: false as const, motivo: 'reprovado' }) });
  assert.deepEqual([modelo.ok, (modelo as { status: number }).status], [false, 422]);
  const outraConta = await aprovarOndaChatwoot('o1', { email: 'suzanne.mychelly1@gmail.com', papel: 'administrator', total: 1, impressao }, { ...deps, ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 2, token: 't' }) });
  assert.deepEqual([outraConta.ok, (outraConta as { status: number }).status], [false, 422], 'a conta do CRM da unidade tem de ser a do disparo');
  assert.equal(gravado.length, 0, 'recusa nenhuma gravou aprovação');
  // unidade DESLIGADA não aprova (a aprovação ficaria registrada sem valer nada): ligue, ou deixe em seco, antes
  const { _semearParaTeste } = await import('./automacoes-estado.js');
  _semearParaTeste([{ slug: UNIDADE.slug, automacao: 'chatwoot-disparo', estado: 'desligado' }]);
  const desligada = await aprovarOndaChatwoot('o1', { email: 'suzanne.mychelly1@gmail.com', papel: 'administrator', total: 1, impressao }, deps);
  _semearParaTeste([]);
  assert.deepEqual([desligada.ok, (desligada as { status: number }).status], [false, 422]);
  assert.match((desligada as { erro: string }).erro, /DESLIGADOS/);
  assert.equal(gravado.length, 0);
});

test('aprovarOndaChatwoot: onda do Kommo não se aprova por aqui; e a rota do console (aprovarOnda) não aprova onda do CRM', async () => {
  process.env.DISPARO_APROVADORES = 'joao@x.com';
  const kommo = ondaDoCrm({ origem: 'kommo' });
  falso('disparoOnda', { findUnique: async () => kommo.onda, updateMany: async () => ({ count: 1 }) });
  const r1 = await aprovarOndaChatwoot('o1', { email: 'suzanne.mychelly1@gmail.com', papel: 'administrator', total: 1, impressao: kommo.impressao });
  assert.deepEqual([r1.ok, (r1 as { status: number }).status], [false, 404]);
  const crm = ondaDoCrm();
  falso('disparoOnda', { findUnique: async () => crm.onda, updateMany: async () => ({ count: 1 }) });
  falso('disparoDestinatario', { findMany: async () => crm.pessoas });
  const r2 = await aprovarOnda('o1', { por: 'joao@x.com', total: 1, impressao: crm.impressao }, async () => ({ ok: true }));
  assert.deepEqual([r2.ok, (r2 as { status: number }).status], [false, 409]);
  assert.match((r2 as { erro: string }).erro, /CRM/);
  delete process.env.DISPARO_APROVADORES;
});

test('a rodada do Kommo ignora as ondas do CRM (cada origem tem o seu Porto)', async () => {
  const { rodadaDoDisparo } = await import('./disparo-worker.js');
  const filtros: unknown[] = [];
  falso('disparoDestinatario', { updateMany: async () => ({ count: 0 }), findMany: async () => [] });
  falso('disparoOnda', {
    updateMany: async () => ({ count: 0 }),
    findMany: async (a: { where: unknown }) => (filtros.push(a.where), []),
  });
  await rodadaDoDisparo();
  assert.ok(filtros.some((w) => (w as { origem?: string }).origem === 'kommo'), 'a busca das ondas aprovadas filtra origem = kommo');
});

test('texto da prévia: o mesmo `textoFinal` do motor, com o primeiro nome de cada pessoa', () => {
  assert.equal(textoFinal('Oi {{1}}, aqui é a {{2}}.', ['Ana', 'Clínica']), 'Oi Ana, aqui é a Clínica.');
});

// ── cada origem conta, pausa e zera só o que é dela ─────────────────────────────────────────────────────────────

test('ISOLAMENTO: limite de taxa, falhas, pausa por número e teto do CRM só tocam as ondas do CRM (chave «crm:»); o Kommo só as dele', async () => {
  const consultas: Array<{ modelo: string; metodo: string; arg: any }> = [];
  const registra = (modelo: string, metodo: string, volta: unknown) => async (arg: unknown) => (consultas.push({ modelo, metodo, arg }), volta);
  falso('disparoDestinatario', { findMany: registra('dest', 'findMany', [{ estado: 'enviado' }, { estado: 'falhou' }]), count: registra('dest', 'count', 0) });
  falso('disparoOnda', { findMany: registra('onda', 'findMany', [{ id: 'oa' }]), updateMany: registra('onda', 'updateMany', { count: 1 }) });
  falso('disparoLimite', { deleteMany: registra('limite', 'deleteMany', { count: 1 }), upsert: registra('limite', 'upsert', { seguidas: 3 }) });
  falso('unitChatwoot', { findUnique: async () => ({ kapsoPhoneNumberId: '1212' }), findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }] });
  falso('unit', { findMany: registra('unit', 'findMany', [{ slug: 'b' }, { slug: 'a' }]) });
  const porto = portoChatwoot({ base: baseFalso().porto, unidades: new Map(), ondas: new Map() });

  assert.deepEqual(await porto.ultimosResultados('u1', 5, AGORA), ['enviado', 'falhou']);
  assert.deepEqual(consultas.pop()!.arg.where.onda, { origem: 'chatwoot' });

  await porto.pausarOndas('u1', null, 'falhas', 'falhas');
  assert.equal(consultas.pop()!.arg.where.origem, 'chatwoot');

  assert.equal(await porto.limiteDeTaxa('u1', true), 3);
  assert.equal(consultas.pop()!.arg.where.unitId, 'crm:u1', 'o contador do CRM tem chave própria (o do Kommo é o número da Graph API)');
  await porto.limiteDeTaxa('u1', false);
  assert.equal(consultas.pop()!.arg.where.unitId, 'crm:u1');

  consultas.length = 0;
  const pausa = await porto.pausarNumero('u1', 'restrito', 'meta');
  assert.deepEqual(pausa, { unidades: ['a', 'b'], ondas: ['oa'] });
  assert.equal(consultas.find((c) => c.modelo === 'onda' && c.metodo === 'findMany')!.arg.where.origem, 'chatwoot');
  assert.equal(consultas.find((c) => c.modelo === 'limite')!.arg.where.unitId, 'crm:u1');

  // o lado do Kommo: o teto, as falhas e as pausas dele ignoram o CRM
  consultas.length = 0;
  const { portoReal } = await import('./disparo/porto.js');
  const kommo = portoReal(new Map([['u1', { id: 'u1', slug: 'u', metaPhoneNumberId: null } as unknown as Unit]]));
  await kommo.contarNaJanela('u1', AGORA, 'ligado');
  assert.deepEqual(consultas.find((c) => c.modelo === 'dest' && c.metodo === 'count')!.arg.where.onda, { origem: 'kommo' });
  await kommo.ultimosResultados('u1', 5, AGORA);
  assert.deepEqual(consultas.filter((c) => c.metodo === 'findMany' && c.modelo === 'dest').pop()!.arg.where.onda, { origem: 'kommo' });
  await kommo.pausarOndas('u1', null, 'x', 'falhas');
  assert.equal(consultas.filter((c) => c.metodo === 'updateMany').pop()!.arg.where.origem, 'kommo');
});

// ── a varredura depois do envio ─────────────────────────────────────────────────────────────────────────────────

test('varredura: quem escreveu SAIR depois do envio vira «saiu»; mensagem que o CRM marcou como falha vira «falhou»; 131048 pede pausa do número', async () => {
  const enviadoEm = new Date(AGORA.getTime() - 3_600_000);
  const linha = (id: string, conversa: number, wamid: string | null, estado = 'enviado') => ({ id, estado, wamid, conversaChatwoot: conversa, enviadoEm, onda: { contaChatwoot: 1, unit: { slug: UNIDADE.slug } } });
  const atualizacoes: Array<{ id: string; data: Record<string, unknown> }> = [];
  falso('disparoDestinatario', {
    findMany: async () => [linha('a', 201, 'cw:9001'), linha('b', 202, 'cw:9002'), linha('c', 203, 'cw:9003'), linha('d', 204, 'cw:9004'), linha('e', 205, 'cw:9005', 'falhou')],
    updateMany: async (a: { where: { id: string }; data: Record<string, unknown> }) => (atualizacoes.push({ id: a.where.id, data: a.data }), { count: 1 }),
  });
  const msg = (id: number, tipo: number, o: Record<string, unknown> = {}) => ({ id, tipo, privada: false, conteudo: '', criadaEm: new Date(AGORA.getTime() - 1_800_000), status: null, erro: null, ...o });
  const porConversa: Record<number, unknown[]> = {
    201: [msg(9001, 1, { status: 'delivered' }), msg(1, 0, { conteudo: 'SAIR' })], // pediu SAIR depois do envio
    202: [msg(9002, 1, { status: 'failed', erro: 'Meta 131048: spam' })], // falha de entrega + restrição
    203: [msg(9003, 1, { status: 'read' }), msg(2, 0, { conteudo: 'quero marcar' })], // respondeu, sem SAIR
    204: [msg(3, 0, { conteudo: 'sair', criadaEm: new Date(enviadoEm.getTime() - 86_400_000) }), msg(9004, 1, { status: 'sent' })], // SAIR ANTES do envio: não conta aqui
    205: [msg(9005, 1, { status: 'failed' })], // já está falhou: não mexe
  };
  const { varrerRespostasDoCrm } = await import('./disparo/chatwoot/rodada.js');
  const r = await varrerRespostasDoCrm({
    ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }),
    mensagens: (async (_c: unknown, conversa: number) => porConversa[conversa] ?? []) as never,
    agora: () => AGORA.getTime(),
  });
  assert.equal(r.saiu, 1);
  assert.equal(r.falhou, 1);
  assert.deepEqual(r.restritos, [UNIDADE.slug]);
  assert.equal(r.faltaram, 0);
  assert.deepEqual(atualizacoes.map((a) => [a.id, a.data.estado]).sort(), [['a', 'saiu'], ['b', 'falhou']]);
  assert.match(String(atualizacoes.find((a) => a.id === 'b')!.data.motivo), /131048/);
});

test('varredura: conta diferente da gravada na onda não lê nada; e NÃO há corte dos 150 mais novos (lê todos até o orçamento de tempo)', async () => {
  const enviadoEm = new Date(AGORA.getTime() - 3_600_000);
  const muitos = Array.from({ length: 400 }, (_, i) => ({ id: `x${i}`, estado: 'enviado', wamid: `cw:${i + 1}`, conversaChatwoot: 1000 + i, enviadoEm, onda: { contaChatwoot: 1, unit: { slug: UNIDADE.slug } } }));
  falso('disparoDestinatario', { findMany: async () => muitos, updateMany: async () => ({ count: 0 }) });
  const lidas: number[] = [];
  const { varrerRespostasDoCrm } = await import('./disparo/chatwoot/rodada.js');
  const r = await varrerRespostasDoCrm({ ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }), mensagens: (async (_c: unknown, n: number) => (lidas.push(n), [])) as never, agora: () => AGORA.getTime() });
  assert.equal(r.conferidos, 400, 'todos os 400, não só 150');
  assert.equal(lidas.length, 400);
  lidas.length = 0;
  const outra = await varrerRespostasDoCrm({ ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 2, token: 't' }), mensagens: (async (_c: unknown, n: number) => (lidas.push(n), [])) as never, agora: () => AGORA.getTime() });
  assert.deepEqual([outra.conferidos, lidas.length], [0, 0], 'conta diferente da gravada na onda: nada é lido');
});

test('rodada do CRM: onda aprovada sem caixa/conta é PAUSADA (não fica adiando gente para sempre e travando a unidade)', async () => {
  const pausadas: Array<Record<string, unknown>> = [];
  falso('disparoOnda', {
    findMany: async () => [{ id: 'lixo', unitId: 'u1', caixaChatwoot: null, contaChatwoot: null, unit: UNIDADE }],
    updateMany: async (a: { data: Record<string, unknown> }) => (pausadas.push(a.data), { count: 1 }),
  });
  falso('disparoDestinatario', { findMany: async () => [] });
  const { rodadaDoDisparoNoCrm, _zerarVarreduraDoCrm } = await import('./disparo/chatwoot/rodada.js');
  _zerarVarreduraDoCrm();
  await rodadaDoDisparoNoCrm();
  assert.equal(pausadas.length, 1);
  assert.equal(pausadas[0]!.estado, 'pausada');
});

// ── abrir e montar o disparo ────────────────────────────────────────────────────────────────────────────────────

test('abrir: caixa que não é da unidade, modelo que o CRM não confirma e variáveis em número errado são recusados sem gravar nada; só UM disparo vivo por unidade', async () => {
  const { abrirOndaChatwoot } = await import('./disparo/chatwoot/onda.js');
  const criados: Array<Record<string, unknown>> = [];
  let viva: unknown = null;
  let montando = 0;
  const tx = {
    $executeRaw: async () => 1,
    disparoOnda: { findFirst: async () => viva, count: async () => montando, create: async (a: { data: Record<string, unknown> }) => (criados.push(a.data), { id: 'onda1', ...a.data }) },
    disparoCampanha: { create: async (a: { data: Record<string, unknown> }) => ({ id: 'camp1', ...a.data }) },
  };
  falso('$transaction', (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  const ctx = criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' });
  const filtro = filtroSchema.parse({ caixa: 3, atributos: { etapa: ['Perdido'] } });
  const modelo = { nome: 'parau_reativacao', idioma: 'pt_BR', texto: 'Oi {{1}}, tudo bem?', variaveis: ['primeiroNome'] };
  const base = { unit: UNIDADE, conta: 1, filtro, modelo, nome: 'Reativação de perdidos', por: 'suzanne@x.com', ctx, conferirModelo: async () => ({ ok: true as const }) };

  assert.equal((await abrirOndaChatwoot({ ...base, filtro: filtroSchema.parse({ caixa: 4 }) })).ok, false, 'a caixa 4 é o histórico (não é cloud)');
  assert.equal((await abrirOndaChatwoot({ ...base, filtro: filtroSchema.parse({ caixa: 20 }) })).ok, false, 'caixa de outra unidade');
  assert.equal((await abrirOndaChatwoot({ ...base, modelo: { ...modelo, variaveis: [] } })).ok, false, 'o texto pede 1 variável e a campanha define 0');
  assert.equal((await abrirOndaChatwoot({ ...base, nome: 'x' })).ok, false, 'sem nome de campanha');
  const reprovado = await abrirOndaChatwoot({ ...base, conferirModelo: async () => ({ ok: false as const, motivo: 'o modelo não está aprovado nesta caixa' }) });
  assert.deepEqual([reprovado.ok, (reprovado as { status: number }).status], [false, 422]);
  const semLeitura = await abrirOndaChatwoot({ ...base, conferirModelo: async () => ({ ok: false as const, motivo: 'CRM fora', transitorio: true as const }) });
  assert.equal((semLeitura as { status: number }).status, 502, 'não conseguir ler o CRM não é culpa do modelo');
  assert.equal(criados.length, 0, 'nenhuma recusa gravou onda');

  const ok = await abrirOndaChatwoot(base);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(
    { origem: criados[0]!.origem, conta: criados[0]!.contaChatwoot, caixa: criados[0]!.caixaChatwoot, estado: criados[0]!.estado, criadaPor: criados[0]!.criadaPor, template: criados[0]!.template },
    { origem: 'chatwoot', conta: 1, caixa: 3, estado: 'montando', criadaPor: 'suzanne@x.com', template: 'parau_reativacao' },
  );
  assert.match(String(criados[0]!.etiqueta), /etapa = Perdido/, 'o filtro em palavras fica na onda');
  assert.deepEqual(criados[0]!.filtro, filtro, 'e o filtro inteiro, para auditoria');

  viva = { id: 'outra', estado: 'montada' };
  const segunda = await abrirOndaChatwoot(base);
  assert.deepEqual([segunda.ok, (segunda as { status: number }).status], [false, 409]);
});

test('montar a lista: grava cada pessoa com a SUA conversa e contato, calcula total e impressão como o painel do Kommo, e some a onda se ninguém é elegível ou se algo falha', async () => {
  const { concluirMontagemChatwoot } = await import('./disparo/chatwoot/onda.js');
  const onda = { id: 'o1', campanhaId: 'c1', unitId: 'u1', estado: 'montando', origem: 'chatwoot', etiqueta: 'CRM · etapa = Perdido', template: 'parau_reativacao', idioma: 'pt_BR', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], cabecalho: null, oferta: null, filtro: { caixa: 3 }, unit: UNIDADE };
  const lido = (n: number) => ({
    lidas: 10, truncada: false, noFiltro: 5, parcial: false, fora: { 'sem-follow-up': 2 },
    elegiveis: Array.from({ length: n }, (_, i) => ({ leadId: null, nome: NOMES[i]!, nomeCompleto: `${NOMES[i]} Silva`, telefone: fone(i + 1).slice(1), chave: chaveDaPessoa(fone(i + 1).slice(1)), conversaId: 100 + i, contatoId: 1000 + i })),
  });
  let linhas: Array<{ chave: string; nome: string }> = [];
  const gravacoes: Array<Record<string, unknown>> = [];
  const criadas: Array<Record<string, unknown>> = [];
  const montar = async (n: number | Error, estado = 'montando', origem = 'chatwoot') => {
    gravacoes.length = 0;
    criadas.length = 0;
    falso('disparoOnda', { findUnique: async () => ({ ...onda, estado, origem }), updateMany: async (a: { data: Record<string, unknown> }) => (gravacoes.push(a.data), { count: 1 }) });
    falso('disparoDestinatario', {
      createMany: async (a: { data: Array<Record<string, unknown>> }) => (criadas.push(...a.data), (linhas = a.data.map((d) => ({ chave: String(d.chave), nome: String(d.nome) }))), { count: a.data.length }),
      findMany: async () => linhas,
    });
    await concluirMontagemChatwoot('o1', async () => {
      if (n instanceof Error) throw n;
      return lido(n);
    });
  };

  await montar(3);
  assert.deepEqual(criadas.map((c) => [c.conversaChatwoot, c.contatoChatwoot, c.nome, c.kommoLeadId]), [[100, 1000, 'Ana', undefined], [101, 1001, 'Bia', undefined], [102, 1002, 'Cris', undefined]]);
  assert.equal(gravacoes[0]!.estado, 'montada');
  assert.equal(gravacoes[0]!.total, 3);
  assert.equal(gravacoes[0]!.impressao, impressaoDaOnda(definicaoDaOnda(onda), linhas), 'a impressão é a mesma que a aprovação vai recalcular');
  assert.deepEqual((gravacoes[0]!.resumo as { fora: unknown }).fora, { 'sem-follow-up': 2 });

  await montar(0);
  assert.equal(gravacoes[0]!.estado, 'cancelada');
  assert.match(String(gravacoes[0]!.pausaMotivo), /nenhuma pessoa elegível/);
  assert.deepEqual(criadas, []);

  await montar(new Error('CRM caiu no meio'));
  assert.equal(gravacoes[0]!.estado, 'cancelada');
  assert.match(String(gravacoes[0]!.pausaMotivo), /montagem falhou.*CRM caiu/);

  await montar(3, 'cancelada');
  assert.deepEqual([gravacoes.length, criadas.length], [0, 0], 'onda cancelada durante a montagem nunca volta a ser aprovável');
  await montar(3, 'montando', 'kommo');
  assert.deepEqual([gravacoes.length, criadas.length], [0, 0], 'onda do Kommo não é montada por aqui');
});

test('contagem com PRAZO: página que nunca responde não pendura — a leitura para no prazo e vem marcada como cortada (contagem parcial)', async () => {
  const d = depsDoPublico([], { pagina: async (_c, p) => (p === 1 ? Array.from({ length: 25 }, (_, i) => cru(i + 1)) : new Promise<unknown[]>(() => undefined)) });
  const t0 = Date.now();
  const r = await calcularPublico(FILTRO, d, { completo: false, prazo: Date.now() + 80 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.truncada, true);
  assert.equal(r.elegiveis.length, 25, 'o que deu para ler vale');
  const sem = await calcularPublico(FILTRO, depsDoPublico([cru(1)]), { completo: false });
  assert.equal(sem.truncada, false, 'sem prazo e lida inteira: não é parcial');
});

// ── a clínica NÃO liga o disparo; lista de teste própria; os limites do CRM são do CRM ──────────────────────────

test('a administradora da clínica NÃO liga o disparo pela tela Robôs: a automação não está na tela e mudarAutomacao recusa (404), sem gravar', async () => {
  const A = await import('./robos-automacoes.js');
  assert.ok(!('chatwoot-disparo' in A.DO_CATALOGO), 'fora da tela Robôs');
  const gravacoes: unknown[] = [];
  const banco = { unidade: async () => ({ id: 'u1', slug: UNIDADE.slug }), gravar: async (...a: unknown[]) => void gravacoes.push(a) } as never;
  for (const estado of ['ligado', 'seco', 'desligado']) {
    const r = await A.mudarAutomacao(banco, { slug: UNIDADE.slug, id: 'chatwoot-disparo', estado, confirmar: true, papel: 'administrator', por: 'Gabi Gerente', estadoAtual: () => 'seco' });
    assert.deepEqual([r.ok, (r as { status?: number }).status], [false, 404], estado);
  }
  assert.deepEqual(gravacoes, []);
  // e o estado de fábrica continua seco (a tela não tinha como mudar)
  assert.equal(modoDoDisparoNoCrm(UNIDADE.slug), 'seco');
});

test('lista de teste do CRM é PRÓPRIA: `slug=*` na DISPARO_LISTA_DE_TESTE do Kommo NÃO solta o CRM; só CHATWOOT_DISPARO_LISTA_DE_TESTE vale, por unidade', () => {
  const antes = { k: process.env.DISPARO_LISTA_DE_TESTE, c: process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE };
  try {
    process.env.DISPARO_LISTA_DE_TESTE = `${UNIDADE.slug}=*`;
    delete process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE;
    const { porto } = portoDoCrm();
    assert.equal(porto.listaDeTeste(UNIDADE.slug)?.size, 0, 'Kommo solto, CRM continua sem ninguém');
    process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE = `${UNIDADE.slug}=5594991000001,5594991000002;outra-unidade=*`;
    assert.deepEqual([...(porto.listaDeTeste(UNIDADE.slug) ?? [])].sort(), ['5594991000001', '5594991000002']);
    assert.equal(porto.listaDeTeste('clinica-demonstracao')?.size, 0, 'unidade que não aparece na lista: ninguém (a entrada «outra-unidade=*» não vale para ela)');
    process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE = `${UNIDADE.slug}=*`;
    assert.equal(porto.listaDeTeste(UNIDADE.slug), null, '`slug=*` do CRM solta só esta unidade, por decisão deliberada');
    process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE = '*';
    assert.equal(porto.listaDeTeste(UNIDADE.slug)?.size, 0, 'um `*` global (formato antigo) não vale: ninguém');
  } finally {
    if (antes.k === undefined) delete process.env.DISPARO_LISTA_DE_TESTE; else process.env.DISPARO_LISTA_DE_TESTE = antes.k;
    if (antes.c === undefined) delete process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE; else process.env.CHATWOOT_DISPARO_LISTA_DE_TESTE = antes.c;
  }
});

test('LIGADO: quem recebeu OUTRO disparo desde a montagem é barrado na hora do envio (a regra dos 7 dias vale ao mandar, não só ao montar)', async () => {
  ligar();
  const t = portoDoCrm({ base: baseFalso({ quantos: 2 }), recebeuDesde: async (_u, chave) => (chave === destino(2).chave ? 1 : 0) });
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.equal(r.mandou, 1);
  assert.deepEqual(t.enviados.map((e) => e.conversa), [101]);
  assert.equal(t.base.estados.get('d2')!.estado, 'descartado');
  assert.match(t.base.estados.get('d2')!.motivo ?? '', /outro disparo nos últimos 7 dias/);
});

test('429 do PRÓPRIO Chatwoot: a pessoa volta para a fila e a rodada acaba, mas NÃO soma «limite da Meta» (nem pausa o número, nem avisa o João disso)', async () => {
  ligar();
  const t = portoDoCrm({ base: baseFalso({ quantos: 3 }), mandar: () => { throw Object.assign(new Error('Chatwoot 429'), { status: 429 }); } });
  let somou = 0;
  falso('disparoLimite', { deleteMany: async () => ({ count: 0 }), upsert: async () => (somou++, { seguidas: 99 }) });
  const r = await rodarUnidade(t.porto, sem_pausa, U_LOTE, [ONDA]);
  assert.match(r.parou ?? '', /esperar/);
  assert.equal(somou, 0, 'o contador de rodadas com limite da Meta não anda');
  assert.deepEqual(t.base.chamadas.avisos, [], 'nenhum alerta de «a Meta pediu para esperar»');
  assert.equal(t.base.estados.get('d1')!.estado, 'pendente');
});

test('alerta de onda SEM ANDAR: 5 rodadas seguidas só com adiados avisam o João UMA vez; quem anda zera', async () => {
  const { avisarSeSemAndar, _zerarSemAndarDoCrm } = await import('./disparo/chatwoot/rodada.js');
  _zerarSemAndarDoCrm();
  const avisos: string[] = [];
  const parada = { adiados: 3, mandou: 0, receberia: 0, falhou: 0, saiu: 0, descartados: 0 };
  for (let i = 0; i < 7; i++) await avisarSeSemAndar('u', 'u1', parada, async (t) => void avisos.push(t));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /SEM ANDAR/);
  await avisarSeSemAndar('u', 'u1', { ...parada, mandou: 1 }, async (t) => void avisos.push(t)); // andou: o episódio acaba
  for (let i = 0; i < 5; i++) await avisarSeSemAndar('u', 'u1', parada, async (t) => void avisos.push(t));
  assert.equal(avisos.length, 2, 'o episódio seguinte avisa de novo');
});

test('restrição da Meta (131048) pausa as ondas do CRM de TODAS as unidades do mesmo número do Kapso', async () => {
  const { varrerSeChegouAHora, _zerarVarreduraDoCrm } = await import('./disparo/chatwoot/rodada.js');
  _zerarVarreduraDoCrm();
  const enviadoEm = new Date(AGORA.getTime() - 3_600_000);
  const pausas: Array<Record<string, unknown>> = [];
  falso('disparoDestinatario', {
    findMany: async () => [{ id: 'a', estado: 'enviado', wamid: 'cw:9001', conversaChatwoot: 1, enviadoEm, entregueEm: null, lidaEm: null, respondeuEm: null, onda: { unitId: 'u1', contaChatwoot: 1, unit: { slug: 'u-a' } } }],
    updateMany: async () => ({ count: 1 }),
  });
  falso('unitChatwoot', { findUnique: async () => ({ kapsoPhoneNumberId: '1212' }), findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }] });
  falso('disparoOnda', { updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => (pausas.push(a), { count: 2 }) });
  await varrerSeChegouAHora({
    ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }),
    mensagens: (async () => [{ id: 9001, tipo: 1, privada: false, conteudo: '', criadaEm: enviadoEm, status: 'failed', erro: 'Meta 131048: spam' }]) as never,
    agora: () => AGORA.getTime(),
  });
  const pausa = pausas.find((p) => (p.data as { estado?: string }).estado === 'pausada')!;
  assert.deepEqual((pausa.where as { unitId: unknown }).unitId, { in: ['u1', 'u2'] }, 'as duas unidades do número, não só a da mensagem');
  assert.equal((pausa.where as { origem: string }).origem, 'chatwoot');
});

test('montagens: o CRM tem o limite PRÓPRIO (2 ao mesmo tempo, somando unidades) e o conector do Kommo não conta as dele', async () => {
  const { abrirOndaChatwoot, MAX_MONTAGENS_DO_CRM } = await import('./disparo/chatwoot/onda.js');
  const tx = { $executeRaw: async () => 1, disparoOnda: { findFirst: async () => null, count: async () => MAX_MONTAGENS_DO_CRM, create: async () => { throw new Error('não podia criar'); } }, disparoCampanha: { create: async () => ({ id: 'c' }) } };
  falso('$transaction', (async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  const r = await abrirOndaChatwoot({ unit: UNIDADE, conta: 1, filtro: filtroSchema.parse({ caixa: 3 }), modelo: { nome: 'parau_reativacao', idioma: 'pt_BR', texto: 'Oi {{1}}', variaveis: ['primeiroNome'] }, nome: 'Reativação', por: 'x@y.com', ctx: criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }), conferirModelo: async () => ({ ok: true as const }) });
  assert.deepEqual([r.ok, (r as { status: number }).status], [false, 429]);
  const filtros: Array<Record<string, unknown>> = [];
  falso('disparoOnda', { count: async (a: { where: Record<string, unknown> }) => (filtros.push(a.where), 1), findMany: async (a: { where: Record<string, unknown> }) => (filtros.push(a.where), []) });
  const { fonteDeDisparo } = await import('../mcp-remoto/disparo-producao.js');
  await fonteDeDisparo.montandoAgora();
  await fonteDeDisparo.ondasRecentes();
  assert.deepEqual(filtros[0], { estado: 'montando', origem: 'kommo' });
  assert.deepEqual(filtros[1], { origem: 'kommo' });
});
