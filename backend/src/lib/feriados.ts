/**
 * Feriados nacionais do Brasil — a clínica não abre em nenhuma unidade.
 *
 * Motivo (04/09/2026): a Sofia de Porto Nacional disse a um paciente, em 25/08,
 * que "teremos atendimento" em 07/09 (Independência) e reservou 17h; a agenda
 * da franquia tinha o bloqueio "Feriado", mas o sync estava quebrado e o agente
 * não tinha nenhum calendário próprio. Este módulo é a rede de segurança que
 * não depende de sync: vale para o horário comercial, para a grade de horários
 * e para o bloco <calendario> do prompt.
 *
 * Só feriados NACIONAIS. Feriado municipal/estadual continua vindo do bloqueio
 * que a recepção marca na agenda da franquia (agenda_blocks).
 */

export interface Feriado {
  data: string; // YYYY-MM-DD
  nome: string;
}

const FIXOS: Array<[string, string]> = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['09-07', 'Independência do Brasil'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Dia da Consciência Negra'],
  ['12-25', 'Natal'],
];

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), como Date UTC à meia-noite. */
export function pascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31); // 3 = março, 4 = abril
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function somarDias(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

const cache = new Map<number, Feriado[]>();

export function feriadosDoAno(ano: number): Feriado[] {
  const pronto = cache.get(ano);
  if (pronto) return pronto;
  const lista: Feriado[] = FIXOS.map(([md, nome]) => ({ data: `${ano}-${md}`, nome }));
  const p = pascoa(ano);
  lista.push(
    { data: iso(somarDias(p, -48)), nome: 'Carnaval (segunda-feira)' },
    { data: iso(somarDias(p, -47)), nome: 'Carnaval (terça-feira)' },
    { data: iso(somarDias(p, -2)), nome: 'Sexta-feira Santa' },
    { data: iso(somarDias(p, 60)), nome: 'Corpus Christi' },
  );
  lista.sort((x, y) => x.data.localeCompare(y.data));
  cache.set(ano, lista);
  return lista;
}

/** Nome do feriado nacional em `dataISO` (YYYY-MM-DD), ou null. */
export function feriadoNacional(dataISO: string): string | null {
  const ano = Number(dataISO.slice(0, 4));
  if (!Number.isFinite(ano)) return null;
  return feriadosDoAno(ano).find((f) => f.data === dataISO)?.nome ?? null;
}

export function ehFeriadoNacional(dataISO: string): boolean {
  return feriadoNacional(dataISO) !== null;
}

/** Data local (YYYY-MM-DD) de um instante num fuso — sem depender do fuso do servidor. */
export function dataLocalISO(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function ehFeriadoNacionalAgora(now: Date, tz: string): boolean {
  return ehFeriadoNacional(dataLocalISO(now, tz));
}

/** Feriados nacionais entre duas datas ISO (inclusive), em ordem. */
export function feriadosNoIntervalo(inicioISO: string, fimISO: string): Feriado[] {
  const a = Number(inicioISO.slice(0, 4));
  const b = Number(fimISO.slice(0, 4));
  const out: Feriado[] = [];
  for (let ano = a; ano <= b; ano++) {
    for (const f of feriadosDoAno(ano)) if (f.data >= inicioISO && f.data <= fimISO) out.push(f);
  }
  return out;
}

const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "terça-feira" para uma data ISO — calculado em UTC puro, sem fuso do servidor. */
export function diaDaSemana(dataISO: string, curto = false): string {
  const d = new Date(`${dataISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return (curto ? DIAS_CURTOS : DIAS_SEMANA)[d.getUTCDay()];
}

/** "terça-feira, 08/09/2026" — a forma que vai para o paciente. */
export function dataPorExtenso(dataISO: string): string {
  const dia = diaDaSemana(dataISO);
  const [a, m, d] = dataISO.split('-');
  return dia ? `${dia}, ${d}/${m}/${a}` : dataISO;
}

/**
 * Bloco de calendário para o prompt: hoje + os próximos `dias` dias, cada um com
 * o dia da semana e o feriado quando houver. Existe porque o modelo, sem isso,
 * usa o calendário do ano em que foi treinado (em 2025, 08/09 caía na segunda —
 * e foi exatamente "segunda-feira, 08/09" que a Sofia escreveu em 2026).
 */
export function renderCalendario(now: Date, tz: string, dias = 21): string {
  const hojeISO = dataLocalISO(now, tz);
  const linhas: string[] = [];
  let d = new Date(`${hojeISO}T00:00:00Z`);
  for (let i = 0; i <= dias; i++, d = somarDias(d, 1)) {
    const data = iso(d);
    const [, m, dd] = data.split('-');
    const fer = feriadoNacional(data);
    linhas.push(`${diaDaSemana(data, true)} ${dd}/${m}${fer ? ` — FERIADO NACIONAL (${fer}), clínica fechada` : ''}`);
  }
  // Sem hora de propósito: o bloco entra no prompt e só pode mudar uma vez por dia,
  // senão cada chamada invalida o cache do sistema.
  return `Hoje é ${dataPorExtenso(hojeISO)} (fuso ${tz}).
Próximos dias (dia da semana já calculado — use EXATAMENTE estes nomes, nunca calcule de cabeça):
${linhas.join(' · ')}
Regras:
- Ao citar uma data ao paciente, escreva sempre o dia da semana desta lista junto com DD/MM.
- Feriado nacional: a clínica NÃO abre. Não ofereça, não reserve nem confirme horário nesse dia;
  se o paciente pedir, diga que é feriado e ofereça o próximo dia útil.
- Dia que não está nesta lista: calcule a partir dela (semana a semana), nunca chute.`;
}
