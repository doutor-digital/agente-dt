/**
 * Três itens da lista "PRIORIDADES DA IA" (21/10/2026), presos no prompt da rede:
 *
 *  - item 5, "É médico?": a frase fixa "Somos fisioterapeutas especialistas no tratamento da coluna pelo método
 *    Doutor Hérnia." aparecia 0 vezes. Só para unidade Doutor Hérnia (o Instituto Trauma, slug `default`, também
 *    é de saúde e não é DH). Vale acima do prompt próprio da unidade, que em Taubaté, Mossoró e Boa Vista chama a
 *    fisioterapeuta de "Dra.".
 *  - item 7, a rede: a Sofia de Marabá negou Canaã (lead 28491142) e a de Parauapebas negou Marabá (lead
 *    28691340). A lista sai da tabela de unidades, nunca nega, e transfere com nota quando falta contato.
 *  - item 16, "avaliação" → "consulta com o nosso especialista" (decisão do João): a palavra sai de todo texto que
 *    o modelo copia; sobra só na regra que proíbe a palavra.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeFollowUpSystemPrompt, composeSystemPrompt, composeSystemPromptParts } from './prompt-composer.js';
import {
  FRASE_E_MEDICO,
  carregarRede,
  cidadeDaUnidade,
  ehDoutorHernia,
  esquecerRede,
  montarRede,
  renderIdentidadeCurta,
  renderIdentidadeDoutorHernia,
  renderRedeDeUnidades,
  semDraSofia,
  semDraSofiaNaDH,
  telefoneParaPaciente,
  type LinhaDeUnidade,
} from './rede-doutor-hernia.js';

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-maraba',
    slug: 'doutor-hernia-maraba',
    name: 'Doutor Hérnia Marabá',
    category: 'saude',
    kommoSubdomain: 'marabadoutorhernia',
    systemPrompt: null,
    sourcePapel: null,
    sourceProdutos: 'Consulta com o especialista: R$ 350 no dia ou R$ 250 antecipado no Pix.',
    sourceNegocio: null,
    sourceDemografia: null,
    personaCompanyName: 'Doutor Hérnia Marabá',
    personaTone: null,
    personaGreeting: null,
    personaResponseLength: 'normal',
    personaLanguage: 'pt-BR',
    personaEmojis: [],
    handoffEnabled: true,
    handoffKeywords: [],
    pipelineIntents: { waiting_deferred: 111, scheduled_meeting: 222 },
    spineEnabled: true,
    spineAgendaStart: '08:00',
    spineAgendaEnd: '18:00',
    qualificationEnabled: false,
    triageEnabled: true,
    collectNameEnabled: true,
    singlePromptMode: false,
    ...over,
  } as unknown as Unit;
}

function linha(slug: string, over: Partial<LinhaDeUnidade> = {}): LinhaDeUnidade {
  return {
    id: `id-${slug}`,
    slug,
    name: null,
    isActive: true,
    kommoSubdomain: null,
    clinicAddress: null,
    igWhatsappNumber: null,
    fbWhatsappNumber: null,
    crmCompartilhado: null,
    ...over,
  };
}

const LINHAS: LinhaDeUnidade[] = [
  linha('doutor-hernia-maraba', { id: 'u-maraba', name: 'Doutor Hérnia Marabá', kommoSubdomain: 'marabadoutorhernia' }),
  linha('doutor-hernia-canaa', {
    name: 'Doutor Hérnia Canaã',
    kommoSubdomain: 'doutorherniacanaa',
    igWhatsappNumber: '5594991234567',
    clinicAddress: 'Rua das Palmeiras, 100 — Centro',
  }),
  linha('doutor-hernia-parauapebas', { name: 'Doutor Hérnia Parauapebas', kommoSubdomain: 'parauapebasdoutorhernia' }),
  linha('doutor-hernia-divinopolis', { name: 'Doutor Hérnia Divinópolis' }),
  linha('doutor-hernia-petropolis', { id: 'u-petro', name: 'Doutor Hérnia Petrópolis', kommoSubdomain: 'doutorhernialvp' }),
  linha('doutor-hernia-caxias', { name: 'Doutor Hérnia Caxias', crmCompartilhado: { contaUnitId: 'u-petro', ativo: true } }),
  // não entram:
  linha('doutor-hernia-olimpia', { name: 'Doutor Hérnia Olímpia', isActive: false }),
  linha('acailandia-resgate', { name: 'Doutor Hérnia Açailândia', kommoSubdomain: 'doutorherniaacailandia' }),
  linha('doutor-hernia-imperatriz-resgate', { name: 'Resgate' }),
  linha('default', { name: 'Instituto Trauma', kommoSubdomain: 'institutotraumakommon' }),
];
const REDE = montarRede(LINHAS);

beforeEach(() => esquecerRede());

// ── item 5: "é médico?" ────────────────────────────────────────────────────────────────────────────────────

test('item 5: unidade Doutor Hérnia recebe a frase fixa do "é médico?", exatamente', () => {
  const { cacheable } = composeSystemPromptParts({ unit: unidade(), redeDeUnidades: REDE });
  assert.ok(cacheable.includes(`"${FRASE_E_MEDICO}"`), 'a frase precisa estar entre aspas, inteira');
  assert.equal(FRASE_E_MEDICO, 'Somos fisioterapeutas especialistas no tratamento da coluna pelo método Doutor Hérnia.');
  assert.match(composeSystemPrompt({ unit: unidade(), redeDeUnidades: REDE }), /Somos fisioterapeutas especialistas/);
});

test('item 5: a frase do método Doutor Hérnia NÃO vai para quem não é Doutor Hérnia', () => {
  const trauma = unidade({ id: 'u-trauma', slug: 'default', name: 'Instituto Trauma', personaCompanyName: 'TraumaFIT', kommoSubdomain: 'institutotraumakommon' });
  const advocacia = unidade({ id: 'u-adv', slug: 'advocacia-magalhaes', name: 'Magalhães Advocacia', personaCompanyName: 'Magalhães', category: 'advocacia', kommoSubdomain: 'magalhaesadv2025' });
  for (const u of [trauma, advocacia]) {
    const p = composeSystemPrompt({ unit: u, redeDeUnidades: REDE });
    assert.doesNotMatch(p, /método Doutor Hérnia/, u.slug);
    assert.doesNotMatch(p, /<rede_doutor_hernia>/, u.slug);
    assert.doesNotMatch(composeFollowUpSystemPrompt(u), /método Doutor Hérnia/, `${u.slug} (follow-up)`);
  }
});

test('item 5: a regra vem DEPOIS do prompt próprio da unidade e diz que vale acima dele ("Dra.")', () => {
  const u = unidade({ systemPrompt: 'Quem atende é a Dra. Victória Nunes.' });
  const { cacheable } = composeSystemPromptParts({ unit: u, redeDeUnidades: REDE });
  assert.ok(cacheable.indexOf('<instrucoes_extras>') >= 0);
  assert.ok(cacheable.indexOf('<rede_doutor_hernia>') > cacheable.indexOf('</instrucoes_extras>'), 'precisa vir depois');
  assert.match(cacheable, /VALE ACIMA das Fontes Oficiais, das instruções extras/);
  assert.match(cacheable, /Não escreva "Dr\.", "Dra\."/);
});

test('item 5: vale também no modo de prompt único e no follow-up', () => {
  const unico = composeSystemPromptParts({
    unit: unidade({ singlePromptMode: true, systemPrompt: 'Prompt inteiro da unidade. Dra. Victória atende.' }),
    redeDeUnidades: REDE,
  });
  assert.ok(unico.cacheable.startsWith('Prompt inteiro da unidade.'), 'o prompt da unidade continua na frente');
  assert.ok(unico.cacheable.includes(FRASE_E_MEDICO));
  assert.ok(composeSystemPrompt({ unit: unidade({ singlePromptMode: true, systemPrompt: 'x' }), redeDeUnidades: REDE }).includes(FRASE_E_MEDICO));
  assert.ok(composeFollowUpSystemPrompt(unidade()).includes(FRASE_E_MEDICO));
});

test('item 5: slug de resgate que divide o Kommo de uma unidade da rede é Doutor Hérnia', () => {
  // pelo slug da dona (achado do Codex): imperatriz-resgate → doutor-hernia-imperatriz, que está no mapa do ⌂ Unidade
  const imperatriz = { slug: 'imperatriz-resgate', name: 'Resgate', personaCompanyName: null, kommoSubdomain: null };
  assert.equal(ehDoutorHernia(imperatriz), true);
  assert.equal(ehDoutorHernia({ ...imperatriz, slug: 'imperatriz-financeiro' }), true);
  // dona fora do mapa: só a lista da rede diz — pelo slug da dona ou pelo Kommo dividido
  const timbo = { slug: 'timbo-resgate', name: 'Resgate', personaCompanyName: null, kommoSubdomain: 'clinicatimbo' };
  assert.equal(ehDoutorHernia(timbo), false, 'sozinho não dá para saber');
  const rede = montarRede([linha('doutor-hernia-timbo', { name: 'Doutor Hérnia Timbó', kommoSubdomain: 'clinicatimbo' })]);
  assert.equal(ehDoutorHernia(timbo, rede), true);
  assert.equal(ehDoutorHernia({ ...timbo, slug: 'outra-coisa' }, rede), true, 'pelo Kommo dividido');
  assert.equal(ehDoutorHernia({ slug: 'acailandia-resgate', name: 'Doutor Hérnia Açailândia', personaCompanyName: null, kommoSubdomain: null }), true);
  assert.equal(ehDoutorHernia({ slug: 'default', name: 'Instituto Trauma', personaCompanyName: null, kommoSubdomain: 'institutotraumakommon' }, rede), false);
  // o follow-up também recebe a rede (achado do Codex): sem ela o resgate ficava sem a regra
  const u = unidade({ id: 'u-res', ...timbo } as Partial<Unit>);
  assert.ok(!composeFollowUpSystemPrompt(u).includes(FRASE_E_MEDICO));
  assert.ok(composeFollowUpSystemPrompt(u, new Date(), rede).includes(FRASE_E_MEDICO));
});

test('nome da IA: nas clínicas Doutor Hérnia é só "Sofia"; fora da rede o preset de saúde segue "Dra. Sofia"', () => {
  const dh = unidade({ personaGreeting: 'Oi! Sou a Dra. Sofia, da Doutor Hérnia Marabá. Como posso te ajudar?' });
  for (const p of [
    composeSystemPrompt({ unit: dh, redeDeUnidades: REDE }),
    composeSystemPromptParts({ unit: dh, redeDeUnidades: REDE }).cacheable,
    composeFollowUpSystemPrompt(dh),
  ]) {
    assert.match(p, /Você é Sofia, quem atende o WhatsApp da Doutor Hérnia Marabá/);
    assert.match(p, /Saudação preferida[^\n]*"Oi! Sou a Sofia, da Doutor Hérnia Marabá/, 'a saudação do banco perde o "Dra."');
    assert.doesNotMatch(p, /Você é Dra\. Sofia/);
  }
  assert.match(composeSystemPrompt({ unit: dh, redeDeUnidades: REDE }), /SEU NOME: você é a Sofia/);
  const trauma = unidade({ id: 'u-trauma', slug: 'default', name: 'Instituto Trauma', personaCompanyName: 'TraumaFIT', kommoSubdomain: 'institutotraumakommon', personaGreeting: 'Oi! Sou a Dra. Sofia.' });
  const pt = composeSystemPrompt({ unit: trauma, redeDeUnidades: REDE });
  assert.match(pt, /Você é Dra\. Sofia, quem atende o WhatsApp da TraumaFIT/);
  assert.match(pt, /"Oi! Sou a Dra\. Sofia\."/);
});

test('nome da IA: a trava de saída tira o "Dra." antes de Sofia — só na rede Doutor Hérnia', () => {
  assert.equal(semDraSofia('Oi! Aqui é a Dra. Sofia, da clínica.'), 'Oi! Aqui é a Sofia, da clínica.');
  assert.equal(semDraSofia('Sou a Doutora Sofia 😊'), 'Sou a Sofia 😊');
  assert.equal(semDraSofia('DRA SOFIA aqui'), 'SOFIA aqui');
  assert.equal(semDraSofia('com a Dra. Sofiane'), 'com a Dra. Sofiane', 'outro nome não é tocado');
  assert.equal(semDraSofia('a Dra. Victória atende'), 'a Dra. Victória atende', 'só o nome da IA');
  const texto = 'Aqui é a Dra. Sofia!';
  assert.equal(semDraSofiaNaDH(texto, unidade()), 'Aqui é a Sofia!');
  assert.equal(semDraSofiaNaDH(texto, { slug: 'default', name: 'Instituto Trauma', personaCompanyName: 'TraumaFIT', kommoSubdomain: 'institutotraumakommon' }), texto);
});

// ── item 7: a rede ─────────────────────────────────────────────────────────────────────────────────────────

test('item 7: a rede sai da tabela — só Doutor Hérnia ativa, sem resgate, uma por cidade, com UF', () => {
  const cidades = REDE.map((r) => r.cidade);
  assert.deepEqual(cidades, ['Canaã dos Carajás/PA', 'Divinópolis', 'Duque de Caxias/RJ', 'Marabá/PA', 'Parauapebas/PA', 'Petrópolis/RJ']);
  assert.ok(!cidades.some((c) => /Olímpia|Açailândia|Trauma|Resgate/.test(c)));
});

test('item 7: cidade e telefone no formato do paciente', () => {
  assert.equal(cidadeDaUnidade('doutor-hernia-imperatriz', 'Comercial'), 'Imperatriz/MA');
  assert.equal(cidadeDaUnidade('doutor-hernia-timbo', 'Doutor Hérnia Timbó'), 'Timbó');
  assert.equal(cidadeDaUnidade('doutor-hernia-caxias', 'Doutor Hérnia Caxias'), 'Duque de Caxias/RJ');
  assert.equal(telefoneParaPaciente('5594991234567'), '(94) 99123-4567');
  assert.equal(telefoneParaPaciente('9432221100'), '(94) 3222-1100');
  assert.equal(telefoneParaPaciente(null), null);
});

test('item 7: Marabá conhece Canaã e Parauapebas — e não lista a si mesma', () => {
  const bloco = renderRedeDeUnidades(unidade(), REDE);
  assert.match(bloco, /Você atende a unidade de Marabá\/PA\./);
  assert.match(bloco, /- Canaã dos Carajás\/PA — WhatsApp \(94\) 99123-4567 · endereço: Rua das Palmeiras, 100/);
  assert.match(bloco, /- Parauapebas\/PA — sem contato cadastrado/);
  assert.doesNotMatch(bloco, /- Marabá\/PA/);
});

test('item 7: nunca nega; sem contato, transfere com a nota pedida; fora da lista, confirma com a equipe', () => {
  const bloco = renderRedeDeUnidades(unidade(), REDE);
  assert.match(bloco, /NUNCA diga que não existe unidade numa cidade/);
  assert.match(bloco, /criar_tarefa com o texto\s+"Paciente é de \{cidade\} — transferir para a unidade de \{cidade da lista\}"\s+e depois pausar_ia/);
  assert.match(bloco, /CIDADE QUE NÃO ESTÁ NA LISTA: não negue/);
  assert.match(bloco, /Não invente telefone nem endereço/);
  assert.match(bloco, /Não marque, não remarque e não consulte horário de outra unidade/);
});

test('item 7: Petrópolis vê Caxias como a mesma equipe (CRM dividido), não como transferência', () => {
  const petro = unidade({ id: 'u-petro', slug: 'doutor-hernia-petropolis', name: 'Doutor Hérnia Petrópolis', kommoSubdomain: 'doutorhernialvp' });
  const bloco = renderRedeDeUnidades(petro, REDE);
  assert.match(bloco, /Você atende a unidade de Petrópolis\/RJ\./);
  assert.match(bloco, /- Duque de Caxias\/RJ — atendida por esta mesma equipe/);
  assert.match(bloco, /- Marabá\/PA — sem contato cadastrado/);
});

test('item 7: o bloco vai no prefixo cacheado e é igual entre chamadas (não derruba o cache)', () => {
  const a = composeSystemPromptParts({ unit: unidade(), redeDeUnidades: REDE, leadId: 1, userMessage: 'oi' });
  const b = composeSystemPromptParts({ unit: unidade(), redeDeUnidades: REDE, leadId: 2, userMessage: 'tem em Canaã?' });
  assert.ok(a.cacheable.includes('Canaã dos Carajás/PA'));
  assert.ok(!a.dynamic.includes('<rede_doutor_hernia>'));
  assert.equal(a.cacheable, b.cacheable);
});

test('item 7: sem a lista (banco fora), a regra de nunca negar continua', () => {
  const bloco = renderRedeDeUnidades(unidade(), []);
  assert.match(bloco, /A lista das outras unidades não está disponível agora/);
  assert.match(bloco, /NUNCA diga que não existe unidade/);
});

test('item 7: carregarRede guarda por 10 min e, se o banco cair, devolve a última lista boa', async () => {
  let chamadas = 0;
  const buscar = async () => {
    chamadas++;
    return LINHAS;
  };
  const r1 = await carregarRede(buscar, 1_000);
  const r2 = await carregarRede(buscar, 1_000 + 5 * 60_000);
  assert.equal(chamadas, 1, 'dentro dos 10 min não vai ao banco de novo');
  assert.deepEqual(r2, r1);
  const r3 = await carregarRede(async () => { throw new Error('banco fora'); }, 1_000 + 11 * 60_000);
  assert.deepEqual(r3, r1, 'banco fora: segue com a última lista');
  esquecerRede();
  assert.deepEqual(await carregarRede(async () => { throw new Error('banco fora'); }, 0), []);
});

// ── item 16: "avaliação" → "consulta com o nosso especialista" ─────────────────────────────────────────────

test('item 16: a regra explícita está no prompt da rede e no do follow-up', () => {
  const p = composeSystemPrompt({ unit: unidade(), redeDeUnidades: REDE });
  assert.match(p, /NÃO use a palavra "avaliação"/);
  assert.match(p, /Diga "consulta com o nosso especialista"/);
  const f = composeFollowUpSystemPrompt(unidade());
  assert.match(f, /Nunca diga "avaliação": diga "consulta com o nosso especialista"/);
  // o follow-up tem teto de 8.000 caracteres (follow-up-prompt.test.ts): a linha precisa ser curta
  assert.ok(renderIdentidadeCurta().length < 260, `linha do follow-up grande demais: ${renderIdentidadeCurta().length}`);
});

test('item 16: fora da regra que a proíbe, "avaliação" não aparece no prompt de uma unidade DH completa', () => {
  for (const [p, regra] of [
    [composeSystemPrompt({ unit: unidade(), redeDeUnidades: REDE }), renderIdentidadeDoutorHernia()],
    [Object.values(composeSystemPromptParts({ unit: unidade(), redeDeUnidades: REDE })).join('\n'), renderIdentidadeDoutorHernia()],
    [composeFollowUpSystemPrompt(unidade()), renderIdentidadeCurta()],
  ]) {
    assert.ok(p.includes(regra));
    const resto = p.split(regra).join('');
    const achados = resto.match(/.{0,40}avalia[çc][ãa]o.{0,40}/gi) ?? [];
    assert.deepEqual(achados, [], 'sobrou "avaliação" em texto que o modelo copia');
  }
});

test('item 16: os pontos que usavam a palavra agora dizem consulta', () => {
  const p = composeSystemPrompt({ unit: unidade(), redeDeUnidades: REDE });
  assert.match(p, /para marcarmos sua\s+consulta com o nosso especialista/, 'EM ESPERA');
  assert.match(p, /A consulta é o que abre as opções/, 'conversão');
  assert.match(p, /consulta presencial/, 'conversão');
  assert.match(p, /deixar esse elogio no Google/, 'elogio');
});
