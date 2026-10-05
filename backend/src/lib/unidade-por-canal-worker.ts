/**
 * Marca no cartão a unidade de atendimento pelo número de WhatsApp — Petrópolis × Caxias no mesmo Kommo.
 * Regras em `unidade-por-canal.ts`.
 *
 * A cada 5 minutos lê as conversas da conta (as mais novas primeiro), agrupa por cartão e marca o campo
 * "⌂ Unidade de atendimento" e a etiqueta da cidade. Não depende da Sofia: a unidade pode ainda não ter IA.
 *
 * Chave `unidade-por-canal` na tela de Automações: desligado não faz nada; "só no papel" registra o que
 * gravaria na lista "o que ela faria"; ligado grava (só em campo vazio).
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoTalk } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { CAMPO_UNIDADE, CANAIS_POR_UNIDADE, planejarUnidade } from './unidade-por-canal.js';

const SWEEP_MS = 5 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;
/** 4 páginas de 250 conversas cobrem com folga o movimento de 5 minutos e o histórico de Petrópolis. */
const MAX_PAGINAS = 4;
const PAUSA_ENTRE_ESCRITAS_MS = 300;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

async function varrerUnidade(slug: string, mapa: Record<number, string>): Promise<void> {
  const estado = estadoDaAutomacao(slug, 'unidade-por-canal', process.env.UNIDADE_POR_CANAL_SLUGS);
  if (estado === 'desligado') return;
  const seco = estado === 'seco';

  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit?.kommoAccessToken) return;
  const kommo = createKommoClient(unit);

  const campos = await kommo.listLeadCustomFieldsTyped();
  const campo = campos.find((f) => f.name === CAMPO_UNIDADE);
  if (!campo) {
    logger.warn({ unit: slug }, `unidade-por-canal: a conta não tem o campo "${CAMPO_UNIDADE}"`);
    return;
  }

  const conversas = await kommo.listarConversas(MAX_PAGINAS);
  const porCartao = new Map<number, KommoTalk[]>();
  const desconhecidos = new Set<number>();
  for (const t of conversas) {
    if (t.entity_type !== 'lead' || !t.entity_id) continue;
    if (typeof t.source_id === 'number' && mapa[t.source_id] === undefined) desconhecidos.add(t.source_id);
    const lista = porCartao.get(t.entity_id) ?? [];
    lista.push(t);
    porCartao.set(t.entity_id, lista);
  }
  if (desconhecidos.size) {
    // número novo conectado na conta: não decide nada até alguém pôr no mapa
    logger.warn({ unit: slug, canais: [...desconhecidos] }, 'unidade-por-canal: conversa por canal fora do mapa — não marquei');
  }
  if (porCartao.size === 0) return;

  const leads = await kommo.listLeadsPorIds([...porCartao.keys()]);
  const resumo = { gravados: 0, confere: 0, diverge: 0, erros: 0 };
  for (const lead of leads) {
    const atual = lead.custom_fields_values?.find((f) => f.field_id === campo.id)?.values?.[0]?.value;
    const noCartao = atual === undefined || atual === null || String(atual).trim() === '' ? null : String(atual);
    const etiquetas = (lead._embedded?.tags ?? []).map((t) => t.name);
    const planejar = (ts: KommoTalk[]) =>
      planejarUnidade({ conversas: ts.map((t) => ({ sourceId: t.source_id, criadaEm: t.created_at })), mapa, noCartao, etiquetas });
    let plano = planejar(porCartao.get(lead.id) ?? []);
    if (!plano) continue;
    // Vai gravar: confirma a PRIMEIRA conversa com o histórico inteiro do cartão. A janela da varredura
    // (as conversas mais recentes da conta) pode não alcançar a conversa antiga de quem voltou pelo outro número.
    if (plano.acao === 'gravar') {
      const todas = await kommo.listTalks(lead.id).catch(() => null);
      if (todas?.length) plano = planejar(todas);
      if (!plano) continue;
    }

    if (plano.acao !== 'gravar') {
      resumo[plano.acao]++;
      registrarSimulacao(unit, 'unidade-por-canal', { leadId: lead.id, acao: plano.acao, alvo: CAMPO_UNIDADE, valor: plano.unidade, noCartao: plano.noCartao, motivo: plano.motivo });
      // a etiqueta acompanha o campo: põe a que falta mesmo quando o campo já estava preenchido
      if (plano.etiqueta && !seco) {
        await kommo.addTag({ leadId: lead.id, tag: plano.etiqueta }).catch((err) => {
          resumo.erros++;
          logger.warn({ err: String(err), unit: slug, leadId: lead.id }, 'unidade-por-canal: falha ao pôr a etiqueta');
        });
        await pausa();
      }
      continue;
    }

    if (seco) {
      registrarSimulacao(unit, 'unidade-por-canal', { leadId: lead.id, acao: 'gravaria', alvo: CAMPO_UNIDADE, valor: plano.unidade, motivo: plano.motivo });
      continue;
    }
    try {
      await kommo.setLeadCustomFieldValue(lead.id, campo.id, campo.type, plano.unidade, campo.enums);
      await kommo.addTag({ leadId: lead.id, tag: plano.etiqueta });
      resumo.gravados++;
      logger.info({ unit: slug, leadId: lead.id, unidade: plano.unidade, motivo: plano.motivo }, 'unidade-por-canal: unidade marcada');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: slug, leadId: lead.id }, 'unidade-por-canal: falha ao marcar');
    }
    await pausa();
  }
  if (resumo.gravados || resumo.diverge || resumo.erros) logger.info({ unit: slug, seco, ...resumo }, 'unidade-por-canal: varredura');
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    for (const [slug, mapa] of Object.entries(CANAIS_POR_UNIDADE)) {
      await varrerUnidade(slug, mapa).catch((err) => logger.warn({ err: String(err), unit: slug }, 'unidade-por-canal: varredura falhou'));
    }
  } finally {
    rodando = false;
  }
}

export function startUnidadePorCanalWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('unidade-por-canal: worker iniciado');
}

export function stopUnidadePorCanalWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
