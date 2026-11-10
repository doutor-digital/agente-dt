/**
 * Sinal por Pix da Sofia 2.0 (flag `Unit.sinalPixCentavos`): o que muda NO TEXTO e nas travas do agente quando a flag está ligada, e a
 * prova de que SEM a flag nada muda (as mesmas frases de sempre).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { unidadeComSinal, intencaoDoDegrauParaAUnidade } from './pagamento-da-unidade.js';
import { fraseDePrecoComSinal, renderFatosDaUnidade, renderRulesGlobal, sinalDaUnidade } from './prompt-composer.js';
import { orientacaoDePagamento, porQueNaoReservar, buildAgendarConsulta, buildAgendaTools } from './agenda-tools.js';
import { aplicarGuardrail } from './guardrail.js';
import { corrigirValorAntecipado } from './valor-antecipado.js';
import { decidirPagamentoAntecipado } from './carimbos-do-agendamento.js';
import { regraDePagamento } from './follow-up.js';
import { degrauDoPixNaoSeAplica } from '../lib/follow-up-worker.js';
import { textoDoSinal } from './sinal-pix-tool.js';
import type { TraceRecorder } from './trace-recorder.js';

const FONTES = 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.';
const CHAVE_FIXA = '12.345.678/0001-90';

function unidade(over: Record<string, unknown> = {}): Unit {
  return {
    id: 'u-arag',
    slug: 'doutor-hernia-araguaina',
    name: 'Araguaína',
    category: 'saude',
    spineEnabled: true,
    spineBookingRequiresPayment: false,
    acceptsAdvancePayment: true,
    pixKey: CHAVE_FIXA,
    pixHolder: 'Clinica LTDA',
    sourceProdutos: FONTES,
    sourcePapel: null,
    sourceNegocio: null,
    systemPrompt: '',
    sinalPixCentavos: null,
    ...over,
  } as unknown as Unit;
}
const comSinal = (over: Record<string, unknown> = {}) => unidade({ sinalPixCentavos: 5000, ...over });

test('unidadeComSinal: só com centavos positivos; taxa de reserva e sem-antecipado vencem a flag', () => {
  assert.equal(unidadeComSinal(unidade()), false);
  assert.equal(unidadeComSinal(comSinal()), true);
  assert.equal(unidadeComSinal({ sinalPixCentavos: 0 }), false);
  assert.equal(unidadeComSinal({ sinalPixCentavos: -5 }), false);
  assert.equal(unidadeComSinal({ sinalPixCentavos: 50.5 }), false);
  assert.equal(unidadeComSinal(comSinal({ spineBookingRequiresPayment: true })), false);
  assert.equal(unidadeComSinal(comSinal({ acceptsAdvancePayment: false })), false);
  assert.equal(unidadeComSinal(null), false);
});

test('sinalDaUnidade: R$ 50 + R$ 200 = R$ 250 (o antecipado das fontes) ou R$ 350 no dia; sem preço legível ou sinal ≥ preço, null', () => {
  assert.deepEqual(sinalDaUnidade(comSinal()), { sinal: 50, comSinal: 250, noDia: 350, restoNoDia: 200 });
  assert.equal(sinalDaUnidade(unidade()), null);
  assert.equal(sinalDaUnidade(comSinal({ sourceProdutos: 'Consulta de avaliação.' })), null);
  assert.equal(sinalDaUnidade(comSinal({ sinalPixCentavos: 25000 })), null);
  assert.equal(sinalDaUnidade(comSinal({ sinalPixCentavos: 30000 })), null);
  assert.equal(fraseDePrecoComSinal(sinalDaUnidade(comSinal())!), 'R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50 (R$ 50 agora por Pix + R$ 200 no dia)');
});

// ── a porta do agendamento ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('porQueNaoReservar: SEM sinal a pergunta é a de sempre (Pix antecipado ou na clínica)', () => {
  const m = porQueNaoReservar({ diaConfirmado: true });
  assert.match(m!, /Pix antecipado \(valor antecipado\) ou na clínica no dia/);
  assert.match(m!, /\[\[botoes: Pix antecipado \| Na clínica\]\]/);
  // sinal_pix não vale numa unidade sem sinal
  assert.match(porQueNaoReservar({ diaConfirmado: true, formaPagamento: 'sinal_pix' })!, /forma de pagamento|como ele prefere pagar/);
});

test('porQueNaoReservar: COM sinal a pergunta é "sinal de R$ 50 agora ou tudo no dia" e sinal_pix libera', () => {
  const sinal = sinalDaUnidade(comSinal());
  const m = porQueNaoReservar({ diaConfirmado: true, sinal })!;
  assert.match(m, /sinal de R\$ 50 agora por Pix \(a consulta fica R\$ 250, com R\$ 200 no dia\) ou pagar tudo no dia \(R\$ 350\)/);
  assert.match(m, /\[\[botoes: Sinal de R\$ 50 \| Pagar no dia\]\]/);
  assert.doesNotMatch(m, /Pix antecipado/);
  assert.equal(porQueNaoReservar({ diaConfirmado: true, formaPagamento: 'sinal_pix', sinal }), null);
  assert.equal(porQueNaoReservar({ diaConfirmado: true, formaPagamento: 'na_clinica', sinal }), null);
});

test('orientacaoDePagamento: sem sinal, a chave fixa e o valor antecipado de sempre', () => {
  const o = orientacaoDePagamento('pix_antecipado', unidade());
  assert.match(o, new RegExp(`A chave Pix é ${CHAVE_FIXA.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(o, /O valor antecipado é R\$ 250/);
  assert.match(orientacaoDePagamento('na_clinica', unidade()), /Ele escolheu PAGAR NA CLÍNICA/);
});

test('orientacaoDePagamento: com sinal, NUNCA a chave fixa; sinal manda chamar gerar_sinal_pix e dizer R$ 200 no dia; na clínica diz R$ 350', () => {
  const u = comSinal();
  const sinal = orientacaoDePagamento('sinal_pix', u);
  assert.match(sinal, /gerar_sinal_pix/);
  assert.match(sinal, /R\$ 250: R\$ 50 de sinal pelo Pix agora \(envie o link\) \+ R\$ 200 no dia/);
  assert.match(sinal, /NUNCA envie chave Pix nem diga que a equipe envia a chave/);
  assert.ok(!sinal.includes(CHAVE_FIXA));
  const dia = orientacaoDePagamento('na_clinica', u);
  assert.match(dia, /R\$ 350 na clínica/);
  assert.ok(!dia.includes(CHAVE_FIXA));
  // mesmo que o modelo mande o valor antigo, a chave fixa não sai
  assert.ok(!orientacaoDePagamento('pix_antecipado', u).includes(CHAVE_FIXA));
});

// ── o texto que o código injeta no prompt ───────────────────────────────────────────────────────────────────────────────────────

test('renderFatosDaUnidade: sem sinal a chave fixa e o "antecipado"; com sinal, a frase do sinal e nenhuma chave', () => {
  const antes = renderFatosDaUnidade(unidade());
  assert.match(antes, new RegExp(`Chave Pix: ${CHAVE_FIXA.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(antes, /Consulta: R\$ 250 antecipado \(pago antes\) ou R\$ 350 no dia/);
  const depois = renderFatosDaUnidade(comSinal());
  assert.ok(!depois.includes(CHAVE_FIXA));
  assert.doesNotMatch(depois, /Chave Pix:/);
  assert.match(depois, /R\$ 350 no dia, ou R\$ 250 garantindo com sinal de R\$ 50 \(R\$ 50 agora por Pix \+ R\$ 200 no dia\)/);
  assert.match(depois, /gerar_sinal_pix/);
});

test('renderRulesGlobal: o passo "Pix" vira "sinal" e os botões, "Sinal de R$ 50 | Pagar no dia" — só com a flag', () => {
  const sem = renderRulesGlobal(unidade());
  assert.match(sem, /dia → horário → dados → Pix\./);
  assert.match(sem, /"Pix antecipado" ou "Na clínica"/);
  const com = renderRulesGlobal(comSinal());
  assert.match(com, /dia → horário → dados → sinal \(Pix\)/);
  assert.match(com, /"Sinal de R\$ 50" ou "Pagar no dia"/);
  assert.doesNotMatch(com, /"Pix antecipado" ou "Na clínica"/);
});

// ── a régua de follow-up ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('régua: o degrau que manda a CHAVE FIXA não roda na unidade com sinal; nas outras, como sempre', () => {
  assert.equal(degrauDoPixNaoSeAplica({ soPix: true }, 'pix_antecipado', unidade()), false);
  assert.equal(degrauDoPixNaoSeAplica({ soPix: true }, 'pix_antecipado', comSinal()), true);
  assert.equal(degrauDoPixNaoSeAplica({ soPix: true }, 'sinal_pix', comSinal()), true);
  assert.equal(degrauDoPixNaoSeAplica({ soPix: false }, 'sinal_pix', comSinal()), false);
});

test('régua: "Achou caro … antecipado de R$ 150" sai do texto na unidade com sinal, e a regra da unidade diz os preços reais', () => {
  const achouCaro = 'Reancore no custo de não tratar. Deixe ele fazer a conta. Termine oferecendo o antecipado de R$ 150.';
  assert.equal(intencaoDoDegrauParaAUnidade(achouCaro, unidade()), achouCaro);
  assert.equal(intencaoDoDegrauParaAUnidade(achouCaro, comSinal()), achouCaro, 'sem o aviso de que a unidade tem sinal legível, o texto não muda');
  const novo = intencaoDoDegrauParaAUnidade(achouCaro, comSinal(), true);
  assert.doesNotMatch(novo, /antecipad|150/);
  assert.equal(regraDePagamento(unidade()), '');
  const regra = regraDePagamento(comSinal());
  assert.match(regra, /não existe chave Pix nem "pagamento antecipado"/);
  assert.match(regra, /R\$ 350 no dia, ou R\$ 250 garantindo com sinal de R\$ 50/);
});

// ── os guardrails de saída ───────────────────────────────────────────────────────────────────────────────────────────────────

test('flag ligada mas fontes sem os dois preços: NADA do sinal vale (chave fixa e botões de sempre) — a Sofia não fica sem Pix', () => {
  const u = comSinal({ sourceProdutos: 'Consulta de avaliação.' });
  assert.equal(sinalDaUnidade(u), null);
  assert.match(renderFatosDaUnidade(u), new RegExp(`Chave Pix: ${CHAVE_FIXA.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(renderRulesGlobal(u), /"Pix antecipado" ou "Na clínica"/);
  assert.equal(degrauDoPixNaoSeAplica({ soPix: true }, 'pix_antecipado', u), false);
  assert.ok(aplicarGuardrail('Para garantir, o Pix é [chave]. Pode ser?', u).text.includes(CHAVE_FIXA));
  assert.equal(regraDePagamento(u), '');
});

test('guardrail: com sinal, R$ 50 e R$ 200 e o link do Asaas passam inteiros; sem a flag o R$ 200 (fora da ficha) é corrigido como sempre', () => {
  const texto = 'Fica R$ 250 com o sinal: R$ 50 agora por este Pix https://www.asaas.com/c/725104409743 e R$ 200 no dia. Pode ser?';
  const com = aplicarGuardrail(texto, comSinal());
  assert.equal(com.text, texto);
  assert.equal(com.rewritten, false);
  assert.deepEqual(com.triggered, []);
  const sem = aplicarGuardrail(texto, unidade());
  assert.equal(sem.rewritten, true);
  assert.ok(sem.triggered.some((t) => t.startsWith('preco_corrigido:')));
});

test('guardrail: "sinal antecipado de R$ 50" NÃO vira R$ 250 com a flag; sem a flag a trava do antecipado age como sempre', () => {
  const texto = 'Para garantir o horário é só o sinal de R$ 50 antecipado pelo Pix.';
  assert.equal(aplicarGuardrail(texto, comSinal()).text, texto);
  assert.equal(aplicarGuardrail(texto, unidade()).text, 'Para garantir o horário é só o sinal de R$ 250 antecipado pelo Pix.');
  assert.deepEqual(corrigirValorAntecipado('R$ 50 antecipado', { antecipado: 250, valoresLegitimos: [50, 200] }), { texto: 'R$ 50 antecipado', corrigiu: [] });
  assert.deepEqual(corrigirValorAntecipado('R$ 50 antecipado', { antecipado: 250 }).corrigiu, [50]);
});

test('guardrail: valor inventado continua barrado com a flag (R$ 150 vira um preço da ficha, nunca R$ 50/200)', () => {
  const r = aplicarGuardrail('A consulta fica R$ 150, pode ser?', comSinal());
  assert.equal(r.rewritten, true);
  assert.doesNotMatch(r.text, /R\$ (50|200)\b/);
  assert.match(r.text, /R\$ (250|350)/);
});

test('guardrail: "[chave]" não vira a chave fixa da clínica com a flag; sem a flag é preenchida como sempre', () => {
  const texto = 'Para garantir, o Pix é [chave] no nome de Clinica LTDA. Pode ser?';
  const com = aplicarGuardrail(texto, comSinal());
  assert.ok(!com.text.includes(CHAVE_FIXA));
  assert.ok(com.triggered.some((t) => t.startsWith('lacuna:')));
  const sem = aplicarGuardrail(texto, unidade());
  assert.ok(sem.text.includes(CHAVE_FIXA));
});

// ── o carimbo do cartão ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('decidirPagamentoAntecipado: sinal escolhido NÃO é pago (Não até o Asaas confirmar); sem forma nada muda', () => {
  const base = { ehRetorno: false, pagamentoComprovado: false };
  assert.equal(decidirPagamentoAntecipado({ ...base, formaPagamento: 'sinal_pix' }).valor, 'Não');
  assert.equal(decidirPagamentoAntecipado({ ...base, escolhaSalva: 'sinal_pix', valorAtual: null }).valor, 'Não');
  // remarcar depois de pago não derruba o Sim
  assert.equal(decidirPagamentoAntecipado({ ...base, escolhaSalva: 'sinal_pix', valorAtual: 'Sim' }).valor, null);
  assert.equal(decidirPagamentoAntecipado({ ...base, formaPagamento: 'pix_antecipado' }).valor, 'Sim');
  assert.equal(decidirPagamentoAntecipado({ ...base, formaPagamento: 'na_clinica' }).valor, 'Não');
});

// ── a ferramenta ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const recorder = { traceId: 't', step: async () => undefined } as unknown as TraceRecorder;

test('buildAgendaTools: gerar_sinal_pix só existe com a flag; a lista das demais é a de sempre', () => {
  const sem = buildAgendaTools({ unit: unidade(), recorder }).map((t) => t.name);
  const com = buildAgendaTools({ unit: comSinal(), recorder }).map((t) => t.name);
  assert.ok(!sem.includes('gerar_sinal_pix'));
  assert.ok(com.includes('gerar_sinal_pix'));
  assert.deepEqual(com.filter((n) => n !== 'gerar_sinal_pix'), sem);
  // flag ligada mas fontes sem preço legível: a Sofia não ganha uma ferramenta de sinal sem número
  assert.ok(!buildAgendaTools({ unit: comSinal({ sourceProdutos: 'Consulta.' }), recorder }).map((t) => t.name).includes('gerar_sinal_pix'));
});

test('agendar_consulta: o esquema de formaPagamento é o de sempre; com a flag o valor é o mesmo (pix_antecipado = sinal) e a descrição diz o que ele significa', () => {
  const forma = (u: Unit) => {
    const sch = buildAgendarConsulta({ unit: u, recorder }).schema as unknown as { shape: { formaPagamento: { _def: { innerType: { options: string[] } }; description?: string } } };
    return sch.shape.formaPagamento;
  };
  assert.deepEqual(forma(unidade())._def.innerType.options, ['pix_antecipado', 'na_clinica']);
  const f = forma(comSinal());
  // o prompt da Sofia 2.0 manda `pix_antecipado` para o sinal: o esquema continua o mesmo, só a descrição diz o que o valor significa
  assert.deepEqual(f._def.innerType.options, ['pix_antecipado', 'na_clinica']);
  assert.match(f.description ?? '', /pix_antecipado \(= o SINAL de R\$ 50 agora por Pix; a consulta fica R\$ 250\)/);
  assert.match(buildAgendarConsulta({ unit: comSinal(), recorder }).description, /gerar_sinal_pix/);
  assert.doesNotMatch(buildAgendarConsulta({ unit: unidade(), recorder }).description, /sinal/i);
});

test('textoDoSinal: link novo, link repetido, já pago e falha — nunca chave Pix, nunca "confirmado"', () => {
  const s = sinalDaUnidade(comSinal())!;
  const novo = textoDoSinal({ tipo: 'link', url: 'https://www.asaas.com/c/1', novo: true, valor: 50, venceEm: '2026-11-14' }, s, true);
  assert.match(novo, /https:\/\/www\.asaas\.com\/c\/1/);
  assert.match(novo, /vale até 14\/11/);
  assert.match(novo, /R\$ 250 \(R\$ 50 agora \+ R\$ 200 no dia\)/);
  assert.doesNotMatch(novo, /MESMO link/);
  assert.match(textoDoSinal({ tipo: 'link', url: 'https://www.asaas.com/c/1', novo: false, valor: 50, venceEm: '2026-11-14' }, s, true), /MESMO link já gerado antes: NÃO gere outro/);
  assert.match(textoDoSinal({ tipo: 'ja-pago' }, s, true), /JÁ foi pago/);
  const falha = textoDoSinal({ tipo: 'falhou', motivo: 'asaas', detalhe: 'x' }, s, true);
  assert.match(falha, /a equipe envia o Pix do sinal por aqui em instantes/);
  assert.match(falha, /NÃO invente link nem chave Pix/);
  assert.match(textoDoSinal({ tipo: 'falhou', motivo: 'asaas', detalhe: 'x' }, s, false), /O aviso à equipe NÃO saiu: NÃO prometa/);
  for (const t of [novo, falha]) assert.doesNotMatch(t, /12\.345/);
});
