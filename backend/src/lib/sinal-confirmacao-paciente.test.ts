/**
 * A confirmação do sinal ao paciente (lib/sinal-confirmacao-paciente.ts): o texto, a janela de 24 h, a pausa, o modo «só no papel» e a reserva de UMA por sinal.
 * Sem banco, sem Kommo e sem rede: as dependências são falsas e a reserva é um UPDATE condicionado, como no banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { confirmarSinalAoPaciente, textoDaConfirmacao, VALE_A_CONFIRMACAO_MS, type DepsDaConfirmacao, type Desfecho } from './sinal-confirmacao-paciente.js';
import type { LinhaDoSinal } from './sinal-pix.js';

const UNIDADE = { id: 'u1', slug: 'doutor-hernia-acailandia', name: 'Doutor Hérnia Açailândia', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit;
const AGORA = new Date('2026-11-26T15:00:00Z'); // 12h em Brasília, 26/11 (quinta)

const sinal = (over: Partial<LinhaDoSinal> = {}): LinhaDoSinal => ({
  id: 's1', unitId: 'u1', clinica: 'doutor-hernia-acailandia', leadId: '5829035', linkId: 'L', url: 'u', valorCentavos: 5000, venceEm: '2026-11-29', consultaEm: '2026-11-30T09:00',
  status: 'pago', paymentId: 'p', criadoEm: new Date('2026-11-26T14:00:00Z'), pagoEm: new Date('2026-11-26T14:59:00Z'), avisadoEm: new Date(), confirmacaoEm: null, ...over,
});

function fake(over: Omit<Partial<DepsDaConfirmacao>, 'estado'> & { janela?: boolean | Error; pausa?: string | null; rota?: boolean; envio?: 'enviado' | 'sem-rota' | Error; estado?: 'ligado' | 'seco' | 'desligado' } = {}) {
  const enviados: string[] = [];
  const notas: string[] = [];
  const mensagens: string[] = [];
  const simulacoes: Array<{ acao: string; valor?: string; motivo?: string }> = [];
  const concluidos: Array<{ id: string; desfecho: Desfecho }> = [];
  const reservadas = new Set<string>();
  const deps: DepsDaConfirmacao = {
    estado: () => over.estado ?? 'ligado',
    agora: () => AGORA,
    reservar: async (id) => (reservadas.has(id) ? false : (reservadas.add(id), true)),
    concluir: async (id, desfecho) => void concluidos.push({ id, desfecho }),
    pausadoPor: async () => (over.pausa === undefined ? null : over.pausa),
    janelaAberta: async () => {
      if (over.janela instanceof Error) throw over.janela;
      return over.janela ?? true;
    },
    temRota: () => over.rota ?? true,
    enviar: async (_u, _l, texto) => {
      if (over.envio instanceof Error) throw over.envio;
      enviados.push(texto);
      return over.envio ?? 'enviado';
    },
    gravarMensagem: async (_u, _l, texto) => void mensagens.push(texto),
    nota: async (_u, _l, texto) => void notas.push(texto),
    simular: (_u, s) => void simulacoes.push(s as never),
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['janela', 'pausa', 'rota', 'envio', 'estado'].includes(k))),
  };
  return { deps, enviados, notas, mensagens, simulacoes, concluidos, reservadas };
}

test('o texto: valor, dia da semana e data, hora e a cidade — e sem inventar quando não há data (ou a consulta já passou)', () => {
  const base = { valorCentavos: 5000, nomeDaUnidade: 'Doutor Hérnia Açailândia', agoraLocal: '2026-11-26T12:00' };
  assert.equal(textoDaConfirmacao({ ...base, consultaEm: '2026-11-30T09:00' }), 'Recebemos seu sinal de R$ 50 ✅ Sua consulta está confirmada para segunda, 30/11 às 09:00 na Doutor Hérnia Açailândia. Até lá!');
  const sem = 'Recebemos seu sinal de R$ 50 ✅ Sua consulta está confirmada na Doutor Hérnia Açailândia. Até lá!';
  assert.equal(textoDaConfirmacao({ ...base, consultaEm: null }), sem);
  assert.equal(textoDaConfirmacao({ ...base, consultaEm: undefined }), sem);
  assert.equal(textoDaConfirmacao({ ...base, consultaEm: 'lixo' }), sem);
  assert.equal(textoDaConfirmacao({ ...base, consultaEm: '2026-11-20T09:00' }), sem, 'consulta que já passou: sem data');
  assert.match(textoDaConfirmacao({ ...base, valorCentavos: 5050, consultaEm: null }), /R\$ 50,50/);
  assert.doesNotMatch(textoDaConfirmacao({ ...base, nomeDaUnidade: 'Araguaína', consultaEm: null }), /Doutor Hérnia Doutor/);
});

test('dentro da janela, sem pausa: UMA mensagem com o texto certo, reserva feita antes, desfecho «enviada» e a mensagem gravada para a pausa pela equipe reconhecer', async () => {
  const f = fake();
  const r = await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps);
  assert.deepEqual(r, { tipo: 'enviada' });
  assert.deepEqual(f.enviados, ['Recebemos seu sinal de R$ 50 ✅ Sua consulta está confirmada para segunda, 30/11 às 09:00 na Doutor Hérnia Açailândia. Até lá!']);
  assert.deepEqual(f.mensagens, f.enviados);
  assert.deepEqual(f.concluidos, [{ id: 's1', desfecho: 'enviada' }]);
  assert.deepEqual(f.notas, [], 'quem recebeu a mensagem não ganha nota de «não enviada»');
});

test('UMA por sinal: a segunda chamada (aviso + varredura, retry, pagamento atrasado) NÃO envia, nem em paralelo', async () => {
  const f = fake();
  const linha = sinal();
  const rs = await Promise.all([confirmarSinalAoPaciente(UNIDADE, linha, f.deps), confirmarSinalAoPaciente(UNIDADE, linha, f.deps), confirmarSinalAoPaciente(UNIDADE, linha, f.deps)]);
  assert.equal(f.enviados.length, 1);
  assert.deepEqual(rs.map((r) => r.tipo).sort(), ['enviada', 'ja-feita', 'ja-feita']);
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, linha, f.deps)).tipo, 'ja-feita');
  assert.equal(f.enviados.length, 1);
  // a linha que o banco já marcou como confirmada nem chega à reserva
  const g = fake();
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal({ confirmacaoEm: new Date() }), g.deps)).tipo, 'ja-feita');
  assert.equal(g.reservadas.size, 0);
});

test('FORA da janela de 24 h: não envia nada (nem modelo) e deixa só a nota «confirmação não enviada: fora da janela de 24 h»', async () => {
  const f = fake({ janela: false });
  const r = await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps);
  assert.deepEqual(r, { tipo: 'nota', desfecho: 'fora-da-janela' });
  assert.deepEqual(f.enviados, []);
  assert.deepEqual(f.mensagens, []);
  assert.equal(f.notas.length, 1);
  assert.match(f.notas[0]!, /confirmação não enviada: fora da janela de 24 h/);
  assert.deepEqual(f.concluidos, [{ id: 's1', desfecho: 'fora-da-janela' }]);
  // a nota também é uma só
  await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps);
  assert.equal(f.notas.length, 1);
});

test('IA PAUSADA (unidade, «Pausar IA» ou pausa com data): não envia e deixa a nota com o motivo; a pausa vale antes da janela', async () => {
  for (const motivo of ['a IA da unidade está pausada', '«Pausar IA» marcado no cartão', 'pausa com data neste cartão']) {
    const f = fake({ pausa: motivo, janela: true });
    assert.deepEqual(await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps), { tipo: 'nota', desfecho: 'pausada' });
    assert.deepEqual(f.enviados, []);
    assert.match(f.notas[0]!, /confirmação não enviada: a IA está pausada/);
    assert.ok(f.notas[0]!.includes(motivo));
  }
});

test('sem rota de envio pelo Salesbot, ou o Kommo só deixou nota interna: nota, e o paciente não é dado como avisado', async () => {
  const a = fake({ rota: false });
  assert.deepEqual(await confirmarSinalAoPaciente(UNIDADE, sinal(), a.deps), { tipo: 'nota', desfecho: 'sem-rota' });
  assert.deepEqual(a.enviados, []);
  const b = fake({ envio: 'sem-rota' });
  assert.deepEqual(await confirmarSinalAoPaciente(UNIDADE, sinal(), b.deps), { tipo: 'nota', desfecho: 'sem-rota' });
  assert.deepEqual(b.mensagens, [], 'não gravou como enviada');
  assert.equal(b.notas.length, 1);
});

test('MODO SECO (padrão da chave): registra o que MANDARIA e não reserva, não envia, não deixa nota nem grava mensagem — e não repete a simulação', async () => {
  const f = fake({ estado: 'seco' });
  const r = await confirmarSinalAoPaciente(UNIDADE, sinal({ id: 'seco-1' }), f.deps);
  assert.equal(r.tipo, 'simulada');
  assert.equal(f.simulacoes.length, 1);
  assert.equal(f.simulacoes[0]!.acao, 'mandaria');
  assert.match(f.simulacoes[0]!.valor ?? '', /^Recebemos seu sinal de R\$ 50 ✅/);
  assert.deepEqual(f.enviados, []);
  assert.deepEqual(f.notas, []);
  assert.deepEqual(f.mensagens, []);
  assert.equal(f.reservadas.size, 0, 'o seco não gasta a reserva: ligar a chave depois ainda confirma');
  assert.deepEqual(f.concluidos, []);
  await confirmarSinalAoPaciente(UNIDADE, sinal({ id: 'seco-1' }), f.deps);
  assert.equal(f.simulacoes.length, 1, 'a mesma varredura de 5 em 5 min não repete a simulação');
  // seco com a janela fechada: registra que NÃO mandaria, também sem tocar em nada
  const g = fake({ estado: 'seco', janela: false });
  await confirmarSinalAoPaciente(UNIDADE, sinal({ id: 'seco-2' }), g.deps);
  assert.equal(g.simulacoes[0]!.acao, 'pularia');
  assert.match(g.simulacoes[0]!.motivo ?? '', /24 h/);
  assert.deepEqual(g.notas, []);
});

test('chave DESLIGADA, pagamento antigo, sinal ainda pendente e conversa do Chatwoot: nada acontece', async () => {
  const d = fake({ estado: 'desligado' });
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal(), d.deps)).tipo, 'desligada');
  const velho = fake();
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal({ pagoEm: new Date(AGORA.getTime() - VALE_A_CONFIRMACAO_MS - 60_000) }), velho.deps)).tipo, 'fora-de-prazo');
  const semData = fake();
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal({ pagoEm: null }), semData.deps)).tipo, 'fora-de-prazo');
  const pendente = fake();
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal({ status: 'pendente' }), pendente.deps)).tipo, 'ja-feita');
  const chat = fake();
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal({ leadId: String(2_000_000_000 + 7) }), chat.deps)).tipo, 'nao-kommo');
  for (const f of [d, velho, semData, pendente, chat]) {
    assert.deepEqual([f.enviados, f.notas, f.mensagens], [[], [], []]);
    assert.equal(f.reservadas.size, 0);
  }
});

test('não deu para ler a conversa (Kommo fora): ADIA sem reservar nada — a próxima varredura tenta, e envia uma vez', async () => {
  const f = fake({ janela: new Error('Kommo 502') });
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps)).tipo, 'adiada');
  assert.equal(f.reservadas.size, 0);
  assert.deepEqual(f.notas, []);
  const g = { ...f.deps, janelaAberta: async () => true };
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal(), g)).tipo, 'enviada');
  assert.equal(f.enviados.length, 1);
});

test('erro no ENVIO: a reserva fica (não repete), nota para a equipe conferir o Kommo, desfecho «erro»', async () => {
  const f = fake({ envio: new Error('timeout') });
  assert.deepEqual(await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps), { tipo: 'nota', desfecho: 'erro' });
  assert.match(f.notas[0]!, /o envio deu erro/);
  assert.deepEqual(f.concluidos, [{ id: 's1', desfecho: 'erro' }]);
  assert.equal((await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps)).tipo, 'ja-feita');
});

test('sinal gerado SEM a data da consulta (placeholder <vencimento>T23:59): a confirmação sai sem dia e hora — nunca inventa um horário', async () => {
  const f = fake();
  await confirmarSinalAoPaciente(UNIDADE, sinal({ consultaEm: '2026-11-29T23:59', venceEm: '2026-12-01' }), f.deps);
  assert.deepEqual(f.enviados, ['Recebemos seu sinal de R$ 50 ✅ Sua consulta está confirmada na Doutor Hérnia Açailândia. Até lá!']);
});

test('o Kommo só deixou uma nota interna (sem Salesbot): a nota da equipe diz que a «🤖 IA» acima NÃO foi para o paciente', async () => {
  const f = fake({ envio: 'sem-rota' });
  await confirmarSinalAoPaciente(UNIDADE, sinal(), f.deps);
  assert.match(f.notas[0]!, /a «🤖 IA» acima NÃO foi para o paciente/);
});
