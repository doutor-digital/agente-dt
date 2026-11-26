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
import { dataLocalISO } from './feriados.js';
import { fusoDaUnidade } from './fuso.js';

const MAX_ULTIMA_FALA = 110;
const MAX_QUEIXA = 60;

const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const semAcento = (t: string): string => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** corta por caractere (não por unidade UTF-16): emoji na borda não vira meio-caractere, que o Chatwoot recusaria */
const cortar = (t: string, max: number): string => {
  const cs = Array.from(t);
  return cs.length > max ? `${cs.slice(0, max - 1).join('').trimEnd()}…` : t;
};
const TLDS = ['com', 'net', 'org', 'br', 'io', 'app', 'me', 'ly', 'info', 'xyz', 'site', 'online', 'link', 'top', 'club', 'shop', 'click', 'live', 'dev', 'co', 'gl', 'to', 'cc', 'ws', 'bit', 'tk', 'ru', 'cn', 'ml', 'ga', 'cf', 'gq', 'pro', 'edu', 'gov', 'biz', 'web', 'us', 'de', 'pt', 'tv', 'ai', 'fr', 'es', 'it', 'uk', 'ca', 'au', 'in', 'jp', 'mx', 'ar', 'cl', 'pe', 'uy', 'py', 'bo', 've', 'ec', 'store', 'tech', 'blog', 'page', 'cloud', 'one', 'zip'];
/**
 * domínio sem esquema («golpe.com/x»): o Chatwoot também o transforma em link clicável. A parte final (.com, .br…) é MINÚSCULA ou toda MAIÚSCULA: «obrigado.Me
 * ajuda» (ponto sem espaço, «Me» de maiúscula só na primeira) não vira link.
 */
const DOMINIO = new RegExp(`(?<![\\w@.-])(?:[a-zA-Z0-9-]+\\.)+(?:${TLDS.join('|')}|${TLDS.map((t) => t.toUpperCase()).join('|')})(?![a-zA-Z0-9])(?:\\/\\S*)?`, 'g');
/** e-mail inteiro: sem ele a parte do domínio ficaria solta na nota e o Chatwoot a transformaria em link */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** tira link, e-mail, colchete, menção, crase e «<»/«>» do que o paciente escreveu (a nota é renderizada pelo Chatwoot) */
const limpar = (t: string): string =>
  t
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+/gi, 'link')
    .replace(EMAIL, 'e-mail')
    .replace(DOMINIO, 'link')
    .replace(/[\[\]()@`<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** o markdown que sobra (asteriscos, sublinhado, til, cerquilha, barra, barra invertida, exclamação) sai ESCAPADO: nada vira negrito, título, tabela ou imagem */
const escapar = (t: string): string => t.replace(/([\\*_~#|!])/g, '\\$1');
/**
 * o que o paciente escreveu, pronto para a nota: limpo, CORTADO no tamanho (antes de escapar: a barra não conta nem fica solta na borda) e escapado
 */
const neutro = (t: string, max?: number): string => escapar(max ? cortar(limpar(t), max) : limpar(t));

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
// «quanto é o tempo de espera?», «quanto fica longe?»: o «quanto» seguido de tempo/espera/distância não é preço
const NAO_E_PRECO = String.raw`(?!\s+(?:o\s+|a\s+|de\s+|do\s+|da\s+)*(?:tempo|espera|demora|prazo|distancia|longe|perto)(?![a-z]))`;
const PRECO = new RegExp(String.raw`(?<![a-z])(?:precos?|valor(?:es)?|cust(?:a|am|ou|o|os)|quanto\s+(?:custa|custam|e|fica|ficou|sai|cobra|cobram)(?![a-z])${NAO_E_PRECO})(?![a-z])|(?<![a-z])r\$`);
// «quanto eu vou esperar?» / «quanto tempo demora?» não são pergunta de preço: o «quanto» só vale colado a custa/é/fica/sai/cobra (e flexões)
const PERGUNTA_DE_PRECO = new RegExp(String.raw`quanto\s+(?:vai\s+)?(?:cust\w*|cobr\w*|fic\w*|sai\w*|seria|sera|e)(?![a-z])${NAO_E_PRECO}|qual(?:is)?\s+(?:seria\s+|sera\s+|e\s+|sao\s+)?(?:o|os|a|as)?\s*(?:valor(?:es)?|preco(?:s)?)(?![a-z])|(?:valor(?:es)?|precos?|custa|custam)\s*\?`);
const CONVENIO = /(?<![a-z])(?:convenio|plano\s+de\s+saude|unimed|hapvida|amil|bradesco\s+saude|sulamerica|carteirinha)(?![a-z])/;
const EXAME = /(?<![a-z])(?:ressonancia|tomografia|raio[\s-]?x|exames?|laudo|eletroneuromiografia)(?![a-z])/;

const ultimo = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

/**
 * a última fala do paciente que tem TEXTO, dentro do ÚLTIMO turno dele (as falas coladas, sem a Sofia no meio): as linhas dela juntas por « / ». Dois áudios seguidos
 * não viram «áudio / áudio»; e áudio sem texto no fim NÃO traz de volta uma fala de antes da resposta da Sofia (sem texto no turno, sem «última fala»).
 */
function ultimaFalaComTexto(falas: readonly Fala[]): string {
  for (let i = falas.length - 1; i >= 0; i--) {
    if (falas[i]!.role !== 'user') break;
    const linhas = falasDoPaciente([falas[i]!]);
    if (linhas.length) return linhas.join(' / ');
  }
  return '';
}

/** limite de oração: ponto, ponto e vírgula, exclamação, interrogação, quebra, « e », «mas», «porém», «porque», «pois», «enquanto» */
const LIMITE_DA_ORACAO = /[.;!?\n]|\s(?:e|mas|porem|porém|porque|pois|enquanto)\s/i;
/** outra pessoa ou outro assunto entre a dor e o tempo: «dor no joelho, minha mãe faleceu há 2 anos» — o tempo não é da dor */
const OUTRO_ASSUNTO = /(?<![a-z])(?:minha|meu|minhas|meus|mae|pai|marido|esposa|mulher|filho|filha|irma|irmao|avo|avos|tio|tia|amig[oa]|vizinh[oa]|ele|ela|eles|elas|faleceu|morreu|casou|casei|nasceu|nasci|formei|mudei|mudou|aposentou|operou)(?![a-z])/;

/**
 * o tempo («há 2 meses») que é DA dor: na mesma oração (nem «e», «mas», ponto…) e sem outra pessoa ou assunto no meio. Entre os tempos da oração vale o MAIS PRÓXIMO da dor
 * que passa no guarda: depois da dor, o trecho entre os dois não pode ter outra pessoa; antes dela, a fala que vem antes do tempo (até a vírgula) também não.
 */
function tempoDaDor(l: string, ini: number, fim: number): string | null {
  const ate = l.slice(fim).search(LIMITE_DA_ORACAO);
  const depois = ate < 0 ? l.length : fim + ate;
  let antes = 0;
  for (const m of l.slice(0, ini).matchAll(new RegExp(LIMITE_DA_ORACAO.source, 'gi'))) antes = (m.index ?? 0) + m[0].length;
  const oracao = l.slice(antes, depois);
  let melhor: { t: string; dist: number } | null = null;
  for (const t of oracao.matchAll(new RegExp(TEMPO.source, 'giu'))) {
    const a = antes + (t.index ?? 0);
    const b = a + t[0].length;
    let dist: number;
    if (a >= fim) {
      // depois da dor: nada de outra pessoa entre as duas
      if (OUTRO_ASSUNTO.test(semAcento(l.slice(fim, a)))) continue;
      dist = a - fim;
    } else {
      // antes da dor: nada de outra pessoa entre o tempo e a dor, nem na frase que o antecede (até a vírgula): «minha mãe faleceu há 2 anos, tenho dor…»
      const antesDoTempo = l.slice(Math.max(antes, l.lastIndexOf(',', a) + 1), a);
      if (OUTRO_ASSUNTO.test(semAcento(l.slice(b, ini))) || OUTRO_ASSUNTO.test(semAcento(antesDoTempo))) continue;
      dist = ini - b;
    }
    if (!melhor || dist < melhor.dist) melhor = { t: t[0], dist };
  }
  return melhor?.t ?? null;
}

function queixa(linhas: string[]): string | null {
  for (const l of linhas) {
    const d = DOR.exec(l);
    if (!d) continue;
    if (NEGA_ANTES.test(semAcento(l.slice(Math.max(0, (d.index ?? 0) - 25), d.index)))) continue; // «não tenho dor na lombar»
    const dor = limparDor(d[0]);
    if (!dor) continue;
    const bruto = tempoDaDor(l, d.index ?? 0, (d.index ?? 0) + d[0].length);
    const tempo = bruto ? bruto.replace(/^(?:faz|fazem)\b/i, 'há').replace(/\s+/g, ' ').trim() : null;
    return neutro(`${dor}${tempo ? ` ${tempo}` : ''}`, MAX_QUEIXA);
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

/** «hoje» (AAAA-MM-DD) NO FUSO DA UNIDADE: Boa Vista (UTC−4) às 23h30 ainda é o dia anterior ao de São Paulo; a consulta de «hoje» não some cedo nem sobra */
export const hojeDaUnidade = (unit: Parameters<typeof fusoDaUnidade>[0], agora: Date = new Date()): string => dataLocalISO(agora, fusoDaUnidade(unit));

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
    if (fala) partes.push(`última fala: «${neutro(fala, MAX_ULTIMA_FALA)}»`);

    return partes.length ? `Resumo: ${partes.join(' · ')}` : null;
  } catch {
    // o resumo é só um enfeite da nota: nada aqui pode impedir de passar a conversa para a equipe
    return null;
  }
}
