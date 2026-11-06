/**
 * Rotina diária, régua 2 — EX-LEAD QUE NUNCA AGENDOU (chave `ROTINA_EXLEAD_SLUGS`, automação `rotina-exlead`).
 *
 * Quem nunca teve consulta (nem no cartão nem na franquia) e hoje está em PERDIDO ou EM ESPERA recebe a ▶ Reativação 30 dias depois da
 * última mensagem do paciente, a ▶ Reativação 2 aos 60 e a ▶ Reativação 3 aos 90. As outras etapas ficam de fora de propósito:
 * a ENTRADA e a EM QUALIFICAÇÃO têm a régua por etapa e o `parados` (90 dias sem mexer → PERDIDO, e aí entra aqui); quem está
 * AGENDADO, COMPARECEU ou EM TRATAMENTO é paciente, não ex-lead.
 *
 * DIVIDE a Reativação com o `etiquetas-auto` PELA MARCA, sem buraco: ele continua pondo a ▶ Reativação 30 d depois da perda, mas PULA a
 * pessoa a quem esta rotina já deu algum degrau (`pularSeARotinaJaCuidou`); e a Reativação que ele já pôs conta aqui como o 1º degrau.
 * O que esta rotina não alcança (lista cortada em 1.500 cartões, «Pausar IA», ◷ Retomar em, quem nunca escreveu) segue saindo de lá.
 *
 * É a MESMA ▶ Reativação, então vale a MESMA proteção do `etiquetas-auto` (mensagem quebrada ou insistência indevida):
 *  - sem a `_v2` aprovada na unidade, o modelo diz "Aqui é {☻ Responsável agendamento}": responsável vazio ou que não é gente segura o 1º toque;
 *  - cartão que nasceu em PERDIDO (importação/carga): os 30 dias não são do paciente;
 *  - quem voltou a conversar em OUTRO cartão (cartão aberto depois da perda, conversa nos últimos 30 dias): não.
 * Além disso: motivo de perda encerrado (Outra cidade, Clicou por engano, Outra patologia, Plano de Saúde, Sem interesse…), NO_FOLLOW_UP,
 * opt-out e CURRÍCULO nunca recebem — o motivo do campo ⊘ OU o escolhido no diálogo NATIVO do Kommo (`loss_reason_id`). O 1º toque só
 * vale com silêncio entre 30 e 60 dias. O relógio conta da última mensagem OU da entrada na situação atual, o que for mais recente: em
 * PERDIDO, a perda (o estoque que o `parados` perde depois de meses calado entra 30 dias depois dela); em EM ESPERA, a entrada na etapa
 * (a SDR que move para esperar uma ligação não dispara a Reativação horas depois). Depois do 1º degrau o relógio segue só na mensagem
 * do paciente: mudar de etapa não zera a régua.
 */
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { ETAPA } from './franquia-move.js';
import { acharNaConta } from './ponte-etiquetas.js';
import { MOTIVO_NASCEU_EM_PERDIDO, nasceuEmPerdido, responsavelQueQuebraOModelo } from './etiquetas-auto.js';
import { v2DaUnidade, voltouEmOutroCartao } from './etiquetas-auto-worker.js';
import { cartoesDaEtapa, prazos, varrerSilencio } from './rotina-silencio.js';
import { ID_ROTINA_EXLEAD, estadoDoExLead } from './rotina-exlead-nunca.js';
import { criarWorker, inteiro, intentsDe, limitar, MAX_TOQUES, resumoNovo, type Ctx, type Regua, type ResumoDaRegua } from './rotina-nucleo.js';

export { ID_ROTINA_EXLEAD, estadoDoExLead };

export const CHAVE_EXLEAD = 'exlead';
export const DIAS_EXLEAD: readonly number[] = [30, 60, 90];
export const ETAPAS_DO_EXLEAD = [ETAPA.PERDIDO, ETAPA.ESPERA] as const;
/** A 1ª é a ▶ Reativação que já existe e o `etiquetas-auto` já usa; 2 e 3 são novas. */
export const ETIQUETAS_EXLEAD: readonly string[] = ['▶ Reativação', '▶ Reativação 2', '▶ Reativação 3'];
/** O 1º toque só vale enquanto o silêncio está em [30, 30 + isto). Estoque mais velho não entra de uma vez. */
export const ENTRADA_EXLEAD_DIAS = 30;

export interface ConfigDoExLead {
  dias: number[];
  /** quantos degraus de ▶ Reativação têm etiqueta + robô + modelo prontos NA CONTA */
  toquesProntos: number;
  invalidas: string[];
}

/** Chaves da unidade (`pipelineIntents`): `rotina_exlead_d1..d3` e `rotina_exlead_toques_prontos`. */
export function configDoExLead(pipelineIntents: unknown, env: Record<string, string | undefined> = process.env): ConfigDoExLead {
  const intents = intentsDe(pipelineIntents);
  const invalidas: string[] = [];
  const dias = prazos(DIAS_EXLEAD, intents, 'rotina_exlead', env.ROTINA_ROBOS_DIAS_EXLEAD, invalidas);
  return { dias, toquesProntos: limitar(inteiro(intents.rotina_exlead_toques_prontos), MAX_TOQUES, 1), invalidas };
}

/** O 1º toque do ex-lead = a ▶ Reativação. Se o `etiquetas-auto` já a pôs neste PERDIDO, o degrau 1 conta como enviado. */
async function marcasDaReativacaoAntiga(ctx: Ctx, leads: KommoLead[]) {
  const porId = new Map<string, KommoLead>();
  for (const l of leads) if (l.closed_at) porId.set(`etiqueta-${ctx.unit.id}-reativacao:${l.id}:${l.closed_at}`, l);
  const mapa = new Map<number, Array<{ chave: string; toque: number; em: number }>>();
  if (porId.size === 0) return mapa;
  const achadas = await prisma.executionTrace.findMany({ where: { id: { in: [...porId.keys()] } }, select: { id: true, createdAt: true } });
  for (const a of achadas) {
    const lead = porId.get(a.id);
    if (lead) mapa.set(lead.id, [{ chave: CHAVE_EXLEAD, toque: 1, em: Math.floor(a.createdAt.getTime() / 1000) }]);
  }
  return mapa;
}

/** As travas da ▶ Reativação do `etiquetas-auto`, aplicadas aqui (é a mesma etiqueta e o mesmo robô). */
async function travasDaReativacao(ctx: Ctx, lead: KommoLead, toque: number) {
  const { unit, agora } = ctx;
  const kommo = ctx.kommo as unknown as KommoClient;
  const perdido = lead.status_id === 143 && !!lead.closed_at;
  if (perdido && nasceuEmPerdido(lead, lead.closed_at as number)) return { codigo: 'nasceu-em-perdido', texto: MOTIVO_NASCEU_EM_PERDIDO, horas: 24 * 7 };
  if (toque === 1) {
    const v2 = await v2DaUnidade(unit, kommo);
    const quebra = v2.reativacao ? null : responsavelQueQuebraOModelo(lead);
    if (quebra) return { codigo: 'responsavel-quebra-o-modelo', texto: quebra, horas: 24 };
  }
  if (perdido) {
    const outro = await voltouEmOutroCartao(unit.id, kommo, lead, lead.closed_at as number, agora);
    if (outro) return { codigo: 'voltou-em-outro-cartao', texto: outro, horas: 24 };
  }
  return null;
}

/** Ex-lead que nunca agendou, hoje em PERDIDO ou EM ESPERA. */
export async function varrerExLead(ctx: Ctx, seco: boolean, resumo: Record<string, ResumoDaRegua>): Promise<void> {
  const r = (resumo[CHAVE_EXLEAD] = resumoNovo());
  if (!acharNaConta(ETIQUETAS_EXLEAD[0], [...ctx.tagsDaConta])) {
    logger.warn({ unit: ctx.unit.slug, etiqueta: ETIQUETAS_EXLEAD[0] }, 'rotina: a conta não tem a etiqueta do 1º toque do ex-lead — nada a fazer');
    r.seguradas['sem-etiqueta-na-conta'] = 1;
    return;
  }
  const cfg = configDoExLead(ctx.unit.pipelineIntents);
  if (cfg.invalidas.length) logger.warn({ unit: ctx.unit.slug, invalidas: cfg.invalidas }, 'rotina: prazos inválidos na unidade — usei os padrões');
  for (const etapa of ETAPAS_DO_EXLEAD) {
    const alvo = etapa === ETAPA.PERDIDO ? { pipelineId: ctx.funis.comercialId, statusId: 143 } : ctx.funis.idDe('COMERCIAL', etapa);
    if (!alvo) continue;
    await varrerSilencio(
      ctx,
      seco,
      {
        automacao: ID_ROTINA_EXLEAD,
        chave: CHAVE_EXLEAD,
        etapa,
        dias: cfg.dias,
        etiquetas: ETIQUETAS_EXLEAD,
        prontos: cfg.toquesProntos,
        entradaAteDias: cfg.dias[0] + ENTRADA_EXLEAD_DIAS,
        // olha bem longe: o estoque que o `parados` perdeu depois de meses calado tem a última mensagem lá atrás
        janelaOlhadaDias: 365,
        opcoesDoCartao: { conferirMotivoMorto: true },
        soQuemNuncaAgendou: true,
        // PERDIDO conta da perda; EM ESPERA, da ENTRADA na etapa (a SDR combina esperar por ligação e move sem «◷ Retomar em»: a
        // última mensagem pode ser antiga e a Reativação sairia horas depois)
        ancorarNaPerda: etapa === ETAPA.PERDIDO,
        ancorarNaEntrada: etapa === ETAPA.ESPERA,
        marcasExtras: marcasDaReativacaoAntiga,
        travaExtra: travasDaReativacao,
      },
      await cartoesDaEtapa(ctx.kommo, alvo),
      r,
    );
  }
}

export const reguaDoExLead: Regua = { id: ID_ROTINA_EXLEAD, estado: estadoDoExLead, primeiraEmMin: 10, rodar: varrerExLead };

const worker = criarWorker(reguaDoExLead);
export const startRotinaExLeadWorker = worker.start;
export const stopRotinaExLeadWorker = worker.stop;
