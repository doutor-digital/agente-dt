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
import { montarPlano, textoDoPlano, type EstadoAtual } from './plano.js';
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

test('--so-crm no seco offline (sem banco): não finge que cria a unidade e avisa que exige unidade existente', () => {
  const p = montarPlano(questionario(), {}, { molde: MOLDE, soCrm: true });
  assert.equal(passo(p, 'unidade').acao, 'nada');
  assert.ok(passo(p, 'unidade').avisos.some((a) => /exige que a unidade já exista/.test(a)));
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
  u.banco.lerUnidade = async () => null;
  const plano = montarPlano(q, {}, { molde: MOLDE, soCrm: true });
  const res = await executarPlano(plano, q, { banco: u.banco, molde: MOLDE, soCrm: true, dizer: () => undefined, confirmar: async () => true });
  assert.ok(res.some((r) => r.situacao === 'falhou'));
  assert.ok(!u.escritas.some((e) => e[0] === 'gravarUnidade'), 'nunca cria unidade');
});

test('--so-crm e --sobrescrever não combinam: o executor recusa antes de qualquer passo', async () => {
  const q = questionario();
  const u = unidadeAtiva(q);
  const plano = montarPlano(q, u.estadoAtual(), { molde: MOLDE, soCrm: true });
  await assert.rejects(executarPlano(plano, q, { banco: u.banco, molde: MOLDE, soCrm: true, sobrescrever: true, dizer: () => undefined, confirmar: async () => true }), /não combina com --sobrescrever/);
  assert.equal(u.escritas.length, 0);
});
