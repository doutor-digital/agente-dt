/**
 * O worker da lista «Agendados sem Pix» (`agendados-sem-pix.ts`): de 5 em 5 minutos olha as unidades que têm banco na Pluggy e decide, por unidade, se já é hora da lista
 * do dia. Quase sempre não é (fora do horário, já feita, estado desligado): essas voltas não tocam agenda nem extrato (só a lista de unidades). O líder dos workers (`worker-lease.ts`) é quem o sobe.
 *
 * As fontes reais: a agenda da franquia (`searchSchedules`, a mesma leitura do resto do agente), o banco pelo cliente compartilhado da Pluggy (o mesmo do conector, com o
 * cache de item e contas) e a Evolution que já manda os avisos à recepção. Nada aqui escreve na franquia, no Kommo nem no banco da Pluggy: a única escrita é a marca do dia.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import axios from 'axios';
import { naoConectou } from './alerta-whatsapp.js';
import { dataLocalISO, ehFeriadoNacional, ehFeriadoNacionalAgora } from './feriados.js';
import { fusoDaUnidade, partesNoFuso } from './fuso.js';
import { destinoDoAvisoClinica } from './aviso-clinica-agendamento.js';
import { unidadeSemAntecipado } from '../agent/pagamento-da-unidade.js';
import { clienteCompartilhado, lerItensDoAmbiente, resolverEmpresas } from './integracoes/pluggy.js';
import { entradasDoBanco, valoresDaOperacaoInvalidos, valoresDaUnidade } from './pix-casamento.js';
import {
  ID_DA_AUTOMACAO,
  cicloDaUnidade,
  estadoDaLista,
  ehAvaliacao,
  type Agendado,
  type DepsDoCiclo,
  type LeituraDoBanco,
  type MarcaDaLista,
  type UnidadeDaLista,
} from './agendados-sem-pix.js';
import { criarContextoPluggy, lerPeriodo, type ContextoPluggy } from '../mcp-remoto/pluggy.js';
import { SPINE_STATUS, instanteNoFuso, searchSchedules, somarDias } from '../services/spine.service.js';

const PASSO_MS = 5 * 60_000;
const PRIMEIRA_VOLTA_MS = 90_000;
/** A agenda guardada por unidade/dia: esperar o banco repete a pergunta a cada 5 min, e a agenda não muda tanto. */
const AGENDA_GUARDADA_MS = 30 * 60_000;
/** Marcações até tantos dias à frente. */
const HORIZONTE_DIAS = 45;

// ----------------------------------------------------------------------------------------------------------------- a marca do dia

const codigoDoErro = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

/**
 * A marca é um rastro `manual` com id FIXO por unidade/dia/modo (P2002 = já existe: dois processos e dois reinícios nunca mandam a mesma lista duas vezes). O estado mora no
 * payload do passo; o rastro é sempre `SUCCESS` (RUNNING apareceria como «turno preso»). O texto do modo seco fica no mesmo payload: é o que a tela de rastros mostra.
 */
export const marcaNoBanco: MarcaDaLista = {
  async ler(id) {
    const linhas = await prisma.$queryRaw<Array<{ estado: string | null; payload: Record<string, unknown> | null }>>`SELECT payload->>'estado' AS "estado", payload AS "payload" FROM execution_steps WHERE trace_id = ${id} LIMIT 1`;
    return linhas.length ? { estado: linhas[0]!.estado ?? 'desconhecido', payload: linhas[0]!.payload ?? {} } : null;
  },
  async reivindicar(id, a) {
    try {
      await prisma.executionTrace.create({
        data: {
          id,
          unitId: a.unitId,
          leadId: '0',
          threadId: id,
          input: { origem: ID_DA_AUTOMACAO },
          channel: 'manual',
          status: 'SUCCESS',
          steps: { create: { sequence: 0, kind: 'KOMMO_ACTION', title: a.titulo, payload: { ...a.payload, estado: a.estado } as Prisma.InputJsonObject } },
        },
      });
      return 'novo';
    } catch (err) {
      if (codigoDoErro(err) !== 'P2002') {
        logger.warn({ err: String(err), id }, `${ID_DA_AUTOMACAO}: não consegui gravar a marca do dia`);
        return 'erro';
      }
      if (a.estado !== 'enviando') return 'repetido';
      // a marca estava `pendente` (a Evolution recusou antes): o primeiro a pegar ganha a nova tentativa
      try {
        const n = await prisma.$executeRaw`UPDATE execution_steps SET payload = jsonb_set(payload, '{estado}', '"enviando"') WHERE trace_id = ${id} AND payload->>'estado' = 'pendente'`;
        return n > 0 ? 'novo' : 'repetido';
      } catch (err2) {
        logger.warn({ err: String(err2), id }, `${ID_DA_AUTOMACAO}: não consegui reabrir a marca`);
        return 'erro';
      }
    }
  },
  async concluir(id, estado, patch = {}) {
    await prisma
      .$executeRaw`UPDATE execution_steps SET payload = (payload || ${JSON.stringify(patch)}::jsonb) || jsonb_build_object('estado', ${estado}::text) WHERE trace_id = ${id}`
      .catch((err: unknown) => logger.warn({ err: String(err), id, estado }, `${ID_DA_AUTOMACAO}: não consegui anotar o desfecho na marca`));
  },
};

// ----------------------------------------------------------------------------------------------------------------- fontes

/**
 * O envio ao grupo, com a diferença que importa: 4xx (a Evolution RESPONDEU que recusou) e «nem conectou» = `recusado` (não saiu; pode repetir, no limite); 5xx, sem resposta,
 * estouro de prazo e conexão cortada = `incerto` (a mensagem PODE ter saído: repetir às cegas mandaria em dobro). Texto cortado em 1500, 15 s de prazo. Nunca lança.
 */
export function classificarFalhaDeEnvio(err: unknown): 'recusado' | 'incerto' {
  const status = Number((err as { response?: { status?: unknown } } | null)?.response?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) return 'recusado';
  if (Number.isInteger(status) && status >= 500 && status < 600) return 'incerto';
  return naoConectou(err) ? 'recusado' : 'incerto';
}

export async function enviarAoGrupo(a: { url: string; header: string; valor: string; numero: string; texto: string }, post: typeof axios.post = axios.post): Promise<'ok' | 'recusado' | 'incerto'> {
  try {
    await post(a.url, { number: a.numero, text: a.texto.slice(0, 1500) }, { headers: { 'Content-Type': 'application/json', [a.header]: a.valor }, timeout: 15_000 });
    return 'ok';
  } catch (err) {
    const r = classificarFalhaDeEnvio(err);
    logger.warn({ resultado: r, status: Number((err as { response?: { status?: unknown } } | null)?.response?.status) || undefined }, `${ID_DA_AUTOMACAO}: falha ao enviar ao grupo`);
    return r;
  }
}

const jaDisse = new Set<string>();
const valoresLogados = new Set<string>();
/** unidade → até quando não tentar ler a agenda de novo (depois de uma falha) */
const agendaComFalha = new Map<string, number>();
function avisarUmaVez(chave: string, msg: string): void {
  if (jaDisse.has(chave)) return;
  jaDisse.add(chave);
  logger.warn(msg);
}

/** Evolution que manda para o grupo: a própria desta lista ou a dos avisos à recepção (mesma instância); null = sem configuração. */
export function evolutionDaLista(env: NodeJS.ProcessEnv = process.env): { url: string; header: string; valor: string } | null {
  const url = env.AGENDADOS_SEM_PIX_EVOLUTION_URL || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL;
  const header = env.AGENDADOS_SEM_PIX_EVOLUTION_HEADER || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_HEADER || env.EVOLUTION_ALERT_HEADER;
  const valor = env.AGENDADOS_SEM_PIX_EVOLUTION_VALUE || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_VALUE || env.EVOLUTION_ALERT_VALUE;
  return url && header && valor ? { url, header, valor } : null;
}

/** O contexto da Pluggy deste processo (itens do PLUGGY_ITENS que viraram empresa de verdade + o cliente compartilhado), ou null se a Pluggy não está ligada. */
export async function contextoPluggyDoAmbiente(env: NodeJS.ProcessEnv = process.env): Promise<ContextoPluggy | null> {
  const lido = lerItensDoAmbiente(env.PLUGGY_ITENS);
  const fonte = clienteCompartilhado(env);
  if (!fonte || !lido.entradas.length) return null;
  const unidades = await prisma.unit.findMany({ select: { slug: true, name: true, isActive: true } });
  const r = resolverEmpresas(lido.entradas, unidades.map((u) => ({ slug: u.slug, nome: u.name, ativa: u.isActive })));
  return r.itens.length ? criarContextoPluggy(r.itens, fonte) : null;
}

const hora = (agora: Date, fuso: string): string => {
  const p = partesNoFuso(agora, fuso);
  return `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')} ${String(p.hora).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
};

type UnidadeDoBanco = Prisma.UnitGetPayload<{
  select: {
    id: true; slug: true; businessHoursTimezone: true; spineTimezone: true; spineBaseUrl: true; spineToken: true; spineAgendaDays: true;
    acceptsAdvancePayment: true; spineBookingRequiresPayment: true; sinalPixCentavos: true; sourceProdutos: true;
  };
}>;

const agendaGuardada = new Map<string, { ate: number; v: { agendados: Agendado[]; conhecidos: Array<string | null> } }>();
/** A agenda lida para saber quem são os pacientes conhecidos: de três semanas atrás a 45 dias à frente (cabe numa busca só, o limite da franquia é 100 dias). */
const CONHECIDOS_DESDE_DIAS = 21;

/**
 * Avaliação ou consulta (a que se paga antes, em qualquer grafia da categoria) ainda AGENDADA ou CONFIRMADA, que ainda NÃO aconteceu (hoje já passada fica de fora), com a última
 * alteração desde o dia útil anterior. Sessão, retorno e reavaliação não entram. Linha com `modified` ilegível é pulada (uma linha ruim não derruba a lista do dia).
 * CONFIRMADA entra com `marcacaoIncerta` (a alteração é a confirmação): nunca vira «não achei Pix».
 */
export async function agendadosRecentes(unit: UnidadeDoBanco, u: UnidadeDaLista, agora: number): Promise<{ agendados: Agendado[]; conhecidos: Array<string | null> } | null> {
  const chave = `${u.slug}:${u.hoje}`;
  let g = agendaGuardada.get(chave);
  if (!g || g.ate <= agora) {
    const r = await searchSchedules(unit, { initialDate: somarDias(u.hoje, -CONHECIDOS_DESDE_DIAS), endDate: somarDias(u.hoje, HORIZONTE_DIAS), rowsPerPage: 100 });
    if (!r.ok || !r.data) return null;
    // lista incompleta (teto de páginas): melhor não afirmar nada do que afirmar «não achei» sobre metade da agenda
    if (r.data.truncada) return null;
    const desde = u.agendadosDesde;
    const conhecidos = r.data.schedules.filter((s) => s.idStatus !== SPINE_STATUS.DESMARCADO).map((s) => s.clientName);
    const agendados = r.data.schedules
      .filter((s) => (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO) && ehAvaliacao(s.categoryName))
      .flatMap((s): Agendado[] => {
        const ms = s.modifiedUtc ? Date.parse(s.modifiedUtc) : NaN;
        if (!s.dayLocal || !s.timeLocal || Number.isNaN(ms)) return []; // sem data de alteração legível não dá para saber se é recente: pula só esta linha
        const agendadoEm = instanteNoFuso(new Date(ms), u.fuso).slice(0, 10);
        return agendadoEm >= desde ? [{ nome: s.clientName, dia: s.dayLocal, hora: s.timeLocal, agendadoEm, alteradoEmMs: ms, marcacaoIncerta: s.idStatus === SPINE_STATUS.CONFIRMADO, idSchedule: s.idSchedule }] : [];
      });
    for (const k of agendaGuardada.keys()) if (!k.endsWith(`:${u.hoje}`)) agendaGuardada.delete(k);
    g = { ate: agora + AGENDA_GUARDADA_MS, v: { agendados, conhecidos } };
    agendaGuardada.set(chave, g);
  }
  // consulta de hoje que já passou não precisa de lembrete de Pix: o corte é na hora da leitura, não na do cache
  const agoraLocal = instanteNoFuso(new Date(agora), u.fuso).slice(0, 16);
  return { agendados: g.v.agendados.filter((a) => `${a.dia}T${a.hora}` > agoraLocal), conhecidos: g.v.conhecidos };
}

/** O banco: status do item (guardado pelo cliente) e, só se atualizou hoje (ou é a última chance), o extrato — UMA leitura por conta. */
export async function lerBancoDaUnidade(ctx: ContextoPluggy, u: UnidadeDaLista, desde: string, lerMesmoDesatualizado: boolean, agora: Date): Promise<LeituraDoBanco | null> {
  const fonte = ctx.fonte;
  if (!fonte) return null;
  const itens = ctx.itens.filter((i) => i.empresa === u.slug);
  if (!itens.length) return null;
  const its = await Promise.all(itens.map((i) => fonte.item(i.itemId).catch(() => null)));
  const quando = its.map((it) => (it?.atualizadoEm ? Date.parse(it.atualizadoEm) : NaN));
  const atualizouHoje = its.every((it, i) => !!it && it.status === 'UPDATED' && !Number.isNaN(quando[i]!) && dataLocalISO(new Date(quando[i]!), u.fuso) === u.hoje);
  const maisAntigo = quando.every((q) => !Number.isNaN(q)) ? Math.min(...quando) : null;
  const lidoAte = maisAntigo === null ? null : hora(new Date(maisAntigo), u.fuso);
  if (!atualizouHoje && !lerMesmoDesatualizado) return { pix: [], lidoAte, lidoAteMs: maisAntigo, confiavel: false };
  // a leitura do conector vale até 90 dias
  const inicio = desde < somarDias(u.hoje, -85) ? somarDias(u.hoje, -85) : desde;
  const leitura = await lerPeriodo(ctx, { empresa: u.slug, inicio, fim: u.hoje });
  return { pix: entradasDoBanco(leitura.lancamentos).pix, lidoAte, lidoAteMs: maisAntigo, confiavel: atualizouHoje && !leitura.incompleto };
}

// ----------------------------------------------------------------------------------------------------------------- a volta

/** Das marcações dadas, as que a conversa da Sofia registrou como «vai pagar na clínica» (`conversations.pagamento_escolhido`). Falha de banco = ninguém sai da lista. */
export async function pagamNaClinica(u: Pick<UnidadeDaLista, 'id' | 'slug'>, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  try {
    const linhas = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT o.spine_id_schedule AS "id"
        FROM conversation_outcomes o JOIN conversations c ON c.id = o.conversation_id
       WHERE o.unit_id = ${u.id} AND o.spine_id_schedule = ANY(${ids}::int[]) AND c.pagamento_escolhido = 'na_clinica'`;
    return new Set(linhas.map((l) => l.id));
  } catch (err) {
    logger.warn({ unidade: u.slug, err: String(err).slice(0, 200) }, `${ID_DA_AUTOMACAO}: não li quem escolheu pagar na clínica — ninguém sai da lista por isso`);
    return new Set();
  }
}

let rodando = false;

/** O dia útil anterior da unidade (dia da agenda e não feriado nacional); sem nenhum nos últimos 14 dias, ontem. */
export function diaUtilAnterior(hoje: string, diasDaAgenda: ReadonlyArray<number>): string {
  for (let n = 1; n <= 14; n++) {
    const d = somarDias(hoje, -n);
    if (diasDaAgenda.includes(new Date(`${d}T00:00:00Z`).getUTCDay()) && !ehFeriadoNacional(d)) return d;
  }
  return somarDias(hoje, -1);
}

/** Uma volta sobre as unidades com banco. Nunca lança. */
export async function varrer(env: NodeJS.ProcessEnv = process.env, agoraMs: number = Date.now()): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const itens = lerItensDoAmbiente(env.PLUGGY_ITENS).entradas;
    // o mais barato primeiro: sem banco configurado, ou com a chave desligada em todas, a volta não toca em nada
    const candidatos = [...new Set(itens.map((i) => i.empresa))].filter((slug) => estadoDaLista(slug, env.AGENDADOS_SEM_PIX_SLUGS) !== 'desligado');
    if (!candidatos.length) return;
    const ctx = await contextoPluggyDoAmbiente(env);
    if (!ctx) return;
    if (valoresDaOperacaoInvalidos(env.AGENDADOS_SEM_PIX_VALORES)) avisarUmaVez('valores-invalidos', `${ID_DA_AUTOMACAO}: AGENDADOS_SEM_PIX_VALORES não é um JSON {"<slug>": [reais]} — ignorada, valem os valores do cadastro e do texto da unidade`);
    const unidades = await prisma.unit.findMany({
      where: { slug: { in: candidatos }, isActive: true, spineEnabled: true },
      select: {
        id: true, slug: true, businessHoursTimezone: true, spineTimezone: true, spineBaseUrl: true, spineToken: true, spineAgendaDays: true,
        acceptsAdvancePayment: true, spineBookingRequiresPayment: true, sinalPixCentavos: true, sourceProdutos: true,
      },
    });
    const agora = new Date(agoraMs);
    for (const unit of unidades) {
      try {
        if (!unit.spineToken || unidadeSemAntecipado(unit)) continue;
        const fuso = fusoDaUnidade(unit);
        const p = partesNoFuso(agora, fuso);
        const hoje = dataLocalISO(agora, fuso);
        const diaDaAgenda = unit.spineAgendaDays.includes(new Date(`${hoje}T00:00:00Z`).getUTCDay());
        const u: UnidadeDaLista = {
          id: unit.id,
          slug: unit.slug,
          fuso,
          hoje,
          minutoDoDia: p.hora * 60 + p.min,
          diaDeTrabalho: diaDaAgenda && !ehFeriadoNacionalAgora(agora, fuso),
          agendadosDesde: diaUtilAnterior(hoje, unit.spineAgendaDays),
          // só a taxa OBRIGATÓRIA (Boa Vista) tira do paciente a escolha de pagar no dia; nas demais a agenda não diz quem escolheu
          podePagarNoDia: !unit.spineBookingRequiresPayment,
          valores: valoresDaUnidade({ slug: unit.slug, sinalPixCentavos: unit.sinalPixCentavos, textoDeProdutos: unit.sourceProdutos, env: env.AGENDADOS_SEM_PIX_VALORES }),
        };
        if (!valoresLogados.has(`${u.slug}:${u.valores.join(',')}`)) {
          valoresLogados.add(`${u.slug}:${u.valores.join(',')}`);
          logger.info({ unidade: u.slug, valoresReais: u.valores.map((v) => v / 100) }, `${ID_DA_AUTOMACAO}: valores de Pix que valem como sinal/consulta nesta unidade`);
        }
        const deps: DepsDoCiclo = {
          agendados: async (x) => {
            // falha de agenda (ou agenda grande demais): não repete a leitura pesada a cada 5 min — espera 10 min
            if ((agendaComFalha.get(x.slug) ?? 0) > agoraMs) return null;
            const r = await agendadosRecentes(unit, x, agoraMs).catch((err) => (logger.warn({ unidade: x.slug, err: String(err).slice(0, 200) }, `${ID_DA_AUTOMACAO}: não li a agenda`), null));
            if (!r) agendaComFalha.set(x.slug, agoraMs + 10 * 60_000);
            return r;
          },
          banco: (x, desde, lerMesmo) => lerBancoDaUnidade(ctx, x, desde, lerMesmo, agora).catch((err) => (logger.warn({ unidade: x.slug, err: String(err).slice(0, 200) }, `${ID_DA_AUTOMACAO}: não li o banco`), null)),
          destino: (slug) => destinoDoAvisoClinica(slug, env.AGENDADOS_SEM_PIX_DESTINOS),
          evolution: () => evolutionDaLista(env),
          pagamNaClinica: (x, ids) => pagamNaClinica(x, ids),
          enviar: (a) => enviarAoGrupo(a),
          agora: () => agoraMs,
          marca: marcaNoBanco,
          avisarUmaVez,
        };
        const desfecho = await cicloDaUnidade(u, estadoDaLista(unit.slug, env.AGENDADOS_SEM_PIX_SLUGS), deps);
        if (desfecho !== 'desligado' && desfecho !== 'fora_do_horario' && desfecho !== 'repetido') logger.info({ unidade: unit.slug, desfecho }, `${ID_DA_AUTOMACAO}: volta`);
      } catch (err) {
        logger.warn({ unidade: unit.slug, err: String(err).slice(0, 200) }, `${ID_DA_AUTOMACAO}: volta falhou — tento na próxima`);
      }
    }
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, `${ID_DA_AUTOMACAO}: varredura falhou`);
  } finally {
    rodando = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

export function startAgendadosSemPixWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VOLTA_MS);
  primeira.unref?.();
  timer = setInterval(() => void varrer(), PASSO_MS);
  timer.unref?.();
  logger.info(`${ID_DA_AUTOMACAO}: worker iniciado`);
}

export function stopAgendadosSemPixWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
