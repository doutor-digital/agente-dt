/**
 * Unidade com taxa de reserva (Boa Vista): as fotos e PDFs que o paciente mandou e que o webhook NÃO trouxe (WhatsApp Lite: chega só
 * «Você recebeu uma mensagem de mídia…») são lidas aqui, pelo servidor, na rota oficial do Kommo — leitura de sempre + leitura em
 * campos, guardada no banco (lib/comprovante-lido.ts). É o que faz o comprovante da taxa contar.
 *
 * Antes só o caminho do salesbot fazia isto. Boa Vista conversa pelo webhook do chat (6.886 dos 6.999 rastros em 6 semanas), onde só o
 * ÁUDIO do Lite era recuperado: a espera de 18 s era por um áudio que nunca vinha, a foto do comprovante ficava na rota oficial sem ser
 * lida e a Sofia dizia «recebi, já confiro» sobre uma imagem que não viu (leads 23602805 e 23436719, 18 e 21/11/2026).
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { lerAnexosDoPaciente, marcarEntregues } from './comprovante-lido.js';
import { abrirTarefaParaEquipe } from '../agent/confirmacao-so-com-crm.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';
import { createKommoClient } from '../services/kommo.service.js';
import { mensagensOficiaisDaUnidade, type MensagemOficial } from '../services/kommo-talks.service.js';

/** O que o modelo lê quando chegou anexo que o servidor não conseguiu ler (não pode pedir «reenvie» como se nada tivesse chegado, nem dizer que viu). */
export const MARCA_ANEXO_NAO_LIDO = '[cliente mandou uma imagem ou um arquivo, mas não foi possível ler]';

export interface AnexosDoTurno {
  /** falas do paciente com a imagem lida, para ir na frente da mensagem do turno ('' = nada a acrescentar) */
  texto: string;
  /** as leituras de comprovante postas na fala: depois de o turno dar certo, `entregarAnexosDoTurno` */
  paraEntregar: string[];
  /** a conversa oficial lida (reaproveitável por quem chama) */
  msgs: MensagemOficial[] | null;
}

export interface DepsDosAnexosDoTurno {
  ler?: typeof lerAnexosDoPaciente;
  conversa?: typeof mensagensOficiaisDaUnidade;
  abrirTarefa?: typeof abrirTarefaParaEquipe;
  kommo?: typeof createKommoClient;
}

export async function lerAnexosDoTurno(
  unit: Unit,
  leadId: number,
  msgsJaLidas: MensagemOficial[] | null,
  recorder: Pick<TraceRecorder, 'step'>,
  deps: DepsDosAnexosDoTurno = {},
): Promise<AnexosDoTurno> {
  let msgs = msgsJaLidas;
  const vazio = (): AnexosDoTurno => ({ texto: '', paraEntregar: [], msgs });
  if (!unit.spineBookingRequiresPayment || !Number.isFinite(leadId)) return vazio();
  try {
    const criarKommo = deps.kommo ?? createKommoClient;
    msgs = msgsJaLidas ?? (await (deps.conversa ?? mensagensOficiaisDaUnidade)(unit, criarKommo(unit), leadId, 40));
    const lidos = await (deps.ler ?? lerAnexosDoPaciente)(unit, leadId, msgs);
    let texto = lidos.texto;
    if (lidos.naoLidos > 0) {
      // o modelo sabe que chegou algo que não foi possível ler (não pede o comprovante como se nada tivesse chegado), e a equipe é avisada
      texto = `${texto ? `${texto}\n\n` : ''}${MARCA_ANEXO_NAO_LIDO}`;
      await (deps.abrirTarefa ?? abrirTarefaParaEquipe)({
        slug: unit.slug,
        unitId: unit.id,
        leadId,
        kommo: criarKommo(unit),
        recorder,
        motivo: 'anexo_nao_lido',
      }).catch(() => undefined);
    }
    if (lidos.lidos > 0) {
      await recorder.step({
        kind: 'THINKING',
        title: `🧾 Anexos do paciente lidos pela conversa oficial: ${lidos.lidos} lido(s), ${lidos.comprovantes} comprovante(s)`,
        payload: { lidos: lidos.lidos, comprovantes: lidos.comprovantes },
      });
    }
    return { texto, paraEntregar: lidos.paraEntregar, msgs };
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'anexos do paciente: não consegui ler pela conversa oficial (segue sem)');
    return vazio();
  }
}

/** O turno deu certo: os comprovantes que ele carregava já estão na conversa e não precisam ser entregues de novo. */
export async function entregarAnexosDoTurno(paraEntregar: ReadonlyArray<string>, leadId: number): Promise<void> {
  await marcarEntregues(prisma, paraEntregar).catch((err) => logger.warn({ err: String(err), leadId }, 'comprovante: não consegui marcar as leituras como entregues'));
}

/** O que a equipe lê na tarefa de um comprovante que chegou com a IA pausada. */
export interface ComprovanteComIaPausada {
  id: string | null;
  resumo: string;
}

/**
 * Comprovante da taxa que chegou com a IA pausada (Boa Vista, 23/11/2026: o comprovante certo veio 3 min depois da pausa e ninguém soube).
 * A nota «paciente continuou escrevendo» é de 1 por dia e só cita o texto: aqui sai a TAREFA, uma por imagem, com a leitura. Nunca derruba o turno.
 */
export async function avisarComprovanteComIaPausada(
  unit: Unit,
  leadId: number,
  recorder: Pick<TraceRecorder, 'step'>,
  comprovante: ComprovanteComIaPausada,
  deps: Pick<DepsDosAnexosDoTurno, 'abrirTarefa' | 'kommo'> = {},
): Promise<void> {
  try {
    await (deps.abrirTarefa ?? abrirTarefaParaEquipe)({
      slug: unit.slug,
      unitId: unit.id,
      leadId,
      kommo: (deps.kommo ?? createKommoClient)(unit),
      recorder,
      motivo: 'comprovante',
      chaveExtra: comprovante.id ? `ia_pausada:${comprovante.id}` : 'ia_pausada',
      detalhe: `A IA está PAUSADA neste cartão e NÃO marcou nada. Leitura do comprovante: ${comprovante.resumo}`,
    });
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'comprovante com a IA pausada: não consegui abrir a tarefa da equipe (segue)');
  }
}

/**
 * Lite com a IA pausada: a foto do comprovante chega só como aviso de mídia e fica na rota oficial. Lê (uma vez, sem esperar) e abre a tarefa
 * por comprovante. NÃO marca como entregue: se a IA voltar, o turno seguinte entrega a leitura à conversa. Foto que não carregou não gera
 * tarefa aqui (a equipe está na conversa e vê o aviso de mídia); o que importa é o comprovante lido não ficar parado.
 */
export async function avisarComprovanteDoLiteComIaPausada(
  unit: Unit,
  leadId: number,
  recorder: Pick<TraceRecorder, 'step'>,
  deps: DepsDosAnexosDoTurno = {},
): Promise<number> {
  if (!unit.spineBookingRequiresPayment || !Number.isFinite(leadId)) return 0;
  try {
    const msgs = await (deps.conversa ?? mensagensOficiaisDaUnidade)(unit, (deps.kommo ?? createKommoClient)(unit), leadId, 40);
    const lidos = await (deps.ler ?? lerAnexosDoPaciente)(unit, leadId, msgs);
    if (lidos.comprovantes === 0) return 0;
    // uma tarefa por comprovante lido (a chave leva o id da leitura); o texto da leitura vem da própria fala
    const resumo = lidos.texto.replace(/\s+/g, ' ').trim().slice(0, 300) || 'ver a conversa';
    const ids = lidos.paraEntregar.length ? lidos.paraEntregar : [null];
    for (const id of ids) await avisarComprovanteComIaPausada(unit, leadId, recorder, { id, resumo }, deps);
    return lidos.comprovantes;
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'comprovante do Lite com a IA pausada: não consegui ler a rota oficial (segue)');
    return 0;
  }
}
