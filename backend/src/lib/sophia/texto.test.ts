import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advogado, etapaAnaliseAgendada, grupoInterno, linkDoMeet } from './config.js';
import { avisoDoAgendamento, avisoDoThiago, descricaoDoEvento, diaPorExtenso, limpar, modalidadeDoAtendimento, tituloDoEvento } from './texto.js';

// Só dados inventados: nomes, cidades e números abaixo não são de ninguém.

test('presencial só em Araguaína/TO; qualquer outra cidade (ou estado diferente) é online', () => {
  assert.equal(modalidadeDoAtendimento('Araguaína'), 'presencial');
  assert.equal(modalidadeDoAtendimento('  ARAGUAINA ', 'TO'), 'presencial');
  assert.equal(modalidadeDoAtendimento('araguaína', 'Tocantins'), 'presencial');
  assert.equal(modalidadeDoAtendimento('Araguaína', 'PA'), 'online');
  assert.equal(modalidadeDoAtendimento('Palmas', 'TO'), 'online');
  assert.equal(modalidadeDoAtendimento('Araguaçu'), 'online');
  assert.equal(modalidadeDoAtendimento(''), 'online');
});

test('título no padrão da equipe', () => {
  assert.equal(tituloDoEvento('Maria de Teste Silva', advogado('x', 'amanda')), 'Atendimento - Maria de Teste Silva (Dra Amanda)');
  assert.equal(tituloDoEvento('João de Teste', advogado('x', 'victor')), 'Atendimento - João de Teste (Dr Victor)');
});

test('descrição: modalidade, cidade, caso, laudo, INSS e contato; online sem link diz que a equipe envia', () => {
  const base = { nomeDoCliente: 'Fulano de Teste', telefone: '+5500000000000', cidade: 'Palmas', caso: 'auxílio cortado', temLaudoEExames: false, situacaoNoInss: 'benefício cessado', modalidade: 'online' as const, linkDoMeet: null };
  const d = descricaoDoEvento(base);
  assert.match(d, /Modalidade: Online pelo Google Meet \(a equipe envia o link/);
  assert.match(d, /Cidade: Palmas/);
  assert.match(d, /Laudo e exames: não tem/);
  assert.match(d, /Contato: \+5500000000000/);
  assert.match(descricaoDoEvento({ ...base, linkDoMeet: 'https://meet.example/abc' }), /Google Meet: https:\/\/meet\.example\/abc/);
  assert.match(descricaoDoEvento({ ...base, modalidade: 'presencial', temLaudoEExames: true }), /Presencial \(no escritório\)[\s\S]*Laudo e exames: tem/);
  assert.match(descricaoDoEvento({ ...base, telefone: null }), /Contato: está no cartão do Kommo/);
});

test('dia por extenso é calculado no código', () => {
  assert.equal(diaPorExtenso('2026-11-18'), 'quarta-feira, 18 de novembro');
  assert.equal(diaPorExtenso('2026-12-01'), 'terça-feira, 1 de dezembro');
});

test('aviso do grupo: formato exato, só o primeiro nome, SEM telefone, advogado marcado pelo número', () => {
  const t = avisoDoAgendamento({
    primeiroNome: 'Maria',
    cidade: 'Araguaína',
    caso: 'auxílio-doença cortado',
    temLaudoEExames: true,
    situacaoNoInss: 'pedido negado',
    data: '2026-11-18',
    hora: '09:00',
    modalidade: 'presencial',
    advogado: { numero: '5500000000001', nome: 'Dra. Amanda' },
  });
  assert.equal(
    t,
    [
      '✅ Sophia agendou um atendimento',
      '👤 Cliente: Maria',
      '📍 Cidade: Araguaína',
      '🩺 Caso: auxílio-doença cortado',
      '📄 Laudo e exames: tem',
      '🏛️ Situação no INSS: pedido negado',
      '📅 quarta-feira, 18 de novembro às 09:00 · presencial',
      '👩‍⚖️ @5500000000001',
      'Já está na agenda da Tramitação e no Kommo.',
    ].join('\n'),
  );
  assert.doesNotMatch(t, /\+55|telefone/i);
});

test('aviso sem número configurado marca só pelo nome (não quebra)', () => {
  const t = avisoDoAgendamento({ primeiroNome: 'Ana', cidade: 'Palmas', caso: 'x', temLaudoEExames: false, situacaoNoInss: 'y', data: '2026-11-18', hora: '10:00', modalidade: 'online', advogado: { numero: null, nome: 'Dr. Victor' } });
  assert.match(t, /👩‍⚖️ @Dr\. Victor/);
  assert.match(t, /· online/);
});

test('aviso do Dr. Thiago: resumo, motivo, link do cartão, pergunta se ele pode ligar, nada agendado', () => {
  const t = avisoDoThiago({ primeiroNome: 'Carlos', cidade: null, resumo: 'dívida de ICMS', motivo: 'tributario', linkDoCartao: 'https://exemplo.kommo.com/leads/detail/1', advogado: { numero: '5500000000002', nome: 'Dr. Thiago' } });
  assert.match(t, /Dr\. Thiago \(não agendei nada\)/);
  assert.match(t, /Motivo: caso tributário/);
  assert.match(t, /@5500000000002 você consegue ligar/);
  assert.doesNotMatch(t, /📍/);
  assert.match(avisoDoThiago({ primeiroNome: 'C', cidade: 'Palmas', resumo: 'x', motivo: 'pediu_thiago', linkDoCartao: null, advogado: { numero: null, nome: 'Dr. Thiago' } }), /o cliente pediu o Dr\. Thiago/);
});

test('limpar: tira quebra de linha e corta o tamanho', () => {
  assert.equal(limpar('a\nb\r\n  c', 50), 'a b c');
  assert.equal(limpar('x'.repeat(30), 10).length, 10);
});

test('config por unidade: JSON por slug, lixo ignorado, grupo só @g.us, link só https', () => {
  assert.equal(grupoInterno('esc', '{"esc":"120363000000000000@g.us"}'), '120363000000000000@g.us');
  assert.equal(grupoInterno('esc', '{"esc":"5500000000000@s.whatsapp.net"}'), null, 'número de pessoa não é grupo');
  assert.equal(grupoInterno('outro', '{"esc":"1@g.us"}'), null);
  assert.equal(grupoInterno('esc', 'isso não é json'), null);
  assert.equal(linkDoMeet('esc', '{"esc":"https://meet.example/x"}'), 'https://meet.example/x');
  assert.equal(linkDoMeet('esc', '{"esc":"http://inseguro"}'), null);
  assert.equal(linkDoMeet('esc', '{"esc":""}'), null);
  assert.deepEqual(etapaAnaliseAgendada('esc', '{"esc":{"pipelineId":10,"statusId":20}}'), { pipelineId: 10, statusId: 20 });
  assert.equal(etapaAnaliseAgendada('esc', '{"esc":{"pipelineId":10}}'), null);
  const raw = "'" + JSON.stringify({ esc: { amanda: { numero: '+55 (00) 00000-0001', tramitacao: 'Amanda Teste' }, victor: '5500000000003', thiago: { numero: '123' } } }) + "'";
  assert.equal(advogado('esc', 'amanda', raw).numero, '5500000000001');
  assert.equal(advogado('esc', 'amanda', raw).tramitacao, 'Amanda Teste');
  assert.equal(advogado('esc', 'victor', raw).numero, '5500000000003');
  assert.equal(advogado('esc', 'victor', raw).tramitacao, 'Victor', 'sem nome configurado vale o primeiro nome');
  assert.equal(advogado('esc', 'thiago', raw).numero, null, 'número curto demais não vale');
  assert.equal(advogado('esc', 'thiago', raw).tramitacao, null);
});
