/**
 * O nome com que a régua cumprimenta: 1º o do CADASTRO da franquia (atributo `nome_paciente`, gravado pela agenda quando um nome casa com a conversa pelo
 * telefone); 2º o do contato (perfil do WhatsApp); 3º nenhum («Olá, tudo bem.»). Nunca o de outra pessoa conhecida: o caso «Olá, Aline», em que Aline
 * era a secretária e o paciente era outro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as regua from './chatwoot-regua.js';
import { renderizar, variaveisDoModeloCampoACampo, type ConversaRegua, type DadosDaUnidade } from './chatwoot-regua.js';
import * as agenda from './chatwoot-agenda.js';
import type { SpineSchedule } from '../services/spine.service.js';

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const Z = (s: string) => new Date(s);
const CONSULTA = { etapa: 'Agendado', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-18', hora_consulta: '14:30' };

function conv(o: { nome?: string; atendente?: string | null; attrs?: Record<string, unknown> } = {}): ConversaRegua {
  return { id: 10, nome: o.nome ?? '', etiquetas: [], attrs: { ...CONSULTA, ...(o.attrs ?? {}) }, criadaEm: Z('2026-10-01T12:00:00Z'), atendente: o.atendente === undefined ? 'Ana' : o.atendente, ultima: null };
}
const saudacao = (c: ConversaRegua) => renderizar('parau_consulta_lembrete_vespera', c, U).texto!.split('\n')[0]!;

test('o nome do CADASTRO vale mais que o do perfil: «Olá, Aline» (a secretária) vira o nome do paciente', () => {
  assert.equal(saudacao(conv({ nome: 'Aline', attrs: { nome_paciente: 'Joaquim Pereira dos Santos' } })), 'Olá, Joaquim. A sua consulta é amanhã.');
  assert.equal(saudacao(conv({ nome: 'Aline', attrs: { nome_paciente: 'MARIA DA SILVA' } })), 'Olá, Maria. A sua consulta é amanhã.');
  assert.deepEqual(renderizar('parau_consulta_lembrete_vespera', conv({ nome: 'Aline', attrs: { nome_paciente: 'Joaquim Pereira' } }), U).variaveis?.[0], 'Joaquim');
});

test('sem nome no cadastro: vale o do perfil; atributo vazio ou só com número não conta', () => {
  assert.equal(saudacao(conv({ nome: 'maria da silva' })), 'Olá, Maria. A sua consulta é amanhã.');
  assert.equal(saudacao(conv({ nome: 'maria da silva', attrs: { nome_paciente: '' } })), 'Olá, Maria. A sua consulta é amanhã.');
  assert.equal(saudacao(conv({ nome: 'maria da silva', attrs: { nome_paciente: '5594999990000' } })), 'Olá, Maria. A sua consulta é amanhã.');
});

test('o nome do perfil que é o de QUEM ATENDE (a secretária no número do paciente) não é usado como nome do paciente', () => {
  assert.equal(saudacao(conv({ nome: 'Aline Souza', atendente: 'Aline' })), 'Olá, tudo bem. A sua consulta é amanhã.');
  assert.equal(saudacao(conv({ nome: 'ALINE', atendente: 'Áline Costa' })), 'Olá, tudo bem. A sua consulta é amanhã.', 'sem acento e sem diferença de maiúscula');
  // outro nome, ou ninguém atribuído: o perfil vale
  assert.equal(saudacao(conv({ nome: 'Aline', atendente: 'Ana' })), 'Olá, Aline. A sua consulta é amanhã.');
  assert.equal(saudacao(conv({ nome: 'Aline', atendente: null })), 'Olá, Aline. A sua consulta é amanhã.');
  // com o nome do cadastro, a coincidência com a atendente não tira nada (é o paciente que se chama Ana, e o cadastro o prova)
  assert.equal(saudacao(conv({ nome: 'Ana', atendente: 'Ana', attrs: { nome_paciente: 'Ana Lima' } })), 'Olá, Ana. A sua consulta é amanhã.');
});

test('sem nome nenhum (perfil só telefone ou vazio): a saudação ocupa o lugar, o texto e o parâmetro do template saem iguais, e nada «falta»', () => {
  for (const nome of ['', '+55 94 99999-0000', '5594999990000']) {
    const r = renderizar('parau_consulta_lembrete_vespera', conv({ nome }), U);
    assert.equal(r.faltando.length, 0, nome);
    assert.equal(r.texto!.split('\n')[0], 'Olá, tudo bem. A sua consulta é amanhã.', nome);
    assert.equal(r.variaveis![0], 'tudo bem', nome);
  }
  assert.equal(regua.SAUDACAO_SEM_NOME, 'tudo bem');
});

test('o preenchimento à mão da atendente NÃO ganha a saudação no lugar do nome: sem nome o campo fica vazio para ela escrever', () => {
  const campos = variaveisDoModeloCampoACampo('parau_consulta_lembrete_vespera', conv({ nome: '+5594999990000' }), U, undefined, Z('2026-11-16T12:00:00Z'));
  assert.deepEqual(campos[0], { campo: 'contact.name', valor: null });
  // mas com o nome do cadastro ela já recebe preenchido
  const com = variaveisDoModeloCampoACampo('parau_consulta_lembrete_vespera', conv({ nome: 'Aline', attrs: { nome_paciente: 'Joaquim Pereira' } }), U, undefined, Z('2026-11-16T12:00:00Z'));
  assert.deepEqual(com[0], { campo: 'contact.name', valor: 'Joaquim' });
});

// ── a agenda grava o nome do cadastro (e só quando é seguro) ──────────────────────────────────────

const ag = (o: Partial<SpineSchedule>): SpineSchedule => ({
  idSchedule: 1, idTreatment: null, idStatus: 1, statusName: 'Agendado', clientName: 'Maria da Silva', categoryName: 'Avaliação', physicalTherapist: null,
  dateAttendanceUtc: null, dateAttendanceLocal: null, dayLocal: '2026-11-16', timeLocal: '14:30:00', isBusy: false, requiresManualValidation: false, ...o,
});
const agendaDe = agenda as unknown as {
  casarTodas: (a: SpineSchedule[], c: agenda.ConversaDaCaixa[], w: (n: string) => string[] | null, hoje: string) => Array<{ conversa: agenda.ConversaDaCaixa; muda: Record<string, string>; nome: string }>;
  nomesParaGravar: (c: Array<{ conversa: agenda.ConversaDaCaixa; muda: Record<string, string>; nome: string }>) => Map<number, { conversa: agenda.ConversaDaCaixa; nome: string }>;
};
const nomesDe = (agendaDia: SpineSchedule[], conversas: agenda.ConversaDaCaixa[], fones: Record<string, string[] | null>) =>
  agendaDe.nomesParaGravar(agendaDe.casarTodas(agendaDia, conversas, (n) => fones[n] ?? null, '2026-11-12'));

test('agenda: um nome casa com a conversa pelo telefone → grava o nome do cadastro (uma vez: igual ao que já está, não regrava)', () => {
  const conversas: agenda.ConversaDaCaixa[] = [{ id: 14, telefone: '+559499745062', attrs: {}, atividade: 10 }];
  const fones = { 'maria da silva': ['5594999745062'] };
  const r = nomesDe([ag({})], conversas, fones);
  assert.deepEqual([...r.entries()].map(([id, v]) => [id, v.nome]), [[14, 'Maria da Silva']]);
  // já gravado: nada a fazer
  const gravada: agenda.ConversaDaCaixa[] = [{ id: 14, telefone: '+559499745062', attrs: { nome_paciente: 'Maria da Silva' }, atividade: 10 }];
  assert.equal(nomesDe([ag({})], gravada, fones).size, 0);
  // o cadastro mudou o nome (correção de grafia): grava a nova
  assert.equal(nomesDe([ag({ clientName: 'Maria da Silva Souza' })], gravada, { 'maria da silva souza': ['5594999745062'] }).get(14)?.nome, 'Maria da Silva Souza');
});

test('agenda: DOIS nomes no mesmo telefone (mãe e filha) → não grava nenhum; nome ambíguo ou sem cadastro também não', () => {
  const conversas: agenda.ConversaDaCaixa[] = [{ id: 14, telefone: '+559499745062', attrs: {}, atividade: 10 }];
  const fones = { 'maria da silva': ['5594999745062'], 'ana da silva': ['5594999745062'], 'duas pessoas': ['5594911112222', '5594933334444'], 'sem cadastro': [] };
  const r = nomesDe([ag({ clientName: 'Maria da Silva' }), ag({ clientName: 'Ana da Silva', idSchedule: 2 }), ag({ clientName: 'Duas Pessoas', idSchedule: 3 }), ag({ clientName: 'Sem Cadastro', idSchedule: 4 })], conversas, fones);
  assert.equal(r.size, 0);
});

test('agenda: `casar` segue devolvendo só quem tem o que gravar (o nome do cadastro não entra no plano da agenda)', () => {
  const conversas: agenda.ConversaDaCaixa[] = [{ id: 20, telefone: '+5594988887777', attrs: { data_consulta: '2026-11-16', hora_consulta: '14:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', etapa: 'Agendado' }, atividade: 5 }];
  const r = agenda.casar([ag({ clientName: 'Ana Souza' })], conversas, () => ['5594988887777'], '2026-11-12');
  assert.equal(r.length, 0);
  assert.equal(nomesDe([ag({ clientName: 'Ana Souza' })], conversas, { 'ana souza': ['5594988887777'] }).get(20)?.nome, 'Ana Souza');
});
