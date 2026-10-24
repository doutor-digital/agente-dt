import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  afastamentoNormalizado,
  batidaNormalizada,
  colaboradorNormalizado,
  criarContextoTiquetaque,
  espelhoNormalizado,
  folhaDoMes,
  resolverContasTiquetaque,
  resumirColaborador,
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

/**
 * Dado pessoal que só existe na FICHA do funcionário. Por decisão da dona da empresa (24/10/2026) ele SAI
 * pelo conector — em `tiquetaque_colaboradores` com `completo: true`. O que estes valores provam aqui é o
 * outro lado: a listagem PADRÃO continua resumida, e as linhas de ponto, batida, atraso e afastamento só
 * identificam a pessoa (nome, local, departamento, cargo) em vez de despejar a ficha de todo mundo.
 */
const DADO_DE_FICHA = [
  '12345678909', '98765432100', 'NIS-SECRETO', '63991234567', '63988887777', 'pessoa.privada@gmail.com',
  '1990-01-02', 'Cidade-Sigilosa', 'EXT-SIGILOSO', '4321',
];

/** Dado do REGISTRO de ponto: sai sempre, em toda resposta que traz o registro. */
const DADO_DO_REGISTRO = {
  batida: ['justificativa sigilosa', 'selfie-sigilosa', '-23.5505'],
  afastamento: ['https://arquivos.exemplo/atestado-sigiloso.pdf', 'CID M54 sigiloso'],
  dia: ['selfie-sigilosa', '-23.5505'],
};

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
  // Ana chega com campos homônimos dos nomes em português: eles não podem ocupar o campo derivado
  funcionario(ID.ana, 'Ana Souza', { admission_date: '2026-10-05' }, { desligamento: 'DATA TROCADA', matricula: 'MATRICULA TROCADA' }),
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

/** Um campo homônimo do Tiquetaque não pode trocar a pessoa da linha (nem o número da rubrica). */
const NOME_TROCADO = 'NOME TROCADO PELO TIQUETAQUE';

/**
 * Espelho bruto de um dia: batidas + rubricas, mais o que o Tiquetaque manda junto (horário que não é
 * HH:MM, localização) e um `nome` homônimo para provar que a pessoa da linha não é trocada.
 */
const diaBruto = (horarios: string[], rub: Record<string, string> = {}) => ({
  horarios: [...horarios, 'selfie-sigilosa'], ...rub, localizacao: '-23.5505', nome: NOME_TROCADO,
});

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
        // a data inválida não entra em `dias`: tem de sair em `diasNaoLidos` para não cortar nada
        days: { '2026-10-14': diaBruto(['07:00', '19:00'], { total: '12.00', extra_50: '2.00' }), '0000-00-00': diaBruto(['09:00']) },
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
            { time: '2026-10-19T08:00', approved: true, type: 'app', justification: 'justificativa sigilosa', latitude: -23.5505, photo: 'selfie-sigilosa', device: 'iPhone da Ana', nome: NOME_TROCADO },
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
                attachment: 'https://arquivos.exemplo/atestado-sigiloso.pdf', details: 'CID M54 sigiloso', horaInicio: 'HORA TROCADA', descontaDoBanco: 'TROCADO',
                approval_info: { approved: true, change_request: { approved_by: { name: 'Gestora Chefe' } } },
              },
              { _id: 'w2', employee_id: ID.ana, leave_type: 'ferias', start_date: '2026-12-01', end_date: '2026-12-20', paid_leave: true, approval_info: { approved: false, change_request: {} } },
            ]
          : q.employee_id === ID.bruno
            ? [{ _id: 'w3', employee_id: ID.bruno, type: 'folga', start_date: '2026-10-10', end_date: '2026-10-10', start_time: '14:00', end_time: '18:00', paid_leave: true, nome: NOME_TROCADO, departamento: 'DEPTO TROCADO', approval_info: { approved: false, change_request: { rejected_date: '2026-10-09T10:00:00+00:00' } } }]
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

/** A resposta está resumida: nenhum campo da ficha da pessoa veio junto. */
function resumida(resposta: unknown, porque = 'a resposta padrão trouxe a ficha inteira'): void {
  const json = JSON.stringify(resposta);
  for (const s of DADO_DE_FICHA) assert.ok(!json.includes(s), `${porque}: "${s}"`);
}

/** A resposta está completa: cada valor pedido chegou. */
function trouxe(resposta: unknown, valores: string[]): void {
  const json = JSON.stringify(resposta);
  for (const s of valores) assert.ok(json.includes(s), `faltou "${s}" na resposta completa`);
}

type Ok<T> = Extract<T, { ok: true }>;
const unidadeOk = <T extends { porUnidade: Record<string, unknown> }>(r: T) => r.porUnidade['doutor-digital'] as Ok<T['porUnidade'][string]>;

const REF: Referencias = {
  locaisDe: new Map([[ID.ana, ['DH - Imperatriz']]]),
  empregadores: new Map([['emp1', 'Doutor Digital LTDA']]),
  escalas: new Map([['esc1', 'Comercial 8h']]),
  gestores: new Map([['u1', 'Gestora Chefe']]),
};

test('colaboradorNormalizado: a ficha inteira do Tiquetaque junto com os campos em português', () => {
  const c = colaboradorNormalizado(FUNCIONARIOS[0]!, REF);
  // os nomes em português continuam de pé: é por eles que filtro, agrupamento, busca e ordenação funcionam
  assert.deepEqual(
    { nome: c.nome, local: c.local, empregador: c.empregador, escala: c.escala, gestor: c.gestor, admissao: c.admissao },
    { nome: 'Ana Souza', local: 'DH - Imperatriz', empregador: 'Doutor Digital LTDA', escala: 'Comercial 8h', gestor: 'Gestora Chefe', admissao: '2026-10-05' },
  );
  // e a ficha sai inteira: documentos, contato, nascimento, cidade, id externo…
  assert.equal(c.cpf, '12345678909');
  assert.equal(c.nis, 'NIS-SECRETO');
  assert.equal(c.mobile_phone, '63991234567');
  assert.equal(c.email, 'pessoa.privada@gmail.com');
  assert.equal(c.birth_date, '1990-01-02');
  assert.equal(c.city, 'Cidade-Sigilosa');
  assert.equal(c.external_id, 'EXT-SIGILOSO');
  // …inclusive o contrato com valor da hora e as exigências de foto e GPS
  const contrato = c.contract_data as { hour_rate_cents: number; requires_geotag: boolean; requires_web_photo: boolean; enabled_geofence: boolean };
  assert.deepEqual(
    { hour_rate_cents: contrato.hour_rate_cents, requires_geotag: contrato.requires_geotag, requires_web_photo: contrato.requires_web_photo, enabled_geofence: contrato.enabled_geofence },
    { hour_rate_cents: 4321, requires_geotag: true, requires_web_photo: true, enabled_geofence: true },
  );
  trouxe(colaboradorNormalizado(FUNCIONARIOS[3]!, REF), ['98765432100', '63988887777']);
  // campo homônimo do bruto não ocupa um nome em português, nem quando o derivado está vazio
  assert.equal(c.desligamento, undefined, 'Ana não foi desligada');
  assert.equal(c.matricula, undefined, 'Ana não tem matrícula no Tiquetaque');
  assert.ok(!JSON.stringify(c).includes('DATA TROCADA') && !JSON.stringify(c).includes('MATRICULA TROCADA'));
  const carla = colaboradorNormalizado(FUNCIONARIOS[2]!, REF);
  assert.equal(carla.desligamento, '2026-10-31');
  assert.equal(carla.matricula, '77');
  // o resumo PROJETA só os campos em português (é ele que vai na listagem padrão)
  const resumo = resumirColaborador(c);
  assert.deepEqual(Object.keys(resumo).sort(), ['admissao', 'cargo', 'departamento', 'empregador', 'escala', 'gestor', 'id', 'inicioDosRegistros', 'local', 'nome']);
  resumida(resumo, 'o resumo trouxe campo da ficha');
  assert.deepEqual(Object.keys(resumirColaborador(carla)).sort(), ['admissao', 'cargo', 'departamento', 'desligamento', 'empregador', 'escala', 'gestor', 'id', 'inicioDosRegistros', 'local', 'matricula', 'nome']);
});

test('espelhoNormalizado: dia e totais inteiros, rubricas com nome daqui, batida só HH:MM, banco de horas', () => {
  const e = espelhoNormalizado(espelhosDoPeriodo('2026-10-01', '2026-10-31')[0]!)!;
  assert.deepEqual(e.totais, { trabalhadas: 16.5, normais: 16.5, atraso: 0.75, faltaInjustificada: 8, faltaJustificada: 1 });
  // os campos em português do dia continuam iguais…
  assert.equal(e.dias[0]!.data, '2026-10-14');
  assert.deepEqual(e.dias[0]!.batidas, ['08:30', '12:00', '13:00', '18:00']);
  assert.deepEqual(e.dias[0]!.horas, { trabalhadas: 8.5, atraso: 0.5 });
  // …e o dia sai inteiro: horários crus (com o que não é HH:MM) e a localização
  assert.deepEqual(e.dias[0]!.horarios, ['08:30', '12:00', '13:00', '18:00', 'selfie-sigilosa']);
  assert.equal(e.dias[0]!.localizacao, '-23.5505');
  // rubrica sem nome daqui não entra no mapa de números (o filtro e a soma dependem dele) mas sai nos
  // totais crus — o deepEqual acima já provou que `totais` tem só as cinco rubricas conhecidas
  assert.equal((e.totals as Record<string, string>).valor_em_reais, '999.99');
  // o banco de horas sai inteiro: os números em português mais o resto do resumo
  assert.deepEqual(
    { saldoAnterior: e.bancoDeHoras!.saldoAnterior, geradoNoPeriodo: e.bancoDeHoras!.geradoNoPeriodo, lancadoManual: e.bancoDeHoras!.lancadoManual, saldoFinal: e.bancoDeHoras!.saldoFinal },
    { saldoAnterior: -9.17, geradoNoPeriodo: 1, lancadoManual: 3, saldoFinal: -5.17 },
  );
  assert.deepEqual(e.bancoDeHoras!.period, { type: 'open', start_date: '2021-03-10' });
  // `dias` já leva cada dia cru: o mapa `days` do bruto não é repetido (dobraria o espelho)
  assert.equal(e.days, undefined);
  assert.equal(e.diasNaoLidos, undefined, 'sem dia ilegível, a chave não aparece');
  const b = espelhoNormalizado(espelhosDoPeriodo('2026-10-01', '2026-10-31')[1]!)!;
  assert.deepEqual(b.totais, { trabalhadas: 50, extra50: 2, extra100: 1.5, adicionalNoturnoExtra50: 0.5 });
  // o dia que `dias` não soube ler sai inteiro em `diasNaoLidos`: nada é cortado
  assert.deepEqual(b.dias.map((d) => d.data), ['2026-10-14']);
  assert.deepEqual(Object.keys(b.diasNaoLidos as object), ['0000-00-00']);
  assert.deepEqual((b.diasNaoLidos as Record<string, { horarios: string[] }>)['0000-00-00']!.horarios, ['09:00', 'selfie-sigilosa']);
  assert.equal(espelhoNormalizado({ totals: {} }), null);
});

test('batida e afastamento saem inteiros: foto, GPS, justificativa, anexo do atestado e quem aprovou', () => {
  const b = batidaNormalizada({ time: '2026-10-19T12:00', approved: false, type: 'ajuste manual', justification: 'justificativa sigilosa', photo: 'selfie-sigilosa', latitude: -23.5505, device: 'iPhone da Ana' })!;
  assert.deepEqual({ data: b.data, hora: b.hora, tipo: b.tipo, aprovada: b.aprovada }, { data: '2026-10-19', hora: '12:00', tipo: 'ajuste manual', aprovada: false });
  assert.equal(b.justification, 'justificativa sigilosa');
  assert.equal(b.photo, 'selfie-sigilosa');
  assert.equal(b.latitude, -23.5505);
  assert.equal(b.device, 'iPhone da Ana');
  assert.equal(batidaNormalizada({ time: 'quebrado' }), null);
  const a = afastamentoNormalizado({ leave_type: 'atestado', start_date: '2026-10-18', end_date: '2026-10-21', paid_leave: true, hours_bank_debit: false, attachment: 'https://arquivos.exemplo/atestado-sigiloso.pdf', details: 'CID M54 sigiloso', approval_info: { approved: true } });
  assert.deepEqual(
    { tipo: a.tipo, inicio: a.inicio, fim: a.fim, situacao: a.situacao, remunerado: a.remunerado, descontaDoBanco: a.descontaDoBanco, temAnexo: a.temAnexo },
    { tipo: 'atestado', inicio: '2026-10-18', fim: '2026-10-21', situacao: 'aprovado', remunerado: true, descontaDoBanco: false, temAnexo: true },
  );
  assert.equal(a.attachment, 'https://arquivos.exemplo/atestado-sigiloso.pdf');
  assert.equal(a.details, 'CID M54 sigiloso');
  assert.deepEqual(a.approval_info, { approved: true });
  trouxe(a, DADO_DO_REGISTRO.afastamento);
  assert.equal(afastamentoNormalizado({ type: 'ferias', start_date: '2026-12-01', approval_info: { approved: false } }).tipo, 'férias');
  assert.equal(afastamentoNormalizado({ type: 'ferias', start_date: '2026-12-01', approval_info: { approved: false } }).situacao, 'pendente');
  assert.equal(afastamentoNormalizado({ leave_type: 'folga', approval_info: { approved: false, change_request: { rejected_date: '2026-10-09' } } }).situacao, 'reprovado');
});

test('folha do mês pelo dia de corte', () => {
  assert.deepEqual(folhaDoMes('2026-10', 31), { inicio: '2026-10-01', fim: '2026-10-31' });
  assert.deepEqual(folhaDoMes('2026-10', 25), { inicio: '2026-09-26', fim: '2026-10-25' });
  assert.deepEqual(folhaDoMes('2026-03', 30), { inicio: '2026-03-01', fim: '2026-03-30' });
  assert.deepEqual(folhaDoMes('2026-01', 20), { inicio: '2025-12-21', fim: '2026-01-20' });
  assert.throws(() => folhaDoMes('2026-13', 31), /AAAA-MM/);
});

test('colaboradores: filtro por local, agrupamento, nomes de empregador/gestor, cache; resumo por padrão e ficha inteira com completo', async () => {
  const chamadas: Array<[string, Record<string, unknown>]> = [];
  const ctx = ctxPadrao(rotasPadrao(), chamadas);
  const r = await tiquetaqueColaboradores(ctx, { unidade: 'doutor-digital', agruparPor: 'local' });
  const u = unidadeOk(r);
  assert.equal(u.total, 4);
  assert.deepEqual(u.agrupado, { 'DH - Imperatriz': 2, 'DH - Açailândia': 1, 'HM TECNOLOGIA MULTIMIX LTDA': 1 });
  assert.equal(u.itens.find((x) => x.nome === 'Bruno Lima')!.empregador, 'Clinica Exemplo LTDA');
  resumida(r, 'a listagem padrão trouxe a ficha inteira');
  const so = await tiquetaqueColaboradores(ctx, { unidade: 'digital', local: 'imperatriz', admitidosDe: '2026-10-01' });
  assert.deepEqual(unidadeOk(so).itens.map((x) => x.nome), ['Ana Souza']);
  // completo: true devolve a ficha inteira (CPF, PIS/NIS, telefone, e-mail, nascimento, cidade, valor da hora)
  const inteiro = await tiquetaqueColaboradores(ctx, { unidade: 'doutor-digital', completo: true });
  trouxe(inteiro, DADO_DE_FICHA);
  const anaInteira = unidadeOk(inteiro).itens.find((x) => x.nome === 'Ana Souza') as Record<string, unknown>;
  assert.equal(anaInteira.cpf, '12345678909');
  assert.equal(anaInteira.nome, 'Ana Souza', 'a ficha crua não troca o nome em português');
  assert.equal(unidadeOk(inteiro).total, 4, 'o filtro e a contagem não mudam com completo');
  // uma chave de cache só: `completo` é resumo na resposta, não leitura nova
  assert.equal(chamadas.filter(([c]) => c === '/employees').length, 1, 'a segunda consulta sai do cache');
  assert.equal(chamadas.find(([c]) => c === '/employees')![1].max_results, 500);
});

test('ponto de hoje: trabalhando agora, saiu, sem batida, sem espelho; falta de hoje não conta', async () => {
  const r = await tiquetaquePontoDoDia(ctxPadrao(), { unidade: 'doutor-digital', agruparPor: 'situacao' });
  assert.equal(r.data, '2026-10-20');
  assert.equal(r.agora, '10:30');
  const u = unidadeOk(r);
  assert.equal(u.resumo.colaboradores, 4);
  assert.equal(u.resumo.trabalhandoAgora, 1);
  assert.equal(u.resumo.saiuOuEmIntervalo, 1);
  assert.equal(u.resumo.semBatida, 1);
  assert.equal(u.resumo.semEspelho, 1);
  assert.equal(u.resumo.comAtraso, 1);
  assert.deepEqual(u.agrupado, { 'saiu ou em intervalo': 1, 'sem batida': 1, 'sem espelho': 1, trabalhando: 1 });
  const ana = u.itens.find((x) => x.nome === 'Ana Souza')!;
  assert.deepEqual(ana.batidas, ['08:15'], 'em batidas só o que é HH:MM');
  assert.equal(ana.atraso, 0.25, 'o número em português ganha da rubrica crua "0.25" (texto)');
  // o dia sai inteiro: horários crus e localização
  assert.deepEqual(ana.horarios, ['08:15', 'selfie-sigilosa']);
  assert.equal(ana.localizacao, '-23.5505');
  assert.equal(ana.nome, 'Ana Souza', 'o campo homônimo do dia não troca a pessoa da linha');
  trouxe(r, DADO_DO_REGISTRO.dia);
  const carla = u.itens.find((x) => x.nome === 'Carla Dias')!;
  assert.equal(carla.faltaInjustificada, undefined, 'falta de hoje ainda não é falta');
  // a chave continua fora do JSON da linha, como antes (o `undefined` não é serializado)…
  assert.ok(!Object.keys(JSON.parse(JSON.stringify(carla)) as object).includes('faltaInjustificada'));
  // …e o mapa de horas em português também não a traz: ele não pode contradizer o resumo, que não conta
  // falta hoje. Quem quiser o número do Tiquetaque tem a rubrica CRUA do dia, que continua na resposta
  assert.equal((carla.horas as Record<string, number>).faltaInjustificada, undefined);
  assert.equal(carla.falta_injustificada, '8.00', 'a rubrica crua do dia não é cortada');
  resumida(r, 'a linha do ponto trouxe a ficha da pessoa');

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
  assert.equal(ana.bancoDeHoras!.saldoFinal, -5.17);
  assert.deepEqual(ana.bancoDeHoras!.period, { type: 'open', start_date: '2021-03-10' }, 'o banco sai inteiro');
  assert.equal(ana.diasComAtraso, 2);
  assert.equal(ana.diasComFaltaInjustificada, 1);
  assert.equal(ana.espelho, undefined, 'sem completo, o espelho inteiro não vai na resposta');
  const carla = u.itens[2]!;
  assert.equal(carla.horas.faltaInjustificada, undefined, 'a falta de hoje sai do total');
  assert.equal(u.resumo.extras, 3.5);
  assert.deepEqual(u.resumo.bancoDeHoras, { pessoas: 2, saldoTotal: -1.17, negativos: 1, positivos: 1 });
  assert.deepEqual(u.agrupado!['DH - Imperatriz'], { pessoas: 2, trabalhadas: 16.5, extras: 0, atraso: 0.75, faltaInjustificada: 8 });
  assert.equal(u.resumo.semEspelho, 1);
  resumida(r, 'a linha de horas trouxe a ficha da pessoa');

  // completo: true acrescenta o espelho inteiro, dia a dia, com os totais crus
  const inteiro = await tiquetaqueHoras(ctxPadrao(), { unidade: 'doutor-digital', mes: '2026-10', completo: true });
  const anaInteira = unidadeOk(inteiro).itens.find((x) => x.nome === 'Ana Souza')!;
  assert.deepEqual(anaInteira.espelho!.dias[0]!.horarios, ['08:30', '12:00', '13:00', '18:00', 'selfie-sigilosa']);
  assert.equal((anaInteira.espelho!.totals as Record<string, string>).valor_em_reais, '999.99');
  assert.deepEqual(anaInteira.horas, u.itens[0]!.horas, 'o resumo de horas não muda com completo');

  const parcial = await tiquetaqueHoras(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-14', fim: '2026-10-16' });
  assert.match(unidadeOk(parcial).aviso!, /folha inteira/);
  await assert.rejects(() => tiquetaqueHoras(ctxPadrao(), { unidade: 'doutor-digital', mes: '2026-10', inicio: '2026-10-01' }), /mes OU/);
  await assert.rejects(() => tiquetaqueHoras(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-01-01', fim: '2026-12-31' }), /no máximo 186 dias/);
});

test('atrasos e faltas: dia a dia, ranking por colaborador, falta de hoje fora', async () => {
  const r = await tiquetaqueAtrasosFaltas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-20', agruparPor: 'colaborador' });
  const u = unidadeOk(r);
  assert.deepEqual(u.resumo, {
    ocorrencias: 4, diasComAtraso: 2, horasDeAtraso: 0.75, pessoasComAtraso: 1, diasComFaltaInjustificada: 1, horasDeFaltaInjustificada: 8,
    pessoasComFaltaInjustificada: 1, diasComFaltaJustificada: 1,
  });
  assert.deepEqual(Object.keys(u.agrupado!), ['Ana Souza'], 'a falta de hoje da Carla não entra');
  assert.equal(u.itens[0]!.diaDaSemana, 'quarta');
  // o dia do atraso sai inteiro (horários crus, localização) e a pessoa da linha não é trocada
  assert.deepEqual(u.itens[0]!.horarios, ['08:30', '12:00', '13:00', '18:00', 'selfie-sigilosa']);
  assert.equal(u.itens[0]!.localizacao, '-23.5505');
  assert.equal(u.itens[0]!.nome, 'Ana Souza', 'o campo homônimo do dia não troca quem se atrasou');
  assert.equal(u.itens[0]!.atraso, 0.5, 'o número em português ganha da rubrica crua "0.50" (texto)');
  trouxe(r, DADO_DO_REGISTRO.dia);
  resumida(r, 'a linha do atraso trouxe a ficha da pessoa');
  const so = await tiquetaqueAtrasosFaltas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-20', tipo: 'falta' });
  assert.deepEqual(unidadeOk(so).itens.map((x) => x.data), ['2026-10-15', '2026-10-16']);
  assert.ok(unidadeOk(so).itens.every((x) => x.atraso === undefined), 'tipo=falta não devolve a rubrica crua de atraso como se fosse o número');
  assert.equal(unidadeOk(so).resumo.horasDeAtraso, 0);
});

test('batidas: tipo e aprovação, marcação inteira (foto, GPS, justificativa), teto de pessoas com aviso', async () => {
  const r = await tiquetaqueBatidas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-19', agruparPor: 'tipo' });
  const u = unidadeOk(r);
  assert.equal(u.batidas, 5);
  assert.equal(u.pendentes, 1);
  assert.deepEqual(u.agrupado, { aparelho: 3, 'ajuste manual': 1, app: 1 });
  // a marcação sai inteira: o registro cru do Tiquetaque junto com os campos em português
  assert.deepEqual(u.itens.find((b) => b.tipo === 'ajuste manual'), {
    time: '2026-10-19T12:00', approved: false, type: 'ajuste manual', justification: 'justificativa sigilosa',
    data: '2026-10-19', hora: '12:00', tipo: 'ajuste manual', aprovada: false, nome: 'Ana Souza', local: 'DH - Imperatriz',
  });
  const app = u.itens.find((b) => b.tipo === 'app')!;
  assert.equal(app.photo, 'selfie-sigilosa');
  assert.equal(app.latitude, -23.5505);
  assert.equal(app.device, 'iPhone da Ana');
  assert.equal(app.nome, 'Ana Souza', 'o campo homônimo da batida não troca de quem ela é');
  trouxe(r, DADO_DO_REGISTRO.batida);
  resumida(r, 'a linha da batida trouxe a ficha da pessoa');
  const pend = await tiquetaqueBatidas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-19', aprovacao: 'pendentes' });
  assert.equal(unidadeOk(pend).batidas, 1);
  const corte = await tiquetaqueBatidas(ctxPadrao(rotasPadrao(), undefined, { maxColaboradores: 2 }), { unidade: 'doutor-digital', inicio: '2026-10-19' });
  const uc = unidadeOk(corte) as { truncado?: boolean; incompleto?: boolean; aviso?: string; colaboradoresLidos: number };
  assert.equal(uc.colaboradoresLidos, 2);
  assert.equal(uc.incompleto, true);
  assert.match(uc.aviso!, /li 2 de 4/);
  await assert.rejects(() => tiquetaqueBatidas(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-01-01', fim: '2026-06-30' }), /no máximo 62 dias/);
});

test('afastamentos: sobreposição, dias no período, situação, anexo do atestado e justificativa inclusive', async () => {
  const r = await tiquetaqueAfastamentos(ctxPadrao(), { unidade: 'doutor-digital', inicio: '2026-10-01', fim: '2026-10-31', agruparPor: 'tipo' });
  const u = unidadeOk(r);
  assert.equal(u.ocorrencias, 2, 'as férias de dezembro não caem no período');
  assert.deepEqual(u.agrupado, { atestado: 1, folga: 1 });
  assert.equal(u.afastadosHoje, 1);
  const atestado = u.itens.find((x) => x.tipo === 'atestado')!;
  assert.equal(atestado.diasNoPeriodo, 4);
  assert.equal(atestado.temAnexo, true);
  // o afastamento sai inteiro: anexo do atestado, detalhe clínico e quem aprovou
  assert.equal(atestado.attachment, 'https://arquivos.exemplo/atestado-sigiloso.pdf');
  assert.equal(atestado.details, 'CID M54 sigiloso');
  assert.deepEqual(atestado.approval_info, { approved: true, change_request: { approved_by: { name: 'Gestora Chefe' } } });
  trouxe(r, DADO_DO_REGISTRO.afastamento);
  // campo homônimo do bruto não ocupa um nome em português: o atestado não tem hora e desconta do banco=false
  assert.equal(atestado.horaInicio, undefined, 'o atestado é de dia inteiro');
  assert.equal(atestado.descontaDoBanco, false);
  const folga = u.itens.find((x) => x.tipo === 'folga')!;
  assert.deepEqual([folga.situacao, folga.horaInicio, folga.horaFim], ['reprovado', '14:00', '18:00']);
  assert.deepEqual([folga.nome, folga.departamento], ['Bruno Lima', 'Tecnologia'], 'campo homônimo do afastamento não troca a pessoa nem o departamento que agrupa');
  resumida(r, 'a linha do afastamento trouxe a ficha da pessoa');
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
