/**
 * As regras puras das tarefas do CRM: horário no relógio da unidade (Boa Vista é UTC−4, o resto UTC−3), janela de falar com o paciente, atraso,
 * janela de 24 h do WhatsApp, em que aba a tarefa cai e o que o servidor recusa antes de gravar.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const R = await import('./regras.js');

const SP = 'America/Sao_Paulo';
const BV = 'America/Boa_Vista';
const J = { inicio: 8, fim: 20 };

test('localParaUtc: o relógio da unidade vira o instante certo (São Paulo −3, Boa Vista −4) e a volta devolve o mesmo texto', () => {
  assert.equal(R.localParaUtc('2026-11-18T14:30', SP)!.toISOString(), '2026-11-18T17:30:00.000Z');
  assert.equal(R.localParaUtc('2026-11-18T14:30', BV)!.toISOString(), '2026-11-18T18:30:00.000Z');
  assert.equal(R.utcParaLocal(new Date('2026-11-18T18:30:00.000Z'), BV), '2026-11-18T14:30');
  assert.equal(R.localParaUtc('2026-11-18 14:30', SP)!.toISOString(), '2026-11-18T17:30:00.000Z', 'aceita espaço no lugar do T');
});

test('localParaUtc recusa data que não existe, hora fora do relógio e texto torto', () => {
  for (const t of ['2026-11-31T10:00', '2026-13-01T10:00', '2026-11-18T25:00', '2026-11-18T10:61', 'amanhã', '', '2026-11-18']) assert.equal(R.localParaUtc(t, SP), null, t);
});

test('janela de falar com o paciente: 8h às 20h no fuso da unidade; fora dela a mensagem espera a próxima abertura', () => {
  const agora = (iso: string) => new Date(iso);
  // 22h30 em Boa Vista (02h30Z do dia seguinte): espera as 8h do dia seguinte de Boa Vista (12h Z)
  const noite = R.localParaUtc('2026-11-18T22:30', BV)!;
  assert.equal(R.dentroDaJanela(noite, BV, J), false);
  assert.equal(R.proximaAbertura(noite, BV, J).toISOString(), R.localParaUtc('2026-11-19T08:00', BV)!.toISOString());
  // 6h da manhã: abre às 8h do MESMO dia
  const cedo = R.localParaUtc('2026-11-18T06:00', SP)!;
  assert.equal(R.proximaAbertura(cedo, SP, J).toISOString(), R.localParaUtc('2026-11-18T08:00', SP)!.toISOString());
  // dentro da janela: o próprio instante
  const meio = R.localParaUtc('2026-11-18T14:00', SP)!;
  assert.equal(R.proximaAbertura(meio, SP, J), meio);
  // 20h em ponto já é fora (a janela é [8, 20))
  assert.equal(R.dentroDaJanela(R.localParaUtc('2026-11-18T20:00', SP)!, SP, J), false);
  assert.equal(R.dentroDaJanela(R.localParaUtc('2026-11-18T08:00', SP)!, SP, J), true);
  // virada de mês e de ano
  assert.equal(R.proximaAbertura(R.localParaUtc('2026-12-31T21:00', SP)!, SP, J).toISOString(), R.localParaUtc('2027-01-01T08:00', SP)!.toISOString());
  void agora;
});

test('janelaDeEnvio: padrão 8–20; CRM_TAREFAS_JANELA muda; valor torto cai no padrão', () => {
  assert.deepEqual(R.janelaDeEnvio({} as never), { inicio: 8, fim: 20 });
  assert.deepEqual(R.janelaDeEnvio({ CRM_TAREFAS_JANELA: '9-18' } as never), { inicio: 9, fim: 18 });
  for (const v of ['18-9', '9-25', 'abc', '9']) assert.deepEqual(R.janelaDeEnvio({ CRM_TAREFAS_JANELA: v } as never), { inicio: 8, fim: 20 }, v);
});

test('atrasoMaximoDaMensagemMs: 2 h de padrão; o .env muda entre 5 min e 24 h', () => {
  assert.equal(R.atrasoMaximoDaMensagemMs({} as never), 2 * 3_600_000);
  assert.equal(R.atrasoMaximoDaMensagemMs({ CRM_TAREFAS_ATRASO_MAX_MIN: '30' } as never), 30 * 60_000);
  assert.equal(R.atrasoMaximoDaMensagemMs({ CRM_TAREFAS_ATRASO_MAX_MIN: '1' } as never), 2 * 3_600_000);
});

test('referenciaDoAtraso: tarefa da madrugada conta o atraso a partir das 8h; a confirmação da menina vale se for mais tarde', () => {
  const quando = R.localParaUtc('2026-11-18T22:30', SP)!;
  const oito = R.localParaUtc('2026-11-19T08:00', SP)!;
  assert.equal(R.referenciaDoAtraso({ quando, confirmadaEm: null }, SP, J).toISOString(), oito.toISOString());
  const conf = new Date(oito.getTime() + 5 * 3_600_000);
  assert.equal(R.referenciaDoAtraso({ quando, confirmadaEm: conf }, SP, J).toISOString(), conf.toISOString());
  // confirmada às 20h30 (fora do horário): conta das 8h do dia seguinte, não das 20h30
  const noite = R.localParaUtc('2026-11-19T20:30', SP)!;
  assert.equal(R.referenciaDoAtraso({ quando, confirmadaEm: noite }, SP, J).toISOString(), R.localParaUtc('2026-11-20T08:00', SP)!.toISOString());
  assert.equal(R.referenciaDoAtraso({ quando, confirmadaEm: new Date(oito.getTime() - 1000) }, SP, J).toISOString(), oito.toISOString(), 'confirmação antiga não adianta nada');
});

test('janela de 24 h: o texto livre só é garantido se o paciente escreveu há pouco; caixa que não é oficial não tem janela', () => {
  const quando = new Date('2026-11-18T15:00:00Z');
  const ha = (h: number) => new Date(quando.getTime() - h * 3_600_000);
  assert.equal(R.janelaGarantida(ha(2), quando, true, SP, J), true);
  assert.equal(R.janelaGarantida(ha(21), quando, true, SP, J), true, '21 h + 2 h de margem ainda cabe em 23h45');
  assert.equal(R.janelaGarantida(ha(22), quando, true, SP, J), false, '22 h + 2 h de margem passa de 23h45: exige modelo');
  assert.equal(R.janelaGarantida(null, quando, true, SP, J), false, 'nunca escreveu: só por modelo');
  assert.equal(R.janelaGarantida(null, quando, false, SP, J), true, 'caixa do celular/API: sem janela');
  // o limite coincide com o horário da janela quando ele cai dentro do horário de falar com o paciente (15h de SP aqui)
  const desde = R.modeloAPartirDe(quando, SP, J)!; // paciente escreveu às 12h de SP: o limite é 09h45 do dia seguinte
  assert.equal(desde.getTime(), quando.getTime() + 24 * 3_600_000 - 15 * 60_000 - 2 * 3_600_000);
  assert.equal(R.modeloAPartirDe(null, SP, J), null);
});

test('janela de 24 h e horário juntos: marcada para as 20h30, a mensagem só sai às 8h do dia seguinte — é nessa hora que a janela precisa estar aberta', () => {
  // o paciente escreveu às 07h00 do dia 18; a menina marca TEXTO LIVRE para as 20h30 do mesmo dia (15,5 h depois: parece caber)
  const ultima = R.localParaUtc('2026-11-18T07:00', SP)!;
  const marcada = R.localParaUtc('2026-11-18T20:30', SP)!;
  assert.equal(R.janelaGarantida(ultima, marcada, true, SP, J), false, 'sairia às 8h do dia 19, 25 h depois: exige modelo');
  assert.equal(R.janelaGarantida(ultima, R.localParaUtc('2026-11-18T19:00', SP)!, true, SP, J), true, 'às 19h ainda sai no mesmo dia (12 h + margem)');
  // o limite que a tela usa: a janela vence às 04h45 do dia 19 (fora do horário) → vale o fechamento das 20h do dia 18
  assert.equal(R.modeloAPartirDe(ultima, SP, J)!.toISOString(), R.localParaUtc('2026-11-18T20:00', SP)!.toISOString());
  // limite DEPOIS das 20h (22h45): o último fechamento é as 20h do mesmo dia
  const tarde = R.localParaUtc('2026-11-18T01:00', SP)!;
  assert.equal(R.modeloAPartirDe(tarde, SP, J)!.toISOString(), R.localParaUtc('2026-11-18T20:00', SP)!.toISOString(), 'limite às 22h45 → fecha às 20h do mesmo dia');
  // a conta da tela e a do servidor concordam em todo o dia: marcado antes do limite = garantido; no limite ou depois = exige modelo
  const limite = R.modeloAPartirDe(ultima, SP, J)!;
  for (let min = -600; min <= 1500; min += 15) {
    const q = new Date(limite.getTime() + min * 60_000);
    assert.equal(R.janelaGarantida(ultima, q, true, SP, J), q < limite, q.toISOString());
  }
});

test('escolherVia: texto se a janela está aberta; senão o modelo; sem nenhum dos dois, não sai', () => {
  const agora = new Date('2026-11-18T15:00:00Z');
  const ha = (h: number) => new Date(agora.getTime() - h * 3_600_000);
  const base = { caixaOficial: true, agora, temTexto: true, temModelo: true };
  assert.deepEqual(R.escolherVia({ ...base, ultimaDoPaciente: ha(3) }), { tipo: 'texto' });
  assert.deepEqual(R.escolherVia({ ...base, ultimaDoPaciente: ha(30) }), { tipo: 'modelo' });
  assert.deepEqual(R.escolherVia({ ...base, ultimaDoPaciente: null }), { tipo: 'modelo' });
  assert.equal(R.escolherVia({ ...base, ultimaDoPaciente: ha(30), temModelo: false }).tipo, 'nenhuma');
  assert.equal(R.escolherVia({ ...base, ultimaDoPaciente: ha(3), temTexto: false }).tipo, 'modelo', 'janela aberta e só o modelo: manda o modelo');
  assert.equal(R.escolherVia({ ...base, ultimaDoPaciente: ha(3), temTexto: false, temModelo: false }).tipo, 'nenhuma');
  assert.deepEqual(R.escolherVia({ ...base, caixaOficial: false, ultimaDoPaciente: ha(300) }), { tipo: 'texto' }, 'sem janela: texto');
  assert.equal(R.escolherVia({ ...base, caixaOficial: false, ultimaDoPaciente: null, temTexto: false }).tipo, 'nenhuma');
});

test('grupoDaTarefa: hoje, atrasadas (com a tolerância do ciclo), próximas e feitas — no calendário da unidade', () => {
  const agora = R.localParaUtc('2026-11-18T15:00', SP)!;
  const g = (estado: string, local: string) => R.grupoDaTarefa({ estado, quando: R.localParaUtc(local, SP)! }, agora, SP);
  assert.equal(g('pendente', '2026-11-18T17:00'), 'hoje');
  assert.equal(g('pendente', '2026-11-18T14:57'), 'hoje', 'passou 3 min: o robô ainda vai pegar');
  assert.equal(g('pendente', '2026-11-18T14:50'), 'atrasadas');
  assert.equal(g('pendente', '2026-11-17T10:00'), 'atrasadas');
  assert.equal(g('pendente', '2026-11-19T09:00'), 'proximas');
  assert.equal(g('aguardando', '2026-11-18T17:00'), 'atrasadas', 'esperando confirmação sempre pede atenção');
  for (const e of ['feita', 'falhou', 'barrada', 'cancelada']) assert.equal(g(e, '2026-11-18T17:00'), 'feitas', e);
  // 23h30 de São Paulo já é "amanhã" em UTC, mas ainda é hoje para a menina
  const tarde = R.localParaUtc('2026-11-18T23:30', SP)!;
  assert.equal(R.grupoDaTarefa({ estado: 'pendente', quando: tarde }, agora, SP), 'hoje');
});

test('problemaNoPedido: mensagem precisa de texto ou modelo; modelo confere variáveis e o nome para a saudação; ligação não usa modelo', () => {
  const modelo = { nome: 'm', idioma: 'pt_BR', texto: 'Oi {{1}}, tudo bem?', variaveis: ['primeiroNome'] };
  assert.equal(R.problemaNoPedido({ tipo: 'mensagem', texto: '', modelo: null }, 'Maria'), 'escreva a mensagem ou escolha um modelo');
  assert.equal(R.problemaNoPedido({ tipo: 'mensagem', texto: 'Oi', modelo: null }, 'Maria'), null);
  assert.equal(R.problemaNoPedido({ tipo: 'mensagem', texto: '', modelo }, 'Maria Silva'), null);
  assert.match(R.problemaNoPedido({ tipo: 'mensagem', texto: '', modelo }, 'Lead 123')!, /nome do contato não serve/);
  assert.match(R.problemaNoPedido({ tipo: 'mensagem', texto: '', modelo: { ...modelo, variaveis: [] } }, 'Maria')!, /variável/);
  assert.equal(R.problemaNoPedido({ tipo: 'mensagem', texto: '', modelo: { ...modelo, variaveis: ['texto:Oi'] } }, 'Lead 1'), null, 'com texto fixo o nome não importa');
  assert.equal(R.problemaNoPedido({ tipo: 'ligacao', texto: 'confirmar', modelo: null }, 'Maria'), null);
  assert.equal(R.problemaNoPedido({ tipo: 'ligacao', texto: '', modelo }, 'Maria'), 'só mensagem usa modelo');
  assert.match(R.problemaNoPedido({ tipo: 'lembrete', texto: 'x'.repeat(1001), modelo: null }, 'Maria')!, /passa de/);
});

test('telefoneDaMenina: DDD + número viram 55…; o que não é telefone é recusado', () => {
  assert.equal(R.telefoneDaMenina('(94) 99999-0000'), '5594999990000');
  assert.equal(R.telefoneDaMenina('5594999990000'), '5594999990000');
  assert.equal(R.telefoneDaMenina('+55 94 99999-0000'), '5594999990000');
  // a mesma regra do disparo: fixo não tem WhatsApp, DDD inventado não vale, número de outro país não entra
  for (const v of ['', 'abc', '99999-0000', '123', '+1 415 555 0100', '+55 94 3333-0000', '(00) 99999-0000', null, undefined]) assert.equal(R.telefoneDaMenina(v), null, String(v));
  assert.equal(R.telefoneMascarado('5594999990000'), '…0000');
});

test('notaComMencao: menção no formato do Chatwoot (id da pessoa) e o nome sem os símbolos que quebram a menção', () => {
  assert.equal(R.notaComMencao({ id: 7, nome: 'Ana Souza' }, 'Hora de ligar.'), '🔔 [@Ana](mention://user/7/Ana) Hora de ligar.');
  assert.ok(!R.notaComMencao({ id: 7, nome: '[Ana](x)' }, 'oi').includes('[Ana]('), 'colchete e parêntese do nome não escapam da menção');
  assert.equal(R.notaComMencao({ id: 7, nome: 'José' }, 'x'), '🔔 [@José](mention://user/7/Jos%C3%A9) x');
});

test('textoDoLembrete: ligação, mensagem e lembrete dizem o que fazer, com o horário da unidade', () => {
  const quando = R.localParaUtc('2026-11-18T14:30', SP)!;
  assert.equal(R.textoDoLembrete({ tipo: 'ligacao', contatoNome: 'Maria Silva Oliveira 28/04 facebook', quando, texto: 'confirmar a consulta' }, SP), 'Hora de ligar para Maria Silva Oliveira (combinado para 18/11 14:30).\nconfirmar a consulta');
  assert.match(R.textoDoLembrete({ tipo: 'mensagem', contatoNome: 'Maria', quando, texto: '' }, SP), /Mensagem para Maria agendada para 18\/11 14:30\./);
  assert.match(R.textoDoLembrete({ tipo: 'lembrete', contatoNome: '', quando, texto: '' }, SP), /Lembrete sobre o contato/);
});
