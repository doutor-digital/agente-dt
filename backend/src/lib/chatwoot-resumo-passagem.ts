/**
 * O «Resumo» de uma linha na nota privada quando a Sofia passa a conversa para a equipe (pedido de 26/11/2026: «a Sofia passa para a equipe e
 * ninguém pega» — quem abre a conversa precisa ver em 5 segundos do que se trata, sem rolar 24 mensagens).
 *
 *   Resumo: dor na lombar há 2 meses · mencionou quinta, à tarde · perguntou preço · última fala: «posso ir amanhã?»
 *
 * SEM chamada de IA e SEM inventar: cada pedaço é ou um atributo que a conversa JÁ TEM (consulta, qualificação) ou um trecho tirado, palavra
 * por palavra, do que o PACIENTE escreveu (queixa, dia e período citados, o último recado) ou uma palavra-chave do que ele escreveu (preço,
 * convênio, exame). Não achou nada confiável = sem resumo (null): a nota fica como sempre foi.
 */
import type { Fala } from './chatwoot-sofia.js';

const MAX_ULTIMA_FALA = 110;
const MAX_QUEIXA = 60;

const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** só o que o paciente escreveu de verdade (sem as marcas «[áudio]» e «[anexo]» que a leitura da conversa põe no lugar do que não é texto) */
function falasDoPaciente(falas: readonly Fala[]): string[] {
  return falas
    .filter((f) => f.role === 'user')
    .flatMap((f) => f.content.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l && l !== '[áudio]' && l !== '[anexo]');
}

const DOR = /\bdor(?:es)?\s+(?:(?:n[aoe]s?|d[aoe]s?|em|no|na|nas|nos)\s+)?\p{L}+(?:\s+\p{L}+)?/iu;
const TEMPO = /\b(?:h[aá]|faz|fazem|tem)\s+(?:uns\s+|cerca\s+de\s+|quase\s+)?\d+\s+(?:dias?|semanas?|mes(?:es)?|m[eê]s|anos?)\b/iu;
// «dor na lombar de ontem» → o que sobra no fim da captura e não é parte do lugar (palavras de ligação) sai
const LIGACAO = new Set(['que', 'e', 'mas', 'há', 'ha', 'faz', 'desde', 'quando', 'com', 'porque', 'pq', 'de', 'do', 'da', 'em', 'no', 'na', 'ou', 'a', 'o', 'tem']);
function limparDor(captura: string): string | null {
  const palavras = captura.replace(/\s+/g, ' ').trim().split(' ');
  while (palavras.length > 1 && LIGACAO.has(palavras[palavras.length - 1]!.toLowerCase())) palavras.pop();
  return palavras.length >= 2 ? palavras.join(' ') : null;
}
const DIA = /(?<!\p{L})(?:(?:segunda|ter[cç]a|quarta|quinta|sexta)(?:-feira)?|s[aá]bado|domingo|amanh[ãa]|hoje)(?!\p{L})/giu;
const PERIODO = /(?<!\p{L})(?:de\s+manh[ãa]|[àa]\s+tarde|[àa]\s+noite|cedo)(?!\p{L})/giu;
const PRECO = /pre[cç]o|valor|quanto\s+(?:custa|[eé]|fica|sai|cobra)|custa\b|r\$/iu;
const PERGUNTA_DE_PRECO = /quanto|qual\s+(?:[eé]\s+)?o\s+(?:valor|pre[cç]o)|\?/iu;
const CONVENIO = /conv[eê]nio|plano\s+de\s+sa[uú]de|unimed|hapvida|amil|bradesco\s+sa[uú]de|sulam[eé]rica|carteirinha/iu;
const EXAME = /resson[aâ]ncia|tomografia|raio[\s-]?x|exame|laudo|eletroneuromiografia/iu;

const ultimo = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

function queixa(linhas: string[]): string | null {
  let dor: string | null = null;
  let tempo: string | null = null;
  for (const l of linhas) {
    const d = DOR.exec(l);
    if (d) dor = limparDor(d[0]) ?? dor;
    const t = TEMPO.exec(l);
    if (t) tempo = t[0].replace(/^(?:faz|fazem|tem)\b/i, 'há').replace(/\s+/g, ' ').trim();
  }
  if (!dor && !tempo) return null;
  const q = dor ? `${dor}${tempo ? ` ${tempo}` : ''}` : `tempo citado: ${tempo}`;
  return q.length > MAX_QUEIXA ? `${q.slice(0, MAX_QUEIXA - 1).trimEnd()}…` : q;
}

function quando(linhas: string[]): string | null {
  const todo = linhas.join('\n');
  const dia = ultimo([...todo.matchAll(DIA)])?.[0];
  const periodo = ultimo([...todo.matchAll(PERIODO)])?.[0];
  if (!dia && !periodo) return null;
  return `mencionou ${[dia?.toLowerCase(), periodo?.toLowerCase()].filter(Boolean).join(', ')}`;
}

function dataCurta(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}/${m[2]}` : d;
}

/** A linha «Resumo: …» (sem quebra de linha), ou null se não há nada confiável a dizer. */
export function resumoDaPassagem(a: { attrs?: Record<string, unknown>; falas?: readonly Fala[] }): string | null {
  const attrs = a.attrs ?? {};
  const linhas = falasDoPaciente(a.falas ?? []);
  const partes: string[] = [];

  const q = queixa(linhas);
  if (q) partes.push(q);
  const dia = txt(attrs.data_consulta);
  if (dia) partes.push(`consulta ${txt(attrs.situacao_consulta).toLowerCase() || 'marcada'} ${dataCurta(dia)}${txt(attrs.hora_consulta) ? ` às ${txt(attrs.hora_consulta)}` : ''}`);
  const quer = quando(linhas);
  if (quer) partes.push(quer);
  const falouPreco = linhas.filter((l) => PRECO.test(l));
  if (falouPreco.length) partes.push(falouPreco.some((l) => PERGUNTA_DE_PRECO.test(l)) ? 'perguntou preço' : 'falou de preço');
  if (linhas.some((l) => CONVENIO.test(l))) partes.push('falou de convênio/plano');
  if (linhas.some((l) => EXAME.test(l))) partes.push('falou de exame');
  const qualif = txt(attrs.qualificacao);
  if (qualif) partes.push(`qualificação ${qualif}`);
  const fala = ultimo(linhas);
  if (fala) partes.push(`última fala: «${fala.length > MAX_ULTIMA_FALA ? `${fala.slice(0, MAX_ULTIMA_FALA - 1).trimEnd()}…` : fala}»`);

  return partes.length ? `Resumo: ${partes.join(' · ')}` : null;
}
