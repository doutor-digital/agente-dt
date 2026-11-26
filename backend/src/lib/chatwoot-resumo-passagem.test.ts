/**
 * O «Resumo» da nota de passagem para a equipe: só o que a conversa JÁ diz (atributos) ou o que o paciente escreveu (trechos e palavras-chave).
 * Sem IA, sem inventar; sem nada confiável, sem resumo — e a nota fica exatamente como era.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hojeDaUnidade, resumoDaPassagem } from './chatwoot-resumo-passagem.js';
import { passarParaEquipeNoChatwoot, type PortaDoChatwoot } from './chatwoot-sofia.js';

const u = (content: string) => ({ role: 'user' as const, content });
const s = (content: string) => ({ role: 'assistant' as const, content });

test('resumo de uma linha: queixa, dia/período, preço e a última fala — tudo vindo do que o paciente escreveu', () => {
  const r = resumoDaPassagem({
    falas: [u('Oi, tenho dor na lombar há 2 meses'), s('Entendi! Quer ver horários?'), u('qual o valor? pode ser quinta à tarde'), s('Posso sim'), u('quero falar com uma pessoa')],
  });
  assert.equal(r, 'Resumo: dor na lombar há 2 meses · mencionou quinta, à tarde · perguntou preço · última fala: «quero falar com uma pessoa»');
});

test('atributos da conversa entram como estão (consulta e qualificação); «faz 3 semanas» vira «há 3 semanas»', () => {
  const r = resumoDaPassagem({
    attrs: { data_consulta: '2026-11-27', hora_consulta: '09:30', situacao_consulta: 'Agendado', qualificacao: 'Quente' },
    falas: [u('dor de cabeça faz 3 semanas')],
    hoje: '2026-11-26',
  });
  assert.equal(r, 'Resumo: dor de cabeça há 3 semanas · consulta Agendado: 27/11 às 09:30 · qualificação Quente · última fala: «dor de cabeça faz 3 semanas»');
});

test('consulta velha ou cancelada no atributo NÃO entra (o atributo fica para trás); sem «hoje» ela também não entra', () => {
  const falas = [u('oi')];
  const attrs = { data_consulta: '2026-10-07', hora_consulta: '09:30', situacao_consulta: 'Agendado' };
  assert.equal(resumoDaPassagem({ attrs, falas, hoje: '2026-11-26' }), 'Resumo: última fala: «oi»');
  assert.equal(resumoDaPassagem({ attrs: { ...attrs, data_consulta: '2026-11-27', situacao_consulta: 'Desmarcado' }, falas, hoje: '2026-11-26' }), 'Resumo: última fala: «oi»');
  assert.equal(resumoDaPassagem({ attrs: { ...attrs, data_consulta: '2026-11-27' }, falas }), 'Resumo: última fala: «oi»');
  assert.match(resumoDaPassagem({ attrs: { ...attrs, data_consulta: '2026-11-26' }, falas, hoje: '2026-11-26' })!, /consulta Agendado: 26\/11 às 09:30/);
});

test('não afirma o que não foi dito: família não é convênio, «meu pai tem 70 anos» não é sintoma, «não tenho dor» não é queixa, «a dor piora à noite» não é horário', () => {
  assert.equal(resumoDaPassagem({ falas: [u('minha familia mora longe, posso ir quinta?')] }), 'Resumo: mencionou quinta · última fala: «minha familia mora longe, posso ir quinta?»');
  assert.doesNotMatch(resumoDaPassagem({ falas: [u('dor na lombar'), u('meu pai tem 70 anos e vai junto')] })!, /há 70|tempo citado/);
  assert.match(resumoDaPassagem({ falas: [u('dor na lombar'), u('meu pai tem 70 anos e vai junto')] })!, /^Resumo: dor na lombar ·/);
  assert.equal(resumoDaPassagem({ falas: [u('não tenho dor nenhuma na lombar')] }), 'Resumo: última fala: «não tenho dor nenhuma na lombar»');
  assert.equal(resumoDaPassagem({ falas: [u('a dor melhorou bastante')] }), 'Resumo: última fala: «a dor melhorou bastante»');
  assert.doesNotMatch(resumoDaPassagem({ falas: [u('minha dor na lombar piora à noite')] })!, /mencionou/);
  assert.doesNotMatch(resumoDaPassagem({ falas: [u('quero uma segunda opinião sobre o exame')] })!, /mencionou/);
  assert.match(resumoDaPassagem({ falas: [u('o valor da vida é outro, vocês podem me ajudar?')] })!, /falou de preço/);
  assert.doesNotMatch(resumoDaPassagem({ falas: [u('o valor da vida é outro, vocês podem me ajudar?')] })!, /perguntou/);
  assert.match(resumoDaPassagem({ falas: [u('valor?')] })!, /perguntou preço/);
});

test('o trecho vai numa nota que o Chatwoot renderiza: sem menção, sem link, sem colchete; corte não quebra emoji; a última fala é a INTEIRA', () => {
  const r = resumoDaPassagem({ falas: [u('[@Maria](mention://user/3/Maria) urgente https://golpe.com/x')] })!;
  assert.doesNotMatch(r, /[\[\]()@]|mention|golpe/);
  assert.equal(r, 'Resumo: última fala: «Maria link urgente link»');
  const emoji = resumoDaPassagem({ falas: [u(`${'a'.repeat(108)}😀😀 fim`)] })!;
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.equal(resumoDaPassagem({ falas: [u('primeira linha\nsegunda linha\nobrigado')] }), 'Resumo: última fala: «primeira linha / segunda linha / obrigado»');
});

test('não inventa: sem dor, sem dia, sem preço no que o paciente disse, nada disso aparece; fala do assistente não conta', () => {
  const r = resumoDaPassagem({ falas: [s('A consulta custa R$ 350, quinta à tarde tem vaga. Tem dor na coluna?'), u('ok, obrigado')] });
  assert.equal(r, 'Resumo: última fala: «ok, obrigado»');
  assert.equal(resumoDaPassagem({ falas: [] }), null);
  assert.equal(resumoDaPassagem({ falas: [u('[áudio]'), u('[anexo]')] }), null);
  assert.equal(resumoDaPassagem({}), null);
});

test('«falou de preço» (sem pergunta), convênio e exame; última fala cortada; dor sem lugar não vira queixa', () => {
  const longa = 'x'.repeat(300);
  const r = resumoDaPassagem({ falas: [u('o valor é muito alto'), u('vocês aceitam plano de saúde'), u('tenho a ressonância aqui'), u(longa)] })!;
  assert.match(r, /falou de preço · falou de convênio\/plano · falou de exame · última fala: «x{100,}…»$/);
  assert.doesNotMatch(r, /queixa|perguntou/);
  assert.equal(resumoDaPassagem({ falas: [u('dor')] }), 'Resumo: última fala: «dor»');
});

function chat(atributos: Record<string, unknown> = {}) {
  const notas: string[] = [];
  const c: PortaDoChatwoot = {
    conversa: async () => ({ id: 1, nome: '', telefone: '+55', attrs: { ...atributos }, etiquetas: [], grupo: false, interno: false }),
    // como o Chatwoot: o que a rodada grava passa a ser o que a próxima leitura devolve
    gravarAtributos: async (_i, parcial) => void Object.assign(atributos, parcial),
    adicionarEtiquetas: async () => {},
    nota: async (_i, t) => void notas.push(t),
    publica: async () => ({ usuario: null }),
    valoresDoAtributo: async () => ['Esperando humano'],
    etiquetasDaConta: async () => [],
  };
  return { c, notas };
}

test('a nota de passagem ganha o resumo na linha de baixo; sem resumo ela é a de sempre', async () => {
  const a = chat();
  await passarParaEquipeNoChatwoot(a.c, { conversa: 1, etapa: '', motivo: 'pediu atendente', resumo: 'Resumo: dor na lombar há 2 meses · perguntou preço' });
  assert.equal(a.notas[0], '🙋 Sofia passou esta conversa para a equipe: pediu atendente\nResumo: dor na lombar há 2 meses · perguntou preço');
  const b = chat();
  await passarParaEquipeNoChatwoot(b.c, { conversa: 1, etapa: '', motivo: 'pediu atendente' });
  await passarParaEquipeNoChatwoot(b.c, { conversa: 1, etapa: '', motivo: 'pediu atendente', resumo: null });
  assert.deepEqual(b.notas, ['🙋 Sofia passou esta conversa para a equipe: pediu atendente', '🙋 Sofia passou esta conversa para a equipe: pediu atendente']);
});

test('ponta a ponta: o pausar_ia da rodada deixa a nota com o resumo do que a Sofia sabe (falas e atributos da conversa)', async () => {
  const { DynamicStructuredTool } = await import('@langchain/core/tools');
  const { z } = await import('zod');
  const { rodarSofiaDoChatwoot } = await import('./chatwoot-sofia.js');
  const nada = (nome: string) => new DynamicStructuredTool({ name: nome, description: nome, schema: z.object({ leadId: z.number().optional() }), func: async () => 'ok' });
  const a = chat({ qualificacao: 'Morno' });
  const r = await rodarSofiaDoChatwoot(
    {
      unit: { id: 'u', slug: 'x', name: 'Clínica', category: 'saude', sourceProdutos: '', systemPrompt: '' } as never,
      falas: [u('tenho dor na lombar há 2 meses'), s('Entendi'), u('quanto custa? quero falar com uma pessoa')],
      conversa: 9,
      modo: 'ligado',
      lida: { id: 9, nome: 'M', telefone: '+5594999990000', attrs: { qualificacao: 'Morno' }, etiquetas: [], grupo: false, interno: false },
      chat: a.c,
    },
    {
      ferramentas: {
        construirAgenda: () => ({ consultar_horarios: nada('consultar_horarios'), buscar_paciente: nada('buscar_paciente'), cadastrar_paciente: nada('cadastrar_paciente'), agendar_consulta: nada('agendar_consulta'), remarcar_consulta: nada('remarcar_consulta'), cancelar_consulta: nada('cancelar_consulta') }),
        contaDividida: async () => null,
        grade: async () => ({ erro: null, slots: [] }),
        consulta: async () => null,
      },
      rodarTeste: (async (_u: unknown, _f: unknown, opts: any) => {
        const tools = opts.ferramentas({ onCall: () => undefined, tz: 'America/Belem' }) as Array<{ name: string; invoke: (x: unknown) => Promise<string> }>;
        await tools.find((t) => t.name === 'pausar_ia')!.invoke({ motivo: 'pediu atendente' });
        return { ok: true as const, reply: 'Já chamo a equipe!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } };
      }) as never,
    },
  );
  assert.equal(r!.passouParaEquipe, true);
  assert.equal(a.notas.length, 1);
  assert.equal(
    a.notas[0],
    '🙋 Sofia passou esta conversa para a equipe: pediu atendente\nResumo: dor na lombar há 2 meses · perguntou preço · qualificação Morno · última fala: «quanto custa? quero falar com uma pessoa»',
  );
});

// ── rodada do sênior (#478): o resumo lê a conversa de AGORA, não a do começo da rodada ───────────────────────────

/** roda a Sofia numa conversa que começa com consulta Agendada e deixa `rodada` mexer na agenda antes do pausar_ia; devolve a nota de passagem */
async function notaDepoisDe(rodada: (tools: Map<string, (x: unknown) => Promise<string>>) => Promise<void>, consultaNaFranquia: () => { quando: string } | null): Promise<string> {
  const { DynamicStructuredTool } = await import('@langchain/core/tools');
  const { z } = await import('zod');
  const { rodarSofiaDoChatwoot } = await import('./chatwoot-sofia.js');
  // no LIGADO valem as ferramentas reais da agenda (na franquia); aqui elas respondem no formato que as reais respondem
  const ferr = (nome: string, resposta = 'ok') => new DynamicStructuredTool({ name: nome, description: nome, schema: z.object({ leadId: z.number().optional(), data: z.string().optional(), hora: z.string().optional(), confirmado: z.boolean().optional() }), func: async () => resposta });
  const nada = (nome: string) => ferr(nome);
  const a = chat({ data_consulta: '2026-12-01', hora_consulta: '09:30', situacao_consulta: 'Agendado' });
  await rodarSofiaDoChatwoot(
    {
      unit: { id: 'u', slug: 'x', name: 'Clínica', category: 'saude', sourceProdutos: '', systemPrompt: '', businessHoursTimezone: 'America/Sao_Paulo' } as never,
      falas: [u('quero remarcar, mas antes quero falar com uma pessoa')],
      conversa: 9,
      modo: 'ligado',
      // a leitura do COMEÇO da rodada: consulta Agendada para 01/12 às 09:30
      lida: { id: 9, nome: 'M', telefone: '+5594999990000', attrs: { data_consulta: '2026-12-01', hora_consulta: '09:30', situacao_consulta: 'Agendado' }, etiquetas: [], grupo: false, interno: false },
      chat: a.c,
      agora: () => new Date('2026-11-26T15:00:00Z'),
    },
    {
      ferramentas: {
        construirAgenda: () => ({ consultar_horarios: nada('consultar_horarios'), buscar_paciente: nada('buscar_paciente'), cadastrar_paciente: nada('cadastrar_paciente'), agendar_consulta: nada('agendar_consulta'), remarcar_consulta: ferr('remarcar_consulta', 'Consulta remarcada de terça-feira, 01/12/2026 às 09:30 para quinta-feira, 03/12/2026 às 14:00.'), cancelar_consulta: ferr('cancelar_consulta', 'Consulta de terça-feira, 01/12/2026 às 09:30 cancelada.') }),
        contaDividida: async () => null,
        grade: async () => ({ erro: null, slots: [{ time: '14:00', status: 'livre' }] }),
        consulta: async () => consultaNaFranquia(),
      },
      rodarTeste: (async (_u: unknown, _f: unknown, opts: any) => {
        const tools = new Map((opts.ferramentas({ onCall: () => undefined, tz: 'America/Belem' }) as Array<{ name: string; invoke: (x: unknown) => Promise<string> }>).map((t) => [t.name, (x: unknown) => t.invoke(x)] as const));
        await rodada(tools);
        await tools.get('pausar_ia')!({ motivo: 'pediu atendente' });
        return { ok: true as const, reply: 'Já chamo a equipe!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } };
      }) as never,
    } as never,
  );
  assert.equal(a.notas.length, 1);
  return a.notas[0]!;
}

test('a Sofia CANCELA na rodada e passa para a equipe: a nota NÃO mostra a consulta que não existe mais (o resumo lê a conversa de agora)', async () => {
  const nota = await notaDepoisDe(async (t) => {
    const r = await t.get('cancelar_consulta')!({ confirmado: true });
    assert.match(r, /cancelada\./);
  }, () => ({ quando: '2026-12-01T09:30' }));
  assert.doesNotMatch(nota, /consulta Agendado|01\/12/);
  assert.match(nota, /^🙋 Sofia passou esta conversa para a equipe: pediu atendente\nResumo: /);
});

test('a Sofia REMARCA na rodada e passa para a equipe: a nota mostra o dia NOVO, não o do começo da rodada', async () => {
  let remarcou = false;
  const nota = await notaDepoisDe(
    async (t) => {
      remarcou = true; // a franquia já tem a consulta nova quando a conferência de «depoisDeRemarcar» pergunta
      const r = await t.get('remarcar_consulta')!({ data: '2026-12-03', hora: '14:00' });
      assert.match(r, /^Consulta remarcada de /);
    },
    // a franquia: a consulta é a velha até a remarcação e a nova depois dela
    () => ({ quando: remarcou ? '2026-12-03T14:00' : '2026-12-01T09:30' }),
  );
  assert.match(nota, /consulta Agendado: 03\/12 às 14:00/);
  assert.doesNotMatch(nota, /01\/12/);
});

test('sem a leitura de agora (o Chatwoot falhou) a nota não arrisca consulta nem qualificação; e uma função de resumo que lança não impede a passagem', async () => {
  const a = chat({ data_consulta: '2026-12-01', situacao_consulta: 'Agendado', qualificacao: 'Quente' });
  const cega = { ...a.c, conversa: async () => { throw new Error('chatwoot 500'); } };
  await passarParaEquipeNoChatwoot(cega, { conversa: 1, etapa: '', motivo: 'pediu atendente', resumo: (atributos) => resumoDaPassagem({ attrs: atributos, falas: [u('oi')], hoje: '2026-11-26' }) });
  assert.equal(a.notas[0], '🙋 Sofia passou esta conversa para a equipe: pediu atendente\nResumo: última fala: «oi»');
  await passarParaEquipeNoChatwoot(cega, { conversa: 1, etapa: '', motivo: 'pediu atendente', resumo: () => { throw new Error('bug no resumo'); } });
  assert.equal(a.notas[1], '🙋 Sofia passou esta conversa para a equipe: pediu atendente');
});

test('dois áudios seguidos não viram «áudio / áudio»; a última fala é a última COM texto', () => {
  assert.equal(resumoDaPassagem({ falas: [u('oi, tenho dor na lombar'), u('[áudio]\n[áudio]')] }), 'Resumo: dor na lombar · última fala: «oi, tenho dor na lombar»');
  assert.equal(resumoDaPassagem({ falas: [u('[áudio]\n[áudio]')] }), null);
  // áudio sem texto DEPOIS da resposta da Sofia não traz de volta uma fala de antes dela
  assert.equal(resumoDaPassagem({ falas: [u('oi, tenho dor na lombar'), s('Entendi!'), u('[áudio]')] }), 'Resumo: dor na lombar');
  assert.equal(resumoDaPassagem({ falas: [u('quero marcar\n[áudio]')] }), 'Resumo: última fala: «quero marcar»');
  assert.doesNotMatch(resumoDaPassagem({ falas: [u('[anexo]\n[áudio]'), u('ok')] })!, /áudio|anexo/);
});

test('«quanto eu vou esperar?» e «quanto tempo demora?» NÃO são pergunta de preço; «quanto custa?», «quanto é?» e «qual o valor?» são', () => {
  for (const f of ['quanto eu vou esperar?', 'quanto tempo demora a consulta?', 'quanto estou devendo de espera', 'o valorizar do tratamento']) assert.doesNotMatch(resumoDaPassagem({ falas: [u(f)] })!, /preço/, f);
  for (const f of ['quanto custa?', 'quanto é a consulta', 'qual o valor?', 'qual é o preço', 'valor?']) assert.match(resumoDaPassagem({ falas: [u(f)] })!, /perguntou preço/, f);
  assert.match(resumoDaPassagem({ falas: [u('o valor é alto')] })!, /falou de preço/);
});

test('plural e flexão de preço continuam preço; «quanto cobram?», «quais os valores?» perguntam; «valor$»/«pagar$» não são preço', () => {
  for (const f of ['quais os preços?', 'quanto custam as sessões?', 'isso custou caro', 'os valores são altos']) assert.match(resumoDaPassagem({ falas: [u(f)] })!, /preço/, f);
  for (const f of ['quanto cobram pela avaliação?', 'quais os valores?', 'qual seria o valor?', 'quanto ficou?']) assert.match(resumoDaPassagem({ falas: [u(f)] })!, /perguntou preço/, f);
  assert.doesNotMatch(resumoDaPassagem({ falas: [u('pagar$ agora')] })!, /preço/);
});

// ── senior rodada 2 (#478): o resumo não afirma o que o paciente não disse ────────────────────────────

test('o tempo é DA dor: «dor no joelho e minha mãe faleceu há 2 anos» NÃO vira «dor no joelho há 2 anos»; o tempo da própria dor (antes, depois, com vírgula) continua', () => {
  for (const f of ['dor no joelho e minha mãe faleceu há 2 anos', 'tenho dor no joelho, minha mãe faleceu há 2 anos', 'dor no joelho. meu pai tem câncer há 3 anos', 'dor no joelho mas meu marido operou há 5 meses']) {
    const queixa = resumoDaPassagem({ falas: [u(f)] })!.split(' · ')[0];
    assert.equal(queixa, 'Resumo: dor no joelho', f);
  }
  assert.match(resumoDaPassagem({ falas: [u('dor no joelho há 2 anos')] })!, /^Resumo: dor no joelho há 2 anos/);
  assert.match(resumoDaPassagem({ falas: [u('há 2 meses tenho dor na lombar')] })!, /^Resumo: dor na lombar há 2 meses/);
  assert.match(resumoDaPassagem({ falas: [u('dor no joelho, faz 3 semanas')] })!, /^Resumo: dor no joelho há 3 semanas/);
});

test('«quanto é o tempo de espera?» NÃO é preço (nem «falou de preço»); «quanto é a consulta?» é', () => {
  for (const f of ['quanto é o tempo de espera?', 'quanto é a espera?', 'quanto fica longe daí?', 'quanto é de distância até aí?', 'quanto demora a consulta?']) assert.doesNotMatch(resumoDaPassagem({ falas: [u(f)] })!, /preço/, f);
  for (const f of ['quanto é a consulta?', 'quanto é?', 'quanto fica a avaliação?']) assert.match(resumoDaPassagem({ falas: [u(f)] })!, /perguntou preço/, f);
});

test('markdown e link do paciente na nota: «golpe.com/x **urgente**» não vira link nem negrito; domínio solto, ~riscado~, # título e | tabela também não', () => {
  const r = resumoDaPassagem({ falas: [u('golpe.com/x **urgente**')] })!;
  assert.doesNotMatch(r, /golpe|\*\*urgente\*\*/);
  assert.equal(r, 'Resumo: última fala: «link \\*\\*urgente\\*\\*»');
  const outros = resumoDaPassagem({ falas: [u('# oi ~x~ a | b ![i](http://x.co/y.png) bit.ly/abc _z_')] })!;
  assert.doesNotMatch(outros, /bit\.ly|http|x\.co/);
  assert.doesNotMatch(outros, /(?<!\\)[*_~#|!]/, 'todo caractere de markdown vem escapado');
  assert.equal(resumoDaPassagem({ falas: [u('meu e-mail é ana@gmail.com e o site dr.silva')] })!.includes('@'), false);
});

test('«hoje» da unidade no limite do dia: Boa Vista (UTC−4) às 23h30 ainda é o dia anterior ao de São Paulo, e a consulta de «hoje» segue no resumo', () => {
  const agora = new Date('2026-11-27T03:30:00Z'); // São Paulo 00:30 de 27/11; Boa Vista 23:30 de 26/11
  assert.equal(hojeDaUnidade({ businessHoursTimezone: 'America/Sao_Paulo' }, agora), '2026-11-27');
  assert.equal(hojeDaUnidade({ businessHoursTimezone: 'America/Boa_Vista' }, agora), '2026-11-26');
  assert.equal(hojeDaUnidade({}, agora), '2026-11-27', 'sem fuso: o padrão da rede (São Paulo)');
  const attrs = { data_consulta: '2026-11-26', hora_consulta: '18:00', situacao_consulta: 'Agendado' };
  const falas = [u('oi')];
  assert.match(resumoDaPassagem({ attrs, falas, hoje: hojeDaUnidade({ businessHoursTimezone: 'America/Boa_Vista' }, agora) })!, /consulta Agendado: 26\/11 às 18:00/);
  assert.equal(resumoDaPassagem({ attrs, falas, hoje: hojeDaUnidade({ businessHoursTimezone: 'America/Sao_Paulo' }, agora) }), 'Resumo: última fala: «oi»', 'em São Paulo a consulta de ontem já passou');
});

// ── review do /code-review high (rodada 3) ─────────────────────────────────────────────────────────

test('o tempo MAIS PRÓXIMO da dor vale e o de outra pessoa nunca: «minha mãe faleceu há 2 anos, tenho dor no joelho» não ganha «há 2 anos»; «meu pai faleceu há 3 anos, tenho dor no joelho há 2 meses» fica «há 2 meses»', () => {
  const queixa = (f: string) => resumoDaPassagem({ falas: [u(f)] })!.split(' · ')[0];
  assert.equal(queixa('minha mãe faleceu há 2 anos, tenho dor no joelho'), 'Resumo: dor no joelho');
  assert.equal(queixa('meu pai faleceu há 3 anos, tenho dor no joelho há 2 meses'), 'Resumo: dor no joelho há 2 meses');
  assert.equal(queixa('há 2 meses, tenho dor no joelho'), 'Resumo: dor no joelho há 2 meses');
  assert.equal(queixa('faz 3 semanas que tenho dor no joelho'), 'Resumo: dor no joelho há 3 semanas');
});

test('e-mail e domínios: o e-mail inteiro some («meu e-mail é ana@gmail.com» não deixa «gmail.com» solto); .pro/.pt/.tv também; «obrigado.Me ajuda» não vira link', () => {
  const r = resumoDaPassagem({ falas: [u('meu e-mail é ana@gmail.com')] })!;
  assert.doesNotMatch(r, /gmail|@/);
  assert.equal(r, 'Resumo: última fala: «meu e-mail é e-mail»');
  for (const f of ['fale no meusite.pro', 'x.pt/abc', 'veja canal.tv e GOLPE.COM/x']) assert.doesNotMatch(resumoDaPassagem({ falas: [u(f)] })!, /meusite|x\.pt|canal\.tv|GOLPE/, f);
  assert.match(resumoDaPassagem({ falas: [u('obrigado.Me ajuda')] })!, /«obrigado\.Me ajuda»/);
});

test('«quanto é o diagnóstico?» / «quanto custa a diária?» SÃO pergunta de preço (a lista de tempo tem fronteira de palavra)', () => {
  for (const f of ['quanto é o diagnóstico?', 'quanto custa a diária?', 'quanto é a hora?']) assert.match(resumoDaPassagem({ falas: [u(f)] })!, /perguntou preço/, f);
  assert.doesNotMatch(resumoDaPassagem({ falas: [u('quanto é o tempo?')] })!, /preço/);
});

test('o corte é do texto CRU e o escape vem depois: nenhuma barra solta antes do «…» nem fala encolhida pelas barras', () => {
  const r = resumoDaPassagem({ falas: [u(`${'*a'.repeat(80)} fim`)] })!;
  assert.doesNotMatch(r, /\\…|\\»/, 'sem barra solta na borda');
  const miolo = r.split('«')[1]!.replace(/»$/, '');
  assert.equal(Array.from(miolo.replace(/\\/g, '')).length <= 110, true);
  assert.equal(Array.from(miolo.replace(/\\/g, '')).length >= 100, true, 'o corte conta os caracteres do paciente, não as barras');
});
