import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import {
  dadosDaTaxa,
  insistenciaJaTratada,
  jaEncaminhouAInsistencia,
  RECADO_INSISTIU_NA_CLINICA,
  RECADO_INSISTIU_SEM_PROMESSA,
  recadoDaChave,
  recadoPagarNaClinica,
  type ContextoDaTaxa,
} from './taxa-de-reserva.js';
import { aplicarTaxaDeReservaNaSaida, decidirATaxa, type FerramentasDaTaxa } from './taxa-de-reserva-saida.js';
import { aplicarGuardrail } from './guardrail.js';
import { pagouOAntecipado } from '../lib/follow-up-worker.js';

const unidade = {
  category: 'saude',
  spineBookingRequiresPayment: true,
  pixKey: '12.345.678/0001-90',
  pixHolder: 'Clinica Teste Ltda',
  sourceProdutos: 'Consulta: R$ 100 antecipado (taxa de agendamento) ou R$ 250 no dia.',
  sourcePapel: null,
  sourceNegocio: null,
  systemPrompt: '',
} as unknown as Unit;
const DADOS = dadosDaTaxa(unidade)!;
const CTX: ContextoDaTaxa = {
  falasDoPaciente: [],
  consultaDePe: false,
  emTratamento: false,
  respostaAnterior: '',
  comprovanteLido: false,
  jaMandouComprovante: false,
  insistenciaJaEncaminhada: false,
};
const com = (o: Partial<ContextoDaTaxa>): ContextoDaTaxa => ({ ...CTX, ...o });

/** Ferramentas falsas que contam as chamadas; cada teste troca só o que importa. */
function ferramentas(over: Partial<FerramentasDaTaxa> = {}) {
  const passos: Array<{ kind: string; title: string; payload?: unknown }> = [];
  const chamadas = { resumir: 0, tarefa: 0, vinculo: 0, cartao: 0, focos: [] as string[] };
  const f: FerramentasDaTaxa = {
    recorder: { step: async (p: { kind: string; title: string; payload?: unknown }) => void passos.push(p) } as never,
    leadId: 123,
    consultaGravada: async () => {
      chamadas.vinculo++;
      return false;
    },
    cartaoDizPago: async () => {
      chamadas.cartao++;
      return false;
    },
    resumir: {
      invoke: async (input) => {
        chamadas.resumir++;
        chamadas.focos.push(input.focusHint);
        return 'Nota interna criada no lead 123';
      },
    },
    abrirTarefa: async () => {
      chamadas.tarefa++;
      return 'criada';
    },
    ...over,
  };
  return { f, passos, chamadas };
}

const INSISTE = com({ falasDoPaciente: ['só pago na clínica mesmo'], respostaAnterior: recadoPagarNaClinica(DADOS) });
const erros = <T extends { kind: string }>(passos: T[]) => passos.filter((p) => p.kind === 'ERROR');

// --- o que o prompt não trouxe: consulta gravada e cartão pago -------------------------------------------------------------------

test('item 1: cartão com "✓ Consulta pg antecipado" marcado — quem já pagou não recebe "horário não garantido" + chave', async () => {
  const { f, passos, chamadas } = ferramentas({ cartaoDizPago: async () => pagouOAntecipado([{ field_name: '✓ Consulta pg antecipado', values: [{ value: true }] }]) });
  for (const [resposta, fala] of [
    ['Já deixei tudo registrado com a equipe pra te receber direito às 14h', 'ok'],
    ['A equipe te envia a chave certa', 'ok'],
    ['Tudo bem!', 'só pago na clínica'],
  ] as const) {
    const r = await aplicarTaxaDeReservaNaSaida(resposta, DADOS, com({ falasDoPaciente: [fala] }), f);
    assert.equal(r.texto, resposta);
    assert.equal(r.troca, null);
    assert.equal(r.liberadaPor, 'cartao_pago');
  }
  assert.equal(chamadas.resumir + chamadas.tarefa, 0);
  assert.equal(erros(passos).length, 0);
});

test('item 1: cartão pago e o paciente PEDE a chave de forma explícita → a chave sai (só o pedido explícito é atendido)', async () => {
  const { f } = ferramentas({ cartaoDizPago: async () => true });
  const r = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, com({ falasDoPaciente: ['qual a chave do pix?'] }), f);
  assert.equal(r.troca?.motivo, 'equipe_envia_a_chave');
  assert.equal(r.texto, recadoDaChave(DADOS));
});

test('item 1: a regra do campo é a de lib/follow-up-worker (a FORMA escolhida "¤ Pagamento antecipado" não prova pagamento)', async () => {
  const escolheu = pagouOAntecipado([{ field_name: '¤ Pagamento antecipado', values: [{ value: true }] }]);
  assert.equal(escolheu, false);
  const { f } = ferramentas({ cartaoDizPago: async () => escolheu });
  const r = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, com({ falasDoPaciente: ['e o pix?'] }), f);
  assert.equal(r.troca?.motivo, 'equipe_envia_a_chave');
});

test('2ª rodada, item 1: sem poder ler o cartão, o pedido EXPLÍCITO da chave recebe a chave (como com o cartão pago) e o rastro avisa', async () => {
  const { f, passos } = ferramentas({ cartaoDizPago: async () => Promise.reject(new Error('kommo 500')) });
  const r = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, com({ falasDoPaciente: ['Mande o pix por gentileza'] }), f);
  assert.equal(r.troca?.motivo, 'equipe_envia_a_chave');
  assert.equal(r.texto, recadoDaChave(DADOS));
  assert.equal(erros(passos).length, 1);
  assert.match(erros(passos)[0].title, /não consegui ler o cartão/);
});

test('2ª rodada, item 1: sem poder ler o cartão, o que NÃO é pedido explícito sai como veio — não se pede de novo a quem pode ter pago', async () => {
  const { f, passos } = ferramentas({ cartaoDizPago: async () => Promise.reject(new Error('kommo 500')) });
  for (const [resposta, fala] of [
    ['A equipe te envia a chave certa', 'ok'],
    ['Já deixei tudo registrado com a equipe pra te receber direito às 14h', 'ok'],
    ['Tudo bem!', 'só pago na clínica'],
    ['A equipe te envia a chave certa', 'ok, vou pagar no pix agora'],
  ] as const) {
    const r = await aplicarTaxaDeReservaNaSaida(resposta, DADOS, com({ falasDoPaciente: [fala] }), f);
    assert.equal(r.texto, resposta);
    assert.equal(r.troca, null);
    assert.equal(r.liberadaPor, 'cartao_ilegivel');
  }
  assert.equal(erros(passos).length, 4);
});

test('item 10: o vínculo da consulta anula a troca (e nem lê o cartão)', async () => {
  const { f, chamadas } = ferramentas({
    consultaGravada: async () => {
      return true;
    },
  });
  for (const ctx of [com({ falasDoPaciente: ['e o pix?'] }), INSISTE]) {
    const r = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, ctx, f);
    assert.equal(r.troca, null);
    assert.equal(r.liberadaPor, 'consulta_gravada');
  }
  assert.equal(chamadas.cartao + chamadas.resumir + chamadas.tarefa, 0);
});

test('item 10: sem a trava disparar nada é lido — nem vínculo, nem cartão, nem passo no rastro', async () => {
  const { f, passos, chamadas } = ferramentas();
  const r = await aplicarTaxaDeReservaNaSaida('Qual horário fica melhor pra você?', DADOS, com({ falasDoPaciente: ['quero agendar'] }), f);
  assert.equal(r.troca, null);
  assert.equal(chamadas.vinculo + chamadas.cartao + passos.length, 0);
  const sem = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', null, com({ falasDoPaciente: ['e o pix?'] }), f);
  assert.equal(sem.troca, null);
  assert.equal(chamadas.vinculo + chamadas.cartao + passos.length, 0);
});

test('decidirATaxa só LÊ: não escreve passo, não abre tarefa, não chama o resumo (serve para conferir reescritas)', async () => {
  const { f, passos, chamadas } = ferramentas();
  const d = await decidirATaxa('Tudo bem!', DADOS, INSISTE, f);
  assert.equal(d.troca?.motivo, 'insistiu_na_clinica');
  assert.equal(chamadas.resumir + chamadas.tarefa + passos.length, 0);
});

// --- insistência: resumo e tarefa só aí, uma vez por conversa --------------------------------------------------------------------

test('item 10: o resumo e a tarefa só saem na insistência — chave pedida, clínica na 1ª vez e horário sem comprovante não chamam', async () => {
  const { f, chamadas } = ferramentas();
  await aplicarTaxaDeReservaNaSaida('Perfeito!', DADOS, com({ falasDoPaciente: ['e o pix?'] }), f);
  await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, com({ falasDoPaciente: ['só pago na clínica'] }), f);
  await aplicarTaxaDeReservaNaSaida('Até já às 13h30', DADOS, com({ falasDoPaciente: ['ok'] }), f);
  assert.equal(chamadas.resumir + chamadas.tarefa, 0);
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.equal(r.troca?.motivo, 'insistiu_na_clinica');
  assert.equal(chamadas.resumir, 1);
  assert.equal(chamadas.tarefa, 1);
  assert.match(chamadas.focos[0], /INSISTE em pagar só na clínica/);
});

test('item 3: quatro turnos de insistência = UM resumo, UMA tarefa, UM recado', async () => {
  const { f, chamadas } = ferramentas();
  let respostaAnterior = recadoPagarNaClinica(DADOS);
  let insistenciaJaEncaminhada = false;
  const saidas: string[] = [];
  for (const fala of ['só na clínica', 'na clínica mesmo', 'pago na hora', 'já disse, pago no dia']) {
    const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, com({ falasDoPaciente: [fala], respostaAnterior, insistenciaJaEncaminhada }), f);
    saidas.push(r.texto);
    respostaAnterior = r.texto;
    insistenciaJaEncaminhada = insistenciaJaEncaminhada || jaEncaminhouAInsistencia(r.texto);
  }
  assert.equal(chamadas.resumir, 1);
  assert.equal(chamadas.tarefa, 1);
  assert.equal(saidas.filter((t) => t === RECADO_INSISTIU_NA_CLINICA).length, 1);
  assert.deepEqual(saidas.slice(1), ['Tudo bem!', 'Tudo bem!', 'Tudo bem!']);
});

// --- item 2: só promete o que saiu -----------------------------------------------------------------------------------------------

test('item 2: com a tarefa e o resumo saídos, o recado promete que a equipe fala com ele', async () => {
  const { f } = ferramentas();
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.equal(r.texto, RECADO_INSISTIU_NA_CLINICA);
  assert.equal(r.equipeAvisada, true);
});

test('item 2: sem a ferramenta de resumo mas com a tarefa → promete (a equipe recebeu a tarefa)', async () => {
  const { f, chamadas } = ferramentas({ resumir: undefined });
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.equal(r.texto, RECADO_INSISTIU_NA_CLINICA);
  assert.equal(chamadas.tarefa, 1);
});

test('item 2: tarefa repetida (já havia uma nas últimas 24 h) conta como equipe avisada', async () => {
  const { f } = ferramentas({ resumir: undefined, abrirTarefa: async () => 'repetida' });
  assert.equal((await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f)).texto, RECADO_INSISTIU_NA_CLINICA);
});

test('item 2: sem ferramenta nenhuma, ou com tudo falhando, o recado NÃO promete e o rastro tem o ERRO', async () => {
  for (const over of [
    { resumir: undefined, abrirTarefa: undefined },
    { resumir: { invoke: async () => 'ERRO: sem permissão' }, abrirTarefa: async () => 'falhou' as const },
    { resumir: { invoke: async () => Promise.reject(new Error('openai 429')) }, abrirTarefa: async () => Promise.reject(new Error('kommo 500')) },
    { resumir: { invoke: async () => 'Sem histórico de mensagens pra resumir (lead 123).' }, abrirTarefa: undefined },
  ] as Array<Partial<FerramentasDaTaxa>>) {
    const { f, passos } = ferramentas(over);
    const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
    assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA);
    assert.equal(r.equipeAvisada, false);
    assert.doesNotMatch(r.texto, /equipe/i);
    assert.ok(erros(passos).some((p) => /NADA chegou à equipe/.test(p.title)), JSON.stringify(passos.map((p) => p.title)));
  }
});

test('item 2: sem o cartão do lead (leadId nulo) não há como avisar a equipe — não promete', async () => {
  const { f } = ferramentas({ leadId: null });
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA);
});

test('item 2: o resumo falhou mas a tarefa saiu → promete, e o rastro registra que o RESUMO não saiu', async () => {
  const { f, passos } = ferramentas({ resumir: { invoke: async () => 'ERRO: openai 429' } });
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.equal(r.texto, RECADO_INSISTIU_NA_CLINICA);
  assert.match(erros(passos)[0].title, /resumo para a equipe NÃO saiu/);
});

// --- item 10: o prazo CANCELA a chamada ------------------------------------------------------------------------------------------

test('item 10: prazo estourado — a resposta sai, o sinal é abortado e o passo de ERRO diz que a chamada foi cancelada', async () => {
  let sinal: AbortSignal | undefined;
  const { f, passos } = ferramentas({
    prazoDoResumoMs: 20,
    abrirTarefa: undefined,
    resumir: {
      invoke: (_input, config) => {
        sinal = config?.signal;
        return new Promise(() => undefined); // nunca responde
      },
    },
  });
  const t0 = Date.now();
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.ok(Date.now() - t0 < 1000, 'não esperou a chamada pendurada');
  assert.equal(sinal?.aborted, true);
  assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA);
  assert.ok(erros(passos).some((p) => /estourou o prazo \(chamada cancelada\)/.test(p.title)));
});

test('item 10: a ferramenta real do resumo para de gravar quando o sinal aborta (a nota não sai depois do "NÃO saiu")', async () => {
  let notasGravadas = 0;
  // o mesmo contrato de `resumir_lead_para_sdr` em tools.ts: confere o sinal depois do LLM e antes de gravar a nota
  const resumir = new DynamicStructuredTool({
    name: 'resumir_lead_para_sdr',
    description: 'teste',
    schema: z.object({ leadId: z.number(), focusHint: z.string().optional() }),
    func: async ({ leadId }, _rm, config) => {
      await new Promise((r) => setTimeout(r, 120)); // o LLM demora mais que o prazo
      if (config?.signal?.aborted) return `ERRO: resumo cancelado (prazo) antes de gravar a nota do lead ${leadId}.`;
      notasGravadas++;
      return 'Nota interna criada';
    },
  });
  const { f } = ferramentas({ prazoDoResumoMs: 20, abrirTarefa: undefined, resumir: resumir as never });
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  await new Promise((res) => setTimeout(res, 250)); // dá tempo da chamada pendurada terminar
  assert.equal(notasGravadas, 0);
  assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA);
});

test('item 10: ferramenta que lança de forma síncrona não derruba a resposta', async () => {
  const { f } = ferramentas({
    resumir: {
      invoke: () => {
        throw new Error('boom síncrono');
      },
    },
    abrirTarefa: () => {
      throw new Error('boom síncrono da tarefa');
    },
  });
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA);
});

// --- item 10: o texto sai inteiro depois do guardrail ----------------------------------------------------------------------------

test('item 10: todo texto que sai da taxa atravessa o guardrail sem mudar', async () => {
  const cenarios: Array<[string, ContextoDaTaxa, Partial<FerramentasDaTaxa>?]> = [
    ['A equipe te envia a chave certa', com({ falasDoPaciente: ['e o pix?'] })],
    ['Fica na Av. Ville Roy, 1234. A chave a equipe te envia.', com({ falasDoPaciente: ['e o pix?', 'qual o endereço?'] })],
    ['Até já às 13h30', com({ falasDoPaciente: ['ok'] })],
    ['Quer que eu te passe a chave Pix?', com({ falasDoPaciente: ['só pago na hora'] })],
    ['Tudo bem!', INSISTE],
    ['Tudo bem!', INSISTE, { resumir: undefined, abrirTarefa: undefined }],
  ];
  for (const [resposta, ctx, over] of cenarios) {
    const { f } = ferramentas(over);
    const r = await aplicarTaxaDeReservaNaSaida(resposta, DADOS, ctx, f);
    assert.ok(r.troca, resposta);
    const g = aplicarGuardrail(r.texto, unidade);
    assert.deepEqual(g.triggered, [], r.texto);
    assert.equal(g.text, r.texto);
    assert.match(r.texto, /\S/);
  }
  const chave = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, com({ falasDoPaciente: ['e o pix?'] }), ferramentas().f);
  assert.equal(chave.texto, recadoDaChave(DADOS));
});

test('item 2 (revisão): a tarefa também tem prazo — um Kommo travado não segura a resposta ao paciente', { timeout: 5000 }, async () => {
  const { f, passos } = ferramentas({ prazoDoResumoMs: 20, resumir: undefined, abrirTarefa: () => new Promise(() => undefined) });
  const t0 = Date.now();
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, f);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA);
  assert.ok(erros(passos).length >= 1);
});

test('item 2 (revisão): se NADA chegou à equipe o João é avisado; se algo chegou, não', async () => {
  const alertas: string[] = [];
  const nada = ferramentas({ resumir: undefined, abrirTarefa: undefined, alertar: async (t) => void alertas.push(t), slug: 'boa-vista' });
  await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, nada.f);
  assert.equal(alertas.length, 1);
  assert.match(alertas[0], /boa-vista.*lead 123.*NADA confirmado chegou à equipe/);
  const ok = ferramentas({ alertar: async (t) => void alertas.push(t) });
  await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, ok.f);
  assert.equal(alertas.length, 1);
  const quebrado = ferramentas({ resumir: undefined, abrirTarefa: undefined, alertar: async () => Promise.reject(new Error('telegram fora')) });
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, quebrado.f);
  assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA, 'o alerta que falha não derruba a resposta');
});

test('item 1 (revisão): a leitura do cartão e a do vínculo têm prazo — um Kommo travado não segura a resposta', { timeout: 5000 }, async () => {
  const pendurada = () => new Promise<boolean>(() => undefined);
  const a = ferramentas({ cartaoDizPago: pendurada, prazoDaLeituraMs: 20 });
  const r = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, com({ falasDoPaciente: ['ok'] }), a.f);
  assert.equal(r.texto, 'A equipe te envia a chave certa');
  assert.equal(r.liberadaPor, 'cartao_ilegivel');
  // 2ª rodada: o prazo estourado no cartão é o cartão ilegível — o pedido explícito da chave ainda recebe a chave
  const pediu = ferramentas({ cartaoDizPago: pendurada, prazoDaLeituraMs: 20 });
  const rp = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, com({ falasDoPaciente: ['e o pix?'] }), pediu.f);
  assert.equal(rp.troca?.motivo, 'equipe_envia_a_chave');
  assert.equal(rp.texto, recadoDaChave(DADOS));
  const b = ferramentas({ consultaGravada: pendurada, prazoDaLeituraMs: 20 });
  const r2 = await aplicarTaxaDeReservaNaSaida('A equipe te envia a chave certa', DADOS, com({ falasDoPaciente: ['e o pix?'] }), b.f);
  assert.equal(r2.troca?.motivo, 'equipe_envia_a_chave', 'sem ler o vínculo, a trava segue (como antes)');
});

// --- 2ª rodada, itens 7 e 9 ----------------------------------------------------------------------------------------------------------

test('2ª rodada, item 7: tarefa e resumo falhando em 6 turnos de insistência = UM alerta, UM recado, a chave UMA vez', async () => {
  const alertas: string[] = [];
  const { f } = ferramentas({
    resumir: { invoke: async () => 'ERRO: openai 429' },
    abrirTarefa: async () => 'falhou',
    alertar: async (t) => void alertas.push(t),
  });
  const respostas = [recadoPagarNaClinica(DADOS)];
  const saidas: string[] = [];
  for (const fala of ['só na clínica', 'na clínica mesmo', 'pago na hora', 'já disse, pago no dia', 'só pago lá', 'na clínica']) {
    const r = await aplicarTaxaDeReservaNaSaida(
      'Tudo bem!',
      DADOS,
      com({ falasDoPaciente: [fala], respostaAnterior: respostas[respostas.length - 1], insistenciaJaEncaminhada: insistenciaJaTratada(respostas) }),
      f,
    );
    saidas.push(r.troca?.motivo ?? 'null');
    respostas.push(r.texto);
  }
  assert.deepEqual(saidas, ['insistiu_na_clinica', 'null', 'null', 'null', 'null', 'null']);
  assert.equal(alertas.length, 1);
  assert.equal(respostas.filter((t) => t.includes('Chave Pix:')).length, 1);
});

test('2ª rodada, item 9: o rastro registra o texto que o paciente RECEBE (sem promessa quando nada chegou à equipe), não o previsto', async () => {
  const sem = ferramentas({ resumir: undefined, abrirTarefa: undefined });
  const r = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, sem.f);
  const passo = sem.passos.find((p) => /💳/.test(p.title));
  assert.equal((passo!.payload as { final: string }).final, r.texto);
  assert.equal(r.texto, RECADO_INSISTIU_SEM_PROMESSA);
  const com1 = ferramentas();
  const r2 = await aplicarTaxaDeReservaNaSaida('Tudo bem!', DADOS, INSISTE, com1.f);
  assert.equal((com1.passos.find((p) => /💳/.test(p.title))!.payload as { final: string }).final, r2.texto);
  assert.equal(r2.texto, RECADO_INSISTIU_NA_CLINICA);
});

test('2ª rodada, item 4: na insistência o endereço fica, com e sem a promessa da equipe', async () => {
  const resposta = 'Fica na Av. Ville Roy, 1234. Tudo bem, entendo!';
  const ok = await aplicarTaxaDeReservaNaSaida(resposta, DADOS, INSISTE, ferramentas().f);
  assert.match(ok.texto, /^Fica na Av\. Ville Roy, 1234\. Tudo bem, entendo!\n\nAnotei que você prefere pagar na clínica e a equipe vai falar/);
  const sem = await aplicarTaxaDeReservaNaSaida(resposta, DADOS, INSISTE, ferramentas({ resumir: undefined, abrirTarefa: undefined }).f);
  assert.match(sem.texto, /^Fica na Av\. Ville Roy, 1234\. Tudo bem, entendo!\n\nEntendi que você prefere pagar na clínica\. Só que, sem a taxa/);
  assert.doesNotMatch(sem.texto, /equipe/i);
  assert.equal(sem.equipeAvisada, false);
  const g = aplicarGuardrail(sem.texto, unidade);
  assert.deepEqual(g.triggered, []);
  assert.equal(g.text, sem.texto);
});
