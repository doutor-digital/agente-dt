import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { instanteNoFuso } from '../services/spine.service.js';
import { pacienteNaFranquia } from '../services/paciente-na-franquia.js';
import { cartaoTemConsulta } from './agendamento-perdido-worker.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { fusoDaUnidade } from './fuso.js';
import {
  Lembranca,
  MARCA,
  UM_POR_LEAD_MS,
  algumaDesde,
  consultaDoRastro,
  cortar,
  decidir,
  detectarPromessa,
  mensagemDaIA,
  proximoPasso,
  textoDoAlerta,
  type Evidencias,
  type Promessa,
} from './prometeu-sem-marcar.js';

/**
 * Vigia "prometeu e não marcou" — ver `prometeu-sem-marcar.ts` para o detector e os casos reais.
 *
 * A cada 2 min lê as mensagens da IA das últimas horas que afirmam consulta marcada. Para cada uma,
 * espera a conversa ficar PARADA (`CARENCIA_MIN` sem mensagem nenhuma): enquanto o paciente responde, a
 * IA ainda pode marcar no turno seguinte, e avisar ali seria alarme falso. Parada a conversa, confere
 * quatro fontes, da mais barata para a mais cara:
 *   1. o rastro: `agendar_consulta` (ou o widget da recepção) marcou para este lead, em qualquer
 *      unidade da mesma conta Kommo (o resgate promete, a comercial marca);
 *   2. o vínculo com a franquia (`spine_lead_links.agendado_para`) ainda por vir;
 *   3. o cartão: ◷ Data da Consulta de agora em diante (`cartaoTemConsulta`, a mesma do vigia de
 *      agendamento perdido) — cobre a recepção e a SDR;
 *   4. a franquia, pelo telefone (`pacienteNaFranquia`) — cobre o paciente em tratamento falando da
 *      sessão e a consulta marcada por fora que ainda não chegou ao cartão.
 * Nenhuma mostra consulta = alerta: tarefa "ALERTA · <slug> · …" no cartão, com prazo de 30 min (é
 * ação com prazo: o paciente acha que vem). Um por cartão a cada 24 h.
 *
 * Em "só no papel" (o padrão da rede) não cria tarefa: grava "alertaria"/"confere" na tela de
 * Automações, pra medir antes de ligar.
 */

const ID = 'prometeu-sem-marcar';
const SWEEP_MS = Number(process.env.PROMETEU_SEM_MARCAR_SWEEP_MS) || 2 * 60_000;
/** Conversa parada há este tanto antes de conferir: o paciente pode responder e a IA marcar. */
const CARENCIA_MIN = Number(process.env.PROMETEU_SEM_MARCAR_CARENCIA_MIN) || 10;
/** Mensagem mais velha que isto não é olhada: cobre um deploy ou o Kommo fora do ar, não o passado. */
const JANELA_H = Number(process.env.PROMETEU_SEM_MARCAR_JANELA_H) || 6;
/** Teto de tarefas por varredura: se algo estiver errado, erra em poucos cartões, não em cem. */
const MAX_ALERTAS = Number(process.env.PROMETEU_SEM_MARCAR_MAX) || 15;
/** Rastro de sucesso do agendar_consulta: olhar até aqui pra trás (consulta marcada semana passada pra hoje). */
const RASTRO_DIAS = 45;
/** Mesma folga do vigia de agendamento perdido: consulta até 4 h antes da promessa ainda conta. */
const FOLGA_MS = 4 * 60 * 60_000;
const PRAZO_TAREFA_S = 30 * 60;
const PREFIXO_RASTRO = 'prometeu-';

/** Palavras que toda afirmação tem: filtro barato no banco antes do detector. */
const PALAVRAS = [
  'marcad', 'agendad', 'reservad', 'confirmad', 'garantid',
  'marquei', 'agendei', 'reservei', 'remarquei', 'confirmei',
  'te espero', 'te esperamos', 'te aguardo', 'te aguardamos', 'lhe espero', 'nos vemos',
];

/** Um aviso de falha por chave a cada hora: todo `warn` vira linha no painel de erros. */
const FALHA_AVISADA_MS = 60 * 60_000;
const falhasAvisadas = new Lembranca();
function avisarFalha(chave: string, dados: Record<string, unknown>, msg: string): void {
  if (falhasAvisadas.sabe(chave)) return;
  falhasAvisadas.lembrar(chave, FALHA_AVISADA_MS);
  logger.warn(dados, msg);
}

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** Mensagens já decididas (avisou, conferiu ou não é promessa). */
const decididas = new Lembranca();
/**
 * Cartões que ganharam alerta (ou "alertaria") nas últimas 24 h, por conta. Segunda trava além do
 * rastro no banco: duas promessas do mesmo cartão na mesma varredura, ou o rastro que não gravou.
 */
const cartoesAvisados = new Lembranca();

export function estadoDoPrometeu(slug: string, raw: string | undefined = process.env.PROMETEU_SEM_MARCAR_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID, raw);
}

interface Candidata {
  id: string;
  conversationId: string;
  unitId: string;
  /** a conta Kommo (subdomínio), ou a própria unidade quando não há — o resgate e a comercial dividem o cartão */
  conta: string;
  leadId: number;
  criadaEm: Date;
  promessa: Promessa;
  telefone: string | null;
  contato: string | null;
}

function decidida(id: string): void {
  decididas.lembrar(id, (JANELA_H + 1) * 60 * 60_000);
}

/** Mensagens da IA na janela, já paradas, que afirmam consulta marcada. */
async function candidatas(agora = new Date()): Promise<Candidata[]> {
  const desde = new Date(agora.getTime() - JANELA_H * 60 * 60_000);
  const ate = new Date(agora.getTime() - CARENCIA_MIN * 60_000);
  const msgs = await prisma.message.findMany({
    where: {
      role: 'assistant',
      createdAt: { gte: desde, lt: ate },
      OR: PALAVRAS.map((p) => ({ content: { contains: p, mode: 'insensitive' as const } })),
    },
    select: {
      id: true,
      conversationId: true,
      content: true,
      meta: true,
      createdAt: true,
      conversation: { select: { unitId: true, leadId: true, phone: true, contactName: true, unit: { select: { kommoSubdomain: true } } } },
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });

  const achadas: Candidata[] = [];
  for (const m of msgs) {
    if (decididas.sabe(m.id)) continue;
    const leadId = Number(m.conversation.leadId);
    const promessa = mensagemDaIA(m.meta) && Number.isFinite(leadId) && leadId > 0 ? detectarPromessa(m.content) : null;
    if (!promessa) {
      decidida(m.id);
      continue;
    }
    achadas.push({
      id: m.id,
      conversationId: m.conversationId,
      unitId: m.conversation.unitId,
      conta: contaDe(m.conversation.unitId, m.conversation.unit.kommoSubdomain),
      leadId,
      criadaEm: m.createdAt,
      promessa,
      telefone: m.conversation.phone,
      contato: m.conversation.contactName,
    });
  }
  if (achadas.length === 0) return [];

  // Conversa ainda andando (mensagem de qualquer lado nos últimos CARENCIA_MIN) fica pra próxima varredura.
  // Vale a conversa do MESMO cartão em qualquer unidade da conta: o resgate promete, passa pra comercial,
  // e é lá que o paciente continua — e onde a consulta pode ser marcada no minuto seguinte.
  const conversas = await prisma.conversation.findMany({
    where: { leadId: { in: [...new Set(achadas.map((a) => String(a.leadId)))] } },
    select: { id: true, leadId: true, unitId: true, unit: { select: { kommoSubdomain: true } } },
  });
  const ultimas = await prisma.message.groupBy({
    by: ['conversationId'],
    where: { conversationId: { in: conversas.map((c) => c.id) } },
    _max: { createdAt: true },
  });
  const ultimaPorConversa = new Map(ultimas.map((u) => [u.conversationId, u._max.createdAt?.getTime() ?? 0]));
  const ultimaPorCartao = new Map<string, number>();
  for (const c of conversas) {
    const k = `${contaDe(c.unitId, c.unit.kommoSubdomain)}|${c.leadId}`;
    ultimaPorCartao.set(k, Math.max(ultimaPorCartao.get(k) ?? 0, ultimaPorConversa.get(c.id) ?? 0));
  }
  return achadas.filter((a) => (ultimaPorCartao.get(`${a.conta}|${a.leadId}`) ?? 0) < ate.getTime());
}

function contaDe(unitId: string, subdominio: string | null): string {
  return subdominio ? `kommo:${subdominio}` : `unidade:${unitId}`;
}

/** Unidades da mesma conta Kommo: o lead é o mesmo cartão no resgate e na comercial. */
async function unidadesDaConta(unit: Unit): Promise<string[]> {
  if (!unit.kommoSubdomain) return [unit.id];
  const irmas = await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } });
  return irmas.length ? irmas.map((u) => u.id) : [unit.id];
}

/** Fontes 1 e 2: o banco do agente. */
async function evidenciaDoBanco(unidades: string[], c: Candidata, desdeLocal: string): Promise<Pick<Evidencias, 'marcouNoRastro' | 'vinculoFuturo'>> {
  const [passos, vinculos] = await Promise.all([
    prisma.executionStep.findMany({
      where: {
        trace: { leadId: String(c.leadId), unitId: { in: unidades } },
        createdAt: { gte: new Date(c.criadaEm.getTime() - RASTRO_DIAS * 86_400_000) },
        OR: [{ title: { startsWith: 'Consulta marcada:' } }, { title: { startsWith: 'Consulta marcada na franquia:' } }],
      },
      select: { title: true },
      take: 20,
    }),
    prisma.spineLeadLink.findMany({
      where: { kommoLeadId: c.leadId, unitId: { in: unidades }, spineIdSchedule: { not: null } },
      select: { agendadoPara: true },
    }),
  ]);
  return {
    marcouNoRastro: algumaDesde(passos.map((p) => consultaDoRastro(p.title)), desdeLocal),
    vinculoFuturo: algumaDesde(vinculos.map((v) => v.agendadoPara), desdeLocal),
  };
}

/**
 * Quando este cartão ganhou o último alerta (nas últimas 24 h)? O rastro do alerta é a marca. Olha a
 * conta toda: o resgate e a comercial falam com o mesmo cartão, e a SDR não precisa de duas tarefas
 * pelo mesmo paciente.
 */
async function ultimoAviso(unidades: string[], leadId: number): Promise<Date | null> {
  const t = await prisma.executionTrace.findFirst({
    where: {
      unitId: { in: unidades },
      leadId: String(leadId),
      id: { startsWith: PREFIXO_RASTRO },
      createdAt: { gte: new Date(Date.now() - UM_POR_LEAD_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return t?.createdAt ?? null;
}

async function registrarAlerta(unit: Unit, c: Candidata, motivo: string, tarefaId: number | null): Promise<void> {
  const id = `${PREFIXO_RASTRO}${unit.id}-${c.leadId}-${c.id}`;
  await prisma.executionTrace
    .create({
      data: {
        id,
        unitId: unit.id,
        leadId: String(c.leadId),
        threadId: id,
        channel: 'manual',
        status: 'SUCCESS',
        input: { origem: 'vigia-prometeu-sem-marcar', mensagemId: c.id, conversaId: c.conversationId },
        steps: {
          create: [
            {
              sequence: 0,
              kind: 'ERROR',
              title: `${MARCA} — lead ${c.leadId}`,
              payload: {
                trecho: c.promessa.trecho,
                forma: c.promessa.forma,
                quando: c.promessa.quando,
                ditaEm: c.criadaEm.toISOString(),
                motivo,
                tarefaId,
              },
            },
          ],
        },
      },
    })
    .catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId: c.leadId }, 'prometeu-sem-marcar: não gravei o rastro do alerta'));
}

async function tratarUnidade(unit: Unit, itens: Candidata[], estado: Estado, orcamento: { alertas: number }): Promise<void> {
  let kommo: KommoClient;
  try {
    kommo = createKommoClient(unit);
  } catch {
    return; // unidade sem Kommo configurado: não há a quem avisar
  }
  const tz = fusoDaUnidade(unit);
  const unidades = await unidadesDaConta(unit);

  let cartoes: Map<number, KommoLead> | null = null;
  try {
    const lidos = await kommo.listLeadsPorIds([...new Set(itens.map((c) => c.leadId))]);
    cartoes = new Map(lidos.map((l) => [l.id, l]));
  } catch (err) {
    // Sem o cartão não dá pra saber se a recepção marcou: `decidir` segura e a próxima varredura tenta.
    avisarFalha(`cartoes:${unit.id}`, { err: String(err), unit: unit.slug, n: itens.length }, 'prometeu-sem-marcar: não li os cartões, fica pra próxima');
  }

  for (const c of itens) {
    const desdeLocal = instanteNoFuso(new Date(c.criadaEm.getTime() - FOLGA_MS), tz);
    const banco = await evidenciaDoBanco(unidades, c, desdeLocal);
    const cartao = cartoes ? (cartoes.get(c.leadId) ?? null) : undefined;
    if (cartao === null) {
      decidida(c.id); // cartão apagado ou de outra conta: não há a quem avisar
      continue;
    }
    const ev: Evidencias = {
      ...banco,
      // lote que falhou = não sei (`decidir` adia)
      cartaoComConsulta: cartao === undefined ? null : cartaoTemConsulta(cartao, c.criadaEm),
      franquiaComConsulta: null,
    };
    // A franquia é a fonte cara: só pergunta quando todo o resto disse "não tem".
    if (!ev.marcouNoRastro && !ev.vinculoFuturo && ev.cartaoComConsulta === false && unit.spineEnabled) {
      const p = await pacienteNaFranquia(unit, c.leadId, [cartao?.name, c.contato], c.telefone).catch(() => null);
      ev.franquiaComConsulta = !!p?.proximo;
    }

    const decisao = decidir(ev);
    // Uma linha por promessa na tela: o dia prometido e quando ela disse ("promessa sexta 09/10 · dita 05/10 15:52").
    const dita = instanteNoFuso(c.criadaEm, tz);
    const alvo = `promessa ${c.promessa.quando ?? 'sem dia/hora'} · dita ${dita.slice(8, 10)}/${dita.slice(5, 7)} ${dita.slice(11, 16)}`;
    const valor = cortar(c.promessa.trecho, 200);
    // O estado entra na chave: "alertaria" no papel não pode calar a primeira tarefa de verdade quando ligarem.
    const chaveCartao = `${estado}|${c.conta}|${c.leadId}`;
    const repetida = cartoesAvisados.sabe(chaveCartao);
    // O dedupe só importa para a tarefa de verdade: no papel e na conferência não custa uma ida ao banco.
    const ultimoAvisoEm =
      decisao.avisar && estado === 'ligado' ? (repetida ? new Date() : await ultimoAviso(unidades, c.leadId)) : null;
    const passo = proximoPasso({ estado: estado === 'ligado' ? 'ligado' : 'seco', decisao, ultimoAvisoEm, agora: new Date() });

    if (passo === 'adiar') continue;
    if (passo === 'confere' || passo === 'ja-avisado') {
      decidida(c.id);
      if (passo === 'confere' && estado === 'seco') {
        registrarSimulacao(unit, ID, { leadId: c.leadId, acao: 'confere', alvo, valor, motivo: decisao.motivo });
      }
      continue;
    }
    if (passo === 'alertaria') {
      decidida(c.id);
      cartoesAvisados.lembrar(chaveCartao, UM_POR_LEAD_MS);
      const motivo = repetida ? `${decisao.motivo} — repetida: ligado, não sairia 2ª tarefa em 24 h` : decisao.motivo;
      registrarSimulacao(unit, ID, { leadId: c.leadId, acao: 'alertaria', alvo, valor, motivo });
      logger.info({ unit: unit.slug, leadId: c.leadId, trecho: cortar(c.promessa.trecho, 120) }, 'prometeu-sem-marcar [seco]: alertaria');
      continue;
    }

    // passo === 'alertar'
    if (orcamento.alertas <= 0) return; // teto da varredura: o resto fica pra próxima
    try {
      const nome = cartao?.name?.trim() || c.contato;
      const tarefa = await kommo.createTask({
        leadId: c.leadId,
        text: textoDoAlerta({ slug: unit.slug, nome, trecho: c.promessa.trecho, quando: c.promessa.quando }),
        completeAt: Math.floor(Date.now() / 1000) + PRAZO_TAREFA_S,
      });
      if (!tarefa) throw new Error('o Kommo não devolveu a tarefa');
      orcamento.alertas--;
      decidida(c.id);
      cartoesAvisados.lembrar(chaveCartao, UM_POR_LEAD_MS);
      await registrarAlerta(unit, c, decisao.motivo, tarefa.id ?? null);
      logger.warn({ unit: unit.slug, leadId: c.leadId, tarefa: tarefa.id }, 'prometeu-sem-marcar: a IA prometeu consulta que não existe — SDR avisada');
    } catch (err) {
      // Sem marca: a mensagem segue na janela e a próxima varredura tenta de novo.
      avisarFalha(`tarefa:${unit.id}:${c.leadId}`, { err: String(err), unit: unit.slug, leadId: c.leadId }, 'prometeu-sem-marcar: falhei ao criar a tarefa');
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    decididas.esquecerVencidas();
    cartoesAvisados.esquecerVencidas();
    falhasAvisadas.esquecerVencidas();

    const lista = await candidatas();
    if (lista.length === 0) return;

    const porUnidade = new Map<string, Candidata[]>();
    for (const c of lista) porUnidade.set(c.unitId, [...(porUnidade.get(c.unitId) ?? []), c]);

    const orcamento = { alertas: MAX_ALERTAS };
    for (const [unitId, itens] of porUnidade) {
      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit || !unit.isActive) continue;
      const estado = estadoDoPrometeu(unit.slug);
      if (estado === 'desligado') continue;
      try {
        await tratarUnidade(unit, itens, estado, orcamento);
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug }, 'prometeu-sem-marcar: unidade falhou, segue a próxima');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'prometeu-sem-marcar: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startPrometeuSemMarcarWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  timer.unref?.();
  logger.info({ sweepMs: SWEEP_MS, carenciaMin: CARENCIA_MIN, janelaH: JANELA_H }, 'vigia "prometeu e não marcou" ligado');
}

export function stopPrometeuSemMarcarWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposto para teste e para uma varredura manual. */
export const _internos = { candidatas, varrer, ID, CARENCIA_MIN, JANELA_H };
