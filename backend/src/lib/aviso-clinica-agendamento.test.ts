import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ID_DA_AUTOMACAO,
  JANELA_NAO_FECHOU_MS,
  avisarClinicaMarcou,
  avisarClinicaNaoFechou,
  avisoSemTrecho,
  silencioDepoisDe,
  destinoDoAvisoClinica,
  estadoDoAvisoClinica,
  primeiroNome,
  textoMarcou,
  textoNaoFechou,
  trechoSeguro,
  type DepsDoAviso,
  type Marcador,
} from './aviso-clinica-agendamento.js';
import { motivoParaNaoAvisar } from './agendamento-perdido-worker.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { automacaoPorId } from './automacoes.js';

const GRUPO = '120363415681041746@g.us';
const SALTO = { id: 'u-salto', slug: 'doutor-hernia-salto', kommoSubdomain: 'doutorherniasalto' };
const ENV: Partial<NodeJS.ProcessEnv> = {
  AVISO_CLINICA_AGENDAMENTO_SLUGS: 'doutor-hernia-salto',
  AVISO_CLINICA_AGENDAMENTO_DESTINOS: JSON.stringify({ 'doutor-hernia-salto': GRUPO }),
  AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: 'http://evolution_api:8080/message/sendText/Suzanne%20-%20Relatorios',
  EVOLUTION_ALERT_HEADER: 'apikey',
  EVOLUTION_ALERT_VALUE: 'segredo',
};

/** Marcador em memória com a mesma regra do banco: id fixo, a primeira escrita vence, FAILED pode ser reaberta. */
function marcadorFalso() {
  const marcas = new Map<string, { unitId: string; leadId: string; status: 'SUCCESS' | 'FAILED'; em: number }>();
  let relogio = 1_000_000;
  const m: Marcador & { marcas: typeof marcas; avancar: (ms: number) => void; agora: () => Date } = {
    marcas,
    avancar: (ms) => {
      relogio += ms;
    },
    agora: () => new Date(relogio),
    async reivindicar(id, a) {
      const ja = marcas.get(id);
      if (!ja) {
        marcas.set(id, { unitId: a.unitId, leadId: a.leadId, status: 'SUCCESS', em: relogio });
        return 'novo';
      }
      if (ja.status === 'FAILED') {
        ja.status = 'SUCCESS';
        return 'novo';
      }
      return 'repetido';
    },
    async houveRecente(unitId, leadId, prefixo, desde) {
      return [...marcas].some(([id, x]) => id.startsWith(prefixo) && x.unitId === unitId && x.leadId === leadId && x.status === 'SUCCESS' && x.em > desde.getTime());
    },
    async soltar(id) {
      const x = marcas.get(id);
      if (x) x.status = 'FAILED';
    },
  };
  return m;
}

function montar(over: Partial<DepsDoAviso> = {}) {
  const enviados: Array<{ url: string; header: string; valor: string; numero: string; texto: string }> = [];
  const simulados: unknown[] = [];
  const marcador = marcadorFalso();
  const deps: DepsDoAviso = {
    env: ENV,
    estado: 'ligado',
    marcador,
    agora: marcador.agora,
    enviar: async (a) => {
      enviados.push(a);
      return 'ok';
    },
    simular: ((_u: unknown, _id: string, s: unknown) => {
      simulados.push(s);
    }) as DepsDoAviso['simular'],
    ...over,
  };
  return { deps, enviados, simulados, marcador };
}

const MARCOU = { unit: SALTO, leadId: 555, idClient: 9, nome: 'MARIA CONCEIÇÃO DA SILVA', data: '2026-11-28', hora: '12:30' };

// ── Texto ──

test('texto «marcou»: primeiro nome, dia da semana, dd/mm, hora, tipo e o link do cartão', () => {
  const t = textoMarcou({ nome: 'MARIA CONCEIÇÃO DA SILVA', data: '2026-11-28', hora: '12:30', tipo: 'avaliação', link: 'https://doutorherniasalto.kommo.com/leads/detail/555' });
  assert.equal(t, '✅ A Sofia marcou *Maria* para sábado, 28/11 às 12:30 (avaliação). Cartão: https://doutorherniasalto.kommo.com/leads/detail/555');
});

test('texto «marcou»: remarcação diz «remarcou»; nome que não é de gente não vaza («Lead 123», telefone)', () => {
  const t = textoMarcou({ nome: 'Lead 5646431', data: '2026-11-30', hora: '09:00', tipo: 'consulta', remarcando: true, link: null });
  assert.equal(t, '🔄 A Sofia remarcou *paciente (sem nome)* para segunda-feira, 30/11 às 09:00 (consulta).');
  assert.equal(primeiroNome('+55 15 99999-0000'), null);
  assert.equal(primeiroNome('  '), null);
  assert.equal(primeiroNome(null), null);
  assert.equal(primeiroNome('ana'), 'Ana');
});

test('texto «não fechou»: nome, trecho da última fala entre aspas, «Vale retomar» e o link', () => {
  const t = textoNaoFechou({ nome: 'Joana Pereira', ultimaFala: 'vou ver com meu marido e te falo', link: 'https://x.kommo.com/leads/detail/7' });
  assert.equal(
    t,
    '⚠️ A Sofia ofereceu horário a *Joana* e não fechou. Última fala do paciente: "vou ver com meu marido e te falo". Vale retomar. Cartão: https://x.kommo.com/leads/detail/7',
  );
});

test('texto «não fechou»: sem fala útil (áudio sem texto, figurinha) a frase da fala some', () => {
  const t = textoNaoFechou({ nome: 'Joana', ultimaFala: '', link: null });
  assert.equal(t, '⚠️ A Sofia ofereceu horário a *Joana* e não fechou. Vale retomar.');
  assert.equal(trechoSeguro('👍'), '');
  assert.equal(trechoSeguro(null), '');
});

test('trecho: sem CPF, telefone, e-mail nem link; corta em 80 caracteres', () => {
  assert.equal(trechoSeguro('meu cpf é 123.456.789-10 pode marcar'), 'meu cpf é pode marcar');
  assert.equal(trechoSeguro('me liga (15) 99876-5432 amanhã'), 'me liga amanhã');
  assert.equal(trechoSeguro('+55 15 99876 5432 é meu zap'), 'é meu zap');
  assert.equal(trechoSeguro('manda pra maria.silva@gmail.com por favor'), 'manda pra por favor');
  assert.equal(trechoSeguro('veja https://exemplo.com/laudo?id=1 o laudo'), 'veja o laudo');
  assert.equal(trechoSeguro('nasci em 03/04/1980 e moro longe'), 'nasci em e moro longe');
  assert.equal(trechoSeguro('quero às 12 horas'), 'quero às 12 horas', 'número curto (hora, dia) fica');
  assert.equal(trechoSeguro('disse "talvez"'), "disse 'talvez'", 'aspas duplas viram simples para não quebrar a citação');
  const longo = trechoSeguro('palavra '.repeat(30));
  assert.ok(longo.length <= 80 && longo.endsWith('…'), longo);
});

test('trecho: marcas de formatação do WhatsApp saem (não quebram o *negrito* do nome nem a citação)', () => {
  assert.equal(trechoSeguro('*urgente* _por favor_ ~já~ `ok`'), 'urgente por favor já ok');
});

test('AVISO_CLINICA_AGENDAMENTO_SEM_TRECHO=1 tira a fala do paciente do «não fechou»', async () => {
  assert.equal(avisoSemTrecho({}), false);
  assert.equal(avisoSemTrecho({ AVISO_CLINICA_AGENDAMENTO_SEM_TRECHO: '1' }), true);
  const { deps, enviados } = montar({ env: { ...ENV, AVISO_CLINICA_AGENDAMENTO_SEM_TRECHO: '1' } });
  await avisarClinicaNaoFechou(NAO_FECHOU, deps);
  assert.equal(enviados[0].texto, '⚠️ A Sofia ofereceu horário a *Joana* e não fechou. Vale retomar. Cartão: https://doutorherniasalto.kommo.com/leads/detail/777');
});

test('silêncio do vigia: o que saiu fica quieto na janela; o que não saiu (seco, recusado, sem destino) espera 1 h, não 15 min', () => {
  const JANELA = 24 * 3600_000;
  for (const d of ['enviado', 'incerto', 'repetido', 'recente'] as const) assert.equal(silencioDepoisDe(d, JANELA), JANELA, d);
  for (const d of ['simulado', 'recusado', 'sem_destino', 'sem_config', 'falhou'] as const) assert.equal(silencioDepoisDe(d, JANELA), 3600_000, d);
  assert.equal(silencioDepoisDe('desligado', JANELA), null);
});

test('o trecho do «não fechou» nunca carrega o número que o paciente escreveu', () => {
  const t = textoNaoFechou({ nome: 'Ana', ultimaFala: 'meu telefone 15 98877-6655, cpf 12345678900', link: null });
  assert.doesNotMatch(t, /\d{4}/);
});

// ── Configuração ──

test('destino é por unidade, sem JID no código; JSON quebrado ou unidade fora = sem destino', () => {
  assert.equal(destinoDoAvisoClinica('doutor-hernia-salto', ENV.AVISO_CLINICA_AGENDAMENTO_DESTINOS), GRUPO);
  assert.equal(destinoDoAvisoClinica('doutor-hernia-tatui', ENV.AVISO_CLINICA_AGENDAMENTO_DESTINOS), null);
  assert.equal(destinoDoAvisoClinica('doutor-hernia-salto', 'isto não é json'), null);
  assert.equal(destinoDoAvisoClinica('doutor-hernia-salto', undefined), null);
  assert.equal(destinoDoAvisoClinica('doutor-hernia-salto', `'{"doutor-hernia-salto":"${GRUPO}"}'`), GRUPO, 'aspas sobrando do .env');
});

test('a chave nasce DESLIGADA em toda unidade, tem modo seco e o id do catálogo é o do código', () => {
  _semearParaTeste([]);
  const a = automacaoPorId(ID_DA_AUTOMACAO);
  assert.ok(a, 'está no catálogo');
  assert.equal(a.quandoVazio, 'desligado');
  assert.equal(a.temSeco, true);
  assert.equal(estadoDoAvisoClinica('doutor-hernia-salto', undefined), 'desligado');
  assert.equal(estadoDoAvisoClinica('doutor-hernia-salto', 'doutor-hernia-tatui'), 'desligado');
  assert.equal(estadoDoAvisoClinica('doutor-hernia-salto', 'doutor-hernia-salto'), 'ligado');
  _semearParaTeste([{ slug: 'doutor-hernia-salto', automacao: ID_DA_AUTOMACAO, estado: 'seco' }]);
  assert.equal(estadoDoAvisoClinica('doutor-hernia-salto', undefined), 'seco');
  _semearParaTeste([]);
});

// ── «marcou» ──

test('ligado: manda o «marcou» no grupo da unidade, pela instância configurada, com a chave da Evolution', async () => {
  const { deps, enviados } = montar();
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'enviado');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].numero, GRUPO);
  assert.equal(enviados[0].url, ENV.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL);
  assert.equal(enviados[0].header, 'apikey');
  assert.equal(enviados[0].valor, 'segredo');
  assert.equal(enviados[0].texto, '✅ A Sofia marcou *Maria* para sábado, 28/11 às 12:30 (avaliação). Cartão: https://doutorherniasalto.kommo.com/leads/detail/555');
});

test('deduplicação: o mesmo «marcou» (retry da tool, webhook reprocessado) sai UMA vez; remarcar para outro horário avisa de novo', async () => {
  const { deps, enviados } = montar();
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'enviado');
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'repetido');
  assert.equal(await avisarClinicaMarcou({ ...MARCOU }, deps), 'repetido');
  assert.equal(enviados.length, 1);
  assert.equal(await avisarClinicaMarcou({ ...MARCOU, hora: '14:00', remarcando: true }, deps), 'enviado');
  assert.equal(enviados.length, 2);
  assert.match(enviados[1].texto, /^🔄 A Sofia remarcou \*Maria\* para sábado, 28\/11 às 14:00/);
});

test('marcou, desmarcou e marcou o MESMO horário de novo = duas consultas na franquia = dois avisos (idSchedule separa)', async () => {
  const { deps, enviados } = montar();
  assert.equal(await avisarClinicaMarcou({ ...MARCOU, idSchedule: 4001 }, deps), 'enviado');
  assert.equal(await avisarClinicaMarcou({ ...MARCOU, idSchedule: 4001 }, deps), 'repetido', 'a mesma consulta (retry) não repete');
  assert.equal(await avisarClinicaMarcou({ ...MARCOU, idSchedule: 4002 }, deps), 'enviado', 'outra consulta, mesmo horário');
  assert.equal(enviados.length, 2);
});

test('tipo: categoria 1 (ou ausente) é avaliação; outra é consulta', async () => {
  const a = montar();
  await avisarClinicaMarcou({ ...MARCOU, idCategory: 1 }, a.deps);
  assert.match(a.enviados[0].texto, /\(avaliação\)/);
  const b = montar();
  await avisarClinicaMarcou({ ...MARCOU, idCategory: 2 }, b.deps);
  assert.match(b.enviados[0].texto, /\(consulta\)/);
});

test('seco: registra o que mandaria (texto e destino) e NÃO manda, NÃO grava marca', async () => {
  const { deps, enviados, simulados, marcador } = montar({ estado: 'seco' });
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'simulado');
  assert.equal(enviados.length, 0);
  assert.equal(marcador.marcas.size, 0);
  assert.equal(simulados.length, 1);
  const s = simulados[0] as { leadId: number; acao: string; alvo: string; valor: string; motivo: string };
  assert.equal(s.acao, 'mandaria');
  assert.equal(s.alvo, 'marcou');
  assert.equal(s.leadId, 555);
  assert.match(s.valor, /A Sofia marcou \*Maria\*/);
  assert.match(s.motivo, new RegExp(GRUPO));
});

test('desligado: não faz nada (nem seco, nem marca)', async () => {
  const { deps, enviados, simulados, marcador } = montar({ estado: 'desligado' });
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'desligado');
  assert.equal(await avisarClinicaNaoFechou({ unit: SALTO, leadId: 1, nome: 'Ana', ultimaFala: 'oi', ofereceuEm: new Date() }, deps), 'desligado');
  assert.equal(enviados.length + simulados.length + marcador.marcas.size, 0);
});

test('sem destino da unidade = não manda (ligado) e o seco diz que não sairia', async () => {
  const sem = montar({ env: { ...ENV, AVISO_CLINICA_AGENDAMENTO_DESTINOS: JSON.stringify({ 'doutor-hernia-tatui': GRUPO }) } });
  assert.equal(await avisarClinicaMarcou(MARCOU, sem.deps), 'sem_destino');
  assert.equal(sem.enviados.length, 0);
  assert.equal(sem.marcador.marcas.size, 0, 'sem destino não consome a marca: ao configurar, o próximo aviso sai');

  const seco = montar({ estado: 'seco', env: { ...ENV, AVISO_CLINICA_AGENDAMENTO_DESTINOS: '' } });
  assert.equal(await avisarClinicaMarcou(MARCOU, seco.deps), 'simulado');
  assert.match((seco.simulados[0] as { motivo: string }).motivo, /SEM destino/);
});

test('sem URL da Evolution ou sem chave = não manda', async () => {
  const a = montar({ env: { ...ENV, AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: undefined } });
  assert.equal(await avisarClinicaMarcou(MARCOU, a.deps), 'sem_config');
  const b = montar({ env: { ...ENV, EVOLUTION_ALERT_VALUE: undefined } });
  assert.equal(await avisarClinicaMarcou(MARCOU, b.deps), 'sem_config');
  assert.equal(a.enviados.length + b.enviados.length, 0);
});

test('chave própria da Evolution vence a dos alertas', async () => {
  const { deps, enviados } = montar({ env: { ...ENV, AVISO_CLINICA_AGENDAMENTO_EVOLUTION_HEADER: 'x-api', AVISO_CLINICA_AGENDAMENTO_EVOLUTION_VALUE: 'outra' } });
  await avisarClinicaMarcou(MARCOU, deps);
  assert.equal(enviados[0].header, 'x-api');
  assert.equal(enviados[0].valor, 'outra');
});

test('falha de envio não quebra: a Evolution lança, recusa ou some — nada sobe para o agendamento', async () => {
  const lanca = montar({
    enviar: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(await avisarClinicaMarcou(MARCOU, lanca.deps), 'falhou');

  const recusa = montar({ enviar: async () => 'recusado' });
  assert.equal(await avisarClinicaMarcou(MARCOU, recusa.deps), 'recusado');
  // recusado libera a marca: o próximo pedido do MESMO evento volta a tentar
  recusa.deps.enviar = async (a) => {
    recusa.enviados.push(a);
    return 'ok';
  };
  assert.equal(await avisarClinicaMarcou(MARCOU, recusa.deps), 'enviado');
  assert.equal(recusa.enviados.length, 1);

  const incerto = montar({ enviar: async () => 'incerto' });
  assert.equal(await avisarClinicaMarcou(MARCOU, incerto.deps), 'incerto');
  assert.equal(await avisarClinicaMarcou(MARCOU, incerto.deps), 'repetido', 'pode ter saído: não repete');
});

test('o banco da marca falhando não cala o aviso (repetir é pouco; ficar no escuro é o que o pedido quer evitar)', async () => {
  const marcador: Marcador = { reivindicar: async () => 'erro', houveRecente: async () => false, soltar: async () => undefined };
  const { deps, enviados } = montar({ marcador });
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'enviado');
  assert.equal(enviados.length, 1);
});

test('lead sem cartão (conversa fora do Kommo): avisa sem o link e deduplica pelo cadastro', async () => {
  const { deps, enviados } = montar();
  const a = { ...MARCOU, leadId: undefined };
  assert.equal(await avisarClinicaMarcou(a, deps), 'enviado');
  assert.equal(await avisarClinicaMarcou(a, deps), 'repetido');
  assert.doesNotMatch(enviados[0].texto, /Cartão:/);
});

// ── «não fechou» ──

const OFERTA = new Date('2026-11-25T14:00:00Z');
const NAO_FECHOU = { unit: SALTO, leadId: 777, nome: 'Joana Pereira', ultimaFala: 'vou ver com meu marido', ofereceuEm: OFERTA };

test('ligado: manda o «não fechou» com o trecho da última fala e o link', async () => {
  const { deps, enviados } = montar();
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'enviado');
  assert.equal(enviados[0].numero, GRUPO);
  assert.equal(
    enviados[0].texto,
    '⚠️ A Sofia ofereceu horário a *Joana* e não fechou. Última fala do paciente: "vou ver com meu marido". Vale retomar. Cartão: https://doutorherniasalto.kommo.com/leads/detail/777',
  );
});

test('«não fechou»: no máximo 1 vez por lead a cada 24 h — oferta nova dentro da janela não reenvia, depois dela sim', async () => {
  const { deps, enviados, marcador } = montar();
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'enviado');
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'recente', 'a mesma oferta, varredura seguinte');
  marcador.avancar(2 * 3600_000);
  assert.equal(await avisarClinicaNaoFechou({ ...NAO_FECHOU, ofereceuEm: new Date(OFERTA.getTime() + 3600_000) }, deps), 'recente', 'outra oferta no mesmo lead, 2 h depois');
  marcador.avancar(JANELA_NAO_FECHOU_MS);
  assert.equal(await avisarClinicaNaoFechou({ ...NAO_FECHOU, ofereceuEm: new Date(OFERTA.getTime() + 30 * 3600_000) }, deps), 'enviado', 'passadas 24 h');
  assert.equal(enviados.length, 2);
});

test('«não fechou» de outro lead não é calado pelo primeiro', async () => {
  const { deps, enviados } = montar();
  await avisarClinicaNaoFechou(NAO_FECHOU, deps);
  assert.equal(await avisarClinicaNaoFechou({ ...NAO_FECHOU, leadId: 778 }, deps), 'enviado');
  assert.equal(enviados.length, 2);
});

test('«não fechou» recusado pela Evolution é tentado de novo na varredura seguinte (e não conta como aviso)', async () => {
  const { deps, enviados } = montar({ enviar: async () => 'recusado' });
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'recusado');
  deps.enviar = async (a) => {
    enviados.push(a);
    return 'ok';
  };
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'enviado');
  assert.equal(enviados.length, 1);
});

test('«não fechou» em seco: registra, não manda, e não gasta a janela de 24 h', async () => {
  const { deps, enviados, simulados, marcador } = montar({ estado: 'seco' });
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'simulado');
  assert.equal((simulados[0] as { alvo: string }).alvo, 'nao-fechou');
  assert.equal(enviados.length, 0);
  assert.equal(marcador.marcas.size, 0);
});

// ── A mesma decisão do vigia de «agendamento perdido» ──

test('o «não fechou» obedece a MESMA decisão do filtro do vigia: adiou, não respondeu e madrugada não avisam; quem respondeu e ficou sem consulta avisa', () => {
  const DIA = 14 * 60;
  const MADRUGADA = 2 * 60;
  assert.match(motivoParaNaoAvisar({ pacienteRespondeu: true, adiou: true }, DIA) ?? '', /adiou/);
  assert.match(motivoParaNaoAvisar({ pacienteRespondeu: false, adiou: false }, DIA) ?? '', /não respondeu/);
  assert.match(motivoParaNaoAvisar({ pacienteRespondeu: true, adiou: false }, MADRUGADA) ?? '', /madrugada/);
  assert.equal(motivoParaNaoAvisar({ pacienteRespondeu: true, adiou: false }, DIA), null);
});
