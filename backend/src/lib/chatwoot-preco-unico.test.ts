/**
 * «Preço único»: R$ na fala do modelo que não é da unidade não sai — a mensagem é segurada e a conversa vai para a equipe.
 * Desligada (o padrão) nada muda; em «só no papel» a mensagem sai como hoje e só se anota o que seguraria.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { AVISO_DE_PRECO_SEGURADO, precosDaUnidade, valoresForaDaConfiguracao } from './chatwoot-preco-unico.js';
import { rodarSofiaDoChatwoot, type ConversaLida, type PortaDoChatwoot } from './chatwoot-sofia.js';
import { etapaParaPassagem, novaMemoriaDaIa, rodarSofia, type PortasDaIa } from './chatwoot-ia.js';
import type { Estado } from './automacoes-estado.js';

const FONTES = 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado. Sinal de R$ 50 no Pix + R$ 200 no dia.';
const unidade = (o: Record<string, unknown> = {}) =>
  ({ id: 'u', slug: 'doutor-hernia-parauapebas', name: 'Doutor Hérnia Parauapebas', category: 'saude', sourceProdutos: FONTES, sourcePapel: '', sourceNegocio: '', systemPrompt: '', ...o }) as unknown as Unit;

test('a tabela da unidade: R$ das fontes, antecipado/no dia e o sinal; ficha sem R$ = nada a conferir', () => {
  assert.deepEqual([...precosDaUnidade(unidade())].sort((a, b) => a - b), [50, 200, 250, 350]);
  assert.equal(precosDaUnidade(unidade({ sourceProdutos: 'Consulta de avaliação com a especialista.' })).size, 0);
});

test('valor da tabela passa; parcela passa; valor do paciente e valor negado passam; abaixo de R$ 20 passa', () => {
  const u = unidade();
  for (const ok of ['A consulta é R$ 350 no dia, ou R$ 250 antecipado.', 'Sinal de R$ 50 agora e R$ 200 no dia.', 'Em 12x fica R$ 29,17 por mês no cartão', 'Entendi o seu comprovante de R$ 120,00, obrigada!', 'Fica R$ 250, e não R$ 450.', 'O estacionamento é R$ 8.', 'Sem valor aqui.']) {
    assert.deepEqual(valoresForaDaConfiguracao(ok, u), [], ok);
  }
});

test('valor que não é da unidade: devolvido, sem repetir, na ordem (o #408: «sinal de R$ 250»? 250 é da tabela; R$ 280 não é)', () => {
  const u = unidade();
  assert.deepEqual(valoresForaDaConfiguracao('A consulta é R$ 280 no dia, ou R$ 280 antecipado, ou R$ 199.', u), [280, 199]);
  assert.deepEqual(valoresForaDaConfiguracao('A consulta é R$ 1.500 no total', u), [1500]);
});

test('centavos contam («R$ 350,99» não é o «R$ 350»); parcela só em frase de parcela e só da consulta, nunca do sinal', () => {
  const u = unidade();
  assert.deepEqual(valoresForaDaConfiguracao('A consulta é R$ 350,99 no dia.', u), [350.99]);
  assert.deepEqual(valoresForaDaConfiguracao('A consulta é R$ 350,00 no dia.', u), []);
  assert.deepEqual(valoresForaDaConfiguracao('O sinal fica R$ 100 agora.', u), [100], '100 é 200÷2, mas não há parcela na frase');
  assert.deepEqual(valoresForaDaConfiguracao('Dá para parcelar: 2x de R$ 175 no cartão.', u), [], '175 = 350÷2, na frase de parcela');
  assert.deepEqual(valoresForaDaConfiguracao('Fica R$ 175 no dia.', u), [175], '175 sem parcela na frase é preço errado');
  assert.deepEqual(valoresForaDaConfiguracao('O sinal é parcelado em 2x de R$ 100.', u), [100], 'sinal não se parcela: só o total da consulta');
});

test('unidade sem R$ na ficha: a trava não tem com o que comparar e nada é segurado', () => {
  assert.deepEqual(valoresForaDaConfiguracao('Fica R$ 999', unidade({ sourceProdutos: 'sem preços' })), []);
});

// ── a rodada ───────────────────────────────────────────────────────────────────────────────────────

const lida: ConversaLida = { id: 12, nome: 'Maria', telefone: '+5594999990000', attrs: {}, etiquetas: [], grupo: false, interno: false };
const chat: PortaDoChatwoot = {
  conversa: async () => null,
  gravarAtributos: async () => {},
  adicionarEtiquetas: async () => {},
  nota: async () => {},
  publica: async () => ({ usuario: null }),
  valoresDoAtributo: async () => [],
  etiquetasDaConta: async () => [],
};
const modelo = (reply: string) =>
  (async () => ({ ok: true as const, reply, actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never;

async function sofia(reply: string, estado: Estado) {
  return (await rodarSofiaDoChatwoot({ unit: unidade(), falas: [{ role: 'user', content: 'quanto custa?' }], conversa: 12, modo: 'ligado', lida, chat }, { rodarTeste: modelo(reply), precoUnico: estado }))!;
}

test('LIGADA: valor fora da tabela → precoSegurado com o que ela ia dizer; valor certo → nada segurado', async () => {
  const errado = await sofia('A consulta é R$ 280 no dia.', 'ligado');
  assert.deepEqual(errado.precoSegurado, { valores: [280], texto: 'A consulta é R$ 280 no dia.' });
  const certo = await sofia('A consulta é R$ 350 no dia, ou R$ 250 antecipado.', 'ligado');
  assert.equal(certo.precoSegurado, null);
});

test('DESLIGADA (padrão) e SÓ NO PAPEL: nada é segurado — a resposta sai como sai hoje', async () => {
  for (const e of ['desligado', 'seco'] as const) assert.equal((await sofia('A consulta é R$ 280 no dia.', e)).precoSegurado, null, e);
});

function portas(r: Awaited<ReturnType<typeof sofia>>, o: { falhaAviso?: boolean; falhaEquipe?: boolean; etapaLida?: string } = {}) {
  const lidasNaPassagem: ConversaLida[] = [];
  const recebidos: Array<{ falas?: unknown; unit?: unknown }> = [];
  const publicas: string[] = [];
  const notas: string[] = [];
  const equipe: string[] = [];
  const eventos: Array<{ tipo: string; detalhe?: string | null }> = [];
  const p: PortasDaIa = {
    estado: () => 'ligado',
    unidade: async () => unidade(),
    mensagens: async () => [{ message_type: 0, content: 'quanto custa?', private: false }],
    nota: async (_c, t) => void notas.push(t),
    publica: async (_c, t) => {
      if (o.falhaAviso && t.includes(AVISO_DE_PRECO_SEGURADO)) throw new Error('chatwoot 500');
      publicas.push(t);
      return { usuario: 3 };
    },
    registrarEvento: async (e) => void eventos.push({ tipo: e.tipo, detalhe: e.detalhe }),
    agendaReal: async () => [],
    passarParaEquipe: async (_c, l, motivo, falas, unit) => {
      lidasNaPassagem.push(l);
      recebidos.push({ falas, unit });
      if (o.falhaEquipe) throw new Error('chatwoot 500');
      equipe.push(motivo);
    },
    transcrever: async () => '',
    conversa: async () => ({ ...lida, attrs: { ...lida.attrs, ...(o.etapaLida ? { etapa: o.etapaLida } : {}) } }),
    cartaoNoKommo: async () => null,
    sofia: async () => r,
    agendar: (fn) => fn,
    cancelar: () => {},
    hoje: () => '2026-11-26',
  };
  return { p, publicas, notas, equipe, eventos, lidasNaPassagem, recebidos };
}
const M = { conversa: 12, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] as string[] };

test('rodada LIGADA com valor fora da tabela: a mensagem NÃO sai, só o aviso; a conversa vai para a equipe; a nota traz o que ela ia dizer', async () => {
  const r = await sofia('A consulta é R$ 280 no dia.', 'ligado');
  const a = portas(r);
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'preco-segurado');
  assert.deepEqual(a.publicas, [AVISO_DE_PRECO_SEGURADO]);
  assert.ok(!a.publicas.some((t) => t.includes('280')));
  assert.equal(a.equipe.length, 1);
  assert.match(a.equipe[0]!, /R\$ 280.*mensagem segurada/);
  assert.match(a.notas[0]!, /SEGURADA.*R\$ 280.*«A consulta é R\$ 280 no dia\.»/s);
  assert.deepEqual(a.eventos, [{ tipo: 'equipe', detalhe: 'valor-pagamento' }, { tipo: 'decisao', detalhe: 'valor fora da tabela (R$ 280)' }]);
});

test('rodada LIGADA com valor da tabela: sai como sempre', async () => {
  const r = await sofia('A consulta é R$ 350 no dia.', 'ligado');
  const a = portas(r);
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'enviada');
  assert.deepEqual(a.publicas, ['A consulta é R$ 350 no dia.']);
  assert.equal(a.equipe.length, 0);
});

test('rodada LIGADA: o Pix e o endereço das ferramentas SAEM mesmo com a mensagem segurada (a consulta e a cobrança já existem)', async () => {
  const r = { ...(await sofia('Marquei! A consulta fica R$ 280.', 'ligado')), pix: '00020126PIXCOPIAECOLA', cartao: '📍 Rua A, 10', acoes: [{ tool: 'agendar_consulta', args: { data: '2026-11-27', hora: '09:00' } }] };
  const a = portas(r);
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'preco-segurado');
  assert.deepEqual(a.publicas, [AVISO_DE_PRECO_SEGURADO, '00020126PIXCOPIAECOLA', '📍 Rua A, 10']);
  assert.match(a.notas[0]!, /agendar_consulta — data: 2026-11-27/);
});

test('rodada LIGADA: se a Sofia JÁ passou para a equipe na mesma rodada, não passa nem conta duas vezes', async () => {
  const r = { ...(await sofia('Já chamo a equipe, a consulta é R$ 280.', 'ligado')), passouParaEquipe: true };
  const a = portas(r);
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'preco-segurado');
  assert.equal(a.equipe.length, 0);
  assert.ok(!a.eventos.some((e) => e.tipo === 'equipe' && e.detalhe === 'valor-pagamento'));
});

test('rodada LIGADA: a nota não mente — aviso que não saiu e passagem que falhou aparecem na nota, e o desfecho vira «falhou»', async () => {
  const r = await sofia('A consulta é R$ 280 no dia.', 'ligado');
  const a = portas(r, { falhaAviso: true });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'preco-segurado');
  assert.match(a.notas[0]!, /O paciente NÃO recebeu nada/);
  const b = portas(r, { falhaEquipe: true });
  assert.equal(await rodarSofia(M, b.p, novaMemoriaDaIa()), 'falhou');
  assert.match(b.notas[0]!, /NÃO consegui passar a conversa para a equipe: pegue esta conversa/);
  assert.match(b.notas[0]!, /recebeu só um aviso/);
});

// ── rodada do sênior (#480): taxa obrigatória, unidade sem antecipado, etapa de agora, confirmação do dia e hora ─────────

const TAXA = { sourceProdutos: 'Consulta: R$ 100 antecipado + R$ 250 no dia.', acceptsAdvancePayment: true, spineBookingRequiresPayment: true };
const SEM_ANTECIPADO = { sourceProdutos: 'Consulta: R$ 350,00 no dia (dinheiro, Pix ou cartão).', acceptsAdvancePayment: false };

test('taxa de reserva obrigatória: a frase que o PRÓPRIO prompt manda dizer («R$ 350 no total — R$ 100 antecipado + R$ 250 no dia») passa; o total se parcela; R$ 351 não', () => {
  const u = unidade(TAXA);
  assert.deepEqual([...precosDaUnidade(u)].sort((a, b) => a - b), [100, 250, 350]);
  for (const ok of ['✨ Valor: R$ 350 no total — R$ 100 antecipado (já pago, garante o horário) + R$ 250 no dia', 'R$ 350 no total — R$ 100 antecipados para garantir o horário (abatem do total) + R$ 250 no dia', 'Dá para parcelar o total em 2x de R$ 175 no cartão.']) {
    assert.deepEqual(valoresForaDaConfiguracao(ok, u), [], ok);
  }
  assert.deepEqual(valoresForaDaConfiguracao('R$ 351 no total — R$ 100 antecipado + R$ 250 no dia', u), [351], 'total errado continua segurado');
  assert.deepEqual(valoresForaDaConfiguracao('A consulta fica R$ 175 no dia.', u), [175], 'fração sem frase de parcela continua errada');
  assert.deepEqual(valoresForaDaConfiguracao('Parcela em 2x de R$ 125 no cartão.', u), [125], 'só o TOTAL (350) se parcela: 125 é o resto de R$ 250 dividido');
  assert.deepEqual(valoresForaDaConfiguracao('Parcela em 10x de R$ 25 no cartão.', u), [25], '25 é o resto de R$ 250 em 10x, não parcela do total');
});

test('unidade SEM antecipado (só paga no dia): «2x de R$ 175» passa quando as parcelas somam o preço da ficha; R$ 175 solto e parcela de outro total, não', () => {
  const u = unidade(SEM_ANTECIPADO);
  assert.deepEqual(valoresForaDaConfiguracao('Dá para parcelar em 2x de R$ 175 no cartão.', u), []);
  assert.deepEqual(valoresForaDaConfiguracao('No cartão: 3x de R$ 116,67.', u), []);
  assert.deepEqual(valoresForaDaConfiguracao('A consulta é R$ 350,00 no dia.', u), []);
  assert.deepEqual(valoresForaDaConfiguracao('Fica R$ 175 no dia.', u), [175], 'sem frase de parcela é preço errado');
  assert.deepEqual(valoresForaDaConfiguracao('Dá para parcelar em 2x de R$ 200.', u), [200], 'as parcelas não somam o preço');
});

test('passar para a equipe usa a etapa de AGORA: marcou na rodada → «Agendado» (não a «Sofia qualifica» lida antes), e a confirmação com dia e hora chega ao paciente', async () => {
  const base = await sofia('Marquei! A consulta fica R$ 280.', 'ligado');
  const r = { ...base, agendou: { data: '2026-11-27', hora: '09:00' }, etapa: 'Agendado', acoes: [{ tool: 'agendar_consulta', args: { data: '2026-11-27', hora: '09:00' } }] };
  const a = portas(r, { etapaLida: 'Sofia qualifica' });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'preco-segurado');
  assert.equal(a.lidasNaPassagem.length, 1);
  assert.equal(a.lidasNaPassagem[0]!.attrs.etapa, 'Agendado', 'a passagem recebe a etapa do fim da rodada');
  assert.ok(Array.isArray(a.recebidos[0]!.falas) && a.recebidos[0]!.falas.length > 0 && a.recebidos[0]!.unit, 'as falas e a unidade vão junto (o resumo da passagem, #478, precisa deles)');
  assert.equal(a.publicas.length, 1);
  assert.match(a.publicas[0]!, /^Sua consulta está marcada para sexta-feira, 27\/11\/2026 às 09:00 ✅/);
  assert.ok(a.publicas[0]!.includes(AVISO_DE_PRECO_SEGURADO), 'a confirmação vem junto do aviso do valor');
  assert.ok(!a.publicas[0]!.includes('280'), 'nenhum valor fora da tabela chega ao paciente');
  assert.match(a.notas[0]!, /recebeu a confirmação do dia e horário e um aviso/);
  // sem consulta marcada: só o aviso, como antes; e sem `etapa` no resultado, vale a conversa relida
  const b = portas({ ...base, etapa: undefined }, { etapaLida: 'Frio' });
  assert.equal(await rodarSofia(M, b.p, novaMemoriaDaIa()), 'preco-segurado');
  assert.deepEqual(b.publicas, [AVISO_DE_PRECO_SEGURADO]);
  assert.equal(b.lidasNaPassagem[0]!.attrs.etapa, 'Frio');
});

test('a rodada devolve a etapa em que a conversa ficou (a do fim, não a de antes)', async () => {
  const u = unidade();
  const lidaQualifica: ConversaLida = { ...lida, attrs: { etapa: 'Sofia qualifica' } };
  const r = (await rodarSofiaDoChatwoot({ unit: u, falas: [{ role: 'user', content: 'oi' }], conversa: 12, modo: 'ligado', lida: lidaQualifica, chat }, { rodarTeste: modelo('Oi!'), precoUnico: 'ligado' }))!;
  assert.equal(r.etapa, 'Sofia qualifica');
});

test('etapaParaPassagem: a protegida vence; sem protegida, a relida, depois a da rodada, depois a lida antes; a da rodada vazia não esconde a relida', () => {
  assert.equal(etapaParaPassagem(['Agendado', 'Sofia qualifica', 'Sofia qualifica']), 'Agendado', 'a rodada marcou, a relida ainda não mostra');
  assert.equal(etapaParaPassagem(['', 'Agendado', '']), 'Agendado', 'a rodada começou sem etapa e a agenda gravou «Agendado» no meio');
  assert.equal(etapaParaPassagem(['Sofia qualifica', 'Frio', 'Novo lead']), 'Frio');
  assert.equal(etapaParaPassagem(['Sofia qualifica', undefined, 'Novo lead']), 'Sofia qualifica');
  assert.equal(etapaParaPassagem(['', null, '']), '');
});

test('o «horário da IA acabou enquanto ela pensava» (#476) vem ANTES do preço: a mensagem não sai, nem o aviso, e a conversa não é passada à equipe', async () => {
  const r = await sofia('A consulta é R$ 280 no dia.', 'ligado');
  const a = portas(r);
  // expediente da equipe quinta 6h30–18h: às 20h a IA atende (aberta); às 15h UTC (12h SP) a equipe atende (fechada)
  const comHorario = unidade({ businessHoursEnabled: true, businessHoursExpediente: { thu: { start: '06:30', end: '18:00' } }, businessHoursTimezone: 'America/Sao_Paulo' });
  let leituras = 0;
  a.p.unidade = async () => comHorario;
  a.p.mensagens = async () => (leituras++, [{ message_type: 0, content: 'quanto custa?', private: false }]);
  a.p.agora = () => new Date(leituras >= 2 ? '2026-11-26T15:00:00Z' : '2026-11-27T01:00:00Z');
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'fora-do-horario');
  assert.deepEqual(a.publicas, [], 'nada vai ao paciente: nem a mensagem, nem o aviso do preço');
  assert.equal(a.equipe.length, 0);
});
