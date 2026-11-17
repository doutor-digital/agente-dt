/**
 * NÃO-PACIENTE MARCADO PELA EQUIPE (pendência 6 de Petrópolis, 17/11/2026): "impedir que funcionários continuem recebendo
 * mensagens de follow-up, mesmo após serem cadastrados como perdidos e terem a conversa encerrada."
 *
 * O que aconteceu (Heitor Barrozo, fisioterapeuta da clínica, cartão 5953841):
 *  - toda conversa nova do funcionário com o número da clínica abre um cartão NOVO em EM QUALIFICAÇÃO (Lite);
 *  - a NOSSA cutucada (cutucada-apos-equipe) falou com ele às 15:49, porque a secretária escreveu e ele não respondeu em 2 h;
 *  - às 15:52 a equipe marcou PERDIDO "Não é paciente (currículo)" à mão — SEM a etiqueta NO_FOLLOW_UP. Os robôs de PERDIDO do
 *    Kommo (48/96/120 h) leem a etiqueta NO EVENTO de entrar em PERDIDO (parados-worker.ts, nao-paciente.ts): pôr a etiqueta
 *    depois não cancela a régua que já ficou agendada.
 *
 * O que esta automação faz (chave `nao-paciente-manual`, por unidade, com "só no papel"):
 *  1. a cada 10 min, os PERDIDO do COMERCIAL das últimas 72 h com "⊘ Motivo" = "Não é paciente (currículo)" e sem a etiqueta de
 *     não contatar: põe NO_FOLLOW_UP + CURRÍCULO;
 *  2. se a unidade configurou `pipeline_intents.nao_paciente_reentrada_status_id` (uma etapa do COMERCIAL SEM robô de entrada —
 *     Petrópolis: EM QUALIFICAÇÃO), tira o cartão de PERDIDO e devolve, para o gatilho ler a etiqueta de novo e não agendar nada;
 *  3. marca a conversa com a parada de follow-up de não-paciente (a mesma que `marcarNaoPaciente` grava) — e é ESSA marca que faz o
 *     TELEFONE ficar de fora nos próximos cartões: a Sofia cala (porta de calar-paciente-em-tratamento) e a cutucada não fala.
 *
 * Desfazer para uma pessoa (marcada por engano): limpar `follow_up_stopped_reason` das conversas daquele telefone e tirar a etiqueta.
 */
import { prisma } from './prisma.js';
import { normalizarNome } from './kommo-schema.js';
import { ultimos8 } from './numeros-internos.js';
import { automacaoLigada } from './automacoes-estado.js';

export const ID_NAO_PACIENTE_MANUAL = 'nao-paciente-manual';
/** O mesmo texto de `nao-paciente.ts` (MOTIVO_DE_PARADA_DO_FOLLOW_UP / OPCAO_MOTIVO_CURRICULO): copiado para este módulo ficar leve. */
export const MOTIVO_PARADA_NAO_PACIENTE = 'não é paciente (currículo)';
export const OPCAO_NAO_PACIENTE = 'Não é paciente (currículo)';

export type PlanoNaoPaciente = 'nada' | 'so_conversa' | 'etiquetar';

/**
 * Puro. `motivo` = o "⊘ Motivo" do cartão; `tags` = etiquetas do cartão; `naoContatar` = a etiqueta da conta (NO_FOLLOW_UP).
 *  - outro motivo → nada;
 *  - já tem a etiqueta (a Sofia marcou, ou a varredura anterior) → só garante a marca da conversa;
 *  - sem a etiqueta → etiquetar (e, com a etapa configurada, sair e voltar de PERDIDO).
 */
export function planoNaoPaciente(args: { motivo: string | null | undefined; tags: ReadonlyArray<string>; naoContatar: string }): PlanoNaoPaciente {
  if (!args.motivo || normalizarNome(args.motivo) !== normalizarNome(OPCAO_NAO_PACIENTE)) return 'nada';
  const alvo = normalizarNome(args.naoContatar);
  return args.tags.some((t) => normalizarNome(t) === alvo) ? 'so_conversa' : 'etiquetar';
}

/** A etapa de passagem da unidade (inteiro positivo em `pipeline_intents`), ou null = não sai de PERDIDO. */
export function etapaDeReentrada(pipelineIntents: unknown): number | null {
  const v = ((pipelineIntents ?? {}) as Record<string, unknown>).nao_paciente_reentrada_status_id;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v !== 143 && v !== 142 ? v : null;
}

/** A automação está ligada nesta unidade? (A memória do telefone só vale onde ela está LIGADA.) */
export function naoPacienteManualLigada(slug: string): boolean {
  return automacaoLigada(slug, ID_NAO_PACIENTE_MANUAL, process.env.NAO_PACIENTE_MANUAL_SLUGS);
}

/**
 * Este TELEFONE já foi marcado como não-paciente nesta unidade (funcionário, candidato)? Pelos últimos 8 dígitos, numa conversa
 * com a parada de follow-up de não-paciente. Só responde `true` onde a automação está LIGADA; falha de banco = `false` (segue
 * como antes, nunca cala por erro).
 */
export async function telefoneMarcadoNaoPaciente(unit: { id: string; slug: string }, telefone: string | null | undefined): Promise<boolean> {
  if (!naoPacienteManualLigada(unit.slug)) return false;
  const fim = ultimos8(telefone);
  if (!fim) return false;
  try {
    const c = await prisma.conversation.findFirst({
      where: { unitId: unit.id, followUpStoppedReason: MOTIVO_PARADA_NAO_PACIENTE, phone: { endsWith: fim } },
      select: { id: true },
    });
    return !!c;
  } catch {
    return false;
  }
}
