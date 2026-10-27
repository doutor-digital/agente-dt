/**
 * Todo lead que entra em contato vira LEAD na franquia — menos número interno.
 *
 * Decisão do João em 27/10/2026, a pedido da Suzanne (a franquia mudou a regra): a IA cadastra na
 * franquia, como LEAD e já na primeira mensagem, quem entra em contato. Isto reverte, para o lead, a
 * regra de 26/09 (`cadastro-na-franquia.ts`: "só vira lead quem agenda"). PACIENTE continua só ao
 * agendar: `syncPatientToSpine`, `cadastrar_paciente` e `spine_sync_patients` não mudam.
 *
 * Duas travas, porque funcionária, equipe e prospecção de marketing também escrevem para a Sofia e
 * não podem entrar na base da franqueadora:
 *  1. lista explícita (`NUMEROS_INTERNOS`, ver `numeros-internos.ts`), pelos últimos 8 dígitos;
 *  2. trava automática: o mesmo telefone em conversas de 3 ou mais unidades distintas em 30 dias
 *     (junta `X` e `X-resgate`, ignora `hm-tecnologia`) não é gente — é rede, ou lista de marketing.
 *     Fica marcado no log e na tela "só no papel" para um humano olhar.
 *
 * ESTADOS (chave `CADASTRO_TODO_LEAD_SLUGS`, tela de Automações):
 *  - desligado (padrão): vale a regra de 26/09, byte a byte. Nenhuma consulta nova ao banco.
 *  - seco: a regra de 26/09 continua decidindo; a nova só DECIDE E LOGA ("cadastraria", "barrou
 *    interno", "barrou 3+ unidades") e grava na tela "só no papel". Não cria nada a mais.
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
import { ehNumeroInterno, ultimos8 } from './numeros-internos.js';
import type { DecisaoDeCadastro } from './cadastro-na-franquia.js';

export const ID_AUTOMACAO = 'cadastro-todo-lead';

/** A trava automática: este tanto de unidades distintas com o mesmo telefone... */
export const UNIDADES_PARA_TRAVAR = 3;
/** ...nesta janela. */
export const DIAS_DA_TRAVA = 30;

/** Empresa do grupo, não clínica: o telefone dela aparece em conversas de teste, não conta como unidade. */
const UNIDADES_IGNORADAS = new Set(['hm-tecnologia']);
/** `acailandia-resgate`, `imperatriz-financeiro`: dividem a conta da unidade dona, não são outra clínica. */
const CONTA_COMPARTILHADA = /-(resgate|tratamento|financeiro)$/;

export function estadoCadastroTodoLead(slug: string, raw: string | undefined = process.env.CADASTRO_TODO_LEAD_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_AUTOMACAO, raw);
}

/** `X-resgate` → `X`. */
export function unidadeBase(slug: string): string {
  return slug.trim().toLowerCase().replace(CONTA_COMPARTILHADA, '');
}

/** As unidades distintas da lista, juntando `X` e `X-resgate` e sem as empresas do grupo. */
export function unidadesDistintas(slugs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of slugs) {
    const base = unidadeBase(s);
    if (base && !UNIDADES_IGNORADAS.has(base)) out.add(base);
  }
  return [...out].sort();
}

export type AcaoDaTriagem = 'cadastrar' | 'interno' | 'varias-unidades' | 'sem-telefone' | 'erro';

export interface Triagem {
  acao: AcaoDaTriagem;
  motivo: string;
  unidades?: string[];
}

/** Os últimos 4 dígitos, para o log dizer de quem se trata sem gravar o telefone inteiro. */
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
  /** tentamos há pouco e não deu (sem sobrenome, Kommo fora): tentar a cada mensagem seria uma leitura do Kommo por mensagem */
  | 'tentou-ha-pouco'
  | 'nova';

/** Quanto esperar para tentar de novo um lead que não passou (ex.: só tem o primeiro nome). */
export const ESPERA_ENTRE_TENTATIVAS_MS = 10 * 60_000;

export interface DepsDoCadastro {
  situacaoNaFranquia(unitId: string, leadId: number): Promise<SituacaoNaFranquia>;
  telefoneDaConversa(unitId: string, leadId: number): Promise<string | null>;
  /** Slugs das conversas com este telefone nos últimos 30 dias. Lança se o banco falhar. */
  unidadesDoTelefone(chave8: string): Promise<string[]>;
}

const VALIDADE_DA_CONSULTA_MS = 10 * 60_000;
const consultas = new Map<string, { em: number; slugs: string[] }>();

export const depsPadrao: DepsDoCadastro = {
  async situacaoNaFranquia(unitId, leadId) {
    const l = await prisma.spineLeadLink.findUnique({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } },
      select: { spineIdLead: true, status: true, updatedAt: true },
    });
    if (l?.spineIdLead) return 'na-franquia';
    if (l && (l.status === 'ignorado' || l.status === 'falhou') && Date.now() - l.updatedAt.getTime() < ESPERA_ENTRE_TENTATIVAS_MS) {
      return 'tentou-ha-pouco';
    }
    return 'nova';
  },
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
};

/** Só para teste. */
export function _limparCacheParaTeste(): void {
  consultas.clear();
  logsVistos.clear();
  emAndamento.clear();
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
    // Em seco, o que importa é o que a regra de 26/09 NÃO cadastraria; quem ela já cadastra não é novidade.
    if (!seco || legado.criar || jaLogado(`${unit.id}|${leadId}|cadastraria`)) return;
    logger.info({ ...base, decisao: 'cadastraria' }, `cadastro-todo-lead${rotulo}: cadastraria — ${t.motivo}`);
    registrarSimulacao(unit, ID_AUTOMACAO, { leadId, acao: 'gravaria', alvo: 'cadastro do lead na franquia', valor: 'lead novo', motivo: t.motivo });
    return;
  }

  const decisao = t.acao === 'interno' ? 'barrou-interno' : t.acao === 'varias-unidades' ? 'barrou-3-unidades' : t.acao === 'sem-telefone' ? 'sem-telefone' : 'erro-na-consulta';
  if (jaLogado(`${unit.id}|${leadId}|${decisao}`)) return;
  const texto =
    t.acao === 'interno' ? 'barrou interno' : t.acao === 'varias-unidades' ? 'barrou 3+ unidades' : t.acao === 'sem-telefone' ? 'sem telefone' : 'consulta falhou';
  const aviso = { ...base, decisao, unidades: t.unidades, criariaMesmoAssim: seco ? legado.criar : undefined };
  const msg = `cadastro-todo-lead${rotulo}: ${texto} — ${t.motivo}${seco ? ' (seco: nada foi barrado de verdade)' : ''}`;
  // 3+ unidades é o que pede olho humano; o resto é rotina.
  if (t.acao === 'varias-unidades' || t.acao === 'erro') logger.warn(aviso, msg);
  else logger.info(aviso, msg);
  registrarSimulacao(unit, ID_AUTOMACAO, { leadId, acao: 'pularia', alvo: 'cadastro do lead na franquia', valor: decisao, motivo: t.motivo });
}

/** O que o webhook faz: `soLead` = cria o LEAD e não o paciente (paciente continua só ao agendar). */
export interface DecisaoDoLead extends DecisaoDeCadastro {
  soLead?: boolean;
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
    if (situacao === 'na-franquia') return estado === 'ligado' ? { criar: false, motivo: 'já está na franquia' } : legado;
    // Quem acabou de agendar não espera: o sobrenome pode ter vindo agora.
    if (situacao === 'tentou-ha-pouco' && !legado.criar) {
      return estado === 'ligado' ? { criar: false, motivo: 'tentei há pouco e faltou dado (sobrenome) — tento de novo em alguns minutos' } : legado;
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
    const triagem = triar(telefone, unidades);
    registrarDecisao(unit, leadId, estado, triagem, telefone, legado);

    if (estado === 'seco') return legado;
    if (triagem.acao === 'cadastrar') return { criar: true, motivo: triagem.motivo, soLead: !legado.criar };
    // Não deu para conferir (sem telefone, banco fora): quem já ia entrar pela regra de 26/09 (agendou) entra como entrava;
    // quem só conversou fica de fora e é reavaliado na próxima mensagem.
    if ((triagem.acao === 'sem-telefone' || triagem.acao === 'erro') && legado.criar) return legado;
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

// ── um cadastro por vez, por lead ────────────────────────────────────────────────────────────

const emAndamento = new Set<string>();

/**
 * Duas mensagens seguidas do mesmo lead não podem criar duas vezes na franquia. Com a regra de 26/09
 * isto quase não acontecia (só depois de agendar); com "toda primeira mensagem" a rajada é o normal.
 */
export async function umCadastroPorVez<T>(unitId: string, leadId: number, fn: () => Promise<T>): Promise<T | undefined> {
  const chave = `${unitId}|${leadId}`;
  if (emAndamento.has(chave)) {
    // Sem retentativa de propósito: o cadastro do lead acontece uma vez e o que faltar (nome, telefone) a próxima
    // mensagem reavalia — nada aqui é "atualização" que a segunda mensagem perderia.
    logger.info({ leadId, unitId }, 'cadastro-todo-lead: já há um cadastro deste lead em andamento — pulei esta chamada');
    return undefined;
  }
  emAndamento.add(chave);
  try {
    return await fn();
  } finally {
    emAndamento.delete(chave);
  }
}
