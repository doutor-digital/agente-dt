/**
 * Quando a Sofia pode fechar como PERDIDO um lead Quente/Morno (decisão do João, 26/10, pela análise do item 5).
 *
 * Medido em 18–26/10: dos 36 `fechar_lead(lost)` da Sofia, 31 foram recusa clara e os 5 erros (4 objeções — 3 de plano de
 * saúde, 1 financeira — e 1 óbito) estavam TODOS entre os 15 Quente/Morno (0 entre os 21 Frio/sem qualificação). A regra, no
 * código e não só no prompt:
 *
 *   Frio / sem qualificação        segue como sempre (fecha);
 *   Quente/Morno + recusa explícita ("não quero", "já resolvi/fiz com outro", "pode encerrar")  → fecha;
 *   Quente/Morno + objeção ("agora não", "tenho plano", "não tenho condição", "vou ver")         → NÃO fecha: para a régua,
 *       leva para EM ESPERA e põe «Retomar em» daqui a 30 dias (se a conta tem o campo);
 *   pedido para parar de receber ("não me perturbe", "pare de mandar", "não quero receber")      → fecha E põe a etiqueta de
 *       não contatar que a conta já usa (qualquer temperatura);
 *   óbito / assunto sensível       → não fecha, tarefa para a equipe (qualquer temperatura).
 *
 * Aqui: o que o paciente disse (puro) e o que fazer com o cartão. A decisão em si mora em `trava-perda.ts`.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { invalidarEtapa } from '../services/lead-stage.service.js';
import { logger } from './logger.js';
import type { EsquemaKommo } from './kommo-schema.js';
import { ETAPA } from './franquia-move.js';
import { CAMPO } from './parados.js';
import { pediuParaSair } from './campanha/metricas.js';

export type ClasseDaFala = 'obito' | 'parar-contato' | 'recusa' | 'objecao' | 'indefinida';

/** Em quanto tempo a retomada é marcada quando a Sofia não fecha (decisão do João). */
export const RETOMAR_EM_DIAS = 30;

function simplificar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Falecimento: nunca é recusa — é para a equipe tratar. Só com contexto: «faleceu», «morreu», «óbito», «falecimento» ou
 * «estou de luto». «Luto» solto é o verbo lutar ("eu luto com essa dor"), e "dor de morte" também não conta.
 */
const OBITO = [/\b(faleceu|faleceram|falecimento|morreu|obito)\b/, /\b(estou|esta|estamos|ficou|ficamos|to)\s+de\s+luto\b/];

/**
 * Pedido para parar de receber mensagem: além de fechar, etiqueta de não contatar. Estreito de propósito, porque ele passa na
 * frente da trava (fecha Quente/Morno e põe NO_FOLLOW_UP): só «para/pare/parem de …», «não me mande(m)/ligue… mais»,
 * «não me perturbe/incomode mais» e «não quero receber / não quero mais saber». "Me passa o pix para enviar o comprovante",
 * "pode pedir para me ligarem amanhã", "qual o número para ligar" e "vcs não me mandaram nada ainda" NÃO são pedido de parar.
 */
const PARAR_CONTATO = [
  /\b(pare|parem|para|parar|pode\s+parar)\s+de\s+(me\s+)?(mandar|enviar|ligar|chamar|perturbar|incomodar|insistir|escrever)\b/,
  /\bnao\s+me\s+(mande|mandem|envie|enviem|ligue|liguem|chame|chamem|procure|procurem|escreva|escrevam)\s+mais\b/,
  /\bnao\s+me\s+(perturbe|perturbem|incomode|incomodem)(\s+mais)?\b/,
  /\bnao\s+quero\s+(mais\s+)?receber\b/,
  /\bnao\s+quero\s+mais\s+saber\b/,
];

/**
 * Recusa FORTE: decisão tomada que vale mesmo com preço ou convênio na frase ("já estou sendo atendida pelo plano em outro
 * lugar" fala de plano e é decisão). "Já fiz/marquei" só conta quando é com OUTRO (médico, clínica, convênio…): "já fiz o pix" e
 * "já marquei com vocês" não são recusa, e pergunta ("já fiz fisio e não resolveu, vocês aceitam unimed?") também não.
 */
const RECUSA_FORTE = [
  /\bpode\s+(encerrar|cancelar|fechar|arquivar)\b/,
  /\bja\s+(resolvi|resolveu|resolvemos)\b/,
  /\bja\s+(estou|to)\s+(sendo\s+)?(atendid|resolvend|me\s+trat|trat)/,
  /\b(vou|irei|fui|vamos)\s+(em|num|numa|no|na|procurar|buscar|tentar)\s+(outr|lugar|clinica|medic)/,
  /\bvou\s+(procurar|tentar)\s+(outr|lugar)/,
  /\bachei\s+(um|uma|outr|fisio|medic|clinica|lugar)/,
  /\bnao\s+(tenho|tem|tenho\s+mais|tem\s+mais)\s+interesse\b/,
  /\bvou\s+deixar\s+(minha\s+)?vaga\b/,
  /\bnumero\s+errado\b/,
];

/** «já agendei/marquei/fiz/fui/passei … com OUTRO», sem pergunta e sem falar de vocês. */
function jaFezComOutro(t: string): boolean {
  if (t.includes('?') || /\b(voces|vcs|voce|aqui|ai)\b/.test(t)) return false;
  return /\bja\s+(agendei|marquei|fiz|fui|passei|consegui|me\s+consultei)\s+(\w+\s+){0,2}(outr\w*|medic\w*|ortoclinica|orto\w*|clinica|hospital|posto|plano|convenio|fisio\w*|neuro\w*)/.test(t);
}

/**
 * Recusa FRACA: parece decisão, mas com adiamento ou preço na mesma frase ("não quero fazer agora, está caro", "não, obrigado,
 * quem sabe depois") é objeção — por isso só vale quando NÃO há marca de objeção.
 */
const RECUSA_FRACA = [
  /\bnao\s+quero\s+(mais\s+)?(marcar|fazer|agendar|o\s+tratamento|a\s+consulta|continuar|nada)\b/,
  /\bnao\s+quero(\s+mais)?[\s.!,]*$/,
  /\bnao\s+vou\s+(marcar|fazer|agendar|mais)\b/,
  /\bnao\s+vou\s*[.…!]*\s*(melhor\s+assim|obrigad)/,
  /\bnao\s+estou\s+precisando\b/,
  /\bnao\s+tem\s+como\s+(eu\s+)?(ir|vir)\b/,
  /^nao[\s,.!]*(obrigad[oa])?[\s.!]*$/,
  /^nao[\s,.!]+obrigad[oa]\b/,
  /^nao\s+mais[\s.!]*$/,
  /\bnao\s+vou\s+(querer\s+mais|mais)\b/,
];

/** Objeção ou adiamento: preço, convênio, "agora não", "vou ver". Não é decisão: a Sofia não fecha Quente/Morno com isso. */
const OBJECAO = [
  /\bno\s+momento\b/,
  /\bagora\b/,
  /\bpor\s+enquanto\b/,
  /\bdeixa\s+pra\s+la\b/,
  /\bvou\s+(ver|pensar|deixar|esperar|avaliar|conversar)\b/,
  /\bvou\s+ver\s+com\b/,
  /\bnao\s+(tenho|tem)\s+(condic|dinheiro|como\s+pagar|grana)/,
  /\bnao\s+da\s+pra\s+mim\b/,
  /\b(plano|convenio|unimed|hapvida|particular|caro|cara|valor|preco|apertad|financeir|sem\s+dinheiro)\w*/,
  /\b(mais\s+)?tarde\b|\bdepois\b|\bmes\s+que\s+vem\b|\bquem\s+sabe\b|\btalvez\b/,
];

/**
 * Pergunta de confirmação que a Sofia faz ("Posso encerrar?") e o paciente responde só com "sim/pode/isso". A resposta sozinha
 * não decide nada: vale o que ele disse ANTES.
 */
const CONFIRMACAO = /^(sim|isso|pode(\s+sim)?|ok|certo|confirmo|claro|com\s+certeza|por\s+favor|isso\s+mesmo|tenho\s+certeza)[\s.!]*$/;

/**
 * A fala do paciente (as mensagens dele, na ordem). Precedência: óbito > parar de receber > recusa forte > objeção > recusa fraca
 * > indefinida. Da mensagem mais nova para a mais antiga: a última que decide manda, e "sim" solto passa direto.
 */
export function classificarFala(textos: ReadonlyArray<string | null | undefined>): ClasseDaFala {
  const itens = textos.map((t) => simplificar(String(t ?? ''))).filter(Boolean);
  if (itens.length === 0) return 'indefinida';
  const junto = itens.join(' . ');
  if (OBITO.some((r) => r.test(junto))) return 'obito';
  if (textos.some((t) => pediuParaSair(String(t ?? ''))) || PARAR_CONTATO.some((r) => r.test(junto))) return 'parar-contato';
  for (let i = itens.length - 1; i >= 0; i--) {
    const t = itens[i];
    if (CONFIRMACAO.test(t)) continue;
    if (RECUSA_FORTE.some((r) => r.test(t)) || jaFezComOutro(t)) return 'recusa';
    if (OBJECAO.some((r) => r.test(t))) return 'objecao';
    if (RECUSA_FRACA.some((r) => r.test(t))) return 'recusa';
  }
  return 'indefinida';
}

/**
 * As mensagens do paciente que decidem: as dele desde a última resposta nossa (no máximo 5), da mais antiga para a mais nova. Se
 * esse último turno é só uma confirmação ("sim" a um "Posso encerrar?"), junta o turno anterior dele — o "não quero mais" que
 * veio antes da pergunta.
 */
export function falasDoUltimoTurno(msgs: ReadonlyArray<{ role: string; content: string }>): string[] {
  const ultimaDeGente = [...msgs].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
  if (!ultimaDeGente || ultimaDeGente.role === 'assistant') return []; // a última palavra é nossa: ainda não há fala nova do paciente
  const turnos: string[][] = [];
  let atual: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && turnos.length < 3; i--) {
    const m = msgs[i];
    if (m.role === 'assistant') {
      if (atual.length > 0) turnos.push(atual);
      atual = [];
      continue;
    }
    if (m.role === 'user' && m.content?.trim()) atual.unshift(m.content);
  }
  if (atual.length > 0 && turnos.length < 3) turnos.push(atual);
  // turnos[0] = o mais recente
  const ultimo = (turnos[0] ?? []).slice(-5);
  const soConfirma = ultimo.length > 0 && ultimo.every((t) => CONFIRMACAO.test(simplificar(t)));
  return soConfirma && turnos[1] ? [...turnos[1].slice(-5), ...ultimo] : ultimo;
}

// ── a etiqueta de não contatar que a conta já usa ──

/**
 * Em ordem de preferência. `NO_FOLLOW_UP` é a que os gatilhos de PERDIDO leem (existe em 18 das 20 contas medidas em 26/10: faltam só Rio Verde e o laboratório); Rio Verde
 * não a tem e usa `NAO_PERTURBAR`; `Fluxo · Opt-out WhatsApp` é o último recurso.
 */
export const ETIQUETAS_DE_NAO_CONTATAR = ['NO_FOLLOW_UP', 'NAO_PERTURBAR', 'Fluxo · Opt-out WhatsApp'] as const;
const cacheDaEtiqueta = new Map<string, { em: number; nome: string }>();
const CACHE_ETIQUETA_MS = 60 * 60_000;

export async function etiquetaDeNaoContatar(unit: Pick<Unit, 'id'>, kommo: Pick<KommoClient, 'listLeadTags'>): Promise<string> {
  const hit = cacheDaEtiqueta.get(unit.id);
  if (hit && Date.now() - hit.em < CACHE_ETIQUETA_MS) return hit.nome;
  let nome: string = ETIQUETAS_DE_NAO_CONTATAR[0];
  try {
    const existentes = new Set((await kommo.listLeadTags(25)).map((t) => t.name));
    nome = ETIQUETAS_DE_NAO_CONTATAR.find((n) => existentes.has(n)) ?? nome;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.id }, 'sofia-fecha: não li as etiquetas da conta — usei NO_FOLLOW_UP');
  }
  cacheDaEtiqueta.set(unit.id, { em: Date.now(), nome });
  return nome;
}

/** Põe a etiqueta ANTES de fechar (os gatilhos de PERDIDO leem a condição no evento). Falha não impede o fechamento: vai para o log. */
export async function etiquetarNaoContatar(unit: Pick<Unit, 'id' | 'slug'>, kommo: Pick<KommoClient, 'listLeadTags' | 'addTag'>, leadId: number): Promise<string | null> {
  try {
    const nome = await etiquetaDeNaoContatar(unit, kommo);
    await kommo.addTag({ leadId, tags: [nome] });
    logger.info({ unit: unit.slug, leadId, etiqueta: nome }, 'sofia-fecha: o paciente pediu para parar — etiqueta de não contatar aplicada');
    return nome;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'sofia-fecha: não consegui pôr a etiqueta de não contatar');
    return null;
  }
}

// ── não fecha: EM ESPERA com «Retomar em» ──

export interface ResultadoDaEspera {
  /** o cartão está (ou já estava) em EM ESPERA */
  naEspera: boolean;
  /** «Retomar em» gravado (a conta tem o campo) */
  retomada: boolean;
}

/**
 * Para a régua sem fechar: EM ESPERA (só se o cartão está no COMERCIAL e a conta tem a etapa) e «Retomar em» daqui a 30 dias
 * (se a conta tem o campo). Grava os campos ANTES de mover, como o worker de parados. Cada passo falha sozinho (log), e o
 * resultado diz o que de fato aconteceu — quem chama só fala o que foi feito.
 */
export async function levarParaEsperaComRetomada(args: {
  unit: Pick<Unit, 'id' | 'slug'>;
  kommo: Pick<KommoClient, 'moveStage' | 'setLeadCustomFieldValue'>;
  funis: { comercialId: number; idDe: (funil: 'COMERCIAL' | 'TRATAMENTO', etapa: string) => { pipelineId: number; statusId: number } | null };
  esquema: Pick<EsquemaKommo, 'campoPorNome'>;
  cartao: Pick<KommoLead, 'id' | 'pipeline_id' | 'status_id'>;
  agoraEpoch: number;
}): Promise<ResultadoDaEspera> {
  const { unit, kommo, funis, esquema, cartao, agoraEpoch } = args;
  const out: ResultadoDaEspera = { naEspera: false, retomada: false };
  const espera = funis.idDe('COMERCIAL', ETAPA.ESPERA);
  if (!espera || cartao.pipeline_id !== funis.comercialId) return out;
  const jaEsta = cartao.status_id === espera.statusId;
  const campoRetomar = esquema.campoPorNome(CAMPO.RETOMAR_EM);
  if (campoRetomar !== null) {
    try {
      await kommo.setLeadCustomFieldValue(cartao.id, campoRetomar, 'date', new Date((agoraEpoch + RETOMAR_EM_DIAS * 86_400) * 1000).toISOString());
      out.retomada = true;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: cartao.id }, 'sofia-fecha: não consegui gravar «Retomar em»');
    }
  }
  const campoMotivo = esquema.campoPorNome(CAMPO.MOTIVO_ESPERA);
  if (campoMotivo !== null && !jaEsta) {
    try {
      await kommo.setLeadCustomFieldValue(cartao.id, campoMotivo, 'select', 'Outro');
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: cartao.id }, 'sofia-fecha: não consegui gravar o «Motivo da espera»');
    }
  }
  if (jaEsta) {
    out.naEspera = true;
    return out;
  }
  try {
    await kommo.moveStage({ leadId: cartao.id, statusId: espera.statusId, pipelineId: espera.pipelineId });
    invalidarEtapa(unit.id, cartao.id);
    out.naEspera = true;
    logger.info({ unit: unit.slug, leadId: cartao.id, retomada: out.retomada }, 'sofia-fecha: Quente/Morno sem recusa explícita — não fechei, levei para EM ESPERA');
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: cartao.id }, 'sofia-fecha: não consegui levar o cartão para EM ESPERA');
  }
  return out;
}

