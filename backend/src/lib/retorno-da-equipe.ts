import type { Unit } from '@prisma/client';
import { dataLocalISO, diaDaSemana, ehFeriadoNacional } from './feriados.js';
import { fusoDaUnidade } from './fuso.js';

/**
 * Quando a EQUIPE da clínica volta a atender — para a IA nunca mais prometer "em instantes".
 *
 * Item 2 das prioridades da IA (21/10/2026): 89 conversas em que a Sofia disse "a equipe vai te chamar em
 * instantes"; só 19% tiveram resposta humana em 60 minutos. Boa parte era de noite e no fim de semana, quando
 * não há ninguém na clínica — a promessa era impossível de cumprir.
 *
 * DE ONDE VEM O HORÁRIO: da janela da agenda (`spineAgendaDays` + `spineAgendaStart/End`, com
 * `spineDayHours` para o dia que muda, como o sábado). É quando a clínica ATENDE, e é a mesma janela que o
 * alerta de SLA já usa como "horário de atendimento da unidade" (`sla-alert-worker.ts`). Só vale quando a
 * agenda está ligada (`spineEnabled`): sem ela, os campos guardam o valor padrão do banco (08:00–18:00,
 * seg–sex), que ninguém conferiu — e horário inventado é pior do que nenhum.
 *
 * POR QUE NÃO O HORÁRIO COMERCIAL (`businessHours*`): ele diz quando a IA RESPONDE, não quando a equipe
 * atende. Com ele ligado, a IA nem fala fora da janela (o sistema manda a mensagem de fora do horário), e em
 * Taubaté ele foi desenhado ao contrário — a IA cobre a noite e o fim de semana, quando a equipe NÃO está.
 * Hoje está desligado nas 21 unidades.
 */

export type RetornoDaEquipe =
  /** a clínica está no horário agora */
  | { tipo: 'aberta' }
  /** fora do horário; `quando` já vem pronto para o paciente: "hoje às 14h", "amanhã (quinta-feira) às 8h" */
  | { tipo: 'fechada'; quando: string; hoje: boolean }
  /** a unidade não tem horário confiável cadastrado */
  | { tipo: 'desconhecido' };

interface Janela {
  inicio: number;
  fim: number;
  inicioTexto: string;
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

function minutos(hhmm: unknown): number | null {
  const m = HHMM.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // 24:00 é o fim do dia; 24:30 é cadastro quebrado, não meia-noite e meia.
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** "08:00" → "8h"; "07:30" → "7h30" — como se fala no WhatsApp. */
export function horaFalada(hhmm: string): string {
  const m = HHMM.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  return m[2] === '00' ? `${h}h` : `${h}h${m[2]}`;
}

function janelaDoDia(unit: Unit, dia: number): Janela | null {
  const mapa = (unit.spineDayHours ?? null) as Record<string, { start?: unknown; end?: unknown }> | null;
  const proprio = mapa?.[String(dia)];
  const inicioTexto = String((proprio?.start ?? unit.spineAgendaStart) ?? '').trim();
  const fimTexto = String((proprio?.end ?? unit.spineAgendaEnd) ?? '').trim();
  const inicio = minutos(inicioTexto);
  const fim = minutos(fimTexto);
  if (inicio === null || fim === null || fim <= inicio) return null;
  return { inicio, fim, inicioTexto };
}

function somarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function minutosAgora(agora: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(agora);
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24;
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function retornoDaEquipe(unit: Unit, agora: Date = new Date()): RetornoDaEquipe {
  if (!unit.spineEnabled) return { tipo: 'desconhecido' };
  const dias = new Set((unit.spineAgendaDays ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (dias.size === 0) return { tipo: 'desconhecido' };

  const tz = fusoDaUnidade(unit);
  const hojeISO = dataLocalISO(agora, tz);
  const agoraMin = minutosAgora(agora, tz);

  // Duas semanas cobrem qualquer feriado emendado; mais que isso é cadastro quebrado.
  for (let i = 0; i <= 14; i++) {
    const iso = somarDias(hojeISO, i);
    const dia = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (!dias.has(dia) || ehFeriadoNacional(iso)) continue;
    const j = janelaDoDia(unit, dia);
    if (!j) continue;
    if (i === 0) {
      if (agoraMin >= j.inicio && agoraMin < j.fim) return { tipo: 'aberta' };
      if (agoraMin >= j.fim) continue;
    }
    const hora = horaFalada(j.inicioTexto);
    const quando =
      i === 0
        ? `hoje às ${hora}`
        : i === 1
          ? `amanhã (${diaDaSemana(iso)}) às ${hora}`
          : `${diaDaSemana(iso)}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}, às ${hora}`;
    return { tipo: 'fechada', quando, hoje: i === 0 };
  }
  return { tipo: 'desconhecido' };
}

/**
 * O que a IA diz ao paciente logo depois de passar o atendimento para a equipe. Vai no resultado de
 * `pausar_ia`, que é a última coisa que ela lê antes de escrever — por isso funciona mesmo em unidade com
 * prompt próprio, e não custa nada no prompt fixo (que fica uma hora em cache e não pode depender da hora).
 */
export function orientacaoAoTransferir(r: RetornoDaEquipe, urgente = false): string {
  const semPrazo = 'NÃO prometa prazo: nada de "em instantes", "já já", "um instante", "logo te chamam".';
  if (r.tipo === 'aberta') {
    return (
      'Responda em UMA frase avisando o paciente que ' +
      (urgente ? 'a equipe já foi avisada com prioridade' : 'a equipe já foi avisada') +
      ' e continua o atendimento por aqui. ' +
      semPrazo
    );
  }
  if (r.tipo === 'fechada') {
    const pronto = r.hoje
      ? ''
      : urgente
        ? ' A clínica não atende mais hoje: só oriente pronto-socorro se o paciente disse que a dor está insuportável.'
        : '';
    return (
      `A equipe está fora do horário agora e volta ${r.quando}. Responda em UMA frase avisando o paciente que ` +
      `a equipe continua o atendimento por aqui ${r.quando} — diga esse dia e essa hora. ${semPrazo}${pronto}`
    );
  }
  return (
    'Responda em UMA frase avisando o paciente que a equipe continua o atendimento por aqui no próximo ' +
    `horário de atendimento da clínica (não temos o horário dela cadastrado — não invente). ${semPrazo}`
  );
}

/** O fim da mensagem fixa de quando a conversa passa do teto de gasto (`FALLBACK_TETO`). */
export function quandoAEquipeResponde(r: RetornoDaEquipe): string {
  if (r.tipo === 'aberta') return 'te responde por aqui';
  if (r.tipo === 'fechada') return `te responde por aqui ${r.quando}, quando a clínica abre`;
  return 'te responde por aqui no próximo horário de atendimento';
}
