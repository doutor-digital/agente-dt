/**
 * O que o SISTEMA faz quando o paciente desiste da consulta e a Sofia está conversando (decisão do coordenador, 26/10/2026,
 * depois da reprovação do sênior no #132): a Sofia NÃO cancela na franquia — cancelar é irreversível e o classificador por
 * frases ainda erra. Ela oferece remarcar e, na recusa explícita, se despede SEM dizer que cancelou. Em código, aqui:
 *
 *  - `oferta`  : a Sofia vai oferecer horário → marca `desistencia_oferta` (o worker avisa a equipe se ele não responder);
 *  - `recusou` : recusa explícita → tarefa URGENTE "CANCELAR NA FRANQUIA" para o responsável do cartão, marca
 *                `recusou_remarcar` (para a NOSSA véspera e a NOSSA régua deste cartão) e etiqueta `NO_FOLLOW_UP`;
 *  - `duvida`  : manter, outra consulta, hesitação → tarefa "conferir com o paciente", SEM parar a véspera.
 *
 * Só com consulta ainda por vir (no cartão ou no vínculo da franquia): sem ela, "cancelei" pode ser o plano de saúde.
 */
import type { Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { avisoRecente, marcarAviso, JANELA_24H_MS } from './aviso-dedupe.js';
import { fusoDaUnidade } from './fuso.js';
import { consultaFuturaDoCartao, quandoLocal } from './desistencia-da-consulta.js';
import { primeiroNomeDoPaciente } from './ponte-respostas.js';

export const MARCA_OFERTA = 'desistencia_oferta';
export const MARCA_RECUSOU = 'recusou_remarcar';
export const ETIQUETA_SEM_FOLLOW_UP = 'NO_FOLLOW_UP';

export function textoTarefaCancelarNaFranquia(a: { slug: string; nome: string | null; quando: string; trecho: string }): string {
  const trecho = a.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    `ALERTA · ${a.slug} · [Contato: ${a.nome || 'paciente'}] URGENTE — CANCELAR NA FRANQUIA — ${a.nome || 'paciente'}, consulta ${a.quando}. ` +
    `Recusou remarcar: "${trecho}". A Sofia se despediu dizendo que a equipe cancela. Cancele na franquia, ponha ✓ Situação da consulta = ` +
    'Desmarcado e tire o cartão de AGENDADO. A nossa véspera e a régua já pararam para este cartão; os lembretes do Kommo continuam até você agir.'
  );
}

export function textoTarefaConferir(a: { slug: string; nome: string | null; quando: string; trecho: string }): string {
  const trecho = a.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    `ALERTA · ${a.slug} · [Contato: ${a.nome || 'paciente'}] CONFERIR COM O PACIENTE — ${a.nome || 'paciente'}, consulta ${a.quando}. ` +
    `Escreveu: "${trecho}" e não ficou claro se ele vem. A Sofia respondeu normal e NÃO cancelou; a véspera segue. Ligue ou escreva ` +
    'para confirmar se a consulta fica ou cai (e, se for de outra pessoa, qual).'
  );
}

export type ResultadoDaAcao = 'nada' | 'marcada' | 'sem_consulta' | 'ja_avisada' | 'tarefa_aberta' | 'falhou';

export interface KommoDaAcao {
  getLead(id: number): Promise<KommoLead | null>;
  createTask(a: { leadId: number; text: string; completeAt: number; responsibleUserId?: number }): Promise<{ id?: number } | null>;
  addTag(a: { leadId: number; tags: string[] }): Promise<void>;
}

export interface DepsDaAcao {
  agora: () => Date;
  avisoRecente: typeof avisoRecente;
  marcarAviso: typeof marcarAviso;
  /** "AAAA-MM-DDTHH:mm" local da consulta ainda por vir no vínculo da franquia, ou null. */
  consultaDoVinculo: (unitId: string, leadId: number, agora: Date) => Promise<string | null>;
}

async function consultaDoVinculoPadrao(unitId: string, leadId: number): Promise<string | null> {
  const l = await prisma.spineLeadLink.findFirst({ where: { unitId, kommoLeadId: leadId, spineIdSchedule: { not: null } }, select: { agendadoPara: true } });
  return l?.agendadoPara ?? null;
}

const DEPS_PADRAO: DepsDaAcao = { agora: () => new Date(), avisoRecente, marcarAviso, consultaDoVinculo: (u, l) => consultaDoVinculoPadrao(u, l) };

const emAndamento = new Set<string>();

/** "AAAA-MM-DDTHH:mm" → "dd/mm às HH:mm". */
const quandoDoVinculo = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)} às ${iso.slice(11, 16)}`;

export async function agirNaDesistencia(
  args: {
    unit: Pick<Unit, 'id' | 'slug' | 'spineTimezone' | 'businessHoursTimezone'>;
    leadId: number;
    acao: 'oferta' | 'recusou' | 'duvida';
    trecho: string;
    kommo: () => KommoDaAcao;
  },
  deps: DepsDaAcao = DEPS_PADRAO,
): Promise<ResultadoDaAcao> {
  const { unit, leadId, acao } = args;
  const trava = `${unit.id}:${leadId}:${acao}`;
  if (emAndamento.has(trava)) return 'ja_avisada';
  emAndamento.add(trava);
  try {
    const agora = deps.agora();
    if (acao === 'oferta') {
      await deps.marcarAviso(unit.id, leadId, MARCA_OFERTA, agora);
      return 'marcada';
    }
    const chaveTarefa = `desistencia_tarefa:${acao === 'recusou' ? 'cancelar' : 'conferir'}`;
    const kommo = args.kommo();
    const lead = await kommo.getLead(leadId).catch(() => null);
    const epoch = consultaFuturaDoCartao(lead, Math.floor(agora.getTime() / 1000));
    const tz = fusoDaUnidade(unit);
    let quando: string | null = epoch ? quandoLocal(epoch, tz) : null;
    if (!quando) {
      const v = await deps.consultaDoVinculo(unit.id, leadId, agora).catch(() => null);
      // do vínculo só conta se ainda não passou (hora local dos dois lados)
      if (v && v.slice(0, 16) > new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(agora).replace(' ', 'T')) quando = quandoDoVinculo(v);
    }
    // cartão legível e sem consulta por vir: "cancelei" pode ser o plano de saúde — não age. Ilegível: não dá para saber.
    if (!quando) return lead ? 'sem_consulta' : 'falhou';

    // a NOSSA véspera e a NOSSA régua param JÁ, antes de qualquer chamada que possa falhar
    if (acao === 'recusou') await deps.marcarAviso(unit.id, leadId, MARCA_RECUSOU, agora);

    if (await deps.avisoRecente(unit.id, leadId, chaveTarefa, JANELA_24H_MS, agora)) return 'ja_avisada';
    const nome = primeiroNomeDoPaciente(lead?.name, null);
    const info = { slug: unit.slug, nome, quando, trecho: args.trecho };
    const criada = await kommo.createTask({
      leadId,
      text: acao === 'recusou' ? textoTarefaCancelarNaFranquia(info) : textoTarefaConferir(info),
      completeAt: Math.floor(agora.getTime() / 1000) + (acao === 'recusou' ? 30 * 60 : 2 * 3600),
      ...(lead?.responsible_user_id ? { responsibleUserId: lead.responsible_user_id } : {}),
    });
    if (!criada) return 'falhou';
    await deps.marcarAviso(unit.id, leadId, chaveTarefa, agora);
    if (acao === 'recusou') {
      await kommo.addTag({ leadId, tags: [ETIQUETA_SEM_FOLLOW_UP] }).catch((err) => logger.warn({ err: String(err), leadId }, 'desistência: não pus NO_FOLLOW_UP (segue)'));
    }
    logger.info({ unit: unit.slug, leadId, acao, quando }, 'desistência da consulta: tarefa aberta para a equipe');
    return 'tarefa_aberta';
  } catch (err) {
    logger.warn({ unit: unit.slug, leadId, acao, err: String(err) }, 'desistência da consulta: ação falhou — segue');
    return 'falhou';
  } finally {
    emAndamento.delete(trava);
  }
}
