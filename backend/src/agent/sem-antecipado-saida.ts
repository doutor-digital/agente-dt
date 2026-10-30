/**
 * Trava DETERMINÍSTICA de saída para unidade SEM pagamento antecipado (Timbó): a Sofia não oferece Pix antecipado.
 *
 * O #166 (29/10/2026) tirou o antecipado do prompt, da ferramenta `agendar_consulta` e da régua de follow-up. Faltava a
 * guarda na SAÍDA: se o modelo repetir por conta própria "antecipado pelo Pix", "garante seu horário" ligado a Pix, a
 * chave Pix para reservar, ou os botões antigos `[[botoes: Pix antecipado | Na clínica]]` (histórico de quem ouviu isso
 * antes da correção), nada cortava. Aqui:
 *
 *  - o botão de forma de pagamento sai (a linha inteira `[[botoes: …]]`);
 *  - a frase que oferece antecipado / Pix para reservar / chave Pix / "pagar antes" sai da resposta, o resto fica (endereço,
 *    dia, hora). Se a frase tem várias orações ("…às 10h, podendo ser pago na hora ou antecipado por Pix"), sai só a
 *    oração. Se a frase inteira saiu e a resposta não diz como se paga, entra a frase verdadeira (`PAGAMENTO_NO_DIA`);
 *  - "pix" como forma de pagar NO DIA ("dinheiro, pix, débito ou crédito") NÃO é tocado: só pix colado em garantir /
 *    reservar / vaga / sinal / comprovante, ou a palavra "antecipad…", ou chave sendo enviada.
 *
 * Quem chama (guardrail.ts) só aciona isto quando `unidadeSemAntecipado(unit)`. A função em si é pura e, sem nada a cortar,
 * devolve o MESMO texto (byte a byte).
 */
import { PAGAMENTO_NO_DIA } from './pagamento-da-unidade.js';
import { juntarFrases, type Pedaco } from './horario-oferecido.js';
import { frasesSemAbreviacao } from './sem-pronto-socorro.js';

export interface SemAntecipadoNaSaida {
  texto: string;
  /** As frases/orações que saíram, para o rastro. */
  removidas: string[];
  /** A linha `[[botoes: …]]` de forma de pagamento saiu. */
  botoesRemovidos: boolean;
}

// ── botões ──────────────────────────────────────────────────────────────────────────────────────────────

const LINHA_DE_BOTOES = /[ \t]*\[\[\s*bot(?:õ|o)es?\s*:\s*([^\]]*?)\s*\]\][ \t]*/gi;
/** Uma opção que é forma de pagamento: "Pix antecipado", "Pix", "Pagar na clínica", "Antecipado". "Na clínica" sozinha só conta junto de outra. */
const BOTAO_DE_PAGAMENTO = /antecipad|\bpix\b|\bpag\w+/i;

function semBotoesDePagamento(texto: string): { texto: string; saiu: boolean } {
  let saiu = false;
  const novo = texto.replace(LINHA_DE_BOTOES, (inteiro, lista: string) => {
    const opcoes = lista.split('|');
    if (!opcoes.some((o) => BOTAO_DE_PAGAMENTO.test(o))) return inteiro;
    saiu = true;
    return '\n';
  });
  if (!saiu) return { texto, saiu };
  return { texto: novo.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), saiu };
}

// ── frases ──────────────────────────────────────────────────────────────────────────────────────────────

const NEGACAO_ANTES = /\b(?:n[ãa]o|nunca|sem|nem|dispensa)\b/i;
/** Até 4 palavras entre as duas pontas: "(garante seu horário)" colado em "Pix", mas não "Para reservar, o pagamento é no dia, pode ser pix". */
const PERTO = String.raw`\W+(?:[\p{L}\p{N}]+\W+){0,4}?`;
const PIX = String.raw`(?:pix|chave)`;
const RESERVA = String.raw`(?:garant\w*|reserv\w*|segur\w*|vaga|sinal|comprovante)`;
const PIX_PARA_RESERVAR = new RegExp(`\\b${RESERVA}${PERTO}${PIX}\\b|\\b${PIX}${PERTO}${RESERVA}\\b`, 'iu');
/** "envia/manda/segue a chave", "chave … enviar": chave Pix sendo entregue. */
const CHAVE_ENVIADA = /\bchave\b[^.!?\n]*\b(?:envi\w+|mand\w+|pass\w+|segue|informa\w*)\b|\b(?:envi\w+|mand\w+|pass\w+|segue|informa\w*)\b[^.!?\n]*\bchave\b/i;
const ANTECIPADO = /antecipad\w*|adiantad\w*/gi;
/** "pagar antes", "pague antes da consulta": adjacente, para não pegar "pagamento no dia, chegue 10 minutos antes". */
const PAGAR_ANTES = /\b(?:pagar|pague|pagando|pago|paga)\s+(?:a\s+consulta\s+|o\s+valor\s+|tudo\s+)?antes\b/gi;

function negadoAntes(t: string, indice: number): boolean {
  return NEGACAO_ANTES.test(t.slice(Math.max(0, indice - 40), indice));
}

/** O trecho oferece pagar antes / Pix para reservar? "Não precisa pagar antecipado" (negado) não conta. */
function oferecePagamentoAntecipado(trecho: string): boolean {
  if (PIX_PARA_RESERVAR.test(trecho) || CHAVE_ENVIADA.test(trecho)) return true;
  for (const re of [ANTECIPADO, PAGAR_ANTES]) {
    for (const m of trecho.matchAll(new RegExp(re.source, 'gi'))) {
      if (!negadoAntes(trecho, m.index ?? 0)) return true;
    }
  }
  return false;
}

/** A frase diz que se paga no dia / na clínica? */
const DIZ_PAGAMENTO_NO_DIA = (t: string) => /\b(?:pag\w+|pix|dinheiro|cart[aã]o)\b/i.test(t) && /\b(?:no\s+dia|na\s+cl[ií]nica)\b/i.test(t);

const FIM_DA_FRASE = /([.!?…]*[\s\p{Extended_Pictographic}️]*)$/u;
const SEPARADOR_DE_ORACAO = /(,\s+|;\s+|\s[–—-]\s)/;

function palavras(t: string): number {
  return t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

/**
 * Tira da frase só a ORAÇÃO que oferece o antecipado (parênteses incluídos). `null` = a frase inteira sai (sobraria menos de
 * 3 palavras, ou não há oração para separar).
 */
function cortarOracao(frase: string): string | null {
  const fim = FIM_DA_FRASE.exec(frase)?.[1] ?? '';
  const corpo = frase.replace(FIM_DA_FRASE, '').replace(/\s*\([^)]*\)/g, (par) => (oferecePagamentoAntecipado(par) ? '' : par));
  const partes = corpo.split(SEPARADOR_DE_ORACAO); // [oração, sep, oração, ...]
  const oracoes = partes.filter((_, i) => i % 2 === 0);
  const ficam = oracoes.filter((o) => !oferecePagamentoAntecipado(o));
  if (ficam.length === oracoes.length || ficam.length === 0) return null;
  // "…, e o endereço é Rua X": a conjunção que sobra no começo sai
  let resto = ficam.join(', ').trim().replace(/^(?:e|mas|ou|porém|por[eé]m)\s+/i, '');
  resto = resto.replace(/[,;:\s–—-]+$/u, '');
  if (palavras(resto) < 3) return null;
  resto = resto.replace(/^(\P{L}*)(\p{Ll})/u, (_, pre: string, c: string) => pre + c.toUpperCase());
  return `${resto}${fim}`.trimEnd() || null;
}

/**
 * Corta a oferta de pagamento antecipado de uma resposta. Só deve ser chamada para unidade sem antecipado
 * (`unidadeSemAntecipado`). Sem nada a cortar, devolve o mesmo texto.
 */
export function semOAntecipadoNaSaida(texto: string): SemAntecipadoNaSaida {
  if (!texto || !texto.trim()) return { texto, removidas: [], botoesRemovidos: false };
  const botoes = semBotoesDePagamento(texto);
  const removidas: string[] = [];
  const ficam: Array<Pedaco | 'oferta'> = [];
  // marca o lugar da PRIMEIRA frase inteira que saiu: se a resposta não diz como se paga, é onde entra a frase verdadeira
  let lugarDaSubstituta = -1;

  for (const p of frasesSemAbreviacao(botoes.texto)) {
    if (/^\s*\[\[/.test(p.frase) || !oferecePagamentoAntecipado(p.frase)) {
      ficam.push(p);
      continue;
    }
    removidas.push(p.frase.trim());
    const sobra = cortarOracao(p.frase);
    if (sobra) {
      ficam.push({ ...p, frase: sobra });
    } else if (lugarDaSubstituta < 0) {
      lugarDaSubstituta = ficam.length;
      ficam.push({ ...p, frase: PAGAMENTO_NO_DIA });
    }
  }
  if (removidas.length === 0 && !botoes.saiu) return { texto, removidas, botoesRemovidos: false };

  // A substituta só fica se nenhuma outra frase da resposta já diz como se paga (sem repetir a mesma informação).
  const outras = ficam.filter((_, i) => i !== lugarDaSubstituta) as Pedaco[];
  if (lugarDaSubstituta >= 0 && outras.some((p) => DIZ_PAGAMENTO_NO_DIA(p.frase))) ficam.splice(lugarDaSubstituta, 1);

  const final = juntarFrases(ficam as Pedaco[]);
  return { texto: final.trim() ? final : PAGAMENTO_NO_DIA, removidas, botoesRemovidos: botoes.saiu };
}
