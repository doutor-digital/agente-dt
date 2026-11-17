/**
 * Varredura do NÃO-PACIENTE marcado pela equipe — ver `nao-paciente-manual.ts` (o porquê, o que faz e como desfazer).
 * A cada 10 min, por unidade com a chave `nao-paciente-manual` fora de "desligado". Em "só no papel" não escreve nada: registra o
 * que faria na tela. Teto de 20 cartões por unidade por rodada.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { motivoDaSdrNoCartao } from './parados.js';
import { etiquetaDeNaoContatar } from './sofia-fecha-quente-morno.js';
import { ETIQUETA_CURRICULO, funilComercial, statusPerdidoDoFunil } from './nao-paciente.js';
import { ID_NAO_PACIENTE_MANUAL as ID, MOTIVO_PARADA_NAO_PACIENTE, etapaDeReentrada, planoNaoPaciente } from './nao-paciente-manual.js';

const SWEEP_MS = 10 * 60_000;
const PRIMEIRA_VARREDURA_MS = 3 * 60_000;
const JANELA_S = 72 * 3600;
const TETO_POR_RODADA = 20;
const PAUSA_REENTRADA_MS = 1500;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
const avisados = new Set<string>();
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function varrerUnidade(unit: Unit): Promise<void> {
  const estado = estadoDaAutomacao(unit.slug, ID, process.env.NAO_PACIENTE_MANUAL_SLUGS);
  if (estado === 'desligado') return;
  const seco = estado !== 'ligado';
  const kommo = createKommoClient(unit);
  const comercial = funilComercial(await kommo.listPipelines());
  const perdido = comercial ? statusPerdidoDoFunil(comercial.statuses ?? []) : null;
  if (!comercial || !perdido) return;

  // PERDIDO do COMERCIAL que mexeu nas últimas 72 h (1 página de 250 basta: o teto da rodada é 20)
  const desde = Math.floor(Date.now() / 1000) - JANELA_S;
  const leads: KommoLead[] = await kommo.listLeadsDasEtapasDesde([{ pipelineId: comercial.id, statusId: perdido }], desde, 1);
  if (!leads.length) return;

  const naoContatar = await etiquetaDeNaoContatar(unit, kommo);
  const reentrada = etapaDeReentrada(unit.pipelineIntents);
  let feitos = 0;
  for (const lead of leads) {
    if (feitos >= TETO_POR_RODADA) break;
    const tags = (lead._embedded?.tags ?? []).map((t) => t.name ?? '');
    const plano = planoNaoPaciente({ motivo: motivoDaSdrNoCartao(lead.custom_fields_values), tags, naoContatar });
    if (plano === 'nada') continue;

    if (seco) {
      if (plano === 'etiquetar') {
        registrarSimulacao(unit, ID, {
          leadId: lead.id,
          acao: 'etiquetaria',
          alvo: 'etiqueta',
          valor: `${naoContatar} + ${ETIQUETA_CURRICULO}${reentrada ? ` e sai/volta de PERDIDO (etapa ${reentrada})` : ''}`,
          motivo: 'PERDIDO "Não é paciente (currículo)" marcado sem a etiqueta: a régua de PERDIDO mandaria mensagem',
        });
      }
      continue;
    }

    try {
      // a marca da conversa é o que faz o TELEFONE ficar de fora nos próximos cartões (Sofia e cutucada)
      await prisma.conversation.updateMany({
        where: { unitId: unit.id, leadId: String(lead.id), followUpStoppedReason: null },
        data: { followUpStoppedReason: MOTIVO_PARADA_NAO_PACIENTE },
      });
      if (plano === 'so_conversa') continue;
      feitos++;
      await kommo.addTag({ leadId: lead.id, tags: [naoContatar, ETIQUETA_CURRICULO] });
      if (reentrada) {
        // o gatilho de PERDIDO lê a etiqueta no evento: sair e voltar faz ele ler de novo, agora com a etiqueta
        await kommo.setLeadPipeline(lead.id, comercial.id, reentrada);
        await dorme(PAUSA_REENTRADA_MS);
        await kommo.setLeadPipeline(lead.id, comercial.id, perdido);
      } else if (!avisados.has(unit.slug)) {
        avisados.add(unit.slug);
        logger.warn({ unit: unit.slug }, `${ID}: sem pipeline_intents.nao_paciente_reentrada_status_id — a régua de PERDIDO que já ficou agendada pode sair`);
      }
      await kommo
        .addLeadNote(
          lead.id,
          `🤫 Não é paciente (marcado pela equipe): pus ${naoContatar} e ${ETIQUETA_CURRICULO}${reentrada ? ' e cancelei a régua de PERDIDO (o cartão saiu e voltou de PERDIDO)' : ''}. ` +
            'Este telefone não recebe mais a Sofia, a cutucada nem a régua, nem em cartão novo.',
        )
        .catch(() => undefined);
      logger.info({ unit: unit.slug, leadId: lead.id, reentrada }, `${ID}: não-paciente marcado pela equipe — etiquetado`);
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, `${ID}: falhou no cartão`);
    }
  }
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
