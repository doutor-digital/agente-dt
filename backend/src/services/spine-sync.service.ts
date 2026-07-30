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
  // "Fulano 27/07 Insta" é nome com etiqueta — vale. Tira a etiqueta e vê o
  // que sobra: se não sobrou nome, o título era só etiqueta.
  const limpo = limparNome(t);
  if (limpo.length < 3) return true;
  return /^(whatsapp|instagram|facebook|contato|cliente|insta|face|fb)$/i.test(limpo);
}

/**
 * Tira do título tudo que a operação carimba depois do nome.
 *
 * O título do lead no Kommo não é um campo de nome — é uma etiqueta de
 * trabalho. Na prática vem "Renata Souza 12/05 Insta": nome, dia do contato e
 * canal. Sem limpar isso, o CRM da franquia ganha uma PACIENTE chamada
 * "Renata Souza 12/05 Insta", para sempre — lá não existe exclusão de lead.
 *
 * Só remove sufixos: data (12/05, 27/07/2026), canal e separadores soltos.
 * Repete enquanto encontrar, porque eles se empilham em qualquer ordem. O que
 * vier ANTES nunca é tocado — sobrenome de verdade não corre risco.
 */
const SUFIXOS_DE_ETIQUETA = [
  /\s*[-–—|/]\s*$/, // separador solto que sobra depois de tirar o resto
  /\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, // 12/05 e 27/07/2026
  /\s+\d{1,2}[-.]\d{1,2}([-.]\d{2,4})?\s*$/, // 12-05, 12.05.2026
  /\s+(insta|instagram|face|facebook|fb|whats|whatsapp|wpp|zap|dm|direct|site|google|tiktok|tik\s?tok|indica[çc][ãa]o|an[úu]ncio|ads|trafego|tr[áa]fego|org[âa]nico|organico)\s*$/i,
];

/**
 * O canal que a operação anotou no fim do título, no vocabulário que o mapa de
 * origem entende. Só o sufixo — "Ana Face" conta, "Faceira Souza" não.
 */
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
  // Se a limpeza comeu o nome inteiro (título que era só etiqueta), devolve o
  // original: quem decide se presta é `pareceNomeAutomatico`.
  return t.length >= 3 ? t : titulo.trim();
}

export interface ResultadoSync {
  ok: boolean;
  /** Por que não sincronizou — sempre preenchido quando ok=false. */
  motivo?: string;
  spineIdLead?: number;
  jaExistia?: boolean;
}

/**
 * Grava o estado atual da tentativa. Uma linha por lead, atualizada — não um
 * log que cresce sem fim. O que interessa é "onde este lead está agora", e
 * `tentativas` distingue "ainda não tem nome" de "tenta há 20 turnos e algo
 * quebrou".
 */
async function registrar(
  unitId: string,
  kommoLeadId: number,
  status: 'ok' | 'falhou' | 'ignorado',
  motivo: string | null,
  spineIdLead: number | null,
): Promise<void> {
  try {
    await prisma.spineLeadLink.upsert({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId } },
      create: { unitId, kommoLeadId, status, motivo, spineIdLead },
      update: { status, motivo, spineIdLead, tentativas: { increment: 1 } },
    });
  } catch (err) {
    logger.warn({ err: String(err), kommoLeadId }, 'spine-sync: não consegui registrar o estado');
  }
}

/** O cadastro exato que iria pra franquia — nada além disto é enviado. */
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
  /** Onde a decisão travou: útil pra tela dizer O QUE consertar. */
  etapa?: 'conexao' | 'desligado' | 'ja-enviado' | 'kommo' | 'nome' | 'pronto';
  payload?: PayloadDoLead;
  tituloKommo?: string;
  spineIdLead?: number;
}

/**
 * Monta o cadastro sem enviar nada.
 *
 * Separado do envio de propósito: a API da franquia não tem exclusão de lead
 * (testado: 404 nas duas formas). Cada erro nosso vira chamado no suporte
 * deles. Poder OLHAR o que sairia, antes de sair, é a diferença entre revisar
 * e descobrir depois.
 */
export async function prepararLead(unit: Unit, kommoLeadId: number): Promise<Preparo> {
  // NÃO exige franquia conectada de propósito: montar o cadastro só lê o
  // Kommo. Travar aqui derrubaria justamente o caso de uso da prévia —
  // conferir os campos ANTES de ligar o espelhamento. Quem decide se pode
  // enviar é `syncLeadToSpine`.
  if (!Number.isFinite(kommoLeadId) || kommoLeadId <= 0) {
    return { ok: false, etapa: 'kommo', motivo: 'leadId inválido' };
  }

  const jaTem = await prisma.spineLeadLink.findUnique({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
  });
  // Só bloqueia se JÁ FOI CRIADO. Uma tentativa que falhou, ou que foi ignorada
  // por falta de nome, tem que ser retentada — é assim que o lead entra sozinho
  // no turno em que a IA descobre o nome, sem ninguém reprocessar nada.
  if (jaTem?.status === 'ok' && jaTem.spineIdLead) {
    return { ok: false, etapa: 'ja-enviado', spineIdLead: jaTem.spineIdLead };
  }

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

  // NORMALIZA AQUI, não na hora de mandar. A prévia só serve pra alguma coisa
  // se mostrar o que REALMENTE sai — e o Kommo devolve o telefone com um
  // apóstrofo na frente ("'+5563…") e o estado por extenso ("Maranhão").
  // Formatar só no envio faria a tela exibir um valor e a franquia receber
  // outro, que é o defeito que a prévia existe pra impedir.
  return {
    ok: true,
    etapa: 'pronto',
    tituloKommo: titulo,
    payload: {
      name: limparNome(titulo),
      whatsapp: whatsapp ? SpineService.normalizarWhatsapp(whatsapp) || null : null,
      description: valor(CAMPO_QUEIXA) ?? 'Lead vindo do atendimento por WhatsApp.',
      // A origem manda no relatório de onde a clínica investe. Quando o campo
      // do Kommo está vazio, o próprio título costuma dizer o canal ("... Insta")
      // — usar isso é melhor que jogar tudo no padrão e contar Instagram como
      // WhatsApp.
      idSource: SpineService.resolverIdSource(
        valor(CAMPO_ORIGEM) ?? canalNoTitulo(titulo),
        unit.spineDefaultSourceId,
      ),
      addressCity: valor(CAMPO_CIDADE)?.toUpperCase() ?? null,
      // "Maranhão" -> "MA". Devolve null quando não reconhece: campo vazio a
      // recepção completa; sigla errada vira paciente no estado errado, e lá
      // não se apaga cadastro.
      addressUf: SpineService.resolverUf(valor(CAMPO_ESTADO)),
    },
  };
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
    // "Sem conexão" não é estado do lead — não suja o histórico dele.
    if (preparo.etapa === 'nome') {
      await registrar(unit.id, kommoLeadId, 'ignorado', motivo, null);
    } else if (preparo.etapa === 'kommo') {
      await registrar(unit.id, kommoLeadId, 'falhou', motivo, null);
    }
    return { ok: false, motivo };
  }

  const r = await SpineService.createLead(unit, preparo.payload);

  if (!r.ok || !r.data?.idLead) {
    const motivo = r.error ?? 'a franquia não devolveu idLead';
    await registrar(unit.id, kommoLeadId, 'falhou', motivo, null);
    logger.warn(
      { kommoLeadId, nome: preparo.payload.name, erro: motivo, unit: unit.slug },
      'spine-sync: falha ao criar lead na franquia',
    );
    return { ok: false, motivo };
  }

  await registrar(unit.id, kommoLeadId, 'ok', null, r.data.idLead);

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

export const SpineSyncService = { syncLeadToSpine, prepararLead, pareceNomeAutomatico, limparNome };
