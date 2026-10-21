/**
 * Cache curto da busca de horários (decisão do João, 21/10/2026) — as regras, sem banco e sem franquia.
 * A ferramenta inteira (consultar_horarios com o cache, agendar_consulta apagando) está em
 * agent/cache-agenda-consulta.test.ts.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  AUTOMACAO_CACHE_AGENDA,
  MARCA_APAGADO,
  UNIDADE_TODA,
  _depsDoCacheParaTeste,
  apagarDoCache,
  assinaturaDaAgenda,
  chaveDoDia,
  depositoNaMemoria,
  entradaQueVale,
  estadoDoCacheDaAgenda,
  guardarNoCache,
  lerDoCache,
  medidorDoCache,
  oferecidosQueNaoValem,
  semHorarioVencido,
  validadeDoCacheMs,
  vaiProCache,
  type DepositoDoCache,
  type DiaConsultado,
} from './cache-agenda.js';
import { _semearParaTeste, type Estado } from './automacoes-estado.js';
import { automacaoPorId } from './automacoes.js';
import type { Simulacao } from './so-no-papel.js';

const SLUG = 'doutor-hernia-araguaina';
const unidade = {
  id: 'u-ara',
  slug: SLUG,
  spineAgendaStart: '08:00',
  spineAgendaEnd: '18:00',
  spineLunchStart: '12:00',
  spineLunchEnd: '13:00',
  spineAgendaDays: [1, 2, 3, 4, 5],
  spineSlotMinutes: 30,
  spineDayHours: null,
  spineStaffPorTurno: null,
  spineTimezone: 'America/Sao_Paulo',
} as unknown as Unit;

const DIA = '2026-10-22';
const OUTRO_DIA = '2026-10-23';
const T0 = new Date('2026-10-21T13:00:00Z'); // 10:00 em Araguaína
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const AGORA_LOCAL = '2026-10-21T10:00:00';

const busca: DiaConsultado = {
  todosLivres: ['08:00', '09:00', '10:00', '14:00', '15:00'],
  livres: ['08:00', '09:00', '10:00', '14:00', '15:00'],
  oferecer: ['08:00', '10:00', '15:00'],
  recusados: ['14:00'],
  sondados: ['08:00', '10:00', '14:00', '15:00'],
};

let deposito: ReturnType<typeof depositoNaMemoria>;
let relogio: Date;
let registros: Simulacao[];

function preparar(estado: Estado | null, env: NodeJS.ProcessEnv = {}, dep?: DepositoDoCache) {
  deposito = depositoNaMemoria();
  relogio = T0;
  registros = [];
  _semearParaTeste(estado ? [{ slug: SLUG, automacao: AUTOMACAO_CACHE_AGENDA, estado }] : []);
  _depsDoCacheParaTeste({
    deposito: dep ?? deposito,
    agora: () => relogio,
    env,
    registrar: (_u, _a, s) => registros.push(s),
  });
}

beforeEach(() => preparar('ligado'));
after(() => {
  _depsDoCacheParaTeste();
  _semearParaTeste([]);
});

// ── a chave na tela ───────────────────────────────────────────────────────────────────────────────

test('chave cache-agenda: nasce em "só no papel" na rede toda; a lista do .env diz quem está LIGADO', () => {
  const a = automacaoPorId(AUTOMACAO_CACHE_AGENDA);
  assert.equal(a?.chave, 'CACHE_AGENDA_SLUGS');
  assert.equal(a?.temSeco, true);
  assert.equal(a?.quandoVazio, 'seco');
  _semearParaTeste([]);
  assert.equal(estadoDoCacheDaAgenda(SLUG, {}), 'seco', 'variável vazia = no papel');
  assert.equal(estadoDoCacheDaAgenda(SLUG, { CACHE_AGENDA_SLUGS: SLUG }), 'ligado');
  assert.equal(estadoDoCacheDaAgenda(SLUG, { CACHE_AGENDA_SLUGS: 'doutor-hernia-serra' }), 'seco', 'fora da lista segue no papel');
});

test('validade: 10 min por padrão, CACHE_AGENDA_MIN muda, de 1 a 60', () => {
  assert.equal(validadeDoCacheMs({}), 10 * 60_000);
  assert.equal(validadeDoCacheMs({ CACHE_AGENDA_MIN: '5' }), 5 * 60_000);
  assert.equal(validadeDoCacheMs({ CACHE_AGENDA_MIN: 'abc' }), 10 * 60_000);
  assert.equal(validadeDoCacheMs({ CACHE_AGENDA_MIN: '0' }), 10 * 60_000);
  assert.equal(validadeDoCacheMs({ CACHE_AGENDA_MIN: '999' }), 60 * 60_000);
});

// ── hit e miss ────────────────────────────────────────────────────────────────────────────────────

test('hit dentro do prazo: a outra conversa recebe a busca guardada, com a hora em que a FRANQUIA foi consultada', async () => {
  assert.equal(await guardarNoCache(unidade, DIA, undefined, busca, true, T0), true);
  relogio = min(9);
  const l = await lerDoCache(unidade, DIA, undefined, '2026-10-21T10:09:00');
  assert.equal(l?.teria, 'hit');
  assert.equal(l?.usar, true);
  assert.deepEqual(l?.entrada?.oferecer, ['08:00', '10:00', '15:00']);
  assert.equal(l?.entrada?.consultadoEm.getTime(), T0.getTime(), 'a hora do carimbo do #104 é a da consulta, não a de agora');
  assert.equal(l?.idadeMin, 9);
});

test('miss depois do prazo (10 min); com CACHE_AGENDA_MIN=30 ainda vale', async () => {
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0);
  relogio = min(11);
  const l = await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL);
  assert.equal(l?.teria, 'miss');
  assert.equal(l?.motivo, 'vencida');
  assert.equal(l?.usar, false);

  _depsDoCacheParaTeste({ deposito, agora: () => relogio, env: { CACHE_AGENDA_MIN: '30' }, registrar: () => undefined });
  assert.equal((await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL))?.teria, 'hit');
});

test('a chave inclui o turno e a configuração da agenda (duração da sessão, profissional por turno)', async () => {
  await guardarNoCache(unidade, DIA, 'manha', busca, true, T0);
  assert.equal((await lerDoCache(unidade, DIA, 'manha', AGORA_LOCAL))?.teria, 'hit');
  assert.equal((await lerDoCache(unidade, DIA, 'tarde', AGORA_LOCAL))?.teria, 'miss');
  assert.equal((await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL))?.teria, 'miss', 'sem turno é outra busca');
  assert.equal((await lerDoCache(unidade, OUTRO_DIA, 'manha', AGORA_LOCAL))?.teria, 'miss');

  const sessao45 = { ...unidade, spineSlotMinutes: 45 } as Unit;
  assert.equal((await lerDoCache(sessao45, DIA, 'manha', AGORA_LOCAL))?.teria, 'miss', 'mudou a duração da sessão');
  const taubate = { ...unidade, spineStaffPorTurno: [{ inicio: '08:00', fim: '13:30', idStaff: 536 }] } as unknown as Unit;
  assert.equal((await lerDoCache(taubate, DIA, 'manha', AGORA_LOCAL))?.teria, 'miss', 'mudou o profissional por turno');

  assert.notEqual(assinaturaDaAgenda(unidade), assinaturaDaAgenda(sessao45));
  assert.equal(assinaturaDaAgenda(unidade), assinaturaDaAgenda({ ...unidade, spineAgendaDays: [5, 4, 3, 2, 1] } as Unit), 'a ordem dos dias não muda nada');
  assert.equal(chaveDoDia(undefined, 'abc'), 'dia:abc');
});

// ── horário vencido ───────────────────────────────────────────────────────────────────────────────

test('horário que já passou sai na LEITURA, no relógio da unidade (o das 10:00 em ponto também)', async () => {
  await guardarNoCache(unidade, '2026-10-21', undefined, busca, true, min(-5));
  const l = await lerDoCache(unidade, '2026-10-21', undefined, AGORA_LOCAL);
  assert.equal(l?.teria, 'hit');
  assert.deepEqual(l?.entrada?.oferecer, ['15:00']);
  assert.deepEqual(l?.entrada?.livres, ['14:00', '15:00']);
  assert.equal(l?.entrada?.consultadoEm.getTime(), min(-5).getTime());

  // tudo já passou: é como se não houvesse nada guardado
  const tarde = await lerDoCache(unidade, '2026-10-21', undefined, '2026-10-21T15:00');
  assert.equal(tarde?.teria, 'miss');
  assert.equal(tarde?.motivo, 'tudo_passou');
});

test('semHorarioVencido aceita "agora" com ou sem segundos', () => {
  assert.deepEqual(semHorarioVencido(DIA, busca, `${DIA}T10:00`).oferecer, ['15:00']);
  assert.deepEqual(semHorarioVencido(DIA, busca, `${DIA}T09:59:59`).oferecer, ['10:00', '15:00']);
  assert.deepEqual(semHorarioVencido(DIA, busca, '2026-10-21T23:00:00').oferecer, busca.oferecer, 'dia seguinte inteiro vale');
});

// ── só guarda sucesso ─────────────────────────────────────────────────────────────────────────────

test('nunca guarda erro nem vazio: sem sondagem, ou sondagem que recusou tudo, não entra', async () => {
  assert.equal(vaiProCache(true, busca), true);
  assert.equal(vaiProCache(false, busca), false);
  assert.equal(vaiProCache(true, { oferecer: [] }), false);
  assert.equal(await guardarNoCache(unidade, DIA, undefined, busca, false, T0), false, 'sem verificação');
  assert.equal(await guardarNoCache(unidade, DIA, undefined, { ...busca, oferecer: [], recusados: busca.sondados }, true, T0), false);
  assert.deepEqual(deposito.linhas, []);
});

test('banco fora do ar: ler vira miss e gravar/apagar não lançam — a busca segue indo à franquia', async () => {
  const quebrado: DepositoDoCache = {
    ler: async () => {
      throw new Error('ECONNREFUSED');
    },
    gravar: async () => {
      throw new Error('ECONNREFUSED');
    },
    apagar: async () => {
      throw new Error('ECONNREFUSED');
    },
    varrer: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
  preparar('ligado', {}, quebrado);
  const l = await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL);
  assert.equal(l?.teria, 'miss');
  assert.equal(l?.motivo, 'erro_ao_ler');
  assert.equal(await guardarNoCache(unidade, DIA, undefined, busca, true, T0), false);
  await apagarDoCache(unidade, DIA, 'teste');
});

test('linha ilegível no banco é miss, não exceção', () => {
  const chave = chaveDoDia(undefined, assinaturaDaAgenda(unidade));
  const v = entradaQueVale([{ dia: DIA, chave, resultado: { oferecer: 'x' }, consultadoEm: T0 }], DIA, chave, T0, 600_000);
  assert.equal(v.entrada, null);
  assert.equal((v as { motivo: string }).motivo, 'ilegivel');
});

// ── apagar ────────────────────────────────────────────────────────────────────────────────────────

test('apagar o dia (marcou, cancelou, horário ocupado): aquele dia vira miss, o outro dia segue', async () => {
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0);
  await guardarNoCache(unidade, OUTRO_DIA, undefined, busca, true, T0);
  relogio = min(2);
  await apagarDoCache(unidade, `${DIA}T10:00`, 'agendar_consulta: marcou');
  assert.equal((await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL))?.teria, 'miss');
  assert.equal((await lerDoCache(unidade, OUTRO_DIA, undefined, AGORA_LOCAL))?.teria, 'hit');
  assert.ok(deposito.linhas.some((l) => l.dia === DIA && l.chave === MARCA_APAGADO), 'deixou a marca');
});

test('sem saber o dia (cancelamento sem data), apaga a unidade toda', async () => {
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0);
  await guardarNoCache(unidade, OUTRO_DIA, 'tarde', busca, true, T0);
  relogio = min(1);
  await apagarDoCache(unidade, null, 'cancelar_consulta: cancelou');
  assert.equal((await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL))?.teria, 'miss');
  assert.equal((await lerDoCache(unidade, OUTRO_DIA, 'tarde', AGORA_LOCAL))?.teria, 'miss');
  assert.ok(deposito.linhas.some((l) => l.dia === UNIDADE_TODA && l.chave === MARCA_APAGADO));
});

test('busca que começou ANTES do apagar e gravou DEPOIS não vale (a marca); busca nova depois da marca vale', async () => {
  relogio = min(3);
  await apagarDoCache(unidade, DIA, 'agendar_consulta: marcou'); // outra conversa marcou no meio da sondagem
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0); // a busca que começou em T0 termina agora
  const l = await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL);
  assert.equal(l?.teria, 'miss');
  assert.equal(l?.motivo, 'apagada');

  await guardarNoCache(unidade, DIA, undefined, busca, true, min(4));
  relogio = min(5);
  assert.equal((await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL))?.teria, 'hit');
});

test('a marca de apagado só sobe — dois "apagar" gravados fora de ordem não a deixam mais velha', async () => {
  await deposito.apagar('u', DIA, min(5));
  await deposito.apagar('u', DIA, min(2));
  const marcas = deposito.linhas.filter((l) => l.chave === MARCA_APAGADO);
  assert.equal(marcas.length, 1);
  assert.equal(marcas[0].consultadoEm.getTime(), min(5).getTime());
});

// ── desligado ─────────────────────────────────────────────────────────────────────────────────────

test('desligada: nem lê nem grava; apagar continua valendo (entrada velha não sobra para quando religar)', async () => {
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0);
  _semearParaTeste([{ slug: SLUG, automacao: AUTOMACAO_CACHE_AGENDA, estado: 'desligado' }]);
  assert.equal(await lerDoCache(unidade, DIA, undefined, AGORA_LOCAL), null);
  assert.equal(await guardarNoCache(unidade, OUTRO_DIA, undefined, busca, true, T0), false);
  await apagarDoCache(unidade, DIA, 'agendar_consulta: marcou');
  assert.equal(deposito.linhas.filter((l) => l.chave !== MARCA_APAGADO).length, 0);
});

// ── a medida ──────────────────────────────────────────────────────────────────────────────────────

test('só no papel, hit: mostra "confere" quando a franquia ainda aceita o que o cache ofereceria', async () => {
  preparar('seco');
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0);
  relogio = min(4);
  const m = medidorDoCache(unidade, { leadId: 28743600 });
  const l = await m.ler(DIA, AGORA_LOCAL);
  assert.equal(l?.teria, 'hit');
  assert.equal(l?.usar, false, 'no papel nunca usa');
  assert.equal(await m.ler(OUTRO_DIA, AGORA_LOCAL), null, 'depois do primeiro acerto não lê mais: com a chave ligada ela teria parado ali');
  m.franquia(DIA, { livres: busca.livres, recusados: ['14:00'], oferecer: ['09:00', '10:00', '15:00'] });
  const r = m.fim(DIA);
  assert.equal(r?.teria, 'hit');
  assert.deepEqual(r?.naoValem, [], '08:00 continua livre na grade — não é divergência');
  assert.equal(registros.length, 1);
  assert.equal(registros[0].acao, 'confere');
  assert.equal(registros[0].alvo, 'horários de 22/10');
  assert.equal(registros[0].valor, '08:00, 10:00, 15:00');
  assert.match(String(registros[0].motivo), /há 4 min/);
});

test('só no papel, hit que ficou velho: "diverge" com o horário que a franquia já não aceita', async () => {
  preparar('seco');
  await guardarNoCache(unidade, DIA, 'tarde', busca, true, T0);
  relogio = min(6);
  const m = medidorDoCache(unidade, { leadId: 5, turno: 'tarde' });
  await m.ler(DIA, AGORA_LOCAL);
  m.franquia(DIA, { livres: ['14:00'], recusados: [], oferecer: ['14:00'] }); // 15:00 foi marcado direto na franquia
  const r = m.fim(DIA);
  assert.deepEqual(r?.naoValem, ['08:00', '10:00', '15:00']);
  assert.equal(registros[0].acao, 'diverge');
  assert.equal(registros[0].alvo, 'horários de 22/10 (tarde)');
  assert.match(String(registros[0].motivo), /já não está livre/);
});

test('só no papel, miss: "pularia", com o motivo do dia oferecido', async () => {
  preparar('seco');
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0);
  relogio = min(20);
  const m = medidorDoCache(unidade, { leadId: 5 });
  await m.ler(DIA, AGORA_LOCAL);
  const r = m.fim(DIA);
  assert.equal(r?.teria, 'miss');
  assert.equal(r?.motivo, 'vencida');
  assert.equal(registros[0].acao, 'pularia');
  assert.match(String(registros[0].motivo), /vencida/);
  assert.equal(m.fim(DIA), null, 'uma medida por busca');
  assert.equal(registros.length, 1);
});

test('ligado: a medida diz que usou e não escreve na tela de "só no papel"', async () => {
  await guardarNoCache(unidade, DIA, undefined, busca, true, T0);
  const m = medidorDoCache(unidade, { leadId: 5 });
  const l = await m.ler(DIA, AGORA_LOCAL);
  assert.equal(l?.usar, true);
  const r = m.fim(DIA);
  assert.equal(r?.usou, true);
  assert.equal(registros.length, 0);
});

test('oferecidosQueNaoValem: só o que saiu da grade ou foi recusado conta', () => {
  assert.deepEqual(oferecidosQueNaoValem(['08:00', '09:00', '10:00'], { livres: ['08:00', '10:00'], recusados: ['10:00'], oferecer: [] }), ['09:00', '10:00']);
  assert.deepEqual(oferecidosQueNaoValem(['08:00'], { livres: ['08:00', '09:00'], recusados: [], oferecer: ['09:00'] }), []);
});
