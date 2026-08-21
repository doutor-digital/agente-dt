import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient } from './kommo.service.js';
import { SpineService } from './spine.service.js';

const CAMPO_ORIGEM = 2440801;
const CAMPO_CIDADE = 2440803;
const CAMPO_ESTADO = 2440807;
const CAMPO_QUEIXA = 2440811;

function pareceNomeAutomatico(titulo: string): boolean {
  const t = titulo.trim();
  if (t.length < 3) return true;
  if (/^lead\b/i.test(t)) return true;
  if (/^\+?\d[\d\s()\-]{6,}$/.test(t)) return true;
  if (/^(whatsapp|instagram|facebook|contato|cliente)$/i.test(t)) return true;
  const limpo = limparNome(t);
  if (limpo.length < 3) return true;
  return /^(whatsapp|instagram|facebook|contato|cliente|insta|face|fb)$/i.test(limpo);
}

const SUFIXOS_DE_ETIQUETA = [
  /\s*[-–—|/]\s*$/,
  /\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/,
  /\s+\d{1,2}[-.]\d{1,2}([-.]\d{2,4})?\s*$/,
  /\s+(insta|instagram|face|facebook|fb|whats|whatsapp|wpp|zap|dm|direct|site|google|tiktok|tik\s?tok|indica[çc][ãa]o|an[úu]ncio|ads|trafego|tr[áa]fego|org[âa]nico|organico)\s*$/i,
];

function canalNoTitulo(titulo: string): string | null {
  const m = /\s(insta|instagram|face|facebook|fb|whats|whatsapp|wpp|zap|site|google|tiktok|indica[çc][ãa]o)\s*$/i
    .exec(titulo.trim());
  if (!m) return null;
  const bruto = m[1].toLowerCase();
  const canonico: Record<string, string> = {
    insta: 'instagram', instagram: 'instagram',
    face: 'facebook', facebook: 'facebook', fb: 'facebook',
    whats: 'whatsapp', whatsapp: 'whatsapp', wpp: 'whatsapp', zap: 'whatsapp',
    site: 'site', google: 'google', tiktok: 'tiktok',
    indicação: 'indicacao', indicacao: 'indicacao',
  };
  return canonico[bruto] ?? null;
}

function limparNome(titulo: string): string {
  let t = titulo.trim();
  for (let volta = 0; volta < 6; volta++) {
    const antes = t;
    for (const re of SUFIXOS_DE_ETIQUETA) t = t.replace(re, '').trim();
    if (t === antes) break;
  }
  return t.length >= 3 ? t : titulo.trim();
}

export interface ResultadoSync {
  ok: boolean;
  motivo?: string;
  spineIdLead?: number;
  jaExistia?: boolean;
}

async function registrar(
  unitId: string,
  kommoLeadId: number,
  status: 'ok' | 'falhou' | 'ignorado',
  motivo: string | null,
  spineIdLead: number | null,
  nome: string | null = null,
): Promise<void> {
  try {
    await prisma.spineLeadLink.upsert({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId } },
      create: { unitId, kommoLeadId, status, motivo, spineIdLead, nome },
      update: {
        status,
        motivo,
        spineIdLead,
        tentativas: { increment: 1 },
        ...(nome ? { nome } : {}),
      },
    });
  } catch (err) {
    logger.warn({ err: String(err), kommoLeadId }, 'spine-sync: não consegui registrar o estado');
  }
}

export interface PayloadDoLead {
  name: string;
  whatsapp: string | null;
  description: string;
  idSource: number;
  addressCity: string | null;
  addressUf: string | null;
}

export interface Preparo {
  ok: boolean;
  motivo?: string;
  etapa?: 'conexao' | 'desligado' | 'ja-enviado' | 'kommo' | 'nome' | 'pronto';
  payload?: PayloadDoLead;
  tituloKommo?: string;
  spineIdLead?: number;
}

export async function montarPayload(unit: Unit, kommoLeadId: number): Promise<Preparo> {
  const kommo = createKommoClient(unit);
  let lead;
  try {
    lead = await kommo.getLead(kommoLeadId);
  } catch (err) {
    return { ok: false, etapa: 'kommo', motivo: `não consegui ler o lead no Kommo: ${String(err)}` };
  }

  const titulo = lead.name ?? '';
  if (pareceNomeAutomatico(titulo)) {
    return { ok: false, etapa: 'nome', tituloKommo: titulo, motivo: `aguardando nome ("${titulo}")` };
  }

  const valor = (fieldId: number): string | null => {
    const f = lead.custom_fields_values?.find((x) => x.field_id === fieldId);
    const v = f?.values?.[0]?.value;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };

  let whatsapp: string | null = null;
  const contatoId = lead._embedded?.contacts?.[0]?.id;
  if (contatoId) {
    try {
      whatsapp = await kommo.getContactPhone(contatoId);
    } catch {
      whatsapp = null;
    }
  }

  return {
    ok: true,
    etapa: 'pronto',
    tituloKommo: titulo,
    payload: {
      name: limparNome(titulo),
      whatsapp: whatsapp ? SpineService.normalizarWhatsapp(whatsapp) || null : null,
      description: valor(CAMPO_QUEIXA) ?? 'Lead vindo do atendimento por WhatsApp.',
      idSource: SpineService.resolverIdSource(
        valor(CAMPO_ORIGEM) ?? canalNoTitulo(titulo),
        unit.spineDefaultSourceId,
      ),
      addressCity: valor(CAMPO_CIDADE)?.toUpperCase() ?? null,
      addressUf: SpineService.resolverUf(valor(CAMPO_ESTADO)),
    },
  };
}

export async function prepararLead(unit: Unit, kommoLeadId: number): Promise<Preparo> {
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    return { ok: false, etapa: 'kommo', motivo: 'leadId inválido' };
  }

  const jaTem = await prisma.spineLeadLink.findUnique({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
  });
  if (jaTem?.status === 'ok' && jaTem.spineIdLead) {
    return { ok: false, etapa: 'ja-enviado', spineIdLead: jaTem.spineIdLead };
  }

  return montarPayload(unit, kommoLeadId);
}

export interface PayloadDoPaciente {
  name: string;
  whatsapp: string | null;
  idSource: number;
  idLead: number | null;
  addressCity: string | null;
  addressUf: string | null;
}

export interface PreparoPaciente {
  ok: boolean;
  motivo?: string;
  etapa?: 'desligado' | 'sem-lead' | 'ja-cadastrado' | 'nome-incompleto' | 'sem-contato' | 'pronto';
  payload?: PayloadDoPaciente;
  spineIdClient?: number;
}

export async function prepararPaciente(
  unit: Unit,
  kommoLeadId: number,
): Promise<PreparoPaciente> {
  const vinculo = await prisma.spineLeadLink.findUnique({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
  });

  if (vinculo?.spineIdClient) {
    return { ok: false, etapa: 'ja-cadastrado', spineIdClient: vinculo.spineIdClient };
  }
  if (!vinculo?.spineIdLead) {
    return {
      ok: false,
      etapa: 'sem-lead',
      motivo: 'este lead ainda não foi espelhado na franquia — o paciente nasce a partir dele',
    };
  }

  const preparo = await montarPayload(unit, kommoLeadId);
  const base = preparo.payload;
  if (!base) {
    return {
      ok: false,
      etapa: preparo.etapa === 'nome' ? 'nome-incompleto' : 'sem-contato',
      motivo: preparo.motivo ?? 'não deu pra montar o cadastro',
    };
  }

  const partes = base.name.trim().split(/\s+/).filter((x) => x.length >= 2);
  if (partes.length < 2) {
    return {
      ok: false,
      etapa: 'nome-incompleto',
      motivo: `o campo lá se chama "Nome Completo" e só temos "${base.name}" — falta o sobrenome`,
      payload: {
        name: base.name,
        whatsapp: base.whatsapp ? SpineService.normalizarWhatsapp(base.whatsapp) : null,
        idSource: base.idSource,
        idLead: vinculo.spineIdLead,
        addressCity: base.addressCity,
        addressUf: base.addressUf,
      },
    };
  }

  const fone = base.whatsapp ? SpineService.normalizarWhatsapp(base.whatsapp) : null;
  if (!fone) {
    return {
      ok: false,
      etapa: 'sem-contato',
      motivo: 'a franquia exige WhatsApp ou e-mail, e a recepção ficaria sem como ligar',
    };
  }

  return {
    ok: true,
    etapa: 'pronto',
    payload: {
      name: base.name,
      whatsapp: fone,
      idSource: base.idSource,
      idLead: vinculo.spineIdLead,
      addressCity: base.addressCity,
      addressUf: base.addressUf,
    },
  };
}

export async function syncPatientToSpine(
  unit: Unit,
  kommoLeadId: number,
): Promise<{ ok: boolean; motivo?: string; spineIdClient?: number; jaExistia?: boolean }> {
  if (!unit.spineToken) return { ok: false, motivo: 'franquia não conectada nesta unidade' };

  const p = await prepararPaciente(unit, kommoLeadId);
  if (p.etapa === 'ja-cadastrado') {
    return { ok: true, spineIdClient: p.spineIdClient, jaExistia: true };
  }
  if (!p.ok || !p.payload) return { ok: false, motivo: p.motivo ?? 'não deu pra montar o cadastro' };

  const r = await SpineService.createClient(unit, p.payload);
  if (!r.ok || !r.data?.idClient) {
    const motivo = r.error ?? 'a franquia não devolveu idClient';
    logger.warn({ kommoLeadId, erro: motivo, unit: unit.slug }, 'spine-sync: falha ao criar paciente');
    return { ok: false, motivo };
  }

  await prisma.spineLeadLink
    .update({
      where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
      data: { spineIdClient: r.data.idClient },
    })
    .catch(() => undefined);

  logger.info(
    { kommoLeadId, spineIdClient: r.data.idClient, unit: unit.slug },
    'spine-sync: paciente cadastrado na franquia',
  );
  return { ok: true, spineIdClient: r.data.idClient };
}

export async function syncLeadToSpine(unit: Unit, kommoLeadId: number): Promise<ResultadoSync> {
  if (!unit.spineToken) {
    return { ok: false, motivo: 'franquia não conectada nesta unidade' };
  }
  if (!unit.spineSyncLeads) {
    return { ok: false, motivo: 'espelhamento de leads desligado nesta unidade' };
  }

  const preparo = await prepararLead(unit, kommoLeadId);
  if (preparo.etapa === 'ja-enviado') {
    return { ok: true, spineIdLead: preparo.spineIdLead, jaExistia: true };
  }
  if (!preparo.ok || !preparo.payload) {
    const motivo = preparo.motivo ?? 'não deu pra montar o cadastro';
    if (preparo.etapa === 'nome') {
      await registrar(unit.id, kommoLeadId, 'ignorado', motivo, null, null);
    } else if (preparo.etapa === 'kommo') {
      await registrar(unit.id, kommoLeadId, 'falhou', motivo, null);
    }
    return { ok: false, motivo };
  }

  const r = await SpineService.createLead(unit, preparo.payload);

  if (!r.ok || !r.data?.idLead) {
    const motivo = r.error ?? 'a franquia não devolveu idLead';
    await registrar(unit.id, kommoLeadId, 'falhou', motivo, null, preparo.payload.name);
    logger.warn(
      { kommoLeadId, nome: preparo.payload.name, erro: motivo, unit: unit.slug },
      'spine-sync: falha ao criar lead na franquia',
    );
    return { ok: false, motivo };
  }

  await registrar(unit.id, kommoLeadId, 'ok', null, r.data.idLead, preparo.payload.name);

  if (unit.spineSyncPatients) {
    const partes = preparo.payload.name.trim().split(/\s+/).filter((x) => x.length >= 2);
    if (partes.length < 2) {
      logger.info(
        { kommoLeadId, nome: preparo.payload.name, unit: unit.slug },
        'spine-sync: paciente aguardando nome completo',
      );
      return { ok: true, spineIdLead: r.data.idLead };
    }

    const p = await SpineService.createClient(unit, {
      name: preparo.payload.name,
      whatsapp: preparo.payload.whatsapp,
      idSource: preparo.payload.idSource,
      idLead: r.data.idLead,
      addressCity: preparo.payload.addressCity,
      addressUf: preparo.payload.addressUf,
    });
    if (p.ok && p.data?.idClient) {
      await prisma.spineLeadLink
        .update({
          where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
          data: { spineIdClient: p.data.idClient },
        })
        .catch(() => undefined);
      logger.info(
        { kommoLeadId, spineIdClient: p.data.idClient, unit: unit.slug },
        'spine-sync: paciente cadastrado na franquia',
      );
    } else {
      logger.warn(
        { kommoLeadId, erro: p.error, unit: unit.slug },
        'spine-sync: lead entrou mas o paciente falhou',
      );
    }
  }

  logger.info(
    {
      kommoLeadId,
      spineIdLead: r.data.idLead,
      nome: preparo.payload.name,
      idSource: preparo.payload.idSource,
      unit: unit.slug,
    },
    'spine-sync: lead enviado para a franquia',
  );
  return { ok: true, spineIdLead: r.data.idLead };
}

export const SpineSyncService = {
  prepararPaciente,
  syncPatientToSpine,
  montarPayload, syncLeadToSpine, prepararLead, pareceNomeAutomatico, limparNome };
