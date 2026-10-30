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
/** A opção que só existe por causa do antecipado: "Pix antecipado", "Pix". */
const OPCAO_DO_ANTECIPADO = /antecipad|\bpix\b/i;
/** A opção fala de forma de pagamento (para saber que a linha INTEIRA é a pergunta de pagamento). */
const OPCAO_DE_PAGAMENTO = /antecipad|\bpix\b|\bpag\w+|na\s+cl[ií]nica|no\s+dia|cart[aã]o|dinheiro|d[eé]bito|cr[eé]dito/i;

/**
 * Tira dos botões a opção do antecipado. Linha só de forma de pagamento ("Pix antecipado | Na clínica") some inteira; linha
 * mista ("Terça 10h | Quarta 14h | Pix antecipado") perde só a opção; sobrando menos de 2 opções, a linha some.
 */
function semBotoesDePagamento(texto: string): { texto: string; saiu: boolean } {
  let saiu = false;
  const novo = texto.replace(LINHA_DE_BOTOES, (inteiro, lista: string) => {
    const opcoes = lista.split('|').map((o) => o.trim()).filter(Boolean);
    if (!opcoes.some((o) => OPCAO_DO_ANTECIPADO.test(o))) return inteiro;
    saiu = true;
    const ficam = opcoes.filter((o) => !OPCAO_DO_ANTECIPADO.test(o));
    if (opcoes.every((o) => OPCAO_DE_PAGAMENTO.test(o)) || ficam.length < 2) return '\n';
    return `[[botoes: ${ficam.join(' | ')}]]`;
  });
  if (!saiu) return { texto, saiu };
  return { texto: novo.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), saiu };
}

// ── frases ──────────────────────────────────────────────────────────────────────────────────────────────

/** Negação DA ORAÇÃO (depois da última vírgula/ponto): "não precisa pagar antecipado". "Sem problema" não nega nada; "Não se preocupe, pode pagar antecipado" também não (a vírgula separa). */
const NEGACAO = /\b(?:n[ãa]o|nunca|nem|dispensa|sem\s+(?:precisar|necessidade|ter\s+que|obrigat\w+))\b/i;
/** Até 4 palavras entre as duas pontas: "Pix (garante seu horário)", mas não "Para reservar, o pagamento é no dia, pode ser pix". */
const PERTO = String.raw`\W+(?:[\p{L}\p{N}]+\W+){0,4}?`;
const PIX = String.raw`(?:pix|chave)`;
/** Verbos de OFERTA ("garante", "reservar"): "horário reservado" / "vaga garantida" (estado, não oferta) ficam de fora. */
const RESERVA = String.raw`(?:garant(?:e|em|ir|indo|iria)|reserv(?:a|ar|e|am|ando)|segur(?:a|ar|e|am)|sinal|entrada|dep[oó]sito)`;
const PIX_PARA_RESERVAR = new RegExp(`\\b${RESERVA}${PERTO}${PIX}\\b|\\b${PIX}${PERTO}${RESERVA}\\b`, 'iu');
/** Chave Pix ou comprovante sendo pedido/entregue: "envia a chave do PIX", "mande o comprovante do Pix". */
const CHAVE_OU_COMPROVANTE_ENVIADO =
  /\b(?:chave|comprovante)\b[^.!?\n]*\b(?:envi\w+|mand\w+|segue|anex\w+)\b|\b(?:envi\w+|mand\w+|segue|anex\w+)\b[^.!?\n]*\b(?:chave|comprovante)\b/i;
/** "antecipada para as 9h", "antecipamos para terça": horário adiantado, não pagamento. */
const HORARIO_ADIANTADO = /^\s+(?:para|pra|em|p\/)\s+(?:a\s+|o\s+|as\s+|às\s+)?(?:\d|amanh|hoje|ontem|seg|ter|qua|qui|sex|s[aá]b|dom|dia\b|semana|cedo|manh)/i;
const ANTECIPADO = /antecipad\w*|adiantad\w*/gi;
/** "pagar antes", "pague antes da consulta": adjacente, para não pegar "pagamento no dia, chegue 10 minutos antes". */
const PAGAR_ANTES = /\b(?:pagar|pague|pagando|pago|paga)\s+(?:a\s+consulta\s+|o\s+valor\s+|tudo\s+)?antes\b/gi;

/** A oração antes de `indice` nega? A negação vale só até a última vírgula/ponto/dois-pontos. */
function negadoAntes(t: string, indice: number): boolean {
  const antes = t.slice(Math.max(0, indice - 60), indice);
  return NEGACAO.test(antes.slice(antes.search(/[^,;.!?:]*$/)));
}

/** O trecho oferece pagar antes / Pix para reservar? "Não precisa pagar antecipado" (negado) não conta. */
function oferecePagamentoAntecipado(trecho: string, pixNaFrase: boolean = /\bpix\b/i.test(trecho)): boolean {
  const temPix = pixNaFrase || /\bpix\b/i.test(trecho);
  const pixReserva = PIX_PARA_RESERVAR.exec(trecho);
  if (pixReserva && !negadoAntes(trecho, pixReserva.index)) return true;
  // chave/comprovante só é de Pix se a frase fala de Pix: "a chave de acesso é na recepção" não é.
  const entrega = temPix ? CHAVE_OU_COMPROVANTE_ENVIADO.exec(trecho) : null;
  if (entrega && !negadoAntes(trecho, entrega.index)) return true;
  for (const m of trecho.matchAll(ANTECIPADO)) {
    if (HORARIO_ADIANTADO.test(trecho.slice((m.index ?? 0) + m[0].length))) continue;
    if (!negadoAntes(trecho, m.index ?? 0)) return true;
  }
  for (const m of trecho.matchAll(PAGAR_ANTES)) {
    if (!negadoAntes(trecho, m.index ?? 0)) return true;
  }
  return false;
}

/** A frase diz que se paga no dia / na clínica? */
const DIZ_PAGAMENTO_NO_DIA = (t: string) => /\b(?:pag\w+|pix|dinheiro|cart[aã]o)\b/i.test(t) && /\b(?:no\s+dia|na\s+cl[ií]nica)\b/i.test(t);

/** "Prefere pagar como?", "Qual a forma de pagamento?": pergunta sobre pagamento. */
const PERGUNTA_DE_PAGAMENTO = /\bpag\w+|\bforma\b/i;
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
  // "…antecipado pelo Pix, a equipe manda a chave": a oração da chave não repete a palavra Pix, mas a frase fala dele
  const pixNaFrase = /\bpix\b/i.test(frase);
  const fim = FIM_DA_FRASE.exec(frase)?.[1] ?? '';
  const corpo = frase.replace(FIM_DA_FRASE, '').replace(/\s*\([^)]*\)/g, (par) => (oferecePagamentoAntecipado(par, pixNaFrase) ? '' : par));
  const partes = corpo.split(SEPARADOR_DE_ORACAO); // [oração, sep, oração, ...]
  const oracoes = partes.filter((_, i) => i % 2 === 0);
  const ficam = oracoes.filter((o) => !oferecePagamentoAntecipado(o, pixNaFrase));
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
    // Saíram os botões de pagamento: a pergunta que vinha ligada a eles ("Prefere pagar como?") não pode ficar sem opções.
    const perguntaSemBotoes = botoes.saiu && /\?[^\p{L}\p{N}]*$/u.test(p.frase) && PERGUNTA_DE_PAGAMENTO.test(p.frase);
    if (/^\s*\[\[/.test(p.frase) || !(oferecePagamentoAntecipado(p.frase) || perguntaSemBotoes)) {
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
