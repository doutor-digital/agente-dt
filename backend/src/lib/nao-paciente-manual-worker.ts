/**
 * Varredura do NÃO-PACIENTE marcado pela equipe — ver `nao-paciente-manual.ts` (o porquê, o que faz e como desfazer).
 * A cada 10 min, por unidade com a chave `nao-paciente-manual` fora de "desligado". Em "só no papel" não escreve nada: registra o
 * que faria na tela. Teto de 20 cartões por unidade por rodada.
 *
 * Retomada (revisão do sênior, PR #395): a marca PENDENTE entra antes de qualquer escrita e a FEITO só no fim. Falhou no meio
 * (429 do Kommo, queda)? A próxima rodada vê a PENDENTE e refaz do começo — a etiqueta é idempotente, e o cartão que ficou na
 * etapa de passagem também é varrido (só com a PENDENTE) e volta para PERDIDO.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { motivoDaSdrNoCartao } from './parados.js';
import { etiquetaDeNaoContatar } from './sofia-fecha-quente-morno.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { ETIQUETA_CURRICULO, funilComercial, statusPerdidoDoFunil } from './nao-paciente.js';
import { ID_NAO_PACIENTE_MANUAL as ID, MOTIVO_PARADA_NAO_PACIENTE, etapaDeReentrada, planoNaoPaciente } from './nao-paciente-manual.js';

const SWEEP_MS = 10 * 60_000;
const PRIMEIRA_VARREDURA_MS = 3 * 60_000;
const JANELA_S = 72 * 3600;
const TETO_POR_RODADA = 20;
const MAX_PAGINAS = 10;
const POR_PAGINA = 250;
const PAUSA_REENTRADA_MS = 1500;
const ESPERAS_DA_VOLTA_MS = [2000, 5000];
const MARCA_PENDENTE = 'nao_paciente_manual:pendente';
const MARCA_FEITO = 'nao_paciente_manual:feito';
const JANELA_DAS_MARCAS_MS = 30 * 24 * 3600_000;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
const dorme = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Todas as páginas (até 10 × 250): o filtro é por updated_at crescente, e o cartão recém-marcado fica no FIM da lista. */
async function cartoesDaJanela(kommo: KommoClient, etapas: Array<{ pipelineId: number; statusId: number }>, desde: number): Promise<KommoLead[]> {
  const todos: KommoLead[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const lote = await kommo.listLeadsDasEtapasDesde(etapas, desde, pagina);
    todos.push(...lote);
    if (lote.length < POR_PAGINA) return todos;
  }
  logger.warn({ etapas, paginas: MAX_PAGINAS }, `${ID}: janela com mais de ${MAX_PAGINAS * POR_PAGINA} cartões — os mais novos ficam de fora até os antigos saírem das 72 h`);
  return todos;
}

/** O que a varredura precisa de fora — injetável para o teste (Kommo e banco falsos). */
export interface DepsDoNaoPaciente {
  kommo: Pick<KommoClient, 'addTag' | 'setLeadPipeline' | 'addLeadNote'>;
  avisoRecente: (unitId: string, leadId: number, chave: string, janelaMs: number) => Promise<boolean>;
  marcarAviso: (unitId: string, leadId: number, chave: string) => Promise<void>;
  /** grava a parada de não-paciente nas conversas do cartão; devolve quantas */
  marcarConversas: (unitId: string, leadId: number) => Promise<number>;
  simular: (unit: { id: string; slug: string }, leadId: number, valor: string) => void;
  dorme: (ms: number) => Promise<void>;
}

export interface ContextoDoNaoPaciente {
  unit: { id: string; slug: string };
  seco: boolean;
  comercialId: number;
  perdido: number;
  reentrada: number | null;
  naoContatar: string;
}

export interface ResumoDoNaoPaciente {
  feitos: number;
  simulados: number;
  falhas: number;
}

/** Volta para PERDIDO com 3 tentativas: o cliente do Kommo não repete 429, e cartão preso na etapa de passagem é o pior caso. */
async function voltarParaPerdido(ctx: ContextoDoNaoPaciente, deps: DepsDoNaoPaciente, leadId: number): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await deps.kommo.setLeadPipeline(leadId, ctx.comercialId, ctx.perdido);
      return;
    } catch (err) {
      if (i >= ESPERAS_DA_VOLTA_MS.length) throw err;
      await deps.dorme(ESPERAS_DA_VOLTA_MS[i]);
    }
  }
}

/**
 * O coração da varredura, sem Kommo nem banco de verdade (testável).
 *
 * COM a etapa de passagem, TODO cartão com o motivo e sem a FEITO sai e volta de PERDIDO — tenha ou não a etiqueta. O código não
 * sabe se a etiqueta entrou antes ou depois do PERDIDO, e a régua só é cancelada se ela já estava lá no evento (revisão do sênior,
 * PR #395: a equipe põe a etiqueta à mão minutos depois de perder). Com a etiqueta já posta, sair e voltar não dispara nada.
 * SEM a etapa, quem já tem a etiqueta só ganha a memória do telefone.
 */
export async function tratarCartoes(ctx: ContextoDoNaoPaciente, leads: ReadonlyArray<KommoLead>, deps: DepsDoNaoPaciente): Promise<ResumoDoNaoPaciente> {
  const r: ResumoDoNaoPaciente = { feitos: 0, simulados: 0, falhas: 0 };
  const { unit } = ctx;
  for (const lead of leads) {
    if (r.feitos >= TETO_POR_RODADA) break;
    const tags = (lead._embedded?.tags ?? []).map((t) => t.name ?? '');
    const plano = planoNaoPaciente({ motivo: motivoDaSdrNoCartao(lead.custom_fields_values), tags, naoContatar: ctx.naoContatar });
    if (plano === 'nada') continue;
    const noPerdido = lead.status_id === ctx.perdido;

    try {
      if (await deps.avisoRecente(unit.id, lead.id, MARCA_FEITO, JANELA_DAS_MARCAS_MS)) continue;
      const pendente = await deps.avisoRecente(unit.id, lead.id, MARCA_PENDENTE, JANELA_DAS_MARCAS_MS);
      // na etapa de passagem, só o cartão que ESTA automação deixou lá (pendente); o resto é da equipe
      if (!noPerdido && !pendente) continue;

      if (plano === 'so_conversa' && !pendente && !ctx.reentrada) {
        // sem etapa de passagem não há como cancelar a régua: só falta a memória do telefone
        if (!ctx.seco) {
          await deps.marcarConversas(unit.id, lead.id);
          await deps.marcarAviso(unit.id, lead.id, MARCA_FEITO);
        }
        continue;
      }

      if (ctx.seco) {
        r.simulados++;
        deps.simular(unit, lead.id, `${ctx.naoContatar} + ${ETIQUETA_CURRICULO}${ctx.reentrada ? ` e sai/volta de PERDIDO (etapa ${ctx.reentrada})` : ''}`);
        continue;
      }

      r.feitos++;
      await deps.marcarAviso(unit.id, lead.id, MARCA_PENDENTE);
      // a memória do telefone primeiro: se o Kommo falhar depois, a Sofia e a cutucada já respeitam
      const conversas = await deps.marcarConversas(unit.id, lead.id);
      const jaTinha = plano === 'so_conversa';
      if (!jaTinha) await deps.kommo.addTag({ leadId: lead.id, tags: [ctx.naoContatar, ETIQUETA_CURRICULO] });
      let reentrou = false;
      if (ctx.reentrada) {
        // o gatilho de PERDIDO lê a etiqueta no evento: sair e voltar faz ele ler de novo, agora com a etiqueta
        if (noPerdido) {
          await deps.kommo.setLeadPipeline(lead.id, ctx.comercialId, ctx.reentrada);
          await deps.dorme(PAUSA_REENTRADA_MS);
        }
        await voltarParaPerdido(ctx, deps, lead.id);
        reentrou = true;
      }
      await deps.marcarAviso(unit.id, lead.id, MARCA_FEITO);

      // a nota diz só o que aconteceu de fato
      const partes = [
        jaTinha
          ? `🤫 Não é paciente (marcado pela equipe): o cartão já tinha ${ctx.naoContatar}.`
          : `🤫 Não é paciente (marcado pela equipe): pus ${ctx.naoContatar} e ${ETIQUETA_CURRICULO}.`,
        reentrou
          ? 'O cartão saiu e voltou de PERDIDO para a régua de PERDIDO ler a etiqueta (a mensagem de 48 h não deve sair).'
          : 'ATENÇÃO: esta unidade não tem a etapa de passagem configurada; a régua de PERDIDO já agendada pode mandar mensagem.',
        conversas > 0
          ? 'Este telefone fica marcado: a Sofia e a cutucada não falam com ele, nem em cartão novo.'
          : 'Não achei a conversa deste cartão no nosso banco: o TELEFONE não ficou marcado (um cartão novo dele ainda recebe a Sofia).',
      ];
      await deps.kommo.addLeadNote(lead.id, partes.join(' ')).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, `${ID}: nota não gravada`));
      logger.info({ unit: unit.slug, leadId: lead.id, reentrou, conversas }, `${ID}: não-paciente marcado pela equipe — etiquetado`);
    } catch (err) {
      r.falhas++;
      // a PENDENTE fica: a próxima rodada refaz (inclusive tira da etapa de passagem)
      logger.error({ err: String(err), unit: unit.slug, leadId: lead.id }, `${ID}: falhou no cartão — refaço na próxima rodada`);
    }
  }
  return r;
}

async function varrerUnidade(unit: Unit): Promise<void> {
  const estado = estadoDaAutomacao(unit.slug, ID, process.env.NAO_PACIENTE_MANUAL_SLUGS);
  if (estado === 'desligado') return;
  const kommo = createKommoClient(unit);
  const comercial = funilComercial(await kommo.listPipelines());
  const perdido = comercial ? statusPerdidoDoFunil(comercial.statuses ?? []) : null;
  if (!comercial || !perdido) return;
  const reentrada = etapaDeReentrada(unit.pipelineIntents);

  const etapas = [{ pipelineId: comercial.id, statusId: perdido }, ...(reentrada ? [{ pipelineId: comercial.id, statusId: reentrada }] : [])];
  const leads = await cartoesDaJanela(kommo, etapas, Math.floor(Date.now() / 1000) - JANELA_S);
  if (!leads.length) return;

  const ctx: ContextoDoNaoPaciente = { unit, seco: estado !== 'ligado', comercialId: comercial.id, perdido, reentrada, naoContatar: await etiquetaDeNaoContatar(unit, kommo) };
  const r = await tratarCartoes(ctx, leads, {
    kommo,
    avisoRecente: (u, l, c, j) => avisoRecente(u, l, c, j),
    marcarAviso: (u, l, c) => marcarAviso(u, l, c),
    marcarConversas: async (u, l) =>
      (await prisma.conversation.updateMany({ where: { unitId: u, leadId: String(l) }, data: { followUpStoppedReason: MOTIVO_PARADA_NAO_PACIENTE } })).count,
    simular: (un, leadId, valor) =>
      registrarSimulacao(un, ID, { leadId, acao: 'etiquetaria', alvo: 'etiqueta', valor, motivo: 'PERDIDO "Não é paciente (currículo)": a régua de PERDIDO mandaria mensagem' }),
    dorme,
  });
  if (r.feitos || r.simulados || r.falhas) logger.info({ unit: unit.slug, ...r }, `${ID}: varredura`);
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { isActive: true, kommoAccessToken: { not: null }, kommoSubdomain: { not: null } } });
    for (const unit of unidades) {
      if (estadoDaAutomacao(unit.slug, ID, process.env.NAO_PACIENTE_MANUAL_SLUGS) === 'desligado') continue;
      await varrerUnidade(unit).catch((err) => logger.warn({ err: String(err), unit: unit.slug }, `${ID}: varredura falhou`));
    }
  } finally {
    rodando = false;
  }
}

export function startNaoPacienteManualWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(`${ID}: worker iniciado`);
}

export function stopNaoPacienteManualWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
