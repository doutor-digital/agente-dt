/**
 * Quem agenda e liga a «Faxina do mês» (regras de cada passo em `faxina-do-mes.ts`).
 *
 *  - Roda no líder (`worker-lease.ts`, como todo worker periódico) e só no DIA 1, entre 2h e 7h de São Paulo.
 *  - UMA VEZ por unidade por mês: antes de começar uma unidade pega a trava `faxina-do-mes:AAAA-MM:<slug>` no banco (90 min);
 *    ao terminar estica a mesma trava por 40 dias. Um deploy no meio da madrugada não repete unidade que já terminou, e uma
 *    que morreu no meio é retomada quando a trava dela vence. Falha do banco = não roda (silêncio é melhor que repetir).
 *  - Unidade por unidade, em fila (nunca em paralelo): o limitador do Kommo é da rede inteira e a Sofia atende no mesmo dia.
 *  - O relatório sai UMA vez por rodada, no Telegram do João (`telegram.ts`). Telegram fora do ar não derruba a faxina: a
 *    trava já foi marcada antes de o texto ser enviado, e o relatório fica também no log.
 *  - Sob demanda (`iniciarFaxinaSobDemanda`): uma unidade, sem janela e sem trava mensal, no estado que a tela lhe deu
 *    (desligada não roda). É o que a rota `POST /units/:id/automacoes/faxina-do-mes/rodar` chama.
 *
 * Liga/desliga pela tela de Automações (chave `FAXINA_DO_MES_SLUGS`): desligado (padrão) / só no papel / ligado.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, createKommoClientSemFreio } from '../services/kommo.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { estadoDosWorkers, reivindicarLease, type Reivindicacao } from './worker-lease.js';
import { enviarTelegram } from './telegram.js';
import { contaDividida } from './crm-compartilhado.js';
import { duplicadosPelaEntradaAutomatica } from './faxina-duplicados.js';
import { ID_ESTOQUE } from './entrada-automatica.js';
import { estadoDaConta, ultimoResumoDaEntrada } from './entrada-automatica-worker.js';
import { paradosLiberado, modoSeco } from './parados.js';
import { estadoDosEstoques } from './parados-estoques.js';
import { ultimoResumoDosParados } from './parados-worker.js';
import { resumoDoSync, type ResumoSync } from './franquia-sync-worker.js';
import { motivosDaUnidadeAgora } from './perda-ia-worker.js';
import {
  ID_FAXINA,
  faxinaDaUnidade,
  acumular,
  janelaDaFaxina,
  montarRelatorio,
  resultadoVazio,
  type CtxFaxina,
  type DepsDaFaxina,
  type EtapaDaAutomacao,
  type ResultadoEtapas,
  type ResultadoMotivos,
  type ResultadoUnidade,
} from './faxina-do-mes.js';

const TICK_MS = Number(process.env.FAXINA_DO_MES_TICK_MS) || 10 * 60_000;
const TRAVA_ENQUANTO_RODA_MS = 90 * 60_000;
const TRAVA_DEPOIS_DE_RODAR_MS = 40 * 24 * 3600_000;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
/** Resumo de varredura mais velho que isto não vale como «o que a automação faz agora» (parados varre de hora em hora; o sincronizador, a cada 15 min). */
const VALIDADE_PARADOS_MS = 3 * 3600_000;
const VALIDADE_SYNC_MS = 60 * 60_000;
/** «Moveria» em só no papel: as linhas que a tela guarda e que a última varredura (ou a anterior) refrescou — a janela é contada a partir DA VARREDURA, não de agora. */
const MARGEM_DO_PAPEL_MS = 75 * 60_000;
const DIAS_DO_PAPEL_ANTIGO = 30;

export const estadoDaFaxina = (slug: string): Estado => estadoDaAutomacao(slug, ID_FAXINA, process.env.FAXINA_DO_MES_SLUGS);

const pausa = () => new Promise<void>((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

// ─── a rodada (testável: tudo que toca banco, Kommo e Telegram entra por `DepsDaRodada`) ────────

export interface AlvoDaFaxina {
  slug: string;
  nome: string;
  subdominio: string;
  modo: 'ligado' | 'seco';
  cuidaDaConta: boolean;
  contaDividida: boolean;
}

export interface DepsDaRodada {
  alvos: (soSlug?: string) => Promise<AlvoDaFaxina[]>;
  reivindicar: (nome: string, ttlMs: number) => Promise<Reivindicacao>;
  faxina: (alvo: AlvoDaFaxina, agoraEpoch: number) => Promise<ResultadoUnidade>;
  enviar: (texto: string) => Promise<boolean>;
  agora: () => Date;
  /** este processo ainda lidera os workers? Perdeu no meio = para (o novo líder retoma pela trava) */
  lider: () => boolean;
}

export interface OpcoesDaRodada {
  /** só esta unidade; sem isto, a rede toda */
  soSlug?: string;
  /** sem janela do dia 1 e sem trava mensal */
  sobDemanda?: boolean;
  /** manda o relatório ao Telegram (padrão: sim) */
  telegram?: boolean;
  /** alvos já montados por quem chamou (a rota sob demanda os valida antes): evita ler unidades duas vezes */
  alvos?: AlvoDaFaxina[];
}

export interface DesfechoDaRodada {
  resultados: ResultadoUnidade[];
  mensagens: string[];
  enviado: boolean;
  /** unidades ligadas que a rodada não alcançou (janela fechou) ou que outro processo já tinha feito */
  naoComecaram: string[];
}

/** Unidades que já terminaram neste mês, neste processo: poupa as idas ao banco dos ticks seguintes. */
const terminadasNoMes = new Set<string>();
/**
 * Unidades interrompidas (freio do Kommo ou exceção) e quando. O banco NÃO segura a retomada neste processo: `reivindicarLease` devolve
 * 'minha' ao mesmo dono (renova), então sem esta memória a unidade seria refeita a CADA tick (10 min). Regra: só retoma depois dos 90 min
 * da trava de verdade, e no máximo `RODADAS_POR_NOITE` rodadas por unidade (a última interrompida desiste e ganha a trava de 40 dias).
 */
const interrompidas = new Map<string, { rodadas: number; em: number }>();
export const RODADAS_POR_NOITE = 2;
/** O último resultado de cada unidade NESTE mês, neste processo: o TOTAL da rodada de retomada tem de ser o da rede, não só o das retomadas. */
const ultimosDoMes = new Map<string, ResultadoUnidade>();

/** Chaves de meses passados saem dos mapas (a chave começa com AAAA-MM). */
function limparMesesAntigos(chaveDoMes: string): void {
  for (const m of [terminadasNoMes, interrompidas, ultimosDoMes] as Array<Set<string> | Map<string, unknown>>) {
    for (const k of [...m.keys()]) if (!k.startsWith(chaveDoMes)) m.delete(k);
  }
}

const souLider = () => estadoDosWorkers()?.lider !== false;

/** Quantas unidades vão por mensagem antes de o relatório ser enviado: um deploy no meio da madrugada perde, no máximo, um lote. */
export const UNIDADES_POR_LOTE = 5;

export async function rodarFaxinaDoMes(o: OpcoesDaRodada, deps: DepsDaRodada): Promise<DesfechoDaRodada> {
  const desfecho: DesfechoDaRodada = { resultados: [], mensagens: [], enviado: false, naoComecaram: [] };
  const alvos = o.alvos ?? (await deps.alvos(o.soSlug));
  const quando = o.sobDemanda ? 'sob-demanda' : 'dia-1';
  let lote: Array<{ resultado: ResultadoUnidade; trava: string | null; chave: string }> = [];
  let tudoEnviado = true;

  /**
   * Envia o relatório do lote. A trava de cada unidade já foi esticada (40 dias) assim que ELA terminou — um deploy no meio não
   * repete unidade. O preço: se o processo morrer entre o fim de uma unidade e o envio, o relatório daquele lote (no máximo
   * `UNIDADES_POR_LOTE` unidades) fica só no log.
   */
  const descarregar = async (ultimo: boolean) => {
    const mes = janelaDaFaxina(deps.agora()).mesDoRelatorio;
    const resultadosDoLote = lote.map((l) => l.resultado);
    if (resultadosDoLote.length || ultimo) {
      const mensagens = montarRelatorio(resultadosDoLote, {
        mes,
        quando,
        semTotal: !ultimo,
        totalDe: o.sobDemanda ? desfecho.resultados : [...ultimosDoMes.values()],
        naoComecaram: ultimo ? desfecho.naoComecaram : [],
      });
      desfecho.mensagens.push(...mensagens);
      for (const m of mensagens) logger.info({ relatorio: m }, 'faxina-do-mes: relatório');
      if (o.telegram !== false) {
        try {
          for (const m of mensagens) tudoEnviado = (await deps.enviar(m)) && tudoEnviado;
        } catch (err) {
          tudoEnviado = false;
          logger.warn({ err: String(err) }, 'faxina-do-mes: o Telegram falhou — o relatório está só no log');
        }
      }
    }
    lote = [];
  };

  for (const [i, alvo] of alvos.entries()) {
    if (!deps.lider()) {
      logger.warn({ unit: alvo.slug }, 'faxina-do-mes: este processo perdeu a liderança dos workers — parei; o novo líder retoma pelas travas');
      const mes = janelaDaFaxina(deps.agora()).chaveDoMes;
      desfecho.naoComecaram.push(...alvos.slice(i).filter((a) => o.sobDemanda || !terminadasNoMes.has(`${mes}:${a.slug}`)).map((a) => a.nome));
      break;
    }
    const j = janelaDaFaxina(deps.agora());
    const chave = `${j.chaveDoMes}:${alvo.slug}`;
    if (!o.sobDemanda) limparMesesAntigos(j.chaveDoMes);
    let trava: string | null = null;
    if (!o.sobDemanda) {
      if (terminadasNoMes.has(chave)) continue;
      const ant = interrompidas.get(chave);
      if (ant && deps.agora().getTime() - ant.em < TRAVA_ENQUANTO_RODA_MS) continue; // ainda dentro dos 90 min: não refaz
      if (!j.dentro) {
        desfecho.naoComecaram.push(alvo.nome);
        continue;
      }
      trava = `${ID_FAXINA}:${chave}`;
      const r = await deps.reivindicar(trava, TRAVA_ENQUANTO_RODA_MS);
      if (r !== 'minha') {
        // 'de-outro' = outro processo está nela ou já terminou (se ele morreu, a trava vence em 90 min e o próximo tick retoma)
        if (r === 'erro') logger.warn({ unit: alvo.slug }, 'faxina-do-mes: banco fora do ar ao pegar a trava — não rodei esta unidade agora');
        continue;
      }
    }
    let resultado: ResultadoUnidade;
    try {
      resultado = await deps.faxina(alvo, Math.floor(deps.agora().getTime() / 1000));
    } catch (err) {
      resultado = resultadoVazio(alvo.slug, alvo.nome, alvo.subdominio, alvo.modo);
      resultado.erros.push(`faxina da unidade: ${String(err).slice(0, 200)}`);
      resultado.interrompida = true;
      logger.error({ err: String(err), unit: alvo.slug }, 'faxina-do-mes: a unidade falhou');
    }
    desfecho.resultados.push(resultado);
    if (!o.sobDemanda) {
      const antes = ultimosDoMes.get(chave);
      if (antes) resultado.avisos.push('esta é a rodada de retomada: o TOTAL da rede soma o que a faxina gravou nas duas rodadas desta unidade');
      ultimosDoMes.set(chave, antes ? acumular(antes, resultado) : resultado);
    }
    // terminou = trava de 40 dias na hora (deploy no meio não repete). Interrompida (freio do Kommo ou exceção): retoma depois dos 90 min,
    // no máximo RODADAS_POR_NOITE vezes; a última interrompida desiste (trava de 40 dias) e o relatório diz.
    if (trava) {
      let desistiu = false;
      if (resultado.interrompida) {
        // perda de liderança (deploy) não gasta rodada: a culpa não é do Kommo, e o novo líder precisa poder retomar
        const rodadas = (interrompidas.get(chave)?.rodadas ?? 0) + (resultado.perdeuLideranca ? 0 : 1);
        if (rodadas >= RODADAS_POR_NOITE) {
          desistiu = true;
          resultado.avisos.push(`interrompida ${rodadas} vezes nesta noite: desisti até o mês que vem (rode sob demanda se precisar)`);
        } else {
          interrompidas.set(chave, { rodadas, em: deps.agora().getTime() });
        }
      }
      if (!resultado.interrompida || desistiu) {
        const marca = await deps.reivindicar(trava, TRAVA_DEPOIS_DE_RODAR_MS);
        terminadasNoMes.add(chave); // neste processo ela não repete de qualquer jeito
        interrompidas.delete(chave);
        if (marca !== 'minha') {
          logger.error({ unit: alvo.slug, marca }, 'faxina-do-mes: NÃO consegui gravar a trava mensal desta unidade — se o servidor reiniciar na janela, ela pode repetir');
          resultado.avisos.push('não consegui gravar a trava mensal no banco: se o servidor reiniciar até as 7h, esta unidade pode repetir (vínculo, tarefa e etiqueta são idempotentes)');
        }
      }
    }
    lote.push({ resultado, trava, chave });
    logger.info({ unit: alvo.slug, modo: alvo.modo, resultado }, 'faxina-do-mes: unidade concluída');
    if (lote.length >= UNIDADES_POR_LOTE && i < alvos.length - 1) await descarregar(false);
  }

  if (desfecho.resultados.length === 0) return desfecho;
  await descarregar(true);
  desfecho.enviado = o.telegram !== false && tudoEnviado;
  if (o.telegram !== false && !desfecho.enviado) logger.warn('faxina-do-mes: o relatório NÃO chegou inteiro ao Telegram (sem token ou recusado) — está no log');
  return desfecho;
}

// ─── o que é de verdade: banco, Kommo e as automações que já existem ────────────────────────────

async function contarNoPapel(unitId: string, automacoes: string[], desde: Date): Promise<number> {
  try {
    return await prisma.automacaoSimulacao.count({ where: { unitId, automacao: { in: automacoes }, acao: 'moveria', ultimaEm: { gte: desde } } });
  } catch {
    return 0;
  }
}

/** De onde a faxina lê (passos 3 e 4) — injetável para o teste provar que ela só LÊ, e quando a única coisa que dispara é o motivo-perdido-ia. */
export interface ChamadasDasAutomacoes {
  ultimoParados: (slug: string) => { em: number; resumo: { movidos: number } } | null;
  ultimoSync: (slug: string) => Pick<ResumoSync, 'em' | 'movimentos' | 'escritas' | 'simulados' | 'semLead'> | null;
  motivos: typeof motivosDaUnidadeAgora;
  noPapel: (unitId: string, automacoes: string[], desde: Date) => Promise<number>;
  agora: () => number;
}
const chamadasReais: ChamadasDasAutomacoes = {
  ultimoParados: ultimoResumoDosParados,
  ultimoSync: (slug) => resumoDoSync().find((r) => r.unit === slug) ?? null,
  motivos: motivosDaUnidadeAgora,
  noPapel: contarNoPapel,
  agora: Date.now,
};

const minutosAtras = (em: number, agora: number) => Math.max(0, Math.round((agora - em) / 60_000));

/**
 * Passos 3 e 4: LÊ o resumo da última varredura de cada automação que já existe — não dispara passada nenhuma (uma passada extra
 * do sincronizador moveria cartão por `franquia-move`/revisão ligados mesmo com a faxina em seco). Cada leitura é isolada: erro
 * numa automação vira nota dela e as outras seguem.
 */
export async function etapasDaFaxina(_ctx: CtxFaxina, unit: Unit, c: ChamadasDasAutomacoes = chamadasReais): Promise<ResultadoEtapas> {
  const slug = unit.slug;
  const out: ResultadoEtapas = { automacoes: [], camposGravados: 0, semCartao: 0 };
  const antigo = new Date(c.agora() - DIAS_DO_PAPEL_ANTIGO * 86_400_000);

  // parados + estoques parados (rodam dentro da mesma varredura)
  {
    const estado: Estado = !paradosLiberado(slug) ? 'desligado' : modoSeco(slug) ? 'seco' : 'ligado';
    const estoques = estadoDosEstoques(slug);
    const a: EtapaDaAutomacao = { id: 'parados', nome: 'Parados e estoques parados', estado, executou: false, movidos: 0, moveria: 0 };
    const ids = ['parados', 'parados-estoques'];
    try {
      if (estado === 'desligado') {
        a.moveria = await c.noPapel(unit.id, ids, antigo);
      } else {
        const ult = c.ultimoParados(slug);
        if (!ult) a.nota = 'sem resumo de varredura (ainda não varreu desde o último reinício do servidor, ou a última falhou)';
        else if (c.agora() - ult.em > VALIDADE_PARADOS_MS) a.nota = `a última varredura foi há ${minutosAtras(ult.em, c.agora())} min: velha demais para contar`;
        else {
          a.executou = true;
          if (estado === 'ligado') a.movidos = ult.resumo.movidos;
          else a.moveria = await c.noPapel(unit.id, ids, new Date(ult.em - MARGEM_DO_PAPEL_MS));
          a.nota = `lido da última varredura, há ${minutosAtras(ult.em, c.agora())} min; estoques parados: ${estoques === 'desligado' ? 'desligados' : estoques === 'seco' ? 'só no papel' : 'ligados'}`;
        }
      }
    } catch (err) {
      a.executou = false;
      a.nota = `não consegui ler: ${String(err).slice(0, 100)}`;
    }
    out.automacoes.push(a);
  }

  // sincronizador (move pelo que a franquia diz, grava campos e faz a revisão dos agendados velhos)
  {
    const estado = estadoDaAutomacao(slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS);
    const revisao = estadoDaAutomacao(slug, 'franquia-revisao', process.env.FRANQUIA_REVISAO_SLUGS);
    const a: EtapaDaAutomacao = { id: 'franquia-sync', nome: 'Sincronizador da franquia e revisão dos agendados velhos', estado, executou: false, movidos: 0, moveria: 0 };
    try {
      if (estado === 'desligado') {
        a.moveria = await c.noPapel(unit.id, ['franquia-move', 'franquia-revisao'], antigo);
      } else {
        const ult = c.ultimoSync(slug);
        const quando = ult ? Date.parse(ult.em) : NaN;
        if (!ult || !Number.isFinite(quando)) a.nota = 'sem resumo de varredura (ainda não varreu desde o último reinício do servidor, ou a última falhou)';
        else if (c.agora() - quando > VALIDADE_SYNC_MS) a.nota = `a última varredura foi há ${minutosAtras(quando, c.agora())} min: velha demais para contar`;
        else {
          a.executou = true;
          // `franquia-move` e a revisão têm estado PRÓPRIO: o resumo traz o que moveu de verdade e o que só simulou
          a.movidos = ult.movimentos;
          a.moveria = Object.values(ult.simulados ?? {}).reduce((s, n) => s + n, 0);
          out.camposGravados = estado === 'ligado' ? ult.escritas : 0;
          out.semCartao = ult.semLead;
          a.nota = `lido da última varredura, há ${minutosAtras(quando, c.agora())} min; revisão dos agendados velhos: ${revisao === 'desligado' ? 'desligada' : revisao === 'seco' ? 'só no papel' : 'ligada'}`;
        }
      }
    } catch (err) {
      a.executou = false;
      a.nota = `não consegui ler: ${String(err).slice(0, 100)}`;
    }
    out.automacoes.push(a);
  }
  return out;
}

/** `motivo-perdido-ia`: a ÚNICA passada que a faxina dispara. Faxina seca só a chama se ele mesmo estiver em «só no papel». */
export async function motivosDaFaxina(ctx: CtxFaxina, unit: Unit, todas: Unit[], c: ChamadasDasAutomacoes = chamadasReais): Promise<ResultadoMotivos> {
  const estado = estadoDaAutomacao(unit.slug, 'motivo-perdido-ia', process.env.MOTIVO_PERDIDO_IA_SLUGS);
  const r: ResultadoMotivos = { estado, executou: false, gravados: 0, gravaria: 0 };
  if (estado === 'desligado') return r;
  if (estado === 'ligado' && ctx.modo === 'seco') {
    r.nota = 'está ligada; a faxina em só no papel não a dispara (é a única passada que a faxina chama)';
    return r;
  }
  try {
    const p = await c.motivos(unit, todas);
    r.executou = p.executou;
    if (!p.executou) r.nota = p.motivo;
    else if (estado === 'ligado') r.gravados = p.gravados;
    else r.gravaria = p.gravados;
  } catch (err) {
    r.nota = `não consegui rodar: ${String(err).slice(0, 100)}`;
  }
  return r;
}

/** Resolve unidade, conta e Kommo e roda `faxinaDaUnidade` com as dependências de verdade. */
async function faxinaReal(alvo: AlvoDaFaxina, agoraEpoch: number): Promise<ResultadoUnidade> {
  const units = await prisma.unit.findMany({ where: { isActive: true } });
  const unit = units.find((u) => u.slug === alvo.slug);
  if (!unit) throw new Error(`unidade ${alvo.slug} não encontrada`);
  const todas = units.filter((u) => (u.kommoSubdomain ?? '').trim().toLowerCase() === alvo.subdominio.toLowerCase());
  const dividida = await contaDividida(todas.length ? todas : [unit]);
  const contaUnit = dividida?.conta ?? unit;
  if (!contaUnit.kommoAccessToken) throw new Error('unidade sem credencial do Kommo');
  const kommo = createKommoClient(contaUnit);
  const ctx: CtxFaxina = { slug: alvo.slug, nome: alvo.nome, subdominio: alvo.subdominio, modo: alvo.modo, cuidaDaConta: alvo.cuidaDaConta, contaDividida: alvo.contaDividida, agoraEpoch };
  const grupoDaConta = todas.length ? todas : [unit];
  const deps: DepsDaFaxina = {
    kommo,
    duplicados: (c) =>
      duplicadosPelaEntradaAutomatica({
        // SEM o freio global, como o worker do #233: GET /leads/unsorted e o vínculo pedem token de administrador, e um 403 aqui não pode congelar o Kommo da rede
        kommo: createKommoClientSemFreio(contaUnit),
        unit: { id: unit.id, slug: unit.slug },
        gravar: c.modo === 'ligado',
        // a caixa é da CONTA: se qualquer unidade dela ligou a entrada-estoque, o worker do #233 já cuida (estado mais cauteloso, como lá)
        estadoDoEstoqueNaConta: estadoDaConta(grupoDaConta.map((u) => estadoDaAutomacao(u.slug, ID_ESTOQUE, process.env.ENTRADA_ESTOQUE_SLUGS))),
        ultimoResumoDoWorker: () => ultimoResumoDaEntrada(alvo.subdominio),
        cancelado: () => !souLider(),
        pausa,
      }),
    etapas: (c) => etapasDaFaxina(c, unit),
    motivos: (c) => motivosDaFaxina(c, unit, grupoDaConta),
    pausa,
    lider: souLider,
  };
  return faxinaDaUnidade(ctx, deps);
}

/** As unidades que a faxina atende hoje: ligadas ou em só no papel, agrupadas por conta do Kommo (a dividida entra inteira). */
async function alvosReais(soSlug?: string): Promise<AlvoDaFaxina[]> {
  const units = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
  const porConta = new Map<string, Unit[]>();
  for (const u of units) {
    const conta = u.kommoSubdomain?.trim().toLowerCase();
    if (!conta) continue;
    porConta.set(conta, [...(porConta.get(conta) ?? []), u]);
  }
  const alvos: AlvoDaFaxina[] = [];
  for (const [conta, todas] of porConta) {
    const dividida = await contaDividida(todas);
    const membros = dividida ? dividida.membros : todas.slice(0, 1);
    // quem cuida da CONTA (tarefas, etiquetas, duplicados) é a primeira unidade ligada, peça-se uma só ou todas: decidir depois
    // do filtro faria a irmã de um Kommo dividido repetir o que é da primeira
    const ligadas = membros.filter((m) => estadoDaFaxina(m.slug) !== 'desligado');
    const donoDaConta = ligadas[0]?.slug;
    for (const m of ligadas) {
      if (soSlug && m.slug !== soSlug) continue;
      alvos.push({ slug: m.slug, nome: m.name, subdominio: conta, modo: estadoDaFaxina(m.slug) as 'ligado' | 'seco', cuidaDaConta: m.slug === donoDaConta, contaDividida: !!dividida });
    }
  }
  return alvos;
}

const depsReais: DepsDaRodada = {
  alvos: alvosReais,
  reivindicar: (nome, ttl) => reivindicarLease(nome, undefined, ttl),
  faxina: faxinaReal,
  enviar: (texto) => enviarTelegram(texto),
  agora: () => new Date(),
  lider: souLider,
};

// ─── liga, tick e sob demanda ───────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let rodandoAgora = false;

async function tick(): Promise<void> {
  if (rodandoAgora) return;
  if (!janelaDaFaxina(new Date()).dentro) return;
  rodandoAgora = true;
  try {
    const d = await rodarFaxinaDoMes({}, depsReais);
    if (d.resultados.length) logger.info({ unidades: d.resultados.length, enviado: d.enviado }, 'faxina-do-mes: rodada concluída');
  } catch (err) {
    logger.error({ err: String(err) }, 'faxina-do-mes: a rodada falhou');
  } finally {
    rodandoAgora = false;
  }
}

/**
 * Roda a faxina de UMA unidade agora, fora do dia 1 (para o João testar), e responde na hora: o relatório chega no Telegram.
 * A unidade precisa estar ligada ou em só no papel — desligada não roda nem sob demanda.
 */
export interface PartidaSobDemanda {
  iniciado: boolean;
  modo?: 'ligado' | 'seco';
  motivo?: string;
  /** 409 = agora não (já rodando, não é o líder); 422 = nada a rodar (desligada, sem Kommo); 503 = erro do servidor (banco) */
  status?: 409 | 422 | 503;
}

export async function iniciarFaxinaSobDemanda(slug: string, opcoes: { telegram?: boolean } = {}, deps: DepsDaRodada = depsReais): Promise<PartidaSobDemanda> {
  if (rodandoAgora) return { iniciado: false, status: 409, motivo: 'a faxina já está rodando (aguarde o relatório no Telegram)' };
  // a passada das automações de etapa só é segura no processo que lidera os workers (a trava `rodando` delas é de memória)
  if (!deps.lider()) return { iniciado: false, status: 409, motivo: 'este servidor não é o que lidera os robôs agora (deploy em andamento?): tente de novo em 1 minuto' };
  const estado = estadoDaFaxina(slug);
  if (estado === 'desligado') return { iniciado: false, status: 422, motivo: 'a Faxina do mês está desligada nesta unidade: ponha em «Só no papel» na tela de Automações e tente de novo' };
  rodandoAgora = true;
  let alvos: AlvoDaFaxina[];
  try {
    alvos = await deps.alvos(slug);
  } catch (err) {
    rodandoAgora = false;
    return { iniciado: false, status: 503, motivo: `não consegui montar a rodada agora (${String(err).slice(0, 100)})` };
  }
  if (alvos.length === 0) {
    rodandoAgora = false;
    return { iniciado: false, status: 422, motivo: 'nada a rodar nesta unidade: sem credencial do Kommo (ou a conta não tem unidade ativa com Kommo)' };
  }
  void rodarFaxinaDoMes({ soSlug: slug, sobDemanda: true, telegram: opcoes.telegram, alvos }, deps)
    .catch((err) => logger.error({ err: String(err), slug }, 'faxina-do-mes: a rodada sob demanda falhou'))
    .finally(() => {
      rodandoAgora = false;
    });
  return { iniciado: true, modo: estado };
}

export function startFaxinaDoMesWorker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  logger.info({ tickMs: TICK_MS }, 'faxina-do-mes: worker ligado (só age no dia 1, entre 2h e 7h, onde a tela ligou)');
}

export function stopFaxinaDoMesWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Só para teste: zera a memória de "já fiz neste mês". */
export function _esquecerFeitas(): void {
  terminadasNoMes.clear();
  interrompidas.clear();
  ultimosDoMes.clear();
}
