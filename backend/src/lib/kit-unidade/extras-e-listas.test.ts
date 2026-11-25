/**
 * Atributos EXTRAS e listas com as opções da clínica (`chatwoot.atributos_extras` / `chatwoot.listas`, Timbó 25/11), contra o Chatwoot de MENTIRA: a conta já existe (rodada
 * `--so-crm --sem-caixa`) e a 2ª rodada, só com os extras e as listas, cria/atualiza SÓ isso e é idempotente. + o kit copia `origem`/`campanha_*`/`quem_agendou` e as etiquetas de fluxo.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executarPlano } from './executar.js';
import { montarPlano, textoDoPlano } from './plano.js';
import { lerQuestionario } from './questionario.js';
import { camposDaSofia, camposDaUnidade } from './molde-sofia.js';
import { lerYamlOuJson } from './yaml-minimo.js';
import { chatwootFalso } from './chatwoot-falso.js';
import { contaHttp, contaHttpSoLeitura, plataformaHttp } from './chatwoot-http.js';
import { kapsoHttp } from './kapso-http.js';
import { segredosEmArquivo } from './segredos.js';
import { ATRIBUTOS_DE_CONTATO, ATRIBUTOS_DE_CONVERSA, ETIQUETAS_DO_CODIGO } from './catalogo.js';
import { MODELO_DA_ESPERA } from '../chatwoot-regua.js';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const MOLDE = readFileSync(join(OPS, 'molde-sofia/bloco-conversa.md'), 'utf8');
const TEXTO = readFileSync(join(OPS, 'questionario.exemplo.yaml'), 'utf8');
const pastas: string[] = [];
after(() => {
  for (const d of pastas) rmSync(d, { recursive: true, force: true });
});

const ESPERA = ['Exames', 'Vai decidir', 'Viajando', 'Financeiro agora não', 'Outro', 'Não interagiu', 'Não deu continuidade', 'Achou caro', 'Queria convênio', 'Horário não encaixa', 'Mora longe / outra cidade', 'Vai falar com a família'];
const ORIGEM = ['Meta Ads', 'Meta-Instagram', 'Meta-WhatsApp', 'Org-Facebook', 'Org-Instagram', 'Indicação', 'Outdoor', 'Fachada', 'Rádio', 'Carro de som', 'Panfleto', 'Eventos', 'Google'];
const CATEGORIA = ['Avaliação', 'Sessão', 'Retorno', 'Retorno com exames', 'Retorno após tratamento', 'Reavaliação'];
const EXTRAS = [
  { chave: 'fisioterapeuta', nome: 'Fisioterapeuta', tipo: 'lista', opcoes: ['DRA. FULANA', 'DR. BELTRANO'] },
  { chave: 'tratamento_indicado', nome: 'Tratamento indicado', tipo: 'lista-multipla', opcoes: ['01 Mês — CERVICAL', '03 Meses — LOMBAR'], descricao: 'Do Kommo' },
  { chave: 'forma_pagamento', nome: 'Forma de pagamento', tipo: 'lista', opcoes: ['À vista / PIX', 'Cartão de crédito', 'Boleto'] },
  { chave: 'data_solicitacao_cancelamento', nome: 'Data da solicitação de cancelamento', tipo: 'data' },
];
const REFERENCIA_ATRS = [
  { id: 901, attribute_key: 'motivo_espera', attribute_display_name: 'Motivo da espera', attribute_display_type: 'list', attribute_values: ['Exames', 'Vai decidir', 'Viajando', 'Financeiro agora não', 'Outro'], attribute_model: 'conversation_attribute', attribute_description: '' },
  { id: 902, attribute_key: 'categoria_consulta', attribute_display_name: 'Categoria da consulta', attribute_display_type: 'list', attribute_values: ['Avaliação', 'Sessão', 'Retorno', 'Retorno com exames', 'Retorno após tratamento'], attribute_model: 'conversation_attribute', attribute_description: '' },
  { id: 903, attribute_key: 'origem', attribute_display_name: 'Origem', attribute_display_type: 'list', attribute_values: ['Meta Ads', 'Google', 'Indicação', 'Parceria', 'Orgânico', 'Remarketing'], attribute_model: 'contact_attribute', attribute_description: '' },
];
/** O questionário real de uma unidade que já existe, sem número (`--sem-caixa`), com ou sem os blocos novos. */
function questionario(comBlocos: boolean) {
  const o = lerYamlOuJson(TEXTO) as any;
  o.assistente = { quer: false };
  for (const c of ['numero_oficial', 'kapso_phone_number_id', 'waba_id']) delete o.whatsapp[c];
  if (comBlocos) {
    o.chatwoot.atributos_extras = EXTRAS;
    o.chatwoot.listas = [
      { chave: 'motivo_espera', opcoes: ESPERA },
      { chave: 'categoria_consulta', opcoes: CATEGORIA },
      { chave: 'origem', opcoes: ORIGEM },
    ];
  }
  const r = lerQuestionario(JSON.stringify(o), { semCaixa: true });
  assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
  return r.q;
}
const comBloco = (f: (o: any) => void) => {
  const o = lerYamlOuJson(TEXTO) as any;
  o.assistente = { quer: false };
  o.chatwoot.atributos_extras = JSON.parse(JSON.stringify(EXTRAS));
  o.chatwoot.listas = [{ chave: 'motivo_espera', opcoes: [...ESPERA] }];
  f(o);
  return lerQuestionario(JSON.stringify(o));
};

const URL_CW = 'https://crm.exemplo.test';

function mundo(q: any) {
  const campos: Record<string, unknown> = { ...camposDaUnidade(q), ...camposDaSofia(q, MOLDE).campos, isActive: true, clinicAddress: 'Endereço de produção', sinalPixCentavos: null };
  const escritas: Array<[string, unknown]> = [];
  const e = { config: null as any, automacoes: ['prompt-da-unidade', 'kommo-lembrete'] as string[], caixas: [] as number[] };
  const banco: any = {
    async lerUnidade() { return { id: 'u1', ativa: true, campos: { ...campos } }; },
    async gravarUnidade(...a: unknown[]) { escritas.push(['gravarUnidade', a]); return { id: 'u1', criada: false }; },
    async lerConfigChatwoot() { return e.config ? { ...e.config } : null; },
    async gravarConfigChatwoot(_u: string, cfg: any, criar: boolean) { escritas.push(['gravarConfigChatwoot', Object.keys(cfg)]); e.config = criar ? cfg : { ...e.config, ...cfg }; },
    async automacoesDaUnidade() { return [...e.automacoes]; },
    async criarAutomacoesEmSeco(_u: string, ids: string[]) { escritas.push(['criarAutomacoesEmSeco', ids]); e.automacoes.push(...ids); },
    async sofiaDaUnidade() { return { ...campos }; },
    async gravarSofia(_u: string, c: unknown) { escritas.push(['gravarSofia', c]); },
    licoes: { async listar() { return []; }, async criar() { escritas.push(['licoes.criar', 1]); }, async contarDaUnidade() { return 0; }, async marcarImportado() { escritas.push(['marcarImportado', 1]); } },
    async caixasRegistradas() { return [...e.caixas]; },
    async registrarCaixa(_u: string, c: any) { escritas.push(['registrarCaixa', c.id]); if (!e.caixas.includes(c.id)) e.caixas.push(c.id); },
  };
  const falso = chatwootFalso({ existentes: [{ id: 5, name: 'Suzanne', email: 'suzanne.mychelly1@gmail.com' }], referencia: { attrs: REFERENCIA_ATRS } });
  const dir = mkdtempSync(join(tmpdir(), 'so-crm-cofre-'));
  pastas.push(dir);
  const externas = {
    plataforma: plataformaHttp(URL_CW, falso.tokenDaPlataforma, falso.fetch),
    abrirConta: (conta: number, token: string) => contaHttp(URL_CW, conta, token, falso.fetch),
    referencia: contaHttpSoLeitura(URL_CW, 1, falso.tokenDeReferencia, falso.fetch),
    contaDoAmbiente: 1,
    adminsDD: ['suzanne.mychelly1@gmail.com'],
    kapso: kapsoHttp('kapso-chave', falso.fetch),
    segredos: segredosEmArquivo(dir, { KAPSO_API_KEY: 'kapso-chave' }),
    urlDoAgente: 'https://agente.exemplo.test',
    urlDoChatwoot: URL_CW,
    gerarSenha: () => 'Aa1!senha-gerada-so-para-o-teste-7731',
  };
  const estado = (): any => {
    const contaId = e.config?.contaId ?? null;
    const c = contaId ? falso.contas.get(contaId) : null;
    return {
      banco: { unidade: { id: 'u1', campos: { ...campos } }, configChatwoot: e.config, caixasRegistradas: [...e.caixas], automacoes: Object.fromEntries(e.automacoes.map((a) => [a, a.startsWith('chatwoot-') ? 'seco' : 'ligado'])), sofia: { ...campos }, licoes: [] },
      chatwoot: c ? { etiquetas: c.labels.map((l: any) => l.title), atributosConversa: c.attrs.filter((a: any) => a.attribute_model === 'conversation_attribute').map((a: any) => a.attribute_key), atributosContato: c.attrs.filter((a: any) => a.attribute_model === 'contact_attribute').map((a: any) => a.attribute_key), tiposDosAtributos: { conversa: Object.fromEntries(c.attrs.filter((a: any) => a.attribute_model === 'conversation_attribute').map((a: any) => [a.attribute_key, a.attribute_display_type])), contato: Object.fromEntries(c.attrs.filter((a: any) => a.attribute_model === 'contact_attribute').map((a: any) => [a.attribute_key, a.attribute_display_type])) }, opcoesDasListas: { conversa: Object.fromEntries(c.attrs.filter((a: any) => a.attribute_model === 'conversation_attribute' && a.attribute_display_type === 'list').map((a: any) => [a.attribute_key, a.attribute_values])), contato: Object.fromEntries(c.attrs.filter((a: any) => a.attribute_model === 'contact_attribute' && a.attribute_display_type === 'list').map((a: any) => [a.attribute_key, a.attribute_values])) }, caixas: c.inboxes.map((i: any) => ({ id: i.id, nome: i.name, robo: !!i.agent_bot })), times: c.teams.map((t: any) => t.name), agentes: Object.fromEntries(c.agents.map((a: any) => [a.email.toLowerCase(), { id: a.id, nome: a.name }])), pastas: {}, mensagensProntas: c.canned.map((p: any) => p.short_code), automacoesDaConta: c.rules.length, webhookDaConta: c.webhooks.length > 0, abas: c.apps.map((a: any) => a.title) }
        : { etiquetas: [], atributosConversa: [], atributosContato: [], caixas: [], times: [], agentes: {}, pastas: {}, mensagensProntas: [], automacoesDaConta: 0 },
      plataforma: true,
      segredos: Object.fromEntries(readdirSync(dir).map((f) => [f, true])),
    } as any;
  };
  return { banco, escritas, falso, dir, externas, estado, e };
}

const naoGet = (m: ReturnType<typeof mundo>, desde = 0) => m.falso.chamadas.slice(desde).filter((c) => c.metodo !== 'GET');
const resp = async (plano: ReturnType<typeof montarPlano>, q: ReturnType<typeof questionario>, m: ReturnType<typeof mundo>) => {
  const perguntados: string[] = [];
  const res = await executarPlano(plano, q, { banco: m.banco, molde: MOLDE, soCrm: true, semCaixa: true, externas: m.externas, dizer: () => undefined, confirmar: async (p) => (perguntados.push(p.id), true) });
  return { res, perguntados };
};
const conta = (m: ReturnType<typeof mundo>) => [...m.falso.contas.values()].pop() as any;

test('validação dos blocos novos: chave que o kit já copia, repetida, lista sem opções, opções em tipo sem lista, lista fora das editáveis e lista sem os valores que o código usa são recusados', () => {
  assert.ok(comBloco(() => {}).ok);
  const erros = (f: (o: any) => void) => { const r = comBloco(f); return r.ok ? [] : r.erros.join(' | '); };
  assert.match(String(erros((o) => (o.chatwoot.atributos_extras[0].chave = 'etapa'))), /já é um atributo que o kit copia/);
  assert.match(String(erros((o) => (o.chatwoot.atributos_extras[1].chave = 'fisioterapeuta'))), /chave repetida/);
  assert.match(String(erros((o) => delete o.chatwoot.atributos_extras[0].opcoes)), /precisa das opções/);
  assert.match(String(erros((o) => (o.chatwoot.atributos_extras[3].opcoes = ['a', 'b']))), /não tem opções/);
  assert.match(String(erros((o) => (o.chatwoot.atributos_extras[0].chave = 'Chave Ruim'))), /minúsculas/);
  assert.match(String(erros((o) => (o.chatwoot.listas = [{ chave: 'etapa', opcoes: ['A', 'B'] }]))), /Invalid enum value/);
  assert.match(String(erros((o) => (o.chatwoot.listas[0].opcoes = ESPERA.filter((x) => x !== 'Exames')))), /precisa conservar «Exames»/);
  assert.match(String(erros((o) => (o.chatwoot.listas = [{ chave: 'origem', opcoes: ['Google', 'Indicação'] }]))), /precisa conservar «Meta Ads»/);
  assert.match(String(erros((o) => (o.chatwoot.listas = [{ chave: 'categoria_consulta', opcoes: ['Avaliação', 'Sessão'] }]))), /precisa conservar «Retorno»/);
  assert.match(String(erros((o) => (o.chatwoot.listas[0].opcoes = ['Exames', 'exames', 'Viajando', 'Vai decidir', 'Financeiro agora não']))), /opção repetida/);
  // os valores que o código usa de verdade batem com as constantes do código
  assert.deepEqual(Object.keys(MODELO_DA_ESPERA).sort(), ['Exames', 'Financeiro agora não', 'Vai decidir', 'Viajando']);
});

test('o kit passa a copiar origem/campanha_*/conjunto (contato), quem_agendou (conversa) e as etiquetas de fluxo que o código lê', () => {
  for (const c of ['origem', 'campanha_codigo', 'campanha_nome', 'conjunto']) assert.ok(ATRIBUTOS_DE_CONTATO.includes(c), c);
  assert.ok(ATRIBUTOS_DE_CONVERSA.includes('quem_agendou'));
  for (const e of ['boas-vindas', 'confirmar-retorno', 'reativacao', 'retomada', 'frio', 'morno']) assert.ok(ETIQUETAS_DO_CODIGO.includes(e), e);
  assert.equal(new Set(ETIQUETAS_DO_CODIGO).size, ETIQUETAS_DO_CODIGO.length, 'sem etiqueta repetida');
});

test('o seco mostra o que muda: extras a criar, lista antes→depois (entram/saem) e os motivos de espera SEM modelo da régua', async () => {
  const q = questionario(true);
  const m = mundo(q);
  await resp(montarPlano(questionario(false), m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), questionario(false), m); // a conta já existe, sem os blocos
  const plano = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true });
  const ex = plano.passos.find((p) => p.id === 'atributos-extras')!;
  assert.equal(ex.acao, 'criar');
  assert.match(ex.itens.join('\n'), /tratamento_indicado — «Tratamento indicado» \(lista-multipla, 2 opções\) \[vira texto/);
  const ls = plano.passos.find((p) => p.id === 'listas')!;
  assert.equal(ls.acao, 'alterar');
  assert.match(ls.itens.join('\n'), /motivo_espera: 5 → 12 opções \(entram: Não interagiu/);
  assert.match(ls.avisos.join('\n'), /motivo_espera: 8 motivo\(s\) SEM modelo da régua.*Outro, Não interagiu, Não deu continuidade, Achou caro/);
  assert.match(textoDoPlano(plano), /Listas com as opções desta clínica \(3\)/);
});

test('2ª rodada só com os extras e as listas: cria os extras (lista-multipla vira texto com as opções na descrição), troca as opções, não duplica nada e a 3ª rodada não escreve', async () => {
  const q0 = questionario(false);
  const m = mundo(q0);
  await resp(montarPlano(q0, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), q0, m); // 1ª: a conta (como a conta 3 de Timbó)
  const c = conta(m);
  const antes = { agentes: c.agents.length, times: c.teams.length, etiquetas: c.labels.length, regras: c.rules.length, prontas: c.canned.length, abas: c.apps.length, inboxes: c.inboxes.length };
  assert.ok(c.labels.some((l: any) => l.title === 'boas-vindas') && c.attrs.some((a: any) => a.attribute_key === 'quem_agendou'), 'a 1ª rodada já copia as etiquetas de fluxo e quem_agendou');
  const q = questionario(true);
  const n = m.falso.chamadas.length;
  const { res } = await resp(montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), q, m);
  assert.deepEqual(res.filter((r) => r.situacao === 'falhou'), [], JSON.stringify(res));
  const novas = naoGet(m, n);
  const escritas = novas.map((x) => `${x.metodo} ${String(x.caminho).replace(/\/api\/v1\/accounts\/\d+\//, '')}`);
  // só atributos: 4 extras (POST) + as 3 listas (PATCH ou POST se faltava)
  assert.ok(escritas.every((e) => /custom_attribute_definitions/.test(e)), escritas.join('\n'));
  assert.equal(escritas.filter((e) => e.startsWith('POST')).length, 4 + 0, 'só os 4 extras são criados (as 3 listas já existiam)');
  const attr = (k: string) => c.attrs.find((a: any) => a.attribute_key === k);
  assert.equal(attr('fisioterapeuta').attribute_display_type, 'list');
  assert.deepEqual(attr('fisioterapeuta').attribute_values, ['DRA. FULANA', 'DR. BELTRANO']);
  assert.equal(attr('tratamento_indicado').attribute_display_type, 'text', 'lista múltipla não existe no Chatwoot: texto');
  assert.deepEqual(attr('tratamento_indicado').attribute_values, []);
  assert.match(attr('tratamento_indicado').attribute_description, /Do Kommo — Pode ter mais de um.*Opções: 01 Mês — CERVICAL; 03 Meses — LOMBAR/);
  assert.equal(attr('data_solicitacao_cancelamento').attribute_display_type, 'date');
  assert.deepEqual(attr('motivo_espera').attribute_values, ESPERA);
  assert.deepEqual(attr('categoria_consulta').attribute_values, CATEGORIA);
  assert.deepEqual(c.attrs.find((a: any) => a.attribute_key === 'origem' && a.attribute_model === 'contact_attribute').attribute_values, ORIGEM);
  assert.deepEqual({ agentes: c.agents.length, times: c.teams.length, etiquetas: c.labels.length, regras: c.rules.length, prontas: c.canned.length, abas: c.apps.length, inboxes: c.inboxes.length }, antes, 'o resto da conta ficou como estava');
  assert.ok(!m.escritas.some((e) => ['gravarUnidade', 'gravarSofia', 'registrarCaixa'].includes(e[0])));
  // 3ª rodada: nada novo
  const n3 = m.falso.chamadas.length;
  await resp(montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), q, m);
  assert.deepEqual(naoGet(m, n3), []);
  const plano3 = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true });
  assert.equal(plano3.passos.find((p) => p.id === 'atributos-extras')!.acao, 'nada');
  assert.equal(plano3.passos.find((p) => p.id === 'listas')!.acao, 'nada');
});

test('lista que a conta ainda não tem é CRIADA com as opções; atributo extra que já existe com outro conteúdo NÃO é trocado', async () => {
  const q0 = questionario(false);
  const m = mundo(q0);
  await resp(montarPlano(q0, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), q0, m);
  const c = conta(m);
  c.attrs = c.attrs.filter((a: any) => a.attribute_key !== 'categoria_consulta');
  c.attrs.push({ id: 7777, attribute_key: 'fisioterapeuta', attribute_display_name: 'Já existia', attribute_display_type: 'text', attribute_values: [], attribute_model: 'conversation_attribute', attribute_description: '' });
  const q = questionario(true);
  await resp(montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), q, m);
  assert.deepEqual(c.attrs.find((a: any) => a.attribute_key === 'categoria_consulta').attribute_values, CATEGORIA);
  const f = c.attrs.find((a: any) => a.attribute_key === 'fisioterapeuta');
  assert.equal(f.attribute_display_name, 'Já existia', 'o que já existe não é trocado');
  assert.equal(f.attribute_display_type, 'text');
});

test('motivo_nao_fechamento precisa conservar «Solicitado exames» (a régua cobra o documento por esse nome)', () => {
  const r = comBloco((o) => (o.chatwoot.listas = [{ chave: 'motivo_nao_fechamento', opcoes: ['Achou caro', 'Vai pensar'] }]));
  assert.ok(!r.ok && r.erros.join(' ').includes('precisa conservar «Solicitado exames»'));
  assert.ok(comBloco((o) => (o.chatwoot.listas = [{ chave: 'motivo_nao_fechamento', opcoes: ['Achou caro', 'Solicitado exames'] }])).ok);
});

test('motivo_nao_agendamento sem opção parecida com os 4 motivos dos botões «Perdido: …» é RECUSADO como as outras listas (com a lista do Kommo, «Plano de Saúde» e «Não deu continuidade ao atendimento» servem)', () => {
  const com = (opcoes: string[]) => comBloco((o) => (o.chatwoot.listas = [{ chave: 'motivo_nao_agendamento', opcoes }]));
  const ruim = com(['Preço', 'Distância', 'Outro']);
  assert.ok(!ruim.ok);
  assert.match((ruim as { erros: string[] }).erros.join(' '), /precisa ter uma opção parecida com «Sem interesse», «Outra cidade», «Plano de saúde», «Não deu continuidade»/);
  assert.ok(com(['Sem interesse', 'Outra cidade', 'Plano de Saúde', 'Não deu continuidade ao atendimento', 'Não interagiu']).ok);
  assert.ok(com(['Sem interesse', 'Outra cidade', 'Plano de saúde', 'Não deu continuidade']).ok);
});

test('o Chatwoot REAL devolve tipo e modelo como NOME («list», «conversation_attribute»): o kit entende nome E número (tipoDoAtributo/ehLista) e o falso fala como o real', async () => {
  const { tipoDoAtributo, ehLista, passoListas } = await import('./fase2.js');
  assert.equal(tipoDoAtributo('list'), 'list');
  assert.equal(tipoDoAtributo(6), 'list');
  assert.equal(tipoDoAtributo('6'), 'list');
  assert.equal(tipoDoAtributo('Text'), 'text');
  assert.equal(tipoDoAtributo(undefined), '');
  assert.ok(ehLista({ attribute_display_type: 'list' }) && ehLista({ attribute_display_type: 6 }) && !ehLista({ attribute_display_type: 'text' }) && !ehLista({ attribute_display_type: 0 }) && !ehLista(undefined));
  // o repro do sênior: a resposta no formato real não pode ser tomada como «não é lista»
  const chamadas: string[] = [];
  const defReal = { id: 77, attribute_key: 'motivo_espera', attribute_display_type: 'list', attribute_model: 'conversation_attribute', attribute_values: ['Exames', 'Viajando', 'Vai decidir', 'Financeiro agora não'] };
  const contaReal: any = { conta: 3, get: async () => [defReal], post: async (c: string) => (chamadas.push('POST ' + c), {}), patch: async (c: string) => (chamadas.push('PATCH ' + c), {}) };
  const q: any = { chatwoot: { listas: [{ chave: 'motivo_espera', opcoes: [...ESPERA] }] } };
  const notas = await passoListas(q, { referencia: null } as any, { conta: contaReal } as any);
  assert.deepEqual(chamadas, ['PATCH custom_attribute_definitions/77']);
  assert.match(notas[0]!, /motivo_espera: 12 opções \(entram 8, saem 0\)/);
  // o falso devolve nome, aceita nome ou número na entrada e recusa valor inválido (422) como o real
  const falso = chatwootFalso({ referencia: { attrs: [{ id: 1, attribute_key: 'a', attribute_display_name: 'A', attribute_display_type: 6, attribute_values: [], attribute_model: 1, attribute_description: '' }] } });
  const lerRef = async () => (await (await falso.fetch('https://crm.exemplo.test/api/v1/accounts/1/custom_attribute_definitions?attribute_model=1', { headers: { api_access_token: falso.tokenDeReferencia } })).json()) as any[];
  const ref = await lerRef();
  assert.equal(ref[0].attribute_display_type, 'list');
  assert.equal(ref[0].attribute_model, 'contact_attribute');
});

test('lista que a conta tem mas como TEXTO livre: o kit FALHA claro (não diz que aplicou); o plano cria quando nenhuma lista existe e altera quando existe', async () => {
  const q0 = questionario(false);
  const m = mundo(q0);
  await resp(montarPlano(q0, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }), q0, m);
  const c = conta(m);
  const lista = c.attrs.find((a: any) => a.attribute_key === 'motivo_espera');
  const q = questionario(true);
  const planoVelho = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true }); // feito quando ainda era lista
  lista.attribute_display_type = 'text'; // …e virou texto livre na conta depois
  const { res } = await resp(planoVelho, q, m); // o EXECUTOR confere de novo
  const falhou = res.find((r) => r.id === 'listas')!;
  assert.equal(falhou.situacao, 'falhou');
  assert.match(falhou.notas.join(' '), /motivo_espera: já existe como atributo do tipo «text», não como lista.*não troca o tipo.*Mude o tipo na conta/);
  assert.doesNotMatch(falhou.notas.join(' '), /apague/i);
  // o SECO já avisa que vai falhar (nunca «criar»), com o motivo, e sem mandar apagar
  const planoAntes = montarPlano(q, m.estado(), { molde: MOLDE, soCrm: true, semCaixa: true });
  const passoL = planoAntes.passos.find((p) => p.id === 'listas')!;
  assert.equal(passoL.acao, 'bloqueado');
  assert.match(passoL.itens.join(' '), /motivo_espera: NÃO DÁ — existe como «text»/);
  assert.match(passoL.avisos.join(' '), /BLOQUEADO e NENHUMA lista dele é aplicada/);
  assert.doesNotMatch(passoL.avisos.join(' '), /apague/i);
  // plano: nenhuma lista existe = criar; alguma existe = alterar
  const vazio = mundo(q);
  assert.equal(montarPlano(q, { ...vazio.estado(), chatwoot: { ...(vazio.estado().chatwoot ?? {}), etiquetas: [], atributosConversa: [], atributosContato: [], caixas: [], times: [], agentes: {}, pastas: {}, mensagensProntas: [], automacoesDaConta: 0, opcoesDasListas: { conversa: {}, contato: {} } } }, { molde: MOLDE, soCrm: true, semCaixa: true }).passos.find((p) => p.id === 'listas')!.acao, 'criar');
});
