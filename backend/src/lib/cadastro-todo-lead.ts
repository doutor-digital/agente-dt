/**
 * Todo lead que entra em contato vira LEAD na franquia — menos número interno.
 *
 * Decisão do João em 27/10/2026, a pedido da Suzanne (a franquia mudou a regra): a IA cadastra na
 * franquia, como LEAD e já na primeira mensagem, quem entra em contato. Isto reverte, para o lead, a
 * regra de 26/09 (`cadastro-na-franquia.ts`: "só vira lead quem agenda"). PACIENTE continua só ao
 * agendar: `syncPatientToSpine`, `cadastrar_paciente` e `spine_sync_patients` não mudam.
 *
 * Três travas, porque funcionária, equipe, prospecção de marketing, engano e "oi" solto também escrevem para a
 * Sofia e não podem entrar na base da franqueadora (as duas primeiras valem SEMPRE, inclusive para anúncio):
 *  1. lista explícita (`NUMEROS_INTERNOS`, ver `numeros-internos.ts`), pelos últimos 8 dígitos;
 *  2. trava automática: o mesmo telefone em conversas de 3 ou mais unidades distintas em 30 dias
 *     (junta `X` e `X-resgate`, ignora `hm-tecnologia`) não é gente — é rede, ou lista de marketing.
 *     Fica marcado no log e na tela "só no papel" para um humano olhar;
 *  3. quem passou nas duas e NÃO agendou: veio de ANÚNCIO (rastreio CTWA no cartão, `veioDeAnuncio`)? É lead, sempre.
 *     Não veio (orgânico: "oi", engano, secretária não listada, fornecedor)? A IA lê as falas do paciente e diz
 *     `lead` (cadastra), `nao_lead` (barra, com motivo) ou `duvida` (não cadastra agora; reavalia — no máximo 3
 *     vezes por lead, 1 a cada 10 min, só se o paciente escreveu algo novo). Falha da IA = `duvida`, nunca lead.
 *     Pedido do João em 27/10/2026: "qualquer pessoa pode cadastrar quem não é lead: secretárias, gente que clica
 *     por engano". A leitura da IA é em `cadastro-triagem-ia.ts`.
 *
 * ESTADOS (chave `CADASTRO_TODO_LEAD_SLUGS`, tela de Automações):
 *  - desligado (padrão): vale a regra de 26/09, byte a byte. Nenhuma consulta nova ao banco.
 *  - seco: a regra de 26/09 continua decidindo; a nova só DECIDE E LOGA ("cadastraria", "cadastraria pela IA",
 *    "barraria pela IA: <motivo>", "dúvida", "barrou interno", "barrou 3+ unidades") e grava na tela "só no
 *    papel". Não cria nada a mais (a leitura da IA, essa sim, roda e custa centavos).
 *  - ligado: a regra nova decide. Cria o lead de quem passar nas duas travas; quem não passar não é
 *    criado nem pelo caminho antigo (nem o agendamento de um número interno).
 *
 * Nada aqui ignora `units.spine_sync_leads` nem o token da franquia: unidade sem espelhamento de leads
 * continua sem cadastrar, qualquer que seja o estado.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { ehNumeroInterno, lerNumerosInternos, ultimos8 } from './numeros-internos.js';
import { deveCriarNaFranquia, type DecisaoDeCadastro } from './cadastro-na-franquia.js';
import { estadoCasamentoJornada } from './casamento-jornada.js';
import { unidadeDona } from '../agent/rede-doutor-hernia.js';
import { resumoDaOrigem, veioDeAnuncio, type AnuncioDeOrigem } from '../agent/anuncio-de-origem.js';
import { estadoEtapaDoLead } from '../services/lead-stage.service.js';
import { avaliarPelaIa, type DecisaoDaIa, type UnidadeDaIa } from './cadastro-triagem-ia.js';
import type { Unit } from '@prisma/client';

export const ID_AUTOMACAO = 'cadastro-todo-lead';

/** A trava automática: este tanto de unidades distintas com o mesmo telefone... */
export const UNIDADES_PARA_TRAVAR = 3;
/** ...nesta janela. */
export const DIAS_DA_TRAVA = 30;

/** Empresa do grupo, não clínica: o telefone dela aparece em conversas de teste, não conta como unidade. */
const UNIDADES_IGNORADAS = new Set(['hm-tecnologia']);

export function estadoCadastroTodoLead(slug: string, raw: string | undefined = process.env.CADASTRO_TODO_LEAD_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_AUTOMACAO, raw);
}

/**
 * As clínicas distintas da lista: `acailandia-resgate` e `doutor-hernia-acailandia` são a MESMA (a dona da conta,
 * ver `unidadeDona`), e as empresas do grupo não contam.
 */
export function unidadesDistintas(slugs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of slugs) {
    const dona = unidadeDona(s);
    if (dona && !UNIDADES_IGNORADAS.has(dona)) out.add(dona);
  }
  return [...out].sort();
}

export type AcaoDaTriagem = 'cadastrar' | 'interno' | 'varias-unidades' | 'sem-telefone' | 'erro' | 'sem-casamento' | 'sem-lista' | 'nao-lead' | 'duvida';

export interface Triagem {
  acao: AcaoDaTriagem;
  motivo: string;
  unidades?: string[];
  /** Por que `cadastrar`: veio de anúncio, ou a IA leu a conversa e viu interesse real. Sem isto, é quem agendou (26/09). */
  origem?: 'anuncio' | 'ia';
  /** Quando a decisão é da IA: quantas leituras este lead já teve, e se esta foi feita agora ou é a anterior reaproveitada. */
  leituras?: { feitas: number; maximo: number; nova: boolean };
}

/** Os últimos 4 dígitos, para o log dizer de quem se trata sem gravar o telefone inteiro. */
/** O motivo de não cadastrar "só lead" sem o casamento — um texto só, para a decisão e o sincronizador dizerem a mesma coisa. */
export const MOTIVO_SEM_CASAMENTO =
  'o casamento cartão × paciente (casamento-jornada) não está LIGADO nesta unidade — lead novo poderia duplicar quem já é paciente';

export const finalDoTelefone = (t: unknown): string => {
  const d = String(t ?? '').replace(/\D/g, '');
  return d ? `…${d.slice(-4)}` : '(sem telefone)';
};

/**
 * A decisão pura: este telefone entra? `unidadesDoTelefone` são os slugs das conversas dos últimos 30
 * dias com este telefone; `null` = não deu para consultar (a dúvida barra: lead barrado volta na
 * próxima mensagem, lead interno criado não tem volta).
 */
export function triar(
  telefone: string | null,
  unidadesDoTelefone: readonly string[] | null,
  internosRaw: string | undefined = process.env.NUMEROS_INTERNOS,
): Triagem {
  if (!ultimos8(telefone)) {
    return { acao: 'sem-telefone', motivo: 'a conversa não tem telefone com 8 dígitos — não dá para conferir se é número interno' };
  }
  // Lista de internos vazia = não configurada, não "ninguém é interno": ligar sem ela cadastraria a equipe e os números de teste.
  if (lerNumerosInternos(internosRaw).chaves.size === 0) {
    return { acao: 'sem-lista', motivo: 'NUMEROS_INTERNOS está vazia ou ausente — sem a lista de números internos não dá para cadastrar com segurança' };
  }
  if (ehNumeroInterno(telefone, internosRaw)) {
    return { acao: 'interno', motivo: `número interno da rede (${finalDoTelefone(telefone)}, NUMEROS_INTERNOS)` };
  }
  if (unidadesDoTelefone === null) {
    return { acao: 'erro', motivo: 'não consegui conferir as outras unidades deste telefone' };
  }
  const unidades = unidadesDistintas(unidadesDoTelefone);
  if (unidades.length >= UNIDADES_PARA_TRAVAR) {
    return {
      acao: 'varias-unidades',
      motivo: `o telefone ${finalDoTelefone(telefone)} falou com ${unidades.length} unidades em ${DIAS_DA_TRAVA} dias (${unidades.join(', ')}) — um humano precisa olhar`,
      unidades,
    };
  }
  return { acao: 'cadastrar', motivo: 'entrou em contato — lead novo na franquia' };
}

// ── o que toca o banco (injetável para teste) ────────────────────────────────────────────────

export type SituacaoNaFranquia =
  /** já tem lead criado lá — não há o que decidir */
  | 'na-franquia'
  /**
   * tentamos há pouco e não deu — sem sobrenome, trava de unidade, dois pacientes no telefone, Kommo fora, ou casou com
   * paciente que já existe: tentar a cada mensagem seria uma leitura do Kommo (e uma busca na franquia) por mensagem
   */
  | 'tentou-ha-pouco'
  | 'nova';

/** Quanto esperar para tentar de novo um lead que não passou (ex.: só tem o primeiro nome). */
export const ESPERA_ENTRE_TENTATIVAS_MS = 10 * 60_000;

/** Quantas vezes a IA lê a conversa de um mesmo lead orgânico. Depois disso vale a última leitura. */
export const MAX_LEITURAS_DA_IA = 3;
/** E o intervalo mínimo entre duas leituras do mesmo lead. */
export const ESPERA_ENTRE_LEITURAS_MS = 10 * 60_000;

export interface DepsDoCadastro {
  situacaoNaFranquia(unitId: string, leadId: number): Promise<SituacaoNaFranquia>;
  telefoneDaConversa(unitId: string, leadId: number): Promise<string | null>;
  /** O casamento cartão × paciente (regra de 16/10) está LIGADO nesta unidade? Sem ele, lead novo duplica paciente que já existe. */
  casamentoLigado(slug: string): boolean;
  /** Slugs das conversas com este telefone nos últimos 30 dias. Lança se o banco falhar. */
  unidadesDoTelefone(chave8: string): Promise<string[]>;
  /** O anúncio que trouxe o lead, lido do cartão do Kommo. `null` = cartão sem rastreio (ou não deu para ler: na dúvida é orgânico). */
  anuncioDoLead(unit: UnidadeMinima, leadId: number): Promise<AnuncioDeOrigem | null>;
  /** As últimas falas DO PACIENTE (nunca as da IA), da mais antiga para a mais nova. Lança se o banco falhar. */
  falasDoPaciente(unit: UnidadeMinima, leadId: number): Promise<string[]>;
  /** A IA lê as falas e decide. Nunca lança: a falha vem como `duvida`. */
  avaliarPelaIa(unit: UnidadeMinima, falas: readonly string[]): Promise<DecisaoDaIa>;
}

const VALIDADE_DA_CONSULTA_MS = 10 * 60_000;
const consultas = new Map<string, { em: number; slugs: string[] }>();

export const depsPadrao: DepsDoCadastro = {
  async situacaoNaFranquia(unitId, leadId) {
    const l = await prisma.spineLeadLink.findUnique({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } },
      select: { spineIdLead: true, spineIdClient: true, status: true, updatedAt: true },
    });
    // Vínculo só com `spineIdClient` (carga de implantação, widget "só cadastrar", Sofia ao cadastrar paciente) é gente que
    // JÁ está na franquia como paciente: criar um lead por cima duplica.
    if (l?.spineIdLead || l?.spineIdClient) return 'na-franquia';
    if (l && (l.status === 'ignorado' || l.status === 'falhou') && Date.now() - l.updatedAt.getTime() < ESPERA_ENTRE_TENTATIVAS_MS) {
      return 'tentou-ha-pouco';
    }
    // A espera também vale para o que o sincronizador não grava no banco (trava de unidade, dois pacientes no telefone).
    if (tentouHaPouco(unitId, leadId)) return 'tentou-ha-pouco';
    return 'nova';
  },
  casamentoLigado: (slug) => estadoCasamentoJornada(slug) === 'ligado',
  async telefoneDaConversa(unitId, leadId) {
    const c = await prisma.conversation.findUnique({
      where: { unitId_leadId: { unitId, leadId: String(leadId) } },
      select: { phone: true },
    });
    return c?.phone ?? null;
  },
  async unidadesDoTelefone(chave8) {
    const agora = Date.now();
    const guardada = consultas.get(chave8);
    if (guardada && agora - guardada.em < VALIDADE_DA_CONSULTA_MS) return guardada.slugs;
    const desde = new Date(agora - DIAS_DA_TRAVA * 86_400_000);
    // `[^0-9]` e não `\D`: dentro do template do Prisma a contrabarra vira escape inválido.
    const linhas = await prisma.$queryRaw<Array<{ slug: string }>>`
      SELECT DISTINCT un.slug AS slug
        FROM conversations c
        JOIN units un ON un.id = c.unit_id
       WHERE c.last_message_at >= ${desde}
         AND c.phone IS NOT NULL
         AND RIGHT(REGEXP_REPLACE(c.phone, '[^0-9]', '', 'g'), 8) = ${chave8}`;
    const slugs = linhas.map((l) => l.slug);
    if (consultas.size > 5_000) consultas.clear();
    consultas.set(chave8, { em: agora, slugs });
    return slugs;
  },
  async anuncioDoLead(unit, leadId) {
    // O webhook passa a `Unit` inteira; sem ela (`kommoSubdomain`) não há como ler o cartão. `estadoEtapaDoLead` tem cache
    // de 90 s e o prompt do mesmo turno acabou de ler este cartão: normalmente é um acerto de cache, sem ida ao Kommo.
    if (!('kommoSubdomain' in unit)) return null;
    const estado = await estadoEtapaDoLead(unit as unknown as Unit, leadId);
    return estado?.anuncio ?? null;
  },
  async falasDoPaciente(unit, leadId) {
    const linhas = await prisma.message.findMany({
      where: { role: 'user', conversation: { unitId: unit.id, leadId: String(leadId) } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { content: true },
    });
    return linhas.map((l) => l.content).reverse();
  },
  avaliarPelaIa: (unit, falas) => avaliarPelaIa(unit as UnidadeDaIa, falas),
};

// ── quem passou nas travas e não agendou: anúncio é lead; o resto, a IA lê ─────────────────────

interface Leitura {
  feitas: number;
  em: number;
  /** O que o paciente tinha escrito quando a IA leu (tamanho + última fala): sem fala nova, ler de novo seria pagar pela mesma resposta. */
  visto: string;
  veredito: DecisaoDaIa;
}
/** Memória do processo, como o resto do arquivo: reiniciar só devolve ao lead as leituras que ele já gastou. */
const leituras = new Map<string, Leitura>();
const leiturasEmCurso = new Map<string, Promise<Triagem>>();

function triagemDaLeitura(l: Leitura, nova: boolean): Triagem {
  const marca = { feitas: l.feitas, maximo: MAX_LEITURAS_DA_IA, nova };
  switch (l.veredito.decisao) {
    case 'lead':
      return { acao: 'cadastrar', origem: 'ia', motivo: `a IA leu a conversa e viu interesse real — ${l.veredito.motivo}`, leituras: marca };
    case 'nao_lead':
      return { acao: 'nao-lead', motivo: l.veredito.motivo, leituras: marca };
    default:
      return { acao: 'duvida', motivo: l.veredito.motivo, leituras: marca };
  }
}

async function lerAConversa(unit: UnidadeMinima, leadId: number, deps: DepsDoCadastro): Promise<Triagem> {
  const chave = `${unit.id}|${leadId}`;
  const antes = leituras.get(chave);
  // `lead` é definitivo: a IA já viu interesse real. Daí em diante só o sincronizador decide (sobrenome, franquia...).
  // `nao_lead` e `duvida` valem até a próxima leitura, que só acontece com o intervalo e o teto abaixo.
  if (antes?.veredito.decisao === 'lead') return triagemDaLeitura(antes, false);
  if (antes && (antes.feitas >= MAX_LEITURAS_DA_IA || Date.now() - antes.em < ESPERA_ENTRE_LEITURAS_MS)) return triagemDaLeitura(antes, false);

  let falas: string[];
  try {
    falas = await deps.falasDoPaciente(unit, leadId);
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'cadastro-todo-lead: falha ao ler as mensagens do paciente');
    return { acao: 'duvida', motivo: 'não consegui ler as mensagens do paciente para a IA avaliar' };
  }
  falas = falas.map((f) => String(f ?? '').trim()).filter(Boolean);
  if (falas.length === 0) return { acao: 'duvida', motivo: 'ainda não há mensagem de texto do paciente para a IA ler' };
  const visto = `${falas.length}|${falas[falas.length - 1]}`;
  if (antes && antes.visto === visto) return triagemDaLeitura(antes, false);

  let veredito: DecisaoDaIa;
  try {
    veredito = await deps.avaliarPelaIa(unit, falas);
    if (!veredito || !['lead', 'nao_lead', 'duvida'].includes(veredito.decisao)) throw new Error('resposta fora do formato');
  } catch (err) {
    veredito = { decisao: 'duvida', motivo: 'a IA não conseguiu avaliar', falhou: true };
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'cadastro-todo-lead: leitura da IA falhou — dúvida');
  }
  // A leitura que falhou também gasta uma das 3: um problema na API não pode virar uma chamada por mensagem.
  const nova: Leitura = { feitas: (antes?.feitas ?? 0) + 1, em: Date.now(), visto, veredito };
  if (leituras.size > 20_000) leituras.clear();
  leituras.set(chave, nova);
  return triagemDaLeitura(nova, true);
}

/**
 * Passou nas travas e não agendou: é lead? Veio de anúncio (rastreio no cartão) = lead, sempre. Senão a IA lê as falas.
 * Nunca lança. Duas mensagens em rajada do mesmo lead dividem UMA leitura.
 */
async function triarOrigem(unit: UnidadeMinima, leadId: number, deps: DepsDoCadastro): Promise<Triagem> {
  try {
    const anuncio = await deps.anuncioDoLead(unit, leadId).catch((err) => {
      logger.warn({ err: String(err), leadId, unit: unit.slug }, 'cadastro-todo-lead: não consegui ler o cartão para ver o anúncio — trato como orgânico');
      return null;
    });
    if (veioDeAnuncio(anuncio)) {
      return { acao: 'cadastrar', origem: 'anuncio', motivo: `lead novo — veio de anúncio (${resumoDaOrigem(anuncio!)})` };
    }
    const chave = `${unit.id}|${leadId}`;
    const emCurso = leiturasEmCurso.get(chave);
    if (emCurso) return await emCurso;
    const p = lerAConversa(unit, leadId, deps).finally(() => leiturasEmCurso.delete(chave));
    leiturasEmCurso.set(chave, p);
    return await p;
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'cadastro-todo-lead: falha ao triar a origem — dúvida');
    return { acao: 'duvida', motivo: 'não consegui triar a origem do lead' };
  }
}

/** Só para teste. */
export function _limparCacheParaTeste(): void {
  consultas.clear();
  logsVistos.clear();
  emAndamento.clear();
  ultimasTentativas.clear();
  leituras.clear();
  leiturasEmCurso.clear();
}

// ── o log: uma linha por decisão, não por mensagem ───────────────────────────────────────────

const logsVistos = new Map<string, number>();
const REPETIR_LOG_A_CADA_MS = 3600_000;

function jaLogado(chave: string): boolean {
  const agora = Date.now();
  if (agora - (logsVistos.get(chave) ?? 0) < REPETIR_LOG_A_CADA_MS) return true;
  logsVistos.set(chave, agora);
  if (logsVistos.size > 20_000) for (const [k, t] of logsVistos) if (agora - t > REPETIR_LOG_A_CADA_MS) logsVistos.delete(k);
  return false;
}

type UnidadeMinima = { id: string; slug: string };

function registrarDecisao(unit: UnidadeMinima, leadId: number, estado: Estado, t: Triagem, telefone: string | null, legado: DecisaoDeCadastro): void {
  const seco = estado === 'seco';
  const rotulo = seco ? ' [seco]' : '';
  const base = { leadId, unit: unit.slug, estado, telefone: finalDoTelefone(telefone) };

  if (t.acao === 'cadastrar') {
    // Só o seco registra o "cadastraria" (ligado, quem cadastra já aparece no log do sincronizador). Uma linha por lead
    // avaliado, também para quem a regra de 26/09 já cadastraria: é o que deixa contar a cobertura (leads novos por dia
    // × leads avaliados aqui) — ver "Limitação" na descrição da automação.
    if (!seco || jaLogado(`${unit.id}|${leadId}|cadastraria`)) return;
    const como = t.origem === 'ia' ? 'cadastraria pela IA' : t.origem === 'anuncio' ? 'cadastraria (anúncio)' : 'cadastraria';
    // `decisao` segue 'cadastraria' (quem conta cobertura no log não muda a consulta); `origem` diz por quê.
    logger.info({ ...base, decisao: 'cadastraria', origem: t.origem, leituras: t.leituras, jaCadastrariaPela26_09: legado.criar }, `cadastro-todo-lead${rotulo}: ${como} — ${t.motivo}`);
    if (!legado.criar) {
      const valor = t.origem === 'ia' ? 'lead novo (a IA leu a conversa)' : t.origem === 'anuncio' ? 'lead novo (veio de anúncio)' : 'lead novo';
      registrarSimulacao(unit, ID_AUTOMACAO, { leadId, acao: 'gravaria', alvo: 'cadastro do lead na franquia', valor, motivo: t.motivo });
    }
    return;
  }

  if (t.acao === 'nao-lead' || t.acao === 'duvida') {
    const ehNaoLead = t.acao === 'nao-lead';
    const decisao = ehNaoLead ? 'barrou-pela-ia' : 'duvida-da-ia';
    // Uma linha por LEITURA (não por mensagem): o número da leitura entra na chave.
    if (jaLogado(`${unit.id}|${leadId}|${decisao}|${t.leituras?.feitas ?? 0}`)) return;
    const quando = t.leituras ? ` (leitura ${t.leituras.feitas} de ${t.leituras.maximo})` : '';
    const texto = ehNaoLead
      ? `${seco ? 'barraria' : 'barrou'} pela IA: ${t.motivo}${quando}${seco ? ' (seco: nada foi barrado de verdade)' : ''}`
      : `dúvida — ${t.motivo}${quando}; ${seco ? 'não cadastraria agora' : 'não cadastra agora'} e reavalia numa mensagem futura`;
    logger.info({ ...base, decisao, leituras: t.leituras }, `cadastro-todo-lead${rotulo}: ${texto}`);
    registrarSimulacao(unit, ID_AUTOMACAO, { leadId, acao: 'pularia', alvo: 'cadastro do lead na franquia', valor: ehNaoLead ? 'nao-lead-pela-ia' : 'duvida-da-ia', motivo: t.motivo });
    return;
  }

  const decisao =
    t.acao === 'interno' ? 'barrou-interno' : t.acao === 'varias-unidades' ? 'barrou-3-unidades' : t.acao === 'sem-telefone' ? 'sem-telefone' : t.acao === 'sem-casamento' ? 'sem-casamento-jornada' : t.acao === 'sem-lista' ? 'sem-lista-de-internos' : 'erro-na-consulta';
  if (jaLogado(`${unit.id}|${leadId}|${decisao}`)) return;
  const texto =
    t.acao === 'interno' ? 'barrou interno' : t.acao === 'varias-unidades' ? 'barrou 3+ unidades' : t.acao === 'sem-telefone' ? 'sem telefone' : t.acao === 'sem-casamento' ? 'não cadastra (casamento-jornada desligado)' : t.acao === 'sem-lista' ? 'não cadastra (NUMEROS_INTERNOS vazia)' : 'consulta falhou';
  const aviso = { ...base, decisao, unidades: t.unidades, criariaMesmoAssim: seco ? legado.criar : undefined };
  const msg = `cadastro-todo-lead${rotulo}: ${texto} — ${t.motivo}${seco ? ' (seco: nada foi barrado de verdade)' : ''}`;
  // 3+ unidades é o que pede olho humano; o resto é rotina.
  if (t.acao === 'varias-unidades' || t.acao === 'erro' || t.acao === 'sem-lista') logger.warn(aviso, msg);
  else logger.info(aviso, msg);
  registrarSimulacao(unit, ID_AUTOMACAO, { leadId, acao: 'pularia', alvo: 'cadastro do lead na franquia', valor: decisao, motivo: t.motivo });
}

/** O que o webhook faz: `soLead` = cria o LEAD e não o paciente (paciente continua só ao agendar). */
export interface DecisaoDoLead extends DecisaoDeCadastro {
  soLead?: boolean;
  /** Decisão de rotina (já está lá, esperando a próxima tentativa): o webhook não precisa de uma linha de log por mensagem. */
  silenciosa?: boolean;
}

/**
 * Decide se este lead é criado na franquia. `legado` é o que a regra de 26/09 disse.
 *
 * Nunca lança: erro aqui cai em "como estava" quando o estado não é ligado, e em "como estava" também
 * quando é ligado mas a dúvida é sobre quem JÁ ia ser cadastrado (agendou) — quem só conversou, na dúvida, fica de fora.
 */
export async function decidirCadastroDoLead(
  entrada: { unit: UnidadeMinima; leadId: number; legado: DecisaoDeCadastro },
  deps: DepsDoCadastro = depsPadrao,
): Promise<DecisaoDoLead> {
  const { unit, leadId, legado } = entrada;
  const estado = estadoCadastroTodoLead(unit.slug);
  if (estado === 'desligado') return legado;

  try {
    const situacao = await deps.situacaoNaFranquia(unit.id, leadId);
    // Já está lá: nada a criar. Devolver "não" poupa a leitura do Kommo que o sincronizador faria a cada mensagem.
    // (Não perde o paciente de quem agenda depois: com o vínculo pronto, `syncLeadToSpine` já devolvia "ja-enviado" antes
    // de qualquer criação de paciente. Paciente nasce em `cadastrar_paciente`/`syncPatientToSpine`, que não mudam.)
    if (situacao === 'na-franquia') return estado === 'ligado' ? { criar: false, motivo: 'já está na franquia', silenciosa: true } : legado;
    // Quem acabou de agendar não espera: o sobrenome pode ter vindo agora.
    if (situacao === 'tentou-ha-pouco' && !legado.criar) {
      return estado === 'ligado' ? { criar: false, motivo: 'tentei há pouco e faltou dado (sobrenome) — tento de novo em alguns minutos', silenciosa: true } : legado;
    }

    const telefone = await deps.telefoneDaConversa(unit.id, leadId);
    const chave = ultimos8(telefone);
    let unidades: string[] | null = null;
    if (chave && !ehNumeroInterno(telefone)) {
      unidades = await deps.unidadesDoTelefone(chave).catch((err) => {
        logger.warn({ err: String(err), leadId, unit: unit.slug }, 'cadastro-todo-lead: falha ao contar as unidades do telefone');
        return null;
      });
    }
    let triagem = triar(telefone, unidades);
    // "Só lead" sem o casamento cartão × paciente cria lead em cima de quem já é paciente da franquia (a busca por
    // idClient → telefone → nome é do casamento). Quem já ia entrar pela regra de 26/09 (agendou) segue como segue hoje.
    if (triagem.acao === 'cadastrar' && !legado.criar && !deps.casamentoLigado(unit.slug)) {
      triagem = {
        acao: 'sem-casamento',
        motivo: MOTIVO_SEM_CASAMENTO,
      };
    }
    // Passou nas travas e só conversou (não agendou): anúncio é lead; o resto a IA lê (`triarOrigem`, nunca lança).
    // Quem agendou já deixou de ser dúvida: segue como segue hoje, sem gastar a leitura.
    if (triagem.acao === 'cadastrar' && !legado.criar) triagem = await triarOrigem(unit, leadId, deps);
    registrarDecisao(unit, leadId, estado, triagem, telefone, legado);

    if (estado === 'seco') return legado;
    if (triagem.acao === 'cadastrar') return { criar: true, motivo: triagem.motivo, soLead: !legado.criar };
    // A IA barrou ou não sabe: sem linha de log por mensagem no webhook (o log da decisão já é por leitura).
    if (triagem.acao === 'nao-lead' || triagem.acao === 'duvida') return { criar: false, motivo: `${triagem.acao}: ${triagem.motivo}`, silenciosa: true };
    // Não deu para conferir (sem telefone, banco fora): quem já ia entrar pela regra de 26/09 (agendou) entra como entrava;
    // quem só conversou fica de fora e é reavaliado na próxima mensagem.
    if ((triagem.acao === 'sem-telefone' || triagem.acao === 'erro' || triagem.acao === 'sem-lista') && legado.criar) return legado;
    return { criar: false, motivo: `${triagem.acao}: ${triagem.motivo}` };
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug, estado }, 'cadastro-todo-lead: falha ao decidir');
    return estado === 'ligado' && !legado.criar ? { criar: false, motivo: 'erro: não consegui conferir — tenta na próxima mensagem' } : legado;
  }
}

/**
 * Depois de criar o lead, o sincronizador cria também o PACIENTE quando a unidade tem `spine_sync_patients`.
 * Lead cadastrado só porque entrou em contato (`soLead`) nunca vira paciente: paciente continua só ao agendar.
 */
export function criaPacienteJuntoComOLead(spineSyncPatients: boolean, soLead: boolean | undefined): boolean {
  return spineSyncPatients && !soLead;
}

// ── um cadastro por vez, por lead — e espera entre tentativas ───────────────────────────────

const emAndamento = new Set<string>();
/** Quando cada lead foi tentado pela última vez (qualquer resultado). Memória do processo: reiniciar só custa uma leitura a mais. */
const ultimasTentativas = new Map<string, number>();

function tentouHaPouco(unitId: string, leadId: number): boolean {
  const t = ultimasTentativas.get(`${unitId}|${leadId}`);
  return t !== undefined && Date.now() - t < ESPERA_ENTRE_TENTATIVAS_MS;
}

/**
 * Duas mensagens seguidas do mesmo lead não podem criar duas vezes na franquia. Com a regra de 26/09
 * isto quase não acontecia (só depois de agendar); com "toda primeira mensagem" a rajada é o normal.
 * Vale também com a automação DESLIGADA (é o mesmo caminho de sempre, só sem a sobreposição).
 *
 * Marca a tentativa ao terminar, seja qual for o resultado: o sincronizador sai sem gravar nada em vários caminhos
 * (trava Petrópolis × Caxias, dois pacientes no telefone, nome incompleto) e a espera de 10 minutos precisa respeitar todos.
 */
export async function umCadastroPorVez<T>(unitId: string, leadId: number, fn: () => Promise<T>): Promise<T | undefined> {
  const chave = `${unitId}|${leadId}`;
  if (emAndamento.has(chave)) {
    // Sem retentativa de propósito: o que faltar (nome, telefone) a próxima mensagem reavalia. Limite conhecido: se esta
    // chamada era a do agendamento e a em andamento é a de "só lead", o paciente que `spine_sync_patients` criaria junto
    // com o lead não nasce por aqui — a chave está desligada em todas as unidades, e o paciente vem do `cadastrar_paciente`.
    logger.info({ leadId, unitId }, 'cadastro-todo-lead: já há um cadastro deste lead em andamento — pulei esta chamada');
    return undefined;
  }
  emAndamento.add(chave);
  try {
    return await fn();
  } finally {
    emAndamento.delete(chave);
    if (ultimasTentativas.size > 20_000) ultimasTentativas.clear();
    ultimasTentativas.set(chave, Date.now());
  }
}

// ── o gancho do webhook ──────────────────────────────────────────────────────────────────────

/** A assinatura de `syncLeadToSpine`: o webhook passa a própria função, sem um lambda no meio que possa esquecer de repassar `soLead`. */
export type SincronizarLead<U> = (unit: U, leadId: number, opcoes: { soLead?: boolean }) => Promise<unknown>;

/**
 * O que o fim do turno da IA faz com o lead: decide e, se for o caso, dispara o cadastro (sem esperar por ele).
 * Fica aqui, e não no webhook, para o "só lead" e a trava de concorrência terem teste no caminho que roda de verdade.
 * `execucao` é a promessa do cadastro disparado (`null` se não houve) — o webhook a ignora, o teste a espera.
 */
export async function cadastrarLeadDoTurno<U extends UnidadeMinima>(
  entrada: { unit: U; leadId: number; ferramentas: string[] },
  sincronizar: SincronizarLead<U>,
  deps: DepsDoCadastro = depsPadrao,
): Promise<{ decisao: DecisaoDoLead; execucao: Promise<unknown> | null }> {
  const { unit, leadId } = entrada;
  const decisao = await decidirCadastroDoLead({ unit, leadId, legado: deveCriarNaFranquia({ ferramentas: entrada.ferramentas }) }, deps);
  if (!decisao.criar) return { decisao, execucao: null };
  const execucao = umCadastroPorVez(unit.id, leadId, () => sincronizar(unit, leadId, { soLead: decisao.soLead })).catch((err) => {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'spine-sync: erro inesperado');
  });
  return { decisao, execucao };
}
