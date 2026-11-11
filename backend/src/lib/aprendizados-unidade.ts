/**
 * Aprendizados escritos pela PRÓPRIA unidade (página pública `/aprendizados/:slug`, com o código da unidade).
 * Pedido de 11/11/2026: a dona de Timbó ajusta a Sofia sem depender do João. A regra entra no bloco
 * `<aprendizados>` do prompt (`renderLessons`), como as do painel.
 *
 * Aqui moram as TRAVAS que a unidade não desliga — o texto é recusado antes de gravar quando mexe em:
 *  - pronto-socorro (a Sofia nunca sugere — decisão de 26/10);
 *  - sinal de alerta (força na perna, xixi, fezes, virilha, febre, emergência): é regra da rede, só o João muda;
 *  - promessa de cura ou de resultado;
 *  - preço, desconto, brinde, parcelamento (só a equipe muda o valor, no cadastro);
 *  - diagnóstico ou remédio.
 * Frase que NEGA o tema com a negação COLADA ao termo ("nunca prometa cura", "não dê desconto") passa: reforça a regra da rede.
 * Sinal de alerta (a lista da rede, `CONDICAO_SINAL_DE_ALERTA`, e o mesmo sinal dito de outro jeito), pronto-socorro/hospital,
 * gratuidade e número de preço não têm exceção nem com negação — qualquer ajuste ali é com o João.
 * É heurística (revisão do sênior no #265): na dúvida recusa, e o João recebe no Telegram cada regra salva para conferir.
 */

import { CONDICAO_SINAL_DE_ALERTA, citaProntoSocorro } from '../agent/sinal-de-alerta.js';

export const CHAVE_APRENDIZADOS = 'aprendizados-pela-unidade';
export const SOURCE_DA_UNIDADE = 'unidade';
export const MIN_CARACTERES = 10;
export const MAX_CARACTERES = 400;
/** Regras ligadas escritas pela unidade: acima disso, ela desliga uma antes de criar outra (o prompt não incha). */
export const MAX_REGRAS_DA_UNIDADE = 25;
/** Prévias por unidade por dia (cada prévia roda o modelo 2× por fala de exemplo). */
export const MAX_PREVIAS_POR_DIA = 10;
export const MAX_FALAS_DA_PREVIA = 3;

export const FALAS_DE_EXEMPLO = [
  'Oi, boa tarde! Quanto custa a consulta?',
  'Tenho hérnia de disco faz 2 anos, dói muito pra sentar. Vocês tratam?',
  'Vou ver com meu marido e depois te falo.',
] as const;

/**
 * Negação COLADA ao termo (até 2 palavras antes, sem vírgula no meio): "nunca prometa cura", "não dê desconto". Negação solta em
 * outro ponto da frase não salva ("Dê 10% de desconto, nunca mais que isso"; "Se o paciente não fechar, ofereça desconto") —
 * achado do sênior no #265. Na dúvida, recusa: o motivo explica e o ajuste vai para o João.
 */
const NEGACAO_COLADA = /(?:^|[\s(])(?:n[aã]o|nunca|jamais|nem|evite|evitar|proibido|sem)\s+(?:[^\s.,;:!?]+\s+){0,2}$/i;

/** Algum trecho do texto casa `re` SEM negação colada antes. */
function semNegacaoColada(texto: string, re: RegExp): boolean {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of texto.matchAll(g)) {
    const antes = texto.slice(Math.max(0, (m.index ?? 0) - 50), m.index);
    if (!NEGACAO_COLADA.test(antes)) return true;
  }
  return false;
}

/** Além da lista da rede (`CONDICAO_SINAL_DE_ALERTA`): o que o paciente fala do mesmo sinal com outras palavras. */
const ALERTA_DITO_DE_OUTRO_JEITO =
  /formig|p[eé]s? (?:\S+ )?ca[ií]d|s[uú]bit|bumbum|n[aá]dega|per[ií]neo|emagrec|perd\w* (?:de )?peso|acord\w* (?:o paciente |ele |a pessoa )?(?:à|a) noite|n[aã]o tem for[cç]a|mij\w*|(?:xixi|urina) na roupa|dorment|adormec|sensibilidade|nas cal[cç]as|n[aã]o sente (?:a |as |mais )?pernas?|pernas? (?:est[aá] |ficou |fica |anda )?(?:fraca|mole)|coc[oô]|evacua|perd\w* (?:de |a )?for[cç]a|for[cç]a (?:na|nas) pernas?|bexiga|intestino|incontin|reten[cç][aã]o|paralis|perdeu (?:o )?movimento|pernas? (?:fraca|falh|bambe|amolec|cede|n[aã]o (?:obedece|aguenta|firma))|falh(?:a|am|ou|aram|ando) (?:a |as )?pernas?|n[aã]o consegue (?:mais )?(?:andar|ficar em p[eé]|mexer|levantar)|controle (?:do|da|de) (?:xixi|urina|fezes|bexiga|intestino)/i;

/** O mesmo pronto-socorro com outro nome (PS, posto, UBS). */
const OUTRO_PRONTO_ATENDIMENTO = /atendimento (?:m[eé]dico )?(?:urgente|imediato)|em outro (?:lugar|servi[cç]o|m[eé]dico)|(?:m[eé]dico|cl[ií]nica|hospital|pronto)\s+de plant[aã]o|(?:lig\w*|chame|chamar|disque|discar?)\s+(?:para |pro |o |ao )?19[23]\b|ambul[aâ]ncia|posto de sa[uú]de|\bPS\b|\bUBS\b|\bpronto[\s-]*socorr/;

const MANDA_AO_HOSPITAL = /\b(?:ir|v[aá]|vai|v[aã]o|procur\w*|lev\w*|mand\w*|encaminh\w*|indic\w*|orient\w*|sugir\w*|sugerir)\s+(?:[^\s.,;:!?]+\s+){0,2}hospita/i;

/** Valor de graça ou "não cobra": sempre do cadastro, com ou sem negação. */
const DE_GRACA = /pela metade|metade do (?:pre[cç]o|valor)|por nossa conta|por conta da (?:casa|cl[ií]nica)|na faixa|sem custo|custo zero|n[aã]o (?:precisa )?pag|gr[aá]tis|gratuit|de gra[cç]a|cortesia|isent|n[aã]o cobr|sem cobrar|brinde|cupom/i;
/** Número de preço: palavra de preço e número (dígitos ou por extenso) na mesma frase, sem ser hora/duração. */
const PALAVRA_DE_PRECO = /consulta|valor|pre[cç]o|cust|cobr|pag|sai por|fica (?:em|por)|reais|r\$/i;
const NUMERO_DE_PRECO =
  /r\$\s*\d|\b\d\s\d\s\d\b|\b\d{2,}(?:[.,]\d+)?\b(?!\s*(?:min|minutos|h\b|hs\b|horas?|dias?|semanas?|meses|anos?|km|metros|sess[oõ]es|vezes|x\b|pacientes))|\b(?:cem|cento|duzent|trezent|quatrocent|quinhent|seiscent|setecent|oitocent|novecent|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|mil)\b/i;

/**
 * Regra que mexe nas ferramentas de segurança ou na urgência (achado do sênior no #265): querer menos LIGAR AGORA é um motivo
 * plausível para escrever "nunca pause a IA" ou "não é urgente" — e é exatamente o que tira a proteção do paciente.
 */
const MEXE_NA_SEGURANCA = /pausar_ia|resumir_lead|sinalDeAlerta|paus\w*\s+(?:a\s+)?(?:ia|sofia|intelig)|ligar agora|n[aã]o (?:d[eê]|marque|ponha) prioridade|n[aã]o (?:[eé]|e|est[aá]|parece) (?:urgente|grave|emerg)|regras? da rede|orienta[cç][aã]o da rede|n[aã]o chame (?:a |o )?(?:equipe|sdr|atendente)|n[aã]o (?:avise|passe para|transfira)|nunca (?:avise|passe|transfira)/i;

/** Regra que tenta desligar as outras (injeção de instrução). */
const MANDA_IGNORAR = /outra assistente|sem regras|sem limites|system prompt|prompt (?:do sistema|completo)|suas instru[cç]|a partir de agora voc[eê]|ignor\w*\s+(?:[^\s.,;:!?]+\s+){0,2}(?:regras?|instru[cç]|orienta|anterior)|esque[cç]a\s+(?:as |todas |tudo|o que|o resto)|desconsider|n[aã]o (?:siga|obede[cç]a|respeite) (?:as |a )?(?:regra|instru)/i;

/** Temas que nem com negação passam: a regra da rede é fixa e o ajuste é com o João. */
function recusaSempre(texto: string): string | null {
  if (citaProntoSocorro(texto) || MANDA_AO_HOSPITAL.test(texto) || OUTRO_PRONTO_ATENDIMENTO.test(texto)) {
    return 'Pronto-socorro e hospital são regra da rede: a Sofia nunca sugere. Esse ajuste é só com o João.';
  }
  if (CONDICAO_SINAL_DE_ALERTA.test(texto) || ALERTA_DITO_DE_OUTRO_JEITO.test(texto)) {
    return 'Sinal de alerta (força ou formigamento nas pernas, xixi, fezes, bexiga, virilha, febre, emergência) é regra da rede e protege o paciente. Esse ajuste é só com o João.';
  }
  if (MEXE_NA_SEGURANCA.test(texto)) return 'A regra não pode mexer em urgência, em pausar a Sofia nem em passar o paciente para a equipe: isso é regra da rede e protege o paciente. Esse ajuste é só com o João.';
  if (MANDA_IGNORAR.test(texto)) return 'A regra não pode mandar a Sofia ignorar ou esquecer as outras regras. Escreva o que ela deve fazer.';
  if (DE_GRACA.test(texto)) return 'Valor, desconto e gratuidade não mudam por aqui: a equipe muda no cadastro da unidade.';
  for (const f of frases(texto)) {
    if (PALAVRA_DE_PRECO.test(f) && NUMERO_DE_PRECO.test(f)) {
      return 'Valor da consulta não muda por aqui: a equipe muda no cadastro da unidade. Escreva a regra sem número de preço.';
    }
  }
  return null;
}

/** Temas que passam só com negação COLADA ("nunca prometa cura", "não dê desconto"). */
const RECUSA_SEM_NEGACAO: Array<{ re: RegExp; motivo: string }> = [
  {
    re: /\bcura\b|\bcurar\b|\bcuramos\b|\bcurado|garant\w* (?:de |a |o )?(?:cura|resultado|melhora)|resultado (?:garantido|certo)|100\s?%|nunca mais (?:vai )?(?:sentir|doer|ter dor)|(?:vai |v[aã]o |fica |ficar[aá]? )(?:ficar )?(?:bom|boa|curad|sem dor|novo em folha)|melhora (?:garantida|certa)|(?:com certeza|garantid\w*|sempre|nunca)\s+(?:[^\s.,;:!?]+\s+){0,3}(?:precis\w*|vai|v[aã]o) (?:de )?(?:operar|cirurgia)|(?:resolve|trata|cura)\w*\s+(?:[^\s.,;:!?]+\s+){0,2}sem (?:operar|cirurgia)|n[aã]o (?:vai|v[aã]o) precisar (?:de )?(?:operar|cirurgia)|(?:[ií]ndice|taxa) de sucesso|quase todos melhoram|prometa|promet\w* (?:que|resultado)|tiro e queda|passa de vez|regrid|volta (?:a trabalhar|ao normal) em|\d+ em cada \d+|\d+\s*%\s*(?:de )?(?:sucesso|melhora|cura|acerto|resultado)|(?:com certeza|garantid\w*|sempre)\s+(?:[^\s.,;:!?]+\s+){0,3}(?:evit\w*|sem) (?:a )?cirurgia|evit\w* (?:a )?cirurgia (?:com certeza|sempre|garantid)|elimin\w* (?:a |sua |de vez a )?dor|(?:a dor|a h[eé]rnia|o problema|a doen[cç]a) (?:some|vai sumir|desaparece|acaba|vai acabar)|(?:resolve|trata|elimina|acaba com)\w*\s+(?:[^\s.,;:!?]+\s+){0,3}(?:definitiv|para sempre|de vez)/i,
    motivo: 'A Sofia não promete cura nem resultado. Escreva a regra sem prometer resultado.',
  },
  {
    re: /descont|promo[cç]|parcel|pre[cç]o (?:novo|diferente|menor|especial)|baixar o (?:pre[cç]o|valor)|abat/i,
    motivo: 'Valor, desconto e parcelamento não mudam por aqui: a equipe muda no cadastro da unidade.',
  },
  {
    re: /provavelmente (?:[eé]|seja|tem)|(?:o caso|o problema) (?:dele|dela|do paciente) [eé]|relaxante|(?:diga|fale|afirme|confirme|responda)\s+(?:[^\s.,;:!?]+\s+){0,3}(?:que )?(?:[eé]|tem|t[aá] com|est[aá] com)\s+(?:uma? )?(?:h[eé]rnia|ci[aá]tic|bico de papagaio|artrose|lombalgia|protus|abaulamento|estenose|escoliose|discopatia)|diagnostiqu|diagnosticar|d[eê] (?:o |um )?diagn[oó]stico|receit[ae]|receitar|(?:indique|indicar|recomende|recomendar|sugira|sugerir|tome|tomar|use|usar|aplique|passe|passar) (?:um |uma |o |a |algum |alguma )?(?:rem[eé]dio|medicamento|pomada|comprimido|inje[cç]|gel|anti|analg)|anti-?inflamat|analg[eé]sic|dipirona|novalgina|dorflex|ibuprofen|nimesulid|diclofenac|paracetamol|tylenol|torsilax|cetoprofen|naproxen|tramadol|cicloben|miosan|buscopan|neosaldina|predniso|dexametason|meloxicam|celecoxib|code[ií]na|morfina|pregabalin|gabapentin|amitriptilin|cataflam|voltaren|advil|alivium|dorilen|toragesic|tandrilax|arcoxia|nisulid|profenid|corticoide|cortisona|ciclobenzaprina|relaxante muscular/i,
    motivo: 'A Sofia não diagnostica nem indica remédio. Escreva a regra sem isso.',
  },
];

/** Uma frase por vez: "Ofereça horário logo. Não prometa cura." tem duas, e a negação de uma não salva a outra. */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.!?;\n])\s+|\n+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

/** `null` = pode gravar. Senão, o motivo em português simples, para a página mostrar. */
export function recusaDaRegra(textoBruto: string): string | null {
  // NFKC: letra e sinal de largura total (Ｉgnore, ＜/x＞) viram os comuns antes de conferir
  const texto = textoBruto.normalize('NFKC').trim();
  if (texto.length < MIN_CARACTERES) return `Escreva a regra com pelo menos ${MIN_CARACTERES} letras.`;
  if (texto.length > MAX_CARACTERES) return `Regra longa demais: até ${MAX_CARACTERES} letras. Divida em duas.`;
  // qualquer < ou > (a regra entra crua no prompt, entre marcações): "</ aprendizados>" e '<x a="1">' também
  if (/[<>‹›«»〈〉]/.test(texto)) return 'Escreva só o texto da regra, sem os sinais < e >.';
  const sempre = recusaSempre(texto);
  if (sempre) return sempre;
  for (const frase of frases(texto)) {
    for (const s of RECUSA_SEM_NEGACAO) {
      if (semNegacaoColada(frase, s.re)) return s.motivo;
    }
  }
  return null;
}

/** Limpa o que a pessoa colou: espaços repetidos e linhas vazias. A palavra dela fica como está. */
export function normalizarRegra(texto: string): string {
  return texto
    .normalize('NFKC')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// ── teto de prévias por unidade por dia (memória do processo; reinício zera, o que só dá folga) ──
const previas = new Map<string, { dia: string; n: number }>();

function diaDe(agora: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

/** Conta uma prévia e diz se ainda cabe hoje. */
export function cabePrevia(slug: string, tz: string, agora: Date = new Date()): boolean {
  const dia = diaDe(agora, tz);
  const p = previas.get(slug);
  if (!p || p.dia !== dia) {
    previas.set(slug, { dia, n: 1 });
    return true;
  }
  if (p.n >= MAX_PREVIAS_POR_DIA) return false;
  p.n += 1;
  return true;
}

/** Devolve a prévia que não chegou a mostrar nada (modelo falhou ou passou do prazo): erro nosso não gasta a cota dela. */
export function devolverPrevia(slug: string, tz: string, agora: Date = new Date()): void {
  const p = previas.get(slug);
  if (p && p.dia === diaDe(agora, tz) && p.n > 0) p.n -= 1;
}

/** Prévias que restam hoje (para a página mostrar). */
export function previasRestantes(slug: string, tz: string, agora: Date = new Date()): number {
  const p = previas.get(slug);
  if (!p || p.dia !== diaDe(agora, tz)) return MAX_PREVIAS_POR_DIA;
  return Math.max(0, MAX_PREVIAS_POR_DIA - p.n);
}

/** Só para teste. */
export function zerarPrevias(): void {
  previas.clear();
}
