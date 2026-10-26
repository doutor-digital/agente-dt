/**
 * A IA só diz "confirmado / agendado / reservado" quando a consulta existe no CRM da franquia.
 *
 * Item 3 da lista da Suzanne (25/10/2026). O que foi medido em produção (14 dias, 26/10):
 *  - Canaã #28886952: a foto do comprovante virou consulta marcada e "✅ Agendamento confirmado" no mesmo
 *    turno; a equipe, que conferia o pagamento, tinha outra data. Decisão do João (26/10): comprovante em
 *    foto ou PDF, SÓ A EQUIPE confirma.
 *  - Balsas #28858838: a recepção desmarcou, o prompt do turno dizia "foi DESMARCADA no sistema" e a IA
 *    respondeu "sua consulta está marcada pra hoje, 22/10, às 13h — já está tudo certo". A trava de texto
 *    (`reserva-sem-marcar.ts`) não pegou: a frase vinha depois de "pra eu te garantir certo:", que o detector
 *    lia como condição.
 *
 * Aqui mora o que é decisão de código (não de prompt): o turno com comprovante não marca nem confirma; a
 * resposta que afirma é trocada pelo recado fixo; a equipe ganha a tarefa. Puro onde dá — o que fala com
 * o Kommo recebe o cliente por parâmetro.
 */
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { avisoRecente, marcarAviso } from '../lib/aviso-dedupe.js';
import { logger } from '../lib/logger.js';
import { enviarTelegram } from '../lib/telegram.js';
import { ehTranscricaoDeComprovante } from '../lib/pagamento-antecipado.js';
import { normalizar, trechos, type Promessa } from '../lib/prometeu-sem-marcar.js';
import type { KommoClient } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';

/** O que a Sofia diz quando chega comprovante. */
export const RECADO_COMPROVANTE =
  'Recebi seu comprovante! 🙏 A equipe confere o pagamento e confirma a sua consulta em até 1 hora, aqui mesmo na conversa.';

/** A consulta que a IA tinha como marcada foi desmarcada no CRM: ela não confirma nada, a equipe vê. */
export const RECADO_DESMARCADA =
  'Deixa eu conferir direitinho o seu horário com a equipe — ela te confirma aqui mesmo na conversa em até 1 hora. 🙏';

/** Vai junto da resposta reprovada quando o CRM diz que a consulta foi desmarcada (refeita da trava). */
export const INSTRUCAO_DESMARCADA =
  '[instrução interna, não é fala do paciente] Sua resposta acima trata como marcada uma consulta que foi DESMARCADA ' +
  'no sistema da clínica: ela não existe mais. Se o paciente pediu, NESTA mensagem, um horário novo e já escolheu ' +
  'dia, hora e forma de pagamento, use consultar_horarios e agendar_consulta. Se ele só confirmou o horário antigo ' +
  'ou perguntou se está tudo certo, NÃO marque nada: diga que vai conferir com a equipe, que confirma em até 1 hora, ' +
  'sem dizer confirmado, agendado nem reservado. Responda só com a mensagem final ou com a chamada da ferramenta.';

/** O bloco `<consulta_do_paciente>` que diz "não há consulta de pé": desmarcada ou não compareceu. */
const BLOCO_SEM_CONSULTA = /foi DESMARCADA no sistema da clínica|registrou NÃO COMPARECEU/;

export function blocoDizDesmarcada(bloco: string | null | undefined): boolean {
  return BLOCO_SEM_CONSULTA.test(String(bloco ?? ''));
}

/**
 * Afirma que a consulta/vaga/pagamento ESTÁ confirmada, agendada, marcada ou reservada. Mais largo que o
 * `detectarPromessa` do vigia (que erra para o lado de calar): vale só onde afirmar é sempre falso — turno com
 * comprovante, ou consulta que o CRM diz desmarcada.
 */
const ASSUNTO = '(?:consulta|avaliacao|agendamento|horario|vaga|reserva|presenca|pagamento|pix)';
const PARTICIPIO = '(?:confirmad|agendad|marcad|reservad|garantid|recebid)(?:inh)?[oa]s?';
/** Frases de estado que dizem O QUE está confirmado: "sua consulta está confirmada", "Agendamento confirmado". */
const AFIRMA_FORTE = new RegExp(
  [
    `\\b${ASSUNTO}\\s+(?:\\S+\\s+){0,5}?${PARTICIPIO}\\b`,
    `\\b${PARTICIPIO}\\s+(?:\\S+\\s+){0,2}?(?:consulta|vaga|horario|presenca)\\b`,
    String.raw`\b(?:confirmei|agendei|marquei|reservei|garanti)\b`,
  ].join('|'),
);
/** Frases soltas, que só valem como afirmação de consulta se o trecho cita dia/hora: "já está tudo certo", "Recebido, confirmado!". */
const AFIRMA_FRACA = new RegExp(
  [
    String.raw`\b(?:esta|ficou|fica|ja esta|ja ficou)\s+(?:tudo\s+)?cert(?:o|inho|inha)\b|\btudo (?:cert(?:o|inho)|confirmad[oa]s?)\b`,
    String.raw`(?:^|[,;:]\s*)(?:ja\s+|tudo\s+)?(?:confirmad|agendad|reservad|garantid)[oa]s?\b`,
  ].join('|'),
);
/** Explicação de como funciona ("só é reservada depois do pagamento"), não afirmação de que ESTÁ confirmado. */
const EXPLICATIVA =
  /\b(?:so (?:e|sera|fica|ficam|sao)|somente|depois d[oae]s? (?:pagamento|comprovante|confirmacao))\b|\b(?:e|sao|sera|serao) (?:confirmad|reservad|agendad|marcad|conferid)[oa]s? pel[ao]s? (?:equipe|clinica|recepcao)\b/;
/** "Te espero terça", "nos vemos": só vale com dia/hora no trecho (no modo estrito). */
const AFIRMA_TE_ESPERO = /\b(?:te|lhe) (?:espero|esperamos|aguardo|aguardamos)\b|\bnos vemos\b/;
/** Negação/condição na ORAÇÃO da afirmação: "ainda não está confirmada", "se estiver confirmada", "para ser confirmada". */
const NAO_AFIRMA =
  /\b(?:nao|nem|nenhum|nenhuma|caso|quando|apos|depois que|assim que|aguarde|aguardando|para ser|pra ser|ate eu)\b|\bse (?:voce|vc|ele|ela|estiver|for|der)\b/;
/**
 * Modo estrito (consulta desmarcada): ali a IA ainda pode explicar preço e oferecer novo horário ("esse valor
 * já garante seu horário reservado"), então fica de fora a explicação de pagamento, e "te espero" só vale com
 * dia/hora.
 */
const EXPLICA_PAGAMENTO = /\b(?:pagando|pagamento antecipado|antecipado|antecipando|valor|pix|r\$)\b/;
const QUANDO = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|\b\d{1,2}\/\d{1,2}\b|\b(?:amanha|hoje)\b|\b\d{1,2}(?::\d{2}|h\d{0,2})\b/;

/** A oração em que a afirmação aparece: do último separador (vírgula, ponto e vírgula, dois-pontos) até o fim dela. */
function oracaoDe(n: string, fim: number): string {
  const antes = n.slice(0, fim);
  return n.slice(Math.max(antes.lastIndexOf(','), antes.lastIndexOf(';'), antes.lastIndexOf(':')) + 1, fim);
}

export function afirmaConfirmacao(texto: string | null | undefined, opcoes: { estrito?: boolean } = {}): Promessa | null {
  for (const t of trechos(String(texto ?? ''))) {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n) || EXPLICATIVA.test(n)) continue;
    if (opcoes.estrito && EXPLICA_PAGAMENTO.test(n)) continue;
    const quando = QUANDO.test(n);
    // No modo estrito (consulta desmarcada) as frases soltas só valem com dia/hora: "Tudo certo, Maria! Quer que eu
    // veja um novo horário?" não é consulta de pé.
    const m =
      AFIRMA_FORTE.exec(n) ??
      (!opcoes.estrito || quando ? AFIRMA_FRACA.exec(n) : null) ??
      (!opcoes.estrito || quando ? AFIRMA_TE_ESPERO.exec(n) : null);
    if (m && !NAO_AFIRMA.test(oracaoDe(n, m.index + m[0].length))) return { trecho: t, forma: 'confirmacao', quando: null };
  }
  return null;
}

/**
 * O prompt diz que a consulta está desmarcada (ou o paciente não compareceu) e a resposta fala dela como de
 * pé. `promessa` é o que a trava de texto já achou; se ela calou, vale o detector largo em modo estrito. Marcou
 * neste turno (o paciente pediu para marcar de novo e a IA marcou) não é o caso.
 */
export function afirmouComConsultaDesmarcada(
  texto: string,
  ctx: { marcouAgora: boolean; bloco: string | null | undefined; promessa: Promessa | null },
): Promessa | null {
  if (ctx.marcouAgora || !blocoDizDesmarcada(ctx.bloco)) return null;
  return ctx.promessa ?? afirmaConfirmacao(texto, { estrito: true });
}

export interface TurnoDoComprovante {
  /** a mensagem deste turno traz foto/PDF lido como comprovante */
  noTurno: boolean;
  /** há comprovante neste turno ou numa das últimas falas do paciente: a equipe ainda não confirmou */
  pendente: boolean;
}

/**
 * As últimas falas do paciente que ainda contam. A janela sai do FATO (o comprovante está lá, lido pela visão), não do
 * texto que a IA respondeu: se ela reescreveu o recado ou não afirmou nada, o turno seguinte continua em espera.
 */
const FALAS_QUE_CONTAM = 10;

/** `falasDoPaciente` na ordem da conversa; a última é a deste turno. */
export function turnoDoComprovante(falasDoPaciente: ReadonlyArray<string>): TurnoDoComprovante {
  const noTurno = ehTranscricaoDeComprovante(falasDoPaciente[falasDoPaciente.length - 1] ?? '');
  const pendente = noTurno || falasDoPaciente.slice(-FALAS_QUE_CONTAM).some((t) => ehTranscricaoDeComprovante(t));
  return { noTurno, pendente };
}

/**
 * "pagamento confirmado", "seu Pix foi aprovado": quem confere o comprovante é a equipe, não a IA. Só com o estado
 * dito ("foi/está/já") ou o particípio colado ao assunto — "o pagamento é confirmado pela equipe" e "pagamento
 * antecipado conferido pela equipe" são explicação.
 */
const PART_PAGAMENTO = '(?:confirmad|aprovad|conferid|validad|compensad|identificad)[oa]s?';
const AFIRMA_PAGAMENTO = new RegExp(
  `\\b(?:pagamento|pix|comprovante)\\s+(?:(?:ja|foi|esta|ficou)\\s+)+(?:\\S+\\s+)?${PART_PAGAMENTO}\\b|\\b(?:pagamento|pix|comprovante)\\s+(?:ja\\s+)?${PART_PAGAMENTO}\\b`,
);
const PELA_EQUIPE = /\bpel[ao]s? (?:equipe|clinica|recepcao|time)\b/;

export function afirmaPagamentoConferido(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n) || EXPLICATIVA.test(n) || PELA_EQUIPE.test(n)) return false;
    const m = AFIRMA_PAGAMENTO.exec(n);
    return !!m && !NAO_AFIRMA.test(oracaoDe(n, m.index + m[0].length));
  });
}

/**
 * Se a resposta afirma confirmação, vale o recado fixo. Resposta que não afirma ("recebi, me manda o nome
 * completo") segue como veio. Só no turno do comprovante ou na espera da equipe (`pendente`): fora dali a frase pode
 * ser explicação ("o pagamento é confirmado pela equipe") e trocá-la mandaria "Recebi seu comprovante!" a quem não
 * mandou nada.
 *
 * - "Pagamento confirmado / Pix aprovado" é da equipe (decisão do João, 26/10): o campo "Pagou antecipado" do cartão
 *   é escrito pela própria IA a partir da foto, é informação e não confirmação.
 * - "Consulta confirmada/agendada" também, a menos que a consulta já esteja no CRM (`consultaNoCrm` = o prompt traz a
 *   consulta de verdade: criada pela equipe, ou paciente que paga o saldo): falar DELA é verdade.
 */
export function respostaDoComprovante(texto: string, turno: TurnoDoComprovante, consultaNoCrm: boolean): string | null {
  if (!turno.pendente) return null;
  if (afirmaPagamentoConferido(texto)) return RECADO_COMPROVANTE;
  if (consultaNoCrm) return null;
  return afirmaConfirmacao(texto) ? RECADO_COMPROVANTE : null;
}

export const RECUSA_DO_COMPROVANTE =
  'RECUSADO: o paciente mandou comprovante de pagamento, e comprovante quem confirma é a EQUIPE da clínica. ' +
  'A consulta NÃO foi marcada. NÃO chame agendar_consulta de novo e NÃO diga que está confirmada, agendada, ' +
  `reservada ou garantida. Responda ao paciente só isto, com as suas palavras: "${RECADO_COMPROVANTE}"`;

/** Turnos depois do comprovante: a equipe ainda não respondeu e o paciente pode estar pedindo outra coisa. */
export const RECUSA_AGUARDANDO_EQUIPE =
  'RECUSADO: a equipe da clínica ainda está conferindo o comprovante que o paciente mandou antes, e é ela quem ' +
  'confirma a consulta. A consulta NÃO foi marcada. NÃO chame agendar_consulta de novo e NÃO diga que está confirmada, ' +
  'agendada, reservada ou garantida. Se o paciente pediu outro dia ou outra forma de pagar, diga que a equipe cuida ' +
  'disso junto da confirmação e chame resumir_lead_para_sdr.';

/** Unidade com taxa de reserva (Boa Vista) e nenhum comprovante da taxa lido na conversa. */
export const RECUSA_SEM_COMPROVANTE_DA_TAXA =
  'RECUSADO: nesta unidade a vaga só é reservada DEPOIS da taxa de reserva, e ainda não há comprovante dela lido ' +
  'nesta conversa. A consulta NÃO foi marcada. NÃO diga que está agendada e NÃO chame agendar_consulta de novo neste ' +
  'turno. Diga ao paciente que o horário fica separado por enquanto e explique como garantir: PIX do valor antecipado ' +
  'desta unidade (mande a chave e peça o COMPROVANTE aqui na conversa) ou pagamento na clínica antes do dia. Quando o ' +
  'comprovante chegar (foto ou PDF), aí sim chame agendar_consulta — e nunca diga "pagamento confirmado": quem confere ' +
  'o dinheiro é a equipe. Se ele preferir pagar na clínica, chame resumir_lead_para_sdr para a equipe acompanhar.';

/**
 * Quem pode marcar (`agendar_consulta`, só ela; `remarcar_consulta` é de quem já tem consulta, tem a sua própria
 * instância e não passa por aqui). Fica no grafo e não no prompt: prompt não segura o modelo (Olímpia 19/10, Canaã 24/10).
 *
 * - Regra geral: comprovante esperando a equipe = a IA NÃO marca (só a equipe confirma por comprovante).
 * - Unidade com taxa de reserva (`exigePagamento`, flag `spineBookingRequiresPayment`; decisão do João, 26/10): é o
 *   contrário — a IA só marca DEPOIS de ler o comprovante da taxa; sem ele, recusa. Quem confere se o dinheiro caiu é
 *   a equipe (tarefa no mesmo turno), e a IA nunca diz "pagamento confirmado".
 */
export function travarAgendamentoPorComprovante(
  tools: DynamicStructuredTool[],
  turno: TurnoDoComprovante,
  recorder: Pick<TraceRecorder, 'step'>,
  opcoes: { exigePagamento?: boolean } = {},
): DynamicStructuredTool[] {
  for (const tool of tools) {
    if (tool.name !== 'agendar_consulta') continue;
    const original = tool.func.bind(tool);
    tool.func = async (args: unknown, ...resto: unknown[]) => {
      if (opcoes.exigePagamento) {
        if (turno.pendente) return original(args as never, ...(resto as never[]));
        await recorder.step({
          kind: 'ERROR',
          title: 'agendar_consulta recusado — reserva sem pagamento: nenhum comprovante da taxa lido na conversa',
          payload: { args },
        });
        return RECUSA_SEM_COMPROVANTE_DA_TAXA;
      }
      if (turno.pendente) {
        await recorder.step({
          kind: 'ERROR',
          title: '🧾 agendar_consulta recusado — comprovante: só a equipe confirma',
          payload: { noTurno: turno.noTurno, args },
        });
        return turno.noTurno ? RECUSA_DO_COMPROVANTE : RECUSA_AGUARDANDO_EQUIPE;
      }
      return original(args as never, ...(resto as never[]));
    };
  }
  return tools;
}

/** Rajada de PDFs do mesmo comprovante (Bebedouro mandou 5 em 1 minuto) = uma tarefa; outro comprovante, mais tarde, outra. */
const JANELA_COMPROVANTE_MS = 15 * 60_000;

type Dedupe = { avisoRecente: typeof avisoRecente; marcarAviso: typeof marcarAviso };

/**
 * Tarefa para a equipe, aberta pelo código (não pela IA): vence em 1 hora, no responsável do cartão. Uma por
 * cartão e motivo a cada 24 h; só marca o aviso depois que o Kommo aceitou, para uma falha não calar a próxima.
 */
export async function abrirTarefaParaEquipe(args: {
  slug: string;
  unitId: string;
  leadId: number;
  kommo: Pick<KommoClient, 'createTask' | 'getLead'>;
  recorder: Pick<TraceRecorder, 'step'>;
  motivo: 'comprovante' | 'desmarcada';
  dedupe?: Dedupe;
  agora?: () => number;
  /** Avisa o João quando a tarefa não saiu: o paciente já ouviu "a equipe confirma em 1 hora". */
  alertar?: (texto: string) => Promise<unknown>;
}): Promise<'criada' | 'repetida' | 'falhou'> {
  const { slug, unitId, leadId, kommo, recorder, motivo } = args;
  const dedupe = args.dedupe ?? { avisoRecente, marcarAviso };
  const chave = motivo === 'comprovante' ? 'comprovante_so_equipe' : 'consulta_desmarcada_afirmada';
  try {
    if (await dedupe.avisoRecente(unitId, leadId, chave, motivo === 'comprovante' ? JANELA_COMPROVANTE_MS : undefined)) return 'repetida';
    let nome: string | null = null;
    let responsavel: number | undefined;
    try {
      const lead = await kommo.getLead(leadId);
      nome = lead?.name?.trim() || null;
      responsavel = lead?.responsible_user_id || undefined;
    } catch (err) {
      logger.warn({ err: String(err), leadId }, 'tarefa da equipe: sem o cartão (nome/responsável)');
    }
    const quem = nome ? ` · ${nome}` : '';
    const text =
      motivo === 'comprovante'
        ? `CONFERIR COMPROVANTE · ${slug}${quem} · o paciente mandou o comprovante: conferir se o pagamento caiu e, se a consulta ainda não estiver na franquia, confirmá-la em até 1 h. A IA não confirmou o pagamento.`
        : `CONFERIR CONSULTA · ${slug}${quem} · a consulta está DESMARCADA no CRM e o paciente respondeu como se estivesse marcada. A IA não confirmou: falar com ele e remarcar em até 1 h.`;
    const agora = args.agora ?? Date.now;
    const res = await kommo.createTask({ leadId, text, completeAt: Math.floor(agora() / 1000) + 3600, responsibleUserId: responsavel });
    await dedupe.marcarAviso(unitId, leadId, chave);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `🧾 Tarefa para a equipe (${motivo}) no lead ${leadId} (tarefa ${res?.id ?? '?'})`,
      payload: { leadId, taskId: res?.id ?? null, responsibleUserId: responsavel ?? null, text },
    });
    return 'criada';
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'ERROR',
      title: `Falha ao abrir a tarefa da equipe (${motivo}): ${erro}`,
      payload: { leadId, motivo },
    });
    // O paciente já ouviu "a equipe confirma em até 1 hora": sem tarefa, ninguém sabe. Aviso no Telegram do João.
    await (args.alertar ?? enviarTelegram)(
      `⚠️ ${slug} — a IA disse ao paciente (lead ${leadId}) que a equipe confirma em até 1 hora, mas a tarefa NÃO saiu (${motivo}): ${erro}. Avisar a equipe à mão.`,
    ).catch(() => undefined);
    return 'falhou';
  }
}
