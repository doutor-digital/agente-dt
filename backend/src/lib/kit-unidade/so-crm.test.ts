/**
 * `--so-crm` (23/11/2026, Marabá): unidade que JÁ EXISTE e está ATIVA no ar pelo Kommo ganha o CRM (Chatwoot) sem o kit escrever na linha de `units`
 * (nem campo vazio) e sem tocar na Sofia dela. Sem a flag a unidade ativa continua RECUSADA (`executar.test.ts`); com `--sobrescrever` o kit trocaria
 * persona, fontes e prompt — por isso as duas flags não combinam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { executarPlano, type BancoPorta, type ConfigGravada } from './executar.js';
import { conflitoDoSoCrm, montarPlano, textoDoPlano, type EstadoAtual } from './plano.js';
import { lerQuestionario, type Questionario } from './questionario.js';
import { camposDaSofia, camposDaUnidade } from './molde-sofia.js';
import { lerYamlOuJson } from './yaml-minimo.js';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const MOLDE = readFileSync(join(OPS, 'molde-sofia/bloco-conversa.md'), 'utf8');
const TEXTO = readFileSync(join(OPS, 'questionario.exemplo.yaml'), 'utf8');
function questionario(f: (o: any) => void = () => {}): Questionario {
  const o = lerYamlOuJson(TEXTO) as any;
  f(o);
  const r = lerQuestionario(JSON.stringify(o));
  assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
  return r.q;
}
const passo = (p: ReturnType<typeof montarPlano>, id: string) => p.passos.find((x) => x.id === id)!;
const sit = (res: Array<{ id: string; situacao: string }>, id: string) => res.find((x) => x.id === id)?.situacao;

/**
 * A unidade como Marabá é hoje: ATIVA, com persona/fontes/prompt/agenda preenchidos (e DIFERENTES do questionário) e alguns campos VAZIOS que o kit, sem a flag, preencheria
 * (sinal Pix, almoço): `--so-crm` não pode escrever nem esses.
 */
function unidadeAtiva(q: Questionario) {
  const campos: Record<string, unknown> = { ...camposDaUnidade(q), ...camposDaSofia(q, MOLDE).campos, isActive: true, clinicAddress: 'Endereço que a equipe escreveu', personaAgentName: 'Sofia (editada)', sourceNegocio: 'Texto do negócio de produção', sinalPixCentavos: null, spineLunchStart: null };
  const escritas: Array<[string, unknown]> = [];
  const estado = { config: null as ConfigGravada | null, automacoes: [] as string[], caixas: [] as number[] };
  const banco: BancoPorta = {
    async lerUnidade() {
      return { id: 'u1', ativa: true, campos: { ...campos } };
    },
    async gravarUnidade(slug, nome, c, soNaCriacao) {
      escritas.push(['gravarUnidade', { slug, nome, c, soNaCriacao }]);
      return { id: 'u1', criada: false };
    },
    async lerConfigChatwoot() {
      return estado.config ? { ...estado.config } : null;
    },
    async gravarConfigChatwoot(_id, cfg, criar) {
      escritas.push(['gravarConfigChatwoot', { cfg, criar }]);
      estado.config = criar ? (cfg as ConfigGravada) : { ...(estado.config as ConfigGravada), ...cfg };
    },
    async automacoesDaUnidade() {
      return [...estado.automacoes];
    },
    async criarAutomacoesEmSeco(_id, ids) {
      escritas.push(['criarAutomacoesEmSeco', { ids }]);
      estado.automacoes.push(...ids);
    },
    async sofiaDaUnidade() {
      return { ...campos };
    },
    async gravarSofia(_id, c) {
      escritas.push(['gravarSofia', c]);
    },
    licoes: {
      async listar() {
        return [];
      },
      async criar(_id, textos) {
        escritas.push(['licoes.criar', textos]);
      },
      async contarDaUnidade() {
        return 0;
      },
      async marcarImportado() {
        escritas.push(['licoes.marcarImportado', null]);
      },
    },
    async caixasRegistradas() {
      return [...estado.caixas];
    },
    async registrarCaixa(_id, caixa) {
      escritas.push(['registrarCaixa', caixa]);
      estado.caixas.push(caixa.id);
    },
  };
  const estadoAtual = (): EstadoAtual => ({ banco: { unidade: { id: 'u1', campos: { ...campos } }, configChatwoot: estado.config, caixasRegistradas: [...estado.caixas], automacoes: Object.fromEntries(estado.automacoes.map((a) => [a, 'seco'])), sofia: { ...campos } }, plataforma: true });
  return { banco, escritas, campos, estadoAtual };
}

test('sem a flag, unidade ATIVA continua bloqueada — e o aviso aponta o caminho seguro (--so-crm) e desaconselha --sobrescrever', () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const p = montarPlano(q, u.estadoAtual(), { molde: MOLDE });
  assert.equal(passo(p, 'unidade').acao, 'bloqueado');
  const aviso = passo(p, 'unidade').avisos.join(' | ');
  assert.match(aviso, /--so-crm/);
  assert.match(aviso, /NÃO use numa unidade no ar/);
});

test('--so-crm no plano: unidade «nada» (só lida), Sofia «nada», e o CRM (config, conta, caixa, automações em seco) segue normal', () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const p = montarPlano(q, u.estadoAtual(), { molde: MOLDE, soCrm: true });
  assert.equal(passo(p, 'unidade').acao, 'nada');
  assert.match(passo(p, 'unidade').itens[0]!, /nenhum campo de units é escrito, nem vazio.*ATIVA/);
  assert.equal(passo(p, 'sofia').acao, 'nada');
  assert.match(passo(p, 'sofia').itens[0]!, /NÃO são tocados/);
  for (const id of ['config-chatwoot', 'conta', 'caixa', 'automacoes-seco']) assert.notEqual(passo(p, id).acao, 'bloqueado', id);
  const texto = textoDoPlano(p);
  assert.match(texto, /--so-crm não escreveu em units/);
  assert.doesNotMatch(texto, /nasce inativa/);
  // o relatório não pede mais «testar a Sofia e ligar» como se ela fosse nova
  assert.ok(p.relatorio.some((r) => /^SOFIA: --so-crm não mexeu/.test(r)));
});

test('--so-crm com unidade que NÃO existe: bloqueado (nunca cria unidade vazia)', () => {
  const q = questionario();
  const p = montarPlano(q, { banco: { unidade: null, configChatwoot: null, caixasRegistradas: [], automacoes: {}, sofia: {} } }, { molde: MOLDE, soCrm: true });
  assert.equal(passo(p, 'unidade').acao, 'bloqueado');
  assert.ok(passo(p, 'unidade').avisos.some((a) => /não existe/.test(a)));
});

test('--so-crm sem ler o banco (seco offline, ou a leitura falhou): o passo fica BLOQUEADO — não parece limpo, e o --aplicar não segue', async () => {
  const q = questionario();
  const p = montarPlano(q, {}, { molde: MOLDE, soCrm: true });
  assert.equal(passo(p, 'unidade').acao, 'bloqueado');
  assert.ok(passo(p, 'unidade').avisos.some((a) => /exige que a unidade já exista/.test(a)));
  const u = unidadeAtiva(q);
  const res = await executarPlano(p, q, { banco: u.banco, molde: MOLDE, soCrm: true, dizer: () => undefined, confirmar: async () => true });
  assert.equal(sit(res, 'unidade'), 'bloqueado');
  assert.equal(sit(res, 'config-chatwoot'), 'bloqueado', 'quem depende da unidade não roda');
  assert.equal(u.escritas.length, 0);
});

test('--so-crm avisa onde o questionário DIFERE da unidade viva (os textos dos modelos da Meta usam o do questionário) e NÃO cria robô', () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const p = montarPlano(q, u.estadoAtual(), { molde: MOLDE, soCrm: true });
  const aviso = passo(p, 'unidade').avisos.find((a) => /DIFERE de units em/.test(a));
  assert.ok(aviso, 'avisa a divergência');
  assert.match(aviso!, /clinicAddress/);
  assert.match(aviso!, /dados_modelos/);
  assert.equal(passo(p, 'robo-sofia').acao, 'nada');
  assert.match(passo(p, 'robo-sofia').itens[0]!, /NÃO é criado nem ligado/);
});

test('--aplicar --so-crm sobre unidade ATIVA com campos vazios: NENHUMA escrita em units, na Sofia nem nos aprendizados; o CRM é gravado (config, automações em seco)', async () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const plano = montarPlano(q, u.estadoAtual(), { molde: MOLDE, soCrm: true });
  const antes = JSON.stringify(u.campos);
  const resultados = await executarPlano(plano, q, { banco: u.banco, molde: MOLDE, soCrm: true, dizer: () => undefined, confirmar: async () => true });
  const nomes = u.escritas.map((e) => e[0]);
  for (const proibida of ['gravarUnidade', 'gravarSofia', 'licoes.criar', 'licoes.marcarImportado']) assert.ok(!nomes.includes(proibida), `escreveu ${proibida}: ${JSON.stringify(u.escritas)}`);
  assert.equal(JSON.stringify(u.campos), antes, 'a linha da unidade ficou byte a byte igual');
  // o CRM foi gravado: config nova + automações em seco
  assert.ok(nomes.includes('gravarConfigChatwoot'));
  assert.ok(nomes.includes('criarAutomacoesEmSeco'));
  const seco = u.escritas.find((e) => e[0] === 'criarAutomacoesEmSeco')![1] as { ids: string[] };
  assert.ok(seco.ids.length >= 6 && seco.ids.every((id) => id.startsWith('chatwoot-')));
  // nenhum `null` e nada de «ligado»
  assert.ok(!JSON.stringify(u.escritas).includes('"ligado"'));
  assert.equal(sit(resultados, 'unidade'), 'nada-a-fazer');
  assert.equal(sit(resultados, 'sofia'), 'nada-a-fazer');
  assert.equal(sit(resultados, 'config-chatwoot'), 'feito');
});

test('plano VELHO (feito sem a flag, unidade ativada depois): o EXECUTOR com --so-crm também não escreve em units nem na Sofia', async () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const planoVelho = montarPlano(q, {}, { molde: MOLDE }); // «criar» tudo, sem ler o banco
  const res = await executarPlano(planoVelho, q, { banco: u.banco, molde: MOLDE, soCrm: true, dizer: () => undefined, confirmar: async () => true });
  const nomes = u.escritas.map((e) => e[0]);
  for (const proibida of ['gravarUnidade', 'gravarSofia', 'licoes.criar', 'licoes.marcarImportado']) assert.ok(!nomes.includes(proibida), `escreveu ${proibida}`);
  assert.equal(sit(res, 'unidade'), 'feito');
  assert.equal(sit(res, 'sofia'), 'feito');
});

test('--so-crm numa unidade que não existe: o executor FALHA e não cria nem a linha vazia', async () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const plano = montarPlano(q, u.estadoAtual(), { molde: MOLDE, soCrm: true }); // plano velho: a unidade existia quando ele foi feito
  u.banco.lerUnidade = async () => null; // e agora não existe mais
  const res = await executarPlano(plano, q, { banco: u.banco, molde: MOLDE, soCrm: true, dizer: () => undefined, confirmar: async () => true });
  assert.ok(res.some((r) => r.situacao === 'falhou'));
  assert.ok(!u.escritas.some((e) => e[0] === 'gravarUnidade'), 'nunca cria unidade');
});

test('--so-crm não combina com --sobrescrever, --sobrescrever-prompt, --reimportar-aprendizados nem --ligar-robo: o plano e o executor recusam (uma regra só, conflitoDoSoCrm)', async () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  assert.equal(conflitoDoSoCrm({ soCrm: true }), null);
  assert.equal(conflitoDoSoCrm({ sobrescrever: true }), null, 'sem --so-crm não há conflito (a regra é do modo)');
  for (const [flag, texto] of [['sobrescrever', '--sobrescrever'], ['sobrescreverPrompt', '--sobrescrever-prompt'], ['reimportarAprendizados', '--reimportar-aprendizados'], ['ligarRobo', '--ligar-robo']] as const) {
    assert.match(conflitoDoSoCrm({ soCrm: true, [flag]: true })!, new RegExp(`não combina com ${texto}`));
  }
  assert.throws(() => montarPlano(q, u.estadoAtual(), { molde: MOLDE, soCrm: true, sobrescrever: true }), /não combina com --sobrescrever/);
  const plano = montarPlano(q, u.estadoAtual(), { molde: MOLDE, soCrm: true });
  for (const extra of [{ sobrescrever: true }, { sobrescreverPrompt: true }, { reimportarAprendizados: true }, { ligarRobo: true }]) {
    await assert.rejects(executarPlano(plano, q, { banco: u.banco, molde: MOLDE, soCrm: true, ...extra, dizer: () => undefined, confirmar: async () => true }), /não combina com/);
  }
  assert.equal(u.escritas.length, 0);
});

test('--so-crm: nenhum aviso do plano aponta --sobrescrever para a Sofia (em Marabá a flag destruiria a Sofia no ar)', () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  // a Sofia viva difere do questionário (como em Marabá: persona e fontes escritas à mão na unidade)
  const estado = u.estadoAtual() as any;
  estado.banco = { ...estado.banco, sofia: { ...(estado.banco?.sofia ?? {}), personaAgentName: 'Sofia de Marabá', sourceNegocio: 'texto vivo da unidade', systemPrompt: 'prompt vivo' } };
  const p = montarPlano(q, estado, { molde: MOLDE, soCrm: true });
  const sofia = passo(p, 'sofia');
  assert.equal(sofia.acao, 'nada');
  assert.ok(!sofia.avisos.some((a) => /--sobrescrever/.test(a)), `aviso da Sofia não pode sugerir --sobrescrever: ${sofia.avisos.join(' | ')}`);
  // unidade ATIVA sem a flag (o caso de Marabá rodado sem --so-crm): a Sofia também não pode sugerir --sobrescrever
  const ativaSemFlag = montarPlano(q, estado, { molde: MOLDE });
  assert.ok(!passo(ativaSemFlag, 'sofia').avisos.some((a) => /--sobrescrever/.test(a)), `ativa sem flag: ${passo(ativaSemFlag, 'sofia').avisos.join(' | ')}`);
  // unidade INATIVA sem a flag: o aviso continua (lá o --sobrescrever é o caminho normal)
  const inativa = { ...estado, banco: { ...estado.banco, unidade: { ...estado.banco.unidade, campos: { ...estado.banco.unidade.campos, isActive: false } } } };
  assert.ok(passo(montarPlano(q, inativa, { molde: MOLDE }), 'sofia').avisos.some((a) => /já preenchidos e diferentes/.test(a)), 'inativa: o aviso segue');
});

test('--so-crm: a config do CRM que já existe e difere não sugere --sobrescrever (a flag é recusada nesse modo)', () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const estado = u.estadoAtual() as any;
  estado.banco = { ...estado.banco, configChatwoot: { ...(estado.banco?.configChatwoot ?? {}), subdominio: 'outrosubdominio', prefixoModelos: 'outro_' } };
  const cfg = passo(montarPlano(q, estado, { molde: MOLDE, soCrm: true }), 'config-chatwoot');
  assert.ok(cfg.avisos.some((a) => /já preenchidos e diferentes/.test(a)), `avisa a divergência: ${cfg.avisos.join(' | ')}`);
  assert.ok(!cfg.avisos.some((a) => /--sobrescrever/.test(a)), `sem sugerir a flag: ${cfg.avisos.join(' | ')}`);
});
