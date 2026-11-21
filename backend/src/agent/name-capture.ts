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
  // Saíram como nome em 05–21/11/2026 («meu nome é ainda disse que é uma hérnia», «sou a favor», «sou o analista», «eu sou daqui de…»).
  'ainda', 'disse', 'falo', 'trabalho', 'favor', 'daqui', 'analista', 'pedreiro', 'mulher', 'homem', 'imagem', 'audio', 'https', 'http',
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

export function looksLikeName(candidate: string): boolean {
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
    if (CUMPRIMENTO_OU_RISADA.test(n)) return false;
    if (!NAME_WORD_RE.test(w)) return false;
    if (n.length < 2) return false;
    tokensReais++;
  }
  return tokensReais > 0 && tokensReais <= MAX_TOKENS_REAIS;
}

/** Sobrenomes que seguem "de/da/do" mesmo escritos em minúscula ("maria da silva"): é o que separa "da Silva" de "da reunião". */
const SOBRENOMES_APOS_CONECTOR = new Set([
  'silva', 'santos', 'souza', 'sousa', 'oliveira', 'pereira', 'costa', 'rodrigues', 'almeida', 'nascimento', 'lima', 'araujo', 'ribeiro',
  'ferreira', 'carvalho', 'gomes', 'martins', 'rocha', 'barbosa', 'alves', 'jesus', 'fatima', 'lourdes', 'deus', 'nazare', 'socorro',
  'aparecida', 'conceicao', 'assis', 'paula', 'carmo', 'santo', 'santana', 'anjos', 'rosario', 'cruz', 'moura', 'melo', 'mello', 'freitas',
  'barros', 'cardoso', 'castro', 'dias', 'lopes', 'moreira', 'nunes', 'teixeira', 'vieira', 'campos', 'andrade', 'azevedo', 'batista',
]);

/** Sigla de estado colada ao nome por hífen ("Recife-pe"): vem de "sou Fulano, Recife-PE", não faz parte do nome. */
const SUFIXO_DE_UF = /-(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)$/i;

export interface OpcoesDeExtracao {
  /** Corte rígido da cauda do nome (ver `capturaRigidaLigada`). Sem ele, o comportamento de antes de 21/11/2026. */
  rigido?: boolean;
  /** Depois do que foi capturado a linha acaba (só pontuação/espaço). "da reunião" no meio da frase não é sobrenome; no fim da linha vale. */
  fimDaLinha?: boolean;
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
      // "Bruno Menezes da IA2GO", "breno da reunião esqueci seu nome": conector só se o que vem depois parece sobrenome.
      if (CONNECTORS.has(n) && out.length > 0) {
        const proxima = words[i + 1];
        const pareceSobrenome =
          !!proxima &&
          (/^\p{Lu}\p{Ll}/u.test(proxima) ||
            (/^\p{Lu}{2,}$/u.test(proxima) && /^\p{Lu}{2,}$/u.test(words[0])) || // "FLAVIO DE PAIVA": tudo em caixa alta
            SOBRENOMES_APOS_CONECTOR.has(norm(proxima)) ||
            (!!opts.fimDaLinha && i + 1 === words.length - 1));
        if (!pareceSobrenome) break;
      }
    }
    if (!CONNECTORS.has(n) && STOPWORDS.has(n)) break;
    if (!CONNECTORS.has(n) && !NAME_WORD_RE.test(w)) break;
    out.push(w);
    if (out.length >= MAX_PALAVRAS) break;
  }
  while (out.length && CONNECTORS.has(norm(out[out.length - 1]))) out.pop();
  const cand = out.join(' ');
  return looksLikeName(cand) ? cand : null;
}

export function askedForName(assistantMessage: string | null | undefined): boolean {
  if (!assistantMessage) return false;
  return /(como.*(te chamar|posso.*chamar)|seu nome|nome completo|qual.*nome|me (diz|conta|fala).*nome|pode.*passar.*nome)/i.test(
    assistantMessage,
  );
}

/**
 * Chave de emergência: `TITULO_CAPTURA_RIGIDA=off` volta a captura do nome (rede de segurança do título) ao que era até 21/11/2026,
 * sem novo deploy de código. Ligada por padrão: na dúvida, não grava.
 */
export function capturaRigidaLigada(raw: string | undefined = process.env.TITULO_CAPTURA_RIGIDA): boolean {
  return (raw ?? '').trim().toLowerCase() !== 'off';
}

const tokensDeNome = (texto: string): string[] => norm(texto ?? '').split(/[^a-z]+/).filter((t) => t.length >= 3);

/**
 * O nome tem alguma prova de que é nome? Um primeiro nome comum (lista fechada, primeiros-nomes.ts) ou uma palavra do perfil do
 * WhatsApp do contato (o que o próprio paciente pôs no aparelho dele). "Lomba", "Esim", "Canaense", "Nego lindo" não têm nenhuma das duas.
 * Nome colado ao sobrenome no perfil também prova, a partir de 6 letras: perfil "jozivambatista834" prova "Jozivam". Abaixo disso o
 * prefixo é coincidência ("Lomba" × "Lombardi Transportes"). O contato do KOMMO não entra: nosso próprio código grava o nome do paciente
 * lá, e um nome errado se provaria sozinho no turno seguinte — só o `author.name` que o WhatsApp mandou no webhook.
 */
export function nomeCorroborado(nome: string, nomeDoPerfil?: string | null): boolean {
  const toks = tokensDeNome(nome).filter((t) => !CONNECTORS.has(t));
  if (toks.length === 0) return false;
  if (PRIMEIROS_NOMES.has(toks[0])) return true;
  const perfil = tokensDeNome(nomeDoPerfil ?? '');
  return toks.some((t) => perfil.some((p) => p === t || (t.length >= 6 && p.startsWith(t))));
}

interface Pedaco {
  texto: string;
  /** Transcrição de áudio: é frase solta, nunca "a resposta" à pergunta do nome. */
  audio: boolean;
}

const MARCA_DE_MIDIA = /\[(?:áudio|audio|imagem|arquivo|v[ií]deo|figurinha|sticker|documento|foto)[^\]\n]*\]\s*:?/gi;

/**
 * Separa o que o paciente ESCREVEU do que o sistema colou na mensagem. O texto que a IA recebe traz "[imagem do cliente]: <o que o
 * modelo de visão viu>", "[áudio do cliente]: <transcrição>", links e avisos entre colchetes — e a rede de segurança lia isso como se
 * fosse fala dele: 9× o cartão virou "Imagem Do Cliente", 2× "Áudio Do Cliente", 4× "Https" (medido 05–21/11/2026).
 * Descrição de imagem e arquivo saem; transcrição de áudio fica, marcada; link e "[voice]" saem do texto digitado.
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
    const ini = (m.index ?? 0) + m[0].length;
    const fim = i + 1 < marcas.length ? marcas[i + 1].index : texto.length;
    const corpo = texto.slice(ini, fim);
    // A descrição/transcrição é o primeiro parágrafo; o que vem depois de uma linha em branco é a próxima mensagem da rajada,
    // digitada pelo paciente ("[imagem do cliente]: …\n\nMeu nome é Ana").
    const corte = corpo.search(/\n\s*\n/);
    const descricao = corte < 0 ? corpo : corpo.slice(0, corte);
    const resto = corte < 0 ? '' : corpo.slice(corte);
    if (/áudio|audio/i.test(m[0]) && limpar(descricao)) pedacos.push({ texto: limpar(descricao), audio: true });
    if (limpar(resto)) pedacos.push({ texto: limpar(resto), audio: false });
  });
  return pedacos;
}

export interface OpcoesDeCaptura {
  /** A IA acabou de perguntar o nome (askedForName da última fala dela). */
  nameWasAsked?: boolean;
  /** Nome do contato no WhatsApp (`author.name` do webhook): prova um nome que a lista de primeiros nomes não tem. */
  nomeDoPerfil?: string | null;
  /** Padrão: `capturaRigidaLigada()`. */
  rigido?: boolean;
}

export interface ResultadoDaCaptura {
  nome: string | null;
  /** Sem nome, mas havia candidato a que só o perfil do WhatsApp poderia provar: vale ler o perfil e tentar de novo. */
  precisaPerfil: boolean;
}

export function detectarNome(userMessage: string, opts: OpcoesDeCaptura = {}): ResultadoDaCaptura {
  const rigido = opts.rigido ?? capturaRigidaLigada();
  const pedacos: Pedaco[] = rigido ? pedacosDaFala(userMessage) : [{ texto: (userMessage ?? '').trim(), audio: false }];
  const ctx = { semProva: false };
  for (const p of pedacos) {
    const nome = detectarNoPedaco(p, opts, rigido, ctx);
    if (nome) return { nome, precisaPerfil: false };
  }
  return { nome: null, precisaPerfil: ctx.semProva };
}

export function detectNameDisclosure(userMessage: string, opts: OpcoesDeCaptura = {}): string | null {
  return detectarNome(userMessage, opts).nome;
}

function detectarNoPedaco(pedaco: Pedaco, opts: OpcoesDeCaptura, rigido: boolean, ctx: { semProva: boolean }): string | null {
  const cleaned = pedaco.texto.trim();
  if (!cleaned) return null;
  const corrobora = (nome: string) => {
    const ok = nomeCorroborado(nome, opts.nomeDoPerfil);
    if (!ok) ctx.semProva = true;
    return ok;
  };

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
  const fimDaLinha = (m: RegExpMatchArray): boolean => {
    const resto = cleaned.slice((m.index ?? 0) + m[0].length).split('\n')[0] ?? '';
    return !/[\p{L}\p{N}]/u.test(resto);
  };
  // Padrão fraco («aqui é o X», «sou X»): sem prova de nome só vale se a IA acabou de perguntar e a pessoa escreveu em maiúscula.
  const valeFraco = (inicio: string, name: string) => corrobora(name) || (!!opts.nameWasAsked && /^\p{Lu}/u.test(inicio));
  for (const { re, fraco, exata } of patterns) {
    const m = cleaned.match(re);
    if (m && m[1]) {
      const name = extractLeadingName(m[1], { rigido, fimDaLinha: rigido && fimDaLinha(m) });
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
  // Rígido: precisa de prova (lista/perfil) ou de pergunta da IA + maiúscula — "sou a favor", "sou o analista", "sou pedreiro",
  // "sou a Arapay assistente da AranetPlay" (robô de outra empresa), "sou daqui".
  const sou = cleaned.match(new RegExp(`\\b(?:eu\\s+)?sou\\s+((?:o|a)\\s+)?${TAIL}`, 'i'));
  if (sou && sou[2]) {
    const name = extractLeadingName(sou[2], { rigido, fimDaLinha: rigido && fimDaLinha(sou) });
    const vale = rigido
      ? !!name && !!(sou[1] || opts.nameWasAsked || /^\p{Lu}/u.test(sou[2])) && valeFraco(sou[2], name)
      : !!(sou[1] || opts.nameWasAsked || /^\p{Lu}/u.test(sou[2]));
    if (name && vale) return name;
  }

  // Áudio é frase solta, e o pedaço até a primeira vírgula ("Mulher, eu tenho vontade…") não é a resposta à pergunta do nome.
  const respostaCurta = !rigido || !pedaco.audio || cleaned.split(/\s+/).length <= 3;
  if (opts.nameWasAsked && respostaCurta) {
    // Pergunta nao e nome. Caso real (Serra, 01/09/2026): a IA perguntou "como
    // posso te chamar?", a paciente respondeu "Vcs atendem planos de saude?" e
    // o cartao dela foi renomeado para "Vcs Atendem Planos 25/08/2026". O
    // paciente responder com outra pergunta e o normal, nao a excecao.
    if (cleaned.includes('?')) return null;
    // A rajada chega como uma mensagem só, uma por linha ("Olá bom dia\n\nLindalva"): o nome pode estar em qualquer uma.
    for (const linha of cleaned.split(/\n+/)) {
      const name = respostaQueEONome(linha);
      // Rígido: a palavra solta depois de "como posso te chamar?" é nome só com prova. Antes, qualquer uma virava título
      // ("Lomba", "Esim", "Canaense", "Nego Lindo", "Aonde Faca", "Td Bem").
      if (name && (!rigido || corrobora(name))) return name;
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
 */
function respostaQueEONome(resposta: string): string | null {
  const trecho = resposta.split(/[,.;:!]|\s[-–—]\s/)[0] ?? '';
  if (/\d/.test(trecho)) return null;
  const limpo = trecho.replace(/[^\p{L}\p{M}'\-\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return looksLikeName(limpo) ? limpo : null;
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
