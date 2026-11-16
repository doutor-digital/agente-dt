/**
 * O PÚBLICO de um disparo pelo CRM: lê as conversas da caixa, aplica o filtro da equipe e as EXCLUSÕES AUTOMÁTICAS (que a equipe não escolhe).
 *
 * A triagem final é a MESMA do motor do Kommo (`triar` de `regras.ts`: telefone, nome, repetido, SAIR, franquia); aqui entram só as exclusões
 * que são do CRM — etiqueta `sem-follow-up`, contato `interno`, outra conversa mais recente do mesmo telefone e quem recebeu outro
 * disparo há pouco. O lado seguro do erro é sempre o de NÃO mandar: se não deu para conferir SAIR ou a franquia, a pessoa fica de fora.
 */
import { conversaDoChatwoot, type ConversaRegua } from '../../chatwoot-regua.js';
import { conversaLidaDoChatwoot } from '../../chatwoot-porta.js';
import { quemFalaPorTelefone } from '../../chatwoot-regua-worker.js';
import { chaveDaPessoa, rotuloDaExclusao, telefoneWhatsapp, triar, type Candidato, type Elegivel, type MotivoDeExclusao, type SituacaoNaFranquia } from '../regras.js';
import { ETIQUETA_SEM_FOLLOW_UP, passaNoFiltro, precisaResolverInteracao, type ConversaDoPublico, type Filtro } from './filtro.js';

/** Motivos que são do CRM (os outros são os de `MotivoDeExclusao`, os mesmos do Kommo). */
export type MotivoDoCrm = 'nao-e-paciente' | 'sem-follow-up' | 'interno' | 'outra-conversa' | 'recebeu-disparo-recente' | 'sair-indisponivel';

export const ROTULO_DO_CRM: Record<MotivoDoCrm, string> = {
  'nao-e-paciente': 'grupo ou número da própria unidade',
  'sem-follow-up': 'etiqueta «sem-follow-up» (a equipe pediu para não chamar)',
  interno: 'contato interno (a equipe falando com o número da unidade)',
  'outra-conversa': 'tem outra conversa mais recente com o mesmo telefone',
  'recebeu-disparo-recente': 'recebeu outro disparo nos últimos 7 dias',
  'sair-indisponivel': 'não deu para conferir se pediu para sair (na dúvida, não manda)',
};

/** Os rótulos do motor do Kommo que falam de «cartão/Kommo» dizem, aqui, o que o CRM quer dizer. */
const ROTULO_ADAPTADO: Partial<Record<MotivoDeExclusao, string>> = {
  'ja-cliente': 'já é paciente (etapa do CRM: agendado, em tratamento, fechou…)',
  'lead-inexistente': 'a conversa não existe mais',
  'ja-na-campanha': 'já está nesta campanha (não manda duas vezes)',
};

/** O rótulo de uma exclusão para a tela: os do CRM, os do Kommo adaptados ao CRM e, no resto, os do motor (`regras.ts`). */
export function rotuloDaExclusaoNoCrm(m: string): string {
  return ROTULO_DO_CRM[m as MotivoDoCrm] ?? ROTULO_ADAPTADO[m as MotivoDeExclusao] ?? rotuloDaExclusao(m);
}

/** Dias em que quem já recebeu um disparo não entra em outro (qualquer campanha da unidade). */
export const DIAS_SEM_REPETIR_DISPARO = 7;

export interface PessoaDoPublico extends Elegivel {
  conversaId: number;
  contatoId: number | null;
}

export interface PublicoCalculado {
  /** conversas lidas da caixa */
  lidas: number;
  /** a leitura parou no teto de páginas: a lista pode estar incompleta */
  truncada: boolean;
  /** conversas que passaram no filtro, ANTES das exclusões automáticas */
  noFiltro: number;
  elegiveis: PessoaDoPublico[];
  /** quem ficou de fora e por quê (chaves de `MotivoDeExclusao` e de `MotivoDoCrm`) */
  fora: Record<string, number>;
  /** `true` na contagem rápida: SAIR e franquia NÃO foram conferidos (só a montagem confere) */
  parcial: boolean;
}

export interface DepsDoPublico {
  /** uma página (25) da listagem da caixa; vazia = acabou */
  pagina: (caixa: number, pagina: number) => Promise<unknown[]>;
  /** a última mensagem PÚBLICA da conversa (para o «sem interação há X dias» quando a listagem só trouxe uma nota privada) */
  ultimaPublica: (conversaId: number) => Promise<Date | null>;
  /** quando o contato pediu para sair (null = nunca). LANÇA se não deu para ler. */
  pediuSair: (c: ConversaDoPublico) => Promise<Date | null>;
  /** chaves de quem recebeu disparo da unidade nos últimos `DIAS_SEM_REPETIR_DISPARO` dias */
  recentes: () => Promise<ReadonlySet<string>>;
  /** a conferência «já é nosso?» (franquia, ou a etapa do CRM em unidade sem agenda) */
  franquia: (e: Elegivel, c: ConversaDoPublico) => Promise<SituacaoNaFranquia>;
  agora: () => Date;
}

const MAX_PAGINAS = 200;
const MAX_RESOLVER = 300;
const SIMULTANEAS = 4;

/** Executa `fn` em todos, `n` por vez. */
async function emLotes<T>(itens: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length) await fn(itens[i++]!);
  }));
}

export function conversaDoPublico(raw: any): ConversaDoPublico | null {
  const c: ConversaRegua | null = conversaDoChatwoot(raw);
  if (!c) return null;
  const contato = Number(raw?.meta?.sender?.id);
  return {
    ...c,
    contatoId: Number.isInteger(contato) && contato > 0 ? contato : null,
    atividadeEm: (Number(raw?.last_activity_at) || 0) * 1000,
    interno: conversaLidaDoChatwoot(raw)?.interno ?? false,
    status: typeof raw?.status === 'string' ? raw.status : '',
  };
}

/** Lê as conversas da caixa (até 5.000). Lança se a LISTAGEM falhar. */
export async function lerConversasDaCaixa(pagina: DepsDoPublico['pagina'], caixa: number, prazo?: number): Promise<{ conversas: ConversaDoPublico[]; naoPaciente: number; truncada: boolean }> {
  const vistas = new Set<number>();
  const conversas: ConversaDoPublico[] = [];
  let naoPaciente = 0;
  let truncada = true;
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    // com prazo (a contagem da tela): sem tempo, para e devolve o que leu, marcado como CORTADO; uma página lenta também é abandonada no prazo
    let lista: unknown[] | null;
    if (prazo === undefined) lista = await pagina(caixa, p);
    else {
      const resta = prazo - Date.now();
      if (resta <= 0) break;
      let t: NodeJS.Timeout | undefined;
      lista = await Promise.race([pagina(caixa, p), new Promise<null>((ok) => void (t = setTimeout(() => ok(null), resta)))]).finally(() => clearTimeout(t));
      if (lista === null) break;
    }
    if (lista.length === 0) {
      truncada = false;
      break;
    }
    for (const raw of lista) {
      if (Number((raw as { inbox_id?: unknown })?.inbox_id) !== caixa) continue; // a caixa pedida, nenhuma outra
      const id = Number((raw as { id?: unknown })?.id);
      if (vistas.has(id)) continue;
      vistas.add(id);
      const c = conversaDoPublico(raw);
      if (!c) naoPaciente++;
      else conversas.push(c);
    }
  }
  return { conversas, naoPaciente, truncada };
}

/**
 * Calcula o público. `completo: false` é a contagem rápida da tela (sem SAIR e sem franquia, que custam uma chamada por pessoa);
 * `completo: true` é a montagem da onda. Em nenhum dos dois ESCREVE nada.
 */
export async function calcularPublico(filtro: Filtro, deps: DepsDoPublico, opcoes: { completo: boolean; /** epoch ms: depois dele a leitura PARA e o resultado vem `truncada` (a contagem rápida da tela) */ prazo?: number }): Promise<PublicoCalculado> {
  const agora = deps.agora();
  const { conversas, naoPaciente, truncada } = await lerConversasDaCaixa(deps.pagina, filtro.caixa, opcoes.prazo);
  const fora: Record<string, number> = {};
  const nega = (m: string, n = 1) => void (fora[m] = (fora[m] ?? 0) + n);
  if (naoPaciente) nega('nao-e-paciente', naoPaciente);

  // Quem FALA com cada telefone é a conversa de atividade mais recente da caixa (a mesma regra da régua): o disparo vai para ela.
  const quem = quemFalaPorTelefone(conversas.map((c) => ({ c, atividade: c.atividadeEm })));

  // 1. o filtro da equipe (o tempo sem interação precisa, às vezes, da última mensagem pública por fora)
  const semTempo: Filtro = { ...filtro, semInteracaoDias: 0 };
  const aposAtributos = conversas.filter((c) => passaNoFiltro(c, semTempo, agora.getTime()));
  const resolvidas = new Map<number, Date | null>();
  let acabouOTempo = false;
  if (filtro.semInteracaoDias > 0) {
    const precisam = aposAtributos.filter((c) => precisaResolverInteracao(c, filtro)).slice(0, MAX_RESOLVER);
    await emLotes(precisam, SIMULTANEAS, async (c) => {
      if (opcoes.prazo !== undefined && Date.now() > opcoes.prazo) {
        acabouOTempo = true;
        return;
      } // sem tempo: vale a atividade da conversa (lado seguro: não entra)
      try {
        resolvidas.set(c.id, await deps.ultimaPublica(c.id));
      } catch {
        // sem a resposta, vale a atividade da conversa (a nota privada só a faz parecer mais nova: o erro é para o lado de EXCLUIR)
      }
    });
  }
  const noFiltro = aposAtributos.filter((c) => passaNoFiltro(c, filtro, agora.getTime(), resolvidas.get(c.id)));

  // 2. as exclusões do CRM
  const recentes = await deps.recentes();
  const candidatas: ConversaDoPublico[] = [];
  for (const c of noFiltro) {
    if (!(quem.get(c.id)?.fala ?? true)) nega('outra-conversa');
    else if (c.etiquetas.some((e) => e.trim().toLowerCase() === ETIQUETA_SEM_FOLLOW_UP)) nega('sem-follow-up');
    else if (c.interno) nega('interno');
    else {
      const tel = telefoneWhatsapp(c.telefone);
      if (tel && recentes.has(chaveDaPessoa(tel))) nega('recebeu-disparo-recente');
      else candidatas.push(c);
    }
  }

  // 3. SAIR: uma leitura de mensagens por pessoa (só a montagem faz). Leitura que falha NÃO vira «não pediu».
  const pediramSair = new Set<string>();
  const porChave = new Map<string, ConversaDoPublico>();
  const semConferencia = new Set<string>();
  for (const c of candidatas) {
    const tel = telefoneWhatsapp(c.telefone);
    if (tel && !porChave.has(chaveDaPessoa(tel))) porChave.set(chaveDaPessoa(tel), c);
  }
  if (opcoes.completo) {
    await emLotes([...porChave], SIMULTANEAS, async ([chave, c]) => {
      try {
        if (await deps.pediuSair(c)) pediramSair.add(chave);
      } catch {
        semConferencia.add(chave);
      }
    });
  }

  // 4. a triagem do motor (telefone, nome, repetido, SAIR, franquia)
  const comConferencia = candidatas.filter((c) => {
    const tel = telefoneWhatsapp(c.telefone);
    if (tel && semConferencia.has(chaveDaPessoa(tel))) {
      nega('sair-indisponivel');
      return false;
    }
    return true;
  });
  const candidatos: Candidato[] = comConferencia.map((c) => ({ leadId: null, nome: c.nome || null, telefoneBruto: c.telefone ?? null }));
  const convDaChave = new Map<string, ConversaDoPublico>();
  for (const c of comConferencia) {
    const tel = telefoneWhatsapp(c.telefone);
    if (tel && !convDaChave.has(chaveDaPessoa(tel))) convDaChave.set(chaveDaPessoa(tel), c);
  }
  const t = await triar(candidatos, {
    jaNaCampanha: new Set(),
    pediramSair,
    franquia: (e) => (opcoes.completo ? deps.franquia(e, convDaChave.get(e.chave)!) : 'livre'),
  });
  for (const [m, n] of Object.entries(t.fora)) nega(m, n ?? 0);
  const elegiveis = t.elegiveis.map((e): PessoaDoPublico => {
    const c = convDaChave.get(e.chave)!;
    return { ...e, conversaId: c.id, contatoId: c.contatoId };
  });
  return { lidas: conversas.length + naoPaciente, truncada: truncada || acabouOTempo, noFiltro: noFiltro.length, elegiveis, fora, parcial: !opcoes.completo };
}

/** O que a etapa do CRM diz da pessoa, para a unidade SEM agenda da franquia (o substituto honesto, e só dele). */
export function situacaoPeloCrm(attrs: Record<string, unknown>): SituacaoNaFranquia {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const etapa = s(attrs.etapa);
  const tratamento = s(attrs.etapa_tratamento);
  if (['Agendado', 'Confirmado'].includes(etapa)) return 'consulta-futura';
  if (['Entrada', 'Em tratamento'].includes(tratamento) || (s(attrs.funil) === 'Tratamento' && !['Alta', 'Tratamento cancelado'].includes(tratamento))) return 'tratamento-aberto';
  if (['Compareceu', 'Pós-consulta', 'Fechou'].includes(etapa)) return 'ja-cliente';
  return 'livre';
}

