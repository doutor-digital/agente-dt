/**
 * Worker de leads PARADOS — quem move é o relógio e a franquia, não a equipe (João, 18 e 21/09/2026).
 *
 * As regras puras estão em `parados.ts`. Aqui: ler o Kommo, decidir, mover, anotar. Roda de hora
 * em hora nas unidades de `PARADOS_SLUGS`; com `PARADOS_SECO=1` só registra o que faria. Cada
 * cartão movido ganha a etiqueta `⏱ movido por prazo` e uma nota dizendo o porquê — a equipe vê
 * de onde veio e sabe que o cartão volta sozinho se o fato mudar.
 *
 * Fontes de verdade:
 *  - última fala do paciente: eventos `incoming_chat_message` do CONTATO (por lead a API dá 204);
 *  - entrada na etapa: último `lead_status_changed` do lead;
 *  - falta e remarcação: o cartão (espelho da fase 1) + histórico do paciente na franquia.
 * Erro de API num cartão pula o cartão (nunca vira "paciente nunca escreveu").
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { esquemaDaUnidade, normalizarNome } from './kommo-schema.js';
import { ETAPA } from './franquia-move.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { carregarFunis, historicoDoPaciente, idClientDoLead, temConsultaFutura, type Funis } from './franquia-sync-worker.js';
import {
  CAMPO,
  MAX_POR_VARREDURA,
  TAG_PRAZO,
  decidirFalta,
  decidirParado,
  decisaoFollowUpEsgotado,
  follopUpEsgotadoDerruba,
  modoSeco,
  paradosLiberado,
  textoDaNota,
  type DecisaoParado,
} from './parados.js';

const SWEEP_MS = Number(process.env.PARADOS_SWEEP_MS) || 60 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
const FUNIS_TTL_MS = 10 * 60_000;
const MOTIVOS_TTL_MS = 60 * 60_000;

const funisCache = new Map<string, { em: number; funis: Funis }>();
async function funisDaUnidade(unit: Unit, kommo: KommoClient): Promise<Funis | null> {
  const hit = funisCache.get(unit.id);
  if (hit && Date.now() - hit.em < FUNIS_TTL_MS) return hit.funis;
  const funis = await carregarFunis(kommo);
  if (funis) funisCache.set(unit.id, { em: Date.now(), funis });
  return funis;
}

const motivosCache = new Map<string, { em: number; porNome: Map<string, number> }>();
/** Id do motivo de perda pelo NOME; cria na conta se não existir (contas novas não têm todos). */
async function idDoMotivoDePerda(unit: Unit, kommo: KommoClient, nome: string): Promise<number | null> {
  let hit = motivosCache.get(unit.id);
  if (!hit || Date.now() - hit.em >= MOTIVOS_TTL_MS) {
    const lista = await kommo.listLossReasons();
    hit = { em: Date.now(), porNome: new Map(lista.map((m) => [normalizarNome(m.name), m.id])) };
    motivosCache.set(unit.id, hit);
  }
  const chave = normalizarNome(nome);
  const id = hit.porNome.get(chave);
  if (id) return id;
  const criado = await kommo.createLossReason(nome);
  if (criado) {
    hit.porNome.set(chave, criado.id);
    logger.info({ unit: unit.slug, motivo: nome, id: criado.id }, 'parados: motivo de perda criado na conta');
    return criado.id;
  }
  return null;
}

function n(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function valorDoCampo(lead: KommoLead, nome: string): unknown {
  const alvo = normalizarNome(nome);
  const f = (lead.custom_fields_values ?? []).find((c) => normalizarNome(c.field_name ?? '') === alvo);
  return f?.values?.[0]?.value;
}

function epochDoCampoData(lead: KommoLead, nome: string): number | null {
  const v = valorDoCampo(lead, nome);
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : v;
  const num = Number(v);
  if (Number.isFinite(num) && num > 0) return num > 1e11 ? Math.floor(num / 1000) : num;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

async function gravarSelect(unit: Unit, kommo: KommoClient, leadId: number, nome: string, opcao: string): Promise<void> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = esquema.campoPorNome(nome);
  if (id === null) {
    logger.warn({ unit: unit.slug, leadId, campo: nome }, 'parados: campo não existe nesta conta — segui sem ele');
    return;
  }
  await kommo.setLeadCustomFieldValue(leadId, id, 'select', opcao);
}

async function gravarData(unit: Unit, kommo: KommoClient, leadId: number, nome: string, epoch: number): Promise<void> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = esquema.campoPorNome(nome);
  if (id === null) return;
  await kommo.setLeadCustomFieldValue(leadId, id, 'date', new Date(epoch * 1000).toISOString());
}

async function limparCampo(unit: Unit, kommo: KommoClient, leadId: number, nome: string): Promise<void> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = esquema.campoPorNome(nome);
  if (id === null) return;
  await kommo.clearLeadCustomField(leadId, id);
}

async function anotarETaguear(unit: Unit, kommo: KommoClient, leadId: number, texto: string): Promise<void> {
  try {
    await kommo.addTag({ leadId, tag: TAG_PRAZO });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao etiquetar');
  }
  try {
    await kommo.addLeadNote(leadId, texto);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao anotar');
  }
}

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

/** Fecha como PERDIDO com motivo + campo do cartão + etiqueta + nota. Em modo seco só registra. Devolve se moveu. */
export async function fecharComoPerdido(
  unit: Unit,
  kommo: KommoClient,
  leadId: number,
  etapaAtual: string,
  d: DecisaoParado,
  seco: boolean,
): Promise<boolean> {
  const base = { unit: unit.slug, leadId, de: etapaAtual, regra: d.regra, motivo: d.motivoPerda };
  if (seco) {
    logger.info(base, 'parados [seco]: moveria pra PERDIDO');
    return false;
  }
  const lossId = d.motivoPerda ? await idDoMotivoDePerda(unit, kommo, d.motivoPerda).catch(() => null) : null;
  if (d.campo) {
    await gravarSelect(unit, kommo, leadId, d.campo.nome, d.campo.opcao).catch((err) =>
      logger.warn({ err: String(err), ...base, campo: d.campo?.nome }, 'parados: falha ao gravar o motivo no cartão'),
    );
  }
  await kommo.setLeadStatus(leadId, { won: false, lossReasonId: lossId ?? undefined });
  await anotarETaguear(unit, kommo, leadId, textoDaNota(d, etapaAtual));
  logger.warn({ ...base, lossId }, 'parados: cartão movido pra PERDIDO');
  return true;
}

/** NÃO COMPARECEU → EM ESPERA com motivo "Outro" e retomada marcada. Devolve se moveu. */
export async function moverParaEspera(
  unit: Unit,
  kommo: KommoClient,
  funis: Funis,
  leadId: number,
  etapaAtual: string,
  d: DecisaoParado,
  seco: boolean,
): Promise<boolean> {
  const alvo = funis.idDe('COMERCIAL', ETAPA.ESPERA);
  const base = { unit: unit.slug, leadId, de: etapaAtual, regra: d.regra };
  if (!alvo) {
    logger.warn(base, 'parados: a conta não tem a etapa EM ESPERA — não movi');
    return false;
  }
  if (seco) {
    logger.info(base, 'parados [seco]: moveria pra EM ESPERA');
    return false;
  }
  if (d.campo) {
    await gravarSelect(unit, kommo, leadId, d.campo.nome, d.campo.opcao).catch((err) =>
      logger.warn({ err: String(err), ...base }, 'parados: falha ao gravar o motivo da espera'),
    );
  }
  if (d.retomarEmEpoch) {
    await gravarData(unit, kommo, leadId, CAMPO.RETOMAR_EM, d.retomarEmEpoch).catch((err) =>
      logger.warn({ err: String(err), ...base }, 'parados: falha ao gravar "Retomar em"'),
    );
  }
  await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
  await anotarETaguear(unit, kommo, leadId, textoDaNota(d, etapaAtual));
  logger.warn(base, 'parados: cartão movido pra EM ESPERA');
  return true;
}

/**
 * Regra 8 (18/09): paciente em EM ESPERA que escreve volta pra EM QUALIFICAÇÃO na hora, e a
 * retomada automática é cancelada (limpa "Retomar em"). Chamado solto pelo webhook: não atrasa a
 * resposta e nunca lança.
 */
export async function voltarDaEsperaSeRespondeu(unit: Unit, leadId: number): Promise<void> {
  if (!paradosLiberado(unit.slug) || !unit.kommoAccessToken) return;
  try {
    const kommo = createKommoClient(unit);
    const lead = await kommo.getLead(leadId);
    const funis = await funisDaUnidade(unit, kommo);
    if (!funis) return;
    const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
    if (!atual || atual.funil !== 'COMERCIAL' || normalizarNome(atual.status) !== normalizarNome(ETAPA.ESPERA)) return;
    const alvo = funis.idDe('COMERCIAL', ETAPA.QUALIFICACAO);
    if (!alvo) return;
    if (modoSeco()) {
      logger.info({ unit: unit.slug, leadId }, 'parados [seco]: voltaria de EM ESPERA pra EM QUALIFICAÇÃO (paciente escreveu)');
      return;
    }
    await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
    await limparCampo(unit, kommo, leadId, CAMPO.RETOMAR_EM).catch(() => undefined);
    await kommo
      .addLeadNote(leadId, '↩ Voltou de EM ESPERA para EM QUALIFICAÇÃO: o paciente escreveu. Retomada automática cancelada.')
      .catch(() => null);
    logger.info({ unit: unit.slug, leadId }, 'parados: paciente respondeu — voltou de EM ESPERA');
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao voltar de EM ESPERA (ignorada)');
  }
}

/** Regra 9 (18/09): régua de follow-up esgotada sem resposta → PERDIDO "Não interagiu". Chamado pelo follow-up-worker. */
export async function perderPorFollowUpEsgotado(unit: Unit, kommo: KommoClient, leadId: number): Promise<void> {
  if (!paradosLiberado(unit.slug)) return;
  try {
    const lead = await kommo.getLead(leadId);
    const funis = await funisDaUnidade(unit, kommo);
    if (!funis) return;
    const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
    if (!atual || atual.funil !== 'COMERCIAL' || !follopUpEsgotadoDerruba(atual.status)) return;
    await fecharComoPerdido(unit, kommo, leadId, atual.status, decisaoFollowUpEsgotado(), modoSeco());
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao fechar por régua esgotada (ignorada)');
  }
}

interface Resumo {
  unit: string;
  seco: boolean;
  avaliados: number;
  movidos: number;
  simulados: number;
  erros: number;
}

async function leadsDaEtapa(kommo: KommoClient, funis: Funis, etapa: string): Promise<KommoLead[]> {
  const alvo = funis.idDe('COMERCIAL', etapa);
  if (!alvo) return [];
  const out: KommoLead[] = [];
  for (let page = 1; page <= 4; page++) {
    const pag = await kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true);
    out.push(...pag);
    if (pag.length < 250) break;
  }
  return out;
}

async function varrerUnidade(unit: Unit): Promise<Resumo> {
  const seco = modoSeco();
  const resumo: Resumo = { unit: unit.slug, seco, avaliados: 0, movidos: 0, simulados: 0, erros: 0 };
  const agora = Math.floor(Date.now() / 1000);
  const kommo = createKommoClient(unit);
  const funis = await funisDaUnidade(unit, kommo);
  if (!funis) {
    logger.warn({ unit: unit.slug }, 'parados: não achei o funil COMERCIAL — pulei a unidade');
    return resumo;
  }
  let feitos = 0;
  const podeMover = () => feitos < MAX_POR_VARREDURA;
  const contar = (moveu: boolean) => {
    feitos++;
    if (moveu) resumo.movidos++;
    else resumo.simulados++;
  };

  // EM ESPERA e EM NEGOCIAÇÃO: o prazo conta da última fala do paciente.
  for (const etapa of [ETAPA.ESPERA, ETAPA.NEGOCIACAO]) {
    if (!podeMover()) break;
    const leads = await leadsDaEtapa(kommo, funis, etapa);
    for (const lead of leads) {
      if (!podeMover()) break;
      resumo.avaliados++;
      try {
        const contactId = lead._embedded?.contacts?.[0]?.id ?? null;
        const ultimaMsg = contactId ? await kommo.ultimaMensagemRecebidaDoContato(contactId) : null;
        const entrou = await kommo.entradaNaEtapaAtual(lead.id);
        const d = decidirParado(
          etapa,
          { ultimaMsgPacienteEpoch: ultimaMsg, entrouNaEtapaEpoch: entrou, criadoEpoch: lead.created_at ?? null },
          agora,
        );
        if (!d) continue;
        contar(await fecharComoPerdido(unit, kommo, lead.id, etapa, d, seco));
        await pausa();
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, etapa }, 'parados: erro num cartão — pulei');
      }
    }
  }

  // NÃO COMPARECEU: faltou há 7 dias e a franquia não tem consulta futura → EM ESPERA.
  if (podeMover()) {
    const leads = await leadsDaEtapa(kommo, funis, ETAPA.NAO_COMPARECEU);
    for (const lead of leads) {
      if (!podeMover()) break;
      resumo.avaliados++;
      try {
        const situacao = String(valorDoCampo(lead, CAMPOS_SYNC.SITUACAO) ?? '');
        if (!n(situacao).includes('nao compareceu')) continue;
        const dataFalta = epochDoCampoData(lead, CAMPOS_SYNC.DATA_CONSULTA);
        // primeiro o prazo (barato); a franquia só é consultada pra quem já passou dele
        if (!decidirFalta(dataFalta, false, agora)) continue;
        const idClient = await idClientDoLead(unit, lead.id, lead.name ?? null);
        const hist = idClient ? await historicoDoPaciente(unit, idClient) : null;
        if (!hist) {
          logger.info({ unit: unit.slug, leadId: lead.id }, 'parados: falta sem paciente achado na franquia — não movi');
          continue;
        }
        const d = decidirFalta(dataFalta, temConsultaFutura(hist.schedules, agora), agora);
        if (!d) continue;
        contar(await moverParaEspera(unit, kommo, funis, lead.id, ETAPA.NAO_COMPARECEU, d, seco));
        await pausa();
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'parados: erro num cartão de falta — pulei');
      }
    }
  }

  logger.info(resumo, 'parados: varredura da unidade');
  return resumo;
}

let rodando = false;
async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true } });
    for (const u of units) {
      if (!paradosLiberado(u.slug) || !u.kommoAccessToken || !u.kommoSubdomain) continue;
      await varrerUnidade(u).catch((err) => logger.warn({ err: String(err), unit: u.slug }, 'parados: unidade falhou'));
    }
  } finally {
    rodando = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

export function startParadosWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(
    { sweepMs: SWEEP_MS, slugs: process.env.PARADOS_SLUGS ?? '', seco: modoSeco(), maxPorVarredura: MAX_POR_VARREDURA },
    'parados worker iniciado',
  );
}

export function stopParadosWorker(): void {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
