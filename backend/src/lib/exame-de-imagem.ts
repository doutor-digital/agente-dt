/**
 * Exame de imagem que o paciente manda no chat (pedido da dona de Timbó, 10/11/2026; decisão do João, 11/11/2026).
 *
 * Paciente manda foto ou PDF de ressonância, tomografia, raio-X, ultrassom ou o laudo de um desses → a Sofia diz que
 * vai passar o exame ao especialista, a IA PAUSA naquele cartão e a equipe é avisada. Não é sinal de alerta: sem
 * 🔴 PRIORIDADE e sem LIGAR AGORA.
 *
 * Automação `exame-de-imagem-pausa-alerta` (EXAME_DE_IMAGEM_SLUGS), nasce desligada. Desligada, NADA muda — nem o
 * prompt da visão, que só ganha a linha do "EXAME DE IMAGEM:" quando a chave está ligada para a unidade.
 *
 * Comprovante Pix tem prioridade: a visão marca "COMPROVANTE:" e o fluxo do comprovante segue como sempre. Foto do
 * corpo, print, figurinha: seguem como hoje.
 *
 * Como funciona (webhook.controller.ts):
 *  1. o aviso sai em código ANTES das travas (fora do horário ou com o cartão já pausado o modelo nem roda);
 *  2. a mensagem do modelo leva INSTRUCAO_DO_EXAME (pausar_ia + uma frase);
 *  3. no fim do turno, por QUALQUER caminho (resposta, fora do horário, etapa calada), `garantirPausaDoExame` confere a
 *     caixinha "Pausar IA" e marca se o modelo não marcou ou nem rodou. A pausa não fica na mão do modelo.
 *
 * Aviso: tarefa `ALERTA · <slug> ·` no cartão, que o roteador de alertas (n8n) leva ao grupo das SDRs da unidade. Se a
 * unidade tiver um grupo PRÓPRIO para exames, a mensagem vai direto para ele pela Evolution e a tarefa sai sem o
 * prefixo (para não chegar duas vezes):
 *  - EXAME_DE_IMAGEM_GRUPOS: JSON {"<slug>": "<id do grupo>@g.us"}.
 *  - EXAME_DE_IMAGEM_EVOLUTION_URL: …/message/sendText/<instância que envia>.
 *  - EXAME_DE_IMAGEM_EVOLUTION_HEADER / _VALUE: o cabeçalho da chave da Evolution (padrão: os do EVOLUTION_ALERT_*).
 */
import type { Unit } from '@prisma/client';
import { automacaoLigada } from './automacoes-estado.js';
import { enviarPelaEvolution } from './alerta-whatsapp.js';
import { logger } from './logger.js';

export * from './exame-de-imagem-texto.js';

export const ID_DA_AUTOMACAO = 'exame-de-imagem-pausa-alerta';

/** Um aviso por cartão nesta janela: cobre a rajada (a mesma ressonância em 5 fotos) sem calar um exame novo horas depois. */
export const JANELA_DO_AVISO_MS = 30 * 60 * 1000;

export function exameDeImagemLigado(unit: Pick<Unit, 'slug'>): boolean {
  return automacaoLigada(unit.slug, ID_DA_AUTOMACAO, process.env.EXAME_DE_IMAGEM_SLUGS);
}

export function linkDoCartao(unit: Pick<Unit, 'kommoSubdomain'>, leadId: number): string | null {
  const sub = unit.kommoSubdomain?.trim();
  return sub ? `https://${sub}.kommo.com/leads/detail/${leadId}` : null;
}

export function grupoDoExame(slug: string, raw: string | undefined = process.env.EXAME_DE_IMAGEM_GRUPOS): string | null {
  if (!raw?.trim()) return null;
  try {
    const mapa = JSON.parse(raw.trim().replace(/^'|'$/g, '')) as Record<string, unknown>;
    const g = mapa?.[slug];
    return typeof g === 'string' && g.trim() ? g.trim() : null;
  } catch {
    logger.warn('exame-de-imagem: EXAME_DE_IMAGEM_GRUPOS não é JSON válido — sem grupo próprio');
    return null;
  }
}

/** Manda no grupo próprio do exame. true = mandou; false = sem config ou falhou (já logado). Nunca lança. */
export async function mandarNoGrupo(grupo: string, texto: string, deps: Parameters<typeof enviarPelaEvolution>[1] = {}): Promise<boolean> {
  const url = process.env.EXAME_DE_IMAGEM_EVOLUTION_URL;
  const header = process.env.EXAME_DE_IMAGEM_EVOLUTION_HEADER || process.env.EVOLUTION_ALERT_HEADER;
  const valor = process.env.EXAME_DE_IMAGEM_EVOLUTION_VALUE || process.env.EVOLUTION_ALERT_VALUE;
  if (!url || !header || !valor) {
    logger.warn('exame-de-imagem: sem EXAME_DE_IMAGEM_EVOLUTION_URL/HEADER/VALUE — o grupo próprio não recebe');
    return false;
  }
  return enviarPelaEvolution({ url, header, valor, numero: grupo, texto }, deps);
}

// ── Pausa garantida no fim do turno ──────────────────────────────────────────────────────────────────────────────

const exameNoTurno = new Set<string>();
const chaveDoTurno = (unitId: string, leadId: number) => `${unitId}:${leadId}`;

/** O turno deste cartão trouxe exame de imagem: no fim dele a pausa é conferida (`garantirPausaDoExame`). */
export function marcarExameNoTurno(unitId: string, leadId: number): void {
  exameNoTurno.add(chaveDoTurno(unitId, leadId));
}

/** Tira a marca e diz se havia. */
export function tirarExameDoTurno(unitId: string, leadId: number): boolean {
  return exameNoTurno.delete(chaveDoTurno(unitId, leadId));
}

export interface DepsDaPausa {
  caixinhaMarcada: (leadId: number, campo: number) => Promise<boolean>;
  marcarCaixinha: (leadId: number, campo: number) => Promise<void>;
}

/**
 * Marca "Pausar IA" no cartão se ainda não está marcada (o modelo não chamou pausar_ia, ou o turno nem chegou ao modelo).
 * Na dúvida (não deu para ler a caixinha), marca: com exame na mão, silêncio da IA é o lado seguro. Nunca lança.
 */
export async function garantirPausaDoExame(
  unit: Pick<Unit, 'slug' | 'kommoPausedFieldId'>,
  leadId: number,
  deps: DepsDaPausa,
): Promise<'ja_pausada' | 'pausou' | 'sem_campo' | 'falhou'> {
  const campo = unit.kommoPausedFieldId;
  if (!campo) {
    logger.error({ unit: unit.slug, leadId }, 'exame-de-imagem: unidade sem kommoPausedFieldId — a IA não foi pausada pelo código');
    return 'sem_campo';
  }
  const marcada = await deps.caixinhaMarcada(leadId, campo).catch(() => false);
  if (marcada) return 'ja_pausada';
  try {
    await deps.marcarCaixinha(leadId, campo);
    logger.info({ unit: unit.slug, leadId }, 'exame-de-imagem: IA pausada pelo código (o modelo não pausou ou não rodou)');
    return 'pausou';
  } catch (err) {
    logger.error({ err: String(err), unit: unit.slug, leadId }, 'exame-de-imagem: não consegui pausar a IA');
    return 'falhou';
  }
}
