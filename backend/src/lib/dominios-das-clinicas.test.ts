/**
 * O ENDEREÇO da clínica existe desde que a conta foi criada: a origem dele é aceita pelas telas por iframe e o menu.js sabe a conta dele, MESMO sem caixa
 * (configuração inerte: Timbó, conta 3, 25/11/2026). Aceitar o endereço não torna a configuração válida para os workers.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const U = await import('./chatwoot-unidades.js');
const { origensDoChatwoot } = await import('./origens-do-chatwoot.js');

const dados = { nome: 'Doutor Hérnia Timbó', cidade: 'Timbó', endereco: 'Rua A, 1 — Centro, Timbó/SC, 89120-000', mapa: 'https://maps.example/timbo' };
// a linha como o banco devolve: conta 3, subdomínio, e NENHUMA caixa (criada com --so-crm --sem-caixa)
const linhaTimbo = { unitId: 'u-timbo', contaId: 3, subdominio: 'drtimbo', prefixoModelos: 'timbo_', usuarioCelularId: null, gerenteId: null, metaAgendamentosDia: null, kapsoPhoneNumberId: null, wabaId: null, envSufixo: 'TIMBO', dadosModelos: dados, unit: { slug: 'doutor-hernia-timbo' }, caixas: [] };

afterEach(() => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  U.aplicarDominios([]);
});

test('unidade SEM caixa: o endereço entra nas origens aceitas e no mapa subdomínio → conta, e a configuração continua inerte (fora de configDaUnidade e dos mapas de caixa)', () => {
  const cfg = U.configDaLinha(linhaTimbo as never);
  assert.ok(U.problemasDaConfig(cfg).includes('sem nenhuma caixa'), 'a config é inválida/inerte');
  U.aplicarConfigs(U.mesclarComSemente([cfg]));
  U.aplicarDominios([linhaTimbo]);
  assert.equal(U.configDaUnidade('doutor-hernia-timbo'), undefined, 'os workers continuam ignorando a inerte');
  assert.deepEqual(Object.keys(U.CAIXAS_REGUA).map(Number).filter((c) => U.CAIXAS_REGUA[c] === 'doutor-hernia-timbo'), []);
  assert.ok(U.origensDasClinicas().includes('https://drtimbo.doutordigitalconsultoria.com'));
  assert.ok(origensDoChatwoot({ CHATWOOT_URL: 'https://atendimento.doutordigitalconsultoria.com', CHATWOOT_TOKEN: 'x', CHATWOOT_CONTA_ID: '1' } as NodeJS.ProcessEnv).includes('https://drtimbo.doutordigitalconsultoria.com'), 'origem aceita pelas telas e pelo CORS (server.ts usa origensDoChatwoot)');
});

test('sem a linha crua, a inerte NÃO entra (o registro vem do banco, não de adivinhação)', () => {
  U.aplicarConfigs(U.mesclarComSemente([U.configDaLinha(linhaTimbo as never)]));
  assert.ok(!U.origensDasClinicas().some((o) => o.includes('drtimbo')));
});

test('subdomínio fora do formato (porta, caminho, maiúscula, curto) nunca vira origem', () => {
  U.aplicarDominios([{ subdominio: 'ruim.com/x', contaId: 4 }, { subdominio: 'Maiuscula', contaId: 5 }, { subdominio: 'ab', contaId: 6 }, { subdominio: 'otimo', contaId: 7 }, { subdominio: null, contaId: 8 }]);
  assert.deepEqual(U.origensDasClinicas().filter((o) => !o.includes('drherniaparauapebas')), ['https://otimo.doutordigitalconsultoria.com']);
});

test('o leitor do banco (recarregarConfigChatwoot) registra o endereço da linha inerte, e a releitura sem a linha o tira', async () => {
  const { recarregarConfigChatwoot } = await import('./chatwoot-unidades-banco.js');
  const { prisma } = await import('./prisma.js');
  const p = prisma as unknown as { unitChatwoot: unknown };
  const antes = p.unitChatwoot;
  try {
    p.unitChatwoot = { findMany: async () => [linhaTimbo] };
    await recarregarConfigChatwoot();
    assert.ok(U.origensDasClinicas().includes('https://drtimbo.doutordigitalconsultoria.com'));
    assert.equal(U.configDaUnidade('doutor-hernia-timbo'), undefined, 'continua inerte');
    // linha rejeitada por OUTRO motivo (subdomínio ok, mas conta inválida) não vira origem confiável
    p.unitChatwoot = { findMany: async () => [{ ...linhaTimbo, contaId: -4 }] };
    await recarregarConfigChatwoot();
    assert.ok(!U.origensDasClinicas().some((o) => o.includes('drtimbo')), 'só entra linha válida ou inerte por falta de caixa');
    p.unitChatwoot = { findMany: async () => [] };
    await recarregarConfigChatwoot();
    assert.ok(!U.origensDasClinicas().some((o) => o.includes('drtimbo')));
  } finally {
    p.unitChatwoot = antes;
  }
});

test('linha em CONFLITO (a mesma que o sistema descarta com «configuração ignorada») NÃO vira origem: prefixo de outra unidade ou caixa repetida (sonda do sênior)', async () => {
  const { recarregarConfigChatwoot } = await import('./chatwoot-unidades-banco.js');
  const { prisma } = await import('./prisma.js');
  const p = prisma as unknown as { unitChatwoot: unknown };
  const antes = p.unitChatwoot;
  const caixa = [{ caixaId: 9901, tipo: 'cloud', instanciaEvolution: null }];
  // VÁLIDA sozinha, mas reusa o prefixo de Parauapebas → descartada por conflito
  const prefixoRepetido = { ...linhaTimbo, unitId: 'u-x', contaId: 7, subdominio: 'drconflito', prefixoModelos: U.SEMENTE_PARAUAPEBAS.prefixoModelos, envSufixo: 'CONFLITO', unit: { slug: 'doutor-hernia-conflito' }, caixas: caixa };
  // INERTE (sem caixa) mas com o prefixo de Parauapebas → também conflita
  const inertaComPrefixoRepetido = { ...linhaTimbo, unitId: 'u-y', subdominio: 'drinerteconflito', prefixoModelos: U.SEMENTE_PARAUAPEBAS.prefixoModelos, envSufixo: 'INERTE', unit: { slug: 'doutor-hernia-inerte' } };
  // caixa repetida de Parauapebas (id 3)
  const caixaRepetida = { ...linhaTimbo, unitId: 'u-z', contaId: 8, subdominio: 'drcaixarepetida', prefixoModelos: 'zeta_', envSufixo: 'ZETA', unit: { slug: 'doutor-hernia-zeta' }, caixas: [{ caixaId: 3, tipo: 'cloud', instanciaEvolution: null }] };
  try {
    p.unitChatwoot = { findMany: async () => [prefixoRepetido, inertaComPrefixoRepetido, caixaRepetida, linhaTimbo] };
    await recarregarConfigChatwoot();
    assert.equal(U.configDaUnidade('doutor-hernia-conflito'), undefined, 'descartada');
    const o = U.origensDasClinicas().join(' ');
    assert.ok(!o.includes('drconflito'), 'a linha descartada por prefixo repetido não vira origem');
    assert.ok(!o.includes('drinerteconflito'), 'a inerte com prefixo de outra unidade também não');
    assert.ok(!o.includes('drcaixarepetida'), 'nem a de caixa repetida');
    assert.ok(o.includes('drtimbo'), 'a inerte sem conflito (Timbó) continua entrando');
    assert.ok(!U.dominiosDasClinicas(1)['drconflito'] && !U.dominiosDasClinicas(1)['drinerteconflito'], 'e o mapa subdomínio → conta (menu.js) também não leva as descartadas');
    assert.equal(U.dominiosDasClinicas(1)['drtimbo'], 3, 'mas leva Timbó → conta 3');
  } finally {
    p.unitChatwoot = antes;
  }
});
