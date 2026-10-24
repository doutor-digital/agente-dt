/**
 * Worker do disparo de campanha: a cada minuto pega as ondas APROVADAS e roda uma rodada por unidade.
 *
 * Roda no líder (worker-lease), como os outros. Mesmo assim cada pessoa é "reivindicada" no banco antes do envio
 * (pendente → enviando, atômico): se dois processos rodarem juntos (o lease abre sem banco, ver `worker-lease.ts`),
 * quem perde a disputa não manda. O estado da unidade vem do catálogo de automações (`disparo-campanha`) e NASCE em
 * "só no papel" para a rede toda — ver `lote.ts` para a trava.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { fusoDaUnidade } from './fuso.js';
import { freiosDoAmbiente } from './disparo/freios.js';
import { rodarUnidade, type OndaNoLote } from './disparo/lote.js';
import { portoReal } from './disparo/porto.js';
import { definicaoDaOnda } from './disparo/onda.js';
import { leadsQuePediramSair } from './disparo/publico.js';

const PASSO_MS = Number(process.env.DISPARO_PASSO_MS) > 0 ? Number(process.env.DISPARO_PASSO_MS) : 60_000;
/** Por quanto tempo depois do envio ainda procuramos um SAIR. */
const HORAS_OLHANDO_SAIR = 72;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** Quem recebeu e depois escreveu SAIR vira `saiu` — é isso que alimenta o freio por SAIR. */
export async function varrerSaidas(unidades: ReadonlyMap<string, Unit>): Promise<number> {
  const enviados = await prisma.disparoDestinatario.findMany({
    where: { estado: 'enviado', kommoLeadId: { not: null }, enviadoEm: { gte: new Date(Date.now() - HORAS_OLHANDO_SAIR * 3_600_000) } },
    select: { id: true, unitId: true, kommoLeadId: true },
  });
  let marcados = 0;
  const porUnidade = new Map<string, typeof enviados>();
  for (const e of enviados) porUnidade.set(e.unitId, [...(porUnidade.get(e.unitId) ?? []), e]);
  for (const [unitId, lista] of porUnidade) {
    const unit = unidades.get(unitId) ?? (await prisma.unit.findUnique({ where: { id: unitId } }));
    if (!unit) continue;
    const sairam = await leadsQuePediramSair(unit, lista.map((e) => e.kommoLeadId as number));
    const ids = lista.filter((e) => sairam.has(e.kommoLeadId as number)).map((e) => e.id);
    if (ids.length === 0) continue;
    const r = await prisma.disparoDestinatario.updateMany({ where: { id: { in: ids }, estado: 'enviado' }, data: { estado: 'saiu', motivo: 'respondeu SAIR depois do envio' } });
    marcados += r.count;
  }
  return marcados;
}

export async function rodadaDoDisparo(): Promise<void> {
  const ondas = await prisma.disparoOnda.findMany({ where: { estado: 'aprovada' }, orderBy: { criadoEm: 'asc' }, include: { unit: true } });
  if (ondas.length === 0) return;
  const unidades = new Map<string, Unit>(ondas.map((o) => [o.unitId, o.unit]));
  const f = freiosDoAmbiente();
  const porto = portoReal(unidades);

  const marcados = await varrerSaidas(unidades).catch((err) => {
    logger.warn({ err: String(err) }, 'disparo: varredura de SAIR falhou');
    return 0;
  });
  if (marcados > 0) logger.warn({ marcados }, 'disparo: pessoas responderam SAIR depois do envio');

  for (const unitId of new Set(ondas.map((o) => o.unitId))) {
    const deste = ondas.filter((o) => o.unitId === unitId);
    const unit = deste[0]!.unit;
    // As ondas pausadas na varredura acima já saíram da lista na próxima leitura; aqui reconfere o estado.
    const vivas = await prisma.disparoOnda.findMany({ where: { id: { in: deste.map((o) => o.id) }, estado: 'aprovada' }, orderBy: { criadoEm: 'asc' } });
    if (vivas.length === 0) continue;
    try {
      const noLote: OndaNoLote[] = vivas.map((o) => ({ id: o.id, campanhaId: o.campanhaId, aprovadaEm: o.aprovadaEm, ...definicaoDaOnda(o) }));
      const r = await rodarUnidade(porto, f, { id: unit.id, slug: unit.slug, nome: unit.name, fuso: fusoDaUnidade(unit) }, noLote);
      if (r.processados > 0 || (r.parou && r.parou !== 'automação desligada nesta unidade')) logger.info({ unit: unit.slug, ...r }, 'disparo: rodada');
    } catch (err) {
      logger.error({ err: String(err), unit: unit.slug }, 'disparo: a rodada da unidade falhou');
    }
  }
}

async function talvezRodar(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    await rodadaDoDisparo();
  } catch (err) {
    logger.error({ err: String(err) }, 'disparo: rodada falhou');
  } finally {
    rodando = false;
  }
}

export function startDisparoWorker(): void {
  if (timer) return;
  timer = setInterval(() => void talvezRodar(), PASSO_MS);
  logger.info({ passoMs: PASSO_MS }, 'disparo de campanha: worker ligado (cada unidade nasce em modo seco)');
}

export function stopDisparoWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
