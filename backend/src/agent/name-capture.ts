import { PRIMEIROS_NOMES } from './primeiros-nomes.js';

function norm(w: string): string {
  return w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

const PALAVRAS_DE_QUEIXA = new Set([
  'dor', 'dores', 'dorzinha', 'doi', 'doendo', 'fraqueza', 'formigamento',
  'dormencia', 'inchaco', 'inflamacao', 'lesao', 'hernia', 'disco', 'coluna',
  'lombar', 'cervical', 'ciatico', 'ciatica', 'nervo', 'perna', 'pernas',
  'braco', 'bracos', 'costas', 'joelho', 'ombro', 'quadril', 'pescoco',
  'cirurgia', 'exame', 'ressonancia', 'raio', 'fisioterapia', 'remedio',
  'tratamento', 'consulta', 'medico', 'sintoma', 'sintomas', 'protrusao',
  'artrose', 'bico', 'papagaio', 'travada', 'travado',
]);

/**
 * Verbos que aparecem nas perguntas que o paciente faz logo depois de a IA
 * perguntar o nome. Nenhum deles e nome de gente, e todos ja apareceram em
 * conversa real: "vcs atendem planos?", "aceita convenio?", "quanto custa?".
 */
const VERBOS_DE_PERGUNTA = new Set([
  'atende', 'atendem', 'atendeu', 'aceita', 'aceitam', 'faz', 'fazem', 'trabalha',
  'trabalham', 'custa', 'custam', 'funciona', 'funcionam', 'fica', 'ficam',
  'cobra', 'cobram', 'demora', 'demoram', 'precisa', 'precisam',
  'tem', 'teria', 'seria', 'poderia', 'consegue', 'conseguem', 'planos', 'plano',
  'convenio', 'convenios', 'particular',
]);

const STOPWORDS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'meu', 'minha', 'seu', 'sua',
  'muito', 'muita', 'muitos', 'muitas', 'pouco', 'pouca', 'poucos', 'poucas',
  'meio', 'meia', 'mais', 'menos', 'todo', 'toda', 'isso', 'aquilo', 'esse',
  'essa', 'este', 'esta', 'aqui', 'ali', 'la', 'gente', 'eu', 'voce', 'ela', 'ele',
  'vc', 'vcs', 'voces', 'voc',
  'sou', 'e', 'ser', 'esta', 'estou', 'ta', 'to', 'tem', 'tenho', 'quero',
  'queria', 'gostaria', 'preciso', 'sei', 'sinto', 'acho', 'posso', 'pode',
  'saber', 'marcar', 'agendar', 'consultar', 'com', 'sem', 'em', 'por', 'para',
  'pra', 'que', 'qual', 'quanto', 'quando', 'onde', 'como', 'nao', 'sim',
  'oi', 'ola', 'bom', 'boa', 'dia', 'tarde', 'noite', 'obrigado', 'obrigada', 'ok',
  'dor', 'dores', 'coluna', 'hernia', 'disco', 'nervo', 'ciatico', 'ciatica',
  'consulta', 'valor', 'valores', 'preco', 'diabetico', 'diabetica', 'hipertenso',
  'hipertensa', 'obeso', 'obesa', 'corcunda', 'coucuda', 'aposentado', 'aposentada',
  'doente', 'cansado', 'cansada', 'nervoso', 'nervosa', 'operado', 'operada',
  // Viraram título de cartão pela rede de segurança em set–out/2026 (medido 19/10, rede toda):
  // "Desculpa apertei errado", "Obg", "Combinado", "Atrapalha no trabalho", "Mas hj eu tô de férias"…
  'desculpa', 'desculpe', 'obg', 'obgd', 'obgda', 'brigado', 'brigada', 'valeu', 'vlw',
  'combinado', 'beleza', 'blz', 'certo', 'entendi', 'entendido', 'perfeito', 'otimo', 'show',
  'mas', 'entao', 'assim', 'nossa', 'opa', 'ai', 'ja', 'so', 'no', 'na', 'nos', 'nas', 'me', 'se', 'te',
  'hj', 'hoje', 'agora', 'depois', 'amanha', 'ontem', 'tudo', 'parte',
  'vou', 'vamos', 'achei', 'era', 'fui', 'tinha', 'tive', 'tava', 'estava', 'atrapalha', 'manda', 'passa',
  'paciente', 'amiga', 'amigo', 'diagnosticada', 'diagnosticado', 'portadora', 'portador',
  'outra', 'outro', 'numero', 'telefone', 'celular', 'confirmo', 'cancela', 'cancelar', 'opcao', 'invalida',
  'explicando', 'endereco', 'teste', 'empresa', 'unidade', 'clinica', 'hapvida', 'radiografia', 'gluteos',
  'atendimento', 'automatico', 'cadeirante',
  'tornozelo', 'formigamentos', 'servical', 'desde', 'manha', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado',
  // "sou X" com profissão/parentesco (quem escreve não está dizendo o nome)
  'motorista', 'auxiliar', 'barbeiro', 'caminhoneiro', 'camioneiro', 'cabeleireira', 'manicure', 'diarista',
  'professora', 'professor', 'enfermeira', 'secretaria', 'doutora', 'doutor', 'assistente', 'gestora', 'gestor',
  'irmao', 'mae', 'pai', 'filha', 'esposa', 'marido', 'esposo', // 'filho' e 'irma' não: "José Filho", "Irma"
  // espanhol/inglês que aparece ("Hola buenos noches", "Soy venezolana", "mentioned you in their story")
  'hola', 'buenos', 'buenas', 'soy', 'si', 'mentioned', 'story',
  // avisos do WhatsApp/Kommo que chegam como mensagem do paciente ("Unable to display this message…",
  // "Flow responses received")
  'unable', 'flow',
  // Palavras que a IA grava no lugar de um nome quando não tem nenhum (Tatuí 19/11/2026 e Salto 13/11: "Ocupado"; 21/10 e 23/10:
  // "Cliente"). Ficam no prompt como exemplo de "isso não é nome" — e daí o modelo as copia.
  'ocupado', 'ocupada', 'cliente', 'clientes', 'loja', 'lead', 'contato', 'usuario', 'usuaria',
  'desconhecido', 'desconhecida', 'anonimo', 'anonima', 'indisponivel', 'placeholder', 'informado', 'definir',
]);

/**
 * Palavras que nunca são nome e que saíram como título em 05–21/11/2026 («meu nome é ainda disse que é uma hérnia», «sou a favor», «sou o
 * analista», «eu sou daqui de…», «Mim Chamou Rodrigo», «Nome De Valdete»). Ficam FORA de `STOPWORDS` de propósito: só valem com a chave
 * `TITULO_CAPTURA_RIGIDA` ligada E só na captura da rede de segurança (`looksLikeName(x, true)`). Os outros chamadores — `atualizar_titulo_lead`
 * (a IA), nome-no-contato, nome-apresentavel — seguem com o `looksLikeName(x)` de sempre.
 */
const PALAVRAS_RIGIDAS = new Set([
  'ainda', 'disse', 'falo', 'trabalho', 'favor', 'daqui', 'analista', 'pedreiro', 'mulher', 'homem', 'imagem', 'audio', 'https', 'http',
  'nome', 'mim', 'chamou', 'chame', 'chamo', 'mesmo', 'ha', 'tou', 'data', 'rua', 'avenida', 'travessa', 'bairro', 'quadra', 'setor', 'loteamento',
]);

/** "Oiii", "Oie", "Olaaa", "kkkk", "rsrs": cumprimento e risada esticados não cabem numa lista. */
const CUMPRIMENTO_OU_RISADA = /^(o+i+e*|o+l+a+|bo+m+|k{2,}|(rs)+|(ha){2,}|(he){2,}|obr|ne)$/;

const NAME_WORD_RE = /^[a-zà-ÿ][a-zà-ÿ'\-]*$/i;

/**
 * Nome brasileiro é comprido, e o limite tem que contar os pedaços QUE IMPORTAM.
 *
 * Antes o corte era `words.length > 4` sobre as palavras cruas, e isso descartava
 * nome real: "Elzilene de Sales Dias Nogueira" (caso de produção, Imperatriz,
 * 28/08/2026) tem 5 palavras — 4 tokens de nome mais o conector "de" — e o card
 * ficou sem o nome da paciente. "Maria da Silva dos Santos" caía igual.
 *
 * Agora o teto vale sobre os tokens REAIS (conectores não contam) e a contagem
 * crua serve só de guarda contra alguém colar uma frase inteira. Quem realmente
 * separa nome de frase são as listas de queixa e de stopword — qualquer frase em
 * português esbarra numa delas.
 */
const MAX_TOKENS_REAIS = 6;
const MAX_PALAVRAS = 8;

export function looksLikeName(candidate: string, rigido = false): boolean {
  const cleaned = (candidate ?? '').trim();
  if (!cleaned) return false;
  if (/\d/.test(cleaned)) return false;
  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > MAX_PALAVRAS) return false;
  if (CONNECTORS.has(norm(words[0]))) return false;
  let tokensReais = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const n = norm(w);
    // "Maria das Dores" (sobrenome/devoção comum): "Dores" com D maiúsculo logo depois de "das" e depois de um nome. "dores nas costas",
    // "Dores lombares" e "sofro de dores" continuam fora (sem "das" antes, ou minúsculo).
    if (n === 'dores' && i > 0 && norm(words[i - 1]) === 'das' && w.startsWith('D') && tokensReais > 0) {
      tokensReais++;
      continue;
    }
    if (PALAVRAS_DE_QUEIXA.has(n)) return false;
    // Conector ANTES de stopword E de verbo: "e" está nas duas listas, e como
    // stopword vinha primeiro, nenhum nome com "e" no meio passava. Mesma razão
    // vale para "da" em "Maria da Silva" — sem acento ele é igual ao verbo.
    if (CONNECTORS.has(n)) continue;
    if (VERBOS_DE_PERGUNTA.has(n)) return false;
    if (STOPWORDS.has(n)) return false;
    if (rigido && PALAVRAS_RIGIDAS.has(n)) return false;
    if (CUMPRIMENTO_OU_RISADA.test(n)) return false;
    if (!NAME_WORD_RE.test(w)) return false;
    if (n.length < 2) return false;
    tokensReais++;
  }
  return tokensReais > 0 && tokensReais <= MAX_TOKENS_REAIS;
}

/**
 * Chave de emergência: `TITULO_CAPTURA_RIGIDA=off` (ou `false`, `0`) devolve a captura do nome ao que era até 21/11/2026 — a rede de
 * segurança do título, as palavras novas de `PALAVRAS_RIGIDAS` e a regravação do título —, sem novo deploy de código. Ligada por padrão.
 */
export function capturaRigidaLigada(raw: string | undefined = process.env.TITULO_CAPTURA_RIGIDA): boolean {
  return !['off', 'false', '0'].includes((raw ?? '').trim().toLowerCase());
}

/**
 * Sobrenomes comuns no Brasil. Servem a duas coisas: «de/da/do» + um destes é sobrenome mesmo escrito em minúscula ("maria da silva" ×
 * "breno da reunião"), e um nome de 2+ palavras que TERMINA em um destes ("Adeilma Gomes Lima") é nome completo mesmo com o primeiro nome
 * fora da lista.
 */
const SOBRENOMES_COMUNS = new Set([
  'silva', 'santos', 'oliveira', 'souza', 'sousa', 'rodrigues', 'ferreira', 'alves', 'pereira', 'lima', 'gomes', 'costa', 'ribeiro', 'martins',
  'carvalho', 'almeida', 'lopes', 'soares', 'fernandes', 'vieira', 'barbosa', 'rocha', 'dias', 'nascimento', 'andrade', 'moreira', 'nunes',
  'marques', 'machado', 'mendes', 'freitas', 'cardoso', 'ramos', 'goncalves', 'santana', 'teixeira', 'moura', 'cavalcante', 'campos', 'araujo',
  'melo', 'mello', 'borges', 'pinto', 'monteiro', 'correia', 'batista', 'reis', 'farias', 'lacerda', 'siqueira', 'brito', 'miranda', 'azevedo',
  'barros', 'castro', 'cunha', 'duarte', 'fonseca', 'guimaraes', 'henrique', 'matos', 'medeiros', 'morais', 'moraes', 'neves',
  'paiva', 'peixoto', 'pires', 'queiroz', 'rezende', 'sales', 'sampaio', 'tavares', 'viana', 'xavier', 'jesus', 'fatima', 'lourdes',
  'deus', 'nazare', 'socorro', 'aparecida', 'conceicao', 'assis', 'paula', 'carmo', 'santo', 'anjos', 'rosario', 'cruz', 'gracas', 'dores',
  'mercedes',
]);
/**
 * Segundo nome que vale DEPOIS de um primeiro nome já provado («Maria Clara», «Ana Sophia», «Maria da Penha»), mas que sozinho não prova nada
 * — ficam fora de `PRIMEIROS_NOMES` por serem também palavra comum, nome de IA da rede ou cidade.
 */
const SEGUNDOS_NOMES = new Set([
  'clara', 'aurora', 'sara', 'aline', 'cintia', 'sophia', 'sofia', 'irma', 'vitoria', 'penha', 'luz', 'rosa', 'gloria', 'graca', 'esperanca',
  'paz', 'domingos', 'salvador', 'marco', 'tomas',
]);
/** Palavra que cabe numa cauda de nome sem ser descartada: conector, primeiro nome, sobrenome comum, Júnior/Filho/Neto ou segundo nome. */
function ehPalavraConhecida(p: string): boolean {
  return CONNECTORS.has(p) || PRIMEIROS_NOMES.has(p) || SOBRENOMES_COMUNS.has(p) || SUFIXO_DE_FAMILIA.has(p) || SEGUNDOS_NOMES.has(p);
}
const SUFIXO_DE_FAMILIA = new Set(['junior', 'filho', 'neto', 'sobrinho']);

/**
 * Com maiúscula, "de/da/do" + palavra costuma ser sobrenome ("Paiva", "Gouvêa", "Sales") — menos estas, que vêm de «aqui é a Ana da
 * Recepção», «Bruno da Khube», «Carlos do Banco».
 */
const NAO_E_SOBRENOME_APOS_CONECTOR = new Set([
  'recepcao', 'clinica', 'empresa', 'reuniao', 'loja', 'equipe', 'unidade', 'atendimento', 'consultorio', 'hospital', 'secretaria',
  'farmacia', 'banco', 'escritorio', 'agencia', 'central', 'financeiro', 'comercial', 'vendas', 'ia', 'sofia', 'doutor', 'doutora',
  'dra', 'dr', 'igreja', 'escola', 'faculdade', 'prefeitura', 'associacao', 'cooperativa', 'laboratorio', 'imobiliaria', 'agropecuaria',
]);

/**
 * Lugares que já viraram «nome» («Meu nome é Goiânia»). Só nome de lugar que NÃO é também nome de gente — Vitória, Natal, Santos, Campos,
 * Serra, Cristina, Salvador (nome e cidade) ficam de fora.
 */
const LUGARES = new Set([
  'goiania', 'brasilia', 'manaus', 'belem', 'recife', 'curitiba', 'palmas', 'cuiaba', 'teresina', 'maceio', 'aracaju', 'florianopolis',
  'fortaleza', 'joinville', 'uberlandia', 'campinas', 'guarulhos', 'osasco', 'sorocaba', 'londrina', 'maringa', 'anapolis', 'araguari',
  'parauapebas', 'maraba', 'imperatriz', 'araguaina', 'acailandia', 'balsas', 'bebedouro', 'taubate', 'olimpia', 'mossoro', 'timbo',
  'petropolis', 'caxias', 'divinopolis', 'tatui', 'salto', 'cerquilho', 'capivari', 'boituva', 'canaa', 'carajas', 'tocantins', 'maranhao',
  'bahia', 'pernambuco', 'goias', 'piaui', 'ceara', 'amazonas', 'rondonia', 'roraima', 'amapa', 'sergipe', 'alagoas', 'paraiba', 'parana',
  'minas', 'gerais', 'angra', 'formosa', 'paragominas', 'xinguara', 'brasil', 'portugal', 'venezuela', 'colombia', 'bolivia', 'paraguai', 'argentina', 'janeiro',
]);

/** Sigla de estado colada ao nome por hífen ("Recife-pe"): vem de "sou Fulano, Recife-PE", não faz parte do nome. */
const SUFIXO_DE_UF = /-(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)$/i;

export interface OpcoesDeExtracao {
  /** Corte rígido da cauda do nome (ver `capturaRigidaLigada`). Sem ele, o comportamento de antes de 21/11/2026. */
  rigido?: boolean;
}

export function extractLeadingName(raw: string, opts: OpcoesDeExtracao = {}): string | null {
  const words = (raw ?? '').trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const n = norm(w);
    if (opts.rigido) {
      // O pedido continua depois do nome: "Daniel e falo do Análise", "Sandy e trabalho com planos". Nome com " e " no meio não existe.
      if (n === 'e') break;
      // "Marcos Nascimento Recife-pe": a sigla do estado não é nome.
      if (out.length > 0 && SUFIXO_DE_UF.test(w)) break;
      if (PALAVRAS_RIGIDAS.has(n)) break;
      // "Bruno Menezes da IA2GO", "breno da reunião esqueci seu nome", "Ana da Recepção": conector só se o que vem depois é sobrenome.
      if (CONNECTORS.has(n) && out.length > 0) {
        const proxima = words[i + 1];
        const np = proxima ? norm(proxima) : '';
        const pareceSobrenome =
          !!proxima &&
          !NAO_E_SOBRENOME_APOS_CONECTOR.has(np) &&
          (/^\p{Lu}\p{Ll}/u.test(proxima) ||
            (/^\p{Lu}{2,}$/u.test(proxima) && /^\p{Lu}{2,}$/u.test(words[0])) || // "FLAVIO DE PAIVA": tudo em caixa alta
            ehPalavraConhecida(np));
        if (!pareceSobrenome) break;
      }
    }
    if (!CONNECTORS.has(n) && STOPWORDS.has(n)) break;
    if (!CONNECTORS.has(n) && !NAME_WORD_RE.test(w)) break;
    out.push(w);
    if (out.length >= MAX_PALAVRAS) break;
  }
  // Rígido: depois do primeiro nome, a palavra que segue só fica se for conhecida (primeiro nome, sobrenome comum, de/da/do) ou escrita
  // com maiúscula — «Meu nome é Mateus exatamente…», «me chamo Valmir porém…» (cauda de frase em minúscula) viravam «Mateus Exatamente».
  if (opts.rigido) {
    const corte = out.findIndex((w, i) => {
      if (i === 0) return false;
      const np = norm(w);
      return !(ehPalavraConhecida(np) || /^\p{Lu}/u.test(w));
    });
    if (corte > 0) out.length = corte;
  }
  while (out.length && CONNECTORS.has(norm(out[out.length - 1]))) out.pop();
  const cand = out.join(' ');
  // «Meu nome é Goiânia»: lugar não é nome.
  if (opts.rigido && out.some((w) => LUGARES.has(norm(w)))) return null;
  return looksLikeName(cand, !!opts.rigido) ? cand : null;
}

export function askedForName(assistantMessage: string | null | undefined): boolean {
  if (!assistantMessage) return false;
  return /(como.*(te chamar|posso.*chamar)|seu nome|nome completo|qual.*nome|me (diz|conta|fala).*nome|pode.*passar.*nome)/i.test(
    assistantMessage,
  );
}

/**
 * A parte da resposta solta a «como posso te chamar?» que tem PROVA de ser nome, ou null se nenhuma tem.
 *
 * - A PRIMEIRA palavra está na lista de primeiros nomes comuns (primeiros-nomes.ts) — não qualquer uma: «Mim Chamou Rodrigo», «Chame Ana
 *   Mesmo», «Nome De Valdete». O resto só entra se for conhecido (primeiro nome, sobrenome comum, de/da/do) ou se a última palavra for
 *   sobrenome comum («Edna Evangelista Cardoso»). Cauda sem prova é cortada: «Mateus Exatamente» → «Mateus», «Erica Há» → «Erica».
 * - Primeiro nome raro só passa como nome completo: 3+ palavras, todas as seguintes conhecidas, a última sobrenome comum
 *   («Adeilma Gomes Lima»). «Alguns Dias», «Brasil Sales», «Data De Nascimento» não passam.
 *
 * «Lomba», «Esim», «Canaense», «Nego lindo», «Aonde faca» não têm prova. O nome do contato (perfil) NÃO serve de prova: o `author.name`
 * que chega do Kommo é o nome do contato no Kommo, e quem o grava é a própria IA (atualizar_titulo_lead → nomeTambemNoContato).
 */
function trechoComProva(nome: string): string | null {
  const palavras = (nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return null;
  const n = palavras.map(norm);
  const nucleo = n.filter((p) => !CONNECTORS.has(p));
  while (nucleo.length > 1 && SUFIXO_DE_FAMILIA.has(nucleo[nucleo.length - 1])) nucleo.pop();
  const terminaEmSobrenome = nucleo.length >= 2 && SOBRENOMES_COMUNS.has(nucleo[nucleo.length - 1]);

  if (PRIMEIROS_NOMES.has(n[0])) {
    // «Edna Evangelista Cardoso»: o nome do meio pode ser raro, mas escrito com maiúscula — «Maria quero reis» não.
    if (terminaEmSobrenome && palavras.slice(1, -1).every((w, i) => ehPalavraConhecida(n[i + 1]) || /^\p{Lu}/u.test(w))) return palavras.join(' ');
    let fim = 1;
    while (fim < palavras.length && ehPalavraConhecida(n[fim])) fim++;
    while (fim > 1 && CONNECTORS.has(n[fim - 1])) fim--;
    return palavras.slice(0, fim).join(' ');
  }
  if (nucleo.length >= 3 && terminaEmSobrenome && n.slice(1).every(ehPalavraConhecida)) return palavras.join(' ');
  return null;
}

export function nomeCorroborado(nome: string): boolean {
  return trechoComProva(nome) !== null;
}

interface Pedaco {
  texto: string;
  /** Transcrição de áudio (quando o webhook põe a marca). */
  audio: boolean;
}

const MARCA_DE_MIDIA = /\[(?:áudio|audio|imagem|arquivo|v[ií]deo|figurinha|sticker|documento|foto)[^\]\n]*\]\s*:?/gi;

/**
 * Separa o que o paciente ESCREVEU do que o sistema colou na mensagem. O texto que a IA recebe traz "[imagem do cliente]: <o que o
 * modelo de visão viu>", "[áudio do cliente]: <transcrição>", links e avisos entre colchetes — e a rede de segurança lia isso como se
 * fosse fala dele: 9× o cartão virou "Imagem Do Cliente", 2× "Áudio Do Cliente", 4× "Https" (medido 05–21/11/2026).
 *
 * O webhook monta cada mensagem como `<texto escrito>\n\n[<tipo> do cliente]: <o que leu>` (webhook.controller.ts, ~1541), então o que
 * o paciente escreveu vem SEMPRE antes das marcas, e tudo depois de uma marca de imagem/arquivo — parágrafos inclusive — é descrição.
 * Descrição sai inteira (a de imagem pode ter parágrafos); transcrição de áudio fica, com a marca; link e "[voice]" saem do texto.
 * Áudio SOZINHO chega sem marca nenhuma (webhook, ~1454: `humanMessage ? … : transcript`) e é lido como texto escrito: as regras
 * não podem depender da marca.
 */
function pedacosDaFala(raw: string): Pedaco[] {
  const texto = (raw ?? '').replace(/\r/g, '');
  const marcas = [...texto.matchAll(MARCA_DE_MIDIA)];
  const pedacos: Pedaco[] = [];
  const limpar = (t: string) =>
    t
      .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
      .replace(/\[[^\]\n]{0,40}\]/g, ' ')
      .trim();
  const antes = marcas.length ? texto.slice(0, marcas[0].index) : texto;
  if (limpar(antes)) pedacos.push({ texto: limpar(antes), audio: false });
  marcas.forEach((m, i) => {
    if (!/áudio|audio/i.test(m[0])) return;
    const ini = (m.index ?? 0) + m[0].length;
    const fim = i + 1 < marcas.length ? marcas[i + 1].index : texto.length;
    const t = limpar(texto.slice(ini, fim));
    if (t) pedacos.push({ texto: t, audio: true });
  });
  return pedacos;
}

export interface OpcoesDeCaptura {
  /** A IA acabou de perguntar o nome (askedForName da última fala dela). */
  nameWasAsked?: boolean;
  /** Padrão: `capturaRigidaLigada()`. */
  rigido?: boolean;
}

export function detectNameDisclosure(userMessage: string, opts: OpcoesDeCaptura = {}): string | null {
  const rigido = opts.rigido ?? capturaRigidaLigada();
  const pedacos: Pedaco[] = rigido ? pedacosDaFala(userMessage) : [{ texto: (userMessage ?? '').trim(), audio: false }];
  for (const p of pedacos) {
    const name = detectarNoPedaco(p, opts, rigido);
    if (name) return name;
  }
  return null;
}

function detectarNoPedaco(pedaco: Pedaco, opts: OpcoesDeCaptura, rigido: boolean): string | null {
  const cleaned = pedaco.texto.trim();
  if (!cleaned) return null;

  const NAME_CHARS = "[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\\-]*";
  // Rígido: a cauda não pode terminar no meio de uma palavra ("IA2GO" virava "IA").
  const FIM = rigido ? "(?![A-Za-zÀ-ÿ0-9_'\\-])" : '';
  const TAIL = `(${NAME_CHARS}(?:\\s+${NAME_CHARS}){0,4})${FIM}`;
  const patterns: Array<{ re: RegExp; fraco?: boolean; exata?: boolean }> = [
    { re: new RegExp(`\\bmeu\\s+nome\\s+completo\\s+(?:é|eh|e)\\s+${TAIL}`, 'i') },
    { re: new RegExp(`\\bmeu\\s+nome\\s+(?:é|eh|e)\\s+${TAIL}`, 'i') },
    { re: new RegExp(`\\bme\\s+chamo\\s+${TAIL}`, 'i') },
    { re: new RegExp(`\\bpode\\s+(?:me\\s+)?chamar\\s+de\\s+${TAIL}`, 'i') },
    // "aqui é o X" também serve de "aqui é o analista": padrão fraco, como "sou X".
    { re: new RegExp(`\\baqui\\s+(?:é|eh|e|quem\\s+fala\\s+é)\\s+(?:o|a)\\s+${TAIL}`, 'i'), fraco: true },
    // "Gilmar meu nome." / "Gilmar é o meu nome"
    // Rígido: o que vem antes de "meu nome" tem que ser SÓ o nome ("Saiu com o meu nome aí" não é «Saiu»).
    { re: new RegExp(`^${TAIL}\\s+(?:(?:é|eh|e)\\s+)?(?:o\\s+)?meu\\s+nome\\b`, 'i'), exata: true },
  ];
  // Padrão fraco («aqui é o X», «sou X»): sem o nome na lista só vale se a IA acabou de perguntar e a pessoa escreveu UMA palavra em maiúscula
  // (e que não seja o nome de uma IA da rede: «Eu sou a Sofia»).
  const valeFraco = (inicio: string, name: string) =>
    nomeCorroborado(name) ||
    (!!opts.nameWasAsked && /^\p{Lu}/u.test(inicio) && name.trim().split(/\s+/).length === 1 && !SEGUNDOS_NOMES.has(norm(name)));
  for (const { re, fraco, exata } of patterns) {
    const m = cleaned.match(re);
    if (m && m[1]) {
      const name = extractLeadingName(m[1], { rigido });
      if (!name) continue;
      if (rigido && exata) {
        // "Gilmar é o meu nome": o "é o" que o TAIL engole não é nome.
        const palavras = m[1].trim().split(/\s+/);
        while (palavras.length > 1 && ['e', 'eh', 'o'].includes(norm(palavras[palavras.length - 1]))) palavras.pop();
        if (norm(name) !== norm(palavras.join(' '))) continue;
      }
      if (!rigido || !fraco || valeFraco(m[1], name)) return name;
    }
  }

  // "sou X" é o padrão mais solto: "sou paciente", "sou auxiliar de professora", "sou motorista" viraram
  // título. Sem artigo e sem a IA ter perguntado o nome, só conta com X em maiúscula — é como a pessoa
  // escreve o próprio nome, e não a profissão. "sou a vania" / "sou o jonas" (com artigo) valem em minúscula.
  // Rígido: precisa do nome na lista, ou de pergunta da IA + maiúscula — "sou a favor", "sou o analista", "sou pedreiro",
  // "sou a Arapay assistente da AranetPlay" (robô de outra empresa), "sou daqui".
  const sou = cleaned.match(new RegExp(`\\b(?:eu\\s+)?sou\\s+((?:o|a)\\s+)?${TAIL}`, 'i'));
  if (sou && sou[2]) {
    const name = extractLeadingName(sou[2], { rigido });
    const vale = rigido
      ? !!name && !!(sou[1] || opts.nameWasAsked || /^\p{Lu}/u.test(sou[2])) && valeFraco(sou[2], name)
      : !!(sou[1] || opts.nameWasAsked || /^\p{Lu}/u.test(sou[2]));
    if (name && vale) return name;
  }

  // Transcrição de áudio (com a marca) é frase solta: «Mariana, queria saber o valor» fala COM a atendente, não diz o nome do paciente.
  const respostaCurta = !rigido || !pedaco.audio || cleaned.split(/\s+/).length <= 3;
  if (opts.nameWasAsked && respostaCurta) {
    // Pergunta nao e nome. Caso real (Serra, 01/09/2026): a IA perguntou "como
    // posso te chamar?", a paciente respondeu "Vcs atendem planos de saude?" e
    // o cartao dela foi renomeado para "Vcs Atendem Planos 25/08/2026". O
    // paciente responder com outra pergunta e o normal, nao a excecao.
    if (cleaned.includes('?')) return null;
    // A rajada chega como uma mensagem só, uma por linha ("Olá bom dia\n\nLindalva"): o nome pode estar em qualquer uma.
    for (const linha of cleaned.split(/\n+/)) {
      const name = respostaQueEONome(linha, rigido);
      // Rígido: a palavra solta depois de "como posso te chamar?" é nome só no trecho que tem prova (`trechoComProva`).
      // Antes, qualquer uma virava título ("Lomba", "Esim", "Canaense", "Nego Lindo", "Aonde Faca", "Td Bem").
      if (name) {
        const aceito = rigido ? trechoComProva(name) : name;
        if (aceito) return aceito;
      }
    }
  }

  return null;
}

/**
 * Depois de "como posso te chamar?", a resposta precisa SER o nome — não começar por ele.
 *
 * Antes pegávamos as primeiras palavras de qualquer resposta, e o cartão virava "Desculpa" ("Desculpa
 * apertei errado"), "Atrapalha" ("Atrapalha no trabalho"), "Já" ("Já fiz uma cirurgia…"), "Flow"
 * ("Flow responses received"): das 859 capturas da rede em 30 dias, ~350 eram frase (medido 19/10/2026).
 * Agora vale o trecho até a primeira vírgula/ponto, e ele inteiro tem que parecer nome: "Maria, tenho
 * dor" continua dando "Maria"; "Maria 😊" também (emoji sai). Número no trecho = telefone ou data.
 *
 * Rígido: corta também em « e » / « ou » («Vanila Sodré e Letícia Sodré» → «Vanila Sodré») e recusa quando depois do nome vem um
 * cumprimento seguido de mais frase — «Aline, boa tarde, queria o valor» é áudio falando COM a atendente, não o nome do paciente.
 */
function respostaQueEONome(resposta: string, rigido = false): string | null {
  const trecho = resposta.split(/[,.;:!]|\s[-–—]\s/)[0] ?? '';
  if (/\d/.test(trecho)) return null;
  if (rigido) {
    const resto = resposta.slice(trecho.length);
    if (/^\W*(?:boa|bom|oi+|ol[aá]|bao)\b[^,.;!?]*[,.;!?]\s*\S/i.test(resto)) return null;
  }
  let limpo = trecho.replace(/[^\p{L}\p{M}'\-\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (rigido) {
    const palavras = limpo.split(' ');
    const corte = palavras.findIndex((p, i) => i > 0 && ['e', 'ou'].includes(norm(p)));
    if (corte > 0) limpo = palavras.slice(0, corte).join(' ');
  }
  return looksLikeName(limpo, rigido) ? limpo : null;
}

/**
 * O título do cartão já traz o nome detectado, palavra por palavra e sem olhar caixa nem acento? ("Antônio Souza 16/11/2026" já traz
 * "Antônio"; "Mariana 16/11/2026" NÃO traz "Maria".) Quem escreveu esse título foi a IA (atualizar_titulo_lead) ou a SDR: a rede de
 * segurança não regrava por cima — 225 das 317 trocas de 05–21/11/2026 eram regravação idêntica e 16 estragaram o título.
 */
export function tituloJaTrazONome(titulo: string, nome: string): boolean {
  const palavras = (t: string) => norm(t ?? '').split(/[^a-z0-9]+/).filter(Boolean);
  const alvo = palavras(nome);
  if (alvo.length === 0) return false;
  return ` ${palavras(titulo).join(' ')} `.includes(` ${alvo.join(' ')} `);
}

export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}
