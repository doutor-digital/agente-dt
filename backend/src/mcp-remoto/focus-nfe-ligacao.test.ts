import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusLigado, ligarFocus, type DepsDaLigacao } from './focus-nfe-ligacao.js';
import { listarIntegracoes } from './integracoes.js';

function deps() {
  const rotas: string[] = [];
  const consultas: string[] = [];
  const avisos: object[] = [];
  const d: DepsDaLigacao = {
    app: { post: (r: string) => rotas.push(r) } as never,
    prisma: {
      unit: { findMany: async () => (consultas.push('unit'), [{ slug: 'doutor-hernia-acailandia', name: 'Açailândia', isActive: true }]) },
      focusNota: new Proxy({}, { get: () => async () => (consultas.push('focusNota'), []) }),
      $transaction: async () => (consultas.push('tx'), undefined),
    } as never,
    alertar: async () => true,
    log: { info: () => undefined, warn: (o) => avisos.push(o), debug: () => undefined },
  };
  return { d, rotas, consultas, avisos };
}

test('SEM variáveis: nada acontece — nenhuma rota, nenhuma consulta ao banco, nenhuma ferramenta (idêntico a antes)', async () => {
  for (const env of [{}, { FOCUS_NFE_UNIDADES: '' }, { FOCUS_NFE_UNIDADES: '*' }, { FOCUS_NFE_TOKEN_ACAILANDIA: 'TOKENdeTESTE1234567890abcdefghij' }]) {
    const { d, rotas, consultas } = deps();
    assert.equal(focusLigado(env), false);
    assert.equal(ligarFocus(d, env), null);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([rotas, consultas], [[], []]);
  }
});

test('só o token, sem a lista FOCUS_NFE_UNIDADES, continua desligado (token sozinho não liga nada)', () => {
  assert.equal(focusLigado({ FOCUS_NFE_TOKEN_ACAILANDIA: 'TOKENdeTESTE1234567890abcdefghij', FOCUS_NFE_AMBIENTE_ACAILANDIA: 'producao' }), false);
});

test('ligada: carrega a conta do ambiente (homologação por padrão), monta a rota SÓ com o segredo e registra as ferramentas só para escritor', async () => {
  const env = { FOCUS_NFE_UNIDADES: 'doutor-hernia-acailandia', FOCUS_NFE_TOKEN_ACAILANDIA: 'TOKENdeTESTE1234567890abcdefghij', FOCUS_NFE_WEBHOOK_SEGREDO: 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres' };
  const { d, rotas } = deps();
  const f = ligarFocus(d, env)!;
  assert.ok(f);
  assert.deepEqual(rotas, ['/focus-nfe/webhook/:unidade/:assinatura']);
  for (let i = 0; i < 50 && f.contas().size === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([...f.contas().keys()], ['doutor-hernia-acailandia']);
  assert.equal(f.contas().get('doutor-hernia-acailandia')!.ambiente, 'homologacao');
  assert.equal(f.ctx.webhookConfigurado, true);
  const nomes: string[] = [];
  const server = { registerTool: (n: string) => nomes.push(n) } as never;
  assert.equal(f.registrar(server, 'leitor', new Set(['outro']), (() => undefined) as never), false);
  assert.equal(nomes.length, 0);
  assert.equal(f.registrar(server, 'u1', new Set(['u1']), (() => undefined) as never), true);
  assert.equal(nomes.length, 5);
});

test('ligada SEM segredo do webhook: a rota não é montada e o log avisa', () => {
  const { d, rotas, avisos } = deps();
  ligarFocus(d, { FOCUS_NFE_UNIDADES: 'doutor-hernia-acailandia', FOCUS_NFE_TOKEN_ACAILANDIA: 'TOKENdeTESTE1234567890abcdefghij' });
  assert.deepEqual(rotas, []);
  assert.ok(avisos.length >= 1);
});

test('listar_integracoes: sem Focus a resposta é idêntica à de antes; com Focus (só para escritor) aparece focus_*', () => {
  const base = { franquia: new Map([['a', { nome: 'A' }]]), kommo: new Map(), bling: new Map() };
  const sem = listarIntegracoes(base);
  const semExplicito = listarIntegracoes({ ...base, focus: new Map() });
  assert.deepEqual(sem, semExplicito);
  assert.ok(!JSON.stringify(sem).includes('focus'));
  const com = listarIntegracoes({ ...base, focus: new Map([['a', { nome: 'A' }]]) });
  assert.equal((com as { comFocus?: number }).comFocus, 1);
  assert.ok(JSON.stringify(com).includes('focus_*'));
  // o ambiente que aparece é o REAL da unidade, nunca um texto fixo
  const textoDe = (ambiente: 'homologacao' | 'producao') => JSON.stringify(listarIntegracoes({ ...base, focus: new Map([['a', { nome: 'A', ambiente }]]) }));
  assert.match(textoDe('producao'), /ambiente desta unidade agora: PRODUÇÃO \(nota REAL\)/);
  assert.match(textoDe('homologacao'), /ambiente desta unidade agora: HOMOLOGAÇÃO \(teste, sem validade fiscal\)/);
  assert.ok(!textoDe('producao').includes('só em ambiente de HOMOLOGAÇÃO'));
});
