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
        // Só sobrescreve quando temos nome: um turno que falhou por rede não
        // pode apagar o nome que um turno anterior já tinha descoberto.
        ...(nome ? { nome } : {}),
      },
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
/**
 * Lê o Kommo e monta o payload. NÃO decide se pode enviar — só traduz.
 *
 * Separado de `prepararLead` porque as duas perguntas são diferentes: "o que
 * sairia" vale sempre; "pode sair" depende de já ter ido. O cadastro de
 * paciente precisa da primeira justamente quando a segunda diz não, porque o
 * paciente nasce de um lead que JÁ foi espelhado.
 */
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

  return montarPayload(unit, kommoLeadId);
}

/** O cadastro de PACIENTE que iria — só os campos que a franquia exige. */
export interface PayloadDoPaciente {
  name: string;
  /** Já em E.164: /api/clients recusa qualquer outro formato. */
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

/**
 * Monta o cadastro de paciente sem enviar. Mesmo motivo da prévia do lead: lá
 * não existe exclusão, então poder olhar antes é a defesa que sobra.
 *
 * As recusas aqui são mais duras que as do lead de propósito — ver cada etapa.
 */
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
  // O paciente nasce do lead: sem idLead não há o que vincular, e um paciente
  // solto no CRM deles não aparece no fluxo que a recepção usa.
  if (!vinculo?.spineIdLead) {
    return {
      ok: false,
      etapa: 'sem-lead',
      motivo: 'este lead ainda não foi espelhado na franquia — o paciente nasce a partir dele',
    };
  }

  // montarPayload, e NÃO prepararLead: este último recusa quando o lead já foi
  // espelhado, que aqui é exatamente a pré-condição.
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

/** Cadastra o paciente na franquia a partir de um lead já espelhado. */
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
    // "Sem conexão" não é estado do lead — não suja o histórico dele.
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

  // O paciente é o passo seguinte, não parte deste. Se falhar, o lead já está
  // lá e a recepção consegue cadastrar à mão pelo botão da tela deles — o
  // contrário (paciente sem lead) deixaria cadastro solto.
  if (unit.spineSyncPatients) {
    // O campo lá se chama "Nome Completo". Um lead pode entrar com "Pedro" —
    // é contato, o vendedor completa depois. Paciente é o cadastro que a
    // recepção usa pra chamar na sala, e "PEDRO" sozinho vira registro que
    // ninguém consegue distinguir dos outros Pedros nem apagar. Espera o
    // sobrenome, do mesmo jeito que o lead espera o nome.
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
