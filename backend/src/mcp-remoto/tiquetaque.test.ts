import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afastamentoSeguro,
  batidaSegura,
  colaboradorSeguro,
  criarContextoTiquetaque,
  espelhoSeguro,
  folhaDoMes,
  resolverContasTiquetaque,
  tiquetaqueAfastamentos,
  tiquetaqueAtrasosFaltas,
  tiquetaqueBatidas,
  tiquetaqueColaboradores,
  tiquetaqueHoras,
  tiquetaquePontoDoDia,
  type ContaTiquetaque,
  type EspelhoBruto,
  type FuncionarioBruto,
  type Referencias,
} from './tiquetaque.js';
import { listarIntegracoes } from './integracoes.js';

/** Valores que NUNCA podem aparecer em resposta nenhuma (LGPD). */
const SEGREDOS = [
  '12345678909', '98765432100', 'NIS-SECRETO', '63991234567', 'pessoa.privada@gmail.com', 'gestora.privada@gmail.com', '1990-01-02',
  'Cidade-Sigilosa', '4321', '-23.5505', '-46.6333', 'RUA SECRETA', '90240111', '11222333000181', 'justificativa sigilosa',
  'https://arquivos.exemplo/atestado-sigiloso.pdf', 'CID M54 sigiloso', 'EXT-SIGILOSO', 'selfie-sigilosa', '63988887777',
];

const AGORA = Date.parse('2026-10-20T13:30:00Z'); // 10:30 em Brasília
const ID = { ana: 'a00000000000000000000001', bruno: 'b00000000000000000000002', carla: 'c00000000000000000000003', davi: 'd00000000000000000000004' };

function funcionario(id: string, nome: string, extra: Partial<FuncionarioBruto['contract_data']> = {}, raiz: Partial<FuncionarioBruto> = {}): FuncionarioBruto {
  return {
    _id: id, full_name: nome, work_schedule: 'esc1',
    // tudo isto chega da API e não pode sair
    cpf: '12345678909', nis: 'NIS-SECRETO', mobile_phone: '63991234567', phone_country_code: '55', email: 'pessoa.privada@gmail.com',
    birth_date: '1990-01-02', city: 'Cidade-Sigilosa', state: 'MA', timezone: 'America/Araguaina', external_id: 'EXT-SIGILOSO',
    contract_data: {
      payment_source: 'emp1', manager: 'u1', admission_date: '2026-03-10', records_start_date: '2026-03-10', department: 'Recepção',
      job_role: 'Recepcionista', hour_rate_cents: 4321, requires_geotag: true, requires_web_photo: true, enabled_geofence: true, ...extra,
    },
    ...raiz,
  };
}

const FUNCIONARIOS = [
  funcionario(ID.ana, 'Ana Souza', { admission_date: '2026-10-05' }),
  funcionario(ID.bruno, 'Bruno Lima', { department: 'Tecnologia', job_role: 'Desenvolvedor', payment_source: 'emp2' }),
  funcionario(ID.carla, 'Carla Dias', { dismissal_date: '2026-10-31', registration_number: '77' }),
  funcionario(ID.davi, 'Davi Rocha', { department: 'Fisioterapia', job_role: 'Fisioterapeuta' }, { cpf: '98765432100', mobile_phone: '63988887777' }),
];

const EMPREGADORES = [
  { _id: 'emp1', name: 'Doutor Digital LTDA', cnpj: '11222333000181', period_cut_day: 31, address: { street_name: 'RUA SECRETA', cep: '90240111' } },
  { _id: 'emp2', name: 'Clinica Exemplo LTDA', cnpj: '11222333000181', period_cut_day: 25 },
];
const LOCAIS = [
  { _id: 's1', name: 'DH - Imperatriz', timezone: 'America/Araguaina', employees: [ID.ana, ID.carla], geofence_location: { radius_meters: 100, location: [-23.5505, -46.6333] } },
  { _id: 's2', name: 'HM TECNOLOGIA MULTIMIX LTDA', employees: [ID.bruno] },
  { _id: 's3', name: 'DH - Açailândia', employees: [ID.davi] },
];
const ESCALAS = [{ _id: 'esc1', description: 'Comercial 8h' }];
const USUARIOS = [{ _id: 'u1', full_name: 'Gestora Chefe', email: 'gestora.privada@gmail.com', mobile_phone: '63991234567', role: 'admin' }];

const lista = (itens: unknown[], q: Record<string, unknown> = {}) => {
  const max = Number(q.max_results ?? 25);
  const page = Number(q.page ?? 1);
  return { _items: itens.slice((page - 1) * max, page * max), _meta: { total: itens.length, max_results: max, page } };
};

/** Espelho bruto de um dia: batidas + rubricas, mais lixo que não pode sair. */
const diaBruto = (horarios: string[], rub: Record<string, string> = {}) => ({ horarios: [...horarios, 'selfie-sigilosa'], ...rub, localizacao: '-23.5505' });

function espelhosDoPeriodo(inicio: string, fim: string): EspelhoBruto[] {
  const itens: EspelhoBruto[] = [];
  if (inicio === '2026-10-20' && fim === '2026-10-20') {
    itens.push(
      { employee_id: ID.ana, period: { start_date: inicio, end_date: fim }, totals: { total: '0.00', atraso: '0.25' }, days: { '2026-10-20': diaBruto(['08:15'], { atraso: '0.25' }) } },
      { employee_id: ID.bruno, period: { start_date: inicio, end_date: fim }, totals: { total: '2.00' }, days: { '2026-10-20': diaBruto(['07:00', '09:00'], { total: '2.00' }) } },
      { employee_id: ID.carla, period: { start_date: inicio, end_date: fim }, totals: { falta_injustificada: '8.00' }, days: { '2026-10-20': diaBruto([], { falta_injustificada: '8.00' }) } },
      // Davi sem espelho no dia
    );
  } else if (inicio === '2026-10-19' && fim === '2026-10-19') {
    itens.push(
      { employee_id: ID.ana, totals: {}, days: { '2026-10-19': diaBruto(['08:00', '12:00', '13:00']) } },
      { employee_id: ID.carla, totals: { falta_injustificada: '8.00' }, days: { '2026-10-19': diaBruto([], { falta_injustificada: '8.00' }) } },
    );
  } else {
    // período longo: Ana com atraso e falta, Carla com falta hoje (não pode contar), Bruno com extras
    const dias: Record<string, Record<string, unknown>> = {
      '2026-10-14': diaBruto(['08:30', '12:00', '13:00', '18:00'], { total: '8.50', atraso: '0.50' }),
      '2026-10-15': diaBruto([], { falta_injustificada: '8.00' }),
      '2026-10-16': diaBruto(['08:00', '12:00', '13:00', '17:00'], { total: '8.00', falta_justificada: '1.00' }),
      '2026-10-20': diaBruto(['08:15'], { atraso: '0.25' }),
    };
    itens.push(
      {
        employee_id: ID.ana, period: { start_date: inicio, end_date: fim },
        totals: { total: '16.50', horas_normais: '16.50', atraso: '0.75', falta_injustificada: '8.00', falta_justificada: '1.00', valor_em_reais: '999.99' },
        days: Object.fromEntries(Object.entries(dias).filter(([d]) => d >= inicio && d <= fim)),
        hours_bank_summary: { previous_balance: '-9.17', generated_balance: '1.00', created_balance: '3.00', final_balance: '-5.17', period: { type: 'open', start_date: '2021-03-10' } },
      },
      {
        employee_id: ID.bruno, period: { start_date: inicio, end_date: fim },
        totals: { total: '50.00', extra_50: '2.00', extra_100: '1.50', adicional_noturno_extra_50: '0.50' },
        days: { '2026-10-14': diaBruto(['07:00', '19:00'], { total: '12.00', extra_50: '2.00' }) },
        hours_bank_summary: { previous_balance: '0', generated_balance: '4.00', created_balance: '0', final_balance: '4.00' },
      },
      {
        employee_id: ID.carla, period: { start_date: inicio, end_date: fim },
        totals: { falta_injustificada: '8.00' },
        days: { '2026-10-20': diaBruto([], { falta_injustificada: '8.00' }) },
      },
    );
  }
  return itens;
}

type Rotas = Record<string, (q: Record<string, unknown>) => unknown>;

function rotasPadrao(): Rotas {
  return {
    '/employees': (q) => lista(FUNCIONARIOS, q),
    '/payment-sources': (q) => lista(EMPREGADORES, q),
    '/sites': (q) => lista(LOCAIS, q),
    '/work-schedules/summary': (q) => lista(ESCALAS, q),
    '/users': (q) => lista(USUARIOS, q),
    '/timesheets': (q) => lista(espelhosDoPeriodo(String(q.start_date), String(q.end_date)), q),
    '/times': (q) => ({
      employee_id: q.employee_id,
      times: q.employee_id === ID.ana
        ? [
            { time: '2026-10-19T08:00', approved: true, type: 'app', justification: 'justificativa sigilosa', latitude: -23.5505, photo: 'selfie-sigilosa' },
            { time: '2026-10-19T12:00', approved: false, type: 'ajuste manual', justification: 'justificativa sigilosa' },
            { time: 'quebrado', approved: true, type: 'web' },
          ]
        : [{ time: '2026-10-19T07:00', approved: true, type: 'aparelho' }],
    }),
    '/work-leaves': (q) =>
      lista(
        q.employee_id === ID.ana
          ? [
              {
                _id: 'w1', employee_id: ID.ana, leave_type: 'atestado', start_date: '2026-10-18', end_date: '2026-10-21', paid_leave: true, hours_bank_debit: false,
                attachment: 'https://arquivos.exemplo/atestado-sigiloso.pdf', details: 'CID M54 sigiloso', approval_info: { approved: true, change_request: { approved_by: { name: 'Gestora Chefe' } } },
              },
              { _id: 'w2', employee_id: ID.ana, leave_type: 'ferias', start_date: '2026-12-01', end_date: '2026-12-20', paid_leave: true, approval_info: { approved: false, change_request: {} } },
            ]
          : q.employee_id === ID.bruno
            ? [{ _id: 'w3', employee_id: ID.bruno, type: 'folga', start_date: '2026-10-10', end_date: '2026-10-10', start_time: '14:00', end_time: '18:00', paid_leave: true, approval_info: { approved: false, change_request: { rejected_date: '2026-10-09T10:00:00+00:00' } } }]
            : [],
        q,
      ),
  };
}

function conta(slug: string, rotas: Rotas, chamadas: Array<[string, Record<string, unknown>]> = []): ContaTiquetaque {
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

const ctxPadrao = (rotas = rotasPadrao(), chamadas?: Array<[string, Record<string, unknown>]>, op: { maxColaboradores?: number } = {}) =>
  criarContextoTiquetaque(new Map([['doutor-digital', conta('doutor-digital', rotas, chamadas)]]), { agora: () => AGORA, ...op });

function semSegredo(resposta: unknown): void {
  const json = JSON.stringify(resposta);
  for (const s of SEGREDOS) assert.ok(!json.includes(s), `vazou "${s}" na resposta`);
}

type Ok<T> = Extract<T, { ok: true }>;
const unidadeOk = <T extends { porUnidade: Record<string, unknown> }>(r: T) => r.porUnidade['doutor-digital'] as Ok<T['porUnidade'][string]>;

const REF: Referencias = {
  locaisDe: new Map([[ID.ana, ['DH - Imperatriz']]]),
  empregadores: new Map([['emp1', 'Doutor Digital LTDA']]),
  escalas: new Map([['esc1', 'Comercial 8h']]),
  gestores: new Map([['u1', 'Gestora Chefe']]),
};

test('colaboradorSeguro: só a lista fechada sai (nome, local, empregador, cargo, datas)', () => {
  const c = colaboradorSeguro(FUNCIONARIOS[0]!, REF);
  assert.deepEqual(Object.keys(c).sort(), ['admissao', 'cargo', 'departamento', 'empregador', 'escala', 'gestor', 'id', 'inicioDosRegistros', 'local', 'nome']);
  assert.deepEqual(
    { nome: c.nome, local: c.local, empregador: c.empregador, escala: c.escala, gestor: c.gestor, admissao: c.admissao },
    { nome: 'Ana Souza', local: 'DH - Imperatriz', empregador: 'Doutor Digital LTDA', escala: 'Comercial 8h', gestor: 'Gestora Chefe', admissao: '2026-10-05' },
  );
  const carla = colaboradorSeguro(FUNCIONARIOS[2]!, REF);
  assert.equal(carla.desligamento, '2026-10-31');
  assert.equal(carla.matricula, '77');
  semSegredo([c, carla]);
});

test('espelhoSeguro: rubricas com nome daqui, chave desconhecida e batida inválida fora, banco de horas', () => {
  const e = espelhoSeguro(espelhosDoPeriodo('2026-10-01', '2026-10-31')[0]!)!;
  assert.deepEqual(e.totais, { trabalhadas: 16.5, normais: 16.5, atraso: 0.75, faltaInjustificada: 8, faltaJustificada: 1 });
  assert.deepEqual(e.dias[0], { data: '2026-10-14', batidas: ['08:30', '12:00', '13:00', '18:00'], horas: { trabalhadas: 8.5, atraso: 0.5 } });
  assert.deepEqual(e.bancoDeHoras, { saldoAnterior: -9.17, geradoNoPeriodo: 1, lancadoManual: 3, saldoFinal: -5.17 });
  const b = espelhoSeguro(espelhosDoPeriodo('2026-10-01', '2026-10-31')[1]!)!;
  assert.deepEqual(b.totais, { trabalhadas: 50, extra50: 2, extra100: 1.5, adicionalNoturnoExtra50: 0.5 });
  assert.equal(espelhoSeguro({ totals: {} }), null);
  semSegredo([e, b]);
});

test('batida e afastamento: só o que pode sair; leave_type real e type da doc; reprovado e pendente', () => {
  assert.deepEqual(batidaSegura({ time: '2026-10-19T12:00', approved: false, type: 'ajuste manual', justification: 'justificativa sigilosa' }), { data: '2026-10-19', hora: '12:00', tipo: 'ajuste manual', aprovada: false });
  assert.equal(batidaSegura({ time: 'quebrado' }), null);
  const a = afastamentoSeguro({ leave_type: 'atestado', start_date: '2026-10-18', end_date: '2026-10-21', paid_leave: true, hours_bank_debit: false, attachment: 'https://arquivos.exemplo/atestado-sigiloso.pdf', details: 'CID M54 sigiloso', approval_info: { approved: true } });
  assert.deepEqual(a, { tipo: 'atestado', inicio: '2026-10-18', fim: '2026-10-21', situacao: 'aprovado', remunerado: true, descontaDoBanco: false, temAnexo: true });
  semSegredo(a);
  assert.equal(afastamentoSeguro({ type: 'ferias', start_date: '2026-12-01', approval_info: { approved: false } }).tipo, 'férias');
  assert.equal(afastamentoSeguro({ type: 'ferias', start_date: '2026-12-01', approval_info: { approved: false } }).situacao, 'pendente');
  assert.equal(afastamentoSeguro({ leave_type: 'folga', approval_info: { approved: false, change_request: { rejected_date: '2026-10-09' } } }).situacao, 'reprovado');
});

test('folha do mês pelo dia de corte', () => {
  assert.deepEqual(folhaDoMes('2026-10', 31), { inicio: '2026-10-01', fim: '2026-10-31' });
  assert.deepEqual(folhaDoMes('2026-10', 25), { inicio: '2026-09-26', fim: '2026-10-25' });
  assert.deepEqual(folhaDoMes('2026-03', 30), { inicio: '2026-03-01', fim: '2026-03-30' });
  assert.deepEqual(folhaDoMes('2026-01', 20), { inicio: '2025-12-21', fim: '2026-01-20' });
  assert.throws(() => folhaDoMes('2026-13', 31), /AAAA-MM/);
});

test('colaboradores: filtro por local, agrupamento, nomes de empregador/gestor, cache e nada sensível', async () => {
  const chamadas: Array<[string, Record<string, unknown>]> = [];
  const ctx = ctxPadrao(rotasPadrao(), chamadas);
  const r = await tiquetaqueColaboradores(ctx, { unidade: 'doutor-digital', agruparPor: 'local' });
  const u = unidadeOk(r);
  assert.equal(u.total, 4);
  assert.deepEqual(u.agrupado, { 'DH - Imperatriz': 2, 'DH - Açailândia': 1, 'HM TECNOLOGIA MULTIMIX LTDA': 1 });
  assert.equal(u.itens.find((x) => x.nome === 'Bruno Lima')!.empregador, 'Clinica Exemplo LTDA');
  semSegredo(r);
  const so = await tiquetaqueColaboradores(ctx, { unidade: 'digital', local: 'imperatriz', admitidosDe: '2026-10-01' });
  assert.deepEqual(unidadeOk(so).itens.map((x) => x.nome), ['Ana Souza']);
  assert.equal(chamadas.filter(([c]) => c === '/employees').length, 1, 'a segunda consulta sai do cache');
  assert.equal(chamadas.find(([c]) => c === '/employees')![1].max_results, 500);
});

test('ponto de hoje: trabalhando agora, saiu, sem batida, sem espelho; atraso e falta de hoje não contam', async () => {
  const r = await tiquetaquePontoDoDia(ctxPadrao(), { unidade: 'doutor-digital', agruparPor: 'situacao' });
  assert.equal(r.data, '2026-10-20');
  assert.equal(r.agora, '10:30');
  const u = unidadeOk(r);
  assert.equal(u.resumo.colaboradores, 4);
  assert.equal(u.resumo.trabalhandoAgora, 1);
  assert.equal(u.resumo.saiuOuEmIntervalo, 1);
  assert.equal(u.resumo.semBatida, 1);
  assert.equal(u.resumo.semEspelho, 1);
  // com o dia em andamento o espelho conta como atraso o que falta trabalhar (21/10: entrou 06:53, "atraso" 6 h às 08:51)
  assert.ok(!('comAtraso' in u.resumo) && !('horasDeAtraso' in u.resumo), 'atraso de hoje não entra no resumo');
  assert.deepEqual(u.agrupado, { 'saiu ou em intervalo': 1, 'sem batida': 1, 'sem espelho': 1, trabalhando: 1 });
  const ana = u.itens.find((x) => x.nome === 'Ana Souza')!;
  assert.deepEqual(ana.batidas, ['08:15'], 'batida inválida (selfie) fica de fora');
  assert.ok(!('atraso' in ana), 'atraso de hoje ainda não é atraso');
  assert.ok(!('faltaInjustificada' in u.itens.find((x) => x.nome === 'Carla Dias')!), 'falta de hoje ainda não é falta');
  await assert.rejects(tiquetaquePontoDoDia(ctxPadrao(), { unidade: 'doutor-digital', situacao: 'comAtraso' }), /só existem quando o dia acaba/);
  semSegredo(r);

  const trab = await tiquetaquePontoDoDia(ctxPadrao(), { unidade: 'doutor-digital', situacao: 'trabalhando' });
  assert.deepEqual(unidadeOk(trab).itens.map((x) => x.nome), ['Ana Souza']);
  const porEmp = await tiquetaquePontoDoDia(ctxPadrao(), { unidade: 'doutor-digital', agruparPor: 'empregador' });
  assert.deepEqual(unidadeOk(porEmp).agrupado, { 'Doutor Digital LTDA': 3, 'Clinica Exemplo LTDA': 1 });
  await assert.rejects(() => tiquetaquePontoDoDia(ctxPadrao(), { unidade: 'doutor-digital', data: '2026-10-21' }), /futuro/);
});

test('ponto de um dia passado: batida ímpar e falta contam', async () => {
  const r = await tiquetaquePontoDoDia(ctxPadrao(), { unidade: 'doutor-digital', data: '2026-10-19', situacao: 'comFalta' });
  assert.equal(r.agora, undefined);
  const u = unidadeOk(r);
  assert.equal(u.resumo.comBatidaImpar, 1);
  assert.equal(u.resumo.comFalta, 1);
  assert.deepEqual(u.itens.map((x) => [x.nome, x.situacao, x.faltaInjustificada]), [['Carla Dias', 'sem batida', 8]]);
});

test('horas pela folha do mês: cada empregador na sua folha, banco de horas, falta de hoje fora, ranking', async () => {
  const chamadas: Array<[string, Record<string, unknown>]> = [];
  const r = await tiquetaqueHoras(ctxPadrao(rotasPadrao(), chamadas), { unidade: 'doutor-digital', mes: '2026-10', ordenarPor: 'bancoDeHoras', agruparPor: 'local' });
  const periodos = chamadas.filter(([c]) => c === '/timesheets').map(([, q]) => `${q.start_date}..${q.end_date}`).sort();
  assert.deepEqual(periodos, ['2026-09-26..2026-10-25', '2026-10-01..2026-10-31'], 'uma leitura por dia de corte');
  const u = unidadeOk(r);
  assert.deepEqual(u.periodos.sort(), ['2026-09-26 a 2026-10-25', '2026-10-01 a 2026-10-31']);
  assert.equal(u.aviso, undefined, 'folha inteira: sem aviso de banco');
  assert.deepEqual(u.itens.map((x) => x.nome), ['Ana Souza', 'Bruno Lima', 'Carla Dias'], 'quem deve mais horas primeiro');
  const ana = u.itens[0]!;
  assert.deepEqual(ana.bancoDeHoras, { saldoAnterior: -9.17, geradoNoPeriodo: 1, lancadoManual: 3, saldoFinal: -5.17 });
  assert.equal(ana.diasComAtraso, 2);
  assert.equal(ana.diasComFaltaInjustificada, 1);
  const carla = u.itens[2]!;
  assert.equal(carla.horas.faltaInjustificada, undefined, 'a falta de hoje sai do total');
  assert.equal(u.resumo.extras, 3.5);
  assert.deepEqual(u.resumo.bancoDeHoras, { pessoas: 2, saldoTotal: -1.17, negativos: 1, positivos: 1 });
  assert.deepEqual(u.agrupado!['DH - Imperatriz'], { pessoas: 2, trabalhadas: 16.5, extras: 0, atraso: 0.75, faltaInjustificada: 8 });
  assert.equal(u.resumo.semEspelho, 1);
  semSegredo(r);

  const parcial = await tiquetaqueHoras(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-14', fim: '2026-10-16' });
  assert.match(unidadeOk(parcial).aviso!, /folha inteira/);
  await assert.rejects(() => tiquetaqueHoras(ctxPadrao(), { unidade: 'doutor-digital', mes: '2026-10', inicio: '2026-10-01' }), /mes OU/);
  await assert.rejects(() => tiquetaqueHoras(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-01-01', fim: '2026-12-31' }), /no máximo 186 dias/);
});

test('atrasos e faltas: dia a dia, ranking por colaborador, atraso e falta de hoje fora', async () => {
  const r = await tiquetaqueAtrasosFaltas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-20', agruparPor: 'colaborador' });
  const u = unidadeOk(r);
  assert.deepEqual(u.resumo, {
    // o 0.25 de atraso da Ana HOJE (dia em andamento) não entra: era a hora que ainda faltava trabalhar
    ocorrencias: 3, diasComAtraso: 1, horasDeAtraso: 0.5, pessoasComAtraso: 1, diasComFaltaInjustificada: 1, horasDeFaltaInjustificada: 8,
    pessoasComFaltaInjustificada: 1, diasComFaltaJustificada: 1,
  });
  assert.deepEqual(Object.keys(u.agrupado!), ['Ana Souza'], 'a falta de hoje da Carla não entra');
  assert.equal(u.itens[0]!.diaDaSemana, 'quarta');
  semSegredo(r);
  const so = await tiquetaqueAtrasosFaltas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-20', tipo: 'falta' });
  assert.deepEqual(unidadeOk(so).itens.map((x) => x.data), ['2026-10-15', '2026-10-16']);
});

test('batidas: tipo e aprovação, justificativa nunca, teto de pessoas com aviso', async () => {
  const r = await tiquetaqueBatidas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-19', agruparPor: 'tipo' });
  const u = unidadeOk(r);
  assert.equal(u.batidas, 5);
  assert.equal(u.pendentes, 1);
  assert.deepEqual(u.agrupado, { aparelho: 3, 'ajuste manual': 1, app: 1 });
  assert.deepEqual(u.itens.find((b) => b.tipo === 'ajuste manual'), { nome: 'Ana Souza', local: 'DH - Imperatriz', data: '2026-10-19', hora: '12:00', tipo: 'ajuste manual', aprovada: false });
  semSegredo(r);
  const pend = await tiquetaqueBatidas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-19', aprovacao: 'pendentes' });
  assert.equal(unidadeOk(pend).batidas, 1);
  const corte = await tiquetaqueBatidas(ctxPadrao(rotasPadrao(), undefined, { maxColaboradores: 2 }), { unidade: 'doutor-digital', inicio: '2026-10-19' });
  const uc = unidadeOk(corte) as { truncado?: boolean; incompleto?: boolean; aviso?: string; colaboradoresLidos: number };
  assert.equal(uc.colaboradoresLidos, 2);
  assert.equal(uc.incompleto, true);
  assert.match(uc.aviso!, /li 2 de 4/);
  await assert.rejects(() => tiquetaqueBatidas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-01-01', fim: '2026-06-30' }), /no máximo 62 dias/);
});

test('afastamentos: sobreposição, dias no período, situação, anexo e justificativa nunca', async () => {
  const r = await tiquetaqueAfastamentos(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-31', agruparPor: 'tipo' });
  const u = unidadeOk(r);
  assert.equal(u.ocorrencias, 2, 'as férias de dezembro não caem no período');
  assert.deepEqual(u.agrupado, { atestado: 1, folga: 1 });
  assert.equal(u.afastadosHoje, 1);
  const atestado = u.itens.find((x) => x.tipo === 'atestado')!;
  assert.equal(atestado.diasNoPeriodo, 4);
  assert.equal(atestado.temAnexo, true);
  const folga = u.itens.find((x) => x.tipo === 'folga')!;
  assert.deepEqual([folga.situacao, folga.horaInicio, folga.horaFim], ['reprovado', '14:00', '18:00']);
  semSegredo(r);
  const pend = await tiquetaqueAfastamentos(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-12-31', situacao: 'pendente', tipo: 'ferias' });
  assert.deepEqual(unidadeOk(pend).itens.map((x) => [x.nome, x.tipo, x.diasNoPeriodo]), [['Ana Souza', 'férias', 20]]);
});

test('conta desconhecida: erro explica que clínicas são locais; "todas" e duplicadas', () => {
  assert.throws(() => resolverContasTiquetaque(ctxPadrao(), 'imperatriz'), /local="Imperatriz"/);
  assert.throws(() => resolverContasTiquetaque(criarContextoTiquetaque(new Map()), 'doutor-digital'), /painel de integrações/);
  assert.equal(resolverContasTiquetaque(ctxPadrao(), ['doutor-digital', 'digital']).length, 1);
  assert.equal(resolverContasTiquetaque(ctxPadrao(), 'todas').length, 1);
});

test('várias contas: uma com erro fica fora da rede', async () => {
  const ok = conta('doutor-digital', rotasPadrao());
  const quebrada = conta('hm-tecnologia', { '/employees': () => { throw new Error('o Tiquetaque recusou o token (401)'); }, '/payment-sources': () => lista([]) });
  const ctx = criarContextoTiquetaque(new Map([[ok.slug, ok], [quebrada.slug, quebrada]]), { agora: () => AGORA });
  const r = await tiquetaqueColaboradores(ctx, { unidade: 'todas' });
  assert.equal(r.rede!.colaboradores, 4);
  assert.deepEqual(r.rede!.unidadesForaDoTotal, ['hm-tecnologia']);
  assert.equal(r.porUnidade['hm-tecnologia']!.ok, false);
});

test('paginação segue _meta.total; locais/escalas/gestores que falham não derrubam o cadastro', async () => {
  let n = 0;
  const muitos = Array.from({ length: 1200 }, (_, i) => funcionario(`f${String(i).padStart(23, '0')}`, `Pessoa ${i}`));
  const rotas: Rotas = {
    ...rotasPadrao(),
    '/employees': (q) => { n++; return lista(muitos, q); },
    '/sites': () => { throw new Error('o token do Tiquetaque não tem acesso a /sites (403)'); },
  };
  const r = await tiquetaqueColaboradores(ctxPadrao(rotas), { unidade: 'doutor-digital', maxItens: 0 });
  assert.equal(n, 3);
  const u = unidadeOk(r);
  assert.equal(u.total, 1200);
  assert.match(u.aviso!, /os locais não foram lidos/);
});

test('integrações mostram o Tiquetaque', () => {
  const r = listarIntegracoes({ franquia: new Map(), kommo: new Map(), bling: new Map(), tiquetaque: new Map([['doutor-digital', { nome: 'Doutor Digital' }]]) });
  assert.equal(r.unidades[0]!.tiquetaque, true);
  assert.equal(r.comTiquetaque, 1);
  assert.ok(r.unidades[0]!.ferramentas.some((f) => f.startsWith('tiquetaque_*')));
});
