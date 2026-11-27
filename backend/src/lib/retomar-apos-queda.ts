import type { Unit } from '@prisma/client';
import { FALLBACK_INDISPONIVEL } from '../agent/llm-policy.js';
import { equipeRespondeuDepois, roboSaiuDepois, type ConversaLida, type ResultadoRetomada, type TurnoPerdido } from './recuperar-turnos.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';

/**
 * Retomada ÚNICA das conversas que ficaram na frase de queda da IA (`FALLBACK_INDISPONIVEL`: "Opa, tive uma instabilidade rapidinha…
 * Pode mandar de novo? Já te respondo.").
 *
 * Caso real (27/11/2026): entre 26/11 21h UTC e 27/11 12h UTC a Anthropic e a OpenAI ficaram sem crédito. 71 conversas receberam a frase
 * de queda; em 48 ela foi a ÚLTIMA coisa dita — o paciente perguntou, ouviu "pode mandar de novo" e ficou calado.
 *
 * Mesma REGRA-MÃE de `recuperar-turnos.ts`: na dúvida, TAREFA para a recepção em vez de resposta. Resposta por cima da equipe, em dobro
 * ou fora do horário é pior que atraso, e tarefa no cartão tira o paciente do silêncio. Só volta para a IA o pedido sobre o qual TUDO se sabe.
 *
 * Por conversa, nesta ordem (cada regra tem um teste):
 *  1. a conversa andou depois da queda (mensagem nova no nosso banco) → fecha: o fluxo normal já cuidou;
 *  2. sem mensagem do paciente ligada à queda → fecha (nada a responder; fica no relatório);
 *  3. unidade dona do cartão agora (etapa) inválida/inativa → fecha;
 *  4. canal que não é o Kommo → TAREFA (só o webhook do Kommo reentra no agente com segurança);
 *  5. a EQUIPE respondeu depois do pedido (Kommo talks oficiais, fala humana; cada pedido é julgado sozinho) → fecha o que ela respondeu;
 *     se ela respondeu todos, a conversa fecha;
 *  6. IA pausada (unidade, lead com data, caixinha "Pausar IA") → fecha;
 *  7. etapa fechada para a IA (ALTA/ganho/cancelado, fora da allowlist, regra global) → fecha;
 *  8. não consegui ler o Kommo, ou a equipe estava na conversa, ou um robô falou depois do pedido → TAREFA;
 *  9. fora do horário da unidade → TAREFA (o turno normal mandaria a mensagem de "fora do horário");
 * 10. o trace da queda já tinha chamado ferramenta de agenda ou Pix → TAREFA (reinjetar mostraria a mensagem 2× ao modelo);
 * 11. mais de 20 mensagens sem resposta (o limite do coalescer) → TAREFA;
 * 12. cada mensagem passa pela MESMA avaliação da recuperação do deploy (`avaliarRetomada`: lembrete D-1, botão, encerramento repetido…);
 *     qualquer uma que pede tarefa leva a conversa toda para a tarefa;
 * 13. UMA vez por conversa: a reivindicação é gravada (e RECUSA se o banco falhar). Só então o aviso é plantado e as mensagens voltam,
 *     da mais nova para a mais velha, pelo coalescer (vira UM turno, com todas as sem resposta juntas), marcadas como retomadas
 *     (não mexem na etapa do cartão).
 *
 * Simulação por padrão: nada é gravado, agendado nem enviado; só se lê (banco e Kommo).
 */

export const ESCOPO_REIVINDICACAO_QUEDA = 'retomada-apos-queda';
/** A reivindicação vale por um mês: nenhuma conversa é retomada duas vezes pela mesma queda (nem pela seguinte, sem soltar à mão). */
export const TTL_REIVINDICACAO_QUEDA_MS = 30 * 24 * 60 * 60_000;
/** O limite do coalescer (`MAX_MESSAGES_PER_BURST`): mais que isto não cabe num turno só. */
export const MAX_MENSAGENS_NO_TURNO = 20;
/** Quanto esperar um turno retomado terminar antes de seguir (o turno normal leva ~30 s). */
export const ESPERA_MAX_DO_TURNO_MS = 5 * 60_000;
/** Marca da conversa no texto que o aviso do turno leva. */
export const PREFIXO_DA_QUEDA = 'Opa, tive uma instabilidade rapidinha';

const normalizar = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();

/** Esta fala da IA é a frase de queda? (por prefixo: um ajuste de pontuação no texto não pode esconder a conversa) */
export function ehFraseDeQueda(texto: string): boolean {
  const n = normalizar(texto);
  return n === normalizar(FALLBACK_INDISPONIVEL) || n.startsWith(normalizar(PREFIXO_DA_QUEDA));
}

export interface MensagemDaConversa {
  role: string;
  content: string;
  createdAt: Date;
  traceId: string | null;
}

export interface TrechoSemResposta {
  /** As frases de queda depois da última fala de verdade da IA/equipe, em ordem. */
  quedas: MensagemDaConversa[];
  /** As mensagens do paciente nesse mesmo trecho, em ordem (ainda sem o vínculo com a queda). */
  pacientes: MensagemDaConversa[];
}

/**
 * O trecho final da conversa que a queda deixou sem resposta: tudo depois da última RESPOSTA DE VERDADE DA SOFIA (fala do assistente com
 * `traceId` que não é a frase de queda). A fala da equipe importada do Kommo (sem `traceId`) NÃO fecha o trecho: no banco ela é indistinguível
 * da resposta automática do WhatsApp Business ("nosso horário de atendimento é…"), que não responde nada — quem diz se a equipe respondeu é a
 * conversa oficial do Kommo, pedido a pedido (`retomarConversa`). null = a ÚLTIMA mensagem da conversa não é a frase de queda (já andou, ou
 * nunca foi o caso) — não é candidata.
 */
export function trechoSemResposta(mensagens: readonly MensagemDaConversa[]): TrechoSemResposta | null {
  const ordenadas = [...mensagens].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const ultima = ordenadas[ordenadas.length - 1];
  if (!ultima || ultima.role !== 'assistant' || !ehFraseDeQueda(ultima.content)) return null;
  let corte = -1;
  ordenadas.forEach((m, i) => {
    if (m.role === 'assistant' && m.traceId && !ehFraseDeQueda(m.content)) corte = i;
  });
  const trecho = ordenadas.slice(corte + 1);
  return {
    quedas: trecho.filter((m) => m.role === 'assistant' && ehFraseDeQueda(m.content)),
    pacientes: trecho.filter((m) => m.role === 'user'),
  };
}

/**
 * A mensagem do paciente pertence à queda? Quando o trace dela É o de uma frase de queda (o dono do burst) ou foi coalescido nele
 * (`__coalesced_into__:<dono>`). Mensagem do mesmo trecho que não se liga a nenhuma queda não é da queda: foi respondida por outro caminho
 * (a equipe pelo Kommo, por exemplo) e retomá-la seria responder velho.
 */
export function ligadaAQueda(trace: { id: string; iaDecision: unknown }, tracesDasQuedas: ReadonlySet<string>): boolean {
  if (tracesDasQuedas.has(trace.id)) return true;
  const d = trace.iaDecision;
  if (typeof d !== 'string' || !d.startsWith('__coalesced_into__:')) return false;
  return tracesDasQuedas.has(d.slice('__coalesced_into__:'.length));
}

/** Passo de ferramenta de agenda ou Pix no trace: marcou, cancelou, remarcou, listou horário, gerou cobrança. */
const FERRAMENTA_QUE_NAO_REPETE = /agend|hor[aá]rio|consult|marcad|remarc|cancel|pix|sinal|cobran/i;

/** O passo gravado é uma chamada (ou resultado) de ferramenta de agenda ou Pix? */
export function passoDeAgendaOuPix(passo: { kind: string; title: string }): boolean {
  return (passo.kind === 'TOOL_CALL' || passo.kind === 'TOOL_RESULT') && FERRAMENTA_QUE_NAO_REPETE.test(passo.title);
}

/**
 * Um robô (Salesbot, lembrete, follow-up…) falou com o paciente DEPOIS do pedido? A própria frase de queda chega ao Kommo como fala de
 * 'sofia' e NÃO conta: é o que estamos consertando.
 */
export function roboFalouDepoisDoPedido(msgs: readonly MensagemOficial[], desde: Date): boolean {
  return roboSaiuDepois(
    msgs.filter((m) => !ehFraseDeQueda(m.texto)),
    desde,
  );
}

// ── decisão e execução ─────────────────────────────────────────────────────────────────────────────────

export interface CandidataDaQueda {
  conversaId: string;
  unitId: string;
  unitSlug: string;
  leadId: string;
  canal: string;
  /** A última frase de queda enviada. */
  quedaEm: Date;
  /** Os traces das frases de queda e os dos pedidos ligados a elas (donos e satélites do burst). */
  tracesDaQueda: string[];
  /** Os pedidos do paciente ligados à queda, em ordem. */
  pedidos: TurnoPerdido[];
  /** Mensagens do paciente no trecho que NÃO se ligam a nenhuma queda (ficam de fora; só vão para o relatório). */
  ignoradas: number;
}

export type Acao = 'fechar' | 'tarefa' | 'reinjetar';
export type Efeito = 'simulado' | 'feito' | 'nada' | 'falhou' | 'adiado';

export interface ResultadoDaConversa {
  conversaId: string;
  unidade: string;
  leadId: string;
  mensagens: number;
  acao: Acao;
  motivo: string;
  /** `simulado` = nada foi gravado (sem `--aplicar`); `feito`; `nada` = fechada sem agir (não há o que gravar); `falhou` (a tarefa/retomada deu erro); `adiado` (o banco não confirmou — rodar de novo). */
  efeito: Efeito;
  detalhe?: string;
}

export interface DepsDaRetomada {
  agora(): Date;
  /** Unidade DONA do paciente agora (etapa do cartão); null = inativa ou lead inválido. */
  unidadeDona(t: TurnoPerdido): Promise<Unit | null>;
  /** Chegou mensagem (de qualquer lado) depois da queda? */
  conversaAndou(conversaId: string, quedaEm: Date): Promise<boolean>;
  /** Algum destes traces já chamou ferramenta de agenda ou Pix? */
  traceTeveAgendaOuPix(traceIds: string[]): Promise<boolean>;
  /** Conversa oficial do Kommo. LANÇA se não leu. */
  lerConversa(unit: Unit, leadId: string): Promise<ConversaLida>;
  iaPausada(unit: Unit, leadId: string): Promise<boolean>;
  /** Por que a IA não responde neste cartão por causa da ETAPA (ou null = pode). LANÇA se não leu. */
  etapaFechada(unit: Unit, leadId: string): Promise<string | null>;
  foraDoHorario(unit: Unit): boolean;
  /** Só leitura: este pedido pode voltar para a IA? Devolve o contexto opaco a entregar a `agendar`. */
  avaliar(t: TurnoPerdido, unit: Unit): Promise<{ naoRetomar: ResultadoRetomada } | { ctx: unknown }>;
  reivindicar(conversaId: string): Promise<'ganhou' | 'perdeu' | 'incerto'>;
  liberarReivindicacao(conversaId: string): Promise<void>;
  /** Planta no processo o aviso que o PRÓXIMO turno deste paciente lê (não pedir para mandar de novo, responder tudo). */
  plantarAviso(unit: Unit, leadId: string): void;
  /** Devolve o pedido ao coalescer (registra o passo no trace). */
  agendar(t: TurnoPerdido, unit: Unit, ctx: unknown): Promise<ResultadoRetomada>;
  /** `ja_existia` = já há tarefa criada DEPOIS deste pedido. LANÇA se o Kommo recusou. */
  criarTarefa(unit: Unit, t: TurnoPerdido, esperaMs: number): Promise<'criada' | 'ja_existia'>;
}

/** Decide e (com `aplicar`) age numa conversa. NUNCA lança: o que der errado vira `efeito: 'falhou'`. */
export async function retomarConversa(deps: DepsDaRetomada, c: CandidataDaQueda, aplicar: boolean): Promise<ResultadoDaConversa> {
  const base = { conversaId: c.conversaId, unidade: c.unitSlug, leadId: c.leadId, mensagens: c.pedidos.length };
  const simulado: Efeito = aplicar ? 'feito' : 'simulado';
  const fechar = (motivo: string, detalhe?: string): ResultadoDaConversa => ({ ...base, acao: 'fechar', motivo, efeito: 'nada', ...(detalhe ? { detalhe } : {}) });
  try {
    if (await deps.conversaAndou(c.conversaId, c.quedaEm)) return fechar('conversa_andou_depois_da_queda');
    if (c.pedidos.length === 0) return fechar('sem_mensagem_do_paciente_ligada_a_queda');

    const unit = await deps.unidadeDona(c.pedidos[c.pedidos.length - 1]!);
    if (!unit) return fechar('unidade_ou_lead_invalido');

    // A partir da conferência do Kommo só ficam os pedidos que a equipe NÃO respondeu (cada um é julgado sozinho): `pedidos` encolhe.
    let pedidos = c.pedidos;
    const tarefa = async (motivo: string): Promise<ResultadoDaConversa> => {
      if (!aplicar) return { ...base, acao: 'tarefa', motivo, efeito: 'simulado' };
      // Entre a decisão e a tarefa a conversa pode ter andado (a Sofia respondeu um recado novo): confere de novo.
      if (await deps.conversaAndou(c.conversaId, c.quedaEm)) return fechar('conversa_andou_depois_da_queda');
      try {
        const r = await deps.criarTarefa(unit, pedidos[pedidos.length - 1]!, deps.agora().getTime() - pedidos[0]!.criadoEm.getTime());
        return { ...base, acao: 'tarefa', motivo, efeito: 'feito', detalhe: r === 'ja_existia' ? 'a tarefa já existia' : undefined };
      } catch (err) {
        return { ...base, acao: 'tarefa', motivo, efeito: 'falhou', detalhe: `o Kommo recusou a tarefa: ${String(err)}` };
      }
    };

    // Só o webhook do Kommo reentra no agente. Chatwoot (Sofia própria, sem `messages`) e Kapso (só transporte) não têm caminho seguro.
    if (c.canal !== 'kommo_chat') return tarefa(`canal_sem_reinjecao_segura:${c.canal}`);

    let conversa: ConversaLida | null = null;
    try {
      conversa = await deps.lerConversa(unit, c.leadId);
    } catch {
      conversa = null;
    }
    if (conversa) {
      const msgs = conversa.msgs;
      pedidos = pedidos.filter((p) => !equipeRespondeuDepois(msgs, p.criadoEm));
      if (pedidos.length === 0) return fechar('equipe_respondeu_depois_do_pedido');
    }

    if (await deps.iaPausada(unit, c.leadId)) return fechar('ia_pausada');

    let etapa: string | null;
    try {
      etapa = await deps.etapaFechada(unit, c.leadId);
    } catch {
      return tarefa('nao_consegui_ler_a_etapa');
    }
    if (etapa) return fechar('etapa_fechada', etapa);

    if (!conversa || conversa.naoConferi) return tarefa('nao_consegui_conferir_o_kommo');
    if (conversa.equipeComAPalavra) return tarefa('equipe_na_conversa');
    if (roboFalouDepoisDoPedido(conversa.msgs, pedidos[0]!.criadoEm)) return tarefa('robo_falou_depois_do_pedido');
    if (deps.foraDoHorario(unit)) return tarefa('fora_do_horario');
    if (await deps.traceTeveAgendaOuPix(c.tracesDaQueda)) return tarefa('trace_da_queda_tinha_agenda_ou_pix');
    if (pedidos.length > MAX_MENSAGENS_NO_TURNO) return tarefa('mais_de_20_mensagens_sem_resposta');

    // Cada mensagem passa pela avaliação da recuperação do deploy. Uma que pede tarefa leva a conversa toda: o turno junta tudo.
    const vao: Array<{ t: TurnoPerdido; ctx: unknown }> = [];
    let descarte: string | null = null;
    for (const t of pedidos) {
      const a = await deps.avaliar(t, unit);
      if ('naoRetomar' in a) {
        if (a.naoRetomar.startsWith('tarefa:')) return tarefa(a.naoRetomar.slice('tarefa:'.length));
        descarte = a.naoRetomar.slice('descartado:'.length);
        continue;
      }
      vao.push({ t, ctx: a.ctx });
    }
    if (vao.length === 0) return fechar(descarte ?? 'nada_para_retomar');

    if (!aplicar) return { ...base, acao: 'reinjetar', motivo: 'sem_resposta_da_equipe_nada_pausa_dentro_do_horario', efeito: 'simulado', detalhe: `${vao.length} mensagem(ns) voltam em 1 turno` };

    // Pegou a vez? Uma vez só, em qualquer processo. Conferida DE NOVO antes: a reivindicação não se devolve por pouco.
    if (await deps.conversaAndou(c.conversaId, c.quedaEm)) return fechar('conversa_andou_depois_da_queda');
    const vez = await deps.reivindicar(c.conversaId);
    if (vez === 'perdeu') return fechar('ja_retomada_antes');
    if (vez === 'incerto') return { ...base, acao: 'reinjetar', motivo: 'banco_nao_confirmou_a_reivindicacao', efeito: 'adiado' };

    deps.plantarAviso(unit, c.leadId);
    // Da mais nova para a mais velha: o coalescer usa a execução (contexto do chat) de quem abre o burst, e a mais nova é a que vale;
    // ele mesmo reordena por chegada, então o turno lê as mensagens na ordem em que o paciente as escreveu.
    let falhou: string | null = null;
    for (const { t, ctx } of [...vao].reverse()) {
      try {
        const r = await deps.agendar(t, unit, ctx);
        if (r !== 'retomado') falhou = r;
      } catch (err) {
        falhou = String(err);
      }
    }
    if (falhou) {
      // Parte pode ter ido: a conversa NÃO volta a ser retomada (a reivindicação fica), a recepção fica sabendo.
      const t = await tarefa(`falha_ao_retomar:${falhou}`);
      return { ...t, detalhe: `${t.detalhe ?? ''} (parte das mensagens pode ter voltado para a IA)`.trim() };
    }
    return { ...base, acao: 'reinjetar', motivo: 'sem_resposta_da_equipe_nada_pausa_dentro_do_horario', efeito: simulado, detalhe: `${vao.length} mensagem(ns) voltaram em 1 turno` };
  } catch (err) {
    // Conversa com problema não derruba as outras.
    return { ...base, acao: 'tarefa', motivo: 'erro_inesperado', efeito: 'falhou', detalhe: String(err) };
  }
}

export interface OpcoesDaExecucao {
  aplicar: boolean;
  /** Conversas ao mesmo tempo (cada uma espera o seu turno terminar). */
  paralelo: number;
}

export interface DepsDaExecucao extends DepsDaRetomada {
  /** Espera os traces saírem do coalescer. true = terminaram; false = estourou o tempo. */
  esperarTurno(traceIds: string[]): Promise<boolean>;
  /** A IA mandou a frase de queda DE NOVO nesta conversa depois de `desde`? */
  respondeuComQueda(conversaId: string, desde: Date): Promise<boolean>;
}

export interface ResumoDaExecucao {
  resultados: ResultadoDaConversa[];
  /** Parou no meio porque a IA voltou a dar a frase de queda. */
  interrompida: boolean;
  porAcao: Record<string, number>;
  porMotivo: Record<string, number>;
  porUnidade: Record<string, Record<string, number>>;
}

export function resumir(resultados: ResultadoDaConversa[], interrompida = false): ResumoDaExecucao {
  const porAcao: Record<string, number> = {};
  const porMotivo: Record<string, number> = {};
  const porUnidade: Record<string, Record<string, number>> = {};
  for (const r of resultados) {
    porAcao[r.acao] = (porAcao[r.acao] ?? 0) + 1;
    const m = `${r.acao}:${r.motivo}`;
    porMotivo[m] = (porMotivo[m] ?? 0) + 1;
    const u = (porUnidade[r.unidade] ??= {});
    u[r.acao] = (u[r.acao] ?? 0) + 1;
  }
  return { resultados, interrompida, porAcao, porMotivo, porUnidade };
}

/**
 * Roda todas as candidatas. Com `aplicar`, cada conversa retomada espera o seu turno terminar e confere se a IA respondeu DE VERDADE:
 * se uma voltou a mandar a frase de queda, o modelo ainda está fora do ar — PARA, e as demais ficam intactas (nem reivindicadas).
 */
export async function executar(
  deps: DepsDaExecucao,
  candidatas: CandidataDaQueda[],
  opcoes: OpcoesDaExecucao,
  aoTerminar: (r: ResultadoDaConversa) => void = () => undefined,
): Promise<ResumoDaExecucao> {
  const resultados: ResultadoDaConversa[] = [];
  let interrompida = false;
  let proxima = 0;
  const trabalhador = async (): Promise<void> => {
    while (!interrompida) {
      const c = candidatas[proxima++];
      if (!c) return;
      const inicio = deps.agora();
      let r = await retomarConversa(deps, c, opcoes.aplicar);
      if (opcoes.aplicar && r.acao === 'reinjetar' && r.efeito === 'feito') {
        const terminou = await deps.esperarTurno(c.pedidos.map((p) => p.traceId));
        if (await deps.respondeuComQueda(c.conversaId, inicio)) {
          interrompida = true;
          r = { ...r, efeito: 'falhou', detalhe: 'a IA respondeu com a frase de queda DE NOVO — execução interrompida' };
        } else if (!terminou) {
          r = { ...r, detalhe: `${r.detalhe ?? ''} (o turno não terminou em ${Math.round(ESPERA_MAX_DO_TURNO_MS / 60_000)} min; confira o trace)`.trim() };
        }
      }
      resultados.push(r);
      aoTerminar(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opcoes.paralelo) }, trabalhador));
  return resumir(resultados, interrompida);
}

export function linhaDoResultado(r: ResultadoDaConversa): string {
  return `${r.unidade.padEnd(28)} lead ${r.leadId.padEnd(10)} conv ${r.conversaId.slice(-8)}  ${r.acao.toUpperCase().padEnd(9)} ${r.motivo}  [${r.efeito}, ${r.mensagens} msg]${r.detalhe ? `  — ${r.detalhe}` : ''}`;
}
