import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { ErroTramitacao } from '../lib/integracoes/tramitacao.js';
import {
  criarContextoTramitacao,
  registrarFerramentasTramitacao,
  tramitacaoAtividades,
  tramitacaoClientes,
  tramitacaoProcesso,
  tramitacaoProcessos,
  tramitacaoPublicacoes,
  type ContaTramitacao,
} from './tramitacao.js';

// Respostas simuladas, no formato do docs.json da API. Nomes, CPFs e senhas inventados.
type Query = Record<string, unknown>;
function conta(rotas: Record<string, (q: Query, caminho: string) => unknown>, chamadas: Array<[string, Query]> = []): ContaTramitacao {
  return {
    slug: 'magalhaes',
    nome: 'Magalhães Advogados',
    fonte: {
      async get<T>(caminho: string, query?: Record<string, never>): Promise<T> {
        chamadas.push([caminho, { ...(query ?? {}) }]);
        const chave = Object.keys(rotas).find((r) => caminho === r || new RegExp(`^${r.replace(/\{id\}/g, '[^/]+')}$`).test(caminho));
        if (!chave) throw new Error(`rota não simulada: ${caminho}`);
        return rotas[chave]!(query ?? {}, caminho) as T;
      },
    },
  };
}
const ctxDe = (c: ContaTramitacao) => criarContextoTramitacao(new Map([[c.slug, c]]));

const SENHA = 'Fic$enha-INSS-1234';
const PAG = (count: number, page = 1, pages = 1, items = 1) => ({ count, page, items, pages, from: 1, to: items, prev: null, next: null });

const PROCESSO = {
  id: 42, uuid: 'u-42', number: '5010331-15.2024.4.03.6201', kind: 'judicial', status: 'ativo', court: 'trf3', title: 'Maria Souza x INSS',
  resultado: null, mais_detalhes: 'Cliente: 123.456.789-09, fone (11) 98765-4321', ajuizamento: '2024-03-10', der: null, comarca: 'Campo Grande', juizo: '1ª Vara',
  valor_da_causa_in_cents: 1234567, receita_prevista_in_cents: 250000, numero_beneficio: '123456789', unidade: null, latest_publication_date: '2026-10-20',
  customers: [{ id: 7, name: 'Maria Souza', role: 'ativo', cpf_cnpj: '123.456.789-09', meu_inss_pass: SENHA }], tags: [{ id: 1, name: 'Urgente' }], parties: [], parties_count: 2,
  created_at: '2024-03-11T10:00:00Z', updated_at: '2026-10-20T10:00:00Z',
};

test('processos: lista resumida em português, valores em reais, filtros viram os parâmetros da API', async () => {
  const chamadas: Array<[string, Query]> = [];
  const ctx = ctxDe(conta({ '/v1/processos': () => ({ lawsuits: [PROCESSO], pagination: PAG(312, 1, 16, 20) }) }, chamadas));
  const r = await tramitacaoProcessos(ctx, { status: ['ativo', 'suspenso'], tipo: 'judicial', tribunal: 'TRF3', ajuizamentoDe: '2024-01-01', ordenar: 'valor_da_causa_desc' });
  assert.deepEqual(chamadas[0], ['/v1/processos', { per_page: 20, page: 1, 'status[]': ['ativo', 'suspenso'], 'kind[]': ['judicial'], 'court[]': ['trf3'], ajuizamento_de: '2024-01-01', order_by: 'valor_da_causa_desc' }]);
  assert.deepEqual(r.paginacao, { pagina: 1, paginas: 16, total: 312, porPagina: 20 });
  const p = r.processos[0]!;
  assert.equal(p.numero, '5010331-15.2024.4.03.6201');
  assert.equal(p.situacao, 'ativo');
  assert.equal(p.tribunal, 'trf3');
  assert.equal(p.valorDaCausa, 12345.67);
  assert.deepEqual(p.clientes, [{ id: 7, nome: 'Maria Souza', polo: 'ativo' }]);
  assert.deepEqual(p.etiquetas, ['Urgente']);
  assert.equal(p.partes, 2);
});

test('processos: nada de CPF, telefone nem senha na resposta, nem com completo', async () => {
  const ctx = ctxDe(conta({ '/v1/processos': () => ({ lawsuits: [PROCESSO], pagination: PAG(1) }) }));
  for (const completo of [false, true]) {
    const r = await tramitacaoProcessos(ctx, { completo });
    const s = JSON.stringify(r);
    for (const proibido of [SENHA, '123.456.789-09', '98765-4321']) assert.equal(s.includes(proibido), false, `${proibido} (completo=${completo})`);
    assert.ok(s.includes('5010331-15.2024.4.03.6201'), 'o número do processo não é mascarado');
  }
  const cheio = await tramitacaoProcessos(ctx, { completo: true });
  assert.equal(((cheio.processos[0] as unknown) as { court: string }).court, 'trf3', 'completo devolve o registro da API (limpo)');
});

test('processos: validação antes de chamar a API (número, tribunal, datas, tamanho da página)', async () => {
  const chamadas: Array<[string, Query]> = [];
  const ctx = ctxDe(conta({ '/v1/processos': () => ({ lawsuits: [], pagination: PAG(0) }) }, chamadas));
  await assert.rejects(tramitacaoProcessos(ctx, { numero: '5010331-abc' }), /número/);
  await assert.rejects(tramitacaoProcessos(ctx, { tribunal: 'trf3; drop' }), /tribunal/);
  await assert.rejects(tramitacaoProcessos(ctx, { ajuizamentoDe: '10/03/2024' }), /AAAA-MM-DD/);
  await assert.rejects(tramitacaoProcessos(ctx, { maxItens: 101 }), /até 100/);
  assert.equal(chamadas.length, 0);
});

test('processo: ficha + partes + movimentações + documentos SÓ com metadados', async () => {
  const chamadas: Array<[string, Query]> = [];
  const ctx = ctxDe(
    conta(
      {
        '/v1/processos/{id}': () => ({ lawsuit: PROCESSO }),
        '/v1/processos/{id}/partes': () => ({
          parties: [{ type: 'customer', id: 'c1', name: 'Maria Souza', role: 'ativo', linked: true, customer: { id: 7, name: 'Maria Souza', cpf_cnpj: '123.456.789-09' } }, { type: 'party', id: 'p2', name: 'INSS', role: 'passivo', linked: false, customer: null }],
          pagination: PAG(2, 1, 1, 2),
          counts: { total: 2, ativo: 1, passivo: 1, outros: 0, linked: 1 },
        }),
        '/v1/processos/{id}/movimentacoes': () => ({
          movements: [{ data_hora: '2026-10-20T10:00:00Z', descricao: 'Juntada de petição do CPF 123.456.789-09', tipo_nome: 'Juntada', grau: '1º grau' }],
          pagination: PAG(1),
        }),
        '/v1/processos/{id}/documentos': () => ({
          documents: [{ id: 'doc_9', tipo_nome: 'Sentença', data_hora_juntada: '2026-10-19T09:00:00Z', paginas: 12, tamanho_bytes: 120000, status: 'disponivel', texto: 'CONTEÚDO SECRETO DO DOCUMENTO', url: 'https://x/arquivo' }],
          pagination: PAG(1),
        }),
      },
      chamadas,
    ),
  );
  const r = await tramitacaoProcesso(ctx, { processo: '5010331-15.2024.4.03.6201' });
  assert.equal(r.processo.id, 42);
  assert.deepEqual((r.partes as { itens: unknown[] }).itens[1], { nome: 'INSS', polo: 'passivo', vinculada: false, clienteId: null });
  assert.deepEqual((r.movimentacoes as { itens: unknown[] }).itens[0], { dataHora: '2026-10-20T10:00:00Z', tipo: 'Juntada', grau: '1º grau', descricao: 'Juntada de petição do CPF ***.***.***-09' });
  const docs = (r.documentos as { itens: Array<Record<string, unknown>> }).itens;
  assert.deepEqual(docs[0], { id: 'doc_9', tipo: 'Sentença', juntadaEm: '2026-10-19T09:00:00Z', paginas: 12, tamanhoBytes: 120000, status: 'disponivel' });
  assert.match(String(r.documentos && (r.documentos as { observacao: string }).observacao), /conteúdo/);
  const s = JSON.stringify(r);
  for (const proibido of ['CONTEÚDO SECRETO', 'https://x/arquivo', '123.456.789-09', '98765-4321']) assert.equal(s.includes(proibido), false, proibido);
  // nunca bate em conteúdo/arquivo de documento
  assert.deepEqual(chamadas.map(([c]) => c).filter((c) => /conteudo|arquivo/.test(c)), []);
  assert.ok(chamadas.some(([c]) => c === '/v1/processos/5010331-15.2024.4.03.6201/documentos'));
});

test('processo: parte que falha (ex. 402 só em documentos) não derruba o resto; o processo em si falhar derruba', async () => {
  const ctx = ctxDe(
    conta({
      '/v1/processos/{id}': () => ({ lawsuit: PROCESSO }),
      '/v1/processos/{id}/partes': () => ({ parties: [], pagination: PAG(0), counts: { total: 0, ativo: 0, passivo: 0, outros: 0, linked: 0 } }),
      '/v1/processos/{id}/movimentacoes': () => ({ movements: [], pagination: PAG(0) }),
      '/v1/processos/{id}/documentos': () => {
        throw new ErroTramitacao('a Tramitação respondeu 402: o plano não inclui', 402);
      },
    }),
  );
  const r = await tramitacaoProcesso(ctx, { processo: '42' });
  assert.match((r.documentos as { indisponivel: string }).indisponivel, /402/);
  const quebrado = ctxDe(conta({ '/v1/processos/{id}': () => { throw new ErroTramitacao('a Tramitação respondeu 402: o plano não inclui', 402); } }));
  await assert.rejects(tramitacaoProcesso(quebrado, { processo: '42' }), /402/);
  await assert.rejects(tramitacaoProcesso(quebrado, { processo: '42/../../clientes' }), /processo/);
  await assert.rejects(tramitacaoProcesso(quebrado, { processo: 'abc' }), /processo/);
});

const PUBLICACAO = {
  id: 1, uuid: 'p1', status: 'nao_lida', disponibilizacao_date: '2026-10-19', publication_date: '2026-10-20', inicio_do_prazo_date: '2026-10-21', created_at: '2026-10-20T00:00:00Z',
  link_tramitacao: 'https://tramitacaointeligente.com.br/publicacoes/1', link: 'https://dje.exemplo/1', texto: `Intime-se MARIA SOUZA, CPF 123.456.789-09. ${'x'.repeat(3000)}`,
  nomeOrgao: '1ª Vara Federal', nomeClasse: 'Procedimento Comum', siglaTribunal: 'TRF3', numero_processo: '50103311520244036201', numero_processo_com_mascara: '5010331-15.2024.4.03.6201',
  destinatarios: [{ nome: 'MARIA SOUZA', polo: 'A' }], destinatario_advogados: [{ nome: 'JOÃO PEREIRA', uf_oab: 'MS', numero_oab: '123' }],
};

test('publicações: filtros, texto cortado e mascarado, destinatários e advogados', async () => {
  const chamadas: Array<[string, Query]> = [];
  const ctx = ctxDe(conta({ '/v1/publicacoes': () => ({ publications: [PUBLICACAO], pagination: PAG(1) }) }, chamadas));
  const r = await tramitacaoPublicacoes(ctx, { busca: 'Souza', processoId: 42, tribunal: 'TRF3', disponibilizadasDe: '2026-10-01', disponibilizadasAte: '2026-10-31', situacao: 'tratada', maxItens: 5 });
  assert.deepEqual(chamadas[0], ['/v1/publicacoes', { per_page: 5, page: 1, query: 'Souza', lawsuit_id: 42, 'court': 'trf3', disponibilizacao_de: '2026-10-01', disponibilizacao_ate: '2026-10-31', status: 'tratada' }]);
  const p = r.publicacoes[0]!;
  assert.equal(p.numeroProcesso, '5010331-15.2024.4.03.6201');
  assert.equal(p.tribunal, 'TRF3');
  assert.equal(p.texto.length <= 1201, true);
  assert.equal(p.textoCortado, true);
  assert.match(p.texto, /CPF \*\*\*\.\*\*\*\.\*\*\*-09/);
  assert.deepEqual(p.destinatarios, [{ nome: 'MARIA SOUZA', polo: 'ativo' }]);
  assert.deepEqual(p.advogados, [{ nome: 'JOÃO PEREIRA', oab: 'MS 123' }]);
  const cheio = await tramitacaoPublicacoes(ctx, { completo: true });
  assert.equal(cheio.publicacoes[0]!.texto.length > 1201, true);
  assert.equal(JSON.stringify(cheio).includes('123.456.789-09'), false);
});

const CLIENTE = {
  id: 7, uuid: 'c7', name: 'Maria Souza', customer_type: 'cliente', cpf_cnpj: '12345678909', email: 'maria@exemplo.com', phone_mobile: '(11) 98765-4321', phone_1: '', phone_2: null,
  state: 'MS', city: 'Campo Grande', neighborhood: 'Centro', street: 'Rua das Flores', street_number: '10', zipcode: '79000-000', birthdate: '1960-05-01', profession: 'Costureira',
  meu_inss_pass: SENHA, rg_numero: '1234567', bank_accounts: [{ bank_name: 'Banco X', account_number: '99887-6', pix_key: '12345678909' }], tags: [{ id: 3, name: 'INSS' }],
  created_at: '2024-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
};

test('clientes: resumo com CPF e telefone mascarados; senha e dados bancários nunca; nunca pede mostrar_meu_inss_pass', async () => {
  const chamadas: Array<[string, Query]> = [];
  const ctx = ctxDe(conta({ '/v1/clientes': () => ({ customers: [CLIENTE], pagination: PAG(1) }) }, chamadas));
  for (const completo of [false, true]) {
    const r = await tramitacaoClientes(ctx, { cpfCnpj: '123.456.789-09', completo });
    const s = JSON.stringify(r);
    for (const proibido of [SENHA, '12345678909', '123.456.789-09', '98765-4321', 'Banco X', '99887-6']) assert.equal(s.includes(proibido), false, `${proibido} (completo=${completo})`);
  }
  assert.ok(chamadas.every(([, q]) => !('mostrar_meu_inss_pass' in q)));
  assert.equal(chamadas[0]![1]['cpf_cnpj'], '12345678909');
  const r = await tramitacaoClientes(ctx, {});
  assert.deepEqual(r.clientes[0], {
    id: 7, nome: 'Maria Souza', tipo: 'cliente', cpfCnpj: '***.***.***-09', email: 'maria@exemplo.com', celular: '(**) *****-4321', telefone: null,
    cidade: 'Campo Grande', uf: 'MS', profissao: 'Costureira', etiquetas: ['INSS'], cadastradoEm: '2024-01-01T00:00:00Z', atualizadoEm: '2026-10-01T00:00:00Z',
  });
});

test('clientes: a API não busca por nome — busca varre algumas páginas e avisa se não deu para ver tudo', async () => {
  const chamadas: Array<[string, Query]> = [];
  const pagina = (n: number) => Array.from({ length: 100 }, (_, i) => ({ ...CLIENTE, id: n * 100 + i, name: n === 1 && i === 5 ? 'José Carlos Prado' : `Fulano ${n}-${i}` }));
  const ctx = criarContextoTramitacao(
    new Map([['magalhaes', conta({ '/v1/clientes': (q) => ({ customers: pagina(Number(q['page'])), pagination: PAG(1000, Number(q['page']), 10, 100) }) }, chamadas)]]),
    { maxPaginas: 3 },
  );
  const r = await tramitacaoClientes(ctx, { busca: 'jose prado' });
  assert.deepEqual(r.clientes.map((c) => c.nome), ['José Carlos Prado']);
  assert.equal(chamadas.length, 3);
  assert.equal(r.truncado, true);
  assert.match(String(r.aviso), /3 de 10 páginas/);
});

test('clientes: busca com mais achados que a página: avisa que há mais e a pagina 2 continua de onde parou', async () => {
  const todos = Array.from({ length: 60 }, (_, i) => ({ ...CLIENTE, id: 1000 + i, name: `Silva ${String(i).padStart(2, '0')}` }));
  const ctx = ctxDe(conta({ '/v1/clientes': (q) => ({ customers: todos.slice((Number(q['page']) - 1) * 100, Number(q['page']) * 100), pagination: PAG(60, Number(q['page']), 1, 100) }) }));
  const p1 = await tramitacaoClientes(ctx, { busca: 'silva', maxItens: 20 });
  assert.equal(p1.clientes.length, 20);
  assert.equal(p1.haMais, true);
  assert.match(String(p1.aviso), /pagina=2/);
  const p3 = await tramitacaoClientes(ctx, { busca: 'silva', maxItens: 20, pagina: 3 });
  assert.deepEqual(p3.clientes.map((c) => c.id), todos.slice(40, 60).map((c) => c.id));
  assert.equal(p3.haMais, undefined);
  assert.equal(p3.truncado, undefined);
});

const ATIVIDADE = {
  id: 5, uuid: 'a5', title: 'Prazo recurso', description: 'Ligar para 11987654321 e confirmar', type: 'Deadline', link: 'https://x', is_public: false, completed: false, completed_on: null, archived_at: null,
  start: '2026-10-30T12:00:00Z', end: null, all_day: true, amount_in_cents: null, deadline_on: '2026-10-30', deadline_start_on: '2026-10-10', deadline_days: 15, deadline_counting: 'dias_uteis',
  creator: { id: 'u1', name: 'Dra. Ana', email: 'ana@exemplo.com' }, customer: { id: 7, name: 'Maria Souza' }, lawsuit: null,
  charge: { status: 'pending', amount_in_cents: 50000, due_date: '2026-11-05', paid: false, invoice_url: 'https://pague/1', payment_url: 'https://pague/2' },
  users: [{ id: 'u2', name: 'Carlos', email: 'c@exemplo.com', role: 'executor' }], tags: [{ id: 1, name: 'Urgente' }], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
};

test('atividades: resumo (prazo fatal, responsável, cliente) sem e-mail, links de cobrança nem telefone inteiro', async () => {
  const chamadas: Array<[string, Query]> = [];
  const ctx = ctxDe(conta({ '/v1/atividades': () => ({ activities: [ATIVIDADE], pagination: PAG(1) }) }, chamadas));
  const r = await tramitacaoAtividades(ctx, { tipo: ['Deadline'], concluida: false, de: '2026-10-01', ate: '2026-10-31', clienteId: 7 });
  assert.deepEqual(chamadas[0], ['/v1/atividades', { per_page: 20, page: 1, 'type[]': ['Deadline'], completed: false, from: '2026-10-01', to: '2026-10-31', customer_id: 7 }]);
  const a = r.atividades[0]!;
  assert.equal(a.prazoFatal, '2026-10-30');
  assert.equal(a.tipo, 'Deadline');
  assert.equal(a.responsavel, 'Dra. Ana');
  assert.deepEqual(a.cliente, { id: 7, nome: 'Maria Souza' });
  assert.deepEqual(a.cobranca, { status: 'pending', valor: 500, vencimento: '2026-11-05', paga: false });
  assert.deepEqual(a.envolvidos, [{ nome: 'Carlos', papel: 'executor' }]);
  const s = JSON.stringify(r);
  for (const proibido of ['ana@exemplo.com', 'c@exemplo.com', 'https://pague', '11987654321']) assert.equal(s.includes(proibido), false, proibido);
});

test('unidade: omitida vale se só uma conta; senão pede; desconhecida lista as que existem', async () => {
  const uma = ctxDe(conta({ '/v1/processos': () => ({ lawsuits: [], pagination: PAG(0) }) }));
  assert.equal((await tramitacaoProcessos(uma, {})).unidade, 'magalhaes');
  await assert.rejects(tramitacaoProcessos(uma, { unidade: 'serra' }), /magalhaes/);
  const duas = criarContextoTramitacao(new Map([['a', { ...conta({}), slug: 'a' }], ['b', { ...conta({}), slug: 'b' }]]));
  await assert.rejects(tramitacaoProcessos(duas, {}), /a, b/);
  await assert.rejects(tramitacaoProcessos(criarContextoTramitacao(new Map()), {}), /nenhum/);
});

test('ferramentas registradas: as cinco, todas só leitura', () => {
  const vistas: Array<{ nome: string; cfg: { annotations?: { readOnlyHint?: boolean }; inputSchema?: Record<string, z.ZodTypeAny> } }> = [];
  const falso = { registerTool: (nome: string, cfg: never) => void vistas.push({ nome, cfg }) } as unknown as McpServer;
  registrarFerramentasTramitacao(falso, ctxDe(conta({})));
  assert.deepEqual(vistas.map((v) => v.nome), ['tramitacao_processos', 'tramitacao_processo', 'tramitacao_publicacoes', 'tramitacao_clientes', 'tramitacao_atividades']);
  for (const v of vistas) assert.equal(v.cfg.annotations?.readOnlyHint, true);
  assert.equal(vistas[0]!.cfg.inputSchema!['maxItens']!.safeParse(101).success, false);
});
