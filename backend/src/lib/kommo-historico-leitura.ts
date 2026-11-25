/**
 * Leitura da Kommo para o histórico do CRM: QUAIS cartões entram (escopo B do João, 25/11/2026), o contato de cada um e a conversa. Só leitura.
 * A decisão de como cada cartão vira dado do CRM mora em `kommo-historico-crm.ts`; aqui só se lê, com a Kommo atrás de uma porta (o teste usa
 * uma Kommo de mentira).
 *
 * Escopo B: TODOS os cartões ABERTOS (todas as etapas, Comercial e Tratamento) + os GANHOS e PERDIDOS fechados nos últimos 6 meses.
 *
 * Duas regras de honestidade: página que falha LANÇA (página vazia quer dizer «acabou», nunca «deu erro»), e o teto de páginas também lança
 * (leitura pela metade nunca vira «importado»). Conversa que a Kommo não entrega (conta sem escopo de chats) vira «sem conversa», contada.
 */
import type { KommoLead, KommoPipeline, KommoTalk, KommoTalkMessage } from '../services/kommo.service.js';
import { atributosDoCartao, linhaDoCartao, type CartaoDaKommo, type ContatoDaKommo, type LinhaDoCartao, type MensagemDaKommo, foneParaWhatsApp } from './kommo-historico-crm.js';

export const MESES_DOS_FECHADOS = 6;
export const POR_PAGINA = 250;
export const MAX_PAGINAS = 100;
export const MAX_TALKS_POR_CARTAO = 5;
/** quantas conversas o SECO lê de verdade para medir mensagens e tempo */
export const AMOSTRA_DO_SECO = 30;
const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;

export interface PortaKommo {
  listPipelines(): Promise<KommoPipeline[]>;
  listLossReasons(): Promise<Array<{ id: number; name: string }>>;
  listUsers(): Promise<Array<{ id: number; name: string }>>;
  listLeadsAbertosPagina(etapas: ReadonlyArray<{ pipelineId: number; statusId: number }>, page?: number): Promise<KommoLead[]>;
  /** cartões destas etapas mexidos desde a data, ordenados por ID (estável: editar um cartão no meio da leitura não muda a posição, ao contrário de `updated_at`) */
  listLeadsDasEtapasPorId(etapas: ReadonlyArray<{ pipelineId: number; statusId: number }>, desdeEpochSeg: number, page?: number): Promise<KommoLead[]>;
  listLeadsPorIds(ids: number[], opcoes?: { contatos?: boolean }): Promise<KommoLead[]>;
  contatosBasicos(ids: number[]): Promise<Map<number, { nome: string | null; telefone: string | null }>>;
  listTalks(leadId: number): Promise<KommoTalk[]>;
  listTalkMessages(talkId: number, limit?: number, page?: number): Promise<KommoTalkMessage[]>;
}

export interface Ambiente {
  porta: PortaKommo;
  pausa: (ms: number) => Promise<void>;
  agora: () => Date;
  /** só dado agregado: sem nome, telefone nem texto */
  log: (texto: string) => void;
}

/** Hoje − 6 meses (calendário), em segundos. */
export function inicioDosFechados(agora: Date, meses = MESES_DOS_FECHADOS): number {
  // o dia fica limitado ao último dia do mês de destino (31/08 − 6 meses = 28/02, e não 03/03)
  const alvoMes = agora.getUTCMonth() - meses;
  const ultimoDia = new Date(Date.UTC(agora.getUTCFullYear(), alvoMes + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(agora.getUTCFullYear(), alvoMes, Math.min(agora.getUTCDate(), ultimoDia), agora.getUTCHours(), agora.getUTCMinutes(), agora.getUTCSeconds()));
  return Math.floor(d.getTime() / 1000);
}

export interface Selecao {
  cartoes: CartaoDaKommo[];
  /** lead → contato principal */
  contatos: Map<number, ContatoDaKommo>;
  /** quantos fechados ficaram de fora por serem mais velhos que a janela */
  fechadosForaDaJanela: number;
}

function valorDoCampoDaKommo(f: { field_type?: string; values: Array<{ value: unknown }> }): unknown {
  const vs = (f.values ?? []).map((v) => v.value).filter((v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === ''));
  if (f.field_type === 'multiselect') return vs;
  return vs[0];
}

export function cartaoDoLead(l: KommoLead, pipelines: ReadonlyMap<number, KommoPipeline>, motivos: ReadonlyMap<number, string>, usuarios: ReadonlyMap<number, string>): CartaoDaKommo | null {
  const funil = pipelines.get(l.pipeline_id);
  const status = funil?.statuses.find((s) => s.id === l.status_id);
  if (!funil || !status) return null;
  return {
    id: l.id,
    nome: l.name ?? '',
    funil: funil.name,
    etapa: status.name,
    statusId: l.status_id,
    preco: Number(l.price) || 0,
    criadoEm: Number(l.created_at) || 0,
    atualizadoEm: Number(l.updated_at) || 0,
    fechadoEm: l.closed_at ? Number(l.closed_at) : null,
    responsavel: l.responsible_user_id ? usuarios.get(l.responsible_user_id) ?? null : null,
    motivoPerda: l.loss_reason_id ? motivos.get(l.loss_reason_id) ?? null : null,
    etiquetas: (l._embedded?.tags ?? []).map((t) => t.name),
    campos: (l.custom_fields_values ?? []).map((f) => ({ nome: f.field_name ?? '', tipo: f.field_type ?? '', valor: valorDoCampoDaKommo(f) })),
  };
}

/** Todas as páginas de uma consulta paginada; LANÇA se passar do teto (ainda vinha página cheia). */
async function todasAsPaginas(ler: (page: number) => Promise<KommoLead[]>, pausa: Ambiente['pausa'], rotulo: string): Promise<KommoLead[]> {
  const todos: KommoLead[] = [];
  for (let p = 1; ; p++) {
    if (p > MAX_PAGINAS) throw new Error(`${rotulo} passou de ${MAX_PAGINAS} páginas: leitura incompleta`);
    const lote = await ler(p);
    todos.push(...lote);
    if (lote.length < POR_PAGINA) return todos;
    await pausa(250);
  }
}

export async function lerSelecao(amb: Ambiente): Promise<Selecao> {
  const { porta, pausa } = amb;
  const pipelines = await porta.listPipelines();
  const porId = new Map(pipelines.map((p) => [p.id, p]));
  const motivos = new Map((await porta.listLossReasons()).map((m) => [m.id, m.name]));
  const usuarios = new Map((await porta.listUsers()).map((u) => [u.id, u.name]));

  const abertas = pipelines.flatMap((p) => p.statuses.filter((s) => s.id !== STATUS_GANHO && s.id !== STATUS_PERDIDO).map((s) => ({ pipelineId: p.id, statusId: s.id })));
  const fechadas = pipelines.flatMap((p) => [STATUS_GANHO, STATUS_PERDIDO].filter((id) => p.statuses.some((s) => s.id === id)).map((statusId) => ({ pipelineId: p.id, statusId })));

  const leads = new Map<number, KommoLead>();
  for (const l of await todasAsPaginas((p) => porta.listLeadsAbertosPagina(abertas, p), pausa, 'cartões abertos')) leads.set(l.id, l);
  const desde = inicioDosFechados(amb.agora());
  let fora = 0;
  // fechados: o filtro de data vai para a Kommo (`updated_at` ≥ início da janela é sempre um superconjunto de `closed_at` ≥ início: quem fechou na
  // janela foi mexido depois), a ordem é por ID (estável) e o que vale é QUANDO fechou (`closed_at`), conferido aqui
  if (fechadas.length) {
    for (const l of await todasAsPaginas((p) => porta.listLeadsDasEtapasPorId(fechadas, desde, p), pausa, 'cartões fechados')) {
      if ((Number(l.closed_at) || 0) >= desde) leads.set(l.id, l);
      else fora++;
    }
  }

  const ordenados = [...leads.values()].sort((a, b) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0) || b.id - a.id);

  // contato principal de cada cartão (a lista não traz o vínculo): em lotes de 50
  const contatoDoLead = new Map<number, number>();
  const ids = ordenados.map((l) => l.id);
  for (let i = 0; i < ids.length; i += 50) {
    await pausa(250);
    for (const l of await porta.listLeadsPorIds(ids.slice(i, i + 50), { contatos: true })) {
      const cs = l._embedded?.contacts ?? [];
      const principal = cs.find((c) => c.is_main) ?? cs[0];
      if (principal) contatoDoLead.set(l.id, principal.id);
    }
  }
  await pausa(250);
  const basicos = await porta.contatosBasicos([...new Set(contatoDoLead.values())]);

  const cartoes: CartaoDaKommo[] = [];
  const contatos = new Map<number, ContatoDaKommo>();
  for (const l of ordenados) {
    const c = cartaoDoLead(l, porId, motivos, usuarios);
    if (!c) continue;
    cartoes.push(c);
    const cid = contatoDoLead.get(l.id);
    const b = cid ? basicos.get(cid) : undefined;
    if (cid) contatos.set(l.id, { id: cid, nome: b?.nome ?? null, telefone: b?.telefone ?? null });
  }
  return { cartoes, contatos, fechadosForaDaJanela: fora };
}

/** O erro da Kommo que quer dizer «esta conta/cartão/conversa não tem o que entregar» (sem escopo de chats, ou sem conversa). */
const semConversaNaKommo = (e: unknown): boolean => [403, 404].includes(Number((e as { status?: number })?.status));

/** Repete 3 vezes (espera crescente, mais longa para o 429) e, se persistir, SOBE o erro. */
async function comTentativas<T>(amb: Ambiente, fazer: () => Promise<T>): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await fazer();
    } catch (e) {
      if (semConversaNaKommo(e) || tentativa >= 3) throw e;
      await amb.pausa((Number((e as { status?: number })?.status) === 429 ? 10_000 : 2_000) * tentativa);
    }
  }
}

/**
 * A conversa de um cartão: as conversas mais recentes primeiro (até MAX_TALKS_POR_CARTAO), mensagens de cada uma. 403/404 numa conversa a pula e
 * mantém as que já foram lidas; `null` = nenhuma conversa a entregar. Qualquer OUTRO erro (429, 5xx, rede) é repetido e, se persistir, SOBE
 * (`exportar` conta como «falha de leitura»): cartão sem mensagem porque a Kommo engasgou não pode virar «nenhuma mensagem».
 */
export async function lerConversa(amb: Ambiente, leadId: number): Promise<MensagemDaKommo[] | null> {
  const { porta, pausa } = amb;
  let talks: KommoTalk[];
  try {
    talks = await comTentativas(amb, () => porta.listTalks(leadId));
  } catch (e) {
    if (semConversaNaKommo(e)) return null;
    throw e;
  }
  const maisRecentes = [...talks].sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0)).slice(0, MAX_TALKS_POR_CARTAO);
  const todas: MensagemDaKommo[] = [];
  let leu = false;
  for (const t of maisRecentes) {
    await pausa(250);
    try {
      todas.push(...(await comTentativas(amb, () => porta.listTalkMessages(Number(t.talk_id), 100))));
      leu = true;
    } catch (e) {
      if (!semConversaNaKommo(e)) throw e;
    }
  }
  return maisRecentes.length && !leu ? null : todas;
}

/** Falhas de leitura SEGUIDAS que fazem a exportação parar (a Kommo está fora do ar: não adianta seguir). */
export const FALHAS_SEGUIDAS_MAX = 10;

// ── o relatório (só agregados) ───────────────────────────────────────────────────────────────────────

export interface Relatorio {
  cartoes: number;
  abertos: number;
  fechados: number;
  fechadosForaDaJanela: number;
  porEtapa: Record<string, number>;
  semTelefone: number;
  telefoneInvalido: number;
  semContato: number;
  telefonesDistintos: number;
  /** telefones que aparecem em mais de um cartão (viram UM contato com várias conversas) */
  telefonesRepetidos: number;
  semConversa: number;
  /** a Kommo engasgou (429/5xx) e a conversa NÃO foi lida: o cartão sai com a nota «não entregou» */
  falhasDeLeitura: number;
  mensagens: number;
  cartoesComMensagem: number;
  /** o seco só lê esta amostra de conversas */
  amostra: number;
  mensagensEstimadas: number;
  segundosPorCartao: number;
  duracaoEstimadaMin: number;
  avisos: Record<string, number>;
  linhasGravadas: number;
}

const vazioRelatorio = (): Relatorio => ({
  cartoes: 0, abertos: 0, fechados: 0, fechadosForaDaJanela: 0, porEtapa: {}, semTelefone: 0, telefoneInvalido: 0, semContato: 0, telefonesDistintos: 0, telefonesRepetidos: 0,
  semConversa: 0, falhasDeLeitura: 0, mensagens: 0, cartoesComMensagem: 0, amostra: 0, mensagensEstimadas: 0, segundosPorCartao: 0, duracaoEstimadaMin: 0, avisos: {}, linhasGravadas: 0,
});

/**
 * Lê tudo e entrega as linhas (GRAVAR) ou só conta (SECO). No seco as conversas são lidas só numa amostra espalhada (`AMOSTRA_DO_SECO`),
 * o bastante para medir mensagens por cartão e segundos por cartão, e a estimativa vira número para o João decidir.
 */
export async function exportar(amb: Ambiente, opcoes: { gravar: boolean; limite?: number; entregar: (l: LinhaDoCartao) => void }): Promise<Relatorio> {
  const r = vazioRelatorio();
  const sel = await lerSelecao(amb);
  r.cartoes = sel.cartoes.length;
  r.fechadosForaDaJanela = sel.fechadosForaDaJanela;
  const fones = new Map<string, number>();
  for (const c of sel.cartoes) {
    if (c.statusId === STATUS_GANHO || c.statusId === STATUS_PERDIDO) r.fechados++;
    else r.abertos++;
    for (const a of atributosDoCartao(c).avisos) r.avisos[a] = (r.avisos[a] ?? 0) + 1; // os avisos valem para TODOS os cartões, não só os da amostra
    const k = `${c.funil} › ${c.etapa}`;
    r.porEtapa[k] = (r.porEtapa[k] ?? 0) + 1;
    const ct = sel.contatos.get(c.id);
    if (!ct) r.semContato++;
    const fone = foneParaWhatsApp(ct?.telefone);
    if (!fone) {
      if (ct?.telefone) r.telefoneInvalido++;
      else r.semTelefone++;
    } else fones.set(fone, (fones.get(fone) ?? 0) + 1);
  }
  r.telefonesDistintos = fones.size;
  r.telefonesRepetidos = [...fones.values()].filter((n) => n > 1).length;

  // `--limite`: os N cartões mais recentes QUE TÊM telefone (cortar antes poderia gravar menos, ou nenhum, e parecer que funcionou)
  const comTelefone = sel.cartoes.filter((c) => foneParaWhatsApp(sel.contatos.get(c.id)?.telefone)).slice(0, opcoes.limite && opcoes.limite > 0 ? opcoes.limite : undefined);
  const passo = opcoes.gravar ? 1 : Math.max(1, Math.floor(comTelefone.length / AMOSTRA_DO_SECO));
  const lidos = new Set<number>();
  let segundos = 0;
  let seguidas = 0;
  for (let i = 0; i < comTelefone.length; i += passo) {
    if (!opcoes.gravar && lidos.size >= AMOSTRA_DO_SECO) break;
    const c = comTelefone[i]!;
    const t0 = Date.now();
    let msgs: MensagemDaKommo[] | null;
    try {
      msgs = await lerConversa(amb, c.id);
      seguidas = 0;
      if (msgs === null) r.semConversa++;
    } catch {
      msgs = null;
      r.falhasDeLeitura++;
      if (++seguidas >= FALHAS_SEGUIDAS_MAX) throw new Error(`${FALHAS_SEGUIDAS_MAX} conversas seguidas sem leitura: a Kommo está engasgada — paro (nada foi importado)`);
    }
    segundos += (Date.now() - t0) / 1000;
    lidos.add(c.id);
    const linha = linhaDoCartao(c, sel.contatos.get(c.id) ?? null, msgs, amb.agora());
    r.mensagens += linha.mensagens.length;
    if (linha.mensagens.length) r.cartoesComMensagem++;
    if (opcoes.gravar) {
      opcoes.entregar(linha);
      r.linhasGravadas++;
    }
    await amb.pausa(250);
    if (opcoes.gravar && lidos.size % 50 === 0) amb.log(`lidos ${lidos.size}/${comTelefone.length} cartões`);
  }
  r.amostra = lidos.size;
  if (lidos.size) {
    r.segundosPorCartao = Math.round((segundos / lidos.size) * 10) / 10;
    r.mensagensEstimadas = Math.round((r.mensagens / lidos.size) * comTelefone.length);
    r.duracaoEstimadaMin = Math.round(((segundos / lidos.size) * comTelefone.length) / 60);
  }
  return r;
}
