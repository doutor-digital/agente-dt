/**
 * Antes de responder, a Sofia olha a conversa como o WhatsApp a vê (rota oficial
 * do Kommo) e recupera o que o webhook não trouxe: a resposta da equipe humana e
 * a mensagem do paciente que ficou para trás (áudio inclusive). O resultado é um
 * bloco de contexto que vai junto com a mensagem do turno — e as mensagens
 * recuperadas entram no histórico local, para o rastro e o follow-up baterem
 * com a realidade.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';
import { createKommoClient } from '../services/kommo.service.js';
import {
  desdeUltimaFalaDaSofia,
  mensagensOficiaisDaUnidade,
  renderConversaOficial,
  type MensagemOficial,
} from '../services/kommo-talks.service.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { neutralizarMarcasDoSistema } from './comprovante-pix.js';

/** Mensagem mais nova que isto é o turno atual, que já chegou pelo webhook. */
export const JANELA_DO_TURNO_MS = 3 * 60_000;
const MAX_ITENS = 12;
/**
 * WhatsApp Lite: o aviso de mídia chega ANTES do arquivo carregar no Kommo ("Aguarde o carregamento…"). Mossoró, lead 6478775
 * (09/11/2026): a Sofia respondeu 2,8 s depois do aviso, o áudio de 2 min ainda não tinha link na rota oficial, e ela seguiu
 * sem ouvir. Com o aviso no turno e sem áudio pronto, relê a rota oficial depois de cada uma destas esperas (~18 s no total).
 */
export const ESPERAS_DO_AUDIO_MS = [4_000, 6_000, 8_000];
/**
 * O áudio que ficou para trás: chegou como aviso, a Sofia respondeu sem ele e, a partir daí, ele estava ANTES da última fala
 * dela — fora de `desdeUltimaFalaDaSofia`, nunca mais era olhado. Nos turnos seguintes, áudio do paciente desta janela que
 * nunca foi transcrito volta, se o histórico local tem o aviso de mídia nesse período (só WhatsApp Lite: na API oficial o
 * webhook já trouxe e transcreveu o áudio, e transcrever de novo seria custo e repetição).
 */
export const JANELA_AUDIO_PERDIDO_MS = 15 * 60_000;
const MAX_AUDIOS_PERDIDOS = 3;
const MARCA_TRANSCRITO = '[áudio do cliente]';

const ehAudioPronto = (m: MensagemOficial) => m.autor === 'paciente' && m.anexo?.tipo === 'voice' && !!m.anexo.link;
const dormirPadrao = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export type ItemOficial = MensagemOficial & { transcricao?: string | null };

/**
 * No WhatsApp Lite (QR code) o webhook entrega o áudio do paciente como TEXTO — "Você recebeu uma mensagem de
 * mídia (ID da mensagem: …)" ou "'messageContextInfo' is not yet supported" — e sem o arquivo. O arquivo está na
 * rota oficial (talks). Mossoró (29/10/2026): 196 avisos assim em 7 dias, 11 áudios transcritos.
 */
export function temMidiaSemArquivo(humanMessage: string): boolean {
  return /Você recebeu uma mensagem de mídia|'messageContextInfo' is not yet supported/i.test(humanMessage);
}

/**
 * Filtra o que vale a pena mostrar ao modelo: equipe sempre; paciente só quando a
 * mensagem não está na entrada deste turno nem é do turno atual.
 */
export function selecionarItens(
  recentes: MensagemOficial[],
  humanMessage: string,
  agora: number,
  /** O áudio deste turno NÃO veio pelo webhook (veio só o aviso de mídia): o da rota oficial entra, mesmo sendo recente. */
  audioDoTurnoSemArquivo = false,
): MensagemOficial[] {
  const jaNaEntrada = new Set(humanMessage.split('\n').map((s) => s.trim()).filter(Boolean));
  const itens: MensagemOficial[] = [];
  for (const m of recentes) {
    if (m.autor === 'sofia') continue;
    if (m.autor === 'paciente') {
      if (m.texto && jaNaEntrada.has(m.texto)) continue;
      const ehAudioDoTurno = audioDoTurnoSemArquivo && m.anexo?.tipo === 'voice' && !!m.anexo.link;
      if (agora - m.em.getTime() < JANELA_DO_TURNO_MS && !ehAudioDoTurno) continue;
    }
    itens.push(m);
  }
  return itens.slice(-MAX_ITENS);
}

/**
 * Áudios do paciente ANTES da última fala da Sofia, dentro de `JANELA_AUDIO_PERDIDO_MS`, que ela não ouviu. Puro: quem chama
 * diz se o histórico tem o aviso de mídia na janela e quais ids da rota oficial já foram transcritos.
 */
export function audiosPerdidos(
  msgs: MensagemOficial[],
  agora: number,
  o: { avisoNaJanela: boolean; jaTranscritos: Set<string> },
): MensagemOficial[] {
  if (!o.avisoNaJanela) return [];
  const depois = new Set(desdeUltimaFalaDaSofia(msgs).map((m) => m.id));
  return msgs
    .filter((m) => ehAudioPronto(m) && !depois.has(m.id) && agora - m.em.getTime() < JANELA_AUDIO_PERDIDO_MS && !o.jaTranscritos.has(m.id))
    .slice(-MAX_AUDIOS_PERDIDOS);
}

/** O que o histórico local diz da janela: houve aviso de mídia do paciente? quais áudios da rota oficial já viraram texto? */
async function situacaoDoHistorico(unit: Unit, leadId: number, agora: number): Promise<{ avisoNaJanela: boolean; jaTranscritos: Set<string> }> {
  const conv = await prisma.conversation.findFirst({ where: { unitId: unit.id, leadId: String(leadId) }, orderBy: { lastMessageAt: 'desc' }, select: { id: true } });
  if (!conv) return { avisoNaJanela: false, jaTranscritos: new Set() };
  // margem: a cópia da rota oficial grava com a hora do WhatsApp, e o áudio é um pouco mais velho que o aviso
  const desde = new Date(agora - JANELA_AUDIO_PERDIDO_MS - 5 * 60_000);
  const ms = await prisma.message.findMany({
    where: { conversationId: conv.id, role: 'user', createdAt: { gte: desde } },
    select: { content: true, meta: true },
    take: 200,
  });
  const jaTranscritos = new Set<string>();
  let avisoNaJanela = false;
  for (const m of ms) {
    if (temMidiaSemArquivo(m.content)) avisoNaJanela = true;
    const id = (m.meta as { kommoMessageId?: unknown } | null)?.kommoMessageId;
    if (typeof id === 'string' && m.content.startsWith(MARCA_TRANSCRITO)) jaTranscritos.add(id);
  }
  return { avisoNaJanela, jaTranscritos };
}

async function registrarNoHistorico(unit: Unit, leadId: number, itens: ItemOficial[]): Promise<void> {
  const conv = await prisma.conversation.findFirst({
    where: { unitId: unit.id, leadId: String(leadId) },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  if (!conv) return;
  for (const m of itens) {
    const conteudo = m.transcricao ? `${MARCA_TRANSCRITO}: ${m.transcricao}` : m.texto || (m.anexo ? `[${m.anexo.tipo}]` : '');
    if (!conteudo) continue;
    // Já gravada por este caminho (id do Kommo) ou pelo webhook (mesmo texto, mesmo
    // minuto): o webhook grava sem id, então a segunda checagem evita a linha dobrada.
    const existe = await prisma.message.findFirst({
      where: {
        conversationId: conv.id,
        OR: [
          { meta: { path: ['kommoMessageId'], equals: m.id } },
          { content: m.texto || conteudo, createdAt: { gte: new Date(m.em.getTime() - 120_000), lte: new Date(m.em.getTime() + 120_000) } },
        ],
      },
      select: { id: true, content: true },
    });
    if (existe) {
      // gravado antes como "[voice]" (não deu pra transcrever naquela hora) e transcrito agora: a linha passa a ter o texto,
      // senão o próximo turno acharia o áudio "nunca transcrito" e pagaria a transcrição de novo
      if (m.transcricao && !existe.content.startsWith(MARCA_TRANSCRITO)) {
        await prisma.message.update({ where: { id: existe.id }, data: { content: conteudo } });
      }
      continue;
    }
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: m.autor === 'paciente' ? 'user' : 'assistant',
        content: conteudo,
        createdAt: m.em,
        meta: { origem: 'kommo_talks', kommoMessageId: m.id, autor: m.autor, nome: m.autorNome || null },
      },
    });
  }
}

export async function blocoDaConversaOficial(args: {
  unit: Unit;
  leadId: number;
  humanMessage: string;
  recorder: TraceRecorder;
  /** A conversa já lida neste turno (a porta da pausa pela equipe lê antes): evita ler o Kommo duas vezes. */
  msgs?: MensagemOficial[] | null;
  /** Nenhum áudio chegou pelo webhook neste turno (quem chama sabe). Junto com o aviso de mídia no texto, liga a busca do áudio na rota oficial. */
  nenhumAudioNoWebhook?: boolean;
  /** Testes: leitura da rota oficial, espera e o histórico local trocáveis. */
  ler?: () => Promise<MensagemOficial[]>;
  dormir?: (ms: number) => Promise<void>;
  esperas?: number[];
  historico?: (agora: number) => Promise<{ avisoNaJanela: boolean; jaTranscritos: Set<string> }>;
  transcrever?: (link: string) => Promise<{ text: string }>;
  registrar?: (unit: Unit, leadId: number, itens: ItemOficial[]) => Promise<void>;
}): Promise<string> {
  const { unit, leadId, humanMessage, recorder } = args;
  const ler = args.ler ?? (() => mensagensOficiaisDaUnidade(unit, createKommoClient(unit), leadId, 40));
  const dormir = args.dormir ?? dormirPadrao;
  const audioDoTurnoSemArquivo = !!args.nenhumAudioNoWebhook && temMidiaSemArquivo(humanMessage);
  let msgs = args.msgs ?? (await ler());
  let selecionados = selecionarItens(desdeUltimaFalaDaSofia(msgs), humanMessage, Date.now(), audioDoTurnoSemArquivo);

  // o aviso de mídia chegou e o áudio ainda não tem link na rota oficial: espera o Kommo carregar e relê
  if (audioDoTurnoSemArquivo && !selecionados.some(ehAudioPronto)) {
    const esperas = args.esperas ?? ESPERAS_DO_AUDIO_MS;
    let esperado = 0;
    for (const ms of esperas) {
      await dormir(ms);
      esperado += ms;
      msgs = await ler();
      selecionados = selecionarItens(desdeUltimaFalaDaSofia(msgs), humanMessage, Date.now(), true);
      if (selecionados.some(ehAudioPronto)) break;
    }
    const achou = selecionados.some(ehAudioPronto);
    await recorder.step({
      kind: achou ? 'THINKING' : 'ERROR',
      title: achou
        ? `Áudio do WhatsApp Lite: carregou no Kommo depois de ${Math.round(esperado / 1000)} s de espera`
        : `Áudio do WhatsApp Lite: não carregou no Kommo em ${Math.round(esperado / 1000)} s — segue sem (o próximo turno tenta de novo)`,
      payload: { leadId, esperadoMs: esperado },
    });
  }

  // áudio de um turno anterior que a Sofia respondeu sem ouvir (estava antes da última fala dela)
  let perdidos: MensagemOficial[] = [];
  const agora = Date.now();
  if (msgs.some((m) => ehAudioPronto(m) && agora - m.em.getTime() < JANELA_AUDIO_PERDIDO_MS)) {
    const sit = await (args.historico ?? ((t: number) => situacaoDoHistorico(unit, leadId, t)))(agora).catch(() => ({ avisoNaJanela: false, jaTranscritos: new Set<string>() }));
    const jaNaLista = new Set(selecionados.map((m) => m.id));
    perdidos = audiosPerdidos(msgs, agora, sit).filter((m) => !jaNaLista.has(m.id));
  }
  if (!selecionados.length && !perdidos.length) return '';

  const itens: ItemOficial[] = [];
  for (const m of [...perdidos, ...selecionados]) {
    let transcricao: string | null = null;
    if (ehAudioPronto(m)) {
      transcricao = await (args.transcrever ?? ((link: string) => transcribeAudio(unit, link)))(m.anexo!.link!)
        .then((t) => t.text || null)
        .catch((err) => {
          logger.warn({ err: String(err), leadId, unit: unit.slug }, 'conversa oficial: áudio antigo não transcrito');
          return null;
        });
    }
    itens.push({ ...m, transcricao });
  }

  const daEquipe = itens.filter((m) => m.autor === 'equipe').length;
  await recorder.step({
    kind: 'THINKING',
    title: `Conversa oficial: ${daEquipe} mensagem(ns) da equipe e ${itens.length - daEquipe} do paciente desde a última fala da Sofia`,
    payload: {
      itens: itens.map((m) => ({ em: m.em, autor: m.autor, nome: m.autorNome, texto: (m.transcricao ?? m.texto).slice(0, 120) })),
    },
  });
  await (args.registrar ?? registrarNoHistorico)(unit, leadId, itens).catch((err) =>
    logger.warn({ err: String(err), leadId }, 'conversa oficial: falha ao gravar no histórico (segue)'),
  );
  let bloco = renderConversaOficial(itens, unit.spineTimezone ?? 'America/Sao_Paulo');
  const perdidosOuvidos = itens.filter((m) => perdidos.some((p) => p.id === m.id) && m.transcricao).length;
  if (perdidosOuvidos) {
    await recorder.step({ kind: 'THINKING', title: `Áudio do WhatsApp Lite que a Sofia não tinha ouvido: ${perdidosOuvidos} recuperado(s) e transcrito(s)`, payload: { leadId } });
    bloco = bloco.replace(
      '</conversa_oficial>',
      'ATENÇÃO: o áudio transcrito acima chegou ANTES da sua última mensagem, mas você respondeu sem ouvi-lo (ele ainda estava carregando). ' +
        'Responda agora levando em conta o que o paciente disse nele; se você pediu para ele escrever ou repetir, NÃO peça de novo e não diga que a mídia falhou.\n</conversa_oficial>',
    );
  }
  // Unidade com taxa de reserva: mensagem antiga do paciente, trazida da rota oficial, não pode trazer as marcas que só o servidor grava.
  return unit.spineBookingRequiresPayment ? neutralizarMarcasDoSistema(bloco) : bloco;
}

/**
 * A mensagem crua do paciente, sem o bloco `<conversa_oficial>` que o controller prega na frente.
 *
 * O bloco entra no HumanMessage de propósito (cauda dinâmica, não estoura o prefixo em cache), mas
 * quem decide COISAS SOBRE O QUE O PACIENTE ESCREVEU tem de ver só o que ele escreveu. Sem isto,
 * `ehSoCumprimento` recebe "<conversa_oficial>…</conversa_oficial>\n\nbom dia" e nunca reconhece o
 * cumprimento — justamente o caso da Glória, que foi o motivo de a regra existir. Vale igual para
 * a busca no RAG e para a detecção de nome.
 */
export function semBlocoOficial(texto: string | undefined): string | undefined {
  if (!texto) return texto;
  const limpo = texto.replace(/<conversa_oficial>[\s\S]*?<\/conversa_oficial>\s*/g, '').trim();
  // bloco sem fechamento (truncado): não dá pra separar com segurança, devolve como veio
  return limpo || texto;
}
