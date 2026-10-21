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
    'mensagem pronta, mande sem essa parte): acolha e transfira para a equipe na hora.]'
  );
}

/** O bloco do prompt. Só para clínica (`category = 'saude'`), como o resto da trava clínica. */
export function renderSinalDeAlerta(unit: Pick<Unit, 'category'>): string {
  if (unit.category?.trim() !== 'saude') return '';
  return `<sinal_de_alerta>
(ALTA PRIORIDADE — vale mais que qualquer orientação das <acoes> que mande ao pronto-socorro)
- O QUE É: perda de força que está piorando (a perna "falha", não consegue ficar em pé), perder o
  controle do xixi ou das fezes, dormência na região íntima, dor depois de queda ou pancada forte,
  febre junto com a dor. Dor forte, dor que piorou, dor que desce para a perna ou formigamento,
  sozinhos, NÃO são sinal de alerta: siga o atendimento normal.
- COMO PERGUNTAR: um sinal por pergunta. Um "sim" solto a uma pergunta com vários sinais não
  confirma nada — pergunte qual deles a pessoa sente antes de tratar como sinal de alerta.
- CONFIRMADO: (1) acolha em UMA frase, sem assustar e sem diagnosticar; (2) dispare a regra da
  unidade que marca o cartão, se houver; (3) transfira NA HORA, sem pedir licença:
  resumir_lead_para_sdr e depois pausar_ia com sinalDeAlerta: true. O sistema avisa a equipe com
  urgência, e o resultado de pausar_ia diz o que falar sobre quando a equipe responde.
- PRONTO-SOCORRO: só cite quando as DUAS coisas forem verdade — (a) não há horário HOJE na clínica
  (consultar_horarios não achou nada hoje, ou a clínica já fechou hoje) E (b) o paciente disse que
  a dor está insuportável. Fora disso, NÃO mande ao pronto-socorro, nem "por precaução" — muito
  menos quem já tem consulta marcada ou paga.
- Se o próprio paciente disser que vai ao pronto-socorro, ou perguntar se deve ir, não desaconselhe:
  diga que, se ele sente que não dá para esperar, pode ir, e que a equipe já foi avisada.
- NUNCA prometa prazo da equipe ("em instantes", "já já", "logo te chamam").
</sinal_de_alerta>`;
}

/** Texto da tarefa urgente no Kommo. `ALERTA · <slug> · [Contato: nome]` é o formato que o roteador de alertas lê. */
export function textoDoAvisoUrgente(a: { slug: string; nome: string | null; motivo: string }): string {
  const contato = a.nome?.trim() ? `[Contato: ${a.nome.trim()}] ` : '';
  const motivo = a.motivo.trim().replace(/\s+/g, ' ').slice(0, 200);
  return (
    `ALERTA · ${a.slug} · ${contato}URGENTE: paciente com sinal de alerta clínico (${motivo}). ` +
    'A IA parou e passou o atendimento para a equipe — falar com o paciente agora.'
  );
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
  return [`🚑 Sinal de alerta · ${a.unidade}`, `${quem} — ${a.motivo.trim().slice(0, 200)}. A IA passou para a equipe.`, link].join('\n');
}
