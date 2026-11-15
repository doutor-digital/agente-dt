/**
 * A aba/menu no SUBDOMÍNIO da clínica: as telas por iframe aceitam a sessão (postMessage) de uma LISTA de origens — a principal do Chatwoot mais o
 * subdomínio de cada clínica cadastrada — e recusam qualquer outra. O trecho de JavaScript que decide isso roda aqui, num `vm`, com `location`/`document` de mentira.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const { origensDoChatwoot } = await import('./origens-do-chatwoot.js');
const { CONTA_NA_PAGINA_JS, comContaNaPagina } = await import('./conta-no-navegador.js');
const U = await import('./chatwoot-unidades.js');
const { paginaDosRobos } = await import('./robos-pagina.js');
const { paginaDoAgente } = await import('./agente-pagina.js');
const { paginaDaAssistente } = await import('./chatwoot-assistente-ui.js');
const F = await import('../controllers/funil.controller.js');

const PRINCIPAL = 'https://atendimento.doutordigitalconsultoria.com';
const PARAU = 'https://drherniaparauapebas.doutordigitalconsultoria.com';
const DEMO = {
  slug: 'clinica-demonstracao', contaId: 2, subdominio: 'demo', prefixoModelos: 'demo_', usuarioCelularId: 77, gerenteId: 51, metaAgendamentosDia: 5, kapsoPhoneNumberId: null, wabaId: null, envSufixo: 'DEMO',
  dadosModelos: { nome: 'Clínica Demonstração', cidade: 'Demonstração', endereco: 'Rua Exemplo, 100 — Centro, Demonstração/PA', mapa: 'https://maps.example/demo' },
  caixas: [{ id: 20, tipo: 'cloud' as const }],
};
const SALVO = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SALVO)) delete process.env[k];
  Object.assign(process.env, SALVO);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
});
function preparar() {
  process.env.CHATWOOT_API_TOKEN = 'tk-amb';
  process.env.CHATWOOT_CONTA_ID = '1';
  process.env.CHATWOOT_URL = PRINCIPAL;
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
}

/** Roda o trecho comum da página com `location`/`document` de mentira e devolve as funções. */
function trecho(origens: string[], pai: { ancestor?: string; referrer?: string }) {
  const ctx = vm.createContext({ location: { search: '?conta=2', ancestorOrigins: pai.ancestor ? [pai.ancestor] : [] }, document: { referrer: pai.referrer ?? '' }, URL, URLSearchParams });
  vm.runInContext(`${comContaNaPagina('/*__CONTA_JS__*/', origens)}; this.origemDoCrm = origemDoCrm; this.origemDoPai = origemDoPai; this.comConta = comConta;`, ctx);
  return ctx as unknown as { origemDoCrm(o: unknown): boolean; origemDoPai(p: string): string; comConta(c: string): string };
}

test('a lista de origens: a principal mais o subdomínio das clínicas CADASTRADAS (e só)', () => {
  preparar();
  assert.deepEqual(origensDoChatwoot(), [PRINCIPAL, 'https://demo.doutordigitalconsultoria.com', PARAU]);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  assert.deepEqual(origensDoChatwoot(), [PRINCIPAL, PARAU], 'sem clínica nova: a principal e o endereço que Parauapebas já tem');
  U.aplicarConfigs([{ ...U.SEMENTE_PARAUAPEBAS, subdominio: null }, { ...DEMO, subdominio: null } as never]);
  assert.deepEqual(origensDoChatwoot(), [PRINCIPAL], 'unidade sem subdomínio gravado não entra');
});

test('subdomínio torto na configuração é recusado (a configuração inteira é ignorada com aviso)', () => {
  assert.ok(U.problemasDaConfig({ ...DEMO, subdominio: 'a.b' } as never).some((p) => /subdomínio inválido/.test(p)));
  assert.ok(U.problemasDaConfig({ ...DEMO, subdominio: 'ev il' } as never).some((p) => /subdomínio inválido/.test(p)));
  assert.deepEqual(U.problemasDaConfig(DEMO as never), []);
});

test('postMessage de uma origem FORA da lista é recusado; a principal e o subdomínio da clínica são aceitos', () => {
  const origens = [PRINCIPAL, 'https://demo.doutordigitalconsultoria.com'];
  const t = trecho(origens, {});
  assert.equal(t.origemDoCrm(PRINCIPAL), true);
  assert.equal(t.origemDoCrm('https://demo.doutordigitalconsultoria.com'), true);
  for (const ruim of ['https://evil.example', `${PRINCIPAL}.evil.test`, 'http://demo.doutordigitalconsultoria.com', 'https://demo.doutordigitalconsultoria.com:8443', 'https://outra.doutordigitalconsultoria.com', 'https://doutordigitalconsultoria.com', 'null', '', undefined, 42]) {
    assert.equal(t.origemDoCrm(ruim), false, String(ruim));
  }
});

test('a origem do PAI: a do próprio iframe pai quando está na lista (Chrome: ancestorOrigins; outros: referrer); senão a principal', () => {
  const origens = [PRINCIPAL, 'https://demo.doutordigitalconsultoria.com'];
  assert.equal(trecho(origens, { ancestor: 'https://demo.doutordigitalconsultoria.com' }).origemDoPai(PRINCIPAL), 'https://demo.doutordigitalconsultoria.com');
  assert.equal(trecho(origens, { referrer: 'https://demo.doutordigitalconsultoria.com/app/accounts/2/dashboard' }).origemDoPai(PRINCIPAL), 'https://demo.doutordigitalconsultoria.com');
  assert.equal(trecho(origens, { ancestor: 'https://evil.example', referrer: 'https://evil.example/x' }).origemDoPai(PRINCIPAL), PRINCIPAL, 'pai fora da lista: nunca endereça a ele');
  assert.equal(trecho(origens, {}).origemDoPai(PRINCIPAL), PRINCIPAL);
  assert.equal(trecho(origens, {}).comConta('/api/x'), '/api/x?conta=2');
});

test('as 4 páginas usam a lista: nenhuma compara a origem com uma string fixa e todas trazem as origens da clínica cadastrada', () => {
  preparar();
  const paginas: Record<string, string> = {
    robos: paginaDosRobos(PRINCIPAL),
    agente: paginaDoAgente(PRINCIPAL),
    assistente: paginaDaAssistente(PRINCIPAL),
  };
  // funil: a página é entregue pelo handler
  let funil = '';
  F.paginaFunilHandler({} as never, { type: () => ({ send: (h: string) => (funil = h) }), status: () => ({ type: () => ({ send: () => undefined }) }) } as never);
  paginas.funil = funil;
  for (const [nome, html] of Object.entries(paginas)) {
    assert.ok(html.includes('origemDoCrm(ev.origin)'), `${nome}: confere a origem pela lista`);
    assert.ok(html.includes('https://demo.doutordigitalconsultoria.com'), `${nome}: traz a origem da clínica`);
    assert.ok(!/ev\.origin\s*(?:!==|===)\s*(?:CW|ORIGEM_CW)\b/.test(html), `${nome}: sobrou comparação com origem fixa`);
    assert.ok(!html.includes('__ORIGENS_CW__') && !html.includes('__ORIGEM_CW__') && !html.includes('/*__CONTA_JS__*/'), `${nome}: marcador sem trocar`);
    assert.ok(html.includes(`origemDoPai("${PRINCIPAL}")`), `${nome}: endereça ao pai real, com a principal de reserva`);
  }
});

test('CORS do botão da assistente e de /funil/gestao: aceita a origem do subdomínio da clínica (e a de Parauapebas), recusa o resto', async () => {
  preparar();
  const { corsDoAssistente } = await import('../controllers/assistente.controller.js');
  const origens = origensDoChatwoot();
  for (const o of origens) {
    assert.ok(corsDoAssistente('/api/public/assistente/estado', o, origens), o);
    assert.ok(corsDoAssistente('/api/public/funil/gestao', o, origens), o);
  }
  for (const ruim of ['https://evil.example', 'https://outra.doutordigitalconsultoria.com', 'http://demo.doutordigitalconsultoria.com']) assert.equal(corsDoAssistente('/api/public/funil/gestao', ruim, origens), null, ruim);
  assert.equal(corsDoAssistente('/api/public/assistente/estado', 'https://demo.doutordigitalconsultoria.com', origens.filter((x) => !x.includes('demo'))), null, 'clínica NÃO cadastrada: sem CORS');
  assert.ok(corsDoAssistente('/api/public/assistente/estado', PRINCIPAL, PRINCIPAL), 'o formato antigo (uma URL) continua valendo');
});
