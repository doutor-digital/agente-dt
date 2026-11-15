/**
 * Fase 2 do kit — o `--aplicar` INTEIRO contra um Chatwoot e um Kapso de mentira (no nível do HTTP, com a API de plataforma), na «Clínica
 * Demonstração». Prova: cada passo cria o que falta, a segunda rodada não cria NADA, nenhum segredo sai no texto, e o que é Meta/Kapso fica em seco.
 * O Chatwoot de mentira recusa nome repetido (422) como o de verdade: passo que não fosse idempotente derrubaria o teste.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const { executarPlano, relatorioFinal } = await import('./executar.js');
type BancoPorta = import('./executar.js').BancoPorta;
type ConfigGravada = import('./executar.js').ConfigGravada;
const { montarPlano } = await import('./plano.js');
const { lerQuestionario } = await import('./questionario.js');
const { chatwootFalso } = await import('./chatwoot-falso.js');
const { contaHttp, plataformaHttp } = await import('./chatwoot-http.js');
const { kapsoHttp } = await import('./kapso-http.js');
const { segredosEmArquivo } = await import('./segredos.js');
const { chaveDoEvento } = await import('../chatwoot-ia.js');

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const MOLDE = readFileSync(join(OPS, 'molde-sofia/bloco-conversa.md'), 'utf8');
const ler = (arq: string) => {
  const r = lerQuestionario(readFileSync(join(OPS, arq), 'utf8'));
  assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
  return r.q;
};
const DEMO = ler('unidades/clinica-demonstracao.yaml');
const URL_CW = 'https://crm.exemplo.test';
const URL_AGENTE = 'https://agente.exemplo.test';
const SENHA = 'Aa1!senha-gerada-so-para-o-teste-7731';

/** Banco de mentira COM ESTADO (só o que o fase 2 usa). */
function bancoFalso() {
  const escritas: Array<[string, unknown]> = [];
  const e = { unidade: null as null | { id: string; ativa: boolean; campos: Record<string, unknown> }, config: null as ConfigGravada | null, automacoes: [] as string[], sofia: {} as Record<string, unknown>, caixas: [] as number[] };
  const banco: BancoPorta = {
    async lerUnidade() {
      return e.unidade ? { ...e.unidade, campos: { ...e.unidade.campos } } : null;
    },
    async gravarUnidade(slug, nome, campos, soNaCriacao) {
      escritas.push(['gravarUnidade', slug]);
      const criada = !e.unidade;
      e.unidade = { id: 'u1', ativa: false, campos: { ...(e.unidade?.campos ?? { isActive: false }), ...(criada ? { ...soNaCriacao } : {}), ...campos } };
      return { id: 'u1', criada };
    },
    async lerConfigChatwoot() {
      return e.config ? { ...e.config, dadosModelos: { ...e.config.dadosModelos } } : null;
    },
    async gravarConfigChatwoot(_u, cfg, criar) {
      escritas.push(['gravarConfigChatwoot', Object.keys(cfg).sort().join(',')]);
      e.config = criar ? (cfg as ConfigGravada) : { ...(e.config as ConfigGravada), ...cfg };
    },
    async automacoesDaUnidade() {
      return [...e.automacoes];
    },
    async criarAutomacoesEmSeco(_u, ids) {
      escritas.push(['criarAutomacoesEmSeco', ids.length]);
      e.automacoes.push(...ids);
    },
    async sofiaDaUnidade() {
      return { ...e.sofia, ...(e.unidade?.campos ?? {}) };
    },
    async gravarSofia(_u, campos) {
      escritas.push(['gravarSofia', Object.keys(campos).length]);
      e.sofia = { ...e.sofia, ...campos };
      if (e.unidade) e.unidade.campos = { ...e.unidade.campos, ...campos };
    },
    async caixasRegistradas() {
      return [...e.caixas];
    },
    async registrarCaixa(_u, c) {
      escritas.push(['registrarCaixa', c.id]);
      if (!e.caixas.includes(c.id)) e.caixas.push(c.id);
    },
  };
  return { banco, escritas, e };
}

function montar(opcoes: { semPlataforma?: boolean; senha?: string; semKapso?: boolean; falharVinculo?: number } = {}) {
  const falso = chatwootFalso({ semPlataforma: opcoes.semPlataforma, falharVinculo: opcoes.falharVinculo });
  falso.semear({
    labels: [
      { id: 1, title: 'quente', description: 'lead quente', color: '#ff0000', show_on_sidebar: true },
      { id: 2, title: 'perdido-preco', description: 'motivo', color: '#999999', show_on_sidebar: false },
      { id: 3, title: 'etiqueta-so-de-parauapebas', description: '', color: '#000000', show_on_sidebar: false },
    ],
    attrs: [{ id: 1, attribute_key: 'etapa', attribute_display_name: 'Etapa', attribute_display_type: 6, attribute_values: ['Novo lead', 'Agendado'], attribute_model: 0, attribute_description: 'etapa do funil' }],
    rules: [
      { id: 1, name: 'parar de receber', description: '', event_name: 'message_created', active: true, conditions: [{ attribute_key: 'content', filter_operator: 'contains', values: ['parar'], query_operator: null }], actions: [{ action_name: 'add_label', action_params: ['sem-follow-up'] }] },
      { id: 2, name: 'distribuir para a Cleia', description: '', event_name: 'conversation_created', active: true, conditions: [{ attribute_key: 'inbox_id', filter_operator: 'equal_to', values: [3], query_operator: null }], actions: [{ action_name: 'assign_agent', action_params: [4] }] },
    ],
  });
  const dir = mkdtempSync(join(tmpdir(), 'kit-cofre-'));
  const segredos = segredosEmArquivo(dir, {});
  const externas = {
    plataforma: opcoes.semPlataforma ? null : plataformaHttp(URL_CW, falso.tokenDaPlataforma, falso.fetch),
    abrirConta: (conta: number, token: string) => contaHttp(URL_CW, conta, token, falso.fetch),
    referencia: contaHttp(URL_CW, 1, falso.tokenDeReferencia, falso.fetch),
    kapso: opcoes.semKapso ? null : kapsoHttp('kapso-chave-secreta', falso.fetch),
    segredos,
    urlDoAgente: URL_AGENTE,
    urlDoChatwoot: URL_CW,
    gerarSenha: () => opcoes.senha ?? SENHA,
  };
  return { falso, dir, segredos, externas };
}

async function rodar(q: typeof DEMO, b: ReturnType<typeof bancoFalso>, externas: ReturnType<typeof montar>['externas'] | null, o: { ligarRobo?: boolean; estado?: import('./plano.js').EstadoAtual } = {}) {
  const plano = montarPlano(q, o.estado ?? {}, { molde: MOLDE });
  const linhas: string[] = [];
  const resultados = await executarPlano(plano, q, { banco: b.banco, molde: MOLDE, externas, ligarRobo: o.ligarRobo, dizer: (l) => linhas.push(l), confirmar: async () => true });
  return { plano, resultados, linhas, relatorio: relatorioFinal(plano, resultados) };
}
const sit = (res: Array<{ id: string; situacao: string }>, id: string) => res.find((x) => x.id === id)?.situacao;
const posts = (falso: ReturnType<typeof chatwootFalso>) => falso.chamadas.filter((c) => c.metodo === 'POST');

test('CLÍNICA DEMONSTRAÇÃO: o --aplicar monta tudo na conta própria dela; Meta/Kapso em seco; segredo no cofre e nunca no texto', async () => {
  const { falso, dir, externas } = montar();
  const b = bancoFalso();
  const { resultados, linhas, relatorio } = await rodar(DEMO, b, externas);

  const feitos = ['unidade', 'config-chatwoot', 'conta', 'automacoes-seco', 'etiquetas', 'atributos', 'automacoes-conta', 'caixa', 'time', 'atendentes', 'usuario-celular', 'registrar-caixa', 'webhook', 'dashboard-app', 'mensagens-prontas', 'modelos', 'sofia', 'robo-sofia'];
  for (const id of feitos) assert.equal(sit(resultados, id), 'feito', `${id}: ${JSON.stringify(resultados.find((r) => r.id === id))}`);
  for (const id of ['pastas', 'subdominio', 'segredos', 'franquia']) assert.equal(sit(resultados, id), 'manual', id);
  for (const id of ['numero', 'dataset-capi']) assert.equal(sit(resultados, id), 'nada-a-fazer', `${id}: demonstração não tem número nem CAPI`);

  // a conta é NOVA e a clínica é a dona dela
  const contaId = b.e.config!.contaId!;
  assert.ok(contaId > 1, 'conta própria, nunca a 1');
  const conta = falso.contas.get(contaId)!;
  assert.equal(conta.name, 'Clínica Demonstração');
  assert.equal(falso.contas.get(1)!.inboxes.length, 0, 'a conta de referência (Parauapebas) não foi tocada');
  assert.deepEqual(falso.chamadas.filter((c) => c.conta === 1).map((c) => c.metodo), Array(falso.chamadas.filter((c) => c.conta === 1).length).fill('GET'), 'a referência só foi LIDA');

  // o usuário conector é administrador da conta e o token dele está no cofre (modo 600)
  const conector = [...falso.usuarios.values()].find((u) => u.email === 'conector+clinica-demonstracao@doutordigitalconsultoria.com')!;
  assert.equal(conector.contas.get(contaId), 'administrator');
  const arquivo = join(dir, 'CHATWOOT_API_TOKEN_DEMO');
  assert.equal(readFileSync(arquivo, 'utf8').trim(), conector.access_token);
  assert.equal(statSync(arquivo).mode & 0o777, 0o600);
  assert.ok(existsSync(join(dir, 'CHATWOOT_SOFIA_BOT_TOKEN_DEMO')));

  // etiquetas: as 19 do código + as «perdido-*» da referência (com a cor dela); a etiqueta só de Parauapebas NÃO vem
  const titulos = conta.labels.map((l) => l.title);
  assert.ok(titulos.includes('quente') && titulos.includes('perdido-preco') && titulos.includes('anuncio'));
  assert.ok(!titulos.includes('etiqueta-so-de-parauapebas'));
  assert.equal(conta.labels.find((l) => l.title === 'quente')!.color, '#ff0000');
  // atributos: copiados com tipo e lista da referência; os que a referência não tem entram como texto
  const etapa = conta.attrs.find((a) => a.attribute_key === 'etapa')!;
  assert.deepEqual([etapa.attribute_display_type, etapa.attribute_values], [6, ['Novo lead', 'Agendado']]);
  assert.equal(conta.attrs.filter((a) => a.attribute_model === 0).length, 23);
  assert.equal(conta.attrs.filter((a) => a.attribute_model === 1).length, 1);
  // automações nativas: a segura foi copiada; a que aponta para caixa/agente da OUTRA conta NÃO (e o relatório... as notas dizem)
  assert.deepEqual(conta.rules.map((r) => r.name), ['parar de receber']);
  assert.ok(resultados.find((r) => r.id === 'automacoes-conta')!.notas.some((n) => /NÃO copiei.*distribuir para a Cleia/.test(n)));
  // mensagens prontas com os dados da clínica
  assert.deepEqual(conta.canned.map((c) => c.short_code), ['demo-endereco', 'demo-chegada']);
  assert.match(conta.canned[0]!.content, /Rua Exemplo, 100/);
  // caixa API (demonstração), time, agentes (3 + celular), membros
  assert.equal(conta.inboxes.length, 1);
  assert.equal(conta.inboxes[0]!.channel_type, 'Channel::Api');
  assert.deepEqual(conta.teams.map((t) => t.name), ['Demonstração']);
  assert.equal(conta.teams[0]!.membros.length, 3);
  assert.deepEqual(conta.agents.map((a) => a.email).filter((e) => e.endsWith('@example.com')).sort(), ['celular.demo@example.com', 'gerente.demo@example.com', 'sdr.demo@example.com', 'secretaria.demo@example.com']);
  assert.equal(conta.inboxes[0]!.membros.length, 4);
  // webhook com a chave do token DESTA conta (e não a de nenhuma outra); aba do Funil com ?conta=
  const tokenDaConta = conector.access_token;
  assert.equal(conta.webhooks.length, 1);
  assert.equal(conta.webhooks[0]!.url, `${URL_AGENTE}/api/public/chatwoot/evento?k=${chaveDoEvento(tokenDaConta)}`);
  assert.notEqual(chaveDoEvento(tokenDaConta), chaveDoEvento(falso.tokenDeReferencia));
  assert.deepEqual(conta.apps[0], { id: conta.apps[0]!.id, title: 'Funil', content: [{ type: 'frame', url: `${URL_AGENTE}/funil?conta=${contaId}` }] });
  assert.ok(!conta.apps[0]!.content.some((c) => JSON.stringify(c).includes('k=')), 'a chave não vai na URL da aba');
  // robô: criado, NÃO ligado na caixa sem --ligar-robo
  assert.equal(conta.bots.length, 1);
  assert.equal(conta.inboxes[0]!.agent_bot, null);
  // banco: caixa registrada (cloud), gerente e celular gravados
  assert.deepEqual(b.e.caixas, [conta.inboxes[0]!.id]);
  assert.equal(b.e.config!.gerenteId, conta.agents.find((a) => a.email === 'gerente.demo@example.com')!.id);
  assert.equal(b.e.config!.usuarioCelularId, conta.agents.find((a) => a.email === 'celular.demo@example.com')!.id);
  // automações em seco, nenhuma ligada
  assert.equal(b.e.automacoes.length, 6);
  // Meta/Kapso: NENHUMA chamada (seco)
  assert.equal(falso.chamadas.filter((c) => c.conta === 'kapso').length, 0);
  assert.ok(resultados.find((r) => r.id === 'modelos')!.notas.some((n) => /SECO.*33 modelo/.test(n)));

  // NADA de segredo no que sai
  const tudo = [...linhas, relatorio].join('\n');
  for (const segredo of [falso.tokenDaPlataforma, falso.tokenDeReferencia, SENHA, conector.access_token, conta.bots[0]!.access_token, 'kapso-chave-secreta', chaveDoEvento(tokenDaConta)]) {
    assert.ok(!tudo.includes(segredo), `vazou segredo no texto: ${segredo.slice(0, 8)}…`);
  }
});

test('SEGUNDA RODADA: não cria NADA (nenhum POST no Chatwoot, nenhuma escrita no banco), com o plano pessimista que pergunta tudo', async () => {
  const { falso, externas } = montar();
  const b = bancoFalso();
  await rodar(DEMO, b, externas);
  const postsAntes = posts(falso).length;
  const estadoAntes = JSON.stringify([...falso.contas.values()]);
  const escritasAntes = b.escritas.length;
  const { resultados } = await rodar(DEMO, b, externas);
  assert.equal(posts(falso).length, postsAntes, 'nenhum POST novo (nem na plataforma)');
  assert.equal(JSON.stringify([...falso.contas.values()]), estadoAntes, 'o Chatwoot ficou exatamente igual');
  assert.deepEqual(b.escritas.slice(escritasAntes), [], 'nenhuma escrita nova no banco');
  assert.equal(falso.usuarios.size, 1 + 0, 'um usuário conector só');
  for (const r of resultados.filter((x) => x.situacao === 'falhou')) assert.fail(`${r.id} falhou na 2ª rodada: ${r.notas.join('|')}`);
  assert.equal(falso.contas.size, 2, 'a referência e UMA conta da clínica');
});

test('--ligar-robo liga o robô Sofia na caixa; sem a flag fica criado e desligado', async () => {
  const { falso, externas } = montar();
  const b = bancoFalso();
  await rodar(DEMO, b, externas, { ligarRobo: true });
  const conta = falso.contas.get(b.e.config!.contaId!)!;
  assert.equal(conta.inboxes[0]!.agent_bot, conta.bots[0]!.id);
});

test('SEM o token do Platform App: a conta NÃO é criada, os passos de dentro da conta ficam BLOQUEADOS, o banco segue (nada órfão)', async () => {
  const { falso, externas } = montar({ semPlataforma: true });
  const b = bancoFalso();
  const { resultados, relatorio } = await rodar(DEMO, b, externas, { estado: { plataforma: false, banco: { unidade: null, configChatwoot: null, caixasRegistradas: [], automacoes: {}, sofia: {} } } });
  assert.equal(sit(resultados, 'conta'), 'bloqueado');
  for (const id of ['etiquetas', 'atributos', 'caixa', 'time', 'atendentes', 'webhook', 'dashboard-app', 'registrar-caixa', 'robo-sofia']) assert.equal(sit(resultados, id), 'bloqueado', id);
  assert.equal(falso.contas.size, 1);
  assert.equal(b.e.config!.contaId ?? null, null);
  assert.match(relatorio, /BLOQUEADO/);
  assert.equal(sit(resultados, 'unidade'), 'feito');
});

test('QUEDA entre criar a conta e criar o usuário: o id da conta já está no banco, e a próxima rodada REAPROVEITA a conta (não cria outra)', async () => {
  const quebrado = montar({ senha: 'curta' }); // o Chatwoot recusa a senha curta: o usuário conector não nasce
  const b = bancoFalso();
  const r1 = await rodar(DEMO, b, quebrado.externas);
  assert.equal(sit(r1.resultados, 'conta'), 'falhou');
  const contaId = b.e.config!.contaId!;
  assert.ok(contaId > 1, 'a conta foi criada e o id ficou gravado ANTES da falha');
  // o Chatwoot é o mesmo; agora com senha boa
  const bom = { ...quebrado.externas, gerarSenha: () => SENHA };
  const r2 = await rodar(DEMO, b, bom);
  assert.equal(sit(r2.resultados, 'conta'), 'feito');
  assert.equal(b.e.config!.contaId, contaId);
  assert.equal(quebrado.falso.contas.size, 2, 'não criou uma segunda conta');
  assert.equal(sit(r2.resultados, 'registrar-caixa'), 'feito');
});

test('sem cofre (KIT_SEGREDOS_DIR) o token gerado se perderia: o passo RECUSA antes de criar o usuário', async () => {
  const { falso, externas } = montar();
  const b = bancoFalso();
  const semCofre = { ...externas, segredos: segredosEmArquivo(null, {}) };
  const { resultados } = await rodar(DEMO, b, semCofre);
  assert.equal(sit(resultados, 'conta'), 'falhou');
  assert.match(resultados.find((r) => r.id === 'conta')!.notas.join(' '), /KIT_SEGREDOS_DIR/);
  assert.equal(falso.usuarios.size, 0, 'nenhum usuário conector criado sem ter onde guardar o token');
});

test('o cofre não sobrescreve um segredo que já existe com outro valor', async () => {
  const { segredos } = montar();
  await segredos.guardar('CHATWOOT_API_TOKEN_X', 'um');
  await segredos.guardar('CHATWOOT_API_TOKEN_X', 'um');
  await assert.rejects(segredos.guardar('CHATWOOT_API_TOKEN_X', 'dois'), /não sobrescrevo/);
  assert.equal(await segredos.ler('CHATWOOT_API_TOKEN_X'), 'um');
  await assert.rejects(segredos.guardar('nome inválido', 'x'), /inválido/);
});

test('CLÍNICA DE VERDADE (modo real): a caixa é WhatsApp Cloud com a chave do Kapso, os 33 modelos vão ao Kapso UMA vez e a 2ª rodada não manda nada', async () => {
  const q = ler('questionario.exemplo.yaml');
  const real = { ...q, unidade: { ...q.unidade, slug: 'clinica-real-teste', nome: 'Clínica Real Teste' }, chatwoot: { ...q.chatwoot, subdominio: 'realteste' }, whatsapp: { ...q.whatsapp, prefixo_modelos: 'real_' }, meta: { ...q.meta, token_env: 'META_ADS_TOKEN_REALTESTE', conta_env: 'META_ADS_CONTA_REALTESTE', dataset_id_env: 'META_DATASET_ID_REALTESTE' } } as typeof DEMO;
  const { falso, segredos, externas } = montar();
  await segredos.guardar('KAPSO_API_KEY', 'kapso-chave-secreta');
  const b = bancoFalso();
  const r1 = await rodar(real, b, externas);
  assert.equal(sit(r1.resultados, 'caixa'), 'feito', JSON.stringify(r1.resultados.find((r) => r.id === 'caixa')));
  const conta = falso.contas.get(b.e.config!.contaId!)!;
  assert.equal(conta.inboxes[0]!.channel_type, 'Channel::Whatsapp');
  assert.deepEqual(conta.inboxes[0]!.channel, { type: 'whatsapp', phone_number: '+5594984420153', provider: 'whatsapp_cloud', provider_config: { api_key: 'kapso-chave-secreta', phone_number_id: '1212928641906230', business_account_id: '2146287749563217' } });
  const noKapso = falso.kapso.get('2146287749563217')!;
  assert.equal(noKapso.size, 33);
  assert.ok([...noKapso.keys()].every((n) => n.startsWith('real_')));
  const enviados = falso.chamadas.filter((c) => c.conta === 'kapso' && c.metodo === 'POST').length;
  assert.equal(enviados, 33);
  assert.ok(![...r1.linhas, r1.relatorio].join('\n').includes('kapso-chave-secreta'));
  await rodar(real, b, externas);
  assert.equal(falso.chamadas.filter((c) => c.conta === 'kapso' && c.metodo === 'POST').length, 33, '2ª rodada: nenhum modelo a mais');
});

test('modo real sem a chave do Kapso: a caixa NÃO é criada (nada de caixa pela metade)', async () => {
  const q = ler('questionario.exemplo.yaml');
  const real = { ...q, unidade: { ...q.unidade, slug: 'clinica-real-teste', nome: 'Clínica Real Teste' }, whatsapp: { ...q.whatsapp, prefixo_modelos: 'real_' }, meta: { ...q.meta, token_env: 'META_ADS_TOKEN_REALTESTE', conta_env: 'META_ADS_CONTA_REALTESTE', dataset_id_env: 'META_DATASET_ID_REALTESTE' } } as typeof DEMO;
  const { falso, externas } = montar();
  const b = bancoFalso();
  const { resultados } = await rodar(real, b, externas);
  assert.equal(sit(resultados, 'caixa'), 'falhou');
  assert.equal(falso.contas.get(b.e.config!.contaId!)!.inboxes.length, 0);
});

test('o vínculo do conector falhou DEPOIS de o usuário nascer: a rodada seguinte refaz o vínculo (pelo id guardado no cofre) em vez de ficar com uma conta inacessível', async () => {
  const { falso, externas } = montar({ falharVinculo: 1 });
  const b = bancoFalso();
  const r1 = await rodar(DEMO, b, externas);
  assert.equal(sit(r1.resultados, 'conta'), 'falhou');
  assert.equal(falso.usuarios.size, 1, 'o usuário nasceu, o token está no cofre');
  const r2 = await rodar(DEMO, b, externas);
  assert.equal(sit(r2.resultados, 'conta'), 'feito', JSON.stringify(r2.resultados.find((r) => r.id === 'conta')));
  assert.match(r2.resultados.find((r) => r.id === 'conta')!.notas.join(' '), /vínculo do conector .* refeito/);
  assert.equal(falso.usuarios.size, 1, 'não criou um segundo usuário');
  assert.equal(sit(r2.resultados, 'registrar-caixa'), 'feito');
});

/** O que o `lerEstado` do script veria na conta da clínica: lido do Chatwoot de mentira + do banco de mentira. */
function estadoLido(falso: ReturnType<typeof montar>['falso'], b: ReturnType<typeof bancoFalso>) {
  const c = falso.contas.get(b.e.config!.contaId!)!;
  const conector = [...falso.usuarios.values()][0]!;
  return {
    banco: {
      unidade: { id: 'u1', campos: b.e.unidade!.campos },
      configChatwoot: { ...b.e.config! },
      caixasRegistradas: [...b.e.caixas],
      automacoes: Object.fromEntries(b.e.automacoes.map((a) => [a, 'seco'])),
      sofia: b.e.sofia,
    },
    chatwoot: {
      etiquetas: c.labels.map((l) => l.title),
      atributosConversa: c.attrs.filter((a) => a.attribute_model === 0).map((a) => a.attribute_key),
      atributosContato: c.attrs.filter((a) => a.attribute_model === 1).map((a) => a.attribute_key),
      caixas: c.inboxes.map((i) => ({ id: i.id, nome: i.name, robo: i.agent_bot !== null })),
      times: c.teams.map((t) => t.name),
      agentes: Object.fromEntries(c.agents.map((a) => [a.email.toLowerCase(), { id: a.id, nome: a.name }])),
      pastas: {},
      mensagensProntas: c.canned.map((x) => x.short_code),
      automacoesDaConta: Math.max(c.rules.length, 8),
      webhookDaConta: c.webhooks.some((w) => w.url.includes(chaveDoEvento(conector.access_token))),
      abas: c.apps.map((a) => a.title),
    },
    segredos: { CHATWOOT_API_TOKEN_DEMO: true, KAPSO_API_KEY: false },
    plataforma: true,
  } as import('./plano.js').EstadoAtual;
}

test('com o estado REAL lido (o plano diz «nada»), os passos do Chatwoot só LÊEM — sem perguntar e sem escrever — e passam os ids adiante', async () => {
  const { falso, externas } = montar();
  const b = bancoFalso();
  await rodar(DEMO, b, externas);
  const estado = estadoLido(falso, b);
  const plano = montarPlano(DEMO, estado, { molde: MOLDE });
  const perguntou: string[] = [];
  const antes = posts(falso).length;
  const escritasAntes = b.escritas.length;
  const resultados = await executarPlano(plano, DEMO, { banco: b.banco, molde: MOLDE, externas, dizer: () => undefined, confirmar: async (p) => (perguntou.push(p.id), true) });
  assert.deepEqual(perguntou.filter((id) => !['unidade', 'config-chatwoot', 'sofia', 'robo-sofia', 'modelos', 'mensagens-prontas'].includes(id)), [], `perguntou por passo que já estava pronto: ${perguntou.join(', ')}`);
  assert.equal(posts(falso).length, antes, 'nenhum POST');
  assert.deepEqual(b.escritas.slice(escritasAntes), []);
  for (const id of ['conta', 'caixa', 'time', 'atendentes', 'usuario-celular', 'webhook', 'dashboard-app']) assert.equal(sit(resultados, id), 'nada-a-fazer', id);
  assert.equal(sit(resultados, 'registrar-caixa'), 'nada-a-fazer');
});

test('plano DEFASADO (diz «nada», mas falta o time): o passo tenta só ler, vê que precisa escrever, PERGUNTA e cria', async () => {
  const { falso, externas } = montar();
  const b = bancoFalso();
  await rodar(DEMO, b, externas);
  const estado = estadoLido(falso, b); // o plano acha que o time existe…
  const conta = falso.contas.get(b.e.config!.contaId!)!;
  conta.teams.length = 0; // …mas alguém apagou
  const plano = montarPlano(DEMO, estado, { molde: MOLDE });
  const perguntou: string[] = [];
  const resultados = await executarPlano(plano, DEMO, { banco: b.banco, molde: MOLDE, externas, dizer: () => undefined, confirmar: async (p) => (perguntou.push(p.id), true) });
  assert.ok(perguntou.includes('time'), 'perguntou antes de criar');
  assert.equal(sit(resultados, 'time'), 'feito');
  assert.equal(conta.teams.length, 1);
});

test('--ligar-robo não TROCA um robô que a caixa já tem (outro); e rodar de novo com o mesmo robô não repete', async () => {
  const { falso, externas } = montar();
  const b = bancoFalso();
  await rodar(DEMO, b, externas, { ligarRobo: true });
  const conta = falso.contas.get(b.e.config!.contaId!)!;
  const robo = conta.bots[0]!.id;
  const posts1 = posts(falso).length;
  const r2 = await rodar(DEMO, b, externas, { ligarRobo: true });
  assert.equal(posts(falso).length, posts1);
  assert.match(r2.resultados.find((r) => r.id === 'robo-sofia')!.notas.join(' '), /já estava ligado/);
  // outro robô na caixa: não troca
  conta.bots.push({ id: 7777, name: 'Outro', outgoing_url: '', access_token: 'x' });
  conta.inboxes[0]!.agent_bot = 7777;
  const r3 = await rodar(DEMO, b, externas, { ligarRobo: true });
  assert.equal(conta.inboxes[0]!.agent_bot, 7777, 'o robô que já estava na caixa continua');
  assert.notEqual(robo, 7777);
  assert.match(r3.resultados.find((r) => r.id === 'robo-sofia')!.notas.join(' '), /JÁ tem outro robô/);
});
