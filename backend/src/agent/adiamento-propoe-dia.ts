/**
 * Chave `adiamento-propoe-dia` (ADIAMENTO_PROPOE_DIA_SLUGS), decisão do João de 27/11/2026.
 *
 * O problema (ops/relatorios/2026-11-27-por-que-sofia-nao-converte.md, M3): quem adia dizendo o motivo ou o quando ("só recebo dia 8", "vou falar
 * com meu esposo") ouvia "te procuro no dia X" e a conversa parava. Em 30 dias de produção, 187 conversas com frase assim e 133 nunca marcaram.
 * Com a chave ligada a Sofia propõe UM dia com DOIS horários reais (`consultar_horarios`) e só marca se o paciente escolher.
 *
 * Por que classificação por LLM e não regex: duas revisões seguidas mostraram que despedida ("obrigada… boa noite", "tchau", "bjs", "grato",
 * "Deus abençoe"), escolha de horário ("a das 14", "segunda de manhã") e adiamento não se separam por lista de palavras. Aqui um modelo leve lê a
 * fala do paciente e a última fala da IA e devolve um SCHEMA (saída estruturada do LangChain, `withStructuredOutput`). Na dúvida, ou em qualquer
 * falha (sem chave, prazo, schema inválido), o resultado é "nada": o comportamento do main, que é o corte de 21/10 (Araguaína, 13cfbaf9) — quem
 * agradece, se despede ou recusa não recebe horário empurrado.
 *
 * O que fica em CÓDIGO (não confiado ao modelo): a chave por unidade, a unidade ter agenda, o paciente NÃO ter consulta de pé nem ser paciente em
 * tratamento, o pré-filtro barato (sem sinal de adiamento/despedida na fala, o modelo nem é chamado) e a regra "uma proposta só".
 */
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { createChatOpenAI } from '../services/openai.service.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { logger } from '../lib/logger.js';
import type { Fala } from './repeticao.js';

export const ID_ADIAMENTO = 'adiamento-propoe-dia';

/** O modelo leve que o repo já usa para tarefas auxiliares (resumo da memória do lead, `lead-memory.service.ts`). */
export const MODELO_DO_CLASSIFICADOR = 'gpt-4o-mini';
export const PRAZO_DO_CLASSIFICADOR_MS = 5_000;

export const TIPOS_DE_FALA = ['despedida', 'recusa', 'adiou_com_motivo', 'adiou_sem_motivo', 'escolheu_horario', 'outro'] as const;
export type TipoDeFala = (typeof TIPOS_DE_FALA)[number];

/** O contrato com o modelo (saída estruturada). Mudar um nome aqui é mudar o contrato: o teste de contrato pega. */
export const SCHEMA_DA_FALA = z.object({
  tipo: z
    .enum(TIPOS_DE_FALA)
    .describe(
      'despedida = agradece, se despede ou fecha a conversa (obrigada, tchau, boa noite, até mais, bjs, grato, Deus abençoe), mesmo que diga um motivo; ' +
        'recusa = não quer, já resolveu, desistiu; ' +
        'adiou_com_motivo = quer, mas adia dizendo o MOTIVO ou o QUANDO (falar com marido/família, só recebo dia X, viagem, mês que vem) e NÃO se despede; ' +
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

// ── pré-filtro: só chama o modelo quando há sinal de adiamento ou despedida ───────────────────────────────────────────────────────

/** Sinal de ADIAMENTO (motivo, data, família, dinheiro, viagem, "depois"). Largo de propósito: quem decide é o modelo. */
const SINAL_DE_ADIAMENTO =
  /receb|sal[áa]rio|pagamento|dinheiro|marido|espos[oa]|mulher|namorad|filh[oa]|\bm[ãa]e\b|\bpai\b|irm[ãa]o?|fam[íi]lia|patr[ãa]o|chefe|m[ée]dico|viaj|viagem|m[êe]s\s+que\s+vem|semana\s+que\s+vem|pr[óo]xim[oa]\s+(?:m[êe]s|semana)|\bdepois\b|mais\s+tarde|\bamanh[ãa]\b|\bvou\s+(?:ver|pensar|falar|conversar|organizar|olhar|consultar|decidir)|\bdeixa\s+eu\b|preciso\s+(?:ver|falar|pensar|conversar)|te\s+(?:aviso|falo|chamo|procuro|retorno|dou\s+retorno)|(?:eu\s+)?(?:aviso|retorno)\b|dia\s+\d|a\s+partir|apertad|sem\s+dinheiro|n[ãa]o\s+(?:posso|d[áa]|tenho)|agora\s+n[ãa]o|carnaval|natal|f[ée]rias/i;
/** Sinal de DESPEDIDA (o modelo é quem separa despedida de adiamento: "obrigada, vou falar com meu marido, boa noite"). */
const SINAL_DE_DESPEDIDA = /obrigad|brigad|\bobg\b|valeu|\bvlw\b|agrade[çc]|gratid|grat[oa]\b|tchau|at[ée]\s|abra[çc]|beij|\bbjs?\b|deus|aben[çc]|boa\s+(?:noite|tarde)|bom\s+(?:dia|descanso)|bom\s+fim|[óo]tim[oa]\s+(?:noite|tarde|dia|semana)|fica\s+com|amém|amem/i;

/** A fala vale a chamada do modelo? Sem sinal nenhum (ex.: "quero marcar segunda", "qual o endereço?"), não se paga a chamada. */
export function valeClassificar(falaDoPaciente: string): boolean {
  const t = falaDoPaciente.trim();
  if (!t || t.length > 400) return false;
  return SINAL_DE_ADIAMENTO.test(t) || SINAL_DE_DESPEDIDA.test(t);
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

/** Horário citado numa fala da IA: "7h", "13:30", "13 horas", "às 7", "7 da manhã", "meio-dia". */
const HORARIO_NA_FALA = /\b\d{1,2}\s*(?:h\b|h\d{2}|:\d{2}|horas?\b)|\b[àa]s\s+\d{1,2}\b|\b\d{1,2}\s+da\s+(?:manh[ãa]|tarde|noite)|meio[\s-]?dia/i;

/**
 * UMA proposta só, em CÓDIGO: antes deste turno, algum turno do paciente com sinal de adiamento foi seguido de fala(s) da IA com horário
 * (numa fala ou em várias bolhas)? Então a proposta já foi feita e o segundo adiamento volta ao comportamento do main (o corte de 21/10).
 */
export function propostaDeAdiamentoJaFeita(falas: Fala[]): boolean {
  const { inicioDoTurno } = turnoEUltimaProposta(falas);
  const passado = falas.slice(0, inicioDoTurno);
  for (let k = 0; k < passado.length; k++) {
    if (passado[k].papel !== 'paciente') continue;
    // o turno do paciente que termina em k e o bloco de falas da IA que vem logo depois
    let m = k;
    while (m + 1 < passado.length && passado[m + 1].papel === 'paciente') m++;
    const turno = passado.slice(k, m + 1).map((f) => f.texto).join('\n');
    let n = m + 1;
    const bolhas: string[] = [];
    while (n < passado.length && passado[n].papel === 'ia') bolhas.push(passado[n++].texto);
    if (bolhas.length > 0 && SINAL_DE_ADIAMENTO.test(turno) && HORARIO_NA_FALA.test(bolhas.join('\n'))) return true;
    k = m;
  }
  return false;
}

// ── o modelo ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const INSTRUCAO_DO_CLASSIFICADOR =
  'Você classifica a ÚLTIMA fala de um paciente numa conversa de WhatsApp com uma clínica de fisioterapia. Você recebe a fala do paciente e a ' +
  'última mensagem da clínica (que pode ter oferecido horários). Responda só com o schema. Regras: ' +
  '(1) se há despedida ou agradecimento de encerramento (obrigada, tchau, boa noite no fim, até mais, bjs, grato, Deus abençoe), é "despedida", ' +
  'mesmo que ele cite um motivo; (2) se ele escolheu ou aceitou um horário (a das 14, segunda de manhã, pode ser terça), é "escolheu_horario", ' +
  'mesmo que cite motivo ou forma de pagamento; (3) "adiou_com_motivo" só quando ele adia dizendo o motivo ou o quando E não se despede; ' +
  '(4) "recusa" quando não quer, já resolveu ou desistiu; (5) NA DÚVIDA, "outro". Nunca invente motivo ou data.';

/** O mínimo que o classificador usa do modelo do LangChain (e o que o teste de contrato falsifica). */
export interface ModeloComSaidaEstruturada {
  withStructuredOutput(schema: unknown, opcoes?: Record<string, unknown>): { invoke(entrada: unknown, opcoes?: Record<string, unknown>): Promise<unknown> };
}

export interface EntradaDaClassificacao {
  falaDoPaciente: string;
  ultimaFalaDaIa: string[];
}

function textoParaOModelo(e: EntradaDaClassificacao): string {
  const ia = e.ultimaFalaDaIa.length ? e.ultimaFalaDaIa.join('\n') : '(nenhuma)';
  return `ÚLTIMA MENSAGEM DA CLÍNICA:\n${ia}\n\nFALA DO PACIENTE:\n${e.falaDoPaciente}`;
}

/** Chama o modelo com o schema e VALIDA a saída contra ele (zod). Qualquer coisa fora do schema = null. */
export async function classificarComModelo(modelo: ModeloComSaidaEstruturada, entrada: EntradaDaClassificacao, prazoMs = PRAZO_DO_CLASSIFICADOR_MS): Promise<ClassificacaoDaFala | null> {
  const estruturado = modelo.withStructuredOutput(SCHEMA_DA_FALA, { name: 'classificar_fala', method: 'functionCalling' });
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const estouro = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ac.abort();
      rej(new Error(`classificador: sem resposta em ${prazoMs} ms`));
    }, prazoMs);
  });
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
    const lido = SCHEMA_DA_FALA.safeParse(bruto);
    return lido.success ? lido.data : null;
  } finally {
    clearTimeout(timer);
  }
}

export interface DependenciasDoAdiamento {
  /** Devolve a classificação, ou null (falha, prazo, schema inválido). Nunca lança. */
  classificar(entrada: EntradaDaClassificacao, unit: Unit): Promise<ClassificacaoDaFala | null>;
}

export const dependenciasPadrao: DependenciasDoAdiamento = {
  async classificar(entrada, unit) {
    try {
      const modelo = createChatOpenAI(unit, { model: MODELO_DO_CLASSIFICADOR, temperature: 0, maxTokens: 150 });
      return await classificarComModelo(modelo as unknown as ModeloComSaidaEstruturada, entrada);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200), unit: unit.slug }, 'adiamento-propoe-dia: o classificador falhou — vale o comportamento de sempre');
      return null;
    }
  },
};

// ── a decisão do turno ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PedidoDeAdiamento {
  unit: Pick<Unit, 'slug' | 'spineEnabled' | 'spineToken'> & Partial<Unit>;
  falas: Fala[] | undefined;
  /** Já tem consulta de pé, ou é paciente em tratamento: nunca se propõe horário novo. */
  temConsultaOuTratamento: boolean;
  /** Só para teste: ignora a chave e usa isto. */
  ligada?: boolean;
}

const limpo = (t: string | null | undefined): string | null => {
  const s = String(t ?? '').replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return s || null;
};

/**
 * O paciente adiou COM motivo e vale propor um dia? null = nada muda (comportamento do main).
 * Só chega ao modelo com: chave ligada, unidade COM agenda, sem consulta/tratamento, sinal de adiamento ou despedida na fala e nenhuma
 * proposta anterior. Só "adiou_com_motivo" propõe; qualquer outro tipo, falha ou dúvida = null.
 */
export async function decidirAdiamento(pedido: PedidoDeAdiamento, deps: DependenciasDoAdiamento = dependenciasPadrao): Promise<AdiamentoDoTurno | null> {
  const { unit, falas } = pedido;
  if (!falas?.length) return null;
  const ligada = pedido.ligada ?? automacaoLigada(unit.slug, ID_ADIAMENTO, process.env.ADIAMENTO_PROPOE_DIA_SLUGS);
  if (!ligada) return null;
  // sem agenda (consultar_horarios não existe) a Sofia inventaria horário: nada de proposta
  if (!unit.spineEnabled || !unit.spineToken) return null;
  if (pedido.temConsultaOuTratamento) return null;
  const { paciente, ia } = turnoEUltimaProposta(falas);
  if (!valeClassificar(paciente)) return null;
  if (propostaDeAdiamentoJaFeita(falas)) return null;
  const c = await deps.classificar({ falaDoPaciente: paciente, ultimaFalaDaIa: ia }, unit as Unit);
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
