/**
 * Copia o motivo do campo ⊘ para o "motivo da perda" do topo do cartão. Regras em `motivo-no-cabecalho.ts`.
 *
 * A cada 10 minutos, por conta Kommo: os cartões perdidos (PERDIDO e TRATAMENTO CANCELADO) que mexeram desde a
 * rodada anterior — na primeira, os dos últimos 30 dias —, do mais antigo para o mais novo. No máximo 200 gravações
 * por rodada, em lotes de 50; o que sobrar entra na próxima, que começa de onde esta parou (`proximoDesde`). O motivo que não existe na lista do Kommo é criado com o
 * mesmo texto do campo (é assim que o topo passa a mostrar o motivo da casa, e não a lista padrão do Kommo).
 *
 * Chave `motivo-no-cabecalho` na tela de Automações: desligado não faz nada; "só no papel" registra o que copiaria
 * (sem criar motivo na lista); ligado grava.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { normalizarNome } from './kommo-schema.js';
import { carregarFunis } from './franquia-sync-worker.js';
import { PERDIDO, planejarMotivoNoCabecalho, proximoDesde, type FunilDoMotivo } from './motivo-no-cabecalho.js';

const ID = 'motivo-no-cabecalho';
const ALVO = 'Motivo da perda (topo do cartão)';
const SWEEP_MS = 10 * 60_000;
const PRIMEIRA_VARREDURA_MS = 3 * 60_000;
const JANELA_INICIAL_S = 30 * 86_400;
const FOLGA_S = 120;
const MAX_PAGINAS = 20;
const POR_PAGINA = 250;
const MAX_GRAVACOES_POR_RODADA = 200;
/** O Kommo aceita até 50 cartões num PATCH. */
const LOTE = 50;
const PAUSA_ENTRE_LOTES_MS = 500;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
/** Por slug: de quando (epoch s) a próxima rodada lê. */
const desdeDe = new Map<string, number>();

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_LOTES_MS));
const estado = (slug: string) => estadoDaAutomacao(slug, ID, process.env.MOTIVO_NO_CABECALHO_SLUGS);

/** Id do motivo na lista do Kommo pelo nome; cria se não existir. null = não deu (fica para a próxima rodada). */
async function idDoMotivo(kommo: KommoClient, unit: Unit, porNome: Map<string, number>, nome: string): Promise<number | null> {
  const chave = normalizarNome(nome);
  const id = porNome.get(chave);
  if (id) return id;
  const criado = await kommo.createLossReason(nome);
  if (!criado) return null;
  porNome.set(chave, criado.id);
  logger.info({ unit: unit.slug, motivo: nome, id: criado.id }, `${ID}: motivo criado na lista do Kommo`);
  return criado.id;
}

async function varrerConta(unit: Unit, seco: boolean): Promise<void> {
  const kommo = createKommoClient(unit);
  const funis = await carregarFunis(kommo);
  if (!funis) return;
  const etapas = [{ pipelineId: funis.comercialId, statusId: PERDIDO }];
  if (funis.tratamentoId) etapas.push({ pipelineId: funis.tratamentoId, statusId: PERDIDO });
  const funilDe = (pipelineId: number): FunilDoMotivo | null =>
    pipelineId === funis.comercialId ? 'COMERCIAL' : pipelineId === funis.tratamentoId ? 'TRATAMENTO' : null;

  const inicio = Math.floor(Date.now() / 1000);
  const desde = (desdeDe.get(unit.slug) ?? inicio - JANELA_INICIAL_S) - FOLGA_S;
  const leads: KommoLead[] = [];
  let completo = false;
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const lote = await kommo.listLeadsDasEtapasDesde(etapas, desde, page);
    leads.push(...lote);
    if (lote.length < POR_PAGINA) {
      completo = true;
      break;
    }
  }

  const planos = leads
    .map((l) => ({ lead: l, motivo: planejarMotivoNoCabecalho(l, funilDe(l.pipeline_id)) }))
    .filter((p): p is { lead: KommoLead; motivo: string } => p.motivo !== null);
  const entram = planos.slice(0, MAX_GRAVACOES_POR_RODADA);
  const proximo = proximoDesde({ inicio, completo, sobra: planos[MAX_GRAVACOES_POR_RODADA]?.lead, ultimo: leads[leads.length - 1] });

  if (seco) {
    for (const p of entram) registrarSimulacao(unit, ID, { leadId: p.lead.id, acao: 'gravaria', alvo: ALVO, valor: p.motivo, motivo: 'copiado do campo ⊘' });
    desdeDe.set(unit.slug, proximo);
    if (entram.length) logger.info({ unit: unit.slug, seco, copiaria: planos.length, registrados: entram.length }, `${ID}: varredura`);
    return;
  }

  const porNome = new Map((await kommo.listLossReasons()).map((m) => [normalizarNome(m.name), m.id]));
  const fila: Array<{ id: number; loss_reason_id: number }> = [];
  let erros = 0;
  for (const p of entram) {
    const lossId = await idDoMotivo(kommo, unit, porNome, p.motivo).catch((err) => {
      logger.warn({ err: String(err), unit: unit.slug, motivo: p.motivo }, `${ID}: não consegui criar o motivo`);
      return null;
    });
    if (lossId) fila.push({ id: p.lead.id, loss_reason_id: lossId });
    else erros++;
  }
  let gravados = 0;
  for (let i = 0; i < fila.length; i += LOTE) {
    const lote = fila.slice(i, i + LOTE);
    try {
      await kommo.atualizarLeadsEmLote(lote);
      gravados += lote.length;
    } catch (err) {
      // um cartão ruim (apagado, mexido no meio) derruba o PATCH inteiro: grava um a um pra isolar
      logger.warn({ err: String(err), unit: unit.slug, cartoes: lote.length }, `${ID}: lote recusado — gravando um a um`);
      for (const item of lote) {
        try {
          await kommo.atualizarLeadsEmLote([item]);
          gravados++;
        } catch (e) {
          erros++;
          logger.warn({ err: String(e), unit: unit.slug, leadId: item.id }, `${ID}: falha ao gravar`);
        }
      }
    }
    await pausa();
  }
  // erro não segura a janela: o cartão volta quando mexer de novo (senão um motivo recusado relia 20 páginas pra sempre)
  desdeDe.set(unit.slug, proximo);
  if (gravados || erros) logger.info({ unit: unit.slug, gravados, erros, pendentes: planos.length - entram.length }, `${ID}: varredura`);
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
    // Uma varredura por CONTA Kommo: a primeira unidade da conta com a chave ligada (ou em seco) faz pelas irmãs.
    const porConta = new Map<string, Unit>();
    for (const u of units) {
      const conta = u.kommoSubdomain?.trim().toLowerCase();
      if (!conta || !u.kommoAccessToken || porConta.has(conta) || estado(u.slug) === 'desligado') continue;
      porConta.set(conta, u);
    }
    for (const u of units) if (estado(u.slug) === 'desligado') desdeDe.delete(u.slug); // religar recomeça os 30 dias
    for (const unit of porConta.values()) {
      await varrerConta(unit, estado(unit.slug) === 'seco').catch((err) => logger.warn({ err: String(err), unit: unit.slug }, `${ID}: varredura falhou`));
    }
  } finally {
    rodando = false;
  }
}

export function startMotivoNoCabecalhoWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(`${ID}: worker iniciado`);
}

export function stopMotivoNoCabecalhoWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
