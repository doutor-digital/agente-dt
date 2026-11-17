/**
 * Retroativo do anúncio no CRM: processo NOVO lê o estado das automações da TELA antes de tudo (senão a origem ligada pela tela aparece
 * desligada e o «FEITO» mente); conversa já guardada é reaplicada (sem nota nova); o relatório diz o que cada parte fez; opções estritas.
 */
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
delete process.env.CHATWOOT_ORIGEM_SLUGS;

const { lerArgumentos, prepararEstadoDasAutomacoes, rodarRetroativo } = await import('./chatwoot-referral-retroativo.js');
const { aoAcharReferral } = await import('./chatwoot-ia.js');
const { portasDaOrigem } = await import('./chatwoot-origem.js');
const { _esquecerOBancoParaTeste, estadoDaAutomacao } = await import('./automacoes-estado.js');
const { prisma } = await import('./prisma.js');

const SLUG = 'doutor-hernia-parauapebas';
const WAMID = (n: number) => `wamid.HBgMNTU5NDkyNDg0NDk5FQIAEhggQUMzMjUx${String(n).padStart(4, '0')}`;
const REF = { anuncio: '120253955239410514', ctwaClid: 'Afd', tipo: 'ad', titulo: 'Dor?', url: null, quando: 1 };

/** Troca um delegate do Prisma por um de mentira (o delegate é um proxy: `mock.method` não alcança) e desfaz no fim de cada teste. */
const originais: Array<() => void> = [];
function trocarDelegate(nome: string, falso: Record<string, unknown>): void {
  const antes = (prisma as any)[nome]; // acessa primeiro: o Prisma cria o delegate sob demanda
  Object.defineProperty(prisma, nome, { value: falso, configurable: true, writable: true });
  originais.push(() => Object.defineProperty(prisma, nome, { value: antes, configurable: true, writable: true }));
}

// a tabela das automações nunca é a de produção: por padrão vazia (cai no .env); cada teste põe a que precisa. A releitura em segundo plano
// (30 s) não pode escapar para o banco de verdade nem ser compartilhada com o teste seguinte.
beforeEach(() => {
  _esquecerOBancoParaTeste();
  trocarDelegate('unitAutomacao', { findMany: async () => [] });
});
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  while (originais.length) originais.pop()!();
  _esquecerOBancoParaTeste();
});

/** O estado da conta de mentira: a origem usa o `estado()` REAL (o que lê o mapa das automações); o resto só registra. */
function estado() {
  const f = { etiquetas: [] as string[][], notas: [] as number[], origem: [] as Array<[number, Record<string, string>]> };
  const e = {
    chat: { adicionarEtiquetas: async (_c: number, l: string[]) => { f.etiquetas.push(l); } },
    nota: { imagem: async () => null, nomes: async () => null, publicar: async (c: number) => { f.notas.push(c); } },
    origem: { ...portasDaOrigem({} as any), contato: async () => ({}), nomes: async () => null, gravar: async (c: number, campos: Record<string, string>) => { f.origem.push([c, campos]); } },
  } as any;
  return { f, e };
}

const portas = (o: { conversas?: number[]; guardados?: Set<string>; truncado?: boolean; etiquetadas?: Set<number> } = {}) => ({
  conversas: async () => ({ lista: (o.conversas ?? [900]).map((id) => ({ id, contato: id + 1000 })), truncado: o.truncado ?? false }),
  referrais: async (c: number) => ({ achados: [{ wamid: WAMID(c), ref: REF, criadaEm: Date.parse('2026-11-15T12:00:00Z') / 1000 }], truncado: false }),
  guardado: async (c: number, w: string) => (o.guardados ?? new Set()).has(`${c}:${w}`),
  temEtiqueta: async (c: number) => (o.etiquetadas ?? new Set()).has(c),
});

const tabelaComOrigemLigada = () => trocarDelegate('unitAutomacao', { findMany: async () => [{ automacao: 'chatwoot-origem', estado: 'ligado', unit: { slug: SLUG } }] });
/** `create` de mentira da linha `kapso-referral`; devolve o contador de chamadas. */
function guardarCria(jaExiste: (c: number) => boolean): { chamadas: number } {
  const n = { chamadas: 0 };
  trocarDelegate('chatwootReguaDisparo', {
    create: async (a: any) => {
      n.chamadas++;
      if (jaExiste(a.data.conversationId)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      return {};
    },
  });
  return n;
}

test('processo NOVO com a origem ligada só na tabela: a origem é aplicada desde a 1ª conversa (depois de ler a tabela)', async () => {
  tabelaComOrigemLigada();
  guardarCria(() => false);
  // sem ler a tabela, o processo novo cai no .env e vê «desligado» — era o bug do retroativo
  assert.equal(estadoDaAutomacao(SLUG, 'chatwoot-origem', process.env.CHATWOOT_ORIGEM_SLUGS), 'desligado');
  await prepararEstadoDasAutomacoes();
  assert.equal(estadoDaAutomacao(SLUG, 'chatwoot-origem', process.env.CHATWOOT_ORIGEM_SLUGS), 'ligado');
  const { f, e } = estado();
  const linhas: string[] = [];
  const c = await rodarRetroativo({ caixa: 3, soConferir: false, modoDaOrigem: e.origem.estado(SLUG) }, portas({ conversas: [900, 901] }), aoAcharReferral(e), (l) => linhas.push(l));
  assert.deepEqual(f.origem.map((x) => x[0]), [1900, 1901], 'a origem foi gravada em TODAS, inclusive a 1ª');
  assert.deepEqual(f.etiquetas, [['anuncio'], ['anuncio']]);
  assert.deepEqual(f.notas, [900, 901]);
  assert.equal(c.feito, 2);
  assert.ok(linhas.every((l) => l.startsWith('FEITO') && l.includes('etiqueta sim') && l.includes('origem gravado')), linhas.join('\n'));
});

test('sem ler a tabela (origem «desligado»): a linha diz origem desligado, não um FEITO mudo', async () => {
  guardarCria(() => false);
  const { e } = estado();
  const linhas: string[] = [];
  await rodarRetroativo({ caixa: 3, soConferir: false, modoDaOrigem: e.origem.estado(SLUG) }, portas(), aoAcharReferral(e), (l) => linhas.push(l));
  assert.match(linhas[0]!, /origem desligado/);
});

test('conversa já guardada é REAPLICADA: etiqueta e origem de novo, nota NÃO', async () => {
  tabelaComOrigemLigada();
  guardarCria(() => true); // a linha já existe (P2002)
  await prepararEstadoDasAutomacoes();
  const { f, e } = estado();
  const linhas: string[] = [];
  const c = await rodarRetroativo({ caixa: 3, soConferir: false, modoDaOrigem: 'ligado' }, portas({ guardados: new Set([`900:${WAMID(900)}`]) }), aoAcharReferral(e), (l) => linhas.push(l));
  assert.deepEqual(f.etiquetas, [['anuncio']]);
  assert.deepEqual(f.notas, [], 'sem nota nova');
  assert.equal(f.origem.length, 1);
  assert.equal(c.jaGuardado, 1);
  assert.equal(c.feito, 1);
  assert.match(linhas[0]!, /já estava guardado.*nota ja-existia, origem gravado/);
});

test('etiqueta que falha aparece como FALHOU (não como FEITO)', async () => {
  guardarCria(() => false);
  const { e } = estado();
  e.chat.adicionarEtiquetas = async () => { throw new Error('chatwoot fora'); };
  const linhas: string[] = [];
  const c = await rodarRetroativo({ caixa: 3, soConferir: false, modoDaOrigem: 'ligado' }, portas(), aoAcharReferral(e), (l) => linhas.push(l));
  assert.equal(c.falhou, 1);
  assert.match(linhas[0]!, /^FALHOU.*etiqueta falhou/);
});

test('--so-conferir não grava nada, mostra o modo da origem e a etiqueta; teto de páginas avisa', async () => {
  const criar = guardarCria(() => false);
  const { f, e } = estado();
  const linhas: string[] = [];
  const c = await rodarRetroativo({ caixa: 3, soConferir: true, modoDaOrigem: 'seco' }, portas({ truncado: true, etiquetadas: new Set([900]) }), aoAcharReferral(e), (l) => linhas.push(l));
  assert.equal(criar.chamadas, 0);
  assert.deepEqual([f.etiquetas, f.notas, f.origem], [[], [], []]);
  assert.equal(c.faltavaGuardar, 1);
  assert.ok(linhas.some((l) => l.startsWith('AVISO') && l.includes('teto de páginas')));
  assert.ok(linhas.some((l) => l.startsWith('FALTA') && l.includes('etiqueta já tem') && l.includes('modo seco')));
});

test('opções estritas: --caixa só dígitos, --desde só AAAA-MM-DD, nada desconhecido (--dias saiu)', () => {
  assert.deepEqual(lerArgumentos([]), { soConferir: false, caixa: 3, desde: '2026-11-13' });
  assert.deepEqual(lerArgumentos(['--so-conferir', '--caixa=12', '--desde=2026-11-14']), { soConferir: true, caixa: 12, desde: '2026-11-14' });
  for (const ruim of ['--caixa=7x', '--caixa=', '--caixa=0', '--desde=14/11', '--desde=2026-13-45', '--dias=10', '--aplicar']) assert.throws(() => lerArgumentos([ruim]), /inválida|inválido/, ruim);
});
