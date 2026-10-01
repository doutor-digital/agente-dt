/**
 * Servidor de TESTE do relatório da rede — para mexer no Swagger sem depender de deploy, de banco,
 * nem da franquia (que recusa IP fora da VPS).
 *
 *   cd backend && npx tsx src/scripts/relatorio-rede-mock.ts
 *   → http://localhost:3999/docs       (Swagger/Scalar com "Test Request")
 *
 * O QUE É REAL: o cálculo, o texto, a montagem da resposta (`montarResposta`), o contrato OpenAPI, a
 * validação de `data`, o 404 de slug errado e o 401 sem chave — tudo vem do mesmo código da rota.
 * O QUE É DE MENTIRA: os números. As "unidades" abaixo são fictícias, com uma cujo Kommo cai e outra
 * cuja franquia cai, para você ver o relatório INCOMPLETO sem esperar uma falha de verdade.
 *
 * NÃO abre porta para produção, não lê banco, não chama Spine nem Kommo, não envia WhatsApp.
 * A chave aceita é fixa e de mentira (abaixo).
 */
import express from 'express';
import { apiReference } from '@scalar/express-api-reference';
import { gerarOpenApiRelatorios } from '../docs/openapi.js';
import { SPINE_STATUS as S, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { coletarRede, dataValida, montarResposta, type Fontes, type UnidadeParaColeta } from '../lib/relatorio-rede.js';
import { CAMPOS_ANALISE, type LeadDoKommo } from '../lib/relatorio-rede-analise.js';

const PORTA = Number(process.env.PORTA_MOCK) || 3999;
const CHAVE_DE_TESTE = 'chave-de-teste-local';

/* ───── unidades fictícias ───── */

interface Ficticia { slug: string; name: string; leads: number | 'cai'; franquia: 'ok' | 'cai'; aval: [number, number, number]; sess: [number, number]; amanha: number; trat: [number, number] | null }

const UNIDADES: Ficticia[] = [
  { slug: 'doutor-hernia-serra', name: 'Serra', leads: 6, franquia: 'ok', aval: [3, 1, 0], sess: [14, 2], amanha: 4, trat: [1, 2400] },
  { slug: 'doutor-hernia-imperatriz', name: 'Imperatriz', leads: 11, franquia: 'ok', aval: [5, 2, 1], sess: [31, 3], amanha: 7, trat: [2, 5200] },
  { slug: 'doutor-hernia-maraba', name: 'Marabá', leads: 8, franquia: 'ok', aval: [4, 0, 0], sess: [18, 1], amanha: 5, trat: [1, 2400] },
  { slug: 'doutor-hernia-balsas', name: 'Balsas', leads: 4, franquia: 'ok', aval: [2, 1, 0], sess: [12, 0], amanha: 3, trat: null },
  { slug: 'doutor-hernia-taubate', name: 'Taubaté', leads: 'cai', franquia: 'ok', aval: [3, 2, 1], sess: [9, 1], amanha: 4, trat: [0, 0] },   // Kommo fora
  { slug: 'doutor-hernia-canaa', name: 'Canaã', leads: 3, franquia: 'cai', aval: [0, 0, 0], sess: [0, 0], amanha: 0, trat: null },             // franquia fora
];
const SEM_FRANQUIA = ['Petrópolis', 'Divinópolis'];

/* ───── cartões fictícios do Kommo (7 dias) ─────
 * qual = [quente, morno, frio, sem]; obj = motivos do não agendamento registrados;
 * cons = consultas do período: [situação, comprovante?, disse que ia pagar?, motivo da falta?, motivo de não fechar?]
 * A Serra reproduz o que medimos lá em 30/09: quase ninguém registra objeção, e o "vai pagar" sem comprovante. */
type Cons = [string, boolean, boolean, string?, string?];
const rep = <T,>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
const KOMMO: Record<string, { qual: [number, number, number, number]; obj: Record<string, number>; cons: Cons[]; semCampo?: string }> = {
  'doutor-hernia-serra': { qual: [13, 56, 54, 9], obj: { 'Sem interesse': 1 },
    cons: [...rep<Cons>(1, ['Atendido', false, false]), ...rep<Cons>(6, ['Desmarcado', false, true]), ...rep<Cons>(2, ['Desmarcado', false, false])] },
  'doutor-hernia-imperatriz': { qual: [22, 30, 18, 14], obj: { 'Sem condições financeira': 9, 'Outra cidade': 4, 'Sem interesse': 3 },
    cons: [...rep<Cons>(12, ['Atendido', true, true]), ...rep<Cons>(10, ['Atendido', false, false, undefined, 'Achou caro']), ...rep<Cons>(1, ['Não compareceu', true, true]),
      ...rep<Cons>(5, ['Não compareceu', false, false, 'Trabalho']), ...rep<Cons>(3, ['Não compareceu', false, true]), ...rep<Cons>(4, ['Confirmado', false, true])] },
  'doutor-hernia-maraba': { qual: [18, 20, 9, 6], obj: { 'Sem condições financeira': 6, 'Vai se organizar': 5 },
    cons: [...rep<Cons>(15, ['Atendido', true, true]), ...rep<Cons>(9, ['Atendido', false, false]), ...rep<Cons>(6, ['Não compareceu', false, false, 'Esqueceu']), ...rep<Cons>(2, ['Desmarcado', false, false])] },
  'doutor-hernia-balsas': { qual: [8, 12, 10, 4], obj: {}, semCampo: CAMPOS_ANALISE.motivoFalta[0],
    cons: [...rep<Cons>(9, ['Atendido', false, false]), ...rep<Cons>(3, ['Não compareceu', false, false])] },
  'doutor-hernia-taubate': { qual: [0, 0, 0, 0], obj: {}, cons: [] },  // Kommo fora
  'doutor-hernia-canaa': { qual: [5, 7, 3, 2], obj: { 'Plano de Saúde': 2 }, cons: [...rep<Cons>(4, ['Atendido', true, true]), ...rep<Cons>(1, ['Não compareceu', false, false])] },
};
const NOMES_CAMPOS = Object.values(CAMPOS_ANALISE).map((ns) => ns[0] as string);
const ID_CAMPO = (nome: string) => 5000 + NOMES_CAMPOS.indexOf(nome);
let proxId = 1;
const cartao = (created_at: number, campos: Record<string, unknown>): LeadDoKommo => ({
  id: proxId++, created_at,
  custom_fields_values: Object.entries(campos).filter(([, v]) => v !== undefined && v !== null).map(([n, v]) => ({ field_id: ID_CAMPO(n), values: [{ value: v }] })),
});

const HOJE_PADRAO = new Date().toISOString().slice(0, 10);
const somarDias = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const ag = (dia: string, idStatus: number, categoryName: string): SpineSchedule => ({
  idSchedule: 1, idTreatment: null, idStatus, statusName: null, clientName: 'Paciente Ficticio', categoryName,
  physicalTherapist: null, dateAttendanceUtc: null, dateAttendanceLocal: null, dayLocal: dia, timeLocal: '10:00',
  isBusy: true, requiresManualValidation: false,
});
const vezes = <T,>(n: number, f: () => T): T[] => Array.from({ length: n }, f);

const fontes: Fontes = {
  async agenda(u, de, ate) {
    const f = UNIDADES.find((x) => x.slug === u.slug)!;
    if (f.franquia === 'cai') return { ok: false, error: '403: IP nao autorizado' };
    const [at, fa, ab] = f.aval;
    return { ok: true, schedules: [
      ...vezes(at, () => ag(de, S.ATENDIDO, 'AVALIAÇÃO')), ...vezes(fa, () => ag(de, S.NAO_COMPARECEU, 'AVALIAÇÃO')),
      ...vezes(ab, () => ag(de, S.CONFIRMADO, 'AVALIAÇÃO')),
      ...vezes(f.sess[0], () => ag(de, S.ATENDIDO, 'SESSÃO')), ...vezes(f.sess[1], () => ag(de, S.NAO_COMPARECEU, 'SESSÃO')),
      ...vezes(f.amanha, () => ag(ate, S.AGENDADO, 'AVALIAÇÃO')),
    ] };
  },
  async tratamentos(u) {
    const f = UNIDADES.find((x) => x.slug === u.slug)!;
    if (f.franquia === 'cai') return { ok: false, error: '403: IP nao autorizado' };
    const [n, v] = f.trat ?? [0, 0];
    const t = (price: number): SpineTreatment => ({ idTreatment: 1, idClient: 1, clientName: 'P', category: null, local: null, degree: null, staffName: null, statusName: 'EM ANDAMENTO', price, created: `${HOJE_PADRAO}T15:00:00Z` });
    return { ok: true, treatments: n ? vezes(n, () => t(v / n)) : [] };
  },
  async kommo(u, j) {
    const f = UNIDADES.find((x) => x.slug === u.slug)!;
    if (f.leads === 'cai') throw new Error('403 Forbidden (Kommo bloqueou por rajada)');
    const k = KOMMO[u.slug]!;
    const deHoje = f.leads;   // quantos dos criados nasceram hoje
    const Q = CAMPOS_ANALISE;
    const hojeUnix = j.criadosAte - 3600;           // criado hoje
    const antesUnix = j.criadosDe + 3600;           // criado dias atrás, ainda na janela
    const criados: LeadDoKommo[] = [];
    const quals: Array<string | null> = [...rep<string | null>(k.qual[0], 'Quente'), ...rep<string | null>(k.qual[1], 'Morno'), ...rep<string | null>(k.qual[2], 'Frio'), ...rep<string | null>(k.qual[3], null)];
    const motivos = Object.entries(k.obj).flatMap(([m, n]) => rep(n, m));
    quals.forEach((q, i) => criados.push(cartao(i < deHoje ? hojeUnix : antesUnix, { [Q.qualificacao[0]]: q, [Q.motivoNaoAgendamento[0]]: motivos[i] ?? null })));
    const mexidos = k.cons.map(([sit, prova, intencao, falta, naoFechou]) => cartao(antesUnix, {
      [Q.dataConsulta[0]]: antesUnix + 86_400, [Q.situacao[0]]: sit,
      [Q.pgComprovante[0]]: prova ? 'Sim' : 'Não', [Q.pgIntencao[0]]: intencao ? 'Sim' : null,
      [Q.motivoFalta[0]]: falta ?? null, [Q.motivoNaoFechamento[0]]: naoFechou ?? null,
    }));
    const acha = (nome: string) => (nome === k.semCampo || !NOMES_CAMPOS.includes(nome) ? null : ID_CAMPO(nome));
    return { criados, mexidos: [...criados, ...mexidos], acha, truncado: false };
  },
  dia: (_u, iso) => iso.slice(0, 10),
  calendario: (_u, data) => {
    const hoje = data ?? HOJE_PADRAO;
    const unix = (d: string) => Math.floor(Date.parse(`${d}T03:00:00Z`) / 1000);   // 00:00 em Brasília
    const inicioJanela = somarDias(hoje, -6);
    return { hoje, amanha: somarDias(hoje, 1), deUnix: unix(hoje), ateUnix: unix(somarDias(hoje, 1)) - 1, inicioJanela, janelaDeUnix: unix(inicioJanela) };
  },
};

/* ───── servidor ───── */

const app = express();
const spec = () => gerarOpenApiRelatorios([
  { url: `http://localhost:${PORTA}/api`, description: 'Servidor de teste local (dados fictícios)' },
  { url: 'https://agente-vps.doutordigitalconsultoria.com/api', description: 'Produção (a rota só existe depois do deploy)' },
]);

app.get('/openapi.json', (_req, res) => res.json(spec()));
app.get('/docs', apiReference({ url: '/openapi.json', theme: 'purple', pageTitle: 'Relatório da rede · teste local' }));
app.get('/', (_req, res) => res.redirect('/docs'));

// Mesma porta de entrada que o backend real: chave de serviço, senão 401.
const guarda: express.RequestHandler = (req, res, next) => {
  if (req.header('x-internal-key') === CHAVE_DE_TESTE) return next();
  res.status(401).json({ error: 'nao_autenticado', dica: `neste servidor de teste a chave é: ${CHAVE_DE_TESTE}` });
};

app.get('/api/cerebro/unidades', guarda, (_req, res) => {
  res.json({ unidades: [
    ...UNIDADES.map((u) => ({ slug: u.slug, nome: u.name, franquiaLigada: true })),
    ...SEM_FRANQUIA.map((n) => ({ slug: n.toLowerCase(), nome: n, franquiaLigada: false })),
  ] });
});

app.get('/api/relatorios/rede-diaria', guarda, async (req, res) => {
  const inicio = Date.now();
  const data = dataValida(req.query.data) ? req.query.data : undefined;
  if (typeof req.query.data === 'string' && !data) { res.status(400).json({ error: 'data_invalida', esperado: 'AAAA-MM-DD' }); return; }
  const pedidas = typeof req.query.unidades === 'string' && req.query.unidades.trim()
    ? req.query.unidades.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const escolhidas = UNIDADES.filter((u) => !pedidas || pedidas.includes(u.slug));
  if (!escolhidas.length) { res.status(404).json({ error: 'nenhuma_unidade', pedidas, dica: 'confira os slugs em /api/cerebro/unidades' }); return; }

  const unidades = await coletarRede(escolhidas as unknown as UnidadeParaColeta[], fontes, { data, simultaneas: 2, pausaMs: 0 });
  const cal = fontes.calendario(escolhidas[0] as unknown as UnidadeParaColeta, data);
  const resposta = montarResposta({ data: cal.hoje, inicioJanela: cal.inicioJanela, unidades, semFranquia: pedidas ? [] : SEM_FRANQUIA, inicioMs: inicio, porUnidade: req.query.porUnidade === '1' || req.query.porUnidade === 'true' });
  if (req.query.formato === 'texto') { res.type('text/plain; charset=utf-8').send(resposta.texto); return; }
  res.json(resposta);
});

app.listen(PORTA, () => {
  console.log(`\nServidor de TESTE do relatório da rede (dados fictícios)\n`);
  console.log(`  Swagger   http://localhost:${PORTA}/docs`);
  console.log(`  Chave     ${CHAVE_DE_TESTE}   ← em Authentication, escolha ChaveDeServico e cole esta chave\n`);
  console.log(`  Experimente: unidades=doutor-hernia-serra · formato=texto · data=abc (dá 400) · sem chave (dá 401)`);
  console.log(`  Taubaté tem o Kommo fora e Canaã tem a franquia fora: o relatório sai INCOMPLETO de propósito.\n`);
});
