/**
 * Os FREIOS do disparo — puros. Quem manda (o worker) só pergunta; os números moram aqui e no ambiente.
 *
 * Por que cada um existe:
 *  - janela de horário: nada de madrugada nem domingo/feriado — mensagem de marketing às 3h é bloqueio e denúncia;
 *  - teto por hora e por dia, POR UNIDADE: cada unidade tem o seu número e o seu tier na Meta (limite de 24 h).
 *    O teto NÃO é compartilhado entre unidades: um número que estoura não pode calar as outras oito;
 *  - parada por SAIR: a regra que o João já usava no Outubro Rosa — "mais de 3 SAIR? parar a unidade";
 *  - parada por falhas seguidas: token vencido ou número bloqueado faria o robô queimar a lista inteira como "falhou";
 *  - validade da aprovação: o João aprovou ESTA lista, daquele dia — não uma de semanas atrás.
 */
import { dataLocalISO, diaDaSemana, ehFeriadoNacional } from '../feriados.js';
import { offsetMinutosNoFuso } from '../fuso.js';

export interface Freios {
  /** hora local (inclusive) em que a janela abre */
  janelaInicio: number;
  /** hora local (exclusive) em que a janela fecha: 18 = última mensagem às 17h59 */
  janelaFim: number;
  /** segunda a sexta; sábado, domingo e feriado nacional ficam de fora */
  soDiasUteis: boolean;
  tetoPorHora: number;
  tetoPorDia: number;
  /** a unidade para quando passa de N pessoas que responderam SAIR (mais de 3, como no Outubro Rosa) */
  maxSair: number;
  /** N falhas SEGUIDAS na unidade pausam a onda */
  falhasSeguidas: number;
  /** rodadas SEGUIDAS em que a Meta pediu para esperar (limite de taxa): passou disto, pausa a unidade e alerta (esperar para sempre é martelar) */
  limiteDeTaxaSeguidos: number;
  /** quantas pessoas por rodada do worker */
  lote: number;
  /** pausa entre uma mensagem e outra, em ms */
  pausaMs: number;
  /** a aprovação vale por N dias: onda aprovada em seco e ligada semanas depois não sai com a lista velha */
  validadeDias: number;
}

export const FREIOS_PADRAO: Freios = {
  janelaInicio: 9,
  janelaFim: 18,
  soDiasUteis: true,
  tetoPorHora: 30,
  tetoPorDia: 100,
  maxSair: 3,
  falhasSeguidas: 5,
  limiteDeTaxaSeguidos: 10,
  lote: 10,
  pausaMs: 1_500,
  validadeDias: 7,
};

function inteiro(v: string | undefined, padrao: number, min: number, max: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

/** Os freios com o que o ambiente sobrescreve. Valor ilegível volta ao padrão: nunca vira "sem teto". */
export function freiosDoAmbiente(env: NodeJS.ProcessEnv = process.env): Freios {
  const p = FREIOS_PADRAO;
  const inicio = inteiro(env.DISPARO_JANELA_INICIO, p.janelaInicio, 0, 23);
  const fim = inteiro(env.DISPARO_JANELA_FIM, p.janelaFim, 1, 24);
  return {
    janelaInicio: fim > inicio ? inicio : p.janelaInicio,
    janelaFim: fim > inicio ? fim : p.janelaFim,
    soDiasUteis: env.DISPARO_SO_DIAS_UTEIS !== '0',
    tetoPorHora: inteiro(env.DISPARO_TETO_HORA, p.tetoPorHora, 1, 1_000),
    tetoPorDia: inteiro(env.DISPARO_TETO_DIA, p.tetoPorDia, 1, 10_000),
    maxSair: inteiro(env.DISPARO_MAX_SAIR, p.maxSair, 0, 1_000),
    falhasSeguidas: inteiro(env.DISPARO_FALHAS_SEGUIDAS, p.falhasSeguidas, 1, 100),
    limiteDeTaxaSeguidos: inteiro(env.DISPARO_LIMITE_DE_TAXA_SEGUIDOS, p.limiteDeTaxaSeguidos, 1, 100),
    lote: inteiro(env.DISPARO_LOTE, p.lote, 1, 100),
    pausaMs: inteiro(env.DISPARO_PAUSA_MS, p.pausaMs, 0, 60_000),
    validadeDias: inteiro(env.DISPARO_VALIDADE_DIAS, p.validadeDias, 1, 90),
  };
}

function horaLocal(agora: Date, tz: string): number {
  const min = (agora.getUTCHours() * 60 + agora.getUTCMinutes() + offsetMinutosNoFuso(agora, tz) + 1440) % 1440;
  return Math.floor(min / 60);
}

/** `ok` quando pode mandar agora; senão o motivo, para o log e a tela. */
export function dentroDaJanela(agora: Date, tz: string, f: Freios): { ok: true } | { ok: false; motivo: string } {
  const dia = dataLocalISO(agora, tz);
  if (f.soDiasUteis) {
    const semana = diaDaSemana(dia, true);
    if (semana === 'sáb') return { ok: false, motivo: 'sábado' };
    if (semana === 'dom') return { ok: false, motivo: 'domingo' };
    if (ehFeriadoNacional(dia)) return { ok: false, motivo: 'feriado' };
  }
  const h = horaLocal(agora, tz);
  if (h < f.janelaInicio || h >= f.janelaFim) return { ok: false, motivo: `fora da janela ${f.janelaInicio}h–${f.janelaFim}h (agora ${h}h)` };
  return { ok: true };
}

/** Quantas mensagens ainda cabem agora, dado o que a unidade já mandou na última hora e nas últimas 24 h. */
export function vagas(f: Freios, naUltimaHora: number, nasUltimas24h: number): number {
  return Math.max(0, Math.min(f.tetoPorHora - naUltimaHora, f.tetoPorDia - nasUltimas24h, f.lote));
}

/** Passou do limite? "Mais de N": com N = 3, a 4ª pessoa que responde SAIR para a unidade. */
export function passouDoLimiteDeSair(sairam: number, f: Freios): boolean {
  return sairam > f.maxSair;
}

/** As últimas respostas da Meta (mais recente primeiro): todas falhas e já N? Então algo está quebrado, não é a lista. */
export function falhasSeguidasDemais(ultimos: ReadonlyArray<'enviado' | 'falhou'>, f: Freios): boolean {
  return ultimos.length >= f.falhasSeguidas && ultimos.slice(0, f.falhasSeguidas).every((e) => e === 'falhou');
}

/** O que o ambiente pediu e NÃO valeu (o código volta ao padrão em silêncio; o worker lê isto e avisa no log). */
export function avisosDoAmbiente(env: NodeJS.ProcessEnv = process.env): string[] {
  const avisos: string[] = [];
  const f = freiosDoAmbiente(env);
  if ((env.DISPARO_JANELA_INICIO ?? env.DISPARO_JANELA_FIM) !== undefined && (f.janelaInicio !== inteiro(env.DISPARO_JANELA_INICIO, f.janelaInicio, 0, 23) || f.janelaFim !== inteiro(env.DISPARO_JANELA_FIM, f.janelaFim, 1, 24))) {
    avisos.push(`DISPARO_JANELA_INICIO/FIM não valem juntos (início ${env.DISPARO_JANELA_INICIO ?? '—'}, fim ${env.DISPARO_JANELA_FIM ?? '—'}): ficou ${f.janelaInicio}h–${f.janelaFim}h`);
  }
  for (const [chave, valor] of Object.entries({ DISPARO_TETO_HORA: f.tetoPorHora, DISPARO_TETO_DIA: f.tetoPorDia, DISPARO_MAX_SAIR: f.maxSair, DISPARO_FALHAS_SEGUIDAS: f.falhasSeguidas, DISPARO_LIMITE_DE_TAXA_SEGUIDOS: f.limiteDeTaxaSeguidos, DISPARO_LOTE: f.lote, DISPARO_PAUSA_MS: f.pausaMs, DISPARO_VALIDADE_DIAS: f.validadeDias })) {
    const bruto = env[chave];
    if (bruto !== undefined && bruto.trim() !== '' && Number(bruto) !== valor) avisos.push(`${chave}="${bruto}" não vale: ficou ${valor}`);
  }
  return avisos;
}
