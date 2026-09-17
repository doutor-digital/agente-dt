import type { Unit } from '@prisma/client';
import type { KommoClient, KommoLead, KommoPipeline } from './kommo.service.js';
import { createKommoClient } from './kommo.service.js';
import { logger } from '../lib/logger.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { lerAnuncioDoLead, type AnuncioDeOrigem } from '../agent/anuncio-de-origem.js';
import {
  chaveTelefone,
  escolherIrmao,
  type CartaoIrmao,
  type Duplicidade,
} from './cadastro-duplicado.js';

export interface EstadoEtapaLead {
  statusId: number;
  nome: string;
  jaAgendadoOuPaciente: boolean;
  /**
   * Preenchido quando o sinal NÃO veio deste cartão, e sim de outro cartão do
   * mesmo telefone. O cartão da conversa pode ser novo e vazio só porque o
   * telefone está gravado em dois formatos — caso Wilson, 15/09/2026.
   */
  duplicidade?: Duplicidade | null;
  /**
   * O anúncio que trouxe o paciente, lido do cartão (o rastreio CTWA grava lá).
   * Sem isto a IA pergunta "como você nos conheceu" para quem chegou por um
   * anúncio que nós mesmos pagamos — e ela pergunta mal: 2 capturas em 1.052.
   */
  anuncio?: AnuncioDeOrigem | null;
}

/**
 * Lê o anúncio do cartão resolvendo os campos PELO NOME (id de campo é por
 * conta). Falha aqui nunca derruba o prompt: sem anúncio, a conversa segue como
 * antes e a pergunta de origem continua valendo.
 */
async function lerAnuncio(
  unit: Unit,
  kommo: KommoClient,
  campos: Parameters<typeof lerAnuncioDoLead>[0],
): Promise<AnuncioDeOrigem | null> {
  if (!campos?.length) return null;
  try {
    const esquema = await esquemaDaUnidade(unit, kommo);
    return lerAnuncioDoLead(campos, (nome) => esquema.campoPorNome(nome));
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'anúncio de origem indisponível — seguindo sem');
    return null;
  }
}

const ETAPA_TTL_MS = 90_000;
const PIPE_TTL_MS = 10 * 60_000;

const pipeCache = new Map<string, { em: number; pipes: KommoPipeline[] }>();
const etapaCache = new Map<string, { em: number; valor: EstadoEtapaLead | null }>();

async function pipelinesDaUnidade(unit: Unit): Promise<KommoPipeline[]> {
  const hit = pipeCache.get(unit.id);
  if (hit && Date.now() - hit.em < PIPE_TTL_MS) return hit.pipes;
  const pipes = await createKommoClient(unit).listPipelines();
  pipeCache.set(unit.id, { em: Date.now(), pipes });
  return pipes;
}

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function temConsultaMarcadaNoCampo(lead: KommoLead): boolean {
  const campos = lead.custom_fields_values ?? [];
  const limiar = Math.floor(Date.now() / 1000) - 24 * 3600;
  for (const f of campos) {
    const nome = normalizar(f.field_name ?? '');
    const ehCampoDeConsulta =
      nome.includes('data') && (nome.includes('consulta') || nome.includes('agendamento'));
    if (!ehCampoDeConsulta) continue;
    const raw = f.values?.[0]?.value;
    const ts = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(ts) && ts >= limiar) return true;
  }
  return false;
}

/**
 * Procura OUTROS cartões com o mesmo telefone e devolve o que mostra que a
 * pessoa já é paciente. Busca pelos últimos 8 dígitos, que é o que atravessa as
 * duas formas do número. Nunca derruba o turno: falhou, segue sem o bloco.
 */
async function duplicidadePorTelefone(
  unit: Unit,
  leadAtual: number,
  telefone: string,
): Promise<Duplicidade | null> {
  const chave = chaveTelefone(telefone);
  if (chave.length < 8) return null;
  try {
    const kommo = createKommoClient(unit);
    const contatos = await kommo.buscarContatosPorTexto(chave, 10);
    const candidatos: CartaoIrmao[] = [];
    for (const c of contatos) {
      for (const l of c._embedded?.leads ?? []) {
        if (l.id === leadAtual || candidatos.some((x) => x.leadId === l.id)) continue;
        if (candidatos.length >= 6) break;
        const lead = await kommo.getLead(l.id).catch(() => null);
        if (!lead) continue;
        const pipes = await pipelinesDaUnidade(unit);
        const est = lead.status_id ? classificar(unit, pipes, lead.pipeline_id, lead.status_id) : null;
        candidatos.push({
          leadId: l.id,
          contatoId: c.id,
          nome: c.name?.trim() || null,
          ehPaciente: Boolean(est?.jaAgendadoOuPaciente) || temConsultaMarcadaNoCampo(lead),
          dataConsulta: dataDaConsulta(lead),
          etapa: est?.nome ?? null,
        });
      }
    }
    return escolherIrmao(candidatos, leadAtual);
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, leadAtual },
      'duplicidadePorTelefone falhou — segue sem o aviso de cartão duplicado',
    );
    return null;
  }
}

/** Epoch (s) da consulta gravada no cartão, se houver. */
function dataDaConsulta(lead: KommoLead): number | null {
  for (const f of lead.custom_fields_values ?? []) {
    const nome = normalizar(f.field_name ?? '');
    if (!(nome.includes('data') && (nome.includes('consulta') || nome.includes('agendamento')))) continue;
    const raw = f.values?.[0]?.value;
    const ts = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(ts) && ts > 0) return ts;
  }
  return null;
}

function classificar(
  unit: Unit,
  pipes: KommoPipeline[],
  pipelineId: number | undefined,
  statusId: number,
): EstadoEtapaLead {
  const pipe =
    pipes.find((p) => p.id === pipelineId) ??
    pipes.find((p) => p.statuses?.some((s) => s.id === statusId));
  const status = pipe?.statuses?.find((s) => s.id === statusId);
  const nome = status?.name?.trim() || `etapa ${statusId}`;
  const semAgenda = (v: boolean): EstadoEtapaLead => ({ statusId, nome, jaAgendadoOuPaciente: v });

  if (statusId === 143 || status?.type === 143) return semAgenda(false);
  if (statusId === 142 || status?.type === 142) return semAgenda(true);
  if (pipe && /tratamento/i.test(pipe.name || '')) return semAgenda(true);

  const intents = unit.pipelineIntents as Record<string, unknown> | null;
  const anchorId = Number(intents?.scheduled_meeting) || null;
  let anchorSort: number | null = null;
  if (pipe?.statuses) {
    const anchor =
      pipe.statuses.find((s) => s.id === anchorId) ??
      pipe.statuses.find((s) => /^\s*agendad/i.test(s.name || ''));
    anchorSort = anchor?.sort ?? null;
  }
  const leadSort = status?.sort ?? null;
  const jaAgendado = anchorSort != null && leadSort != null && leadSort >= anchorSort;
  return semAgenda(jaAgendado);
}

export async function estadoEtapaDoLead(
  unit: Unit,
  leadId: number | undefined,
  telefone?: string | null,
): Promise<EstadoEtapaLead | null> {
  if (!leadId || !Number.isFinite(leadId)) return null;

  const key = `${unit.id}:${leadId}`;
  const hit = etapaCache.get(key);
  if (hit && Date.now() - hit.em < ETAPA_TTL_MS) return hit.valor;

  let valor: EstadoEtapaLead | null = null;
  try {
    const kommo = createKommoClient(unit);
    const lead = await kommo.getLead(leadId);
    if (lead?.status_id) {
      const pipes = await pipelinesDaUnidade(unit);
      valor = classificar(unit, pipes, lead.pipeline_id, lead.status_id);
    }

    // O anúncio que a pessoa clicou já está no cartão — o rastreio CTWA grava lá.
    // Ler aqui custa nada (o lead já foi buscado) e evita a IA perguntar "como
    // você nos conheceu" para quem chegou por um anúncio que a gente pagou.
    const anuncio = await lerAnuncio(unit, kommo, lead?.custom_fields_values);
    if (anuncio) {
      valor = valor
        ? { ...valor, anuncio }
        : { statusId: lead?.status_id ?? 0, nome: '', jaAgendadoOuPaciente: false, anuncio };
    }
    if (lead && temConsultaMarcadaNoCampo(lead)) {
      valor = valor
        ? { ...valor, jaAgendadoOuPaciente: true }
        : { statusId: lead.status_id ?? 0, nome: 'com consulta marcada', jaAgendadoOuPaciente: true };
    }

    // O cartão desta conversa pode ser novo e vazio só porque o telefone está
    // gravado em dois formatos — e aí ele não tem sinal nenhum para dar. Antes de
    // desistir, pergunta pelo TELEFONE: outro cartão do mesmo número pode dizer
    // que a pessoa já é paciente. Caso Wilson, 15/09/2026.
    if (!valor?.jaAgendadoOuPaciente && telefone) {
      const dup = await duplicidadePorTelefone(unit, leadId, telefone);
      if (dup) {
        valor = {
          statusId: valor?.statusId ?? 0,
          nome: dup.irmao.etapa ?? valor?.nome ?? 'já cadastrado nesta clínica',
          jaAgendadoOuPaciente: true,
          duplicidade: dup,
        };
      }
    }
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, leadId },
      'estadoEtapaDoLead falhou — sem bloco de etapa no prompt',
    );
    valor = null;
  }

  if (etapaCache.size > 5000) etapaCache.clear();
  etapaCache.set(key, { em: Date.now(), valor });
  return valor;
}
