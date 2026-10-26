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
import { fusoDaUnidade } from './fuso.js';
import { prisma } from './prisma.js';
import { agoraLocalISO } from '../agent/consulta-que-passou.js';
import { epochSeg } from './etiquetas-auto.js';
import { semAcento } from './sem-acento.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';

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
export function quandoLocal(epochS: number, tz: string): string {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(epochS * 1000),
  );
  // "26/10, 14:00" → "26/10 às 14:00"
  return p.replace(/,?\s+/, ' às ');
}

/** O id no catálogo (automacoes.ts) e a variável de ambiente que ainda manda quando a tela nunca falou nada. */
export const ID_AUTOMACAO = 'desistencia-cancela';

/**
 * A ação nova (tarefas CANCELAR/CONFERIR, marca que para a véspera e a régua, NO_FOLLOW_UP, tarefa de silêncio) é uma AUTOMAÇÃO por
 * unidade que NASCE EM "SÓ NO PAPEL" (regra da casa: uma unidade por vez, seco primeiro): em seco ela decide, lê e REGISTRA
 * "abriria tarefa / pararia a véspera / poria NO_FOLLOW_UP" na tela de Automações, sem gravar nada. A oferta de remarcar pela
 * Sofia (prompt) não depende disto.
 */
export function estadoDaDesistencia(slug: string, raw: string | undefined = process.env.DESISTENCIA_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_AUTOMACAO, raw);
}

/** "AAAA-MM-DDTHH:mm" → "dd/mm às HH:mm". */
export const quandoDoVinculo = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)} às ${iso.slice(11, 16)}`;

/** A consulta por vir no vínculo da franquia ("AAAA-MM-DDTHH:mm" local), ou null. */
export async function consultaDoVinculoPadrao(unitId: string, leadId: number): Promise<string | null> {
  const l = await prisma.spineLeadLink.findFirst({ where: { unitId, kommoLeadId: leadId, spineIdSchedule: { not: null } }, select: { agendadoPara: true } });
  return l?.agendadoPara ?? null;
}

export interface ConsultaPorVir {
  /** "dd/mm às HH:mm", para a tarefa. */
  label: string;
  /** "AAAA-MM-DDTHH:mm" local da clínica — a identidade da consulta (a marca de recusa/oferta é desta consulta; se remarcar, é outra). */
  iso: string;
}

/**
 * A consulta ainda por vir — do cartão (◷ Data da Consulta) e, se o cartão não tem, do vínculo da franquia —, com a MESMA folga
 * de 3 h nos dois (hora local dos dois lados). null = não achei consulta por vir.
 */
export async function quandoDaConsultaPorVir(args: {
  unit: Pick<Unit, 'id' | 'spineTimezone' | 'businessHoursTimezone'>;
  leadId: number;
  lead: Pick<KommoLead, 'custom_fields_values'> | null | undefined;
  agora: Date;
  consultaDoVinculo?: (unitId: string, leadId: number) => Promise<string | null>;
}): Promise<ConsultaPorVir | null> {
  const tz = fusoDaUnidade(args.unit);
  const epoch = consultaFuturaDoCartao(args.lead, Math.floor(args.agora.getTime() / 1000));
  if (epoch) return { label: quandoLocal(epoch, tz), iso: agoraLocalISO(tz, new Date(epoch * 1000)).slice(0, 16) };
  const v = await (args.consultaDoVinculo ?? consultaDoVinculoPadrao)(args.unit.id, args.leadId).catch(() => null);
  if (v && v.slice(0, 16) >= agoraLocalISO(tz, new Date(args.agora.getTime() - 3 * 3600_000)).slice(0, 16)) return { label: quandoDoVinculo(v), iso: v.slice(0, 16) };
  return null;
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
