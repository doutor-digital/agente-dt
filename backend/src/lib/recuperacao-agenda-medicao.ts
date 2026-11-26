/**
 * A MEDIÇÃO do retorno da lista de recuperação (26/11/2026). Parte PURA + o carregador.
 *
 * Pergunta: dos pacientes que apareceram na lista, quantos voltaram a marcar em até X dias, e quantos compareceram? Comparado com o que
 * já acontecia ANTES da lista (rede, piso medido em 26/11: 11% dos desmarcados e 3% dos faltosos voltam).
 *
 * COMO LER (a ressalva faz parte do número):
 *  - É CORRELAÇÃO. Quem voltou depois de aparecer na lista pode ter voltado sozinho, ou porque a recepção ligou por outro motivo. O
 *    número não prova que a ligação causou a volta. O que o aproxima de uma prova é a comparação com o «seco»: as listas geradas em
 *    «só no papel» (ninguém recebeu) são o grupo de comparação, medido do mesmo jeito, na mesma unidade e na mesma época. Sem seco da
 *    mesma época, só resta comparar com a base da rede, que é um piso e de outro período.
 *  - «Remarcou» = apareceu, depois da lista e dentro da janela, um agendamento NOVO do mesmo paciente (mesma unidade, mesmo nome) para
 *    o mesmo dia da lista ou depois, ou o mesmo agendamento voltou a ficar marcado para uma data de hoje em diante. Reativar o mesmo
 *    horário que já passou é correção de registro, não retorno: conta à parte.
 *  - O paciente é reconhecido pelo NOME normalizado (a agenda da franquia não traz o id): homônimos se misturam.
 *  - Só conta janela COMPLETA: quem foi listado há menos de X dias ainda está em observação e fica fora da taxa.
 *  - O histórico só existe desde que a chave foi ligada na unidade (`historicoDesde`). Antes disso é «sem dado», nunca zero.
 */
import { prisma } from './prisma.js';
import { SPINE_STATUS } from '../services/spine.service.js';

export const JANELA_PADRAO_DIAS = 30;
export const JANELA_MAXIMA_DIAS = 90;

/** O que a rede já tinha ANTES da lista (cópia da agenda do Dash, 16/07 a 26/11/2026; «voltou» = mesmo nome, mesma unidade; é um PISO). */
export const BASE_DA_REDE = {
  desmarque: 0.11,
  falta: 0.03,
  fonte:
    'Rede, antes da lista: 78 de 702 avaliações desmarcadas e 6 de 174 faltas tiveram nova consulta na mesma unidade (cópia da agenda do Dash, 16/07 a 26/11/2026). É um piso: a cópia não guarda a agenda futura e o casamento é pelo nome.',
};

const DIA_MS = 86_400_000;
/**
 * Até onde a varredura enxerga o futuro (`DIAS_FRENTE` do sincronizador). Um agendamento que aparece pela primeira vez DEPOIS da lista
 * pode ser só um que já existia e entrou na janela; só o que cai dentro deste horizonte a partir da lista é visto na hora em que nasce.
 */
export const HORIZONTE_DOS_AGENDAMENTOS_DIAS = 45;
const MARCADO = new Set<number>([SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO, SPINE_STATUS.ATENDIDO]);
const DE_PE = new Set<number>([SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO]);

export interface ItemMedido {
  idSchedule: number;
  pacienteChave: string;
  tipo: string;
  modo: string;
  listadoEm: Date;
}

export interface EventoMedido {
  idSchedule: number;
  pacienteChave: string;
  deStatus: number | null;
  paraStatus: number | null;
  inicioEm: Date;
  vistoEm: Date;
}

export type GrupoDaMedicao = 'desmarque' | 'falta';

export interface NumerosDoGrupo {
  listados: number;
  /** listados há pelo menos a janela inteira: a taxa só olha estes */
  comJanelaCompleta: number;
  remarcaram: number;
  compareceram: number;
  /** listados há menos que a janela: ainda podem voltar */
  emObservacao: number;
  /** dos que estão em observação, quantos já remarcaram (não entra na taxa) */
  remarcaramEmObservacao: number;
  /** o mesmo horário que já tinha passado voltou a ficar marcado/atendido: o registro foi corrigido, não é retorno */
  correcoesDeRegistro: number;
  taxaRemarcou: number | null;
  taxaCompareceu: number | null;
}

const vazio = (): NumerosDoGrupo => ({
  listados: 0, comJanelaCompleta: 0, remarcaram: 0, compareceram: 0, emObservacao: 0, remarcaramEmObservacao: 0, correcoesDeRegistro: 0, taxaRemarcou: null, taxaCompareceu: null,
});

const grupoDoTipo = (tipo: string): GrupoDaMedicao => (tipo === 'faltou' ? 'falta' : 'desmarque');
const razao = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

interface Desfecho {
  remarcou: boolean;
  compareceu: boolean;
  correcao: boolean;
}

/** PURO. O que aconteceu com UM item da lista, olhando os eventos do mesmo paciente depois da lista e dentro da janela. Não depende da ordem em que vêm. */
export function desfechoDoItem(item: ItemMedido, eventos: ReadonlyArray<EventoMedido>, janelaDias: number): Desfecho {
  const fim = item.listadoEm.getTime() + janelaDias * DIA_MS;
  const doPaciente = eventos
    .filter((e) => e.pacienteChave === item.pacienteChave && e.vistoEm.getTime() > item.listadoEm.getTime())
    .sort((a, b) => a.vistoEm.getTime() - b.vistoEm.getTime());
  const dentro = doPaciente.filter((e) => e.vistoEm.getTime() <= fim);

  // 1. agendamento NOVO (primeira vez visto depois da lista) para o dia da lista ou depois
  const novos = dentro.filter(
    (e) => e.idSchedule !== item.idSchedule && e.deStatus === null && e.paraStatus !== null && MARCADO.has(e.paraStatus) &&
      e.inicioEm.getTime() >= item.listadoEm.getTime() && e.inicioEm.getTime() <= item.listadoEm.getTime() + HORIZONTE_DOS_AGENDAMENTOS_DIAS * DIA_MS,
  );
  // 2. o mesmo agendamento voltou a ficar de pé, para uma data de hoje em diante (remarcado)
  const mesmos = dentro.filter(
    (e) => e.idSchedule === item.idSchedule && e.paraStatus !== null && DE_PE.has(e.paraStatus) && e.inicioEm.getTime() >= item.listadoEm.getTime(),
  );
  const marcacoes = [...novos, ...mesmos];
  if (marcacoes.length > 0) {
    // compareceu = ALGUM dos agendamentos que ele marcou depois da lista foi atendido (marcou A, desmarcou A, marcou B e foi a B conta)
    const primeira = marcacoes.reduce((m, e) => Math.min(m, e.vistoEm.getTime()), Infinity);
    const ids = new Set(marcacoes.map((e) => e.idSchedule));
    // só o que foi visto DENTRO da janela: contar o atendimento depois dela faria o número crescer para sempre, e dois períodos iguais dariam taxas diferentes conforme a data da consulta
    const atendido = dentro.some((e) => ids.has(e.idSchedule) && e.paraStatus === SPINE_STATUS.ATENDIDO && e.vistoEm.getTime() >= primeira);
    return { remarcou: true, compareceu: atendido, correcao: false };
  }
  // 3. o mesmo horário que já tinha passado foi reativado: correção do registro
  const correcao = dentro.some((e) => e.idSchedule === item.idSchedule && e.paraStatus !== null && MARCADO.has(e.paraStatus));
  return { remarcou: false, compareceu: false, correcao };
}

export interface ResumoDaMedicao {
  porModo: Record<string, { desmarque: NumerosDoGrupo; falta: NumerosDoGrupo; total: NumerosDoGrupo }>;
}

/** PURO. Os números por modo («ligado» = a recepção recebeu; «seco» = só no papel, o grupo de comparação) e por grupo (desmarque, falta). */
export function medirRetorno(itens: ReadonlyArray<ItemMedido>, eventos: ReadonlyArray<EventoMedido>, agora: Date, janelaDias: number): ResumoDaMedicao {
  const porModo: ResumoDaMedicao['porModo'] = {};
  const doPaciente = new Map<string, EventoMedido[]>();
  for (const e of eventos) {
    const l = doPaciente.get(e.pacienteChave) ?? [];
    l.push(e);
    doPaciente.set(e.pacienteChave, l);
  }
  for (const item of itens) {
    const alvo = (porModo[item.modo] ??= { desmarque: vazio(), falta: vazio(), total: vazio() });
    const d = desfechoDoItem(item, doPaciente.get(item.pacienteChave) ?? [], janelaDias);
    const completa = agora.getTime() >= item.listadoEm.getTime() + janelaDias * DIA_MS;
    for (const n of [alvo[grupoDoTipo(item.tipo)], alvo.total]) {
      n.listados++;
      if (d.correcao) n.correcoesDeRegistro++;
      if (completa) {
        n.comJanelaCompleta++;
        if (d.remarcou) n.remarcaram++;
        if (d.compareceu) n.compareceram++;
      } else {
        n.emObservacao++;
        if (d.remarcou) n.remarcaramEmObservacao++;
      }
    }
  }
  for (const m of Object.values(porModo)) {
    for (const n of [m.desmarque, m.falta, m.total]) {
      n.taxaRemarcou = razao(n.remarcaram, n.comJanelaCompleta);
      n.taxaCompareceu = razao(n.compareceram, n.comJanelaCompleta);
    }
  }
  return { porModo };
}

// ── o carregador (banco) ───────────────────────────────────────────────────────────────────────

export interface MedicaoDaUnidade {
  unidade: string;
  periodo: { inicio: string; fim: string };
  janelaDias: number;
  /** o primeiro evento que o histórico guardou nesta unidade (null = a chave nunca registrou nada) */
  historicoDesde: string | null;
  eventosNoHistorico: number;
  /** a lista que apareceu/foi simulada no período */
  /** `incertos`: a Evolution não respondeu (pode não ter chegado à recepção) — contam como listados, e aparecem aqui para quem lê o número */
  listas: { dias: number; itens: number; incertos: number };
  resultado: ResumoDaMedicao['porModo'] | null;
  /** quando não há como medir, o motivo — nunca um zero */
  semDado?: string;
}

/** Carrega e mede UMA unidade (`unitId`/`slug`). `inicio`/`fim` = dias AAAA-MM-DD da LISTA (em UTC, pelo instante em que foi gerada). */
export async function medirUnidade(a: { unitId: string; slug: string; inicio: string; fim: string; janelaDias: number; agora?: Date }): Promise<MedicaoDaUnidade> {
  const agora = a.agora ?? new Date();
  const de = new Date(`${a.inicio}T00:00:00.000Z`);
  const ate = new Date(new Date(`${a.fim}T00:00:00.000Z`).getTime() + DIA_MS);
  const base = { unidade: a.slug, periodo: { inicio: a.inicio, fim: a.fim }, janelaDias: a.janelaDias };

  const [primeiro, total, itensDb] = await Promise.all([
    prisma.agendaStatusEvento.findFirst({ where: { unitId: a.unitId }, orderBy: { vistoEm: 'asc' }, select: { vistoEm: true } }),
    prisma.agendaStatusEvento.count({ where: { unitId: a.unitId } }),
    prisma.agendaRecuperacaoItem.findMany({
      // «pendente» (a Evolution recusou), «sem_destino» e «enviando» (ainda no meio) não chegaram à recepção: não entram na conta
      where: { unitId: a.unitId, listadoEm: { gte: de, lt: ate }, NOT: { envio: { in: ['pendente', 'sem_destino', 'enviando'] } } },
      select: { idSchedule: true, pacienteChave: true, tipo: true, modo: true, listadoEm: true, dia: true, envio: true },
    }),
  ]);
  const historicoDesde = primeiro?.vistoEm.toISOString().slice(0, 10) ?? null;
  const listas = { dias: new Set(itensDb.map((i) => i.dia)).size, itens: itensDb.length, incertos: itensDb.filter((i) => i.envio === 'incerto').length };
  if (total === 0) {
    return { ...base, historicoDesde, eventosNoHistorico: 0, listas, resultado: null, semDado: 'o histórico da agenda ainda não registrou nada nesta unidade (a chave «recuperacao-agenda» nunca esteve em «só no papel» ou ligada aqui)' };
  }
  if (itensDb.length === 0) {
    return { ...base, historicoDesde, eventosNoHistorico: total, listas, resultado: null, semDado: 'nenhuma lista foi gerada (nem simulada) neste período' };
  }
  const chaves = [...new Set(itensDb.map((i) => i.pacienteChave))];
  const desde = new Date(Math.min(...itensDb.map((i) => i.listadoEm.getTime())));
  const eventos = await prisma.agendaStatusEvento.findMany({
    where: { unitId: a.unitId, pacienteChave: { in: chaves }, vistoEm: { gt: desde } },
    select: { idSchedule: true, pacienteChave: true, deStatus: true, paraStatus: true, inicioEm: true, vistoEm: true },
    orderBy: [{ vistoEm: 'asc' }, { id: 'asc' }],
  });
  return { ...base, historicoDesde, eventosNoHistorico: total, listas, resultado: medirRetorno(itensDb, eventos, agora, a.janelaDias).porModo };
}
