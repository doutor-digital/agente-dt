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
  modelosV2,
  type ModelosV2,
  type Decisao,
} from './etiquetas-auto.js';

/**
 * Varre as unidades com "Etiquetas ▶ automáticas" ligada ou em "só no papel" e aplica as regras de
 * `etiquetas-auto.ts`. Ligado = põe a etiqueta (o bot do Kommo manda a mensagem) e deixa uma nota no
 * cartão; seco = só registra "etiquetaria"/"pularia" pra tela de Automações.
 *
 * Um cartão recebe cada etiqueta UMA vez por motivo (a chave da decisão: o GANHO, o retorno daquela
 * data, a perda daquele dia). A marca é um rastro em `execution_traces` por decisão, gravada ANTES
 * da etiqueta: se a marca não grava, a etiqueta não sai — o erro fica do lado de não mandar, nunca
 * do lado de mandar a mesma mensagem a cada varredura.
 */

const ID = 'etiquetas-auto';
const SWEEP_MS = Number(process.env.ETIQUETAS_AUTO_SWEEP_MS) || 15 * 60_000;
/** Teto por unidade e varredura: se algo estiver errado, erra em 20 pacientes, não em 300. */
const MAX_POR_VARREDURA = Number(process.env.ETIQUETAS_AUTO_MAX) || 20;
const PAGINAS_RETORNO = 4;
const MARCA = 'ETIQUETA ·';
const DIA_S = 86_400;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

export function estadoDasEtiquetas(slug: string, raw: string | undefined = process.env.ETIQUETAS_AUTO_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID, raw);
}

/** Um rastro por decisão: `execution_steps` tem (trace, sequence) único — um por cartão colidiria. */
const idDoRastro = (unitId: string, d: Decisao) => `etiqueta-${unitId}-${d.chave}`;

async function jaFeitas(unitId: string, decisoes: Decisao[]): Promise<Set<string>> {
  if (decisoes.length === 0) return new Set();
  const ids = decisoes.map((d) => idDoRastro(unitId, d));
  const achados = await prisma.executionTrace.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return new Set(achados.map((t) => t.id));
}

/** Grava a marca. `false` = não gravou, e então a etiqueta NÃO deve sair. */
async function marcar(unitId: string, leadId: number, d: Decisao): Promise<boolean> {
  const id = idDoRastro(unitId, d);
  try {
    await prisma.executionTrace.create({
      data: {
        id,
        unitId,
        leadId: String(leadId),
        threadId: id,
        input: { origem: 'etiquetas-auto' },
        channel: 'manual',
        status: 'SUCCESS',
        steps: {
          create: {
            sequence: 0,
            kind: 'KOMMO_ACTION',
            title: `${MARCA} ${d.etiqueta} — ${d.motivo}`,
            payload: { leadId, etiqueta: d.etiqueta, chave: d.chave, motivo: d.motivo },
          },
        },
      },
    });
    return true;
  } catch (err) {
    logger.warn({ err: String(err), leadId, chave: d.chave }, 'etiquetas: não gravei a marca — etiqueta não sai');
    return false;
  }
}

async function desmarcar(unitId: string, d: Decisao): Promise<void> {
  await prisma.executionTrace.delete({ where: { id: idDoRastro(unitId, d) } }).catch(() => undefined);
}

/** Última mensagem que o sistema viu em cada cartão (epoch s). */
async function ultimasConversas(unitId: string, leadIds: number[]): Promise<Map<number, number>> {
  if (leadIds.length === 0) return new Map();
  const linhas = await prisma.conversation.findMany({
    where: { unitId, leadId: { in: leadIds.map(String) } },
    select: { leadId: true, lastMessageAt: true },
  });
  return new Map(linhas.map((l) => [Number(l.leadId), Math.floor(l.lastMessageAt.getTime() / 1000)]));
}

/**
 * Quem volta a escrever depois que todos os cartões fecharam ganha um cartão NOVO no Kommo — a
 * conversa de hoje não aparece no cartão perdido. Antes de reativar, olha os outros cartões do
 * contato: cartão aberto depois da perda, ou conversa nos últimos 30 dias, cancela.
 */
async function voltouEmOutroCartao(
  unitId: string,
  kommo: KommoClient,
  lead: KommoLead,
  perdeu: number,
  agora: number,
): Promise<string | null> {
  const contatos = lead._embedded?.contacts ?? [];
  const principal = (contatos.find((c) => c.is_main) ?? contatos[0])?.id;
  if (!principal) return null;
  const ids = await kommo.leadsDoContato(principal);
  if (ids === null) return 'não consegui ler os outros cartões do contato — tenta na próxima';
  const outros = ids.filter((id) => id !== lead.id);
  if (outros.length === 0) return null;
  const cartoes = await kommo.listLeadsPorIds(outros);
  const novo = cartoes.find((c) => (c.created_at ?? 0) > perdeu);
  if (novo) return `voltou em outro cartão (${novo.id})`;
  const conversas = await ultimasConversas(unitId, outros);
  const recente = [...conversas.values()].find((t) => agora - t < DIAS_REATIVACAO * DIA_S);
  return recente ? 'conversou em outro cartão nos últimos 30 dias' : null;
}

/** Aprovação de modelo muda raramente: uma leitura por unidade a cada hora basta. */
const MODELOS_VALIDADE_MS = 3600_000;
const SEM_V2: ModelosV2 = { boasVindas: false, retorno: false, reativacao: false };
const modelosCache = new Map<string, { em: number; v2: ModelosV2 }>();

/** Quais `_v2` a unidade tem aprovadas. Falha de leitura NÃO fica no cache: tenta de novo na próxima. */
async function v2DaUnidade(unit: Unit, kommo: KommoClient): Promise<ModelosV2> {
  const c = modelosCache.get(unit.id);
  if (c && Date.now() - c.em < MODELOS_VALIDADE_MS) return c.v2;
  try {
    const v2 = modelosV2(await kommo.listChatTemplates());
    modelosCache.set(unit.id, { em: Date.now(), v2 });
    return v2;
  } catch (err) {
    // Sem a lista, vale o modelo original (pula): mas avisa, senão "pularia" parece regra e é falha.
    logger.warn({ err: String(err), unit: unit.slug }, 'etiquetas: não li os modelos — segue valendo o modelo original');
    return SEM_V2;
  }
}

async function decisoesDaUnidade(unit: Unit, kommo: KommoClient): Promise<Array<{ lead: KommoLead; d: Decisao }>> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const comercial = esquema.pipelinePorNome('COMERCIAL');
  if (!comercial) {
    logger.warn({ unit: unit.slug }, 'etiquetas: funil COMERCIAL não achado — nada a fazer');
    return [];
  }
  const agora = Math.floor(Date.now() / 1000);
  const v2 = await v2DaUnidade(unit, kommo);
  const saida: Array<{ lead: KommoLead; d: Decisao }> = [];
  const junta = (lead: KommoLead, d: Decisao | null) => {
    if (d) saida.push({ lead, d });
  };

  const ganhos = await kommo.listLeadsNaJanela('closed_at', agora - JANELA_GANHO_S, agora, 4, false, {
    pipelineId: comercial,
    statusId: 142,
  });
  for (const l of ganhos.leads) junta(l, decidirBoasVindas(l, agora, v2.boasVindas));

  const retorno = esquema.statusPorNome('COMERCIAL', 'RETORNO PÓS-TRATAMENTO');
  if (retorno) {
    for (let page = 1; page <= PAGINAS_RETORNO; page++) {
      const lote = await kommo.listLeadsPorEtapa(comercial, retorno, 250, page);
      for (const l of lote) junta(l, decidirConfirmarRetorno(l, agora, v2.retorno));
      if (lote.length < 250) break;
    }
  }

  const limite = DIAS_REATIVACAO * DIA_S;
  const perdidos = await kommo.listLeadsNaJanela('closed_at', agora - limite - JANELA_REATIVACAO_S, agora - limite, 4, true, {
    pipelineId: comercial,
    statusId: 143,
  });
  const conversas = await ultimasConversas(unit.id, perdidos.leads.map((l) => l.id));
  for (const l of perdidos.leads) {
    const d = decidirReativacao(l, agora, conversas.get(l.id) ?? null, v2.reativacao);
    if (d?.tipo === 'coloca') {
      const motivo = await voltouEmOutroCartao(unit.id, kommo, l, l.closed_at ?? 0, agora);
      if (motivo) {
        junta(l, { tipo: 'pula', etiqueta: d.etiqueta, chave: d.chave, motivo });
        continue;
      }
    }
    junta(l, d);
  }

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

  if (estado === 'seco') {
    for (const { lead, d } of decisoes) {
      registrarSimulacao(unit, ID, {
        leadId: lead.id,
        acao: d.tipo === 'coloca' ? 'etiquetaria' : 'pularia',
        alvo: d.etiqueta,
        motivo: d.motivo,
      });
    }
    return;
  }

  const aPor = decisoes.filter((x) => x.d.tipo === 'coloca');
  const feitas = await jaFeitas(unit.id, aPor.map((x) => x.d));
  let postas = 0;
  for (const { lead, d } of aPor) {
    if (feitas.has(idDoRastro(unit.id, d))) continue;
    if (postas >= MAX_POR_VARREDURA) {
      logger.warn({ unit: unit.slug, max: MAX_POR_VARREDURA }, 'etiquetas: teto da varredura — o resto fica pra próxima');
      break;
    }
    if (!(await marcar(unit.id, lead.id, d))) continue;
    try {
      // O gatilho do Kommo é "etiqueta ADICIONADA": se a de um retorno anterior ainda está lá, tira antes.
      if (d.tipo === 'coloca' && d.reaplica) await kommo.removeTag(lead.id, d.etiqueta);
      await kommo.addTag({ leadId: lead.id, tag: d.etiqueta });
    } catch (err) {
      // Não saiu: tira a marca pra próxima varredura tentar de novo.
      await desmarcar(unit.id, d);
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, etiqueta: d.etiqueta }, 'etiquetas: falha ao pôr etiqueta');
      continue;
    }
    postas++;
    await kommo.addLeadNote(lead.id, `🤖 Etiqueta ${d.etiqueta} colocada automaticamente — ${d.motivo}.`).catch(() => undefined);
    logger.info({ unit: unit.slug, leadId: lead.id, etiqueta: d.etiqueta, motivo: d.motivo }, 'etiquetas: etiqueta posta');
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
