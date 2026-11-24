/**
 * `--so-crm --sem-caixa` («estrutura agora, número depois», Timbó 24/11): monta o CRM SEM a caixa do WhatsApp, o webhook e os modelos da Meta (dependem do número no Kapso);
 * a rodada seguinte, sem a flag e com o número no questionário, completa só o que faltou — contra o Chatwoot de MENTIRA (`chatwoot-falso.ts`), nada duplica.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codigoDeSaida, executarPlano } from './executar.js';
import { conflitoDoSoCrm, montarPlano, textoDoPlano } from './plano.js';
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
/** O questionário completo (com número); `semNumero` tira número, id do Kapso e WABA (ou os escreve PENDENTE). */
function questionario(semNumero: false | 'ausentes' | 'pendente' = false, semCaixa = false) {
  const o = lerYamlOuJson(TEXTO) as any;
  o.assistente = { quer: false };
  if (semNumero === 'ausentes') for (const c of ['numero_oficial', 'kapso_phone_number_id', 'waba_id']) delete o.whatsapp[c];
  if (semNumero === 'pendente') for (const c of ['numero_oficial', 'kapso_phone_number_id', 'waba_id']) o.whatsapp[c] = 'PENDENTE';
  const r = lerQuestionario(JSON.stringify(o), { semCaixa });
  assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
  return r.q;
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

const naoGet = (m: ReturnType<typeof mundo>, desde = 0) => m.falso.chamadas.slice(desde).filter((c) => c.metodo !== 'GET');
const posts = (lista: Array<{ metodo: string; caminho: string }>, re: RegExp) => lista.filter((c) => c.metodo === 'POST' && re.test(c.caminho));
const resp = async (plano: ReturnType<typeof montarPlano>, q: ReturnType<typeof questionario>, m: ReturnType<typeof mundo>, extra: Record<string, unknown> = {}) => {
  const perguntados: string[] = [];
  const res = await executarPlano(plano, q, { banco: m.banco, molde: MOLDE, soCrm: true, externas: m.externas, dizer: () => undefined, confirmar: async (p) => (perguntados.push(p.id), true), ...extra });
  return { res, perguntados };
};

test('validação: sem a flag número/Kapso/WABA continuam obrigatórios no modo real; com --sem-caixa podem faltar ou estar PENDENTE, mas se vierem o formato vale', () => {
  const o = lerYamlOuJson(TEXTO) as any;
  for (const c of ['numero_oficial', 'kapso_phone_number_id', 'waba_id']) delete o.whatsapp[c];
  const sem = lerQuestionario(JSON.stringify(o));
  assert.ok(!sem.ok && sem.erros.some((e) => /numero_oficial/.test(e)), 'sem a flag recusa');
  assert.ok(lerQuestionario(JSON.stringify(o), { semCaixa: true }).ok);
  // PENDENTE só vale com a flag
  const p = lerYamlOuJson(TEXTO) as any;
  p.whatsapp.numero_oficial = 'PENDENTE';
  p.whatsapp.kapso_phone_number_id = 'pendente';
  assert.ok(!lerQuestionario(JSON.stringify(p)).ok);
  const lp = lerQuestionario(JSON.stringify(p), { semCaixa: true });
  assert.ok(lp.ok, lp.ok ? '' : lp.erros.join('; '));
  // formato errado continua errado, com ou sem a flag
  const r = lerYamlOuJson(TEXTO) as any;
  r.whatsapp.numero_oficial = '123';
  const ruim = lerQuestionario(JSON.stringify(r), { semCaixa: true });
  assert.ok(!ruim.ok && ruim.erros.some((e) => /numero_oficial/.test(e)));
  // o resto do questionário não afrouxa: 1 gerente
  const g = lerYamlOuJson(TEXTO) as any;
  g.chatwoot.atendentes = g.chatwoot.atendentes.map((a: any) => ({ ...a, funcao: 'secretaria' }));
  assert.ok(!lerQuestionario(JSON.stringify(g), { semCaixa: true }).ok);
});

test('--sem-caixa só vale com --so-crm (e não combina com o que o --so-crm já recusa)', () => {
  assert.match(conflitoDoSoCrm({ semCaixa: true })!, /só vale junto de --so-crm/);
  assert.equal(conflitoDoSoCrm({ semCaixa: true, soCrm: true }), null);
  assert.throws(() => montarPlano(questionario(), {}, { molde: MOLDE, semCaixa: true }), /só vale junto de --so-crm/);
  assert.match(conflitoDoSoCrm({ semCaixa: true, soCrm: true, ligarRobo: true })!, /não combina com --ligar-robo/);
});

test('plano --so-crm --sem-caixa: caixa, registro da caixa, webhook e modelos ADIADOS (manuais); atendentes e subdomínio não dependem da caixa; o resto segue', () => {
  const q = questionario('ausentes', true);
  const m = mundo(q);
  const p = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true });
  const por = (id: string) => p.passos.find((x) => x.id === id)!;
  for (const id of ['caixa', 'registrar-caixa', 'webhook', 'modelos']) {
    assert.equal(por(id).acao, 'manual', id);
    assert.equal(por(id).execucao, 'manual', id);
    assert.match(por(id).itens.join(' '), /ADIADO \(--sem-caixa\)/, id);
  }
  assert.deepEqual(por('atendentes').depende, ['time']);
  assert.deepEqual(por('subdominio').depende, ['conta']);
  for (const id of ['conta', 'etiquetas', 'atributos', 'automacoes-conta', 'time', 'atendentes', 'dashboard-app', 'mensagens-prontas', 'automacoes-seco', 'config-chatwoot']) assert.notEqual(por(id).acao, 'manual', id);
  assert.match(p.relatorio[0]!, /^SEM CAIXA \(--sem-caixa\).*número no Kapso → rodar de novo SEM --sem-caixa/);
  assert.ok(!p.relatorio.some((r) => /^MODELOS:/.test(r)), 'o resumo não promete modelos agora');
  assert.ok(!textoDoPlano(p).includes('conectado ao Kapso (coexistência') || /—/.test(textoDoPlano(p)), 'número ausente aparece como «—», sem quebrar');
});

test('1ª rodada --so-crm --sem-caixa (responde «s» a tudo): conta, time, agentes, etiquetas, atributos, automações, abas e mensagens prontas; ZERO caixa, webhook, modelo e membro de caixa; exit 0; units intocada', async () => {
  const q = questionario('pendente', true);
  const m = mundo(q);
  const plano = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true });
  const { res, perguntados } = await resp(plano, q, m, { semCaixa: true });
  assert.deepEqual(res.filter((r) => r.situacao === 'falhou'), []);
  assert.equal(codigoDeSaida(plano, res), 0, JSON.stringify(res.map((r) => `${r.id}=${r.situacao}`)));
  for (const id of ['caixa', 'registrar-caixa', 'webhook', 'modelos']) assert.ok(!perguntados.includes(id), `perguntou ${id}`);
  const tudo = naoGet(m);
  assert.deepEqual(posts(tudo, /inboxes/), [], 'nenhuma caixa');
  assert.deepEqual(posts(tudo, /webhooks/), [], 'nenhum webhook');
  assert.deepEqual(posts(tudo, /message_templates/), [], 'nenhum modelo na Meta');
  assert.deepEqual(posts(tudo, /inbox_members/), [], 'ninguém entra em caixa');
  assert.ok(posts(tudo, /teams\/\d+\/team_members/).length >= 1, 'entram no time');
  assert.ok(m.falso.contas.size >= 1 && [...m.falso.contas.values()].some((c: any) => c.agents.length >= 2 && c.teams.length === 1 && c.labels.length >= 20 && c.apps.length >= 2), 'a estrutura existe');
  assert.ok(!m.escritas.some((e) => ['gravarUnidade', 'gravarSofia', 'registrarCaixa'].includes(e[0])));
  const cfg = m.e.config as { kapsoPhoneNumberId: unknown; wabaId: unknown; contaId: number };
  assert.ok(cfg.contaId > 0 && !cfg.kapsoPhoneNumberId && !cfg.wabaId, 'a config guarda a conta e deixa número/WABA vazios');
  assert.deepEqual(m.e.caixas, [], 'nenhuma caixa registrada: a configuração fica inerte para o servidor');
  // repetir a mesma rodada não escreve mais nada
  const n = m.falso.chamadas.length;
  const plano2 = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true });
  await resp(plano2, q, m, { semCaixa: true });
  assert.deepEqual(naoGet(m, n), [], 'a 2ª rodada igual não cria nada');
});

test('2ª rodada SEM --sem-caixa, com o número: cria só a caixa, os membros dela, o webhook e os modelos — nenhuma conta, agente, time, etiqueta ou atributo duplicado; a 3ª não escreve nada', async () => {
  const qSem = questionario('pendente', true);
  const m = mundo(qSem);
  await resp(montarPlano(qSem, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), qSem, m, { semCaixa: true });
  const contasAntes = m.falso.contas.size;
  const c0: any = [...m.falso.contas.values()].pop();
  const antes = { agentes: c0.agents.length, times: c0.teams.length, etiquetas: c0.labels.length, atributos: c0.attrs.length, regras: c0.rules.length, prontas: c0.canned.length, abas: c0.apps.length };
  // o número chegou
  const q = questionario(false, false);
  const n = m.falso.chamadas.length;
  const plano = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true });
  assert.equal(plano.passos.find((p) => p.id === 'caixa')!.acao, 'criar');
  const { res } = await resp(plano, q, m);
  assert.deepEqual(res.filter((r) => r.situacao === 'falhou'), [], JSON.stringify(res));
  const novas = naoGet(m, n);
  assert.equal(posts(novas, /inboxes$/).length, 1, 'a caixa nasce uma vez');
  assert.ok(posts(novas, /inbox_members/).length >= 1, 'os agentes que já existiam entram na caixa');
  assert.equal(posts(novas, /webhooks$/).length, 1);
  assert.ok(posts(novas, /message_templates/).length >= 30, 'os modelos vão à Meta (Kapso)');
  assert.deepEqual(posts(novas, /\/(agent_bots|users|labels|custom_attribute_definitions|automation_rules|canned_responses|dashboard_apps|teams|agents)$|team_members|platform\/api\/v1\/(accounts|users)/), [], 'nada da estrutura é refeito');
  assert.equal(m.falso.contas.size, contasAntes);
  const c1: any = [...m.falso.contas.values()].pop();
  assert.deepEqual({ agentes: c1.agents.length, times: c1.teams.length, etiquetas: c1.labels.length, atributos: c1.attrs.length, regras: c1.rules.length, prontas: c1.canned.length, abas: c1.apps.length }, antes);
  assert.equal(c1.inboxes.length, 1);
  assert.equal(c1.inboxes[0].membros.length >= 2, true);
  assert.deepEqual(m.e.caixas.length, 1, 'a caixa foi registrada');
  const cfg = m.e.config as { kapsoPhoneNumberId: string; wabaId: string };
  assert.ok(cfg.kapsoPhoneNumberId && cfg.wabaId, 'a rodada com o número preencheu Kapso e WABA que estavam vazios');
  assert.ok(!m.escritas.some((e) => ['gravarUnidade', 'gravarSofia'].includes(e[0])));
  // 3ª rodada: tudo no lugar
  const n3 = m.falso.chamadas.length;
  const e3 = m.escritas.length;
  await resp(montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true }), q, m);
  assert.deepEqual(naoGet(m, n3), [], '3ª rodada: nenhuma escrita no Chatwoot/Kapso');
  assert.deepEqual(m.escritas.slice(e3).filter((e) => e[0] !== 'gravarConfigChatwoot'), []);
});
