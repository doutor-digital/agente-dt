import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { reivindicarComCerteza } from './dedup-cache.js';
import { emPausa } from './pausa-unidade.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { conferirEquipe, ehRespostaAutomatica } from './pausa-equipe.js';
import { textoDaTarefa } from './sem-resposta-worker.js';
import { createKommoClient, isLeadPaused } from '../services/kommo.service.js';
import { enviosDaSofia, mensagensOficiaisDaUnidade, type MensagemOficial } from '../services/kommo-talks.service.js';
import { guardarRespostaSegurada, marcarNaoEntregue } from '../agent/entrega-falha.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import { idsEmVoo } from './agent-coalescer.js';
import type { EstadoLideranca } from './worker-lease.js';

/**
 * Recuperação no start: o deploy (ou uma queda) matou um turno da IA no meio e ninguém retomou.
 *
 * Caso real (Timbó, lead 5142896, 30/10/2026): 17:00:47 a paciente mandou um áudio e a IA SEGUROU a resposta ("atropelada")
 * porque às 17:01:05 chegou uma foto. A foto esperava a janela do coalescer, em memória; o serviço reiniciou nesse intervalo
 * e o trace ficou RUNNING. A paciente ficou sem resposta nenhuma. Na rede, 38 traces RUNNING há mais de 10 min em 24 h,
 * concentrados nas horas de deploy. (A drenagem do SIGTERM, #179, evita a maior parte; isto cobre o que sobrar.)
 *
 * REGRA-MÃE: na dúvida, TAREFA para a recepção em vez de resposta. Resposta em dobro, ou por cima da recepção, é pior
 * que atraso — e atraso com tarefa no cartão deixa de ser silêncio. Só volta para a IA o pedido sobre o qual TUDO
 * se sabe: ninguém respondeu, nada pausa, o turno morto não tinha passado do webhook, e o Kommo foi lido e conferido.
 *
 * O que decide, nesta ordem (cada regra tem um teste):
 *  - SÓ o líder do `worker_leases` em modo `lease` varre (= o container antigo já soltou o lease no fim da drenagem) e só
 *    por `JANELA_APOS_LIDERANCA_MS` depois de assumir;
 *  - o PISO da busca é a posse da liderança (menos `FOLGA_ANTES_DA_POSSE_MS`), não "2 h atrás": trace preso por outro
 *    motivo, de antes do deploy, não é reprocessado — fica para investigar;
 *  - a unidade é REFEITA pela etapa do cartão (`resolveOwnerUnitByStage`), não a gravada no trace: o paciente pode ter
 *    mudado de funil/IA desde então;
 *  - já respondido (qualquer unidade da mesma conta do Kommo no banco, e a conversa oficial do Kommo — que pega a
 *    recepção pelo celular) → fecha, não refaz. Independe da chave `pausa-equipe`;
 *  - IA pausada (unidade, cartão com data, caixinha) → fecha, a equipe é quem atende;
 *  - não consegui ler o Kommo, ou a equipe estava na conversa → TAREFA (não sei se posso falar por cima);
 *  - trace que já tinha passo de modelo ou ferramenta → NÃO reinjeta (o modelo veria a mensagem 2× e poderia marcar
 *    consulta ou mandar Pix de novo) → TAREFA;
 *  - fora do horário no momento da retomada → TAREFA (o turno normal mandaria a mensagem de "fora do horário");
 *  - UMA vez só: o `claimMessageId` é gravado no banco e RECUSA se o banco falhar;
 *  - o pedido volta pelo coalescer, então vários pedidos perdidos do mesmo paciente viram UM turno;
 *  - a resposta que estava "segurada" é restaurada a partir do passo gravado no trace (o `<entrega_falhou>`).
 *
 * Todo trace que NÃO foi retomado fecha FAILED com o motivo — nunca SUCCESS, que esconderia um paciente sem resposta.
 * Desligar: `RECUPERAR_TURNOS_DESLIGADO=1`.
 */

/** Primeira varredura depois do boot, e de quanto em quanto tempo repete (só o líder varre de fato). */
export const ATRASO_INICIAL_MS = 60_000;
export const INTERVALO_MS = 120_000;
/** Depois de virar líder, varre por este tempo e para (cobre as mensagens dos últimos segundos do antigo). */
export const JANELA_APOS_LIDERANCA_MS = 10 * 60_000;
/** Trace mais novo que isto ainda pode estar vivo no processo antigo, ainda drenando. */
export const IDADE_MINIMA_MS = 120_000;
/**
 * Quanto ANTES de eu virar líder um trace ainda conta como "do deploy". O container antigo morre antes de eu assumir:
 * se ele solta o lease no fim da drenagem a diferença é de segundos; se levou SIGKILL, o lease vence até 90 s depois e o
 * tick de 30 s pode atrasar mais — e o trace nasceu antes da morte. Pouco mais que isso e já é "preso por outro motivo".
 */
export const FOLGA_ANTES_DA_POSSE_MS = 3 * 60_000;
/**
 * Reivindicação que já era de outro e o trace continua RUNNING depois de tanto tempo: a tentativa morreu (um segundo
 * deploy no meio da recuperação). Quem varre é o líder, então um dono vivo só existiria numa troca de lease; um turno
 * leva segundos, e o trace já nasceu há mais que `IDADE_MINIMA_MS`.
 */
export const IDADE_TENTATIVA_MORTA_MS = 5 * 60_000;
export const MAX_POR_VARREDURA = 50;
/** Quanto tempo a reivindicação vale. Maior que a janela de busca: o trace nunca é candidato duas vezes. */
export const TTL_REIVINDICACAO_MS = 24 * 60 * 60_000;
export const ESCOPO_REIVINDICACAO = 'turno-recuperado';
export const MARCA_ABANDONADO = '__abandoned_by_restart__';
/** Uma tarefa por paciente (a marca é do cartão, não do trace). */
export const REGRA_TAREFA_TURNO_PERDIDO = 'turno_perdido_tarefa';
export const REALERTA_TAREFA_MS = 12 * 3600_000;
/** Tolerância de relógio entre o Kommo e o nosso banco ao perguntar "saiu mensagem depois do pedido?". */
export const FOLGA_RELOGIO_MS = 2_000;
/**
 * Quantas voltas um trace que ficou SEM decisão (o Kommo ou o banco falhou, a reivindicação é de outro e ainda é recente)
 * pode ocupar a fila. Passado disso sai da consulta: sem o teto, 50 traces assim, que voltam ao topo a cada 2 min por
 * ordem de idade, esconderiam os perdidos mais novos. Três voltas cobrem a idade da `IDADE_TENTATIVA_MORTA_MS`.
 */
export const MAX_VOLTAS_SEM_DECISAO = 3;

export interface TurnoPerdido {
  traceId: string;
  unitId: string;
  leadId: string;
  criadoEm: Date;
  input: unknown;
}

export interface RespostaSegurada {
  reply: string;
  mensagemId: string | null;
}

/**
 * `retomado`: foi para o coalescer. `descartado:x`: não é para responder (o trace fecha com x).
 * `tarefa:x`: não é para a IA responder e a recepção precisa saber (tarefa no cartão, trace fecha com x).
 */
export type ResultadoRetomada = 'retomado' | `descartado:${string}` | `tarefa:${string}`;

export interface PassoGravado {
  kind: string;
  title: string;
}

export interface ConversaLida {
  msgs: MensagemOficial[];
  /** A equipe tem a palavra (fala humana depois da última da IA, nas últimas 24 h, sem devolução à Sofia). */
  equipeComAPalavra: boolean;
  /** Não deu para conferir a caixinha "Pausar IA" — sem certeza, não é para falar. */
  naoConferi: boolean;
}

/** O que o controller sabe fazer e este módulo não (precisa do `processAgent` e do esquema de unidades). */
export interface GanchosDoController {
  /** Unidade DONA do paciente agora (etapa do cartão); null = unidade inativa ou lead inválido. */
  unidadeDona(t: TurnoPerdido): Promise<Unit | null>;
  retomar(t: TurnoPerdido, unit: Unit): Promise<ResultadoRetomada>;
  /** Para o texto da tarefa: nome do contato e a mensagem. */
  resumoDoPedido(t: TurnoPerdido): { contato: string | null; texto: string };
}

export interface DepsRecuperacao extends GanchosDoController {
  agora(): number;
  /** Traces que este processo tem na fila ou rodando: não estão perdidos, nunca são candidatos. */
  idsEmVoo(): string[];
  /** `excluirIds` entra na consulta (antes do limite): os que estão em voo não podem ocupar as vagas dos perdidos. */
  buscarPerdidos(p: { criadosAntes: Date; criadosDepois: Date; limite: number; excluirIds: string[] }): Promise<TurnoPerdido[]>;
  passosDoTrace(traceId: string): Promise<PassoGravado[]>;
  /** Mensagem da IA para este lead (QUALQUER unidade da mesma conta do Kommo) depois de `desde`? */
  respondidoNoBanco(unit: Unit, leadId: string, desde: Date): Promise<boolean>;
  /** Conversa oficial do Kommo. LANÇA se não leu. */
  lerConversa(unit: Unit, leadId: string): Promise<ConversaLida>;
  iaPausada(unit: Unit, leadId: string): Promise<boolean>;
  /** A unidade está fora do horário de atendimento da IA agora? */
  foraDoHorario(unit: Unit): boolean;
  /** Atômico e permanente: `ganhou` só para o primeiro que pedir. `incerto` = o banco não respondeu (não refaz, tenta na volta seguinte). */
  reivindicar(traceId: string): Promise<'ganhou' | 'perdeu' | 'incerto'>;
  /** Respostas seguradas ("atropelada") deste paciente que ele nunca leu, mais antigas primeiro. */
  seguradasPendentes(unit: Unit, leadId: string, aPartirDe: Date): Promise<RespostaSegurada[]>;
  restaurarSegurada(unit: Unit, leadId: string, s: RespostaSegurada): void;
  /** Abre a tarefa no cartão. `ja_existia` = o mesmo paciente já tem uma (não duplica). LANÇA se o Kommo recusou. */
  criarTarefa(unit: Unit, t: TurnoPerdido, esperaMs: number): Promise<'criada' | 'ja_existia'>;
  /** Fecha o trace como FAILED (só se ainda estiver RUNNING). */
  encerrar(traceId: string, motivo: string): Promise<void>;
}

export interface OpcoesVarredura {
  /** Voltas que cada trace já gastou sem decisão; a varredura lê e atualiza (vive entre as voltas). */
  voltasSemDecisao?: Map<string, number>;
  /** Mandou parar (shutdown, perdeu a liderança): não começa paciente novo nem retoma nada. */
  parar?: () => boolean;
}

export interface ResumoRecuperacao {
  candidatos: number;
  retomados: number;
  tarefas: number;
  tarefasFalhas: number;
  descartados: Record<string, number>;
}

// ── parte pura ─────────────────────────────────────────────────────────────────────────────────────────

/** A janela de busca: do piso (posse da liderança menos a folga) até "velho o bastante para não estar vivo". */
export function janelaDeBusca(agora: number, posse: Date): { criadosAntes: Date; criadosDepois: Date } {
  return {
    criadosAntes: new Date(agora - IDADE_MINIMA_MS),
    criadosDepois: new Date(posse.getTime() - FOLGA_ANTES_DA_POSSE_MS),
  };
}

/** O `where` da busca. Fora de `depsDeProducao` para o teste pegar quem tirar um filtro. */
export function filtroDePerdidos(p: { criadosAntes: Date; criadosDepois: Date; excluirIds: string[] }) {
  return {
    channel: 'kommo_chat',
    status: 'RUNNING' as const,
    unitId: { not: null },
    createdAt: { lt: p.criadosAntes, gt: p.criadosDepois },
    ...(p.excluirIds.length ? { id: { notIn: p.excluirIds } } : {}),
  };
}

/** Como o trace abandonado é fechado: SEMPRE FAILED (SUCCESS esconderia um paciente sem resposta), com o motivo. */
export function dadosDeEncerramento(motivo: string) {
  return {
    status: 'FAILED' as const,
    iaDecision: `${MARCA_ABANDONADO}:${motivo}`,
    errorMessage: `abandonado: o serviço reiniciou no meio do turno (${motivo})`,
  };
}

/** A posse da liderança — só em modo `lease`. Em `sem-lease` (banco fora) o processo se declara líder SEM ter soltado o antigo. */
export function posseDaLideranca(e: EstadoLideranca | null): Date | null {
  return e && e.lider && e.modo === 'lease' ? e.desde : null;
}

/**
 * Passos que o turno grava ANTES de o modelo rodar (leitura de áudio e imagem, aviso de burst, a própria retomada).
 * Qualquer outro — modelo, ferramenta, ação no Kommo, erro, resposta — significa que o turno AVANÇOU, e o que ele fez
 * não dá para desfazer nem saber de fora. Lista de permitidos de propósito: passo novo que ninguém previu conta como avanço.
 */
const PASSOS_ANTES_DO_MODELO: readonly RegExp[] = [
  /^Burst coalescido/,
  /^Áudio (\d+\/\d+ )?transcrito/,
  /^(Imagem|Arquivo) (\d+\/\d+ )?lido/,
  /^♻ Retomado/,
];

export function turnoJaAvancou(passos: readonly PassoGravado[]): boolean {
  return passos.some((p) => {
    if (p.kind === 'WEBHOOK_RECEIVED') return false;
    return !(p.kind === 'THINKING' && PASSOS_ANTES_DO_MODELO.some((re) => re.test(p.title)));
  });
}

/**
 * Saiu mensagem para o paciente depois do pedido? Qualquer saída conta (equipe pelo Kommo ou pelo celular, Sofia, robô)
 * — menos a resposta automática do WhatsApp Business (saudação/ausência), que não responde nada.
 */
export function saiuMensagemDepois(msgs: readonly MensagemOficial[], desde: Date): boolean {
  const piso = desde.getTime() - FOLGA_RELOGIO_MS;
  return msgs.some((m) => m.direcao === 'saida' && m.em.getTime() > piso && !ehRespostaAutomatica(m, msgs));
}

// ── orquestração ───────────────────────────────────────────────────────────────────────────────────────

export async function recuperarTurnosPerdidos(deps: DepsRecuperacao, posse: Date, opcoes: OpcoesVarredura = {}): Promise<ResumoRecuperacao> {
  const agora = deps.agora();
  const resumo: ResumoRecuperacao = { candidatos: 0, retomados: 0, tarefas: 0, tarefasFalhas: 0, descartados: {} };
  const voltas = opcoes.voltasSemDecisao ?? new Map<string, number>();
  const parar = opcoes.parar ?? (() => false);

  // Nunca candidatos: o que este processo tem em voo e o que já gastou as voltas sem decisão.
  const fora = new Set([...deps.idsEmVoo(), ...[...voltas].filter(([, n]) => n >= MAX_VOLTAS_SEM_DECISAO).map(([id]) => id)]);
  const perdidos = (
    await deps.buscarPerdidos({ ...janelaDeBusca(agora, posse), limite: MAX_POR_VARREDURA, excluirIds: [...fora] })
  ).filter((t) => !fora.has(t.traceId)); // de novo, por garantia: quem implementa a consulta pode ignorar o filtro
  resumo.candidatos = perdidos.length;
  if (perdidos.length === 0) return resumo;

  // Quem terminou a volta ainda RUNNING e fora do coalescer não foi decidido: gasta uma volta.
  const decididos = new Set<string>();
  const contarSemDecisao = (): void => {
    for (const t of perdidos) {
      if (!decididos.has(t.traceId)) voltas.set(t.traceId, (voltas.get(t.traceId) ?? 0) + 1);
    }
  };

  // Um paciente por vez; dentro dele, na ordem em que escreveu.
  const gravados = new Map<string, TurnoPerdido[]>();
  for (const t of [...perdidos].sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime())) {
    const k = `${t.unitId}::${t.leadId}`;
    gravados.set(k, [...(gravados.get(k) ?? []), t]);
  }

  // A unidade é a DONA de agora (etapa do cartão), e dois grupos gravados em unidades diferentes que hoje têm a mesma
  // dona viram um só — senão sairiam dois turnos paralelos para o mesmo cartão.
  // Tudo o que é fechado ou retomado conta como decidido (a unica porta é `deps.encerrar` e o `retomado`).
  const depsMarcando: DepsRecuperacao = {
    ...deps,
    encerrar: async (id, motivo) => {
      await deps.encerrar(id, motivo);
      decididos.add(id);
    },
  };

  const donos = new Map<string, { unit: Unit; turnos: TurnoPerdido[] }>();
  for (const turnos of gravados.values()) {
    if (parar()) break;
    const primeiro = turnos[0]!;
    let unit: Unit | null;
    try {
      unit = await deps.unidadeDona(primeiro);
    } catch (err) {
      // Não sei de quem é o paciente: não toco (o trace segue RUNNING e a próxima varredura tenta de novo).
      logger.error({ err: String(err), leadId: primeiro.leadId, unitId: primeiro.unitId }, 'recuperar-turnos: não descobri a unidade dona (segue com os outros)');
      continue;
    }
    if (!unit) {
      for (const t of turnos) await fechar(depsMarcando, resumo, t, 'unidade_ou_lead_invalido');
      continue;
    }
    const k = `${unit.id}::${primeiro.leadId}`;
    const atual = donos.get(k);
    donos.set(k, { unit, turnos: [...(atual?.turnos ?? []), ...turnos].sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime()) });
  }

  for (const { unit, turnos } of donos.values()) {
    if (parar()) break;
    try {
      await recuperarDoPaciente(depsMarcando, unit, turnos, agora, resumo, decididos, parar);
    } catch (err) {
      // Um paciente com problema não pode impedir a recuperação dos outros.
      logger.error({ err: String(err), leadId: turnos[0]?.leadId, unit: unit.slug }, 'recuperar-turnos: falha ao recuperar um paciente (segue com os outros)');
    }
  }
  contarSemDecisao();
  return resumo;
}

async function fechar(deps: DepsRecuperacao, resumo: ResumoRecuperacao, t: TurnoPerdido, motivo: string): Promise<void> {
  await deps.encerrar(t.traceId, motivo);
  resumo.descartados[motivo] = (resumo.descartados[motivo] ?? 0) + 1;
}

/**
 * Tarefa para a recepção. UMA por paciente (o texto leva a última mensagem), tentada UMA vez: um timeout do Kommo pode
 * ter criado a tarefa e repetir a duplicaria. Os traces fecham FAILED de qualquer jeito; se o Kommo recusou, o motivo
 * diz e o erro vai para o painel de erros.
 */
async function comTarefa(
  deps: DepsRecuperacao,
  resumo: ResumoRecuperacao,
  unit: Unit,
  turnos: TurnoPerdido[],
  motivo: string,
  agora: number,
): Promise<void> {
  const ultimo = turnos[turnos.length - 1]!;
  let sufixo = '';
  try {
    const r = await deps.criarTarefa(unit, ultimo, agora - turnos[0]!.criadoEm.getTime());
    if (r === 'criada') resumo.tarefas++;
  } catch (err) {
    resumo.tarefasFalhas++;
    sufixo = ':tarefa_nao_confirmada';
    logger.error({ err: String(err), unit: unit.slug, leadId: ultimo.leadId, motivo }, 'recuperar-turnos: a tarefa para a recepção NÃO foi confirmada — paciente sem resposta, confira o cartão');
  }
  for (const t of turnos) await fechar(deps, resumo, t, `${motivo}${sufixo}`);
}

async function recuperarDoPaciente(
  deps: DepsRecuperacao,
  unit: Unit,
  turnos: TurnoPerdido[],
  agora: number,
  resumo: ResumoRecuperacao,
  decididos: Set<string>,
  parar: () => boolean,
): Promise<void> {
  const leadId = turnos[0]!.leadId;

  // 1. Já respondido, no banco (todas as unidades da conta). Cada pedido é julgado sozinho: o primeiro pode ter sido
  //    respondido (trace que só não fechou) e o segundo não.
  let pendentes: TurnoPerdido[] = [];
  for (const t of turnos) {
    if (await deps.respondidoNoBanco(unit, leadId, new Date(t.criadoEm.getTime() - FOLGA_RELOGIO_MS))) {
      await fechar(deps, resumo, t, 'ja_respondida');
    } else {
      pendentes.push(t);
    }
  }
  if (pendentes.length === 0) return;

  // 2. Já respondido, no Kommo: a recepção que respondeu pelo celular não está no nosso banco.
  let conversa: ConversaLida | null = null;
  try {
    conversa = await deps.lerConversa(unit, leadId);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'recuperar-turnos: não li a conversa oficial (vai tarefa, não resposta)');
  }
  if (conversa) {
    const msgs = conversa.msgs;
    const ainda: TurnoPerdido[] = [];
    for (const t of pendentes) {
      if (saiuMensagemDepois(msgs, t.criadoEm)) await fechar(deps, resumo, t, 'ja_respondida');
      else ainda.push(t);
    }
    pendentes = ainda;
    if (pendentes.length === 0) return;
  }

  // 3. IA pausada: a equipe é quem atende.
  if (await deps.iaPausada(unit, leadId)) {
    for (const t of pendentes) await fechar(deps, resumo, t, 'ia_pausada');
    return;
  }

  // 4. Sem certeza do Kommo, ou a equipe tinha a palavra: não falo por cima. Tarefa.
  if (!conversa || conversa.naoConferi) return comTarefa(deps, resumo, unit, pendentes, 'nao_consegui_conferir_o_kommo', agora);
  if (conversa.equipeComAPalavra) return comTarefa(deps, resumo, unit, pendentes, 'equipe_na_conversa', agora);

  // 5. O turno morto já tinha passado do webhook: modelo/ferramenta rodaram e não sei o que fizeram. Qualquer um do
  //    paciente nesse estado leva o grupo todo para a tarefa (a conversa é uma só).
  for (const t of pendentes) {
    if (turnoJaAvancou(await deps.passosDoTrace(t.traceId))) return comTarefa(deps, resumo, unit, pendentes, 'turno_ja_tinha_comecado', agora);
  }

  // 6. Fora do horário: o turno normal mandaria a mensagem de "fora do horário". Aqui, tarefa para o dia seguinte.
  if (deps.foraDoHorario(unit)) return comTarefa(deps, resumo, unit, pendentes, 'fora_do_horario', agora);

  // 7. Uma vez só, em qualquer processo, em qualquer start.
  const meus: TurnoPerdido[] = [];
  const jaTentados: TurnoPerdido[] = [];
  for (const t of pendentes) {
    // O shutdown começou: o turno que eu agendasse morreria com o processo e gastaria a reivindicação à toa.
    if (parar()) return;
    const r = await deps.reivindicar(t.traceId);
    if (r === 'ganhou') meus.push(t);
    else if (r === 'incerto') resumo.descartados.banco_incerto = (resumo.descartados.banco_incerto ?? 0) + 1; // volta seguinte
    else if (agora - t.criadoEm.getTime() > IDADE_TENTATIVA_MORTA_MS) jaTentados.push(t);
    else resumo.descartados.outro_processo_cuida = (resumo.descartados.outro_processo_cuida ?? 0) + 1;
  }
  if (jaTentados.length > 0) await comTarefa(deps, resumo, unit, jaTentados, 'recuperacao_ja_tentada', agora);
  if (meus.length === 0) return;

  // Lidas ANTES de retomar (o turno nasce na janela do coalescer e não pode esperar o banco), aplicadas DEPOIS.
  const seguradas = await deps.seguradasPendentes(unit, leadId, meus[0]!.criadoEm).catch(() => [] as RespostaSegurada[]);
  let restaurou = false;
  for (const t of meus) {
    let r: ResultadoRetomada;
    try {
      r = await deps.retomar(t, unit);
    } catch (err) {
      logger.error({ err: String(err), traceId: t.traceId, leadId }, 'recuperar-turnos: falha ao retomar o turno (vai tarefa)');
      await comTarefa(deps, resumo, unit, [t], 'falha_ao_retomar', agora);
      continue;
    }
    if (r === 'retomado') {
      resumo.retomados++;
      decididos.add(t.traceId);
      if (!restaurou) {
        // A resposta que a IA segurou porque o paciente escreveu de novo não saiu e vive só na memória do processo morto.
        // Só DEPOIS de haver um turno a caminho (a janela do coalescer ainda não fechou): sem turno, a marca ficaria
        // na memória até a próxima mensagem do paciente e a IA pediria desculpa por algo que a conversa já passou.
        restaurou = true;
        for (const s of seguradas) deps.restaurarSegurada(unit, leadId, s);
      }
    } else if (r.startsWith('tarefa:')) {
      await comTarefa(deps, resumo, unit, [t], r.slice('tarefa:'.length), agora);
    } else {
      await fechar(deps, resumo, t, r.slice('descartado:'.length));
    }
  }
}

// ── produção ───────────────────────────────────────────────────────────────────────────────────────────

const TITULO_SEGURADA = '⏭ Resposta segurada';

/** As dependências de verdade: banco, Kommo e a memória do processo. Os ganchos vêm do controller (precisa do processAgent). */
export function depsDeProducao(ganchos: GanchosDoController): DepsRecuperacao {
  return {
    ...ganchos,
    agora: () => Date.now(),
    idsEmVoo: idsEmVoo,
    async buscarPerdidos({ criadosAntes, criadosDepois, limite, excluirIds }) {
      const linhas = await prisma.executionTrace.findMany({
        where: filtroDePerdidos({ criadosAntes, criadosDepois, excluirIds }),
        orderBy: { createdAt: 'asc' },
        take: limite,
        select: { id: true, unitId: true, leadId: true, createdAt: true, input: true },
      });
      return linhas.map((l) => ({ traceId: l.id, unitId: l.unitId!, leadId: l.leadId, criadoEm: l.createdAt, input: l.input }));
    },
    async passosDoTrace(traceId) {
      const passos = await prisma.executionStep.findMany({ where: { traceId }, select: { kind: true, title: true } });
      return passos.map((p) => ({ kind: p.kind, title: p.title }));
    },
    async respondidoNoBanco(unit, leadId, desde) {
      // Todas as unidades da mesma conta do Kommo (comercial e resgate dividem o cartão) — é o que `enviosDaSofia` faz.
      return (await enviosDaSofia(unit, Number(leadId), desde)).length > 0;
    },
    async lerConversa(unit, leadId) {
      const msgs = await mensagensOficiaisDaUnidade(unit, createKommoClient(unit), Number(leadId), 40);
      const l = await conferirEquipe(unit, Number(leadId), undefined, msgs);
      return { msgs, equipeComAPalavra: !!l.fala, naoConferi: l.motivo === 'nao_conferi' };
    },
    async iaPausada(unit, leadId) {
      try {
        // Lida de novo do banco: o `unit` pode ter sido carregado antes de a recepção pausar.
        const atual = await prisma.unit.findUnique({ where: { id: unit.id } });
        if (!atual) return true; // unidade sumiu: não há IA a retomar
        if (emPausa(atual)) return true;
        if (await leadPausadoPorJanela(atual.id, Number(leadId))) return true;
        return await isLeadPaused(atual, Number(leadId));
      } catch (err) {
        // Falha ao perguntar não decide: o turno normal confere tudo de novo antes de gerar e antes de enviar.
        logger.warn({ err: String(err), unit: unit.slug, leadId }, 'recuperar-turnos: não consegui conferir a pausa (o turno confere de novo)');
        return false;
      }
    },
    foraDoHorario(unit) {
      const h = checkBusinessHours(unit);
      return h.enabled && !h.isOpen;
    },
    reivindicar: (traceId) => reivindicarComCerteza(ESCOPO_REIVINDICACAO, traceId, TTL_REIVINDICACAO_MS),
    async seguradasPendentes(unit, leadId, aPartirDe) {
      // A resposta pode ter sido segurada quando o cartão era de OUTRA unidade da mesma conta (comercial ↔ resgate).
      const unidades = unit.kommoSubdomain
        ? (await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } })).map((u) => u.id)
        : [unit.id];
      const unitIds = unidades.length ? unidades : [unit.id];
      // O que a IA segurou e ninguém entregou: depois da última resposta que saiu e até meia hora antes do pedido perdido.
      const ultima = await prisma.message.findFirst({
        where: { role: 'assistant', traceId: { not: null }, conversation: { unitId: { in: unitIds }, leadId } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const piso = new Date(aPartirDe.getTime() - 30 * 60_000);
      const desde = ultima && ultima.createdAt > piso ? ultima.createdAt : piso;
      const passos = await prisma.executionStep.findMany({
        where: {
          kind: 'THINKING',
          title: { startsWith: TITULO_SEGURADA },
          // Sem teto de cima: a resposta é segurada DEPOIS que o pedido perdido chegou (é por causa dele que foi segurada).
          createdAt: { gt: desde },
          trace: { unitId: { in: unitIds }, leadId },
        },
        orderBy: { createdAt: 'asc' },
        select: { payload: true },
      });
      const r: RespostaSegurada[] = [];
      for (const p of passos) {
        const payload = (p.payload ?? {}) as { reply?: unknown; mensagemId?: unknown };
        if (typeof payload.reply === 'string' && payload.reply.trim()) {
          r.push({ reply: payload.reply, mensagemId: typeof payload.mensagemId === 'string' ? payload.mensagemId : null });
        }
      }
      return r;
    },
    restaurarSegurada(unit, leadId, s) {
      marcarNaoEntregue(unit.id, Number(leadId), s.reply, Date.now(), 'atropelada');
      guardarRespostaSegurada(unit.id, Number(leadId), s.mensagemId);
    },
    async criarTarefa(unit, t, esperaMs) {
      const leadId = Number(t.leadId);
      if (await avisoRecente(unit.id, leadId, REGRA_TAREFA_TURNO_PERDIDO, REALERTA_TAREFA_MS)) return 'ja_existia';
      const { contato, texto } = ganchos.resumoDoPedido(t);
      const kommo = createKommoClient(unit);
      // O responsável do cartão; o `createTask` troca o login da consultoria pelo usuário da clínica (quando é um só).
      let responsavel: number | undefined;
      try {
        responsavel = (await kommo.getLead(leadId))?.responsible_user_id || undefined;
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug, leadId }, 'recuperar-turnos: sem o cartão para achar o responsável — a tarefa vai pelo padrão da unidade');
      }
      const criada = await kommo.createTask({
        leadId,
        text: textoDaTarefa({ slug: unit.slug, contato, esperaMs, ultima: texto }),
        completeAt: Math.floor(Date.now() / 1000),
        responsibleUserId: responsavel,
      });
      // 2xx sem o id da tarefa: não dá para afirmar que ela existe.
      if (!criada) throw new Error('o Kommo respondeu sem o id da tarefa');
      await marcarAviso(unit.id, leadId, REGRA_TAREFA_TURNO_PERDIDO);
      return 'criada';
    },
    async encerrar(traceId, motivo) {
      // `status: RUNNING` no filtro: nunca sobrescreve um turno que terminou de verdade entre a busca e agora.
      await prisma.executionTrace.updateMany({ where: { id: traceId, status: 'RUNNING' }, data: dadosDeEncerramento(motivo) });
    },
  };
}

/**
 * Liga a varredura periódica (primeira em `ATRASO_INICIAL_MS`, depois a cada `INTERVALO_MS`). Devolve a função que
 * desliga, para o shutdown chamar. Uma volta nunca começa em cima da outra. `lideranca()` devolve a posse (desde
 * quando este processo é o líder em modo `lease`) ou null quando não é.
 */
export function agendarRecuperacao(ganchos: GanchosDoController, lideranca: () => Date | null): () => void {
  if (process.env.RECUPERAR_TURNOS_DESLIGADO === '1') {
    logger.info('recuperar-turnos: desligado por RECUPERAR_TURNOS_DESLIGADO=1');
    return () => undefined;
  }
  const deps = depsDeProducao(ganchos);
  let parado = false;
  let timer: NodeJS.Timeout | null = null;
  const voltasSemDecisao = new Map<string, number>();
  const proxima = (ms: number): void => {
    if (parado) return;
    timer = setTimeout(() => {
      const posse = lideranca();
      // Só o que o deploy/queda deixou para trás interessa: passada a janela, trace RUNNING é outra coisa e reprocessá-lo
      // seria responder de novo a quem pode já ter sido respondido — fica para investigar, não para refazer.
      if (!posse || Date.now() - posse.getTime() > JANELA_APOS_LIDERANCA_MS) {
        proxima(INTERVALO_MS);
        return;
      }
      // Para no meio da volta se o processo vai sair ou se deixou de ser o líder (troca de lease: o outro processo é quem
      // tem turnos vivos agora, e tomá-los por perdidos seria responder em dobro).
      const parar = (): boolean => parado || lideranca() === null;
      recuperarTurnosPerdidos(deps, posse, { voltasSemDecisao, parar })
        .then((r) => {
          if (r.candidatos > 0) logger.info(r, 'recuperar-turnos: varredura concluída');
        })
        .catch((err) => logger.error({ err: String(err) }, 'recuperar-turnos: varredura falhou'))
        .finally(() => proxima(INTERVALO_MS));
    }, ms);
    timer.unref();
  };
  proxima(ATRASO_INICIAL_MS);
  return () => {
    parado = true;
    if (timer) clearTimeout(timer);
  };
}
