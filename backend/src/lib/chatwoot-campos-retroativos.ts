/**
 * Campos retroativos do CRM (Chatwoot) — LOTE 2 (pedido do João, 17/11/2026): conversas da caixa de WhatsApp oficial com a ETAPA, o FUNIL, o
 * MOTIVO e a QUALIFICAÇÃO vazios, preenchidos a partir do que a Doutor Digital já sabe (cartão do Kommo, agenda da franquia, classificação da
 * Sofia). Aqui mora SÓ a decisão (pura, sem rede nem banco); quem lê e grava é `chatwoot-campos-retroativos-run.ts`.
 *
 * Regras (só preenche campo VAZIO, nunca sobrescreve):
 *  2. etapa ← cartão do Kommo no funil COMERCIAL: AGENDADO→Agendado, COMPARECEU→Compareceu, EM NEGOCIAÇÃO→Pós-consulta, EM QUALIFICAÇÃO→Sofia
 *     qualifica, PERDIDO→Perdido. EM ESPERA não tem etapa: ganha a etiqueta `conferir-etapa` (a equipe decide). Resto (entrada, não compareceu,
 *     ganho, retorno pós-tratamento): sem regra, fica vazio.
 *  3. motivo_nao_agendamento ← motivo de perda do cartão (de/para abaixo), só em quem fica Perdido. Perdido sem motivo mapeável NÃO é gravado
 *     («Perdido exige motivo», a mesma regra da Sofia e da janela de resolver) e Perdido com consulta de pé na agenda também não (quem desistiu e
 *     marcou de novo é decisão da equipe): vão para a equipe, listados com o código do motivo.
 *  4. funil = Tratamento + etapa_tratamento ← cartão no funil TRATAMENTO (EM TRATAMENTO→Em tratamento, ALTA→Alta). Quem está em tratamento não
 *     leva etapa comercial.
 *  5. etapa Compareceu ← agenda da franquia: o que o `chatwoot-agenda` já gravou na conversa (situação Atendido + categoria Avaliação).
 *  6. qualificacao ← última classificação da Sofia (Quente/Morno/Frio), só se for dos últimos 30 dias.
 *
 * O que protege o paciente (tudo provado em `chatwoot-campos-retroativos.test.ts`):
 *  - RÉGUA: as regras de ENTRADA (perdido há 48 h, alta, cancelamento…) só disparam para valor visto DEPOIS da partida (`Visto.inicial = false`).
 *    O plano devolve `marcasVisto`: a etapa/etapa_tratamento que a gente grava já entra na memória da régua como `inicial`, ANTES da gravação.
 *    E, por segurança, se mesmo assim a régua passaria a ter uma regra NOVA ainda no prazo (ex.: etapa Agendado + consulta futura → véspera), o
 *    plano NÃO grava o campo que a causou (`pulou: regua-acordaria`): conversa que a régua falaria vai para a equipe, não para o paciente.
 *  - CAPI: etapa Agendado/Compareceu viraria evento de conversão para a Meta. O plano devolve `marcasCapi`: as linhas `capi-visto:<Evento>` como
 *    `inicial` (o worker nunca manda o que já estava assim).
 */
import { candidatos, diaEmBelem, lerData, limiteDe, precisaUltimaPublica, retomadaSegurada, type AjustesDaRegua, type Candidato, type ConversaRegua, type MensagemResumo, type Vistos } from './chatwoot-regua.js';
import { eventosAlcancados, type EventoCapi } from './chatwoot-capi.js';
import { ETIQUETA_PAUSA } from './chatwoot-pausa.js';

export const ETIQUETA_CONFERIR_ETAPA = 'conferir-etapa';
export const JANELA_DA_QUALIFICACAO_MS = 30 * 24 * 3600_000;
const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;

/** Um cartão do Kommo já resolvido para nomes (a porta traduz pipeline e status). */
export interface LeadDoKommo {
  id: number;
  /** nome do funil: COMERCIAL | TRATAMENTO */
  funil: string;
  /** nome da etapa do cartão (EM QUALIFICAÇÃO, AGENDADO…) */
  etapa: string;
  statusId: number;
  /** segundos desde 1970 */
  atualizadoEm: number;
  /** nome do motivo de perda do cartão, se houver */
  motivoPerda: string | null;
}

export interface FatoDeQualificacao {
  leadId: number;
  valor: string;
  observadoEm: Date;
}

export interface EntradaDaConversa {
  conv: ConversaRegua;
  /** open | resolved | pending | snoozed */
  status: string;
  leads: readonly LeadDoKommo[];
  qualificacoes: readonly FatoDeQualificacao[];
  /** o que a memória da régua já tem desta conversa */
  vistos: Vistos;
  /** a lista de `motivo_nao_agendamento` da conta */
  motivosValidos: readonly string[];
  /** o que a Gestora configurou na tela «Robôs» (tempos e modelos): a régua de verdade usa estes, não os de fábrica */
  ajustes?: AjustesDaRegua;
  /**
   * A última mensagem PÚBLICA da conversa (null = nenhuma). A listagem traz a última mensagem que não é atividade, que muitas vezes é uma NOTA
   * privada; em etapa de qualificação o worker da régua troca por esta (`precisaUltimaPublica`) antes de decidir, e a trava tem de olhar o que ele olha.
   * `undefined` = não buscada (vale a da listagem).
   */
  ultimaPublica?: MensagemResumo | null;
}

export type RegraDoCampo = 'etapa-kommo' | 'motivo-kommo' | 'tratamento-kommo' | 'compareceu-agenda' | 'qualificacao-sofia' | 'espera-kommo';

export interface Alteracao {
  campo: string;
  depois: string;
  regra: RegraDoCampo;
  /** sem nome, telefone nem texto de paciente: só o fato que decidiu */
  porque: string;
}

export type CodigoDoBloqueio = 'tem-conferir-etapa' | 'ia-pausada-resolvida' | 'kommo-ambiguo' | 'perdido-sem-motivo' | 'perdido-motivo-invalido' | 'perdido-com-consulta' | 'regua-acordaria' | 'regua-sumiria';

export interface Plano {
  conversa: number;
  alteracoes: Alteracao[];
  /** etiqueta a ACRESCENTAR (a lista inteira é remontada por quem grava) */
  etiquetaNova: string | null;
  /** por que algo (ou tudo) deixou de ser gravado */
  bloqueios: Array<{ codigo: CodigoDoBloqueio; detalhe: string }>;
  /** nota para a contagem: o cartão do Kommo existe mas a etapa dele não tem regra */
  semRegra: string | null;
  /** o que entra na memória da régua como `inicial` ANTES de gravar */
  marcasVisto: Array<{ campo: string; valor: string }>;
  /** eventos de conversão da Meta que ficam como `inicial` (nunca enviados) ANTES de gravar */
  marcasCapi: EventoCapi[];
}

const semAcento = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
const vazio = (v: unknown): boolean => (typeof v === 'string' ? v.trim() === '' : v === undefined || v === null);
const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

// ── telefone ────────────────────────────────────────────────────────────────────────────────────────

/** Dígitos com DDI: o Kommo guarda muita gente sem o 55 (DDD + número); sem isto `mesmoTelefone` (que compara DDI+DDD) nunca casaria. */
export function foneComDdi(t: string | null | undefined): string {
  const d = String(t ?? '').replace(/\D/g, '');
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

/** Mesmo número: DDI+DDD e os 8 últimos dígitos (com e sem o 9). Número sem DDD não casa (os 8 dígitos sozinhos juntariam gente de outro DDD). */
export function mesmoFone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = foneComDdi(a);
  const y = foneComDdi(b);
  return x.length >= 12 && y.length >= 12 && x.slice(0, 4) === y.slice(0, 4) && x.slice(-8) === y.slice(-8);
}

/** Chave de agrupamento do mesmo número (DDI+DDD e 8 últimos dígitos), com o MESMO tratamento do 55 de `mesmoFone`. null = sem DDD/curto demais. */
export function chaveDoFone(t: string | null | undefined): string | null {
  const d = foneComDdi(t);
  return d.length < 12 ? null : `${d.slice(0, 4)}|${d.slice(-8)}`;
}

// ── de/para ─────────────────────────────────────────────────────────────────────────────────────────

/** Etapa do cartão COMERCIAL do Kommo → etapa do Chatwoot (de/para de 12/11/2026, só as que o João mandou preencher). */
const ETAPA_DO_COMERCIAL: Readonly<Record<string, string>> = {
  AGENDADO: 'Agendado',
  COMPARECEU: 'Compareceu',
  'EM NEGOCIACAO': 'Pós-consulta',
  'EM QUALIFICACAO': 'Sofia qualifica',
};
const ETAPA_DO_TRATAMENTO: Readonly<Record<string, string>> = { 'EM TRATAMENTO': 'Em tratamento', ALTA: 'Alta' };

/**
 * Motivo de perda do Kommo de Parauapebas → lista `motivo_nao_agendamento` do Chatwoot. Só entra o que tem equivalente claro; o resto fica
 * sem motivo (e o Perdido vai para a equipe). O resultado ainda é conferido na lista da conta (`motivosValidos`).
 */
const MOTIVO_DO_KOMMO: Readonly<Record<string, string>> = {
  'PLANO DE SAUDE': 'Plano de saúde',
  'OUTRA PATOLOGIA': 'Outra patologia',
  'SOLICITADO EXAMES': 'Solicitado exames',
  'CASO ENVIADO PARA A FRANQUIA': 'Caso enviado para a franquia',
  'DECIDIR COM A FAMILIA': 'Decidir com a família',
  'MORA EM OUTRA CIDADE': 'Outra cidade',
  'OUTRA CIDADE': 'Outra cidade',
  'BANDEIRA VERMELHA': 'Bandeira vermelha',
  'VAI VIAJAR': 'Viajando',
  'ESTA VIAJANDO': 'Viajando',
  'ACHOU CARO': 'Achou caro',
  'VAI SE ORGANIZAR FINANCEIRAMENTE': 'Vai se organizar',
  'VAI SE ORGANIZAR': 'Vai se organizar',
  'FINANCEIRAMENTE VULNERAVEL': 'Sem condições',
  'SEM CONDICOES FINANCEIRAS': 'Sem condições',
  'NAO INTERAGIU': 'Não interagiu',
  'INFORMACAO PARA TERCEIRO': 'Informação para terceiro',
  'CLICOU POR ENGANO': 'Clicou por engano',
  'SEM INTERESSE': 'Sem interesse',
  'NAO DEU CONTINUIDADE AO ATENDIMENTO': 'Não deu continuidade',
  'NAO PERTURBAR': 'Não perturbar',
  'LEAD MORTO': 'Lead morto',
  'CANCELAMENTO DE TRATAMENTO': 'Cancelamento de tratamento',
};

export function motivoDoChatwoot(nomeNoKommo: string | null | undefined, validos: readonly string[]): string | null {
  if (!nomeNoKommo) return null;
  const m = MOTIVO_DO_KOMMO[semAcento(nomeNoKommo)];
  return m && validos.includes(m) ? m : null;
}

// ── escolha do cartão ───────────────────────────────────────────────────────────────────────────────

/** Consulta marcada de hoje em diante (Belém) e ainda de pé. */
function consultaDePe(a: Record<string, unknown>, agora: Date): boolean {
  const dia = lerData(a.data_consulta);
  return !!dia && dia.iso >= diaEmBelem(agora) && ['Agendado', 'Confirmado'].includes(texto(a.situacao_consulta));
}

const maisRecente = (leads: readonly LeadDoKommo[]): LeadDoKommo => leads.reduce((a, b) => (b.atualizadoEm > a.atualizadoEm || (b.atualizadoEm === a.atualizadoEm && b.id > a.id) ? b : a));

type DoComercial = { tipo: 'etapa'; valor: string; lead: LeadDoKommo } | { tipo: 'espera' } | { tipo: 'perdido'; lead: LeadDoKommo } | { tipo: 'sem-regra'; nome: string } | { tipo: 'ambiguo'; detalhe: string } | { tipo: 'nenhum' };

function traduzirComercial(l: LeadDoKommo): DoComercial {
  const nome = semAcento(l.etapa);
  if (l.statusId === STATUS_PERDIDO || nome === 'PERDIDO') return { tipo: 'perdido', lead: l };
  if (nome === 'EM ESPERA') return { tipo: 'espera' };
  const valor = l.statusId === STATUS_GANHO ? undefined : ETAPA_DO_COMERCIAL[nome];
  return valor ? { tipo: 'etapa', valor, lead: l } : { tipo: 'sem-regra', nome: l.etapa };
}

/**
 * Qual cartão COMERCIAL vale: um só é fácil; vários, vale o aberto; vários abertos que dão etapas DIFERENTES não se decide por palpite (a
 * mesma regra de nunca estampar a partir do primeiro resultado de uma busca ambígua). Sem aberto, o mais recente.
 */
function escolherComercial(leads: readonly LeadDoKommo[]): DoComercial {
  const todos = leads.filter((l) => semAcento(l.funil) === 'COMERCIAL');
  if (!todos.length) return { tipo: 'nenhum' };
  const abertos = todos.filter((l) => l.statusId !== STATUS_GANHO && l.statusId !== STATUS_PERDIDO);
  if (abertos.length > 1) {
    const traduzidos = abertos.map(traduzirComercial);
    const chaves = new Set(traduzidos.map((t) => (t.tipo === 'etapa' ? `e:${t.valor}` : t.tipo === 'sem-regra' ? `s:${semAcento(t.nome)}` : t.tipo)));
    if (chaves.size > 1) return { tipo: 'ambiguo', detalhe: `${abertos.length} cartões abertos com etapas diferentes` };
  }
  return traduzirComercial(maisRecente(abertos.length ? abertos : todos));
}

function escolherTratamento(leads: readonly LeadDoKommo[]): { etapa: string; lead: LeadDoKommo } | null {
  const mapeados = leads.filter((l) => semAcento(l.funil) === 'TRATAMENTO' && ETAPA_DO_TRATAMENTO[semAcento(l.etapa)]);
  if (!mapeados.length) return null;
  const lead = maisRecente(mapeados);
  return { etapa: ETAPA_DO_TRATAMENTO[semAcento(lead.etapa)]!, lead };
}

function qualificacaoDaSofia(fatos: readonly FatoDeQualificacao[], agora: Date): { valor: string; fato: FatoDeQualificacao } | null {
  let melhor: { valor: string; fato: FatoDeQualificacao } | null = null;
  for (const f of fatos) {
    const t = f.observadoEm.getTime();
    if (!Number.isFinite(t) || t > agora.getTime() || agora.getTime() - t > JANELA_DA_QUALIFICACAO_MS) continue;
    const valor = ({ QUENTE: 'Quente', MORNO: 'Morno', FRIO: 'Frio' } as Record<string, string>)[semAcento(f.valor)];
    if (!valor) continue;
    if (!melhor || t > melhor.fato.observadoEm.getTime()) melhor = { valor, fato: f };
  }
  return melhor;
}

// ── a régua: o que ela passaria a ter por causa do preenchimento ────────────────────────────────────

/** Os campos que a régua acompanha como «entrou agora» (ver `camposObservados`). */
const CAMPOS_OBSERVADOS_ESCRITOS = ['etapa', 'etapa_tratamento'] as const;

export function vistosComMarcas(vistos: Vistos, marcas: ReadonlyArray<{ campo: string; valor: string }>, agora: Date): Vistos {
  const novo = new Map(vistos);
  for (const m of marcas) novo.set(m.campo, { valor: m.valor, desde: agora, inicial: true });
  return novo;
}

const chaveDe = (k: Candidato): string => `${k.regra}|${k.chave}`;

/** A conversa como o worker da régua a decide: em etapa de qualificação ele troca a última mensagem pela última PÚBLICA. */
function comoOWorker(c: ConversaRegua, ultimaPublica: MensagemResumo | null | undefined): ConversaRegua {
  return ultimaPublica !== undefined && precisaUltimaPublica(c) ? { ...c, ultima: ultimaPublica } : c;
}

/**
 * O que gravar muda na régua, comparando os dois estados com a mesma conta do worker:
 *  - `acorda`: regras NOVAS ainda no prazo (a régua passaria a falar/agir);
 *  - `some`: regras que existiam, ainda no prazo, e deixam de existir (o paciente perderia véspera/dia/preparo, por exemplo).
 */
export function mudancaNaRegua(antes: ConversaRegua, depois: ConversaRegua, vistosAntes: Vistos, vistosDepois: Vistos, agora: Date, ajustes?: AjustesDaRegua, ultimaPublica?: MensagemResumo | null): { acorda: string[]; some: string[] } {
  // a retomada de lead que o worker SEGURA (consulta de pé, avaliou há pouco) não acorda nem some: a régua nunca a manda
  const A = candidatos(comoOWorker(antes, ultimaPublica), vistosAntes, ajustes).filter((k) => !retomadaSegurada(k.regra, antes.attrs, agora));
  const D = candidatos(comoOWorker(depois, ultimaPublica), vistosDepois, ajustes).filter((k) => !retomadaSegurada(k.regra, depois.attrs, agora));
  const chavesA = new Set(A.map(chaveDe));
  const chavesD = new Set(D.map(chaveDe));
  const noPrazo = (k: Candidato) => agora.getTime() <= limiteDe(k).getTime();
  return { acorda: D.filter((k) => !chavesA.has(chaveDe(k)) && noPrazo(k)).map((k) => k.regra), some: A.filter((k) => !chavesD.has(chaveDe(k)) && noPrazo(k)).map((k) => k.regra) };
}

// ── a decisão ───────────────────────────────────────────────────────────────────────────────────────

interface Grupo {
  nome: 'qualificacao' | 'etapa' | 'tratamento';
  alteracoes: Alteracao[];
}

export function decidirCampos(e: EntradaDaConversa, agora: Date): Plano {
  const { conv } = e;
  const a = conv.attrs;
  const plano: Plano = { conversa: conv.id, alteracoes: [], etiquetaNova: null, bloqueios: [], semRegra: null, marcasVisto: [], marcasCapi: [] };
  if (conv.etiquetas.includes(ETIQUETA_CONFERIR_ETAPA)) {
    plano.bloqueios.push({ codigo: 'tem-conferir-etapa', detalhe: 'já marcada para a equipe conferir: não mexo' });
    return plano;
  }
  const grupos: Grupo[] = [];

  // 4. tratamento (funil + etapa_tratamento)
  const trat = escolherTratamento(e.leads);
  // cartão de TRATAMENTO (alta antiga, por exemplo) e um cartão COMERCIAL aberto MAIS NOVO: não se sabe se a pessoa voltou a ser lead (consulta
  // marcada de novo). Gravar Tratamento tiraria véspera/dia/preparo e calaria a Sofia; gravar a etapa comercial contradiria o tratamento.
  const comerciaisAbertos = e.leads.filter((l) => semAcento(l.funil) === 'COMERCIAL' && l.statusId !== STATUS_GANHO && l.statusId !== STATUS_PERDIDO);
  const tratamentoAmbiguo = !!trat && comerciaisAbertos.some((l) => l.atualizadoEm > trat.lead.atualizadoEm);
  if (tratamentoAmbiguo) plano.bloqueios.push({ codigo: 'kommo-ambiguo', detalhe: 'cartão de TRATAMENTO e um cartão COMERCIAL aberto mais novo: a equipe decide' });
  const funilVazio = vazio(a.funil);
  const tratVazio = vazio(a.etapa_tratamento);
  const emTratamento = !!trat;
  if (trat && !tratamentoAmbiguo && funilVazio && tratVazio) {
    grupos.push({
      nome: 'tratamento',
      alteracoes: [
        { campo: 'funil', depois: 'Tratamento', regra: 'tratamento-kommo', porque: `Kommo TRATAMENTO / ${trat.lead.etapa}` },
        { campo: 'etapa_tratamento', depois: trat.etapa, regra: 'tratamento-kommo', porque: `Kommo TRATAMENTO / ${trat.lead.etapa}` },
      ],
    });
  }

  // 2/3/5. etapa comercial (não vale para quem está em tratamento)
  if (vazio(a.etapa) && !emTratamento && texto(a.funil) !== 'Tratamento' && vazio(a.etapa_tratamento)) {
    const k = escolherComercial(e.leads);
    const atendidaNaAgenda = texto(a.situacao_consulta) === 'Atendido' && texto(a.categoria_consulta) === 'Avaliação';
    const alteracoes: Alteracao[] = [];
    if (k.tipo === 'ambiguo') {
      plano.bloqueios.push({ codigo: 'kommo-ambiguo', detalhe: k.detalhe });
    } else if (k.tipo === 'sem-regra') {
      plano.semRegra = `Kommo ${k.nome}`;
    } else if (k.tipo === 'espera') {
      plano.etiquetaNova = ETIQUETA_CONFERIR_ETAPA;
    } else if (k.tipo === 'perdido' && consultaDePe(a, agora)) {
      // o cartão diz Perdido mas a agenda tem consulta de pé: quem desistiu e marcou de novo é decisão da equipe (o `chatwoot-agenda` também não mexe aí)
      plano.bloqueios.push({ codigo: 'perdido-com-consulta', detalhe: 'o Kommo diz Perdido, mas a conversa tem consulta de pé na agenda: a equipe decide' });
    } else if (k.tipo === 'perdido') {
      const motivoAtual = texto(a.motivo_nao_agendamento);
      // o motivo que a conversa JÁ tem só vale se for uma opção da lista da conta: Perdido com motivo fora da lista quebra a regra da tela (Perdido exige motivo válido)
      // e o texto livre de um robô/pessoa antiga não é fato do Kommo: não se grava a etapa por cima dele, a equipe decide
      const atualInvalido = !!motivoAtual && !e.motivosValidos.includes(motivoAtual);
      const motivo = atualInvalido ? null : motivoAtual || motivoDoChatwoot(k.lead.motivoPerda, e.motivosValidos);
      if (atualInvalido) plano.bloqueios.push({ codigo: 'perdido-motivo-invalido', detalhe: e.motivosValidos.length ? 'o Kommo diz Perdido, mas o motivo que a conversa já tem não está na lista de motivos do CRM: a equipe decide' /* (sem o texto do campo: é livre e pode ter nome/telefone, e o detalhe vai para o log) */ : 'o Kommo diz Perdido e a conversa já tem motivo, mas a lista de motivos do CRM veio VAZIA (não consegui conferir): não gravo' });
      else if (!motivo) plano.bloqueios.push({ codigo: 'perdido-sem-motivo', detalhe: k.lead.motivoPerda ? 'o motivo de perda do Kommo não tem equivalente na lista do CRM' : 'o cartão está Perdido no Kommo sem motivo de perda' });
      else {
        alteracoes.push({ campo: 'etapa', depois: 'Perdido', regra: 'etapa-kommo', porque: 'Kommo PERDIDO' });
        if (!motivoAtual) alteracoes.push({ campo: 'motivo_nao_agendamento', depois: motivo, regra: 'motivo-kommo', porque: 'motivo de perda do cartão do Kommo' });
      }
    } else if (k.tipo === 'etapa') {
      alteracoes.push({ campo: 'etapa', depois: k.valor, regra: 'etapa-kommo', porque: `Kommo ${k.lead.etapa}` });
    }
    // 5. a agenda da franquia (já gravada na conversa pelo `chatwoot-agenda`) diz que a avaliação foi ATENDIDA: é fato. Vale sozinha (sem cartão) e vale
    // mais que um cartão que ainda está em AGENDADO / EM QUALIFICAÇÃO. Cartão adiantado (negociação), perdido, em espera ou ambíguo: fica o do Kommo.
    const cartaoAtrasado = k.tipo === 'nenhum' || (k.tipo === 'etapa' && (k.valor === 'Agendado' || k.valor === 'Sofia qualifica'));
    if (atendidaNaAgenda && cartaoAtrasado) {
      const nova: Alteracao = { campo: 'etapa', depois: 'Compareceu', regra: 'compareceu-agenda', porque: 'agenda da franquia: avaliação atendida' };
      const i = alteracoes.findIndex((x) => x.campo === 'etapa');
      if (i >= 0) alteracoes[i] = nova;
      else alteracoes.push(nova);
    }
    if (alteracoes.length) grupos.push({ nome: 'etapa', alteracoes });
  }

  // 6. qualificação
  if (vazio(a.qualificacao)) {
    const q = qualificacaoDaSofia(e.qualificacoes, agora);
    if (q) grupos.push({ nome: 'qualificacao', alteracoes: [{ campo: 'qualificacao', depois: q.valor, regra: 'qualificacao-sofia', porque: 'classificação da Sofia nos últimos 30 dias' }] });
  }

  // a conversa RESOLVIDA e pausada: qualquer escrita dispara `conversation_updated`, que reativa a Sofia (nota + tira a pausa). Não é mensagem ao
  // paciente, mas é efeito colateral que o preenchimento não deve causar: vai para a equipe.
  if (e.status === 'resolved' && conv.etiquetas.includes(ETIQUETA_PAUSA) && (grupos.length || plano.etiquetaNova)) {
    plano.bloqueios.push({ codigo: 'ia-pausada-resolvida', detalhe: 'resolvida e com a IA pausada: gravar reativaria a Sofia' });
    plano.etiquetaNova = null;
    return plano;
  }

  // a régua: tira do plano o que a faria falar (qualificação primeiro: ela sozinha pode acordar o aviso de lead quente; depois etapa; depois tratamento)
  let ativos = [...grupos];
  const acordadas = new Set<string>();
  const sumiriam = new Set<string>();
  for (const tirar of [null, 'qualificacao', 'etapa', 'tratamento'] as const) {
    if (tirar) ativos = ativos.filter((g) => g.nome !== tirar);
    const alteracoes = ativos.flatMap((g) => g.alteracoes);
    const depois = aplicar(conv, alteracoes, plano.etiquetaNova);
    const marcas = alteracoes.filter((x) => (CAMPOS_OBSERVADOS_ESCRITOS as readonly string[]).includes(x.campo)).map((x) => ({ campo: x.campo, valor: x.depois }));
    const m = mudancaNaRegua(conv, depois, e.vistos, vistosComMarcas(e.vistos, marcas, agora), agora, e.ajustes, e.ultimaPublica);
    if (!m.acorda.length && !m.some.length) {
      plano.alteracoes = alteracoes;
      plano.marcasVisto = marcas;
      plano.marcasCapi = eventosAlcancados(depois.attrs).filter((ev) => !eventosAlcancados(a).includes(ev));
      break;
    }
    for (const regra of m.acorda) acordadas.add(regra);
    for (const regra of m.some) sumiriam.add(regra);
  }
  const deixou = grupos.filter((g) => !ativos.includes(g)).map((g) => g.nome);
  if (acordadas.size) plano.bloqueios.push({ codigo: 'regua-acordaria', detalhe: `a régua passaria a ter: ${[...acordadas].join(', ')} — não gravei: ${deixou.join(', ')}` });
  if (sumiriam.size) plano.bloqueios.push({ codigo: 'regua-sumiria', detalhe: `a régua deixaria de ter: ${[...sumiriam].join(', ')} — não gravei: ${deixou.join(', ')}` });
  return plano;
}

/** A conversa como ficaria depois de gravar (para a régua e o CAPI olharem). */
export function aplicar(conv: ConversaRegua, alteracoes: readonly Alteracao[], etiquetaNova: string | null): ConversaRegua {
  const attrs: Record<string, unknown> = { ...conv.attrs };
  for (const x of alteracoes) attrs[x.campo] = x.depois;
  const etiquetas = etiquetaNova && !conv.etiquetas.includes(etiquetaNova) ? [...conv.etiquetas, etiquetaNova] : conv.etiquetas;
  return { ...conv, attrs, etiquetas };
}
