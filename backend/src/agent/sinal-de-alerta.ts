import type { Unit } from '@prisma/client';

/**
 * Sinal de alerta clínico: acolher, marcar e passar NA HORA para a equipe — e quase nunca pronto-socorro.
 *
 * Item 1 das prioridades da IA (21/10/2026): de 01 a 20/10 a Sofia mandou paciente ao pronto-socorro em 44
 * conversas, ~13 delas sem sinal de alerta de verdade — inclusive gente com consulta paga e horário livre.
 * Duas causas no que a IA lê:
 *  - a regra da rede dizia só "sinal de alerta clínico → PARE a condução comercial e transfira", sem dizer
 *    o que é sinal de alerta nem quando cabe falar em pronto-socorro;
 *  - a regra "sinal de alerta" cadastrada em 26 unidades faz UMA pergunta com vários sinais juntos, e o
 *    "sim" do paciente (a qualquer um deles, ou só concordando) virava confirmação e pronto-socorro.
 *
 * Regra decidida (João, 21/10): acolher, marcar o sinal de alerta e passar NA HORA para humano.
 * Pronto-socorro só se não houver horário HOJE **e** o paciente disser que a dor está insuportável.
 *
 * Ajuste do João (21/10, à tarde) para os SINAIS GRAVES DA COLUNA (perder o controle do xixi ou das fezes,
 * dormência na virilha/"região da sela", perna fraca de repente): a Sofia não manda ao pronto-socorro nem
 * transfere de cara — ela TENTA AGENDAR o horário mais próximo (hoje/amanhã) e avisa a equipe na hora
 * (`avisar_sinal_de_alerta`, que não pausa). Só transfere se ele recusar, não houver horário até amanhã ou a
 * conversa travar. Os outros sinais (queda/pancada, febre com dor) seguem a regra da manhã.
 */

/** Motivo de `pausar_ia` que é sinal de alerta — rede de segurança para quando o modelo esquece a flag. */
export const MOTIVO_SINAL_DE_ALERTA =
  /sinal(is)? de alerta|red ?flag|bandeira vermelha|emerg[eê]ncia|perda de for[cç]a|perdendo (a )?for[cç]a|incontin[eê]ncia|(controle|segurar) (d[oa]s? |[oa]s? )?(xixi|urina|fezes|intestino|bexiga)|anestesia em sela/i;

export function ehHandoffPorSinalDeAlerta(motivo: string | null | undefined, flag?: boolean): boolean {
  return flag === true || MOTIVO_SINAL_DE_ALERTA.test(motivo ?? '');
}

/** Tarefa criada pela regra da unidade que já é o aviso urgente — evita dois avisos no mesmo turno. */
export const TAREFA_URGENTE = /sinal(is)? de alerta|bandeira vermelha|emerg[eê]ncia/i;

/** Orientação ou mensagem cadastrada na unidade que manda o paciente ao pronto-socorro. */
const CITA_PRONTO_SOCORRO = /pronto[\s-]*(socorro|atendimento)|\bUPA\b|\bemerg[eê]ncia\b/i;

export function citaProntoSocorro(texto: string | null | undefined): boolean {
  return CITA_PRONTO_SOCORRO.test(texto ?? '');
}

/**
 * Colada na regra da unidade que cita pronto-socorro. O cadastro é dado de produção e não muda por aqui;
 * a trava muda o que a IA LÊ, para a orientação antiga não ganhar da regra da rede.
 */
export function travaDoProntoSocorro(texto: string | null | undefined): string {
  if (!citaProntoSocorro(texto)) return '';
  return (
    ' [REGRA DA REDE, vale mais que o texto acima: pronto-socorro SÓ quando não houver horário HOJE na ' +
    'clínica E o paciente disser que a dor está insuportável. Fora disso, não cite pronto-socorro (se for ' +
    'mensagem pronta, mande sem essa parte) e siga <sinal_de_alerta>.]'
  );
}

/** Regra da unidade cuja CONDIÇÃO é sinal de alerta — costuma mandar transferir de cara. */
const CONDICAO_SINAL_DE_ALERTA = /sinal(is)? de alerta|red ?flag|bandeira vermelha|emerg[eê]ncia|perda de for[cç]a|xixi|urina|fezes|esf[ií]ncter|\bsela\b/i;

/**
 * Regra de SINAL DE ALERTA disparada por queda, pancada ou acidente sem dizer de quando (a "trauma/febre" cadastrada
 * em 21/10). Regra que já diz o prazo ("recente", "há anos") vale como está, e regra que só cita trauma sem ser de
 * sinal de alerta (o Instituto Trauma, que é ortopedia) não ganha a ressalva — achado do Codex, 21/10.
 */
const CONDICAO_TRAUMA = /\bqueda|pancada|acidente/i;
const CONDICAO_COM_PRAZO = /recente|antig|\b(?:dias?|semanas?|mes(?:es)?|m[eê]s|anos?)\b/i;

function regraDeTraumaSemPrazo(condicao: string): boolean {
  return CONDICAO_SINAL_DE_ALERTA.test(condicao) && CONDICAO_TRAUMA.test(condicao) && !CONDICAO_COM_PRAZO.test(condicao);
}

/**
 * A regra "trauma/febre" do cadastro (21/10) diz só "dor forte depois de queda, pancada ou acidente". Marabá, lead
 * 28220160 (15/10): acidente de moto de UM ANO atrás, placa na perna, dor no quadril que veio depois — pela letra da
 * regra, transferência na hora. Sinal de alerta é o trauma recente; o antigo é queixa comum, e a pergunta dele
 * ("pode ser da coluna por causa do acidente?") merece resposta.
 */
const TRAVA_TRAUMA_ANTIGO =
  ' [REGRA DA REDE: só vale para queda, pancada ou acidente RECENTE (dias ou poucas semanas). Acidente, fratura ' +
  'ou cirurgia de meses ou anos atrás não é sinal de alerta: responda e siga o atendimento normal.]';

/**
 * Colada na regra da unidade disparada por sinal de alerta: nos sinais graves da coluna, a transferência
 * imediata que o cadastro manda vira "tente agendar antes" (ajuste do João, 21/10).
 */
export function travaDaRegraDeSinalDeAlerta(condicao: string | null | undefined): string {
  if (!CONDICAO_SINAL_DE_ALERTA.test(condicao ?? '')) return '';
  const trauma = regraDeTraumaSemPrazo(condicao ?? '') ? TRAVA_TRAUMA_ANTIGO : '';
  return (
    ' [REGRA DA REDE, vale mais que esta regra: nos SINAIS GRAVES DA COLUNA não transfira nem pause antes de ' +
    'tentar agendar — ofereça o horário mais próximo, chame avisar_sinal_de_alerta e só transfira se ele ' +
    'recusar, não houver horário até amanhã ou a conversa travar. Ver <sinal_de_alerta>.]' +
    trauma
  );
}

/** O bloco do prompt. Só para clínica (`category = 'saude'`), como o resto da trava clínica. */
export function renderSinalDeAlerta(unit: Pick<Unit, 'category'>): string {
  if (unit.category?.trim() !== 'saude') return '';
  return `<sinal_de_alerta>
(ALTA PRIORIDADE — vale mais que qualquer orientação das <acoes> que mande ao pronto-socorro ou
mande transferir antes de tentar agendar)
- COMO PERGUNTAR: um sinal por pergunta. Um "sim" solto a uma pergunta com vários sinais não
  confirma nada — pergunte qual deles a pessoa sente antes de tratar como sinal de alerta.
- VÁRIAS MENSAGENS SEGUIDAS: leia todas antes de responder. Se QUALQUER uma traz dor, limitação ou
  sinal clínico, acolha ISSO primeiro — nunca responda só ao "tudo bem" ou ao "boa noite" do fim.
- LINGUAGEM DO DIA A DIA (e erro de digitação) conta igual: "me faltou/faltaram as pernas" ("mim
  falou as pernas"), "as pernas falharam", "a perna bambeou", "quase não andei" ("quer não andei"),
  "não consigo andar", "travei". Acolha em UMA frase e faça a pergunta de sinais de alerta, UM sinal
  por vez — comece pela força da perna ("a perna ficou fraca, sem força?") — e siga o que vem abaixo
  conforme a resposta.
- DOR QUE VAI PARA A VIRILHA, OS TESTÍCULOS, A REGIÃO ÍNTIMA OU A BARRIGA ("irradia pra virilha",
  "chega nos testículos", "dói o saco", "vai pra barriga"): não pule para sono e trabalho. Acolha em UMA
  frase e faça a pergunta de sinais de alerta, UM sinal por vez — comece pela dormência ("a virilha ou a
  região íntima fica dormente, adormecida?") e depois o controle do xixi e das fezes. Sem diagnosticar
  (nada de "pode ser rim", "pode ser hérnia"). Se ele não tiver nenhum dos sinais, siga o atendimento normal.
- NÃO É sinal de alerta: dor forte, dor que piorou, dor que desce para a perna ou formigamento,
  sozinhos. Siga o atendimento normal.
- SINAIS GRAVES DA COLUNA: perder o controle do xixi ou das fezes, dormência na virilha / região
  íntima ("região da sela"), perna que ficou fraca de repente ou está piorando. Aqui a ordem é:
  (1) acolha em UMA frase, sem assustar e sem diagnosticar;
  (2) TENTE AGENDAR: consulte a agenda e ofereça o horário mais próximo, priorizando hoje e amanhã,
      e marque se ele aceitar (o caminho normal de cadastro e agendamento);
  (3) no MESMO turno em que confirmar o sinal, chame avisar_sinal_de_alerta — avisa a equipe na hora,
      com urgência, e NÃO pausa a IA. Não chame pausar_ia antes de tentar agendar.
  Só transfira (resumir_lead_para_sdr e depois pausar_ia com sinalDeAlerta: true) se ele recusar o
  horário, se não houver horário até amanhã, ou se a conversa travar.
- OUTROS SINAIS DE ALERTA (dor depois de queda ou pancada forte RECENTE — acidente também, de dias ou
  poucas semanas —, febre junto com a dor): acolha em UMA frase e transfira NA HORA, sem pedir licença:
  resumir_lead_para_sdr e depois pausar_ia com sinalDeAlerta: true. O resultado de pausar_ia diz o que
  falar sobre quando a equipe responde.
- ACIDENTE, FRATURA OU CIRURGIA ANTIGA (meses ou anos atrás), com dor que veio depois: NÃO é sinal de
  alerta. Responda o que ele perguntou ("pode ter relação, sim — é isso que o especialista examina na
  consulta") e siga o atendimento normal.
- PRONTO-SOCORRO: o sinal, sozinho, NÃO é motivo de pronto-socorro. Só cite pronto-socorro quando as
  DUAS coisas forem verdade — (a) não há horário HOJE na clínica (consultar_horarios não achou nada
  hoje, ou a clínica já fechou hoje) E (b) o paciente disse que a dor está insuportável. Nunca "por
  precaução" — muito menos para quem já tem consulta marcada ou paga.
- Se o próprio paciente disser que vai ao pronto-socorro, ou perguntar se deve ir, NUNCA desaconselhe:
  diga que, se ele sente que não dá para esperar, pode ir, e que a equipe já foi avisada.
- NUNCA prometa prazo da equipe ("em instantes", "já já", "logo te chamam").
</sinal_de_alerta>`;
}

/**
 * Em que pé está a conversa quando a equipe é avisada:
 *  - `agendando`: sinal grave da coluna, a IA segue tentando marcar o horário mais próximo (não pausou);
 *  - `transferiu`: a IA parou e passou o atendimento.
 */
export type SituacaoDoAviso = 'agendando' | 'transferiu';

/** Uma tarefa por situação por cartão a cada 24 h (`card_alert`, a mesma regra dos outros avisos). */
export const CHAVE_DO_AVISO: Record<SituacaoDoAviso, string> = {
  agendando: 'sinal-de-alerta-agendando',
  transferiu: 'sinal-de-alerta-transferiu',
};

/** Texto da tarefa urgente no Kommo. `ALERTA · <slug> · [Contato: nome]` é o formato que o roteador de alertas lê. */
export function textoDoAvisoUrgente(a: {
  slug: string;
  nome: string | null;
  motivo: string;
  situacao?: SituacaoDoAviso;
}): string {
  const contato = a.nome?.trim() ? `[Contato: ${a.nome.trim()}] ` : '';
  const motivo = a.motivo.trim().replace(/\s+/g, ' ').slice(0, 200);
  const situacao =
    a.situacao === 'agendando'
      ? 'A IA está oferecendo o horário mais próximo para agendar — acompanhar a conversa e falar com o paciente.'
      : 'A IA parou e passou o atendimento para a equipe — falar com o paciente agora.';
  return `ALERTA · ${a.slug} · ${contato}URGENTE: paciente com sinal de alerta clínico (${motivo}). ${situacao}`;
}

/** Aviso no Telegram do João — o canal que sobrou depois do banimento do WhatsApp dos alertas. */
export function textoTelegramSinalDeAlerta(a: {
  unidade: string;
  subdominio: string | null | undefined;
  leadId: number;
  nome: string | null;
  motivo: string;
  situacao?: SituacaoDoAviso;
}): string {
  const quem = a.nome?.trim() || `lead ${a.leadId}`;
  const link = a.subdominio ? `https://${a.subdominio}.kommo.com/leads/detail/${a.leadId}` : `lead ${a.leadId}`;
  const pe = a.situacao === 'agendando' ? 'A IA está tentando agendar o horário mais próximo.' : 'A IA passou para a equipe.';
  return [`🚑 Sinal de alerta · ${a.unidade}`, `${quem} — ${a.motivo.trim().slice(0, 200)}. ${pe}`, link].join('\n');
}
