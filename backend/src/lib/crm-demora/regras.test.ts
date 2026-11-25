/**
 * As regras puras da «demora a responder». O que se prova aqui:
 *  - a espera da equipe conta pela 1ª mensagem do paciente depois da última resposta HUMANA — a mensagem de espera, a régua (usuário 2) e as
 *    notas NÃO a zeram, e o eco do celular e o usuário do CRM zeram;
 *  - a Sofia é um piso (o que ela respondeu não espera a equipe) e a passagem dela abre a espera na hora da passagem;
 *  - cada passo só vale dentro do horário, do prazo e sem as travas (Sofia atendendo, sem-follow-up, janela de 24 h, interno, grupo…).
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../prisma.js';

Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });

const M = await import('./marca.js');
const R = await import('./regras.js');
const T = await import('../crm-tarefas/regras.js');
const S = await import('../chatwoot-sofia.js');

const FUSO = 'America/Sao_Paulo';
/** terça 18/11/2026, 15:00 em São Paulo */
const AGORA = T.localParaUtc('2026-11-18T15:00', FUSO)!;
const sec = (minutosAtras: number) => Math.floor((AGORA.getTime() - minutosAtras * 60_000) / 1000);
let id = 0;
const P = (min: number, content = 'quero marcar uma consulta', extra: object = {}) => ({ id: ++id, message_type: 0, private: false, content, created_at: sec(min), sender: { type: 'contact', id: 55 }, ...extra });
const HUMANO = (min: number) => ({ id: ++id, message_type: 1, private: false, content: 'Oi, tudo bem?', created_at: sec(min), sender: { id: 4, type: 'user', name: 'Cleia' } });
const ECO = (min: number) => ({ id: ++id, message_type: 1, private: false, content: 'respondi pelo celular', created_at: sec(min), sender: null, content_attributes: { external_echo: true } });
const ROBO = (min: number, content = 'Lembrete: sua consulta é amanhã') => ({ id: ++id, message_type: 1, private: false, content, created_at: sec(min), sender: { id: 2, type: 'user', name: 'Sofia' } });
const SOFIA = (min: number) => ({ id: ++id, message_type: 1, private: false, content: 'Posso te ajudar com o valor?', created_at: sec(min), sender: { id: 1, type: 'agent_bot', name: 'Sofia' } });
const ESPERA = (min: number, nome = 'Maria') => ({ id: ++id, message_type: 1, private: false, content: M.textoDaEspera(nome), created_at: sec(min), sender: { id: 2, type: 'user' } });
const NOTA = (min: number, content: string) => ({ id: ++id, message_type: 1, private: true, content, created_at: sec(min), sender: { id: 2, type: 'user' } });
const ATIVIDADE = (min: number) => ({ id: ++id, message_type: 2, private: false, content: 'Conversa atribuída', created_at: sec(min) });

const espera = (msgs: unknown[], esperandoHumano = false) => R.esperaDaEquipe(R.mensagensDaConversa(msgs), { esperandoHumano });
const min = (d: Date | undefined) => (d ? Math.round((AGORA.getTime() - d.getTime()) / 60_000) : null);

// ── a marca ──────────────────────────────────────────────────────────────────────────────────────

test('a mensagem de espera tem o texto combinado e é reconhecida pela API e pelo webhook; o paciente citando a frase não vira marca', () => {
  assert.equal(M.textoDaEspera('Maria'), 'Oi, Maria! Recebemos sua mensagem 😊 Já já alguém da equipe te responde.');
  assert.equal(M.textoDaEspera(null), 'Oi! Recebemos sua mensagem 😊 Já já alguém da equipe te responde.');
  assert.equal(M.ehMensagemDeEspera(ESPERA(5)), true, 'API (message_type numérico)');
  assert.equal(M.ehMensagemDeEspera({ event: 'message_created', message_type: 'outgoing', private: false, content: M.textoDaEspera('Ana') }), true, 'webhook (message_type em texto)');
  assert.equal(M.ehMensagemDeEspera({ message_type: 1, content: 'qualquer coisa', content_attributes: { demora_espera: true } }), true, 'marca explícita');
  assert.equal(M.ehMensagemDeEspera({ message_type: 0, content: M.textoDaEspera('Ana') }), false, 'mensagem do paciente');
  assert.equal(M.ehMensagemDeEspera({ message_type: 1, private: true, content: M.textoDaEspera('Ana') }), false, 'nota privada');
  assert.equal(M.ehMensagemDeEspera(HUMANO(1)), false);
  assert.equal(M.ehMensagemDeEspera(null), false);
});

test('a nota de passagem da Sofia é a que o código da Sofia escreve (se o texto dela mudar, esta prova quebra)', async () => {
  const notas: string[] = [];
  const porta = {
    conversa: async () => ({ etiquetas: [] as string[], attrs: {} }),
    adicionarEtiquetas: async () => undefined,
    valoresDoAtributo: async () => [] as string[],
    gravarAtributos: async () => undefined,
    nota: async (_: number, t: string) => void notas.push(t),
    destinoDaPassagem: async () => ({ id: 5, nome: 'Maria Heloisa' }),
  };
  await S.passarParaEquipeNoChatwoot(porta as never, { conversa: 9, etapa: 'Novo lead', motivo: 'quer falar com gente' });
  await S.passarParaEquipeNoChatwoot({ ...porta, destinoDaPassagem: undefined } as never, { conversa: 9, etapa: 'Novo lead', motivo: 'x' });
  assert.equal(notas.length, 2);
  for (const n of notas) assert.equal(M.ehNotaDePassagem(n), true, n);
});

// ── classificar ──────────────────────────────────────────────────────────────────────────────────

test('classificar: paciente, humano (CRM e celular), Sofia, robô e o que não conta', () => {
  const papel = (m: unknown) => R.classificarMensagem(m)?.papel ?? null;
  assert.equal(papel(P(3)), 'paciente');
  assert.equal(papel(HUMANO(3)), 'humano');
  assert.equal(papel(ECO(3)), 'humano', 'eco do celular');
  assert.equal(papel({ ...ECO(3), content_attributes: '{"external_echo":true}' }), 'humano', 'content_attributes como texto JSON');
  assert.equal(papel({ ...ECO(3), sender: { id: 7, type: 'user', name: '📱 Celular da unidade' } }), 'humano', 'usuário do celular da caixa Evolution');
  assert.equal(papel(SOFIA(3)), 'sofia');
  assert.equal(papel(ROBO(3)), 'robo', 'régua/tarefas saem pelo usuário 2');
  assert.equal(papel({ ...ROBO(3), message_type: 3 }), 'robo', 'template');
  assert.equal(papel(ESPERA(3)), null, 'a nossa mensagem de espera não conta para nada');
  assert.equal(papel(NOTA(3, 'uma nota qualquer')), null);
  assert.equal(papel(NOTA(3, '🙋 A Sofia passou esta conversa para você: quer falar com gente')), 'passagem');
  assert.equal(papel(ATIVIDADE(3)), null);
  assert.equal(papel({ message_type: 1, content: 'saída sem remetente nem eco', created_at: sec(3) }), 'humano', 'na dúvida é gente: não incomoda ninguém');
  assert.equal(papel({ message_type: 0, content: 'x', created_at: 'lixo' }), null);
});

test('classificar: «ok, obrigada» é cortesia; anexo e áudio sem texto não são', () => {
  const c = (m: unknown) => R.classificarMensagem(m)?.cortesia;
  assert.equal(c(P(3, 'ok, obrigada')), true);
  assert.equal(c(P(3, 'quanto custa?')), false);
  assert.equal(c(P(3, '', { attachments: [{ file_type: 'audio' }] })), false);
});

// ── a espera da equipe ───────────────────────────────────────────────────────────────────────────

test('a espera abre na 1ª mensagem do paciente que ninguém respondeu', () => {
  assert.equal(min(espera([P(8), P(6), P(2)])?.desde), 8);
  assert.equal(espera([]), null);
  assert.equal(espera([HUMANO(10)]), null);
});

test('CUIDADO CENTRAL: a mensagem de espera, a régua e as notas NÃO zeram a espera da equipe', () => {
  // o Chatwoot zeraria o waiting_since aqui; a conta pelas mensagens não
  assert.equal(min(espera([P(12), ESPERA(7)])?.desde), 12);
  assert.equal(min(espera([P(12), ROBO(9), NOTA(8, '🔔 [@Maria](mention://user/5/Maria) ⏰ esperando'), ESPERA(7), ATIVIDADE(6)])?.desde), 12);
  // a régua falou DEPOIS de o paciente escrever: continua esperando desde a mensagem dele
  assert.equal(min(espera([ROBO(40), P(20), ROBO(15)])?.desde), 20);
});

test('resposta HUMANA zera a espera: usuário do CRM e celular; o paciente que volta abre outra', () => {
  assert.equal(espera([P(12), HUMANO(9)]), null);
  assert.equal(espera([P(12), ECO(9)]), null, 'respondeu pelo celular');
  assert.equal(min(espera([P(30), HUMANO(25), P(11), ESPERA(6)])?.desde), 11);
  // a espera de antes não conta para a de agora, mesmo com mensagem de espera no meio
  assert.equal(min(espera([P(60), ESPERA(55), HUMANO(50), P(7)])?.desde), 7);
});

test('a Sofia é um piso: o que ela respondeu não espera a equipe', () => {
  assert.equal(espera([P(20), SOFIA(19)]), null);
  assert.equal(min(espera([P(20), SOFIA(19), P(8)])?.desde), 8);
  // sem a Sofia no meio (só a régua), a espera conta da primeira
  assert.equal(min(espera([P(20), ROBO(19), P(8)])?.desde), 20);
});

test('a passagem da Sofia abre a espera NA HORA da passagem, não 20 minutos antes', () => {
  const passou = NOTA(9, '🙋 A Sofia passou esta conversa para você: pediu humano');
  // 20 min de papo com a Sofia, passou há 9 min, ninguém respondeu: espera de 9 min (e não de 30)
  assert.equal(min(espera([P(30), SOFIA(29), P(12), SOFIA(11), passou], true)?.desde), 9);
  // sem a passagem de pé (alguém reativou a Sofia / tirou a etiqueta) vale a regra da Sofia como piso
  assert.equal(espera([P(30), SOFIA(29), P(12), SOFIA(11), passou], false), null);
  // a equipe respondeu depois da passagem: nada
  assert.equal(espera([P(30), SOFIA(29), passou, HUMANO(5)], true), null);
  // o paciente continua escrevendo depois da passagem: a espera segue da passagem
  assert.equal(min(espera([P(30), passou, P(4)], true)?.desde), 9);
  // mesmo que a fala pública da Sofia venha uns segundos DEPOIS da nota
  assert.equal(min(espera([P(30), passou, SOFIA(9)], true)?.desde), 9);
});

test('cortesia depois de uma resposta nossa não abre espera; o 1º «bom dia» do lead abre', () => {
  assert.equal(espera([P(30), HUMANO(25), P(8, 'ok, obrigada 🙏')]), null);
  assert.equal(espera([ROBO(30), P(8, 'ok')]), null, 'resposta ao lembrete da régua');
  assert.equal(min(espera([P(8, 'bom dia')])?.desde), 8, 'primeiro contato: ninguém falou ainda');
  assert.equal(min(espera([P(30), HUMANO(25), P(9, 'ok, obrigada'), P(8, 'e quanto custa?')])?.desde), 8);
  assert.equal(min(espera([P(30), HUMANO(25), P(8, '', { attachments: [{ file_type: 'audio' }] })])?.desde), 8, 'áudio é mensagem de verdade');
});

test('devolve também a última mensagem do paciente (a janela de 24 h conta dela)', () => {
  assert.equal(min(espera([P(30), P(12), ROBO(5)])?.ultimaDoPaciente ?? undefined), 12);
});

// ── a decisão ────────────────────────────────────────────────────────────────────────────────────

const JANELA = T.janelaDeEnvio({});
const LIDA = { etiquetas: [] as string[], grupo: false, interno: false, attrs: {} as Record<string, unknown> };
function decidir(minutosDeEspera: number, o: Partial<import('./regras.js').EntradaDaDecisao> & { ultimaDoPacienteMin?: number } = {}) {
  const desde = new Date(AGORA.getTime() - minutosDeEspera * 60_000);
  const ult = new Date(AGORA.getTime() - (o.ultimaDoPacienteMin ?? minutosDeEspera) * 60_000);
  return R.decidirDemora({ espera: { desde, ultimaDoPaciente: ult, pelaPassagem: false }, agora: AGORA, fuso: FUSO, janela: JANELA, status: 'open', lida: LIDA, iaLigada: false, caixaOficial: true, ...o });
}

test('os três passos vencem aos 5, 10 e 30 minutos', () => {
  assert.deepEqual(decidir(4).devidos, []);
  assert.deepEqual(decidir(5).devidos, ['espera']);
  assert.deepEqual(decidir(9).devidos, ['espera']);
  assert.deepEqual(decidir(10).devidos, ['espera', 'aviso-10']);
  assert.deepEqual(decidir(31).devidos, ['espera', 'aviso-10', 'aviso-30']);
  assert.deepEqual(R.decidirDemora({ espera: null, agora: AGORA, fuso: FUSO, janela: JANELA, status: 'open', lida: LIDA, iaLigada: false, caixaOficial: true }).devidos, []);
});

test('passo atrasado demais não sai (servidor parado não vira rajada)', () => {
  assert.deepEqual(decidir(61).devidos, ['aviso-10', 'aviso-30'], 'a espera ao paciente vale até 60 min');
  assert.deepEqual(decidir(91).devidos, ['aviso-30']);
  assert.deepEqual(decidir(181).devidos, []);
  assert.ok(decidir(181).barrados.some((b) => b.motivo.includes('prazo')));
});

test('só dentro das 8h–20h da unidade (nada à noite, para o paciente nem para a equipe) e a espera conta só as horas de atender', () => {
  const em = (local: string) => T.localParaUtc(local, FUSO)!;
  const na = (agora: Date, desde: Date) => ({ agora, espera: { desde, ultimaDoPaciente: desde, pelaPassagem: false } });
  // 21h: fora do horário, mesmo com 40 min de espera
  assert.deepEqual(decidir(40, na(em('2026-11-18T21:00'), em('2026-11-18T20:20'))).devidos, []);
  // escreveu 7h48; às 8h00 ainda não houve um minuto sequer de espera dentro do horário; às 8h12, 12 minutos
  assert.deepEqual(decidir(0, na(em('2026-11-18T08:00'), em('2026-11-18T07:48'))).devidos, []);
  assert.deepEqual(decidir(0, na(em('2026-11-18T08:12'), em('2026-11-18T07:48'))).devidos, ['espera', 'aviso-10']);
  // a conversa mais parada da NOITE: escreveu às 20h10, ninguém respondeu; às 8h07 do dia seguinte são 7 min úteis (e 11 h 57 min corridos)
  const noite = decidir(0, na(em('2026-11-19T08:07'), em('2026-11-18T20:10')));
  assert.deepEqual(noite.devidos, ['espera']);
  assert.equal(noite.minutos, 7);
  assert.equal(noite.minutosReais, 717);
  assert.deepEqual(decidir(0, na(em('2026-11-19T08:11'), em('2026-11-18T20:10'))).devidos, ['espera', 'aviso-10']);
  // mas a conversa de ontem à tarde, já estourada em horas de atender, não volta
  assert.deepEqual(decidir(0, na(em('2026-11-19T09:00'), em('2026-11-18T14:00'))).devidos, []);
});

test('minutosUteis e duracaoCurta', () => {
  const em = (local: string) => T.localParaUtc(local, FUSO)!;
  const u = (a: string, b: string) => R.minutosUteis(em(a), em(b), FUSO, JANELA);
  assert.equal(u('2026-11-18T10:00', '2026-11-18T10:30'), 30);
  assert.equal(u('2026-11-18T19:50', '2026-11-18T20:30'), 10, 'só até as 20h');
  assert.equal(u('2026-11-18T19:00', '2026-11-19T09:00'), 120, '1 h de hoje + 1 h de amanhã');
  assert.equal(u('2026-11-18T22:00', '2026-11-19T07:00'), 0, 'a noite inteira');
  assert.equal(u('2026-11-18T12:00', '2026-11-18T11:00'), 0);
  assert.equal(R.minutosUteis(em('2026-11-01T12:00'), em('2026-11-18T12:00'), FUSO, JANELA), 999_999, 'mais de uma semana: muito');
  assert.equal(R.duracaoCurta(10), '10 min');
  assert.equal(R.duracaoCurta(120), '2 h');
  assert.equal(R.duracaoCurta(717), '11 h 57 min');
});

test('classificar: o conector de OUTRA conta (id que não é o 2) é robô quando a conta diz qual é', () => {
  const doConector = { ...ROBO(3), sender: { id: 31, type: 'user' } };
  assert.equal(R.classificarMensagem(doConector)?.papel, 'humano', 'sem saber, na dúvida é gente (não incomoda ninguém)');
  assert.equal(R.classificarMensagem(doConector, new Set([31]))?.papel, 'robo');
  assert.equal(min(R.esperaDaEquipe(R.mensagensDaConversa([P(20), doConector], new Set([31])), { esperandoHumano: false })?.desde), 20);
});

test('nunca para grupo, contato interno, histórico, conversa resolvida ou adiada', () => {
  const casos: Array<[typeof LIDA, string]> = [[{ ...LIDA, grupo: true }, 'open'], [{ ...LIDA, interno: true }, 'open'], [{ ...LIDA, etiquetas: ['historico'] }, 'open'], [LIDA, 'resolved'], [LIDA, 'snoozed']];
  for (const [lida, status] of casos) {
    assert.deepEqual(decidir(35, { lida, status }).devidos, [], `${JSON.stringify(lida)} ${status}`);
  }
  assert.deepEqual(decidir(35, { status: 'pending' }).devidos, ['espera', 'aviso-10', 'aviso-30'], 'pendente (robô) também espera a equipe');
});

test('histórico da Kommo: o rótulo historico só silencia enquanto a conversa é arquivo — o paciente que voltou é avisado; as outras seguem o rótulo', () => {
  const lida = { ...LIDA, etiquetas: ['historico'] };
  assert.deepEqual(decidir(35, { lida, historicoSilencia: true }).devidos, [], 'arquivo da Kommo (ninguém mexeu): calada');
  assert.deepEqual(decidir(35, { lida, historicoSilencia: false }).devidos, ['espera', 'aviso-10', 'aviso-30'], 'o paciente voltou depois da importação: a demora vale como em qualquer conversa');
  assert.deepEqual(decidir(35, { lida }).devidos, [], 'sem o campo vale o rótulo, como sempre valeu (Parauapebas, Instagram/Messenger)');
});

test('a mensagem ao paciente respeita sem-follow-up e a janela de 24 h; o aviso à equipe não', () => {
  assert.deepEqual(decidir(12, { lida: { ...LIDA, etiquetas: ['sem-follow-up'] } }).devidos, ['aviso-10'], 'o paciente pediu para não receber: a equipe ainda é avisada');
  assert.deepEqual(decidir(12, { ultimaDoPacienteMin: 24 * 60 }).devidos, ['aviso-10'], 'janela de 24 h fechada: sem texto livre');
  assert.deepEqual(decidir(12, { caixaOficial: false, ultimaDoPacienteMin: 24 * 60 }).devidos, ['espera', 'aviso-10'], 'caixa sem janela (Evolution)');
});

test('com a Sofia: etiqueta sofia-atendendo segura tudo até ela travar; prestes a responder segura só a mensagem ao paciente', () => {
  const at = { ...LIDA, etiquetas: ['sofia-atendendo'] };
  assert.deepEqual(decidir(12, { lida: at }).devidos, [], 'a Sofia está conversando');
  assert.deepEqual(decidir(16, { lida: at }).devidos, ['aviso-10'], 'travada há mais de 15 min: a equipe é avisada, o paciente não leva mensagem por cima da Sofia');
  assert.deepEqual(decidir(35, { lida: at }).devidos, ['aviso-10', 'aviso-30']);
  // Sofia ligada e capaz de responder; o paciente escreveu há 1 min (a rodada ainda vai ler a conversa)
  assert.deepEqual(decidir(12, { iaLigada: true, ultimaDoPacienteMin: 1 }).devidos, ['aviso-10']);
  assert.deepEqual(decidir(12, { iaLigada: true, ultimaDoPacienteMin: 4 }).devidos, ['espera', 'aviso-10'], 'passou da espera da rodada: ela já respondeu ou desistiu');
  // Sofia calada (pausada pela equipe): não vai responder, a mensagem de espera pode sair
  assert.deepEqual(decidir(12, { iaLigada: true, ultimaDoPacienteMin: 1, lida: { ...LIDA, etiquetas: ['ia-pausada'] } }).devidos, ['espera', 'aviso-10']);
});

test('chaves: o dia no fuso da unidade e o episódio (mesma espera = mesma chave)', () => {
  assert.equal(R.diaNoFuso(T.localParaUtc('2026-11-18T23:30', FUSO)!, FUSO), '2026-11-18');
  assert.equal(R.diaNoFuso(T.localParaUtc('2026-11-18T23:30', FUSO)!, 'Asia/Tokyo'), '2026-11-19');
  const d = new Date('2026-11-18T18:00:07.900Z');
  assert.equal(R.chaveDoEpisodio(d), R.chaveDoEpisodio(new Date('2026-11-18T18:00:07.100Z')));
  assert.notEqual(R.chaveDoEpisodio(d), R.chaveDoEpisodio(new Date('2026-11-18T18:05:07Z')));
});

test('recuarMinutosUteis: 200 min úteis atrás pula a noite (às 8h05 é 16h45 de ontem)', () => {
  const em = (local: string) => T.localParaUtc(local, FUSO)!;
  const r = (agora: string, min: number) => R.recuarMinutosUteis(em(agora), min, FUSO, JANELA).toISOString();
  assert.equal(r('2026-11-19T08:05', 200), em('2026-11-18T16:45').toISOString());
  assert.equal(r('2026-11-18T15:00', 200), em('2026-11-18T11:40').toISOString(), 'no meio do dia é só voltar o relógio');
  assert.equal(r('2026-11-18T21:00', 60), em('2026-11-18T19:00').toISOString(), 'fora do horário conta do fechamento');
  assert.equal(R.minutosUteis(em('2026-11-18T16:45'), em('2026-11-19T08:05'), FUSO, JANELA), 200, 'ida e volta');
});

test('Sofia sem o robô do CRM: a fala em texto livre do conector é da Sofia; o modelo aprovado continua sendo da régua; a mensagem de espera não sai', () => {
  const texto = ROBO(3, 'Posso te ajudar?');
  const modelo = { ...ROBO(3), additional_attributes: { template_params: { name: 'parau_lead_reengajamento_48h' } } };
  assert.equal(R.classificarMensagem(texto)?.papel, 'robo');
  assert.equal(R.classificarMensagem(texto, new Set(), true)?.papel, 'sofia');
  assert.equal(R.classificarMensagem(modelo, new Set(), true)?.papel, 'robo');
  // o paciente que ela respondeu não espera a equipe
  assert.equal(R.esperaDaEquipe(R.mensagensDaConversa([P(10), ROBO(9, 'Oi!')], new Set(), true), { esperandoHumano: false }), null);
  assert.deepEqual(decidir(12, { conectorEhSofia: true }).devidos, ['aviso-10']);
  assert.ok(decidir(12, { conectorEhSofia: true }).barrados.some((b) => b.passo === 'espera' && /mesmo usuário/.test(b.motivo)));
  assert.deepEqual(decidir(12, { conectorEhSofia: false }).devidos, ['espera', 'aviso-10']);
});

test('a demora fica DESLIGADA na clínica de demonstração (não em seco), mesmo com a tela ou o .env mandando ligar', async () => {
  const { modoDaDemora } = await import('./gerente.js');
  assert.equal(modoDaDemora('clinica-demonstracao'), 'desligado');
  assert.equal(modoDaDemora('clinica-demonstracao', { CHATWOOT_DEMORA_SLUGS: 'clinica-demonstracao' } as never), 'desligado');
  assert.equal(modoDaDemora('doutor-hernia-parauapebas', { CHATWOOT_DEMORA_SLUGS: 'doutor-hernia-parauapebas' } as never), 'ligado');
  assert.equal(modoDaDemora('doutor-hernia-parauapebas', {} as never), 'seco', 'e as demais nascem em seco');
});
