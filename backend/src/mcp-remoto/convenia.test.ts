import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afastamentoNormalizado,
  colaboradorNormalizado,
  conveniaAfastamentos,
  conveniaColaborador,
  conveniaColaboradores,
  conveniaFerias,
  conveniaMovimentacao,
  criarContextoConvenia,
  resolverContasConvenia,
  resumirColaborador,
  type ColaboradorBruto,
  type ContaConvenia,
} from './convenia.js';
import { listarIntegracoes } from './integracoes.js';

/**
 * Dado pessoal que só existe na FICHA da pessoa. Por decisão da dona da empresa (24/10/2026) ele SAI pelo
 * conector — na ficha de uma pessoa e nas listagens com `completo: true`. O que estes valores provam aqui é
 * o outro lado: a listagem PADRÃO continua resumida, para não despejar a ficha inteira de todo mundo.
 */
const DADO_DE_FICHA = [
  '123.456.789-09', '12345678909', 'PIS-SECRETO', 'RG-SECRETO', 'CTPS-SECRETA', 'TITULO-SECRETO', 'CNH-SECRETA',
  'pix-secreto', 'AGENCIA-SECRETA', 'CONTA-SECRETA', 'Rua Secreta', '01310-100', '(11) 99999-0000', '(11) 3333-4444',
  'pessoa.privada@gmail.com', 'alternativo@gmail.com', '1990-01-02', '4321.5', 'Mae Sigilosa', 'Pai Sigiloso',
  'anotacao sigilosa', 'Fisica-sigilosa', 'Etnia-sigilosa', 'ASO-sigiloso', 'Contato Emergencia',
];

function pessoa(id: string, nome: string, sobrenome: string, extra: Partial<ColaboradorBruto> = {}): ColaboradorBruto {
  return {
    id, name: nome, last_name: sobrenome, social_name: '', status: 'Ativo', hiring_date: '2026-03-10', registration: null,
    department: { id: 'd1', name: 'Tecnologia' }, job: { id: 'j1', name: 'Analista de sistemas' }, team: { id: 't1', name: 'Time A' },
    cost_center: { id: 'c1', name: 'Administrativo' }, supervisor: { id: 's1', name: 'Gestora', last_name: 'Chefe' },
    intern: { initial_at: null, finish_at: null }, experience_period: { first_end: '2026-04-24', second_end: '2026-06-08', experience_period_type: '45 + 45 dias' },
    payroll: { registration: '77' },
    // tudo isto chega da API e agora SAI (decisão da dona, 24/10/2026)
    email: 'pessoa.privada@gmail.com', alternative_email: 'alternativo@gmail.com', salary: 4321.5, birth_date: '1990-01-02',
    phone: '(11) 3333-4444', cellphone: '(11) 99999-0000', mother_name: 'Mae Sigilosa', father_name: 'Pai Sigiloso',
    document: { cpf: '123.456.789-09', pis: 'PIS-SECRETO', rg: 'RG-SECRETO', ctps: 'CTPS-SECRETA', voter_card: 'TITULO-SECRETO' },
    cpf: { id: 'x', cpf: '12345678909' }, rg: { number: 'RG-SECRETO' }, ctps: { number: 'CTPS-SECRETA', pis: 'PIS-SECRETO' },
    driver_license: { number: 'CNH-SECRETA' }, electoral_card: { number: 'TITULO-SECRETO' },
    address: { address: 'Rua Secreta', zip_code: '01310-100', number: '1' },
    bank_accounts: [{ bank: 'Banco', account: 'CONTA-SECRETA', agency: 'AGENCIA-SECRETA', pix: 'pix-secreto' }],
    contact_information: { personal_phone: '(11) 99999-0000', personal_email: 'pessoa.privada@gmail.com', residential_phone: '(11) 3333-4444' },
    emergency_contacts: [{ name: 'Contato Emergencia', phone: '(11) 99999-0000' }],
    annotations: [{ title: 'obs', notes: 'anotacao sigilosa' }], aso: [{ observation: 'ASO-sigiloso' }],
    disability: { disability_type: 'Fisica-sigilosa' }, ethnicity: { name: 'Etnia-sigilosa' },
    ...extra,
  };
}

const ANA = pessoa('aaaaaaaa-0000-4000-8000-000000000001', 'Ana', 'Souza', { hiring_date: '2026-10-05' });
const BRUNO = pessoa('aaaaaaaa-0000-4000-8000-000000000002', 'Bruno', 'Lima', {
  department: { name: 'Comercial' }, job: { name: 'Gerente Comercial' }, hiring_date: '2024-01-15', intern: { initial_at: '2026-02-01', finish_at: '2027-01-31' },
});
const CARLA_DESLIGADA = pessoa('aaaaaaaa-0000-4000-8000-000000000003', 'Carla', 'Dias', {
  department: { name: 'Operações' }, job: { name: 'Estagiário' }, hiring_date: '2025-08-01', status: 'Desligado', relationship: { name: 'Estágio' },
});
const DESLIGADOS = [
  {
    id: CARLA_DESLIGADA.id, corporate_email: 'corporativo@empresa.com',
    dismissal: {
      date: '2026-10-10', type: { id: 3, title: 'Término de Contrato de Estágio' }, dismissal_step: { name: 'Concluída' },
      termination_notice: { termination_notice_type: { name: 'Trabalhado' } }, motive: 'motivo-livre-sigiloso', comments: 'comentario-sigiloso',
    },
  },
];

type Rotas = Record<string, (q: Record<string, unknown>) => unknown>;

function conta(slug: string, rotas: Rotas, chamadas: Array<[string, Record<string, unknown>]> = []): ContaConvenia {
  return {
    slug, nome: slug,
    fonte: {
      async get<T>(caminho: string, query?: Record<string, string | number | undefined>): Promise<T> {
        chamadas.push([caminho, { ...(query ?? {}) }]);
        const r = rotas[caminho];
        if (!r) throw new Error(`rota não simulada: ${caminho}`);
        return r(query ?? {}) as T;
      },
    },
  };
}

const pagina = (data: unknown[]) => ({ current_page: 1, last_page: 1, total: data.length, data });

function rotasPadrao(): Rotas {
  return {
    '/employees': () => pagina([ANA, BRUNO]),
    '/employees/dismissed': () => pagina(DESLIGADOS),
    [`/employees/${ANA.id}`]: () => ({ data: { ...ANA, relationship: { name: 'CLT' } } }),
    [`/employees/${BRUNO.id}`]: () => ({ data: BRUNO }),
    [`/employees/${CARLA_DESLIGADA.id}`]: () => ({ data: CARLA_DESLIGADA }),
    [`/employees/${ANA.id}/vacations/solicitations`]: () => pagina([
      { starts_at: '2026-10-20', finishes_at: '2026-11-08', requested_days: 20, allowance: 10, status: 'approved', canceled: null, justification: 'justificativa-das-ferias' },
      { starts_at: '2026-12-01', finishes_at: '2026-12-10', requested_days: 10, status: 'approved', canceled: { created_at: 'x' } },
    ]),
    [`/employees/${ANA.id}/vacations/periods`]: () => pagina([
      { balance: 30, initial_balance: 30, purchasing_started_at: '2024-03-10', purchasing_finished_at: '2025-03-09', concessive_finished_at: '2026-03-09' },
      { balance: 10, initial_balance: 30, purchasing_started_at: '2025-03-10', purchasing_finished_at: '2026-03-09', concessive_finished_at: '2026-12-31' },
    ]),
    [`/employees/${BRUNO.id}/vacations/solicitations`]: () => pagina([]),
    [`/employees/${BRUNO.id}/vacations/periods`]: () => pagina([]),
    [`/employees/${ANA.id}/absences`]: () => ({
      data: { employee_id: ANA.id, absences: [{ motive: { name: 'Afastamento por doença' }, type: { name: 'Justificada' }, date_from: '2026-09-28', date_to: '2026-10-03', total: 6, cid: 'M54.5', justification: 'dor nas costas sigilosa' }] },
    }),
    [`/employees/${BRUNO.id}/absences`]: () => ({
      data: { employee_id: BRUNO.id, absences: [{ motive: { name: 'Falta' }, type: { name: 'Não justificada' }, date_from: '2026-10-15', date_to: '2026-10-15', total: '1', cid: null, justification: 'nao-avisou-sigiloso' }] },
    }),
    '/companies/collective-vacations': () => pagina([{ title: 'Recesso', starts_at: '2026-12-22', finishes_at: '2027-01-02', requested_days: 12, departments: [{ id: 'd1', name: 'Tecnologia' }], emails: ['rh-coletivas@empresa.com'], justification: 'justificativa-da-coletiva' }]),
  };
}

const AGORA = Date.parse('2026-10-20T15:00:00Z');
const ctxPadrao = (rotas = rotasPadrao(), chamadas?: Array<[string, Record<string, unknown>]>, op: { maxColaboradores?: number } = {}) =>
  criarContextoConvenia(new Map([['doutor-digital', conta('doutor-digital', rotas, chamadas)]]), { agora: () => AGORA, ...op });

/** A resposta está resumida: nenhum campo da ficha da pessoa veio junto. */
function resumida(resposta: unknown, porque = 'a listagem padrão trouxe a ficha inteira'): void {
  const json = JSON.stringify(resposta);
  for (const s of DADO_DE_FICHA) assert.ok(!json.includes(s), `${porque}: "${s}"`);
}

/** A resposta está completa: cada valor pedido chegou. */
function trouxe(resposta: unknown, valores: string[]): void {
  const json = JSON.stringify(resposta);
  for (const s of valores) assert.ok(json.includes(s), `faltou "${s}" na resposta completa`);
}

test('colaboradorNormalizado: o registro cru inteiro junto com os campos em português', () => {
  const c = colaboradorNormalizado(BRUNO);
  // os nomes em português continuam de pé (é por eles que filtro, agrupamento e busca funcionam)
  assert.equal(c.nome, 'Bruno Lima');
  assert.equal(c.gestor, 'Gestora Chefe');
  assert.equal(c.matricula, '77');
  assert.equal(c.departamento, 'Comercial');
  assert.deepEqual(c.estagio, { inicio: '2026-02-01', fim: '2027-01-31' });
  assert.deepEqual(c.experiencia, { tipo: '45 + 45 dias', fimPrimeiroPeriodo: '2026-04-24', fimSegundoPeriodo: '2026-06-08' });
  // e o que o Convênia manda sai inteiro: documentos, dinheiro, endereço, contato, saúde
  assert.equal((c.document as { cpf: string }).cpf, '123.456.789-09');
  assert.equal((c.cpf as { cpf: string }).cpf, '12345678909');
  assert.equal((c.ctps as { pis: string }).pis, 'PIS-SECRETO');
  assert.equal((c.rg as { number: string }).number, 'RG-SECRETO');
  assert.equal(c.salary, 4321.5);
  assert.equal(c.birth_date, '1990-01-02');
  assert.equal((c.bank_accounts as Array<{ pix: string; agency: string }>)[0]!.pix, 'pix-secreto');
  assert.equal((c.address as { address: string }).address, 'Rua Secreta');
  assert.equal(c.cellphone, '(11) 99999-0000');
  assert.equal(c.email, 'pessoa.privada@gmail.com');
  assert.equal(c.mother_name, 'Mae Sigilosa');
  assert.equal((c.aso as Array<{ observation: string }>)[0]!.observation, 'ASO-sigiloso');
  assert.equal((c.ethnicity as { name: string }).name, 'Etnia-sigilosa');
  assert.equal((c.disability as { disability_type: string }).disability_type, 'Fisica-sigilosa');
  assert.equal((c.annotations as Array<{ notes: string }>)[0]!.notes, 'anotacao sigilosa');
  trouxe(c, DADO_DE_FICHA);
});

test('no choque de nomes, o campo em português ganha do bruto (filtro e agrupamento não quebram)', () => {
  const c = colaboradorNormalizado(pessoa('x', 'Ana', 'Souza', { nome: 'ERRADO', departamento: 'ERRADO', cargo: 'ERRADO', situacao: 'ERRADO' }));
  assert.equal(c.nome, 'Ana Souza');
  assert.equal(c.departamento, 'Tecnologia');
  assert.equal(c.cargo, 'Analista de sistemas');
  assert.equal(c.situacao, 'Ativo');
});

test('resumirColaborador: projeta só os campos em português da ficha já normalizada', () => {
  const r = resumirColaborador(colaboradorNormalizado(BRUNO));
  assert.deepEqual(Object.keys(r).sort(), ['admissao', 'cargo', 'centroDeCusto', 'departamento', 'estagio', 'experiencia', 'gestor', 'id', 'matricula', 'nome', 'situacao', 'time']);
  assert.equal(r.nome, 'Bruno Lima');
  resumida(r);
});

test('nome social sai quando difere do nome; vazio ou igual não', () => {
  assert.equal(colaboradorNormalizado(pessoa('x', 'Joao', 'Silva', { social_name: 'Joana Silva' })).nomeSocial, 'Joana Silva');
  assert.equal(colaboradorNormalizado(pessoa('x', 'Joao', 'Silva', { social_name: 'João Silva' })).nomeSocial, undefined);
  assert.equal(colaboradorNormalizado(pessoa('x', 'Joao', 'Silva')).nomeSocial, undefined);
});

test('afastamentoNormalizado: motivo, tipo e dias em português MAIS o CID e a justificativa', () => {
  const a = afastamentoNormalizado({ motive: { name: 'Afastamento por doença' }, type: { name: 'Justificada' }, date_from: '2026-10-01', date_to: '2026-10-03', total: '3', cid: 'M54.5', justification: 'dor nas costas sigilosa' });
  assert.deepEqual(a, {
    motive: { name: 'Afastamento por doença' }, type: { name: 'Justificada' }, date_from: '2026-10-01', date_to: '2026-10-03', total: '3',
    cid: 'M54.5', justification: 'dor nas costas sigilosa',
    motivo: 'Afastamento por doença', tipo: 'Justificada', de: '2026-10-01', ate: '2026-10-03', dias: 3,
  });
});

test('colaboradores ativos: filtros, agrupamento e listagem resumida por padrão', async () => {
  const chamadas: Array<[string, Record<string, unknown>]> = [];
  const ctx = ctxPadrao(rotasPadrao(), chamadas);
  const r = await conveniaColaboradores(ctx, { unidade: 'doutor-digital', agruparPor: 'departamento' });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(r.situacao, 'ativos');
  assert.equal(u.total, 2);
  assert.deepEqual(u.agrupado, { Comercial: 1, Tecnologia: 1 });
  assert.equal(chamadas[0]![0], '/employees');
  assert.equal(chamadas[0]![1].paginate, 500);
  resumida(r);

  const so = await conveniaColaboradores(ctx, { unidade: 'digital', departamento: 'tecnologia', admitidosDe: '2026-10-01', admitidosAte: '2026-10-31' });
  const s = so.porUnidade['doutor-digital'] as Extract<(typeof so.porUnidade)[string], { ok: true }>;
  assert.deepEqual(s.itens.map((x) => x.nome), ['Ana Souza']);
  assert.equal(chamadas.filter(([c]) => c === '/employees').length, 1, 'a segunda consulta sai do cache');
});

test('colaboradores com completo: true: a mesma leitura devolve a ficha inteira (uma chave de cache só)', async () => {
  const chamadas: Array<[string, Record<string, unknown>]> = [];
  const ctx = ctxPadrao(rotasPadrao(), chamadas);
  const padrao = await conveniaColaboradores(ctx, { unidade: 'doutor-digital' });
  resumida(padrao);

  const r = await conveniaColaboradores(ctx, { unidade: 'doutor-digital', completo: true });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.deepEqual(u.itens.map((x) => x.nome), ['Ana Souza', 'Bruno Lima'], 'os campos em português continuam lá');
  trouxe(r, ['123.456.789-09', '4321.5', 'pix-secreto', 'Rua Secreta', '1990-01-02', 'ASO-sigiloso']);
  assert.equal(chamadas.filter(([c]) => c === '/employees').length, 1, 'completo não cria variante de cache: a leitura é a mesma');
});

test('colaboradores desligados: ficha lida por pessoa, período de desligamento e desligamento inteiro', async () => {
  const ctx = ctxPadrao();
  const r = await conveniaColaboradores(ctx, { unidade: 'doutor-digital', desligadosDe: '2026-10-01', desligadosAte: '2026-10-31', agruparPor: 'tipoDesligamento' });
  assert.equal(r.situacao, 'desligados');
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(u.total, 1);
  assert.equal(u.itens[0]!.nome, 'Carla Dias');
  assert.equal(u.itens[0]!.situacao, 'Desligado');
  // o desligamento é registro pequeno: sai inteiro, com motivo e comentários, mesmo na listagem resumida
  assert.deepEqual(u.itens[0]!.desligamento, {
    date: '2026-10-10', type: { id: 3, title: 'Término de Contrato de Estágio' }, dismissal_step: { name: 'Concluída' },
    termination_notice: { termination_notice_type: { name: 'Trabalhado' } }, motive: 'motivo-livre-sigiloso', comments: 'comentario-sigiloso',
    data: '2026-10-10', tipo: 'Término de Contrato de Estágio', avisoPrevio: 'Trabalhado', etapa: 'Concluída',
  });
  assert.deepEqual(u.agrupado, { 'Término de Contrato de Estágio': 1 });
  resumida(r);
  const fora = await conveniaColaboradores(ctx, { unidade: 'doutor-digital', situacao: 'desligados', desligadosDe: '2026-11-01' });
  assert.equal((fora.porUnidade['doutor-digital'] as { total: number }).total, 0);
  await assert.rejects(() => conveniaColaboradores(ctx, { unidade: 'doutor-digital', situacao: 'ativos', desligadosDe: '2026-10-01' }), /desligados/);
});

test('desligados além do teto: contam sem nome; com filtro de pessoa a conta sai marcada incompleta', async () => {
  const muitos = Array.from({ length: 3 }, (_, i) => ({ id: `dddddddd-0000-4000-8000-00000000000${i}`, dismissal: { date: `2026-10-0${i + 1}`, type: { title: 'Outros' } } }));
  const rotas: Rotas = { ...rotasPadrao(), '/employees/dismissed': () => pagina(muitos) };
  for (const d of muitos) rotas[`/employees/${d.id}`] = () => ({ data: pessoa(d.id, 'Pessoa', d.id.slice(-1)) });
  const ctx = ctxPadrao(rotas, undefined, { maxColaboradores: 2 });
  const r = await conveniaColaboradores(ctx, { unidade: 'doutor-digital', situacao: 'desligados', agruparPor: 'tipoDesligamento' });
  const u = r.porUnidade['doutor-digital'] as { total: number; itens: unknown[]; desligadosSemFicha?: number; incompleto?: boolean; agrupado?: Record<string, number>; aviso?: string };
  assert.equal(u.total, 3, 'o terceiro conta, só não é nomeado');
  assert.equal(u.itens.length, 2);
  assert.equal(u.desligadosSemFicha, 1);
  assert.equal(u.incompleto, undefined);
  assert.deepEqual(u.agrupado, { Outros: 3 });
  assert.match(u.aviso!, /sem nome/);

  const porDep = await conveniaColaboradores(ctx, { unidade: 'doutor-digital', situacao: 'desligados', agruparPor: 'departamento' });
  assert.deepEqual((porDep.porUnidade['doutor-digital'] as { agrupado?: Record<string, number> }).agrupado, { Tecnologia: 2, '(sem ficha)': 1 });

  const f = await conveniaColaboradores(ctx, { unidade: 'doutor-digital', situacao: 'desligados', departamento: 'tecnologia' });
  const uf = f.porUnidade['doutor-digital'] as { total: number; incompleto?: boolean; aviso?: string };
  assert.equal(uf.total, 2);
  assert.equal(uf.incompleto, true);
  assert.match(uf.aviso!, /parciais/);
});

test('movimentação com desligados além do teto: a contagem de desligamentos vem da listagem inteira', async () => {
  const muitos = Array.from({ length: 3 }, (_, i) => ({ id: `dddddddd-0000-4000-8000-00000000000${i}`, dismissal: { date: `2026-10-0${i + 1}`, type: { title: 'Outros' } } }));
  const rotas: Rotas = { ...rotasPadrao(), '/employees/dismissed': () => pagina(muitos) };
  for (const d of muitos) rotas[`/employees/${d.id}`] = () => ({ data: pessoa(d.id, 'Pessoa', d.id.slice(-1), { hiring_date: '2020-01-01' }) });
  const r = await conveniaMovimentacao(ctxPadrao(rotas, undefined, { maxColaboradores: 2 }), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-31' });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(u.desligamentos, 3);
  assert.deepEqual(u.porMes['2026-10'], { admissoes: 1, desligamentos: 3 });
  assert.deepEqual(u.desligamentosPorTipo, { Outros: 3 });
  assert.equal(u.itensDesligamentos.length, 2);
  assert.equal((u as { incompleto?: boolean }).incompleto, true);
});

test('movimentação: admissões e desligamentos do período, por mês e por tipo', async () => {
  const r = await conveniaMovimentacao(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-31' });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(u.ativosHoje, 2);
  assert.equal(u.admissoes, 1);
  assert.equal(u.desligamentos, 1);
  assert.equal(u.saldo, 0);
  assert.deepEqual(u.porMes, { '2026-10': { admissoes: 1, desligamentos: 1 } });
  assert.deepEqual(u.desligamentosPorTipo, { 'Término de Contrato de Estágio': 1 });
  assert.deepEqual(u.itensAdmissoes.map((x) => x.nome), ['Ana Souza']);
  resumida(r);
});

test('movimentação com completo: true traz a ficha inteira de quem entrou e de quem saiu', async () => {
  const r = await conveniaMovimentacao(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-31', completo: true });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.deepEqual(u.itensAdmissoes.map((x) => x.nome), ['Ana Souza']);
  assert.deepEqual(u.itensDesligamentos.map((x) => x.nome), ['Carla Dias']);
  trouxe(u.itensAdmissoes, ['123.456.789-09', '4321.5']);
  trouxe(u.itensDesligamentos, ['123.456.789-09', 'Rua Secreta']);
});

test('movimentação conta a admissão de quem entrou e já saiu', async () => {
  const r = await conveniaMovimentacao(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2025-08-01', fim: '2025-08-31' });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.deepEqual(u.itensAdmissoes.map((x) => x.nome), ['Carla Dias']);
  assert.equal(u.desligamentos, 0);
});

test('férias: no período, canceladas fora, vencidas e a vencer, solicitação e coletiva inteiras', async () => {
  const r = await conveniaFerias(ctxPadrao(), { unidade: 'doutor-digital', fim: '2026-12-31' });
  assert.deepEqual(r.periodo, { inicio: '2026-10-20', fim: '2026-12-31', hoje: '2026-10-20' });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(u.feriasNoPeriodo, 1, 'a cancelada de dezembro não conta');
  assert.equal(u.emFeriasHoje, 1);
  // registro pequeno: a solicitação sai como o Convênia guarda (justificativa inclusive) + nomes em português
  assert.deepEqual(u.itens[0], {
    starts_at: '2026-10-20', finishes_at: '2026-11-08', requested_days: 20, allowance: 10, status: 'aprovada', canceled: null,
    justification: 'justificativa-das-ferias',
    inicio: '2026-10-20', fim: '2026-11-08', dias: 20, abonoDias: 10, statusOriginal: 'approved',
    nome: 'Ana Souza', cargo: 'Analista de sistemas', departamento: 'Tecnologia',
  }, 'o status traduzido não apaga o original: statusOriginal guarda o que o Convênia manda');
  assert.equal(u.periodosVencidos, 1);
  assert.equal(u.vencidas[0]!.limiteParaTirar, '2026-03-09');
  assert.equal(u.vencidas[0]!.initial_balance, 30, 'o período aquisitivo também sai inteiro');
  assert.equal(u.periodosAVencerAteOFim, 1);
  assert.deepEqual(u.coletivas, [{
    title: 'Recesso', starts_at: '2026-12-22', finishes_at: '2027-01-02', requested_days: 12, departments: [{ id: 'd1', name: 'Tecnologia' }],
    emails: ['rh-coletivas@empresa.com'], justification: 'justificativa-da-coletiva',
    titulo: 'Recesso', inicio: '2026-12-22', fim: '2027-01-02', dias: 12, departamentos: ['Tecnologia'],
  }]);
  assert.equal(u.colaboradoresLidos, 2);
  // a ficha da pessoa não vem junto nas férias: só nome, cargo e departamento
  resumida(r);
});

test('férias numa empresa grande: lê até o teto e avisa', async () => {
  const r = await conveniaFerias(ctxPadrao(rotasPadrao(), undefined, { maxColaboradores: 1 }), { unidade: 'doutor-digital' });
  const u = r.porUnidade['doutor-digital'] as { truncado?: boolean; colaboradoresLidos: number; colaboradoresNoFiltro: number; aviso?: string };
  assert.equal(u.truncado, true);
  assert.equal(u.colaboradoresLidos, 1);
  assert.equal(u.colaboradoresNoFiltro, 2);
  assert.match(u.aviso!, /filtre por departamento/);
});

test('afastamentos: sobreposição com o período, dias dentro dele, com CID e justificativa', async () => {
  const r = await conveniaAfastamentos(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-31', agruparPor: 'motivo' });
  const u = r.porUnidade['doutor-digital'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(u.ocorrencias, 2);
  assert.equal(u.pessoas, 2);
  assert.equal(u.itens[0]!.diasNoPeriodo, 3, 'de 28/09 a 03/10: só 01–03/10 contam');
  assert.equal(u.diasNoPeriodo, 4);
  assert.deepEqual(u.agrupado, { 'Afastamento por doença': 1, Falta: 1 });
  assert.equal(u.itens[0]!.cid, 'M54.5');
  assert.equal(u.itens[0]!.justification, 'dor nas costas sigilosa');
  assert.equal(u.itens[0]!.nome, 'Ana Souza');
  assert.equal(u.itens[1]!.justification, 'nao-avisou-sigiloso');
  assert.match(r.observacao, /CID e justificativa inclusive/);
  // a ficha da pessoa não vem junto no afastamento: só nome, cargo e departamento
  resumida(r);
  const so = await conveniaAfastamentos(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-31', motivo: 'doenca' });
  assert.equal((so.porUnidade['doutor-digital'] as { ocorrencias: number }).ocorrencias, 1);
});

test('ficha de uma pessoa: sempre completa, sem precisar de flag', async () => {
  const r = await conveniaColaborador(ctxPadrao(), { unidade: 'doutor-digital', busca: 'ana souza' });
  assert.ok(r.colaborador && r.ferias);
  assert.equal(r.colaborador.nome, 'Ana Souza');
  assert.equal(r.colaborador.vinculo, 'CLT');
  assert.ok('periodos' in r.ferias && r.ferias.periodos.length === 2);
  assert.ok(Array.isArray(r.afastamentos) && r.afastamentos[0]!.motivo === 'Afastamento por doença');
  assert.equal(r.afastamentos[0]!.cid, 'M54.5');
  // a ficha de UMA pessoa sai inteira: documento, dinheiro, endereço, contato, saúde
  trouxe(r, DADO_DE_FICHA);
  assert.match(r.aviso, /dado pessoal sensível/);
});

test('ficha: nome ambíguo devolve candidatos; desligado é achado; ninguém dá erro claro', async () => {
  const rotas: Rotas = { ...rotasPadrao(), '/employees': () => pagina([ANA, BRUNO, pessoa('aaaaaaaa-0000-4000-8000-000000000009', 'Ana', 'Pereira')]) };
  const r = await conveniaColaborador(ctxPadrao(rotas), { unidade: 'doutor-digital', busca: 'Ana' });
  assert.ok(r.candidatos);
  assert.deepEqual(r.candidatos.map((c) => c.nome), ['Ana Pereira', 'Ana Souza']);
  resumida(r, 'a lista de candidatos é só para desambiguar: não despeja ficha');

  const d = await conveniaColaborador(ctxPadrao({ ...rotasPadrao(), [`/employees/${CARLA_DESLIGADA.id}/vacations/solicitations`]: () => pagina([]), [`/employees/${CARLA_DESLIGADA.id}/vacations/periods`]: () => pagina([]), [`/employees/${CARLA_DESLIGADA.id}/absences`]: () => ({ data: { absences: [] } }) }), { unidade: 'doutor-digital', busca: 'carla' });
  assert.ok(d.colaborador);
  assert.equal(d.colaborador.situacao, 'Desligado');
  assert.equal(d.colaborador.desligamento?.data, '2026-10-10');
  trouxe(d, DADO_DE_FICHA);

  await assert.rejects(() => conveniaColaborador(ctxPadrao(), { unidade: 'doutor-digital', busca: 'Zé Ninguém' }), /ninguém com/);
});

test('ficha: parte sem permissão vira "indisponivel" sem derrubar o resto', async () => {
  const rotas: Rotas = { ...rotasPadrao(), [`/employees/${ANA.id}/absences`]: () => { throw new Error('o token do Convênia não tem permissão (403)'); } };
  const r = await conveniaColaborador(ctxPadrao(rotas), { unidade: 'doutor-digital', busca: ANA.id });
  assert.ok(r.colaborador);
  assert.deepEqual(r.afastamentos, { indisponivel: 'o token do Convênia não tem permissão (403)' });
});

test('várias empresas: uma com erro fica fora da rede', async () => {
  const ok = conta('doutor-digital', rotasPadrao());
  const quebrada = conta('hm-tecnologia', { '/employees': () => { throw new Error('o Convênia recusou o token (401)'); } });
  const ctx = criarContextoConvenia(new Map([[ok.slug, ok], [quebrada.slug, quebrada]]), { agora: () => AGORA });
  const r = await conveniaColaboradores(ctx, { unidade: 'todas' });
  assert.equal(r.rede!.colaboradores, 2);
  assert.deepEqual(r.rede!.unidadesForaDoTotal, ['hm-tecnologia']);
  assert.equal(r.porUnidade['hm-tecnologia']!.ok, false);
});

test('empresa sem Convênia e sem nenhuma conta: erros claros', () => {
  assert.throws(() => resolverContasConvenia(ctxPadrao(), 'serra'), /sem Convênia/);
  assert.throws(() => resolverContasConvenia(criarContextoConvenia(new Map()), 'doutor-digital'), /painel de integrações/);
  assert.equal(resolverContasConvenia(ctxPadrao(), ['doutor-digital', 'digital']).length, 1, 'o mesmo pedido duas vezes conta uma');
});

test('paginação segue last_page', async () => {
  let n = 0;
  const rotas: Rotas = { '/employees': (q) => { n++; return { current_page: q.page, last_page: 3, data: [pessoa(`p${q.page}`, 'P', String(q.page))] }; } };
  const r = await conveniaColaboradores(ctxPadrao(rotas), { unidade: 'doutor-digital' });
  assert.equal(n, 3);
  assert.equal((r.porUnidade['doutor-digital'] as { total: number }).total, 3);
});

test('integrações mostram o Convênia', () => {
  const r = listarIntegracoes({ franquia: new Map(), kommo: new Map(), bling: new Map(), asaas: new Map([['doutor-digital', { nome: 'Doutor Digital' }]]), convenia: new Map([['doutor-digital', { nome: 'Doutor Digital' }]]) });
  assert.equal(r.unidades[0]!.convenia, true);
  assert.equal(r.comConvenia, 1);
  assert.ok(r.unidades[0]!.ferramentas.some((f) => f.startsWith('convenia_*')));
});
