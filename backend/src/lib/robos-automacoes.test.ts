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
    async ultimasDe() {
      return o.ultimas ?? {};
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
  assert.ok(!ids.includes('chatwoot-tarefas') && !ids.includes('chatwoot-disparo') && !ids.includes('chatwoot-demora'), 'só a Doutor Digital liga: a tela Robôs da clínica não mostra nem muda');
  for (const a of AUTOMACOES.filter((x) => x.id.startsWith('chatwoot-') && x.id !== 'chatwoot-disparo' && x.id !== 'chatwoot-tarefas' && x.id !== 'chatwoot-demora')) assert.ok(ids.includes(a.id), `${a.id} sumiu da tela`);
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
  assert.equal(padrao['fixa-selo-sofia'], 'ligado', 'o selo da Sofia vem ligado');
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
  assert.equal((await estado({ CHATWOOT_SELO_SOFIA: ' 0 ' }))['fixa-selo-sofia'], 'desligado', '«0» desliga o selo (mesma regra do menu.js, com trim)');
  assert.equal(desl['fixa-etiqueta-anuncio'], 'desligado');
  assert.equal(desl['fixa-nota-anuncio'], 'desligado');
  assert.equal(desl['fixa-sofia-robo'], 'ligado');
  assert.equal(desl['fixa-sofia-atendendo'], 'ligado', 'com o robô, vem ligado');
  assert.equal((await estado({ CHATWOOT_SOFIA_COMO_BOT: '1', CHATWOOT_SOFIA_BOT_TOKEN: 'token-do-robo-123456', CHATWOOT_SOFIA_ATENDENDO: '0' }))['fixa-sofia-atendendo'], 'desligado', '«0» desliga o «Sofia atendendo»');
  assert.equal((await estado({ CHATWOOT_SOFIA_COMO_BOT: '1' }))['fixa-sofia-atendendo'], 'desligado', 'COMO_BOT=1 sem token do robô: o código não age, o painel não pode dizer ligado');
  // e as variáveis citadas existem de verdade no código que as lê
  const codigo = ['chatwoot-assistente-ui.ts', 'chatwoot-guia-etapas.ts', 'chatwoot-origem.ts', 'chatwoot-anuncio.ts', 'chatwoot-sofia-bot.ts', 'chatwoot-sofia-atendendo.ts', 'chatwoot-selo-sofia.ts'].map((f) => fonte(`./${f}`)).join('\n');
  for (const f of A.FIXAS.filter((x) => x.variavel)) assert.ok(codigo.includes(f.variavel!), `${f.variavel} não está mais no código`);
});

test('aba «Automações» não espera o histórico lento: UMA busca, com teto (15/11 e 23/11: a aba ficava 5–60 s em «Carregando…»)', async () => {
  const { banco } = bancoFalso({});
  let buscas = 0;
  banco.ultimasDe = async (ids) => {
    buscas++;
    await new Promise((r) => setTimeout(r, 40));
    return Object.fromEntries(ids.map((id) => [id, [{ em: '2026-11-15T12:00:00.000Z', nivel: 'info', texto: `${id}: ciclo`, resumo: '' }]]));
  };
  const l = await A.automacoesDaUnidade(banco, SLUG, { env: {}, tetoMs: 150 });
  assert.equal(buscas, 1, 'o log é lido UMA vez para todas as automações (eram 14 buscas na mesma janela)');
  assert.equal(l.find((x) => x.id === 'chatwoot-agenda')!.ultimas.length, 1);
  assert.equal(l.find((x) => x.id === 'chatwoot-ia')!.ultimas.length, 1);
  const fonteLib = fonte('./robos-automacoes.ts');
  assert.match(fonteLib, /created_at >= \$\{desde\}/, 'a busca no log olha só os últimos dias');
  assert.match(fonteLib, /const desde = new Date\(Date\.now\(\) - DIAS_DO_HISTORICO/);
});

test('23/11: se o histórico OU «quem mexeu» travar, a aba abre dentro do teto, a parte que travou vem vazia e o aviso diz qual', async () => {
  for (const travada of ['ultimas', 'mudancas', 'as duas'] as const) {
    const { banco } = bancoFalso({ mudancas: [{ automacao: 'chatwoot-agenda', por: 'Suzanne (Chatwoot)', em: new Date('2026-11-16T10:00:00Z') }], ultimas: { 'chatwoot-agenda': [{ em: '2026-11-16T12:00:00.000Z', nivel: 'info', texto: 'chatwoot-agenda: ciclo', resumo: '' }] } });
    const boa = { mudancas: banco.mudancas, ultimasDe: banco.ultimasDe };
    if (travada !== 'mudancas') banco.ultimasDe = () => new Promise(() => {}); // nunca responde
    if (travada !== 'ultimas') banco.mudancas = () => new Promise(() => {});
    const falhou: string[] = [];
    const t0 = Date.now();
    const l = await A.automacoesDaUnidade(banco, SLUG, { env: {}, tetoMs: 150, aoFalhar: (p) => falhou.push(p) });
    const ms = Date.now() - t0;
    assert.ok(ms < 600, `${travada}: levou ${ms} ms — cada leitura do banco precisa de teto (o «quem mexeu» não tinha e esperava a fila do pool)`);
    const ag = l.find((x) => x.id === 'chatwoot-agenda')!;
    assert.equal(l.length > 10, true, 'a lista abre inteira');
    assert.deepEqual(falhou.sort(), travada === 'as duas' ? ['mudancas', 'ultimas'] : [travada]);
    assert.equal(ag.ultimas.length, travada === 'mudancas' ? 1 : 0, 'o histórico vem vazio só se ELE travou');
    assert.equal(ag.mudou === null, travada !== 'ultimas', '«quem mexeu» vem vazio só se ELE travou');
    void boa;
  }
});

test('23/11: erro do banco (não só demora) também vira «parte vazia + aviso», e leitura que deu certo não avisa', async () => {
  const { banco } = bancoFalso({});
  banco.ultimasDe = async () => { throw new Error('pool esgotado'); };
  const falhou: string[] = [];
  const l = await A.automacoesDaUnidade(banco, SLUG, { env: {}, aoFalhar: (p) => falhou.push(p) });
  assert.deepEqual(falhou, ['ultimas']);
  assert.ok(l.length > 10);
  const ok: string[] = [];
  await A.automacoesDaUnidade(bancoFalso({}).banco, SLUG, { env: {}, aoFalhar: (p) => ok.push(p) });
  assert.deepEqual(ok, []);
});

test('23/11: a memória curta junta pedidos seguidos numa busca só, expira, e erro não fica guardado', async () => {
  const memoria = new Map<string, { ate: number; p: Promise<number> }>();
  let agora = 1_000;
  let buscas = 0;
  const buscar = async () => ++buscas;
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => A.comMemoriaCurta(memoria, 'k', 60_000, buscar, () => agora)));
  assert.deepEqual([a, b, c], [1, 1, 1], 'três aberturas da aba ao mesmo tempo = uma busca (a tela dispara várias de uma vez)');
  agora += 59_000;
  assert.equal(await A.comMemoriaCurta(memoria, 'k', 60_000, buscar, () => agora), 1);
  agora += 2_000;
  assert.equal(await A.comMemoriaCurta(memoria, 'k', 60_000, buscar, () => agora), 2, 'passou o prazo: busca de novo');
  assert.equal(await A.comMemoriaCurta(memoria, 'outra', 60_000, buscar, () => agora), 3, 'chave (unidade) diferente não se mistura');
  let tentativas = 0;
  const falha = () => { tentativas++; return Promise.reject(new Error('x')); };
  await assert.rejects(A.comMemoriaCurta(memoria, 'e', 60_000, falha, () => agora));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(A.comMemoriaCurta(memoria, 'e', 60_000, falha, () => agora));
  assert.equal(tentativas, 2, 'erro não fica na memória: a próxima abertura tenta de novo');
});

test('23/11: a busca do log é UMA consulta (não uma por automação), da unidade, e a aba/controller têm os tetos e o aviso', () => {
  const lib = fonte('./robos-automacoes.ts');
  assert.equal((lib.match(/system_logs/g) ?? []).length >= 1, true);
  assert.equal((lib.match(/\$queryRaw/g) ?? []).length, 1, 'uma consulta só para o histórico de todas as automações');
  assert.doesNotMatch(lib, /systemLog\.findMany/, 'nada de uma busca por automação');
  assert.match(lib, /context->>'slug' = \$\{slug\}/, 'só desta unidade');
  const ctl = fonte('../controllers/robos.controller.ts');
  assert.match(ctl, /comTeto\(recarregarAutomacoes\(\), TETO_DO_RECARREGAR_MS/);
  assert.match(ctl, /aoFalhar: \(parte\) => parcial\.push\(parte\)/);
  assert.match(ctl, /\n\s+parcial,/, 'a resposta leva o aviso do que não foi lido');
  assert.match(fonte('./robos-pagina.ts'), /parcial\.indexOf\('ultimas'\)/, 'a tela diz que não leu em vez de «sem registro»');
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
