/**
 * `--so-crm` contra o Chatwoot de MENTIRA (`chatwoot-falso.ts`, como `fase2.test.ts`): o sênior reproduziu (23/11) que, com o plano «robo-sofia = nada», o executor ainda
 * perguntava «Aplicar (robo-sofia)?» e, respondendo «s», fazia `POST agent_bots` e guardava o token do robô no cofre; e que `chatwoot-ia` nascia em seco.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executarPlano } from './executar.js';
import { montarPlano, textoDoPlano } from './plano.js';
import { lerQuestionario } from './questionario.js';
import { camposDaSofia, camposDaUnidade } from './molde-sofia.js';
import { lerYamlOuJson } from './yaml-minimo.js';
import { chatwootFalso } from './chatwoot-falso.js';
import { contaHttp, contaHttpSoLeitura, plataformaHttp } from './chatwoot-http.js';
import { kapsoHttp } from './kapso-http.js';
import { segredosEmArquivo } from './segredos.js';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const MOLDE = readFileSync(join(OPS, 'molde-sofia/bloco-conversa.md'), 'utf8');
const TEXTO = readFileSync(join(OPS, 'questionario.exemplo.yaml'), 'utf8');
const pastas: string[] = [];
after(() => {
  for (const d of pastas) rmSync(d, { recursive: true, force: true });
});
function questionario() {
  const r = lerQuestionario(JSON.stringify(lerYamlOuJson(TEXTO)));
  assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
  return r.q; // assistente.quer = true: o caso em que o robô poderia nascer
}

const URL_CW = 'https://crm.exemplo.test';

function mundo(q: any) {
  const campos: Record<string, unknown> = { ...camposDaUnidade(q), ...camposDaSofia(q, MOLDE).campos, isActive: true, clinicAddress: 'Endereço de produção', sinalPixCentavos: null };
  const escritas: Array<[string, unknown]> = [];
  const e = { config: null as any, automacoes: ['prompt-da-unidade', 'kommo-lembrete'] as string[], caixas: [] as number[] };
  const banco: any = {
    async lerUnidade() { return { id: 'u1', ativa: true, campos: { ...campos } }; },
    async gravarUnidade(...a: unknown[]) { escritas.push(['gravarUnidade', a]); return { id: 'u1', criada: false }; },
    async lerConfigChatwoot() { return e.config ? { ...e.config } : null; },
    async gravarConfigChatwoot(_u: string, cfg: any, criar: boolean) { escritas.push(['gravarConfigChatwoot', Object.keys(cfg)]); e.config = criar ? cfg : { ...e.config, ...cfg }; },
    async automacoesDaUnidade() { return [...e.automacoes]; },
    async criarAutomacoesEmSeco(_u: string, ids: string[]) { escritas.push(['criarAutomacoesEmSeco', ids]); e.automacoes.push(...ids); },
    async sofiaDaUnidade() { return { ...campos }; },
    async gravarSofia(_u: string, c: unknown) { escritas.push(['gravarSofia', c]); },
    licoes: { async listar() { return []; }, async criar() { escritas.push(['licoes.criar', 1]); }, async contarDaUnidade() { return 0; }, async marcarImportado() { escritas.push(['marcarImportado', 1]); } },
    async caixasRegistradas() { return [...e.caixas]; },
    async registrarCaixa(_u: string, c: any) { escritas.push(['registrarCaixa', c.id]); if (!e.caixas.includes(c.id)) e.caixas.push(c.id); },
  };
  const falso = chatwootFalso({ existentes: [{ id: 5, name: 'Suzanne', email: 'suzanne.mychelly1@gmail.com' }] });
  const dir = mkdtempSync(join(tmpdir(), 'so-crm-cofre-'));
  pastas.push(dir);
  const externas = {
    plataforma: plataformaHttp(URL_CW, falso.tokenDaPlataforma, falso.fetch),
    abrirConta: (conta: number, token: string) => contaHttp(URL_CW, conta, token, falso.fetch),
    referencia: contaHttpSoLeitura(URL_CW, 1, falso.tokenDeReferencia, falso.fetch),
    contaDoAmbiente: 1,
    adminsDD: ['suzanne.mychelly1@gmail.com'],
    kapso: kapsoHttp('kapso-chave', falso.fetch),
    segredos: segredosEmArquivo(dir, { KAPSO_API_KEY: 'kapso-chave' }),
    urlDoAgente: 'https://agente.exemplo.test',
    urlDoChatwoot: URL_CW,
    gerarSenha: () => 'Aa1!senha-gerada-so-para-o-teste-7731',
  };
  const estado = (): any => {
    const contaId = e.config?.contaId ?? null;
    const c = contaId ? falso.contas.get(contaId) : null;
    return {
      banco: { unidade: { id: 'u1', campos: { ...campos } }, configChatwoot: e.config, caixasRegistradas: [...e.caixas], automacoes: Object.fromEntries(e.automacoes.map((a) => [a, a.startsWith('chatwoot-') ? 'seco' : 'ligado'])), sofia: { ...campos }, licoes: [] },
      chatwoot: c ? { etiquetas: c.labels.map((l: any) => l.title), atributosConversa: c.attrs.filter((a: any) => a.attribute_model === 0).map((a: any) => a.attribute_key), atributosContato: c.attrs.filter((a: any) => a.attribute_model === 1).map((a: any) => a.attribute_key), caixas: c.inboxes.map((i: any) => ({ id: i.id, nome: i.name, robo: !!i.agent_bot })), times: c.teams.map((t: any) => t.name), agentes: Object.fromEntries(c.agents.map((a: any) => [a.email.toLowerCase(), { id: a.id, nome: a.name }])), pastas: {}, mensagensProntas: c.canned.map((p: any) => p.short_code), automacoesDaConta: c.rules.length, webhookDaConta: c.webhooks.length > 0, abas: c.apps.map((a: any) => a.title) }
        : { etiquetas: [], atributosConversa: [], atributosContato: [], caixas: [], times: [], agentes: {}, pastas: {}, mensagensProntas: [], automacoesDaConta: 0 },
      plataforma: true,
      segredos: Object.fromEntries(readdirSync(dir).map((f) => [f, true])),
    } as any;
  };
  return { banco, escritas, falso, dir, externas, estado, e };
}


const nomesDeEscrita = (m: ReturnType<typeof mundo>) => m.escritas.map((e) => e[0]);

test('--so-crm contra o Chatwoot falso, respondendo «s» a TUDO: 0 POST agent_bots, nenhum token de robô no cofre, nenhuma pergunta sobre o robô, nenhum chatwoot-ia, nada em units/Sofia', async () => {
  const q = questionario();
  const m = mundo(q);
  const plano = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true });
  assert.equal(plano.passos.find((p) => p.id === 'robo-sofia')!.execucao, 'manual', 'o plano não manda executar o robô');
  assert.ok(!textoDoPlano(plano).includes('chatwoot-ia → seco'), 'o plano não cria chatwoot-ia');
  const perguntados: string[] = [];
  const res = await executarPlano(plano, q, { banco: m.banco, molde: MOLDE, soCrm: true, externas: m.externas, dizer: () => undefined, confirmar: async (p) => (perguntados.push(p.id), true) });
  assert.ok(!perguntados.includes('robo-sofia'), `perguntou sobre o robô: ${perguntados.join(',')}`);
  assert.equal(res.find((r) => r.id === 'robo-sofia')!.situacao, 'nada-a-fazer');
  assert.equal(res.filter((r) => r.situacao === 'falhou').length, 0, JSON.stringify(res.filter((r) => r.situacao === 'falhou')));
  // o CRM foi montado (prova de que o teste anda de verdade)
  assert.ok(res.find((r) => r.id === 'caixa')!.situacao === 'feito');
  const bots = m.falso.chamadas.filter((c) => /agent_bots|set_agent_bot/.test(c.caminho) && c.metodo !== 'GET');
  assert.deepEqual(bots, [], 'nenhum POST/PATCH de robô');
  assert.deepEqual(readdirSync(m.dir).filter((f) => /SOFIA_BOT/i.test(f)), [], 'nenhum token de robô no cofre');
  const secos = m.escritas.filter((e) => e[0] === 'criarAutomacoesEmSeco').flatMap((e) => e[1] as string[]);
  assert.ok(secos.length >= 6 && !secos.includes('chatwoot-ia'), `em seco: ${secos.join(',')}`);
  for (const proibida of ['gravarUnidade', 'gravarSofia', 'licoes.criar', 'marcarImportado']) assert.ok(!nomesDeEscrita(m).includes(proibida), proibida);
  // segunda rodada (idempotente): nada novo fora GET, e o robô segue intocado
  const n1 = m.falso.chamadas.length;
  const e1 = m.escritas.length;
  const plano2 = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true });
  const perg2: string[] = [];
  await executarPlano(plano2, q, { banco: m.banco, molde: MOLDE, soCrm: true, externas: m.externas, dizer: () => undefined, confirmar: async (p) => (perg2.push(p.id), true) });
  assert.ok(!perg2.includes('robo-sofia'));
  assert.deepEqual(m.falso.chamadas.slice(n1).filter((c) => c.metodo !== 'GET' && /agent_bots/.test(c.caminho)), []);
  assert.deepEqual(m.escritas.slice(e1).filter((e) => e[0] === 'criarAutomacoesEmSeco' && (e[1] as string[]).includes('chatwoot-ia')), []);
});

test('plano VELHO (feito sem --so-crm, dizia «criar» o robô): o executor com --so-crm não chega ao passoRobo nem pergunta', async () => {
  const q = questionario();
  const m = mundo(q);
  const planoVelho = montarPlano(q, m.estado(), { molde: MOLDE });
  assert.equal(planoVelho.passos.find((p) => p.id === 'robo-sofia')!.acao, 'criar');
  const perguntados: string[] = [];
  const res = await executarPlano(planoVelho, q, { banco: m.banco, molde: MOLDE, soCrm: true, externas: m.externas, dizer: () => undefined, confirmar: async (p) => (perguntados.push(p.id), true) });
  assert.ok(!perguntados.includes('robo-sofia'));
  assert.equal(res.find((r) => r.id === 'robo-sofia')!.situacao, 'nada-a-fazer');
  assert.deepEqual(m.falso.chamadas.filter((c) => /agent_bots/.test(c.caminho) && c.metodo !== 'GET'), []);
  assert.deepEqual(readdirSync(m.dir).filter((f) => /SOFIA_BOT/i.test(f)), []);
  const secos = m.escritas.filter((e) => e[0] === 'criarAutomacoesEmSeco').flatMap((e) => e[1] as string[]);
  assert.ok(!secos.includes('chatwoot-ia'), 'o executor também exclui chatwoot-ia');
});

test('os avisos do --so-crm não mandam mexer em units, na franquia nem ligar o número sem confirmar o canal da Kommo', () => {
  const q = questionario();
  const m = mundo(q);
  const p = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true });
  const tudo = [...p.relatorio, ...p.passos.flatMap((x) => [...x.itens, ...x.avisos])].join('\n');
  assert.doesNotMatch(tudo, /gravar o token da API da franquia|ligar spine_enabled|units\.spine_token \(como|SOFIA_BOT_TOKEN_[A-Z]+\)? ficam|rodar testar-prompt/);
  assert.match(p.relatorio.find((r) => /^NÚMERO/.test(r))!, /decisão SEPARADA.*CORTAR a entrada de leads da Kommo/);
  assert.ok(p.relatorio.some((r) => /^COFRE:.*--sem-ia/.test(r) && !/e o do robô/.test(r)));
  assert.equal(p.passos.find((x) => x.id === 'franquia')!.acao, 'nada');
  assert.ok(!p.passos.find((x) => x.id === 'segredos')!.itens.some((i) => /^FRANQUIA_TOKEN/.test(i)), 'não pede o token da franquia no ambiente');
});
