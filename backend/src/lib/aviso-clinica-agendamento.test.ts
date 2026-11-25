import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ID_DA_AUTOMACAO,
  JANELA_NAO_FECHOU_MS,
  avisarClinicaMarcou,
  avisarClinicaNaoFechou,
  avisoSemTrecho,
  emMadrugadaDoAviso,
  linkDoCartao,
  reenviarMarcouPendentes,
  silencioDepoisDe,
  destinoDoAvisoClinica,
  estadoDoAvisoClinica,
  nomeDeGente,
  primeiroNome,
  textoMarcou,
  textoNaoFechou,
  trechoSeguro,
  type DepsDoAviso,
  type EstadoDaMarca,
  type Marcador,
} from './aviso-clinica-agendamento.js';
import { motivoParaNaoAvisar } from './agendamento-perdido-worker.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { automacaoPorId } from './automacoes.js';

const GRUPO = '120363415681041746@g.us';
const SALTO = { id: 'u-salto', slug: 'doutor-hernia-salto', kommoSubdomain: 'doutorherniasalto', businessHoursTimezone: 'America/Sao_Paulo', spineTimezone: 'America/Sao_Paulo' };
const ENV: Partial<NodeJS.ProcessEnv> = {
  AVISO_CLINICA_AGENDAMENTO_SLUGS: 'doutor-hernia-salto',
  AVISO_CLINICA_AGENDAMENTO_DESTINOS: JSON.stringify({ 'doutor-hernia-salto': GRUPO }),
  AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: 'http://evolution_api:8080/message/sendText/Suzanne%20-%20Relatorios',
  EVOLUTION_ALERT_HEADER: 'apikey',
  EVOLUTION_ALERT_VALUE: 'segredo',
};

/** Marcador em memória com a mesma regra do banco: id fixo, a primeira escrita vence, `pendente` pode ser pega por UM chamador. */
function marcadorFalso() {
  const marcas = new Map<string, { unitId: string; leadId: string; estado: EstadoDaMarca; em: number; payload: Record<string, unknown> }>();
  // 25/11/2026 12:00 em Salto (15:00 UTC): dia, fora da madrugada
  let relogio = Date.parse('2026-11-25T15:00:00Z');
  const m: Marcador & { marcas: typeof marcas; avancar: (ms: number) => void; agora: () => Date } = {
    marcas,
    avancar: (ms) => {
      relogio += ms;
    },
    agora: () => new Date(relogio),
    async reivindicar(id, a) {
      const ja = marcas.get(id);
      if (!ja) {
        marcas.set(id, { unitId: a.unitId, leadId: a.leadId, estado: a.estado, em: relogio, payload: a.payload });
        return 'novo';
      }
      if (a.estado === 'pendente') return 'repetido';
      return (await m.pegar(id)) ? 'novo' : 'repetido';
    },
    async pegar(id) {
      const x = marcas.get(id);
      if (!x || x.estado !== 'pendente') return false;
      x.estado = 'enviando';
      return true;
    },
    async houveRecente(unitId, leadId, prefixo, janelaMs) {
      return [...marcas].some(([id, x]) => id.startsWith(prefixo) && x.unitId === unitId && x.leadId === leadId && x.estado !== 'pendente' && x.em > relogio - janelaMs);
    },
    async concluir(id, estado) {
      const x = marcas.get(id);
      if (x) x.estado = estado;
    },
    async pendentes(prefixo, idadeMaxMs) {
      return [...marcas]
        .filter(([id, x]) => id.startsWith(prefixo) && x.estado === 'pendente' && x.em > relogio - idadeMaxMs)
        .map(([id, x]) => ({ id, unitId: x.unitId, leadId: x.leadId, payload: x.payload }));
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
    nomeDoContato: async () => null,
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
  for (const d of ['enviado', 'incerto', 'repetido'] as const) assert.equal(silencioDepoisDe(d, JANELA), JANELA, d);
  // «recente» (outro aviso do lead dentro das 24 h) olha de novo em 1 h: esta oferta pode valer quando as 24 h fecharem
  for (const d of ['recente', 'recusado', 'sem_destino', 'sem_config', 'falhou'] as const) assert.equal(silencioDepoisDe(d, JANELA), 3600_000, d);
  assert.equal(silencioDepoisDe('simulado', JANELA), 3 * 3600_000);
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
  const marcador: Marcador = { ...marcadorFalso(), reivindicar: async () => 'erro' };
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

// ── Reprovação do sênior (#450): CPF/conta no trecho, link do Chatwoot, reenvio do «marcou», madrugada, dia da semana, títulos, nome do cartão ──

test('trecho NUNCA deixa passar CPF ou conta, por mais que o paciente quebre o número (casos medidos pelo sênior)', () => {
  const casos: Array<[string, RegExp]> = [
    ['meu cpf 123_456_789_10', /^meu cpf$/],
    ['cpf *012*.*602*.*411*-*14*', /^cpf$/],
    ['cpf 012,602,411-14', /^cpf$/],
    ['conta 351,855,134,29', /^conta$/],
    ['CPF: 012.602.411-14 Banco: Mercado Pago Agência: 0001 Conta: 3518551342-9', /^CPF: Banco: Mercado Pago Agência: Conta:$/],
    ['pix 012 602 411 14 pode ser', /^pix pode ser$/],
    ['cpf ~012~/~602~/~411~ 14', /^cpf$/],
  ];
  for (const [entrada, esperado] of casos) {
    const t = trechoSeguro(entrada);
    assert.doesNotMatch(t, /\d/, `sobrou dígito em «${entrada}» → «${t}»`);
    assert.match(t, esperado, entrada);
  }
  // o filtro roda de novo depois do corte em 80 caracteres: o número que o corte deixaria pela metade também não vaza
  const cortado = trechoSeguro(`${'palavra '.repeat(9)}012.602.411-14 e mais um pouco de conversa`);
  assert.doesNotMatch(cortado, /\d{3}/);
  // números curtos (hora, dia) continuam
  assert.equal(trechoSeguro('pode ser dia 12 às 9 horas'), 'pode ser dia 12 às 9 horas');
});

test('o texto do «não fechou» inteiro não carrega dígitos de documento (caso Rio Verde)', () => {
  const t = textoNaoFechou({ nome: 'Ana', ultimaFala: 'CPF: 012.602.411-14 Banco: Mercado Pago Agência: 0001 Conta: 3518551342-9', link: 'https://x.kommo.com/leads/detail/7' });
  assert.doesNotMatch(t.replace('leads/detail/7', ''), /\d{2}/);
});

test('link do cartão: lead sintético do Chatwoot (2 bilhões + conversa) não tem cartão no Kommo — sem link', async () => {
  assert.equal(linkDoCartao(SALTO, 555), 'https://doutorherniasalto.kommo.com/leads/detail/555');
  assert.equal(linkDoCartao(SALTO, 2_000_000_123), null);
  assert.equal(linkDoCartao(SALTO, undefined), null);
  assert.equal(linkDoCartao({ kommoSubdomain: null }, 555), null);
  const { deps, enviados } = montar();
  await avisarClinicaMarcou({ ...MARCOU, leadId: 2_000_000_123 }, deps);
  assert.doesNotMatch(enviados[0].texto, /Cartão:|kommo\.com/);
  const n = montar();
  await avisarClinicaNaoFechou({ ...NAO_FECHOU, leadId: 2_000_000_124 }, n.deps);
  assert.doesNotMatch(n.enviados[0].texto, /Cartão:|kommo\.com/);
});

test('dia da semana: calculado da data civil da agenda, certo em qualquer fuso do servidor (28/11/2026 é SÁBADO)', () => {
  const dados = { nome: 'Ana', hora: '09:00', tipo: 'consulta', link: null };
  const dia = (data: string) => textoMarcou({ ...dados, data }).match(/para ([^,]+),/)?.[1];
  const antes = process.env.TZ;
  try {
    for (const tz of ['America/Sao_Paulo', 'America/Manaus', 'Pacific/Auckland', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(dia('2026-11-27'), 'sexta-feira', tz);
      assert.equal(dia('2026-11-28'), 'sábado', tz);
      assert.equal(dia('2026-11-29'), 'domingo', tz);
      assert.equal(dia('2026-11-30'), 'segunda-feira', tz);
      assert.equal(dia('2026-12-31'), 'quinta-feira', tz);
    }
  } finally {
    if (antes === undefined) delete process.env.TZ;
    else process.env.TZ = antes;
  }
});

test('primeiro nome pula título: Dr., Dra., Sr., Sra.', () => {
  assert.equal(primeiroNome('Dr. Fulano de Tal'), 'Fulano');
  assert.equal(primeiroNome('DRA. MARIA SOUZA'), 'Maria');
  assert.equal(primeiroNome('Sra Joana'), 'Joana');
  assert.equal(primeiroNome('sr. josé'), 'José');
  assert.equal(primeiroNome('Dr.'), null);
  assert.equal(primeiroNome('Drica Lima'), 'Drica', 'só o título inteiro é pulado');
});

test('nome: a franquia sem nome de gente → usa o do cartão do Kommo; sem nenhum dos dois → «paciente (sem nome)»', async () => {
  const a = montar();
  await avisarClinicaMarcou({ ...MARCOU, nome: null, nomeDoCartao: async () => 'Joana Lima' }, a.deps);
  assert.match(a.enviados[0].texto, /marcou \*Joana\* para/);

  const b = montar();
  await avisarClinicaMarcou({ ...MARCOU, nome: '  ', nomeDoCartao: async () => 'Lead 5646431' }, b.deps);
  assert.match(b.enviados[0].texto, /\*paciente \(sem nome\)\*/);

  const c = montar();
  await avisarClinicaMarcou(
    {
      ...MARCOU,
      nome: null,
      nomeDoCartao: async () => {
        throw new Error('kommo fora');
      },
    },
    c.deps,
  );
  assert.match(c.enviados[0].texto, /\*paciente \(sem nome\)\*/);

  // com nome da franquia, o cartão nem é consultado
  let consultou = false;
  const d = montar();
  await avisarClinicaMarcou(
    {
      ...MARCOU,
      nomeDoCartao: async () => {
        consultou = true;
        return 'Outro';
      },
    },
    d.deps,
  );
  assert.equal(consultou, false);
  assert.match(d.enviados[0].texto, /\*Maria\*/);
});

// 26/11/2026 02:00 em Salto (05:00 UTC) = madrugada; 10:00 = 13:00 UTC
const MADRUGADA = () => new Date('2026-11-26T05:00:00Z');
const MANHA = () => new Date('2026-11-26T13:00:00Z');

test('madrugada: entre 21h e 7h na hora da unidade (limites exatos)', () => {
  const em = (iso: string) => emMadrugadaDoAviso(SALTO, new Date(iso));
  assert.equal(em('2026-11-26T00:00:00Z'), true, '21:00 em Salto');
  assert.equal(em('2026-11-25T23:59:00Z'), false, '20:59');
  assert.equal(em('2026-11-26T09:59:00Z'), true, '06:59');
  assert.equal(em('2026-11-26T10:00:00Z'), false, '07:00');
  assert.equal(emMadrugadaDoAviso({ businessHoursTimezone: 'America/Manaus', spineTimezone: 'America/Sao_Paulo' }, new Date('2026-11-26T10:30:00Z')), true, 'Manaus: 06:30');
});

test('«marcou» de madrugada fica guardado (não toca o celular) e sai depois das 7h, uma vez só', async () => {
  const { deps, enviados, marcador } = montar({ agora: MADRUGADA });
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'segurado');
  assert.equal(enviados.length, 0);
  assert.equal([...marcador.marcas.values()][0].estado, 'pendente');
  // o mesmo evento chegando de novo de madrugada não duplica a marca
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'repetido');

  // varredura ainda de madrugada: nada sai
  assert.equal(await reenviarMarcouPendentes({ ...deps, unidade: async () => SALTO }), 0);
  assert.equal(enviados.length, 0);

  // varredura das 10h: sai, com o texto de quando foi marcado
  const manha = { ...deps, agora: MANHA, unidade: async () => SALTO };
  assert.equal(await reenviarMarcouPendentes(manha), 1);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].numero, GRUPO);
  assert.match(enviados[0].texto, /^✅ A Sofia marcou \*Maria\* para sábado, 28\/11 às 12:30/);
  assert.equal([...marcador.marcas.values()][0].estado, 'enviado');
  // e não sai outra vez
  assert.equal(await reenviarMarcouPendentes(manha), 0);
  assert.equal(enviados.length, 1);
});

test('«marcou» recusado pela Evolution fica pendente e o vigia reenvia sem duplicar; sem resposta (incerto) nunca reenvia', async () => {
  const { deps, enviados, marcador } = montar({ enviar: async () => 'recusado' });
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'recusado');
  assert.equal([...marcador.marcas.values()][0].estado, 'pendente');

  deps.enviar = async (a) => {
    enviados.push(a);
    return 'ok';
  };
  const varredura = { ...deps, unidade: async () => SALTO };
  assert.equal(await reenviarMarcouPendentes(varredura), 1);
  assert.equal(await reenviarMarcouPendentes(varredura), 0, 'já saiu');
  assert.equal(await avisarClinicaMarcou(MARCOU, deps), 'repetido', 'o mesmo evento voltando não duplica');
  assert.equal(enviados.length, 1);

  const inc = montar({ enviar: async () => 'incerto' });
  await avisarClinicaMarcou(MARCOU, inc.deps);
  assert.equal([...inc.marcador.marcas.values()][0].estado, 'incerto');
  assert.equal(await reenviarMarcouPendentes({ ...inc.deps, unidade: async () => SALTO }), 0);
});

test('reenvio do «marcou»: recusa de novo continua pendente; passou de 12 h não manda; seco e desligado não mandam; sem destino não manda', async () => {
  const a = montar({ enviar: async () => 'recusado' });
  await avisarClinicaMarcou(MARCOU, a.deps);
  assert.equal(await reenviarMarcouPendentes({ ...a.deps, unidade: async () => SALTO }), 0);
  assert.equal([...a.marcador.marcas.values()][0].estado, 'pendente', 'recusou outra vez: segue pendente para a próxima varredura');

  a.marcador.avancar(13 * 3600_000);
  a.deps.enviar = async (x) => {
    a.enviados.push(x);
    return 'ok';
  };
  assert.equal(await reenviarMarcouPendentes({ ...a.deps, unidade: async () => SALTO }), 0, 'aviso velho não ajuda');

  for (const estado of ['seco', 'desligado'] as const) {
    const b = montar({ enviar: async () => 'recusado' });
    await avisarClinicaMarcou(MARCOU, b.deps);
    b.deps.enviar = async (x) => {
      b.enviados.push(x);
      return 'ok';
    };
    assert.equal(await reenviarMarcouPendentes({ ...b.deps, estado, unidade: async () => SALTO }), 0, estado);
    assert.equal(b.enviados.length, 0);
  }

  const c = montar({ enviar: async () => 'recusado' });
  await avisarClinicaMarcou(MARCOU, c.deps);
  c.deps.enviar = async (x) => {
    c.enviados.push(x);
    return 'ok';
  };
  assert.equal(await reenviarMarcouPendentes({ ...c.deps, env: { ...ENV, AVISO_CLINICA_AGENDAMENTO_DESTINOS: '' }, unidade: async () => SALTO }), 0);
  assert.equal(c.enviados.length, 0);
});

test('reenvio nunca lança: banco fora, unidade que sumiu, envio que explode', async () => {
  const quebrado: Marcador = { ...marcadorFalso(), pendentes: async () => { throw new Error('banco fora'); } };
  assert.equal(await reenviarMarcouPendentes({ ...montar().deps, marcador: quebrado }), 0);

  const a = montar({ enviar: async () => 'recusado' });
  await avisarClinicaMarcou(MARCOU, a.deps);
  assert.equal(await reenviarMarcouPendentes({ ...a.deps, unidade: async () => null }), 0);
  assert.equal(await reenviarMarcouPendentes({ ...a.deps, unidade: async () => { throw new Error('x'); } }), 0);
});

test('«não fechou» recusado fica pendente e NÃO conta como aviso das 24 h; a mesma oferta reenvia uma vez só', async () => {
  const { deps, enviados, marcador } = montar({ enviar: async () => 'recusado' });
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'recusado');
  assert.equal([...marcador.marcas.values()][0].estado, 'pendente');
  deps.enviar = async (a) => {
    enviados.push(a);
    return 'ok';
  };
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'enviado');
  assert.equal(await avisarClinicaNaoFechou(NAO_FECHOU, deps), 'recente');
  assert.equal(enviados.length, 1);
});

test('primeiro nome: inicial solta é pulada («J. Silva» → Silva) e nome composto com hífen mantém as duas maiúsculas', () => {
  assert.equal(primeiroNome('J. Silva'), 'Silva');
  assert.equal(primeiroNome('MARIA-CLARA Souza'), 'Maria-Clara');
  assert.equal(primeiroNome('A'), null);
});

test('reenvio do «marcou» que explode no meio: a marca volta a pendente (nada saiu) e os outros pendentes seguem', async () => {
  const a = montar({ enviar: async () => 'recusado' });
  await avisarClinicaMarcou(MARCOU, a.deps);
  await avisarClinicaMarcou({ ...MARCOU, leadId: 556, hora: '14:00' }, a.deps);
  let chamadas = 0;
  a.deps.enviar = async (x) => {
    chamadas++;
    if (chamadas === 1) throw new Error('timeout');
    a.enviados.push(x);
    return 'ok';
  };
  assert.equal(await reenviarMarcouPendentes({ ...a.deps, unidade: async () => SALTO }), 1, 'o segundo seguiu');
  const estados = [...a.marcador.marcas.values()].map((m) => m.estado).sort();
  assert.deepEqual(estados, ['enviado', 'pendente']);
  assert.equal(await reenviarMarcouPendentes({ ...a.deps, unidade: async () => SALTO }), 1, 'o que explodiu sai na varredura seguinte');
  assert.equal(a.enviados.length, 2);
});

test('reenvio do «marcou»: unidade inativa não recebe', async () => {
  const a = montar({ enviar: async () => 'recusado' });
  await avisarClinicaMarcou(MARCOU, a.deps);
  a.deps.enviar = async (x) => {
    a.enviados.push(x);
    return 'ok';
  };
  assert.equal(await reenviarMarcouPendentes({ ...a.deps, unidade: async () => ({ ...SALTO, isActive: false }) }), 0);
  assert.equal(a.enviados.length, 0);
});

// ── Nome do paciente: franquia → conversations.contact_name → cartão do Kommo → «paciente (sem nome)» (7 avisos de Salto saíram sem nome em 25/11) ──

test('«não fechou»: cartão com título genérico («Lead 23 16/11/2026») + contact_name preenchido = primeiro nome do contact_name', async () => {
  const casos: Array<[string, string, string]> = [
    ['Odete', 'Lead 23 16/11/2026', 'Odete'],
    ['Paulo', 'Lead #4921723', 'Paulo'],
    ['Maria Simone Rodrigues', 'Lead 5020739', 'Maria'],
  ];
  for (const [contato, cartao, esperado] of casos) {
    const { deps, enviados } = montar({ nomeDoContato: async () => contato });
    await avisarClinicaNaoFechou({ ...NAO_FECHOU, nome: cartao }, deps);
    assert.match(enviados[0].texto, new RegExp(`a \\*${esperado}\\* e não fechou`), contato);
    assert.doesNotMatch(enviados[0].texto, /sem nome/);
  }
});

test('«não fechou»: a conversa é buscada na unidade e no lead certos', async () => {
  const buscas: Array<[string, number]> = [];
  const { deps } = montar({
    nomeDoContato: async (u, l) => {
      buscas.push([u, l]);
      return 'Odete';
    },
  });
  await avisarClinicaNaoFechou(NAO_FECHOU, deps);
  assert.deepEqual(buscas, [[SALTO.id, NAO_FECHOU.leadId]]);
});

test('«não fechou»: sem contact_name usa o nome do cartão; título genérico do Kommo NUNCA vira nome', async () => {
  const a = montar();
  await avisarClinicaNaoFechou({ ...NAO_FECHOU, nome: 'Joana Pereira' }, a.deps);
  assert.match(a.enviados[0].texto, /a \*Joana\* e não fechou/);

  for (const generico of ['Lead #123', 'Lead 23 16/11/2026', 'lead 77', 'Novo lead', 'Contato', 'Sem nome', null, '', '   ']) {
    const b = montar();
    await avisarClinicaNaoFechou({ ...NAO_FECHOU, nome: generico }, b.deps);
    assert.match(b.enviados[0].texto, /a \*paciente \(sem nome\)\* e não fechou/, String(generico));
  }
  // contact_name também genérico ou lixo (emoji, inicial, usuário com número) não vira nome
  for (const lixo of ['.', '💖', 'D', 'cabralcacilda39', 'Lead 12']) {
    const c = montar({ nomeDoContato: async () => lixo });
    await avisarClinicaNaoFechou({ ...NAO_FECHOU, nome: 'Joana' }, c.deps);
    assert.match(c.enviados[0].texto, /a \*Joana\* e não fechou/, lixo);
  }
});

test('«marcou»: franquia sem nome + contact_name preenchido = primeiro nome do contact_name; a franquia, quando tem nome, vence', async () => {
  const a = montar({ nomeDoContato: async () => 'Maria Simone Rodrigues' });
  await avisarClinicaMarcou({ ...MARCOU, nome: null }, a.deps);
  assert.match(a.enviados[0].texto, /marcou \*Maria\* para/);

  const b = montar({ nomeDoContato: async () => 'Odete' });
  await avisarClinicaMarcou({ ...MARCOU, nome: 'PAULO ANTUNES' }, b.deps);
  assert.match(b.enviados[0].texto, /marcou \*Paulo\* para/);
});

test('«marcou»: ordem franquia → contact_name → cartão → «paciente (sem nome)», cada fonte só consultada se as de antes falharam', async () => {
  let cartao = 0;
  const a = montar({ nomeDoContato: async () => 'Lead 9' });
  await avisarClinicaMarcou(
    {
      ...MARCOU,
      nome: 'Lead 55',
      nomeDoCartao: async () => {
        cartao++;
        return 'Joana Lima';
      },
    },
    a.deps,
  );
  assert.match(a.enviados[0].texto, /marcou \*Joana\* para/);
  assert.equal(cartao, 1);

  let contato = 0;
  const b = montar({
    nomeDoContato: async () => {
      contato++;
      return 'Odete';
    },
  });
  await avisarClinicaMarcou(
    {
      ...MARCOU,
      nome: null,
      nomeDoCartao: async () => {
        cartao++;
        return 'Joana Lima';
      },
    },
    b.deps,
  );
  assert.match(b.enviados[0].texto, /marcou \*Odete\* para/);
  assert.equal(cartao, 1, 'o cartão não foi consultado: o contact_name já deu o nome');
  assert.equal(contato, 1);

  const c = montar({
    nomeDoContato: async () => {
      throw new Error('banco fora');
    },
  });
  await avisarClinicaMarcou({ ...MARCOU, nome: null, nomeDoCartao: async () => 'Lead #1' }, c.deps);
  assert.match(c.enviados[0].texto, /\*paciente \(sem nome\)\*/);
});

test('primeiroNome: «Maria Simone Rodrigues» vira «Maria»; título genérico do Kommo vira null', () => {
  assert.equal(primeiroNome('Maria Simone Rodrigues'), 'Maria');
  assert.equal(primeiroNome('Odete'), 'Odete');
  for (const g of ['Lead #123', 'Lead 23 16/11/2026', 'Novo lead', 'Contato', 'Sem nome', 'Paciente', 'WhatsApp']) assert.equal(primeiroNome(g), null, g);
  assert.equal(primeiroNome('Leandro Silva'), 'Leandro', 'só o título «lead» inteiro é genérico');
  assert.equal(primeiroNome('Contatinho'), 'Contatinho');
});

test('nome do contato/cartão passa pelo filtro de nome-lixo do cadastro («Ocupado», «Fly link», «Oi», emoji) — não vira nome do paciente', async () => {
  for (const lixo of ['Ocupado', 'Ocupada', 'Fly link', 'Oi', 'Bom dia', 'Quero marcar consulta', 'Doutor Hérnia Salto']) {
    const a = montar({ nomeDoContato: async () => lixo });
    await avisarClinicaNaoFechou({ ...NAO_FECHOU, nome: 'Joana Pereira' }, a.deps);
    assert.match(a.enviados[0].texto, /a \*Joana\* e não fechou/, lixo);
    const b = montar({ nomeDoContato: async () => null });
    await avisarClinicaNaoFechou({ ...NAO_FECHOU, nome: lixo }, b.deps);
    assert.match(b.enviados[0].texto, /\*paciente \(sem nome\)\*/, `cartão ${lixo}`);
  }
  // enfeite colado no nome do perfil sai: «Rosa❤️» é Rosa
  const c = montar({ nomeDoContato: async () => 'Rosa❤️' });
  await avisarClinicaNaoFechou({ ...NAO_FECHOU, nome: 'Lead 1' }, c.deps);
  assert.match(c.enviados[0].texto, /a \*Rosa\* e não fechou/);
  assert.equal(nomeDeGente('Maria Simone Rodrigues'), 'Maria Simone Rodrigues');
  assert.equal(nomeDeGente('😃'), null);
  assert.equal(nomeDeGente('Lead 23 16/11/2026'), null);
});
