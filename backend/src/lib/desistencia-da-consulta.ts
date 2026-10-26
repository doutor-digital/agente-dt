/**
 * "Cancelei", "desmarquei", "não vou": o paciente desistiu da consulta que tinha.
 *
 * Item 6 da lista da Suzanne (25/10/2026), decisão do João em 26/10:
 *  1. os lembretes param;
 *  2. a Sofia TENTA REMARCAR (acolhe em uma frase, oferece novo horário — bloco em `agent/paciente-desistiu.ts`);
 *     se ele recusar ou não responder, encerra com educação, para a régua e abre tarefa para a equipe.
 *
 * O que aconteceu nos casos de Araguaína (medido em 26/10, eventos do Kommo + banco):
 *  - #28861610: consulta de 23/10 14:00 só no cartão (nunca foi para a franquia: 0 linha em `spine_lead_links`).
 *    "Cancelei." às 14:03 de 22/10, em cima do lembrete de 24 h; a IA estava pausada, então ninguém respondeu. O cartão
 *    ficou em AGENDADO e os robôs de 3 h e de 1 h antes mandaram às 11:00 e 13:01 de 23/10.
 *  - #28858170: "pode desmarcar" em 24/10 11:17; cartão em AGENDADO; os dois robôs de 24 h mandaram às 14:00 de 25/10.
 * O robô do Kommo não lê conversa. Quem tem de agir é a equipe — e a única coisa que o servidor sabia era uma NOTA no
 * cartão ("o paciente continuou escrevendo com a IA pausada"), que ninguém lê. Aqui vira TAREFA com o prefixo ALERTA,
 * que também chega no WhatsApp do grupo.
 *
 * O detector é ESTREITO de propósito (frases reais lidas antes do regex, 45 dias de mensagens): "cancelamento de
 * contrato" e "solicitação de cancelamento" são conversa de tratamento, e "não irei pagar a mais" não é "não vou ir".
 */
import type { Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import { avisoRecente, marcarAviso, JANELA_24H_MS } from './aviso-dedupe.js';
import { logger } from './logger.js';
import { fusoDaUnidade } from './fuso.js';
import { epochSeg } from './etiquetas-auto.js';
import { semAcento } from './sem-acento.js';
import { primeiroNomeDoPaciente } from './ponte-respostas.js';

import { pareceDesistenciaDaConsulta } from './desistencia-frases.js';

const CAMPO_DATA_DA_CONSULTA = 'datadaconsulta';

/** Data da consulta no cartão (epoch s) quando ainda não passou — ou null. Por NOME do campo: cada conta tem os seus ids. */
export function consultaFuturaDoCartao(lead: Pick<KommoLead, 'custom_fields_values'> | null | undefined, agoraS: number): number | null {
  for (const f of lead?.custom_fields_values ?? []) {
    const nome = semAcento(f.field_name ?? '').replace(/[^a-z0-9]/g, '');
    if (nome !== CAMPO_DATA_DA_CONSULTA) continue;
    const n = epochSeg(f.values?.[0]?.value);
    // Uma folga de 3 h: o paciente que escreve "não vou" no meio da tarde de uma consulta das 14 h ainda é desistência.
    if (n !== null && n >= agoraS - 3 * 3600) return n;
  }
  return null;
}

/** "AAAA-MM-DDTHH:mm" local da clínica → "dd/mm às HH:mm". */
function quandoLocal(epochS: number, tz: string): string {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(epochS * 1000),
  );
  // "26/10, 14:00" → "26/10 às 14:00"
  return p.replace(/,?\s+/, ' às ');
}

export type MotivoDaTarefa = 'ia_calada' | 'sem_resposta';

export function textoTarefaDesistenciaSemIA(args: {
  slug: string;
  nome: string | null | undefined;
  quando: string;
  mensagem: string;
  motivo?: MotivoDaTarefa;
}): string {
  const trecho = args.mensagem.replace(/\s+/g, ' ').trim().slice(0, 140);
  const porque =
    args.motivo === 'sem_resposta'
      ? 'A Sofia ofereceu outro horário e ele não respondeu (se a equipe já resolveu por telefone, é só fechar esta tarefa).'
      : 'A Sofia está calada nesta conversa (IA pausada, fora do horário, etapa sem IA ou a equipe falou) — ninguém ofereceu novo horário.';
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome || 'paciente'}] Escreveu que não vem: "${trecho}". ` +
    `A consulta de ${args.quando} segue no cartão. ${porque} ` +
    'Combine outro horário com o paciente OU, se ele não quer mais, cancele na franquia, ponha ✓ Situação da consulta = Desmarcado e tire o cartão de AGENDADO. ' +
    'Enquanto estiver em AGENDADO com a data da consulta, os lembretes automáticos do Kommo continuam saindo para ele.'
  );
}

export type ResultadoDaDesistencia = 'nao_e' | 'sem_consulta' | 'ja_avisada' | 'tarefa_aberta' | 'falhou';

export interface DepsDaDesistencia {
  agora: () => Date;
  avisoRecente: typeof avisoRecente;
  marcarAviso: typeof marcarAviso;
}

const DEPS_PADRAO: DepsDaDesistencia = { agora: () => new Date(), avisoRecente, marcarAviso };

/** Mesmo paciente, duas mensagens em segundos (ou o Kommo reenviando o webhook): só uma passa. Confere-e-grava sem await no meio. */
const emAndamento = new Set<string>();

export interface KommoDaDesistencia {
  getLead(id: number): Promise<KommoLead | null>;
  createTask(a: { leadId: number; text: string; completeAt: number }): Promise<{ id?: number } | null>;
}

/**
 * O paciente escreveu que não vem e a Sofia NÃO vai oferecer horário novo — ou porque está calada (`ia_calada`: IA
 * pausada, fora do horário, etapa sem IA, a equipe falou), ou porque ofereceu e ele não respondeu (`sem_resposta`):
 * a equipe resolve, e precisa saber por TAREFA, não por nota. Só quando o cartão tem consulta ainda por vir (sem
 * consulta, "cancelei" pode ser o plano de saúde). Uma tarefa por motivo a cada 24 h (a trava de 21/09 contra tarefa
 * repetida). `kommo` é uma fábrica: um cliente que não nasce (unidade sem credencial) não pode derrubar o webhook.
 * Nunca lança.
 */
export async function abrirTarefaDaDesistencia(
  args: {
    unit: Pick<Unit, 'id' | 'slug' | 'spineTimezone' | 'businessHoursTimezone'>;
    leadId: number;
    texto: string;
    motivo: MotivoDaTarefa;
    nome?: string | null;
    kommo: () => KommoDaDesistencia;
  },
  deps: DepsDaDesistencia = DEPS_PADRAO,
): Promise<ResultadoDaDesistencia> {
  if (!pareceDesistenciaDaConsulta(args.texto)) return 'nao_e';
  const { unit, leadId } = args;
  const trava = `${unit.id}:${leadId}:${args.motivo}`;
  if (emAndamento.has(trava)) return 'ja_avisada';
  emAndamento.add(trava);
  try {
    const agora = deps.agora();
    const chave = `desistencia_tarefa:${args.motivo}`;
    if (await deps.avisoRecente(unit.id, leadId, chave, JANELA_24H_MS, agora)) return 'ja_avisada';
    const kommo = args.kommo();
    const lead = await kommo.getLead(leadId);
    const consulta = consultaFuturaDoCartao(lead, Math.floor(agora.getTime() / 1000));
    if (!consulta) return 'sem_consulta';
    const criada = await kommo.createTask({
      leadId,
      text: textoTarefaDesistenciaSemIA({
        slug: unit.slug,
        nome: primeiroNomeDoPaciente(lead?.name, args.nome ?? null),
        quando: quandoLocal(consulta, fusoDaUnidade(unit)),
        mensagem: args.texto,
        motivo: args.motivo,
      }),
      completeAt: Math.floor(agora.getTime() / 1000) + 60 * 60,
    });
    // marca SÓ depois de o Kommo confirmar: falha de rede não pode calar o aviso por 24 h
    if (!criada) return 'falhou';
    await deps.marcarAviso(unit.id, leadId, chave, agora);
    logger.info({ unit: unit.slug, leadId, consulta, motivo: args.motivo }, 'desistência da consulta: tarefa aberta para a equipe');
    return 'tarefa_aberta';
  } catch (err) {
    logger.warn({ unit: unit.slug, leadId, err: String(err) }, 'desistência da consulta: não consegui abrir a tarefa — segue');
    return 'falhou';
  } finally {
    emAndamento.delete(trava);
  }
}
