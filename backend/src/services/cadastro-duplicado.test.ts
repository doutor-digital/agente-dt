import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avisoDeCartaoDuplicado,
  chaveTelefone,
  escolherIrmao,
  type CartaoIrmao,
} from './cadastro-duplicado.js';

const TZ = 'America/Sao_Paulo';
const irmao = (p: Partial<CartaoIrmao> & { leadId: number }): CartaoIrmao => ({
  contatoId: 1,
  nome: 'Wilson Delfino Dos Santos',
  ehPaciente: true,
  dataConsulta: null,
  etapa: 'EM NEGOCIAÇÃO',
  ...p,
});

test('a chave sobrevive às duas formas do mesmo número', () => {
  // foi exatamente essa diferença que criou o cartão novo do Wilson
  const comNove = chaveTelefone('64992135721');
  const semNove = chaveTelefone('+556492135721');
  assert.equal(comNove, semNove);
  assert.equal(comNove, '92135721');
});

test('a chave ignora formatação e DDI', () => {
  assert.equal(chaveTelefone('(64) 99213-5721'), '92135721');
  assert.equal(chaveTelefone('+55 64 99213 5721'), '92135721');
});

test('número curto não vira chave parcial perigosa', () => {
  assert.equal(chaveTelefone('1234'), '1234');
  assert.equal(chaveTelefone(null), '');
  assert.equal(chaveTelefone(undefined), '');
});

test('o próprio cartão da conversa nunca conta como irmão', () => {
  assert.equal(escolherIrmao([irmao({ leadId: 4120340 })], 4120340), null);
});

test('irmão que não é paciente não gera aviso', () => {
  // dois cartões de um lead que nunca agendou é ruído de CRM, não risco pro paciente
  const d = escolherIrmao([irmao({ leadId: 111, ehPaciente: false })], 999);
  assert.equal(d, null);
});

test('o caso Wilson: acha o cartão antigo com a consulta', () => {
  const d = escolherIrmao(
    [irmao({ leadId: 2618554, dataConsulta: 1789493400 }), irmao({ leadId: 4120340 })],
    4120340,
  );
  assert.ok(d);
  assert.equal(d.irmao.leadId, 2618554);
  assert.equal(d.outros, 1);
});

test('entre vários pacientes, vence a consulta mais recente', () => {
  const d = escolherIrmao(
    [
      irmao({ leadId: 1, dataConsulta: 1000 }),
      irmao({ leadId: 2, dataConsulta: 9000 }),
      irmao({ leadId: 3, dataConsulta: 5000 }),
    ],
    99,
  );
  assert.equal(d?.irmao.leadId, 2);
});

test('o aviso PROÍBE abrir agendamento novo — não basta informar', () => {
  const d = escolherIrmao([irmao({ leadId: 2618554, dataConsulta: 1789493400 })], 4120340)!;
  const t = avisoDeCartaoDuplicado(d, TZ);
  assert.match(t, /NÃO trate como primeiro contato/);
  assert.match(t, /REMARCAR/);
  assert.match(t, /Wilson Delfino/);
});

test('o aviso explica que o horário ocupado pode ser o da própria pessoa', () => {
  const d = escolherIrmao([irmao({ leadId: 1, dataConsulta: 1789493400 })], 2)!;
  assert.match(avisoDeCartaoDuplicado(d, TZ), /porque é dela/);
});

test('divergência vira handoff, não negociação de horário', () => {
  const d = escolherIrmao([irmao({ leadId: 1 })], 2)!;
  assert.match(avisoDeCartaoDuplicado(d, TZ), /passe para a equipe/);
});

test('a data sai em hora LOCAL, não em UTC', () => {
  // 1789493400 = 15/09/2026 17:30 UTC = 14:30 em São Paulo — o horário real do Wilson
  const d = escolherIrmao([irmao({ leadId: 1, dataConsulta: 1789493400 })], 2)!;
  const t = avisoDeCartaoDuplicado(d, TZ);
  assert.match(t, /14:30/);
  assert.doesNotMatch(t, /17:30/);
});

test('sem data de consulta o aviso não inventa horário', () => {
  const d = escolherIrmao([irmao({ leadId: 1, dataConsulta: null })], 2)!;
  const t = avisoDeCartaoDuplicado(d, TZ);
  assert.doesNotMatch(t, /Consulta registrada/);
  assert.match(t, /JÁ TEM outro cadastro/);
});

test('mais de um irmão: o texto diz quantos', () => {
  const d = escolherIrmao([irmao({ leadId: 1 }), irmao({ leadId: 2 }), irmao({ leadId: 3 })], 9)!;
  assert.match(avisoDeCartaoDuplicado(d, TZ), /\(3 no total\)/);
});
