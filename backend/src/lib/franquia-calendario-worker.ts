/**
 * Agenda da franquia no Calendário do Kommo — o worker. A decisão (o que criar/atualizar/fechar) é de
 * `franquia-calendario.ts` (puro); aqui se busca, casa paciente → cartão e aplica.
 *
 * LIGA POR UNIDADE NA TELA DE AUTOMAÇÕES (`franquia-calendario`: ligado = escreve, "só no papel" = lê e registra, desligado). Sem nada
 * gravado na tela vale o `.env` de sempre, que continua mandando em Timbó: `FRANQUIA_CALENDARIO_SLUGS` (csv; `*` = todas; vazio =
 * desligado), e só ESCREVE quem também está em `FRANQUIA_CALENDARIO_APLICAR`. INDEPENDENTE de a unidade estar no sincronizador: este
 * passo só cria/atualiza/conclui TAREFAS e nunca grava campo nem etapa do cartão.
 *
 * O que muda de conta para conta mora na tabela `unit_calendario` (tipo da tarefa, dono, duração), com o `.env` antigo
 * (`FRANQUIA_CALENDARIO_TIPO` / `_RESPONSAVEL` = `slug:valor`, csv) como reserva. Sem nenhum dos dois: tipo "Consulta" da conta (e sem
 * esse a unidade FICA PARADA — não há tipo "padrão"), dono = o único usuário da clínica, 60 min.
 * `FRANQUIA_CALENDARIO_DURACAO_MIN` (padrão 60; 0 = não manda duração), `FRANQUIA_CALENDARIO_REMARCADO` (`manter` — padrão — ou
 * `fechar`; ver o porquê em `franquia-calendario.ts`) e `FRANQUIA_CALENDARIO_INTERVALO_MIN` (padrão 15) valem para todas.
 *
 * Kommo dividido (Petrópolis × Caxias): a dona usa o marcador de sempre, `[ag:N]`; a irmã, `[ag:caxias:N]`. Cada uma só vê as próprias
 * tarefas e só põe a tarefa num cartão cujo «⌂ Unidade de atendimento» é o dela; senão a tarefa nasce solta, com nome e telefone.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, KommoApiError, type KommoClient, type KommoTarefa } from '../services/kommo.service.js';
import { SpineService, somarDias, localParaUtcIso, type SpineSchedule } from '../services/spine.service.js';
import { contaDoKommo, grupoDaUnidade, podeMexer, valorDaUnidadeNoCartao, veredictoDoCartao, type GrupoDoCrm } from './crm-compartilhado.js';
import { estadoGravado } from './automacoes-estado.js';
import { normalizar } from './franquia-sync.js';
import { ondeTemSync, resolverPaciente, type EntradaDoCacheDeLead } from './franquia-sync-worker.js';
import {
  DURACAO_PADRAO_SEG, configDaUnidade, epochDaConsulta, intervaloDoCalendarioMs, janelaDoCalendario, modoDoCalendario, planejarCalendario,
  prefixoDaUnidade, slugNaLista, sufixoComCartao, sufixoDeTarefaSolta, textoDaTarefa, tipoPeloNome,
  type Acao, type LinhaDeConfig, type ModoDoCalendario, type TarefaAberta,
} from './franquia-calendario.js';

const ID_AUTOMACAO = 'franquia-calendario';
const PRIMEIRA_MS = 120_000;
const PAUSA_ENTRE_ESCRITAS_MS = 200;
/** Tarefas NOVAS por varredura: a primeira de uma unidade grande se espalha por várias, em vez de bater no Kommo de uma vez. */
const MAX_CRIAR_POR_VARREDURA = Number(process.env.FRANQUIA_CALENDARIO_MAX_CRIAR) || 80;
const MAX_LINHAS_DE_LOG_SECO = 200;
/**
 * Tarefa criada há pouco não se cria de novo mesmo que a lista do Kommo ainda não a mostre. 30 min (eram 10): com a varredura a
 * cada 3–15 min e várias unidades em fila, a lista do Kommo pode demorar a refletir o POST, e criar de novo duplica a agenda.
 */
export const CRIADA_RECENTE_MS = 30 * 60_000;
const MAX_CACHE_DO_CALENDARIO = 5000;
/** Recusas explícitas do Kommo (400/404/422) seguidas, numa unidade, antes de parar de criar na rodada. */
const LIMITE_DE_RECUSAS_SEGUIDAS = 3;
const TIPO_CACHE_MS = 6 * 60 * 60_000;

export interface ResumoCalendario {
  unit: string;
  em: string;
  modo: ModoDoCalendario;
  agendamentos: number;
  tarefasAbertas: number;
  /**
   * Quantas tarefas CONCLUÍDAS a leitura devolveu (filtradas por `filter[complete_till]`, que o Kommo não documenta no GET /tasks).
   * Para medir no seco: se é igual ao total de concluídas da conta, o filtro está sendo ignorado; 0 com a recepção concluindo = filtro quebrado.
   */
  concluidasLidas: number;
  /** em modo seco, o que FARIA */
  criadas: number;
  atualizadas: number;
  fechadas: number;
  /** tarefas criadas soltas por falta de cartão (ou cartão incerto): nome e telefone vão no texto */
  semCartao: number;
  /** das `semCartao`, quantas porque o telefone casou com vários cartões e nenhum se provou */
  cartaoIncerto: number;
  /** tarefas abertas cujo agendamento não veio na busca — só logado */
  sumiram: number;
  /** passou do teto de criações da varredura; entram na próxima */
  adiadas: number;
  passados: number;
  /** consultas ativas cuja tarefa já foi concluída por alguém: respeitado */
  jaConcluidas: number;
  ignorados: number;
  erros: number;
}

export interface DepsDoCalendario {
  kommo?: KommoClient;
  agora?: Date;
  /** a linha de `unit_calendario` da unidade (`null` = sem linha); sem isto lê do banco */
  lerConfig?: () => Promise<LinhaDeConfig | null>;
  /** o grupo do Kommo dividido (`null` = Kommo só dela); sem isto lê do banco */
  grupo?: GrupoDoCrm | null;
  /** este cartão é desta unidade? só consultado em Kommo dividido; sem isto lê o cartão no Kommo */
  cartaoEhDaUnidade?: (leadId: number) => Promise<boolean>;
  buscarAgenda?: (de: string, ate: string) => Promise<{ ok: boolean; erro?: string; agendamentos: SpineSchedule[]; truncada?: boolean }>;
  resolver?: (nome: string, idsSchedule: number[]) => Promise<{ leadId: number | null; confirmado: boolean; fone?: string | null }>;
  modo?: ModoDoCalendario;
  pausaMs?: number;
}

const tipoPorConta = new Map<string, { id: number; ate: number }>();
const criadasRecentes = new Map<string, number>();
/**
 * O casamento paciente → cartão do calendário, SÓ dele. O do sincronizador (`cacheLead`) é lido para decidir o que gravar no cartão
 * e vale 6 h: o calendário casa só pelo nome, que é mais fraco, e não pode escrever lá.
 */
const cacheDoCalendario = new Map<string, EntradaDoCacheDeLead>();
const avisadasSemDono = new Set<string>();
const semTipoAvisadas = new Set<string>();
/** A última varredura de cada unidade (a tela só deixa ligar quem teve uma rodada SECA limpa — ver `rodadaSecaLimpa`). */
const ultimoResumo = new Map<string, ResumoCalendario>();

/** A última varredura desta unidade foi em "só no papel" e sem erro? É o que a tela exige antes de passar para "ligado". */
export function rodadaSecaLimpa(slug: string): boolean {
  const r = ultimoResumo.get(slug);
  return !!r && r.modo === 'seco' && r.erros === 0;
}
/** Última atualização aplicada por agendamento: se o Kommo não "guardou" o que mandamos, não regravamos para sempre. */
const ultimaAtualizacao = new Map<string, { assinatura: string; visto: string }>();

export function _limparMemoriaDoCalendario(): void {
  tipoPorConta.clear();
  criadasRecentes.clear();
  ultimaAtualizacao.clear();
  cacheDoCalendario.clear();
  avisadasSemDono.clear();
  semTipoAvisadas.clear();
  ultimoResumo.clear();
}

/**
 * O tipo das tarefas da unidade: o configurado, ou o "Consulta" da conta. Sem nenhum dos dois, `null` e a unidade FICA PARADA
 * nesta varredura — não há tipo "padrão". A lista de tarefas abertas é filtrada por tipo, então trocar o tipo no meio do caminho
 * (cair no 1 por falta de "Consulta" e depois alguém criar o tipo, ou mudar o tipo configurado da unidade) esconde as tarefas
 * antigas e duplica a agenda inteira; e o tipo 1 é o Follow-up dos robôs, uma lista enorme que não é nossa.
 */
async function tipoDeTarefa(unit: Pick<Unit, 'slug'>, kommo: KommoClient, conta: string, configurado: number | null): Promise<number | null> {
  if (configurado) return configurado;
  const hit = tipoPorConta.get(conta);
  if (hit && hit.ate > Date.now()) return hit.id;
  let id: number | null;
  try {
    id = tipoPeloNome(await kommo.listarTiposDeTarefa());
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: sem a lista de tipos de tarefa — nada feito nesta varredura');
    return null;
  }
  if (id === null) {
    if (!semTipoAvisadas.has(unit.slug)) {
      semTipoAvisadas.add(unit.slug);
      logger.warn({ unit: unit.slug }, 'franquia-calendario: a conta não tem o tipo de tarefa "Consulta" e a unidade não tem tipo configurado (unit_calendario / FRANQUIA_CALENDARIO_TIPO) — unidade parada (crie o tipo "Consulta" na conta ou configure o id)');
    }
    return null;
  }
  semTipoAvisadas.delete(unit.slug); // o tipo apareceu: se sumir de novo, avisa de novo
  tipoPorConta.set(conta, { id, ate: Date.now() + TIPO_CACHE_MS });
  return id;
}

function paraTarefa(t: KommoTarefa): TarefaAberta {
  return { id: t.id, text: t.text ?? '', completeTill: typeof t.complete_till === 'number' ? t.complete_till : null, entityId: t.entity_id ?? null };
}

const estadoVisto = (t: Pick<TarefaAberta, 'text' | 'completeTill'> | undefined) => `${(t?.text ?? '').trim()}|${t?.completeTill ?? ''}`;

/** As memórias só valem por minutos (criadas) ou até o próximo deploy (atualizações); sem poda, crescem para sempre. */
function podarMemoria(): void {
  const agora = Date.now();
  for (const [k, em] of criadasRecentes) if (agora - em > CRIADA_RECENTE_MS) criadasRecentes.delete(k);
  if (ultimaAtualizacao.size > 5000) ultimaAtualizacao.clear();
  if (cacheDoCalendario.size > MAX_CACHE_DO_CALENDARIO) for (const [k, v] of cacheDoCalendario) if (v.expiraEm <= agora) cacheDoCalendario.delete(k);
  if (cacheDoCalendario.size > MAX_CACHE_DO_CALENDARIO) cacheDoCalendario.clear();
}

/**
 * Sem dono configurado, o `createTask` manda a tarefa para o ÚNICO usuário da clínica. Conta com mais de um (ou sem nenhum além da
 * consultoria) cai no dono do token — o login "Doutor Digital" —, e a recepção não vê a tarefa. Avisa uma vez por unidade e processo.
 */
async function avisarSeNaoHaDonoUnico(unit: Pick<Unit, 'slug'>, kommo: KommoClient): Promise<void> {
  if (avisadasSemDono.has(unit.slug)) return;
  avisadasSemDono.add(unit.slug);
  try {
    const n = await kommo.usuariosDaClinica(); // do cache de 6 h do cliente (o mesmo que o createTask usa)
    if (n === null) {
      logger.warn({ unit: unit.slug }, 'franquia-calendario: unidade sem dono configurado e não consegui listar os usuários da conta — confira para quem vão as tarefas');
    } else if (n !== 1) {
      logger.warn(
        { unit: unit.slug, usuariosDaClinica: n },
        'franquia-calendario: unidade sem dono configurado e a conta não tem UM só usuário da clínica — a tarefa vai para o dono do token (configure responsible_user_id em unit_calendario)',
      );
    }
  } catch {
    /* só um aviso: se a leitura falhar, as tarefas seguem o caminho de sempre */
  }
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function varrerCalendario(unit: Unit, deps: DepsDoCalendario = {}): Promise<ResumoCalendario> {
  const r = await varrerUnidadeDoCalendario(unit, deps);
  ultimoResumo.set(unit.slug, r);
  return r;
}

async function varrerUnidadeDoCalendario(unit: Unit, deps: DepsDoCalendario): Promise<ResumoCalendario> {
  const modo = deps.modo ?? modoDoCalendario(unit.slug, undefined, estadoGravado(unit.slug, ID_AUTOMACAO));
  const agora = deps.agora ?? new Date();
  const resumo: ResumoCalendario = {
    unit: unit.slug, em: agora.toISOString(), modo, agendamentos: 0, tarefasAbertas: 0, concluidasLidas: 0, criadas: 0, atualizadas: 0, fechadas: 0,
    semCartao: 0, cartaoIncerto: 0, sumiram: 0, adiadas: 0, passados: 0, jaConcluidas: 0, ignorados: 0, erros: 0,
  };
  if (modo === 'desligado') return resumo;
  const aplicar = modo === 'aplicar';
  podarMemoria();
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const kommo = deps.kommo ?? createKommoClient(await contaDoKommo(unit));
  const pausa = deps.pausaMs ?? PAUSA_ENTRE_ESCRITAS_MS;

  // Kommo dividido: o marcador desta unidade (a irmã tem prefixo) e o rótulo que diz quais cartões são dela
  const grupo = deps.grupo !== undefined ? deps.grupo : await grupoDaUnidade(unit.id);
  let prefixo = '';
  if (grupo) {
    const membro = grupo.membros.find((m) => m.unitId === unit.id);
    // O prefixo vem do SLUG (não muda), nunca do rótulo: o rótulo é o texto da opção do campo no Kommo e quem o renomeia faria
    // a unidade ler as tarefas antigas como de outra e recriar a agenda inteira sem fechar as velhas.
    prefixo = unit.id === grupo.contaUnitId ? '' : prefixoDaUnidade(unit.slug);
    if (!membro || (unit.id !== grupo.contaUnitId && !prefixo)) {
      logger.warn({ unit: unit.slug }, 'franquia-calendario: unidade em conta dividida sem rótulo próprio — não sei quais cartões são dela, pulei');
      resumo.erros++;
      return resumo;
    }
  }
  const veredictos = new Map<number, Promise<boolean>>(); // um cartão lido uma vez por varredura
  const lerCartao = async (leadId: number): Promise<boolean> => {
    try {
      return podeMexer(veredictoDoCartao(grupo, unit.id, valorDaUnidadeNoCartao(await kommo.getLead(leadId))));
    } catch (err) {
      // cartão que não existe mais: a tarefa nasce solta. Qualquer outro erro (429, timeout) LANÇA: a criação deste agendamento
      // fica para a próxima varredura (nada foi gravado ainda) em vez de nascer solta para sempre por um tropeço passageiro
      if (err instanceof KommoApiError && err.status === 404) return false;
      throw err;
    }
  };
  const cartaoEhDaUnidade = deps.cartaoEhDaUnidade ?? (async (leadId: number) => {
    if (!grupo) return true;
    let v = veredictos.get(leadId);
    if (!v) {
      v = lerCartao(leadId);
      veredictos.set(leadId, v);
      v.catch(() => veredictos.delete(leadId)); // não guarda a falha
    }
    return v;
  });
  let linha: LinhaDeConfig | null;
  try {
    linha = deps.lerConfig ? await deps.lerConfig() : await prisma.unitCalendario.findUnique({ where: { unitId: unit.id } });
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2021') {
      // sem saber o tipo gravado, cair no "Consulta" por nome poderia trocar o tipo da unidade e duplicar a agenda: não faz nada
      logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: não consegui ler unit_calendario — nada feito nesta varredura');
      resumo.erros++;
      return resumo;
    }
    linha = null; // P2021 = a tabela ainda não existe (a migration não rodou): vale o .env, como antes deste passo existir
  }
  const config = configDaUnidade(unit.slug, linha);

  // 1. a agenda da franquia. Sem ela não se decide nada (nem fechar: agenda vazia por pane não é agenda vazia).
  const { de, ate } = janelaDoCalendario(tz, agora);
  const ag = deps.buscarAgenda
    ? await deps.buscarAgenda(de, ate)
    // FORA da trava global do sincronizador (`comVaga`, 6): ele segura cada vaga a varredura INTEIRA da unidade (~15 min), e o calendário
    // esperaria na fila por uma rodada. O limite do calendário é o PRÓPRIO: `rodarEmFaixas` (FRANQUIA_CALENDARIO_PARALELO, padrão 3 contas).
    : await SpineService.searchSchedules(unit, { initialDate: de, endDate: ate, rowsPerPage: 100 }).then((r) => ({
        ok: r.ok, erro: r.error, agendamentos: r.data?.schedules ?? [], truncada: r.data?.truncada,
      }));
  if (!ag.ok) {
    logger.warn({ unit: unit.slug, erro: ag.erro }, 'franquia-calendario: agenda indisponível — nada feito');
    resumo.erros++;
    return resumo;
  }
  resumo.agendamentos = ag.agendamentos.length;
  if (ag.truncada) logger.warn({ unit: unit.slug }, 'franquia-calendario: a franquia tinha mais páginas que o teto — lista incompleta, não dou tarefa por sumida');

  // 2. as tarefas abertas do Kommo (a fonte da verdade da idempotência)
  const conta = kommo.subdomain;
  const taskTypeId = await tipoDeTarefa(unit, kommo, conta, config.tipo);
  if (taskTypeId === null) {
    resumo.erros++;
    return resumo;
  }
  // a janela em epoch, pelo relógio da clínica: de 00:00 de hoje-14 até 00:00 do dia seguinte ao último
  const deEpoch = epochDaConsulta(localParaUtcIso(`${de}T00:00:00`, tz)) ?? 0;
  const ateEpoch = epochDaConsulta(localParaUtcIso(`${somarDias(ate, 1)}T00:00:00`, tz)) ?? 0;
  let abertas: KommoTarefa[] = [];
  let completa = true;
  try {
    ({ tarefas: abertas, completa } = await kommo.listarTarefas({ taskTypeId }));
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: não consegui ler as tarefas abertas — nada feito (criaria duplicada)');
    resumo.erros++;
    return resumo;
  }
  resumo.tarefasAbertas = abertas.length;
  if (!completa) logger.warn({ unit: unit.slug, lidas: abertas.length }, 'franquia-calendario: lista de tarefas cortada no teto — não crio tarefa nova nesta varredura');
  // As CONCLUÍDAS da janela: tarefa que a recepção deu por feita (ou que nós fechamos) não se recria. Sem esta leitura, concluir
  // uma consulta ainda AGENDADA faria o worker criar outra a cada 10 min. Falhou = não crio nada novo (pode ser duplicada).
  let concluidas: KommoTarefa[] = [];
  try {
    const r = await kommo.listarTarefas({ taskTypeId, concluidas: true, completeTillDe: deEpoch, completeTillAte: ateEpoch });
    concluidas = r.tarefas;
    resumo.concluidasLidas = r.tarefas.length;
    if (!r.completa) completa = false;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: não consegui ler as tarefas concluídas — não crio tarefa nova nesta varredura');
    resumo.erros++;
    completa = false;
  }

  // 3. decide
  const plano = planejarCalendario({
    agendamentos: ag.agendamentos,
    tarefas: abertas.map(paraTarefa),
    concluidas: concluidas.map((t) => ({ ...paraTarefa(t), resultado: t.result?.text ?? null })),
    agoraEpoch: Math.floor(agora.getTime() / 1000),
    tz,
    janela: { deEpoch, ateEpoch },
    remarcado: process.env.FRANQUIA_CALENDARIO_REMARCADO === 'fechar' ? 'fechar' : 'manter',
    prefixo,
  });
  resumo.passados = plano.passados;
  resumo.jaConcluidas = plano.jaConcluidas;
  resumo.ignorados = plano.ignorados;

  // dono configurado = esse, sem troca. Sem dono: o `createTask` aplica a regra de sempre (o único usuário da clínica, nunca o login da consultoria)
  const responsavel = config.responsavel ?? undefined;
  if (responsavel === undefined) await avisarSeNaoHaDonoUnico(unit, kommo);
  else avisadasSemDono.delete(unit.slug); // dono configurado: se for removido depois, avisa de novo
  const durationSec = config.duracaoMin !== null ? config.duracaoMin * 60 : DURACAO_PADRAO_SEG;

  const idsPorPaciente = new Map<string, number[]>();
  for (const s of ag.agendamentos) {
    if (!s.clientName || typeof s.idSchedule !== 'number') continue;
    const k = normalizar(s.clientName);
    idsPorPaciente.set(k, [...(idsPorPaciente.get(k) ?? []), s.idSchedule]);
  }

  // 4. aplica (ou, em seco, só conta e loga)
  const abertasPorId = new Map(abertas.map((t) => [t.id, paraTarefa(t)]));
  let linhasSeco = 0;
  const dizer = (o: Record<string, unknown>, msg: string) => {
    if (aplicar || linhasSeco++ >= MAX_LINHAS_DE_LOG_SECO) return;
    logger.info({ unit: unit.slug, ...o }, `franquia-calendario: [seco] ${msg}`);
  };
  let criadasAgora = 0; // criações que DERAM CERTO: é o que gasta a cota
  let recusasSeguidas = 0; // recusas explícitas do Kommo (400/404/422) em fila: recusa permanente não se repete 160 vezes por rodada
  let criacoesSuspensas = false;
  let tentativasAgora = 0; // criações tentadas (inclui as que falharam): teto para uma falha geral não martelar o Kommo e a franquia
  const aplicarAcao = async (a: Acao): Promise<void> => {
    if (a.tipo === 'sumiu') {
      if (ag.truncada) return; // busca incompleta: não dá para dizer que sumiu
      resumo.sumiram++;
      logger.info({ unit: unit.slug, idSchedule: a.idSchedule, taskId: a.taskId }, 'franquia-calendario: tarefa aberta sem agendamento na busca — deixei como está');
      return;
    }
    if (a.tipo === 'fechar') {
      dizer({ idSchedule: a.idSchedule, taskId: a.taskId, resultado: a.resultado }, 'fecharia');
      if (aplicar) {
        await kommo.fecharTarefa(a.taskId, a.resultado);
        await dormir(pausa);
      }
      resumo.fechadas++;
      return;
    }
    if (a.tipo === 'atualizar') {
      const assinatura = `${a.texto ?? ''}|${a.completeTill ?? ''}`;
      const chave = `${unit.id}:${a.idSchedule}`;
      const antes = ultimaAtualizacao.get(chave);
      const agoraVisto = estadoVisto(abertasPorId.get(a.taskId));
      // Só trava se for o MESMO pedido E a tarefa continua exatamente como estava quando o mandei: aí o Kommo não guarda o que
      // envio. Se alguém mexeu na tarefa desde então (o estado visto mudou), a correção legítima passa.
      if (aplicar && antes && antes.assinatura === assinatura && antes.visto === agoraVisto) {
        // já mandei exatamente isto e o Kommo continua igual: não regravo a cada varredura (dois escritores = regravação eterna)
        logger.warn({ unit: unit.slug, idSchedule: a.idSchedule, taskId: a.taskId }, 'franquia-calendario: o Kommo não guardou a atualização anterior — não regravo');
        return;
      }
      dizer({ idSchedule: a.idSchedule, taskId: a.taskId, texto: a.texto, completeTill: a.completeTill }, 'atualizaria');
      if (aplicar) {
        await kommo.atualizarTarefa(a.taskId, {
          ...(a.texto !== null ? { text: a.texto } : {}),
          ...(a.completeTill !== null ? { completeAt: a.completeTill, durationSec: durationSec || undefined } : {}),
        });
        ultimaAtualizacao.set(chave, { assinatura, visto: agoraVisto }); // só depois de gravar: PATCH que falhou tenta de novo na próxima
        await dormir(pausa);
      }
      resumo.atualizadas++;
      return;
    }
    // criar
    if (!completa) return;
    const recente = criadasRecentes.get(`${unit.id}:${a.idSchedule}`);
    if (recente && Date.now() - recente < CRIADA_RECENTE_MS) return;
    if (criacoesSuspensas || criadasAgora >= MAX_CRIAR_POR_VARREDURA || tentativasAgora >= MAX_CRIAR_POR_VARREDURA * 2) {
      resumo.adiadas++;
      return;
    }
    tentativasAgora++;
    const nome = a.item.clientName ?? '';
    const ids = idsPorPaciente.get(normalizar(nome)) ?? [a.idSchedule];
    const r = deps.resolver
      ? await deps.resolver(nome, ids)
      : await resolverPaciente(unit, kommo, nome, null, ids, cacheDoCalendario).then((x) => ({ leadId: x.leadId, confirmado: x.leadConfirmado, fone: x.fone ?? null }));
    // Só cartão PROVADO recebe a tarefa: telefone que casa com vários cartões (mãe e filha dividem o WhatsApp) é palpite. E, em Kommo
    // dividido, só o cartão que o campo «⌂ Unidade de atendimento» diz ser desta unidade.
    let leadId = r.leadId !== null && r.confirmado && (await cartaoEhDaUnidade(r.leadId)) ? r.leadId : null;
    // O nome do paciente da franquia vai em TODA tarefa: dois homônimos podem cair no mesmo cartão, e assim a recepção vê quem é.
    // O telefone vem do próprio `resolverPaciente` (já cacheado); nada de segunda busca na franquia.
    let texto = textoDaTarefa(a.item, tz, leadId === null ? sufixoDeTarefaSolta(nome, r.fone ?? null) : sufixoComCartao(nome), prefixo);
    dizer({ idSchedule: a.idSchedule, leadId, solta: leadId === null, texto, completeTill: a.completeTill }, 'criaria');
    if (aplicar) {
      // marcada ANTES do POST: num timeout o Kommo pode ter gravado a tarefa, e a lista da próxima varredura pode ainda não mostrá-la
      criadasRecentes.set(`${unit.id}:${a.idSchedule}`, Date.now());
      const postar = (lead: number | null, txt: string) => kommo.createTask({
        leadId: lead, text: txt, completeAt: a.completeTill, responsibleUserId: responsavel, taskTypeId, manterResponsavel: responsavel !== undefined,
        durationSec: durationSec || undefined,
      });
      const recusou = (err: unknown): err is KommoApiError => err instanceof KommoApiError && [400, 404, 422].includes(err.status ?? 0);
      // recusa explícita: a tarefa NÃO nasceu, então a marca não pode esconder o agendamento por 30 min (timeout/5xx: pode ter nascido, a marca fica);
      // a pausa vale também no erro (o intervalo mínimo entre pedidos é da conta do Kommo, dividida com a Sofia da rede toda); e 3 recusas
      // seguidas são recusa permanente (tipo apagado, dono desativado): para de criar nesta unidade até a próxima rodada
      const contarRecusa = async (err: KommoApiError) => {
        criadasRecentes.delete(`${unit.id}:${a.idSchedule}`);
        await dormir(pausa);
        if (++recusasSeguidas >= LIMITE_DE_RECUSAS_SEGUIDAS) {
          criacoesSuspensas = true;
          logger.warn(
            { unit: unit.slug, status: err.status, taskTypeId, responsavel: responsavel ?? null },
            `franquia-calendario: o Kommo recusou ${LIMITE_DE_RECUSAS_SEGUIDAS} criações seguidas — paro de criar nesta unidade até a próxima rodada (tipo de tarefa apagado? dono desativado?)`,
          );
        }
      };
      let feita: { id?: number } | null;
      try {
        feita = await postar(leadId, texto);
      } catch (err) {
        if (!recusou(err)) throw err;
        if (leadId === null) { await contarRecusa(err); throw err; }
        // o culpado pode ser o CARTÃO (mesclado ou apagado entre a leitura e o POST) e não a conta: uma tentativa SOLTA, com nome e telefone
        await dormir(pausa);
        leadId = null;
        texto = textoDaTarefa(a.item, tz, sufixoDeTarefaSolta(nome, r.fone ?? null), prefixo);
        try {
          feita = await postar(null, texto);
        } catch (err2) {
          if (recusou(err2)) await contarRecusa(err2);
          throw err2;
        }
      }
      if (!feita) {
        resumo.erros++;
        logger.warn({ unit: unit.slug, idSchedule: a.idSchedule, solta: leadId === null }, 'franquia-calendario: o Kommo não devolveu o id da tarefa criada');
        await dormir(pausa);
        return;
      }
      recusasSeguidas = 0;
      await dormir(pausa);
    }
    criadasAgora++;
    resumo.criadas++;
    if (leadId === null) {
      resumo.semCartao++;
      if (r.leadId !== null) resumo.cartaoIncerto++;
    }
  };
  for (const a of plano.acoes) {
    try {
      await aplicarAcao(a);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: unit.slug, idSchedule: a.idSchedule, tipo: a.tipo }, 'franquia-calendario: falha na tarefa');
    }
  }
  return resumo;
}

// ── relógio ──────────────────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

/**
 * Uma unidade por CONTA do Kommo. Duas unidades na mesma conta FORA de um grupo (Imperatriz e os "-resgate/-financeiro/-tratamento"
 * usam o subdomínio da principal) leriam a mesma lista de tarefas com o mesmo `[ag:N]`: duplicariam a agenda ou fechariam a tarefa
 * da outra. Dentro de um grupo (Petrópolis × Caxias) o prefixo do marcador separa as duas, e elas ficam na MESMA faixa. Pura.
 * `unidades` vem na ordem em que as recusas devem ser decididas: a primeira de cada conta fica.
 */
export function faixasPorConta<T extends { slug: string }>(
  unidades: ReadonlyArray<{ unit: T; conta: string; grupoId: string | null }>,
): { faixas: T[][]; recusadas: Array<{ unit: T; conta: string; motivo: string }> } {
  const porConta = new Map<string, Array<{ unit: T; grupoId: string | null }>>();
  for (const u of unidades) porConta.set(u.conta, [...(porConta.get(u.conta) ?? []), u]);
  const faixas: T[][] = [];
  const recusadas: Array<{ unit: T; conta: string; motivo: string }> = [];
  for (const [conta, lista] of porConta) {
    // a unidade "de verdade" (doutor-hernia-*) fica; as auxiliares da mesma conta (-resgate, -financeiro...) são as recusadas
    lista.sort((a, b) => Number(b.unit.slug.startsWith('doutor-hernia-')) - Number(a.unit.slug.startsWith('doutor-hernia-')));
    const grupoDaConta = lista.find((x) => x.grupoId !== null)?.grupoId ?? null;
    const aceitas = grupoDaConta ? lista.filter((x) => x.grupoId === grupoDaConta) : lista.slice(0, 1);
    for (const x of lista) {
      if (aceitas.includes(x)) continue;
      recusadas.push({ unit: x.unit, conta, motivo: `a conta ${conta} já é atendida por ${aceitas[0].unit.slug}${grupoDaConta ? ' (conta dividida)' : ''}` });
    }
    faixas.push(aceitas.map((x) => x.unit));
  }
  return { faixas, recusadas };
}

let ultimoAvisoDeSlugs = '';
const recusadasAvisadas = new Set<string>();

/** As unidades que rodam agora, em faixas (uma por conta do Kommo): com franquia e Kommo, ATIVAS, e ligadas (ou em "só no papel") na tela ou no `.env`. */
async function unidadesDoCalendario(): Promise<Unit[][]> {
  const units = await prisma.unit.findMany({ where: { ...(await ondeTemSync()), isActive: true }, orderBy: { id: 'asc' } });
  const doCalendario = units.filter((u) => modoDoCalendario(u.slug, undefined, estadoGravado(u.slug, ID_AUTOMACAO)) !== 'desligado');
  // slug do .env escrito errado, ou unidade sem token da franquia/Kommo: sem este aviso o passo "liga" e não faz nada, em silêncio
  const raw = process.env.FRANQUIA_CALENDARIO_SLUGS;
  if (raw && raw.replace(/['"\s]/g, '')) {
    const achados = new Set(units.map((u) => u.slug));
    const faltam = raw.replace(/['"]/g, '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*' && !achados.has(s));
    const chave = faltam.join(',');
    if (chave !== ultimoAvisoDeSlugs) {
      ultimoAvisoDeSlugs = chave;
      if (faltam.length) logger.warn({ faltam }, 'franquia-calendario: slug da lista sem unidade ativa com franquia e Kommo configurados');
    }
  }
  const comConta = [];
  for (const unit of doCalendario) {
    try {
      const dona = await contaDoKommo(unit);
      const conta = (dona.kommoSubdomain ?? '').trim().toLowerCase() || `unit:${dona.id}`;
      comConta.push({ unit, conta, grupoId: (await grupoDaUnidade(unit.id))?.contaUnitId ?? null });
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: não consegui descobrir a conta do Kommo desta unidade — pulei só ela');
    }
  }
  const { faixas, recusadas } = faixasPorConta(comConta);
  for (const r of recusadas) {
    if (recusadasAvisadas.has(r.unit.slug)) continue;
    recusadasAvisadas.add(r.unit.slug);
    logger.warn({ unit: r.unit.slug, conta: r.conta }, `franquia-calendario: unidade ligada RECUSADA — ${r.motivo}; duas unidades no mesmo Kommo fora de um grupo duplicariam a agenda. Desligue uma das duas`);
  }
  return faixas;
}

/**
 * Roda `fn` em cada item, com até `paralelo` FAIXAS ao mesmo tempo; dentro de uma faixa é um de cada vez. Uma faixa é uma conta do Kommo
 * (Petrópolis e Caxias dividem a conta e o limite de requisições dela, então ficam na mesma faixa).
 */
export async function rodarEmFaixas<T>(faixas: T[][], paralelo: number, fn: (item: T) => Promise<void>): Promise<void> {
  let proxima = 0;
  const trabalhador = async () => {
    while (proxima < faixas.length) {
      const faixa = faixas[proxima++];
      for (const item of faixa) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(paralelo, faixas.length)) }, trabalhador));
}

/** Quantas contas do Kommo a rodada atende ao mesmo tempo: `FRANQUIA_CALENDARIO_PARALELO`, padrão 3, de 1 a 6 (o teto do sincronizador). */
export function paraleloDoCalendario(raw: string | undefined = process.env.FRANQUIA_CALENDARIO_PARALELO): number {
  const n = Math.floor(Number((raw ?? '').replace(/^['"]|['"]$/g, '')));
  return Number.isFinite(n) && n > 0 ? Math.min(6, n) : 3;
}

async function varrerTodas(): Promise<void> {
  if (rodando) {
    logger.warn('franquia-calendario: batida descartada — a varredura anterior ainda não terminou');
    return;
  }
  rodando = true;
  const inicio = Date.now();
  let unidades = 0;
  try {
    const faixas = await unidadesDoCalendario();
    unidades = faixas.reduce((n, f) => n + f.length, 0);
    await rodarEmFaixas(faixas, paraleloDoCalendario(), async (unit) => {
      const t0 = Date.now();
      try {
        const r = await varrerCalendario(unit);
        logger.info({ ...r, ms: Date.now() - t0 }, 'franquia-calendario: varredura concluída');
      } catch (err) {
        logger.error({ err, unit: unit.slug }, 'franquia-calendario: varredura falhou');
      }
    });
  } catch (err) {
    logger.error({ err }, 'franquia-calendario: a rodada falhou antes de varrer');
  } finally {
    rodando = false;
    // a duração da rodada inteira é o que diz se o intervalo cabe: rodada maior que o intervalo descarta a batida seguinte
    if (unidades > 0) logger.info({ unidades, ms: Date.now() - inicio, intervaloMs: intervaloDoCalendarioMs(), paralelo: paraleloDoCalendario() }, 'franquia-calendario: rodada concluída');
  }
}

export function startFranquiaCalendarioWorker(): void {
  if (timer || primeira) return;
  const slugs = process.env.FRANQUIA_CALENDARIO_SLUGS;
  logger.info(
    { slugs: slugs || '(vazio = só o que a tela ligar)', aplicar: process.env.FRANQUIA_CALENDARIO_APLICAR || '(vazio = seco)', intervaloMin: intervaloDoCalendarioMs() / 60_000 },
    'franquia-calendario: worker iniciado',
  );
  primeira = setTimeout(() => void varrerTodas(), PRIMEIRA_MS);
  timer = setInterval(() => void varrerTodas(), intervaloDoCalendarioMs());
}

export function stopFranquiaCalendarioWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
