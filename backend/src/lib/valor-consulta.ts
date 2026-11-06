/**
 * "¤ Valor da Consulta" preenchido sozinho (pedido do João, 05/11/2026, Timbó: "o valor é padrão 250… ninguém
 * precisa preencher… não vai esconder, ele vai ser preenchido sozinho").
 *
 * Por que importa: o dashboard soma este campo no card Consultas → Valor total e tem a regra de qualidade
 * "Passou pela consulta sem valor da consulta"; o guia da Ponte pedia o campo à SDR em AGENDADO.
 *
 * A REGRA (pura, sem Kommo):
 *  - o valor vem das fontes da unidade (`valorDaConsultaNoDia(source_produtos)`, em `agent/pagamento-da-unidade.ts`).
 *    Nenhum número no código: sem preço nas fontes, não escreve (e o worker registra o motivo);
 *  - quando: a consulta que o cartão espelha é uma AVALIAÇÃO ainda por acontecer: status Agendado, Confirmado ou
 *    Remarcado E horário no futuro (consulta de ontem que a recepção não deu baixa não ganha valor depois do fato).
 *    Retorno e sessão não têm este preço; atendida, faltou e desmarcada não são "consulta marcada";
 *  - só em campo VAZIO. Qualquer coisa já digitada fica — inclusive 0, que a recepção usa para cortesia;
 *  - chave própria por unidade (`valor-consulta`, tela de Automações): desligado não faz nada, seco só registra.
 *
 * Fonte única do campo: só este módulo escreve "¤ Valor da Consulta" (o sincronizador da franquia não o espelha:
 * o valor da franquia é o do TRATAMENTO). Os DOIS caminhos que gravam (a varredura e a Sofia ao agendar, `valor-consulta-agendar.ts`)
 * decidem pela MESMA função, das mesmas fontes: não há dois escritores com fontes diferentes para brigar.
 *
 * UNIDADE COM PAGAMENTO ANTECIPADO (06/11/2026): o preço no dia seria o errado para quem pagou antes. Os modelos de WhatsApp
 * "consulta prepagamento" e "dados pix" (Açailândia, Salto e as cópias) leem este campo: "a consulta com pagamento antecipado é
 * {{valor}}" / "Valor: {{valor}}". Então, quando a unidade TEM preço antecipado nas fontes:
 *  - `¤ Pagamento antecipado` = Sim (ou `✓ Consulta pg antecipado` = Sim: o dinheiro entrou) → preço ANTECIPADO particular;
 *  - = Não → preço no dia;
 *  - vazio → ESPERA a forma (nunca um número que pode estar errado); no DIA da consulta, sem forma, vale o preço no dia;
 *  - paciente com plano/convênio (campo "Plano de saúde" preenchido ou etiqueta de convênio) → não grava, o log diz o motivo;
 *  - unidade com taxa de reserva (Boa Vista: o antecipado é PARTE do valor, não desconto) → não grava em nenhum cartão;
 *  - CORREÇÃO: o robô guarda o que gravou (`valor-consulta-marca.ts`); se o cartão ainda tem exatamente isso e a forma mudou
 *    (Não→Sim por comprovante), ele troca para o preço certo. Valor digitado por pessoa, e o 0 da cortesia, nunca.
 * Sem preço antecipado nas fontes (Timbó) NADA disso vale: a regra é a de sempre. Única exceção, a unidade com taxa de reserva (Boa Vista), que não grava em nenhum cartão.
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { ehAvaliacao, normalizar } from './franquia-sync.js';
import { automacaoLigada, type Estado } from './automacoes-estado.js';
import { valorDaConsultaNoDia, type FlagsDePagamento } from '../agent/pagamento-da-unidade.js';
import { precosDaConsulta } from '../agent/prompt-composer.js';
import { dataBRNoFuso, offsetMinutosNoFuso } from './fuso.js';

export const CAMPO_VALOR_DA_CONSULTA = '¤ Valor da Consulta';

/** Os status da franquia em que a avaliação ainda vai acontecer. */
const CONSULTA_POR_VIR: readonly number[] = [SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO];

/** O campo precisa aceitar número: monetário (o da conta) ou numérico. Texto/lista recusariam o PATCH em todo cartão. */
const TIPOS_QUE_ACEITAM_NUMERO: readonly string[] = ['monetary', 'numeric'];

export interface EntradaValorDaConsulta {
  estado: Estado;
  /** a consulta que o cartão espelha nesta varredura (a mesma que o sincronizador usa) */
  consulta: Pick<SpineSchedule, 'categoryName' | 'idStatus'> | null;
  /** quando ela acontece e que horas são (epoch, s): só avaliação que ainda vai acontecer recebe */
  consultaEpoch: number | null;
  agoraEpoch: number;
  /** o campo existe nesta conta? e de que tipo */
  tipoDoCampo: string | null;
  /** o que o cartão tem hoje no campo: `null` = vazio */
  noCartao: string | null;
  /** "250,00", lido das fontes da unidade, ou null */
  preco: string | null;
  /** o sincronizador inteiro (ou a revisão) está em "só no papel": nada grava, nem com esta chave ligada */
  secoGlobal?: boolean;
  /**
   * --- só para unidade com pagamento antecipado (tudo abaixo ausente = a regra de sempre) ---
   * "150,00": o preço antecipado PARTICULAR, lido das fontes (`precosDaUnidade`). null/ausente = a unidade não tem.
   */
  precoAntecipado?: string | null;
  /** o que o cartão diz da forma de pagamento (`formaDoCartao`) */
  forma?: FormaDoPagamento;
  /** a consulta é HOJE no fuso da unidade? (sem forma até o dia da consulta, vale o preço no dia) */
  consultaHoje?: boolean;
  /** unidade com taxa de reserva obrigatória (`spineBookingRequiresPayment`): o antecipado é parte do valor, não desconto */
  taxaDeReserva?: boolean;
  /** há sinal de plano/convênio no cartão (`temSinalDeConvenio`) */
  comConvenio?: boolean;
  /** centavos que o PRÓPRIO robô gravou neste cartão (`valor-consulta-marca.ts`), ou null/ausente se nunca gravou */
  marcaCentavos?: number | null;
}

/** `¤ Pagamento antecipado` (ou o pagamento comprovado): Sim → antecipado; Não → no dia; vazio → ainda não se sabe. */
export type FormaDoPagamento = 'sim' | 'nao' | 'vazio';

export type MotivoDeNaoGravar =
  | 'desligado'
  | 'sem-campo'
  | 'campo-sem-numero'
  | 'sem-consulta-por-vir'
  | 'ja-preenchido'
  | 'sem-preco'
  | 'taxa-de-reserva'
  | 'convenio'
  | 'espera-forma';

export type DecisaoValorDaConsulta =
  | { acao: 'nada'; motivo: MotivoDeNaoGravar }
  /** `troca`: o campo tinha o que o PRÓPRIO robô gravou e a forma de pagamento mudou; quem aplica ainda confere o autor no Kommo */
  | { acao: 'gravar' | 'gravaria'; valor: number; motivo: string; troca?: boolean; qual?: 'antecipado' | 'no-dia' };

/** "250,00" → 250. Nada de valor inventado: texto que não é número devolve null. */
export function precoEmNumero(preco: string | null | undefined): number | null {
  const n = Number(String(preco ?? '').trim().replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A consulta é uma avaliação que ainda vai acontecer? */
export function avaliacaoPorVir(consulta: EntradaValorDaConsulta['consulta'], consultaEpoch: number | null, agoraEpoch: number): boolean {
  if (!consulta || consulta.idStatus === null || consulta.idStatus === undefined) return false;
  if (consultaEpoch === null || !(consultaEpoch > agoraEpoch)) return false;
  return ehAvaliacao(consulta) && CONSULTA_POR_VIR.includes(consulta.idStatus);
}

/** Centavos inteiros: compara o que o Kommo devolve ("150", "150.0000", 150) com o que o robô gravou sem erro de ponto flutuante. */
export const emCentavos = (v: unknown): number | null => {
  const t = String(v ?? '').trim();
  if (t === '') return null; // vazio não é R$ 0 (a cortesia)
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Decide o que fazer com o campo deste cartão. Puro: a ordem dos testes é a ordem dos motivos que o log mostra. */
export function decidirValorDaConsulta(e: EntradaValorDaConsulta): DecisaoValorDaConsulta {
  if (e.estado === 'desligado') return { acao: 'nada', motivo: 'desligado' };
  if (e.tipoDoCampo === null) return { acao: 'nada', motivo: 'sem-campo' };
  if (!TIPOS_QUE_ACEITAM_NUMERO.includes(e.tipoDoCampo)) return { acao: 'nada', motivo: 'campo-sem-numero' };
  if (!avaliacaoPorVir(e.consulta, e.consultaEpoch, e.agoraEpoch)) return { acao: 'nada', motivo: 'sem-consulta-por-vir' };
  // Taxa de reserva (Boa Vista): o "antecipado" é PARTE do valor, não desconto, e o valor da consulta ali não é um preço só.
  // Vale mesmo sem preço antecipado legível nas fontes: na dúvida, não grava.
  if (e.taxaDeReserva) return { acao: 'nada', motivo: 'taxa-de-reserva' };
  const modo = e.estado === 'seco' || e.secoGlobal ? 'gravaria' : 'gravar';
  const preenchido = e.noCartao !== null && e.noCartao.trim() !== '';
  const noDia = precoEmNumero(e.preco);
  const antecipado = precoEmNumero(e.precoAntecipado);

  // Sem preço antecipado (ou um que não é menor que o do dia: as fontes se contradizem): a regra de sempre.
  if (antecipado === null || noDia === null || antecipado >= noDia) {
    if (preenchido) return { acao: 'nada', motivo: 'ja-preenchido' };
    if (noDia === null) return { acao: 'nada', motivo: 'sem-preco' };
    return { acao: modo, valor: noDia, motivo: 'avaliação marcada e campo vazio (preço das fontes da unidade)' };
  }

  if (e.comConvenio) return { acao: 'nada', motivo: 'convenio' };

  const forma = e.forma ?? 'vazio';
  const qual = forma === 'sim' ? 'antecipado' : forma === 'nao' || e.consultaHoje ? 'no-dia' : null;
  const alvo = qual === 'antecipado' ? antecipado : qual === 'no-dia' ? noDia : null;

  if (preenchido) {
    // Só o robô se corrige: o cartão ainda tem EXATAMENTE o que ele gravou e agora o certo é outro número.
    const atual = emCentavos(e.noCartao);
    if (alvo !== null && qual !== null && e.marcaCentavos != null && e.marcaCentavos > 0 && atual === e.marcaCentavos && Math.round(alvo * 100) !== atual) {
      return { acao: modo, valor: alvo, qual, troca: true, motivo: `a forma de pagamento mudou (${qual === 'antecipado' ? 'antecipado' : 'no dia'}): o robô troca o que ele mesmo gravou` };
    }
    return { acao: 'nada', motivo: 'ja-preenchido' };
  }
  if (alvo === null || qual === null) return { acao: 'nada', motivo: 'espera-forma' };
  const porque = forma === 'vazio' ? 'sem forma de pagamento até o dia da consulta: vale o preço no dia' : `forma de pagamento: ${qual === 'antecipado' ? 'antecipado (Sim)' : 'no dia (Não)'}`;
  return { acao: modo, valor: alvo, qual, motivo: `avaliação marcada e campo vazio; ${porque}` };
}

/** "Sim"/"Não"/"S"/true/"1": o que o Kommo devolve num campo Sim/Não ou caixa de seleção. */
const ehSim = (v: unknown): boolean => v === true || /^\s*(sim|s|true|1)\s*$/i.test(String(v ?? ''));
const ehNao = (v: unknown): boolean => v === false || /^\s*(n[aã]o|n|false|0)\s*$/i.test(String(v ?? ''));

/**
 * A forma de pagamento do cartão. `pagouAntecipado` (✓ Consulta pg antecipado = Sim: o dinheiro entrou, por comprovante ou Asaas)
 * vale mais que `¤ Pagamento antecipado`, que só guarda o que o paciente ESCOLHEU: quem pagou antes pagou o preço de antes.
 * Valor que não é Sim nem Não ("talvez", texto livre) = vazio: na dúvida espera, não chuta.
 */
export function formaDoCartao(pagamentoAntecipado: unknown, pagouAntecipado: unknown): FormaDoPagamento {
  if (ehSim(pagouAntecipado) || ehSim(pagamentoAntecipado)) return 'sim';
  if (ehNao(pagamentoAntecipado)) return 'nao';
  return 'vazio';
}

/**
 * O cartão é de paciente com plano/convênio? O preço do convênio não é nenhum dos dois desta regra, e errar para o lado do
 * particular cobra a mais de quem tem direito ao desconto. Sinais: o campo "⬢ Plano de saúde" com algo que não seja uma negação, ou uma
 * etiqueta que fale de convênio/plano de saúde. Na dúvida (valor estranho no campo) é convênio.
 */
export function temSinalDeConvenio(planoDeSaude: unknown, etiquetas: ReadonlyArray<string>): boolean {
  const campo = String(planoDeSaude ?? '').trim();
  if (campo !== '' && !/^(?:n[aã]o\b|nenhum|n\/a|-+$|particular|sem\b)/i.test(campo)) return true;
  // etiqueta que NEGA o convênio ("SEM CONVÊNIO", "Particular - sem plano de saúde") não é sinal de convênio
  return etiquetas.some((t) => /conv[eê]nio|plano\s+de\s+sa[uú]de|carteirinha/i.test(t) && !/\b(?:sem|n[aã]o)\b|particular/i.test(t));
}

/**
 * O que o cartão diz da forma de pagamento e do plano. Lê pelo NOME do campo (cada conta tem os seus ids), como a régua de cobrança
 * (`pagouOAntecipado`): "¤ Pagamento antecipado", "✓ Consulta pg antecipado" (pode ser caixa de seleção) e "⬢ Plano de saúde".
 */
export function sinaisDoCartao(
  lead: { custom_fields_values?: ReadonlyArray<{ field_id: number; field_name?: string; values?: ReadonlyArray<{ value?: unknown }> | null }> | null; _embedded?: { tags?: ReadonlyArray<{ name: string }> | null } | null },
  /** o cartão do guia pode vir sem `field_name`: aí o nome sai do esquema da conta */
  nomeDoCampo?: (id: number) => string | undefined,
  /** a Sofia acabou de decidir a forma e vai gravá-la: vale esta, não a que o cartão ainda mostra */
  pagamentoAntecipadoDecidido?: 'Sim' | 'Não' | null,
): { forma: FormaDoPagamento; comConvenio: boolean } {
  const campo = (nome: string): unknown => {
    const c = (lead.custom_fields_values ?? []).find((f) => normalizar(f.field_name ?? nomeDoCampo?.(f.field_id)) === nome);
    return c?.values?.[0]?.value ?? null;
  };
  const etiquetas = (lead._embedded?.tags ?? []).map((t) => t.name);
  return {
    forma: formaDoCartao(pagamentoAntecipadoDecidido ?? campo('pagamento antecipado'), campo('consulta pg antecipado')),
    comConvenio: temSinalDeConvenio(campo('plano de saude'), etiquetas),
  };
}

/** A consulta é hoje, no fuso da unidade? (epoch em segundos) */
export function consultaEhHoje(consultaEpoch: number | null, agoraEpoch: number, fuso: string): boolean {
  if (consultaEpoch === null) return false;
  return dataBRNoFuso(consultaEpoch * 1000, fuso) === dataBRNoFuso(agoraEpoch * 1000, fuso);
}

/** "2026-11-07" + "14:30" no relógio da unidade → epoch em segundos (para o caminho da Sofia, que sabe a data pelo texto). */
export function epochDaConsulta(data: string, hora: string, fuso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  const h = /^(\d{1,2}):(\d{2})/.exec(hora);
  if (!m || !h) return null;
  const comoUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(h[1]), Number(h[2]));
  return Math.floor((comoUtc - offsetMinutosNoFuso(new Date(comoUtc), fuso) * 60_000) / 1000);
}

export interface PrecosDaUnidade {
  /** "250,00", de `valorDaConsultaNoDia` */
  noDia: string | null;
  /** "150,00": o antecipado particular. null = a unidade não tem (ou as fontes não fecham: ver abaixo) */
  antecipado: string | null;
}

type UnidadeComFontes = { sourceProdutos?: string | null; systemPrompt?: string | null } & FlagsDePagamento;

const emReais = (n: number) => n.toFixed(2).replace('.', ',');

/**
 * Os dois preços desta unidade, das FONTES (nada fixo no código). O antecipado vem de `precosDaConsulta`, a mesma leitura que
 * a Sofia e o guardrail de preço usam (acha o R$ do slot "antecipado" e ignora o de plano/convênio). Só vale se bate com o preço
 * no dia lido aqui e é menor que ele; qualquer divergência entre as duas leituras = sem antecipado = a regra de sempre.
 * Unidade sem antecipado (`acceptsAdvancePayment = false`, Timbó) nunca tem.
 */
const precosGuardados = new WeakMap<object, PrecosDaUnidade>();

export function precosDaUnidade(unit: UnidadeComFontes): PrecosDaUnidade {
  // a varredura pergunta isto a cada cartão (centenas): duas regex sobre as fontes e o prompt, o mesmo resultado para a unidade toda
  const guardado = precosGuardados.get(unit);
  if (guardado) return guardado;
  const r = lerPrecosDaUnidade(unit);
  precosGuardados.set(unit, r);
  return r;
}

function lerPrecosDaUnidade(unit: UnidadeComFontes): PrecosDaUnidade {
  const noDia = valorDaConsultaNoDia(unit.sourceProdutos);
  const p = precosDaConsulta({ sourceProdutos: unit.sourceProdutos ?? null, systemPrompt: unit.systemPrompt ?? '', acceptsAdvancePayment: unit.acceptsAdvancePayment, spineBookingRequiresPayment: unit.spineBookingRequiresPayment });
  const dia = precoEmNumero(noDia);
  if (!p || dia === null || Math.round(p.noDia * 100) !== Math.round(dia * 100) || !(p.antecipado < dia)) return { noDia, antecipado: null };
  return { noDia, antecipado: emReais(p.antecipado) };
}

/**
 * O robô vai preencher o Valor da Consulta nesta unidade? Ligado (não seco), com o sincronizador também ligado — é ele
 * quem roda a regra — e com o preço nas fontes. É a pergunta do guia da Ponte: só então ele deixa de pedir o campo à
 * SDR. O worker decide cartão a cartão com `decidirValorDaConsulta`; esta é a condição da UNIDADE.
 */
export function valorDaConsultaVemDoRobo(unit: { slug: string; sourceProdutos?: string | null; systemPrompt?: string | null } & FlagsDePagamento): boolean {
  if (
    !automacaoLigada(unit.slug, 'valor-consulta', process.env.VALOR_CONSULTA_SLUGS) ||
    !automacaoLigada(unit.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS)
  ) {
    return false;
  }
  // taxa de reserva (Boa Vista): o robô desiste da unidade inteira, a SDR segue preenchendo
  if (unit.spineBookingRequiresPayment) return false;
  return precosDaUnidade(unit).noDia !== null;
}
