import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { esquemaDaUnidade } from './kommo-schema.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import {
  DIAS_REATIVACAO,
  JANELA_GANHO_S,
  JANELA_REATIVACAO_S,
  decidirBoasVindas,
  decidirConfirmarRetorno,
  decidirReativacao,
  type Decisao,
} from './etiquetas-auto.js';

/**
 * Varre as unidades com "Etiquetas ▶ automáticas" ligada ou em "só no papel" e aplica as regras de
 * `etiquetas-auto.ts`. Ligado = põe a etiqueta (o bot do Kommo manda a mensagem) e deixa uma nota no
 * cartão; seco = só registra "etiquetaria"/"pularia" pra tela de Automações.
 *
 * Um cartão recebe cada etiqueta UMA vez por motivo (a chave da decisão: o GANHO, o retorno daquela
 * data, a perda daquele dia). A marca fica no rastro (`execution_traces`, um por decisão), como no
 * vigia de agendamento perdido, então sobrevive a deploy e a SDR tirar a etiqueta não faz ela voltar.
 */

const ID = 'etiquetas-auto';
const SWEEP_MS = Number(process.env.ETIQUETAS_AUTO_SWEEP_MS) || 15 * 60_000;
/** Teto por unidade e varredura: se algo estiver errado, erra em 20 pacientes, não em 300. */
const MAX_POR_VARREDURA = Number(process.env.ETIQUETAS_AUTO_MAX) || 20;
const PAGINAS_RETORNO = 4;
const MARCA = 'ETIQUETA ·';

let timer: NodeJS.Timeout | null = null;
let rodando = false;

export function estadoDasEtiquetas(slug: string, raw: string | undefined = process.env.ETIQUETAS_AUTO_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID, raw);
}

/**
 * Um rastro por decisão (não por cartão): `execution_steps` tem (trace, sequence) único, então um
 * rastro por cartão faria a 2ª etiqueta do mesmo cartão falhar ao gravar a marca — e repetir.
 */
const idDoRastro = (unitId: string, d: Decisao) => `etiqueta-${unitId}-${d.chave}`;

async function jaFeito(unitId: string, d: Decisao): Promise<boolean> {
  const t = await prisma.executionTrace.findUnique({ where: { id: idDoRastro(unitId, d) }, select: { id: true } });
  return t !== null;
}

async function marcarFeito(unitId: string, leadId: number, d: Decisao): Promise<void> {
  const idRastro = idDoRastro(unitId, d);
  await prisma.executionStep
    .create({
      data: {
        trace: {
          connectOrCreate: {
            where: { id: idRastro },
            create: {
              id: idRastro,
              unitId,
              leadId: String(leadId),
              threadId: idRastro,
              input: { origem: 'etiquetas-auto' },
              channel: 'manual',
            },
          },
        },
        sequence: 0,
        kind: 'KOMMO_ACTION',
        title: `${MARCA} ${d.etiqueta} — ${d.motivo}`,
        payload: { leadId, etiqueta: d.etiqueta, chave: d.chave, motivo: d.motivo },
      },
    })
    .catch((err) => logger.warn({ err: String(err), leadId, chave: d.chave }, 'etiquetas: não gravei a marca — pode repetir'));
}

/** Última mensagem que o sistema viu com cada paciente (epoch s). */
async function ultimasConversas(unitId: string, leadIds: number[]): Promise<Map<number, number>> {
  if (leadIds.length === 0) return new Map();
  const linhas = await prisma.conversation.findMany({
    where: { unitId, leadId: { in: leadIds.map(String) } },
    select: { leadId: true, lastMessageAt: true },
  });
  return new Map(linhas.map((l) => [Number(l.leadId), Math.floor(l.lastMessageAt.getTime() / 1000)]));
}

async function decisoesDaUnidade(unit: Unit, kommo: KommoClient): Promise<Array<{ lead: KommoLead; d: Decisao }>> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const comercial = esquema.pipelinePorNome('COMERCIAL');
  if (!comercial) {
    logger.warn({ unit: unit.slug }, 'etiquetas: funil COMERCIAL não achado — nada a fazer');
    return [];
  }
  const agora = Math.floor(Date.now() / 1000);
  const saida: Array<{ lead: KommoLead; d: Decisao }> = [];
  const junta = (lead: KommoLead, d: Decisao | null) => {
    if (d) saida.push({ lead, d });
  };

  const ganhos = await kommo.listLeadsFechadosEntre(comercial, 142, agora - JANELA_GANHO_S, agora);
  for (const l of ganhos.leads) junta(l, decidirBoasVindas(l, agora));

  const retorno = esquema.statusPorNome('COMERCIAL', 'RETORNO PÓS-TRATAMENTO');
  if (retorno) {
    for (let page = 1; page <= PAGINAS_RETORNO; page++) {
      const lote = await kommo.listLeadsPorEtapa(comercial, retorno, 250, page);
      for (const l of lote) junta(l, decidirConfirmarRetorno(l, agora));
      if (lote.length < 250) break;
    }
  }

  const limite = DIAS_REATIVACAO * 86_400;
  const perdidos = await kommo.listLeadsFechadosEntre(comercial, 143, agora - limite - JANELA_REATIVACAO_S, agora - limite);
  const conversas = await ultimasConversas(unit.id, perdidos.leads.map((l) => l.id));
  for (const l of perdidos.leads) junta(l, decidirReativacao(l, agora, conversas.get(l.id) ?? null));

  if (ganhos.truncado || perdidos.truncado) {
    logger.warn({ unit: unit.slug }, 'etiquetas: janela com mais de 1000 cartões — veio cortada');
  }
  return saida;
}

async function varrerUnidade(unit: Unit, estado: Estado): Promise<void> {
  let kommo: KommoClient;
  try {
    kommo = createKommoClient(unit);
  } catch {
    return;
  }
  const decisoes = await decisoesDaUnidade(unit, kommo);
  let postas = 0;
  for (const { lead, d } of decisoes) {
    if (estado === 'seco') {
      registrarSimulacao(unit, ID, {
        leadId: lead.id,
        acao: d.tipo === 'coloca' ? 'etiquetaria' : 'pularia',
        alvo: d.etiqueta,
        motivo: d.motivo,
      });
      continue;
    }
    if (d.tipo === 'pula') continue;
    if (postas >= MAX_POR_VARREDURA) {
      logger.warn({ unit: unit.slug, max: MAX_POR_VARREDURA }, 'etiquetas: teto da varredura — o resto fica pra próxima');
      break;
    }
    if (await jaFeito(unit.id, d)) continue;
    try {
      // O gatilho do Kommo é "etiqueta ADICIONADA": se a de um retorno anterior ainda está lá, tira antes.
      if (d.reaplica) await kommo.removeTag(lead.id, d.etiqueta);
      await kommo.addTag({ leadId: lead.id, tag: d.etiqueta });
      await marcarFeito(unit.id, lead.id, d);
      postas++;
      await kommo
        .addLeadNote(lead.id, `🤖 Etiqueta ${d.etiqueta} colocada automaticamente — ${d.motivo}.`)
        .catch(() => undefined);
      logger.info({ unit: unit.slug, leadId: lead.id, etiqueta: d.etiqueta, motivo: d.motivo }, 'etiquetas: etiqueta posta');
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, etiqueta: d.etiqueta }, 'etiquetas: falha ao pôr etiqueta');
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { isActive: true } });
    for (const unit of unidades) {
      const estado = estadoDasEtiquetas(unit.slug);
      if (estado === 'desligado') continue;
      try {
        await varrerUnidade(unit, estado);
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug }, 'etiquetas: varredura da unidade falhou');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'etiquetas: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startEtiquetasAutoWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  timer.unref?.();
  logger.info({ sweepMs: SWEEP_MS, max: MAX_POR_VARREDURA }, 'etiquetas ▶ automáticas: worker ligado');
}

export function stopEtiquetasAutoWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
