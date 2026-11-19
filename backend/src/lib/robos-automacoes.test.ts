/**
 * Aba «Automações» da tela «Robôs»: o que aparece (agrupado), de onde vem cada estado, quem pode mudar (só administrador do Chatwoot), as travas
 * do console (modo seco, só no papel antes de ligar) e a confirmação do que não tem volta. Confere também, no CÓDIGO, que os comportamentos da
 * Sofia listados valem no caminho do Chatwoot e que os «só no Kommo» não são usados por ele.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const A = await import('./robos-automacoes.js');
const { AUTOMACOES, automacaoPorId } = await import('./automacoes.js');
const { _semearParaTeste, panoramaDaUnidade } = await import('./automacoes-estado.js');

const fonte = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function bancoFalso(o: { mudancas?: Array<{ automacao: string; por: string | null; em: Date }>; ultimas?: Record<string, import('./robos-automacoes.js').UltimaAcao[]>; semUnidade?: boolean } = {}) {
  const gravacoes: Array<{ unit: { id: string }; automacao: string; estado: string; por: string }> = [];
  const banco: import('./robos-automacoes.js').BancoDasAutomacoes = {
    async mudancas() {
      return o.mudancas ?? [];
    },
    async ultimas(id) {
      return o.ultimas?.[id] ?? [];
    },
    async unidade(slug) {
      return o.semUnidade ? null : { id: 'u1', slug };
    },
    async gravar(unit, automacao, estado, por) {
      gravacoes.push({ unit, automacao, estado, por });
    },
  };
  return { banco, gravacoes };
}

const SLUG = 'doutor-hernia-parauapebas';

test('a lista: grupos na ordem, as seis chatwoot-*, os comportamentos da Sofia do Chatwoot e as fixas só de leitura', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'chatwoot-regua', estado: 'seco' }, { slug: SLUG, automacao: 'chatwoot-ia', estado: 'ligado' }]);
  const { banco } = bancoFalso();
  const l = await A.automacoesDaUnidade(banco, SLUG, { env: {} });
  const ids = l.map((x) => x.id);
  for (const id of ['chatwoot-ia', 'chatwoot-agenda', 'chatwoot-regua', 'chatwoot-capi', 'chatwoot-origem', 'chatwoot-duplicados']) assert.ok(ids.includes(id), id);
  // toda automação chatwoot-* do catálogo aparece (nenhuma nova fica de fora)
  // (as ÚNICAS de fora de propósito: o disparo em massa e as tarefas que mandam mensagem sozinhas só a Doutor Digital liga, pelo console — a clínica não as liga pela tela)
  // e as duas que mandam mensagem sozinhas NÃO aparecem na tela da clínica
  assert.ok(!ids.includes('chatwoot-tarefas') && !ids.includes('chatwoot-disparo'), 'só a Doutor Digital liga: a tela Robôs da clínica não mostra nem muda');
  for (const a of AUTOMACOES.filter((x) => x.id.startsWith('chatwoot-') && x.id !== 'chatwoot-disparo' && x.id !== 'chatwoot-tarefas')) assert.ok(ids.includes(a.id), `${a.id} sumiu da tela`);
  assert.ok(!ids.includes('chatwoot-disparo'), 'chatwoot-disparo NÃO pode aparecer na tela da clínica');
  // ordem dos grupos
  const ordem = l.map((x) => x.grupo);
  const vistos = [...new Set(ordem)];
  assert.deepEqual(vistos, A.ORDEM_DOS_GRUPOS.filter((g) => vistos.includes(g)));
  assert.deepEqual(vistos.slice(0, 2), ['sofia', 'agenda']);
  // estado real da unidade
  assert.equal(l.find((x) => x.id === 'chatwoot-regua')!.estado, 'seco');
  assert.equal(l.find((x) => x.id === 'chatwoot-ia')!.estado, 'ligado');
  assert.equal(l.find((x) => x.id === 'chatwoot-ia')!.vemDoAmbiente, false);
  assert.equal(l.find((x) => x.id === 'chatwoot-agenda')!.vemDoAmbiente, true);
  // texto simples e cuidado vêm do catálogo; só as do catálogo são editáveis
  const regua = l.find((x) => x.id === 'chatwoot-regua')!;
  assert.equal(regua.oQueFaz, automacaoPorId('chatwoot-regua')!.oQueFaz);
  assert.equal(regua.cuidado, automacaoPorId('chatwoot-regua')!.pegadinha ?? null);
  assert.deepEqual(regua.estados, ['ligado', 'seco', 'desligado']);
  for (const x of l) assert.equal(x.editavel, x.origem === 'catalogo', x.id);
  for (const x of l.filter((y) => y.origem === 'fixa')) {
    assert.deepEqual(x.estados, []);
    assert.match(x.nota ?? '', /Doutor Digital/);
    assert.equal(x.semRegistro, true);
  }
});

test('as fixas leem o estado do MESMO ambiente que o código lê; sem interruptor = sempre ligada', async () => {
  const { banco } = bancoFalso();
  const estado = async (env: NodeJS.ProcessEnv) => Object.fromEntries((await A.automacoesDaUnidade(banco, SLUG, { env })).filter((x) => x.origem === 'fixa').map((x) => [x.id, x.estado]));
  const padrao = await estado({});
  assert.equal(padrao['fixa-atalhos'], 'ligado');
  assert.equal(padrao['fixa-resolver'], 'ligado');
  assert.equal(padrao['fixa-guia-etapa'], 'ligado', 'o guia da etapa vem ligado');
  assert.equal(padrao['fixa-etiqueta-anuncio'], 'ligado');
  assert.equal(padrao['fixa-nota-anuncio'], 'ligado');
  assert.equal(padrao['fixa-sofia-robo'], 'desligado', 'a Sofia como robô só liga com CHATWOOT_SOFIA_COMO_BOT=1');
  assert.equal(padrao['fixa-sofia-atendendo'], 'desligado', 'sem robô não há «Pendentes» a corrigir');
  assert.equal(padrao['fixa-pausa-celular'], 'sempre');
  assert.equal(padrao['fixa-perdido-motivo'], 'sempre');
  assert.equal(padrao['fixa-avisos-regua'], 'sempre');
  const desl = await estado({ CHATWOOT_ATALHOS: '0', CHATWOOT_RESOLVER_OBRIGATORIO: '0', CHATWOOT_ETIQUETA_ANUNCIO: '0', CHATWOOT_NOTA_ANUNCIO: '0', CHATWOOT_SOFIA_COMO_BOT: '1', CHATWOOT_SOFIA_BOT_TOKEN: 'token-do-robo-123456' });
  assert.equal(desl['fixa-atalhos'], 'desligado');
  assert.equal(desl['fixa-resolver'], 'desligado');
  assert.equal((await estado({ CHATWOOT_GUIA_ETAPA: '0' }))['fixa-guia-etapa'], 'desligado', '«0» desliga o guia da etapa');
  assert.equal(desl['fixa-etiqueta-anuncio'], 'desligado');
  assert.equal(desl['fixa-nota-anuncio'], 'desligado');
  assert.equal(desl['fixa-sofia-robo'], 'ligado');
  assert.equal(desl['fixa-sofia-atendendo'], 'ligado', 'com o robô, vem ligado');
  assert.equal((await estado({ CHATWOOT_SOFIA_COMO_BOT: '1', CHATWOOT_SOFIA_BOT_TOKEN: 'token-do-robo-123456', CHATWOOT_SOFIA_ATENDENDO: '0' }))['fixa-sofia-atendendo'], 'desligado', '«0» desliga o «Sofia atendendo»');
  assert.equal((await estado({ CHATWOOT_SOFIA_COMO_BOT: '1' }))['fixa-sofia-atendendo'], 'desligado', 'COMO_BOT=1 sem token do robô: o código não age, o painel não pode dizer ligado');
  // e as variáveis citadas existem de verdade no código que as lê
  const codigo = ['chatwoot-assistente-ui.ts', 'chatwoot-guia-etapas.ts', 'chatwoot-origem.ts', 'chatwoot-anuncio.ts', 'chatwoot-sofia-bot.ts', 'chatwoot-sofia-atendendo.ts'].map((f) => fonte(`./${f}`)).join('\n');
  for (const f of A.FIXAS.filter((x) => x.variavel)) assert.ok(codigo.includes(f.variavel!), `${f.variavel} não está mais no código`);
});

test('aba «Automações» não espera o histórico lento: buscas juntas, com teto (15/11: a aba ficava 60 s em «Carregando…»)', async () => {
  const { banco } = bancoFalso({});
  let chamadas = 0;
  banco.ultimas = async (id) => {
    chamadas++;
    if (id === 'chatwoot-agenda') return new Promise(() => {}); // nunca responde
    await new Promise((r) => setTimeout(r, 40));
    return [{ em: '2026-11-15T12:00:00.000Z', nivel: 'info', texto: `${id}: ciclo`, resumo: '' }];
  };
  const t0 = Date.now();
  const l = await A.automacoesDaUnidade(banco, SLUG, { env: {}, tetoMs: 150 });
  const ms = Date.now() - t0;
  assert.ok(ms < 600, `levou ${ms} ms — as buscas precisam correr juntas e respeitar o teto`);
  assert.equal(chamadas, l.filter((x) => x.origem === 'catalogo').length);
  assert.deepEqual(l.find((x) => x.id === 'chatwoot-agenda')!.ultimas, [], 'a que travou aparece sem histórico');
  assert.equal(l.find((x) => x.id === 'chatwoot-ia')!.ultimas.length, 1);
  assert.match(fonte('./robos-automacoes.ts'), /createdAt: \{ gte: new Date\(Date\.now\(\) - DIAS_DO_HISTORICO/, 'a busca no log olha só os últimos dias');
});

test('«últimas ações»: o que o log guardou; sem log, «sem registro» (nada inventado); quem mexeu por último', async () => {
  const em = new Date('2026-11-16T10:00:00Z');
  const { banco } = bancoFalso({
    mudancas: [{ automacao: 'chatwoot-agenda', por: 'Suzanne (Chatwoot)', em }],
    ultimas: { 'chatwoot-agenda': [{ em: '2026-11-16T12:00:00.000Z', nivel: 'info', texto: 'chatwoot-agenda: ciclo', resumo: 'agenda 12 · gravadas 3' }] },
  });
  const l = await A.automacoesDaUnidade(banco, SLUG, { env: {} });
  const ag = l.find((x) => x.id === 'chatwoot-agenda')!;
  assert.equal(ag.semRegistro, false);
  assert.equal(ag.ultimas[0]!.resumo, 'agenda 12 · gravadas 3');
  assert.deepEqual(ag.mudou, { por: 'Suzanne (CRM)', em: em.toISOString() }, 'a tela mostra «(CRM)» mesmo para o que foi gravado como «(Chatwoot)»');
  const ia = l.find((x) => x.id === 'chatwoot-ia')!;
  assert.equal(ia.semRegistro, true);
  assert.deepEqual(ia.ultimas, []);
  assert.equal(ia.mudou, null);
  assert.equal(A.resumoDoContexto({ slug: 'x', agenda: 12, gravadas: 3, caixa: 3, nome: 'a' }), 'agenda 12 · gravadas 3');
  assert.equal(A.resumoDoContexto(null), '');
});

// ── permissão e travas ─────────────────────────────────────────────────────────────────────────────

const pedir = (o: Partial<Parameters<typeof A.mudarAutomacao>[1]> & { hoje?: 'ligado' | 'seco' | 'desligado' | null } = {}) => ({
  slug: SLUG,
  id: 'chatwoot-agenda',
  estado: 'seco',
  papel: 'administrator',
  por: 'Suzanne',
  estadoAtual: () => o.hoje ?? 'desligado',
  ...o,
});

test('só administrador do CRM muda; atendente (agent/sem papel) é recusada e nada é gravado; o registro leva o nome e «(Chatwoot)» (a tela mostra «(CRM)»)', async () => {
  const { banco, gravacoes } = bancoFalso();
  for (const papel of ['agent', null, undefined, '']) {
    const r = await A.mudarAutomacao(banco, pedir({ papel }));
    assert.equal(r.ok, false, String(papel));
    assert.equal(!r.ok && r.status, 403);
  }
  assert.equal(gravacoes.length, 0);
  const ok = await A.mudarAutomacao(banco, pedir());
  assert.deepEqual(ok, { ok: true, id: 'chatwoot-agenda', estado: 'seco' });
  assert.deepEqual(gravacoes, [{ unit: { id: 'u1', slug: SLUG }, automacao: 'chatwoot-agenda', estado: 'seco', por: 'Suzanne (Chatwoot)' }]);
});

test('só as automações da tela: o resto do catálogo, as fixas e id inventado são 404; estado inválido e seco sem modo seco são 400', async () => {
  const { banco, gravacoes } = bancoFalso();
  for (const id of ['parados', 'sofia-calada', 'fixa-atalhos', 'nativa-1', 'inventada', 123]) {
    const r = await A.mudarAutomacao(banco, pedir({ id }));
    assert.equal(!r.ok && r.status, 404, String(id));
  }
  assert.equal((await A.mudarAutomacao(banco, pedir({ estado: 'ativado' }))).ok, false);
  assert.equal((await A.mudarAutomacao(banco, pedir({ estado: undefined }))).ok, false);
  // modo seco só onde o catálogo tem
  const semSeco = Object.keys(A.DO_CATALOGO).find((id) => !automacaoPorId(id)!.temSeco);
  if (semSeco) {
    const r = await A.mudarAutomacao(banco, pedir({ id: semSeco, estado: 'seco' }));
    assert.equal(!r.ok && r.status, 400);
  }
  const semUnidade = bancoFalso({ semUnidade: true });
  assert.equal(((await A.mudarAutomacao(semUnidade.banco, pedir())) as { status?: number }).status, 404);
  assert.equal(gravacoes.length, 0);
});

test('ligar exige ter rodado em «Só no papel» (como no console); desligar e pôr no papel não exigem', async () => {
  const { banco, gravacoes } = bancoFalso();
  const r = await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-regua', estado: 'ligado', hoje: 'desligado' }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 400);
  assert.match(!r.ok ? r.erro : '', /Só no papel/);
  assert.equal((await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-regua', estado: 'ligado', hoje: 'seco' }))).ok, true);
  assert.equal((await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-regua', estado: 'desligado', hoje: 'ligado' }))).ok, true);
  assert.equal((await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-regua', estado: 'seco', hoje: 'desligado' }))).ok, true);
  assert.equal(gravacoes.length, 3);
});

test('o que NÃO TEM VOLTA (juntar contatos, evento para a Meta) pede confirmação explícita para ligar; sem confirmar não grava', async () => {
  assert.equal(A.semVolta(automacaoPorId('chatwoot-duplicados')!), true);
  assert.equal(A.semVolta(automacaoPorId('chatwoot-capi')!), true);
  for (const id of ['chatwoot-regua', 'chatwoot-ia', 'chatwoot-agenda', 'chatwoot-origem']) assert.equal(A.semVolta(automacaoPorId(id)!), false, id);
  const { banco, gravacoes } = bancoFalso();
  for (const id of ['chatwoot-duplicados', 'chatwoot-capi']) {
    const sem = await A.mudarAutomacao(banco, pedir({ id, estado: 'ligado', hoje: 'seco' }));
    assert.equal(sem.ok, false);
    assert.equal(!sem.ok && sem.status, 409);
    assert.equal(!sem.ok && sem.precisaConfirmar, true);
    for (const confirmar of ['true', 1, 'sim', false, undefined]) assert.equal((await A.mudarAutomacao(banco, pedir({ id, estado: 'ligado', hoje: 'seco', confirmar }))).ok, false, String(confirmar));
  }
  assert.equal(gravacoes.length, 0);
  assert.equal((await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-duplicados', estado: 'ligado', hoje: 'seco', confirmar: true }))).ok, true);
  // desligar e pôr no papel nunca pedem confirmação; religar o que já está ligado também não
  assert.equal((await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-duplicados', estado: 'desligado', hoje: 'ligado' }))).ok, true);
  assert.equal((await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-capi', estado: 'seco', hoje: 'desligado' }))).ok, true);
  assert.equal((await A.mudarAutomacao(banco, pedir({ id: 'chatwoot-capi', estado: 'ligado', hoje: 'ligado' }))).ok, true);
});

// ── Sofia: o que vale no caminho do Chatwoot (conferido no código) ────────────────────────────────

test('os comportamentos da Sofia listados valem no caminho do Chatwoot; os «só no Kommo» não são usados por ele', () => {
  const composer = fonte('../agent/prompt-composer.ts');
  const direta = fonte('../agent/conversa-direta.ts');
  const guardrail = fonte('../agent/guardrail.ts');
  const convenio = fonte('../agent/preco-convenio.ts');
  const sofiaChatwoot = fonte('./chatwoot-sofia.ts');
  // o Chatwoot monta o prompt pelo compositor e limpa a saída pelo guardrail
  assert.ok(fonte('../controllers/playground.controller.ts').includes('composeSystemPromptForUnit'));
  assert.ok(sofiaChatwoot.includes("aplicarGuardrail"));
  assert.ok(composer.includes("'encerramento-pergunta-motivo'") && composer.includes("'prompt-da-unidade'") && composer.includes('sorrisoColoridoLigado') && composer.includes('renderConversaDiretaDaUnidade'));
  for (const id of ['conduzir-direto', 'nome-na-hora-de-marcar', 'sem-pergunta-de-alerta']) assert.ok(direta.includes(`'${id}'`), id);
  assert.ok(guardrail.includes('corrigirPrecoDoConvenio') && convenio.includes("'preco-convenio'"));
  for (const id of ['conduzir-direto', 'nome-na-hora-de-marcar', 'sem-pergunta-de-alerta', 'preco-convenio', 'sorriso-colorido', 'encerramento-pergunta-motivo', 'prompt-da-unidade']) assert.ok(id in A.DO_CATALOGO, id);
  // o caminho do Chatwoot (chatwoot-ia + chatwoot-sofia) não consulta os que são do Kommo
  const caminho = fonte('./chatwoot-ia.ts') + sofiaChatwoot;
  const gates = ['sofiaCaladaLiberada', 'pacienteEmTratamento', 'calarPacienteEmTratamento', 'semCarinhaLigado', 'exameDeImagemLigado', "'teto-mensal'", "'cache-conversa'", "'pausa-equipe'", "'sofia-calada'", "'calar-paciente-em-tratamento'", "'sem-carinha'"];
  for (const g of gates) assert.equal(caminho.includes(g), false, `${g} aparece no caminho do Chatwoot: tire de SO_NO_KOMMO e ponha na tela`);
  for (const id of A.SO_NO_KOMMO) assert.ok(automacaoPorId(id), id);
  for (const id of A.SO_NO_KOMMO) assert.equal(id in A.DO_CATALOGO, false, id);
  // tudo o que a tela lista do catálogo existe no catálogo
  for (const id of Object.keys(A.DO_CATALOGO)) assert.ok(automacaoPorId(id), id);
  assert.ok(panoramaDaUnidade(SLUG, {}).length > 0);
});
