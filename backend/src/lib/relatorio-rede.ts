/**
 * Relatório das 18h da rede, para a chefe (pedido do João, 30/09/2026).
 *
 * Duas mensagens:
 * 1. **Placar do dia** — a regra de ouro do funil: o lead conta pelo Kommo; agendado, atendido, falta e
 *    tratamento contam pela franquia, que é a verdade clínica. O CRM dizia "compareceram" com base em
 *    marcação manual e saía errado (ver o relatório das 20h da Imperatriz).
 * 2. **Análise dos últimos 7 dias** — qualificação, objeção, falta e pagamento antecipado. Isso só
 *    existe no cartão do Kommo (a franquia não guarda), então sai de lá, sempre com a cobertura do
 *    campo ao lado. Os porquês estão em `relatorio-rede-analise.ts`.
 *
 * Este arquivo é só CÁLCULO e TEXTO: nenhuma função aqui chama API. A coleta (Spine + Kommo) mora
 * em `coletarUnidade`, que recebe as dependências por parâmetro — assim o teste roda com dados de
 * mentira e o relatório nunca depende de a franquia estar de pé para ser testado.
 *
 * Não envia nada. Quem manda o WhatsApp é o n8n, depois que a pessoa aprovou o texto.
 */
import { SPINE_STATUS, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { analisar, somarAnalises, type AchaCampo, type AnaliseUnidade, type LeadDoKommo, type Motivos, type Ranking } from './relatorio-rede-analise.js';

export interface Contagem {
  /** tudo que estava marcado para o dia e não foi desmarcado */
  marcadas: number;
  atendidas: number;
  faltas: number;
  /** marcado ou confirmado e ainda sem desfecho (inclui "aguardando" e "atrasado") */
  abertas: number;
  /** desmarcadas e remarcadas: saíram do dia */
  desmarcadas: number;
}

export interface ResumoAgenda {
  avaliacao: Contagem;
  sessao: Contagem;
  retorno: Contagem;
  /** marcados para amanhã, por categoria */
  amanha: { avaliacao: number; sessao: number; retorno: number };
  /** categorias que não soubemos classificar — se crescer, o texto do relatório está mentindo */
  semCategoria: number;
}

export interface ResumoTratamentos {
  fechadosHoje: number;
  valorHoje: number;
}

export interface UnidadeRelatada {
  slug: string;
  nome: string;
  /** null = o Kommo não respondeu; o resto do relatório da unidade continua valendo */
  leadsNovos: number | null;
  agenda: ResumoAgenda | null;
  tratamentos: ResumoTratamentos | null;
  /** últimos 7 dias, dos campos do cartão; null = o Kommo não respondeu */
  analise: AnaliseUnidade | null;
  /** o que deu errado nesta unidade, em palavras de gente — vai no texto da chefe */
  falhas: string[];
  /** o erro técnico de cada falha — vai só no aviso ao João, nunca no texto da chefe */
  detalhes: string[];
  /** a unidade não tem Kommo conectado: sem análise, e isso não é falha */
  semKommo?: boolean;
}

/** AAAA-MM-DD que EXISTE. "2026-13-01" passa numa regex e depois estoura como 500 lá dentro. */
export function dataValida(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
}

/** Traduz o erro para a chefe. O texto cru (nome de método, epoch, stack) vai para `detalhes`. */
export function motivoLegivel(err: unknown): string {
  const m = String(err instanceof Error ? err.message : err);
  if (/\b429\b/.test(m)) return 'limite de chamadas atingido';
  if (/\b(401|403)\b/.test(m)) return 'acesso recusado';
  if (/\b(404)\b/.test(m)) return 'endereço não encontrado';
  if (/\b5\d\d\b/.test(m)) return 'o sistema deles está com erro';
  if (/timeout|ETIMEDOUT|ECONNABORTED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(m)) return 'não respondeu a tempo';
  return 'erro inesperado';
}

export type Categoria = 'avaliacao' | 'sessao' | 'retorno' | null;

const vazia = (): Contagem => ({ marcadas: 0, atendidas: 0, faltas: 0, abertas: 0, desmarcadas: 0 });

function semAcento(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Sessão, retorno ou avaliação. A ordem importa: "Retorno após tratamento" e "Sessão" nunca
 * são avaliação, e "Reavaliação" é (contém "avalia"), igual a `ehAvaliacao` do sincronizador.
 */
export function categoriaDe(nome: string | null | undefined): Categoria {
  const c = semAcento(nome);
  if (!c) return null;
  if (c.includes('sess')) return 'sessao';
  if (c.includes('retorno')) return 'retorno';
  if (c.includes('avalia')) return 'avaliacao';
  return null;
}

function contar(c: Contagem, idStatus: number | null): void {
  if (idStatus === SPINE_STATUS.DESMARCADO || idStatus === SPINE_STATUS.REMARCADO) {
    c.desmarcadas++;
    return;
  }
  c.marcadas++;
  if (idStatus === SPINE_STATUS.ATENDIDO) c.atendidas++;
  else if (idStatus === SPINE_STATUS.NAO_COMPARECEU) c.faltas++;
  else c.abertas++;   // agendado, confirmado, aguardando, atrasado, ou sem status
}

/**
 * Fecha a agenda do dia. `hoje` e `amanha` são datas locais da clínica (AAAA-MM-DD), a mesma
 * base de `dayLocal` — comparar com a data UTC colocaria a consulta das 21h no dia seguinte.
 */
export function resumirAgenda(schedules: SpineSchedule[], hoje: string, amanha: string): ResumoAgenda {
  const r: ResumoAgenda = {
    avaliacao: vazia(),
    sessao: vazia(),
    retorno: vazia(),
    amanha: { avaliacao: 0, sessao: 0, retorno: 0 },
    semCategoria: 0,
  };
  for (const s of schedules) {
    const cat = categoriaDe(s.categoryName);
    if (!cat) {
      if (s.dayLocal === hoje || s.dayLocal === amanha) r.semCategoria++;
      continue;
    }
    if (s.dayLocal === hoje) contar(r[cat], s.idStatus);
    else if (s.dayLocal === amanha && s.idStatus !== SPINE_STATUS.DESMARCADO && s.idStatus !== SPINE_STATUS.REMARCADO) {
      r.amanha[cat]++;
    }
  }
  return r;
}

/**
 * Tratamento fechado hoje = criado hoje na franquia. Cancelado não conta como venda.
 * `dia` converte o instante `created` para a data local da clínica.
 */
export function resumirTratamentos(
  tratamentos: SpineTreatment[],
  hoje: string,
  dia: (iso: string) => string | null,
): ResumoTratamentos {
  let n = 0;
  let valor = 0;
  for (const t of tratamentos) {
    if (!t.created || dia(t.created) !== hoje) continue;
    if (semAcento(t.statusName).includes('cancel')) continue;
    n++;
    if (typeof t.price === 'number' && Number.isFinite(t.price)) valor += t.price;
  }
  return { fechadosHoje: n, valorHoje: valor };
}

/** Comparecimento = atendidas ÷ (atendidas + faltas). Quem ainda está em aberto não entra na conta. */
export function taxaDeComparecimento(c: Contagem): number | null {
  const base = c.atendidas + c.faltas;
  return base > 0 ? c.atendidas / base : null;
}

function somar(a: Contagem, b: Contagem): Contagem {
  return {
    marcadas: a.marcadas + b.marcadas,
    atendidas: a.atendidas + b.atendidas,
    faltas: a.faltas + b.faltas,
    abertas: a.abertas + b.abertas,
    desmarcadas: a.desmarcadas + b.desmarcadas,
  };
}

export interface TotaisDaRede {
  unidadesNoRelatorio: number;
  leadsNovos: number;
  avaliacao: Contagem;
  sessao: Contagem;
  retorno: Contagem;
  amanha: { avaliacao: number; sessao: number; retorno: number };
  tratamentos: ResumoTratamentos;
}

export function totaisDaRede(unidades: UnidadeRelatada[]): TotaisDaRede {
  const t: TotaisDaRede = {
    unidadesNoRelatorio: unidades.length,
    leadsNovos: 0,
    avaliacao: vazia(),
    sessao: vazia(),
    retorno: vazia(),
    amanha: { avaliacao: 0, sessao: 0, retorno: 0 },
    tratamentos: { fechadosHoje: 0, valorHoje: 0 },
  };
  for (const u of unidades) {
    t.leadsNovos += u.leadsNovos ?? 0;
    if (u.agenda) {
      t.avaliacao = somar(t.avaliacao, u.agenda.avaliacao);
      t.sessao = somar(t.sessao, u.agenda.sessao);
      t.retorno = somar(t.retorno, u.agenda.retorno);
      t.amanha.avaliacao += u.agenda.amanha.avaliacao;
      t.amanha.sessao += u.agenda.amanha.sessao;
      t.amanha.retorno += u.agenda.amanha.retorno;
    }
    if (u.tratamentos) {
      t.tratamentos.fechadosHoje += u.tratamentos.fechadosHoje;
      t.tratamentos.valorHoje += u.tratamentos.valorHoje;
    }
  }
  return t;
}

/* ───────────────────────────── texto ───────────────────────────── */

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);

/** R$ 18.400 — sem centavos: para a chefe o número redondo lê mais rápido. */
export function moeda(v: number): string {
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

function linhaDaUnidade(u: UnidadeRelatada): string {
  if (!u.agenda) {
    return `*${u.nome}* · franquia indisponível${u.leadsNovos !== null ? ` · ${plural(u.leadsNovos, 'lead', 'leads')}` : ''}`;
  }
  const a = u.agenda.avaliacao;
  const partes: string[] = [];
  if (u.leadsNovos !== null) partes.push(plural(u.leadsNovos, 'lead', 'leads'));
  partes.push(`aval. ${a.atendidas}/${a.marcadas}${a.faltas ? ` (${plural(a.faltas, 'falta', 'faltas')})` : ''}`);
  partes.push(`sessões ${u.agenda.sessao.atendidas}/${u.agenda.sessao.marcadas}`);
  if (u.tratamentos && u.tratamentos.fechadosHoje > 0) {
    partes.push(`trat. ${u.tratamentos.fechadosHoje} (${moeda(u.tratamentos.valorHoje)})`);
  }
  if (u.agenda.amanha.avaliacao > 0) partes.push(`amanhã ${plural(u.agenda.amanha.avaliacao, 'aval.', 'aval.')}`);
  return `*${u.nome}* · ${partes.join(' · ')}`;
}

export interface EntradaDoTexto {
  /** AAAA-MM-DD */
  data: string;
  unidades: UnidadeRelatada[];
  /** nomes das unidades ativas que ficaram fora por não terem a franquia ligada */
  semFranquia: string[];
}

/** AAAA-MM-DD → 30/09 */
const diaMes = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * O texto que vai pro WhatsApp. **Só negrito com `*`**: itálico e markdown de título não renderizam
 * direito e o João já vetou. Sem emoji no meio dos números, só nos cabeçalhos.
 */
export function montarPlacar(e: EntradaDoTexto): string {
  const t = totaisDaRede(e.unidades);
  const ordenadas = [...e.unidades].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const aval = t.avaliacao;
  const comp = taxaDeComparecimento(aval);
  const L: string[] = [];

  L.push(`📊 *RELATÓRIO DA REDE · ${diaMes(e.data)} · 18h*`);
  L.push('');
  L.push(`*REDE · ${plural(t.unidadesNoRelatorio, 'unidade', 'unidades')}*`);
  L.push(`Leads novos: ${t.leadsNovos}`);
  L.push(
    `Avaliações: ${aval.marcadas} marcadas · ${aval.atendidas} atendidas · ${plural(aval.faltas, 'falta', 'faltas')}` +
      ` · ${aval.abertas} em aberto · ${aval.desmarcadas} desmarcadas`,
  );
  L.push(`Comparecimento: ${pct(comp)} ${comp === null ? '(ninguém com desfecho ainda)' : `(${aval.atendidas} de ${aval.atendidas + aval.faltas})`}`);
  L.push(`Sessões: ${t.sessao.atendidas} atendidas · ${plural(t.sessao.faltas, 'falta', 'faltas')} · ${t.sessao.abertas} em aberto`);
  if (t.retorno.marcadas > 0) L.push(`Retornos: ${t.retorno.atendidas} atendidos de ${t.retorno.marcadas}`);
  L.push(
    `Tratamentos fechados hoje: ${t.tratamentos.fechadosHoje}` +
      (t.tratamentos.fechadosHoje > 0 ? ` · ${moeda(t.tratamentos.valorHoje)}` : ''),
  );
  L.push(`Amanhã: ${t.amanha.avaliacao} avaliações · ${t.amanha.sessao} sessões`);
  L.push('');
  L.push('*POR UNIDADE*');
  for (const u of ordenadas) L.push(linhaDaUnidade(u));

  // Atenção: o que a chefe precisa saber que NÃO é número — unidade cega, dado incompleto.
  const atencao: string[] = [];
  for (const u of ordenadas) for (const f of u.falhas) atencao.push(`${u.nome}: ${f}`);
  const semCat = ordenadas.filter((u) => (u.agenda?.semCategoria ?? 0) > 0);
  if (semCat.length) {
    atencao.push(`${semCat.map((u) => u.nome).join(', ')}: agendamentos com categoria que o relatório não reconhece, ficaram fora da conta`);
  }
  if (e.semFranquia.length) atencao.push(`Sem franquia conectada, fora deste relatório: ${e.semFranquia.join(', ')}`);
  if (atencao.length) {
    L.push('');
    L.push('*ATENÇÃO*');
    for (const a of atencao) L.push(`• ${a}`);
  }

  L.push('');
  L.push('Como ler: "aval. 3/4" = 3 atendidas de 4 marcadas. Em aberto = marcado ou confirmado, sem desfecho até as 18h.');
  L.push('Fonte: agenda e tratamentos da franquia; leads do Kommo.');
  return L.join('\n');
}

/* ───── análise dos 7 dias ───── */

const fracao = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}% (${a} de ${b})` : '— (nenhum caso)');
const top = (r: Ranking, n = 3) => r.slice(0, n).map(([k, v]) => `${k} ${v}`).join(' · ');

/** "Esqueceu 5 · Trabalho 3 · registrado em 8 de 40 faltas" — o motivo nunca aparece sem a cobertura. */
function motivos(r: Motivos, dequem: string): string {
  if (r.base === 0) return `nenhum caso`;
  if (r.registradas === 0) return `ninguém registrou o motivo (0 de ${r.base} ${dequem})`;
  return `${top(r.ranking)} · registrado em ${r.registradas} de ${r.base} ${dequem}`;
}

function linhaDaAnalise(u: UnidadeRelatada): string {
  const a = u.analise;
  if (!a) return `*${u.nome}* · ${u.semKommo ? 'sem Kommo conectado' : 'Kommo indisponível'}`;
  const c = a.consultas;
  const partes = [
    `${plural(a.leads.total, 'lead', 'leads')}, ${plural(a.leads.quente, 'quente', 'quentes')}`,
    `${plural(c.total, 'consulta', 'consultas')}: ${c.atendidas} atend., ${plural(c.faltas, 'falta', 'faltas')}, ${c.desmarcadas} desm.`,
    `${a.antecipado.comprovante} com comprovante`,
  ];
  const o = a.objecoes;
  if (o.base > 0) {
    partes.push(o.registradas > 0 ? `objeção: ${o.ranking[0]![0]} (${o.registradas} de ${o.base} registradas)` : `objeção sem registro (0 de ${o.base})`);
  }
  return `*${u.nome}* · ${partes.join(' · ')}`;
}

export function montarAnalise(e: EntradaDoTexto & { inicioJanela: string }): string {
  const ordenadas = [...e.unidades].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const com = ordenadas.filter((u) => u.analise);
  const r = somarAnalises(com.map((u) => u.analise!));
  const L: string[] = [];
  L.push(`🔎 *ANÁLISE · ÚLTIMOS 7 DIAS (${diaMes(e.inicioJanela)} a ${diaMes(e.data)})*`);
  L.push('');
  L.push(`*Leads:* ${r.leads.total} · quentes ${r.leads.quente}${r.leads.total ? ` (${Math.round((r.leads.quente / r.leads.total) * 100)}%)` : ''} · mornos ${r.leads.morno} · frios ${r.leads.frio} · sem qualificação ${r.leads.semQualificacao}`);
  L.push(`*Consultas do período:* ${r.consultas.total} · atendidas ${r.consultas.atendidas} · faltaram ${r.consultas.faltas} · desmarcaram ${r.consultas.desmarcadas} · em aberto ${r.consultas.abertas}${r.consultas.semSituacao ? ` · sem situação ${r.consultas.semSituacao}` : ''}`);
  L.push(`*Pagamento antecipado:* ${r.antecipado.comprovante} com comprovante${r.consultas.total ? ` (${Math.round((r.antecipado.comprovante / r.consultas.total) * 100)}% das consultas)` : ''} · ${r.antecipado.disseQueIaPagar} disseram que iam pagar`);
  const p = r.antecipado.pagou, np = r.antecipado.naoPagou;
  L.push(`*Comparecimento:* quem pagou antes ${fracao(p.atendidas, p.atendidas + p.faltas)} · quem não pagou ${fracao(np.atendidas, np.atendidas + np.faltas)}`);
  L.push(`*Principal objeção (não agendou):* ${motivos(r.objecoes, 'leads sem consulta')}`);
  L.push(`*Por que faltaram:* ${motivos(r.faltas, 'faltas')}`);
  L.push(`*Por que não fecharam tratamento:* ${motivos(r.naoFechou, 'atendidos que não fecharam')}`);
  L.push('');
  L.push('*POR UNIDADE · 7 DIAS*');
  for (const u of ordenadas) L.push(linhaDaAnalise(u));

  const atencao: string[] = [];
  for (const u of com) {
    if (u.analise!.camposAusentes.length) atencao.push(`${u.nome}: a conta não tem ${u.analise!.camposAusentes.join(', ')}`);
    if (u.analise!.truncado) atencao.push(`${u.nome}: lista do Kommo cortada no limite, os números são um piso`);
  }
  if (atencao.length) {
    L.push('');
    L.push('*ATENÇÃO*');
    for (const a of atencao) L.push(`• ${a}`);
  }
  L.push('');
  L.push('Fonte: campos do cartão no Kommo. Situação da consulta copiada da franquia pelo sincronizador. Pagou antes = comprovante marcado; "disseram que iam pagar" não conta como pago.');
  return L.join('\n');
}

export interface EntradaDasMensagens extends EntradaDoTexto {
  /** AAAA-MM-DD, primeiro dia da janela da análise */
  inicioJanela: string;
}

/** As mensagens na ordem de envio: placar do dia e, se houver dado do Kommo, a análise. */
export function montarMensagens(e: EntradaDasMensagens): string[] {
  const msgs = [montarPlacar(e)];
  if (e.unidades.some((u) => u.analise)) msgs.push(montarAnalise(e));
  return msgs;
}

/** Compatibilidade: o texto inteiro numa string só (as mensagens separadas por uma linha em branco). */
export function montarTexto(e: EntradaDoTexto & { inicioJanela?: string }): string {
  return montarMensagens({ ...e, inicioJanela: e.inicioJanela ?? e.data }).join('\n\n');
}


export interface RespostaDoRelatorio {
  data: string;
  geradoEm: string;
  duracaoMs: number;
  texto: string;
  /** o mesmo conteúdo de `texto`, uma mensagem de WhatsApp por item: [placar do dia, análise 7 dias] */
  mensagens: string[];
  janela: { de: string; ate: string };
  totais: TotaisDaRede;
  totaisAnalise: AnaliseUnidade;
  unidades: UnidadeRelatada[];
  semFranquia: string[];
  /** o n8n usa isto para decidir se manda o relatório ou avisa o João antes */
  saude: { unidades: number; falhas: number; completo: boolean };
}

/**
 * O corpo exato que a rota devolve. Existe separado do controller para que o handler de produção e
 * o servidor de teste local (scripts/relatorio-rede-mock.ts) montem a resposta pelo MESMO código —
 * quem testa no Swagger local vê o contrato real, não uma imitação dele.
 */
export function montarResposta(e: { data: string; inicioJanela: string; unidades: UnidadeRelatada[]; semFranquia: string[]; inicioMs: number }): RespostaDoRelatorio {
  const falhas = e.unidades.reduce((n, u) => n + u.falhas.length, 0);
  const mensagens = montarMensagens({ data: e.data, inicioJanela: e.inicioJanela, unidades: e.unidades, semFranquia: e.semFranquia });
  return {
    data: e.data,
    geradoEm: new Date().toISOString(),
    duracaoMs: Date.now() - e.inicioMs,
    texto: mensagens.join('\n\n'),
    mensagens,
    janela: { de: e.inicioJanela, ate: e.data },
    totais: totaisDaRede(e.unidades),
    totaisAnalise: somarAnalises(e.unidades.filter((u) => u.analise).map((u) => u.analise!)),
    unidades: e.unidades,
    semFranquia: e.semFranquia,
    saude: { unidades: e.unidades.length, falhas, completo: falhas === 0 },
  };
}

/* ───────────────────────────── coleta ───────────────────────────── */

/** O que a coleta precisa do mundo — injetado para o teste não depender de rede. */
export interface Fontes {
  /** agenda da franquia entre duas datas locais (inclusive) */
  agenda(unit: UnidadeParaColeta, de: string, ate: string): Promise<{ ok: boolean; schedules?: SpineSchedule[]; error?: string }>;
  /** tratamentos criados no dia `hoje` (AAAA-MM-DD, da clínica) */
  tratamentos(unit: UnidadeParaColeta, hoje: string): Promise<{ ok: boolean; treatments?: SpineTreatment[]; error?: string }>;
  /**
   * Cartões do Kommo: criados em [criadosDe, criadosAte] e mexidos de `mexidosDe` até agora, mais o
   * tradutor nome → id de campo desta conta. Epoch em segundos.
   */
  kommo(
    unit: UnidadeParaColeta,
    janela: { criadosDe: number; criadosAte: number; mexidosDe: number },
  ): Promise<{ criados: LeadDoKommo[]; mexidos: LeadDoKommo[]; acha: AchaCampo; truncado: boolean } | null>;  // null = unidade sem Kommo
  /** converte um instante ISO para a data local da clínica; null se não der */
  dia(unit: UnidadeParaColeta, iso: string): string | null;
  /**
   * Hoje e amanhã na clínica (AAAA-MM-DD), o epoch do começo e do fim de hoje, e o começo da janela de
   * 7 dias (hoje e os 6 anteriores) — como data e como epoch.
   */
  calendario(
    unit: UnidadeParaColeta,
    data?: string,
  ): { hoje: string; amanha: string; deUnix: number; ateUnix: number; inicioJanela: string; janelaDeUnix: number };
}

export interface UnidadeParaColeta {
  slug: string;
  name: string;
  spineTimezone: string | null;
  [k: string]: unknown;
}

/**
 * Uma unidade. Cada fonte falha sozinha: o Kommo cair não apaga a agenda, e a franquia cair não
 * apaga os leads. O que falhou vai para `falhas` com a causa — a chefe vê "franquia não respondeu",
 * não um zero que parece resultado.
 */
export async function coletarUnidade(unit: UnidadeParaColeta, fontes: Fontes, data?: string): Promise<UnidadeRelatada> {
  const cal = fontes.calendario(unit, data);
  const out: UnidadeRelatada = { slug: unit.slug, nome: unit.name, leadsNovos: null, agenda: null, tratamentos: null, analise: null, falhas: [], detalhes: [] };
  const falhou = (oque: string, err: unknown) => {
    out.falhas.push(`${oque} (${motivoLegivel(err)})`);
    out.detalhes.push(`${oque}: ${String(err instanceof Error ? err.message : err).slice(0, 300)}`);
  };

  try {
    const r = await fontes.agenda(unit, cal.hoje, cal.amanha);
    if (r.ok && r.schedules) out.agenda = resumirAgenda(r.schedules, cal.hoje, cal.amanha);
    else falhou('agenda da franquia não respondeu', r.error ?? 'sem detalhe');
  } catch (err) {
    falhou('agenda da franquia não respondeu', err);
  }

  try {
    const r = await fontes.tratamentos(unit, cal.hoje);
    if (r.ok && r.treatments) out.tratamentos = resumirTratamentos(r.treatments, cal.hoje, (iso) => fontes.dia(unit, iso));
    else falhou('tratamentos da franquia não responderam', r.error ?? 'sem detalhe');
  } catch (err) {
    falhou('tratamentos da franquia não responderam', err);
  }

  try {
    // "mexidos" vai até AGORA, não até o fim da janela: o Kommo filtra pela ÚLTIMA alteração, então
    // num relatório de dia passado um cartão mexido depois da janela sumiria se o corte fosse no fim dela.
    const k = await fontes.kommo(unit, { criadosDe: cal.janelaDeUnix, criadosAte: cal.ateUnix, mexidosDe: cal.janelaDeUnix });
    if (!k) {
      out.semKommo = true;
      return out;
    }
    out.leadsNovos = k.criados.filter((l) => (l.created_at ?? 0) >= cal.deUnix && (l.created_at ?? 0) <= cal.ateUnix).length;
    out.analise = analisar({ criados: k.criados, mexidos: k.mexidos, acha: k.acha, deUnix: cal.janelaDeUnix, ateUnix: cal.ateUnix, truncado: k.truncado });
  } catch (err) {
    falhou('Kommo não respondeu', err);
  }
  return out;
}

/**
 * Uma unidade lenta não pode segurar o relatório de todas. O Spine tem timeout de 30 s POR chamada e
 * cada unidade faz várias: sem um teto, uma franquia sonolenta atrasaria o relatório das 18h inteiro.
 * Estourou o teto, a unidade entra com aviso — a chamada pendurada termina sozinha depois, sem efeito.
 */
function comLimite(u: UnidadeParaColeta, trabalho: Promise<UnidadeRelatada>, ms: number): Promise<UnidadeRelatada> {
  let timer: NodeJS.Timeout;
  const estouro = new Promise<UnidadeRelatada>((resolve) => {
    timer = setTimeout(
      () => resolve({ slug: u.slug, nome: u.name, leadsNovos: null, agenda: null, tratamentos: null, analise: null,
        falhas: [`demorou mais de ${Math.round(ms / 1000)} s para responder, ficou de fora`], detalhes: [`teto de ${ms} ms estourado`] }),
      ms,
    );
  });
  return Promise.race([trabalho, estouro]).finally(() => clearTimeout(timer));
}

/**
 * A rede inteira, SEM paralelismo além de `simultaneas`. O Kommo já bloqueou o IP desta VPS por
 * rajada de chamadas; 14 unidades em paralelo repetiria isso. `pausaMs` espaça o início de cada uma.
 */
export async function coletarRede(
  unidades: UnidadeParaColeta[],
  fontes: Fontes,
  opts: { data?: string; simultaneas?: number; pausaMs?: number; limiteUnidadeMs?: number } = {},
): Promise<UnidadeRelatada[]> {
  const fila = [...unidades];
  const feitas: UnidadeRelatada[] = [];
  const n = Math.max(1, opts.simultaneas ?? 2);
  const pausa = opts.pausaMs ?? 400;
  const limite = opts.limiteUnidadeMs ?? 75_000;
  const trabalhador = async () => {
    for (;;) {
      const u = fila.shift();
      if (!u) return;
      const trabalho = coletarUnidade(u, fontes, opts.data);
      feitas.push(await comLimite(u, trabalho, limite));
      // Estourou o teto? O resultado já foi com aviso, mas as chamadas dela seguem no ar. Esperar que
      // terminem antes de pegar a próxima é o que garante no máximo `simultaneas` unidades batendo no
      // Kommo ao mesmo tempo — rajada já bloqueou o IP da VPS. (Cada chamada tem timeout próprio.)
      await trabalho.catch(() => undefined);
      if (pausa > 0) await new Promise((r) => setTimeout(r, pausa));
    }
  };
  await Promise.all(Array.from({ length: n }, trabalhador));
  return feitas;
}
