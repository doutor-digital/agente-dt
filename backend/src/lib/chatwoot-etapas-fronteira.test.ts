/**
 * Etapas por conta, a FRONTEIRA: o que o Chatwoot de uma conta com etapas próprias (Timbó = nomes da Kommo) devolve vira PAPEL antes de a régua, a
 * Sofia, a agenda, o CAPI, o Hoje e o gestor decidirem; e o que eles gravam volta com o nome da conta. Parauapebas (sem mapa) fica byte a byte igual.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://teste:teste@localhost:5432/teste';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const { aplicarEtapasDasContas, etapasDaConta, etapasDoContexto, PAPEIS_COMERCIAIS } = await import('./chatwoot-etapas.js');
const { ETAPAS_DE_TIMBO_NA_COLUNA: COLUNA_DE_TIMBO } = await import('./chatwoot-etapas-timbo.js');
const { conversaDoChatwoot, candidatos } = await import('./chatwoot-regua.js');
const { portaDoChatwoot, conversaLidaDoChatwoot } = await import('./chatwoot-porta.js');
const { criarContextoChatwoot } = await import('../mcp-remoto/chatwoot.js');
const { camposFaltandoAoResolver } = await import('./chatwoot-resolver.js');
const { mudancaDaConversa } = await import('./chatwoot-etiquetas.js');
const { montarHoje } = await import('./chatwoot-hoje.js');
const { montarQuadro, cartaoDaConversa, exigeConfirmacao } = await import('./funil-chatwoot.js');
const { situacaoPeloCrm } = await import('./disparo/chatwoot/publico.js');
const { aplicarConfigs, SEMENTE_PARAUAPEBAS, contaDaCaixa } = await import('./chatwoot-unidades.js');
const { conversaCrua } = await import('./chatwoot-etapas.js');
const { colunaDaEtapa } = await import('./funil-chatwoot.js');

const TIMBO = () => etapasDaConta(3);
beforeEach(() => aplicarEtapasDasContas([{ contaId: 3, etapas: COLUNA_DE_TIMBO }]));
after(() => aplicarEtapasDasContas([]));

/** o par de nomes (conta de Timbó ↔ molde) de cada papel comercial que a conta tem; o alias «Confirmado» fica de fora (lê-se «Agendado») */
const PARES: Array<[string, string]> = [
  ['Leads de entrada', 'Novo lead'],
  ['EM QUALIFICAÇÃO', 'Sofia qualifica'],
  ['AGENDADO', 'Agendado'],
  ['COMPARECEU', 'Compareceu'],
  ['EM NEGOCIAÇÃO', 'Pós-consulta'],
  ['GANHO / CONCLUÍDO', 'Fechou'],
  ['PERDIDO', 'Perdido'],
];

const bruta = (etapa: string, extra: Record<string, unknown> = {}) => ({
  id: 5,
  inbox_id: 9,
  created_at: 1_700_000_000,
  labels: [],
  meta: { sender: { name: 'Paciente de Teste', phone_number: '+5511999990000' } },
  custom_attributes: { etapa, funil: 'Comercial', data_consulta: '2026-12-01', hora_consulta: '10:00', situacao_consulta: 'Agendado', ...extra },
});

test('régua: a conversa de Timbó (nomes da Kommo) chega à régua IDÊNTICA à de Parauapebas com o nome do molde', () => {
  for (const [nomeDaConta, papel] of PARES) {
    const deTimbo = conversaDoChatwoot(bruta(nomeDaConta), TIMBO())!;
    const doMolde = conversaDoChatwoot(bruta(papel))!;
    assert.deepEqual(deTimbo, doMolde, nomeDaConta);
    const agora = new Date('2026-11-30T12:00:00Z');
    assert.deepEqual(candidatos(deTimbo, new Map() as never), candidatos(doMolde, new Map() as never), `candidatos de ${nomeDaConta}`);
    void agora;
  }
  // o tratamento também
  const t = conversaDoChatwoot({ ...bruta('', {}), custom_attributes: { funil: 'Tratamento', etapa_tratamento: 'ALTA', data_alta: '2026-11-20' } }, TIMBO())!;
  assert.equal(t.attrs.etapa_tratamento, 'Alta');
});

test('SEM mapa a régua lê exatamente o que lia: os mesmos atributos (o mesmo objeto)', () => {
  const raw = bruta('Sofia qualifica');
  assert.equal(conversaDoChatwoot(raw)!.attrs, raw.custom_attributes);
  assert.equal(conversaDoChatwoot(raw, etapasDaConta(1))!.attrs, raw.custom_attributes);
  assert.equal(conversaDoChatwoot(raw, etapasDaConta(null))!.attrs, raw.custom_attributes);
  // a conta de Timbó com a conversa ainda no nome ANTIGO do molde (migração em andamento): a mesma coisa
  assert.equal(conversaDoChatwoot(raw, TIMBO())!.attrs.etapa, 'Sofia qualifica');
});

test('a caixa diz a conta: Timbó tem mapa, Parauapebas e caixa desconhecida têm o molde', () => {
  aplicarConfigs([
    SEMENTE_PARAUAPEBAS,
    { ...SEMENTE_PARAUAPEBAS, slug: 'doutor-hernia-timbo', contaId: 3, prefixoModelos: 'timbo_', caixas: [{ id: 9, tipo: 'cloud' }], subdominio: null },
  ]);
  try {
    assert.equal(contaDaCaixa(9), 3);
    assert.equal(etapasDaConta(contaDaCaixa(9)).comercial[1]!.nome, 'EM QUALIFICAÇÃO');
    assert.equal(etapasDaConta(contaDaCaixa(3)).comercial[1]!.nome, 'Sofia qualifica'); // caixa 3 = Parauapebas
    assert.equal(etapasDaConta(contaDaCaixa(777)).comercial[1]!.nome, 'Sofia qualifica'); // desconhecida
  } finally {
    aplicarConfigs([SEMENTE_PARAUAPEBAS]);
  }
});

/** Um Chatwoot de mentira (conversa 5 com `attrs`; definições do atributo `etapa`) que guarda o que a porta grava. */
function chatwootFalso(attrs: Record<string, unknown>, conta = 3) {
  const gravado: Array<{ caminho: string; corpo: any }> = [];
  const fetchFalso = (async (url: string, o: { method: string; body?: string }) => {
    const caminho = url.split(`/accounts/${conta}/`)[1] ?? '';
    if (o.method === 'POST') gravado.push({ caminho, corpo: o.body ? JSON.parse(o.body) : {} });
    let corpo: unknown = { ok: true };
    if (caminho === 'conversations/5') corpo = { id: 5, labels: ['a'], custom_attributes: attrs, meta: { sender: {} } };
    if (caminho.startsWith('custom_attribute_definitions'))
      corpo = [
        { attribute_key: 'etapa', attribute_values: ['Leads de entrada', 'EM QUALIFICAÇÃO', 'AGENDADO', 'PERDIDO'] },
        { attribute_key: 'etapa_tratamento', attribute_values: ['Leads de entrada', 'EM TRATAMENTO', 'ALTA'] },
      ];
    return { ok: true, status: 200, text: async () => JSON.stringify(corpo) };
  }) as unknown as typeof fetch;
  const ctx = criarContextoChatwoot({ url: 'https://crm.exemplo', conta, token: 'segredo-de-teste' }, { fetch: fetchFalso });
  return { ctx, gravado };
}

test('porta (Sofia): lê o PAPEL, grava o NOME da conta, e não regrava a etapa que ninguém pediu para mudar', async () => {
  const { ctx, gravado } = chatwootFalso({ etapa: 'EM QUALIFICAÇÃO', queixa: 'x', etapa_tratamento: 'EM TRATAMENTO' });
  const porta = portaDoChatwoot(ctx);
  const lida = await porta.conversa(5);
  assert.equal(lida!.attrs.etapa, 'Sofia qualifica');
  assert.equal(lida!.attrs.etapa_tratamento, 'Em tratamento');
  // grava só um campo comum: a etapa que a conversa tem NÃO muda de nome nem some
  await porta.gravarAtributos(5, { qualificacao: 'Quente' });
  assert.deepEqual(gravado.at(-1)!.corpo.custom_attributes, { etapa: 'EM QUALIFICAÇÃO', queixa: 'x', etapa_tratamento: 'EM TRATAMENTO', qualificacao: 'Quente' });
  // grava a etapa por papel: sai o nome da conta
  await porta.gravarAtributos(5, { etapa: 'Perdido', motivo_nao_agendamento: 'Achou caro' });
  assert.equal(gravado.at(-1)!.corpo.custom_attributes.etapa, 'PERDIDO');
  // «Confirmado» não existe na conta: vira AGENDADO; «Frio» não existe: a etapa de agora fica
  await porta.gravarAtributos(5, { etapa: 'Confirmado' });
  assert.equal(gravado.at(-1)!.corpo.custom_attributes.etapa, 'AGENDADO');
  await porta.gravarAtributos(5, { etapa: 'Frio' });
  assert.equal(gravado.at(-1)!.corpo.custom_attributes.etapa, 'EM QUALIFICAÇÃO');
  // «Esperando humano» não existe: qualificação (a etiqueta esperando-humano faz o resto)
  await porta.gravarAtributos(5, { etapa: 'Esperando humano' });
  assert.equal(gravado.at(-1)!.corpo.custom_attributes.etapa, 'EM QUALIFICAÇÃO');
});

test('porta: «esta conta tem a etapa X?» responde em papéis (Sofia só move para etapa que a conta tem)', async () => {
  const { ctx } = chatwootFalso({});
  const porta = portaDoChatwoot(ctx);
  const etapas = await porta.valoresDoAtributo('etapa');
  assert.deepEqual(etapas, ['Novo lead', 'Sofia qualifica', 'Agendado', 'Perdido']);
  assert.ok(!etapas.includes('Esperando humano') && !etapas.includes('Frio'));
  assert.deepEqual(await porta.valoresDoAtributo('etapa_tratamento'), ['Entrada', 'Em tratamento', 'Alta']);
});

test('porta SEM mapa (Parauapebas): nada traduzido, a gravação é a de sempre', async () => {
  const { ctx, gravado } = chatwootFalso({ etapa: 'Sofia qualifica', queixa: 'x' }, 1);
  const porta = portaDoChatwoot(ctx);
  assert.equal(etapasDoContexto(ctx), etapasDaConta(1));
  assert.equal((await porta.conversa(5))!.attrs.etapa, 'Sofia qualifica');
  await porta.gravarAtributos(5, { etapa: 'Frio', qualificacao: 'Quente' });
  assert.deepEqual(gravado.at(-1)!.corpo.custom_attributes, { etapa: 'Frio', queixa: 'x', qualificacao: 'Quente' });
  // sem mapa a lista do atributo passa como o Chatwoot a entrega (aqui a de mentira tem nomes quaisquer: nenhum é traduzido)
  assert.deepEqual(await porta.valoresDoAtributo('etapa'), ['Leads de entrada', 'EM QUALIFICAÇÃO', 'AGENDADO', 'PERDIDO']);
});

test('conversaLidaDoChatwoot sem mapa devolve os atributos como vieram (cópia), com mapa em papéis', () => {
  const raw = bruta('PERDIDO');
  assert.equal(conversaLidaDoChatwoot(raw)!.attrs.etapa, 'PERDIDO');
  assert.equal(conversaLidaDoChatwoot(raw, TIMBO())!.attrs.etapa, 'Perdido');
});

test('resolver: Perdido sem motivo e Fechou sem valor valem pelos nomes da conta', () => {
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'PERDIDO' }, TIMBO()), ['motivo_nao_agendamento']);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'GANHO / CONCLUÍDO' }, TIMBO()), ['valor_fechado']);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'GANHO / CONCLUÍDO', valor_fechado: 1500 }, TIMBO()), []);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'PERDIDO' }), [], 'sem mapa o nome da conta não é «Perdido»: como sempre');
  assert.deepEqual(camposFaltandoAoResolver({}, TIMBO()), ['etapa']);
});

test('botão «Perdido: motivo»: grava o nome que a conta dá a Perdido e mantém o resto como estava', () => {
  const conv = { labels: ['perdido-sem-interesse'], custom_attributes: { etapa: 'EM QUALIFICAÇÃO', queixa: 'x' } };
  const m = mudancaDaConversa(conv, undefined, TIMBO())!;
  assert.equal(m.atributos.etapa, 'PERDIDO');
  assert.equal(m.atributos.queixa, 'x');
  assert.equal(mudancaDaConversa(conv)!.atributos.etapa, 'Perdido');
});

test('Hoje: decide por papel e mostra o nome da conta', () => {
  const mapa = TIMBO();
  const c = conversaCrua(mapa, { ...bruta('EM NEGOCIAÇÃO'), status: 'open', last_activity_at: 1_760_000_000 });
  const h = montarHoje([c], Date.parse('2026-11-25T15:00:00Z'), new Set(), mapa);
  assert.equal(h.separou.naoFecharam.length, 1);
  assert.equal(h.separou.naoFecharam[0]!.detalhe, 'EM NEGOCIAÇÃO');
  const sem = montarHoje([{ ...bruta('Pós-consulta'), status: 'open' }], Date.parse('2026-11-25T15:00:00Z'), new Set());
  assert.equal(sem.separou.naoFecharam[0]!.detalhe, 'Pós-consulta');
});

test('quadro: a coluna é o nome da conta; a conversa que ainda tem o nome antigo cai na coluna do MESMO papel, não na 1ª', () => {
  const lista = ['Leads de entrada', 'EM QUALIFICAÇÃO', 'AGENDADO', 'PERDIDO'];
  const antiga = cartaoDaConversa(bruta('Perdido'), lista, undefined, [], TIMBO());
  assert.equal(antiga.etapa, 'PERDIDO');
  assert.equal(cartaoDaConversa(bruta('PERDIDO'), lista, undefined, [], TIMBO()).etapa, 'PERDIDO');
  assert.equal(cartaoDaConversa(bruta('Confirmado'), lista, undefined, [], TIMBO()).etapa, 'AGENDADO');
  assert.equal(cartaoDaConversa(bruta('uma etapa que ninguém conhece'), lista, undefined, [], TIMBO()).etapa, 'Leads de entrada');
  // sem mapa: como sempre (fora da lista = 1ª coluna)
  assert.equal(cartaoDaConversa(bruta('Perdido'), lista).etapa, 'Leads de entrada');
  const q = montarQuadro([{ payload: [bruta('EM QUALIFICAÇÃO'), { ...bruta('Perdido'), id: 6 }] }], lista, new Map(), [], 'comercial', TIMBO());
  assert.equal(q.colunas.find((c: { etapa: string }) => c.etapa === 'PERDIDO')!.cartoes.length, 1);
});

test('funil: mover para Alta / Tratamento cancelado pede confirmação pelo PAPEL', () => {
  assert.ok(exigeConfirmacao('ALTA', TIMBO()) && exigeConfirmacao('TRATAMENTO CANCELADO', TIMBO()));
  assert.ok(!exigeConfirmacao('EM TRATAMENTO', TIMBO()) && !exigeConfirmacao('Leads de entrada', TIMBO()));
  assert.ok(exigeConfirmacao('Alta') && !exigeConfirmacao('ALTA'));
});

test('disparo sem agenda: a situação pelo CRM lê o papel', () => {
  assert.equal(situacaoPeloCrm({ etapa: 'AGENDADO' }, TIMBO()), 'consulta-futura');
  assert.equal(situacaoPeloCrm({ etapa: 'GANHO / CONCLUÍDO' }, TIMBO()), 'ja-cliente');
  assert.equal(situacaoPeloCrm({ etapa: 'PERDIDO', funil: 'Tratamento', etapa_tratamento: 'EM TRATAMENTO' }, TIMBO()), 'tratamento-aberto');
  assert.equal(situacaoPeloCrm({ etapa: 'PERDIDO', funil: 'Tratamento', etapa_tratamento: 'ALTA' }, TIMBO()), 'livre');
  assert.equal(situacaoPeloCrm({ etapa: 'Agendado' }), 'consulta-futura');
});

test('os 15 papéis comerciais existem e nenhum nome do molde de Parauapebas mudou', () => {
  assert.equal(PAPEIS_COMERCIAIS.length, 15);
});

test('quadro/ficha/mover usam a MESMA coluna: colunaDaEtapa (nome antigo do molde → coluna do papel; sem mapa, como sempre)', () => {
  const lista = ['Leads de entrada', 'EM QUALIFICAÇÃO', 'AGENDADO', 'PERDIDO'];
  assert.equal(colunaDaEtapa('Agendado', lista, TIMBO(), false), 'AGENDADO');
  assert.equal(colunaDaEtapa('AGENDADO', lista, TIMBO(), false), 'AGENDADO');
  assert.equal(colunaDaEtapa('', lista, TIMBO(), false), 'Leads de entrada');
  assert.equal(colunaDaEtapa('Em tratamento', ['Leads de entrada', 'EM TRATAMENTO', 'ALTA'], TIMBO(), true), 'EM TRATAMENTO');
  assert.equal(colunaDaEtapa('Agendado', lista, null, false), 'Leads de entrada', 'sem mapa: fora da lista = 1ª coluna (como antes)');
  assert.equal(colunaDaEtapa('Perdido', ['Novo lead', 'Perdido'], null, false), 'Perdido');
});

test('a ficha e o copiloto leem a etapa em papel (conversaLidaDoChatwoot com o mapa da conta)', () => {
  assert.equal(conversaLidaDoChatwoot(bruta('EM NEGOCIAÇÃO'), etapasDaConta(3))!.attrs.etapa, 'Pós-consulta');
});

test('o leitor do banco só aplica o mapa das linhas ACEITAS (válida ou inerte sem conflito) e avisa do mapa inválido', async () => {
  const { recarregarConfigChatwoot } = await import('./chatwoot-unidades-banco.js');
  const { prisma } = await import('./prisma.js');
  const U = await import('./chatwoot-unidades.js');
  const dados = { nome: 'Doutor Hérnia Timbó', cidade: 'Timbó', endereco: 'Rua A, 1 — Centro, Timbó/SC, 89120-000', mapa: 'https://maps.example/timbo' };
  const timbo = { unitId: 'u-timbo', contaId: 3, subdominio: 'drtimbo', prefixoModelos: 'timbo_', usuarioCelularId: null, gerenteId: null, metaAgendamentosDia: null, kapsoPhoneNumberId: null, wabaId: null, envSufixo: 'TIMBO', dadosModelos: dados, unit: { slug: 'doutor-hernia-timbo' }, caixas: [], etapas: COLUNA_DE_TIMBO };
  const p = prisma as unknown as { unitChatwoot: unknown };
  const antes = p.unitChatwoot;
  try {
    // Timbó é INERTE (sem caixa): o mapa vale mesmo assim
    p.unitChatwoot = { findMany: async () => [timbo] };
    await recarregarConfigChatwoot();
    assert.equal(etapasDaConta(3).comercial[1]!.nome, 'EM QUALIFICAÇÃO');
    // a linha DESCARTADA por conflito (prefixo de Parauapebas) não manda no mapa
    p.unitChatwoot = { findMany: async () => [{ ...timbo, prefixoModelos: U.SEMENTE_PARAUAPEBAS.prefixoModelos }] };
    await recarregarConfigChatwoot();
    assert.equal(etapasDaConta(3).comercial[1]!.nome, 'Sofia qualifica');
    // mapa inválido: a conta fica no molde
    p.unitChatwoot = { findMany: async () => [{ ...timbo, etapas: { comercial: [{ papel: 'Inventado', nome: 'X' }], tratamento: [] } }] };
    await recarregarConfigChatwoot();
    assert.equal(etapasDaConta(3).comercial[1]!.nome, 'Sofia qualifica');
    // linha sem mapa (nula): molde
    p.unitChatwoot = { findMany: async () => [{ ...timbo, etapas: null }] };
    await recarregarConfigChatwoot();
    assert.equal(etapasDaConta(3).comercial[1]!.nome, 'Sofia qualifica');
  } finally {
    p.unitChatwoot = antes;
    aplicarConfigs([SEMENTE_PARAUAPEBAS]);
  }
});

test('tela do Funil: a conta com etapas próprias recebe `confirmam` (os nomes dela); sem mapa a resposta é a mesma de sempre', async () => {
  const { confirmamNaTela } = await import('../controllers/funil.controller.js');
  const doTrat = ['Leads de entrada', 'EM TRATAMENTO', 'ALTA', 'TRATAMENTO CANCELADO'];
  assert.deepEqual(confirmamNaTela(doTrat, TIMBO()), { confirmam: ['ALTA', 'TRATAMENTO CANCELADO'] });
  assert.deepEqual(confirmamNaTela(['Entrada', 'Em tratamento', 'Alta', 'Tratamento cancelado'], etapasDaConta(1)), {}, 'Parauapebas: nenhum campo novo na resposta');
});

test('LIGAR o mapa não vira «entrou na etapa»: a régua viu a conversa SEM mapa com o nome da Kommo cru e DEPOIS o mapa entra → 0 mudança e 0 candidato', async () => {
  const { atualizarVistos, candidatos } = await import('./chatwoot-regua.js');
  const t1 = new Date('2026-11-25T12:00:00Z');
  const partida = { primeiraVez: false, desde: new Date('2026-01-01T00:00:00Z') };
  const casos: Array<['etapa' | 'etapa_tratamento', string]> = [['etapa', 'PERDIDO'], ['etapa', 'GANHO / CONCLUÍDO'], ['etapa', 'AGENDADO'], ['etapa_tratamento', 'ALTA'], ['etapa_tratamento', 'TRATAMENTO CANCELADO'], ['etapa_tratamento', 'EM TRATAMENTO']];
  for (const [campo, nome] of casos) {
    // sem data de consulta: o que se mede é a ETAPA (a véspera/dia de uma consulta marcada é decisão por data, igual com ou sem mapa)
    const attrs = { [campo]: nome, funil: campo === 'etapa_tratamento' ? 'Tratamento' : 'Comercial', pagamento_antecipado: 'Sim', situacao_consulta: 'Agendado', data_consulta: '', hora_consulta: '' };
    const semMapa = conversaDoChatwoot(bruta('', attrs), null)!;
    const v0 = atualizarVistos(semMapa, new Map(), new Date('2026-11-20T12:00:00Z'), { primeiraVez: false, desde: null }).vistos; // a régua JÁ viu (não inicial)
    const comMapa = conversaDoChatwoot(bruta('', attrs), TIMBO())!;
    const r = atualizarVistos(comMapa, v0, t1, partida);
    assert.deepEqual(r.mudancas, [], `${campo}=${nome}: nada mudou`);
    assert.deepEqual(candidatos(comMapa, r.vistos).map((k) => k.regra), [], `${campo}=${nome}: nenhum candidato`);
  }
  // «Confirmado» (molde) → AGENDADO (alias): também não é mudança
  const conf = conversaDoChatwoot(bruta('Confirmado', { situacao_consulta: 'Confirmado' }), null)!;
  const vc = atualizarVistos(conf, new Map(), new Date('2026-11-20T12:00:00Z'), { primeiraVez: false, desde: null }).vistos;
  assert.deepEqual(atualizarVistos(conversaDoChatwoot(bruta('AGENDADO', { situacao_consulta: 'Confirmado' }), TIMBO())!, vc, t1, partida).mudancas, []);
  // mudança REAL de etapa com o mapa ligado continua sendo mudança (Agendado → PERDIDO)
  const ag = conversaDoChatwoot(bruta('AGENDADO'), TIMBO())!;
  const va = atualizarVistos(ag, new Map(), new Date('2026-11-20T12:00:00Z'), { primeiraVez: false, desde: null }).vistos;
  const real = atualizarVistos(conversaDoChatwoot(bruta('PERDIDO'), TIMBO())!, va, t1, partida);
  assert.deepEqual(real.mudancas.map((m) => [m.tipo, m.campo]), [['atualizar', 'etapa']]);
  // Parauapebas (sem mapa): comparação exata, como sempre — «PERDIDO» não é «Perdido»
  const p0 = conversaDoChatwoot(bruta('Perdido'), null)!;
  const vp = atualizarVistos(p0, new Map(), new Date('2026-11-20T12:00:00Z'), { primeiraVez: false, desde: null }).vistos;
  assert.equal(atualizarVistos(conversaDoChatwoot(bruta('PERDIDO'), null)!, vp, t1, partida).mudancas.length, 1);
  assert.equal(Object.keys(p0).includes('mapaDeEtapas'), false, 'a conversa sem mapa é a de sempre');
  assert.equal(Object.keys(conversaDoChatwoot(bruta('PERDIDO'), TIMBO())!).includes('mapaDeEtapas'), false, 'e com mapa o campo não aparece em JSON/spread/deepEqual');
});

test('o mapa gravado COM O SERVIDOR NO AR vale na chamada seguinte: a porta da Sofia e a ponte do botão Perdido não guardam o mapa de quando foram montadas', async () => {
  const { portasDaPonte } = await import('./chatwoot-etiquetas.js');
  aplicarEtapasDasContas([]); // a porta nasce SEM mapa
  const { ctx, gravado } = chatwootFalso({ etapa: 'EM QUALIFICAÇÃO', queixa: 'x' });
  const porta = portaDoChatwoot(ctx);
  const ponte = portasDaPonte(ctx);
  assert.equal((await porta.conversa(5))!.attrs.etapa, 'EM QUALIFICAÇÃO', 'sem mapa: como veio');
  assert.deepEqual(await porta.valoresDoAtributo('etapa'), ['Leads de entrada', 'EM QUALIFICAÇÃO', 'AGENDADO', 'PERDIDO'], 'sem mapa: a lista como o Chatwoot a entrega (e fica guardada)');
  assert.equal(ponte.mapaDeEtapas, etapasDaConta(3));
  // o servidor relê a configuração (a cada minuto) e o mapa entra
  aplicarEtapasDasContas([{ contaId: 3, etapas: COLUNA_DE_TIMBO }]);
  assert.equal((await porta.conversa(5))!.attrs.etapa, 'Sofia qualifica', 'a PRÓXIMA chamada já lê em papel');
  await porta.gravarAtributos(5, { etapa: 'Perdido' });
  assert.equal(gravado.at(-1)!.corpo.custom_attributes.etapa, 'PERDIDO', 'e grava o nome da conta');
  assert.deepEqual(await porta.valoresDoAtributo('etapa'), ['Novo lead', 'Sofia qualifica', 'Agendado', 'Perdido'], 'a lista guardada também é traduzida com o mapa de AGORA');
  assert.equal(ponte.mapaDeEtapas.comercial[1]!.nome, 'EM QUALIFICAÇÃO', 'a ponte do botão «Perdido» também');
  // e o caminho de volta: o mapa sai
  aplicarEtapasDasContas([]);
  assert.equal((await porta.conversa(5))!.attrs.etapa, 'EM QUALIFICAÇÃO');
});
