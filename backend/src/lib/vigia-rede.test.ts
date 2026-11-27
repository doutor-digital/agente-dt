import test from 'node:test';
import assert from 'node:assert/strict';
import {
  avaliar,
  classeDominante,
  decidir,
  duracao,
  emSilencioNoturno,
  familiaDoModelo,
  horaBrasilia,
  LIMIARES,
  montarTexto,
  rodarVigia,
  suprimir,
  type EstadoAlerta,
  type Observacao,
  type Problema,
} from './vigia-rede.js';
import { leituraEmMemoria, storeEmMemoria, type ChamadaLlm, type FraseEnviada } from './vigia-rede-memoria.js';

const ANTHROPIC_SEM_SALDO =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Ch"}';
const OPENAI_SEM_SALDO =
  '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
// 27/11/2026 15:00 UTC = 12:00 em Brasília (fora do silêncio noturno)
const T0 = Date.parse('2026-11-27T15:00:00Z');
const d = (t: number) => new Date(t);

function obsVazia(agora = d(T0)): Observacao {
  return {
    agora,
    errosSaldoJanela: [],
    errosFalhaJanela: [],
    totaisFalhaJanela: { anthropic: { ok: 50, erro: 0 }, openai: { ok: 20, erro: 0 } },
    totaisParadaJanela: { anthropic: { ok: 100, erro: 0 }, openai: { ok: 40, erro: 0 } },
    ultimoSucesso: { anthropic: agora, openai: agora },
    baseline: [100, 90, 110, 80, 95, 120, 100],
    frases: { mensagens: 0, conversas: 0, unidades: [] },
  };
}
const achar = (ps: Problema[], chave: string) => {
  const p = ps.find((x) => x.chave === chave);
  assert.ok(p, `problema ${chave} existe`);
  return p;
};

test('familiaDoModelo: decide pelo modelo, não pelo rótulo provider (chamadas do Claude aparecem como "openai")', () => {
  assert.equal(familiaDoModelo('claude-sonnet-5'), 'anthropic');
  assert.equal(familiaDoModelo('claude-haiku-5-5'), 'anthropic');
  assert.equal(familiaDoModelo('gpt-4o-mini'), 'openai');
  assert.equal(familiaDoModelo(null), 'openai');
});

test('tudo normal: nenhum problema ativo', () => {
  const ps = avaliar(obsVazia());
  assert.deepEqual(ps.filter((p) => p.ativo), []);
});

test('CRÉDITO: as duas frases reais separam Anthropic e OpenAI, cada uma com o seu aviso', () => {
  const obs = obsVazia();
  obs.errosSaldoJanela = [
    { familia: 'anthropic', mensagem: ANTHROPIC_SEM_SALDO, chamadas: 12, unidades: ['Caxias', 'Salto'], primeiro: d(T0 - 9 * MIN), ultimo: d(T0 - 1 * MIN) },
    { familia: 'openai', mensagem: OPENAI_SEM_SALDO, chamadas: 3, unidades: ['Tatuí'], primeiro: d(T0 - 5 * MIN), ultimo: d(T0 - 2 * MIN) },
  ];
  const ps = avaliar(obs);
  const a = achar(ps, 'credito:anthropic');
  const o = achar(ps, 'credito:openai');
  assert.equal(a.ativo, true);
  assert.equal(o.ativo, true);
  assert.deepEqual(a.unidades, ['Caxias', 'Salto']);
  assert.deepEqual(o.unidades, ['Tatuí']);
  assert.equal(a.vistoEm.getTime(), T0 - 1 * MIN, 'o "visto" do crédito é a hora do último erro');
  const ta = montarTexto(a, 'novo', { agora: d(T0), desde: a.inicioEm });
  assert.match(ta, /console\.anthropic\.com → Plans & Billing/);
  assert.match(ta, /recarga automática/);
  assert.doesNotMatch(ta, /platform\.openai\.com/);
  const to = montarTexto(o, 'novo', { agora: d(T0), desde: o.inicioEm });
  assert.match(to, /platform\.openai\.com → Billing/);
  assert.doesNotMatch(to, /console\.anthropic\.com/);
});

test('CRÉDITO: rate limit (429 por minuto) e erro de chave NÃO são falta de saldo', () => {
  const obs = obsVazia();
  obs.errosSaldoJanela = [
    { familia: 'openai', mensagem: '429 Rate limit reached for gpt-4o on tokens per min', chamadas: 40, unidades: [], primeiro: d(T0 - MIN), ultimo: d(T0) },
    { familia: 'anthropic', mensagem: '400 This API key is not scoped to a workspace', chamadas: 40, unidades: [], primeiro: d(T0 - MIN), ultimo: d(T0) },
  ];
  assert.equal(achar(avaliar(obs), 'credito:openai').ativo, false);
  assert.equal(achar(avaliar(obs), 'credito:anthropic').ativo, false);
});

test('CRÉDITO: só volta com chamada boa DEPOIS do último erro (silêncio da madrugada não prova nada)', () => {
  const estado: EstadoAlerta = { chave: 'credito:anthropic', abertoEm: d(T0 - 3 * H), ultimoVistoEm: d(T0 - 20 * MIN), ultimoAvisoEm: d(T0 - 3 * H), lembretes: 0, resolvidoEm: null };
  const semProva = obsVazia();
  semProva.ultimoSucesso.anthropic = d(T0 - 3 * H); // o último sucesso é ANTERIOR ao erro
  assert.equal(achar(avaliar(semProva), 'credito:anthropic').podeFechar(estado), false);
  const nenhum = obsVazia();
  nenhum.ultimoSucesso.anthropic = null;
  assert.equal(achar(avaliar(nenhum), 'credito:anthropic').podeFechar(estado), false);
  const comProva = obsVazia();
  comProva.ultimoSucesso.anthropic = d(T0 - 5 * MIN);
  assert.equal(achar(avaliar(comProva), 'credito:anthropic').podeFechar(estado), true);
  // o sucesso da OUTRA conta não fecha esta
  const outra = obsVazia();
  outra.ultimoSucesso = { anthropic: d(T0 - 3 * H), openai: d(T0 - MIN) };
  assert.equal(achar(avaliar(outra), 'credito:anthropic').podeFechar(estado), false);
});

test('IA FALHANDO: exige amostra mínima e taxa alta; erro de saldo não conta (tem aviso próprio)', () => {
  const L = LIMIARES;
  const mk = (ok: number, erro: number, saldo = 0) => {
    const obs = obsVazia();
    obs.totaisFalhaJanela.anthropic = { ok, erro: erro + saldo };
    obs.errosFalhaJanela = [
      ...(erro ? [{ familia: 'anthropic' as const, mensagem: '503 {"type":"error","error":{"type":"overloaded_error"}}', chamadas: erro, unidades: ['Caxias'], primeiro: d(T0 - 10 * MIN), ultimo: d(T0) }] : []),
      ...(saldo ? [{ familia: 'anthropic' as const, mensagem: ANTHROPIC_SEM_SALDO, chamadas: saldo, unidades: ['Caxias'], primeiro: d(T0 - 10 * MIN), ultimo: d(T0) }] : []),
    ];
    return achar(avaliar(obs), 'falha:anthropic');
  };
  assert.equal(mk(8, 6).ativo, false, 'amostra pequena (14 < mínimo): 4 de 11 foi a oscilação de 13/11');
  assert.equal(mk(20, 4).ativo, false, '17% é ruído');
  assert.equal(mk(20, 10).ativo, true, '33% com 30 chamadas');
  assert.equal(mk(0, L.falhaMinimoChamadas).ativo, true, '100% com amostra mínima');
  assert.equal(mk(5, 0, 200).ativo, false, 'só erro de saldo: quem avisa é o CRÉDITO');
  assert.equal(mk(20, 10).numeros.pct, 33);
});

test('IA FALHANDO: histerese — só diz que voltou com amostra e taxa bem abaixo do limiar', () => {
  const obs = obsVazia();
  obs.totaisFalhaJanela.anthropic = { ok: 18, erro: 2 }; // 10%: abaixo do limiar de alarme, mas ainda não é "normal"
  obs.errosFalhaJanela = [{ familia: 'anthropic', mensagem: '503', chamadas: 2, unidades: [], primeiro: d(T0), ultimo: d(T0) }];
  const p = achar(avaliar(obs), 'falha:anthropic');
  const estado: EstadoAlerta = { chave: p.chave, abertoEm: d(T0 - H), ultimoVistoEm: d(T0 - 10 * MIN), ultimoAvisoEm: d(T0 - H), lembretes: 0, resolvidoEm: null };
  assert.equal(p.ativo, false);
  assert.equal(p.podeFechar(estado), false);
  obs.totaisFalhaJanela.anthropic = { ok: 19, erro: 1 }; // 5%
  obs.errosFalhaJanela = [{ familia: 'anthropic', mensagem: '503', chamadas: 1, unidades: [], primeiro: d(T0), ultimo: d(T0) }];
  assert.equal(achar(avaliar(obs), 'falha:anthropic').podeFechar(estado), true);
});

test('IA PARADA: zero sucesso só alarma se o normal daquele horário é ter tráfego (madrugada não alarma)', () => {
  const parada = obsVazia();
  parada.totaisParadaJanela = { anthropic: { ok: 0, erro: 0 }, openai: { ok: 0, erro: 0 } };
  assert.equal(achar(avaliar(parada), 'parada').ativo, true);
  assert.equal(achar(avaliar(parada), 'parada').numeros.normal, 100);
  const madrugada = { ...parada, baseline: [3, 5, 2, 8, 4, 0, 6] };
  assert.equal(achar(avaliar(madrugada), 'parada').ativo, false);
  const normal = obsVazia();
  assert.equal(achar(avaliar(normal), 'parada').ativo, false);
});

test('FRASE DE QUEDA: volume e número de pacientes mínimos; voltou só com a IA respondendo', () => {
  const mk = (mensagens: number, conversas: number) => {
    const obs = obsVazia();
    obs.frases = { mensagens, conversas, unidades: ['Caxias'] };
    return achar(avaliar(obs), 'frase');
  };
  assert.equal(mk(3, 3).ativo, false);
  assert.equal(mk(8, 1).ativo, false, 'um paciente reenviando não é queda da rede');
  assert.equal(mk(4, 3).ativo, true);
  const estado: EstadoAlerta = { chave: 'frase', abertoEm: d(T0 - H), ultimoVistoEm: d(T0 - 10 * MIN), ultimoAvisoEm: d(T0 - H), lembretes: 0, resolvidoEm: null };
  assert.equal(mk(0, 0).podeFechar(estado), true);
  const semTrafego = obsVazia();
  semTrafego.totaisParadaJanela = { anthropic: { ok: 0, erro: 0 }, openai: { ok: 0, erro: 0 } };
  assert.equal(achar(avaliar(semTrafego), 'frase').podeFechar(estado), false);
});

test('SUPRESSÃO: saldo cobre "falhando" do mesmo provedor, "parada" e "frase"; sem causa, parada e frase avisam sozinhas', () => {
  const obs = obsVazia();
  obs.errosSaldoJanela = [{ familia: 'anthropic', mensagem: ANTHROPIC_SEM_SALDO, chamadas: 30, unidades: ['Caxias'], primeiro: d(T0 - 9 * MIN), ultimo: d(T0) }];
  obs.totaisFalhaJanela.anthropic = { ok: 0, erro: 30 };
  obs.errosFalhaJanela = obs.errosSaldoJanela;
  obs.totaisFalhaJanela.openai = { ok: 0, erro: 20 };
  obs.errosFalhaJanela = [...obs.errosSaldoJanela, { familia: 'openai', mensagem: '500 internal', chamadas: 20, unidades: ['Salto'], primeiro: d(T0 - 9 * MIN), ultimo: d(T0) }];
  obs.totaisParadaJanela = { anthropic: { ok: 0, erro: 30 }, openai: { ok: 0, erro: 20 } };
  obs.frases = { mensagens: 9, conversas: 6, unidades: ['Caxias'] };
  const ps = suprimir(avaliar(obs));
  const sup = (c: string) => achar(ps, c).suprimidoPor;
  assert.equal(achar(ps, 'credito:anthropic').ativo, true);
  assert.equal(sup('credito:anthropic'), undefined);
  assert.equal(achar(ps, 'falha:anthropic').ativo, false, 'saldo não conta como falha');
  assert.equal(achar(ps, 'falha:openai').ativo, true);
  assert.equal(sup('falha:openai'), undefined, 'falha da OpenAI não tem saldo da OpenAI: avisa');
  assert.ok(sup('parada'));
  assert.ok(sup('frase'));

  const sozinha = obsVazia();
  sozinha.frases = { mensagens: 6, conversas: 5, unidades: ['Caxias'] };
  sozinha.totaisParadaJanela = { anthropic: { ok: 0, erro: 0 }, openai: { ok: 0, erro: 0 } };
  const ps2 = suprimir(avaliar(sozinha));
  assert.equal(achar(ps2, 'frase').suprimidoPor, undefined);
  assert.equal(achar(ps2, 'parada').suprimidoPor, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// decidir
// ---------------------------------------------------------------------------------------------------------------
function problema(extra: Partial<Problema> = {}): Problema {
  return { chave: 'credito:anthropic', tipo: 'credito', familia: 'anthropic', ativo: true, inicioEm: d(T0), vistoEm: d(T0), unidades: [], numeros: {}, podeFechar: () => true, ...extra };
}
const aberto = (extra: Partial<EstadoAlerta> = {}): EstadoAlerta => ({ chave: 'credito:anthropic', abertoEm: d(T0 - H), ultimoVistoEm: d(T0 - 5 * MIN), ultimoAvisoEm: d(T0 - H), lembretes: 0, resolvidoEm: null, ...extra });

test('decidir: 1 aviso quando começa; silêncio por 2 h; lembrete na 2ª hora; voltou só com prova', () => {
  assert.equal(decidir(problema(), null, d(T0)), 'novo');
  assert.equal(decidir(problema({ ativo: false }), null, d(T0)), 'nada');
  assert.equal(decidir(problema(), aberto({ ultimoAvisoEm: d(T0 - 119 * MIN) }), d(T0)), 'atualizar');
  assert.equal(decidir(problema(), aberto({ ultimoAvisoEm: d(T0 - 120 * MIN) }), d(T0)), 'lembrete');
  assert.equal(decidir(problema({ ativo: false }), aberto(), d(T0)), 'voltou');
  assert.equal(decidir(problema({ ativo: false, podeFechar: () => false }), aberto(), d(T0)), 'nada');
});

test('decidir: aviso que não chegou ao Telegram é tentado de novo; problema que nunca foi avisado fecha em silêncio', () => {
  assert.equal(decidir(problema(), aberto({ ultimoAvisoEm: null }), d(T0)), 'novo');
  assert.equal(decidir(problema({ ativo: false }), aberto({ ultimoAvisoEm: null }), d(T0)), 'absorver');
});

test('decidir: o que virou consequência de outro aviso é absorvido, e o já resolvido reabre como novo', () => {
  assert.equal(decidir(problema({ suprimidoPor: 'credito:anthropic' }), aberto(), d(T0)), 'absorver');
  assert.equal(decidir(problema({ suprimidoPor: 'credito:anthropic' }), null, d(T0)), 'nada');
  assert.equal(decidir(problema(), aberto({ resolvidoEm: d(T0 - H) }), d(T0)), 'novo');
});

// ---------------------------------------------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------------------------------------------
test('texto: classe do erro em português, sem repetir a mensagem do provedor', () => {
  const g = (mensagem: string) => [{ familia: 'anthropic' as const, mensagem, chamadas: 3, unidades: [], primeiro: d(T0), ultimo: d(T0) }];
  assert.match(classeDominante(g('400 {"error":{"message":"This API key is not scoped to a workspace"}}')), /chave/);
  assert.match(classeDominante(g('503 overloaded_error')), /5xx/);
  assert.match(classeDominante(g('429 Rate limit reached')), /429/);
  assert.match(classeDominante(g('Request timed out')), /timeout/);
  assert.match(classeDominante(g('400 invalid_request_error The request body is not valid JSON')), /400/);
  assert.equal(classeDominante([]), 'erro desconhecido');
});

test('texto: nenhum aviso carrega texto de paciente nem a mensagem crua do provedor', () => {
  const obs = obsVazia();
  const segredo = 'Maria da Silva 11999998888 quero marcar';
  obs.errosFalhaJanela = [{ familia: 'anthropic', mensagem: `500 erro ${segredo}`, chamadas: 20, unidades: ['Doutor Hérnia Caxias'], primeiro: d(T0 - 10 * MIN), ultimo: d(T0) }];
  obs.totaisFalhaJanela.anthropic = { ok: 10, erro: 20 };
  const p = achar(avaliar(obs), 'falha:anthropic');
  for (const tipo of ['novo', 'lembrete', 'voltou'] as const) {
    const t = montarTexto(p, tipo, { agora: d(T0), desde: d(T0 - 30 * MIN) });
    assert.doesNotMatch(t, /Maria|11999998888|marcar/);
  }
});

test('texto: duração e horário de Brasília', () => {
  assert.equal(duracao(30_000), '1 min');
  assert.equal(duracao(42 * MIN), '42 min');
  assert.equal(duracao(15 * H + 17 * MIN), '15 h 17 min');
  assert.equal(duracao(2 * H), '2 h');
  const agora = d(Date.parse('2026-11-27T15:00:00Z'));
  assert.equal(horaBrasilia(d(Date.parse('2026-11-27T12:05:00Z')), agora), '09:05');
  assert.equal(horaBrasilia(d(Date.parse('2026-11-26T21:55:00Z')), agora), '26/11 18:55');
});

test('silêncio noturno: 22h–7h em Brasília', () => {
  assert.equal(emSilencioNoturno(d(Date.parse('2026-11-27T00:59:00Z'))), false, '21:59 BRT');
  assert.equal(emSilencioNoturno(d(Date.parse('2026-11-27T01:00:00Z'))), true, '22:00 BRT');
  assert.equal(emSilencioNoturno(d(Date.parse('2026-11-27T09:59:00Z'))), true, '06:59 BRT');
  assert.equal(emSilencioNoturno(d(Date.parse('2026-11-27T10:00:00Z'))), false, '07:00 BRT');
  assert.equal(emSilencioNoturno(d(Date.parse('2026-11-27T15:00:00Z'))), false, '12:00 BRT');
});

// ---------------------------------------------------------------------------------------------------------------
// A rodada inteira, contra a mesma queda de 26→27/11 em miniatura
// ---------------------------------------------------------------------------------------------------------------
/** Tráfego normal de 1 chamada/min de cada modelo + o que `extra` acrescentar. */
function trafego(de: number, ate: number, extra: (t: number) => ChamadaLlm[] = () => []): ChamadaLlm[] {
  const out: ChamadaLlm[] = [];
  for (let t = de; t <= ate; t += MIN) out.push(...extra(t));
  return out;
}

test('RODADA: queda de crédito → 1 aviso por conta, lembretes juntos, silêncio de madrugada, 1 "voltou" por conta com duração', async () => {
  // ancora em 26/11 20:00 BRT (23:00Z). Anthropic cai às 21:00Z do dia 27 -> usamos horas relativas a um dia "normal" de 8 dias antes
  const inicio = Date.parse('2026-11-18T00:00:00Z');
  const quedaA = Date.parse('2026-11-26T21:55:00Z');
  const quedaO = Date.parse('2026-11-26T23:41:00Z');
  const voltaO = Date.parse('2026-11-27T11:28:00Z');
  const voltaA = Date.parse('2026-11-27T12:12:00Z');
  const fim = Date.parse('2026-11-27T13:00:00Z');
  const chamadas: ChamadaLlm[] = trafego(inicio, fim, (t) => {
    const a: ChamadaLlm = t >= quedaA && t < voltaA
      ? { t, status: 'error', model: 'claude-sonnet-5', unidade: 'u1', mensagem: ANTHROPIC_SEM_SALDO }
      : { t, status: 'success', model: 'claude-sonnet-5', unidade: 'u1' };
    const o: ChamadaLlm = t >= quedaO && t < voltaO
      ? { t, status: 'error', model: 'gpt-4o', unidade: 'u2', mensagem: OPENAI_SEM_SALDO }
      : { t, status: 'success', model: 'gpt-4o', unidade: 'u2' };
    return [a, o];
  });
  const frases: FraseEnviada[] = [];
  for (let t = quedaA; t < voltaA; t += 20 * MIN) frases.push({ t, conversa: `c${t}`, unidade: 'u1' });
  const leitura = leituraEmMemoria(chamadas, frases, (id) => ({ u1: 'Caxias', u2: 'Salto' })[id] ?? id);
  const store = storeEmMemoria();
  const enviados: string[] = [];

  for (let t = Date.parse('2026-11-26T20:00:00Z'); t <= fim; t += 5 * MIN) {
    await rodarVigia({ leitura, store, agora: d(t), enviar: async (txt) => (enviados.push(txt), true) });
  }
  const novos = enviados.filter((x) => x.startsWith('🔴 SOFIA SEM CRÉDITO'));
  assert.equal(novos.length, 2, 'um aviso de início por conta');
  assert.match(novos[0], /Anthropic/);
  assert.match(novos[1], /OpenAI/);
  const voltou = enviados.filter((x) => x.startsWith('✅'));
  assert.equal(voltou.length, 2);
  assert.match(voltou[0], /OpenAI.*Ficou 11 h/s);
  assert.match(voltou[1], /Anthropic.*Ficou 14 h/s);
  // IA parada, falha e frase são consequência: nenhum aviso próprio
  assert.equal(enviados.filter((x) => /PARADA|FALHANDO|FRASE DE QUEDA/.test(x)).length, 0);
  // lembretes: nunca entre 22h e 7h de Brasília (01:00Z–10:00Z), nunca separados quando as duas contas estão abertas
  const lembretes = enviados.filter((x) => /Ainda sem crédito|Continuam abertos/.test(x));
  assert.ok(lembretes.length >= 1 && lembretes.length <= 6, `lembretes: ${lembretes.length}`);
  assert.ok(enviados.length <= 10, `no máximo 10 mensagens na noite inteira (foram ${enviados.length})`);
  assert.ok([...store.linhas.values()].every((l) => l.resolvidoEm !== null), 'tudo fechado no fim');
});

test('RODADA: estado persistido — reiniciar o processo (novo líder, mesmo banco) não repete o aviso', async () => {
  const chamadas = trafego(T0 - 8 * D, T0, (t) => [
    t > T0 - 30 * MIN
      ? { t, status: 'error', model: 'claude-sonnet-5', unidade: 'u1', mensagem: ANTHROPIC_SEM_SALDO }
      : { t, status: 'success', model: 'claude-sonnet-5', unidade: 'u1' },
  ]);
  const leitura = leituraEmMemoria(chamadas);
  const store = storeEmMemoria();
  const enviados: string[] = [];
  const enviar = async (t: string) => (enviados.push(t), true);
  await rodarVigia({ leitura, store, agora: d(T0 - 20 * MIN), enviar });
  assert.equal(enviados.length, 1);
  // "deploy": outro processo, mesma tabela (a mesma store) — próximo tick não repete
  await rodarVigia({ leitura, store, agora: d(T0 - 15 * MIN), enviar });
  await rodarVigia({ leitura, store, agora: d(T0 - 10 * MIN), enviar });
  assert.equal(enviados.length, 1);
});

test('RODADA: se o Telegram recusar, nada é marcado como avisado e a próxima rodada tenta de novo', async () => {
  const chamadas = trafego(T0 - 8 * D, T0, (t) => [{ t, status: 'error', model: 'claude-sonnet-5', unidade: 'u1', mensagem: ANTHROPIC_SEM_SALDO }]);
  const leitura = leituraEmMemoria(chamadas);
  const store = storeEmMemoria();
  let aceita = false;
  const enviados: string[] = [];
  const enviar = async (t: string) => (enviados.push(t), aceita);
  await rodarVigia({ leitura, store, agora: d(T0), enviar });
  assert.equal(store.linhas.get('credito:anthropic')?.ultimoAvisoEm, null);
  aceita = true;
  await rodarVigia({ leitura, store, agora: d(T0 + 5 * MIN), enviar });
  assert.equal(enviados.length, 2);
  assert.ok(store.linhas.get('credito:anthropic')?.ultimoAvisoEm);
  await rodarVigia({ leitura, store, agora: d(T0 + 10 * MIN), enviar });
  assert.equal(enviados.length, 2, 'entregue uma vez, não repete');
});

test('RODADA: lembrete devido de madrugada espera; sai às 7h de Brasília', async () => {
  const noite = Date.parse('2026-11-27T05:00:00Z'); // 02:00 BRT
  const chamadas = trafego(noite - 8 * D, noite + 6 * H, (t) => [{ t, status: 'error', model: 'claude-sonnet-5', unidade: 'u1', mensagem: ANTHROPIC_SEM_SALDO }]);
  const leitura = leituraEmMemoria(chamadas);
  const store = storeEmMemoria();
  const enviados: Array<{ t: number; txt: string }> = [];
  for (let t = noite; t <= noite + 6 * H; t += 5 * MIN) {
    await rodarVigia({ leitura, store, agora: d(t), enviar: async (txt) => (enviados.push({ t, txt }), true) });
  }
  assert.equal(enviados[0].t, noite, 'o aviso de problema NOVO sai de madrugada');
  const lembretes = enviados.slice(1);
  assert.ok(lembretes.length >= 1);
  assert.ok(lembretes.every((l) => !emSilencioNoturno(d(l.t))), 'lembrete só fora do silêncio');
  assert.equal(new Date(lembretes[0].t).toISOString(), '2026-11-27T10:00:00.000Z', 'primeiro lembrete: 7h BRT em ponto');
});

test('RODADA: falha de leitura não muda estado nem manda aviso', async () => {
  const leitura = leituraEmMemoria([]);
  leitura.errosAgrupados = async () => {
    throw new Error('banco fora');
  };
  const store = storeEmMemoria();
  await assert.rejects(rodarVigia({ leitura, store, agora: d(T0), enviar: async () => true }), /banco fora/);
  assert.equal(store.linhas.size, 0);
});

test('RODADA: IA parada sozinha (sem erro registrado) avisa', async () => {
  // 8 dias de tráfego e, nas últimas 40 min, nada
  const chamadas = trafego(T0 - 8 * D, T0 - 40 * MIN, (t) => [{ t, status: 'success', model: 'claude-sonnet-5', unidade: 'u1' }]);
  const leitura = leituraEmMemoria(chamadas, []);
  const store = storeEmMemoria();
  const enviados: string[] = [];
  await rodarVigia({ leitura, store, agora: d(T0), enviar: async (t) => (enviados.push(t), true) });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /SOFIA PARADA/);
  assert.match(enviados[0], /O que fazer/);
});

test('RODADA: frase de queda sozinha (IA responde, mas pacientes recebem a frase) avisa uma vez, sem dado de paciente', async () => {
  const chamadas = trafego(T0 - 8 * D, T0, (t) => [{ t, status: 'success', model: 'claude-sonnet-5', unidade: 'u1' }]);
  const frases: FraseEnviada[] = [0, 1, 2, 3, 4].map((i) => ({ t: T0 - i * 4 * MIN, conversa: `conv-${i}`, unidade: 'u1' }));
  const leitura = leituraEmMemoria(chamadas, frases, () => 'Caxias');
  const store = storeEmMemoria();
  const enviados: string[] = [];
  for (const dt of [0, 5, 10]) await rodarVigia({ leitura, store, agora: d(T0 + dt * MIN), enviar: async (t) => (enviados.push(t), true) });
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /FRASE DE QUEDA/);
  assert.match(enviados[0], /5 vezes.*5 pacientes.*Caxias/s);
  assert.doesNotMatch(enviados[0], /conv-/);
});
