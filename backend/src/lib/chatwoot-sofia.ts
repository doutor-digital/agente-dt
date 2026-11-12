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
import { travaDaAgendaDaIa } from './crm-compartilhado.js';
import { dataPorExtenso, feriadoNacional } from './feriados.js';
import { consultaMarcadaNoTurno, legendaDoCartao } from './cartao-de-chegada.js';
import { extrairBotoes } from './botoes.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import { type ConversaLida, type PortaDoChatwoot } from './chatwoot-porta.js';

export type { ConversaLida, PortaDoChatwoot };

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
import { leadDaConversaChatwoot } from './chatwoot-lead.js';
import type { SandboxAction, rodarTesteDaSofia } from '../controllers/playground.controller.js';

export type Fala = { role: 'user' | 'assistant'; content: string };
export type ModoDaSofia = 'seco' | 'ligado';

// ── o Chatwoot, como a Sofia o enxerga: ver chatwoot-porta.ts ──

// ── regras da conversa (puras) ─────────────────────────────────────────────────────────────────────

/** Etapas de quem já tem consulta de pé ou já passou por ela: a Sofia não as muda. */
export const ETAPAS_PROTEGIDAS: ReadonlySet<string> = new Set(['Agendado', 'Confirmado', 'Compareceu', 'Pós-consulta', 'Fechou']);
/** Etapas em que o agendamento da Sofia leva a conversa para «Agendado». */
const ETAPAS_QUE_VIRAM_AGENDADO = new Set(['', 'Novo lead', 'Sofia qualifica', 'Esperando humano', 'Frio', 'Resgate', 'Perdido']);
/** O que `mover_etapa` aceita da Sofia. As outras etapas são efeito de outra ação (agendar, passar à equipe) ou da equipe. */
export const ETAPAS_DA_SOFIA = ['Sofia qualifica', 'Frio', 'Perdido'] as const;
export const ETIQUETA_HUMANO = 'esperando-humano';
/** Etiquetas que DISPARAM a régua ou marcam outro processo: a Sofia não as põe. */
const ETIQUETAS_RESERVADAS = new Set(['confirmar-retorno', 'retomada', 'reativacao', 'boas-vindas', 'aderencia-meio', 'sem-follow-up', 'pagou-antecipado', 'respondeu-pelo-celular', ETIQUETA_HUMANO, 'sem-resposta', 'pendente-de-revisao']);

/**
 * A Sofia deve ficar calada? Conversa já passada para a equipe, paciente em tratamento (o funil de tratamento é humano)
 * ou grupo. Devolve o motivo, ou null para seguir.
 */
export function motivoDeNaoResponder(c: ConversaLida): string | null {
  if (c.grupo) return 'grupo';
  if (texto(c.attrs.etapa) === 'Esperando humano' || c.etiquetas.includes(ETIQUETA_HUMANO)) return 'esperando-humano';
  if (texto(c.attrs.funil) === 'Tratamento' || texto(c.attrs.etapa_tratamento)) return 'em-tratamento';
  return null;
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

  // ── passar à equipe (pausar_ia, e o aviso do Pix que não saiu) ──
  const passarParaEquipe = async (motivo: string): Promise<boolean> => {
    if (seco) {
      estado.passouParaEquipe = true;
      return true;
    }
    try {
      await chat.adicionarEtiquetas(conversa, [ETIQUETA_HUMANO]);
      // etapa não é campo: quem tem consulta de pé ou já passou por ela fica onde está (a etiqueta e a nota avisam a equipe)
      if (!ETAPAS_PROTEGIDAS.has(estado.etapa) && (await chat.valoresDoAtributo('etapa')).includes('Esperando humano')) {
        await chat.gravarAtributos(conversa, { etapa: 'Esperando humano' });
        estado.etapa = 'Esperando humano';
      }
      await chat.nota(conversa, `🙋 Sofia passou esta conversa para a equipe: ${motivo.slice(0, 300)}`);
      estado.passouParaEquipe = true;
      return true;
    } catch (err) {
      logger.warn({ err: String(err), conversa }, 'chatwoot-sofia: não consegui passar a conversa para a equipe');
      return false;
    }
  };

  // ── o conjunto da agenda ──
  const agenda = deps.construirAgenda(
    { unit, recorder, telefoneDaConversa: p.telefone ?? undefined, semSondagem: seco, semGravar: seco },
    { avisarEquipe: (motivo, detalhe) => passarParaEquipe(motivo === 'sinal_pix_falhou' ? `o Pix do sinal não saiu. ${detalhe}` : `Pix do sinal gerado mas sem registro. ${detalhe}`) },
  );

  if (seco) {
    const semAntecipado = unidadeSemAntecipado(unit);
    const taxaObrigatoria = !semAntecipado && !!unit.spineBookingRequiresPayment;
    const sinal = sinalDaUnidade(unit);
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
      const pendencia = porQueNaoReservar({ ...a, formaPagamento: forma, semAntecipado, taxaObrigatoria, sinal });
      if (pendencia) return pendencia;
      const recusa = await conferirHorario(a.data, a.hora);
      if (recusa) return recusa;
      estado.agendou = { data: a.data, hora: a.hora };
      const quemEQuando = semAntecipado ? linhaProntaDaData(a.data, semAntecipado) : ' Confirme ao paciente com EXATAMENTE este dia da semana e data.';
      return `Consulta marcada para ${dataPorExtenso(a.data)} às ${a.hora}.${quemEQuando}${orientacaoDePagamento(forma, unit, semAntecipado, sinal)}`;
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
      'Passa a conversa para a equipe humana (etiqueta esperando-humano, etapa «Esperando humano» e uma nota com o motivo) e a Sofia para de responder nela até a equipe falar. Use quando o paciente pede um atendente, quando você não sabe ou não pode resolver, ou quando uma ferramenta pedir. Termine a sua mensagem avisando o paciente que a equipe continua.',
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
  for (const t of reais) {
    const interno = t.func.bind(t);
    t.func = async (args: unknown, ...resto: unknown[]) => {
      const res = String(await interno(args as never, ...(resto as never[])));
      onCall({ tool: t.name, args: sem(args), result: res });
      if (t.name === 'agendar_consulta' && agendamentoDeuCerto(res)) {
        const a = args as { data: string; hora: string };
        await depoisDeAgendar(a);
      }
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

export function preambuloDoChatwoot(a: { modo: ModoDaSofia; unitNome: string; telefone: string | null }): string {
  return `# CONTEXTO DESTE ATENDIMENTO
Você está respondendo uma conversa REAL de WhatsApp da ${a.unitNome}, que chegou pelo Chatwoot. Aqui NÃO existe Kommo, cartão nem leadId: não cite nada disso ao paciente.
${a.telefone ? `O telefone do paciente (o WhatsApp desta conversa) é ${a.telefone}: use este em buscar_paciente e cadastrar_paciente, a menos que ele diga outro.` : ''}
Ferramentas deste canal: consultar_horarios, buscar_paciente, cadastrar_paciente, agendar_consulta, remarcar_consulta, cancelar_consulta, gerar_sinal_pix (se a unidade usa sinal), aplicar_tag, mover_etapa, registrar_qualificacao e pausar_ia. Não existem ferramentas de campos do cartão nem de título do lead: o que o paciente contar (queixa, cidade…) fica só na conversa.
- Não escreva a linha [[botoes: …]]: aqui não há botões. Ofereça as opções no próprio texto, em frase curta.
- A etapa «Agendado» e a data da consulta são gravadas sozinhas quando agendar_consulta dá certo. Para passar o paciente à equipe use pausar_ia.
${a.modo === 'seco' ? '- MODO DE OBSERVAÇÃO: as ferramentas que gravam estão simuladas; a sua mensagem NÃO chega ao paciente. Aja exatamente como agiria de verdade.' : '- Sua mensagem vai direto ao paciente, e as ferramentas gravam de verdade.'}`;
}

export interface PedidoDaSofia {
  unit: Unit;
  falas: Fala[];
  conversa: number;
  modo: ModoDaSofia;
  lida: ConversaLida;
  chat: PortaDoChatwoot;
}

export interface ResultadoDaSofia {
  resposta: string;
  acoes: Array<{ tool: string; args: Record<string, unknown> }>;
  /** o Pix copia-e-cola do sinal, que vai SOZINHO numa mensagem depois da resposta (só no ligado) */
  pix: string | null;
  /** endereço e mapa, depois de marcar (só no ligado) */
  cartao: string | null;
  passouParaEquipe: boolean;
  /** o modelo falhou ou não escreveu resposta, mas as ferramentas já tinham agido: nada a enviar, equipe avisada */
  semResposta?: boolean;
}

export interface DepsDaRodada {
  rodarTeste: typeof rodarTesteDaSofia;
  ferramentas?: DepsDasFerramentas;
}

export async function rodarSofiaDoChatwoot(p: PedidoDaSofia, deps: DepsDaRodada): Promise<ResultadoDaSofia | null> {
  const recorder = new RastroEmMemoria(`cw-${p.conversa}-${Date.now()}`, p.unit.id);
  const estado: EstadoDaRodada = { etapa: texto(p.lida.attrs.etapa), agendou: null, passouParaEquipe: false };
  const feitas: SandboxAction[] = [];
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
        onCall: (a) => {
          feitas.push(a);
          onCall(a);
        },
        deps: deps.ferramentas,
      }),
    preambulo: preambuloDoChatwoot({ modo: p.modo, unitNome: p.unit.name, telefone: p.lida.telefone }),
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
      semResposta: true,
    };
  }
  const acoes = r.actions.map((a) => ({ tool: a.tool, args: a.args }));

  // a mesma limpeza da saída que o Kommo faz: sem botões (não há aqui) e com o guardrail de preço, tom e pronto-socorro
  const semBotoes = extrairBotoes(r.reply).texto;
  const resposta = aplicarGuardrail(semBotoes, p.unit, {
    mensagensDoPaciente: p.falas.filter((f) => f.role === 'user').map((f) => f.content),
    consultaMarcada: !!estado.agendou,
  }).text.trim();

  // primeira resposta: a conversa deixa de ser «Novo lead» (etapa só vira o que a Sofia sabe; quem já passou disso fica onde está)
  if (!estado.passouParaEquipe && !estado.agendou && (estado.etapa === '' || estado.etapa === 'Novo lead')) {
    try {
      if ((await p.chat.valoresDoAtributo('etapa')).includes('Sofia qualifica')) {
        if (p.modo === 'ligado') await p.chat.gravarAtributos(p.conversa, { etapa: 'Sofia qualifica' });
        acoes.push({ tool: 'mover_etapa', args: { etapa: 'Sofia qualifica', automatico: true } });
      }
    } catch (err) {
      logger.warn({ err: String(err), conversa: p.conversa }, 'chatwoot-sofia: não consegui pôr a conversa em «Sofia qualifica»');
    }
  }

  const ligado = p.modo === 'ligado';
  return {
    resposta,
    acoes,
    pix: ligado ? (pixDoSinalDoTurno(recorder.traceId) ?? null) : null,
    cartao: ligado && consultaMarcadaNoTurno(recorder.traceId) ? legendaDoCartao(p.unit) : null,
    passouParaEquipe: estado.passouParaEquipe,
  };
}
