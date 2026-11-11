/**
 * Sofia 2.0 (11/11/2026): o Pix copia-e-cola do sinal sai numa mensagem SÓ COM O CÓDIGO, logo depois da resposta da Sofia.
 *
 * Por quê à parte: no WhatsApp, tocar e segurar copia a mensagem inteira, e o app do banco recusa o código com frase em volta.
 * Pedido do João ("pensa num idoso"): sem formulário, sem link — copia, cola no banco e paga.
 *
 * Por quê esperar: o salesbot lê o campo "Resposta IA" na hora em que roda (assíncrono). Regravar o campo antes de a 1ª mensagem
 * sair faria o paciente receber o código duas vezes e perder a explicação. Então confiro na conversa oficial (`/talks/{id}/messages`)
 * que a resposta já saiu e só depois mando o código. Sem confirmar a tempo, mando assim mesmo: código duplicado é melhor que nenhum.
 *
 * Nunca derruba nada: falhou, vira tarefa para a equipe mandar o Pix à mão.
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { jaSaiu, type MensagemDaConversa } from './reenvio-salesbot.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { pixDoSinalDoTurno } from '../agent/sinal-pix-tool.js';
import { abrirTarefaParaEquipe } from '../agent/confirmacao-so-com-crm.js';

export const ESPERA_DA_RESPOSTA_MS = 12_000;
const PASSO_MS = 1_500;

export interface EnvioDoPix {
  unit: Pick<Unit, 'id' | 'slug'>;
  leadId: number;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
  /** o texto da Sofia que acabou de sair (a explicação do Pix) */
  respostaAnterior: string;
  /** a resposta saiu pelo salesbot (campo "Resposta IA"): aí é preciso esperar ela sair antes de regravar o campo */
  viaSalesbot: boolean;
  /** modo widget: a entrega é uma só (return_url) — não há como mandar a 2ª mensagem por ali */
  modoWidget: boolean;
  recorder: Pick<TraceRecorder, 'step' | 'traceId'>;
  kommo: Pick<KommoClient, 'sendChatReply' | 'listTalkMessages' | 'createTask' | 'getLead'>;
  /** grava a mensagem no histórico da conversa (messages) */
  registrar: (texto: string) => Promise<unknown>;
  esperar?: (ms: number) => Promise<void>;
  agora?: () => number;
  /** o teste troca a deduplicação (banco) e o alerta (Telegram) da tarefa */
  dedupe?: Parameters<typeof abrirTarefaParaEquipe>[0]['dedupe'];
  alertar?: (texto: string) => Promise<unknown>;
}

export type DesfechoDoPix = 'sem-pix' | 'enviado' | 'enviado-sem-confirmar-anterior' | 'falhou';

/** Espera a resposta anterior aparecer na conversa oficial. `true` = saiu; `false` = não deu para confirmar no prazo. */
export async function esperarRespostaSair(
  ler: () => Promise<MensagemDaConversa[] | null>,
  texto: string,
  esperar: (ms: number) => Promise<void>,
  agora: () => number,
  prazoMs = ESPERA_DA_RESPOSTA_MS,
): Promise<boolean> {
  const fim = agora() + prazoMs;
  for (;;) {
    const vistas = await ler().catch(() => null);
    if (vistas && jaSaiu(vistas, texto, Math.floor(agora() / 1000))) return true;
    if (agora() + PASSO_MS > fim) return false;
    await esperar(PASSO_MS);
  }
}

export async function enviarPixDoSinal(a: EnvioDoPix): Promise<DesfechoDoPix> {
  const pix = pixDoSinalDoTurno(a.recorder.traceId);
  if (!pix) return 'sem-pix';
  const esperar = a.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const agora = a.agora ?? Date.now;

  const tarefa = (por: string) =>
    abrirTarefaParaEquipe({
      slug: a.unit.slug,
      unitId: a.unit.id,
      leadId: a.leadId,
      kommo: a.kommo,
      recorder: a.recorder,
      motivo: 'sinal_pix_falhou',
      chaveExtra: 'codigo_nao_saiu',
      dedupe: a.dedupe,
      alertar: a.alertar,
      detalhe: `O Pix copia-e-cola FOI gerado no Asaas, mas a mensagem com o código NÃO saiu (${por}). Mandar ao paciente este código, sozinho numa mensagem: ${pix}`,
    }).catch(() => 'falhou' as const);

  if (a.modoWidget) {
    await a.recorder.step({ kind: 'ERROR', title: '💠 Pix do sinal: modo widget não manda 2ª mensagem — tarefa para a equipe', payload: { leadId: a.leadId } });
    await tarefa('modo widget');
    return 'falhou';
  }

  let confirmou = true;
  if (a.viaSalesbot) {
    const talk = Number(a.talkId) || 0;
    confirmou = talk
      ? await esperarRespostaSair(() => a.kommo.listTalkMessages(talk, 15), a.respostaAnterior, esperar, agora)
      : (await esperar(6_000), false);
    if (!confirmou) logger.warn({ leadId: a.leadId, unit: a.unit.slug }, 'pix-do-sinal: não confirmei a saída da resposta anterior — mando o código assim mesmo');
  }

  const t0 = agora();
  try {
    const r = await a.kommo.sendChatReply({ leadId: a.leadId, chatId: a.chatId, talkId: a.talkId, contactId: a.contactId, text: pix });
    if (r.via === 'lead_note') throw new Error('virou nota interna, não chegou ao paciente');
    await a.recorder.step({
      kind: 'KOMMO_ACTION',
      title: `💠 Pix copia-e-cola do sinal enviado à parte (${r.via}${confirmou ? '' : ', sem confirmar a resposta anterior'})`,
      payload: { leadId: a.leadId, via: r.via, confirmouAnterior: confirmou },
      latencyMs: agora() - t0,
    });
    await a.registrar(pix).catch((err) => logger.warn({ err: String(err), leadId: a.leadId }, 'pix-do-sinal: não gravei no histórico (segue)'));
    return confirmou ? 'enviado' : 'enviado-sem-confirmar-anterior';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, leadId: a.leadId, unit: a.unit.slug }, 'pix-do-sinal: o código não saiu — tarefa para a equipe');
    await a.recorder.step({ kind: 'ERROR', title: `💠 Pix do sinal NÃO saiu (${msg.slice(0, 90)}) — tarefa para a equipe`, payload: { leadId: a.leadId, erro: msg } });
    await tarefa(msg.slice(0, 120));
    return 'falhou';
  }
}
