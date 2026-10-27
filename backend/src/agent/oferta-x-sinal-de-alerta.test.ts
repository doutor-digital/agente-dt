/**
 * A oferta da campanha (#126) e o sinal de alerta / sem pronto-socorro (#129) no MESMO turno.
 *
 * O merge do #126 com o #129 juntou `ofertaDaCampanha`, `mensagensDoPaciente` e `fraseDeReserva` no mesmo
 * `ContextoDoGuardrail` (guardrail.ts) e no mesmo fim de turno (graph.ts). Cada lado tinha teste sozinho; aqui eles
 * correm juntos, com o mesmo encadeamento do `graph.ts`: rede do sinal (passarPorSinalNoTurno) -> guardrail com o contexto
 * montado igual ao grafo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';

import { aplicarGuardrail } from './guardrail.js';
import { passarPorSinalNoTurno } from './passe-por-sinal.js';
import { falasDoTurno, fraseDoPasse } from './sinal-de-alerta.js';
import { confirmouConsultaNoTurno } from './venda-em-alerta.js';
import { pacienteFalouDePs } from './sem-pronto-socorro.js';
import { marcouNesteTurno } from './reserva-sem-marcar.js';
import { retornoDaEquipe } from '../lib/retorno-da-equipe.js';
import { semDiminutivo } from '../lib/sem-diminutivo.js';
import { semIntimidade } from '../lib/sem-intimidade.js';

const OFERTA = 'Consulta de avaliação por R$ 150 (em vez de R$ 280) para quem marcar até 31/10. Vale para uma pessoa por consulta.';

const unit = {
  id: 'u1',
  slug: 'doutor-hernia-canaa',
  name: 'Doutor Hérnia Canaã',
  category: 'saude',
  spineEnabled: false,
  sourceProdutos: 'Consulta presencial: R$ 350 no dia, ou R$ 280 antecipado.',
  sourcePapel: null,
  sourceNegocio: null,
  spineBookingRequiresPayment: false,
} as unknown as Unit;

function ferramentas(resultadoPausa = 'OK — IA pausada no lead 7 (3ms).') {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const tools = [
    { name: 'pausar_ia', invoke: async (a: Record<string, unknown>) => (chamadas.push({ nome: 'pausar_ia', args: a }), resultadoPausa) },
    { name: 'resumir_lead_para_sdr', invoke: async (a: Record<string, unknown>) => (chamadas.push({ nome: 'resumir_lead_para_sdr', args: a }), 'ok') },
  ];
  return { chamadas, tools };
}

/**
 * O fim do turno como o graph.ts monta: as falas do paciente, a rede do sinal, `passouPorSinal` e o guardrail com
 * { ...extrasDoGuardrail, mensagensDoPaciente, fraseDeReserva }.
 */
async function fimDoTurno(o: {
  falas: string[];
  textoDoModelo: string;
  oferta?: string | null;
  mensagens?: BaseMessage[];
  resultadoPausa?: string;
}) {
  const { chamadas, tools } = ferramentas(o.resultadoPausa);
  const mensagens = o.mensagens ?? ([new HumanMessage(o.falas.join('\n'))] as BaseMessage[]);
  const mensagensDoPaciente = falasDoTurno(mensagens.map((m) => ({ tipo: m.getType(), texto: String(m.content) })));
  const passe = await passarPorSinalNoTurno({
    unit,
    leadId: 7,
    mensagens,
    falasDoPaciente: mensagensDoPaciente,
    tools,
    recorder: { step: async () => undefined },
    textoFinal: o.textoDoModelo,
  });
  const passouPorSinal = passe.avisou || passe.texto !== o.textoDoModelo;
  // os resultados das ferramentas do turno, como o graph.ts os junta (de trás para a frente até a fala do paciente)
  const doTurno: string[] = [];
  for (let i = mensagens.length - 1; i >= 0 && mensagens[i].getType() !== 'human'; i--) {
    if (mensagens[i].getType() === 'tool') doTurno.push(String(mensagens[i].content));
  }
  const extrasDoGuardrail = { ofertaDaCampanha: o.oferta === undefined ? OFERTA : o.oferta };
  const guard = aplicarGuardrail(semIntimidade(semDiminutivo(passe.texto)), unit, {
    ...extrasDoGuardrail,
    mensagensDoPaciente,
    fraseDeReserva: passouPorSinal ? fraseDoPasse(retornoDaEquipe(unit), pacienteFalouDePs(mensagensDoPaciente)) : undefined,
    consultaMarcada: passouPorSinal && (marcouNesteTurno(doTurno) || confirmouConsultaNoTurno(doTurno)),
  });
  return { passe, passouPorSinal, guard, chamadas, mensagensDoPaciente };
}

/** O modelo já pausou a IA com a flag de sinal de alerta neste turno (então a rede de código não mexe). */
const modeloJaAvisou = (fala: string): BaseMessage[] => [
  new HumanMessage(fala),
  new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'pausar_ia', args: { motivo: 'x', sinalDeAlerta: true } }] }),
  new ToolMessage({ content: 'OK — IA pausada', tool_call_id: 'a' }),
];

// ── (a) campanha sem sinal de alerta: o R$ da oferta passa ──

test('(a) paciente da campanha pergunta preço, sem sinal de alerta: o R$ 150 da oferta NÃO é cortado nem trocado pelo da ficha', async () => {
  const texto = 'Pela campanha a consulta de avaliação fica R$ 150 antecipado, até 31/10. Quer que eu veja um horário?';
  const r = await fimDoTurno({ falas: ['oi, quanto custa a consulta?'], textoDoModelo: texto });
  assert.equal(r.passe.avisou, false, 'sem sinal a rede do passe não mexe');
  assert.equal(r.passouPorSinal, false);
  assert.equal(r.chamadas.length, 0, 'sem sinal ninguém é pausado');
  assert.equal(r.guard.text, texto);
  assert.deepEqual(r.guard.triggered, []);
  assert.equal(r.guard.rewritten, false);
});

test('(a) controle: o mesmo texto SEM a oferta no contexto é corrigido para o valor da ficha (prova que o teste enxerga o bug)', async () => {
  const texto = 'Pela campanha a consulta de avaliação fica R$ 150 antecipado, até 31/10. Quer que eu veja um horário?';
  const r = await fimDoTurno({ falas: ['oi, quanto custa a consulta?'], textoDoModelo: texto, oferta: null });
  assert.equal(r.guard.rewritten, true);
  assert.doesNotMatch(r.guard.text, /R\$\s*150/);
});

test('(a) a oferta e o corte do pronto-socorro convivem no mesmo texto: sai a frase do PS, o R$ 150 fica intacto', () => {
  // Mesma chamada que o graph faz quando o modelo (que já avisou a equipe) escreve as duas coisas juntas.
  const r = aplicarGuardrail(
    'Pela campanha fica R$ 150 antecipado. Se piorar, procure o pronto-socorro mais próximo. Quer ver um horário?',
    unit,
    { ofertaDaCampanha: OFERTA, mensagensDoPaciente: ['quanto custa a consulta?'] },
  );
  assert.equal(r.text, 'Pela campanha fica R$ 150 antecipado. Quer ver um horário?');
  assert.ok(r.triggered.some((t) => t.startsWith('pronto_socorro_ou_cirurgia')));
  assert.ok(!r.triggered.some((t) => /^preco/.test(t)), 'o R$ da oferta não vira "fora do catálogo"');
});

test('(a) ter a oferta no contexto não muda o corte do pronto-socorro (com ou sem oferta o resultado é o mesmo)', () => {
  const texto = 'Entendi 🙏 Procure o pronto-socorro mais próximo. A equipe já foi avisada.';
  const com = aplicarGuardrail(texto, unit, { ofertaDaCampanha: OFERTA, mensagensDoPaciente: ['estou com dor'] });
  const sem = aplicarGuardrail(texto, unit, { ofertaDaCampanha: null, mensagensDoPaciente: ['estou com dor'] });
  assert.equal(com.text, 'Entendi 🙏 A equipe já foi avisada.');
  assert.deepEqual(com, sem);
});

// ── (b) sinal de alerta com a oferta no contexto: o corte / a frase de reserva continuam valendo ──

test('(b) sinal de alerta, modelo seguiu vendendo a oferta: a rede pausa com a flag e sai a frase do passe, SEM R$ nem horário', async () => {
  const r = await fimDoTurno({
    falas: ['minha perna está perdendo força'],
    textoDoModelo: 'Entendi! Pela campanha a avaliação fica R$ 150 antecipado. Que tal quarta às 9h?',
  });
  assert.equal(r.passe.avisou, true);
  assert.equal(r.chamadas[0].nome, 'pausar_ia');
  assert.equal(r.chamadas[0].args.sinalDeAlerta, true);
  assert.match(r.guard.text, /avisei a nossa equipe, com prioridade/);
  assert.doesNotMatch(r.guard.text, /R\$|150|quarta|pronto|UPA|hospital/i);
});

test('(b) o modelo já avisou e a resposta é SÓ o pronto-socorro: o corte leva tudo e sai a frase do passe (não a de reserva do #129 de "me conta mais")', async () => {
  const r = await fimDoTurno({
    falas: ['não consigo segurar o xixi'],
    mensagens: modeloJaAvisou('não consigo segurar o xixi'),
    textoDoModelo: 'Procure o pronto-socorro mais próximo.',
  });
  assert.equal(r.passouPorSinal, true);
  assert.equal(r.guard.rewritten, true);
  assert.ok(r.guard.triggered.some((t) => t.startsWith('pronto_socorro_ou_cirurgia')));
  assert.match(r.guard.text, /avisei a nossa equipe, com prioridade/);
  assert.doesNotMatch(r.guard.text, /me conta um pouquinho mais|pronto|R\$/i);
});

test('(b) o modelo já avisou e a frase do PS carrega o R$ da oferta: a frase inteira sai e o R$ não vaza por baixo', async () => {
  const r = await fimDoTurno({
    falas: ['não consigo segurar o xixi'],
    mensagens: modeloJaAvisou('não consigo segurar o xixi'),
    textoDoModelo: 'Procure o pronto-socorro, e depois a avaliação sai por R$ 150 antecipado.',
  });
  assert.match(r.guard.text, /avisei a nossa equipe, com prioridade/);
  assert.doesNotMatch(r.guard.text, /R\$|150|pronto/i);
});

test('(b) fora de turno de alerta o corte total cai na frase de reserva padrão (o contexto da oferta não a troca)', () => {
  const r = aplicarGuardrail('Procure o pronto-socorro mais próximo.', unit, {
    ofertaDaCampanha: OFERTA,
    mensagensDoPaciente: ['quanto custa?'],
  });
  assert.match(r.text, /Me conta um pouquinho mais do que você está sentindo/);
  assert.doesNotMatch(r.text, /R\$/);
});

// ── (b2) o corte do PS deixa venda para trás num turno de alerta: sai SÓ a frase do passe ──

test('(b2) alerta + modelo já avisou: "Procure o PS. Pela campanha fica R$ 150. Quer ver um horário?" sai SÓ a frase do passe', async () => {
  const r = await fimDoTurno({
    falas: ['minha perna está perdendo força'],
    mensagens: modeloJaAvisou('minha perna está perdendo força'),
    textoDoModelo: 'Procure o pronto-socorro mais próximo. Pela campanha a avaliação fica R$ 150 antecipado. Quer ver um horário?',
  });
  assert.equal(r.passouPorSinal, true);
  assert.equal(r.guard.text, fraseDoPasse(retornoDaEquipe(unit), false));
  assert.doesNotMatch(r.guard.text, /R\$|150|quer ver|pronto/i);
  assert.ok(r.guard.triggered.includes('alerta_com_venda'));
  assert.ok(r.guard.triggered.some((t) => t.startsWith('pronto_socorro_ou_cirurgia')));
  assert.equal(r.guard.rewritten, true);
});

test('(b2) alerta + corte do PS: horário solto ou só a pergunta de agendamento também levam a frase do passe', async () => {
  for (const texto of [
    'Procure o pronto-socorro. Tenho quarta às 9h livre.',
    'Procure o pronto-socorro. Posso agendar a sua consulta?',
    'Procure o pronto-socorro. Quer que eu veja a vaga de amanhã?',
    'Procure o pronto-socorro. Tenho vaga às 9h30.',
    'Procure o pronto-socorro. Temos vaga amanhã, é só me falar.',
    'Procure o pronto-socorro. A avaliação sai por 150 reais.',
  ]) {
    const r = await fimDoTurno({
      falas: ['não consigo segurar o xixi'],
      mensagens: modeloJaAvisou('não consigo segurar o xixi'),
      textoDoModelo: texto,
    });
    assert.equal(r.guard.text, fraseDoPasse(retornoDaEquipe(unit), false), texto);
  }
});

test('(b2) fora de turno de alerta nada muda: o PS é cortado e o R$ da oferta e a pergunta ficam', () => {
  const r = aplicarGuardrail(
    'Procure o pronto-socorro mais próximo. Pela campanha a avaliação fica R$ 150 antecipado. Quer ver um horário?',
    unit,
    { ofertaDaCampanha: OFERTA, mensagensDoPaciente: ['quanto custa a consulta?'] },
  );
  assert.equal(r.text, 'Pela campanha a avaliação fica R$ 150 antecipado. Quer ver um horário?');
  assert.ok(!r.triggered.includes('alerta_com_venda'));
});

test('(b2) turno de alerta em que o corte do PS deixa só o aviso limpo: o aviso atravessa intacto', async () => {
  const r = await fimDoTurno({
    falas: ['minha perna está perdendo força'],
    mensagens: modeloJaAvisou('minha perna está perdendo força'),
    textoDoModelo: 'Sinto muito 🙏 Já avisei a nossa equipe, com prioridade. Procure o pronto-socorro mais próximo.',
  });
  assert.equal(r.guard.text, 'Sinto muito 🙏 Já avisei a nossa equipe, com prioridade.');
  assert.ok(!r.guard.triggered.includes('alerta_com_venda'));
});

test('(b2) pergunta clínica do aviso ("desde quarta?", "mais de 2 horas?") não é venda: o aviso fica, só o PS sai', async () => {
  const r = await fimDoTurno({
    falas: ['minha perna está perdendo força'],
    mensagens: modeloJaAvisou('minha perna está perdendo força'),
    textoDoModelo: 'Já avisei a nossa equipe 🙏 Isso começou desde quarta? Faz mais de 2 horas que você não sente a perna? Procure o pronto-socorro.',
  });
  assert.equal(r.guard.text, 'Já avisei a nossa equipe 🙏 Isso começou desde quarta? Faz mais de 2 horas que você não sente a perna?');
  assert.ok(!r.guard.triggered.includes('alerta_com_venda'));
});

test('(b2) turno de alerta SEM nada a cortar: a resposta do modelo (aviso limpo) atravessa intacta', async () => {
  const texto = 'Sinto muito 🙏 Já avisei a nossa equipe, com prioridade, e ela te chama em instantes.';
  const r = await fimDoTurno({
    falas: ['minha perna está perdendo força'],
    mensagens: modeloJaAvisou('minha perna está perdendo força'),
    textoDoModelo: texto,
  });
  assert.equal(r.guard.text, texto);
  assert.deepEqual(r.guard.triggered, []);
});

// ── (b3) rodada do sênior no #143 ──

test('(b3) BLOQUEANTE: o modelo marcou consulta e a confirmação traz a frase de PS: só o PS sai, dia, hora, R$ e endereço chegam', async () => {
  const fala = 'minha perna está perdendo força, pode marcar pela campanha?';
  const mensagens: BaseMessage[] = [
    new HumanMessage(fala),
    new AIMessage({ content: '', tool_calls: [{ id: 'g', name: 'agendar_consulta', args: { hora: '09:00' } }] }),
    new ToolMessage({ content: 'Consulta marcada para quarta às 09:00.', tool_call_id: 'g' }),
  ];
  const r = await fimDoTurno({
    falas: [fala],
    mensagens,
    textoDoModelo: 'Marcado pela campanha: quarta às 9h, R$ 150 antecipado 🙏 Se piorar, procure o pronto-socorro mais próximo.',
  });
  assert.equal(r.passouPorSinal, true);
  assert.equal(r.guard.text, 'Marcado pela campanha: quarta às 9h, R$ 150 antecipado 🙏');
  assert.ok(r.guard.triggered.some((t) => t.startsWith('pronto_socorro_ou_cirurgia')));
  assert.ok(!r.guard.triggered.includes('alerta_com_venda'));
});

test('(b3) lacuna: "[valor antecipado]" só vira R$ depois do preenchimento; a venda é pega mesmo assim', async () => {
  const r = await fimDoTurno({
    falas: ['não consigo segurar o xixi'],
    mensagens: modeloJaAvisou('não consigo segurar o xixi'),
    textoDoModelo: 'Procure o pronto-socorro. A avaliação sai por [valor antecipado].',
  });
  assert.equal(r.guard.text, fraseDoPasse(retornoDaEquipe(unit), false));
  assert.ok(r.guard.triggered.includes('alerta_com_venda'));
  assert.ok(r.guard.triggered.some((t) => t.startsWith('lacuna_preenchida')));
});

test('(b3) venda que escapava (às 9, marcá-la, agendá-lo, reservá-la, 150,00, cento e cinquenta, posso garantir, Pix, disponibilidade): vira a frase do passe', async () => {
  for (const venda of [
    'Amanhã às 9 está bom.',
    'Quer que eu tente marcá-la para amanhã?',
    'Posso agendá-lo para quarta.',
    'Vou reservá-la agora.',
    'A avaliação sai por 150,00.',
    'A avaliação sai por cento e cinquenta.',
    'A avaliação sai por duzentos e cinquenta reais.',
    'Fica mil reais.',
    'Posso garantir o seu lugar.',
    'Te mando o Pix.',
    'Tenho disponibilidade amanhã.',
    'Quarta às 14 horas fica bom.',
    'Posso abrir sua agenda ainda hoje?',
    'Já deixei sua reserva, é só confirmar o agendamento.',
    'De acordo, podemos iniciar quarta às 9h.',
    'Marquei para quinta.',
    'Quer que eu veja um horário?',
    'Quer que eu veja um horário pra você?',
    'Quer que eu veja os horários de quinta pra você? 😊',
    'Quer que eu veja as opções pra você?',
    'Fica 150 à vista.',
    'Você pode vir às 9 da manhã?',
    'Tenho qua. às 9h.',
    'Posso remarcar a sua consulta para quinta?',
    'Quarta às 9h a doutora avalia a sua dor.',
    'Quarta às 9h a nossa equipe te atende.',
    'Posso te passar os valores?',
    'Amanhã cedo tem espaço com a doutora, te interessa?',
    'A condição da campanha vale só até sexta, aproveita!',
    'Consigo te atender quarta de manhã.',
    'Quarta de manhã fica bom pra você?',
    'Mando o link de pagamento?',
    'Deixo separado o das 9h pra você?',
  ]) {
    const r = await fimDoTurno({
      falas: ['não consigo segurar o xixi'],
      mensagens: modeloJaAvisou('não consigo segurar o xixi'),
      textoDoModelo: `Procure o pronto-socorro. ${venda}`,
    });
    assert.equal(r.guard.text, fraseDoPasse(retornoDaEquipe(unit), false), venda);
  }
});

test('(b3) triagem clínica NÃO é venda: horas, datas e "marca" da pergunta clínica atravessam; só o PS sai', async () => {
  for (const pergunta of [
    'Isso piorou nas últimas 24h?',
    'A dor começou há 3h?',
    'Faz 48h sem urinar?',
    'A dor começou às 7h?',
    'Tem algum horário do dia em que piora?',
    'Começou desde as 14:30?',
    'Isso começou desde 20/10?',
    'De 0 a 10, a dor está 8/10?',
    'Quer que eu peça pra equipe ligar?',
    'Tem marca roxa na região?',
    'Tem dificuldade na marcha?',
    'Isso começou desde quarta?',
    'Faz mais de 2 horas que você não sente a perna?',
    'Você consegue andar?',
    'Sente formigamento?',
    'Ela te responde amanhã (quinta) às 8h.',
    'Hoje às 15h a dor aumentou?',
    'Hoje as 2 pernas doem?',
    'Em qual horário a dor fica pior?',
    'Você está disponível para a equipe te ligar agora?',
    'Posso ver com a equipe se ela te liga ainda hoje?',
    'Quer que eu peça pra equipe te ligar?',
    'Você prefere que a equipe ligue hoje ou amanhã?',
    'Na segunda às 10h a perna já estava fraca?',
    'Hoje às 6h você conseguiu urinar normalmente?',
    'Você tomou algum remédio hoje às 8h?',
  ]) {
    const r = await fimDoTurno({
      falas: ['minha perna está perdendo força'],
      mensagens: modeloJaAvisou('minha perna está perdendo força'),
      textoDoModelo: `Já avisei a nossa equipe 🙏 ${pergunta} Procure o pronto-socorro.`,
    });
    assert.equal(r.guard.text, `Já avisei a nossa equipe 🙏 ${pergunta}`, pergunta);
    assert.ok(!r.guard.triggered.includes('alerta_com_venda'), pergunta);
  }
});

test('(b3) o agendar_consulta FALHOU e o modelo oferece outro horário em turno de alerta: sem confirmação para proteger, sai a frase do passe', async () => {
  const fala = 'minha perna está perdendo força, pode marcar pela campanha?';
  const mensagens: BaseMessage[] = [
    new HumanMessage(fala),
    new AIMessage({ content: '', tool_calls: [{ id: 'g', name: 'agendar_consulta', args: { hora: '09:00' } }] }),
    new ToolMessage({ content: 'RECUSADO: horário indisponível.', tool_call_id: 'g' }),
  ];
  const r = await fimDoTurno({
    falas: [fala],
    mensagens,
    textoDoModelo: 'Esse horário caiu. Tenho quinta às 9h por R$ 150, serve? Se piorar, procure o pronto-socorro.',
  });
  assert.equal(r.guard.text, fraseDoPasse(retornoDaEquipe(unit), false));
  assert.ok(r.guard.triggered.includes('alerta_com_venda'));
});

test('(b3) remarcar / confirmar presença / cancelar que deram certo + frase de PS: o dia novo chega ao paciente (modelo pausou sozinho)', async () => {
  const fala = 'minha perna está perdendo força';
  const turno = (ferramenta: string, resultado: string): BaseMessage[] => [
    new HumanMessage(fala),
    new AIMessage({ content: '', tool_calls: [
      { id: 'p', name: 'pausar_ia', args: { motivo: 'x', sinalDeAlerta: true } },
      { id: 'f', name: ferramenta, args: {} },
    ] }),
    new ToolMessage({ content: 'OK — IA pausada', tool_call_id: 'p' }),
    new ToolMessage({ content: resultado, tool_call_id: 'f' }),
  ];
  const PS = ' Se piorar, procure o pronto-socorro.';
  for (const [ferramenta, resultado, texto] of [
    ['remarcar_consulta', 'Remarcada de terça, 11/11 às 14:00 para quarta, 12/11 às 09:00.', 'Pronto, remarquei para quarta, 12/11, às 9h.'],
    ['confirmar_presenca', 'Presença confirmada para quarta, 12/11 às 09:00. Agradeça.', 'Presença confirmada para quarta, 12/11, às 9h 🙏'],
    ['cancelar_consulta', 'Consulta de quarta, 12/11 às 09:00 cancelada. Confirme ao paciente e pergunte se ele quer remarcar.', 'Cancelei a sua consulta de quarta, 12/11, às 9h. Quer remarcar para outro dia?'],
    ['agendar_consulta', 'RECUSADO: este paciente já tem consulta marcada na clínica em quarta, 12/11 às 09:00. Confirme esse dia e hora.', 'Você já tem consulta marcada na quarta, 12/11, às 9h.'],
  ] as const) {
    const r = await fimDoTurno({ falas: [fala], mensagens: turno(ferramenta, resultado), textoDoModelo: texto + PS });
    assert.equal(r.guard.text, texto, ferramenta);
    assert.ok(!r.guard.triggered.includes('alerta_com_venda'), ferramenta);
  }
});

test('(b3) a ferramenta NÃO deu certo (cancelar sem confirmar, agendar sem vaga): sem confirmação a proteger, venda + PS vira a frase do passe', async () => {
  const fala = 'minha perna está perdendo força';
  for (const [ferramenta, resultado] of [
    ['cancelar_consulta', 'Antes de cancelar, confirme com o paciente.'],
    ['agendar_consulta', '09:00 não está mais disponível (ocupado). A consulta NÃO foi marcada.'],
  ] as const) {
    const mensagens: BaseMessage[] = [
      new HumanMessage(fala),
      new AIMessage({ content: '', tool_calls: [{ id: 'f', name: ferramenta, args: {} }] }),
      new ToolMessage({ content: resultado, tool_call_id: 'f' }),
    ];
    const r = await fimDoTurno({ falas: [fala], mensagens, textoDoModelo: 'Quer ver outro horário? Se piorar, procure o pronto-socorro.' });
    assert.equal(r.guard.text, fraseDoPasse(retornoDaEquipe(unit), false), ferramenta);
  }
});

// ── (c) as duas ao mesmo tempo: o aviso urgente prevalece ──

test('(c) pergunta o preço E diz o sinal de alerta: sai o aviso urgente, o preço da oferta fica para depois', async () => {
  const r = await fimDoTurno({
    falas: ['quanto custa a consulta? minha perna está perdendo força e não consigo segurar o xixi'],
    textoDoModelo: 'Pela campanha a consulta de avaliação fica R$ 150 antecipado, até 31/10. Quer ver um horário?',
  });
  assert.equal(r.passe.avisou, true);
  assert.equal(r.chamadas.find((c) => c.nome === 'pausar_ia')?.args.sinalDeAlerta, true);
  assert.match(r.guard.text, /avisei a nossa equipe, com prioridade/);
  assert.doesNotMatch(r.guard.text, /R\$|150|quer ver/i);
});

test('(c) a pausa FALHOU duas vezes: ainda assim sai a frase honesta (sem "avisei") e o R$ da oferta não vaza', async () => {
  const r = await fimDoTurno({
    falas: ['quanto custa? minha perna está perdendo força'],
    textoDoModelo: 'Pela campanha fica R$ 150 antecipado. Quer ver um horário?',
    resultadoPausa: 'falhou: kommo fora do ar',
  });
  assert.equal(r.passe.avisou, false);
  assert.equal(r.passouPorSinal, true, 'a frase do passe trocou o texto: a refeita da pergunta final não pode vender de novo');
  assert.doesNotMatch(r.guard.text, /avisei|R\$|150/i);
  assert.match(r.guard.text, /segue com a nossa equipe/);
});

test('(c) o paciente falou em pronto-socorro, a frase do passe não desaconselha e atravessa o guardrail intacta (com a oferta no contexto)', async () => {
  const r = await fimDoTurno({
    falas: ['devo ir ao pronto-socorro? também queria saber o preço, minha perna está perdendo força'],
    textoDoModelo: 'Pela campanha fica R$ 150 antecipado. Quer ver um horário?',
  });
  assert.match(r.guard.text, /Se você sentir que não dá para esperar, pode ir/);
  assert.deepEqual(r.guard.triggered, [], 'o guardrail não corta nem reescreve a frase do passe');
  assert.doesNotMatch(r.guard.text, /R\$|150/);
});

test('(c) o modelo marcou consulta na oferta E o paciente tem sinal: a confirmação dele fica e o R$ da oferta passa', async () => {
  const fala = 'minha perna está perdendo força, pode marcar pela campanha?';
  const mensagens: BaseMessage[] = [
    new HumanMessage(fala),
    new AIMessage({ content: '', tool_calls: [{ id: 'g', name: 'agendar_consulta', args: { hora: '09:00' } }] }),
    new ToolMessage({ content: 'Consulta marcada para quarta às 09:00.', tool_call_id: 'g' }),
  ];
  const texto = 'Marcado pela campanha: quarta às 9h, R$ 150 antecipado 🙏';
  const r = await fimDoTurno({ falas: [fala], mensagens, textoDoModelo: texto });
  assert.equal(r.passe.avisou, true);
  assert.equal(r.guard.text, texto);
});

// ── a costura no graph.ts ──

test('graph.ts: as DUAS chamadas do guardrail do fim do turno levam oferta + falas do paciente, e a final leva a frase de reserva', () => {
  const src = readFileSync(new URL('./graph.ts', import.meta.url), 'utf8');
  assert.match(src, /const extrasDoGuardrail = \{ ofertaDaCampanha: /);
  const final = /aplicarGuardrail\(semIntimidade\(semDiminutivo\(textoFinal\)\), unit, \{([^}]*)\}\)/s.exec(src);
  assert.ok(final, 'chamada final do guardrail não encontrada');
  assert.match(final[1], /\.\.\.extrasDoGuardrail/);
  assert.match(final[1], /mensagensDoPaciente/);
  assert.match(final[1], /fraseDeReserva: passouPorSinal \?/);
  const cta = /aplicarGuardrail\(textoFinal, unit, \{([^}]*)\}\)/s.exec(src);
  assert.ok(cta, 'chamada da pergunta final não encontrada');
  assert.match(cta[1], /mensagensDoPaciente/);
  assert.match(cta[1], /\.\.\.extrasDoGuardrail/);
  // Linhas inteiras (não só o começo): cada uma fecha uma mutação que antes sobrevivia. Comparação sem espaços nem
  // quebras de linha: reformatar o graph.ts não quebra o teste, mudar o código quebra.
  const semEspaco = (t: string) => t.replace(/\s+/g, '');
  const srcCompacto = semEspaco(src);
  for (const linha of [
    'const extrasDoGuardrail = { ofertaDaCampanha: ofertaDoTurno.valor?.oferta ?? null };',
    'fraseDeReserva: passouPorSinal ? fraseDoPasse(retornoDaEquipe(unit), pacienteFalouDePs(mensagensDoPaciente)) : undefined,',
    'if (cta.precisaRefazer && !passouPorSinal && !respostaFixa && ',
    'const passouPorSinal = passe.avisou || passe.texto !== textoFinal;',
    'const marcouAgora = marcouNesteTurno(doTurno);',
    'consultaMarcada: passouPorSinal && (marcouAgora || confirmouConsultaNoTurno(doTurno)),',
  ]) {
    assert.ok(srcCompacto.includes(semEspaco(linha)), `graph.ts perdeu a linha: ${linha}`);
  }
  // nenhuma chamada do guardrail no graph pode ficar sem o contexto da oferta
  for (const m of src.matchAll(/aplicarGuardrail\(/g)) {
    const trecho = src.slice(m.index, m.index + 260);
    assert.match(trecho, /extrasDoGuardrail/, `aplicarGuardrail sem o contexto da oferta: ${trecho.slice(0, 80)}`);
  }
});
