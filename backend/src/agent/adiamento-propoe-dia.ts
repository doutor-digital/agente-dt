/**
 * Chave `adiamento-propoe-dia` (ADIAMENTO_PROPOE_DIA_SLUGS), decisão do João de 27/11/2026.
 *
 * O problema (ops/relatorios/2026-11-27-por-que-sofia-nao-converte.md, M3): quem adia dizendo o motivo ou o quando ("só recebo dia 8", "vou falar
 * com meu esposo") ouvia "te procuro no dia X" e a conversa parava. Em 30 dias de produção, 187 conversas com frase assim e 133 nunca marcaram.
 * Com a chave ligada a Sofia propõe UM dia com DOIS horários reais (`consultar_horarios`) e só marca se o paciente escolher.
 *
 * Por que classificação por LLM e não regex: despedida ("obrigada… boa noite", "tchau", "bjs", "grato", "Deus abençoe"), escolha de horário
 * ("a das 14", "segunda de manhã") e adiamento não se separam por lista de palavras. Aqui um modelo leve lê a fala do paciente e a última fala da
 * IA e devolve um SCHEMA (saída estruturada do LangChain, `withStructuredOutput`). Na dúvida, ou em qualquer falha (sem chave, prazo, schema
 * inválido), o resultado é "nada": o comportamento do main, que é o corte de 21/10 (Araguaína, 13cfbaf9).
 *
 * O que fica em CÓDIGO, e só pode TIRAR a proposta (nunca criá-la): a chave por unidade; a unidade ter agenda; o paciente NÃO ter consulta de pé nem
 * tratamento (e, se a leitura falhar, vale "tem"); o pré-filtro (só há chamada quando a fala tem sinal de ADIAMENTO); o veto de despedida e o veto de
 * recusa; e "uma proposta só", que lê um MARCADOR gravado quando a proposta sai (não um regex sobre o texto).
 *
 * UMA classificação por turno: o grafo roda o prompt a cada volta de ferramenta; o resultado fica guardado por `traceId` e é reaproveitado.
 */
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { createChatOpenAI, recordLlmCall } from '../services/openai.service.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { Fala } from './repeticao.js';
import { promptTemConsulta } from './reserva-sem-marcar.js';

export const ID_ADIAMENTO = 'adiamento-propoe-dia';

/** O modelo leve que o repo já usa para tarefas auxiliares (resumo da memória do lead, `lead-memory.service.ts`). */
export const MODELO_DO_CLASSIFICADOR = 'gpt-4o-mini';
export const PRAZO_DO_CLASSIFICADOR_MS = 5_000;

/** O passo gravado no rastro do turno quando a proposta de dia e horários SAIU na resposta. É o marcador de "uma proposta só". */
export const TITULO_DA_PROPOSTA = '📅 Adiamento: a proposta de dia e horários saiu';

export const TIPOS_DE_FALA = ['despedida', 'recusa', 'adiou_com_motivo', 'adiou_sem_motivo', 'escolheu_horario', 'outro'] as const;
export type TipoDeFala = (typeof TIPOS_DE_FALA)[number];

/** O contrato com o modelo (saída estruturada). Mudar um nome aqui é mudar o contrato: o teste de contrato pega. */
export const SCHEMA_DA_FALA = z.object({
  tipo: z
    .enum(TIPOS_DE_FALA)
    .describe(
      'despedida = agradece, se despede ou fecha a conversa (obrigada, brigada, tchau, xau, bjo, fui, falou, boa noite, bom domingo, boa semana, até mais, grato, Deus abençoe), mesmo que diga um motivo; ' +
        'recusa = não quer, não quer mais, já resolveu, já fechou com outro médico ou clínica, desistiu; ' +
        'adiou_com_motivo = quer, mas adia dizendo o MOTIVO ou o QUANDO (falar com marido/família/chefe, só recebo dia X, plantão, viagem, mês que vem) e NÃO se despede; ' +
        'adiou_sem_motivo = só "vou pensar", "te aviso", "depois eu vejo", sem motivo nem data; ' +
        'escolheu_horario = escolheu ou aceitou um dos horários oferecidos (mesmo que cite um motivo junto); ' +
        'outro = qualquer outra coisa, ou na dúvida.',
    ),
  motivo: z.string().nullish().describe('O motivo do adiamento, nas palavras dele, curto. Só quando tipo = adiou_com_motivo.'),
  data_citada: z.string().nullish().describe('A data ou época que ele citou ("dia 8", "mês que vem"). Só quando houver.'),
});
export type ClassificacaoDaFala = z.infer<typeof SCHEMA_DA_FALA>;

/** O que o prompt recebe quando o paciente adiou com motivo e a chave está ligada. */
export interface AdiamentoDoTurno {
  motivo: string | null;
  dataCitada: string | null;
}

/** Onde a decisão do turno fica guardada: uma classificação por turno, reaproveitada em toda volta do agente. */
export interface AdiamentoGuardado {
  traceId?: string;
  pronto?: boolean;
  valor?: AdiamentoDoTurno | null;
}

const guardados = new Map<string, AdiamentoGuardado>();
const MAX_GUARDADOS = 500;

/** O guardado deste turno (um por `traceId`). Sem traceId, um novo a cada chamada (não reaproveita). */
export function guardadoDoTurno(traceId: string | null | undefined): AdiamentoGuardado {
  if (!traceId) return {};
  let g = guardados.get(traceId);
  if (!g) {
    g = { traceId };
    guardados.set(traceId, g);
    if (guardados.size > MAX_GUARDADOS) guardados.delete(guardados.keys().next().value as string);
  }
  return g;
}

// ── pré-filtro: só chama o modelo quando há sinal de ADIAMENTO (despedida não precisa de modelo: o veto em código resolve) ─────────

/** Sinal de ADIAMENTO: família/chefe, dinheiro, viagem/plantão, época, "vou ver/pensar/falar". Estreito: "bom dia", "obrigada", "ok" não chamam. */
const SINAL_DE_ADIAMENTO =
  /(?:falar|conversar|ver|combinar|decidir|consultar|perguntar)\b[^.!?\n]{0,25}\bcom\s+(?:(?:o|a)\s+)?(?:(?:meu|minha|meus|minhas)\s+)?(?:marido|espos[oa]|mulher|namorad[oa]|filh[oa]s?|m[ãa]e|pai|irm[ãa]o?|famil\w*|m[ée]dico|patr[ãa]o|chefe|gerente)|\brecebo\b|\bquando\s+(?:eu\s+)?(?:receber|pegar|cair)|\breceber\b|\bsal[áa]rio\b|\bsem\s+dinheiro\b|\bapertad|\besperar\s+o\s+pagamento|\bdia\s+do\s+pagamento|(?:m[êe]s|semana)\s+que\s+vem|pr[óo]xim[oa]\s+(?:m[êe]s|semana)|\bdepois\s+(?:do|da|de|que)\b|\ba\s+partir\s+d|\bs[óo]\s+(?:no\s+|em\s+)?(?:dia|m[êe]s|janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)|\bcarnaval|\bnatal\b|\bf[ée]rias|\bplant[ãa]o|\bviaj|\bvou\s+(?:ver|pensar|falar|conversar|organizar|olhar|consultar|decidir|esperar)|\bpreciso\s+(?:ver|falar|pensar|conversar|esperar)|\bdeixa\s+eu\b|\bte\s+(?:aviso|falo|chamo|procuro|retorno|dou\s+retorno)\b/i;

/**
 * Despedida CLARA (rede de segurança em código, só para NÃO propor): agradecimento, tchau/xau, bjo(s), grato, "fui", "falou", Deus abençoe,
 * "até mais", "boa semana", "bom domingo", "boa noite pra você", ou "boa noite/tarde/dia" FECHANDO a fala. É um veto, nunca um gatilho: se
 * acerta, a Sofia não propõe horário (o corte de 21/10, sem custo de chamada); se erra, só deixa de propor, e o comportamento é o do main.
 */
const DESPEDIDA_CLARA =
  /obrigad|\bbrigad|\bobg\b|valeu|\bvlw\b|\bflw\b|\btmj\b|agrade[çc]|gratid|\bgrat[oa]\b|\b[tx]chau|\bxau\b|(?<![\p{L}])int[ée](?![\p{L}])|abra[çc]|\bbeij|\bbjo|\bbjs?\b|\bdeus\b|aben[çc]|am[ée]m|fica\s+com|at[ée]\s+(?:mais|logo|breve|amanh[ãa]|j[áa]|a\s+pr[óo]xima|l[áa]|depois)|boa\s+(?:noite|tarde|semana|p[áa]scoa)\s+(?:pra|para|a)\s+(?:voc[êe]|vcs|voc[êe]s|todos)|\bboa\s+semana\b|\bbom\s+(?:domingo|fim\s+de\s+semana|final\s+de\s+semana|descanso)|\bten(?:ha|ham)\s+(?:um|uma)\s+(?:[óo]tim|bo[ma])|[óo]tim[oa]\s+(?:noite|tarde|dia|semana)/iu;
/** Despedida que só vale NO FIM da fala: "…, boa noite" / "…, até" / "…, fui" / "…, falou" / "…, bom dia" (aberta com "bom dia" é cumprimento). */
const DESPEDIDA_NO_FIM = /(?:boa\s+(?:noite|tarde)|bom\s+dia|at[ée]|fui|falou)$/i;

/** A fala tem despedida clara (em qualquer lugar, ou uma despedida curta FECHANDO a fala, ignorando emoji e pontuação finais)? */
export function temDespedidaClara(texto: string): boolean {
  if (DESPEDIDA_CLARA.test(texto)) return true;
  const fim = texto.replace(/[\s\p{Extended_Pictographic}\p{P}\p{S}]+$/u, '').trim();
  return DESPEDIDA_NO_FIM.test(fim);
}

/** Recusa CLARA (veto em código): não quer, desistiu, já resolveu ou já fechou com outro. Nunca recebe proposta de horário. */
const RECUSA_CLARA =
  /n[ãa]o\s+(?:quero|tenho\s+interesse|me\s+interess|vou\s+(?:fazer|querer|marcar|precisar)|pretendo|preciso\s+mais)|\bn[ãa]o\s+quero\s+mais|\bdesist|\bj[áa]\s+(?:resolvi|me\s+resolvi|consegui\s+resolver|fechei|marquei\s+(?:em|com|outr)|fiz\s+(?:o\s+)?tratamento)|fechei\s+com|(?:outr[oa]|outro)\s+(?:cl[ií]nica|m[ée]dico|lugar|profissional|fisio\w*)|pare\s+de\s+me|me\s+tir[ae]\s+d[ao]/i;

/**
 * Escolha de horário CLARA (veto em código): hora dita ("8h", "14:30", "13 horas", "às 8", "das 14") ou dia + período/aceite ("pode ser terça",
 * "segunda de manhã", "quero quarta"). Quem já escolheu vai para a marcação, não para uma proposta nova. Só TIRA a proposta.
 */
const ESCOLHA_CLARA =
  /\b\d{1,2}\s*(?:h\b|h\d{2}|:\d{2}|horas?\b)|(?<![\p{L}])[àa]s\s+\d{1,2}\b|\bdas\s+\d{1,2}\b|\b(?:pode\s+(?:ser|marcar)|quero|prefiro|fico\s+com|vou\s+(?:na|no|de))\b[^.!?\n]{0,25}(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|manh[ãa]|tarde)|(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)\s+(?:de\s+manh[ãa]|[àa]\s+tarde|t[áa]\s+[óo]timo|serve|[óo]timo)|\b(?:a|o)\s+de\s+(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)\b/iu;

/** A fala já escolhe um horário? */
export function temEscolhaDeHorario(texto: string): boolean {
  return ESCOLHA_CLARA.test(texto);
}

/** A fala tem recusa clara? */
export function temRecusaClara(texto: string): boolean {
  return RECUSA_CLARA.test(texto);
}

/** A fala vale a chamada do modelo? Sem sinal de adiamento (ex.: "quero marcar segunda", "bom dia", "obrigada", "qual o endereço?"), não se paga a chamada. */
export function valeClassificar(falaDoPaciente: string): boolean {
  const t = falaDoPaciente.trim();
  if (!t || t.length > 400) return false;
  return SINAL_DE_ADIAMENTO.test(t);
}

// ── o turno do paciente e a última fala da IA ─────────────────────────────────────────────────────────────────────────────────────

/** As falas SEGUIDAS do paciente no fim da conversa (o turno em curso) e as falas da IA logo antes delas. */
export function turnoEUltimaProposta(falas: Fala[]): { paciente: string; ia: string[]; inicioDoTurno: number } {
  let fim = falas.length - 1;
  while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
  let i = fim;
  while (i >= 0 && falas[i].papel === 'paciente') i--;
  const paciente = falas.slice(i + 1, fim + 1).map((f) => f.texto).join('\n').trim();
  let j = i;
  while (j >= 0 && falas[j].papel === 'ia') j--;
  const ia = falas.slice(j + 1, i + 1).map((f) => f.texto);
  return { paciente, ia, inicioDoTurno: i + 1 };
}

// ── o modelo ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const INSTRUCAO_DO_CLASSIFICADOR =
  'Você classifica a ÚLTIMA fala de um paciente numa conversa de WhatsApp com uma clínica de fisioterapia. Você recebe a fala do paciente e a ' +
  'última mensagem da clínica (que pode ter oferecido horários). Responda só com o schema. Regras: ' +
  '(1) se há despedida ou agradecimento de encerramento (obrigada, brigada, tchau, xau, bjo, fui, falou, boa noite no fim, bom domingo, boa semana, até mais, grato, Deus abençoe), é "despedida", ' +
  'mesmo que ele cite um motivo; (2) se ele escolheu ou aceitou um horário (a das 14, segunda de manhã, pode ser terça), é "escolheu_horario", ' +
  'mesmo que cite motivo ou forma de pagamento; (3) "adiou_com_motivo" só quando ele adia dizendo o motivo ou o quando E não se despede; ' +
  '(4) "recusa" quando não quer, não quer mais, já resolveu, já fechou com outro médico ou clínica, ou desistiu; (5) NA DÚVIDA, "outro". Nunca invente motivo ou data.';

/** O mínimo que o classificador usa do modelo do LangChain (e o que o teste de contrato falsifica). */
export interface ModeloComSaidaEstruturada {
  withStructuredOutput(schema: unknown, opcoes?: Record<string, unknown>): { invoke(entrada: unknown, opcoes?: Record<string, unknown>): Promise<unknown> };
}

export interface EntradaDaClassificacao {
  falaDoPaciente: string;
  ultimaFalaDaIa: string[];
}

/** O uso do modelo, para a conta (`llm_calls`): o classificador passa FORA do `invokeChatModel`, então registra por aqui. */
export interface UsoDaClassificacao {
  promptTokens: number;
  completionTokens: number;
  latenciaMs: number;
  status: 'success' | 'error' | 'cancelled';
  erro?: string;
}

function textoParaOModelo(e: EntradaDaClassificacao): string {
  const ia = e.ultimaFalaDaIa.length ? e.ultimaFalaDaIa.join('\n') : '(nenhuma)';
  return `ÚLTIMA MENSAGEM DA CLÍNICA:\n${ia}\n\nFALA DO PACIENTE:\n${e.falaDoPaciente}`;
}

/** Com `includeRaw` o LangChain devolve `{ raw, parsed }`; sem ele, o objeto. Aceita os dois e VALIDA contra o schema. */
function lerSaida(bruto: unknown): { classificacao: ClassificacaoDaFala | null; usage: { input_tokens?: number; output_tokens?: number } | null } {
  const comRaw = bruto && typeof bruto === 'object' && 'parsed' in (bruto as object) ? (bruto as { parsed?: unknown; raw?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }) : null;
  const lido = SCHEMA_DA_FALA.safeParse(comRaw ? comRaw.parsed : bruto);
  return { classificacao: lido.success ? lido.data : null, usage: comRaw?.raw?.usage_metadata ?? null };
}

/** Chama o modelo com o schema e VALIDA a saída contra ele (zod). Qualquer coisa fora do schema = null. O uso é reportado em `aoTerminar`. */
export async function classificarComModelo(
  modelo: ModeloComSaidaEstruturada,
  entrada: EntradaDaClassificacao,
  prazoMs = PRAZO_DO_CLASSIFICADOR_MS,
  aoTerminar?: (uso: UsoDaClassificacao) => void,
): Promise<ClassificacaoDaFala | null> {
  const estruturado = modelo.withStructuredOutput(SCHEMA_DA_FALA, { name: 'classificar_fala', method: 'functionCalling', includeRaw: true });
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const estouro = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ac.abort();
      rej(new Error(`classificador: sem resposta em ${prazoMs} ms`));
    }, prazoMs);
  });
  const t0 = Date.now();
  try {
    const bruto = await Promise.race([
      estruturado.invoke(
        [
          { role: 'system', content: INSTRUCAO_DO_CLASSIFICADOR },
          { role: 'user', content: textoParaOModelo(entrada) },
        ],
        { signal: ac.signal },
      ),
      estouro,
    ]);
    const { classificacao, usage } = lerSaida(bruto);
    aoTerminar?.({ promptTokens: usage?.input_tokens ?? 0, completionTokens: usage?.output_tokens ?? 0, latenciaMs: Date.now() - t0, status: 'success' });
    return classificacao;
  } catch (err) {
    aoTerminar?.({ promptTokens: 0, completionTokens: 0, latenciaMs: Date.now() - t0, status: ac.signal.aborted ? 'cancelled' : 'error', erro: String(err).slice(0, 200) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface DependenciasDoAdiamento {
  /** Devolve a classificação, ou null (falha, prazo, schema inválido). Nunca lança. */
  classificar(entrada: EntradaDaClassificacao, unit: Unit, traceId: string | null): Promise<ClassificacaoDaFala | null>;
  /** A proposta de dia e horários JÁ saiu antes nesta conversa (marcador gravado no rastro)? Falha de leitura = true (não propõe). */
  propostaJaFeita(unitId: string, leadId: number): Promise<boolean>;
}

export const dependenciasPadrao: DependenciasDoAdiamento = {
  async classificar(entrada, unit, traceId) {
    try {
      const modelo = createChatOpenAI(unit, { model: MODELO_DO_CLASSIFICADOR, temperature: 0, maxTokens: 150 });
      return await classificarComModelo(modelo as unknown as ModeloComSaidaEstruturada, entrada, PRAZO_DO_CLASSIFICADOR_MS, (uso) => {
        // a conta de uso (tela de custo e teto mensal leem `llm_calls`): sem isto a chamada seria invisível
        void recordLlmCall({
          unitId: unit.id,
          traceId,
          provider: 'openai',
          model: MODELO_DO_CLASSIFICADOR,
          promptTokens: uso.promptTokens,
          completionTokens: uso.completionTokens,
          latencyMs: uso.latenciaMs,
          status: uso.status,
          errorMessage: uso.erro,
        });
      });
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200), unit: unit.slug }, 'adiamento-propoe-dia: o classificador falhou — vale o comportamento de sempre');
      return null;
    }
  },
  async propostaJaFeita(unitId, leadId) {
    try {
      const achou = await prisma.executionStep.findFirst({
        where: { title: TITULO_DA_PROPOSTA, trace: { unitId, leadId: String(leadId) } },
        select: { id: true },
      });
      return !!achou;
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200), unitId, leadId }, 'adiamento-propoe-dia: não li o marcador da proposta — não propõe');
      return true;
    }
  },
};

// ── a decisão do turno ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PedidoDeAdiamento {
  unit: Pick<Unit, 'id' | 'slug' | 'spineEnabled' | 'spineToken'> & Partial<Unit>;
  leadId: number | undefined;
  falas: Fala[] | undefined;
  /** O rastro do turno (para a conta de uso). */
  traceId?: string | null;
  /**
   * Já tem consulta de pé, é paciente em tratamento, OU a leitura disso falhou: nunca se propõe horário novo. Pode chegar depois (promessa): o
   * modelo já corre em paralelo com o resto do prompt.
   */
  temConsultaOuTratamento: boolean | Promise<boolean>;
}

const limpo = (t: string | null | undefined): string | null => {
  const s = String(t ?? '').replace(/[\r\n<>"“”`;{}[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || null;
};

/**
 * O paciente adiou COM motivo e vale propor um dia? null = nada muda (comportamento do main).
 * Só chega ao modelo com: chave ligada, unidade COM agenda, lead conhecido, sem consulta/tratamento, sinal de adiamento na fala, sem despedida
 * nem recusa clara e nenhuma proposta anterior. Só "adiou_com_motivo" propõe; qualquer outro tipo, falha ou dúvida = null.
 */
export async function decidirAdiamento(pedido: PedidoDeAdiamento, deps: DependenciasDoAdiamento = dependenciasPadrao): Promise<AdiamentoDoTurno | null> {
  const { unit, falas, leadId } = pedido;
  if (!falas?.length || !leadId) return null;
  if (!automacaoLigada(unit.slug, ID_ADIAMENTO, process.env.ADIAMENTO_PROPOE_DIA_SLUGS)) return null;
  // sem agenda (consultar_horarios não existe) a Sofia inventaria horário: nada de proposta
  if (!unit.spineEnabled || !unit.spineToken) return null;
  if (pedido.temConsultaOuTratamento === true) return null;
  const { paciente, ia } = turnoEUltimaProposta(falas);
  if (!valeClassificar(paciente)) return null;
  // vetos em código: só TIRAM a proposta (o corte de 21/10), e poupam a chamada
  if (temDespedidaClara(paciente) || temRecusaClara(paciente) || temEscolhaDeHorario(paciente)) return null;
  if (await deps.propostaJaFeita(unit.id, leadId)) return null;
  const [c, temConsulta] = await Promise.all([deps.classificar({ falaDoPaciente: paciente, ultimaFalaDaIa: ia }, unit as Unit, pedido.traceId ?? null), Promise.resolve(pedido.temConsultaOuTratamento)]);
  if (temConsulta) return null;
  if (!c || c.tipo !== 'adiou_com_motivo') return null;
  return { motivo: limpo(c.motivo), dataCitada: limpo(c.data_citada) };
}

/** O bloco do turno: propor o dia e dois horários reais, sem empurrar nem calar. */
export function renderPacienteAdiou(a: AdiamentoDoTurno): string {
  // texto do paciente via modelo: limpo aqui também (nunca fecha o bloco nem injeta tag)
  const motivo = limpo(a.motivo);
  const quando = limpo(a.dataCitada);
  const dito = [motivo ? `motivo: "${motivo}"` : null, quando ? `quando: "${quando}"` : null].filter(Boolean).join('; ');
  return (
    '<paciente_adiou>\n(contado pelo sistema; vale mais que a regra da pergunta de continuidade e a de "sem horário")\n' +
    `Ele ADIOU dizendo o motivo ou o quando${dito ? ` (${dito})` : ''}. ` +
    'Isto NÃO é despedida nem recusa: não feche com "te procuro depois", "fico no aguardo" ou "quando quiser me chama".\n' +
    '- Chame consultar_horarios para o primeiro dia útil EM ou DEPOIS do impedimento que ele disse (se só deu o motivo, sem data, o dia útil que ' +
    'vem daqui a 2 ou 3 dias) e, numa mensagem só, proponha UM dia com os DOIS horários que a agenda devolveu, retomando o motivo dele: ' +
    '"Combinado! Já deixo pra {dia}, depois que você {receber / falar com ele / voltar}? Tenho {h1} ou {h2}." ' +
    'Os dois horários vêm SÓ de consultar_horarios; nunca invente vaga. Se a agenda não devolver horário nesse dia, não ofereça nenhum: ' +
    '"combinado, te procuro no dia DD/MM".\n' +
    '- Só chame agendar_consulta se ele ESCOLHER um dos horários (a confirmação do dia segue valendo). NUNCA diga que está reservado, guardado ou ' +
    'garantido antes de marcar.\n' +
    '- Se ele recusar marcar agora ou preferir avisar depois: aceite sem insistir ("Combinado, te procuro no dia DD/MM"). Uma proposta só: ' +
    'não repita o horário na mensagem seguinte. Nunca prometa HORA de retorno.\n' +
    '</paciente_adiou>'
  );
}

/**
 * Nunca se propõe horário novo a quem JÁ TEM consulta de pé, é paciente em tratamento, ou quando a leitura disso FALHOU (consulta, etapa ou franquia):
 * falha = "tem" (não propõe), nunca "não tem".
 */
export function bloqueiaProposta(a: { blocoDaConsulta: string; jaAgendadoOuPaciente?: boolean | null; leituraFalhou: boolean }): boolean {
  return a.leituraFalhou || !!a.jaAgendadoOuPaciente || promptTemConsulta(a.blocoDaConsulta);
}
