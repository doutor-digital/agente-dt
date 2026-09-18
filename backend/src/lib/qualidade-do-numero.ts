/**
 * Vigia da qualidade do número de WhatsApp.
 *
 * A Meta dá uma nota ao número (GREEN / YELLOW / RED) e um teto de envio por
 * dia. Quando a nota cai, o bloqueio costuma vir atrás — e número bloqueado
 * deixa a unidade MUDA sem ninguém entender por quê. É o tipo de coisa que só
 * se descobre pelo efeito: "os pacientes pararam de responder".
 *
 * Por isso isto é vigia, não painel. Qualidade é GREEN em 99% dos dias; virar
 * card na tela seria mais um número que ninguém olha. O aviso só sai quando
 * PIORA — e aí ele interrompe, porque merece interromper.
 *
 * Mesma escolha do guardião da voz: silêncio enquanto está tudo bem.
 */

export type Qualidade = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

/** Pior para melhor. Serve para comparar duas leituras. */
const ORDEM: Record<Qualidade, number> = { RED: 0, YELLOW: 1, GREEN: 2, UNKNOWN: 3 };

export function normalizarQualidade(bruto: unknown): Qualidade {
  const s = String(bruto ?? '').toUpperCase();
  return s === 'GREEN' || s === 'YELLOW' || s === 'RED' ? s : 'UNKNOWN';
}

export interface LeituraDoNumero {
  qualidade: Qualidade;
  /** Teto de envio da Meta, como ela devolve: "TIER_1K", "TIER_10K"… */
  limite: string | null;
}

/**
 * Piorou desde a última leitura?
 *
 * UNKNOWN nunca dispara alerta: "não sei" não é notícia ruim, e a Meta devolve
 * campo vazio de vez em quando. Alerta por ruído é alerta que se aprende a
 * ignorar — e aí o de verdade passa batido.
 */
export function piorou(antes: LeituraDoNumero | null, agora: LeituraDoNumero): boolean {
  if (agora.qualidade === 'UNKNOWN') return false;
  if (!antes || antes.qualidade === 'UNKNOWN') {
    // Primeira leitura conhecida: só avisa se já nasce ruim.
    return agora.qualidade !== 'GREEN';
  }
  if (ORDEM[agora.qualidade] < ORDEM[antes.qualidade]) return true;
  // Teto de envio caiu (TIER_10K → TIER_1K) mesmo com a cor igual.
  return Boolean(antes.limite && agora.limite && antes.limite !== agora.limite && menorTeto(agora.limite, antes.limite));
}

/** "TIER_1K" < "TIER_10K". Compara o número, não o texto. */
function menorTeto(a: string, b: string): boolean {
  const n = (s: string) => {
    const m = /TIER_(\d+)(K|M)?/i.exec(s);
    if (!m) return Number.POSITIVE_INFINITY;
    const base = Number(m[1]);
    return m[2]?.toUpperCase() === 'M' ? base * 1_000_000 : m[2] ? base * 1_000 : base;
  };
  return n(a) < n(b);
}

/** Voltou ao normal — vale uma linha, pra pessoa saber que passou. */
export function melhorou(antes: LeituraDoNumero | null, agora: LeituraDoNumero): boolean {
  if (!antes || agora.qualidade !== 'GREEN') return false;
  return antes.qualidade === 'YELLOW' || antes.qualidade === 'RED';
}

const EXPLICA: Record<string, string> = {
  YELLOW:
    'Amarelo costuma vir de paciente marcando como "não quero receber" ou denunciando. ' +
    'Vale olhar se algum disparo recente incomodou.',
  RED: 'Vermelho é o passo antes do bloqueio. Se bloquear, a unidade fica MUDA no WhatsApp.',
};

export function textoDoAlerta(a: {
  unidade: string;
  numero: string;
  antes: LeituraDoNumero | null;
  agora: LeituraDoNumero;
}): string {
  const de = a.antes?.qualidade ?? 'desconhecida';
  const linhas = [
    `⚠️ *${a.unidade}* · WhatsApp ${a.numero}`,
    '',
    `Qualidade do número: *${de} → ${a.agora.qualidade}*`,
  ];
  if (a.agora.limite) linhas.push(`Limite de envio: ${a.agora.limite}`);
  const p = EXPLICA[a.agora.qualidade];
  if (p) linhas.push('', p);
  return linhas.join('\n');
}

export function textoDaMelhora(a: { unidade: string; numero: string }): string {
  return `✅ *${a.unidade}* · WhatsApp ${a.numero}: qualidade voltou para GREEN.`;
}
