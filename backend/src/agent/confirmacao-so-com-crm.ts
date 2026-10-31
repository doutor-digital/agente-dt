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
export const INSTRUCAO_DESMARCADA = montarInstrucaoDesmarcada(true);

/** Unidade sem pagamento antecipado (Timbó): a instrução não manda o paciente "escolher forma de pagamento". */
export function instrucaoDesmarcada(semAntecipado: boolean): string {
  return montarInstrucaoDesmarcada(!semAntecipado);
}

function montarInstrucaoDesmarcada(comFormaDePagamento: boolean): string {
  return (
    '[instrução interna, não é fala do paciente] Sua resposta acima trata como marcada uma consulta que foi DESMARCADA ' +
    'no sistema da clínica: ela não existe mais. Se o paciente pediu, NESTA mensagem, um horário novo e já escolheu ' +
    (comFormaDePagamento ? 'dia, hora e forma de pagamento' : 'dia e hora') +
    ', use consultar_horarios e agendar_consulta. Se ele só confirmou o horário antigo ' +
    'ou perguntou se está tudo certo, NÃO marque nada: diga que vai conferir com a equipe, que confirma em até 1 hora, ' +
    'sem dizer confirmado, agendado nem reservado. Responda só com a mensagem final ou com a chamada da ferramenta.'
  );
}

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
    String.raw`\bdeixei\s+(?:\S+\s+){0,2}?(?:agendad|marcad|reservad|garantid|confirmad)[oa]s?\b`,
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
  /\b(?:so (?:e|sera|fica|ficam|sao)|somente|depois d[oae]s? (?:pagamento|comprovante|confirmacao))\b|(?<!\b(?:recebid|agendad|marcad|reservad|aprovad|conferid|confirmad|validad)[oa]s? )\b(?:e|sao|sera|serao) (?:confirmad|reservad|agendad|marcad|conferid)[oa]s? pel[ao]s? (?:equipe|clinica|recepcao)\b/;
/** "Combinado, terça às 10h então": só vale com dia/hora no trecho. */
const AFIRMA_COMBINADO = /\bcombinad[oa]s?\b/;
/** "Te espero terça", "nos vemos": só vale com dia/hora no trecho quando a regra é estrita ou só-forte. */
const AFIRMA_TE_ESPERO = /\b(?:te|lhe) (?:espero|esperamos|aguardo|aguardamos)\b|\bnos vemos\b/;
/** Negação/condição na ORAÇÃO da afirmação: "ainda não está confirmada", "se estiver confirmada", "para ser confirmada". */
const NAO_AFIRMA =
  /\b(?:nao|nem|nenhum|nenhuma|caso|quando|apos|depois que|assim que|aguarde|aguardando|para ser|pra ser|ate eu|sendo|vai ser|ira ser)\b|\bse (?:voce|vc|ele|ela|estiver|for|der)\b/;
/**
 * Modo estrito (consulta desmarcada): ali a IA ainda pode explicar preço e oferecer novo horário ("esse valor
 * já garante seu horário reservado"), então fica de fora a explicação de pagamento, e "te espero" só vale com
 * dia/hora.
 */
const EXPLICA_PAGAMENTO = /\b(?:pagando|pagamento antecipado|antecipado|antecipando|valor|pix|r\$)\b/;
/** Dia concreto (não só hora): "terça", "29/10", "amanhã", "hoje". "A partir das 8h" é horário de funcionamento. */
const QUANDO_DIA = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|\b\d{1,2}\/\d{1,2}\b|\b(?:amanha|hoje)\b/;
const QUANDO = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|\b\d{1,2}\/\d{1,2}\b|\b(?:amanha|hoje)\b|\b\d{1,2}(?::\d{2}|h\d{0,2})\b/;

/** Para quem estende o detector sem mexer nele (`taxa-de-reserva.ts`). */
export const NAO_AFIRMA_CONFIRMACAO = NAO_AFIRMA;
export const QUANDO_HORARIO = QUANDO;

/** A oração em que a afirmação aparece: do último separador (vírgula, ponto e vírgula, dois-pontos) até o fim dela. */
function oracaoDe(n: string, fim: number): string {
  const antes = n.slice(0, fim);
  return n.slice(Math.max(antes.lastIndexOf(','), antes.lastIndexOf(';'), antes.lastIndexOf(':')) + 1, fim);
}

export function afirmaConfirmacao(texto: string | null | undefined, opcoes: { estrito?: boolean; soForte?: boolean } = {}): Promessa | null {
  for (const t of trechos(String(texto ?? ''))) {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n) || EXPLICATIVA.test(n)) continue;
    if (opcoes.estrito && EXPLICA_PAGAMENTO.test(n)) continue;
    const quando = QUANDO.test(n);
    // No modo estrito (consulta desmarcada) as frases soltas só valem com dia/hora: "Tudo certo, Maria! Quer que eu
    // veja um novo horário?" não é consulta de pé.
    // `soForte`: na espera da equipe (depois do turno do comprovante) a conversa segue comum — "Fica na Rua X, 120. Te espero
    // lá!" e "Tudo certo 😊" não são consulta confirmada; só valem as frases que dizem O QUE está confirmado.
    // Frase solta COM dia/hora ("Tudo certo pra terça às 10h! Te espero lá", "Combinado, terça às 10h então") vale sempre:
    // ali a IA está tratando um horário como combinado.
    const solta = (!opcoes.soForte && !opcoes.estrito) || (opcoes.soForte ? QUANDO_DIA.test(n) : quando);
    const m =
      AFIRMA_FORTE.exec(n) ??
      (solta ? AFIRMA_FRACA.exec(n) : null) ??
      (solta ? AFIRMA_TE_ESPERO.exec(n) : null) ??
      // "Combinado, vou ver os horários de amanhã" / "Combinado! Quer que eu veja...": é a IA agindo ou oferecendo, não um horário combinado
      (quando && !/\b(?:vou|vamos|posso|quer|deixa eu)\b/.test(n.split(';').find((c) => /\bcombinad/.test(c)) ?? n) ? AFIRMA_COMBINADO.exec(n) : null);
    // "O pagamento antecipado confirmado garante sua vaga" é explicação; "Sua consulta está confirmada e o Pix garante
    // sua vaga" NÃO é: o `garante` só livra quando o que está "confirmado" é o próprio pagamento/Pix.
    if (m && /^(?:pagamento|pix)\b/.test(m[0]) && /\bgarant(?:e|em)\b/.test(n)) continue;
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
  /** há comprovante deste turno ou recebido nas últimas 24 h: a equipe ainda não confirmou */
  pendente: boolean;
  /** o valor lido em cada comprovante da espera (`null` = ilegível ou ausente) */
  valores?: ReadonlyArray<number | null>;
}

/** A espera da equipe tem prazo: depois de 24 h o comprovante deixa de contar (o histórico inteiro fica no banco). */
const PRAZO_DA_ESPERA_MS = 24 * 3_600_000;

/**
 * O webhook carimba a leitura do comprovante com a hora em que a mensagem chegou — as mensagens do histórico não
 * trazem data, e comprovante de meses atrás não pode liberar marcação nem travar a IA. Fica no FIM da descrição.
 */
export function marcarRecebimento(descricao: string, agora: Date = new Date()): string {
  return `${descricao} [recebido-em:${agora.toISOString()}]`;
}

export interface ComprovanteLido {
  /** valor em reais lido no comprovante, ou null (ilegível/ausente) */
  valor: number | null;
  /** epoch ms do carimbo do webhook, ou null (sem carimbo = mensagem antiga) */
  recebidoEm: number | null;
}

/** "200,00", "1.000", "1.000,50", "100.00", "100" → número; qualquer outra coisa → null. */
export function valorEmReais(s: string): number | null {
  const t = s.trim().replace(/[.,]+$/, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^\d+,\d{1,2}$/.test(t)) return Number(t.replace(',', '.'));
  if (/^\d+(\.\d{1,2})?$/.test(t)) return Number(t);
  return null;
}

function valorDoComprovante(segmento: string): number | null {
  const m = /valor[^$\d]{0,40}R\$\s*([\d.,]+)/i.exec(segmento);
  if (m) return valorEmReais(m[1]);
  // sem a palavra "valor": o primeiro R$ que não é saldo, limite ou tarifa ("Saldo R$ 100,00. Transferência de R$ 50,00" = 50)
  for (const x of segmento.matchAll(/R\$\s*([\d.,]+)/gi)) {
    if (!/(?:saldo|limite|tarifa)[^$]{0,20}$/i.test(segmento.slice(Math.max(0, (x.index ?? 0) - 25), x.index))) return valorEmReais(x[1]);
  }
  return null;
}

/** Cada "[imagem|arquivo do cliente]: COMPROVANTE…" da fala, com o valor lido e o carimbo. */
export function comprovantesDoTexto(texto: string): ComprovanteLido[] {
  return String(texto ?? '')
    .split(/(?=\[(?:imagem|arquivo) do cliente\]:)/)
    .filter((seg) => ehTranscricaoDeComprovante(seg))
    .map((seg) => {
      const carimbo = /\[recebido-em:([^\]]+)\]/.exec(seg);
      const t = carimbo ? Date.parse(carimbo[1]) : NaN;
      return { valor: valorDoComprovante(seg), recebidoEm: Number.isNaN(t) ? null : t };
    });
}

/**
 * `falasDoPaciente` na ordem da conversa; a última é a deste turno. A espera vem do FATO — comprovante lido, carimbado
 * nas últimas 24 h — e não do texto que a IA respondeu. `consultaNoCrm`: o prompt traz a consulta de verdade (a equipe
 * criou) — a espera acabou e só o comprovante DESTE turno conta.
 */
export function turnoDoComprovante(
  falasDoPaciente: ReadonlyArray<string>,
  consultaNoCrm = false,
  agora: number = Date.now(),
): TurnoDoComprovante {
  const doTurno = comprovantesDoTexto(falasDoPaciente[falasDoPaciente.length - 1] ?? '');
  const noTurno = doTurno.length > 0;
  const anteriores = falasDoPaciente
    .slice(0, -1)
    .flatMap(comprovantesDoTexto)
    .filter((c) => c.recebidoEm !== null && agora - c.recebidoEm >= 0 && agora - c.recebidoEm <= PRAZO_DA_ESPERA_MS); // data no futuro (relógio/forjada) não vale
  const naEspera = [...(consultaNoCrm ? [] : anteriores), ...doTurno];
  return { noTurno, pendente: naEspera.length > 0, valores: naEspera.map((c) => c.valor) };
}

/**
 * "pagamento confirmado", "seu Pix foi aprovado", "recebido e confirmado", "o Pix já caiu": quem confere o dinheiro é a
 * equipe, não a IA. Só vale com o estado dito ("foi/está/já") ou o particípio colado ao assunto — "o pagamento é
 * confirmado pela equipe" (presente) e "pagamento antecipado conferido pela equipe" são explicação; já "foi conferido
 * pela equipe" é afirmação.
 */
const PART_PAGAMENTO = '(?:confirmad|aprovad|conferid|validad|compensad|identificad)[oa]s?';
const AFIRMA_PAGAMENTO = new RegExp(
  [
    `\\b(?:pagamento|pix|comprovante)\\s+(?:(?:ja|foi|esta|ficou)\\s+)+(?:\\S+\\s+){0,3}?${PART_PAGAMENTO}\\b`,
    `\\b(?:pagamento|pix|comprovante)\\s+(?:ja\\s+)?(?:recebid[oa]s?\\s+e\\s+)?${PART_PAGAMENTO}\\b`,
    String.raw`\b(?:pix|pagamento|dinheiro|valor)\s+(?:ja\s+)?caiu\b`,
  ].join('|'),
);

export function afirmaPagamentoConferido(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n) || EXPLICATIVA.test(n)) return false;
    // "Com o Pix confirmado garante sua vaga": o confirmado é a condição do que vem depois — explicação
    if (/\b(?:confirmad|aprovad|conferid|validad)[oa]s?,?\s+garant(?:e|em)\b/.test(n)) return false;
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
  // Depois do turno do comprovante (espera da equipe) só as afirmações FORTES: a conversa segue comum.
  return afirmaConfirmacao(texto, { soForte: !turno.noTurno }) ? RECADO_COMPROVANTE : null;
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

/** Unidade com taxa de reserva (Boa Vista) e nenhum comprovante da taxa lido na conversa (últimas 24 h). */
export const RECUSA_SEM_COMPROVANTE_DA_TAXA =
  'RECUSADO: nesta unidade a vaga só é reservada DEPOIS da taxa de reserva, e ainda não há comprovante dela lido ' +
  'nesta conversa. A consulta NÃO foi marcada. NÃO diga que está agendada e NÃO chame agendar_consulta de novo neste ' +
  'turno. Diga ao paciente que o horário fica separado por enquanto e explique como garantir: PIX do valor antecipado ' +
  'desta unidade (mande a chave e peça o COMPROVANTE aqui na conversa) ou pagamento na clínica antes do dia. Quando o ' +
  'comprovante chegar (foto ou PDF) com o valor da taxa, aí sim chame agendar_consulta — e nunca diga "pagamento ' +
  'confirmado": quem confere o dinheiro é a equipe. Se ele preferir pagar na clínica, chame resumir_lead_para_sdr para ' +
  'a equipe acompanhar.';

const brl = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;

/** Quanto foi lido nos comprovantes da espera e quanto era esperado — vai na tarefa e no passo do rastro. */
export function detalheDoValor(turno: TurnoDoComprovante, taxaEsperada: number | null): string {
  const lidos = (turno.valores ?? []).map((v) => (v === null ? 'ilegível/ausente' : brl(v))).join(', ') || 'nenhum';
  return `valor lido: ${lidos}; esperado (taxa de reserva): ${taxaEsperada === null ? 'não cadastrado na unidade' : brl(taxaEsperada)}`;
}

/** O valor lido bate com a taxa? Exato; só a formatação dos centavos (100 = 100,00) é tolerada. */
export function taxaConfere(turno: TurnoDoComprovante, taxaEsperada: number | null): boolean {
  if (taxaEsperada === null || !(taxaEsperada > 0)) return false;
  return (turno.valores ?? []).some((v) => v !== null && Math.round(v * 100) === Math.round(taxaEsperada * 100));
}

export interface OpcoesDaTrava {
  /** a unidade exige a taxa de reserva antes de marcar (flag `spineBookingRequiresPayment`) */
  exigePagamento?: boolean;
  /** o valor da taxa, lido de onde a unidade guarda o antecipado (`precosDaConsulta`); null = não cadastrado */
  taxaEsperada?: number | null;
}

export type DecisaoDaTrava = { libera: true } | { libera: false; titulo: string; texto: string };

/**
 * A decisão da trava, pura (o grafo executa; o eval usa a mesma para não prometer o que o grafo recusa).
 *
 * - Regra geral: comprovante esperando a equipe = a IA NÃO marca (só a equipe confirma por comprovante).
 * - Unidade com taxa de reserva (decisão do João, 26/10): a IA marca DEPOIS de ler um comprovante cujo valor bate EXATAMENTE
 *   com a taxa. Sem comprovante, valor diferente/ilegível ou taxa não cadastrada → recusa e vai para a equipe.
 */
export function decidirTrava(turno: TurnoDoComprovante, opcoes: OpcoesDaTrava = {}): DecisaoDaTrava {
  const esperada = opcoes.taxaEsperada ?? null;
  if (opcoes.exigePagamento) {
    if (!turno.pendente) {
      return {
        libera: false,
        titulo: 'agendar_consulta recusado — reserva sem pagamento: nenhum comprovante da taxa lido na conversa',
        texto: RECUSA_SEM_COMPROVANTE_DA_TAXA,
      };
    }
    if (!taxaConfere(turno, esperada)) {
      return {
        libera: false,
        titulo: `agendar_consulta recusado — reserva sem pagamento: o comprovante não bate com a taxa (${detalheDoValor(turno, esperada)})`,
        texto:
          `RECUSADO: o comprovante lido NÃO confirma a taxa de reserva (${detalheDoValor(turno, esperada)}). A consulta NÃO foi marcada. ` +
          'NÃO chame agendar_consulta de novo e NÃO diga que está confirmada, agendada, reservada, garantida nem que o pagamento ' +
          `foi confirmado. Responda ao paciente só isto, com as suas palavras: "${RECADO_COMPROVANTE}"`,
      };
    }
    return { libera: true };
  }
  if (turno.pendente) {
    return {
      libera: false,
      titulo: '🧾 agendar_consulta recusado — comprovante: só a equipe confirma',
      texto: turno.noTurno ? RECUSA_DO_COMPROVANTE : RECUSA_AGUARDANDO_EQUIPE,
    };
  }
  return { libera: true };
}

/**
 * Quem pode marcar (`agendar_consulta`, só ela; `remarcar_consulta` é de quem já tem consulta, tem a sua própria
 * instância e não passa por aqui). Fica no grafo e não no prompt: prompt não segura o modelo (Olímpia 19/10, Canaã 24/10).
 * A regra está em `decidirTrava`.
 */
export function travarAgendamentoPorComprovante(
  tools: DynamicStructuredTool[],
  turno: TurnoDoComprovante,
  recorder: Pick<TraceRecorder, 'step'>,
  opcoes: OpcoesDaTrava = {},
): DynamicStructuredTool[] {
  for (const tool of tools) {
    if (tool.name !== 'agendar_consulta') continue;
    const original = tool.func.bind(tool);
    tool.func = async (args: unknown, ...resto: unknown[]) => {
      const d = decidirTrava(turno, opcoes);
      if (d.libera) return original(args as never, ...(resto as never[]));
      await recorder.step({ kind: 'ERROR', title: d.titulo, payload: { noTurno: turno.noTurno, valores: turno.valores ?? [], args } });
      return d.texto;
    };
  }
  return tools;
}

/**
 * A resposta final CITA a equipe, a recepção ou a clínica? Na consulta desmarcada isso basta para abrir a tarefa: adivinhar
 * "promessa" pelo texto (negação, modal, oração) falhou em frases comuns ("Pode deixar que a equipe vai te confirmar", "A
 * equipe, em até 1 hora, vai te confirmar"). Tarefa a mais custa 1 minuto; a menos deixa o paciente esperando uma ligação.
 */
export function citaEquipe(texto: string | null | undefined): boolean {
  return /\b(?:equipe|recepcao|clinica|time)\b/.test(normalizar(String(texto ?? '')));
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
  motivo: 'comprovante' | 'desmarcada' | 'insistiu_na_clinica' | 'cadastro_duplicado' | 'agenda_sem_conferir';
  dedupe?: Dedupe;
  agora?: () => number;
  /** Avisa o João quando a tarefa não saiu: o paciente já ouviu "a equipe confirma em 1 hora". */
  alertar?: (texto: string) => Promise<unknown>;
  /** Texto extra da tarefa (ex.: valor lido × esperado). */
  detalhe?: string;
  /**
   * Entra na chave de deduplicação (`<chave>:<chaveExtra>`): a tarefa passa a ser "uma por cartão, motivo E isto". Quem promete
   * ao paciente uma resposta sobre UM horário usa o horário aqui — a tarefa de outro horário não cobre a promessa.
   */
  chaveExtra?: string;
}): Promise<'criada' | 'repetida' | 'falhou'> {
  const { slug, unitId, leadId, kommo, recorder, motivo } = args;
  const dedupe = args.dedupe ?? { avisoRecente, marcarAviso };
  const chaveBase = { comprovante: 'comprovante_so_equipe', desmarcada: 'consulta_desmarcada_afirmada', insistiu_na_clinica: 'taxa_insistiu_na_clinica', cadastro_duplicado: 'cadastro_possivel_duplicado', agenda_sem_conferir: 'agenda_horario_sem_conferir' }[motivo];
  const chave = args.chaveExtra ? `${chaveBase}:${args.chaveExtra}` : chaveBase;
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
    const texto = {
      comprovante: `CONFERIR COMPROVANTE · ${slug}${quem} · o paciente mandou o comprovante: conferir se o pagamento caiu e, se a consulta ainda não estiver na franquia, confirmá-la em até 1 h. A IA não confirmou o pagamento.`,
      desmarcada: `CONFERIR CONSULTA · ${slug}${quem} · a consulta está DESMARCADA no CRM e o paciente respondeu como se estivesse marcada. A IA não confirmou: falar com ele e remarcar em até 1 h.`,
      insistiu_na_clinica: `FALAR COM O PACIENTE · ${slug}${quem} · reserva com taxa: ele já recebeu a chave Pix e INSISTE em pagar só na clínica. Sem o comprovante da taxa o horário NÃO está garantido: falar com ele em até 1 h.`,
      cadastro_duplicado: `CONFERIR CADASTRO · ${slug}${quem} · há outro cadastro na franquia com o MESMO telefone e nome parecido (talvez a mesma pessoa em dobro, talvez parente) que já tem consulta marcada. A IA NÃO juntou os cadastros nem usou o do outro: confirmar quem é e, se for a mesma pessoa, manter uma só consulta.`,
      agenda_sem_conferir: `CONFERIR HORÁRIO · ${slug}${quem} · o paciente pediu um horário que aparece ocupado e a IA não conseguiu conferir se é a consulta DELE (cadastro em dobro ou a franquia não respondeu). A IA não marcou nem ofereceu outro horário e disse que a equipe confirma e responde por aqui: confirmar com ele (a tarefa vence em 1 h).`,
    }[motivo];
    const agora = args.agora ?? Date.now;
    const text = args.detalhe ? `${texto} ${args.detalhe}.` : texto;
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
    // Quem promete é o motivo. «horário»: a IA só promete se a tarefa saiu (senão foi instruída a NÃO prometer). «cadastro»: a
    // IA não promete nada por causa dela; só a equipe não saberá do cadastro em dobro. Os demais: o paciente já ouviu «em até 1 hora».
    const textoDaFalha: Partial<Record<typeof motivo, string>> = {
      agenda_sem_conferir: `a tarefa de conferir o HORÁRIO NÃO saiu (lead ${leadId}): ${erro}. A IA foi instruída a não prometer retorno da equipe nesse caso; ainda assim o paciente ficou sem resposta sobre o horário: avisar a equipe à mão.`,
      cadastro_duplicado: `a tarefa de conferir o CADASTRO em dobro NÃO saiu (lead ${leadId}): ${erro}. A IA não prometeu nada por causa dela, mas a equipe não sabe do outro cadastro: avisar à mão.`,
    };
    await (args.alertar ?? enviarTelegram)(
      `⚠️ ${slug} — ` +
        (textoDaFalha[motivo] ??
          `a IA disse ao paciente (lead ${leadId}) que a equipe confirma em até 1 hora, mas a tarefa NÃO saiu (${motivo}): ${erro}. Avisar a equipe à mão.`),
    ).catch(() => undefined);
    return 'falhou';
  }
}
