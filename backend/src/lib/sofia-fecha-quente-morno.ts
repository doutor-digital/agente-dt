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

/** Falecimento: nunca é recusa — é para a equipe tratar. (Só o óbito; "dor de morte" não conta.) */
const OBITO = [/\b(faleceu|falecimento|faleceram|morreu|obito|velorio|enterro|luto)\b/];

/** Pedido para parar de receber mensagem: além de fechar, etiqueta de não contatar. */
const PARAR_CONTATO = [
  /\bnao\s+(me\s+)?(perturb|incomod)\w*/,
  /\b(pare|para|parar|pode\s+parar)\s+(de\s+)?(me\s+)?(mand|envi|lig|cham|perturb|incomod)\w*/,
  /\bnao\s+(me\s+)?(mand|envi|lig|cham)\w*\s*(mais|nada)\b/,
  /\bnao\s+quero\s+(mais\s+)?(receber|saber|contato|mensagem)/,
  /\bnao\s+(me\s+)?procur\w*\s+mais\b/,
];

/**
 * Recusa explícita: o paciente decidiu (não quero, já resolvi, foi para outro, pode encerrar). Vem ANTES da objeção: "já estou
 * sendo atendida pelo plano em outro lugar" fala de plano e mesmo assim é uma decisão tomada.
 */
const RECUSA = [
  /\bpode\s+(encerrar|cancelar|fechar|arquivar)\b/,
  /\bja\s+(resolvi|resolveu|resolvemos|fiz|fui|agendei|marquei|passei|consegui|estou\s+(sendo\s+)?(atendid|resolvend|me\s+trat|trat)|to\s+(sendo\s+)?atendid)/,
  /\bja\s+estou\s+resolvend/,
  /\b(vou|irei|fui|vamos)\s+(em|num|numa|no|na|procurar|buscar|tentar)\s+(outr|lugar|clinica|medic)/,
  /\bvou\s+(procurar|tentar)\s+(outr|lugar)/,
  /\bachei\s+(um|uma|outr|fisio|medic|clinica|lugar)/,
  /\bnao\s+(tenho|tem|tenho\s+mais|tem\s+mais)\s+interesse\b/,
  /\bnao\s+quero\s+(mais\s+)?(marcar|fazer|agendar|o\s+tratamento|a\s+consulta|continuar|nada)\b/,
  /\bnao\s+quero(\s+mais)?[\s.!,]*$/,
  /\bnao\s+vou\s+(marcar|fazer|agendar|mais)\b/,
  /\bnao\s+vou\s*[.…!]*\s*(melhor\s+assim|obrigad)/,
  /\bvou\s+deixar\s+(minha\s+)?vaga\b/,
  /\bnao\s+estou\s+precisando\b/,
  /\bnao\s+tem\s+como\s+(eu\s+)?(ir|vir)\b/,
  /\bnumero\s+errado\b/,
  /^nao[\s,.!]*(obrigad[oa])?[\s.!]*$/,
  /^nao[\s,.!]+obrigad[oa]\b/,
  /^nao\s+mais[\s.!]*$/,
  /\bnao\s+vou\s+(querer\s+mais|mais)\b/,
];

/** Objeção ou adiamento: preço, convênio, "agora não", "vou ver". Não é decisão: a Sofia não fecha Quente/Morno com isso. */
const OBJECAO = [
  /\bno\s+momento\b/,
  /\bagora\s+nao\b/,
  /\bpor\s+enquanto\b/,
  /\bdeixa\s+pra\s+la\b/,
  /\bvou\s+(ver|pensar|deixar|esperar|avaliar|conversar)\b/,
  /\bnao\s+(tenho|tem)\s+(condic|dinheiro|como\s+pagar|grana)/,
  /\bnao\s+da\s+pra\s+mim\b/,
  /\b(plano|convenio|unimed|hapvida|particular|caro|valor|preco|apertad|financeir)\w*/,
  /\b(mais\s+)?tarde\b|\bdepois\b|\bmes\s+que\s+vem\b/,
];

/**
 * A fala do paciente (as mensagens dele desde a última resposta nossa, na ordem). Vale a ordem de precedência:
 * óbito > parar de receber > recusa explícita > objeção > indefinida.
 */
export function classificarFala(textos: ReadonlyArray<string | null | undefined>): ClasseDaFala {
  const itens = textos.map((t) => simplificar(String(t ?? ''))).filter(Boolean);
  if (itens.length === 0) return 'indefinida';
  const junto = itens.join(' . ');
  if (OBITO.some((r) => r.test(junto))) return 'obito';
  if (textos.some((t) => pediuParaSair(String(t ?? ''))) || PARAR_CONTATO.some((r) => r.test(junto))) return 'parar-contato';
  // a recusa vale pela ÚLTIMA fala que decide; objeção dita antes e recusa depois ("tenho plano… então não quero mais") é recusa
  for (let i = itens.length - 1; i >= 0; i--) {
    if (RECUSA.some((r) => r.test(itens[i]))) return 'recusa';
    if (OBJECAO.some((r) => r.test(itens[i]))) return 'objecao';
  }
  return 'indefinida';
}

/** As mensagens do paciente desde a última resposta nossa (no máximo 5), da mais antiga para a mais nova. */
export function falasDoUltimoTurno(msgs: ReadonlyArray<{ role: string; content: string }>): string[] {
  const out: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && out.length < 5; i--) {
    const m = msgs[i];
    if (m.role === 'assistant') break;
    if (m.role === 'user' && m.content?.trim()) out.unshift(m.content);
  }
  return out;
}

// ── a etiqueta de não contatar que a conta já usa ──

/**
 * Em ordem de preferência. `NO_FOLLOW_UP` é a que os gatilhos de PERDIDO leem (existe em 17 das 19 contas medidas em 26/10); Rio Verde
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

