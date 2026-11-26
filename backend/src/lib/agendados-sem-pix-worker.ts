/**
 * O worker da lista «Agendados sem Pix» (`agendados-sem-pix.ts`): de 5 em 5 minutos olha as unidades que têm banco na Pluggy e decide, por unidade, se já é hora da lista
 * do dia. Quase sempre não é (fora do horário, já feita, estado desligado): essas voltas não tocam agenda nem banco. O líder dos workers (`worker-lease.ts`) é quem o sobe.
 *
 * As fontes reais: a agenda da franquia (`searchSchedules`, a mesma leitura do resto do agente), o banco pelo cliente compartilhado da Pluggy (o mesmo do conector, com o
 * cache de item e contas) e a Evolution que já manda os avisos à recepção. Nada aqui escreve na franquia, no Kommo nem no banco da Pluggy: a única escrita é a marca do dia.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { enviarPelaEvolutionComResultado } from './alerta-whatsapp.js';
import { dataLocalISO, ehFeriadoNacional, ehFeriadoNacionalAgora } from './feriados.js';
import { fusoDaUnidade, partesNoFuso } from './fuso.js';
import { destinoDoAvisoClinica } from './aviso-clinica-agendamento.js';
import { unidadeSemAntecipado } from '../agent/pagamento-da-unidade.js';
import { clienteCompartilhado, lerItensDoAmbiente, resolverEmpresas } from './integracoes/pluggy.js';
import { entradasDoBanco, semAcento, valoresDaUnidade } from './pix-casamento.js';
import {
  ID_DA_AUTOMACAO,
  cicloDaUnidade,
  estadoDaLista,
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
  async estado(id) {
    const linhas = await prisma.$queryRaw<Array<{ estado: string | null }>>`SELECT payload->>'estado' AS "estado" FROM execution_steps WHERE trace_id = ${id} LIMIT 1`;
    return linhas.length ? (linhas[0]!.estado ?? 'desconhecido') : null;
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
  async concluir(id, estado) {
    await prisma
      .$executeRaw`UPDATE execution_steps SET payload = jsonb_set(payload, '{estado}', to_jsonb(${estado}::text)) WHERE trace_id = ${id}`
      .catch((err: unknown) => logger.warn({ err: String(err), id, estado }, `${ID_DA_AUTOMACAO}: não consegui anotar o desfecho na marca`));
  },
};

// ----------------------------------------------------------------------------------------------------------------- fontes

const jaDisse = new Set<string>();
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

/** Avaliação ou consulta (a que se paga antes) de hoje em diante, ainda AGENDADA ou CONFIRMADA, mexida desde o dia útil anterior. Sessão, retorno e reavaliação não entram. */
export async function agendadosRecentes(unit: UnidadeDoBanco, u: UnidadeDaLista, agora: number): Promise<{ agendados: Agendado[]; conhecidos: Array<string | null> } | null> {
  const chave = `${u.slug}:${u.hoje}`;
  const g = agendaGuardada.get(chave);
  if (g && g.ate > agora) return g.v;
  const r = await searchSchedules(unit, { initialDate: somarDias(u.hoje, -CONHECIDOS_DESDE_DIAS), endDate: somarDias(u.hoje, HORIZONTE_DIAS) });
  if (!r.ok || !r.data) return null;
  // lista incompleta (teto de páginas): melhor não afirmar nada do que afirmar «não achei» sobre metade da agenda
  if (r.data.truncada) return null;
  const desde = u.agendadosDesde;
  const conhecidos = r.data.schedules.filter((s) => s.idStatus !== SPINE_STATUS.DESMARCADO).map((s) => s.clientName);
  const agendados = r.data.schedules
    .filter((s) => s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO)
    .filter((s) => {
      const c = semAcento(s.categoryName ?? '');
      return c.startsWith('avaliacao') || c === 'consulta';
    })
    .filter((s) => s.dayLocal && s.timeLocal && s.dayLocal >= u.hoje)
    .flatMap((s): Array<Agendado & { alteradoEm: string }> => {
      if (!s.modifiedUtc) return []; // sem data nenhuma não dá para saber se é recente: fica de fora (a lista é de quem foi marcado agora, não de toda a agenda)
      const alteradoEm = instanteNoFuso(new Date(s.modifiedUtc), u.fuso).slice(0, 10);
      // a última alteração é a data da MARCAÇÃO só enquanto o registro está AGENDADO; em CONFIRMADO ela é a da confirmação (a régua e a recepção mexem no registro): a data da marcação é desconhecida
      return [{ nome: s.clientName, dia: s.dayLocal!, hora: s.timeLocal!, agendadoEm: s.idStatus === SPINE_STATUS.AGENDADO ? alteradoEm : null, alteradoEm }];
    })
    .filter((a) => a.alteradoEm >= desde)
    .map(({ alteradoEm: _alteradoEm, ...a }): Agendado => a);
  const v = { agendados, conhecidos };
  for (const k of agendaGuardada.keys()) if (!k.endsWith(`:${u.hoje}`)) agendaGuardada.delete(k);
  agendaGuardada.set(chave, { ate: agora + AGENDA_GUARDADA_MS, v });
  return v;
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
  if (!atualizouHoje && !lerMesmoDesatualizado) return { pix: [], lidoAte, confiavel: false };
  // a leitura do conector vale até 90 dias
  const inicio = desde < somarDias(u.hoje, -85) ? somarDias(u.hoje, -85) : desde;
  const leitura = await lerPeriodo(ctx, { empresa: u.slug, inicio, fim: u.hoje });
  return { pix: entradasDoBanco(leitura.lancamentos).pix, lidoAte, confiavel: atualizouHoje && !leitura.incompleto };
}

// ----------------------------------------------------------------------------------------------------------------- a volta

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
          valores: valoresDaUnidade({ slug: unit.slug, sinalPixCentavos: unit.sinalPixCentavos, textoDeProdutos: unit.sourceProdutos, env: env.AGENDADOS_SEM_PIX_VALORES }),
        };
        const deps: DepsDoCiclo = {
          agendados: (x) => agendadosRecentes(unit, x, agoraMs).catch((err) => (logger.warn({ unidade: x.slug, err: String(err).slice(0, 200) }, `${ID_DA_AUTOMACAO}: não li a agenda`), null)),
          banco: (x, desde, lerMesmo) => lerBancoDaUnidade(ctx, x, desde, lerMesmo, agora).catch((err) => (logger.warn({ unidade: x.slug, err: String(err).slice(0, 200) }, `${ID_DA_AUTOMACAO}: não li o banco`), null)),
          destino: (slug) => destinoDoAvisoClinica(slug, env.AGENDADOS_SEM_PIX_DESTINOS),
          evolution: () => evolutionDaLista(env),
          enviar: (a) => enviarPelaEvolutionComResultado(a),
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
