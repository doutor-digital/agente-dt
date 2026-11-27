/**
 * A Sofia DE VERDADE numa conversa do Chatwoot (pedido do João, 12/11/2026: «completa, mesmo que demore»).
 *
 * O que muda em relação ao modo de teste que a `chatwoot-ia` usava até aqui (`rodarTesteDaSofia` com ferramentas de mentira):
 *  - AGENDA, CADASTRO e SINAL PIX são as ferramentas REAIS do Kommo (`agent/agenda-tools.ts`, `agent/sinal-pix-tool.ts`), sem mudar uma
 *    linha da regra: franquia, trava de duplicado, conferência de telefone, Asaas. O que elas guardam "por lead" usa a chave sintética
 *    da conversa (`chatwoot-lead.ts`) e o telefone vem do Chatwoot. `kommo` não existe neste caminho: nada grava em cartão do Kommo.
 *  - O que no Kommo é campo/etapa/etiqueta/«pausar a IA» vira atributo/etiqueta/nota DA CONVERSA do Chatwoot (com mesclagem: o
 *    Chatwoot substitui o objeto inteiro de atributos). Valores de lista conferidos contra as definições VIVAS do Chatwoot.
 *
 * DOIS MODOS (o mesmo conjunto de ferramentas, o mesmo esquema para o modelo):
 *  - `seco`: as de LEITURA são reais (horários da franquia — só a grade, sem a sondagem que marca e desmarca —, busca de paciente sem
 *    gravar vínculo). As que ESCREVEM (cadastrar, agendar, remarcar, cancelar, sinal, tag, etapa, qualificação, passar à equipe) são
 *    simuladas: respondem ao modelo como se tivessem dado certo, depois de conferir as mesmas portas (dia confirmado, forma de
 *    pagamento, feriado, horário livre na grade). Nada é gravado.
 *  - `ligado`: tudo de verdade. Depois de `agendar_consulta` dar certo grava data, hora, situação «Agendado», qualificação «Quente»
 *    e a etapa «Agendado» (se a conversa ainda não passou dessa fase).
 *
 * Etapa não é campo: quem já está em Agendado/Confirmado/Compareceu/Pós-consulta/Fechou NÃO muda de etapa por ação da Sofia
 * (a régua lê a etapa; mover quem está em alta dispara mensagem de meses depois). Campo sim, etapa não.
 */
import { categoriaDoMotivo, type CodigoDoMotivo, type OrigemDaPassagem } from './motivo-da-passagem.js';
import { notaComMencao } from './crm-tarefas/regras.js';
import { ETIQUETA_PAUSA } from './chatwoot-pausa.js';
import { MOTIVOS_MORTOS } from './motivos-mortos.js';
import { classificarFala, falasDoUltimoTurno } from './sofia-fecha-quente-morno.js';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { TraceRecorder } from '../agent/trace-recorder.js';
import {
  buildAgendarConsulta,
  buildBuscarPaciente,
  buildCadastrarPaciente,
  buildCancelarConsulta,
  buildConsultarHorarios,
  buildRemarcarConsulta,
  consultaAtual,
  gradeDoDia,
  interpretarHorarioEscolhido,
  linhaProntaDaData,
  orientacaoDePagamento,
  porQueNaoReservar,
} from '../agent/agenda-tools.js';
import { buildGerarSinalPix, pixDoSinalDoTurno, textoDoSinal } from '../agent/sinal-pix-tool.js';
import { fixarLeadDaConversa } from '../agent/graph.js';
import { agendamentoDeuCerto } from '../agent/remarcacao.js';
import { aplicarGuardrail } from '../agent/guardrail.js';
import { sinalDaUnidade } from '../agent/prompt-composer.js';
import { unidadeSemAntecipado } from '../agent/pagamento-da-unidade.js';
import { pixDepoisDeMarcar } from '../agent/pix-depois-de-marcar.js';
import { travaDaAgendaDaIa } from './crm-compartilhado.js';
import { dataLocalISO, dataPorExtenso, feriadoNacional } from './feriados.js';
import { consultaMarcadaNoTurno, legendaDoCartao } from './cartao-de-chegada.js';
import { extrairBotoes } from './botoes.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import { MARCA_DO_RESGATE, texto, type ConversaLida, type PortaDoChatwoot } from './chatwoot-porta.js';
import { leadDaConversaChatwoot } from './chatwoot-lead.js';
import { hojeDaUnidade, resumoDaPassagem } from './chatwoot-resumo-passagem.js';
import { aceitouEsteHorario, ID_SO_COM_SIM, recusaDeAceite } from './chatwoot-agenda-so-com-sim.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { fusoDaUnidade } from './fuso.js';
import { ID_PRECO_UNICO, textoDosValores, valoresForaDaConfiguracao } from './chatwoot-preco-unico.js';
import type { SandboxAction, rodarTesteDaSofia } from '../controllers/playground.controller.js';

export type { ConversaLida, PortaDoChatwoot };


export type Fala = { role: 'user' | 'assistant'; content: string };
export type ModoDaSofia = 'seco' | 'ligado';

// ── regras da conversa (puras) ─────────────────────────────────────────────────────────────────────

/** Etapas de quem já tem consulta de pé ou já passou por ela: a Sofia não as muda. */
export const ETAPAS_PROTEGIDAS: ReadonlySet<string> = new Set(['Agendado', 'Confirmado', 'Compareceu', 'Pós-consulta', 'Fechou']);
/** Etapas em que o agendamento da Sofia leva a conversa para «Agendado». */
const ETAPAS_QUE_VIRAM_AGENDADO = new Set(['', 'Novo lead', 'Sofia qualifica', 'Frio', 'Resgate', 'Perdido']);
/** O que `mover_etapa` aceita da Sofia. As outras etapas são efeito de outra ação (agendar, passar à equipe) ou da equipe. */
export const ETAPAS_DA_SOFIA = ['Sofia qualifica', 'Frio', 'Perdido'] as const;
export const ETIQUETA_HUMANO = 'esperando-humano';
/** Etiquetas que DISPARAM a régua ou marcam outro processo: a Sofia não as põe. */
const ETIQUETAS_RESERVADAS = new Set(['confirmar-retorno', 'retomada', 'reativacao', 'boas-vindas', 'aderencia-meio', 'sem-follow-up', 'pagou-antecipado', 'respondeu-pelo-celular', ETIQUETA_HUMANO, 'interno', 'sem-resposta', 'pendente-de-revisao',
  // «anuncio» = veio de anúncio COMPROVADO pelo Kapso (chatwoot-origem.ts); palpite da Sofia ("vi o anúncio") misturaria a pasta
  'anuncio',
  // «Sofia atendendo» é um SINAL do servidor (chatwoot-sofia-atendendo.ts): se o modelo pudesse pôr, mentiria numa conversa já passada à equipe
  'sofia-atendendo']);

/**
 * A Sofia deve ficar calada? Contato interno, conversa já passada para a equipe, paciente em tratamento (o funil de tratamento é humano)
 * ou grupo. Devolve o motivo, ou null para seguir.
 */
export function motivoDeNaoResponder(c: ConversaLida): string | null {
  if (c.grupo) return 'grupo';
  // a equipe falando com o número da unidade («libera», «acabando»): etiqueta `interno` na conversa ou atributo `interno` no contato
  if (c.interno) return 'interno';
  if (texto(c.attrs.etapa) === 'Esperando humano' || c.etiquetas.includes(ETIQUETA_HUMANO)) return 'esperando-humano';
  // pausa da IA nesta conversa (uma pessoa assumiu, ou respondeu pelo celular): fica calada até reativar ou resolver
  if (c.etiquetas.includes(ETIQUETA_PAUSA)) return 'ia-pausada';
  if (texto(c.attrs.funil) === 'Tratamento' || texto(c.attrs.etapa_tratamento)) return 'em-tratamento';
  return null;
}

/**
 * Motivos de «Perdido» em que a conversa que VOLTA a escrever não é resgate de venda. Duas fontes, nenhuma inventada aqui:
 *  1. a lista de motivos MORTOS que a casa já usa (`motivos-mortos.ts`: os 5 do João de 06/11 — outra cidade, clicou por engano, outra
 *     patologia, plano de saúde, sem interesse — mais bandeira vermelha, caso enviado à franquia, informação para terceiro…);
 *  2. os que são DA EQUIPE no CRM e não estão nela: cancelamento de tratamento, currículo, fornecedor/propaganda, «não perturbar» (o paciente
 *     pediu para não ser incomodado) e «lead morto».
 * Nesses a Sofia segue como sempre seguiu (responde, sem mexer na etapa).
 */
const MOTIVOS_DA_EQUIPE = /cancelamento de tratamento|curriculo|fornecedor|propaganda|nao perturbar|lead morto/;
const semAcento = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** O motivo registrado deixa o caso com a equipe? (a grafia varia na conta: «Caso enviado à franquia», «Currículo / vaga», espaço duplo) */
export function motivoSemResgate(motivo: string): boolean {
  const sem = semAcento(motivo);
  const compacto = sem.replace(/[^a-z0-9]/g, '');
  return MOTIVOS_DA_EQUIPE.test(sem) || MOTIVOS_MORTOS.some((m) => compacto.includes(m)) || /caso enviado/.test(sem);
}

export const ETAPA_RESGATE = 'Resgate';
/** a chave por unidade (catálogo): desligada = a Sofia como sempre; «só no papel» (o padrão) = só anota o que faria; ligada = o resgate de verdade */
export const ID_RESGATE = 'chatwoot-sofia-resgate';
export { MARCA_DO_RESGATE };

/**
 * A conversa estava em «Perdido» e o paciente voltou a escrever (a caixa trava em conversa única: a mensagem reabre a conversa): a Sofia atende
 * como RESGATE — sabe que ele já foi dado como perdido, não recomeça do zero e a conversa sai de «Perdido». Devolve o motivo da perda, ou null
 * quando não é resgate (outra etapa, motivo que fica com a equipe, ou desligado por `CHATWOOT_SOFIA_RESGATE=0`).
 * Quem está em tratamento ou com a equipe nem chega aqui (`motivoDeNaoResponder` calou antes).
 *
 * «Resgate» é uma etapa de TRABALHO da equipe (chatwoot-guia-etapas.ts): o prompt só vale ali quando foi a Sofia quem pôs a conversa lá
 * (`MARCA_DO_RESGATE`); a que a equipe moveu à mão não ganha o «foi dada como Perdido».
 */
export function resgateDaConversa(attrs: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): { motivo: string; mover: boolean; devolver: boolean } | null {
  if (env.CHATWOOT_SOFIA_RESGATE === '0') return null;
  const etapa = texto(attrs.etapa);
  const daSofia = texto(attrs[MARCA_DO_RESGATE]) === 'sim';
  if (etapa !== 'Perdido' && !(etapa === ETAPA_RESGATE && daSofia)) return null;
  const motivo = texto(attrs.motivo_nao_agendamento);
  if (motivo && motivoSemResgate(motivo)) return null;
  return { motivo, mover: etapa === 'Perdido', devolver: etapa === ETAPA_RESGATE };
}

/**
 * Grava a etapa do resgate (e a marca «resgate da Sofia»). Quem recusou de vez volta para «Perdido» COM `sem-follow-up`: a etiqueta entra ANTES da etapa, para a
 * régua nunca ver «Perdido» sem ela e mandar os follow-ups de 48/96/120 h a quem pediu para parar.
 */
export async function gravarEtapaDoResgate(chat: PortaDoChatwoot, conversa: number, etapa: string, opcoes?: { semFollowUp?: boolean }): Promise<void> {
  if (opcoes?.semFollowUp) await chat.adicionarEtiquetas(conversa, ['sem-follow-up']);
  try {
    await chat.gravarAtributos(conversa, { etapa, [MARCA_DO_RESGATE]: etapa === ETAPA_RESGATE ? 'sim' : 'nao' });
  } catch (err) {
    // a etapa não foi gravada: a etiqueta que acabou de entrar não pode ficar numa conversa que segue em «Resgate»
    if (opcoes?.semFollowUp) await chat.removerEtiquetas?.(conversa, ['sem-follow-up']).catch(() => undefined);
    throw err;
  }
}

const NAO_SECO = /^[\s\W]*(?:n[aã]o|nao)[\s,.!]*(?:obrigad[oa])?[\s.!]*$/i;

/**
 * O paciente recusou de vez («não quero mais», «pare de me mandar», «não tenho interesse») na última fala dele? Aí o resgate NÃO o tira de «Perdido».
 * Óbito («minha mãe faleceu») NÃO é recusa: é caso sensível para a equipe (a Sofia não mexe na etapa para nenhum lado — ver `falouDeLuto`).
 * `forte`: sem o «não» seco — para DEVOLVER a «Perdido» quem já está conversando em «Resgate», onde um «não» solto costuma ser a resposta a uma pergunta da
 * Sofia («já fez fisioterapia?»), não recusa. Para NÃO tirar de «Perdido» quem acabou de voltar, o «não» seco conta (lado seguro).
 */
export function recusouDeVez(falas: readonly Fala[], forte = false): boolean {
  const turno = falasDoUltimoTurno(falas);
  const classe = classificarFala(turno);
  if (classe === 'parar-contato') return true;
  if (classe !== 'recusa') return false;
  return !(forte && turno.length > 0 && turno.every((t) => NAO_SECO.test(t)));
}

/** o paciente falou de falecimento/luto: caso para a equipe, a etapa não anda (nem para «Resgate», nem de volta a «Perdido») */
export const falouDeLuto = (falas: readonly Fala[]): boolean => classificarFala(falasDoUltimoTurno(falas)) === 'obito';

/**
 * Passa a conversa para a equipe: etiqueta `esperando-humano`, etapa «Esperando humano» e uma nota com o motivo. Etapa não é campo: quem
 * tem consulta de pé ou já passou por ela (`ETAPAS_PROTEGIDAS`) fica na etapa em que está — a etiqueta e a nota avisam a equipe, e a
 * etiqueta cala a Sofia. Devolve a etapa em que a conversa ficou. LANÇA se o Chatwoot falhar.
 */
export async function passarParaEquipeNoChatwoot(chat: PortaDoChatwoot, a: {
    conversa: number;
    etapa: string;
    motivo: string;
    /**
     * a linha «Resumo: …» (chatwoot-resumo-passagem.ts) que vai no fim da nota. Em função: recebe os atributos da conversa como estão AGORA (a leitura que esta
     * passagem já faz) — se a Sofia cancelou ou remarcou nesta rodada, os que a rodada leu no começo estão velhos e a nota mostraria consulta que não existe mais.
     */
    resumo?: string | null | ((atributosDeAgora: Record<string, unknown>) => string | null);
  },
): Promise<string> {
  let etapa = a.etapa;
  // já passada antes (etiqueta no lugar): a nota repete, mas a MENÇÃO não — a pessoa não é chamada duas vezes pela mesma passagem
  const deAgora = await chat.conversa(a.conversa).catch(() => null);
  const jaPassada = !!deAgora?.etiquetas.includes(ETIQUETA_HUMANO);
  await chat.adicionarEtiquetas(a.conversa, [ETIQUETA_HUMANO]);
  if (!ETAPAS_PROTEGIDAS.has(etapa) && (await chat.valoresDoAtributo('etapa')).includes('Esperando humano')) {
    await chat.gravarAtributos(a.conversa, { etapa: 'Esperando humano' });
    etapa = 'Esperando humano';
  }
  const motivo = a.motivo.slice(0, 300);
  // com a conversa já ABERTA desde a 1ª mensagem o Chatwoot não avisa ninguém na passagem: a menção na nota privada avisa quem está com a
  // conversa (rodízio) ou, sem dono, a gerente da caixa. Falhar em achar a pessoa cai na nota de sempre.
  const destino = jaPassada || !chat.destinoDaPassagem ? null : await chat.destinoDaPassagem(a.conversa).catch(() => null);
  // sem a leitura de agora (o Chatwoot falhou) a consulta e a qualificação ficam de fora: melhor calar que mostrar o que a rodada já mudou
  let linha: string | null | undefined;
  if (typeof a.resumo === 'function' && !deAgora) logger.warn({ conversa: a.conversa }, 'chatwoot-sofia: não consegui reler a conversa para o resumo da passagem — a nota sai sem consulta nem qualificação');
  try {
    linha = typeof a.resumo === 'function' ? a.resumo(deAgora?.attrs ?? {}) : a.resumo;
  } catch {
    linha = null; // o resumo é enfeite: nunca impede a passagem
  }
  const resumo = linha?.trim() ? `\n${linha.trim()}` : '';
  await chat.nota(a.conversa, destino ? notaComMencao(destino, `🙋 A Sofia passou esta conversa para você: ${motivo}${resumo}`) : `🙋 Sofia passou esta conversa para a equipe: ${motivo}${resumo}`);
  return etapa;
}

export const etiquetaNormalizada = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** O que gravar nos atributos quando a Sofia marcou uma consulta. `etapa` só entra se a conversa ainda não passou dessa fase. */
export function atributosDoAgendamento(
  a: { data: string; hora: string },
  etapaAtual: string,
  qualificacoesValidas: readonly string[],
): Record<string, string> {
  const o: Record<string, string> = { data_consulta: a.data, hora_consulta: a.hora, situacao_consulta: 'Agendado' };
  if (qualificacoesValidas.includes('Quente')) o.qualificacao = 'Quente';
  if (ETAPAS_QUE_VIRAM_AGENDADO.has(etapaAtual)) o.etapa = 'Agendado';
  return o;
}

// ── o rastro em memória ────────────────────────────────────────────────────────────────────────────

/** As ferramentas reais contam o que fizeram a um `TraceRecorder`. Aqui não há trace de banco: o passo vai para o log. */
export class RastroEmMemoria extends TraceRecorder {
  readonly passos: Array<{ kind: string; title: string }> = [];
  override async step(args: { kind: string; title: string; payload?: unknown; latencyMs?: number }): Promise<void> {
    this.passos.push({ kind: args.kind, title: args.title });
    logger.debug({ traceId: this.traceId, kind: args.kind }, `chatwoot-sofia: ${args.title}`);
  }
  override async finalize(): Promise<void> {
    /* sem trace de banco */
  }
}

// ── as ferramentas ─────────────────────────────────────────────────────────────────────────────────

export interface ContextoDaAgenda {
  unit: Unit;
  recorder: TraceRecorder;
  telefoneDaConversa?: string;
  semSondagem?: boolean;
  semGravar?: boolean;
  avisoSemKommo?: (motivo: string, detalhe: string) => Promise<boolean>;
}

export interface FerramentasDaAgenda {
  consultar_horarios: DynamicStructuredTool;
  buscar_paciente: DynamicStructuredTool;
  cadastrar_paciente: DynamicStructuredTool;
  agendar_consulta: DynamicStructuredTool;
  remarcar_consulta: DynamicStructuredTool;
  cancelar_consulta: DynamicStructuredTool;
  gerar_sinal_pix?: DynamicStructuredTool;
}

/** As ferramentas reais de agenda, SEM Kommo (o teste troca por falsas). */
export function construirAgendaReal(
  ctx: ContextoDaAgenda,
  sinal: { avisarEquipe: (motivo: 'sinal_pix_falhou' | 'sinal_pix_sem_registro', detalhe: string) => Promise<boolean> },
): FerramentasDaAgenda {
  return {
    consultar_horarios: buildConsultarHorarios(ctx),
    buscar_paciente: buildBuscarPaciente(ctx),
    cadastrar_paciente: buildCadastrarPaciente(ctx),
    agendar_consulta: buildAgendarConsulta(ctx),
    remarcar_consulta: buildRemarcarConsulta(ctx),
    cancelar_consulta: buildCancelarConsulta(ctx),
    ...(sinalDaUnidade(ctx.unit) ? { gerar_sinal_pix: buildGerarSinalPix({ unit: ctx.unit, recorder: ctx.recorder, conversaGarantida: true, avisarEquipe: sinal.avisarEquipe }) } : {}),
  };
}

export interface DepsDasFerramentas {
  construirAgenda: typeof construirAgendaReal;
  grade: (unit: Unit, dia: string) => Promise<{ erro: string | null; slots: ReadonlyArray<{ time: string; status: string; motivo?: string | null; turnoComAtendimento?: boolean }> }>;
  consulta: (unit: Unit, leadId: number) => Promise<{ quando: string } | null>;
  /** conta de Kommo dividida entre duas unidades: a agenda pela IA não separa (texto de recusa) */
  contaDividida: (unit: Unit) => Promise<string | null>;
}

export const depsReaisDasFerramentas = (): DepsDasFerramentas => ({
  construirAgenda: construirAgendaReal,
  contaDividida: (unit) => travaDaAgendaDaIa(unit),
  grade: gradeDoDia as DepsDasFerramentas['grade'],
  consulta: async (unit, leadId) => {
    const c = await consultaAtual(unit, leadId);
    return c?.quando ? { quando: c.quando } : null;
  },
});

/** O que muda durante a rodada e o fim da rodada precisa saber. */
export interface EstadoDaRodada {
  etapa: string;
  agendou: { data: string; hora: string } | null;
  passouParaEquipe: boolean;
  /** por que passou (categoria do painel Agente, `motivo-da-passagem.ts`); o 1º motivo da rodada vale */
  motivoDaPassagem?: CodigoDoMotivo | null;
  /** o modelo mexeu na etapa nesta rodada (`mover_etapa`): o resgate automático não passa por cima do que ele decidiu */
  etapaMexida?: boolean;
}

export interface PedidoDasFerramentas {
  unit: Unit;
  modo: ModoDaSofia;
  conversa: number;
  telefone: string | null;
  chat: PortaDoChatwoot;
  recorder: TraceRecorder;
  estado: EstadoDaRodada;
  onCall: (a: SandboxAction) => void;
  deps?: DepsDasFerramentas;
  /** o que a Sofia leu da conversa (as falas): alimenta o «Resumo» da nota de passagem e a trava «só agenda com sim» (a última fala do paciente); os atributos o resumo lê de AGORA, na hora de passar */
  falas?: readonly Fala[];
  /** a chave `chatwoot-agenda-so-com-sim` desta unidade; ausente = pergunta ao catálogo (o teste fixa) */
  soComSim?: Estado;
  /** o relógio (só o teste fixa): a data de hoje na unidade — para «amanhã/hoje» da fala do paciente e para a consulta do «Resumo» */
  agora?: () => Date;
}

const sem = (args: unknown): Record<string, unknown> => {
  const { leadId: _l, ...resto } = (args ?? {}) as Record<string, unknown>;
  return resto;
};

export function montarFerramentas(p: PedidoDasFerramentas): DynamicStructuredTool[] {
  const { unit, modo, conversa, chat, recorder, estado, onCall } = p;
  const deps = p.deps ?? depsReaisDasFerramentas();
  const seco = modo === 'seco';
  const lead = leadDaConversaChatwoot(conversa);

  // ── passar à equipe (pausar_ia, os avisos da agenda e do Pix) ──
  const passarParaEquipe = async (motivo: string, origem: OrigemDaPassagem = 'modelo'): Promise<boolean> => {
    // a categoria só vale quando a equipe foi mesmo avisada (o 1º motivo da rodada fica)
    const passou = () => {
      estado.passouParaEquipe = true;
      estado.motivoDaPassagem ??= categoriaDoMotivo(motivo, origem);
    };
    if (seco) {
      passou();
      return true;
    }
    try {
      estado.etapa = await passarParaEquipeNoChatwoot(chat, { conversa, etapa: estado.etapa, motivo, resumo: (atributosDeAgora) => resumoDaPassagem({ attrs: atributosDeAgora, falas: p.falas, hoje: hojeDaUnidade(unit, p.agora?.()) }) });
      passou();
      return true;
    } catch (err) {
      logger.warn({ err: String(err), conversa }, 'chatwoot-sofia: não consegui passar a conversa para a equipe');
      return false;
    }
  };

  // ── o conjunto da agenda ──
  const agenda = deps.construirAgenda(
    {
      unit,
      recorder,
      telefoneDaConversa: p.telefone ?? undefined,
      semSondagem: seco,
      semGravar: seco,
      // cadastro duplicado, agenda sem conferir, cadastro recusado, vaga presa: sem tarefa no Kommo, a equipe fica sabendo pela conversa
      avisoSemKommo: (motivo, detalhe) => passarParaEquipe(`${motivo.replace(/_/g, ' ')} — ${detalhe}`, 'agenda'),
    },
    { avisarEquipe: (motivo, detalhe) => passarParaEquipe(motivo === 'sinal_pix_falhou' ? `o Pix do sinal não saiu. ${detalhe}` : `Pix do sinal gerado mas sem registro. ${detalhe}`, motivo === 'sinal_pix_falhou' ? 'pix' : 'pix-sem-registro') },
  );

  if (seco) {
    const semAntecipado = unidadeSemAntecipado(unit);
    const taxaObrigatoria = !semAntecipado && !!unit.spineBookingRequiresPayment;
    const sinal = sinalDaUnidade(unit);
    const pixDepois = pixDepoisDeMarcar(unit, { semAntecipado, taxaObrigatoria });
    /** o horário existe na grade e está livre? devolve o texto de recusa, ou null */
    const conferirHorario = async (data: string, hora: string): Promise<string | null> => {
      const feriado = feriadoNacional(data);
      if (feriado) return `${dataPorExtenso(data)} é feriado nacional (${feriado}) — a clínica não abre. NÃO marque nesse dia; consulte horários em outro dia útil.`;
      if (!unit.spineEnabled || !unit.spineToken) return 'Agenda não conectada. NÃO confirme nada — diga que a equipe conclui o agendamento.';
      if (unit.spineAiPaused) return 'AGENDAMENTO PAUSADO pela recepção. A consulta NÃO foi marcada. Explique que houve uma intercorrência na agenda e que a equipe confirma o horário em seguida. NÃO diga que está agendado.';
      const dividida = await deps.contaDividida(unit);
      if (dividida) return dividida;
      const { erro, slots } = await deps.grade(unit, data);
      if (erro) return `Não consegui confirmar a agenda (${erro}). NÃO diga que está marcado.`;
      const slot = slots.find((s) => s.time === hora);
      if (!slot) return `${hora} não é um horário de atendimento em ${data}. Consulte os horários de novo e ofereça um da lista.`;
      const marcavel = slot.status === 'livre' || (slot.status === 'incerto' && !!slot.turnoComAtendimento);
      return marcavel ? null : `${hora} não está mais disponível (${slot.motivo ?? slot.status}). A consulta NÃO foi marcada. Peça desculpas, consulte os horários de novo e ofereça outro.`;
    };

    agenda.cadastrar_paciente.func = async (a: { nome: string; telefone: string; horarioEscolhido: string }) => {
      if (a.nome.trim().split(/\s+/).filter((x) => x.length >= 2).length < 2) return 'RECUSADO: falta o sobrenome. Pergunte o nome completo antes de cadastrar.';
      const quando = interpretarHorarioEscolhido(a.horarioEscolhido);
      if (!quando.ok) return `RECUSADO: ${quando.motivo} Só cadastre quem já escolheu o horário — ofereça os horários primeiro.`;
      const fone = SpineService.normalizarWhatsapp(a.telefone);
      if (!fone || fone.replace(/\D/g, '').length < 12) return 'RECUSADO: telefone incompleto. Peça o número com DDD.';
      return 'Cadastrado. idClient 999001 — use este número em agendar_consulta.';
    };

    agenda.agendar_consulta.func = async (a: { idClient: number; data: string; hora: string; diaConfirmado?: boolean; formaPagamento?: string }) => {
      let forma = a.formaPagamento;
      if (semAntecipado) forma = 'na_clinica';
      if (taxaObrigatoria) forma = 'pix_antecipado';
      if (sinal && forma === 'pix_antecipado') forma = 'sinal_pix';
      // Chave `pix-depois-de-marcar`: mesma regra da agenda do Kommo (agent/pix-depois-de-marcar.ts).
      const formaNaoDita = pixDepois && !forma;
      if (formaNaoDita && !sinal) forma = 'na_clinica';
      const pendencia = porQueNaoReservar({ ...a, formaPagamento: forma, semAntecipado, taxaObrigatoria, sinal, pixDepois });
      if (pendencia) return pendencia;
      const recusa = await conferirHorario(a.data, a.hora);
      if (recusa) return recusa;
      estado.agendou = { data: a.data, hora: a.hora };
      const quemEQuando = semAntecipado ? linhaProntaDaData(a.data, semAntecipado) : ' Confirme ao paciente com EXATAMENTE este dia da semana e data.';
      return `Consulta marcada para ${dataPorExtenso(a.data)} às ${a.hora}.${quemEQuando}${orientacaoDePagamento(formaNaoDita ? undefined : forma, unit, semAntecipado, sinal, formaNaoDita)}`;
    };

    agenda.remarcar_consulta.func = async (a: { data: string; hora: string }) => {
      const atual = await deps.consulta(unit, lead);
      if (!atual) return 'RECUSADO: este paciente não tem consulta marcada para remarcar. Se ele quer marcar, use agendar_consulta.';
      const recusa = await conferirHorario(a.data, a.hora);
      if (recusa) return recusa;
      return `Consulta remarcada de ${AgendaReconcileService.porExtenso(atual.quando)} para ${dataPorExtenso(a.data)} às ${a.hora}. Confirme ao paciente com EXATAMENTE este dia da semana e data.`;
    };

    agenda.cancelar_consulta.func = async (a: { confirmado?: boolean }) => {
      const atual = await deps.consulta(unit, lead);
      if (!atual) return 'Este paciente não tem consulta marcada para cancelar.';
      return a.confirmado
        ? `Consulta de ${AgendaReconcileService.porExtenso(atual.quando)} cancelada.`
        : `Pergunte ao paciente, em UMA mensagem, se confirma o cancelamento da consulta de ${AgendaReconcileService.porExtenso(atual.quando)}. Só chame de novo com confirmado=true depois de ele dizer que sim.`;
    };

    if (agenda.gerar_sinal_pix) {
      agenda.gerar_sinal_pix.func = async () => {
        if (!sinal) return 'Esta unidade não usa sinal por Pix. NÃO ofereça sinal; siga a forma de pagamento de sempre.';
        if (!estado.agendou) return 'Ainda não há consulta marcada neste cartão. Marque primeiro com agendar_consulta; só depois gere o sinal.';
        return textoDoSinal({ tipo: 'link', url: '(Pix copia e cola de exemplo — seco)', novo: true, valor: sinal.sinal, venceEm: estado.agendou.data, copiaECola: true }, sinal, false);
      };
    }
  }

  // ── o que muda no Chatwoot depois de agendar (só o que a Sofia sabe: data, hora, situação, qualificação, etapa) ──
  const depoisDeAgendar = async (a: { data: string; hora: string }): Promise<void> => {
    estado.agendou = { data: a.data, hora: a.hora };
    try {
      const qualificacoes = await chat.valoresDoAtributo('qualificacao');
      const attrs = atributosDoAgendamento(a, estado.etapa, qualificacoes);
      if (attrs.etapa && !(await chat.valoresDoAtributo('etapa')).includes(attrs.etapa)) delete attrs.etapa;
      if (seco) {
        if (attrs.etapa) estado.etapa = attrs.etapa; // o que o ligado faria: o resto da rodada enxerga a conversa já em «Agendado»
        onCall({ tool: 'gravar_no_chatwoot', args: attrs, result: '[SECO] gravaria estes atributos na conversa — simulado.' });
        return;
      }
      await chat.gravarAtributos(conversa, attrs);
      if (attrs.etapa) estado.etapa = attrs.etapa;
      onCall({ tool: 'gravar_no_chatwoot', args: attrs, result: 'atributos gravados na conversa.' });
    } catch (err) {
      // a consulta já está na franquia; a varredura da agenda (chatwoot-agenda) completa os campos
      logger.warn({ err: String(err), conversa }, 'chatwoot-sofia: consulta marcada, mas não consegui gravar os campos na conversa');
    }
  };

  /** grava atributos da consulta na conversa; falhar não desfaz a franquia (a varredura da agenda completa) */
  const gravarSituacao = async (attrs: Record<string, string>): Promise<void> => {
    try {
      if (!seco) await chat.gravarAtributos(conversa, attrs);
      onCall({ tool: 'gravar_no_chatwoot', args: attrs, result: seco ? '[SECO] gravaria estes atributos na conversa — simulado.' : 'atributos gravados na conversa.' });
    } catch (err) {
      logger.warn({ err: String(err), conversa }, 'chatwoot-sofia: a franquia mudou, mas não consegui gravar os campos na conversa');
    }
  };
  /** remarcou: a conversa passa a mostrar o dia novo (sem isto a véspera sairia para o dia velho). Confere na franquia, não no texto da ferramenta. */
  const depoisDeRemarcar = async (a: { data: string; hora: string }, resposta: string): Promise<void> => {
    if (seco) {
      if (/^Consulta remarcada de /.test(resposta)) await gravarSituacao({ data_consulta: a.data, hora_consulta: a.hora, situacao_consulta: 'Agendado' });
      return;
    }
    const atual = await deps.consulta(unit, lead).catch(() => null);
    if (atual && atual.quando.slice(0, 16) === `${a.data}T${a.hora}`) await gravarSituacao({ data_consulta: a.data, hora_consulta: a.hora, situacao_consulta: 'Agendado' });
  };

  // ── as que são só do Chatwoot (no lugar das do Kommo) ──
  const aplicar_tag = new DynamicStructuredTool({
    name: 'aplicar_tag',
    description:
      'Põe uma ou mais etiquetas na conversa. Só vale etiqueta que já existe na conta; as que disparam mensagens ou passam a conversa à equipe (confirmar-retorno, retomada, reativacao, boas-vindas, sem-follow-up, esperando-humano…) NÃO são suas. Para passar à equipe use pausar_ia.',
    schema: z.object({ tag: z.string().min(1).max(50).optional(), tags: z.array(z.string().min(1).max(50)).min(1).max(10).optional() }),
    func: async ({ tag, tags }: { tag?: string; tags?: string[] }) => {
      const pedidas = [...new Set([...(tag ? [tag] : []), ...(tags ?? [])].map(etiquetaNormalizada).filter(Boolean))];
      if (!pedidas.length) return 'Nenhuma etiqueta informada.';
      const reservadas = pedidas.filter((t) => ETIQUETAS_RESERVADAS.has(t));
      const daConta = await chat.etiquetasDaConta();
      const existentes = new Set(daConta.map(etiquetaNormalizada));
      const nomes = new Map(daConta.map((e) => [etiquetaNormalizada(e), e]));
      const validas = pedidas.filter((t) => existentes.has(t) && !ETIQUETAS_RESERVADAS.has(t));
      const inexistentes = pedidas.filter((t) => !existentes.has(t) && !ETIQUETAS_RESERVADAS.has(t));
      if (validas.length && !seco) await chat.adicionarEtiquetas(conversa, validas.map((t) => nomes.get(t) ?? t));
      return (
        (validas.length ? `${seco ? '[SECO] ' : ''}Etiqueta(s) aplicada(s): ${validas.join(', ')}. ` : '') +
        (reservadas.length ? `RECUSADO (não é sua): ${reservadas.join(', ')}. ` : '') +
        (inexistentes.length ? `Não existe na conta: ${inexistentes.join(', ')}. ` : '')
      ).trim();
    },
  });

  const mover_etapa = new DynamicStructuredTool({
    name: 'mover_etapa',
    description:
      'Muda a etapa do funil desta conversa no Chatwoot. Aceita só: «Sofia qualifica», «Frio» ou «Perdido» (Perdido exige o motivo_nao_agendamento). «Agendado» é automático quando agendar_consulta dá certo; para passar à equipe use pausar_ia. Quem já está Agendado/Confirmado/Compareceu/Pós-consulta/Fechou não muda.',
    schema: z.object({
      etapa: z.enum(ETAPAS_DA_SOFIA),
      motivo_nao_agendamento: z.string().max(80).optional().describe('Obrigatório para «Perdido»: exatamente um dos motivos da lista da conta.'),
    }),
    func: async ({ etapa, motivo_nao_agendamento }: { etapa: (typeof ETAPAS_DA_SOFIA)[number]; motivo_nao_agendamento?: string }) => {
      if (ETAPAS_PROTEGIDAS.has(estado.etapa)) return `RECUSADO: esta conversa está em «${estado.etapa}» e a etapa dela não é sua. Se algo mudou, use pausar_ia e a equipe decide.`;
      const etapas = await chat.valoresDoAtributo('etapa');
      if (!etapas.includes(etapa)) return `RECUSADO: a etapa «${etapa}» não existe neste Chatwoot.`;
      const attrs: Record<string, unknown> = { etapa };
      if (etapa === 'Perdido') {
        const motivos = await chat.valoresDoAtributo('motivo_nao_agendamento');
        if (!motivo_nao_agendamento || !motivos.includes(motivo_nao_agendamento)) return `RECUSADO: «Perdido» exige motivo_nao_agendamento, um destes: ${motivos.join(' | ') || '(lista não disponível — use pausar_ia)'}.`;
        attrs.motivo_nao_agendamento = motivo_nao_agendamento;
      }
      if (!seco) await chat.gravarAtributos(conversa, attrs);
      estado.etapa = etapa;
      estado.etapaMexida = true;
      return `${seco ? '[SECO] ' : ''}Etapa → ${etapa}.`;
    },
  });

  const registrar_qualificacao = new DynamicStructuredTool({
    name: 'registrar_qualificacao',
    description: 'Registra o quanto o paciente está pronto para marcar: Quente (quer marcar), Morno (interessado, ainda com dúvida) ou Frio (sem interesse agora). Quem agenda vira Quente sozinho.',
    schema: z.object({ qualificacao: z.enum(['Quente', 'Morno', 'Frio']) }),
    func: async ({ qualificacao }: { qualificacao: string }) => {
      if (!(await chat.valoresDoAtributo('qualificacao')).includes(qualificacao)) return `RECUSADO: a qualificação «${qualificacao}» não existe neste Chatwoot.`;
      if (!seco) await chat.gravarAtributos(conversa, { qualificacao });
      return `${seco ? '[SECO] ' : ''}Qualificação → ${qualificacao}.`;
    },
  });

  const pausar_ia = new DynamicStructuredTool({
    name: 'pausar_ia',
    description:
      'Passa a conversa para a equipe humana (etiqueta esperando-humano, etapa «Esperando humano» e uma nota com o motivo) e a Sofia para de responder nela até a equipe tirar a etiqueta e mudar a etapa. Use quando o paciente pede um atendente, quando você não sabe ou não pode resolver, ou quando uma ferramenta pedir. Termine a sua mensagem avisando o paciente que a equipe continua.',
    schema: z.object({ motivo: z.string().min(1).max(300) }),
    func: async ({ motivo }: { motivo: string }) => {
      const ok = await passarParaEquipe(motivo);
      return ok
        ? `${seco ? '[SECO] ' : ''}Conversa passada para a equipe. Diga ao paciente, em uma frase, que a equipe continua o atendimento por aqui.`
        : 'NÃO consegui avisar a equipe agora. NÃO prometa retorno; diga que vai verificar.';
    },
  });

  const reais = (Object.values(agenda) as Array<DynamicStructuredTool | undefined>).filter((t): t is DynamicStructuredTool => !!t);
  // o lead da conversa vale em toda ferramenta, escreva o que escrever o modelo (e some do schema que ele vê)
  fixarLeadDaConversa(reais, lead, recorder, unit);
  // «SÓ AGENDA COM SIM» (chatwoot-agenda-so-com-sim.ts): a ferramenta que grava dia e hora só roda se a última fala do paciente aceitou ESTE dia
  // e ESTE horário. Chave por unidade, nasce desligada; em «só no papel» não bloqueia, só anota o que bloquearia. Desligada = byte a byte como antes.
  const soComSim: Estado = p.soComSim ?? estadoDaAutomacao(unit.slug, ID_SO_COM_SIM, process.env.CHATWOOT_AGENDA_SO_COM_SIM_SLUGS);
  const travaDoSim = (ferramenta: string, args: unknown): string | null => {
    if (soComSim === 'desligado' || (ferramenta !== 'agendar_consulta' && ferramenta !== 'remarcar_consulta')) return null;
    const a = args as { data?: string; hora?: string };
    if (!a?.data || !a?.hora) {
      // pedido torto: quem recusa é a validação (zod) da própria ferramenta; fica no log porque aqui a trava não consegue conferir
      logger.warn({ conversa, ferramenta }, 'chatwoot-sofia: só agenda com sim — pedido sem data ou hora, a trava não conferiu');
      return null;
    }
    const agora = p.agora?.() ?? new Date();
    const r = aceitouEsteHorario(p.falas ?? [], { data: a.data, hora: a.hora }, dataLocalISO(agora, fusoDaUnidade(unit)));
    if (r.ok) return null;
    const texto = recusaDeAceite(ferramenta, r, { data: a.data, hora: a.hora });
    logger.info({ conversa, ferramenta, modo: soComSim, motivo: r.motivo }, 'chatwoot-sofia: só agenda com sim — o paciente não aceitou este horário');
    if (soComSim === 'seco') {
      registrarSimulacao(unit, ID_SO_COM_SIM, { leadId: lead, acao: 'pularia', alvo: ferramenta, valor: `${a.data} ${a.hora}`, motivo: r.motivo });
      return null;
    }
    return texto;
  };
  for (const t of reais) {
    const interno = t.func.bind(t);
    t.func = async (args: unknown, ...resto: unknown[]) => {
      const recusada = travaDoSim(t.name, args);
      if (recusada) {
        onCall({ tool: t.name, args: sem(args), result: recusada });
        return recusada;
      }
      const res = String(await interno(args as never, ...(resto as never[])));
      // no seco a leitura é só a grade, sem a sondagem que o ligado faz na franquia: quem avalia o seco precisa saber
      onCall({ tool: t.name, args: seco && t.name === 'consultar_horarios' ? { ...sem(args), observacao: 'seco: só a grade, sem a sondagem — o ligado pode oferecer menos horários' } : sem(args), result: res });
      if (t.name === 'agendar_consulta' && agendamentoDeuCerto(res)) {
        const a = args as { data: string; hora: string };
        await depoisDeAgendar(a);
      }
      if (t.name === 'remarcar_consulta') await depoisDeRemarcar(args as { data: string; hora: string }, res);
      if (t.name === 'cancelar_consulta' && /^Consulta de .+ cancelada\./.test(res)) await gravarSituacao({ situacao_consulta: 'Desmarcado' });
      return res;
    };
  }
  const nativas = [aplicar_tag, mover_etapa, registrar_qualificacao, pausar_ia];
  for (const t of nativas) {
    const interno = t.func.bind(t);
    t.func = async (args: unknown, ...resto: unknown[]) => {
      const res = String(await interno(args as never, ...(resto as never[])));
      onCall({ tool: t.name, args: sem(args), result: res });
      return res;
    };
  }
  return [...reais, ...nativas];
}

// ── a rodada ───────────────────────────────────────────────────────────────────────────────────────

export function preambuloDoChatwoot(a: { modo: ModoDaSofia; unitNome: string; telefone: string | null; resgate?: { motivo: string } | null }): string {
  return `# CONTEXTO DESTE ATENDIMENTO
Você está respondendo uma conversa REAL de WhatsApp da ${a.unitNome}, que chegou pelo Chatwoot. Aqui NÃO existe Kommo, cartão nem leadId: não cite nada disso ao paciente.
${a.telefone ? `O telefone do paciente (o WhatsApp desta conversa) é ${a.telefone}: use este em buscar_paciente e cadastrar_paciente, a menos que ele diga outro.` : ''}
Ferramentas deste canal: consultar_horarios, buscar_paciente, cadastrar_paciente, agendar_consulta, remarcar_consulta, cancelar_consulta, gerar_sinal_pix (se a unidade usa sinal), aplicar_tag, mover_etapa, registrar_qualificacao e pausar_ia. Não existem ferramentas de campos do cartão nem de título do lead: o que o paciente contar (queixa, cidade…) fica só na conversa.
- Não escreva a linha [[botoes: …]]: aqui não há botões. Ofereça as opções no próprio texto, em frase curta.
- A etapa «Agendado» e a data da consulta são gravadas sozinhas quando agendar_consulta dá certo. Para passar o paciente à equipe use pausar_ia.
${a.resgate ? `- RESGATE: esta conversa foi dada como «Perdido»${a.resgate.motivo ? ` (motivo registrado: ${a.resgate.motivo})` : ''} e o paciente VOLTOU a escrever. Não recomece do zero nem repita a abertura: leia a conversa, reconheça que ele voltou e retome de onde parou, sem cobrar nem lembrar que ele sumiu. Se ele disser que não quer, respeite e encerre sem insistir. Se ele quer marcar, conduza normalmente.\n` : ''}${a.modo === 'seco' ? '- MODO DE OBSERVAÇÃO: as ferramentas que gravam estão simuladas; a sua mensagem NÃO chega ao paciente. Aja exatamente como agiria de verdade.' : '- Sua mensagem vai direto ao paciente, e as ferramentas gravam de verdade.'}`;
}

export interface PedidoDaSofia {
  unit: Unit;
  falas: Fala[];
  conversa: number;
  modo: ModoDaSofia;
  lida: ConversaLida;
  chat: PortaDoChatwoot;
  /** o relógio (só o teste fixa): a data de hoje na unidade decide se a consulta ainda vale no «Resumo» da passagem */
  agora?: () => Date;
}

export interface ResultadoDaSofia {
  resposta: string;
  acoes: Array<{ tool: string; args: Record<string, unknown> }>;
  /** o Pix copia-e-cola do sinal, que vai SOZINHO numa mensagem depois da resposta (só no ligado) */
  pix: string | null;
  /** endereço e mapa, depois de marcar (só no ligado) */
  cartao: string | null;
  passouParaEquipe: boolean;
  /** por que passou para a equipe, em categoria (só o código; o texto fica na nota do Chatwoot) */
  motivoDaPassagem?: CodigoDoMotivo | null;
  /** a consulta que ela marcou nesta rodada (no ligado, depois de a franquia aceitar); null/ausente = não marcou */
  agendou?: { data: string; hora: string } | null;
  /** o modelo falhou ou não escreveu resposta, mas as ferramentas já tinham agido: nada a enviar, equipe avisada */
  semResposta?: boolean;
  /** a etapa em que a conversa ficou no FIM da rodada (a Sofia pode ter marcado: «Agendado»); quem passa para a equipe depois usa esta, não a lida antes */
  etapa?: string;
  /** «preço único» LIGADO: a fala do modelo trazia R$ que não é da unidade — NÃO sai; `texto` é o que ela ia dizer (vai na nota para a equipe) */
  precoSegurado?: { valores: number[]; texto: string } | null;
  /** só no LIGADO: o paciente voltou de «Perdido» e a conversa deve ir para «Resgate» DEPOIS de a resposta sair (quem envia grava) */
  resgatar?: boolean;
  /** só no LIGADO: a conversa que a Sofia pôs em «Resgate» e o paciente recusou de vez volta para «Perdido» DEPOIS de a resposta sair (quem envia grava) */
  devolverAPerdido?: boolean;
}

export interface DepsDaRodada {
  rodarTeste: typeof rodarTesteDaSofia;
  ferramentas?: DepsDasFerramentas;
  /** só o teste: a chave «só agenda com sim», o relógio, a chave «preço único» e a do resgate da unidade */
  soComSim?: Estado;
  agora?: () => Date;
  precoUnico?: Estado;
  resgate?: Estado;
  /** só o teste: onde o «só no papel» anota */
  simular?: typeof registrarSimulacao;
}

export async function rodarSofiaDoChatwoot(p: PedidoDaSofia, deps: DepsDaRodada): Promise<ResultadoDaSofia | null> {
  const recorder = new RastroEmMemoria(`cw-${p.conversa}-${Date.now()}`, p.unit.id);
  const estado: EstadoDaRodada = { etapa: texto(p.lida.attrs.etapa), agendou: null, passouParaEquipe: false, motivoDaPassagem: null };
  const feitas: SandboxAction[] = [];
  // a chave da unidade: desligada = nada (como antes do resgate); «só no papel» = só anota o que faria (sem prompt novo, sem mexer em etapa); ligada = resgate de verdade
  const chave: Estado = deps.resgate ?? estadoDaAutomacao(p.unit.slug, ID_RESGATE, process.env.CHATWOOT_SOFIA_RESGATE_SLUGS);
  const resgate = chave === 'desligado' ? null : resgateDaConversa(p.lida.attrs);
  const valendo = chave === 'ligado';
  // a marca «resgate da Sofia» de uma conversa que já saiu de «Resgate» (a equipe moveu, a Sofia marcou consulta…) não pode ficar «sim»
  if (valendo && p.modo === 'ligado' && texto(p.lida.attrs[MARCA_DO_RESGATE]) === 'sim' && texto(p.lida.attrs.etapa) !== ETAPA_RESGATE) {
    await p.chat.gravarAtributos(p.conversa, { [MARCA_DO_RESGATE]: 'nao' }).catch((err: unknown) => logger.warn({ err: String(err), conversa: p.conversa }, 'chatwoot-sofia: não consegui limpar a marca velha do resgate'));
  }
  const r = await deps.rodarTeste(p.unit, p.falas, {
    ferramentas: ({ onCall }) =>
      montarFerramentas({
        unit: p.unit,
        modo: p.modo,
        conversa: p.conversa,
        telefone: p.lida.telefone,
        chat: p.chat,
        recorder,
        estado,
        falas: p.falas,
        soComSim: deps.soComSim,
        agora: deps.agora ?? p.agora,
        onCall: (a) => {
          feitas.push(a);
          onCall(a);
        },
        deps: deps.ferramentas,
      }),
    // o «VOLTOU a escrever… reconheça» é só da 1ª rodada (a conversa ainda em «Perdido»); em «Resgate» a Sofia já o acolheu e não repete
    preambulo: preambuloDoChatwoot({ modo: p.modo, unitNome: p.unit.name, telefone: p.lida.telefone, resgate: valendo && resgate?.mover ? resgate : null }),
    maxVoltas: 8,
  });
  if (!r.ok) {
    logger.warn({ conversa: p.conversa, erro: r.error, mensagem: 'message' in r ? r.message : undefined }, 'chatwoot-sofia: a rodada falhou');
    // as ferramentas podem já ter gravado (consulta marcada, Pix gerado) antes de o modelo falhar: quem chama precisa saber, para avisar a equipe
    if (!feitas.length) return null;
    return {
      resposta: '',
      acoes: feitas.map((a) => ({ tool: a.tool, args: a.args })),
      pix: null,
      cartao: null,
      passouParaEquipe: estado.passouParaEquipe,
      motivoDaPassagem: estado.motivoDaPassagem ?? null,
      agendou: p.modo === 'ligado' ? estado.agendou : null,
      etapa: estado.etapa,
      semResposta: true,
    };
  }
  const acoes = r.actions.map((a) => ({ tool: a.tool, args: a.args }));

  // a mesma limpeza da saída que o Kommo faz: sem botões (não há aqui) e com o guardrail de preço, tom e pronto-socorro
  const semBotoes = extrairBotoes(r.reply).texto;
  // PREÇO ÚNICO (chatwoot-preco-unico.ts): R$ na fala do MODELO que não é da unidade. Ligado: a mensagem é segurada (quem chama avisa a equipe);
  // «só no papel»: anota o que seguraria e a mensagem sai como sempre; desligado (o padrão): nada.
  let precoSegurado: ResultadoDaSofia['precoSegurado'] = null;
  const estadoDoPreco: Estado = deps.precoUnico ?? estadoDaAutomacao(p.unit.slug, ID_PRECO_UNICO, process.env.CHATWOOT_PRECO_UNICO_SLUGS);
  if (estadoDoPreco !== 'desligado') {
    const fora = valoresForaDaConfiguracao(semBotoes, p.unit);
    if (fora.length) {
      logger.warn({ conversa: p.conversa, unit: p.unit.slug, valores: fora, modo: estadoDoPreco }, 'chatwoot-sofia: preço único — a Sofia citou valor que não é da unidade');
      if (estadoDoPreco === 'ligado') precoSegurado = { valores: fora, texto: semBotoes };
      else registrarSimulacao(p.unit, ID_PRECO_UNICO, { leadId: leadDaConversaChatwoot(p.conversa), acao: 'pularia', alvo: 'mensagem', valor: textoDosValores(fora), motivo: 'valor fora da configuração de preços da unidade' });
    }
  }
  const resposta = aplicarGuardrail(semBotoes, p.unit, {
    mensagensDoPaciente: p.falas.filter((f) => f.role === 'user').map((f) => f.content),
    consultaMarcada: !!estado.agendou,
  }).text.trim();

  // primeira resposta: a conversa deixa de ser «Novo lead» (etapa só vira o que a Sofia sabe; quem já passou disso fica onde está)
  if (!estado.passouParaEquipe && !estado.agendou && (estado.etapa === '' || estado.etapa === 'Novo lead')) {
    try {
      if ((await p.chat.valoresDoAtributo('etapa')).includes('Sofia qualifica')) {
        if (p.modo === 'ligado') {
          await p.chat.gravarAtributos(p.conversa, { etapa: 'Sofia qualifica' });
          estado.etapa = 'Sofia qualifica'; // a etapa do fim da rodada (`ResultadoDaSofia.etapa`)
        }
        acoes.push({ tool: 'mover_etapa', args: { etapa: 'Sofia qualifica', automatico: true } });
      }
    } catch (err) {
      logger.warn({ err: String(err), conversa: p.conversa }, 'chatwoot-sofia: não consegui pôr a conversa em «Sofia qualifica»');
    }
  }

  // RESGATE: o paciente que estava em «Perdido» voltou e a Sofia respondeu — a conversa deixa de ser «Perdido» (o funil e a régua não podem seguir tratando
  // como perdido quem está conversando). Só se a rodada não a levou para outro lugar (equipe, consulta marcada, outra etapa que o modelo escolheu).
  // No LIGADO quem grava é quem envia a resposta, DEPOIS de ela sair (`resgatar`): resposta descartada ou que não saiu não tira ninguém de «Perdido».
  // RECUSA («não quero mais», «pare de me mandar»): NÃO é resgate — fica em «Perdido» (e quem a Sofia já tinha posto em «Resgate» volta para lá).
  let resgatar = false;
  let devolverAPerdido = false;
  if (resgate && !estado.passouParaEquipe && !estado.agendou && !estado.etapaMexida) {
    const recusou = recusouDeVez(p.falas);
    const luto = falouDeLuto(p.falas);
    /** «só no papel» da chave: anota o que faria e não muda nada */
    const anota = (de: string, para: string) => {
      try {
        (deps.simular ?? registrarSimulacao)(p.unit, ID_RESGATE, { leadId: leadDaConversaChatwoot(p.conversa), acao: 'moveria', alvo: `etapa → ${para}`, valor: para, deEtapa: de, motivo: de === 'Perdido' ? 'o paciente voltou de «Perdido»: a Sofia o atenderia como resgate' : 'o paciente que estava em «Resgate» recusou de vez: voltaria para «Perdido» (sem follow-up)' });
      } catch (err) {
        logger.warn({ err: String(err), conversa: p.conversa }, 'chatwoot-sofia: não consegui anotar o «só no papel» do resgate');
      }
    };
    try {
      if (resgate.mover && estado.etapa === 'Perdido' && !recusou && !luto) {
        if ((await p.chat.valoresDoAtributo('etapa')).includes(ETAPA_RESGATE)) {
          if (!valendo) anota('Perdido', ETAPA_RESGATE);
          else if (p.modo === 'ligado') resgatar = true;
          else acoes.push({ tool: 'mover_etapa', args: { etapa: ETAPA_RESGATE, de: 'Perdido', automatico: true } });
        }
      } else if (resgate.devolver && estado.etapa === ETAPA_RESGATE && recusouDeVez(p.falas, true)) {
        if (!valendo) anota(ETAPA_RESGATE, 'Perdido');
        else if (p.modo === 'ligado') devolverAPerdido = true;
        else acoes.push({ tool: 'mover_etapa', args: { etapa: 'Perdido', de: ETAPA_RESGATE, automatico: true } });
      }
    } catch (err) {
      logger.warn({ err: String(err), conversa: p.conversa }, 'chatwoot-sofia: não consegui conferir a etapa «Resgate» na conta');
    }
  }

  const ligado = p.modo === 'ligado';
  return {
    resposta,
    acoes,
    pix: ligado ? (pixDoSinalDoTurno(recorder.traceId) ?? null) : null,
    cartao: ligado && consultaMarcadaNoTurno(recorder.traceId) ? legendaDoCartao(p.unit) : null,
    passouParaEquipe: estado.passouParaEquipe,
    motivoDaPassagem: estado.motivoDaPassagem ?? null,
    agendou: ligado ? estado.agendou : null,
    etapa: estado.etapa,
    precoSegurado,
    resgatar,
    devolverAPerdido,
  };
}
