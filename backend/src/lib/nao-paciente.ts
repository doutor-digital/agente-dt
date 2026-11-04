/**
 * Quem escreve NÃO é paciente: candidato a vaga, currículo, vídeo de apresentação (decisão do João, 04/11/2026, todas as unidades).
 *
 * O cartão sai do funil de pacientes, decidido no CÓDIGO (a ferramenta `marcar_nao_paciente` chama isto):
 *  1. etiqueta CURRÍCULO + a etiqueta de "não contatar" da conta (NO_FOLLOW_UP): os gatilhos de PERDIDO do Kommo leem a
 *     condição no evento, então as duas entram ANTES de mudar a etapa — sem isso a régua de recuperação mandaria
 *     "sentimos sua falta" a quem só queria uma vaga;
 *  2. "⊘ Motivo do não agendamento" = "Não é paciente (currículo)", resolvido pelo NOME do campo e pelo NOME da opção
 *     (o id da opção é diferente em cada conta). Conta sem o campo ou sem a opção (Salto, laboratório): NÃO grava nenhum
 *     outro motivo no lugar, só registra no log e na nota do cartão;
 *  3. PERDIDO do funil COMERCIAL da conta, no MESMO PATCH que grava o motivo: `(pipeline_id, status_id)` juntos, porque o
 *     143 existe em todo funil (no TRATAMENTO é TRATAMENTO CANCELADO) e o `status_id` sozinho cai no funil em que o cartão está;
 *  4. a IA para neste cartão (caixinha "Pausar IA") e a escada de follow-up congela. Não carimba "assumido por humano" nem
 *     `handoffAt`: não é um handoff, e o `handoffAt` armaria a reativação de 30 min.
 *
 * Não passa por nenhuma chave de automação: a movimentação de etapa da IA está desligada em várias unidades, e esta é uma
 * decisão explícita (não é o robô de "parados" nem o `franquia-move`).
 *
 * O que NÃO é candidato fica de fora por trava de código, mesmo que o modelo erre: cartão com consulta futura ou pagamento
 * (trava-perda), em GANHO ou no funil TRATAMENTO é paciente — a ferramenta recusa e nada é escrito.
 *
 * O arquivo do currículo não é tocado: fica na conversa do cartão.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { resolveEnumId } from '../services/kommo.service.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { normalizarNome } from './kommo-schema.js';
import { travaDaPerdaAutomatica } from './trava-perda.js';
import { etiquetaDeNaoContatar } from './sofia-fecha-quente-morno.js';
import { esquecerPausaPropria, registrarPausaPropria } from './pausa-propria.js';
import { motivoDaSdrNoCartao } from './parados.js';

export const TIPOS_NAO_PACIENTE = ['curriculo'] as const;
export type TipoNaoPaciente = (typeof TIPOS_NAO_PACIENTE)[number];

export const ETIQUETA_CURRICULO = 'CURRÍCULO';
export const CAMPO_MOTIVO_NAO_AGENDAMENTO = '⊘ Motivo do não agendamento';
export const OPCAO_MOTIVO_CURRICULO = 'Não é paciente (currículo)';
export const MOTIVO_DE_PARADA_DO_FOLLOW_UP = 'não é paciente (currículo)';

const GANHO = 142;
const PERDIDO = 143;

type KommoUsado = Pick<
  KommoClient,
  | 'getLead'
  | 'listPipelines'
  | 'listLeadCustomFieldsTyped'
  | 'listLeadTags'
  | 'addTag'
  | 'tagsDoLead'
  | 'setLeadFieldFlag'
  | 'isLeadFieldChecked'
  | 'moverCartao'
  | 'gravarCamposDoLead'
  | 'addLeadNote'
  | 'createTask'
>;

export type SituacaoDoMotivo = 'gravado' | 'sem_campo' | 'sem_opcao' | 'mantido_da_equipe' | 'nao_gravou';

export interface ResultadoNaoPaciente {
  /**
   * `feito`: tudo o que dava foi feito; `ja_estava`: o cartão já estava marcado (nada novo escrito);
   * `parcial`: algum passo falhou (o texto diz qual); `recusado`: é paciente — nada foi escrito.
   */
  desfecho: 'feito' | 'ja_estava' | 'parcial' | 'recusado';
  etiquetas: boolean;
  pausada: boolean;
  motivo: SituacaoDoMotivo;
  movido: boolean;
  /** só em `recusado`: por quê (vai para a IA, em linguagem de bastidor) */
  recusa?: string;
  /** o que deu errado, para o trace e para a nota */
  falhas: string[];
}

export interface PedidoNaoPaciente {
  unit: Pick<Unit, 'id' | 'slug'>;
  kommo: KommoUsado;
  leadId: number;
  tipo: TipoNaoPaciente;
  /** o campo "Pausar IA" da unidade; sem ele a IA não pode ser pausada (vai para a lista de falhas) */
  pausedFieldId: number | null;
  agoraEpoch?: number;
}

function tags(c: Pick<KommoLead, '_embedded'>): string[] {
  return (c._embedded?.tags ?? []).map((t) => t.name);
}

/** O funil COMERCIAL pela mesma regra do resto do sistema (`carregarFunis`): o principal da conta, ou o de nome COMERCIAL. */
export function funilComercial<P extends { id: number; name: string; is_main?: boolean }>(pipes: ReadonlyArray<P>): P | null {
  return pipes.find((p) => p.is_main) ?? pipes.find((p) => normalizarNome(p.name) === normalizarNome('COMERCIAL')) ?? null;
}

/** O PERDIDO do funil: o status 143 (ou, se a conta o listou sem o id esperado, o de nome PERDIDO). */
export function statusPerdidoDoFunil(statuses: ReadonlyArray<{ id: number; name: string }>): number | null {
  return statuses.find((s) => s.id === PERDIDO)?.id ?? statuses.find((s) => normalizarNome(s.name) === 'perdido')?.id ?? null;
}

const recusar = (recusa: string): ResultadoNaoPaciente => ({
  desfecho: 'recusado',
  etiquetas: false,
  pausada: false,
  motivo: 'nao_gravou',
  movido: false,
  recusa,
  falhas: [],
});

/**
 * Faz tudo. Nunca lança: cada passo falha sozinho e o resultado diz o que de fato aconteceu (quem chama só pode falar o que foi feito).
 * A decisão de ser ou não candidato é do modelo; aqui só se confere que o cartão não é de paciente.
 */
export async function marcarNaoPaciente(p: PedidoNaoPaciente): Promise<ResultadoNaoPaciente> {
  const { unit, kommo, leadId } = p;
  const base = { unit: unit.slug, leadId, tipo: p.tipo };
  const agora = p.agoraEpoch ?? Math.floor(Date.now() / 1000);
  const falhas: string[] = [];

  // 1. O cartão e os funis. Sem eles não dá para provar que não é paciente: não escreve nada.
  let cartao: KommoLead;
  let pipes: Awaited<ReturnType<KommoUsado['listPipelines']>>;
  try {
    [cartao, pipes] = await Promise.all([kommo.getLead(leadId), kommo.listPipelines()]);
  } catch (err) {
    logger.warn({ err: String(err), ...base }, 'nao-paciente: não consegui ler o cartão/funis — nada foi marcado');
    return recusar('não consegui ler o cartão agora para conferir. Nada foi marcado: trate a mensagem normalmente e a marcação pode ser feita na próxima.');
  }

  const comercial = funilComercial(pipes);
  const tratamento = pipes.find((x) => normalizarNome(x.name) === normalizarNome('TRATAMENTO')) ?? null;
  if (tratamento && cartao.pipeline_id === tratamento.id) {
    logger.info({ ...base }, 'nao-paciente: o cartão está no funil TRATAMENTO — é paciente, recusei');
    return recusar('este cartão está no funil TRATAMENTO: é paciente (ou ex-paciente). Não é candidato; siga o atendimento normal.');
  }
  if (cartao.status_id === GANHO && (!comercial || cartao.pipeline_id === comercial.id)) {
    logger.info({ ...base }, 'nao-paciente: o cartão está em GANHO — é paciente, recusei');
    return recusar('este cartão está em GANHO (já fechou tratamento): é paciente. Não é candidato; siga o atendimento normal.');
  }
  const trava = travaDaPerdaAutomatica(cartao, agora, { semTemperatura: true });
  if (trava) {
    logger.info({ ...base, trava: trava.motivo }, 'nao-paciente: o cartão tem consulta ou pagamento — é paciente, recusei');
    return recusar(`este cartão está com «${trava.motivo}»: é paciente, não candidato. Não marque; siga o atendimento normal.`);
  }

  const perdidoComercial = comercial ? statusPerdidoDoFunil(comercial.statuses) : null;
  const jaEstaFechado = !!comercial && perdidoComercial !== null && cartao.pipeline_id === comercial.id && cartao.status_id === perdidoComercial;
  const jaEtiquetado = tags(cartao).some((t) => normalizarNome(t) === normalizarNome(ETIQUETA_CURRICULO));

  // Idempotência: o modelo pode chamar duas vezes no mesmo turno, ou o candidato mandar o vídeo depois do PDF.
  if (jaEstaFechado && jaEtiquetado) {
    const pausada = await pausarIa(p, falhas);
    return { desfecho: 'ja_estava', etiquetas: true, pausada, motivo: 'mantido_da_equipe', movido: false, falhas };
  }

  const naoContatar = await etiquetaDeNaoContatar(unit, kommo);

  // 2. Etiquetas ANTES da etapa. Se não entraram, o cartão NÃO anda: PERDIDO sem a etiqueta dispara a régua de recuperação.
  let etiquetas = false;
  try {
    await kommo.addTag({ leadId, tags: [ETIQUETA_CURRICULO, naoContatar] });
    etiquetas = true;
    try {
      const guardadas = (await kommo.tagsDoLead(leadId)).map(normalizarNome);
      for (const t of [ETIQUETA_CURRICULO, naoContatar]) {
        if (!guardadas.includes(normalizarNome(t))) {
          falhas.push(`o Kommo não guardou a etiqueta ${t}`);
          if (t === naoContatar) etiquetas = false;
        }
      }
    } catch (err) {
      logger.warn({ err: String(err), ...base }, 'nao-paciente: não consegui reler as etiquetas (segui com o que o PATCH respondeu)');
    }
  } catch (err) {
    falhas.push(`etiquetas: ${String(err)}`);
    logger.error({ err: String(err), ...base }, 'nao-paciente: não consegui etiquetar — o cartão não foi movido');
  }

  // 3. Para a IA (depois das etiquetas, antes de mexer na etapa: a conversa não pode seguir enquanto o cartão anda).
  const pausada = await pausarIa(p, falhas);
  await prisma.conversation
    .updateMany({ where: { unitId: unit.id, leadId: String(leadId) }, data: { followUpStoppedReason: MOTIVO_DE_PARADA_DO_FOLLOW_UP } })
    .catch((err) => {
      falhas.push(`follow-up: ${String(err)}`);
      logger.warn({ err: String(err), ...base }, 'nao-paciente: não consegui parar a escada de follow-up');
    });

  // 4. O motivo, pelo NOME do campo e da opção. Nunca grava outra coisa no lugar.
  let motivo: SituacaoDoMotivo = 'nao_gravou';
  let campos: Array<{ field_id: number; values: Array<Record<string, unknown>> }> | undefined;
  try {
    const todos = await kommo.listLeadCustomFieldsTyped();
    const doMotivo = todos.filter((c) => normalizarNome(c.name) === normalizarNome(CAMPO_MOTIVO_NAO_AGENDAMENTO) && (c.type === 'select' || c.type === 'radiobutton'));
    if (doMotivo.length === 0) {
      motivo = 'sem_campo';
      logger.warn({ ...base, campo: CAMPO_MOTIVO_NAO_AGENDAMENTO }, 'nao-paciente: esta conta não tem o campo do motivo — o cartão vai a PERDIDO sem motivo gravado');
    } else {
      const achado = doMotivo
        .map((c) => ({ campo: c, enumId: resolveEnumId(OPCAO_MOTIVO_CURRICULO, c.enums ?? []) }))
        .find((x) => x.enumId !== null);
      if (!achado) {
        motivo = 'sem_opcao';
        logger.warn({ ...base, campo: CAMPO_MOTIVO_NAO_AGENDAMENTO, opcao: OPCAO_MOTIVO_CURRICULO }, 'nao-paciente: esta conta não tem a opção do motivo — nenhum outro motivo foi gravado no lugar');
      } else if (jaEstaFechado && motivoDaSdrNoCartao(cartao.custom_fields_values)) {
        motivo = 'mantido_da_equipe'; // a equipe já fechou e escreveu o motivo dela
      } else {
        campos = [{ field_id: achado.campo.id, values: [{ enum_id: achado.enumId as number }] }];
        motivo = 'gravado';
      }
    }
  } catch (err) {
    falhas.push(`motivo: ${String(err)}`);
    logger.warn({ err: String(err), ...base }, 'nao-paciente: não consegui ler os campos da conta — o cartão não leva motivo');
  }

  // 5. PERDIDO do COMERCIAL, com o motivo no mesmo PATCH (se o Kommo recusar o valor, o cartão não anda sem ele).
  let movido = false;
  if (!etiquetas) {
    falhas.push('cartão não movido: as etiquetas não entraram');
  } else if (!comercial || perdidoComercial === null) {
    falhas.push('cartão não movido: não achei o PERDIDO do funil COMERCIAL desta conta');
    logger.error({ ...base }, 'nao-paciente: a conta não tem funil COMERCIAL/PERDIDO reconhecível');
  } else if (jaEstaFechado) {
    // já estava em PERDIDO (a equipe fechou, ou um robô): só faltava a etiqueta, a pausa e, se não tinha, o motivo
    if (campos) {
      try {
        await kommo.gravarCamposDoLead(leadId, campos);
      } catch (err) {
        motivo = 'nao_gravou';
        falhas.push(`motivo: ${String(err)}`);
        logger.error({ err: String(err), ...base }, 'nao-paciente: não consegui gravar o motivo no cartão que já estava em PERDIDO');
      }
    }
  } else {
    try {
      await kommo.moverCartao(leadId, { statusId: perdidoComercial, pipelineId: comercial.id, campos });
      movido = true;
    } catch (err) {
      if (motivo === 'gravado') motivo = 'nao_gravou';
      falhas.push(`movimento para PERDIDO: ${String(err)}`);
      logger.error({ err: String(err), ...base, pipelineId: comercial.id, statusId: perdidoComercial }, 'nao-paciente: o Kommo recusou mover para PERDIDO (campo obrigatório no PERDIDO?)');
    }
  }
  if (!movido && !jaEstaFechado && motivo === 'gravado') motivo = 'nao_gravou'; // o motivo só vale se foi no mesmo PATCH que moveu

  // 6. Rastro no cartão para a equipe; e tarefa se o cartão ficou no funil de pacientes.
  const resumo = [
    `Candidato a vaga (${p.tipo}): a Sofia respondeu uma vez e parou. Etiqueta ${ETIQUETA_CURRICULO}${etiquetas ? '' : ' (NÃO entrou)'}`,
    motivo === 'gravado'
      ? `motivo «${OPCAO_MOTIVO_CURRICULO}»`
      : motivo === 'mantido_da_equipe'
        ? 'motivo da equipe mantido'
        : `SEM motivo gravado (${motivo === 'sem_campo' ? 'a conta não tem o campo' : motivo === 'sem_opcao' ? `a conta não tem a opção «${OPCAO_MOTIVO_CURRICULO}»` : 'falhou'})`,
    movido || jaEstaFechado ? 'cartão em PERDIDO' : 'cartão NÃO foi movido',
    pausada ? 'IA pausada' : 'IA NÃO foi pausada',
  ].join(' · ');
  await kommo.addLeadNote(leadId, `${resumo}. O arquivo do currículo continua na conversa do cartão.`).catch((err) => logger.warn({ err: String(err), ...base }, 'nao-paciente: não consegui deixar a nota'));
  if (!movido && !jaEstaFechado) {
    await kommo
      .createTask({
        leadId,
        text: `Candidato a vaga (currículo): a Sofia não conseguiu mover o cartão para PERDIDO (${falhas.join('; ') || 'sem detalhe'}). Mova à mão e ponha o motivo «${OPCAO_MOTIVO_CURRICULO}».`,
        completeAt: agora + 3600,
        responsibleUserId: cartao.responsible_user_id,
      })
      .catch((err) => logger.warn({ err: String(err), ...base }, 'nao-paciente: não consegui abrir a tarefa para a equipe'));
  }

  logger.info({ ...base, etiquetas, pausada, motivo, movido, falhas }, 'nao-paciente: candidato tratado');
  const completo = etiquetas && pausada && (movido || jaEstaFechado) && (motivo === 'gravado' || motivo === 'mantido_da_equipe') && falhas.length === 0;
  return { desfecho: completo ? 'feito' : 'parcial', etiquetas, pausada, motivo, movido, falhas };
}

/** "Pausar IA" no cartão, com a marca de "fui eu" para a resposta deste turno não ser jogada fora pela trava de antes de enviar. */
async function pausarIa(p: PedidoNaoPaciente, falhas: string[]): Promise<boolean> {
  const { unit, kommo, leadId, pausedFieldId } = p;
  if (!pausedFieldId) {
    falhas.push('a unidade não tem o campo «Pausar IA» configurado');
    logger.error({ unit: unit.slug, leadId }, 'nao-paciente: unidade sem kommoPausedFieldId — a IA não foi pausada');
    return false;
  }
  registrarPausaPropria(unit, leadId);
  try {
    await kommo.setLeadFieldFlag(leadId, pausedFieldId, true);
    return true;
  } catch (err) {
    let pausou = false;
    try {
      pausou = await kommo.isLeadFieldChecked(leadId, pausedFieldId);
    } catch {
      pausou = true; // na dúvida a marca fica: silêncio é o pior caso (mesma regra do pausar_ia)
    }
    if (!pausou) esquecerPausaPropria(unit, leadId);
    falhas.push(`pausa: ${String(err)}`);
    logger.error({ err: String(err), unit: unit.slug, leadId }, 'nao-paciente: não consegui pausar a IA');
    return pausou;
  }
}

/** O que a ferramenta devolve ao modelo. Nunca conta a falha ao candidato: só diz o que escrever. */
export function textoParaOModelo(r: ResultadoNaoPaciente): string {
  if (r.desfecho === 'recusado') return `RECUSADO: ${r.recusa}`;
  const fala =
    'Agora responda UMA frase só ao candidato: agradeça, diga que o currículo foi recebido e que o recrutamento é tratado pela equipe da clínica. ' +
    'Sem pergunta no fim, sem prometer vaga, prazo ou salário, sem falar de consulta, preço ou horário, e sem dizer que "marcou", "etiquetou" ou "fechou" nada.';
  if (r.desfecho === 'feito') return `OK — candidato marcado: etiqueta, motivo e PERDIDO aplicados, IA pausada e follow-up parado. ${fala}`;
  if (r.desfecho === 'ja_estava') return `OK — este cartão já estava marcado como candidato; a IA segue pausada. ${fala}`;
  const faltou = [
    !r.etiquetas && 'a etiqueta',
    !r.movido && 'a mudança para PERDIDO',
    !r.pausada && 'a pausa da IA',
    r.motivo !== 'gravado' && r.motivo !== 'mantido_da_equipe' && 'o motivo',
  ].filter(Boolean);
  return `PARCIAL — a equipe vai terminar a marcação à mão (faltou: ${faltou.join(', ') || 'um detalhe'}); não conte isso ao candidato. ${fala}`;
}
