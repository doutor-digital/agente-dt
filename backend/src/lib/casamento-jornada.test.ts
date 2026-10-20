/**
 * As partes PURAS das regras de 16/10/2026: quem é o paciente do cartão (decisões 1 e 3), quais faltas viram tarefa
 * (decisão 4), a guarda do funil TRATAMENTO (decisão 2) e o que o cadastro faz quando o paciente já existe (achado do
 * inventário). Sem rede e sem banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cartoesComMaisDeUmPaciente, chaveDoConflito, escolherPacienteDoCartao, faltasParaAvisar, idsDoConflito, identidadeDoPaciente,
  nomesCompativeis, notaConflitoDeTelefone, TAG_CONFLITO, type ClienteCandidato,
} from './casamento-jornada.js';
import { chaveTelefone, nomeDaFranquia } from './franquia-sync.js';
import { tiraDoTratamento } from './guarda-funil-tratamento.js';
import { decidirCadastro } from '../services/paciente-existente.js';
import type { SpineSchedule } from '../services/spine.service.js';

const FONE = chaveTelefone('+5599991234567');
const c = (idClient: number, name: string, whatsapp: string | null): ClienteCandidato => ({ idClient, name, whatsapp });
const alvos = (...nomes: string[]) => new Set(nomes.map(nomeDaFranquia));

// ── decisão 3: idClient → telefone → nome ──

test('decisão 3: o ⚙ idClient do cartão vem primeiro — nem olha telefone nem nome', () => {
  const r = escolherPacienteDoCartao({ idDoCartao: 777, candidatos: [c(1, 'MARIA SILVA', '+5599991234567')], fone: FONE, alvos: alvos('MARIA SILVA') });
  assert.deepEqual(r, { tipo: 'achou', idClient: 777, por: 'idClient' });
});

test('decisão 3: o telefone vem antes do nome — o paciente do telefone ganha do homônimo exato', () => {
  const r = escolherPacienteDoCartao({
    idDoCartao: null,
    candidatos: [c(1, 'MARIA SILVA', '+5511900001111'), c(2, 'MARIA DA SILVA SANTOS', '(99) 99123-4567')],
    fone: FONE,
    alvos: alvos('MARIA SILVA'),
  });
  assert.deepEqual(r, { tipo: 'achou', idClient: 2, por: 'telefone' });
});

test('decisão 3: nome só no fim — nome exato e único, nunca contra um telefone diferente', () => {
  assert.deepEqual(
    escolherPacienteDoCartao({ idDoCartao: null, candidatos: [c(5, 'JOSE PEREIRA', null)], fone: FONE, alvos: alvos('JOSE PEREIRA') }),
    { tipo: 'achou', idClient: 5, por: 'nome' },
  );
  assert.equal(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [c(5, 'JOSE PEREIRA', '+5511988887777')], fone: FONE, alvos: alvos('JOSE PEREIRA') }).tipo, 'nenhum', 'homônimo de outro telefone');
  assert.equal(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [c(5, 'JOSE PEREIRA', null), c(6, 'JOSE PEREIRA', null)], fone: '', alvos: alvos('JOSE PEREIRA') }).tipo, 'nenhum', 'dois homônimos');
});

test('decisão 3: a franquia não traz o telefone, e outro cartão do mesmo telefone (com nome compatível) já sabe o idClient', () => {
  const irmao = c(4321, 'ANA SOUZA', '+5599991234567');
  assert.deepEqual(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [], irmaos: [irmao], fone: FONE, alvos: alvos('ANA DE SOUZA'), nome: 'Ana de Souza' }), { tipo: 'achou', idClient: 4321, por: 'telefone' });
  assert.equal(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [], irmaos: [], fone: FONE, alvos: new Set(), nome: 'Ana de Souza' }).tipo, 'nenhum');
});

test('achado 2 (revisão de 16/10): o cartão irmão só vale com nome compatível — título sem nome ou de outra pessoa não casa', () => {
  const daMae = c(4321, 'MARIA SOUZA', '+5599991234567');
  assert.equal(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [], irmaos: [daMae], fone: FONE, alvos: new Set(), nome: 'Lead 16/10/2026' }).tipo, 'nenhum', 'sem nome no título: não prova nada (vai pra CONFERIR, como antes)');
  assert.equal(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [], irmaos: [daMae], fone: FONE, alvos: alvos('ANA SOUZA'), nome: 'Ana Souza' }).tipo, 'nenhum', 'a filha não herda o paciente da mãe');
});

// ── decisão 1: dois pacientes no mesmo telefone ──

test('decisão 1: dois pacientes DIFERENTES no mesmo telefone = conflito, nunca escolha automática', () => {
  const r = escolherPacienteDoCartao({
    idDoCartao: null,
    candidatos: [c(101, 'MARIA TESTE', '+5599991234567'), c(202, 'JOSE TESTE', '99 99123-4567')],
    fone: FONE,
    alvos: alvos('MARIA TESTE'),
  });
  assert.equal(r.tipo, 'conflito', 'mesmo com o título batendo com um deles: quem decide é a SDR');
  assert.deepEqual(r.tipo === 'conflito' ? r.candidatos.map((x) => x.idClient).sort() : [], [101, 202]);
});

test('decisão 1: o mesmo nome e o mesmo telefone em dois cadastros é a mesma pessoa (desempata pela agenda, não pergunta)', () => {
  const r = escolherPacienteDoCartao({ idDoCartao: null, candidatos: [c(1, 'ANA LIMA', '+5599991234567'), c(2, 'IA-ANA LIMA', '99991234567')], fone: FONE, alvos: alvos('ANA LIMA') });
  assert.equal(r.tipo, 'desempatar');
});

test('decisão 1: o irmão do Kommo com OUTRO idClient do mesmo telefone também é conflito', () => {
  const r = escolherPacienteDoCartao({ idDoCartao: null, candidatos: [c(101, 'MARIA TESTE', '+5599991234567')], irmaos: [c(202, 'Maria Teste Souza', '+5599991234567')], fone: FONE, alvos: alvos('MARIA TESTE'), nome: 'MARIA TESTE' });
  assert.equal(r.tipo, 'conflito');
});

// ── achado 1 da revisão de 16/10: no CADASTRO, o nome tem de bater ──

test('achado 1: cadastro da Ana Souza no WhatsApp da mãe (Maria Souza, paciente) = conflito; no robô o telefone continua mandando', () => {
  const mae = c(100, 'MARIA SOUZA', '+5599991234567');
  const cadastro = escolherPacienteDoCartao({ idDoCartao: null, candidatos: [mae], fone: FONE, alvos: alvos('ANA SOUZA'), nome: 'Ana Souza', modo: 'cadastro' });
  assert.deepEqual(cadastro, { tipo: 'conflito', candidatos: [mae], outroNome: true });
  assert.deepEqual(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [mae], fone: FONE, alvos: alvos('ANA SOUZA'), nome: 'Ana Souza' }), { tipo: 'achou', idClient: 100, por: 'telefone' }, 'regra do robô (23/09): sem mudança');
  // a própria Maria, com o nome escrito de outro jeito, casa
  assert.deepEqual(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [mae], fone: FONE, alvos: alvos('MARIA DE SOUZA'), nome: 'Maria de Souza', modo: 'cadastro' }), { tipo: 'achou', idClient: 100, por: 'telefone' });
  // o cartão irmão da mãe (mesmo telefone, ⚙ da Maria) também é conflito no cadastro — e ignorado no robô
  assert.equal(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [], irmaos: [mae], fone: FONE, alvos: alvos('ANA SOUZA'), nome: 'Ana Souza', modo: 'cadastro' }).tipo, 'conflito');
  // a Ana já cadastrada no mesmo telefone da mãe: é ela
  const ana = c(101, 'ANA CAROLINA SOUZA', '+5599991234567');
  assert.deepEqual(escolherPacienteDoCartao({ idDoCartao: null, candidatos: [mae, ana], fone: FONE, alvos: alvos('ANA SOUZA'), nome: 'Ana Souza', modo: 'cadastro' }), { tipo: 'achou', idClient: 101, por: 'telefone' });
});

test('achado 1: cadastro — o ⚙ idClient (ou o vínculo) do cartão só vale se o nome do paciente bater', () => {
  assert.deepEqual(escolherPacienteDoCartao({ idDoCartao: 100, nomeDoCartao: 'MARIA SOUZA', candidatos: [], fone: FONE, alvos: new Set(), nome: 'Ana Souza', modo: 'cadastro' }).tipo, 'conflito');
  assert.deepEqual(escolherPacienteDoCartao({ idDoCartao: 100, nomeDoCartao: 'IA-MARIA SOUZA', candidatos: [], fone: FONE, alvos: new Set(), nome: 'Maria Souza', modo: 'cadastro' }), { tipo: 'achou', idClient: 100, por: 'idClient' });
});

test('nomesCompativeis: primeiro nome com folga de digitação e um sobrenome em comum; duas pessoas no título', () => {
  assert.equal(nomesCompativeis('Ana Souza', 'MARIA SOUZA'), false);
  assert.equal(nomesCompativeis('Maria Souza', 'MARIA DA SILVA SOUZA'), true);
  assert.equal(nomesCompativeis('ALEXANDRO SANT ANA', 'ALEXSANDRO SANT ANA'), true);
  assert.equal(nomesCompativeis('MARIA DA PENHA - ALEXANDRO SANT ANA', 'ALEXSANDRO SANTANA SANT ANA'), true);
  assert.equal(nomesCompativeis('Lead 16/10/2026', 'MARIA SOUZA'), false);
  assert.equal(nomesCompativeis('Maria', 'MARIA SOUZA'), true, 'sem sobrenome de um lado: o primeiro nome basta');
  assert.equal(nomesCompativeis('Maria Lima', 'MARIA SOUZA'), false);
});

test('decisão 1: cartão que recebeu pacientes diferentes na varredura (o caso 1292772); o mesmo paciente duas vezes não conta', () => {
  const m = cartoesComMaisDeUmPaciente([
    { leadId: 555, quem: identidadeDoPaciente(null, [101], 'MARIA TESTE') },
    { leadId: 555, quem: identidadeDoPaciente(202, [], 'JOSE TESTE') },
    { leadId: 777, quem: identidadeDoPaciente(303, [], 'ANA') },
    { leadId: 777, quem: identidadeDoPaciente(null, [303], 'ANA') },
    { leadId: null, quem: 'nome:x' },
  ]);
  assert.deepEqual([...m.keys()], [555]);
  assert.equal(identidadeDoPaciente(null, [], 'Maria  Teste'), 'nome:maria teste');
});

test('decisão 1: os candidatos do conflito vão e voltam da marca guardada; a nota diz o que fazer', () => {
  const k = chaveDoConflito([202, 101, 202]);
  assert.equal(k, 'conflito-franquia:101,202');
  assert.deepEqual(idsDoConflito(k), [101, 202]);
  assert.deepEqual(idsDoConflito('outra-coisa:1'), []);
  const nota = notaConflitoDeTelefone([{ idClient: 101, nome: 'MARIA' }, { idClient: 202, nome: 'JOSE' }]);
  assert.match(nota, /101/);
  assert.match(nota, /202/);
  assert.match(nota, /widget/);
  assert.ok(nota.includes(TAG_CONFLITO));
});

// ── decisão 4: falta em retorno ou sessão vira nota + tarefa ──

const AGORA = Date.parse('2026-10-16T15:00:00Z') / 1000;
let seq = 1;
const ag = (h: number, idStatus: number, categoria: string): SpineSchedule => ({
  idSchedule: seq++, idTreatment: null, idStatus, statusName: null, clientName: 'X', categoryName: categoria, physicalTherapist: null,
  dateAttendanceUtc: new Date((AGORA + h * 3600) * 1000).toISOString(), dateAttendanceLocal: null, dayLocal: '2026-10-15', timeLocal: '09:00',
  isBusy: true, requiresManualValidation: false,
});

test('decisão 4: falta em SESSÃO e em RETORNO vira aviso; em AVALIAÇÃO não (é da máquina de etapas)', () => {
  const sessao = ag(-5, 40, 'PROTOCOLO 03 MESES - LOMBAR');
  const retorno = ag(-30, 40, 'RETORNO COM EXAMES');
  const avaliacao = ag(-20, 40, 'AVALIAÇÃO');
  const r = faltasParaAvisar({ agendamentos: [sessao, retorno, avaliacao], etapa: 'AGENDADO', agoraEpoch: AGORA });
  assert.deepEqual(r.map((f) => [f.s.idSchedule, f.tipo]), [[sessao.idSchedule, 'sessão'], [retorno.idSchedule, 'retorno']]);
});

test('decisão 4: quem está em RETORNO PÓS-TRATAMENTO e falta a qualquer consulta ganha aviso', () => {
  const avaliacao = ag(-20, 40, 'AVALIAÇÃO');
  assert.equal(faltasParaAvisar({ agendamentos: [avaliacao], etapa: 'RETORNO PÓS-TRATAMENTO', agoraEpoch: AGORA }).length, 1);
});

test('decisão 4: só falta recente (7 d), registrada e já passada; atendida/futura não', () => {
  const velha = ag(-10 * 24, 40, 'SESSÃO');
  const atendida = ag(-5, 42, 'SESSÃO');
  const futura = ag(+5, 40, 'SESSÃO');
  assert.deepEqual(faltasParaAvisar({ agendamentos: [velha, atendida, futura], etapa: 'EM TRATAMENTO', agoraEpoch: AGORA }), []);
});

// ── decisão 2: a Sofia não tira o cartão do funil TRATAMENTO ──

test('decisão 2: a Sofia não leva cartão do TRATAMENTO pro COMERCIAL, não troca de funil e não fecha o tratamento', () => {
  const base = { pipelineAtual: 20, tratamentoId: 20, statusDoTratamento: [201, 202, 142, 143] };
  assert.equal(tiraDoTratamento({ ...base, destino: { tipo: 'etapa', statusId: 111 } }), true, 'AGENDADO do comercial');
  assert.equal(tiraDoTratamento({ ...base, destino: { tipo: 'etapa', statusId: 111, pipelineId: 10 } }), true);
  assert.equal(tiraDoTratamento({ ...base, destino: { tipo: 'funil', pipelineId: 10 } }), true);
  assert.equal(tiraDoTratamento({ ...base, destino: { tipo: 'fechar', ganho: true } }), true, 'ALTA');
  assert.equal(tiraDoTratamento({ ...base, destino: { tipo: 'fechar', ganho: false } }), true, 'TRATAMENTO CANCELADO');
  assert.equal(tiraDoTratamento({ ...base, destino: { tipo: 'etapa', statusId: 143 } }), true);
  assert.equal(tiraDoTratamento({ ...base, destino: { tipo: 'etapa', statusId: 202 } }), false, 'dentro do próprio funil pode');
  assert.equal(tiraDoTratamento({ ...base, pipelineAtual: 10, destino: { tipo: 'etapa', statusId: 111 } }), false, 'cartão do comercial: livre');
  assert.equal(tiraDoTratamento({ ...base, tratamentoId: null, destino: { tipo: 'etapa', statusId: 111 } }), false, 'conta sem funil TRATAMENTO');
});

// ── achado do inventário: cadastro casa com o paciente que já existe ──

test('cadastro: desligado cria como sempre; ligado casa com o existente; só no papel cria e registra', () => {
  const achou = { tipo: 'achou' as const, idClient: 6008, por: 'telefone' as const };
  assert.deepEqual(decidirCadastro('desligado', achou), { criar: true });
  const ligado = decidirCadastro('ligado', achou);
  assert.equal(ligado.criar, false);
  assert.equal(!ligado.criar && ligado.vincular, 6008);
  const seco = decidirCadastro('seco', achou);
  assert.equal(seco.criar, true);
  assert.match(seco.criar && seco.simular ? seco.simular.motivo : '', /já existe/);
  assert.deepEqual(decidirCadastro('ligado', null), { criar: true }, 'ninguém achado: cria');
});

test('cadastro: telefone de dois pacientes não cria; franquia fora do ar no ligado não arrisca a duplicata', () => {
  const conflito = decidirCadastro('ligado', { tipo: 'conflito', ids: [1, 2] });
  assert.equal(conflito.criar, false);
  assert.equal(!conflito.criar && conflito.vincular, null);
  const erro = decidirCadastro('ligado', 'erro');
  assert.equal(erro.criar, false);
  assert.equal(!erro.criar && erro.jaExistia, false);
  assert.deepEqual(decidirCadastro('seco', 'erro'), { criar: true });
});
