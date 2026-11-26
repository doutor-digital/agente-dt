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
const semAcento = (t: string): string => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** corta por caractere (não por unidade UTF-16): emoji na borda não vira meio-caractere, que o Chatwoot recusaria */
const cortar = (t: string, max: number): string => {
  const cs = Array.from(t);
  return cs.length > max ? `${cs.slice(0, max - 1).join('').trimEnd()}…` : t;
};
/** o que o paciente escreveu vai numa nota que o Chatwoot renderiza (markdown e menção): sem colchete, parêntese, arroba, crase nem link */
const neutro = (t: string): string => t.replace(/[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+/gi, 'link').replace(/[\[\]()@`<>]/g, ' ').replace(/\s+/g, ' ').trim();

/** só o que o paciente escreveu de verdade (sem as marcas «[áudio]» e «[anexo]» que a leitura da conversa põe no lugar do que não é texto) */
function falasDoPaciente(falas: readonly Fala[]): string[] {
  return falas
    .filter((f) => f.role === 'user')
    .flatMap((f) => f.content.split('\n'))
    .map((l) => l.trim())
    .filter((l) => l && l !== '[áudio]' && l !== '[anexo]');
}

// «dor na lombar», «dor de cabeça», «dores nos joelhos»: a preposição é obrigatória («a dor melhorou bastante» não é queixa)
const DOR = /(?<!\p{L})dor(?:es)?\s+(?:n[aoe]s?|d[aoe]s?|em)\s+\p{L}+(?:\s+\p{L}+)?/iu;
const NEGA_ANTES = /(?<![a-z])(?:nao|sem|nenhuma?|nunca)(?![a-z])/;
// o tempo só vale na MESMA linha da dor («dor na lombar há 2 meses»); «meu pai tem 70 anos» não é sintoma
const TEMPO = /(?<!\p{L})(?:h[aá]|faz|fazem)\s+(?:uns\s+|cerca\s+de\s+|quase\s+)?\d+\s+(?:dias?|semanas?|mes(?:es)?|m[eê]s|anos?)(?!\p{L})/iu;
// «dor na lombar de ontem» → o que sobra no fim da captura e não é parte do lugar (palavras de ligação) sai
const LIGACAO = new Set(['que', 'e', 'mas', 'há', 'ha', 'faz', 'desde', 'quando', 'com', 'porque', 'pq', 'de', 'do', 'da', 'em', 'no', 'na', 'ou', 'a', 'o', 'tem']);
function limparDor(captura: string): string | null {
  const palavras = captura.replace(/\s+/g, ' ').trim().split(' ');
  while (palavras.length > 2 && LIGACAO.has(palavras[palavras.length - 1]!.toLowerCase())) palavras.pop();
  return palavras.length >= 3 ? palavras.join(' ') : null;
}
const DIA = /(?<!\p{L})(?:(?:segunda|ter[cç]a|quarta|quinta|sexta)(?:-feira)?|s[aá]bado|domingo)(?!\p{L})/giu;
const PERIODO = /(?<!\p{L})(?:de\s+manh[ãa]|[àa]\s+tarde|[àa]\s+noite|cedo)(?!\p{L})/giu;
/** a linha fala de MARCAR (horário, consulta, vaga…): só nela «quinta» ou «à noite» é preferência de agenda, não sintoma («a dor piora à noite») */
const FALA_DE_AGENDA = /hor[aá]rio|consulta|marcar|agendar|agenda|vaga|posso ir|pode ser|dispon[ií]vel|encaix|\d\s*h(?![a-z])|\b[aà]s\s+\d/i;
const NAO_E_DIA = /segunda\s+(?:opini|vez|via|parte)/i;
const PRECO = /(?<![a-z])(?:preco|valor|valores|custa|custo|quanto\s+(?:custa|e|fica|sai|cobra))(?![a-z])|r\$/;
// «quanto eu vou esperar?» / «quanto tempo demora?» não são pergunta de preço: o «quanto» só vale colado a custa/é/fica/sai/cobra
const PERGUNTA_DE_PRECO = /quanto\s+(?:custa|e|fica|sai|cobra|vai\s+custar)(?![a-z])|qual\s+(?:e\s+)?(?:o\s+)?(?:valor|preco)(?![a-z])|(?:valor|preco|custa)\s*\?/;
const CONVENIO = /(?<![a-z])(?:convenio|plano\s+de\s+saude|unimed|hapvida|amil|bradesco\s+saude|sulamerica|carteirinha)(?![a-z])/;
const EXAME = /(?<![a-z])(?:ressonancia|tomografia|raio[\s-]?x|exames?|laudo|eletroneuromiografia)(?![a-z])/;

const ultimo = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

/** a última fala do paciente que tem TEXTO (as linhas dela sem «[áudio]»/«[anexo]»), juntas por « / »; dois áudios seguidos não viram «áudio / áudio» */
function ultimaFalaComTexto(falas: readonly Fala[]): string {
  for (let i = falas.length - 1; i >= 0; i--) {
    if (falas[i]!.role !== 'user') continue;
    const linhas = falasDoPaciente([falas[i]!]);
    if (linhas.length) return neutro(linhas.join(' / '));
  }
  return '';
}

function queixa(linhas: string[]): string | null {
  for (const l of linhas) {
    const d = DOR.exec(l);
    if (!d) continue;
    if (NEGA_ANTES.test(semAcento(l.slice(Math.max(0, (d.index ?? 0) - 25), d.index)))) continue; // «não tenho dor na lombar»
    const dor = limparDor(d[0]);
    if (!dor) continue;
    const t = TEMPO.exec(l);
    const tempo = t ? t[0].replace(/^(?:faz|fazem)\b/i, 'há').replace(/\s+/g, ' ').trim() : null;
    return cortar(neutro(`${dor}${tempo ? ` ${tempo}` : ''}`), MAX_QUEIXA);
  }
  return null;
}

function quando(linhas: string[]): string | null {
  const agenda = linhas.filter((l) => FALA_DE_AGENDA.test(l) && !DOR.test(l) && !NAO_E_DIA.test(l));
  const todo = agenda.join('\n');
  const dia = ultimo([...todo.matchAll(DIA)])?.[0];
  const periodo = ultimo([...todo.matchAll(PERIODO)])?.[0];
  if (!dia && !periodo) return null;
  return `mencionou ${[dia?.toLowerCase(), periodo?.toLowerCase()].filter(Boolean).join(', ')}`;
}

function dataCurta(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}/${m[2]}` : d;
}

/**
 * A linha «Resumo: …» (sem quebra de linha), ou null se não há nada confiável a dizer. `hoje` (AAAA-MM-DD na unidade): a consulta só entra se estiver
 * Agendada/Confirmada para hoje ou depois (o atributo da conversa fica velho depois da consulta); sem `hoje` ela não entra.
 */
export function resumoDaPassagem(a: { attrs?: Record<string, unknown>; falas?: readonly Fala[]; hoje?: string | null }): string | null {
  try {
    const attrs = a.attrs ?? {};
    const linhas = falasDoPaciente(a.falas ?? []);
    const norm = linhas.map(semAcento);
    const partes: string[] = [];

    const q = queixa(linhas);
    if (q) partes.push(q);
    const dia = txt(attrs.data_consulta);
    const situacao = txt(attrs.situacao_consulta);
    if (dia && a.hoje && /^\d{4}-\d{2}-\d{2}$/.test(dia) && dia >= a.hoje && /^(agendado|confirmado)$/i.test(situacao)) {
      partes.push(`consulta ${situacao}: ${dataCurta(dia)}${txt(attrs.hora_consulta) ? ` às ${txt(attrs.hora_consulta)}` : ''}`);
    }
    const quer = quando(linhas);
    if (quer) partes.push(quer);
    const idxPreco = norm.map((l, i) => (PRECO.test(l) ? i : -1)).filter((i) => i >= 0);
    if (idxPreco.length) partes.push(idxPreco.some((i) => PERGUNTA_DE_PRECO.test(norm[i]!)) ? 'perguntou preço' : 'falou de preço');
    if (norm.some((l) => CONVENIO.test(l))) partes.push('falou de convênio/plano');
    if (norm.some((l) => EXAME.test(l))) partes.push('falou de exame');
    const qualif = neutro(txt(attrs.qualificacao));
    if (qualif) partes.push(`qualificação ${qualif}`);
    // a última fala INTEIRA do paciente (as linhas dela juntas), não só a última linha
    const fala = ultimaFalaComTexto(a.falas ?? []);
    if (fala) partes.push(`última fala: «${cortar(fala, MAX_ULTIMA_FALA)}»`);

    return partes.length ? `Resumo: ${partes.join(' · ')}` : null;
  } catch {
    // o resumo é só um enfeite da nota: nada aqui pode impedir de passar a conversa para a equipe
    return null;
  }
}
