/**
 * Menu de suporte no WhatsApp — a MÁQUINA DE ESTADOS (pura: sem banco, sem rede, sem relógio próprio).
 *
 * A equipe da clínica escreve para o número do agente de suporte e este menu conduz a conversa com TEXTO FIXO, sem IA:
 *   1. "Você faz parte da equipe?"  2. quem é (o número é procurado nos grupos "Mkt | Dr Hérnia <unidade>" do WhatsApp; se não
 *   achar, nome + unidade por texto)  3. o que está acontecendo (7 opções)  4. detalhes  5. protocolo.
 * Como nenhuma etapa usa IA nem interpreta o texto da pessoa como comando, ninguém consegue "dar ordem" ao agente por
 * aqui: o que a pessoa escreve é só DADO que vai para o cartão do Telegram do João.
 *
 * Quem executa os efeitos (gravar, enviar, abrir a demanda) é `suporte-menu.ts`. Esta função só decide o próximo passo.
 */

export type Passo =
  | 'inicio'
  | 'equipe'
  | 'identificacao'
  | 'confirma-unidade'
  | 'categoria'
  | 'detalhes'
  | 'aberta'
  | 'encerrada'
  /** o painel marcou a demanda como resolvida e perguntou se funcionou (1 sim / 2 não) */
  | 'resolvida'
  /** a pessoa confirmou que funcionou: silêncio por um tempo (um "obrigada" não reabre o menu) */
  | 'concluida';

export type Verificacao = 'grupo' | 'texto' | 'nenhuma';

export interface UnidadeBasica {
  slug: string;
  nome: string;
}

export interface Estado {
  passo: Passo;
  /** respostas inválidas seguidas no passo atual */
  tentativas: number;
  /** o que a pessoa escreveu como identificação (livre, cortado em 120) */
  nome: string | null;
  /** unidade achada pelo texto: candidata no passo `confirma-unidade`, confirmada depois */
  unidade: UnidadeBasica | null;
  /** como a identidade foi estabelecida: `grupo` = o número está no grupo de Marketing da unidade (verificado);
   *  `texto` = a pessoa disse a unidade e confirmou (NÃO verificado); `nenhuma` = sem unidade */
  verificacao: Verificacao;
  categoria: number | null;
  protocolo: number | null;
  /** última vez que o estado mudou (para expirar a conversa parada) */
  atualizadoEm: Date | null;
  /** última vez que mandamos "sua demanda está em análise" (no máx. 1 a cada 30 min) */
  avisouEm: Date | null;
}

export const ESTADO_VAZIO: Estado = {
  passo: 'inicio',
  tentativas: 0,
  nome: null,
  unidade: null,
  verificacao: 'nenhuma',
  categoria: null,
  protocolo: null,
  atualizadoEm: null,
  avisouEm: null,
};

export interface Entrada {
  /** texto da mensagem (legenda, se for imagem); vazio se não houver texto */
  texto: string;
  /** true = a mensagem não trouxe texto (áudio, imagem sem legenda, figurinha…) */
  semTexto: boolean;
  tipoMidia?: 'audio' | 'imagem' | 'outro' | null;
}

export interface Abrir {
  categoria: number;
  categoriaNome: string;
  relato: string;
  nome: string | null;
  unidade: UnidadeBasica | null;
  verificacao: Verificacao;
  /** em quantos grupos de Marketing o número foi visto (consultoria e agência aparecem em vários) */
  gruposVistos: number;
}

export interface Resultado {
  estado: Estado;
  /** textos a enviar, em ordem; `{protocolo}` é trocado pelo número da demanda depois que ela é aberta */
  respostas: string[];
  /** quando preenchido, o chamador abre a demanda e manda o cartão ao Telegram */
  abrir?: Abrir;
  /** true = nada a responder (conversa encerrada, repetição) */
  silencio: boolean;
  /** true = a conversa começou do zero agora (conta para o limite de conversas novas por hora) */
  nova: boolean;
  /** a pessoa disse que AINDA NÃO funcionou: o chamador reabre esta demanda e avisa a equipe */
  reabrir?: number;
}

export const MARCA_PROTOCOLO = '{protocolo}';

export const CATEGORIAS: Readonly<Record<number, string>> = {
  1: 'A Sofia (IA) respondeu errado ou não respondeu',
  2: 'Problema no Kommo (cartão, etapa, campo ou etiqueta)',
  3: 'Um robô ou automação não disparou ou disparou errado',
  4: 'Agenda ou franquia (horário, paciente, situação da consulta)',
  5: 'Caixa ou boleto',
  6: 'Dashboard ou relatório com número errado',
  7: 'Outro',
};

export const TEXTOS = {
  boasVindas:
    'Oi! Sou o assistente de suporte da Doutor Digital. Você faz parte da equipe Doutor Hérnia?\n\nResponda:\n1 - Sim\n2 - Não',
  naoEquipe: 'Obrigado pelo contato! Este canal é só para a equipe da clínica. Para atendimento de paciente, fale com a sua clínica.',
  reconhecidoPeloGrupo: (nome: string | null, unidade: string) =>
    `${nome ? `Oi, ${nome}! ` : ''}Vi o seu número no grupo de Marketing da unidade ${unidade}.\n\n`,
  pedeIdentificacao: 'Qual o seu nome e a unidade onde você trabalha? Exemplo: Maria, Timbó.',
  refazIdentificacao: 'Tudo bem. Escreva de novo o seu nome e a unidade.',
  menu:
    'O que está acontecendo?\n\n' +
    Object.entries(CATEGORIAS)
      .map(([n, t]) => `${n} - ${t}`)
      .join('\n') +
    '\n\nResponda com o número.',
  pedeDetalhes:
    'Me conta em uma frase o que aconteceu. Se puder, escreva o nome do paciente ou o link do cartão. Se tiver um print, descreva o que aparece nele.',
  semTextoPedeDetalhes: 'Não consegui ler esse arquivo. Pode escrever em uma frase o que aconteceu?',
  protocolo: `Recebi, protocolo ${MARCA_PROTOCOLO}. Estou analisando e te aviso aqui.`,
  chamaPessoa: `Não entendi. Vou chamar uma pessoa para te ajudar. Protocolo ${MARCA_PROTOCOLO}.`,
  confirmaUnidade: (nome: string) => `Encontrei a unidade ${nome}. Está certo?\n\n1 - Sim\n2 - Não`,
  repeteSimNao: 'Não entendi. Responda 1 para Sim ou 2 para Não.',
  repeteMenu: 'Não entendi. Responda com um número de 1 a 7.',
  repeteIdentificacao: 'Não entendi. Escreva o seu nome e a unidade. Exemplo: Maria, Timbó.',
  emAnalise: (n: number) => `Sua demanda ${n} está em análise. Se for outro assunto, envie 0 para recomeçar.`,
  /** o que o painel manda quando marca a demanda como resolvida (a nota, se houver, é de quem resolveu: João/Suzanne) */
  resolvida: (n: number, nota: string | null) =>
    `Sua demanda ${n} foi resolvida. ✅${nota ? `\n\n${nota}` : ''}\n\nPode testar? Responda 1 se funcionou ou 2 se ainda não.`,
  funcionou: 'Que bom! Obrigado por avisar. Se precisar de novo, é só mandar uma mensagem aqui. 💙',
  reaberta: (n: number) => `Entendi. Reabri a demanda ${n} e avisei a equipe. Te aviso aqui de novo quando estiver resolvido.`,
  repeteResolvida: 'Não entendi. Responda 1 se funcionou ou 2 se ainda não.',
} as const;

/** Minutos parada até a conversa voltar ao começo (passos do menu). */
export const EXPIRA_MENU_MIN = 30;
/** Demanda aberta: depois disto a próxima mensagem começa um menu novo. */
export const EXPIRA_ABERTA_H = 12;
/** Quem respondeu "Não": silêncio até isto (não responde de novo para não virar spam). */
export const EXPIRA_ENCERRADA_H = 24;
/** Resolvida esperando o "funcionou?": depois disto a próxima mensagem começa um menu novo. */
export const EXPIRA_RESOLVIDA_H = 72;
/** Confirmou que funcionou: silêncio por este tempo. */
export const EXPIRA_CONCLUIDA_H = 12;
/** O aviso "em análise" sai no máximo uma vez por este intervalo. */
export const INTERVALO_AVISO_MIN = 30;
/** Respostas inválidas seguidas antes de chamar uma pessoa. */
export const MAX_TENTATIVAS = 2;

const MAX_NOME = 120;
const MAX_RELATO = 1000;

const MIN = 60_000;
const H = 60 * MIN;

/** minúsculas, sem acento, espaços colapsados */
export function normalizar(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tira caracteres de controle e corta: o texto do usuário vira DADO, nunca formatação. */
export function limparTexto(texto: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(texto ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function simOuNao(texto: string): 'sim' | 'nao' | null {
  const t = normalizar(texto).replace(/[.!?,;:]+$/g, '');
  if (/^(1|sim|s|sou|faco|claro|isso|correto|certo|ok)$/.test(t)) return 'sim';
  if (/^(2|nao|n|nao sou|errado|incorreto)$/.test(t)) return 'nao';
  return null;
}

/** Resposta ao "funcionou?": aceita 1/2 e também o jeito comum de falar ("deu certo", "ainda não", "continua o erro"). */
export function funcionouOuNao(texto: string): 'sim' | 'nao' | null {
  const t = normalizar(texto).replace(/[.!?,;:]+$/g, '');
  if (/\b(nao funcionou|ainda nao|continua|nao resolveu|nao deu|mesmo erro|persiste|piorou)\b/.test(t)) return 'nao';
  const s = simOuNao(t);
  if (s) return s;
  if (/^(funcionou|deu certo|resolveu|resolvido|tudo certo|agora foi|foi sim|show|perfeito|obrigad[ao])\b/.test(t)) return 'sim';
  return null;
}

export function categoriaEscolhida(texto: string): number | null {
  const m = /^([1-7])(?:\s|[.)\-:]|$)/.exec(normalizar(texto));
  return m ? Number(m[1]) : null;
}

const PALAVRAS_GENERICAS = new Set(['doutor', 'dr', 'dra', 'hernia', 'instituto', 'clinica', 'unidade', 'de', 'da', 'do', 'das', 'dos', 'e']);

function palavrasDistintas(unidade: UnidadeBasica): string[] {
  const separar = (t: string) => normalizar(t).split(/[^a-z0-9]+/).filter((p) => p.length >= 3 && !PALAVRAS_GENERICAS.has(p));
  const doNome = separar(unidade.nome);
  // o nome manda; o slug só entra se o nome não tiver palavra própria (slug como "rioverde" nunca apareceria no texto)
  return [...new Set(doNome.length ? doNome : separar(unidade.slug))];
}

/**
 * A unidade citada no texto ("Maria, Timbó"). Quando duas batem ("Rio Verde" e "Lucas do Rio Verde" num texto que cita a
 * segunda), vale a mais específica (a que casou mais palavras); empate = não achou. A identificação é contexto, nunca prova.
 */
export function acharUnidade(texto: string, unidades: readonly UnidadeBasica[]): UnidadeBasica | null {
  const palavras = new Set(normalizar(texto).split(/[^a-z0-9]+/).filter(Boolean));
  const achadas = unidades
    .map((u) => ({ u, n: palavrasDistintas(u) }))
    .filter(({ n }) => n.length > 0 && n.every((p) => palavras.has(p)));
  if (!achadas.length) return null;
  const maior = achadas.reduce((a, b) => (b.n.length > a.n.length ? b : a));
  // só vale a mais específica quando as outras são "pedaços" dela (Rio Verde dentro de Lucas do Rio Verde); duas unidades
  // diferentes citadas no mesmo texto = ambíguo
  const todasContidas = achadas.every(({ n }) => n.every((p) => maior.n.includes(p)));
  const empate = achadas.filter(({ n }) => n.length === maior.n.length).length > 1;
  return todasContidas && !empate ? maior.u : null;
}

/**
 * TODAS as unidades citadas num texto ("Tatuí, Boa Vista e Salto"), sem as que são pedaço de outra citada (Rio Verde dentro de
 * Lucas do Rio Verde). No máximo `max`.
 */
export function unidadesCitadas(texto: string, unidades: readonly UnidadeBasica[], max = 5): UnidadeBasica[] {
  const palavras = new Set(normalizar(texto).split(/[^a-z0-9]+/).filter(Boolean));
  const achadas = unidades
    .map((u) => ({ u, n: palavrasDistintas(u) }))
    .filter(({ n }) => n.length > 0 && n.every((p) => palavras.has(p)));
  const fora = achadas.filter((a) => achadas.some((b) => b !== a && b.n.length > a.n.length && a.n.every((p) => b.n.includes(p))));
  return achadas.filter((a) => !fora.includes(a)).slice(0, max).map(({ u }) => u);
}

export interface Contexto {
  agora: Date;
  unidades: readonly UnidadeBasica[];
  /** unidades cujo grupo "Mkt | Dr Hérnia …" tem o número de quem escreveu (vazio = não achou ou o índice ainda não carregou) */
  unidadesDoGrupo: readonly UnidadeBasica[];
  /** nome do perfil do WhatsApp de quem escreve (só contexto; qualquer um pode pôr o nome que quiser) */
  nomePerfil: string | null;
}

function expirou(e: Estado, agora: Date): boolean {
  if (!e.atualizadoEm) return e.passo !== 'inicio';
  const parado = agora.getTime() - e.atualizadoEm.getTime();
  if (e.passo === 'aberta') return parado > EXPIRA_ABERTA_H * H;
  if (e.passo === 'encerrada') return parado > EXPIRA_ENCERRADA_H * H;
  if (e.passo === 'resolvida') return parado > EXPIRA_RESOLVIDA_H * H;
  if (e.passo === 'concluida') return parado > EXPIRA_CONCLUIDA_H * H;
  if (e.passo === 'inicio') return false;
  return parado > EXPIRA_MENU_MIN * MIN;
}

function comoNova(agora: Date): Resultado {
  return {
    estado: { ...ESTADO_VAZIO, passo: 'equipe', atualizadoEm: agora },
    respostas: [TEXTOS.boasVindas],
    silencio: false,
    nova: true,
  };
}

function relatoDaEntrada(e: Entrada): string {
  const texto = limparTexto(e.texto, MAX_RELATO);
  if (texto) return texto;
  if (e.tipoMidia === 'audio') return '[áudio recebido, sem transcrição]';
  if (e.tipoMidia === 'imagem') return '[imagem recebida, sem legenda]';
  return '[arquivo recebido, sem texto]';
}

function abrirDemanda(e: Estado, categoria: number, relato: string, ctx: Contexto): Resultado {
  const agora = ctx.agora;
  return {
    estado: { ...e, passo: 'aberta', tentativas: 0, categoria, atualizadoEm: agora, avisouEm: agora },
    respostas: [TEXTOS.protocolo],
    abrir: {
      categoria,
      categoriaNome: CATEGORIAS[categoria] ?? CATEGORIAS[7]!,
      relato,
      nome: e.nome,
      unidade: e.unidade,
      verificacao: e.verificacao,
      gruposVistos: ctx.unidadesDoGrupo.length,
    },
    silencio: false,
    nova: false,
  };
}

/** Repete a pergunta; na 2ª resposta inválida seguida, chama uma pessoa (abre a demanda "Outro" com o que houver). */
function invalida(e: Estado, entrada: Entrada, ctx: Contexto, repete: string): Resultado {
  const tentativas = e.tentativas + 1;
  if (tentativas >= MAX_TENTATIVAS) {
    const relato = `(não respondeu o menu no passo "${e.passo}") ${relatoDaEntrada(entrada)}`.slice(0, MAX_RELATO);
    const r = abrirDemanda(e, 7, relato, ctx);
    return { ...r, respostas: [TEXTOS.chamaPessoa] };
  }
  return { estado: { ...e, tentativas, atualizadoEm: ctx.agora }, respostas: [repete], silencio: false, nova: false };
}

/**
 * Dado o estado da conversa e a mensagem que chegou, devolve o novo estado, o que responder e, quando for o caso,
 * a demanda a abrir. Nunca lança.
 */
export function avancar(estadoAtual: Estado, entrada: Entrada, ctx: Contexto): Resultado {
  const { agora } = ctx;
  const texto = entrada.texto ?? '';
  const t = normalizar(texto);

  // "0" recomeça de qualquer ponto
  if (t === '0') return comoNova(agora);

  // conversa parada há tempo demais volta ao começo (e esta mensagem já recebe as boas-vindas)
  if (expirou(estadoAtual, agora)) return comoNova(agora);

  const e = estadoAtual;

  switch (e.passo) {
    case 'inicio':
      return comoNova(agora);

    case 'encerrada':
    case 'concluida':
      // disse "Não" (ou já confirmou que funcionou): fica em silêncio até expirar (ou até mandar 0)
      return { estado: e, respostas: [], silencio: true, nova: false };

    case 'resolvida': {
      const r = funcionouOuNao(texto);
      if (r === 'sim') {
        return { estado: { ...e, passo: 'concluida', tentativas: 0, atualizadoEm: agora }, respostas: [TEXTOS.funcionou], silencio: false, nova: false };
      }
      if (r === 'nao' && e.protocolo != null) {
        return {
          estado: { ...e, passo: 'aberta', tentativas: 0, atualizadoEm: agora, avisouEm: agora },
          respostas: [TEXTOS.reaberta(e.protocolo)],
          silencio: false,
          nova: false,
          reabrir: e.protocolo,
        };
      }
      // aqui a resposta inválida NÃO abre demanda nova: repete uma vez e depois fica quieto
      if (e.tentativas >= 1) return { estado: e, respostas: [], silencio: true, nova: false };
      return { estado: { ...e, tentativas: 1, atualizadoEm: agora }, respostas: [TEXTOS.repeteResolvida], silencio: false, nova: false };
    }

    case 'aberta': {
      const aviso = e.avisouEm ? agora.getTime() - e.avisouEm.getTime() : Infinity;
      if (aviso < INTERVALO_AVISO_MIN * MIN || e.protocolo == null) return { estado: e, respostas: [], silencio: true, nova: false };
      return {
        estado: { ...e, avisouEm: agora },
        respostas: [TEXTOS.emAnalise(e.protocolo)],
        silencio: false,
        nova: false,
      };
    }

    case 'equipe': {
      const r = simOuNao(texto);
      if (r === 'sim') {
        // o número está no grupo de Marketing de UMA unidade: identificado, pula a pergunta de nome e unidade
        if (ctx.unidadesDoGrupo.length === 1) {
          const unidade = ctx.unidadesDoGrupo[0]!;
          const nome = ctx.nomePerfil ? limparTexto(ctx.nomePerfil, MAX_NOME) : null;
          const primeiro = nome ? (nome.split(/\s+/)[0] ?? null) : null;
          return {
            estado: { ...e, passo: 'categoria', tentativas: 0, nome, unidade, verificacao: 'grupo', atualizadoEm: agora },
            respostas: [TEXTOS.reconhecidoPeloGrupo(primeiro, unidade.nome) + TEXTOS.menu],
            silencio: false,
            nova: false,
          };
        }
        return {
          estado: { ...e, passo: 'identificacao', tentativas: 0, atualizadoEm: agora },
          respostas: [TEXTOS.pedeIdentificacao],
          silencio: false,
          nova: false,
        };
      }
      if (r === 'nao') {
        return { estado: { ...e, passo: 'encerrada', tentativas: 0, atualizadoEm: agora }, respostas: [TEXTOS.naoEquipe], silencio: false, nova: false };
      }
      return invalida(e, entrada, ctx, TEXTOS.repeteSimNao);
    }

    case 'identificacao': {
      const declarado = limparTexto(texto, MAX_NOME);
      if (entrada.semTexto || declarado.length < 3) return invalida(e, entrada, ctx, TEXTOS.repeteIdentificacao);
      const unidade = acharUnidade(declarado, ctx.unidades);
      if (unidade) {
        return {
          estado: { ...e, passo: 'confirma-unidade', tentativas: 0, nome: declarado, unidade, verificacao: 'nenhuma', atualizadoEm: agora },
          respostas: [TEXTOS.confirmaUnidade(unidade.nome)],
          silencio: false,
          nova: false,
        };
      }
      return {
        estado: { ...e, passo: 'categoria', tentativas: 0, nome: declarado, unidade: null, verificacao: 'nenhuma', atualizadoEm: agora },
        respostas: [TEXTOS.menu],
        silencio: false,
        nova: false,
      };
    }

    case 'confirma-unidade': {
      const r = simOuNao(texto);
      if (r === 'sim') {
        return {
          estado: { ...e, passo: 'categoria', tentativas: 0, verificacao: 'texto', atualizadoEm: agora },
          respostas: [TEXTOS.menu],
          silencio: false,
          nova: false,
        };
      }
      if (r === 'nao') {
        return {
          estado: { ...e, passo: 'identificacao', tentativas: 0, nome: null, unidade: null, verificacao: 'nenhuma', atualizadoEm: agora },
          respostas: [TEXTOS.refazIdentificacao],
          silencio: false,
          nova: false,
        };
      }
      return invalida(e, entrada, ctx, TEXTOS.repeteSimNao);
    }

    case 'categoria': {
      const c = categoriaEscolhida(texto);
      if (c == null) return invalida(e, entrada, ctx, TEXTOS.repeteMenu);
      return {
        estado: { ...e, passo: 'detalhes', tentativas: 0, categoria: c, atualizadoEm: agora },
        respostas: [TEXTOS.pedeDetalhes],
        silencio: false,
        nova: false,
      };
    }

    case 'detalhes': {
      // arquivo sem texto: pede o texto UMA vez; na segunda, abre a demanda com o aviso de que veio só o arquivo
      if (entrada.semTexto && e.tentativas === 0) {
        return { estado: { ...e, tentativas: 1, atualizadoEm: agora }, respostas: [TEXTOS.semTextoPedeDetalhes], silencio: false, nova: false };
      }
      return abrirDemanda(e, e.categoria ?? 7, relatoDaEntrada(entrada), ctx);
    }
  }
}
