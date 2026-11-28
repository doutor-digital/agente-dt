/**
 * A Sofia só leva o cartão para AGENDADO DEPOIS de marcar a consulta.
 *
 * O caso (Salto, lead 5478545, 27/11/2026 21:05–21:07): a paciente deu o nome e a cidade, a Sofia chamou `mover_etapa` para AGENDADO
 * (113199875) no mesmo turno em que anotava os campos — ainda sem consulta. Às 21:06 ofereceu "segunda 30/11 às 09h ou 14h". Dois
 * minutos depois o sincronizador da franquia (franquia-revisao) olhou o cartão: AGENDADO sem «◷ Data da Consulta» e paciente que a
 * franquia não conhece → CONFERIR NA FRANQUIA (113199871), que NÃO está nas etapas em que a Sofia atende em Salto. A paciente perguntou
 * "Quanto é a consulta?" e ficou sem resposta ("IA não responde nesta etapa").
 *
 * São DOIS escritores da mesma etapa lendo fontes diferentes: a Sofia escreve AGENDADO pelo que a conversa PROMETE, a franquia lê pelo
 * que EXISTE. Enquanto a Sofia afirmar uma consulta que não existe, a franquia vai desmentir — e o desmentido tira a Sofia da conversa.
 * O prompt já diz "SÓ DEPOIS de a consulta ser marcada com sucesso"; o modelo nem sempre obedece (Salto, 7 dias: 15 movimentos para
 * AGENDADO, 3 sem consulta marcada; rede: 4 cartões voltaram de AGENDADO para CONFERIR). Esta porta faz valer no código.
 *
 * O QUE FAZ: no `mover_etapa`, destino = a etapa `scheduled_meeting` da unidade, unidade com franquia ligada, e nenhuma evidência de
 * consulta — nem o passo «Consulta marcada:» no rastro deste cartão (gravado só depois de a franquia aceitar), nem «◷ Data da Consulta»
 * com data de agora em diante no cartão — devolve RECUSADO à IA. Marcou depois? A próxima chamada passa.
 *
 * O QUE NÃO FAZ: só vale onde o ESCRITOR CONCORRENTE está de fato escrevendo — franquia ligada, `franquia-move` e `franquia-revisao` LIGADOS
 * (em "só no papel" ou desligados ninguém desmente o cartão, e recusar tiraria da Sofia um movimento legítimo). Não mexe em unidade sem
 * franquia (lá AGENDADO é a única prova que existe), nem em outra etapa. Falha ABERTA: se não
 * deu para ler o rastro ou o cartão, deixa mover como sempre foi — recusar por erro de leitura prenderia a Sofia em quem de fato marcou.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import type { KommoLead } from '../services/kommo.service.js';
import { aguardarMarcacaoDaIa } from './marcacao-da-ia-no-turno.js';
import { automacaoLigada } from './automacoes-estado.js';
import { estadoDoMove } from './franquia-move.js';

/** Quanto tempo atrás o passo «Consulta marcada:» ainda vale como prova de que o cartão tem consulta (remarcação e ciclo longo cabem aqui). */
const PROVA_DA_MARCACAO_DIAS = 45;

/** O cartão com «◷ Data da Consulta» de ontem para cá ainda "tem consulta"; mais velho que isso é de outro ciclo. */
const FOLGA_DA_DATA_MS = 12 * 3600_000;

/** A etapa AGENDADO da unidade (a `scheduled_meeting` do mapa de intenções), ou null se a unidade não tem. */
export function etapaAgendadoDaUnidade(unit: Pick<Unit, 'pipelineIntents'> | null | undefined): number | null {
  const intents = unit?.pipelineIntents as Record<string, unknown> | null | undefined;
  const n = Number(intents?.scheduled_meeting);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface DepsAgendadoSoDepoisDeMarcar {
  /** A franquia está MOVENDO cartão nesta unidade (move e revisão ligados, nenhum dos dois em seco)? Só aí AGENDADO sem consulta é desmentido. */
  franquiaDesmenteOCartao: (slug: string) => boolean;
  /**
   * A marcação deu certo NESTE turno? As tools rodam em paralelo (ToolNode): o modelo pode pedir `agendar_consulta` e `mover_etapa` na
   * mesma rodada, e o passo «Consulta marcada:» só nasce quando a franquia responde — por isso espera a marcação em curso (com teto).
   * Medido em 30 dias: 2 de 19 movimentos «sem consulta» eram marcações que terminaram DEPOIS do pedido de mover.
   */
  marcouNesteTurno: () => Promise<boolean>;
  /** A Sofia já marcou consulta neste cartão (passo «Consulta marcada:»)? Lança se não leu. */
  marcouPelaSofia: (unitId: string, leadId: number) => Promise<boolean>;
  /** O cartão como está agora. Lança se não leu. */
  lerCartao: (leadId: number) => Promise<Pick<KommoLead, 'custom_fields_values'>>;
  /** «◷ Data da Consulta» do cartão de `desde` em diante? */
  cartaoTemConsulta: (lead: Pick<KommoLead, 'custom_fields_values'>, desde: Date) => Promise<boolean>;
  agora: () => Date;
}

/**
 * O passo «Consulta marcada:» só prova consulta VIVA se a data marcada não passou (uma consulta de 20 dias atrás, cancelada ou faltada,
 * não pode liberar o AGENDADO do paciente que voltou). A data vai no `payload.data` (AAAA-MM-DD, comparável como texto).
 */
export async function marcouPelaSofiaNoRastro(unitId: string, leadId: number, agora: Date = new Date()): Promise<boolean> {
  const desde = new Date(agora.getTime() - PROVA_DA_MARCACAO_DIAS * 86_400_000);
  const ontem = new Date(agora.getTime() - 86_400_000).toISOString().slice(0, 10);
  const linhas = await prisma.$queryRaw<Array<{ n: bigint }>>`
    select count(*) as n
      from execution_steps s
      join execution_traces t on t.id = s.trace_id
     where t.unit_id = ${unitId}
       and t.lead_id = ${String(leadId)}
       and s.title like 'Consulta marcada:%'
       and s.created_at > ${desde}
       and (s.payload->>'data') >= ${ontem}`;
  return Number(linhas[0]?.n ?? 0) > 0;
}

export const TEXTO_RECUSA_AGENDADO =
  'RECUSADO: este cartão ainda não tem consulta marcada, então não vai para AGENDADO. Etapa AGENDADO é só para consulta que ' +
  '`agendar_consulta` já confirmou — se o cartão for para lá sem consulta, o sincronizador da franquia o tira de lá em minutos ' +
  'e você perde a conversa. Continue atendendo normalmente (ofereça horários, tire a dúvida do paciente); depois de marcar com ' +
  'sucesso, chame `mover_etapa` de novo.';

/**
 * `null` = pode mover. Texto = RECUSADO (devolvido à IA). Nunca lança.
 */
export async function recusaDeAgendadoSemConsulta(
  args: { unit: Unit | null | undefined; leadId: number; statusId: number },
  deps: DepsAgendadoSoDepoisDeMarcar,
): Promise<{ texto: string; motivo: string } | null> {
  const { unit, leadId, statusId } = args;
  if (!unit?.spineEnabled) return null;
  if (!deps.franquiaDesmenteOCartao(unit.slug)) return null;
  const agendado = etapaAgendadoDaUnidade(unit);
  if (!agendado || statusId !== agendado) return null;
  try {
    if (await deps.marcouNesteTurno()) return null;
    if (await deps.marcouPelaSofia(unit.id, leadId)) return null;
    const cartao = await deps.lerCartao(leadId);
    const desde = new Date(deps.agora().getTime() - FOLGA_DA_DATA_MS);
    if (await deps.cartaoTemConsulta(cartao, desde)) return null;
    return { texto: TEXTO_RECUSA_AGENDADO, motivo: 'AGENDADO sem consulta marcada (nem passo «Consulta marcada:» nem «◷ Data da Consulta» no cartão)' };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId, statusId }, 'agendado-so-depois-de-marcar: não consegui conferir — deixo mover como sempre');
    return null;
  }
}

/** As dependências de produção. `lerCartao` recebe o `kommo` do turno e `traceId` é o do turno (a marcação em curso é por turno). */
export function depsDeProducao(kommo: { getLead(id: number): Promise<KommoLead> }, traceId: string): DepsAgendadoSoDepoisDeMarcar {
  return {
    franquiaDesmenteOCartao: (slug) =>
      automacaoLigada(slug, 'franquia-revisao', process.env.FRANQUIA_REVISAO_SLUGS) && estadoDoMove(slug) === 'ligado',
    marcouNesteTurno: () => aguardarMarcacaoDaIa(traceId),
    marcouPelaSofia: (unitId, leadId) => marcouPelaSofiaNoRastro(unitId, leadId),
    lerCartao: (leadId) => kommo.getLead(leadId),
    // import tardio: evita ciclo agent ↔ workers (o vigia importa o cliente do Kommo e a franquia)
    cartaoTemConsulta: async (lead, desde) => (await import('./agendamento-perdido-worker.js')).cartaoTemConsulta(lead, desde, 0),
    agora: () => new Date(),
  };
}
