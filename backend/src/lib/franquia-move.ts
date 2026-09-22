/**
 * Franquia → Kommo, fase 2: MOVER etapa (a fase 1 só escrevia campos).
 *
 * Decisão do João com a chefe da DH (18/09/2026): a franquia é onde a clínica registra o que
 * aconteceu; o cartão do Kommo anda sozinho atrás do fato. As SDRs param de mover cartão.
 * Máquina de etapas, casada com o rastreio do n8n (que manda Purchase pra Meta SÓ quando o
 * cartão passa por GANHO / CONCLUÍDO no funil COMERCIAL):
 *
 *   avaliação marcada (futura)        → AGENDADO
 *   avaliação atendida                → COMPARECEU
 *   falta registrada                  → NÃO COMPARECEU
 *   atendido há 48 h sem tratamento   → EM NEGOCIAÇÃO
 *   tratamento aberto                 → GANHO / CONCLUÍDO
 *   primeira sessão atendida          → EM TRATAMENTO (funil TRATAMENTO)
 *   tratamento finalizado             → ALTA
 *
 *   tratamento cancelado              → TRATAMENTO CANCELADO        (22/09/2026)
 *   alta + retorno pós marcado        → RETORNO PÓS-TRATAMENTO      (22/09/2026, volta pro COMERCIAL)
 *   retorno pós atendido              → COMPARECEU, como avaliação  (22/09/2026)
 *
 * O que NUNCA faz: tirar cartão de PERDIDO ou TRATAMENTO CANCELADO (decisão humana); tirar de ALTA
 * ou RETORNO PÓS-TRATAMENTO por outro motivo que não o retorno acima; mover pra PERDIDO ou EM ESPERA
 * (é leitura da conversa, fica com a Sofia/SDR); mexer em cartão que está em outro funil (resgate,
 * financeiro…). Quem já teve alta tem tratamento FINALIZADO no histórico — isso não pode empurrar o
 * cartão de volta pra GANHO quando ele volta pra um retorno.
 *
 * Só nas unidades em `FRANQUIA_MOVE_SLUGS` (csv; `*` = todas). Lab primeiro, depois Imperatriz.
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { ehConsulta } from './franquia-sync.js';
import { normalizarNome } from './kommo-schema.js';

export const ETAPA = {
  INC: 'Etapa de leads de entrada',
  QUALIFICACAO: 'EM QUALIFICAÇÃO',
  ESPERA: 'EM ESPERA',
  AGENDADO: 'AGENDADO',
  NAO_COMPARECEU: 'NÃO COMPARECEU',
  COMPARECEU: 'COMPARECEU',
  NEGOCIACAO: 'EM NEGOCIAÇÃO',
  RETORNO: 'RETORNO PÓS-TRATAMENTO',
  GANHO: 'GANHO / CONCLUÍDO',
  PERDIDO: 'PERDIDO',
  EM_TRATAMENTO: 'EM TRATAMENTO',
  ALTA: 'ALTA',
  CANCELADO: 'TRATAMENTO CANCELADO',
} as const;

export type Funil = 'COMERCIAL' | 'TRATAMENTO';

export interface EtapaAtual {
  funil: Funil;
  status: string;
}

/** O que precisamos saber de um tratamento da franquia pra decidir etapa. 44 pendente · 45 em andamento · 46 finalizado. */
export interface TratamentoParaEtapa {
  idStatus: number | null;
  statusName?: string | null;
}

export interface EntradaMovimento {
  atual: EtapaAtual | null;
  /** todas as consultas (avaliação/retorno) e sessões do paciente que conhecemos */
  agendamentos: SpineSchedule[];
  tratamentos: TratamentoParaEtapa[];
  agoraEpoch: number;
  horasAteNegociacao: number;
}

export interface Movimento {
  funil: Funil;
  para: string;
  motivo: string;
}

export const TRATAMENTO_FINALIZADO = 46;

const n = normalizarNome;
const eh = (a: string, b: string) => n(a) === n(b);
const emAlgum = (status: string, lista: string[]) => lista.some((s) => eh(status, s));

/** Etapa de entrada tem nome variável ("Incoming leads", "Etapa de leads de entrada"): trata pelo padrão. */
export function ehEtapaDeEntrada(status: string): boolean {
  const s = n(status);
  return s.includes('entrada') || s.includes('incoming') || s === n(ETAPA.INC);
}

const PRE_AGENDADO = [ETAPA.QUALIFICACAO, ETAPA.ESPERA];
const INTOCAVEIS_COMERCIAL = [ETAPA.PERDIDO];
const INTOCAVEIS_TRATAMENTO = [ETAPA.CANCELADO];

/** "Retorno após tratamento" na franquia: a consulta de quem já teve alta. Categoria ≠ "Retorno" simples (que é dentro da avaliação). */
export function ehRetornoPosTratamento(s: Pick<SpineSchedule, 'categoryName'>): boolean {
  const c = n(s.categoryName ?? '');
  return c.includes('retorno') && c.includes('tratamento');
}

function epoch(s: SpineSchedule): number | null {
  if (!s.dateAttendanceUtc) return null;
  const t = Math.floor(Date.parse(s.dateAttendanceUtc) / 1000);
  return Number.isFinite(t) ? t : null;
}

function ehSessao(s: SpineSchedule): boolean {
  const c = n(s.categoryName ?? '');
  return !!c && !ehConsulta(s);
}

export const TRATAMENTO_EM_ANDAMENTO = 45;

function finalizado(t: TratamentoParaEtapa): boolean {
  return t.idStatus === TRATAMENTO_FINALIZADO || /finaliz|conclu|alta/.test(n(t.statusName ?? ''));
}

function cancelado(t: TratamentoParaEtapa): boolean {
  return /cancel/.test(n(t.statusName ?? ''));
}

/**
 * 45 EM ANDAMENTO (ou nome equivalente). Um tratamento só PENDENTE (44, proposta sem pagamento)
 * não segura a ALTA. Sem id nem nome (veio do /treatments/search cru) assume em andamento, que é
 * o que aquela rota devolve.
 */
function emAndamento(t: TratamentoParaEtapa): boolean {
  if (finalizado(t) || cancelado(t)) return false;
  const nome = n(t.statusName ?? '');
  if (t.idStatus === TRATAMENTO_EM_ANDAMENTO) return true;
  if (nome) return /andamento|ativo/.test(nome);
  return t.idStatus === null;
}

export const TRATAMENTO_PENDENTE = 44;

/**
 * Tratamento "aberto" na franquia (pendente ou em andamento): é o que leva o cartão pra GANHO.
 * Cancelado e finalizado não contam — e um status que a gente NÃO conhece (id fora de 44/45/46,
 * sem nome) também não: um cancelado que chegue sem `statusName` não pode virar Purchase.
 */
export function tratamentoAberto(t: TratamentoParaEtapa): boolean {
  if (finalizado(t) || cancelado(t)) return false;
  if (t.idStatus === null || t.idStatus === TRATAMENTO_PENDENTE || t.idStatus === TRATAMENTO_EM_ANDAMENTO) return true;
  return /pendente|andamento|ativo/.test(n(t.statusName ?? ''));
}
const aberto = tratamentoAberto;

function pendente(t: TratamentoParaEtapa): boolean {
  return !finalizado(t) && !cancelado(t) && (t.idStatus === TRATAMENTO_PENDENTE || /pendente/.test(n(t.statusName ?? '')));
}

/** Retorno pós-tratamento atendido há pouco: entre uma varredura e outra, ou registrado depois do fato. */
const RECENTE_S = 7 * 24 * 3600;

/** Puro: dado o cartão e o que a franquia sabe, pra onde o cartão vai (ou null = fica). */
export function planejarMovimento(e: EntradaMovimento): Movimento | null {
  const atual = e.atual;
  if (!atual) return null;
  const status = atual.status;
  const ir = (funil: Funil, para: string, motivo: string): Movimento | null => (atual.funil === funil && eh(status, para) ? null : { funil, para, motivo });

  if (atual.funil === 'COMERCIAL' && emAlgum(status, INTOCAVEIS_COMERCIAL)) return null;
  if (atual.funil === 'TRATAMENTO' && emAlgum(status, INTOCAVEIS_TRATAMENTO)) return null;

  const consultas = e.agendamentos.filter((s) => ehConsulta(s) && epoch(s) !== null);
  const sessoes = e.agendamentos.filter((s) => ehSessao(s) && epoch(s) !== null);
  const temFinalizado = e.tratamentos.some(finalizado);
  const temAberto = e.tratamentos.some(aberto);
  const temEmAndamento = e.tratamentos.some(emAndamento);
  const temCancelado = e.tratamentos.some(cancelado);
  const temPendente = e.tratamentos.some(pendente);
  const passou = (s: SpineSchedule) => (epoch(s) ?? Infinity) <= e.agoraEpoch;
  const futura = (s: SpineSchedule) => (epoch(s) ?? 0) > e.agoraEpoch && (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO);
  // quem já fez um ciclo inteiro (alta) volta como retorno pós-tratamento. O retorno mais recente marca o
  // corte do ciclo atual: sessão e tratamento de antes dele são do ciclo velho e não valem pra GANHO/ALTA.
  const retornosPos = consultas.filter(ehRetornoPosTratamento).sort((a, b) => (epoch(b) ?? 0) - (epoch(a) ?? 0));
  const ultimoRetornoPos = retornosPos[0] ?? null;
  const cicloAnterior = ultimoRetornoPos !== null;
  const corteCiclo = ultimoRetornoPos ? (epoch(ultimoRetornoPos) ?? 0) : 0;
  const retornoPosAtendido = !!ultimoRetornoPos && ultimoRetornoPos.idStatus === SPINE_STATUS.ATENDIDO && passou(ultimoRetornoPos);
  const retornoPosAtendidoRecente = retornoPosAtendido && e.agoraEpoch - corteCiclo <= RECENTE_S;
  const retornoPosMarcado = !!ultimoRetornoPos && futura(ultimoRetornoPos);

  // ── RETORNO PÓS-TRATAMENTO (COMERCIAL): só sai quando o retorno é atendido, e aí segue como avaliação normal ──
  if (atual.funil === 'COMERCIAL' && eh(status, ETAPA.RETORNO)) {
    if (retornoPosAtendido) return ir('COMERCIAL', ETAPA.COMPARECEU, 'retorno pós-tratamento atendido na franquia');
    return null;
  }

  // ── funil TRATAMENTO ──
  if (atual.funil === 'TRATAMENTO') {
    if (eh(status, ETAPA.ALTA)) {
      // paciente de alta com retorno marcado: volta pro COMERCIAL, na etapa própria
      if (retornoPosMarcado) return ir('COMERCIAL', ETAPA.RETORNO, 'retorno pós-tratamento marcado na franquia');
      // retorno marcado e atendido entre duas varreduras (ou lançado depois): não pode ficar preso na ALTA
      if (retornoPosAtendidoRecente) return ir('COMERCIAL', ETAPA.COMPARECEU, 'retorno pós-tratamento atendido na franquia');
      return null;
    }
    if (eh(status, ETAPA.EM_TRATAMENTO)) {
      if (cicloAnterior) {
        // o FINALIZADO do ciclo velho é esperado aqui; o que decide é o tratamento novo
        if (temCancelado && !temEmAndamento && !temPendente) return ir('TRATAMENTO', ETAPA.CANCELADO, 'tratamento cancelado na franquia');
        if (temFinalizado && !temEmAndamento && !temPendente && !temCancelado) return ir('TRATAMENTO', ETAPA.ALTA, 'tratamento finalizado na franquia');
        return null;
      }
      // um tratamento pendente não segura a alta; um em andamento segura
      if (temFinalizado && !temEmAndamento) return ir('TRATAMENTO', ETAPA.ALTA, 'tratamento finalizado na franquia');
      // cancelado na franquia, sem outro aberto (pendente ou em andamento) e sem finalizado: a clínica encerrou
      if (temCancelado && !temAberto && !temFinalizado) return ir('TRATAMENTO', ETAPA.CANCELADO, 'tratamento cancelado na franquia');
    }
    return null;
  }

  // ── tratamento existe: GANHO, e depois EM TRATAMENTO na 1ª sessão atendida ──
  // (finalizado só conta pra quem NÃO é retorno de um ciclo anterior)
  if (temAberto || (temFinalizado && !cicloAnterior)) {
    // sessão do ciclo velho (antes do retorno pós) não leva ninguém pra EM TRATAMENTO de novo
    const sessaoAtendida = sessoes.some((s) => s.idStatus === SPINE_STATUS.ATENDIDO && passou(s) && (epoch(s) ?? 0) > corteCiclo);
    if (eh(status, ETAPA.GANHO)) {
      if (sessaoAtendida) return ir('TRATAMENTO', ETAPA.EM_TRATAMENTO, 'primeira sessão atendida');
      return null;
    }
    // qualquer etapa antes de GANHO (inclusive entrada, espera e negociação) vai pra GANHO primeiro:
    // é ali que o n8n manda o Purchase; EM TRATAMENTO fica pra próxima varredura, se já houver sessão.
    return ir('COMERCIAL', ETAPA.GANHO, 'tratamento aberto na franquia');
  }

  // ── sem tratamento: a consulta manda ──
  if (consultas.length === 0) return null;
  const porData = [...consultas].sort((a, b) => (epoch(b) ?? 0) - (epoch(a) ?? 0));
  const atendidas = porData.filter((s) => s.idStatus === SPINE_STATUS.ATENDIDO && (epoch(s) ?? Infinity) <= e.agoraEpoch);
  const futurasMarcadas = porData.filter((s) => (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO) && (epoch(s) ?? 0) > e.agoraEpoch);
  const ultimaFalta = porData.find((s) => s.idStatus === SPINE_STATUS.NAO_COMPARECEU && (epoch(s) ?? Infinity) <= e.agoraEpoch);

  if (atendidas.length > 0) {
    const ultimaAtendida = atendidas[0];
    if (eh(status, ETAPA.COMPARECEU)) {
      // Decisão do João (18/09): com retorno marcado, o paciente já tem próximo passo — fica em
      // COMPARECEU e as 48 h só contam depois do retorno. Cobrar "decidiu?" de quem vai voltar
      // soaria como se a clínica não soubesse o que ela mesma agendou.
      if (futurasMarcadas.length > 0) return null;
      const horas = (e.agoraEpoch - (epoch(ultimaAtendida) ?? e.agoraEpoch)) / 3600;
      if (horas >= e.horasAteNegociacao) return ir('COMERCIAL', ETAPA.NEGOCIACAO, `atendido há ${Math.floor(horas)} h sem tratamento`);
      return null;
    }
    if (eh(status, ETAPA.NEGOCIACAO)) return null;
    if (ehEtapaDeEntrada(status) || emAlgum(status, [...PRE_AGENDADO, ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU])) {
      return ir('COMERCIAL', ETAPA.COMPARECEU, 'avaliação atendida na franquia');
    }
    return null;
  }

  if (futurasMarcadas.length > 0) {
    if (ehEtapaDeEntrada(status) || emAlgum(status, [...PRE_AGENDADO, ETAPA.NAO_COMPARECEU])) {
      return ir('COMERCIAL', ETAPA.AGENDADO, 'avaliação marcada na franquia');
    }
    return null;
  }

  if (ultimaFalta && eh(status, ETAPA.AGENDADO)) {
    return ir('COMERCIAL', ETAPA.NAO_COMPARECEU, 'falta registrada na franquia');
  }
  return null;
}

export function moveLiberado(slug: string, raw: string | undefined = process.env.FRANQUIA_MOVE_SLUGS): boolean {
  const lista = (raw ?? '').replace(/^['"]|['"]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (lista.length === 0) return false;
  return lista.includes('*') || lista.includes(slug);
}

export function horasAteNegociacao(raw: string | undefined = process.env.FRANQUIA_NEGOCIACAO_HORAS): number {
  const h = Number((raw ?? '').replace(/^['"]|['"]$/g, ''));
  return Number.isFinite(h) && h > 0 ? h : 48;
}
