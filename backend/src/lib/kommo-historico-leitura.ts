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
import { atributosDoCartao, compararOrdem, consultaDePe, linhaDoCartao, ordemDoCartao, type CartaoDaKommo, type ContatoDaKommo, type LinhaDoCartao, type MensagemDaKommo, foneParaWhatsApp } from './kommo-historico-crm.js';

export const MESES_DOS_FECHADOS = 6;
export const POR_PAGINA = 250;
export const MAX_PAGINAS = 400; // 100 mil cartões na conta: acima disso a leitura LANÇA (nunca importa pela metade)
export const MAX_TALKS_POR_CARTAO = 5;
export const MENSAGENS_POR_PAGINA = 100;
/** 100 páginas de 100 = 10 mil mensagens numa conversa: acima disso a leitura LANÇA (não pode virar «as últimas 50» de uma conversa lida pela metade) */
export const MAX_PAGINAS_DE_MENSAGENS = 100;
/** quantas conversas o SECO lê de verdade para medir mensagens e tempo */
export const AMOSTRA_DO_SECO = 30;
/** o quadro e o «Hoje» leem 8 páginas de 25 conversas (`MAX_PAGINAS` de funil-chatwoot): só as 200 mais recentes por última atividade aparecem */
export const LINHAS_DO_QUADRO = 200;
const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;

export interface PortaKommo {
  listPipelines(): Promise<KommoPipeline[]>;
  listLossReasons(): Promise<Array<{ id: number; name: string }>>;
  listUsers(): Promise<Array<{ id: number; name: string }>>;
  /**
   * UMA página (250) de TODOS os cartões da conta, qualquer etapa, ordenados por ID (do mais novo ao mais velho). A ordem por id não muda quando
   * um cartão troca de etapa ou é editado no meio da leitura (ao contrário de `updated_at` ou de um filtro por etapa): andar por página nunca pula
   * ninguém — cartão novo só empurra a lista (e a repetição é descartada pelo id).
   */
  listLeadsPagina(page: number): Promise<KommoLead[]>;
  /**
   * UMA página dos cartões ABERTOS nestas etapas (por id, do mais novo ao mais velho). Só para a etapa «Incoming leads» (type 1), que a lista geral
   * de cartões NÃO devolve (medido em Timbó: 21 cartões nela, 0 na lista geral).
   */
  listLeadsAbertosPagina(etapas: ReadonlyArray<{ pipelineId: number; statusId: number }>, page?: number): Promise<KommoLead[]>;
  listLeadsPorIds(ids: number[], opcoes?: { contatos?: boolean }): Promise<KommoLead[]>;
  contatosBasicos(ids: number[]): Promise<Map<number, { nome: string | null; telefone: string | null }>>;
  listTalks(leadId: number): Promise<KommoTalk[]>;
  listTalkMessages(talkId: number, limit?: number, page?: number): Promise<KommoTalkMessage[]>;
}

export interface Ambiente {
  porta: PortaKommo;
  /** `eventosAlcancados` do CAPI (ver `linhaDoCartao`) */
  eventosCapi: (atributos: Record<string, unknown>) => readonly string[];
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
  /** quantos cartões a conta inteira tem (lidos para achar os do escopo) */
  lidosNaConta: number;
  /** cartões que só a 2ª passada da paginação achou (um cartão apagado no meio da leitura empurra a lista e faz a 1ª pular um) */
  recuperadosNaPaginacao: number;
  /** cartões do escopo cujo funil/etapa a Kommo não lista mais (funil arquivado, etapa apagada): NÃO entram — contados para o seco não parecer completo */
  semEtapaConhecida: number;
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
    statusTipo: status.type,
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

/**
 * Todas as páginas de uma consulta paginada; LANÇA se passar do teto (ainda vinha página cheia).
 * DUAS passadas, unidas pelo id: apagar um cartão que a 1ª passada já leu empurra a lista para trás e o PRIMEIRO cartão da página seguinte some da leitura
 * (a lista é por id, do mais novo ao mais velho). A 2ª passada pega o que a 1ª perdeu; `recuperados` conta quantos (deveria ser 0 quase sempre).
 */
async function todasAsPaginas(ler: (page: number) => Promise<KommoLead[]>, pausa: Ambiente['pausa'], rotulo: string): Promise<{ lista: KommoLead[]; recuperados: number }> {
  const todos = new Map<number, KommoLead>(); // a repetição na fronteira das páginas (cartão novo empurrou a lista) é descartada pelo id
  let recuperados = 0;
  for (const passada of [1, 2]) {
    for (let p = 1; ; p++) {
      if (p > MAX_PAGINAS) throw new Error(`${rotulo} passou de ${MAX_PAGINAS} páginas: leitura incompleta`);
      const lote = await ler(p);
      for (const l of lote) {
        if (passada === 2 && !todos.has(l.id)) recuperados++;
        todos.set(l.id, l);
      }
      if (lote.length < POR_PAGINA) break;
      await pausa(250);
    }
  }
  return { lista: [...todos.values()], recuperados };
}

export async function lerSelecao(amb: Ambiente): Promise<Selecao> {
  const { porta, pausa } = amb;
  const pipelines = await porta.listPipelines();
  const porId = new Map(pipelines.map((p) => [p.id, p]));
  // motivo de perda e responsável só enfeitam a nota: a conta sem escopo para listá-los (403) não pode derrubar a exportação de ~25 min
  const opcional = async <T>(nome: string, ler: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await comTentativas(amb, ler); // 429/5xx: repete (espera crescente) e, se persistir, SOBE o erro — só o 403/404 («sem escopo») é engolido
    } catch (e) {
      if (!semConversaNaKommo(e)) throw e;
      amb.log(`AVISO ${nome} indisponível (http ${String((e as { status?: number })?.status ?? '?')}): a nota segue sem esse dado`);
      return [];
    }
  };
  const motivos = new Map((await opcional('motivos de perda', () => porta.listLossReasons())).map((m) => [m.id, m.name]));
  const usuarios = new Map((await opcional('usuários', () => porta.listUsers())).map((u) => [u.id, u.name]));

  // TODOS os cartões da conta por id (estável) e o escopo B aplicado AQUI: aberto (qualquer etapa) OU ganho/perdido fechado dentro da janela.
  // (Ler «os abertos» e «os fechados» em duas consultas deixaria passar o cartão que muda de uma para a outra no meio da leitura.)
  const desde = inicioDosFechados(amb.agora());
  let fora = 0;
  const leads = new Map<number, KommoLead>();
  const { lista: daConta, recuperados } = await todasAsPaginas((p) => porta.listLeadsPagina(p), pausa, 'cartões da conta');
  let recuperadosNaEntrada = 0;
  for (const l of daConta) {
    const fechado = l.status_id === STATUS_GANHO || l.status_id === STATUS_PERDIDO;
    if (!fechado) leads.set(l.id, l);
    else if ((Number(l.closed_at) || 0) >= desde) leads.set(l.id, l);
    else fora++;
  }

  // a etapa «Incoming leads» não vem na lista geral: lê à parte, também por id (um cartão aceito no meio da leitura aparece na outra lista: o id junta os dois)
  const entrada = pipelines.flatMap((p) => p.statuses.filter((st) => st.type === 1 || /^incoming leads$/i.test(st.name)).map((st) => ({ pipelineId: p.id, statusId: st.id })));
  if (entrada.length) {
    const lidos = await todasAsPaginas((p) => porta.listLeadsAbertosPagina(entrada, p), pausa, 'cartões da entrada');
    recuperadosNaEntrada = lidos.recuperados;
    for (const l of lidos.lista) leads.set(l.id, l);
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
  let semEtapaConhecida = 0;
  for (const l of ordenados) {
    const c = cartaoDoLead(l, porId, motivos, usuarios);
    if (!c) {
      semEtapaConhecida++;
      continue;
    }
    cartoes.push(c);
    const cid = contatoDoLead.get(l.id);
    const b = cid ? basicos.get(cid) : undefined;
    if (cid) contatos.set(l.id, { id: cid, nome: b?.nome ?? null, telefone: b?.telefone ?? null });
  }
  return { cartoes, contatos, fechadosForaDaJanela: fora, lidosNaConta: daConta.length, recuperadosNaPaginacao: recuperados + recuperadosNaEntrada, semEtapaConhecida };
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
      // TODAS as páginas (100 por vez) até uma vir incompleta: só assim as «últimas 50» são as últimas de verdade e o total da nota bate
      for (let pagina = 1; ; pagina++) {
        if (pagina > MAX_PAGINAS_DE_MENSAGENS) throw new Error(`conversa passou de ${MAX_PAGINAS_DE_MENSAGENS} páginas de mensagens: leitura incompleta`);
        const lote = await comTentativas(amb, () => porta.listTalkMessages(Number(t.talk_id), MENSAGENS_POR_PAGINA, pagina));
        todas.push(...lote);
        if (lote.length < MENSAGENS_POR_PAGINA) break;
        await pausa(250);
      }
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
  lidosNaConta: number;
  recuperadosNaPaginacao: number;
  semEtapaConhecida: number;
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
  /** conversas que, depois de importadas, a régua/CAPI/telas NÃO tratariam como arquivo (tem de ser 0) */
  /** telefones com um cartão de consulta de pé em que a conversa de DESTINO (a de maior id, que recebe o «confirmo») NÃO é a dele: tem de ser 0 */
  consultaDePeForaDoDestino: number;
  /** telefones com MAIS DE UM cartão de consulta de pé (só um vira o destino: o outro precisa de olhar humano) */
  telefonesComVariasConsultasDePe: number;
  /** conversas que nascem vivas e ficariam fora das `LINHAS_DO_QUADRO` mais recentes da lista (o quadro e o Hoje só leem essas): tem de ser 0 */
  vivasForaDoTopo: number;
  /** conversas que já NASCERIAM vivas (a regra de arquivo, `ehArquivo`, diz que não é arquivo): as de consulta de pé (AGENDADO etc.), que recebem os lembretes do CRM */
  nascemVivas: number;
}

const vazioRelatorio = (): Relatorio => ({
  cartoes: 0, abertos: 0, fechados: 0, fechadosForaDaJanela: 0, lidosNaConta: 0, recuperadosNaPaginacao: 0, semEtapaConhecida: 0, porEtapa: {}, semTelefone: 0, telefoneInvalido: 0, semContato: 0, telefonesDistintos: 0, telefonesRepetidos: 0,
  semConversa: 0, falhasDeLeitura: 0, mensagens: 0, cartoesComMensagem: 0, amostra: 0, mensagensEstimadas: 0, segundosPorCartao: 0, duracaoEstimadaMin: 0, avisos: {}, linhasGravadas: 0, nascemVivas: 0, consultaDePeForaDoDestino: 0, telefonesComVariasConsultasDePe: 0, vivasForaDoTopo: 0,
});

/**
 * Lê tudo e entrega as linhas (GRAVAR) ou só conta (SECO). No seco as conversas são lidas só numa amostra espalhada (`AMOSTRA_DO_SECO`),
 * o bastante para medir mensagens por cartão e segundos por cartão, e a estimativa vira número para o João decidir.
 */
export async function exportar(
  amb: Ambiente,
  opcoes: {
    gravar: boolean;
    limite?: number;
    entregar: (l: LinhaDoCartao) => void;
    /** a MESMA regra de arquivo das telas e da régua (`ehArquivo`), aplicada à conversa COMO A IMPORTAÇÃO A GRAVA (resolvida, com `kommo_importado_em` = agora) */
    arquivo?: (conversa: { labels: string[]; status: string; last_activity_at: number; additional_attributes: Record<string, unknown>; custom_attributes: Record<string, unknown> }, agora: Date) => boolean;
  },
): Promise<Relatorio> {
  const r = vazioRelatorio();
  const sel = await lerSelecao(amb);
  r.cartoes = sel.cartoes.length;
  r.fechadosForaDaJanela = sel.fechadosForaDaJanela;
  r.lidosNaConta = sel.lidosNaConta;
  r.recuperadosNaPaginacao = sel.recuperadosNaPaginacao;
  r.semEtapaConhecida = sel.semEtapaConhecida;
  const fones = new Map<string, number>();
  const agora = amb.agora();
  const agoraSeg = Math.floor(agora.getTime() / 1000);
  /** por telefone: a posição de cada cartão (a que decide o destino) e se é de consulta de pé */
  const porFone = new Map<string, Array<{ ordem: number[]; pe: boolean }>>();
  /** a lista como o Chatwoot a ordena (última atividade): as vivas nascem com a hora da importação, o arquivo com a data do cartão */
  const lista: Array<{ em: number; viva: boolean }> = [];
  for (const c of sel.cartoes) {
    if (c.statusId === STATUS_GANHO || c.statusId === STATUS_PERDIDO) r.fechados++;
    else r.abertos++;
    const m = atributosDoCartao(c, agora);
    for (const a of m.avisos) r.avisos[a] = (r.avisos[a] ?? 0) + 1; // os avisos valem para TODOS os cartões, não só os da amostra
    const foneDoCartao = foneParaWhatsApp(sel.contatos.get(c.id)?.telefone);
    if (foneDoCartao) {
      const aberto = c.statusId !== STATUS_GANHO && c.statusId !== STATUS_PERDIDO;
      const pe = consultaDePe(c, m, agora);
      const grupo = porFone.get(foneDoCartao) ?? [];
      grupo.push({ ordem: ordemDoCartao({ consultaDePe: pe, aberto, atualizadoEm: c.atualizadoEm, id: c.id }), pe });
      porFone.set(foneDoCartao, grupo);
      if (opcoes.arquivo) {
        const ultima = Math.min(Math.max(c.atualizadoEm, c.criadoEm), agoraSeg);
        const viva = !opcoes.arquivo({ labels: m.etiquetas, status: 'resolved', last_activity_at: ultima, additional_attributes: { kommo_lead_id: c.id, kommo_importado_em: agoraSeg, kommo_aberto: aberto }, custom_attributes: m.atributos }, agora);
        if (viva) r.nascemVivas++;
        lista.push({ em: viva ? agoraSeg : ultima, viva });
      }
    }
    const k = `${c.funil} › ${c.etapa}`;
    r.porEtapa[k] = (r.porEtapa[k] ?? 0) + 1;
    const ct = sel.contatos.get(c.id);
    if (!ct) r.semContato++;
    const fone = foneDoCartao;
    if (!fone) {
      if (ct?.telefone) r.telefoneInvalido++;
      else r.semTelefone++;
    } else fones.set(fone, (fones.get(fone) ?? 0) + 1);
  }
  // destino: a maior posição do telefone é a conversa de maior id. Se o telefone tem consulta de pé e o destino NÃO é de consulta de pé, o «confirmo» cairia na conversa errada
  for (const grupo of porFone.values()) {
    const destino = grupo.reduce((x, y) => (compararOrdem(x.ordem, y.ordem) >= 0 ? x : y));
    const pes = grupo.filter((g) => g.pe).length;
    if (pes > 0 && !destino.pe) r.consultaDePeForaDoDestino++;
    if (pes > 1) r.telefonesComVariasConsultasDePe++;
  }
  // as vivas têm de caber nas LINHAS_DO_QUADRO primeiras da lista (as vivas vão ao topo; empate, a viva primeiro)
  lista.sort((x, y) => y.em - x.em || Number(y.viva) - Number(x.viva));
  r.vivasForaDoTopo = lista.reduce((n, x, i) => n + (x.viva && i >= LINHAS_DO_QUADRO ? 1 : 0), 0);
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
    const linha = linhaDoCartao(c, sel.contatos.get(c.id) ?? null, msgs, agora, amb.eventosCapi);
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
