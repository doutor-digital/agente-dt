/**
 * Expediente da clínica — o jeito de dizer «a IA atende quando a clínica está FECHADA».
 *
 * Por que existe (23/11/2026): Caxias e Petrópolis foram prometidas «das 18h às 6h30 nos dias
 * úteis e 24h nos fins de semana e feriados». A janela por hora cheia (`businessHoursStart/End`
 * + `businessHoursByDay`) não descreve isso: não tem 6h30, e uma janela por dia não cobre ao
 * mesmo tempo sábado e domingo inteiros E a madrugada de segunda. Dois leads de formulário
 * (sáb 15h39 e dom 7h34) caíram em `__out_of_hours__` e ficaram sem resposta.
 *
 * A ideia: em vez de listar quando a IA atende, guardar quando a EQUIPE atende (o expediente) e
 * deixar a IA com todo o resto. O resto sai de graça e emendado — noite, fim de semana e feriado
 * viram um intervalo só, porque são o complemento do expediente.
 *
 *   {"mon":{"start":"06:30","end":"18:00"}, "tue":{...}, "wed":{...}, "thu":{...}, "fri":{...}}
 *
 *  - dia ausente do mapa (sat, sun) = sem expediente = a IA atende o dia inteiro;
 *  - feriado nacional = sem expediente, qualquer que seja o dia da semana (mesma regra que já
 *    fecha a clínica no horário comercial normal, ver `feriados.ts`);
 *  - início inclusivo, fim exclusivo, precisão de minuto; o expediente não atravessa a meia-noite.
 *
 * Fica numa coluna própria (`business_hours_expediente`), nula na maioria das unidades: quem não
 * tem o campo segue pela janela antiga, sem mudar nada (expand/contract).
 */

import { logger } from './logger.js';

export interface JanelaDeExpediente {
  /** minutos desde a meia-noite, inclusivo */
  inicio: number;
  /** minutos desde a meia-noite, exclusivo */
  fim: number;
}

export type Expediente = Partial<Record<string, JanelaDeExpediente>>;

const DIAS_VALIDOS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** «24:00» só vale como FIM (clínica que fecha à meia-noite); como início não existe. */
function minutosDe(texto: unknown, comoFim = false): number | null {
  if (typeof texto !== 'string') return null;
  const t = texto.trim();
  if (comoFim && t === '24:00') return 24 * 60;
  const m = HHMM.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export type LeituraDoExpediente = { ok: true; expediente: Expediente | null } | { ok: false; motivo: string };

/**
 * Valida e converte o JSON gravado. Sem valor (null/undefined) = sem expediente, e está certo.
 * Torto = qualquer dia com horário inválido, fim <= início, dia que não existe, ou nenhum dia com
 * expediente. É a mesma função da gravação (zod, em units.controller) e da leitura (abaixo).
 */
export function interpretarExpediente(bruto: unknown): LeituraDoExpediente {
  if (bruto === null || bruto === undefined) return { ok: true, expediente: null };
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return { ok: false, motivo: 'não é um objeto' };
  const out: Expediente = {};
  for (const [dia, valor] of Object.entries(bruto as Record<string, unknown>)) {
    if (!DIAS_VALIDOS.has(dia)) return { ok: false, motivo: `dia desconhecido "${dia}"` };
    if (valor === null) continue; // «sem expediente neste dia» escrito de propósito
    const v = valor as { start?: unknown; end?: unknown };
    const inicio = minutosDe(v?.start);
    const fim = minutosDe(v?.end, true);
    if (inicio === null || fim === null || fim <= inicio) {
      return { ok: false, motivo: `horário inválido em "${dia}" (use "HH:MM", fim depois do início)` };
    }
    out[dia] = { inicio, fim };
  }
  if (Object.keys(out).length === 0) return { ok: false, motivo: 'nenhum dia com expediente' };
  return { ok: true, expediente: out };
}

const jaAvisou = new Set<string>();

/**
 * Lê o expediente da unidade. `null` quando não há — OU quando está torto: aí a unidade cai na
 * janela antiga (já provada), em vez de ficar muda ou falar por cima da equipe por causa de um
 * erro de digitação. O aviso sai UMA vez por unidade e motivo (isto roda a cada mensagem).
 */
export function lerExpediente(bruto: unknown, unidade = ''): Expediente | null {
  const r = interpretarExpediente(bruto);
  if (r.ok) return r.expediente;
  const chave = `${unidade}|${r.motivo}`;
  if (!jaAvisou.has(chave)) {
    jaAvisou.add(chave);
    logger.warn({ unit: unidade, motivo: r.motivo }, 'expediente da unidade inválido — usando a janela de horário antiga');
  }
  return null;
}

/** A equipe está no expediente neste instante? (feriado nacional nunca é expediente) */
export function dentroDoExpediente(e: Expediente, weekday: string, minutoDoDia: number, feriado: boolean): boolean {
  if (feriado) return false;
  const j = e[weekday];
  return !!j && minutoDoDia >= j.inicio && minutoDoDia < j.fim;
}

const NOMES_DIAS: Array<[string, string]> = [
  ['mon', 'seg'],
  ['tue', 'ter'],
  ['wed', 'qua'],
  ['thu', 'qui'],
  ['fri', 'sex'],
  ['sat', 'sáb'],
  ['sun', 'dom'],
];

function hhmm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

/** Texto para o prompt: quando a equipe atende (a IA não) e quando a IA atende. */
export function descreverExpediente(e: Expediente): string {
  // Agrupa dias seguidos com o mesmo horário: «seg–sex, das 6h30 às 18h».
  const grupos: Array<{ de: number; ate: number; j: JanelaDeExpediente }> = [];
  NOMES_DIAS.forEach(([chave], i) => {
    const j = e[chave];
    if (!j) return;
    const ult = grupos[grupos.length - 1];
    if (ult && ult.ate === i - 1 && ult.j.inicio === j.inicio && ult.j.fim === j.fim) ult.ate = i;
    else grupos.push({ de: i, ate: i, j });
  });
  return grupos
    .map((g) => `${g.de === g.ate ? NOMES_DIAS[g.de][1] : `${NOMES_DIAS[g.de][1]}–${NOMES_DIAS[g.ate][1]}`}, das ${hhmm(g.j.inicio)} às ${hhmm(g.j.fim)}`)
    .join('; ');
}
