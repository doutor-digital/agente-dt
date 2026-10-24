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
import { avisosDoAmbiente, freiosDoAmbiente } from './disparo/freios.js';
import { rodarUnidade, type OndaNoLote } from './disparo/lote.js';
import { portoReal } from './disparo/porto.js';
import { definicaoDaOnda } from './disparo/onda.js';
import { leadsQuePediramSair } from './disparo/publico.js';

const PASSO_MS = Number(process.env.DISPARO_PASSO_MS) > 0 ? Number(process.env.DISPARO_PASSO_MS) : 60_000;
/** Por quanto tempo depois do envio ainda procuramos um SAIR. */
const HORAS_OLHANDO_SAIR = 72;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

let ultimaVarreduraDeSair = 0;
/** A busca por SAIR lê texto de mensagem: de 10 em 10 minutos basta (a reconferência na hora do envio é a que protege). */
const VARRER_SAIR_A_CADA_MS = Number(process.env.DISPARO_SAIR_A_CADA_MS) > 0 ? Number(process.env.DISPARO_SAIR_A_CADA_MS) : 600_000;
/** Montagem que passou disto sem terminar morreu junto com o processo (deploy): cancela com o motivo em vez de ficar "montando…" para sempre. */
const MONTAGEM_PRESA_MS = 30 * 60_000;

/** Quem recebeu e DEPOIS escreveu SAIR vira `saiu` — é isso que alimenta o freio por SAIR. */
export async function varrerSaidas(unidades: ReadonlyMap<string, Unit>, agora = Date.now()): Promise<number> {
  if (agora - ultimaVarreduraDeSair < VARRER_SAIR_A_CADA_MS) return 0;
  ultimaVarreduraDeSair = agora;
  const enviados = await prisma.disparoDestinatario.findMany({
    // 'falhou' COM enviadoEm é o envio incerto (timeout, processo que caiu): se a pessoa respondeu SAIR depois, a mensagem chegou.
    where: { estado: { in: ['enviado', 'falhou'] }, kommoLeadId: { not: null }, enviadoEm: { gte: new Date(agora - HORAS_OLHANDO_SAIR * 3_600_000) } },
    select: { id: true, unitId: true, kommoLeadId: true, enviadoEm: true },
  });
  let marcados = 0;
  const porUnidade = new Map<string, typeof enviados>();
  for (const e of enviados) porUnidade.set(e.unitId, [...(porUnidade.get(e.unitId) ?? []), e]);
  for (const [unitId, lista] of porUnidade) {
    const unit = unidades.get(unitId) ?? (await prisma.unit.findUnique({ where: { id: unitId } }));
    if (!unit) continue;
    const desde = new Date(Math.min(...lista.map((e) => e.enviadoEm!.getTime())));
    const sairam = await leadsQuePediramSair(unit, lista.map((e) => e.kommoLeadId as number), desde);
    // Só vale o pedido feito DEPOIS do envio dessa pessoa: quem já tinha pedido antes foi barrado na reconferência.
    const ids = lista.filter((e) => (sairam.get(e.kommoLeadId as number)?.getTime() ?? 0) >= e.enviadoEm!.getTime()).map((e) => e.id);
    if (ids.length === 0) continue;
    const r = await prisma.disparoDestinatario.updateMany({ where: { id: { in: ids }, estado: { in: ['enviado', 'falhou'] } }, data: { estado: 'saiu', motivo: 'respondeu SAIR depois do envio' } });
    marcados += r.count;
  }
  return marcados;
}

/** Um `enviando` que passou disto morreu com o processo. Não dá para saber se saiu: fica registrado como INCERTO (conta no teto, nunca é reenviado). */
const ENVIO_PRESO_MS = 15 * 60_000;

export async function fecharEnviosPresos(agora = Date.now()): Promise<number> {
  const r = await prisma.disparoDestinatario.updateMany({
    where: { estado: 'enviando', enviadoEm: { lt: new Date(agora - ENVIO_PRESO_MS) } },
    data: { estado: 'falhou', motivo: 'INCERTO: o processo caiu durante o envio. Confira no WhatsApp antes de mandar de novo (nunca reenviado sozinho)' },
  });
  return r.count;
}

export async function cancelarMontagensPresas(agora = Date.now()): Promise<number> {
  const r = await prisma.disparoOnda.updateMany({
    where: { estado: 'montando', criadoEm: { lt: new Date(agora - MONTAGEM_PRESA_MS) } },
    data: { estado: 'cancelada', pausaMotivo: 'a montagem foi interrompida (reinício do servidor?): monte a onda de novo' },
  });
  return r.count;
}

export async function rodadaDoDisparo(): Promise<void> {
  const presos = await fecharEnviosPresos();
  if (presos > 0) logger.warn({ presos }, 'disparo: envios que ficaram no meio (processo caiu) foram marcados como INCERTOS');
  const presas = await cancelarMontagensPresas();
  if (presas > 0) logger.warn({ presas }, 'disparo: montagens interrompidas foram canceladas');
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
  logger.info({ passoMs: PASSO_MS, freios: freiosDoAmbiente() }, 'disparo de campanha: worker ligado (cada unidade nasce em modo seco)');
  for (const aviso of avisosDoAmbiente()) logger.warn(aviso);
}

export function stopDisparoWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
