/**
 * "🤖 Passar para a Sofia" — a parte que mexe em banco e Kommo (as regras puras estão em `ponte-passar-sofia.ts`).
 *
 * Ordem: confere o cartão e a etapa → tira a pausa (a do banco e a caixinha "Pausar IA") → guarda o histórico da tela
 * na memória do lead → libera a Sofia neste lead por 12 h (fura só a trava de horário) → abre o turno pelo MESMO
 * caminho do atendimento adiado (`iniciarTurnoAdiado`), com todas as travas do `processAgent`. Sem fala pendente do
 * paciente, não abre turno: a Sofia responde quando ele escrever.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient } from '../services/kommo.service.js';
import { retomarLead } from './pausa-lead.js';
import { iniciadorDoTurno, type IniciaTurno } from './atendimento-adiado.js';
import { fusoDaUnidade } from './fuso.js';
import { LIBERADA_POR_MS, dividirFalas, juntarNaMemoria, liberadaAgora, montarHistorico, notaDoHistorico, INSTRUCAO_CONTINUAR, type PedidoDePassagem } from './ponte-passar-sofia.js';

/** A trava de horário pergunta isto só quando a IA está FORA do horário. Erro de banco = não liberada (fica como era). */
export async function conversaLiberadaPelaEquipe(unitId: string, leadId: number): Promise<boolean> {
  try {
    const c = await prisma.conversation.findUnique({
      where: { unitId_leadId: { unitId, leadId: String(leadId) } },
      select: { liberadaAte: true },
    });
    return liberadaAgora(c?.liberadaAte);
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId }, 'conversaLiberadaPelaEquipe: falha — fica a trava de horário');
    return false;
  }
}

export type ResultadoDaPassagem =
  | { ok: true; turno: 'iniciado' | 'aguardando' | 'recente'; liberadaAte: string; falasGuardadas: number; pendentes: number; nota: boolean }
  | { ok: false; motivo: 'etapa'; erro: string };

export interface DepsDaPassagem {
  kommo: KommoClient;
  agora(): Date;
  iniciar: IniciaTurno | null;
}

function quandoLocal(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', '');
}

/**
 * Turno aberto pela Ponte há pouco: o `processAgent` não aplica a trava "a equipe falou, a Sofia para" nele (foi a equipe
 * que passou), e um 2º clique em seguida não abre outro turno (não manda duas mensagens). Mesmo processo: o turno
 * adiado roda no coalescer de quem recebeu o pedido.
 */
const passadosAgora = new Map<string, number>();
const JANELA_DO_TURNO_DA_PONTE_MS = 3 * 60_000;
export function passadoPelaPonteAgora(unitId: string, leadId: number, agora = Date.now()): boolean {
  const t = passadosAgora.get(`${unitId}:${leadId}`);
  return !!t && agora - t < JANELA_DO_TURNO_DA_PONTE_MS;
}

/** Dois cliques seguidos (ou duas atendentes) no mesmo cartão viram UMA passagem. */
const emAndamento = new Map<string, Promise<ResultadoDaPassagem>>();

export function passarParaASofia(unit: Unit, pedido: PedidoDePassagem, deps?: Partial<DepsDaPassagem>): Promise<ResultadoDaPassagem> {
  const k = `${unit.id}:${pedido.leadId}`;
  const ja = emAndamento.get(k);
  if (ja) return ja;
  const p = passar(unit, pedido, {
    kommo: deps?.kommo ?? createKommoClient(unit),
    agora: deps?.agora ?? (() => new Date()),
    iniciar: deps?.iniciar !== undefined ? deps.iniciar : iniciadorDoTurno(),
  }).finally(() => emAndamento.delete(k));
  emAndamento.set(k, p);
  return p;
}

async function passar(unit: Unit, pedido: PedidoDePassagem, deps: DepsDaPassagem): Promise<ResultadoDaPassagem> {
  const { leadId } = pedido;
  const lead = await deps.kommo.getLead(leadId);
  const permitidas = unit.kommoAllowedStatusIds ?? [];
  if (permitidas.length && !permitidas.includes(lead.status_id)) {
    return { ok: false, motivo: 'etapa', erro: 'A Sofia não atende na etapa em que este cartão está. Mova o cartão para uma etapa da Sofia (ex.: EM QUALIFICAÇÃO) e tente de novo.' };
  }

  // 1) pausa: a do banco (Ponte/widget/pausa-equipe) e a caixinha "Pausar IA" — a atendente pediu, então desmarca mesmo se foi ela que marcou
  await retomarLead(unit, leadId, pedido.por ?? 'Ponte');
  if (unit.kommoPausedFieldId && (await deps.kommo.isLeadFieldChecked(leadId, unit.kommoPausedFieldId))) {
    await deps.kommo.setLeadFieldFlag(leadId, unit.kommoPausedFieldId, false);
  }

  // 2) histórico da tela → memória do lead (o bloco que o prompt da Sofia lê). As falas pendentes vão como a fala do turno.
  const { anteriores, pendentes } = dividirFalas(pedido.falas);
  const agora = deps.agora();
  const contexto = pendentes.length ? anteriores : pedido.falas;
  if (contexto.length) {
    const historico = montarHistorico(contexto, quandoLocal(agora, fusoDaUnidade(unit)), pedido.por);
    const atual = await prisma.leadMemory.findUnique({ where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } }, select: { summary: true } });
    const summary = juntarNaMemoria(atual?.summary, historico);
    await prisma.leadMemory.upsert({
      where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
      create: { unitId: unit.id, leadId: String(leadId), summary },
      update: { summary },
    });
  }

  // 2b) a mesma conversa vira NOTA no cartão: o Kommo (Lite) não tem o histórico antigo e a equipe também precisa ler.
  //     Falha na nota não impede a passagem.
  let nota = false;
  if (pedido.falas.length) {
    nota = await deps.kommo
      .addLeadNote(leadId, notaDoHistorico(pedido.falas, quandoLocal(agora, fusoDaUnidade(unit)), pedido.por, 'tela'))
      .then((r) => !!r?.id, (err) => {
        logger.warn({ err: String(err), unit: unit.slug, leadId }, 'ponte: não consegui pôr a nota do histórico no cartão (segue)');
        return false;
      });
  }

  // 3) libera a Sofia neste lead (só fura a trava de horário)
  const liberadaAte = new Date(agora.getTime() + LIBERADA_POR_MS);
  await prisma.conversation.upsert({
    where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
    create: { unitId: unit.id, leadId: String(leadId), channel: 'kommo_chat', liberadaAte },
    update: { liberadaAte },
  });

  const base = { liberadaAte: liberadaAte.toISOString(), falasGuardadas: contexto.length, pendentes: pendentes.length, nota };
  // 4) o turno: responde o que o paciente mandou; se a última fala é da clínica, a Sofia CONTINUA a conversa (13/11, João)
  if (!deps.iniciar) {
    logger.warn({ unit: unit.slug, leadId }, 'ponte: passar para a Sofia sem iniciador de turno — ela responde quando o paciente escrever');
    return { ok: true, turno: 'aguardando', ...base };
  }
  const k = `${unit.id}:${leadId}`;
  if (passadoPelaPonteAgora(unit.id, leadId, agora.getTime())) {
    logger.info({ unit: unit.slug, leadId }, 'ponte: passado de novo em menos de 3 min — não abre outro turno');
    return { ok: true, turno: 'recente', ...base };
  }
  passadosAgora.set(k, agora.getTime());
  if (passadosAgora.size > 2_000) passadosAgora.clear();
  const contactId = lead._embedded?.contacts?.find((c) => c.is_main)?.id ?? lead._embedded?.contacts?.[0]?.id ?? null;
  const textos = pendentes.length ? pendentes : [INSTRUCAO_CONTINUAR];
  await deps.iniciar({ unit, leadId, textos, desde: agora, contactId, telefone: null, via: 'ponte' });
  logger.info({ unit: unit.slug, leadId, ...base }, 'ponte: conversa passada para a Sofia — turno iniciado');
  return { ok: true, turno: 'iniciado', ...base };
}
