/**
 * O resultado de uma onda para o gestor — as contas puras (sem banco, sem Kommo, sem Meta).
 *
 * REGRA DE OURO: número que não dá para medir é `null`, nunca um palpite. A Meta só entrega entregue/lida/custo POR DIA e
 * POR MODELO (ou por categoria), somando tudo o que a conta de WhatsApp mandou. Só se atribui à onda quando a conta
 * fecha: o que a Meta registra bate com o que a onda mandou, e mais ninguém mandou nos mesmos dias. Se não fecha, vai
 * `null` com o MOTIVO por escrito, e quem lê decide.
 */
import { normalizar } from '../franquia-sync.js';

// ── funil que sai do banco ─────────────────────────────────────────────────────────────────────────────────────

export interface Funil {
  selecionados: number;
  /** quem RECEBEU a mensagem (inclui quem depois pediu SAIR) */
  enviados: number;
  falhas: number;
  /** na fila, ou reivindicado e ainda sem resposta da Meta */
  pendentes: number;
  /** recebeu e respondeu SAIR (é um SUBCONJUNTO de `enviados`) */
  saiu: number;
  /** barrado antes do envio (franquia, SAIR antigo, seco…) */
  descartados: number;
  entregues: number | null;
  lidas: number | null;
  responderam: number | null;
  agendaram: number | null;
}

/**
 * `porEstado` = contagem por `estado` da onda; `saiuQueRecebeu` = os `saiu` com `enviadoEm`. Quem pediu SAIR ANTES de receber
 * (estado `saiu` sem `enviadoEm`) nunca foi enviado: conta como descartado, como o freio por SAIR já conta (`contarSairam`).
 * Fecha a conta: selecionados = enviados + falhas + pendentes + descartados (o `saiu` está dentro de `enviados`).
 */
export function funilDoBanco(porEstado: Readonly<Record<string, number>>, saiuQueRecebeu: number): Pick<Funil, 'selecionados' | 'enviados' | 'falhas' | 'pendentes' | 'saiu' | 'descartados'> {
  const n = (e: string) => porEstado[e] ?? 0;
  const saiuTodos = n('saiu');
  const recebeu = Math.min(saiuQueRecebeu, saiuTodos);
  return {
    selecionados: Object.values(porEstado).reduce((s, v) => s + v, 0),
    enviados: n('enviado') + recebeu,
    falhas: n('falhou'),
    pendentes: n('pendente') + n('enviando'),
    saiu: recebeu,
    descartados: n('descartado') + (saiuTodos - recebeu),
  };
}

/** Envios por hora cheia (UTC, ISO), do mais antigo ao mais novo. Quem converte para São Paulo é a tela. */
export function enviosPorHora(enviadoEm: ReadonlyArray<Date>): Array<{ hora: string; enviados: number }> {
  const porHora = new Map<number, number>();
  for (const d of enviadoEm) {
    const h = Math.floor(d.getTime() / 3_600_000) * 3_600_000;
    porHora.set(h, (porHora.get(h) ?? 0) + 1);
  }
  return [...porHora].sort((a, b) => a[0] - b[0]).map(([h, enviados]) => ({ hora: new Date(h).toISOString(), enviados }));
}

// ── Meta: entregue, lida e custo ───────────────────────────────────────────────────────────────────────────────

/** O que a onda mandou (nosso banco) nos dias dela, e se alguém mais mandou na mesma conta de WhatsApp. */
export interface EnviosDaOnda {
  /** enviado ou saiu, com hora de envio */
  confirmados: number;
  /** `falhou` ou `enviando` COM hora de envio: a Meta pode ter aceitado (o envio incerto) */
  incertos: number;
  /** envios de OUTRAS ondas das unidades da mesma conta (WABA) dentro dos dias desta, de qualquer modelo (afeta o custo, que é por categoria) */
  deOutrasOndas: number;
  /** o mesmo, só dos que usaram o MESMO modelo (afeta o `sent` do modelo) */
  deOutrasOndasDoModelo: number;
}

export interface LinhaDeTemplate {
  /** dia (UTC) e idioma da linha: a tabela tem uma por (dia, modelo, idioma) */
  date?: Date;
  language?: string;
  sent: number;
  delivered: number;
  read: number;
  syncedAt: Date;
}

export interface LinhaDeCusto {
  pricingCategory: string;
  volume: number;
  costUsd: number;
  syncedAt: Date;
}

export interface MetaDaOnda {
  entregues: number | null;
  lidas: number | null;
  entreguesAtualizadoEm: Date | null;
  custoUsd: number | null;
  custoAtualizadoEm: Date | null;
  /** por que ficou `null` (ou null quando mediu) */
  motivoEntregues: string | null;
  motivoCusto: string | null;
}

/**
 * A tabela guarda uma linha por (dia, modelo, idioma), e o idioma pode vir vazio ("não segmentado"). Se o mesmo dia tem a do
 * idioma da onda E a vazia, vale a do idioma da onda: somar as duas dobraria o `sent`.
 */
export function umaLinhaPorDia<T extends LinhaDeTemplate>(linhas: ReadonlyArray<T>, idioma: string): T[] {
  const porDia = new Map<number, T>();
  for (const l of linhas) {
    const dia = l.date?.getTime() ?? 0;
    const atual = porDia.get(dia);
    if (!atual || (atual.language !== idioma && l.language === idioma)) porDia.set(dia, l);
  }
  return [...porDia.values()];
}

const soma = (xs: ReadonlyArray<number>) => xs.reduce((s, v) => s + v, 0);
const maisAntiga = (ds: ReadonlyArray<Date>): Date | null => (ds.length ? new Date(Math.min(...ds.map((d) => d.getTime()))) : null);

/**
 * Entregues, lidas e custo da onda, a partir das linhas diárias da Meta já gravadas (`whatsapp_template_daily` e
 * `whatsapp_cost_daily`). Só atribui quando a conta fecha:
 *  - ninguém recebeu ainda → nada a medir;
 *  - outra onda da mesma conta mandou nos mesmos dias → a Meta soma os dois, e rachar seria chute;
 *  - ENTREGUES/LIDAS: o `sent` da Meta para o modelo nos dias precisa estar entre o que a onda confirmou e o que mandou
 *    contando os envios incertos. Acima = há envio de outra origem (transmissão do Kommo, outro robô); abaixo = a Meta
 *    ainda não contou tudo (dado atrasado);
 *  - CUSTO: só com o entregue medido, e o volume de MARKETING cobrado nos dias entre o entregue e o que a onda mandou. A
 *    cobrança da Meta é por mensagem entregue: abaixo do entregue ela ainda não fechou (custo parcial), acima há marketing
 *    de outra origem.
 */
export function atribuirMeta(envios: EnviosDaOnda, template: ReadonlyArray<LinhaDeTemplate>, custo: ReadonlyArray<LinhaDeCusto>, semNada: { template: boolean; custo: boolean } = { template: false, custo: false }): MetaDaOnda {
  const vazio = (motivoEntregues: string, motivoCusto: string = motivoEntregues): MetaDaOnda => ({ entregues: null, lidas: null, entreguesAtualizadoEm: null, custoUsd: null, custoAtualizadoEm: null, motivoEntregues, motivoCusto });
  if (envios.confirmados === 0) return vazio('ninguém recebeu ainda: não há o que medir na Meta');
  if (envios.deOutrasOndasDoModelo > 0) {
    return vazio(`outra onda da mesma conta do WhatsApp mandou ${envios.deOutrasOndasDoModelo} mensagem(ns) com este mesmo modelo nos mesmos dias: a Meta soma tudo por dia e por modelo e não dá para separar`);
  }
  const possiveis = envios.confirmados + envios.incertos;

  let entregues: number | null = null;
  let lidas: number | null = null;
  let entreguesAtualizadoEm: Date | null = null;
  let motivoEntregues: string | null = null;
  if (template.length === 0) {
    motivoEntregues = semNada.template
      ? 'a tabela da Meta (template_analytics) não tem nenhuma linha desta unidade: o sync de custo nunca gravou para ela (token sem o escopo whatsapp_business_management, WABA não cadastrada ou o sync parado)'
      : 'a tabela da Meta (template_analytics) não tem linhas deste modelo nos dias da onda: o sync ainda não rodou depois do envio, ou o nome do modelo não bate';
  } else {
    const enviadasNaMeta = soma(template.map((l) => l.sent));
    if (enviadasNaMeta > possiveis) {
      motivoEntregues = `a Meta registra ${enviadasNaMeta} envios deste modelo nos dias da onda e a onda mandou ${possiveis}: há envio de outra origem (por exemplo transmissão do Kommo)`;
    } else if (enviadasNaMeta < envios.confirmados) {
      motivoEntregues = `a Meta ainda não contou todos os envios (${enviadasNaMeta} de ${envios.confirmados}): dado atrasado`;
    } else {
      entregues = soma(template.map((l) => l.delivered));
      lidas = soma(template.map((l) => l.read));
      entreguesAtualizadoEm = maisAntiga(template.map((l) => l.syncedAt));
    }
  }

  let custoUsd: number | null = null;
  let custoAtualizadoEm: Date | null = null;
  let motivoCusto: string | null = null;
  const marketing = custo.filter((l) => l.pricingCategory.toUpperCase().startsWith('MARKETING'));
  if (envios.deOutrasOndas > 0) {
    motivoCusto = `outra onda da mesma conta do WhatsApp mandou ${envios.deOutrasOndas} mensagem(ns) nos mesmos dias: a Meta cobra marketing por categoria e dia, e não dá para separar`;
  } else if (entregues === null) {
    motivoCusto = 'sem o número de entregues conferido não dá para saber se a cobrança da Meta já fechou: ' + (motivoEntregues ?? '');
  } else if (marketing.length === 0) {
    motivoCusto = semNada.custo
      ? 'a tabela de custo (pricing_analytics) não tem nenhuma linha desta unidade: o sync nunca gravou para ela'
      : 'a tabela de custo (pricing_analytics) não tem linhas de MARKETING nos dias da onda';
  } else {
    const cobradas = soma(marketing.map((l) => l.volume));
    if (cobradas > possiveis) {
      motivoCusto = `a Meta cobrou ${cobradas} mensagens de marketing nos dias da onda e a onda mandou ${possiveis}: há marketing de outra origem`;
    } else if (cobradas < entregues) {
      motivoCusto = `a cobrança da Meta ainda não fechou (${cobradas} cobradas de ${entregues} entregues)`;
    } else {
      custoUsd = soma(marketing.map((l) => l.costUsd));
      custoAtualizadoEm = maisAntiga(marketing.map((l) => l.syncedAt));
    }
  }
  return { entregues, lidas, entreguesAtualizadoEm, custoUsd, custoAtualizadoEm, motivoEntregues, motivoCusto };
}

/** Dia (UTC) de cada ponta dos envios, como datas à meia-noite UTC: é como o sync grava a coluna `date`. */
export function diasDosEnvios(primeiro: Date, ultimo: Date): { de: Date; ate: Date; fimExclusivo: Date } {
  const dia = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const de = dia(primeiro);
  const ate = dia(ultimo);
  return { de, ate, fimExclusivo: new Date(ate.getTime() + 86_400_000) };
}

// ── Kommo: respondeu ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Distribui as mensagens recebidas pelos cartões. Um contato pode ter MAIS DE UM cartão da onda: as respostas valem para todos
 * eles (um mapa invertido contato→cartão perderia todos menos um). `eventosDeChat` devolve o id do cartão (é assim que o placar
 * do Outubro Rosa o lê); se um dia devolver o do contato, casa do mesmo jeito.
 */
export function mensagensPorCartao(
  contatoDoCartao: ReadonlyMap<number, number>,
  eventos: ReadonlyArray<{ leadId: number; tipo: 'entrada' | 'saida'; em: number }>,
): Map<number, number[]> {
  const cartoesDoContato = new Map<number, number[]>();
  for (const [cartao, contato] of contatoDoCartao) cartoesDoContato.set(contato, [...(cartoesDoContato.get(contato) ?? []), cartao]);
  const porCartao = new Map<number, number[]>();
  for (const e of eventos) {
    if (e.tipo !== 'entrada') continue;
    const cartoes = contatoDoCartao.has(e.leadId) ? [e.leadId] : (cartoesDoContato.get(e.leadId) ?? []);
    for (const c of cartoes) porCartao.set(c, [...(porCartao.get(c) ?? []), e.em]);
  }
  return porCartao;
}

/**
 * Quantas pessoas escreveram DEPOIS de receber. `entradas` = hora (epoch s) de cada mensagem recebida, por cartão. Só conta
 * a mensagem posterior ao envio DELA: quem escreveu antes da campanha não é resposta.
 */
export function contarResponderam(pessoas: ReadonlyArray<{ leadId: number; enviadoEm: Date }>, entradas: ReadonlyMap<number, ReadonlyArray<number>>): number {
  let n = 0;
  for (const p of pessoas) {
    const corte = Math.floor(p.enviadoEm.getTime() / 1000);
    if ((entradas.get(p.leadId) ?? []).some((em) => em > corte)) n += 1;
  }
  return n;
}

// ── Franquia: agendou ──────────────────────────────────────────────────────────────────────────────────────────

export interface AgendamentoNaFranquia {
  clientName: string | null;
  categoryName: string | null;
  statusName: string | null;
  dateAttendanceUtc: string | null;
}

/**
 * Quantas pessoas têm uma AVALIAÇÃO marcada (não desmarcada) para DEPOIS do envio. Sem o id do paciente na agenda, o que casa é o
 * NOME INTEIRO normalizado: é LIMITE INFERIOR. Fica de fora (e é contado em `semConferir`) quem não tem nome e sobrenome e quem
 * tem o mesmo nome de outra pessoa da onda (dois "Maria Silva" não se distinguem, e marcar a consulta de uma na outra seria
 * palpite virando dado). A onda já barra quem tinha consulta futura no envio, então avaliação depois do envio é marcação nova.
 */
export function contarAgendaram(
  pessoas: ReadonlyArray<{ nomeCompleto: string | null; enviadoEm: Date }>,
  agenda: ReadonlyArray<AgendamentoNaFranquia>,
): { agendaram: number; semConferir: number } {
  const nomes = pessoas.map((p) => normalizar(p.nomeCompleto));
  const repeticoes = new Map<string, number>();
  for (const n of nomes) repeticoes.set(n, (repeticoes.get(n) ?? 0) + 1);
  const avaliacoes = new Map<string, number[]>();
  for (const s of agenda) {
    if (!/AVALIA/i.test(s.categoryName ?? '') || /DESMARC/i.test(s.statusName ?? '') || !s.clientName || !s.dateAttendanceUtc) continue;
    const t = Date.parse(s.dateAttendanceUtc);
    if (!Number.isFinite(t)) continue;
    const chave = normalizar(s.clientName);
    avaliacoes.set(chave, [...(avaliacoes.get(chave) ?? []), t]);
  }
  let agendaram = 0;
  let semConferir = 0;
  pessoas.forEach((p, i) => {
    const nome = nomes[i]!;
    if (nome.split(' ').filter(Boolean).length < 2 || (repeticoes.get(nome) ?? 0) > 1) {
      semConferir += 1;
      return;
    }
    if ((avaliacoes.get(nome) ?? []).some((t) => t > p.enviadoEm.getTime())) agendaram += 1;
  });
  return { agendaram, semConferir };
}

// ── custo por resposta e por agendamento ──────────────────────────────────────────────────────────────────────

const arredondar = (n: number) => Math.round(n * 100) / 100;

/** Custo em reais e por resposta/agendamento (em reais). Sem dólar medido, sem câmbio ou sem divisor, é `null`: nada de estimar. */
export function custoDaOnda(usd: number | null, cambio: number | null, responderam: number | null, agendaram: number | null): { usd: number | null; brl: number | null; porResposta: number | null; porAgendamento: number | null } {
  const brl = usd !== null && cambio !== null && cambio > 0 ? usd * cambio : null;
  return {
    usd: usd === null ? null : Math.round(usd * 1e4) / 1e4,
    brl: brl === null ? null : arredondar(brl),
    porResposta: brl !== null && responderam ? arredondar(brl / responderam) : null,
    porAgendamento: brl !== null && agendaram ? arredondar(brl / agendaram) : null,
  };
}
