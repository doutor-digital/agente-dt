/**
 * A grade da agenda dos advogados e a conta de "livre". Funções PURAS (sem rede, sem relógio): quem chama passa o "agora".
 *
 * Regra da gestora (17/11/2026): segunda a sexta, 8h–12h e 14h–18h, atendimento de 50 min. A grade começa de hora em hora
 * (8h, 9h, 10h, 11h, 14h, 15h, 16h, 17h): o último atendimento de cada janela termina às 11h50 e às 17h50. Feriado nacional não tem agenda.
 * "Livre" = o advogado não tem NENHUMA atividade com hora marcada na Tramitação que se sobreponha ao atendimento.
 */
import { feriadoNacional } from '../feriados.js';
import { OFFSET_DO_ESCRITORIO, type ChaveDoAdvogado } from './config.js';

export const DURACAO_MIN = 50;
export const JANELAS: ReadonlyArray<readonly [number, number]> = [
  [8, 12],
  [14, 18],
];
/** Quanto antes do atendimento a Sophia para de oferecer (dá tempo de o advogado ver o aviso). */
export const ANTECEDENCIA_MIN = 120;

export interface Intervalo {
  inicio: number;
  fim: number;
}

export interface Slot {
  data: string;
  hora: string;
  inicio: number;
  fim: number;
}

export interface SlotLivre extends Slot {
  advogado: ChaveDoAdvogado;
}

const dois = (n: number) => String(n).padStart(2, '0');

export function instante(data: string, hora: string): number {
  return Date.parse(`${data}T${hora}:00${OFFSET_DO_ESCRITORIO}`);
}

/** Dia da semana (0 = domingo) da data civil, sem depender do fuso da máquina. */
export function diaDaSemana(data: string): number {
  return new Date(`${data}T12:00:00Z`).getUTCDay();
}

export function somarDias(data: string, n: number): string {
  return new Date(Date.parse(`${data}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** A data civil de um instante, no fuso do escritório (UTC-3). */
export function dataLocal(ms: number): string {
  return new Date(ms - 3 * 3_600_000).toISOString().slice(0, 10);
}

export function diaUtil(data: string): boolean {
  const d = diaDaSemana(data);
  return d >= 1 && d <= 5 && feriadoNacional(data) === null;
}

/** Os horários possíveis do dia (vazio em fim de semana e feriado). */
export function gradeDoDia(data: string): Slot[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !diaUtil(data)) return [];
  const slots: Slot[] = [];
  for (const [de, ate] of JANELAS) {
    for (let h = de; h < ate; h++) {
      const hora = `${dois(h)}:00`;
      const inicio = instante(data, hora);
      const fim = inicio + DURACAO_MIN * 60_000;
      if (fim <= instante(data, `${dois(ate)}:00`)) slots.push({ data, hora, inicio, fim });
    }
  }
  return slots;
}

export function ehHorarioDaGrade(data: string, hora: string): boolean {
  return gradeDoDia(data).some((s) => s.hora === hora);
}

interface AtividadeDaTramitacao {
  start?: string | null;
  end?: string | null;
  all_day?: boolean | null;
  archived_at?: string | null;
}

/**
 * O que da lista de atividades do advogado ocupa o relógio. Dia inteiro (prazo, lembrete) NÃO ocupa: senão um prazo no dia
 * bloquearia a agenda inteira. Atividade com hora mas sem fim ocupa a duração de um atendimento a partir do início.
 */
export function intervalosOcupados(atividades: readonly AtividadeDaTramitacao[]): Intervalo[] {
  const out: Intervalo[] = [];
  for (const a of atividades) {
    if (a.all_day || a.archived_at || !a.start) continue;
    const inicio = Date.parse(a.start);
    if (!Number.isFinite(inicio)) continue;
    const fimBruto = a.end ? Date.parse(a.end) : NaN;
    const fim = Number.isFinite(fimBruto) && fimBruto > inicio ? fimBruto : inicio + DURACAO_MIN * 60_000;
    out.push({ inicio, fim });
  }
  return out;
}

export const sobrepoe = (a: Intervalo, b: Intervalo): boolean => a.inicio < b.fim && b.inicio < a.fim;

/**
 * Os horários livres, do mais cedo para o mais tarde, no máximo `diasAFrente` dias a partir de hoje. Para cada horário vai
 * o advogado livre com MENOS atendimento naquele dia (empate: a ordem de `advogados`). Se os dois estão livres, o horário aparece uma vez.
 */
export function horariosLivres(args: {
  agora: number;
  advogados: readonly ChaveDoAdvogado[];
  ocupado: Partial<Record<ChaveDoAdvogado, readonly Intervalo[]>>;
  diasAFrente?: number;
  antecedenciaMin?: number;
}): SlotLivre[] {
  const { agora, advogados, ocupado } = args;
  const corte = agora + (args.antecedenciaMin ?? ANTECEDENCIA_MIN) * 60_000;
  const hoje = dataLocal(agora);
  const livres: SlotLivre[] = [];
  const limite = args.diasAFrente ?? 14;
  for (let i = 0; i <= limite; i++) {
    const data = somarDias(hoje, i);
    const grade = gradeDoDia(data);
    if (grade.length === 0) continue;
    const carga = (adv: ChaveDoAdvogado) => grade.filter((s) => (ocupado[adv] ?? []).some((o) => sobrepoe(o, s))).length;
    const ordem = [...advogados].sort((a, b) => carga(a) - carga(b));
    for (const s of grade) {
      if (s.inicio < corte) continue;
      const quem = ordem.find((adv) => !(ocupado[adv] ?? []).some((o) => sobrepoe(o, s)));
      if (quem) livres.push({ ...s, advogado: quem });
    }
  }
  return livres;
}

/** Dois horários para oferecer: o mais cedo e o primeiro que não é do mesmo dia e período (manhã/tarde) dele. */
export function doisParaOferecer(livres: readonly SlotLivre[]): SlotLivre[] {
  if (livres.length <= 2) return [...livres];
  const periodo = (s: Slot) => `${s.data}|${s.hora < '12:00' ? 'm' : 't'}`;
  const primeiro = livres[0]!;
  const segundo = livres.find((s) => periodo(s) !== periodo(primeiro)) ?? livres[1]!;
  return [primeiro, segundo];
}
