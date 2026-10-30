import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  desfechoDaAgenda, idDoMarcador, janelaDoCalendario, mapaPorSlug, modoDoCalendario, planejarCalendario, profissionalResumido, sufixoComCartao, sufixoDeTarefaSolta, textoDaTarefa,
  tipoPeloNome, type Acao, type ItemDaAgenda, type TarefaAberta,
} from './franquia-calendario.js';

const TZ = 'America/Sao_Paulo';
// 2026-11-03 17:00Z = 14:00 em São Paulo
const QUANDO = Date.parse('2026-11-03T17:00:00.000Z') / 1000;
// "agora" = 2 de novembro, meio-dia local
const AGORA = Date.parse('2026-11-02T15:00:00.000Z') / 1000;
const JANELA = { deEpoch: Date.parse('2026-11-01T03:00:00Z') / 1000, ateEpoch: Date.parse('2026-12-03T03:00:00Z') / 1000 };

const item = (o: Partial<ItemDaAgenda> = {}): ItemDaAgenda => ({
  idSchedule: 3784113,
  clientName: 'INGRIDE SOUZA LIMA',
  categoryName: 'AVALIAÇÃO',
  physicalTherapist: 'DR. LEONARDO PEREIRA DOS SANTOS',
  statusName: 'AGENDADO',
  dateAttendanceUtc: '2026-11-03T17:00:00.000Z',
  ...o,
});

// o texto como o Kommo o guarda: 🩺 (4 bytes) vira ⚕ (downgradeEmoji)
const GUARDADO = '⚕ AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113]';
const tarefa = (o: Partial<TarefaAberta> = {}): TarefaAberta => ({ id: 900, text: GUARDADO, completeTill: QUANDO, entityId: 555, ...o });

const plano = (agendamentos: ItemDaAgenda[], tarefas: TarefaAberta[] = [], extra: Partial<Parameters<typeof planejarCalendario>[0]> = {}) =>
  planejarCalendario({ agendamentos, tarefas, agoraEpoch: AGORA, tz: TZ, janela: JANELA, ...extra });

const tipos = (acoes: Acao[]) => acoes.map((a) => a.tipo);

// ── texto ───────────────────────────────────────────────────────────────────────
test('texto: categoria, hora LOCAL, profissional resumido, status e marcador', () => {
  assert.equal(textoDaTarefa(item(), TZ), '🩺 AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113]');
  assert.equal(idDoMarcador(textoDaTarefa(item(), TZ)), 3784113);
});

test('profissional: com título (Dr./Dra.) leva o primeiro nome; sem título, só o primeiro nome; vazio some', () => {
  assert.equal(profissionalResumido('DR. LEONARDO PEREIRA'), 'Dr. Leonardo');
  assert.equal(profissionalResumido('DRA. ANA PAULA MOURA'), 'Dra. Ana');
  assert.equal(profissionalResumido('MARCOS ANTONIO'), 'Marcos');
  assert.equal(profissionalResumido(null), '');
  assert.equal(textoDaTarefa(item({ physicalTherapist: null }), TZ), '🩺 AVALIAÇÃO 14:00 · AGENDADO [ag:3784113]');
});

// ── criar / não duplicar ──────────────────────────────────────────────────────────
test('criar: agendamento futuro sem tarefa vira uma tarefa no horário da consulta', () => {
  const p = plano([item()]);
  assert.equal(p.acoes.length, 1);
  const a = p.acoes[0];
  assert.equal(a.tipo, 'criar');
  if (a.tipo === 'criar') {
    assert.equal(a.idSchedule, 3784113);
    assert.equal(a.completeTill, QUANDO);
    assert.match(a.texto, /\[ag:3784113\]$/);
  }
});

test('criar: TODAS as categorias entram (avaliação, sessão, tratamento)', () => {
  const p = plano([
    item({ idSchedule: 1, categoryName: 'AVALIAÇÃO' }),
    item({ idSchedule: 2, categoryName: 'SESSÃO' }),
    item({ idSchedule: 3, categoryName: 'TRATAMENTO' }),
  ]);
  assert.deepEqual(tipos(p.acoes), ['criar', 'criar', 'criar']);
});

test('não duplica: tarefa aberta com o marcador igual = nada a fazer (o texto vem do Kommo sem o emoji)', () => {
  assert.deepEqual(plano([item()], [tarefa()]).acoes, []);
});

test('não duplica: o mesmo agendamento repetido pela paginação da franquia cria uma tarefa só', () => {
  assert.equal(plano([item(), item()]).acoes.length, 1);
});

test('não cria tarefa para o passado (e conta)', () => {
  const p = plano([item({ dateAttendanceUtc: '2026-11-02T12:00:00.000Z' })]); // 09:00 local de hoje, já passou
  assert.deepEqual(p.acoes, []);
  assert.equal(p.passados, 1);
});

test('agendamento sem id, sem data ou sem paciente é ignorado (bloqueio de agenda não vira tarefa)', () => {
  const p = plano([item({ idSchedule: null }), item({ idSchedule: 2, dateAttendanceUtc: null }), item({ idSchedule: 3, clientName: null })]);
  assert.deepEqual(p.acoes, []);
  assert.equal(p.ignorados, 3);
});

// ── atualizar ───────────────────────────────────────────────────────────────────────
test('atualizar: mudou o horário → muda só o horário (texto novo junto, porque a hora está nele)', () => {
  const novo = item({ dateAttendanceUtc: '2026-11-03T18:30:00.000Z' }); // 15:30 local
  const p = plano([novo], [tarefa()]);
  assert.equal(p.acoes.length, 1);
  const a = p.acoes[0];
  assert.equal(a.tipo, 'atualizar');
  if (a.tipo === 'atualizar') {
    assert.equal(a.taskId, 900);
    assert.equal(a.completeTill, Date.parse('2026-11-03T18:30:00.000Z') / 1000);
    assert.match(a.texto ?? '', /15:30/);
  }
});

test('atualizar: AGENDADO → CONFIRMADO muda o texto e NÃO o horário', () => {
  const p = plano([item({ statusName: 'CONFIRMADO' })], [tarefa()]);
  const a = p.acoes[0];
  assert.equal(a.tipo, 'atualizar');
  if (a.tipo === 'atualizar') {
    assert.equal(a.completeTill, null);
    assert.match(a.texto ?? '', /CONFIRMADO/);
  }
});

test('atualizar preserva o que vem depois do marcador (contato da tarefa solta, nota da recepção)', () => {
  const solta = tarefa({ text: `${GUARDADO} Paciente: INGRIDE · Tel: 47999990000`, entityId: null });
  const p = plano([item({ statusName: 'CONFIRMADO' })], [solta]);
  const a = p.acoes[0];
  assert.equal(a.tipo, 'atualizar');
  if (a.tipo === 'atualizar') assert.match(a.texto ?? '', /CONFIRMADO \[ag:3784113\] Paciente: INGRIDE · Tel: 47999990000$/);
  // e sem mudança na franquia, a tarefa solta não é regravada
  assert.deepEqual(plano([item()], [solta]).acoes, []);
});

// ── fechar, por status ───────────────────────────────────────────────────────────────
test('fechar: ATENDIDO → "Atendido"; FALTOU (e NÃO COMPARECEU) → "Faltou"; DESMARCADO → "Desmarcado"', () => {
  const casos: Array<[string, string]> = [['ATENDIDO', 'Atendido'], ['FALTOU', 'Faltou'], ['NÃO COMPARECEU', 'Faltou'], ['DESMARCADO', 'Desmarcado']];
  for (const [status, resultado] of casos) {
    const p = plano([item({ statusName: status })], [tarefa()]);
    assert.deepEqual(p.acoes, [{ tipo: 'fechar', idSchedule: 3784113, taskId: 900, resultado }], status);
  }
});

test('REMARCADO: por padrão MANTÉM (a franquia muda a data no mesmo registro); com "fechar", fecha como "Remarcado"', () => {
  const remarcado = item({ statusName: 'REMARCADO', dateAttendanceUtc: '2026-11-05T17:00:00.000Z' });
  const manter = plano([remarcado], [tarefa()]);
  assert.equal(manter.acoes[0].tipo, 'atualizar', 'a tarefa acompanha a nova data');
  const fechar = plano([remarcado], [tarefa()], { remarcado: 'fechar' });
  assert.deepEqual(fechar.acoes, [{ tipo: 'fechar', idSchedule: 3784113, taskId: 900, resultado: 'Remarcado' }]);
  assert.equal(desfechoDaAgenda('REMARCADO'), 'ativo');
  assert.equal(desfechoDaAgenda('REMARCADO', 'fechar'), 'remarcado');
});

test('status terminal sem tarefa aberta: nada (nunca ressuscita uma tarefa que já foi fechada)', () => {
  for (const status of ['ATENDIDO', 'FALTOU', 'DESMARCADO']) assert.deepEqual(plano([item({ statusName: status })]).acoes, [], status);
});

test('status que a franquia inventar amanhã é tratado como ativo, não fecha tarefa', () => {
  assert.equal(desfechoDaAgenda('EM ATENDIMENTO'), 'ativo');
});

test('duplicadas (reinício no meio do POST): a mais antiga fica, as outras fecham como "Duplicada"', () => {
  const p = plano([item()], [tarefa({ id: 905 }), tarefa({ id: 900 }), tarefa({ id: 903 })]);
  assert.deepEqual(p.acoes, [
    { tipo: 'fechar', idSchedule: 3784113, taskId: 903, resultado: 'Duplicada' },
    { tipo: 'fechar', idSchedule: 3784113, taskId: 905, resultado: 'Duplicada' },
  ]);
});

// ── sumiu ─────────────────────────────────────────────────────────────────────────────
test('sumiu da busca DENTRO da janela: só é apontado (a execução loga, não apaga)', () => {
  const p = plano([], [tarefa()]);
  assert.deepEqual(p.acoes, [{ tipo: 'sumiu', idSchedule: 3784113, taskId: 900 }]);
});

test('sumiu: tarefa fora da janela (ou de outro robô, sem marcador) não é problema de ninguém', () => {
  const p = plano([], [
    tarefa({ completeTill: JANELA.ateEpoch + 86_400 }),
    tarefa({ id: 901, text: 'LIGAR AGORA para o paciente', completeTill: QUANDO }),
  ]);
  assert.deepEqual(p.acoes, []);
});

// ── tarefa solta ──────────────────────────────────────────────────────────────────────
test('tarefa solta: o texto leva nome e telefone depois do marcador (que continua achável)', () => {
  const t = textoDaTarefa(item(), TZ, sufixoDeTarefaSolta('INGRIDE SOUZA LIMA', '+5547999990000'));
  assert.equal(t, '🩺 AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113] Paciente: INGRIDE SOUZA LIMA · Tel: +5547999990000');
  assert.equal(idDoMarcador(t), 3784113);
  assert.match(textoDaTarefa(item(), TZ, sufixoDeTarefaSolta('INGRIDE', null)), /sem cartão no Kommo$/);
});

// ── modo seco e configuração ────────────────────────────────────────────────────────────
test('modo: vazio = desligado; em SLUGS sem APLICAR = seco (o padrão); só em APLICAR = aplica', () => {
  assert.equal(modoDoCalendario('doutor-hernia-timbo', {}), 'desligado');
  assert.equal(modoDoCalendario('doutor-hernia-timbo', { slugs: 'doutor-hernia-timbo' }), 'seco');
  assert.equal(modoDoCalendario('doutor-hernia-timbo', { slugs: 'doutor-hernia-timbo', aplicar: '' }), 'seco');
  assert.equal(modoDoCalendario('doutor-hernia-timbo', { slugs: 'doutor-hernia-timbo', aplicar: 'doutor-hernia-timbo' }), 'aplicar');
  assert.equal(modoDoCalendario('doutor-hernia-serra', { slugs: 'doutor-hernia-timbo', aplicar: 'doutor-hernia-timbo' }), 'desligado');
  // APLICAR sozinho não liga nada: quem manda é SLUGS
  assert.equal(modoDoCalendario('doutor-hernia-timbo', { aplicar: 'doutor-hernia-timbo' }), 'desligado');
  assert.equal(modoDoCalendario('x', { slugs: '"*"' }), 'seco');
});

test('slug:valor — formato do responsável e do tipo; lixo é ignorado', () => {
  const m = mapaPorSlug('doutor-hernia-timbo:15905863, outra:abc, :7, sem-valor, serra:42');
  assert.deepEqual([...m], [['doutor-hernia-timbo', 15905863], ['serra', 42]]);
  assert.equal(mapaPorSlug(undefined).size, 0);
});

test('tipo "Consulta" é achado pelo nome (sem caixa, sem acento); sem ele, null', () => {
  assert.equal(tipoPeloNome([{ id: 1, name: 'Follow-up' }, { id: 4302851, name: 'consulta' }]), 4302851);
  assert.equal(tipoPeloNome([{ id: 1, name: 'Follow-up' }, { id: 2, name: 'Reunião' }]), null);
});

test('desfecho pelo ID do status (o nome pode variar entre franquias); o nome fica de reforço', () => {
  assert.equal(desfechoDaAgenda('Compareceu', 'manter', 42), 'atendido');
  assert.equal(desfechoDaAgenda('Ausente', 'manter', 40), 'faltou');
  assert.equal(desfechoDaAgenda('Cancelado pelo paciente', 'manter', 57), 'desmarcado');
  assert.equal(desfechoDaAgenda('AGENDADO', 'manter', 37), 'ativo');
});

test('tarefa de consulta ativa que alguém JÁ CONCLUÍDA no Kommo: não recria (e conta)', () => {
  const p = plano([item()], [], { concluidas: [{ text: GUARDADO }] });
  assert.deepEqual(p.acoes, []);
  assert.equal(p.jaConcluidas, 1);
  // sem a concluída, cria
  assert.equal(plano([item()]).acoes[0].tipo, 'criar');
});

test('reativada: concluída por NÓS (Desmarcado/Atendido/Faltou/Remarcado) não impede nova tarefa; a concluída pela recepção sim', () => {
  for (const resultado of ['Desmarcado', 'Atendido', 'Faltou', 'Remarcado']) {
    assert.equal(plano([item()], [], { concluidas: [{ text: GUARDADO, resultado }] }).acoes[0]?.tipo, 'criar', resultado);
  }
  assert.deepEqual(plano([item()], [], { concluidas: [{ text: GUARDADO, resultado: 'Ligado, confirmou' }] }).acoes, []);
  assert.deepEqual(plano([item()], [], { concluidas: [{ text: GUARDADO, resultado: null }] }).acoes, []);
});

test('baixa atrasada: consulta de 5 dias atrás que a recepção deu ATENDIDO/FALTOU/DESMARCADO fecha a tarefa que ficou aberta', () => {
  const cincoDiasAtras = Date.parse('2026-10-28T17:00:00Z') / 1000;
  for (const [status, resultado] of [['ATENDIDO', 'Atendido'], ['FALTOU', 'Faltou'], ['DESMARCADO', 'Desmarcado']] as const) {
    const p = plano([item({ statusName: status, dateAttendanceUtc: '2026-10-28T17:00:00.000Z' })], [tarefa({ completeTill: cincoDiasAtras })]);
    assert.deepEqual(p.acoes, [{ tipo: 'fechar', idSchedule: 3784113, taskId: 900, resultado }], status);
  }
});

test('janela de leitura: hoje-14 até hoje+30', () => {
  assert.deepEqual(janelaDoCalendario(TZ, new Date('2026-11-02T15:00:00Z')), { de: '2026-10-19', ate: '2026-12-02' });
});

test('texto de tarefa com cartão leva o nome do paciente depois do marcador', () => {
  assert.equal(textoDaTarefa(item(), TZ, sufixoComCartao('INGRIDE SOUZA LIMA')), '🩺 AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113] Paciente: INGRIDE SOUZA LIMA');
});
