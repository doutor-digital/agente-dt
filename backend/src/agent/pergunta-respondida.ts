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
import { cidadeConhecida, pareceCidade, type Fatos } from './falta-para-agendar.js';
import { canonizarFatos } from '../services/fatos-canonicos.js';
import { horariosOferecidos, horariosQueJaPassaram } from './horario-oferecido.js';
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

/** Chave `pergunta-ja-respondida` (automacoes.ts): nasce DESLIGADA; liga-se por unidade (piloto) pela tela ou pelo `.env`. */
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
// "a dor é a 2 anos" (escrito sem o h): só com palavra de dor por perto e nunca "daqui a 2 semanas", "dentro de", "até"
const TEMPO_A_SEM_H = new RegExp(String.raw`(?<!daqui\s|dentro\s|ate\s|depois\s|antes\s|em\s)\ba\s+${APROX}${NUM}\s+(?:meses|mes|anos?)\b`);
const TEMPO_SEM_VERBO = new RegExp(String.raw`\b${APROX}${NUM}\s+${UNID}\b`, 'g');
/** "em 2 semanas", "daqui 15 dias", "por 3 meses": prazo que vem, não há quanto tempo dói. */
const ANTES_DE_PRAZO = /(?:^|\s)(?:em|daqui|dentro|cada|por|pra|para|ate|depois|durante|nos|nas|ultimos|ultimas|proximos|proximas|antes|a)\s*$/;
/** A idade ("tenho 40 anos", "aos 52", "40 anos de idade") não é o tempo da dor. */
const IDADE = new RegExp(
  String.raw`\b(?:tenho|tem|tinha|completei|completou)\s+(?:\d+|${NUM})\s*anos|\d+\s*anos\s+de\s+idade|\baos\s+\d+|\bcom\s+\d+\s*anos` +
    String.raw`|\b(?:vinte|trinta|quarenta|cinquenta|sessenta|setenta|oitenta|noventa)(?:\s+e\s+\w+)?\s+anos\b`,
);
/** "preciso de 2 dias": prazo. (Para meses e anos, "dor de 3 anos" é resposta.) */
const DE_DE_PRAZO = /(?:^|\s)de\s*$/;
/** "depois de 3 meses", "antes de 2 semanas", "dentro de 1 mês": prazo, com qualquer unidade. */
const PRAZO_COM_DE = /(?:antes|depois|dentro|ate)\s+de\s*$/;
const TEMPO_VAGO = /\b(?:ha|faz)\s+(?:muito\s+|bastante\s+)?(?:tempo|tempao|anos|meses)\b|\bha\s+um\s+tempao\b/;
const TEMPO_DESDE =
  /\bdesde\s+(?:o\s+|a\s+|de\s+)?(?:\d{4}|\d{1,2}\/\d{2,4}|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|ano\s+passado|mes\s+passado|semana\s+passada|ontem|anteontem|hoje|domingo|segunda|terca|quarta|quinta|sexta|sabado|crianca|adolescencia|natal|carnaval)/;

/** O tempo tem de ser DA DOR: palavra de dor/sintoma por perto, e nada que o ligue a outra coisa ("operei há 2 anos", "minha filha de 5 anos"). */
const PALAVRA_DE_DOR =
  /\b(?:dor|dores|doi|doendo|doeu|sinto|sentindo|sente|senti|formig\w*|dorm[eê]ncia|hernia|disco|protrusao|abaulamento|coluna|lombar|cervical|ciatic\w*|costas|pescoco|nuca|perna|braco|joelho|ombro|quadril|crise|crises|travad\w*|latej\w*|incomod\w*|problema|sintoma\w*|sofro|sofrendo|piora\w*|machuc\w*|lesao|inflam\w*|tratamento)\b/;
/** O que vem antes e prende o tempo a OUTRA coisa: cirurgia, trabalho, idade de familiar, remédio, estado civil. */
const OUTRA_COISA_ANTES =
  /(?:oper\w+|cirurgi\w*|fiz|fez|filh\w*|neto|neta|bebe|crianca|idade|casad\w*|trabalh\w*|empresa|formad\w*|aposentad\w*|divorc\w*|separ\w*|nasc\w*|remedio|uso|usando|tomando|sobrinh\w*|mae|pai|marido|esposa|namor\w*|moro|moramos|mora|carteira|carro|casa)\s+(?:\w+\s+){0,3}(?:de\s+|ha\s+|faz\s+|ja\s+faz\s+)?$/;
const JANELA_DE_DOR = 45;

function ligadoADor(t: string, ini: number, fim: number): boolean {
  if (!PALAVRA_DE_DOR.test(t.slice(Math.max(0, ini - JANELA_DE_DOR), Math.min(t.length, fim + JANELA_DE_DOR)))) return false;
  return !OUTRA_COISA_ANTES.test(t.slice(Math.max(0, ini - 40), ini));
}

/**
 * `comContexto`: o tempo precisa estar ligado à dor (conversa solta). Sem ele é a fala que responde DIRETO a "há quanto tempo?",
 * onde "2 anos" basta; idade e prazo continuam recusados.
 */
function respostaDeTempo(texto: string, comContexto = true): string | null {
  const t = semAcento(falaLimpa(texto));
  const ok = (m: RegExpExecArray | RegExpMatchArray): boolean => {
    const ini = m.index ?? 0;
    return !comContexto || ligadoADor(t, ini, ini + m[0].length);
  };
  for (const re of [TEMPO_COM_VERBO, TEMPO_VAGO, TEMPO_DESDE, ...(comContexto ? [TEMPO_A_SEM_H] : [])]) {
    const m = new RegExp(re.source, 'g');
    for (const c of t.matchAll(m)) if (ok(c)) return c[0].trim();
  }
  for (const m of t.matchAll(TEMPO_SEM_VERBO)) {
    if (/^um\s+dia$/.test(m[0].trim())) continue; // "um dia eu levantei peso": não é quanto tempo
    if (/anos?$/.test(m[0]) && (IDADE.test(t) || Number(/\d+/.exec(m[0])?.[0] ?? 0) > 15)) continue;
    const antes = t.slice(Math.max(0, m.index - 20), m.index);
    if (/(?:dias?|semanas?|quinzenas?)$/.test(m[0]) && DE_DE_PRAZO.test(antes)) continue;
    if (PRAZO_COM_DE.test(antes)) continue;
    if (!ANTES_DE_PRAZO.test(antes) && ok(m)) return m[0].trim();
  }
  return null;
}

/** Resposta DIRETA a "há quanto tempo?": além das contas acima, "ontem", "semana passada", "faz tempo". */
const TEMPO_CURTO = /\b(?:ontem|anteontem|hoje|semana\s+passada|mes\s+passado|ano\s+passado|faz\s+tempo|muito\s+tempo|bastante\s+tempo|recentemente)\b/;
function respostaDiretaDeTempo(texto: string): string | null {
  const t = semAcento(falaLimpa(texto));
  return respostaDeTempo(texto, false) ?? TEMPO_CURTO.exec(t)?.[0] ?? null;
}

// "moro em Marabá", "moramos no Pará" (estado: não vale), "moro aqui", "sou de Parauapebas" (com maiúscula: "sou de confiança" não
// é cidade), "venho de Eldorado", "aqui de Canaã". Fica de fora: "moro perto do hospital", "moro na mesma rua", "moro em local
// afastado", "moro no Maranhão" — nada disso diz a cidade.
const CIDADE_MORO =
  /(?<![\p{L}])(?:[Mm]oro|[Mm]oramos|[Rr]esido|(?:[Ee]stou|[Tt]ô|[Tt]o|[Ee]stamos)\s+[Mm]orando)\s+(?:aqui\s+|ali\s+|l[aá]\s+)?(?:(?:em|no|na)\s+([\p{L}][\p{L}'.\-]*(?:\s+[\p{L}][\p{L}'.\-]*){0,4})|aqui(?:\s+mesmo)?(?![\p{L}]))/u;
/** "moro em casa", "no sítio", "no centro", "na mesma rua", "em local afastado", "em outra cidade": onde ele mora, não a cidade. */
const NAO_E_CIDADE = /^(?:casa|apartamento|apto|ap|sitio|fazenda|roca|chacara|zona|bairro|centro|condominio|loteamento|residencial|setor|jardim|parque|conjunto|nucleo|vila|rua|avenida|av|interior|beira|predio|quarto|frente|fundos|cima|baixo|um|uma|outro|outra|onde|ca|la|ali|mesma|mesmo|local|lugar|area|regiao|capital|cidade|litoral|campo|mata|sul|norte|leste|oeste|perto|longe|proximo|afastado|distrito|povoado)$/;
/** Estado sozinho não é cidade (São Paulo e Rio de Janeiro ficam de fora da lista: são as duas coisas). */
const ESTADOS = new Set([
  'acre', 'alagoas', 'amapa', 'amazonas', 'bahia', 'ceara', 'espirito santo', 'goias', 'maranhao', 'mato grosso', 'mato grosso do sul',
  'minas gerais', 'para', 'paraiba', 'parana', 'pernambuco', 'piaui', 'rio grande do norte', 'rio grande do sul', 'rondonia',
  'roraima', 'santa catarina', 'sergipe', 'tocantins', 'distrito federal', 'brasil',
]);
/** Onde o nome do lugar termina: "moro em Marabá e trabalho em…", "moro em Marabá mesmo", "moro em Marabá desde 2010". */
const FIM_DO_LUGAR = /(?:^|\s)(?:e|mas|que|pois|porque|desde|ha|há|faz|com|onde|hoje|mesmo|tambem|também|agora|ja|já|mais|bem|perto|longe|ai|aí|la|lá|sim|ne|né|so|só|a|ha)(?:\s|$)|[,.;!?]/i;

/** O trecho que sobrou depois de "moro em" é uma cidade? Só o nome do lugar (corta no "e", no "mesmo", na vírgula), nunca estado. */
function lugarEhCidade(bruto: string): string | null {
  // "moro na cidade de Canaã dos Carajás"
  const cortado = bruto.replace(/^cidade\s+d[aeo]s?\s+/i, '').split(FIM_DO_LUGAR)[0].trim();
  if (!cortado) return null;
  const n = semAcento(cortado);
  const primeira = /^vila\s+(?:velha|rica)\b/.test(n) ? 'vilacidade' : n.split(/\s+/)[0];
  if (NAO_E_CIDADE.test(primeira) || ESTADOS.has(n) || /^[a-z]{2}$/.test(n)) return null;
  return pareceCidade(cortado) ? cortado : null;
}

// "vim do Instagram", "sou de Deus", "venho de Uber" não são cidade; "aqui da Igreja" e "vim de…" (trajeto) nem entram
const CIDADE_SOU_DE =
  /(?<![\p{L}])(?:[Ss]ou|[Ss]omos|[Vv]enho)\s+(?:d[aeo]s?|em)\s+(?!(?:Assembleia|Congrega[çc][ãa]o|Par[óo]quia|Cat[óo]lica|Batista|Ordem|Associa[çc][ãa]o|Sindicato|Comunidade|Capela|Templo|Minist[ée]rio|Deus|Jesus|Cristo|Nossa|Senhor|Maria|Uber|Fam[ií]lia|Igreja|F[eé]|Paz|Ambul[âa]ncia|Carro|Moto|[ÔO]nibus|T[aá]xi|Empresa|Escola|Faculdade|Prefeitura|Aplicativo|App|Peixes|Aqu[aá]rio|[ÁA]ries|Touro|G[eê]meos|C[aâ]ncer|Le[aã]o|Virgem|Libra|Escorpi[aã]o|Sagit[aá]rio|Capric[oó]rnio|Instagram|Facebook|Google|WhatsApp|Whats|Insta|Face|TikTok|YouTube|An[uú]ncio|Site|Hospital|Cl[ií]nica|Posto|Unimed|M[eé]dico|Doutor|Dr|Dra|Fisio\w*|Ortoped\w*|Plano|Amil|Bradesco|SUS|Ambulat[óo]rio|Pronto|Santa\s+Casa|UPA|UBS)\b)(\p{Lu}[\p{L}'\-]+(?:\s+(?:d[aeo]s?\s+)?\p{Lu}[\p{L}'\-]+){0,3})/u;
const CIDADE_SOU_DAQUI = /(?<![\p{L}])[Ss]ou\s+daqui\b|(?<![\p{L}])[Ss]omos\s+daqui\b/u;

/** "Não moro aqui", "nunca morei em Marabá", "já não sou daqui": o contrário de responder. */
function negado(t: string, indice: number): boolean {
  return /(?:\bn[ãa]o|\bnunca|\bj[aá]\s+n[ãa]o|\bdeixei\s+de)\s*$/i.test(t.slice(Math.max(0, indice - 14), indice));
}

function respostaDeCidade(texto: string): string | null {
  const t = falaLimpa(texto);
  const moro = CIDADE_MORO.exec(t);
  if (moro && !negado(t, moro.index)) {
    if (!moro[1]) return moro[0].trim(); // "moro aqui"
    const lugar = lugarEhCidade(moro[1]);
    if (lugar) return `${moro[0].slice(0, moro[0].indexOf(moro[1]))}${lugar}`.trim();
  }
  const sou = CIDADE_SOU_DE.exec(t);
  if (sou && !negado(t, sou.index)) {
    const lugar = lugarEhCidade(sou[1]);
    if (lugar) return `${sou[0].slice(0, sou[0].indexOf(sou[1]))}${lugar}`.trim();
  }
  const daqui = CIDADE_SOU_DAQUI.exec(t);
  if (daqui && !negado(t, daqui.index)) return daqui[0].trim();
  return null;
}

const IMPACTO_RESPOSTA = new RegExp(
  [
    // "isso me atrapalha", "a dor atrapalha muito": exige o sujeito (eu / a dor), para não pegar "desculpa incomodar" nem "não quero atrapalhar"
    String.raw`\b(?:me|nos)\s+(?:\w+\s+){0,2}(?:atrapalh|impede|impedindo|limita|limitando|prejudic)\w*`,
    String.raw`\b(?:dor|isso|ela|esta|essa)\s+(?:\w+\s+){0,2}(?:atrapalh|impede|impedindo|limita|limitando|prejudic)\w*`,
    String.raw`\batrapalh\w*\s+(?:muito|bastante|demais|tudo|minha|meu|o\s+meu|a\s+minha)`,
    String.raw`\bnao\s+(?:consigo|conseguia|consegue|aguento)\s+(?:mais\s+)?(?:trabalhar|dormir|andar|ficar|levantar|sentar|abaixar|me\s+abaixar|fazer|pegar|carregar|brincar|cuidar|correr|caminhar|treinar|dirigir)`,
    String.raw`\b(?:acordo|acordando|durmo|dormindo)\s+(?:mal|com\s+dor|de\s+madrugada|varias\s+vezes)|\bnao\s+(?:durmo|consigo\s+dormir)`,
    String.raw`\btrabalh\w+\s+(?:com\s+dor|sofrendo|mal)|\b(?:parei|deixei)\s+de\s+(?:trabalhar|treinar|fazer|caminhar|correr)|\bafastad[oa]\b|\batestado\b`,
    String.raw`\bdificuldade\s+(?:pra|para|de|em)\s+(?:trabalhar|andar|dormir|sentar|levantar|ficar)`,
  ].join('|'),
);

/** Atividade da rotina que a dor atrapalha, dita como resposta direta ("trabalho", "dormir", "pra sentar"). */
const IMPACTO_ATIVIDADE = /\b(?:trabalh\w*|dorm\w*|sono|andar|caminh\w*|sent\w+|levant\w*|abaix\w*|dirig\w*|cuidar|brincar|correr|trein\w*|academia|atividades?|rotina|dia\s+a\s+dia|servico|filhos?|carregar|pegar\s+peso|banho|vestir)\b/;

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

function doCartao(tema: Tema, fatosBrutos: Fatos | null | undefined): string | null {
  if (!fatosBrutos) return null;
  // os mesmos apelidos que a escrita junta (tempo_de_dor -> tempo_dor, localizacao -> cidade): lê pela gaveta canônica
  const fatos = canonizarFatos(fatosBrutos);
  if (tema === 'cidade') {
    // a MESMA conta da lista <falta_para_agendar>: `localizacao` (onde dói) e parte do corpo não são cidade
    if (!cidadeConhecida(fatos)) return null;
    const k = ['cidade', 'municipio', 'cidade_paciente', 'mora_em'].find((c) => pareceCidade(fatos[c]));
    return k ? String(fatos[k]).trim().slice(0, 60) : 'consegue vir à unidade';
  }
  for (const k of FATO_DO_TEMA[tema]) {
    const v = String(fatos[k] ?? '').trim();
    if (v) return v.slice(0, 80);
  }
  return null;
}

/**
 * Resposta CURTA à pergunta da cidade, sem "moro em": só vale o que se sabe ser cidade. Uma palavra capitalizada que não é cidade
 * conhecida ("Ana", "Josiane", "Kelly", "Ombros") pode ser o nome do paciente: na dúvida não aceita (a Sofia pergunta de novo).
 * Duas palavras ou mais passam se `pareceCidade` aprova e não começam por tratamento ("Dona Maria", "Seu José") nem por nome comum.
 */
const CIDADES_CONHECIDAS = new Set([
  // as cidades das unidades da rede e das vizinhas
  'caxias', 'petropolis', 'timbo', 'salto', 'tatui', 'araguaina', 'acailandia', 'balsas', 'canaa', 'canaa dos carajas', 'boa vista', 'rio verde',
  'mossoro', 'imperatriz', 'parauapebas', 'maraba', 'bebedouro', 'taubate', 'capivari', 'cerquilho', 'boituva', 'olimpia', 'eldorado dos carajas',
  'curionopolis', 'xinguara', 'redencao', 'conceicao do araguaia', 'tucurui', 'paragominas', 'castanhal', 'belem', 'santarem', 'altamira',
  'sao luis', 'teresina', 'palmas', 'goiania', 'brasilia', 'fortaleza', 'natal', 'recife', 'salvador', 'manaus', 'cuiaba', 'campo grande',
  'sao paulo', 'rio de janeiro', 'belo horizonte', 'curitiba', 'porto alegre', 'florianopolis', 'campinas', 'sorocaba', 'santos', 'ribeirao preto',
  'sao jose do rio preto', 'itu', 'indaiatuba', 'piracicaba', 'jundiai', 'tocantinopolis', 'gurupi', 'colinas do tocantins', 'estreito', 'carolina',
]);
const TRATAMENTO = new Set(['dona', 'seu', 'sr', 'sra', 'dr', 'dra', 'tia', 'tio', 'pastor', 'pastora', 'irma', 'irmao', 'padre', 'doutor', 'doutora', 'senhor', 'senhora']);
const NOMES_COMUNS = new Set([
  'ana', 'maria', 'joao', 'jose', 'pedro', 'paulo', 'carlos', 'marcos', 'lucas', 'luiz', 'luis', 'antonio', 'francisco', 'marcia', 'julia', 'juliana',
  'fernanda', 'patricia', 'camila', 'sandra', 'lucia', 'rita', 'rosa', 'sonia', 'teresa', 'carla', 'cintia', 'aline', 'bruno', 'rafael', 'daniel',
  'gabriel', 'felipe', 'roberto', 'ricardo', 'eduardo', 'fabio', 'sergio', 'jorge', 'mario', 'marcelo', 'andre', 'diego', 'thiago', 'tiago', 'renato',
  'claudia', 'cristina', 'vera', 'elaine', 'luciana', 'adriana', 'simone', 'silvia', 'regina', 'helena', 'beatriz', 'larissa', 'amanda', 'jessica',
  'leticia', 'vanessa', 'valeria', 'raimunda', 'francisca', 'antonia', 'sebastiao', 'raimundo', 'manoel', 'joaquim', 'alex', 'wellington', 'edson',
]);
/** `true` quando a resposta curta NÃO pode ser aceita como cidade: pode ser nome de gente, ou não é cidade conhecida. */
function pareceNome(t: string): boolean {
  const n = semAcento(t).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const p = n.split(' ').filter(Boolean);
  if (p.length === 0) return true;
  if (CIDADES_CONHECIDAS.has(n)) return false;
  if (p.length === 1) return true; // uma palavra que não é cidade conhecida: na dúvida, pode ser o nome dele
  if (TRATAMENTO.has(p[0])) return true;
  if (NOMES_COMUNS.has(p[0]) && !(p.length >= 3 && ['do', 'da', 'de', 'dos', 'das'].includes(p[1]))) return true;
  return false;
}

const PALAVRAS_DE_OUTRO_ASSUNTO = /\b(?:pre[cç]o|valor|quanto|custa|hor[aá]rio|consulta|agendar|marcar|dia|plano|conv[eê]nio|pix)\b/i;
/** Resposta curta à pergunta da cidade que NÃO é cidade ("no centro", "bairro Nova Esperança", "em casa"). */
const ONDE_MORA_SEM_CIDADE = /\b(?:bairro|centro|rua|avenida|av\.|casa|apartamento|s[ií]tio|fazenda|zona\s+rural|condom[ií]nio|loteamento)\b/i;

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
    // nome de cidade tem até 4 palavras; o resto (dor, nome, pedido) é outra coisa dita no lugar da resposta
    if (palavras.length > 4 || PALAVRAS_DE_OUTRO_ASSUNTO.test(t) || ONDE_MORA_SEM_CIDADE.test(t) || !pareceCidade(t) || pareceNome(t)) return null;
    if (/\b(?:sinto|tenho|dor|doi|meu|minha|nome|chamo|chamar|pode|quero|queria|preciso|estou|to|vou|acho|nao|ja|ola|oi)\b/.test(semAcento(t))) return null;
    if (/^(?:sim|n[aã]o|ok|okay|t[aá]|isso|aham|uhum|obrigad[oa]|pode\s+ser)\b/i.test(t)) return null;
    return t.slice(0, 60);
  }
  // Tempo e rotina: só vale fala com CONTEÚDO que responde — tempo (número, "ontem", "faz tempo") ou atividade/verbo da rotina. "sim", "ok",
  // um nome, o aviso de mídia do Lite e pergunta de convênio sem "?" não respondem nada: na dúvida a Sofia ainda pergunta.
  if (tema === 'tempo de dor') return respostaDiretaDeTempo(t) ? t.slice(0, 80) : null;
  return respostaDeImpacto(t) ?? (IMPACTO_ATIVIDADE.test(semAcento(t)) && !PALAVRAS_DE_OUTRO_ASSUNTO.test(t) ? t.slice(0, 80) : null);
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

const CONFIRMA_CIDADE_DITA = /\bmora\s+(?:aqui\s+)?(?:em|no|na)\s+\p{Lu}/u;

/** Os temas já respondidos que a resposta do modelo pergunta de novo. */
export function temasRepetidosNaResposta(resposta: string, ja: readonly JaRespondida[]): Tema[] {
  if (ja.length === 0) return [];
  const respondidos = new Set(ja.map((r) => r.tema));
  const repetidos = new Set<Tema>();
  for (const q of perguntasDe(resposta)) {
    const tema = temaDaPergunta(q);
    if (!tema || !respondidos.has(tema)) continue;
    // "Você mora em Marabá, né?" confirma o que ele disse (cita a cidade), não pergunta a cidade: não é repetição
    if (tema === 'cidade' && CONFIRMA_CIDADE_DITA.test(q)) continue;
    repetidos.add(tema);
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
    'mantenha o resto e o tom, e termine com o PRÓXIMO passo da conversa (a pergunta seguinte do roteiro). NÃO ofereça horário novo nem mude dia ou hora: se o rascunho já tinha horários, mantenha EXATAMENTE esses; se não tinha, não ponha nenhum. ' +
    'Responda só com a mensagem final.'
  );
}

/**
 * A resposta refeita roda DEPOIS da trava de horário (vencido, inventado, "manhã ou tarde?"): ela não pode trazer horário que o
 * rascunho não tinha, nem um que já passou. Só pode repetir os do rascunho.
 */
export function refeitaTrazHorarioNovo(rascunho: string, refeita: string, agoraLocal: string): boolean {
  const antes = horariosOferecidos(rascunho, agoraLocal);
  const depois = horariosOferecidos(refeita, agoraLocal);
  const novos = depois.filter((h) => !antes.some((o) => o.data === h.data && o.hora === h.hora));
  return novos.length > 0 || horariosQueJaPassaram(depois, agoraLocal).length > 0;
}
