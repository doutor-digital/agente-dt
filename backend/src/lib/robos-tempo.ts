/**
 * O TEMPO de cada robô da régua — a única definição do valor de fábrica (a régua lê daqui) e do que a Gestora pode mudar na tela «Robôs».
 *
 * O que muda é o NÚMERO (em minutos, horas ou dias). A âncora («da consulta», «de virar Perdido»…) e a direção (antes/depois) são do robô e
 * não se trocam: um lembrete «antes» nunca vira «depois». Cada robô tem um mínimo e um máximo. Robô que age «na hora» (falta marcada,
 * alta, etiqueta…) ou num horário fixo do dia (09:00 do «Retomar em») não tem tempo para mexer e não aparece aqui.
 *
 * Valor de fábrica NÃO é copiado em outro lugar: `chatwoot-regua.ts` lê `TEMPO[regra].padraoMin`. Os testes da régua fixam os horários de
 * fábrica; o teste desta tela confere que mexer no número desloca o horário exatamente isso, na direção certa.
 */
export type UnidadeDeTempo = 'minutos' | 'horas' | 'dias';

export interface EspecDeTempo {
  direcao: 'antes' | 'depois';
  /** «da consulta», «de virar Perdido»… (completa «N horas antes/depois …») */
  ancora: string;
  padraoMin: number;
  minMin: number;
  maxMin: number;
  unidades: readonly UnidadeDeTempo[];
  /** o robô age em dias inteiros, no mesmo horário de sempre (09:00): o número é de dias */
  diasInteiros?: boolean;
  nota?: string;
}

const M = 1;
const H = 60;
const D = 1440;

export const TEMPO: Readonly<Record<string, EspecDeTempo>> = {
  'consulta-vespera': { direcao: 'antes', ancora: 'da consulta ou da sessão', padraoMin: 24 * H, minMin: 6 * H, maxMin: 3 * D, unidades: ['horas', 'dias'], nota: 'Vale para consulta com hora marcada. Sem hora, o aviso sai 09:00 do dia anterior.' },
  'consulta-dia': { direcao: 'antes', ancora: 'da consulta', padraoMin: 3 * H, minMin: 30 * M, maxMin: 12 * H, unidades: ['minutos', 'horas'] },
  'consulta-preparo': { direcao: 'antes', ancora: 'da consulta', padraoMin: 1 * H, minMin: 15 * M, maxMin: 6 * H, unidades: ['minutos', 'horas'] },
  'sessao-dia': { direcao: 'antes', ancora: 'da sessão', padraoMin: 3 * H, minMin: 30 * M, maxMin: 12 * H, unidades: ['minutos', 'horas'] },
  'prepagamento-pendente': { direcao: 'depois', ancora: 'do pré-pagamento', padraoMin: 3 * H, minMin: 30 * M, maxMin: 2 * D, unidades: ['minutos', 'horas', 'dias'] },
  'pos-atendimento': { direcao: 'depois', ancora: 'da consulta', padraoMin: 1 * D, minMin: 1 * H, maxMin: 7 * D, unidades: ['horas', 'dias'] },
  'decisao-4d': { direcao: 'depois', ancora: 'da consulta', padraoMin: 4 * D, minMin: 1 * D, maxMin: 30 * D, unidades: ['dias'], diasInteiros: true },
  'decisao-7d': { direcao: 'depois', ancora: 'da consulta', padraoMin: 7 * D, minMin: 1 * D, maxMin: 60 * D, unidades: ['dias'], diasInteiros: true },
  'decisao-30d': { direcao: 'depois', ancora: 'da consulta', padraoMin: 30 * D, minMin: 7 * D, maxMin: 120 * D, unidades: ['dias'], diasInteiros: true },
  'followup-48h': { direcao: 'depois', ancora: 'de virar Perdido', padraoMin: 48 * H, minMin: 1 * H, maxMin: 10 * D, unidades: ['horas', 'dias'] },
  'followup-96h': { direcao: 'depois', ancora: 'de virar Perdido', padraoMin: 96 * H, minMin: 1 * H, maxMin: 10 * D, unidades: ['horas', 'dias'] },
  'followup-120h': { direcao: 'depois', ancora: 'de virar Perdido', padraoMin: 120 * H, minMin: 1 * H, maxMin: 10 * D, unidades: ['horas', 'dias'] },
  'falta-48h': { direcao: 'depois', ancora: 'da consulta perdida', padraoMin: 2 * D, minMin: 1 * H, maxMin: 14 * D, unidades: ['horas', 'dias'] },
  'espera-retomada2': { direcao: 'depois', ancora: 'do dia de «Retomar em» (às 09:00)', padraoMin: 3 * D, minMin: 1 * D, maxMin: 14 * D, unidades: ['dias'], diasInteiros: true },
  'alta-nps': { direcao: 'depois', ancora: 'da alta', padraoMin: 48 * H, minMin: 1 * H, maxMin: 30 * D, unidades: ['horas', 'dias'] },
  'alta-retorno-60d': { direcao: 'depois', ancora: 'da alta (às 09:00)', padraoMin: 60 * D, minMin: 30 * D, maxMin: 365 * D, unidades: ['dias'], diasInteiros: true },
  'pendencia-documento': { direcao: 'depois', ancora: 'da consulta', padraoMin: 120 * H, minMin: 1 * D, maxMin: 30 * D, unidades: ['horas', 'dias'] },
  'lead-quente-parado': { direcao: 'depois', ancora: 'da última mensagem do paciente', padraoMin: 3 * H, minMin: 30 * M, maxMin: 2 * D, unidades: ['minutos', 'horas'] },
  'sem-resposta-24h': { direcao: 'depois', ancora: 'da nossa última mensagem', padraoMin: 24 * H, minMin: 1 * H, maxMin: 7 * D, unidades: ['horas', 'dias'] },
};

/** O valor de fábrica em minutos (a régua usa isto). */
export function padraoMin(regra: string): number {
  const e = TEMPO[regra];
  if (!e) throw new Error(`regra sem tempo configurável: ${regra}`);
  return e.padraoMin;
}

const MINUTOS_POR_UNIDADE: Readonly<Record<UnidadeDeTempo, number>> = { minutos: 1, horas: 60, dias: 1440 };

export type TempoValidado = { ok: true; minutos: number } | { ok: false; erro: string };

/** Valida o que a Gestora digitou: número inteiro, unidade que o robô aceita, MESMA direção do robô e dentro do mínimo e do máximo. */
export function validarTempo(regra: string, p: { numero: unknown; unidade: unknown; direcao: unknown }): TempoValidado {
  const e = TEMPO[regra];
  if (!e) return { ok: false, erro: 'este robô age na hora (ou em horário fixo): não tem tempo para mudar' };
  if (p.direcao !== e.direcao) return { ok: false, erro: `este robô manda ${e.direcao === 'antes' ? 'ANTES' : 'DEPOIS'} ${e.ancora}: a direção não muda` };
  if (typeof p.numero !== 'number' || !Number.isInteger(p.numero) || p.numero < 0) return { ok: false, erro: 'o tempo precisa ser um número inteiro' };
  if (typeof p.unidade !== 'string' || !(e.unidades as readonly string[]).includes(p.unidade)) return { ok: false, erro: `a unidade deste robô é ${e.unidades.join(' ou ')}` };
  const minutos = p.numero * MINUTOS_POR_UNIDADE[p.unidade as UnidadeDeTempo];
  if (minutos < e.minMin || minutos > e.maxMin) return { ok: false, erro: `o tempo deste robô vai de ${descreverMinutos(e.minMin)} a ${descreverMinutos(e.maxMin)}` };
  if (e.diasInteiros && minutos % 1440 !== 0) return { ok: false, erro: 'este robô age em dias inteiros' };
  return { ok: true, minutos };
}

/** O valor (em minutos) cabe nos limites do robô? Serve à validação e à leitura do que já estava guardado. */
export function tempoDentroDosLimites(regra: string, minutos: number): boolean {
  const e = TEMPO[regra];
  if (!e || !Number.isInteger(minutos)) return false;
  return minutos >= e.minMin && minutos <= e.maxMin && (!e.diasInteiros || minutos % 1440 === 0);
}

/** 90 → «1 h 30 min»; 1440 → «1 dia»; 2880 → «2 dias». */
export function descreverMinutos(min: number): string {
  if (min % 1440 === 0) return `${min / 1440} ${min / 1440 === 1 ? 'dia' : 'dias'}`;
  if (min % 60 === 0) return `${min / 60} h`;
  if (min > 60) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${min} min`;
}

/** Como a tela mostra o número: a maior unidade que divide certinho dentre as que o robô aceita. */
export function emUnidade(regra: string, minutos: number): { numero: number; unidade: UnidadeDeTempo } {
  const e = TEMPO[regra];
  const ordem: UnidadeDeTempo[] = ['dias', 'horas', 'minutos'];
  for (const u of ordem) {
    if (e && !e.unidades.includes(u)) continue;
    if (minutos % MINUTOS_POR_UNIDADE[u] === 0) return { numero: minutos / MINUTOS_POR_UNIDADE[u], unidade: u };
  }
  const u = e?.unidades[e.unidades.length - 1] ?? 'minutos';
  return { numero: Math.round(minutos / MINUTOS_POR_UNIDADE[u]), unidade: u };
}

/** «24 h antes da consulta», «48 h depois de virar Perdido», «4 dias depois da consulta». */
export function etiquetaDoTempo(regra: string, minutos: number): string {
  const e = TEMPO[regra];
  if (!e) return '';
  return `${descreverMinutos(minutos)} ${e.direcao} ${e.ancora}`;
}
