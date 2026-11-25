/**
 * Unidade que saiu da Kommo (corte de Timbó, 25/11/2026): a trava «cartão ATIVO no Kommo» não pode mais calar a Sofia do CRM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { kommoCortado, confereCartaoNoKommo, tratamentoNaFranquia } = await import('./kommo-cortado.js');
const IA = await import('./chatwoot-ia.js');
const R = await import('./chatwoot-regua-worker.js');
const TIMBO = 'doutor-hernia-timbo';

test('kommoCortado: só o slug da lista; espaços e vírgulas sobrando não atrapalham; lista vazia ou sem slug = não cortado', () => {
  assert.equal(kommoCortado(TIMBO, 'doutor-hernia-timbo'), true);
  // maiúscula na variável (erro de digitação) não deixa a unidade calada sem aviso
  assert.equal(kommoCortado(TIMBO, 'Doutor-Hernia-Timbo'), true);
  assert.equal(kommoCortado(TIMBO, ' doutor-hernia-salto , doutor-hernia-timbo ,'), true);
  assert.equal(kommoCortado('doutor-hernia-salto', 'doutor-hernia-timbo'), false);
  // não casa pedaço do nome
  assert.equal(kommoCortado('doutor-hernia-tim', 'doutor-hernia-timbo'), false);
  assert.equal(kommoCortado(TIMBO, ''), false);
  assert.equal(kommoCortado(TIMBO, undefined), false);
  assert.equal(kommoCortado(null, 'doutor-hernia-timbo'), false);
  assert.equal(kommoCortado('', 'doutor-hernia-timbo'), false);
});

test('kommoCortado: sem segundo argumento lê CHATWOOT_KOMMO_CORTADO_SLUGS', () => {
  const antes = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
  try {
    process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = TIMBO;
    assert.equal(kommoCortado(TIMBO), true);
    delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    assert.equal(kommoCortado(TIMBO), false);
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    else process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = antes;
  }
});

test('Sofia do CRM (cartaoNoKommoDaIa): unidade cortada NÃO consulta a Kommo; unidade não cortada consulta 1 vez e o cartão vale', async () => {
  const consultas: string[] = [];
  const consultar = (u: { slug: string }) => async (telefone: string) => {
    consultas.push(`${u.slug}|${telefone}`);
    return { leadId: 777 };
  };
  const unidade = (slug: string) => ({ id: 'u1', slug, kommoSubdomain: 'clinica', kommoAccessToken: 'tok-kommo' }) as never;
  const antes = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
  try {
    process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = TIMBO;
    assert.equal(await IA.cartaoNoKommoDaIa(unidade(TIMBO), '5547999990001', consultar as never), null);
    assert.deepEqual(consultas, [], 'unidade cortada não pode consultar a Kommo');
    assert.deepEqual(await IA.cartaoNoKommoDaIa(unidade('doutor-hernia-salto'), '5515999990001', consultar as never), { leadId: 777 });
    assert.deepEqual(consultas, ['doutor-hernia-salto|5515999990001']);
    // sem a variável: Timbó volta a consultar (comportamento de antes)
    delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    assert.deepEqual(await IA.cartaoNoKommoDaIa(unidade(TIMBO), '5547999990001', consultar as never), { leadId: 777 });
    assert.equal(consultas.length, 2);
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    else process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = antes;
  }
});

test('régua (kommoDaRegua): unidade cortada fica SEM conferidor do Kommo; não cortada recebe o conferidor; sem token, nenhum', () => {
  const fabricados: string[] = [];
  const conferidor = async () => null;
  const fabricar = (u: { slug?: string }) => {
    fabricados.push(String(u.slug));
    return conferidor;
  };
  const unidade = (slug: string, token: string | null = 'tok') => ({ slug, kommoSubdomain: 'clinica', kommoAccessToken: token }) as never;
  const antes = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
  try {
    process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = TIMBO;
    assert.equal(R.kommoDaRegua(unidade(TIMBO), fabricar as never), undefined);
    assert.equal(R.kommoDaRegua(unidade('doutor-hernia-salto'), fabricar as never), conferidor);
    assert.equal(R.kommoDaRegua(unidade('doutor-hernia-salto', null), fabricar as never), undefined);
    assert.deepEqual(fabricados, ['doutor-hernia-salto']);
    delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    assert.equal(R.kommoDaRegua(unidade(TIMBO), fabricar as never), conferidor);
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    else process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = antes;
  }
});

test('tratamentoNaFranquia: paciente com tratamento ativo OU sessão futura cala; franquia que não conferiu cala; lead, não achado e paciente sem nada seguem', () => {
  assert.match(String(tratamentoNaFranquia({ tipo: 'paciente', idClient: 42, tratamentoAtivo: true, sessaoFutura: false })), /idClient 42\) com tratamento ativo$/);
  assert.match(String(tratamentoNaFranquia({ tipo: 'paciente', idClient: 42, tratamentoAtivo: false, sessaoFutura: true })), /com sessão futura$/);
  assert.match(String(tratamentoNaFranquia({ tipo: 'paciente', idClient: 42, tratamentoAtivo: true, sessaoFutura: true })), /tratamento ativo \+ sessão futura$/);
  assert.equal(tratamentoNaFranquia({ tipo: 'paciente', idClient: 42, tratamentoAtivo: false, sessaoFutura: false }), null);
  // avaliou há pouco (corte de Timbó 25/11: avaliou de manhã e à tarde a Sofia o tratou como lead): cala
  assert.match(String(tratamentoNaFranquia({ tipo: 'paciente', idClient: 42, tratamentoAtivo: false, sessaoFutura: false, avaliacaoRecente: true })), /avaliação\/retorno nos últimos 60 dias$/);
  assert.equal(tratamentoNaFranquia({ tipo: 'paciente', idClient: 42, tratamentoAtivo: false, sessaoFutura: false, avaliacaoRecente: false }), null);
  assert.equal(tratamentoNaFranquia({ tipo: 'lead' }), null);
  assert.equal(tratamentoNaFranquia({ tipo: 'nao_achou' }), null);
  // índice vencido / não carregado (telefone NÃO achado), telefone ilegível, unidade sem franquia: segue
  assert.equal(tratamentoNaFranquia({ tipo: 'indisponivel', motivo: 'índice de telefones vencido (40 h)' }), null);
  assert.equal(tratamentoNaFranquia({ tipo: 'indisponivel', motivo: 'índice de telefones da franquia ainda não carregado' }), null);
  assert.equal(tratamentoNaFranquia({ tipo: 'indisponivel', motivo: 'telefone ilegível' }), null);
  assert.equal(tratamentoNaFranquia({ tipo: 'indisponivel', motivo: 'unidade sem franquia conectada' }), null);
  // a franquia NÃO conferiu (paciente achado e ficha que não veio, estouro do tempo, erro): cala — melhor calar que errar
  assert.match(String(tratamentoNaFranquia({ tipo: 'indisponivel', motivo: 'ficha do paciente não veio' })), /^não consegui conferir na franquia/);
  assert.match(String(tratamentoNaFranquia({ tipo: 'indisponivel', motivo: 'Error: timeout de 3000 ms' })), /^não consegui conferir na franquia/);
  assert.match(String(tratamentoNaFranquia({ tipo: 'indisponivel', motivo: 'paciente no índice sem id' })), /^não consegui conferir na franquia/);
});

test('confereCartaoNoKommo: confere só com Kommo configurado e unidade NÃO cortada (a mesma regra na Sofia e na régua)', () => {
  const com = { slug: TIMBO, kommoSubdomain: 'clinica', kommoAccessToken: 'tok' };
  assert.equal(confereCartaoNoKommo(com, ''), true);
  assert.equal(confereCartaoNoKommo(com, 'doutor-hernia-salto'), true);
  assert.equal(confereCartaoNoKommo(com, TIMBO), false);
  assert.equal(confereCartaoNoKommo({ ...com, kommoAccessToken: null }, ''), false);
  assert.equal(confereCartaoNoKommo({ ...com, kommoSubdomain: '' }, ''), false);
});

test('perguntarTratamentoNaFranquia: pede a carga do índice ANTES de perguntar (na unidade cortada ninguém mais pede) e devolve o motivo', async () => {
  const ordem: string[] = [];
  const unidade = { id: 'u1', slug: TIMBO } as never;
  const motivo = await IA.perguntarTratamentoNaFranquia(unidade, '5547999990001', {
    agendar: () => void ordem.push('agendar'),
    consultar: (async () => (ordem.push('consultar'), { tipo: 'paciente', idClient: 9, tratamentoAtivo: true, sessaoFutura: false })) as never,
  });
  assert.deepEqual(ordem, ['agendar', 'consultar']);
  assert.match(String(motivo), /idClient 9\) com tratamento ativo/);
  // a carga que falha não impede a pergunta
  const r = await IA.perguntarTratamentoNaFranquia(unidade, '5547999990001', {
    agendar: () => {
      throw new Error('fila quebrada');
    },
    consultar: (async () => ({ tipo: 'nao_achou' })) as never,
  });
  assert.equal(r, null);
});
