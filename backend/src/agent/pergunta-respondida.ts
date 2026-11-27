/**
 * A Sofia perguntando de novo o que o paciente JÁ respondeu: há quanto tempo dói, em que cidade ele mora, como a dor
 * atrapalha a rotina. Às vezes 2 ou 3 vezes na mesma conversa (relatório "por que a Sofia não converte", 27/11/2026,
 * 136 conversas lidas). A trava que existia (`repeticao.ts`) só cobria o PEDIDO DE NOME e a mesma pergunta SEM resposta;
 * aqui é o contrário: a pergunta teve resposta — na conversa ou no cartão — e ela foi feita mesmo assim.
 *
 * Duas camadas, como no nome:
 *  1. o bloco `<ja_respondido>` no prompt, e a lista `<falta_para_agendar>` sem o que já foi dito;
 *  2. depois da resposta do modelo, se ela repete uma dessas perguntas, o grafo a refaz UMA vez sem a pergunta.
 *
 * Função pura sobre a lista de falas e os fatos do cartão — sem banco, sem Kommo — para testar com conversa de
 * verdade. A resposta só conta quando há evidência: na dúvida, NÃO diz que foi respondida (perguntar uma vez a mais é
 * ruim; deixar de perguntar a cidade e oferecer horário a quem mora longe é pior).
 */
import { cidadeConhecida, type Fatos } from './falta-para-agendar.js';
import { perguntasDe, respostaVazia, type Fala } from './repeticao.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { ehSoCumprimento } from '../lib/pediu-para-parar.js';

export type Tema = 'tempo de dor' | 'cidade' | 'impacto na rotina';

export interface JaRespondida {
  tema: Tema;
  /** O que ele disse (ou o fato do cartão), curto, para a IA citar em meia frase. */
  trecho: string;
  origem: 'conversa' | 'cartão';
}

/** Chave `pergunta-ja-respondida` (automacoes.ts): nasce LIGADA na rede toda; a tela desliga por unidade. */
export function perguntaJaRespondidaLigada(slug: string): boolean {
  return automacaoLigada(slug, 'pergunta-ja-respondida', process.env.PERGUNTA_JA_RESPONDIDA_SLUGS);
}

// ── Que pergunta é esta ─────────────────────────────────────────────────────────────────────────────────

const PERGUNTA_TEMPO = /h[aá]\s+quanto\s+tempo|desde\s+quando|faz\s+quanto\s+tempo|quanto\s+tempo\s+(?:faz|j[aá]|voc[eê]\s+(?:sente|tem|est[aá]))|quando\s+(?:isso\s+|a\s+dor\s+)?(?:come[cç]ou|surgiu)/i;
const PERGUNTA_CIDADE =
  /\bmora\s+(?:aqui\s+)?(?:em|no|na|perto)\b|\bmoram\s+(?:em|no|na)\b|qual\s+(?:[eé]\s+)?(?:a\s+)?(?:sua\s+)?cidade|(?:de\s+)?(?:qual|que)\s+cidade|em\s+que\s+cidade|de\s+onde\s+(?:voc[eê]|vc)\s+[eé]|(?:voc[eê]|vc)\s+[eé]\s+de\s+onde|onde\s+(?:voc[eê]|vc)\s+mora/i;
const PERGUNTA_IMPACTO = new RegExp(
  [
    String.raw`(?:atrapalh|impact|afet|limit|interfer|prejudic)\w*[^?.!]{0,70}(?:rotina|dia\s+a\s+dia|trabalho|sono|dormir|atividades?|vida|no\s+seu\s+dia)`,
    String.raw`(?:rotina|dia\s+a\s+dia|trabalho|sono)[^?.!]{0,50}(?:atrapalh|impact|afet|limit|interfer|prejudic)\w*`,
    String.raw`o\s+que\s+(?:mais\s+)?(?:a\s+)?(?:dor\s+)?(?:te\s+)?(?:impede|atrapalha|limita)`,
    String.raw`como\s+(?:isso|a\s+dor|essa\s+dor)\s+(?:tem\s+)?(?:te\s+)?(?:afet|impact|atrapalh)\w*`,
    String.raw`(?:consegue|est[aá]\s+conseguindo)\s+(?:trabalhar|dormir|fazer\s+suas?\s+atividades)`,
  ].join('|'),
  'i',
);

/** Outras coisas que a mesma frase pode estar perguntando ("onde dói e há quanto tempo?"): aí a fala curta não diz qual respondeu. */
const PERGUNTA_DE_OUTRO_ASSUNTO =
  /onde\s+(?:[eé]\s+)?(?:que\s+)?(?:d[oó]i|sente)|qual\s+(?:a\s+)?regi[aã]o|em\s+que\s+(?:parte|regi[aã]o)|como\s+(?:eu\s+)?posso\s+te\s+chamar|(?:qual|seu)\s+(?:[eé]\s+)?(?:o\s+)?(?:seu\s+)?nome|(?:qual|que)\s+hor[aá]rio|qual\s+dia/i;

const PERGUNTAS: Array<[Tema, RegExp]> = [
  ['tempo de dor', PERGUNTA_TEMPO],
  ['cidade', PERGUNTA_CIDADE],
  ['impacto na rotina', PERGUNTA_IMPACTO],
];

/** Do que trata a pergunta (um dos 3 temas), ou null. */
export function temaDaPergunta(pergunta: string): Tema | null {
  for (const [tema, re] of PERGUNTAS) if (re.test(pergunta)) return tema;
  return null;
}

// ── O paciente já respondeu? ────────────────────────────────────────────────────────────────────────────

function semAcento(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** A fala como ele escreveu, sem as marcas do sistema ("[áudio do cliente]:"); a transcrição fica. */
function falaLimpa(texto: string): string {
  return texto.replace(/\[[^\]]*\]:?/g, ' ').replace(/\s+/g, ' ').trim();
}

const NUM = String.raw`(?:\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta|varios|varias|alguns|algumas|muitos|muitas|meio|meia)`;
const UNID = String.raw`(?:dias?|semanas?|quinzenas?|mes|meses|anos?)`;
const APROX = String.raw`(?:(?:uns|umas|cerca\s+de|quase|mais\s+de|menos\s+de|aproximadamente|mais\s+ou\s+menos)\s+)*`;
// sem "tem/tenho": "tenho 40 anos" é a idade, não o tempo da dor
const TEMPO_COM_VERBO = new RegExp(String.raw`\b(?:ha|faz|fazem|ja\s+faz)\s+${APROX}${NUM}\s+${UNID}\b`);
const TEMPO_SEM_VERBO = new RegExp(String.raw`\b${APROX}${NUM}\s+${UNID}\b`, 'g');
/** "em 2 semanas", "daqui 15 dias", "por 3 meses": prazo que vem, não há quanto tempo dói. */
const ANTES_DE_PRAZO = /(?:^|\s)(?:em|daqui|dentro|cada|por|pra|para|ate|depois|durante|nos|nas|ultimos|ultimas|proximos|proximas|a)\s*$/;
/** A idade ("tenho 40 anos", "aos 52", "40 anos de idade") não é o tempo da dor. */
const IDADE = /\b(?:tenho|tem|tinha|completei|completou)\s+\d+\s*anos|\d+\s*anos\s+de\s+idade|\baos\s+\d+|\bcom\s+\d+\s*anos/;
const TEMPO_VAGO = /\b(?:ha|faz)\s+(?:muito\s+|bastante\s+)?(?:tempo|tempao|anos|meses)\b|\bha\s+um\s+tempao\b/;
const TEMPO_DESDE =
  /\bdesde\s+(?:o\s+|a\s+|de\s+)?(?:\d{4}|\d{1,2}\/\d{2,4}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|ano\s+passado|mes\s+passado|semana\s+passada|ontem|anteontem|hoje|domingo|segunda|terca|quarta|quinta|sexta|sabado|que\s+\w+|crianca|adolescencia|natal|carnaval)/;

function respostaDeTempo(texto: string): string | null {
  const t = semAcento(falaLimpa(texto));
  const c = TEMPO_COM_VERBO.exec(t) ?? TEMPO_VAGO.exec(t) ?? TEMPO_DESDE.exec(t);
  if (c) return c[0].trim();
  for (const m of t.matchAll(TEMPO_SEM_VERBO)) {
    if (/^um\s+dia$/.test(m[0].trim())) continue; // "um dia eu levantei peso": não é quanto tempo
    if (/anos?$/.test(m[0]) && (IDADE.test(t) || Number(/\d+/.exec(m[0])?.[0] ?? 0) > 15)) continue;
    if (!ANTES_DE_PRAZO.test(t.slice(Math.max(0, m.index - 20), m.index))) return m[0].trim();
  }
  return null;
}

// "moro em Marabá", "moramos no Pará", "resido na capital", "moro aqui perto", "sou de Parauapebas" (com maiúscula: "sou de
// confiança" não é cidade), "venho de Eldorado", "aqui de Canaã".
const CIDADE_MORO =
  /(?<![\p{L}])(?:[Mm]oro|[Mm]orando|[Mm]ora|[Mm]oramos|[Rr]esido|[Rr]esidente)\s+(?:aqui\s+|ali\s+|l[aá]\s+)?(?:(?:em|no|na|perto\s+d[aeo]s?|pr[oó]ximo\s+(?:a|de|do|da))\s+[\p{L}][\p{L}'.-]*|aqui(?:\s+mesmo|\s+perto)?)/u;
// "vim do Instagram" não é cidade
const CIDADE_SOU_DE =
  /(?<![\p{L}])(?:[Ss]ou|[Ss]omos|[Vv]enho|[Vv]im|[Vv]iemos|[Aa]qui|[Dd]aqui)\s+(?:d[aeo]s?|em)\s+(?!(?:Instagram|Facebook|Google|WhatsApp|Whats|Insta|Face|TikTok|YouTube|An[uú]ncio|Site)\b)\p{Lu}[\p{L}'-]+/u;
const CIDADE_SOU_DAQUI = /(?<![\p{L}])[Ss]ou\s+daqui\b|(?<![\p{L}])[Ss]omos\s+daqui\b/u;

function respostaDeCidade(texto: string): string | null {
  const t = falaLimpa(texto);
  const m = CIDADE_MORO.exec(t) ?? CIDADE_SOU_DE.exec(t) ?? CIDADE_SOU_DAQUI.exec(t);
  return m ? m[0].trim() : null;
}

const IMPACTO_RESPOSTA = new RegExp(
  [
    String.raw`\b(?:atrapalh\w*|impede\w*|impedindo|limita\w*|prejudic\w*|incomod\w*)\b`,
    String.raw`\bnao\s+(?:consigo|conseguia|consegue|aguento)\s+(?:mais\s+)?(?:trabalhar|dormir|andar|ficar|levantar|sentar|abaixar|me\s+abaixar|fazer|pegar|carregar|brincar|cuidar|correr|caminhar|treinar|dirigir)`,
    String.raw`\b(?:acordo|acordando|durmo|dormindo)\s+(?:mal|com\s+dor|de\s+madrugada|varias\s+vezes)|\bnao\s+(?:durmo|consigo\s+dormir)`,
    String.raw`\btrabalh\w+\s+(?:com\s+dor|sofrendo|mal)|\b(?:parei|deixei)\s+de\s+(?:trabalhar|treinar|fazer|caminhar|correr)|\bafastad[oa]\b|\batestado\b`,
    String.raw`\bdificuldade\s+(?:pra|para|de|em)\s+(?:trabalhar|andar|dormir|sentar|levantar|ficar)`,
  ].join('|'),
);

function respostaDeImpacto(texto: string): string | null {
  const m = IMPACTO_RESPOSTA.exec(semAcento(falaLimpa(texto)));
  return m ? m[0].trim() : null;
}

const RESPOSTAS: Record<Tema, (texto: string) => string | null> = {
  'tempo de dor': respostaDeTempo,
  cidade: respostaDeCidade,
  'impacto na rotina': respostaDeImpacto,
};

/** O cartão já tem a resposta (os apelidos que a IA inventa para a mesma coisa; fatos-canonicos.ts). */
const FATO_DO_TEMA: Record<Tema, string[]> = {
  'tempo de dor': ['tempo_dor', 'tempo_de_dor', 'duracao', 'duracao_dor'],
  cidade: [],
  'impacto na rotina': ['impacto', 'impacto_rotina', 'impacto_na_rotina', 'limitacao', 'limitacoes', 'atrapalha_rotina', 'impacto_dor'],
};

function doCartao(tema: Tema, fatos: Fatos | null | undefined): string | null {
  if (!fatos) return null;
  if (tema === 'cidade') {
    // a MESMA conta da lista <falta_para_agendar>: `localizacao` (onde dói) e parte do corpo não são cidade
    if (!cidadeConhecida(fatos)) return null;
    const k = ['cidade', 'municipio', 'cidade_paciente', 'mora_em'].find((c) => String(fatos[c] ?? '').trim());
    return k ? String(fatos[k]).trim().slice(0, 60) : 'consegue vir à unidade';
  }
  for (const k of FATO_DO_TEMA[tema]) {
    const v = String(fatos[k] ?? '').trim();
    if (v) return v.slice(0, 80);
  }
  return null;
}

const PALAVRAS_DE_OUTRO_ASSUNTO = /\b(?:pre[cç]o|valor|quanto|custa|hor[aá]rio|consulta|agendar|marcar|dia|plano|conv[eê]nio|pix)\b/i;

/**
 * A fala logo depois de uma pergunta SÓ daquele tema responde a ela? Para tempo e rotina, qualquer fala que não seja vazia,
 * cumprimento nem outra pergunta ("não lembro" também é resposta: perguntar de novo não adianta). Para a cidade é mais
 * estrito (curta, sem pergunta, sem assunto de preço/horário): é ela que decide se há horário a oferecer.
 */
function respostaImediata(tema: Tema, fala: string, anterior: string | null): string | null {
  if (respostaVazia(fala, anterior) || ehSoCumprimento(fala)) return null;
  const t = falaLimpa(fala);
  if (!t || t.includes('?')) return null;
  const palavras = t.split(/\s+/).filter(Boolean);
  if (tema === 'cidade') {
    if (palavras.length > 6 || PALAVRAS_DE_OUTRO_ASSUNTO.test(t)) return null;
    if (/^(?:sim|n[aã]o|ok|okay|t[aá]|isso|aham|uhum|obrigad[oa]|pode\s+ser)\b/i.test(t)) return null;
    return t.slice(0, 60);
  }
  if (PALAVRAS_DE_OUTRO_ASSUNTO.test(t) && palavras.length <= 6) return null;
  return t.slice(0, 80);
}

/**
 * O que o paciente já respondeu, nesta conversa ou no cartão. `falas` na ordem; só conta até a última fala do paciente
 * (a deste turno entra: se ele respondeu agora, não se pergunta de novo).
 */
export function jaRespondidas(falasTodas: Fala[], fatos?: Fatos | null): JaRespondida[] {
  let fim = falasTodas.length - 1;
  while (fim >= 0 && falasTodas[fim].papel !== 'paciente') fim--;
  const falas = fim >= 0 ? falasTodas.slice(Math.max(0, fim + 1 - 30), fim + 1) : [];
  const saida: JaRespondida[] = [];

  for (const [tema] of PERGUNTAS) {
    // 1) o que ele escreveu, em qualquer fala (a resposta pode vir ANTES da pergunta: "tenho dor há 3 anos" no 1º contato)
    let achada: string | null = null;
    for (const f of falas) {
      if (f.papel !== 'paciente') continue;
      achada = RESPOSTAS[tema](f.texto);
      if (achada) break;
    }
    if (achada) {
      saida.push({ tema, trecho: achada, origem: 'conversa' });
      continue;
    }
    // 2) a fala logo depois de uma pergunta da IA que era SÓ deste tema
    for (let i = 0; i < falas.length && !achada; i++) {
      if (falas[i].papel !== 'ia') continue;
      const qs = perguntasDe(falas[i].texto);
      if (qs.length !== 1 || temaDaPergunta(qs[0]) !== tema) continue;
      // "onde dói e há quanto tempo?" / "onde dói e em qual cidade você mora?": a fala curta pode ser só a outra metade
      if (PERGUNTA_DE_OUTRO_ASSUNTO.test(qs[0]) || PERGUNTAS.some(([t, re]) => t !== tema && re.test(qs[0]))) continue;
      for (let j = i + 1; j < falas.length && falas[j].papel === 'paciente' && !achada; j++) {
        const anterior = [...falas.slice(0, j)].reverse().find((x) => x.papel === 'paciente')?.texto ?? null;
        achada = respostaImediata(tema, falas[j].texto, anterior);
      }
    }
    if (achada) {
      saida.push({ tema, trecho: achada, origem: 'conversa' });
      continue;
    }
    // 3) o cartão
    const doFato = doCartao(tema, fatos);
    if (doFato) saida.push({ tema, trecho: doFato, origem: 'cartão' });
  }
  return saida;
}

/** O rótulo da lista <falta_para_agendar> que cada tema resolve (o de rotina não está na lista). */
export function rotulosRespondidos(ja: readonly JaRespondida[]): string[] {
  return ja.filter((r) => r.tema !== 'impacto na rotina').map((r) => r.tema);
}

// ── O que o modelo lê, e a trava da resposta ───────────────────────────────────────────────────────────

const COMO_NAO_PERGUNTAR: Record<Tema, string> = {
  'tempo de dor': 'NÃO pergunte "há quanto tempo", "desde quando" nem "quando começou"',
  cidade: 'NÃO pergunte a cidade nem "onde você mora"',
  'impacto na rotina': 'NÃO pergunte como a dor atrapalha a rotina, o trabalho ou o sono',
};

export function renderJaRespondido(ja: readonly JaRespondida[]): string {
  if (ja.length === 0) return '';
  const linhas = ja.map(
    (r) => `- ${r.tema.toUpperCase()}: ele JÁ respondeu ${r.origem === 'cartão' ? '(está no cartão)' : '(na conversa)'}: "${r.trecho.replace(/"/g, "'")}". ${COMO_NAO_PERGUNTAR[r.tema]}.`,
  );
  return (
    '<ja_respondido>\n(contado pelo sistema: perguntar de novo o que o paciente já respondeu é o que mais irrita e faz ele sumir. ' +
    'Use a resposta dele, citando em meia frase se couber, e siga para o próximo passo.)\n' +
    `${linhas.join('\n')}\n</ja_respondido>`
  );
}

/** Os temas já respondidos que a resposta do modelo pergunta de novo. */
export function temasRepetidosNaResposta(resposta: string, ja: readonly JaRespondida[]): Tema[] {
  if (ja.length === 0) return [];
  const respondidos = new Set(ja.map((r) => r.tema));
  const repetidos = new Set<Tema>();
  for (const q of perguntasDe(resposta)) {
    const tema = temaDaPergunta(q);
    if (tema && respondidos.has(tema)) repetidos.add(tema);
  }
  return [...repetidos];
}

export function instrucaoRefazerSemPerguntaRepetida(temas: readonly Tema[], ja: readonly JaRespondida[]): string {
  const lembrete = temas
    .map((t) => ja.find((r) => r.tema === t))
    .filter((r): r is JaRespondida => !!r)
    .map((r) => `${r.tema} ("${r.trecho.replace(/"/g, "'")}")`)
    .join('; ');
  return (
    '[instrução interna, não é fala do paciente] Seu rascunho pergunta de novo o que o paciente JÁ respondeu: ' +
    `${lembrete}. Reescreva a MESMA resposta SEM essa(s) pergunta(s): use o que ele disse (em meia frase, se couber), ` +
    'mantenha o resto e o tom, e termine com o PRÓXIMO passo da conversa (a pergunta seguinte do roteiro, ou o horário se já for a hora). ' +
    'Responda só com a mensagem final.'
  );
}
