/**
 * Sessões e tratamento da franquia espelhados no bloco EM TRATAMENTO do cartão — e ATUALIZADOS.
 *
 * Por que isto existe, ao lado de `tratamento-para-cartao.ts`: aquele grava "só se vazio", o que é
 * certo para queixa e protocolo e errado para contador. `# Sessões realizadas` que foi gravada uma
 * vez e nunca mais mexida está errada na semana seguinte. Aqui a franquia vence: o valor é
 * recalculado a cada varredura e só vai ao Kommo quando mudou.
 *
 * Definições (combinadas com o João em 02/10/2026; mudar aqui muda o que a SDR lê):
 *  - sessão = agendamento que não é avaliação nem retorno (`ehConsulta`) e pertence a ESTE tratamento:
 *    tem o `idTreatment` dele, ou não traz id nenhum (a ficha do paciente não manda o id de cada
 *    sessão) e é posterior à criação do tratamento — o que deixa de fora o ciclo anterior de quem
 *    voltou depois da alta;
 *  - realizadas = status ATENDIDO · faltas = NÃO COMPARECEU;
 *  - marcadas = AGENDADO ou CONFIRMADO ainda por vir;
 *  - previstas = realizadas + faltas + marcadas (desmarcada e remarcada não entram — é arrumação
 *    de agenda, e contá-las faria o tratamento parecer maior do que é);
 *  - próxima = a primeira sessão marcada por vir; última = a última ATENDIDA.
 *  Sessão agendada com data já passada e sem desfecho na franquia não conta em nada: ninguém sabe
 *  se foi atendida, e chutar aqui seria inventar dado.
 *
 * Campo que a conta não tem é pulado em silêncio (cada clínica nasceu de uma versão do cartão).
 */
import { SPINE_STATUS, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { ehConsulta, normalizar } from './franquia-sync.js';

export const CAMPOS_SESSOES = {
  PREVISTAS: '# Sessões previstas',
  REALIZADAS: '# Sessões realizadas',
  MARCADAS: '# Sessões marcadas',
  FALTAS: '# Nº de faltas',
  PROXIMA: '◷ Próxima sessão',
  ULTIMA: '◷ Última sessão',
  LOCAL: '⚕ Local do tratamento',
  GRAU: '⚕ Grau',
  STATUS_TRAT: '⚕ Status do tratamento',
  ID_TRAT: '⚙ idTreatment (franquia)',
} as const;

export interface ResumoDeSessoes {
  realizadas: number;
  faltas: number;
  marcadas: number;
  previstas: number;
  /** epoch (s) da primeira sessão marcada por vir */
  proxima: number | null;
  /** última sessão atendida: epoch (s) e o dia no fuso da clínica (AAAA-MM-DD) */
  ultima: { epoch: number; dia: string | null } | null;
}

const epochDe = (iso: string | null | undefined): number | null => {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/**
 * Conta as sessões do tratamento `idTreatment`. Devolve null quando não há NENHUMA sessão dele na
 * lista — caso em que gravar zero seria afirmar que o tratamento não tem sessão, quando talvez só
 * não tenhamos a agenda dele em mãos.
 */
export function resumirSessoes(
  schedules: SpineSchedule[],
  idTreatment: number | null,
  agoraEpoch: number,
  criadoEm: string | null = null,
): ResumoDeSessoes | null {
  if (!idTreatment) return null;
  const desde = epochDe(criadoEm);
  const vistos = new Set<number>();
  const sessoes = schedules.filter((s) => {
    if (ehConsulta(s) || !s.dateAttendanceUtc) return false;
    if (s.idTreatment !== null && s.idTreatment !== idTreatment) return false;
    if (s.idTreatment === null && desde !== null) {
      const quando = epochDe(s.dateAttendanceUtc);
      if (quando === null || quando < desde) return false;
    }
    if (s.idSchedule !== null) {
      if (vistos.has(s.idSchedule)) return false;
      vistos.add(s.idSchedule);
    }
    return true;
  });
  if (sessoes.length === 0) return null;

  let realizadas = 0;
  let faltas = 0;
  let marcadas = 0;
  let proxima: number | null = null;
  let ultima: ResumoDeSessoes['ultima'] = null;
  for (const s of sessoes) {
    const epoch = epochDe(s.dateAttendanceUtc);
    if (epoch === null) continue;
    if (s.idStatus === SPINE_STATUS.ATENDIDO) {
      realizadas++;
      if (!ultima || epoch > ultima.epoch) ultima = { epoch, dia: s.dayLocal ?? (s.dateAttendanceLocal ? s.dateAttendanceLocal.slice(0, 10) : null) };
    } else if (s.idStatus === SPINE_STATUS.NAO_COMPARECEU) {
      faltas++;
    } else if ((s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO) && epoch > agoraEpoch) {
      marcadas++;
      if (proxima === null || epoch < proxima) proxima = epoch;
    }
  }
  return { realizadas, faltas, marcadas, previstas: realizadas + faltas + marcadas, proxima, ultima };
}

/** "2026-09-28" → "28/09/2026". */
export function diaParaTexto(dia: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dia ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** O que o planejador precisa saber de um campo da conta: o tipo REAL (cada clínica nasceu de uma versão) e o valor no cartão. */
export interface CampoDoCartao {
  tipo: string;
  valor: string | null;
}

export type EscritaDeSessao =
  | { campo: string; tipo: 'numeric' | 'date' | 'text' | 'textarea'; valor: string | number; motivo: string; limpar?: false }
  | { campo: string; limpar: true; motivo: string };

export interface EntradaSessoes {
  schedules: SpineSchedule[];
  tratamento: Pick<SpineTreatment, 'idTreatment' | 'local' | 'degree' | 'statusName' | 'created'> | null;
  agoraEpoch: number;
  /** Devolve o campo da conta pelo nome, ou null se a conta não o tem. */
  campo: (nome: string) => CampoDoCartao | null;
}

const num = (v: string | null): number | null => {
  if (v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Puro: dado o que a franquia sabe e o que o cartão mostra, devolve só o que precisa mudar. */
export function escritasDeSessoes(e: EntradaSessoes): EscritaDeSessao[] {
  const out: EscritaDeSessao[] = [];
  const t = e.tratamento;
  if (!t?.idTreatment) return out;

  const numerico = (nome: string, valor: number, motivo: string) => {
    const c = e.campo(nome);
    if (!c) return;
    if (num(c.valor) === valor) return;
    out.push({ campo: nome, tipo: 'numeric', valor, motivo });
  };
  const data = (nome: string, epoch: number, motivo: string) => {
    const c = e.campo(nome);
    if (!c) return;
    const atual = num(c.valor);
    if (atual !== null && Math.abs(atual - epoch) <= 60) return;
    out.push({ campo: nome, tipo: 'date', valor: epoch, motivo });
  };
  const texto = (nome: string, valor: string | null | undefined, motivo: string) => {
    const v = String(valor ?? '').trim();
    const c = e.campo(nome);
    if (!c || !v) return;
    if (normalizar(c.valor) === normalizar(v)) return;
    out.push({ campo: nome, tipo: c.tipo === 'textarea' ? 'textarea' : 'text', valor: v, motivo });
  };

  numerico(CAMPOS_SESSOES.ID_TRAT, t.idTreatment, 'tratamento na franquia');
  texto(CAMPOS_SESSOES.LOCAL, t.local, 'local do tratamento na franquia');
  texto(CAMPOS_SESSOES.GRAU, t.degree, 'grau do tratamento na franquia');
  texto(CAMPOS_SESSOES.STATUS_TRAT, t.statusName, 'status do tratamento na franquia');

  const r = resumirSessoes(e.schedules, t.idTreatment, e.agoraEpoch, t.created ?? null);
  if (!r) return out; // sem agenda do tratamento em mãos: não afirma zero

  numerico(CAMPOS_SESSOES.REALIZADAS, r.realizadas, 'sessões atendidas na franquia');
  numerico(CAMPOS_SESSOES.FALTAS, r.faltas, 'sessões NÃO COMPARECEU na franquia');
  numerico(CAMPOS_SESSOES.MARCADAS, r.marcadas, 'sessões agendadas por vir na franquia');
  numerico(CAMPOS_SESSOES.PREVISTAS, r.previstas, 'realizadas + faltas + marcadas');

  if (r.proxima !== null) {
    data(CAMPOS_SESSOES.PROXIMA, r.proxima, 'próxima sessão marcada na franquia');
  } else {
    // a data que estava lá passou (ou a sessão foi desmarcada): deixar seria mostrar uma "próxima" no passado
    const c = e.campo(CAMPOS_SESSOES.PROXIMA);
    if (c && num(c.valor) !== null) out.push({ campo: CAMPOS_SESSOES.PROXIMA, limpar: true, motivo: 'não há sessão marcada por vir' });
  }

  if (r.ultima) {
    const c = e.campo(CAMPOS_SESSOES.ULTIMA);
    if (c && (c.tipo === 'date' || c.tipo === 'date_time')) {
      data(CAMPOS_SESSOES.ULTIMA, r.ultima.epoch, 'última sessão atendida na franquia');
    } else {
      texto(CAMPOS_SESSOES.ULTIMA, diaParaTexto(r.ultima.dia), 'última sessão atendida na franquia');
    }
  }
  return out;
}
