/**
 * Placar de campanha de disparo (Outubro Rosa e as próximas): as contas puras.
 *
 * Quem coleta (coleta.ts) traz os dados crus do Kommo, do nosso banco e da franquia; aqui só se
 * decide o que é "respondeu", "pediu para sair", "agendou" e se soma. Nada aqui faz I/O, para dar
 * para testar com os casos reais da 1ª rodada (13–14/10/2026).
 */

export interface GrupoDeEtiqueta {
  /** Chave estável do grupo no banco, ex.: `rodada-1`, `dia-1`. */
  chave: string;
  /** Como aparece na página, ex.: `1ª rodada (13–14/10)`, `Dia 1`. */
  rotulo: string;
  ordem: number;
  /**
   * Avaliação com `idSchedule` acima deste número foi criada depois do envio. Só a 1ª rodada precisa: a lista
   * dela não conferiu a agenda antes. Os dias novos saem de quem não tinha avaliação marcada na escolha.
   */
  agendamentoAcimaDe?: number;
}

export interface RegraDeGrupo {
  padrao: RegExp;
  grupo: (m: RegExpMatchArray) => GrupoDeEtiqueta;
}

export function grupoDaEtiqueta(nome: string, regras: RegraDeGrupo[]): GrupoDeEtiqueta | null {
  for (const r of regras) {
    const m = nome.match(r.padrao);
    if (m) return r.grupo(m);
  }
  return null;
}

/** Nome em maiúsculas, sem acento, sem número e sem as partículas (de, da, dos…). */
export function tokensDoNome(nome: string | null | undefined): string[] {
  const s = (nome ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ');
  return s.split(/\s+/).filter((t) => t && !['DE', 'DA', 'DO', 'DOS', 'DAS', 'E'].includes(t));
}

/**
 * Os nomes são da mesma pessoa? `exato` quando todas as palavras batem; `parcial` quando o nome do Kommo
 * (às vezes só "Maria do Carmo") está inteiro dentro do da franquia. Parcial PRECISA ser confirmado pelo
 * telefone: em 15/10 "Maria do Carmo… Silva" bateu com outra Maria … Silva da mesma agenda.
 */
export function compararNomes(a: string | null | undefined, b: string | null | undefined): 'exato' | 'parcial' | null {
  const ta = tokensDoNome(a);
  const tb = tokensDoNome(b);
  if (ta.length === 0 || tb.length === 0) return null;
  if (ta.join(' ') === tb.join(' ')) return 'exato';
  const [menor, maior] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (menor.length < 2 || menor[0] !== maior[0]) return null;
  const resto = new Set(maior);
  return menor.every((t) => resto.has(t)) ? 'parcial' : null;
}

/** Os 8 últimos dígitos: o que atravessa "+55 99 9…", "(99) 9…" e o número sem o nono dígito. */
export function finalDoTelefone(tel: string | null | undefined): string | null {
  const d = (tel ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

/**
 * Pedido de descadastro. O rodapé do modelo diz "responda SAIR"; aceitamos também as variações que
 * aparecem em conversa. "Cancelar" sozinho NÃO conta: é o paciente cancelando consulta.
 */
export function pediuParaSair(texto: string | null | undefined): boolean {
  const t = (texto ?? '').trim();
  if (!t) return false;
  if (/^["'“]?\s*(sair|pare|parar|stop)\s*[.!]*\s*["'”]?$/i.test(t)) return true;
  return /(n[aã]o\s+(quero|desejo)\s+(mais\s+)?receber|me\s+(tira|tire|remova|retire)\s+d[ae]ss?a\s+lista|descadastr)/i.test(t);
}

export interface EventoDeChat {
  leadId: number;
  tipo: 'entrada' | 'saida';
  /** epoch em segundos */
  em: number;
  /** id do usuário do Kommo; 0 = robô, Sofia ou transmissão */
  por: number;
}

export interface MensagemGuardada {
  leadId: number;
  papel: 'user' | 'assistant' | 'system';
  texto: string;
  /** epoch em segundos */
  em: number;
}

export interface Conversa {
  /** Hora em que a mensagem da campanha saiu para este cartão (1ª saída depois do início do grupo). */
  enviadaEm: number | null;
  respondeuEm: number | null;
  /** Minutos até a 1ª resposta da Sofia depois da mensagem do paciente. */
  sofiaMin: number | null;
  /** Minutos até alguém da equipe escrever depois da mensagem do paciente. */
  equipeMin: number | null;
  saiu: boolean;
}

export function lerConversa(inicioDoGrupo: number, eventos: EventoDeChat[], mensagens: MensagemGuardada[]): Conversa {
  const evs = [...eventos].sort((a, b) => a.em - b.em);
  const envio = evs.find((e) => e.tipo === 'saida' && e.em >= inicioDoGrupo) ?? null;
  const vazia: Conversa = { enviadaEm: envio?.em ?? null, respondeuEm: null, sofiaMin: null, equipeMin: null, saiu: false };
  if (!envio) return vazia;
  const resposta = evs.find((e) => e.tipo === 'entrada' && e.em > envio.em) ?? null;
  if (!resposta) return vazia;
  const sofia = mensagens.filter((m) => m.papel === 'assistant' && m.em >= resposta.em).sort((a, b) => a.em - b.em)[0];
  const equipe = evs.find((e) => e.tipo === 'saida' && e.por > 0 && e.em >= resposta.em);
  const saiu = mensagens.some((m) => m.papel === 'user' && m.em >= envio.em && pediuParaSair(m.texto));
  const min = (t: number | undefined) => (t == null ? null : Math.max(0, Math.round((t - resposta.em) / 60)));
  return { enviadaEm: envio.em, respondeuEm: resposta.em, sofiaMin: min(sofia?.em), equipeMin: min(equipe?.em), saiu };
}

/**
 * Quem recebeu a transmissão, e quando. A API pública do Kommo não entrega o relatório da transmissão
 * (responde "This is a private API" ao token), mas cada envio deixa uma mensagem de saída no chat da pessoa.
 * Uma transmissão é uma RAJADA: vários cartões do grupo recebendo mensagem automática na mesma hora. Mensagem
 * avulsa da Sofia ou da recepção não forma rajada. Saída escrita por gente (`por` > 0) nunca conta.
 *
 * Rajada = pelo menos 3 cartões na mesma hora E 20% do grupo (bastam 8). Medido em 15/10: com 2, dois
 * cartões do Dia 1 — ainda não enviado — apareciam como "enviados" por causa da régua automática.
 *
 * Devolve, por cartão, a hora da 1ª mensagem dele que caiu numa hora de rajada.
 */
export function envioPorRajada(eventos: EventoDeChat[], desde: number, tamanhoDoGrupo: number): Map<number, number> {
  const minimo = Math.max(3, Math.min(8, Math.ceil(0.2 * tamanhoDoGrupo)));
  const saidas = eventos.filter((e) => e.tipo === 'saida' && e.por === 0 && e.em >= desde);
  const porHora = new Map<number, Set<number>>();
  for (const e of saidas) {
    const h = Math.floor(e.em / 3600);
    const set = porHora.get(h) ?? new Set<number>();
    set.add(e.leadId);
    porHora.set(h, set);
  }
  const rajadas = new Set([...porHora].filter(([, leads]) => leads.size >= minimo).map(([h]) => h));
  const out = new Map<number, number>();
  for (const e of [...saidas].sort((a, b) => a.em - b.em)) {
    if (!out.has(e.leadId) && rajadas.has(Math.floor(e.em / 3600))) out.set(e.leadId, e.em);
  }
  return out;
}

export interface AvaliacaoNaAgenda {
  idSchedule: number;
  nome: string;
  status: string;
  /** YYYY-MM-DD, dia local da consulta */
  dia: string;
}

export interface TratamentoNaFranquia {
  idClient: number | null;
  nome: string;
  preco: number;
  /** YYYY-MM-DD */
  criado: string;
}

/** Agendou = avaliação nova, não desmarcada; compareceu = ATENDIDO. */
export function situacaoDaAvaliacao(status: string): { agendou: boolean; compareceu: boolean } {
  const s = status.toUpperCase();
  return { agendou: !s.includes('DESMARC'), compareceu: s.includes('ATENDIDO') };
}

/**
 * O que a agenda diz desta pessoa depois do envio. Remarcar cria um agendamento NOVO na franquia, então o
 * corte por número sozinho contaria remarcação como resultado (Helena, Açailândia, 15/10: tinha avaliação
 * em 15/10, criada antes do envio, e remarcou para 16/10). Quem já tinha avaliação marcada para depois do
 * envio, criada antes do corte, fica como `jaTinha` e não conta. Os dias novos não têm corte: a escolha já
 * tirou quem tinha avaliação marcada.
 */
export function resultadoNaAgenda(
  daPessoa: AvaliacaoNaAgenda[],
  grupo: GrupoDeEtiqueta,
  diaDoEnvio: string,
): { agendou: boolean; compareceu: boolean; jaTinha: boolean } {
  const depois = daPessoa.filter((a) => a.dia >= diaDoEnvio);
  const corte = grupo.agendamentoAcimaDe;
  if (corte != null && depois.some((a) => a.idSchedule <= corte)) return { agendou: false, compareceu: false, jaTinha: true };
  const novas = depois.filter((a) => corte == null || a.idSchedule > corte);
  return {
    agendou: novas.some((a) => situacaoDaAvaliacao(a.status).agendou),
    compareceu: novas.some((a) => situacaoDaAvaliacao(a.status).compareceu),
    jaTinha: false,
  };
}

export interface Placar {
  naTransmissao: number;
  enviadas: number | null;
  entregues: number | null;
  lidas: number | null;
  falhas: number | null;
  custoUsd: number | null;
  responderam: number;
  sairam: number;
  agendaram: number;
  compareceram: number;
  tratamentos: number;
  receita: number;
  /** Mediana dos minutos até a Sofia responder; null sem resposta. */
  sofiaMinMediana: number | null;
  /** Em quantas conversas respondidas alguém da equipe escreveu. */
  equipeEntrou: number;
  equipeMinMediana: number | null;
}

export function mediana(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

export interface Transmissao {
  tagIds: number[];
  enviadas: number;
  entregues: number;
  lidas: number;
  respondidas: number;
  falhas: number;
  custoUsd: number;
}

/** Soma as transmissões cujo segmento usa alguma etiqueta do grupo. null quando o Kommo não deixou ler. */
export function somarTransmissoes(trans: Transmissao[] | null, tagIdsDoGrupo: number[]): Pick<Placar, 'enviadas' | 'entregues' | 'lidas' | 'falhas' | 'custoUsd'> & { respondidasKommo: number | null } {
  if (!trans) return { enviadas: null, entregues: null, lidas: null, falhas: null, custoUsd: null, respondidasKommo: null };
  const alvo = new Set(tagIdsDoGrupo);
  const doGrupo = trans.filter((t) => t.tagIds.some((id) => alvo.has(id)));
  const soma = (k: keyof Transmissao) => doGrupo.reduce((s, t) => s + (t[k] as number), 0);
  return {
    enviadas: soma('enviadas'),
    entregues: soma('entregues'),
    lidas: soma('lidas'),
    falhas: soma('falhas'),
    custoUsd: Math.round(soma('custoUsd') * 10000) / 10000,
    respondidasKommo: soma('respondidas'),
  };
}
