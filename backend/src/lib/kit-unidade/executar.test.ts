import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { codigoDeSaida, executarPlano, relatorioFinal, type BancoPorta } from './executar.js';
import { montarPlano } from './plano.js';
import { lerQuestionario, type Questionario } from './questionario.js';
import { AUTOMACOES } from '../automacoes.js';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const MOLDE = readFileSync(join(OPS, 'molde-sofia/bloco-conversa.md'), 'utf8');
const r = lerQuestionario(readFileSync(join(OPS, 'questionario.exemplo.yaml'), 'utf8'));
assert.ok(r.ok);
const Q: Questionario = r.q;
const SECO_CHATWOOT = AUTOMACOES.filter((a) => a.id.startsWith('chatwoot-') && a.temSeco).map((a) => a.id);

/** Banco de mentira COM ESTADO: guarda o que lhe mandaram e responde as leituras com o que já foi gravado. */
function bancoFalso(init: { automacoes?: string[]; sofia?: Record<string, unknown>; existe?: boolean; falhaEm?: keyof BancoPorta; ativa?: boolean; campos?: Record<string, unknown>; config?: import('./executar.js').ConfigGravada | null } = {}) {
  const chamadas: Array<[string, unknown]> = [];
  const quebra = (nome: keyof BancoPorta) => {
    if (init.falhaEm === nome) throw new Error(`banco caiu em ${nome}`);
  };
  const estado = {
    unidade: init.existe || init.ativa ? { id: 'u1', ativa: !!init.ativa, campos: { ...(init.campos ?? {}), isActive: !!init.ativa } as Record<string, unknown> } : null,
    config: init.config ?? null,
    automacoes: [...(init.automacoes ?? [])],
    sofia: { ...(init.sofia ?? {}) } as Record<string, unknown>,
    caixas: [] as number[],
  };
  const banco: BancoPorta = {
    async lerUnidade() {
      return estado.unidade ? { ...estado.unidade, campos: { ...estado.unidade.campos } } : null;
    },
    async gravarUnidade(slug, nome, campos, soNaCriacao) {
      quebra('gravarUnidade');
      chamadas.push(['gravarUnidade', { slug, nome, campos, soNaCriacao }]);
      const criada = !estado.unidade;
      estado.unidade = { id: 'u1', ativa: estado.unidade?.ativa ?? false, campos: { ...(estado.unidade?.campos ?? { isActive: false }), ...(criada ? { ...soNaCriacao } : {}), ...campos } };
      return { id: 'u1', criada };
    },
    async lerConfigChatwoot() {
      return estado.config ? { ...estado.config, dadosModelos: { ...estado.config.dadosModelos } } : null;
    },
    async gravarConfigChatwoot(unitId, cfg, criar) {
      quebra('gravarConfigChatwoot');
      chamadas.push(['gravarConfigChatwoot', { unitId, cfg, criar }]);
      estado.config = criar ? (cfg as import('./executar.js').ConfigGravada) : { ...(estado.config as import('./executar.js').ConfigGravada), ...cfg };
    },
    async automacoesDaUnidade() {
      return [...estado.automacoes];
    },
    async criarAutomacoesEmSeco(unitId, ids) {
      chamadas.push(['criarAutomacoesEmSeco', { unitId, ids }]);
      estado.automacoes.push(...ids);
    },
    async sofiaDaUnidade() {
      return { ...estado.sofia, ...(estado.unidade?.campos ?? {}) };
    },
    async gravarSofia(unitId, campos) {
      chamadas.push(['gravarSofia', { unitId, campos }]);
      estado.sofia = { ...estado.sofia, ...campos };
      if (estado.unidade) estado.unidade.campos = { ...estado.unidade.campos, ...campos };
    },
    async caixasRegistradas() {
      return [...estado.caixas];
    },
    async registrarCaixa(unitId, caixa) {
      chamadas.push(['registrarCaixa', { unitId, caixa }]);
      if (!estado.caixas.includes(caixa.id)) estado.caixas.push(caixa.id);
    },
  };
  return { banco, chamadas, estado };
}

async function rodar(banco: BancoPorta, o: { sim?: boolean; recusar?: string[]; sobrescreverPrompt?: boolean; sobrescrever?: boolean; estado?: import('./plano.js').EstadoAtual } = {}) {
  const plano = montarPlano(Q, o.estado ?? {}, { molde: MOLDE, sobrescrever: o.sobrescrever });
  const linhas: string[] = [];
  const perguntou: string[] = [];
  const resultados = await executarPlano(plano, Q, {
    banco,
    molde: MOLDE,
    sobrescreverPrompt: o.sobrescreverPrompt,
    sobrescrever: o.sobrescrever,
    dizer: (l) => linhas.push(l),
    confirmar: async (p) => {
      perguntou.push(p.id);
      return !o.recusar?.includes(p.id);
    },
  });
  return { plano, resultados, linhas, perguntou };
}
const sit = (res: Array<{ id: string; situacao: string }>, id: string) => res.find((x) => x.id === id)?.situacao;

test('--aplicar: os passos de banco rodam NA ORDEM, cada um com confirmação, e a unidade nasce inativa-por-fora (sem ligar nada)', async () => {
  const { banco, chamadas } = bancoFalso();
  const { resultados, perguntou } = await rodar(banco);
  assert.deepEqual(perguntou, ['unidade', 'config-chatwoot', 'automacoes-seco', 'sofia']);
  assert.deepEqual(chamadas.map((c) => c[0]), ['gravarUnidade', 'gravarConfigChatwoot', 'criarAutomacoesEmSeco', 'gravarSofia']);
  const seco = chamadas[2]![1] as { ids: string[] };
  assert.deepEqual(seco.ids, SECO_CHATWOOT);
  // nenhuma chamada pede "ligado"
  assert.ok(!JSON.stringify(chamadas).includes('ligado'));
  assert.equal(sit(resultados, 'unidade'), 'feito');
  assert.equal(sit(resultados, 'automacoes-seco'), 'feito');
});

test('SEM as portas do Chatwoot/Kapso (sem token), os passos de fora do banco ficam BLOQUEADOS — nunca fingem que fizeram; os manuais ficam como manual', async () => {
  const { banco, chamadas } = bancoFalso();
  const { resultados, plano, linhas } = await rodar(banco);
  for (const id of ['conta', 'etiquetas', 'atributos', 'automacoes-conta', 'caixa', 'time', 'atendentes', 'mensagens-prontas', 'modelos', 'webhook', 'dashboard-app']) assert.equal(sit(resultados, id), 'bloqueado', id);
  for (const id of ['pastas', 'numero', 'dataset-capi', 'subdominio', 'segredos', 'franquia']) assert.equal(sit(resultados, id), 'manual', id);
  for (const id of ['registrar-caixa', 'robo-sofia', 'usuario-celular']) assert.equal(sit(resultados, id), 'bloqueado', id);
  assert.ok(linhas.some((l) => /sem acesso ao Chatwoot/.test(l)));
  const rel = relatorioFinal(plano, resultados);
  assert.match(rel, /BLOQUEADO/);
  assert.match(rel, /O QUE FALTA:/);
  assert.equal(chamadas.length, 4);
});

test('recusar uma etapa a pula e trava as que dependem dela', async () => {
  const { banco, chamadas } = bancoFalso();
  const { resultados } = await rodar(banco, { recusar: ['unidade'] });
  assert.equal(sit(resultados, 'unidade'), 'recusado');
  assert.equal(sit(resultados, 'config-chatwoot'), 'bloqueado');
  assert.equal(sit(resultados, 'automacoes-seco'), 'bloqueado');
  assert.equal(sit(resultados, 'sofia'), 'bloqueado');
  assert.equal(chamadas.length, 0);
});

test('falha de banco PARA a execução no passo, sem tentar os seguintes', async () => {
  const { banco, chamadas } = bancoFalso({ falhaEm: 'gravarConfigChatwoot' });
  const { resultados, plano } = await rodar(banco);
  assert.equal(sit(resultados, 'unidade'), 'feito');
  assert.equal(sit(resultados, 'config-chatwoot'), 'falhou');
  assert.equal(sit(resultados, 'automacoes-seco'), undefined);
  assert.deepEqual(chamadas.map((c) => c[0]), ['gravarUnidade']);
  assert.match(relatorioFinal(plano, resultados), /automacoes-seco\s+NÃO RODOU/);
});

test('idempotente: automação que já tem linha (qualquer estado) NÃO é tocada; só entra em seco quem não tem', async () => {
  const { banco, chamadas } = bancoFalso({ automacoes: ['chatwoot-regua', 'chatwoot-agenda'] });
  await rodar(banco);
  const seco = chamadas.find((c) => c[0] === 'criarAutomacoesEmSeco')![1] as { ids: string[] };
  assert.deepEqual(seco.ids, SECO_CHATWOOT.filter((id) => id !== 'chatwoot-regua' && id !== 'chatwoot-agenda'));
  const { banco: b2, chamadas: c2 } = bancoFalso({ automacoes: SECO_CHATWOOT });
  await rodar(b2);
  assert.ok(!c2.some((c) => c[0] === 'criarAutomacoesEmSeco'), 'todas já têm linha: nada a criar');
});

test('o systemPrompt que a unidade já tem NÃO é sobrescrito sem o pedido explícito', async () => {
  const { banco, chamadas } = bancoFalso({ existe: true, sofia: { systemPrompt: 'prompt antigo da unidade' } });
  const { resultados } = await rodar(banco);
  const gravados = (chamadas.find((c) => c[0] === 'gravarSofia')![1] as { campos: Record<string, unknown> }).campos;
  assert.ok(!('systemPrompt' in gravados));
  assert.ok('sourceProdutos' in gravados);
  assert.ok(resultados.find((x) => x.id === 'sofia')!.notas.some((n) => /JÁ tem systemPrompt/.test(n)));
  const { banco: b2, chamadas: c2 } = bancoFalso({ existe: true, sofia: { systemPrompt: 'prompt antigo da unidade' } });
  await rodar(b2, { sobrescreverPrompt: true });
  assert.ok('systemPrompt' in (c2.find((c) => c[0] === 'gravarSofia')![1] as { campos: Record<string, unknown> }).campos);
});

test('segredo do ambiente nunca chega ao banco, ao log nem ao relatório', async () => {
  process.env.META_ADS_TOKEN_PARAUAPEBAS = 'EAAG-SEGREDO-NAO-PODE-VAZAR-123456';
  process.env.FRANQUIA_TOKEN_PARAUAPEBAS = 'franquia-SEGREDO-NAO-PODE-VAZAR-654321';
  try {
    const { banco, chamadas } = bancoFalso();
    const { linhas, plano, resultados } = await rodar(banco);
    const tudo = JSON.stringify(chamadas) + linhas.join('\n') + relatorioFinal(plano, resultados);
    assert.ok(!tudo.includes('NAO-PODE-VAZAR'));
    // e os campos gravados em units não têm token/chave de API (só pixKey/pixHolder, que são dado de negócio do questionário)
    const unidade = (chamadas[0]![1] as { campos: Record<string, unknown> }).campos;
    assert.ok(!Object.keys(unidade).some((k) => /token|secret|apikey|password/i.test(k)));
  } finally {
    delete process.env.META_ADS_TOKEN_PARAUAPEBAS;
    delete process.env.FRANQUIA_TOKEN_PARAUAPEBAS;
  }
});

test('a categoria da unidade só é mandada para a CRIAÇÃO, nunca misturada nos campos do update', async () => {
  const { banco, chamadas } = bancoFalso();
  await rodar(banco);
  const u = chamadas[0]![1] as { campos: Record<string, unknown>; soNaCriacao: Record<string, unknown> };
  assert.deepEqual(u.soNaCriacao, { category: 'saude' });
  assert.ok(!('category' in u.campos));
});

// ── PROTEÇÃO DA UNIDADE QUE JÁ EXISTE (revisão do sênior no #341) ───────────────────────────────────────────────

import { SEMENTE_PARAUAPEBAS } from '../chatwoot-unidades.js';
import { camposDaSofia, camposDaUnidade } from './molde-sofia.js';
import type { EstadoAtual } from './plano.js';
import type { ConfigGravada } from './executar.js';

/** Parauapebas como ela é hoje: ATIVA, tudo preenchido (inclusive com valores que DIFEREM do questionário: a equipe editou). */
function parauapebas(ativa = true, vazios: string[] = []) {
  const campos: Record<string, unknown> = { ...camposDaUnidade(Q), ...camposDaSofia(Q, MOLDE).campos, clinicAddress: 'Rua C, 455-A (endereço que a equipe ajustou)', personaAgentName: 'Sofia (editada)', sourceNegocio: 'Texto do negócio que a equipe escreveu', spineLunchStart: '12:00' };
  for (const k of vazios) campos[k] = null;
  const config: ConfigGravada = { prefixoModelos: 'parau_', metaAgendamentosDia: 8, kapsoPhoneNumberId: SEMENTE_PARAUAPEBAS.kapsoPhoneNumberId, wabaId: SEMENTE_PARAUAPEBAS.wabaId, envSufixo: 'PARAUAPEBAS', dadosModelos: { ...SEMENTE_PARAUAPEBAS.dadosModelos, endereco: 'Endereço editado nos modelos' } };
  const f = bancoFalso({ existe: true, ativa, campos, config, automacoes: SECO_CHATWOOT, sofia: { systemPrompt: 'prompt de produção de Parauapebas' } });
  const snapshot = () => JSON.stringify([f.estado.unidade, f.estado.config, f.estado.automacoes, f.estado.sofia]);
  const estado = (): EstadoAtual => ({ banco: { unidade: { id: 'u1', campos: f.estado.unidade!.campos }, configChatwoot: f.estado.config, caixasRegistradas: [3], automacoes: Object.fromEntries(f.estado.automacoes.map((a) => [a, 'ligado'])), sofia: { ...f.estado.sofia, ...f.estado.unidade!.campos } } });
  return { ...f, snapshot, estado };
}

test('PARAUAPEBAS (ativa): o script recusa, NADA é gravado e os passos de banco ficam bloqueados — o Kapso, a WABA e a persona continuam como estão', async () => {
  const p = parauapebas();
  const antes = p.snapshot();
  const { resultados, linhas } = await rodar(p.banco, { estado: p.estado() });
  assert.equal(p.chamadas.length, 0, `nenhuma escrita: ${JSON.stringify(p.chamadas)}`);
  assert.equal(p.snapshot(), antes, 'o estado do banco é byte a byte o mesmo');
  assert.equal(sit(resultados, 'unidade'), 'bloqueado');
  for (const id of ['config-chatwoot', 'sofia']) assert.ok(['bloqueado', 'nada-a-fazer'].includes(sit(resultados, id)!), `${id}: ${sit(resultados, id)}`);
  assert.ok(['bloqueado', 'nada-a-fazer'].includes(sit(resultados, 'automacoes-seco')!), 'as automações já têm linha: nada a fazer');
  assert.ok(linhas.some((l) => /ATIVA/.test(l)));
  // e mesmo se o plano estivesse velho (a unidade foi ativada depois de planejar), o EXECUTOR confere de novo e recusa
  const p2 = parauapebas();
  const antes2 = p2.snapshot();
  const planoVelho = montarPlano(Q, {}, { molde: MOLDE });
  const res = await executarPlano(planoVelho, Q, { banco: p2.banco, molde: MOLDE, dizer: () => undefined, confirmar: async () => true });
  assert.equal(sit(res, 'unidade'), 'falhou');
  assert.equal(p2.chamadas.length, 0);
  assert.equal(p2.snapshot(), antes2);
});

test('unidade existente INATIVA com valores diferentes: só preenche campo vazio, nunca grava null e nunca troca Kapso/WABA/persona/fontes/endereço', async () => {
  const p = parauapebas(false, ['spineLunchStart', 'personaTone']);
  p.chamadas.length = 0;
  const antes = JSON.parse(p.snapshot()) as [{ campos: Record<string, unknown> }, unknown, unknown, Record<string, unknown>];
  const { resultados } = await rodar(p.banco, { estado: p.estado() });
  const gravacoes = p.chamadas.filter((c) => c[0] !== 'criarAutomacoesEmSeco');
  const json = JSON.stringify(gravacoes);
  assert.ok(!json.includes('null'), 'nunca grava null por cima de nada');
  const u = (gravacoes.find((c) => c[0] === 'gravarUnidade')![1] as { campos: Record<string, unknown> }).campos;
  assert.deepEqual(Object.keys(u).sort(), ['spineLunchStart'], 'só o campo que estava vazio na unidade (a persona é gravada no passo da Sofia)');
  for (const protegido of ['clinicAddress', 'name', 'personaAgentName', 'sourceNegocio', 'sourceProdutos', 'systemPrompt', 'kapsoPhoneNumberId', 'wabaId']) assert.ok(!(protegido in u), `${protegido} não pode ser trocado`);
  // a configuração do CRM: só pode entrar a CHAVE que faltava nos dados dos modelos (telefone, valores); Kapso, WABA, prefixo e meta não são tocados
  const cfg = gravacoes.find((c) => c[0] === 'gravarConfigChatwoot');
  if (cfg) {
    const parcial = (cfg[1] as { cfg: Record<string, unknown>; criar: boolean });
    assert.equal(parcial.criar, false);
    assert.deepEqual(Object.keys(parcial.cfg), ['subdominio', 'dadosModelos']);
    assert.equal((parcial.cfg.dadosModelos as Record<string, unknown>).endereco, 'Endereço editado nos modelos', 'o endereço dos modelos fica');
  }
  const depois = JSON.parse(p.snapshot()) as typeof antes;
  assert.equal((depois[1] as ConfigGravada).kapsoPhoneNumberId, SEMENTE_PARAUAPEBAS.kapsoPhoneNumberId);
  assert.equal((depois[1] as ConfigGravada).wabaId, SEMENTE_PARAUAPEBAS.wabaId);
  assert.equal((depois[1] as ConfigGravada).dadosModelos.endereco, 'Endereço editado nos modelos');
  assert.equal(depois[0]!.campos.clinicAddress, antes[0]!.campos.clinicAddress);
  assert.equal(depois[3]!.systemPrompt, 'prompt de produção de Parauapebas');
  assert.equal(sit(resultados, 'unidade'), 'feito');
});

test('config existente com Kapso/WABA vazios: preenche só eles, sem apagar o prefixo, a meta nem os dados dos modelos', async () => {
  const f = bancoFalso({ existe: true, config: { prefixoModelos: 'parau_', metaAgendamentosDia: 8, kapsoPhoneNumberId: null, wabaId: null, envSufixo: 'PARAUAPEBAS', dadosModelos: { nome: 'Doutor Hérnia Parauapebas', endereco: 'Endereço editado' } } });
  await rodar(f.banco);
  const c = f.chamadas.find((x) => x[0] === 'gravarConfigChatwoot')![1] as { cfg: Record<string, unknown>; criar: boolean };
  assert.equal(c.criar, false);
  assert.deepEqual(Object.keys(c.cfg).sort(), ['dadosModelos', 'kapsoPhoneNumberId', 'subdominio', 'wabaId']);
  assert.equal(f.estado.config!.prefixoModelos, 'parau_');
  assert.equal(f.estado.config!.metaAgendamentosDia, 8, 'a meta que já estava fica');
  assert.equal(f.estado.config!.dadosModelos.endereco, 'Endereço editado', 'o endereço já escrito nos modelos fica');
  assert.equal(f.estado.config!.dadosModelos.cidade, 'Parauapebas', 'a chave que faltava foi preenchida');
  assert.equal(f.estado.config!.kapsoPhoneNumberId, '1212928641906230');
});

test('--sobrescrever é a ÚNICA forma de trocar o que está preenchido e de tocar numa unidade ativa — e então troca', async () => {
  const p = parauapebas();
  const { resultados } = await rodar(p.banco, { estado: p.estado(), sobrescrever: true });
  assert.equal(sit(resultados, 'unidade'), 'feito');
  const u = (p.chamadas.find((c) => c[0] === 'gravarUnidade')![1] as { campos: Record<string, unknown> }).campos;
  assert.equal(u.clinicAddress, Q.unidade.endereco);
  assert.ok(!JSON.stringify(p.chamadas).includes('null'), 'mesmo com a flag, nunca grava null');
});

test('unidade NOVA: roda 2 vezes e a segunda não grava mais nada (idempotente)', async () => {
  const f = bancoFalso();
  await rodar(f.banco);
  const gravouNaPrimeira = f.chamadas.length;
  assert.ok(gravouNaPrimeira >= 4);
  f.chamadas.length = 0;
  const e: EstadoAtual = { banco: { unidade: { id: 'u1', campos: f.estado.unidade!.campos }, configChatwoot: f.estado.config, caixasRegistradas: [], automacoes: Object.fromEntries(f.estado.automacoes.map((a) => [a, 'seco'])), sofia: { ...f.estado.sofia, ...f.estado.unidade!.campos } } };
  await rodar(f.banco, { estado: e });
  assert.deepEqual(f.chamadas.filter((c) => c[0] !== 'gravarUnidade'), [], 'só a atualização da unidade (sem campo novo) pode aparecer');
  const u = f.chamadas.find((c) => c[0] === 'gravarUnidade');
  if (u) assert.deepEqual((u[1] as { campos: Record<string, unknown> }).campos, {}, 'e sem nenhum campo');
});

test('código de saída do --aplicar: 0 só quando nada foi recusado, bloqueado, falhou ou deixou de rodar (a clínica pela metade NÃO sai 0)', () => {
  const plano = { unidade: 'x', config: {} as never, relatorio: [], passos: ['unidade', 'webhook', 'time'].map((id) => ({ id, sistema: 'banco', titulo: id, acao: 'criar', itens: [], execucao: 'sim', avisos: [], depende: [] })) } as never;
  const r = (id: string, situacao: string) => ({ id, situacao, notas: [] }) as never;
  assert.equal(codigoDeSaida(plano, [r('unidade', 'feito'), r('webhook', 'nada-a-fazer'), r('time', 'manual')]), 0);
  assert.equal(codigoDeSaida(plano, [r('unidade', 'feito'), r('webhook', 'recusado'), r('time', 'feito')]), 3, 'respondeu «não» a uma etapa');
  assert.equal(codigoDeSaida(plano, [r('unidade', 'feito'), r('webhook', 'bloqueado'), r('time', 'feito')]), 3, 'etapa bloqueada');
  assert.equal(codigoDeSaida(plano, [r('unidade', 'feito'), r('webhook', 'feito')]), 3, 'a execução parou antes (etapa que não rodou)');
  assert.equal(codigoDeSaida(plano, [r('unidade', 'falhou'), r('webhook', 'recusado'), r('time', 'feito')]), 1, 'falha vence');
});
