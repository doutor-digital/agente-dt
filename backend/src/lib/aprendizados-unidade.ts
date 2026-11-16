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
  /formig|p[eé]s? (?:\S+ )?ca[ií]d|s[uú]bit|bumbum|n[aá]dega|per[ií]neo|emagrec|perd\w* (?:de )?peso|acord\w* (?:o paciente |ele |a pessoa )?(?:à|a) noite|n[aã]o tem for[cç]a|mij\w*|(?:xixi|urina) na roupa|dorment|adormec|sensibilidade|nas cal[cç]as|n[aã]o sente (?:a |as |mais )?pernas?|pernas? (?:est[aá] |ficou |fica |anda )?(?:fraca|mole)|coc[oô]|evacua|perd\w* (?:de |a )?for[cç]a|for[cç]a (?:na|nas) pernas?|bexiga|intestino|incontin|reten[cç][aã]o|paralis|perdeu (?:o )?movimento|pernas? (?:fraca|falh|bambe|amolec|cede|n[aã]o (?:obedece|aguenta|firma))|falh(?:a|am|ou|aram|ando) (?:a |as )?pernas?|n[aã]o consegue (?:mais )?(?:andar|ficar em p[eé]|mexer|levantar)|controle (?:do|da|de) (?:xixi|urina|fezes|bexiga|intestino)|perd\w*\s+(?:o |a )?controle\s+(?:para|de ir|ao ir|d[oae]s?\s+(?:xixi|urina|fezes|bexiga|intestino|esf[ií]ncter|necessidades|pernas?))|perd\w* (?:de )?(?:sensa[cç][aã]o|sensibilidade)|regi[aã]o (?:[ií]ntima|genital)|[oó]rg[aã]os? genit\w*|sem for[cç]a|fraqueza|enfraquec\w*|pern\w*\s+(?:\S+\s+){0,2}sem for|for[cç]a\s+(?:\S+\s+){0,2}pern|p[eé]s?\s+(?:\S+\s+){0,2}(?:sem for|fraco)|perda\s+de\s+(?:for[cç]a|controle|sensa|sensibilidade)|segurar\s+(?:o\s+)?(?:xixi|coc[oô]|fezes|urina)|n[aã]o\s+(?:consegue|conseguir)\s+(?:segurar|urinar|evacuar)|controle\s+(?:para|pra)\s+ir\s+(?:ao|no)\s+banheiro/i;

/** O mesmo pronto-socorro com outro nome (PS, posto, UBS). */
const OUTRO_PRONTO_ATENDIMENTO = /atendimento (?:m[eé]dico )?(?:urgente|imediato)|em outro (?:lugar|servi[cç]o|m[eé]dico)|(?:m[eé]dico|cl[ií]nica|hospital|pronto)\s+de plant[aã]o|(?:lig\w*|chame|chamar|disque|discar?)\s+(?:para |pro |o |ao )?19[23]\b|ambul[aâ]ncia|posto de sa[uú]de|\bPS\b|\bUBS\b|\bpronto[\s-]*socorr|\bpronto[\s-]*atendimento/;

const MANDA_AO_HOSPITAL = /\b(?:ir|v[aá]|vai|v[aã]o|procur\w*|lev\w*|mand\w*|encaminh\w*|indic\w*|orient\w*|sugir\w*|sugerir)\s+(?:[^\s.,;:!?]+\s+){0,2}hospita/i;

/** Valor de graça ou "não cobra": sempre do cadastro, com ou sem negação. */
const DE_GRACA = /pela metade|metade do (?:pre[cç]o|valor)|por nossa conta|por conta da (?:casa|cl[ií]nica)|na faixa|sem custo|custo zero|custo nenhum|n[aã]o (?:precisa )?pag|gr[aá]tis|gratuit|de gra[cç]a|cortesia|isent|n[aã]o cobr|sem cobrar|brinde|cupom|sem pagar|n[aã]o tem custo|\bfree\b|nada a pagar|sem [oô]nus|zero reais|liberad[ao] sem|bonifica/i;
/** Número de preço: palavra de preço e número (dígitos ou por extenso) na mesma frase, sem ser hora/duração. */
const PALAVRA_DE_PRECO = /consulta|valor|pre[cç]o|cust|cobr|pag|sai por|fica (?:em|por)|reais|r\$/i;
const NUMERO_DE_PRECO =
  /r\$\s*\d|\b\d\s\d\s\d\b|\b\d{2,}(?:[.,]\d+)?\b(?!\s*(?:min|minutos|h\b|hs\b|horas?|dias?|semanas?|meses|anos?|km|metros|sess[oõ]es|vezes|x\b|pacientes))|\b(?:cem|cento|duzent[oa]s|trezent[oa]s|quatrocent[oa]s|quinhent[oa]s|seiscent[oa]s|setecent[oa]s|oitocent[oa]s|novecent[oa]s|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa|mil)\b/i;

/**
 * Regra que mexe nas ferramentas de segurança ou na urgência (achado do sênior no #265): querer menos LIGAR AGORA é um motivo
 * plausível para escrever "nunca pause a IA" ou "não é urgente" — e é exatamente o que tira a proteção do paciente.
 */
const MEXE_NA_SEGURANCA = /pausar_ia|resumir_lead|sinalDeAlerta|paus\w*\s+(?:a\s+)?(?:ia|sofia|intelig)|ligar agora|n[aã]o (?:d[eê]|marque|ponha) prioridade|n[aã]o (?:[eé]|e|est[aá]|parece) (?:urgente|grave|emerg)|regras? da rede|orienta[cç][aã]o da rede|n[aã]o chame (?:a |o )?(?:equipe|sdr|atendente)|n[aã]o (?:avise|passe para|transfira)|nunca (?:avise|passe|transfira)|n[aã]o (?:[eé]|e) (?:motivo de )?(?:pressa|urg[eê]ncia|emerg[eê]ncia)|pode esperar (?:at[eé] )?a consulta|n[aã]o\s+(?:precisa|precisam|h[aá] necessidade)\s+(?:de\s+)?(?:\S+\s+){0,2}(?:correr|corra)\b|n[aã]o\s+(?:tem|h[aá])\s+(?:motivo|necessidade|raz[aã]o)\s+(?:\S+\s+){0,2}(?:urg|corr)|dor\s+forte\s+(?:\S+\s+){0,4}(?:esper|aguard|normal|comum)/i;

/** Regra que tenta desligar as outras (injeção de instrução): o verbo de «ignorar» e o objeto «regras» em várias palavras, mais as frases prontas (português e inglês). */
const OBJ_REGRA = '(?:regras?|normas?|diretrizes?|orienta\\w*|instru\\w*|pol[ií]ticas?|restri\\w*|limites?|filtros?|protocolos?|determina\\w*|ordens|comandos?|prompts?|configura\\w*|treinamento|programa[cç]\\w*|seguran[cç]a|guardrails?|salvaguardas?|travas?|proibi\\w*|anterior\\w*)';
const VERBO_IGNORAR = '(?:ignor\\w*|esque[cç]\\w*|desconsider\\w*|desobede\\w*|desrespeit\\w*|descumpr\\w*|burl\\w*|contorn\\w*|quebr\\w*|romp\\w*|pul\\w*|abandon\\w*|dispens\\w*|despreze\\w*|desligu\\w*|desativ\\w*|anul\\w*|revog\\w*|substitu\\w*|sobrescrev\\w*|sobrepon\\w*|passe por cima|passar por cima|passando por cima|deix\\w+ de lado|finj\\w*|fa[cç]a de conta|faz de conta|n[aã]o (?:siga|seguir|obede[cç]a|respeite|considere|leve|cumpra|aplique)|disregard|forget|override|bypass)';
const MANDA_IGNORAR = new RegExp(
  [
    `${VERBO_IGNORAR}\\s+(?:[^\\s.,;:!?]+\\s+){0,4}${OBJ_REGRA}`,
    `${OBJ_REGRA}\\s+(?:anteriores|antigas?|de antes|acima|originais|iniciais|passadas|do sistema)`,
    'outra assistente|sem regras|sem limites|system prompt|prompt (?:do sistema|completo)|suas instru[cç]|novas? instru[cç]|novo papel|de agora em diante|voc[eê] agora (?:[eé]|ser[aá]|vai ser)',
    'a partir de agora,?\\s+(?:voc[eê]|ignor|respond|fal[ea]|atend|seja|aja)',
    '(?:ia|assistente|bot)\\s+sem\\s+(?:restri[cç]\\w*|filtros?|regras|limites|censura)|(?:sem|nenhum\\w*)\\s+(?:filtros?|censura)\\b|modo (?:livre|sem)|responda\\s+livremente|fale\\s+(?:como|o que)\\s+(?:voc[eê] )?quiser|seja\\s+livre',
    '(?:respond\\w*|fal[ea]\\w*|aja|atue|age)\\s+(?:[^\\s.,;:!?]+\\s+){0,2}sem\\s+(?:restri[cç]\\w*|limites?|filtros?|regras)',
    '(?:ignor|esque[cç])\\w*\\s+(?:tudo|todas|todos|todo|o que|o resto)|desobede\\w*|desconsider',
    'ignore\\s+(?:\\w+\\s+){0,3}(?:rules?|instructions?|guidelines?|prompts?)|forget\\s+(?:\\w+\\s+){0,3}(?:rules|instructions)|previous\\s+(?:rules|instructions)|jailbreak|developer mode|you are now|act as (?:if|an?)\\b|\\bpretend\\b|without (?:any )?(?:restrictions|limits|rules|filters)',
  ].join('|'),
  'i',
);

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
    re: /\bcura\b|\bcurar\b|\bcuramos\b|\bcurado|garant\w* (?:de |a |o )?(?:cura|resultado|melhora)|resultado (?:garantido|certo)|100\s?%|nunca mais (?:vai )?(?:sentir|doer|ter dor)|(?:vai |v[aã]o |fica |ficar[aá]? )(?:ficar )?(?:bom|boa|curad|sem dor|novo em folha)|melhora (?:garantida|certa)|(?:com certeza|garantid\w*|sempre|nunca)\s+(?:[^\s.,;:!?]+\s+){0,3}(?:precis\w*|vai|v[aã]o) (?:de )?(?:operar|cirurgia)|(?:resolve|trata|cura)\w*\s+(?:[^\s.,;:!?]+\s+){0,2}sem (?:operar|cirurgia)|n[aã]o (?:vai|v[aã]o) precisar (?:de )?(?:operar|cirurgia)|(?:[ií]ndice|taxa) de sucesso|quase todos melhoram|prometa|promet\w* (?:que|resultado)|tiro e queda|passa de vez|regrid|volta (?:a trabalhar|ao normal) em|\d+ em cada \d+|\d+\s*%\s*(?:de )?(?:sucesso|melhora|cura|acerto|resultado)|(?:com certeza|garantid\w*|sempre)\s+(?:[^\s.,;:!?]+\s+){0,3}(?:evit\w*|sem) (?:a )?cirurgia|evit\w* (?:a )?cirurgia (?:com certeza|sempre|garantid)|elimin\w* (?:a |sua |de vez a )?dor|(?:a dor|a h[eé]rnia|o problema|a doen[cç]a) (?:some|vai sumir|desaparece|acaba|vai acabar)|(?:resolve|trata|elimina|acaba com)\w*\s+(?:[^\s.,;:!?]+\s+){0,3}(?:definitiv|para sempre|de vez)|\d+\s*%\s*(?:dos|das|de)\s+(?:nossos |nossas |meus |minhas )?(?:pacientes|casos|clientes)|(?:saem|sai|ficam|fica|voltam|volta)\s+(?:[^\s.,;:!?]+\s+){0,2}sem dor|n[aã]o\s+volta\w*\s+a\s+(?:sentir|ter)\s+dor|livres?\s+d[ae]\s+(?:dor|h[eé]rnia|sofrimento)|al[ií]vio\s+(?:garantid|certo|imediato|total|definitiv)|(?:al[ií]vio|melhora|resultado|sucesso|efic[aá]cia|redu[cç][aã]o)s?\s+(?:\S+\s+){0,2}garant\w*|garant\w*\s+(?:\S+\s+){0,3}(?:al[ií]vio|melhora|resultado|sucesso|efic[aá]cia|sem dor|fim da dor)|acab\w+\s+com\s+(?:a\s+|sua\s+|essa\s+)?(?:dor|h[eé]rnia)|adeus\s+(?:[aà]\s+)?dor|fim\s+da\s+dor|dor\s+(?:nunca mais|n[aã]o volta)|efic[aá]cia\s+(?:comprovada|garantida|total)|100\s*por\s*cento/i,
    motivo: 'A Sofia não promete cura nem resultado. Escreva a regra sem prometer resultado.',
  },
  {
    re: /descont|promo[cç]|parcel|pre[cç]o (?:novo|diferente|menor|especial)|baixar o (?:pre[cç]o|valor)|abat/i,
    motivo: 'Valor, desconto e parcelamento não mudam por aqui: a equipe muda no cadastro da unidade.',
  },
  {
    re: /provavelmente (?:[eé]|seja|tem)|(?:o caso|o problema) (?:dele|dela|do paciente) [eé]|relaxante|(?:diga|fale|afirme|confirme|responda|sugira|informe|avise|explique|esclare[cç]a|conte|mencione|comente|adiante|antecipe|conclua|presuma|assuma)\s+(?:[^\s.,;:!?]+\s+){0,5}(?:que )?(?:[eé]|tem|t[aá] com|est[aá] com|parece|deve ser|pode ser|aparenta|sugere|indica|seria)\s+(?:uma? )?(?:h[eé]rnia|ci[aá]tic\w*|ciatalgia|lombociatalgia|bico de papagaio|artrose|artrite|lombalgia|cervicalgia|protus\w*|abaulamento|estenose|escoliose|discopatia|radiculopatia|espondil\w*|osteoporose|fibromialgia|tendinite|bursite)|(?:pelo|pela|conforme|segundo)\s+(?:que\s+)?(?:\S+\s+){0,6}(?:[eé]|seria|parece|deve ser|pode ser|trata-se de)\s+(?:uma?\s+)?(?:h[eé]rnia|ci[aá]tic\w*|ciatalgia|lombociatalgia|bico de papagaio|artrose|artrite|lombalgia|cervicalgia|protus\w*|abaulamento|estenose|escoliose|discopatia|radiculopatia|espondil\w*|osteoporose|fibromialgia|tendinite|bursite)|(?:paciente|pessoa|queixa|sintomas?|descri[cç][aã]o|relato)\s+(?:\S+\s+){0,6}(?:[eé]|seria|parece|deve ser|pode ser|trata-se de)\s+(?:uma?\s+)?(?:h[eé]rnia|ci[aá]tic\w*|ciatalgia|lombociatalgia|bico de papagaio|artrose|artrite|lombalgia|cervicalgia|protus\w*|abaulamento|estenose|escoliose|discopatia|radiculopatia|espondil\w*|osteoporose|fibromialgia|tendinite|bursite)|diagnostiqu|diagnosticar|d[eê] (?:o |um )?diagn[oó]stico|receit[ae]|receitar|(?:indique|indicar|recomende|recomendar|sugira|sugerir|tome|tomar|use|usar|aplique|passe|passar) (?:um |uma |o |a |algum |alguma )?(?:rem[eé]dio|medicamento|pomada|comprimido|inje[cç]|gel|anti|analg)|anti-?inflamat|analg[eé]sic|dipirona|novalgina|dorflex|ibuprofen|nimesulid|diclofenac|paracetamol|tylenol|torsilax|cetoprofen|naproxen|tramadol|cicloben|miosan|buscopan|neosaldina|predniso|dexametason|meloxicam|celecoxib|code[ií]na|morfina|pregabalin|gabapentin|amitriptilin|cataflam|voltaren|advil|alivium|dorilen|toragesic|tandrilax|arcoxia|nisulid|profenid|corticoide|cortisona|ciclobenzaprina|relaxante muscular|(?:compressa|gelo|bolsa t[eé]rmica|repouso|alongamento|massagem)\s+(?:[^\s.,;:!?]+\s+){0,5}(?:alivi|ajud|melhor|trat)|(?:alivi|ajud)\w*\s+(?:[^\s.,;:!?]+\s+){0,4}(?:compressa|gelo|repouso|alongamento)|(?:fa[cç]a|use|aplique|fique em)\s+(?:[^\s.,;:!?]+\s+){0,2}(?:compressa|gelo|repouso|alongamento)/i,
    motivo: 'A Sofia não diagnostica, não indica remédio nem orienta autocuidado (gelo, repouso, alongamento). Escreva a regra sem isso.',
  },
];

/** Uma frase por vez: "Ofereça horário logo. Não prometa cura." tem duas, e a negação de uma não salva a outra. */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.!?;\n])\s+|\n+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

const LETRA_DO_PORTUGUES = /[A-Za-zÀ-ÖØ-öø-ÿ]/;
/** Marcas de direção e afins que vêm ao COPIAR de outro lugar (telefone/endereço do WhatsApp, do Maps): sem efeito no texto, são tiradas em silêncio (`umaLinha` do formulário). */
export const INVISIVEIS_BENIGNOS = /[\u00ad\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const ALFABETOS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u, /\p{Script=Coptic}/u, /\p{Script=Georgian}/u];
/** O texto sem o que o emoji usa de legítimo: o ZWJ ENTRE emojis, o seletor de emoji logo depois de um emoji e o quadradinho do teclado (1️⃣). */
function semPartesDeEmoji(texto: string): string {
  return texto
    .normalize('NFKC')
    .replace(/(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0E\uFE0F])\u200d(?=\p{Extended_Pictographic})/gu, '')
    .replace(/(?<=\p{Emoji})[\uFE0E\uFE0F]/gu, '')
    .replace(/(?<=[0-9#*])\u20e3/g, '');
}
const INVISIVEL = 'O texto tem um caractere invisível (talvez copiado de outro lugar). Apague e digite de novo.';
/**
 * DISFARCE em QUALQUER campo do formulário (nome, endereço, texto): caractere invisível, marca combinante solta ou letras de alfabetos misturados na mesma palavra. Não limita o alfabeto
 * (nome de rua ou de pessoa com «Ł» ou «ő» é legítimo): quem limita o alfabeto é `textoSuspeito`, só para o texto que vira REGRA ou FATO da assistente.
 */
export function textoComDisfarce(texto: string): string | null {
  const t = semPartesDeEmoji(texto);
  if (/(?![\n\r\t])\p{Cc}|\p{Cf}/u.test(t)) return INVISIVEL;
  if (/\p{M}/u.test(t)) return 'O texto tem uma letra com marca estranha em cima (por exemplo um traço sobre o «i»). Apague e digite de novo.';
  for (const palavra of t.split(/[^\p{L}\p{M}]+/u)) {
    if (palavra.length >= 2 && ALFABETOS.filter((re) => re.test(palavra)).length > 1) return 'Tem uma palavra com letras de alfabetos misturados (por exemplo um «о» cirílico no lugar do «o»). Apague e digite de novo.';
  }
  return null;
}
/**
 * Para o texto que vira REGRA ou FATO da assistente vale a LISTA DO QUE PODE: um texto em português só precisa de letras latinas (A–Z e as acentuadas do latim-1), números, pontuação, símbolos e emojis.
 * Qualquer outra LETRA (cirílico, grego, letras de IPA como «ɪ» e «ɡ», armênio…) é recusada — em palavra inteira também («игнорируй» e «ɪgnore» não passam) —, além do disfarce de `textoComDisfarce`.
 */
export function textoSuspeito(texto: string): string | null {
  const disfarce = textoComDisfarce(texto);
  if (disfarce) return disfarce;
  for (const c of semPartesDeEmoji(texto)) {
    if (/\p{L}/u.test(c) && !LETRA_DO_PORTUGUES.test(c)) return 'Tem uma letra que não é do nosso alfabeto (por exemplo um «о» cirílico no lugar do «o», ou um «ɪ» no lugar do «i»). Apague e digite de novo com o teclado em português.';
  }
  return null;
}

/** Sem acento e com as letras parecidas dobradas (ø→o, ß→ss…): as travas rodam TAMBÉM neste texto, então «ígnore» e «ignør e» valem como «ignore». */
const PARECIDAS: Record<string, string> = { 'ø': 'o', 'Ø': 'O', 'ð': 'd', 'Ð': 'D', 'þ': 'p', 'Þ': 'P', 'æ': 'ae', 'Æ': 'AE', 'ß': 'ss' };
export function dobrarParecidas(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').replace(/[øØðÐþÞæÆß]/g, (c) => PARECIDAS[c] ?? c);
}

/** «1gn0re», «descont0», «r3gras»: palavra que mistura letras com 0 1 3 4 5 7 @ volta a ser a palavra (número puro, «150» ou «1.200», não muda). */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a' };
function desfazerLeet(t: string): string {
  return t.replace(/[\p{L}\d@]+/gu, (tok) => (/\p{L}/u.test(tok) && /[0-9@]/.test(tok) && tok.replace(/[^\p{L}]/gu, '').length >= 2 ? tok.replace(/[0-9@]/g, (c) => LEET[c] ?? c) : tok));
}
/** «i.g.n.o.r.e», «ig-nore», «i g n o r e», «ig_nore»: tira a pontuação no meio da palavra e junta letras soltas. */
function juntarPicado(t: string): string {
  return t.replace(/(?<=\p{L})[^\p{L}\p{N}\s]+(?=\p{L})/gu, '').replace(/(?<![\p{L}\p{N}])(?:\p{L} ){3,}\p{L}(?![\p{L}\p{N}])/gu, (m) => m.replace(/ /g, ''));
}
/** «3 5 0» e «3.5.0» viram «350». */
function juntarDigitos(t: string): string {
  return t.replace(/(?<![\p{L}\p{N}])\d(?:[ .]\d){2,}(?![\p{L}\p{N}])/gu, (m) => m.replace(/[ .]/g, ''));
}

/**
 * O texto e os disfarces dele (acento/letra parecida, letras picadas, 1gn0re, dígitos soltos). As travas rodam em TODOS: o que um passa, outro pega. Heurística, não prova:
 * a regra da rede continua valendo acima de tudo, e o João recebe no Telegram cada regra salva.
 */
export function variantes(texto: string): string[] {
  const dobrada = dobrarParecidas(texto);
  const leet = desfazerLeet(dobrada);
  return [...new Set([texto, dobrada, juntarPicado(dobrada), leet, juntarPicado(leet), juntarDigitos(dobrada)])];
}

/** `null` = pode gravar. Senão, o motivo em português simples, para a página mostrar. As travas rodam no texto E nos disfarces dele. */
export function recusaDaRegra(textoBruto: string): string | null {
  // NFKC: letra e sinal de largura total (Ｉgnore, ＜/x＞) viram os comuns antes de conferir
  const texto = textoBruto.normalize('NFKC').trim();
  const suspeito = textoSuspeito(texto);
  if (suspeito) return suspeito;
  if (texto.length < MIN_CARACTERES) return `Escreva a regra com pelo menos ${MIN_CARACTERES} letras.`;
  if (texto.length > MAX_CARACTERES) return `Regra longa demais: até ${MAX_CARACTERES} letras. Divida em duas.`;
  // qualquer < ou > (a regra entra crua no prompt, entre marcações): "</ aprendizados>" e '<x a="1">' também
  if (/[<>‹›«»〈〉]/.test(texto)) return 'Escreva só o texto da regra, sem os sinais < e >.';
  for (const variante of variantes(texto)) {
    const sempre = recusaSempre(variante);
    if (sempre) return sempre;
    for (const frase of frases(variante)) {
      for (const s of RECUSA_SEM_NEGACAO) {
        if (semNegacaoColada(frase, s.re)) return s.motivo;
      }
    }
  }
  return null;
}

/**
 * Texto de FATO que o dono escreve (primeira consulta, formas de pagamento, perguntas frequentes…) e que entra nas FONTES da Sofia, não como regra. Mesmo assim é só DADO e passa pelas MESMAS
 * travas da página /aprendizados: sem marcação (`<`/`>`), sem mandar ignorar regra, sem pronto-socorro, sem valor em reais NEM número de preço (inclusive por extenso e sem a palavra «preço»),
 * sem consulta de graça (em qualquer jeito de dizer, na pergunta ou na resposta), sem promessa de cura, sem diagnóstico ou autocuidado, sem sinal de alerta nem mexer na urgência. `null` = pode.
 */
const PALAVRA_DE_CONSULTA = /consulta|avalia[cç][aã]o|atendimento|sess[aã]o|sess[oõ]es|exame|retorno|tratamento|primeira vez|1[aª] vez|diagn[oó]stico/i;
const DE_GRACA_NA_FRASE =
  /gr[aá]tis|gratuit\w*|gratuidade|\bfree\b|de gra[cç]a|sem custo|custo (?:zero|nenhum)|(?:sem|nenhum|zero)\s+(?:nenhum\s+)?(?:custo|cobran[cç]a|[oô]nus|valor|taxa)|n[aã]o\s+(?:tem|h[aá]|existe|ter[aá]|vai ter)\s+(?:nenhum[ao]?\s+)?(?:custo|cobran[cç]a|[oô]nus|valor|taxa)|sem\s+(?:pagar|ter que pagar)|nada\s+(?:a|para|pra)\s+pagar|n[aã]o\s+(?:\w+\s+)?(?:paga|pagam|pague|pagar[aá]?|precisa\s+pagar)\b|cortesia|isent\w*|brinde|cupom|bonifica\w*|(?:sai|fica) na faixa|n[aã]o cobr\w*|por nossa conta|por conta d[aeo]s?\s+(?:casa|cl[ií]nica|gente|nossa)|metade do (?:pre[cç]o|valor)|pela metade|liberad[oa]\s+sem/gi;
/** Gratuidade que o dono diz de algo que NÃO é a consulta («estacionamento gratuito», «não cobramos taxa para remarcar»): adjetivo olha as 3 palavras de ANTES; «não cobramos…» olha a PRIMEIRA palavra depois dos artigos. */
const GRATUIDADE_ADJETIVO = /^(?:gr[aá]tis|gratuit\w*|free|de gra[cç]a|cortesia|brinde|cupom)/i;
const COISA_NAO_CONSULTA = /^(?:estacion\w*|wi-?fi|caf[eé]\w*|[aá]gua|revistas?|taxas?|multas?|remarca\w*|reagenda\w*|cancel\w*|segunda|vias?|valet|ar-?condicionado|brinquedos?|pipoca|doce\w*)$/i;
const ARTIGOS = new Set(['a', 'o', 'as', 'os', 'uma', 'um', 'de', 'da', 'do', 'das', 'dos', 'nenhuma', 'nenhum', 'qualquer', 'pela', 'pelo', 'por', 'para', 'pra', 'com', 'na', 'no']);
const palavrasDe = (t: string) => t.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);

/** A frase promete a consulta/avaliação/atendimento de graça? (`anterior` = a frase de antes, para «A avaliação tem custo? Não, é gratuita.») */
function prometeGratuidade(frase: string, anterior: string): boolean {
  // a frase de antes só entra se era uma PERGUNTA («A avaliação tem custo? Não, é gratuita.») ou se esta é curta e não tem sujeito próprio («A primeira consulta. É grátis.»)
  const contexto = anterior.endsWith('?') || palavrasDe(frase).length <= 4 ? anterior : '';
  if (!(PALAVRA_DE_CONSULTA.test(frase) || PALAVRA_DE_CONSULTA.test(contexto))) return false;
  for (const m of frase.matchAll(DE_GRACA_NA_FRASE)) {
    const idx = m.index ?? 0;
    const adjetivo = GRATUIDADE_ADJETIVO.test(m[0]);
    const antes = palavrasDe(frase.slice(0, idx)).slice(-3);
    // a primeira palavra depois dos artigos («não cobramos A TAXA…» → taxa)
    const depois = palavrasDe(frase.slice(idx + m[0].length)).find((w) => !ARTIGOS.has(w.toLowerCase()));
    const benigno = adjetivo ? antes.some((w) => COISA_NAO_CONSULTA.test(w)) : !!depois && COISA_NAO_CONSULTA.test(depois);
    if (!benigno) return true;
  }
  return false;
}

const PRECO_PALAVRA = /^(?:valor(?:es)?|pre[cç]os?|custa\w*|custos?|cobr\w*|cobran[cç]a|reais|mensalidade|taxas?|parcel\w*|entrada|investimento|sinal|pix|cart[aã]o|cart[oõ]es|dinheiro|d[eé]bito|cr[eé]dito|boleto|vista|cheque|pag\w*|r\$|total|desconto|tabela|pacote|mensal|semanal)$/i;
/** Palavra que, logo antes do número, o transforma em preço: «por 200», «só 150», «consulta: 150». */
const ANTES_DO_NUMERO = /^(?:por|apenas|somente|so|s[oó]|consulta|avalia[cç][aã]o|atendimento|sess[aã]o|tratamento|pacote|plano|exame|retorno|ficam?|sai|saem|custa\w*)$/i;
const NUMERO_POR_EXTENSO = /^(?:cem|cento|duzent[oa]s|trezent[oa]s|quatrocent[oa]s|quinhent[oa]s|seiscent[oa]s|setecent[oa]s|oitocent[oa]s|novecent[oa]s|mil|vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa)$/i;
const NUMERO_PEQUENO_EXTENSO = /^(?:um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove)$/i;
const UNIDADE_NAO_PRECO = /^(?:min|minutos?|h|hs|horas?|dias?|semanas?|meses|m[eê]s|anos?|km|metros?|m|cm|sess[aã]o|sess[oõ]es|vezes|x|pacientes?|andar|pessoas?|%)$/i;
const NAO_E_PRECO_ANTES = /^(?:[aà]s|at[eé]|das|dos|entre|dia|dias|andar|sala|salas|n|n[ºo°]|n[uú]mero|cep|ramal|bloco|km|lote|quadra|apto|apartamento|conjunto|loja|ed|edif[ií]cio|galeria|br|crm|crefito|crf|cnpj|cpf|rg|tel|telefone|whatsapp|zap|celular|fone|ligue|ligar|contato|protocolo|c[oó]digo|matr[ií]cula)$/i;
const grupoDeNumero = (t?: string) => !!t && /^\d[\d.,]*$/.test(t) && t.replace(/\D/g, '').length >= 3;
const RUA = /^(?:rua|av|avenida|alameda|travessa|pra[cç]a|rodovia|estrada|largo|beco)$/i;

/** Preço NA FRASE: número de verdade (dígitos de 2 ou mais, ou por extenso) perto de uma palavra de preço ou de forma de pagamento (valor, custa, sai por, Pix, cartão, «por 200», «consulta: 150»); hora, telefone, CEP, data, ano, endereço e duração não contam. */
export function temNumeroDePreco(frase: string): boolean {
  const cruas = frase.split(/\s+/).filter(Boolean);
  const palavras = cruas.map((p) => p.replace(/^[("'“]+|[)"'”,;:!?]+$/g, '').replace(/\.$/, ''));
  const minusc = palavras.map((p) => p.toLowerCase());
  const precos = new Set<number>();
  minusc.forEach((p, i) => {
    if (PRECO_PALAVRA.test(p)) precos.add(i);
    else if ((p === 'sai' || p === 'fica') && /^(?:por|em|a|r\$)$/i.test(minusc[i + 1] ?? '')) precos.add(i);
    else if (p === 'partir' && minusc[i + 1] === 'de' && minusc[i - 1] === 'a') precos.add(i);
  });
  // «dez reais», «duzentos reais»: a palavra «reais» com um número por extenso perto (a palavra «real» sozinha é adjetivo: «horário real»)
  if (minusc.some((w, i) => w === 'reais' && minusc.slice(Math.max(0, i - 4), i).some((x) => NUMERO_PEQUENO_EXTENSO.test(x) || NUMERO_POR_EXTENSO.test(x)))) return true;
  for (let i = 0; i < palavras.length; i++) {
    const p = palavras[i]!;
    const extenso = NUMERO_POR_EXTENSO.test(p);
    const digitos = /^\d[\d.,]*$/.test(p) && !/^\(/.test(cruas[i]!) ? p.replace(/\D/g, '').length : 0;
    if (!extenso && (digitos < 2 || digitos > 7)) continue;
    // unidade que não é dinheiro: «40 minutos», «de 40 a 50 minutos», «3 vezes»
    if (UNIDADE_NAO_PRECO.test(minusc[i + 1] ?? '')) continue;
    if (/^(?:a|[aà]|at[eé]|e|ou)$/i.test(minusc[i + 1] ?? '') && UNIDADE_NAO_PRECO.test(minusc[i + 3] ?? '')) continue;
    if (NAO_E_PRECO_ANTES.test(minusc[i - 1] ?? '')) continue;
    // 0800 123 4567: zero na frente, ou vários grupos de número em fila, é telefone/registro, não preço
    if (/^0\d/.test(p) || grupoDeNumero(palavras[i - 1]) || grupoDeNumero(palavras[i + 1])) continue;
    const valor = Number(p.replace(/\D/g, ''));
    if (!extenso && valor >= 1950 && valor <= 2100 && /^(?:desde|em|ano|de|do)$/i.test(minusc[i - 1] ?? '')) continue;
    // telefone com DDD solto: «94 99999-0000»
    if (/^\d{4,5}-?\d{4}$/.test(palavras[i + 1] ?? '')) continue;
    // número de endereço: depois de «Rua…» e sem palavra de preço no meio nem logo depois
    const ruaAntes = minusc.slice(Math.max(0, i - 7), i).findLastIndex((w) => RUA.test(w));
    if (ruaAntes >= 0) {
      const desdeRua = Math.max(0, i - 7) + ruaAntes;
      if (![...precos].some((j) => (j > desdeRua && j < i) || (j > i && j <= i + 2))) continue;
    }
    if ([...precos].some((j) => Math.abs(j - i) <= 6)) return true;
    if (ANTES_DO_NUMERO.test(minusc[i - 1] ?? '') || ANTES_DO_NUMERO.test(minusc[i - 2] ?? '')) return true;
  }
  return false;
}

export function recusaDeFato(textoBruto: string, opcoes: { permiteParcelamento?: boolean } = {}): string | null {
  const texto = textoBruto.normalize('NFKC').trim();
  const suspeito = textoSuspeito(texto);
  if (suspeito) return suspeito;
  if (/[<>‹›«»〈〉]/.test(texto)) return 'Escreva só o texto, sem os sinais < e >.';
  const parcela = opcoes.permiteParcelamento ? new RegExp(RECUSA_SEM_NEGACAO[1]!.re.source.replace('|parcel', ''), 'i') : RECUSA_SEM_NEGACAO[1]!.re;
  for (const variante of variantes(texto)) {
    if (MANDA_IGNORAR.test(variante)) return 'O texto não pode mandar a assistente ignorar ou esquecer as regras. Escreva só a informação.';
    if (citaProntoSocorro(variante) || MANDA_AO_HOSPITAL.test(variante) || OUTRO_PRONTO_ATENDIMENTO.test(variante)) return 'Pronto-socorro e hospital são regra da rede: a assistente nunca orienta isso, e a rede já trata a urgência. Tire essa parte.';
    if (/r\$\s*\d|\b\d[\d.,]*\s*(?:reais|real)\b/i.test(variante)) return 'Não escreva valores em reais aqui: o preço da consulta fica no cadastro (seção «Valores da consulta»), e a assistente só fala o que está lá.';
    if (CONDICAO_SINAL_DE_ALERTA.test(variante) || ALERTA_DITO_DE_OUTRO_JEITO.test(variante)) return 'Sinal de alerta (força, sensação ou formigamento nas pernas, controle do xixi ou das fezes, região íntima, febre) é regra da rede e protege o paciente: não escreva sobre isso aqui.';
    if (MEXE_NA_SEGURANCA.test(variante)) return 'O texto não pode mexer em urgência, em pausar a assistente nem em passar o paciente para a equipe: isso é regra da rede.';
    const fs = frases(variante);
    for (const [i, frase] of fs.entries()) {
      const anterior = fs[i - 1] ?? '';
      // pergunta + resposta valem juntas: «Quanto custa a consulta? A partir de 150.» / «A avaliação tem custo? Não, é gratuita.»
      const comPergunta = anterior.endsWith('?') ? `${anterior} ${frase}` : frase;
      if (temNumeroDePreco(comPergunta)) return 'Valor da consulta não muda por aqui: o preço fica no cadastro da clínica (seção «Valores da consulta»). Escreva sem número de preço.';
      // de graça: só quando se fala da consulta/atendimento («estacionamento gratuito» e «não cobramos taxa para remarcar» passam)
      if (prometeGratuidade(frase, anterior)) return 'Consulta, avaliação ou atendimento de graça, brinde ou cortesia não pode ser prometido por aqui: valor e gratuidade são do cadastro da clínica.';
      if (semNegacaoColada(frase, RECUSA_SEM_NEGACAO[0]!.re)) return RECUSA_SEM_NEGACAO[0]!.motivo;
      if (semNegacaoColada(frase, parcela)) return RECUSA_SEM_NEGACAO[1]!.motivo;
      if (semNegacaoColada(frase, RECUSA_SEM_NEGACAO[2]!.re)) return RECUSA_SEM_NEGACAO[2]!.motivo;
    }
  }
  return null;
}

/** Pergunta frequente: pergunta e resposta são lidas JUNTAS (a resposta «Não, é gratuita.» só diz de graça por causa da pergunta). */
export function recusaDePergunta(pergunta: string, resposta: string): string | null {
  return recusaDeFato(`${pergunta.trim().replace(/\s+/g, ' ')} ${resposta.trim().replace(/\s+/g, ' ')}`);
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

export function diaDe(agora: Date, tz: string): string {
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
