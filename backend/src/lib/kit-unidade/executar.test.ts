import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { executarPlano, relatorioFinal, type BancoPorta } from './executar.js';
import { montarPlano } from './plano.js';
import { lerQuestionario, type Questionario } from './questionario.js';
import { AUTOMACOES } from '../automacoes.js';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const MOLDE = readFileSync(join(OPS, 'molde-sofia/bloco-conversa.md'), 'utf8');
const r = lerQuestionario(readFileSync(join(OPS, 'questionario.exemplo.yaml'), 'utf8'));
assert.ok(r.ok);
const Q: Questionario = r.q;
const SECO_CHATWOOT = AUTOMACOES.filter((a) => a.id.startsWith('chatwoot-') && a.temSeco).map((a) => a.id);

/** Banco de mentira que guarda o que lhe mandaram. */
function bancoFalso(init: { automacoes?: string[]; sofia?: Record<string, unknown>; existe?: boolean; falhaEm?: keyof BancoPorta } = {}) {
  const chamadas: Array<[string, unknown]> = [];
  const quebra = (nome: keyof BancoPorta) => {
    if (init.falhaEm === nome) throw new Error(`banco caiu em ${nome}`);
  };
  const banco: BancoPorta = {
    async gravarUnidade(slug, nome, campos) {
      quebra('gravarUnidade');
      chamadas.push(['gravarUnidade', { slug, nome, campos }]);
      return { id: 'u1', criada: !init.existe };
    },
    async gravarConfigChatwoot(unitId, cfg) {
      quebra('gravarConfigChatwoot');
      chamadas.push(['gravarConfigChatwoot', { unitId, cfg }]);
    },
    async automacoesDaUnidade() {
      return init.automacoes ?? [];
    },
    async criarAutomacoesEmSeco(unitId, ids) {
      chamadas.push(['criarAutomacoesEmSeco', { unitId, ids }]);
    },
    async sofiaDaUnidade() {
      return init.sofia ?? {};
    },
    async gravarSofia(unitId, campos) {
      chamadas.push(['gravarSofia', { unitId, campos }]);
    },
  };
  return { banco, chamadas };
}

async function rodar(banco: BancoPorta, o: { sim?: boolean; recusar?: string[]; sobrescreverPrompt?: boolean } = {}) {
  const plano = montarPlano(Q, {}, { molde: MOLDE });
  const linhas: string[] = [];
  const perguntou: string[] = [];
  const resultados = await executarPlano(plano, Q, {
    banco,
    molde: MOLDE,
    sobrescreverPrompt: o.sobrescreverPrompt,
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

test('passos que dependem de API externa PARAM no esqueleto (e dizem isso); os manuais ficam como manual', async () => {
  const { banco, chamadas } = bancoFalso();
  const { resultados, plano, linhas } = await rodar(banco);
  for (const id of ['etiquetas', 'atributos', 'caixa', 'time', 'atendentes', 'pastas', 'mensagens-prontas', 'modelos', 'dataset-capi', 'subdominio']) assert.equal(sit(resultados, id), 'esqueleto', id);
  for (const id of ['automacoes-conta', 'numero', 'segredos', 'franquia']) assert.equal(sit(resultados, id), 'manual', id);
  // os que dependem de um passo de esqueleto também são esqueleto (não rodam), não «feito»
  for (const id of ['registrar-caixa', 'robo-sofia', 'usuario-celular']) assert.equal(sit(resultados, id), 'esqueleto', id);
  assert.ok(linhas.some((l) => /não implementado nesta fase/.test(l)));
  const rel = relatorioFinal(plano, resultados);
  assert.match(rel, /PENDENTE \(esqueleto, Fase 2\)/);
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
