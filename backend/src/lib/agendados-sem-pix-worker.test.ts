import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from './logger.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';
import { ID_DA_AUTOMACAO, type UnidadeDaLista } from './agendados-sem-pix.js';
import { agendadosRecentes, contextoPluggyDoAmbiente, diaUtilAnterior, evolutionDaLista, lerBancoDaUnidade, varrer } from './agendados-sem-pix-worker.js';
import { agendaEmFatias } from './rendimento-sofia-fontes.js';
import { criarContextoPluggy } from '../mcp-remoto/pluggy.js';
import type { ContaPluggy, FontePluggy, ItemConfigurado, ItemPluggy, LancamentoPluggy } from './integracoes/pluggy.js';

// nomes, ids e documentos INVENTADOS
const HOJE = '2026-11-26';
const ITEM = 'a5c763cb-0952-457b-9936-630f79c5b016';
const SLUG = 'doutor-hernia-teste';

// ---------------------------------------------------------------------------------------------- a agenda (servidor que finge ser a franquia)

interface Corpo { initialDate: string; endDate: string; pagination: { page: number; rowsPerPage: number } }
const pedidosDaAgenda: Corpo[] = [];
let linhas: Array<Record<string, unknown>> = [];
let totalDePaginas = 1;
let servidor: http.Server;
let base = '';

before(async () => {
  servidor = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const corpo = JSON.parse(b || '{}') as Corpo;
      pedidosDaAgenda.push(corpo);
      const dias = (Date.parse(`${corpo.endDate}T00:00:00Z`) - Date.parse(`${corpo.initialDate}T00:00:00Z`)) / 86_400_000;
      res.setHeader('content-type', 'application/json');
      if (dias > 100) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'intervalo de datas máximo 100 dias' }));
      }
      res.end(JSON.stringify({ status: 'success', data: { data: linhas, total: linhas.length, page: corpo.pagination.page, rowsPerPage: 100, totalPages: totalDePaginas } }));
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

const unit = () => ({ spineBaseUrl: base, spineToken: 't', spineTimezone: 'America/Sao_Paulo' });
const sched = (id: number, nome: string, categoria: string, idStatus: number, dateAttendance: string, modified: string | undefined) => ({
  idSchedule: id, clientName: nome, categoryName: categoria, idStatus, statusName: 'x', dateAttendance, modified, modifiedBy: 'Recepcao Teste',
});
const U: UnidadeDaLista = { id: 'u1', slug: SLUG, fuso: 'America/Sao_Paulo', hoje: HOJE, minutoDoDia: 12 * 60 + 20, diaDeTrabalho: true, agendadosDesde: '2026-11-25', valores: [25000] };

test('agenda: só avaliação/consulta AGENDADA ou CONFIRMADA e marcada desde ontem; sessão, retorno, reavaliação, desmarcado e marcação antiga ficam de fora; hora na unidade', async () => {
  pedidosDaAgenda.length = 0;
  totalDePaginas = 1;
  linhas = [
    sched(1, 'Maria Silva', 'AVALIAÇÃO', 37, '2026-11-27T11:30:00.000Z', '2026-11-25T18:00:00.000Z'), // entra: 08:30 local, marcada ontem
    sched(2, 'Joana Lima', 'CONSULTA', 38, '2026-11-26T17:00:00.000Z', '2026-11-26T12:00:00.000Z'), // entra: confirmada, marcada hoje
    sched(3, 'Ana Antiga', 'AVALIAÇÃO', 37, '2026-11-30T11:30:00.000Z', '2026-11-20T12:00:00.000Z'), // marcada há 6 dias
    sched(4, 'Paulo Sessao', 'SESSÃO', 37, '2026-11-27T11:30:00.000Z', '2026-11-25T18:00:00.000Z'),
    sched(5, 'Rita Retorno', 'RETORNO', 37, '2026-11-27T11:30:00.000Z', '2026-11-25T18:00:00.000Z'),
    sched(6, 'Rosa Reavalia', 'REAVALIAÇÃO', 37, '2026-11-27T11:30:00.000Z', '2026-11-25T18:00:00.000Z'),
    sched(7, 'Dora Desmarcou', 'AVALIAÇÃO', 57, '2026-11-27T11:30:00.000Z', '2026-11-25T18:00:00.000Z'),
    sched(8, 'Sem Data', 'AVALIAÇÃO', 37, '2026-11-27T11:30:00.000Z', undefined),
    sched(9, 'Ivo Atendido', 'AVALIAÇÃO', 42, '2026-11-26T11:30:00.000Z', '2026-11-25T18:00:00.000Z'),
  ];
  const r = await agendadosRecentes(unit() as never, { ...U, slug: 'a-agenda' }, Date.now());
  assert.deepEqual(r!.agendados, [
    { nome: 'Maria Silva', dia: '2026-11-27', hora: '08:30', agendadoEm: '2026-11-25' },
    // CONFIRMADA: a última alteração é a confirmação, não a marcação — a data da marcação é desconhecida (o Pix vale desde 30 dias antes da consulta)
    { nome: 'Joana Lima', dia: '2026-11-26', hora: '14:00', agendadoEm: null },
  ]);
  // os conhecidos são todos os pacientes da agenda lida, de qualquer categoria, menos quem desmarcou
  assert.deepEqual(r!.conhecidos, ['Maria Silva', 'Joana Lima', 'Ana Antiga', 'Paulo Sessao', 'Rita Retorno', 'Rosa Reavalia', 'Sem Data', 'Ivo Atendido']);
  // a leitura vai de 21 dias atrás a 45 dias à frente, numa busca só (a franquia recusa mais de 100 dias)
  assert.deepEqual([pedidosDaAgenda[0]!.initialDate, pedidosDaAgenda[0]!.endDate], ['2026-11-05', '2027-01-11']);
  assert.equal(pedidosDaAgenda.length, 1, 'uma leitura só');
  // guardada: a volta seguinte (esperando o banco) não pergunta de novo à franquia
  await agendadosRecentes(unit() as never, { ...U, slug: 'a-agenda' }, Date.now());
  assert.equal(pedidosDaAgenda.length, 1);
});

test('agenda: o corte é o DIA ÚTIL anterior (na segunda, desde a sexta; depois de feriado, desde o último dia útil), e marcação confirmada ontem entra com data de marcação desconhecida', async () => {
  const semana = [1, 2, 3, 4, 5];
  assert.equal(diaUtilAnterior('2026-11-26', semana), '2026-11-25', 'quinta: quarta');
  assert.equal(diaUtilAnterior('2026-11-30', semana), '2026-11-27', 'segunda: sexta (não domingo)');
  assert.equal(diaUtilAnterior('2026-11-23', semana), '2026-11-19', 'segunda depois da Consciência Negra (sexta 20/11, feriado nacional): quinta');
  assert.equal(diaUtilAnterior('2026-11-16', semana), '2026-11-13', 'segunda depois do feriado de domingo: sexta');
  assert.equal(diaUtilAnterior('2026-09-08', semana), '2026-09-04', 'terça depois da Independência (segunda 07/09): sexta');
  assert.equal(diaUtilAnterior('2026-11-30', [1, 2, 3, 4, 5, 6]), '2026-11-28', 'unidade que abre sábado: sábado');
  assert.equal(diaUtilAnterior('2026-11-30', []), '2026-11-29', 'sem dia de agenda: ontem');
  pedidosDaAgenda.length = 0;
  totalDePaginas = 1;
  linhas = [
    sched(1, 'Maria Confirmada', 'AVALIAÇÃO', 38, '2026-12-01T11:30:00.000Z', '2026-11-27T18:00:00.000Z'), // confirmada na sexta
    sched(2, 'Joana Marcada', 'AVALIAÇÃO', 37, '2026-12-01T12:30:00.000Z', '2026-11-27T18:00:00.000Z'), // marcada na sexta
    sched(3, 'Ana Velha', 'AVALIAÇÃO', 37, '2026-12-01T13:30:00.000Z', '2026-11-26T18:00:00.000Z'), // marcada antes do corte
  ];
  const r = await agendadosRecentes(unit() as never, { ...U, slug: 'a-segunda', hoje: '2026-11-30', agendadosDesde: '2026-11-27' }, Date.now());
  assert.deepEqual(r!.agendados.map((a) => [a.nome, a.agendadoEm]), [['Maria Confirmada', null], ['Joana Marcada', '2026-11-27']]);
});

test('agenda: lista cortada no teto de páginas NÃO vira lista (melhor calar que afirmar «não achei» sobre metade da agenda)', async () => {
  totalDePaginas = 99;
  linhas = [sched(1, 'Maria Silva', 'AVALIAÇÃO', 37, '2026-11-27T11:30:00.000Z', '2026-11-25T18:00:00.000Z')];
  assert.equal(await agendadosRecentes(unit() as never, { ...U, slug: 'a-truncada' }, Date.now()), null);
  totalDePaginas = 1;
});

test('ROI: a agenda de 150 dias é lida em fatias de 90 (a franquia recusa mais de 100 dias com 400) e sem repetir dia', async () => {
  pedidosDaAgenda.length = 0;
  totalDePaginas = 1;
  linhas = [sched(1, 'Maria Silva', 'AVALIAÇÃO', 37, '2026-11-27T11:30:00.000Z', '2026-11-25T18:00:00.000Z')];
  const r = await agendaEmFatias(unit() as never, '2026-08-01', '2026-12-28');
  assert.ok(r);
  assert.equal(r.completa, true);
  // o corpo leva o fim EXCLUSIVO (o cliente soma 1 dia): as fatias são 01/08–29/10 e 30/10–28/12, sem dia repetido nem faltando, nenhuma com mais de 100 dias
  assert.deepEqual(pedidosDaAgenda.map((p) => [p.initialDate, p.endDate]), [['2026-08-01', '2026-10-30'], ['2026-10-30', '2026-12-29']]);
  totalDePaginas = 99;
  assert.equal((await agendaEmFatias(unit() as never, '2026-11-01', '2026-11-10'))?.completa, false, 'fatia cortada: a lista diz que não está completa');
  totalDePaginas = 1;
});

// ---------------------------------------------------------------------------------------------- o banco

const item = (o: Partial<ItemPluggy> = {}): ItemPluggy => ({ id: ITEM, banco: 'InfinitePay', status: 'UPDATED', statusDaSincronizacao: 'SUCCESS', atualizadoEm: '2026-11-26T14:59:00.000Z', consentimentoExpiraEm: '2027-10-01T00:00:00.000Z', erroCodigo: null, ...o });
const conta: ContaPluggy = { id: 'c1', tipo: 'BANK', subtipo: 'CHECKING_ACCOUNT', nome: 'Conta', numero: '1', saldo: 0, moeda: 'BRL' };
const lanc = (id: string, descricao: string, valor: number, o: Partial<LancamentoPluggy> = {}): LancamentoPluggy => ({ id, data: '2026-11-25', descricao, valor, tipo: 'entrada', categoria: null, status: 'POSTED', ...o });

function ctxDoBanco(it: ItemPluggy | Error, lancamentos: LancamentoPluggy[] = [], truncado = false) {
  const pedidos: string[] = [];
  const fonte: FontePluggy = {
    async item() { pedidos.push('item'); if (it instanceof Error) throw it; return it; },
    async contas() { pedidos.push('contas'); return [conta]; },
    async transacoes(id, de, ate) { pedidos.push(`tx ${de} ${ate}`); return { lancamentos, truncado }; },
    async testar() {},
    invalidarItem() {},
  };
  const itens: ItemConfigurado[] = [{ empresa: SLUG, nomeDaEmpresa: 'Teste', itemId: ITEM }];
  return { ctx: criarContextoPluggy(itens, fonte, { agora: () => Date.parse('2026-11-26T15:20:00.000Z') }), pedidos };
}
const agora = new Date('2026-11-26T15:20:00.000Z'); // 12:20 em São Paulo

test('banco: atualizou hoje → lê o extrato UMA vez por conta, separa o Pix e diz até quando leu (hora da unidade)', async () => {
  const { ctx, pedidos } = ctxDoBanco(item(), [lanc('p1', 'Pix MARIA SILVA', 250), lanc('v1', 'Vendas Visa', 100)]);
  const r = await lerBancoDaUnidade(ctx, U, '2026-11-20', false, agora);
  assert.ok(r);
  assert.equal(r.confiavel, true);
  assert.equal(r.lidoAte, '26/11 11:59');
  assert.deepEqual(r.pix.map((p) => p.id), ['p1']);
  assert.equal(pedidos.filter((p) => p.startsWith('tx')).length, 1);
  assert.match(pedidos.find((p) => p.startsWith('tx'))!, /tx 2026-11-20 2026-11-26/);
});

test('banco: NÃO atualizou hoje → não lê o extrato (só o status, que o cliente guarda) a menos que seja a última chance; e aí vem «não confiável»', async () => {
  const velho = item({ atualizadoEm: '2026-11-25T14:59:00.000Z' });
  const espera = ctxDoBanco(velho, [lanc('p1', 'Pix MARIA SILVA', 250)]);
  const r = await lerBancoDaUnidade(espera.ctx, U, '2026-11-20', false, agora);
  assert.deepEqual(r, { pix: [], lidoAte: '25/11 11:59', confiavel: false });
  assert.equal(espera.pedidos.some((p) => p.startsWith('tx')), false, 'esperar não gasta extrato');
  const ultima = ctxDoBanco(velho, [lanc('p1', 'Pix MARIA SILVA', 250)]);
  const l = await lerBancoDaUnidade(ultima.ctx, U, '2026-11-20', true, agora);
  assert.equal(l!.confiavel, false);
  assert.equal(l!.pix.length, 1, 'na última chance lê o que tem');
});

test('banco: conexão fora do ar (status ≠ UPDATED), extrato cortado ou item que não responde nunca viram «confiável»', async () => {
  assert.equal((await lerBancoDaUnidade(ctxDoBanco(item({ status: 'LOGIN_ERROR' })).ctx, U, '2026-11-20', false, agora))!.confiavel, false);
  assert.equal((await lerBancoDaUnidade(ctxDoBanco(item(), [], true).ctx, U, '2026-11-20', false, agora))!.confiavel, false, 'truncado');
  const semItem = await lerBancoDaUnidade(ctxDoBanco(new Error('caiu')).ctx, U, '2026-11-20', false, agora);
  assert.equal(semItem!.confiavel, false);
  assert.equal(semItem!.lidoAte, null);
});

test('banco: o período pedido nunca passa de 90 dias (o limite da leitura do conector)', async () => {
  const { ctx, pedidos } = ctxDoBanco(item());
  await lerBancoDaUnidade(ctx, U, '2025-01-01', false, agora);
  assert.match(pedidos.find((p) => p.startsWith('tx'))!, /tx 2026-09-02 2026-11-26/);
});

// ---------------------------------------------------------------------------------------------- com as variáveis vazias ou a chave desligada, tudo IGUAL a hoje

test('SEM PLUGGY_ITENS: a volta não toca em banco de dados nem em nada (comportamento idêntico ao de antes)', async () => {
  // o banco de teste não existe (DATABASE_URL de mentira): se a volta tocasse nele, o erro sairia no log como aviso
  const logs = ['info', 'warn', 'error'].map((n) => mock.method(logger, n as 'info'));
  await varrer({}, Date.parse('2026-11-26T15:20:00.000Z'));
  await varrer({ PLUGGY_ITENS: '' }, Date.parse('2026-11-26T15:20:00.000Z'));
  assert.deepEqual(logs.map((l) => l.mock.callCount()), [0, 0, 0]);
  mock.restoreAll();
});

test('chave DESLIGADA na tela: a volta não toca em banco de dados nem em Pluggy, mesmo com PLUGGY_ITENS e credenciais', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: ID_DA_AUTOMACAO, estado: 'desligado' }]);
  const logs = ['info', 'warn', 'error'].map((n) => mock.method(logger, n as 'info'));
  const env = { PLUGGY_ITENS: `${SLUG}:${ITEM}`, PLUGGY_CLIENT_ID: 'id-falso', PLUGGY_CLIENT_SECRET: 'segredo-falso-123' };
  await varrer(env, Date.parse('2026-11-26T15:20:00.000Z'));
  assert.deepEqual(logs.map((l) => l.mock.callCount()), [0, 0, 0], 'desligada: nem lê unidade, nem Pluggy, nem grava marca');
  mock.restoreAll();
  _esquecerOBancoParaTeste();
});

test('sem credenciais da Pluggy o contexto não existe (a lista nem tenta)', async () => {
  assert.equal(await contextoPluggyDoAmbiente({ PLUGGY_ITENS: `${SLUG}:${ITEM}` }), null);
  assert.equal(await contextoPluggyDoAmbiente({}), null);
});

test('Evolution: a própria da lista ou a dos avisos à recepção; sem URL ou sem chave, null', () => {
  assert.equal(evolutionDaLista({}), null);
  assert.deepEqual(evolutionDaLista({ AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: 'http://a', EVOLUTION_ALERT_HEADER: 'apikey', EVOLUTION_ALERT_VALUE: 'k' }), { url: 'http://a', header: 'apikey', valor: 'k' });
  assert.deepEqual(evolutionDaLista({ AGENDADOS_SEM_PIX_EVOLUTION_URL: 'http://b', AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: 'http://a', EVOLUTION_ALERT_HEADER: 'apikey', EVOLUTION_ALERT_VALUE: 'k' })?.url, 'http://b');
  assert.equal(evolutionDaLista({ AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: 'http://a' }), null);
});
