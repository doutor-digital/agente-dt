import type { Unit } from '@prisma/client';

/**
 * Sinal de alerta clínico: acolher em UMA frase, PARAR a IA e passar NA HORA para a equipe ligar.
 *
 * Decisão do João em 26/10/2026 (itens 1 e 2 da conferência da Suzanne), que SUBSTITUI as de 21/10:
 *  - sinal de alerta (perder força na perna, não segurar xixi/fezes, dormência entre as pernas, dor que piorou
 *    de repente, febre com dor, queda/pancada recente) → a IA para na hora. Acabou o "tentar agendar antes"
 *    dos sinais graves da coluna: a regra de 21/10 estava no ar e os casos aconteceram (Olímpia, Mossoró,
 *    Balsas, Rio Verde: nenhuma etiqueta 🔴 PRIORIDADE nas 21 contas, ninguém da equipe avisado);
 *  - o aviso é a etiqueta 🔴 PRIORIDADE no cartão + a tarefa "LIGAR AGORA" no Kommo + o Telegram do João.
 *    WhatsApp não: o número de alertas foi banido (06/10);
 *  - a Sofia NUNCA sugere pronto-socorro/UPA/hospital/emergência por conta própria e NUNCA opina sobre médico
 *    ou cirurgia. Se o PRÓPRIO paciente perguntar se deve ir, ou disser que vai, ela não desaconselha: diz que,
 *    se ele sente que não dá para esperar, pode ir, e que a equipe já foi avisada. Some a exceção de 21/10
 *    ("sem horário hoje + dor insuportável").
 */

/** Etiqueta que o cartão ganha quando a IA para por sinal de alerta (nome exato pedido pela Suzanne, 25/10). */
export const ETIQUETA_PRIORIDADE = '🔴 PRIORIDADE';

/** Motivo de `pausar_ia` que é sinal de alerta — rede de segurança para quando o modelo esquece a flag. */
export const MOTIVO_SINAL_DE_ALERTA =
  /sinal(is)? de alerta|red ?flag|bandeira vermelha|emerg[eê]ncia|perda de for[cç]a|perdendo (a )?for[cç]a|incontin[eê]ncia|(controle|segur\w*) (d[oa]s? |[oa]s? )?(xixi|urina|fezes|intestino|bexiga)|anestesia em sela|dorm[eê]ncia (na|em|entre)|piorou de repente|piora repentina|dor repentina|febre (e|com|junto)/i;

export function ehHandoffPorSinalDeAlerta(motivo: string | null | undefined, flag?: boolean): boolean {
  return flag === true || MOTIVO_SINAL_DE_ALERTA.test(motivo ?? '');
}

/** Tarefa criada pela regra da unidade que já é o aviso urgente — evita dois avisos no mesmo turno. */
export const TAREFA_URGENTE = /sinal(is)? de alerta|bandeira vermelha|emerg[eê]ncia/i;
const LIGAR_AGORA = /ligar agora/i;

/** Orientação ou mensagem cadastrada na unidade que manda o paciente ao pronto-socorro. */
const CITA_PRONTO_SOCORRO = /pronto[\s-]*(socorro|atendimento)|\bUPA\b|\bSAMU\b|\bemerg[eê]ncia\b/i;

export function citaProntoSocorro(texto: string | null | undefined): boolean {
  return CITA_PRONTO_SOCORRO.test(texto ?? '');
}

/**
 * Colada na regra da unidade que cita pronto-socorro. O cadastro é dado de produção e não muda por aqui;
 * a trava muda o que a IA LÊ, para a orientação antiga não ganhar da regra da rede. Sem exceção: a Sofia não
 * sugere pronto-socorro (decisão de 26/10). A saída também é varrida por `sem-pronto-socorro.ts`.
 */
export function travaDoProntoSocorro(texto: string | null | undefined): string {
  if (!citaProntoSocorro(texto)) return '';
  return (
    ' [REGRA DA REDE, vale mais que o texto acima: NUNCA sugira pronto-socorro, UPA, hospital ou emergência ' +
    'por conta própria — mande esta parte sem essa menção. Se o próprio paciente perguntar se deve ir ou disser ' +
    'que vai, não desaconselhe: diga que, se ele sente que não dá para esperar, pode ir, e que a equipe já foi ' +
    'avisada. Siga <sinal_de_alerta>.]'
  );
}

/** Regra da unidade cuja CONDIÇÃO é sinal de alerta — costuma mandar transferir de cara. */
const CONDICAO_SINAL_DE_ALERTA = /sinal(is)? de alerta|red ?flag|bandeira vermelha|emerg[eê]ncia|perda de for[cç]a|xixi|urina|fezes|esf[ií]ncter|\bsela\b|dorm[eê]ncia|febre|virilha|de repente/i;

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
 * Colada na regra da unidade disparada por sinal de alerta: o cadastro costuma mandar "transferir" sem dizer
 * como. Aqui a ordem fica igual à da rede (26/10): acolher em UMA frase, resumir e pausar com `sinalDeAlerta`.
 */
export function travaDaRegraDeSinalDeAlerta(condicao: string | null | undefined): string {
  if (!CONDICAO_SINAL_DE_ALERTA.test(condicao ?? '')) return '';
  const trauma = regraDeTraumaSemPrazo(condicao ?? '') ? TRAVA_TRAUMA_ANTIGO : '';
  return (
    ' [REGRA DA REDE, vale mais que esta regra: confirmado o sinal, PARE na hora — nada de tentar agendar nem ' +
    'de oferecer horário antes. Acolha em UMA frase, chame resumir_lead_para_sdr e depois pausar_ia com ' +
    'sinalDeAlerta: true (isso etiqueta 🔴 PRIORIDADE e cria a tarefa LIGAR AGORA). Não cite pronto-socorro. ' +
    'Ver <sinal_de_alerta>.]' +
    trauma
  );
}

/** O bloco do prompt. Só para clínica (`category = 'saude'`), como o resto da trava clínica. */
export function renderSinalDeAlerta(unit: Pick<Unit, 'category'>): string {
  if (unit.category?.trim() !== 'saude') return '';
  return `<sinal_de_alerta>
(ALTA PRIORIDADE — decisão do João, 26/10. Vale mais que qualquer orientação das <acoes>, do cadastro
da unidade e dos modelos de mensagem)
- SINAL DE ALERTA é quando o paciente diz que: (a) perdeu força na perna, ou a perna está fraca, bamba,
  falhando; (b) não consegue segurar o xixi ou as fezes (escape, "se molhou", "não senti"); (c) sente
  dormência ou adormecimento na virilha, entre as pernas ou na região íntima; (d) a dor PIOROU DE REPENTE
  (de uma hora para outra, não aos poucos); (e) está com febre junto com a dor; (f) sente dor depois de
  queda, pancada ou acidente RECENTE (dias ou poucas semanas).
- CONFIRMADO O SINAL, A IA PARA NA HORA. Nada de oferecer horário, de "tentar agendar antes", de perguntar
  de sono ou de trabalho, de seguir a conversa comercial. No MESMO turno, nesta ordem:
  (1) resumir_lead_para_sdr; (2) pausar_ia com sinalDeAlerta: true — isso já coloca a etiqueta
  🔴 PRIORIDADE no cartão, cria a tarefa LIGAR AGORA e avisa o João; (3) responda UMA frase que acolhe,
  sem assustar e sem diagnosticar, e diz o que o resultado de pausar_ia mandar sobre a equipe.
  Não chame consultar_horarios nem agendar_consulta depois de um sinal confirmado.
- QUANDO A FALA É CLARA ("não estou segurando o xixi", "minha perna está perdendo força"), é sinal
  confirmado: não pergunte de novo, pare.
- QUANDO A FALA É VAGA, acolha em UMA frase e faça UMA pergunta com UM sinal só (um "sim" solto a uma
  pergunta com vários sinais não confirma nada): "a perna ficou fraca, sem força?". Se ele confirmar, pare
  como acima; se negar, siga o atendimento normal.
- VÁRIAS MENSAGENS SEGUIDAS: leia todas antes de responder. Se QUALQUER uma traz dor, limitação ou sinal
  clínico, acolha ISSO primeiro — nunca responda só ao "tudo bem" ou ao "boa noite" do fim.
- LINGUAGEM DO DIA A DIA (e erro de digitação) conta igual: "me faltou/faltaram as pernas" ("mim falou
  as pernas"), "as pernas falharam", "a perna bambeou", "quase não andei" ("quer não andei"), "não consigo
  andar", "travei", "me mijei", "escapou o xixi". É fala vaga: faça a pergunta de UM sinal, como acima.
- DOR QUE VAI PARA A VIRILHA, OS TESTÍCULOS, A REGIÃO ÍNTIMA OU A BARRIGA ("irradia pra virilha", "chega
  nos testículos", "dói o saco", "vai pra barriga"): não pule para sono e trabalho. Acolha em UMA frase e
  pergunte UM sinal — comece pela dormência ("a virilha ou a região íntima fica dormente, adormecida?") e
  depois o controle do xixi e das fezes. Sem diagnosticar (nada de "pode ser rim", "pode ser hérnia"). Se
  ele não tiver nenhum dos sinais, siga o atendimento normal.
- NÃO É sinal de alerta: dor forte, dor que piorou aos poucos ou há dias, dor que desce para a perna ou
  formigamento, sozinhos. Siga o atendimento normal.
- ACIDENTE, FRATURA OU CIRURGIA ANTIGA (meses ou anos atrás), com dor que veio depois: NÃO é sinal de
  alerta. Responda o que ele perguntou ("pode ter relação, sim — é isso que o especialista examina na
  consulta") e siga o atendimento normal.
- PRONTO-SOCORRO: você NUNCA sugere pronto-socorro, UPA, hospital, SAMU ou emergência por conta própria —
  nem "por precaução", nem sem horário hoje, nem com dor insuportável. Não há exceção sua.
- Se o PRÓPRIO paciente perguntar se deve ir ao pronto-socorro, ou disser que vai: NUNCA desaconselhe (e
  não mande ir). Trate como sinal de alerta — resumir_lead_para_sdr e pausar_ia com sinalDeAlerta: true,
  se ainda não fez — e diga que, se ele sente que não dá para esperar, pode ir, e que a equipe já foi avisada.
- MÉDICO E CIRURGIA: você NUNCA opina sobre médico (qual procurar, se outro especialista serve melhor, se
  este ou aquele é bom) nem sobre cirurgia (se precisa, se não precisa, "caminho cirúrgico", "indicação
  cirúrgica"). Isso é do especialista, na consulta.
- NUNCA prometa prazo da equipe ("em instantes", "já já", "logo te chamam").
</sinal_de_alerta>`;
}

/**
 * Em que pé está a conversa quando a equipe é avisada. Desde 26/10 só existe `transferiu`: a IA para e a equipe
 * liga. (`agendando` era o "tentar agendar antes" de 21/10, abandonado.)
 */
export type SituacaoDoAviso = 'transferiu';

/** Uma tarefa por situação por cartão a cada 24 h (`card_alert`, a mesma regra dos outros avisos). */
export const CHAVE_DO_AVISO: Record<SituacaoDoAviso, string> = {
  transferiu: 'sinal-de-alerta-transferiu',
};

/**
 * Texto da tarefa urgente no Kommo. `ALERTA · <slug> · [Contato: nome]` é o formato que o roteador de alertas
 * lê — o prefixo fica como está; o "LIGAR AGORA" vem logo depois, onde a recepção lê primeiro.
 */
export function textoDoAvisoUrgente(a: { slug: string; nome: string | null; motivo: string }): string {
  const contato = a.nome?.trim() ? `[Contato: ${a.nome.trim()}] ` : '';
  const motivo = a.motivo.trim().replace(/\s+/g, ' ').slice(0, 200);
  return (
    `ALERTA · ${a.slug} · ${contato}LIGAR AGORA — URGENTE: paciente com sinal de alerta clínico (${motivo}). ` +
    'A IA parou e passou o atendimento para a equipe — ligar para o paciente agora.'
  );
}

/** Tarefa de sinal de alerta escrita pela regra da unidade: ganha o "LIGAR AGORA" no fim se não tiver. */
export function comLigarAgora(texto: string): string {
  if (!TAREFA_URGENTE.test(texto) || LIGAR_AGORA.test(texto)) return texto;
  return `${texto.trimEnd()} — LIGAR AGORA`;
}

/** Aviso no Telegram do João — o canal que sobrou depois do banimento do WhatsApp dos alertas. */
export function textoTelegramSinalDeAlerta(a: {
  unidade: string;
  subdominio: string | null | undefined;
  leadId: number;
  nome: string | null;
  motivo: string;
}): string {
  const quem = a.nome?.trim() || `lead ${a.leadId}`;
  const link = a.subdominio ? `https://${a.subdominio}.kommo.com/leads/detail/${a.leadId}` : `lead ${a.leadId}`;
  return [
    `🚑 Sinal de alerta · ${a.unidade} · LIGAR AGORA`,
    `${quem} — ${a.motivo.trim().slice(0, 200)}. A IA parou e passou para a equipe.`,
    link,
  ].join('\n');
}
