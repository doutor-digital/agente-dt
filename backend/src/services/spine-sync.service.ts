// ============================================================================
// spine-sync.service.ts — Leva o lead do Kommo para o CRM da franquia.
//
// POR QUE ISSO EXISTE
// -------------------
// A clínica opera no sistema da franquia; o atendimento acontece no Kommo. Sem
// a ponte, quem chega pelo WhatsApp só existe de um lado, e a recepção descobre
// o paciente na hora em que ele aparece na porta.
//
// TRÊS DECISÕES QUE EVITAM SUJEIRA IRREVERSÍVEL
// ---------------------------------------------
// 1. SÓ COM NOME DE VERDADE. O Kommo cria o lead com título automático
//    ("Lead #21768453", "WhatsApp", o telefone). Mandar isso pra franquia
//    encheria o CRM de fantasma — e a API deles NÃO TEM exclusão de lead
//    (testado: 404), então cada erro é permanente e só some na mão.
// 2. UMA VEZ SÓ. O vínculo é gravado com unique (unitId, kommoLeadId): o retry
//    do webhook, que o Kommo faz de rotina, não vira segundo cadastro.
// 3. NUNCA DERRUBA O ATENDIMENTO. É chamado fire-and-forget. Se a franquia
//    estiver fora do ar, o paciente continua sendo atendido — a sincronização
//    é importante, mas não é ela que conversa com quem está com dor.
// ============================================================================

import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient } from './kommo.service.js';
import { SpineService } from './spine.service.js';

/** Campos do Kommo de onde tiramos os dados do cadastro. */
const CAMPO_ORIGEM = 2440801;
const CAMPO_CIDADE = 2440803;
const CAMPO_ESTADO = 2440807;
const CAMPO_QUEIXA = 2440811;

/**
 * Títulos que o Kommo gera sozinho. Nenhum deles é nome de gente, e mandar
 * qualquer um pra franquia cria um cadastro que ninguém consegue usar nem
 * apagar.
 */
function pareceNomeAutomatico(titulo: string): boolean {
  const t = titulo.trim();
  if (t.length < 3) return true;
  if (/^lead\b/i.test(t)) return true; // "Lead #123", "Lead 2 27/7/26"
  if (/^\+?\d[\d\s()\-]{6,}$/.test(t)) return true; // só telefone
  if (/^(whatsapp|instagram|facebook|contato|cliente)$/i.test(t)) return true;
  // "Fulano 27/07/2026" é nome com data — vale; tira a data e vê o que sobra.
  const semData = t.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '').trim();
  return semData.length < 3;
}

/** Tira a data que a tool de título acrescenta: "Maria Silva 27/07/2026". */
function limparNome(titulo: string): string {
  return titulo.replace(/\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/, '').trim();
}

export interface ResultadoSync {
  ok: boolean;
  /** Por que não sincronizou — sempre preenchido quando ok=false. */
  motivo?: string;
  spineIdLead?: number;
  jaExistia?: boolean;
}

export async function syncLeadToSpine(unit: Unit, kommoLeadId: number): Promise<ResultadoSync> {
  if (!unit.spineEnabled || !unit.spineToken) {
    return { ok: false, motivo: 'franquia não conectada nesta unidade' };
  }
  if (!unit.spineSyncLeads) {
    return { ok: false, motivo: 'espelhamento de leads desligado nesta unidade' };
  }
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    return { ok: false, motivo: 'leadId inválido' };
  }

  const jaTem = await prisma.spineLeadLink.findUnique({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
  });
  if (jaTem) {
    return { ok: true, spineIdLead: jaTem.spineIdLead, jaExistia: true };
  }

  const kommo = createKommoClient(unit);
  let lead;
  try {
    lead = await kommo.getLead(kommoLeadId);
  } catch (err) {
    return { ok: false, motivo: `não consegui ler o lead no Kommo: ${String(err)}` };
  }

  const titulo = lead.name ?? '';
  if (pareceNomeAutomatico(titulo)) {
    return { ok: false, motivo: `lead ainda sem nome real ("${titulo}")` };
  }
  const nome = limparNome(titulo);

  const valor = (fieldId: number): string | null => {
    const f = lead.custom_fields_values?.find((x) => x.field_id === fieldId);
    const v = f?.values?.[0]?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  // O telefone mora no CONTATO, não no lead. Sem ele a franquia até aceita o
  // cadastro, mas a recepção fica com um nome que não dá pra ligar.
  let whatsapp: string | null = null;
  const contatoId = lead._embedded?.contacts?.[0]?.id;
  if (contatoId) {
    try {
      whatsapp = await kommo.getContactPhone(contatoId);
    } catch {
      whatsapp = null;
    }
  }

  const idSource = SpineService.resolverIdSource(valor(CAMPO_ORIGEM), unit.spineDefaultSourceId);
  const queixa = valor(CAMPO_QUEIXA);

  const r = await SpineService.createLead(unit, {
    name: nome,
    whatsapp,
    description: queixa ?? 'Lead vindo do atendimento por WhatsApp.',
    idSource,
    addressCity: valor(CAMPO_CIDADE),
    addressUf: valor(CAMPO_ESTADO),
  });

  if (!r.ok || !r.data?.idLead) {
    logger.warn(
      { kommoLeadId, nome, erro: r.error, unit: unit.slug },
      'spine-sync: falha ao criar lead na franquia',
    );
    return { ok: false, motivo: r.error ?? 'a franquia não devolveu idLead' };
  }

  try {
    await prisma.spineLeadLink.create({
      data: { unitId: unit.id, kommoLeadId, spineIdLead: r.data.idLead },
    });
  } catch {
    // Corrida: dois webhooks do mesmo lead ao mesmo tempo. O cadastro já foi
    // criado — registrar isso é o que importa, e o unique fez o trabalho dele.
    logger.info({ kommoLeadId }, 'spine-sync: vínculo já existia (corrida)');
  }

  logger.info(
    { kommoLeadId, spineIdLead: r.data.idLead, nome, idSource, unit: unit.slug },
    'spine-sync: lead enviado para a franquia',
  );
  return { ok: true, spineIdLead: r.data.idLead };
}

export const SpineSyncService = { syncLeadToSpine, pareceNomeAutomatico, limparNome };
