/**
 * Alerta «Sofia parou»: falha, teto ou erro com a Sofia LIGADA e o paciente segue sem resposta depois de N min → aviso no grupo da recepção
 * (1 por conversa a cada 2 h e 1 por unidade e motivo a cada 30 min). Em «só no papel» só anota; desligado e Sofia desligada não fazem nada.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { Estado } from './automacoes-estado.js';
import type { ConversaLida } from './chatwoot-porta.js';
import { conferirSofiaParou, DESFECHOS_QUE_PARAM, descarregarPendentes, ENTRE_AVISOS_DA_UNIDADE_MS, ENTRE_LOTES_DA_RETOMADA_MS, LOTE_DA_RETOMADA, paradosDoRegistro, retomarDoRegistro, type EventoDoRegistro, ENTRE_AVISOS_MS, esquecerAvisosDoVigia, minutosDoAlerta, pendentesDoVigia, textoDoAviso, ultimaDoPacienteEm, type DepsDoVigia } from './chatwoot-sofia-parou.js';
import { novaMemoriaDaIa, rodarSofia, type PortasDaIa } from './chatwoot-ia.js';
import { textoDaEspera } from './crm-demora/marca.js';

beforeEach(() => esquecerAvisosDoVigia());

const T0 = Date.parse('2026-11-26T15:00:00Z'); // quinta 12h em São Paulo
const ENV = { AVISO_CLINICA_AGENDAMENTO_DESTINOS: '{"doutor-hernia-parauapebas":"1203630@g.us"}', AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: 'https://evo/message/sendText/x', AVISO_CLINICA_AGENDAMENTO_EVOLUTION_HEADER: 'apikey', AVISO_CLINICA_AGENDAMENTO_EVOLUTION_VALUE: 'k' };
const unit = (o: Partial<Unit> = {}) => ({ id: 'u', slug: 'doutor-hernia-parauapebas', businessHoursEnabled: false, ...o }) as unknown as Unit;
const lida = (o: Partial<ConversaLida> = {}): ConversaLida => ({ id: 12, nome: 'Maria da Silva', telefone: '+5594999990000', attrs: {}, etiquetas: [], grupo: false, interno: false, ...o });
/** mensagem do paciente `minAtras` minutos antes de T0 */
const doPaciente = (minAtras: number) => ({ message_type: 0, private: false, content: 'oi', created_at: Math.floor((T0 - minAtras * 60_000) / 1000) });

function deps(o: { estado?: Estado; sofia?: Estado; mensagens?: any[]; lida?: ConversaLida | null; unidade?: Partial<Unit>; env?: Record<string, string>; envio?: 'ok' | 'recusado' | 'incerto'; agora?: () => number } = {}) {
  const enviados: Array<{ numero: string; texto: string }> = [];
  const simulados: unknown[] = [];
  const registrados: Array<{ slug: string; conversa: number; desfecho: string }> = [];
  const d: DepsDoVigia = {
    estado: () => o.estado ?? 'ligado',
    estadoDaSofia: () => o.sofia ?? 'ligado',
    unidade: async () => unit(o.unidade),
    mensagens: async () => o.mensagens ?? [doPaciente(20)],
    conversa: async () => (o.lida === null ? null : (o.lida ?? lida())),
    agora: o.agora ?? (() => T0),
    link: (c) => `https://crm/app/accounts/1/conversations/${c}`,
    env: o.env ?? ENV,
    enviar: async (a) => (enviados.push({ numero: a.numero, texto: a.texto }), o.envio ?? 'ok'),
    simular: ((_u: unknown, _id: unknown, s: unknown) => void simulados.push(s)) as never,
    registrarAviso: async (slug, conversa, desfecho) => void registrados.push({ slug, conversa, desfecho }),
  };
  return { d, enviados, simulados, registrados };
}
const M = { slug: 'doutor-hernia-parauapebas', conversa: 12 };

test('paciente sem resposta há 20 min depois de uma falha, DENTRO do horário da equipe: avisa o grupo da recepção, com nome, tempo, motivo e o link da conversa', async () => {
  const a = deps();
  assert.equal(await conferirSofiaParou(M, 'falhou', a.d), 'avisou');
  assert.equal(a.enviados.length, 1);
  assert.equal(a.enviados[0]!.numero, '1203630@g.us');
  assert.equal(a.enviados[0]!.texto, '⚠️ A Sofia parou de responder no CRM: *Maria* escreveu há 20 min e ninguém respondeu (falha da Sofia ou do Chatwoot). Abra a conversa 12 e responda por lá. https://crm/app/accounts/1/conversations/12');
  // «teto» e «kommo-indisponivel» atingem a unidade toda: o aviso diz que o resto vem num resumo
  esquecerAvisosDoVigia();
  const t = deps();
  assert.equal(await conferirSofiaParou(M, 'teto', t.d), 'avisou');
  assert.match(t.enviados[0]!.texto, /\(limite de respostas do dia\)\. Abra a conversa 12 e responda por lá\. https:\/\/crm\/app\/accounts\/1\/conversations\/12 Se outros pacientes ficaram parados pelo mesmo motivo, eles vêm num resumo em seguida\.$/);
});

test('1 aviso por conversa a cada 2 h; depois das 2 h avisa de novo; Evolution recusou libera a próxima', async () => {
  let agora = T0;
  const a = deps({ agora: () => agora });
  assert.equal(await conferirSofiaParou(M, 'falhou', a.d), 'avisou');
  agora = T0 + 60 * 60_000;
  assert.equal(await conferirSofiaParou(M, 'falhou', a.d), 'ja-avisada');
  agora = T0 + ENTRE_AVISOS_MS + 1000;
  assert.equal(await conferirSofiaParou(M, 'teto', a.d), 'avisou');
  assert.equal(a.enviados.length, 2);
  esquecerAvisosDoVigia();
  const r = deps({ envio: 'recusado' });
  assert.equal(await conferirSofiaParou(M, 'falhou', r.d), 'recusado');
  assert.equal(await conferirSofiaParou(M, 'falhou', deps().d), 'avisou', 'a recusa não gastou a janela das 2 h');
});

test('NÃO avisa: já respondida (última pública é nossa), paciente escreveu há pouco, conversa já com a equipe/IA pausada, unidade pausada', async () => {
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ mensagens: [doPaciente(30), { message_type: 1, private: false, content: 'Já te respondo' }] }).d), 'respondida');
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ mensagens: [doPaciente(3)] }).d), 'recente');
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ mensagens: [doPaciente(30), { message_type: 1, private: true, content: 'nota' }] }).d), 'avisou', 'nota privada não é resposta');
  esquecerAvisosDoVigia();
  for (const l of [lida({ etiquetas: ['esperando-humano'] }), lida({ etiquetas: ['ia-pausada'] }), lida({ attrs: { funil: 'Tratamento' } }), lida({ interno: true })]) {
    assert.equal(await conferirSofiaParou(M, 'falhou', deps({ lida: l }).d), 'ja-tem-gente', JSON.stringify(l));
  }
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ unidade: { pausaDesde: new Date(T0 - 3600_000), pausaAte: new Date(T0 + 3600_000) } as Partial<Unit> }).d), 'pausada');
});

test('a Sofia do CRM respeita a janela da IA (#476): fora dela quem atende é a equipe e o «teto» NÃO gera alerta falso; dentro dela, avisa', async () => {
  // expediente da equipe quinta 6h30–18h: às 12h a IA está calada (a equipe atende) — o «teto» da rodada não deixou ninguém sem resposta que a Sofia fosse dar
  const exp = { thu: { start: '06:30', end: '18:00' } };
  const comJanela = { businessHoursEnabled: true, businessHoursExpediente: exp, businessHoursTimezone: 'America/Sao_Paulo' } as Partial<Unit>;
  const calada = deps({ unidade: comJanela });
  assert.equal(await conferirSofiaParou(M, 'teto', calada.d), 'fora-do-horario-da-ia');
  assert.equal(await conferirSofiaParou(M, 'falhou', calada.d), 'fora-do-horario-da-ia');
  assert.equal(calada.enviados.length, 0);
  assert.equal(pendentesDoVigia(), 0, 'nem fica para o resumo');
  // às 19h (fora do expediente) a IA atende: a falha é de verdade; 19h30 de São Paulo = 22h30Z
  const agoraNoite = T0 + 7 * 3600_000 + 30 * 60_000;
  const atende = deps({ unidade: comJanela, agora: () => agoraNoite, mensagens: [{ ...doPaciente(0), created_at: Math.floor((agoraNoite - 30 * 60_000) / 1000) }] });
  assert.equal(await conferirSofiaParou(M, 'teto', atende.d), 'avisou', '19h30: a IA atende e a equipe ainda está no horário do alerta (até 20h)');
});

test('FORA do horário da equipe o aviso não sai: fica numa lista e, quando a clínica ABRE, sai UM resumo com quem AINDA espera (quem a equipe atendeu sai)', async () => {
  let agora = Date.parse('2026-11-27T01:00:00Z'); // quinta 22h em São Paulo: a equipe já fechou
  const falas: Record<number, any[]> = {};
  const respondidos = new Set<number>();
  const a = deps({ agora: () => agora });
  // cada conversa tem a sua última mensagem: a do paciente há 40 min, ou já respondida pela equipe depois
  a.d.mensagens = async (c) => (respondidos.has(c) ? [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor((agora - 3600_000) / 1000) }, { message_type: 1, private: false, content: 'Oi! Aqui é a recepção', created_at: Math.floor(agora / 1000) }] : (falas[c] ??= [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor((agora - 40 * 60_000) / 1000) }]));
  const r = await Promise.all([20, 21, 22, 23].map((c) => conferirSofiaParou({ slug: M.slug, conversa: c }, c === 20 ? 'teto' : 'falhou', a.d)));
  assert.deepEqual(r, ['acumulada', 'acumulada', 'acumulada', 'acumulada']);
  assert.equal(a.enviados.length, 0, 'de noite nada sai');
  assert.equal(pendentesDoVigia(), 4);
  // ainda fechada: a varredura espera
  assert.equal(await descarregarPendentes(), 0);
  // a equipe atende a 22 de manhã cedo, antes de abrir
  respondidos.add(22);
  // sexta 9h em São Paulo = 12h Z: aberta
  agora = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(await descarregarPendentes(), 1, 'UM resumo');
  assert.equal(a.enviados.length, 1);
  const t = a.enviados[0]!.texto;
  assert.match(t, /^⚠️ A Sofia parou de responder no CRM e 3 pacientes seguem sem resposta:/);
  for (const c of [20, 21, 23]) assert.match(t, new RegExp(`conversa ${c} https://crm/app/accounts/1/conversations/${c}`));
  assert.doesNotMatch(t, /conversa 22 /, 'a que a equipe atendeu sai da lista');
  assert.equal(pendentesDoVigia(), 0);
  // não repete: a segunda varredura não manda de novo
  assert.equal(await descarregarPendentes(), 0);
  assert.equal(a.enviados.length, 1);
});

test('TETO POR UNIDADE (todos os motivos, inclusive «falhou»): 30 conversas paradas ao mesmo tempo viram 1 aviso + 1 resumo; outro motivo e outra unidade avisam', async () => {
  let agora = T0;
  const a = deps({ agora: () => agora, env: { ...ENV, AVISO_CLINICA_AGENDAMENTO_DESTINOS: '{"doutor-hernia-parauapebas":"1203630@g.us","doutor-hernia-caxias":"999@g.us"}' } });
  for (const desfecho of ['teto', 'falhou']) {
    agora = T0;
    esquecerAvisosDoVigia();
    a.enviados.length = 0;
    const conversas = Array.from({ length: 30 }, (_, i) => 100 + i);
    // as 30 chegam juntas (Promise.all: a reserva da janela tem de ser síncrona, senão todas passam)
    const r = await Promise.all(conversas.map((c) => conferirSofiaParou({ slug: M.slug, conversa: c }, desfecho, a.d)));
    assert.equal(r.filter((x) => x === 'avisou').length, 1, `${desfecho}: ${JSON.stringify(r)}`);
    assert.equal(r.filter((x) => x === 'acumulada').length, 29, desfecho);
    assert.equal(a.enviados.length, 1, `${desfecho}: 30 conversas, 1 WhatsApp na hora`);
    assert.equal(pendentesDoVigia(), 29, 'as outras 29 não se perdem');
    // dentro dos 30 min o resumo ESPERA (foi a janela da unidade que segurou as 29); passada a janela sai UM com as 29
    assert.equal(await descarregarPendentes(), 0, 'antes dos 30 min nada sai');
    assert.equal(a.enviados.length, 1);
    agora = T0 + ENTRE_AVISOS_DA_UNIDADE_MS + 1000;
    assert.equal(await descarregarPendentes(), 1, 'passada a janela sai o resumo');
    assert.equal(a.enviados.length, 2, `${desfecho}: 1 aviso + 1 resumo`);
    assert.match(a.enviados[1]!.texto, /e 29 pacientes seguem sem resposta:.*e mais 21\./);
  }
  // outro motivo, mesma unidade: avisa na hora
  agora = T0;
  esquecerAvisosDoVigia();
  a.enviados.length = 0;
  assert.equal(await conferirSofiaParou({ slug: M.slug, conversa: 200 }, 'kommo-indisponivel', a.d), 'avisou');
  assert.equal(await conferirSofiaParou({ slug: M.slug, conversa: 201 }, 'kommo-indisponivel', a.d), 'acumulada');
  assert.equal(await conferirSofiaParou({ slug: M.slug, conversa: 202 }, 'sem-texto', a.d), 'avisou', 'outro motivo');
  // outra unidade, mesmo motivo: avisa
  assert.equal(await conferirSofiaParou({ slug: 'doutor-hernia-caxias', conversa: 300 }, 'kommo-indisponivel', a.d), 'avisou');
  assert.equal(a.enviados.length, 3);
  // passada a janela de 30 min a próxima conversa avisa de novo na hora
  agora = T0 + ENTRE_AVISOS_DA_UNIDADE_MS + 1000;
  assert.equal(await conferirSofiaParou({ slug: M.slug, conversa: 400 }, 'kommo-indisponivel', a.d), 'avisou');
});

test('teto por unidade: a recusa da Evolution libera a janela da unidade; o «só no papel» tem a sua e não gasta a do aviso de verdade', async () => {
  const r = deps({ envio: 'recusado' });
  assert.equal(await conferirSofiaParou(M, 'teto', r.d), 'recusado');
  assert.equal(await conferirSofiaParou({ ...M, conversa: 13 }, 'teto', deps().d), 'avisou', 'a recusa não gastou a janela da unidade');
  esquecerAvisosDoVigia();
  const seco = deps({ estado: 'seco' });
  assert.equal(await conferirSofiaParou(M, 'teto', seco.d), 'simulado');
  assert.equal(await conferirSofiaParou({ ...M, conversa: 13 }, 'teto', seco.d), 'acumulada', 'o seco também não repete por unidade');
  assert.equal(await conferirSofiaParou({ ...M, conversa: 14 }, 'teto', deps({ estado: 'ligado' }).d), 'avisou', 'o seco de antes não gastou a janela do aviso de verdade');
});

test('o resumo em «só no papel» só anota «alertaria» (nada sai) e o resumo da Evolution recusada fica para a próxima varredura', async () => {
  let agora = T0;
  const seco = deps({ estado: 'seco', agora: () => agora });
  assert.equal(await conferirSofiaParou(M, 'teto', seco.d), 'simulado');
  assert.equal(await conferirSofiaParou({ ...M, conversa: 13 }, 'teto', seco.d), 'acumulada');
  assert.equal(await descarregarPendentes(), 0, 'dentro dos 30 min a unidade espera');
  agora = T0 + ENTRE_AVISOS_DA_UNIDADE_MS + 1000;
  assert.equal(await descarregarPendentes(), 1);
  assert.equal(seco.enviados.length, 0);
  assert.equal(seco.simulados.length, 2, 'o aviso e o resumo, só anotados');
  assert.match(String((seco.simulados[1] as { valor: string }).valor), /1 paciente segue sem resposta/);
  esquecerAvisosDoVigia();
  let t = T0;
  const recusa = deps({ envio: 'recusado', agora: () => t });
  assert.equal(await conferirSofiaParou(M, 'teto', deps({ agora: () => t }).d), 'avisou');
  assert.equal(await conferirSofiaParou({ ...M, conversa: 13 }, 'teto', recusa.d), 'acumulada');
  t = T0 + ENTRE_AVISOS_DA_UNIDADE_MS + 1000;
  assert.equal(await descarregarPendentes(), 0, 'a Evolution recusou o resumo');
  assert.equal(pendentesDoVigia(), 1, 'a conversa segue esperando o próximo resumo');
});

test('a mensagem de espera do robô de demora NÃO é resposta; conversa que não leu NÃO é «já tem gente»; «só no papel» não gasta a janela do aviso de verdade', async () => {
  const espera = { message_type: 1, private: false, content: textoDaEspera(null), created_at: Math.floor((T0 - 10 * 60_000) / 1000) };
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ mensagens: [doPaciente(30), espera] }).d), 'avisou');
  esquecerAvisosDoVigia();
  const semLida = deps({ lida: null });
  assert.equal(await conferirSofiaParou(M, 'falhou', semLida.d), 'avisou');
  assert.match(semLida.enviados[0]!.texto, /\*um paciente\*/);
  esquecerAvisosDoVigia();
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ estado: 'seco' }).d), 'simulado');
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ estado: 'ligado' }).d), 'avisou', 'o seco de antes não conta como aviso');
});

test('chave desligada ou Sofia desligada: nada; SECO: só anota «alertaria» (nada sai); sem destino/instância: não manda', async () => {
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ estado: 'desligado' }).d), 'desligado');
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ sofia: 'seco' }).d), 'sofia-desligada');
  const s = deps({ estado: 'seco' });
  assert.equal(await conferirSofiaParou(M, 'falhou', s.d), 'simulado');
  assert.equal(s.enviados.length, 0);
  assert.equal(s.simulados.length, 1);
  assert.match(String((s.simulados[0] as { valor: string }).valor), /A Sofia parou de responder/);
  esquecerAvisosDoVigia();
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ env: {} }).d), 'sem-destino');
  assert.equal(await conferirSofiaParou(M, 'falhou', deps({ env: { AVISO_CLINICA_AGENDAMENTO_DESTINOS: ENV.AVISO_CLINICA_AGENDAMENTO_DESTINOS } }).d), 'sem-config');
});

test('peças: N minutos pelo env (padrão 15), tempo longo em horas, última fala do paciente, desfechos que contam', () => {
  assert.equal(minutosDoAlerta({}), 15);
  assert.equal(minutosDoAlerta({ CHATWOOT_SOFIA_PAROU_MIN: '30' } as NodeJS.ProcessEnv), 30);
  assert.equal(minutosDoAlerta({ CHATWOOT_SOFIA_PAROU_MIN: 'abc' } as NodeJS.ProcessEnv), 15);
  assert.match(textoDoAviso({ nome: 'Lead 123', minutos: 190, desfecho: 'teto', conversa: 7, link: null }), /^⚠️ A Sofia parou de responder no CRM: \*um paciente\* escreveu há 3 h e ninguém respondeu \(limite de respostas do dia\)\. Abra a conversa 7/);
  assert.equal(ultimaDoPacienteEm([{ message_type: 1, content: 'x' }]), null);
  assert.deepEqual([...DESFECHOS_QUE_PARAM].sort(), ['falhou', 'kommo-indisponivel', 'sem-texto', 'teto']);
});

// ── a rodada arma o vigia só quando deve ──────────────────────────────────────────────────────────

function portas(o: { estado: 'seco' | 'ligado'; sofia?: 'falha' | 'ok' | 'lanca'; teto?: boolean; lida?: Partial<ConversaLida> }) {
  const armados: Array<{ conversa: number; desfecho: string }> = [];
  const p: PortasDaIa = {
    estado: () => o.estado,
    unidade: async () => unit(),
    mensagens: async () => [{ message_type: 0, content: 'oi', private: false }],
    nota: async () => {},
    publica: async () => ({ usuario: 3 }),
    agendaReal: async () => [],
    passarParaEquipe: async () => {},
    transcrever: async () => '',
    conversa: async () => lida(o.lida),
    cartaoNoKommo: async () => null,
    sofia: async () => {
      if (o.sofia === 'lanca') throw new Error('modelo caiu');
      return o.sofia === 'falha' ? null : { resposta: 'Oi!', acoes: [], pix: null, cartao: null, passouParaEquipe: false };
    },
    agendar: (fn) => fn,
    cancelar: () => {},
    hoje: () => '2026-11-26',
    vigiarSofiaParou: (m, desfecho) => void armados.push({ conversa: m.conversa, desfecho }),
  };
  return { p, armados };
}
const MS = { conversa: 12, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] as string[] };

test('a rodada arma o alerta quando a Sofia LIGADA falha ou lança; não arma no seco, na resposta enviada, na conversa calada', async () => {
  const falha = portas({ estado: 'ligado', sofia: 'falha' });
  assert.equal(await rodarSofia(MS, falha.p, novaMemoriaDaIa()), 'falhou');
  assert.deepEqual(falha.armados, [{ conversa: 12, desfecho: 'falhou' }]);
  const lanca = portas({ estado: 'ligado', sofia: 'lanca' });
  await assert.rejects(() => rodarSofia(MS, lanca.p, novaMemoriaDaIa()));
  assert.deepEqual(lanca.armados, [{ conversa: 12, desfecho: 'falhou' }], 'exceção também conta');
  const semArmar: Array<[string, Parameters<typeof portas>[0]]> = [['seco', { estado: 'seco', sofia: 'falha' }], ['enviada', { estado: 'ligado', sofia: 'ok' }], ['calada', { estado: 'ligado', sofia: 'ok', lida: { etiquetas: ['esperando-humano'] } }]];
  for (const [nome, o] of semArmar) {
    const a = portas(o);
    await rodarSofia(MS, a.p, novaMemoriaDaIa());
    assert.deepEqual(a.armados, [], nome);
  }
});

// ── review do /code-review high (rodada 3) ─────────────────────────────────────────────────────────

test('Caxias (a IA atende 18h–6h30, a equipe 8h–20h): a falha da NOITE, relida quando a clínica abre, continua sendo da Sofia — a janela vale no instante em que o paciente escreveu', async () => {
  const exp = { fri: { start: '06:30', end: '18:00' }, thu: { start: '06:30', end: '18:00' } };
  const caxias = { businessHoursEnabled: true, businessHoursExpediente: exp, businessHoursTimezone: 'America/Sao_Paulo' } as Partial<Unit>;
  const escreveu = Date.parse('2026-11-27T02:00:00Z'); // quinta 23h em São Paulo: a IA atende
  let agora = escreveu + 20 * 60_000;
  const a = deps({ unidade: caxias, agora: () => agora, mensagens: [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor(escreveu / 1000) }] });
  assert.equal(await conferirSofiaParou(M, 'falhou', a.d), 'acumulada', '23h20: a equipe já fechou, fica para o resumo');
  agora = Date.parse('2026-11-27T12:00:00Z'); // sexta 9h: a IA está calada (a equipe atende), mas a falha foi da noite
  assert.equal(await descarregarPendentes(), 1, 'o resumo sai: a falha não é descartada pela janela de AGORA');
  assert.match(a.enviados[0]!.texto, /1 paciente segue sem resposta/);
});

test('o resumo não perde ninguém: erro ao reler uma conversa, Evolution recusando ou falta de destino deixam os pendentes na lista; passadas 24 h são largados', async () => {
  let agora = Date.parse('2026-11-27T01:00:00Z'); // quinta 22h: fechada
  let quebra = true;
  const a = deps({ agora: () => agora });
  const base = a.d.mensagens;
  a.d.mensagens = async (c) => {
    if (quebra && c === 32) throw new Error('chatwoot 500');
    return [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor((agora - 40 * 60_000) / 1000) }];
  };
  void base;
  for (const c of [31, 32, 33]) assert.equal(await conferirSofiaParou({ slug: M.slug, conversa: c }, 'falhou', a.d), c === 32 ? 'falhou' : 'acumulada');
  // 32 quebrou já na conferência (não entrou); as outras duas esperam
  assert.equal(pendentesDoVigia(), 2);
  agora = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(await descarregarPendentes(), 1);
  assert.equal(a.enviados.length, 1);
  assert.equal(pendentesDoVigia(), 0, 'saíram no resumo enviado');
  // sem destino: ficam; 24 h depois são largados
  esquecerAvisosDoVigia();
  agora = Date.parse('2026-11-27T01:00:00Z');
  const s = deps({ agora: () => agora, env: { AVISO_CLINICA_AGENDAMENTO_DESTINOS: ENV.AVISO_CLINICA_AGENDAMENTO_DESTINOS } });
  s.d.mensagens = async () => [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor((agora - 40 * 60_000) / 1000) }];
  // chave ligada mas sem a instância: a conferência nem acumula (sem-config)
  assert.equal(await conferirSofiaParou(M, 'falhou', s.d), 'sem-config');
  // com tudo configurado mas a Evolution recusando o resumo: a conversa fica
  esquecerAvisosDoVigia();
  const r = deps({ agora: () => agora, envio: 'recusado' });
  r.d.mensagens = s.d.mensagens;
  assert.equal(await conferirSofiaParou(M, 'falhou', r.d), 'acumulada');
  agora = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(await descarregarPendentes(), 0);
  assert.equal(pendentesDoVigia(), 1, 'a Evolution recusou: continua na lista');
  agora = Date.parse('2026-11-29T12:00:00Z'); // 2 dias depois, em dia útil... sábado 28 é a equipe? domingo 29 fecha: espera abrir não importa, a validade vence antes
  await descarregarPendentes();
  assert.equal(pendentesDoVigia(), 0, 'passou de 24 h: largado');
});

test('duas varreduras não andam ao mesmo tempo (a janela do resumo só é reservada no envio: a segunda esperaria o mesmo pendente e mandaria de novo)', async () => {
  let agora = Date.parse('2026-11-27T01:00:00Z');
  const a = deps({ agora: () => agora });
  a.d.mensagens = async () => [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor((agora - 40 * 60_000) / 1000) }];
  assert.equal(await conferirSofiaParou(M, 'falhou', a.d), 'acumulada');
  agora = Date.parse('2026-11-27T12:00:00Z');
  const [x, y] = await Promise.all([descarregarPendentes(), descarregarPendentes()]);
  assert.equal(x + y, 1, 'um resumo só');
  assert.equal(a.enviados.length, 1);
});

// ── retomada no boot: o servidor reinicia no meio da noite e o resumo da manhã ainda lista quem está sem resposta ─────────────────────

const ev = (conversa: number, tipo: string, nome: string | null, em: string, unitSlug = M.slug): EventoDoRegistro => ({ unitSlug, conversa, tipo, nome, criadoEm: new Date(em) });

test('Registro → parados: o ÚLTIMO evento de cada conversa; só falha/teto/sem-texto/Kommo-indisponível deixam parado; uma rodada que marcou, passou à equipe ou foi calada depois tira da lista', () => {
  const p = paradosDoRegistro([
    ev(1, 'decisao', 'falhou', '2026-11-27T01:00:00Z'),
    ev(2, 'decisao', 'teto', '2026-11-27T01:05:00Z'),
    ev(3, 'decisao', 'falhou', '2026-11-27T01:10:00Z'),
    ev(3, 'marcou', null, '2026-11-27T01:20:00Z'), // falhou, depois a Sofia marcou
    ev(4, 'decisao', 'falhou', '2026-11-27T01:10:00Z'),
    ev(4, 'decisao', 'equipe-respondeu', '2026-11-27T01:30:00Z'),
    ev(5, 'decisao', 'calada', '2026-11-27T01:10:00Z'),
    ev(6, 'decisao', 'kommo-indisponivel', '2026-11-27T01:12:00Z'),
    ev(6, 'decisao', 'falhou', '2026-11-27T01:40:00Z', 'doutor-hernia-caxias'), // outra unidade com o MESMO número de conversa não mistura
    ev(7, 'decisao', 'sem-texto', '2026-11-27T01:14:00Z'),
  ]);
  assert.deepEqual(p.map((x) => `${x.slug}|${x.conversa}|${x.desfecho}`).sort(), [`${M.slug}|1|falhou`, `${M.slug}|2|teto`, `${M.slug}|6|kommo-indisponivel`, `${M.slug}|7|sem-texto`, 'doutor-hernia-caxias|6|falhou'].sort());
});

test('retomada: rearma com o que FALTA dos 15 min (quem já passou do prazo, já), em lotes escalonados; nunca lança; só olha as últimas 24 h', async () => {
  const agora = Date.parse('2026-11-27T02:00:00Z');
  const armadas: Array<{ conversa: number; esperaMs: number }> = [];
  let pediu: Date | null = null;
  const eventos = [
    ev(1, 'decisao', 'falhou', '2026-11-27T01:52:00Z'), // 8 min atrás: faltam 7
    ...Array.from({ length: 45 }, (_, i) => ev(100 + i, 'decisao', 'teto', '2026-11-27T01:00:00Z')), // 1 h atrás: já passou do prazo
  ];
  const n = await retomarDoRegistro({ eventos: async (desde) => ((pediu = desde), eventos), armar: (p, esperaMs) => void armadas.push({ conversa: p.conversa, esperaMs }), agora: () => agora, env: {} });
  assert.equal(n, 46);
  assert.equal(pediu!.getTime(), agora - 24 * 3600_000, 'as últimas 24 h');
  assert.equal(armadas.find((a) => a.conversa === 1)!.esperaMs, 7 * 60_000);
  const velhas = armadas.filter((a) => a.conversa >= 100).map((a) => a.esperaMs);
  assert.equal(velhas.filter((e) => e === 0).length, LOTE_DA_RETOMADA, 'o 1º lote vai já');
  assert.equal(Math.max(...velhas), 2 * ENTRE_LOTES_DA_RETOMADA_MS, '45 conversas = 3 lotes: 0, 3 s e 6 s');
  // o Registro fora do ar não derruba o boot
  assert.equal(await retomarDoRegistro({ eventos: async () => { throw new Error('banco fora'); }, armar: () => undefined, agora: () => agora }), 0);
});

test('o servidor REINICIA no meio da noite: a lista é reconstruída do Registro e o resumo da manhã ainda traz quem segue sem resposta (e não quem a equipe atendeu)', async () => {
  // quinta 23h (SP) as falhas aconteceram; o servidor foi reiniciado às 2h (sexta) — a memória (pendentes) zerou
  const falhouEm = Date.parse('2026-11-27T02:00:00Z'); // quinta 23h em São Paulo
  esquecerAvisosDoVigia(); // = o processo novo
  let agora = Date.parse('2026-11-27T05:00:00Z'); // sexta 2h: a equipe está fechada
  const respondidos = new Set<number>();
  const a = deps({ agora: () => agora });
  a.d.mensagens = async (c) => [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor(falhouEm / 1000) }, ...(respondidos.has(c) ? [{ message_type: 1, private: false, content: 'Oi! Aqui é a recepção', created_at: Math.floor((agora + 1) / 1000) }] : [])];
  // o Registro guardou as 3 falhas da noite
  const eventos = [ev(41, 'decisao', 'falhou', '2026-11-27T02:00:00Z'), ev(42, 'decisao', 'teto', '2026-11-27T02:03:00Z'), ev(43, 'decisao', 'falhou', '2026-11-27T02:05:00Z')];
  // o «armar» do servidor faria um setTimeout; aqui a conferência roda na hora (o prazo de 15 min já tinha passado)
  const resultados: string[] = [];
  const n = await retomarDoRegistro({
    eventos: async () => eventos,
    agora: () => agora,
    env: {},
    armar: async (p) => void resultados.push(await conferirSofiaParou({ slug: p.slug, conversa: p.conversa }, p.desfecho, a.d)),
  });
  assert.equal(n, 3);
  assert.deepEqual(resultados, ['acumulada', 'acumulada', 'acumulada'], 'de madrugada nada sai: fica para o resumo');
  assert.equal(a.enviados.length, 0);
  assert.equal(pendentesDoVigia(), 3, 'a lista foi reconstruída');
  // a recepção atende a 42 ainda de madrugada (pelo celular)
  respondidos.add(42);
  // sexta 9h em São Paulo: a clínica abre
  agora = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(await descarregarPendentes(), 1, 'UM resumo');
  assert.equal(a.enviados.length, 1);
  const t = a.enviados[0]!.texto;
  assert.match(t, /^⚠️ A Sofia parou de responder no CRM e 2 pacientes seguem sem resposta:/);
  assert.match(t, /conversa 41 /);
  assert.match(t, /conversa 43 /);
  assert.doesNotMatch(t, /conversa 42 /, 'a que a recepção atendeu sai');
});

test('o aviso que SAIU vai para o Registro (`alerta-parou`): a retomada do boot não o repete; o «só no papel» não grava; uma falha NOVA depois do aviso volta à lista', async () => {
  const a = deps();
  assert.equal(await conferirSofiaParou(M, 'falhou', a.d), 'avisou');
  assert.deepEqual(a.registrados, [{ slug: M.slug, conversa: 12, desfecho: 'falhou' }]);
  const s = deps({ estado: 'seco' });
  assert.equal(await conferirSofiaParou({ ...M, conversa: 13 }, 'falhou', s.d), 'simulado');
  assert.deepEqual(s.registrados, []);
  // Registro depois do aviso: o último evento é o aviso → não é «parado»
  const parados = (evs: EventoDoRegistro[]) => paradosDoRegistro(evs).map((p) => p.conversa);
  assert.deepEqual(parados([ev(12, 'decisao', 'falhou', '2026-11-27T01:00:00Z'), ev(12, 'alerta-parou', 'falhou', '2026-11-27T01:16:00Z')]), []);
  assert.deepEqual(parados([ev(12, 'decisao', 'falhou', '2026-11-27T01:00:00Z'), ev(12, 'alerta-parou', 'falhou', '2026-11-27T01:16:00Z'), ev(12, 'decisao', 'teto', '2026-11-27T03:00:00Z')]), [12], 'falha nova depois do aviso');
  // o resumo também grava, uma linha por conversa
  let agora = Date.parse('2026-11-27T01:00:00Z');
  const r = deps({ agora: () => agora });
  r.d.mensagens = async () => [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor((agora - 40 * 60_000) / 1000) }];
  await conferirSofiaParou({ ...M, conversa: 51 }, 'falhou', r.d);
  await conferirSofiaParou({ ...M, conversa: 52 }, 'falhou', r.d);
  agora = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(await descarregarPendentes(), 1);
  assert.deepEqual(r.registrados.map((x) => [x.conversa, x.desfecho]).sort(), [[51, 'resumo'], [52, 'resumo']]);
});

test('o pendente reconstruído conta as 24 h da FALHA, não do boot: o de 23 h atrás é largado 1 h depois, não 24 h depois', async () => {
  const falhou = Date.parse('2026-11-27T01:00:00Z');
  let agora = falhou + 23 * 3600_000; // sexta 23h (SP): equipe fechada
  const a = deps({ agora: () => agora });
  a.d.mensagens = async () => [{ message_type: 0, private: false, content: 'oi', created_at: Math.floor(falhou / 1000) }];
  assert.equal(await conferirSofiaParou(M, 'falhou', a.d, falhou), 'acumulada');
  agora = falhou + 25 * 3600_000;
  await descarregarPendentes();
  assert.equal(pendentesDoVigia(), 0, 'passou de 24 h da falha');
});

test('a retomada roda UMA vez por processo e só arma unidade que o servidor conhece, na conta DELA (ambiente = a do ambiente); chave desligada não arma', async () => {
  const { retomarVigiasDoRegistro, esquecerRetomadaDaVigia } = await import('./chatwoot-ia.js');
  esquecerRetomadaDaVigia();
  const armadas: Array<{ conta: number; slug: string; conversa: number; esperaMs: number; falhouEm: number }> = [];
  const portas = (conta: number) => ({ portas: { vigiarSofiaParou: (m: { slug: string; conversa: number }, _d: string, r: { esperaMs: number; falhouEm: number }) => void armadas.push({ conta, slug: m.slug, conversa: m.conversa, esperaMs: r.esperaMs, falhouEm: r.falhouEm }) } }) as never;
  const eventos = async () => [
    ev(1, 'decisao', 'falhou', new Date(Date.now() - 5 * 60_000).toISOString(), 'u-ambiente'),
    ev(2, 'decisao', 'falhou', new Date(Date.now() - 5 * 60_000).toISOString(), 'u-propria'),
    ev(3, 'decisao', 'falhou', new Date(Date.now() - 5 * 60_000).toISOString(), 'u-desconhecida'),
    ev(4, 'decisao', 'falhou', new Date(Date.now() - 5 * 60_000).toISOString(), 'u-desligada'),
  ];
  const e = { CHATWOOT_URL: 'https://crm.exemplo', CHATWOOT_CONTA_ID: '1', CHATWOOT_API_TOKEN: 'x' } as NodeJS.ProcessEnv;
  const dep = {
    eventos,
    estadoDaChave: (slug: string): Estado => (slug === 'u-desligada' ? 'desligado' : 'seco'),
    contaDaUnidade: ((slug: string) => (slug === 'u-ambiente' ? null : slug === 'u-propria' ? 7 : undefined)) as never,
    estadoDoReceptor: ((conta: number) => portas(conta)) as never,
  };
  const n = await retomarVigiasDoRegistro(e, dep);
  assert.equal(n, 4, 'as 4 passam pela retomada; quem arma é o «armar»');
  const por = Object.fromEntries(armadas.map((x) => [x.slug, x.conta]));
  assert.equal(por['u-propria'], 7, 'a conta DA unidade');
  assert.equal(por['u-ambiente'], 1, 'unidade do ambiente: a conta do ambiente (CHATWOOT_CONTA_ID)');
  assert.ok(!('u-desconhecida' in por), 'unidade que o servidor não conhece: nunca cai na conta de outra clínica');
  assert.ok(!('u-desligada' in por), 'chave desligada não arma');
  for (const x of armadas) assert.ok(x.esperaMs > 8 * 60_000 && x.esperaMs <= 10 * 60_000, `faltam ~10 min dos 15 (5 min atrás): ${x.esperaMs}`);
  // segunda chamada no mesmo processo: nada
  assert.equal(await retomarVigiasDoRegistro(e, dep), 0);
  esquecerRetomadaDaVigia();
});
