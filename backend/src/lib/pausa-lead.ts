/**
 * Pausa da IA para UM lead, com data para voltar (widget "Pausar a Sofia", 02/10/2026).
 *
 * Antes a pausa por lead era só a caixinha "Pausar IA" do cartão: sem data, a SDR tinha que lembrar
 * de desmarcar. Agora a SDR escolhe até quando, e a Sofia volta sozinha.
 *
 * Duas camadas, de propósito:
 *  1. a linha em `lead_pausas` — é ela que manda na Sofia, mesmo que alguém desmarque a caixinha;
 *  2. a caixinha "Pausar IA" — marcada junto, porque os Salesbots e a régua leem a caixinha, não o
 *     nosso banco. Só desmarcamos ao vencer se FOMOS nós que marcamos (`marcouCampo`): se a SDR já
 *     tinha marcado à mão, a marca é dela.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { pausaDoLeadAtiva } from './pausa-lead-regras.js';

export { PAUSA_LEAD_MAX_DIAS, pausaDoLeadAtiva, validarPausaDoLead, type JanelaDoLead } from './pausa-lead-regras.js';

type UnitDoKommo = Pick<
  Unit,
  | 'id'
  | 'slug'
  | 'kommoSubdomain'
  | 'kommoAccessToken'
  | 'kommoSalesbotId'
  | 'kommoReplyFieldId'
  | 'kommoPausedFieldId'
  | 'kommoBypassSalesbot'
  | 'kommoSalesbotExecuteEnabled'
>;

export interface EstadoDaPausaDoLead {
  leadId: number;
  emPausa: boolean;
  ate: Date | null;
  motivo: string | null;
  por: string | null;
  /** A caixinha "Pausar IA" do cartão ficou marcada por nós. Falso = a Sofia está pausada só pelo banco. */
  campoMarcado: boolean;
}

function estadoDe(leadId: number, p: { ate: Date; motivo: string | null; por: string | null; marcouCampo: boolean } | null, agora = new Date()): EstadoDaPausaDoLead {
  const ativa = pausaDoLeadAtiva(p, agora);
  return {
    leadId,
    emPausa: ativa,
    ate: ativa ? p!.ate : null,
    motivo: ativa ? p!.motivo : null,
    por: ativa ? p!.por : null,
    campoMarcado: ativa ? p!.marcouCampo : false,
  };
}

/** A Sofia pergunta isto na hora de responder: o lead tem janela de pausa em curso? */
export async function leadPausadoPorJanela(unitId: string, leadId: number): Promise<boolean> {
  try {
    const p = await prisma.leadPausa.findUnique({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } },
      select: { ate: true },
    });
    return pausaDoLeadAtiva(p);
  } catch (err) {
    // Na dúvida a Sofia responde (igual a `isLeadPaused`): erro de banco não pode calar a IA.
    logger.warn({ err, unitId, leadId }, 'leadPausadoPorJanela: falha — assumindo não pausado');
    return false;
  }
}

export async function estadoDaPausaDoLead(unitId: string, leadId: number): Promise<EstadoDaPausaDoLead> {
  const p = await prisma.leadPausa.findUnique({ where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } } });
  return estadoDe(leadId, p);
}

export async function pausarLead(
  unit: UnitDoKommo,
  leadId: number,
  pedido: { ate: Date; motivo?: string | null; por?: string | null },
): Promise<EstadoDaPausaDoLead> {
  const anterior = await prisma.leadPausa.findUnique({ where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: leadId } } });
  let marcouCampo = anterior?.marcouCampo ?? false;

  if (unit.kommoPausedFieldId) {
    try {
      const kommo = createKommoClient(unit);
      const jaMarcado = await kommo.isLeadFieldChecked(leadId, unit.kommoPausedFieldId);
      if (!jaMarcado) {
        await kommo.setLeadFieldFlag(leadId, unit.kommoPausedFieldId, true);
        marcouCampo = true;
      }
    } catch (err) {
      // Sem a caixinha, os Salesbots não sabem da pausa — mas a Sofia sabe (a linha manda nela).
      logger.warn({ err, unit: unit.slug, leadId }, 'pausarLead: não consegui marcar "Pausar IA" no cartão — pausa só pelo banco');
    }
  }

  const gravada = await prisma.leadPausa.upsert({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: leadId } },
    create: { unitId: unit.id, kommoLeadId: leadId, ate: pedido.ate, motivo: pedido.motivo?.trim() || null, por: pedido.por?.trim() || null, marcouCampo },
    update: { ate: pedido.ate, motivo: pedido.motivo?.trim() || null, por: pedido.por?.trim() || null, marcouCampo },
  });
  logger.info({ unit: unit.slug, leadId, ate: pedido.ate, por: pedido.por, marcouCampo }, 'pausa do lead ligada');
  return estadoDe(leadId, gravada);
}

/** Desmarca a caixinha se foi a gente que marcou. Devolve falso quando não deu para falar com o Kommo. */
async function desmarcarSeFomosNos(unit: UnitDoKommo, leadId: number, marcouCampo: boolean): Promise<boolean> {
  if (!marcouCampo || !unit.kommoPausedFieldId) return true;
  try {
    await createKommoClient(unit).setLeadFieldFlag(leadId, unit.kommoPausedFieldId, false);
    return true;
  } catch (err) {
    logger.warn({ err, unit: unit.slug, leadId }, 'pausa do lead: não consegui desmarcar "Pausar IA"');
    return false;
  }
}

export async function retomarLead(unit: UnitDoKommo, leadId: number, por?: string | null): Promise<EstadoDaPausaDoLead> {
  const p = await prisma.leadPausa.findUnique({ where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: leadId } } });
  if (p) {
    await desmarcarSeFomosNos(unit, leadId, p.marcouCampo);
    await prisma.leadPausa.delete({ where: { id: p.id } });
    logger.info({ unit: unit.slug, leadId, por }, 'pausa do lead desligada');
  }
  return estadoDe(leadId, null);
}

/** Uma passada do worker: tira as pausas vencidas e devolve quantas limpou. */
export async function liberarPausasVencidas(agora: Date = new Date()): Promise<number> {
  const vencidas = await prisma.leadPausa.findMany({ where: { ate: { lte: agora } }, include: { unit: true }, take: 200 });
  let limpas = 0;
  for (const p of vencidas) {
    const ok = await desmarcarSeFomosNos(p.unit, p.kommoLeadId, p.marcouCampo);
    // Se o Kommo não respondeu, tenta de novo no próximo minuto — mas desiste depois de 1 dia, para
    // um lead apagado do Kommo não prender a linha para sempre.
    const velhaDemais = agora.getTime() - p.ate.getTime() > 86_400_000;
    if (ok || velhaDemais) {
      await prisma.leadPausa.delete({ where: { id: p.id } }).catch(() => {});
      limpas++;
    }
  }
  return limpas;
}
