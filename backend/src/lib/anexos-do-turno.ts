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
import { ESPERAS_DO_AUDIO_MS, midiaDoTurnoPronta } from './conversa-oficial.js';

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
  /** Só entrega o que já foi lido e ficou sem entregar (ver `DepsDosAnexos.soEntregar`): não lê imagem nova, não vai ao Kommo, não abre tarefa. */
  soEntregar?: boolean;
  /** Testes: a espera do Lite (como em `blocoDaConversaOficial`). */
  dormir?: (ms: number) => Promise<void>;
  esperas?: number[];
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
  // só entregar: sem a conversa já lida pelo turno não há o que fazer (não vale uma ida ao Kommo por turno)
  if (deps.soEntregar && !msgsJaLidas) return vazio();
  try {
    const criarKommo = deps.kommo ?? createKommoClient;
    msgs = msgsJaLidas ?? (await (deps.conversa ?? mensagensOficiaisDaUnidade)(unit, criarKommo(unit), leadId, 40));
    const lidos = await (deps.ler ?? lerAnexosDoPaciente)(unit, leadId, msgs, deps.soEntregar ? { soEntregar: true } : {});
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

/** O comprovante lido fica 72 h na janela de leitura (lib/comprovante-lido.ts): é o tempo em que o mesmo comprovante pode reaparecer. */
const JANELA_DO_AVISO_PAUSADA_MS = 72 * 3_600_000;
/** Foto do Lite que não carregou, com a IA pausada: uma tarefa «ver anexo» a cada tanto, não uma por mídia. */
const JANELA_ANEXO_NAO_LIDO_PAUSADA_MS = 6 * 3_600_000;

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
      // o MESMO comprovante parado não abre outra tarefa a cada mídia do paciente (a leitura não entregue é reivindicada de novo a cada 5 min)
      janelaMs: JANELA_DO_AVISO_PAUSADA_MS,
      detalhe: `A IA está PAUSADA neste cartão e NÃO marcou nada. Leitura do comprovante: ${comprovante.resumo}`,
    });
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'comprovante com a IA pausada: não consegui abrir a tarefa da equipe (segue)');
  }
}

/**
 * Lite com a IA pausada: a foto do comprovante chega só como aviso de mídia e fica na rota oficial. Espera ela carregar (como o turno comum),
 * lê, e abre a tarefa por comprovante. NÃO marca como entregue: o turno comum seguinte (`lerAnexosDoTurno` com `soEntregar`) a entrega à
 * conversa quando a IA voltar. Foto que não carregou depois da espera abre «ver anexo» (uma a cada 6 h): pode ser o comprovante.
 */
export async function avisarComprovanteDoLiteComIaPausada(
  unit: Unit,
  leadId: number,
  recorder: Pick<TraceRecorder, 'step'>,
  humanMessage: string,
  deps: DepsDosAnexosDoTurno = {},
): Promise<number> {
  if (!unit.spineBookingRequiresPayment || !Number.isFinite(leadId)) return 0;
  try {
    const criarKommo = deps.kommo ?? createKommoClient;
    const conversa = deps.conversa ?? mensagensOficiaisDaUnidade;
    const dormir = deps.dormir ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
    let msgs = await conversa(unit, criarKommo(unit), leadId, 40);
    for (const ms of deps.esperas ?? ESPERAS_DO_AUDIO_MS) {
      if (midiaDoTurnoPronta(msgs, humanMessage, Date.now())) break;
      await dormir(ms);
      msgs = await conversa(unit, criarKommo(unit), leadId, 40);
    }
    const lidos = await (deps.ler ?? lerAnexosDoPaciente)(unit, leadId, msgs);
    if (lidos.comprovantes === 0) {
      if (lidos.naoLidos > 0) {
        await (deps.abrirTarefa ?? abrirTarefaParaEquipe)({ slug: unit.slug, unitId: unit.id, leadId, kommo: criarKommo(unit), recorder, motivo: 'anexo_nao_lido', janelaMs: JANELA_ANEXO_NAO_LIDO_PAUSADA_MS }).catch(() => undefined);
      }
      return 0;
    }
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
