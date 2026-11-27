/**
 * RETOMA, UMA VEZ, as conversas que ficaram na frase de queda da IA ("Opa, tive uma instabilidade rapidinha… Pode mandar de novo?").
 * As regras de decisão estão em `lib/retomar-apos-queda.ts` (leia o cabeçalho de lá: é a mesma REGRA-MÃE da recuperação do deploy —
 * na dúvida, TAREFA para a recepção em vez de resposta).
 *
 * SIMULA por padrão: lê o banco e o Kommo, não grava, não agenda e não envia nada. Só age com `--aplicar`.
 *
 * Roda dentro do contêiner do agente (precisa do banco, das chaves do modelo e do Kommo). Com LOG_LEVEL=warn a saída fica só com o relatório:
 *   LOG_LEVEL=warn node dist/scripts/retomar-apos-queda.js [--desde 2026-11-26T21:00:00Z] [--ate 2026-11-27T12:11:00Z]
 *                                                         [--unidade doutor-hernia-taubate,hm-tecnologia] [--paralelo 3] [--aplicar]
 *
 * Opções:
 *   --desde / --ate   janela da FRASE DE QUEDA (padrão: 26/11/2026 21:00 UTC até agora)
 *   --unidade         só estas unidades (slugs separados por vírgula)
 *   --paralelo        conversas ao mesmo tempo com `--aplicar` (padrão 2; cada uma espera o seu turno terminar)
 *   --aplicar         age de verdade. Antes confere que o modelo ESTÁ de pé (llm_calls dos últimos 10 min: com chamada e sem erro);
 *                     `--ignorar-saude` pula essa conferência (só se você mesmo conferiu).
 *
 * Como cada canal reentra no agente (verificado no código, 27/11/2026):
 *  - Kommo (webhook → salesbot/chat): é o ÚNICO caminho do agente. O pedido volta pelo coalescer, com o mesmo `processAgent` do webhook e
 *    todas as travas dele (pausa, horário, etapa, equipe), marcado como retomado (não mexe na etapa).
 *  - Chatwoot: a Sofia do Chatwoot é outro motor (`chatwoot-ia`), não grava em `messages`; nenhuma das conversas da queda é de lá.
 *  - Kapso: só transporte de WhatsApp para o CRM; não reentra no agente.
 *  Conversa que NÃO seja `kommo_chat` vai para TAREFA, nunca para reinjeção.
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { FALLBACK_INDISPONIVEL } from '../agent/llm-policy.js';
import { marcarNaoEntregue } from '../agent/entrega-falha.js';
import { TraceRecorder, syncRecorderSequence } from '../agent/trace-recorder.js';
import { getCheckpointer } from '../agent/graph.js';
import { iniciarAutomacoes } from '../lib/automacoes-estado.js';
import { iniciarConfigChatwoot } from '../lib/chatwoot-unidades-banco.js';
import { iniciarCrmCompartilhado } from '../lib/crm-compartilhado.js';
import { idsEmVoo } from '../lib/agent-coalescer.js';
import { liberarClaim, reivindicarComCerteza } from '../lib/dedup-cache.js';
import { depsDeProducao, type TurnoPerdido } from '../lib/recuperar-turnos.js';
import { createKommoClient } from '../services/kommo.service.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { etapaCalada, sofiaCaladaLiberada } from '../lib/sofia-calada.js';
import { etapaPermitida, precisaDoFunil, type FunisDaConta } from '../lib/etapa-permitida.js';
import { getPausedStagesGlobalSet } from '../services/actions.service.js';
import { ganchosDeRecuperacao, avaliarRetomada, agendarRetomada, DEPS_RETOMADA_PADRAO } from '../controllers/webhook.controller.js';
import {
  ESCOPO_REIVINDICACAO_QUEDA,
  ESPERA_MAX_DO_TURNO_MS,
  PREFIXO_DA_QUEDA,
  TTL_REIVINDICACAO_QUEDA_MS,
  executar,
  ligadaAQueda,
  linhaDoResultado,
  passoDeAgendaOuPix,
  trechoSemResposta,
  type CandidataDaQueda,
  type DepsDaExecucao,
} from '../lib/retomar-apos-queda.js';

/** Motivos de fechar SEM tarefa em que o paciente continua sem resposta de verdade (o contrário de `equipe_respondeu…`, `conversa_andou…`). */
const SEGUEM_SEM_RESPOSTA = new Set(['ia_pausada', 'etapa_fechada', 'sem_mensagem_do_paciente_ligada_a_queda', 'unidade_ou_lead_invalido']);

const DESDE_PADRAO = '2026-11-26T21:00:00Z';
/** Depois do último turno, o que ele deixou rodando em segundo plano ainda precisa terminar antes do `process.exit`. */
const GRACA_APOS_OS_TURNOS_MS = 20_000;

export interface ArgsDoScript {
  aplicar: boolean;
  desde: Date;
  ate: Date;
  unidades: string[];
  paralelo: number;
  ignorarSaude: boolean;
}

export function lerArgs(argv: string[], agora: Date = new Date()): ArgsDoScript {
  const valor = (nome: string): string | undefined => {
    const i = argv.indexOf(nome);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`${nome}=`))?.slice(nome.length + 1);
  };
  const data = (nome: string, padrao: Date): Date => {
    const v = valor(nome);
    if (!v) return padrao;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error(`${nome}: data inválida "${v}" (use 2026-11-26T21:00:00Z)`);
    return d;
  };
  const paralelo = Number(valor('--paralelo') ?? 2);
  if (!Number.isInteger(paralelo) || paralelo < 1 || paralelo > 8) throw new Error('--paralelo: um inteiro de 1 a 8');
  return {
    aplicar: argv.includes('--aplicar'),
    desde: data('--desde', new Date(DESDE_PADRAO)),
    ate: data('--ate', agora),
    unidades: (valor('--unidade') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    paralelo,
    ignorarSaude: argv.includes('--ignorar-saude'),
  };
}

/** As conversas cuja ÚLTIMA mensagem é a frase de queda, enviada na janela, com os pedidos do paciente ligados a ela. */
export async function carregarCandidatas(a: Pick<ArgsDoScript, 'desde' | 'ate' | 'unidades'>): Promise<CandidataDaQueda[]> {
  const comQueda = await prisma.message.findMany({
    where: {
      role: 'assistant',
      content: { startsWith: PREFIXO_DA_QUEDA },
      createdAt: { gte: a.desde, lte: a.ate },
      ...(a.unidades.length ? { conversation: { unit: { slug: { in: a.unidades } } } } : {}),
    },
    select: { conversationId: true },
    distinct: ['conversationId'],
  });
  const candidatas: CandidataDaQueda[] = [];
  for (const { conversationId } of comQueda) {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { unit: { select: { slug: true } } } });
    if (!conv) continue;
    const msgs = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 120,
      select: { role: true, content: true, createdAt: true, traceId: true },
    });
    const trecho = trechoSemResposta(msgs);
    if (!trecho || trecho.quedas.length === 0) continue;
    const ultimaQueda = trecho.quedas[trecho.quedas.length - 1]!;
    if (ultimaQueda.createdAt < a.desde || ultimaQueda.createdAt > a.ate) continue;

    const tracesDasQuedas = new Set(trecho.quedas.map((q) => q.traceId).filter((t): t is string => !!t));
    const idsDosPacientes = [...new Set(trecho.pacientes.map((p) => p.traceId).filter((t): t is string => !!t))];
    const traces = idsDosPacientes.length
      ? await prisma.executionTrace.findMany({ where: { id: { in: idsDosPacientes } }, select: { id: true, unitId: true, leadId: true, createdAt: true, input: true, iaDecision: true } })
      : [];
    const ligadas = traces.filter((t) => ligadaAQueda(t, tracesDasQuedas));
    const pedidos: TurnoPerdido[] = ligadas
      .map((t) => ({ traceId: t.id, unitId: t.unitId ?? conv.unitId, leadId: t.leadId, criadoEm: t.createdAt, input: t.input }))
      .sort((x, y) => x.criadoEm.getTime() - y.criadoEm.getTime());
    const idsLigados = new Set(ligadas.map((t) => t.id));
    candidatas.push({
      conversaId: conv.id,
      unitId: conv.unitId,
      unitSlug: conv.unit.slug,
      leadId: conv.leadId,
      canal: conv.channel,
      quedaEm: ultimaQueda.createdAt,
      tracesDaQueda: [...new Set([...tracesDasQuedas, ...idsLigados])],
      pedidos,
      ignoradas: trecho.pacientes.filter((p) => !p.traceId || !idsLigados.has(p.traceId)).length,
    });
  }
  return candidatas.sort((x, y) => x.quedaEm.getTime() - y.quedaEm.getTime());
}

/** O modelo está de pé? Com `--aplicar`, uma retomada que dá a frase de queda de novo seria pior que o silêncio. */
export async function modeloEstaDePe(agora: Date = new Date()): Promise<{ ok: boolean; sucessos: number; erros: number }> {
  const desde = new Date(agora.getTime() - 10 * 60_000);
  const [sucessos, erros] = await Promise.all([
    prisma.llmCall.count({ where: { createdAt: { gte: desde }, status: 'success' } }),
    prisma.llmCall.count({ where: { createdAt: { gte: desde }, status: 'error' } }),
  ]);
  return { ok: sucessos > 0 && erros === 0, sucessos, erros };
}

async function etapaFechada(unit: Unit, leadId: string): Promise<string | null> {
  const kommo = createKommoClient(unit);
  const lead = await kommo.getLead(Number(leadId));
  const sid = lead.status_id;
  const pid = lead.pipeline_id;
  const permitidos = unit.kommoAllowedStatusIds ?? [];
  let esquema: Awaited<ReturnType<typeof esquemaDaUnidade>> | null = null;
  try {
    esquema = await esquemaDaUnidade(unit, kommo);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'retomar-apos-queda: não li o esquema da conta');
  }
  // As mesmas travas do turno (webhook.controller, processarTurno): GANHO/ALTA/CANCELADO pelo nome, allowlist da unidade, regra global.
  if (sofiaCaladaLiberada(unit.slug) && esquema && sid && pid) {
    const pos = esquema.nomeDoStatus(pid, sid);
    if (pos && etapaCalada(pos.status, { statusId: sid, pipeline: pos.pipeline })) return `etapa calada: ${pos.status}`;
  }
  const funis: FunisDaConta | null = precisaDoFunil(permitidos, sid) ? esquema : null;
  if (permitidos.length > 0 && !etapaPermitida(permitidos, sid, pid, funis)) return `etapa ${sid ?? '?'} fora da allowlist da unidade`;
  const pausadas = await getPausedStagesGlobalSet();
  if ((sid && pausadas.has(`*:${sid}`)) || (sid && pid && pausadas.has(`${pid}:${sid}`))) return `etapa ${sid} pausada por regra global`;
  return null;
}

export function depsDeProducaoDaQueda(): DepsDaExecucao {
  const base = depsDeProducao(ganchosDeRecuperacao);
  const depsRetomada = {
    ...DEPS_RETOMADA_PADRAO,
    // Não bloqueia o agendamento: as mensagens de uma conversa precisam entrar no coalescer coladas (a janela é de 8 s), e o passo é só rastro.
    async registrar(t: TurnoPerdido, unit: Unit, leadId: number): Promise<void> {
      const recorder = new TraceRecorder(t.traceId, unit.id);
      void syncRecorderSequence(recorder, t.traceId)
        .then(() =>
          recorder.step({
            kind: 'THINKING',
            title: '♻ Retomado depois da queda da IA: o paciente recebeu o aviso de instabilidade e ficou sem resposta; esta mensagem volta para a IA (uma vez só)',
            payload: { leadId, retomadoAposQueda: true },
          }),
        )
        .catch((err) => logger.warn({ err: String(err), traceId: t.traceId }, 'retomar-apos-queda: não gravei o passo de retomada (o turno segue)'));
    },
  };
  return {
    agora: () => new Date(),
    unidadeDona: (t) => ganchosDeRecuperacao.unidadeDona(t),
    async conversaAndou(conversaId, quedaEm) {
      return (await prisma.message.count({ where: { conversationId: conversaId, createdAt: { gt: quedaEm } } })) > 0;
    },
    async traceTeveAgendaOuPix(traceIds) {
      const passos = await prisma.executionStep.findMany({ where: { traceId: { in: traceIds }, kind: { in: ['TOOL_CALL', 'TOOL_RESULT'] } }, select: { kind: true, title: true } });
      return passos.some(passoDeAgendaOuPix);
    },
    lerConversa: (unit, leadId) => base.lerConversa(unit, leadId),
    iaPausada: (unit, leadId) => base.iaPausada(unit, leadId),
    etapaFechada,
    foraDoHorario: (unit) => base.foraDoHorario(unit),
    avaliar: (t, unit) => avaliarRetomada(t, unit),
    reivindicar: (conversaId) => reivindicarComCerteza(ESCOPO_REIVINDICACAO_QUEDA, conversaId, TTL_REIVINDICACAO_QUEDA_MS),
    liberarReivindicacao: (conversaId) => liberarClaim(ESCOPO_REIVINDICACAO_QUEDA, conversaId),
    // O turno roda NESTE processo: o aviso em memória é lido pelo compositor do mesmo processo, uma vez, no turno retomado.
    plantarAviso: (unit, leadId) => marcarNaoEntregue(unit.id, Number(leadId), FALLBACK_INDISPONIVEL, Date.now(), 'queda'),
    agendar: async (t, unit, ctx) => {
      const r = await agendarRetomada(t, unit, ctx as Parameters<typeof agendarRetomada>[2], depsRetomada);
      return r;
    },
    criarTarefa: (unit, t, esperaMs) => base.criarTarefa(unit, t, esperaMs),
    async esperarTurno(traceIds) {
      const limite = Date.now() + ESPERA_MAX_DO_TURNO_MS;
      while (Date.now() < limite) {
        const emVoo = new Set(idsEmVoo());
        if (!traceIds.some((id) => emVoo.has(id))) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    },
    async respondeuComQueda(conversaId, desde) {
      return (await prisma.message.count({ where: { conversationId: conversaId, role: 'assistant', createdAt: { gt: desde }, content: { startsWith: PREFIXO_DA_QUEDA } } })) > 0;
    },
  };
}

async function main(): Promise<void> {
  const args = lerArgs(process.argv.slice(2));
  console.log(`retomar-apos-queda — ${args.aplicar ? 'APLICANDO' : 'SIMULAÇÃO (nada é gravado; use --aplicar para agir)'}`);
  console.log(`janela da frase de queda: ${args.desde.toISOString()} → ${args.ate.toISOString()}${args.unidades.length ? ` · unidades: ${args.unidades.join(', ')}` : ''}`);

  // O que o servidor carrega no boot e as travas leem da memória: sem isto o script decidiria com as chaves "do .env", não com as do painel.
  await iniciarAutomacoes().catch((err) => logger.warn({ err: String(err) }, 'retomar-apos-queda: automações não carregadas'));
  await iniciarConfigChatwoot();
  await iniciarCrmCompartilhado();

  if (args.aplicar) {
    const saude = await modeloEstaDePe();
    console.log(`modelo (llm_calls, 10 min): ${saude.sucessos} com sucesso, ${saude.erros} com erro`);
    if (!saude.ok && !args.ignorarSaude) {
      console.error('RECUSADO: o modelo não provou estar de pé nos últimos 10 min (precisa de chamada com sucesso e nenhuma com erro). Confira o saldo/chave ou use --ignorar-saude.');
      process.exitCode = 1;
      return;
    }
    await getCheckpointer(); // o histórico da conversa mora no checkpoint do LangGraph
  }

  const candidatas = await carregarCandidatas(args);
  console.log(`${candidatas.length} conversa(s) terminam na frase de queda\n`);
  const resumo = await executar(depsDeProducaoDaQueda(), candidatas, { aplicar: args.aplicar, paralelo: args.paralelo }, (r) => console.log(linhaDoResultado(r)));

  // O turno deixa tarefas soltas depois de responder (captura silenciosa, revisão de saída, cadastro na franquia): dá tempo antes do process.exit.
  if (args.aplicar && resumo.resultados.some((r) => r.acao === 'reinjetar' && r.efeito === 'feito')) await new Promise((r) => setTimeout(r, GRACA_APOS_OS_TURNOS_MS));

  console.log('\n=== RESUMO ===');
  console.log(`conversas: ${resumo.resultados.length}${resumo.interrompida ? '  (INTERROMPIDA: a IA voltou a mandar a frase de queda)' : ''}`);
  for (const [k, n] of Object.entries(resumo.porAcao).sort()) console.log(`  ${k.toUpperCase().padEnd(10)} ${n}`);
  console.log('por motivo:');
  for (const [k, n] of Object.entries(resumo.porMotivo).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(3)}  ${k}`);
  const ignoradas = candidatas.reduce((s, c) => s + c.ignoradas, 0);
  if (ignoradas) console.log(`mensagens do paciente no trecho que não se ligam a nenhuma queda (ficaram de fora): ${ignoradas}`);
  const seguemSemResposta = resumo.resultados.filter((r) => r.acao === 'fechar' && SEGUEM_SEM_RESPOSTA.has(r.motivo));
  if (seguemSemResposta.length) {
    console.log(`\nFECHADAS SEM AÇÃO que ainda terminam na frase de queda (a equipe é quem atende; confira se alguém está olhando): ${seguemSemResposta.length}`);
    for (const r of seguemSemResposta) console.log(`  ${linhaDoResultado(r)}`);
  }
  const falhas = resumo.resultados.filter((r) => r.efeito === 'falhou' || r.efeito === 'adiado');
  if (falhas.length) {
    console.log(`\nATENÇÃO — ${falhas.length} sem desfecho (falhou/adiado); rode de novo (as já feitas não se repetem):`);
    for (const r of falhas) console.log(`  ${linhaDoResultado(r)}`);
    process.exitCode = 1;
  }
  if (resumo.interrompida) process.exitCode = 1;
}

// Só roda quando é o script (o teste importa as funções puras sem disparar o banco).
const eOScript = process.argv[1] ? /retomar-apos-queda\.(ts|js)$/.test(process.argv[1]) : false;
if (eOScript) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => undefined);
      process.exit(process.exitCode ?? 0);
    });
}
