/**
 * Monta o texto do resumo de qualidade da Sofia. PURO: recebe números, devolve texto. Não fala com banco,
 * nem com Telegram, nem com relógio — é o que o teste exercita.
 *
 * Princípio (medido em 27/10/2026): a média do juiz mente, porque ~77% das notas baixas não são falha da
 * Sofia (ela nem falou; o paciente sumiu depois da 1ª fala). Então a nota só vale sobre as conversas
 * "avaliáveis" e o texto diz sempre quantas ficaram de fora e por quê.
 */
import { SINAIS_ZERADOS, totalDeSinais, type Sinais } from './sinais.js';
import { rotuloDoDia, somarDias } from './dias.js';
import type { DadosDiarios, DadosSemanais, DiaAvaliado, DiaMensagens, FaixaDeNota, UnidadeNota } from './tipos.js';

// ── limiares: o que é "piorou" ─────────────────────────────────────────────────────────────────────
/** O juiz parou se avaliou menos que esta fração da média diária dos 7 dias anteriores (25/10 foi o caso). */
export const FRACAO_JUIZ_PAROU = 0.5;
/** Queda de nota (0 a 10) que conta como piora. */
export const QUEDA_DE_NOTA = 0.5;
/** Só compara nota com pelo menos isto de conversas avaliáveis de cada lado — abaixo é ruído. */
export const MIN_AVALIAVEIS_PARA_COMPARAR = 10;
/** Alta de pontos percentuais que conta como piora (Sofia sem falar, mensagens vazias). */
export const ALTA_DE_PONTOS = 5;
/** Só compara taxa com pelo menos isto de conversas / mensagens no denominador. */
export const MIN_CONVERSAS_PARA_TAXA = 20;
export const MIN_MENSAGENS_PARA_TAXA = 50;
/**
 * Sinais de erro: piorou se ontem ≥ 1,5× o ESPERADO para o movimento do dia (taxa dos 7 dias × mensagens da Sofia
 * ontem) E pelo menos 5 acima dele. Pela taxa, e não pela contagem, para que dia de muito movimento não pareça dia ruim.
 */
export const FATOR_SINAIS = 1.5;
export const SALTO_MINIMO_SINAIS = 5;
export const MIN_MENSAGENS_SOFIA_PARA_TAXA = 50;

// ── formatação ─────────────────────────────────────────────────────────────────────────────────────
export function num1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
}
function inteiro(n: number): string {
  return Math.round(n).toLocaleString('pt-BR');
}
export function pct(parte: number, todo: number): string {
  return todo > 0 ? `${Math.round((parte / todo) * 100)}%` : '–';
}
function taxa(parte: number, todo: number): number | null {
  return todo > 0 ? (parte / todo) * 100 : null;
}

// ── agregação ──────────────────────────────────────────────────────────────────────────────────────
export interface TotaisDeAvaliacao {
  total: number;
  semSofia: number;
  sumiu: number;
  avaliaveis: number;
  /** Média ponderada pelas avaliáveis de cada dia; null quando não houve nenhuma. */
  media: number | null;
}

export function somarAvaliacoes(dias: readonly DiaAvaliado[]): TotaisDeAvaliacao {
  let soma = 0;
  const t = { total: 0, semSofia: 0, sumiu: 0, avaliaveis: 0 };
  for (const d of dias) {
    t.total += d.total;
    t.semSofia += d.semSofia;
    t.sumiu += d.sumiu;
    t.avaliaveis += d.avaliaveis;
    if (d.mediaAvaliaveis !== null) soma += d.mediaAvaliaveis * d.avaliaveis;
  }
  return { ...t, media: t.avaliaveis > 0 ? soma / t.avaliaveis : null };
}

export interface TotaisDeMensagens {
  conversas: number;
  semSofia: number;
  mensagens: number;
  vazias: number;
  mensagensSofia: number;
  sinais: Sinais;
}

export function somarMensagens(dias: readonly DiaMensagens[]): TotaisDeMensagens {
  const t: TotaisDeMensagens = { conversas: 0, semSofia: 0, mensagens: 0, vazias: 0, mensagensSofia: 0, sinais: { ...SINAIS_ZERADOS } };
  for (const d of dias) {
    t.conversas += d.conversasComPaciente;
    t.semSofia += d.conversasSemSofia;
    t.mensagens += d.mensagensPaciente;
    t.vazias += d.mensagensPacienteVazias;
    t.mensagensSofia += d.mensagensSofia;
    t.sinais.repetidas += d.sinais.repetidas;
    t.sinais.vazamento += d.sinais.vazamento;
    t.sinais.falha += d.sinais.falha;
  }
  return t;
}

const doDia = <T extends { dia: string }>(lista: readonly T[], dia: string): T[] => lista.filter((x) => x.dia === dia);
const entre = <T extends { dia: string }>(lista: readonly T[], de: string, ate: string): T[] =>
  lista.filter((x) => x.dia >= de && x.dia <= ate);

function detalheDosSinais(s: Sinais): string {
  return `repetidas ${s.repetidas}, raciocínio vazado ${s.vazamento}, "não consegui/instabilidade/não entendi" ${s.falha}`;
}

function linhaDePiores(piores: readonly UnidadeNota[], rotulo: string): string {
  if (piores.length === 0) return `${rotulo}: nenhuma unidade com conversas avaliáveis suficientes.`;
  return `${rotulo}: ${piores.map((u) => `${u.nome} ${num1(u.media)} (${u.avaliaveis})`).join(' · ')}`;
}

// ── diário ─────────────────────────────────────────────────────────────────────────────────────────
export interface Veredito {
  /** Frases curtas do que piorou; vazio = tudo igual ao normal. */
  alertas: string[];
}

/** O que mudou, comparando ontem com a véspera e com os 7 dias anteriores a ontem. Puro. */
export function avaliarDia(d: DadosDiarios): Veredito {
  const alertas: string[] = [];
  const ontem = d.dia;
  const vespera = somarDias(ontem, -1);
  const base = { de: somarDias(ontem, -7), ate: somarDias(ontem, -1) };

  const av = somarAvaliacoes(doDia(d.avaliacoes, ontem));
  const avVespera = somarAvaliacoes(doDia(d.avaliacoes, vespera));
  const av7 = somarAvaliacoes(entre(d.avaliacoes, base.de, base.ate));
  const mediaDiaria = av7.total / 7;
  // Domingo e segunda têm menos conversas que quinta: só vira "parou" se também ficou abaixo da metade do mesmo
  // dia da semana passada (quando houve avaliação nele).
  const mesmoDiaSemanaPassada = somarAvaliacoes(doDia(d.avaliacoes, somarDias(ontem, -7))).total;
  const abaixoDoMesmoDia = mesmoDiaSemanaPassada <= 0 || av.total < mesmoDiaSemanaPassada * FRACAO_JUIZ_PAROU;

  if (mediaDiaria > 0 && av.total < mediaDiaria * FRACAO_JUIZ_PAROU && abaixoDoMesmoDia) {
    alertas.push(
      av.total === 0
        ? `o juiz não avaliou nada ontem (média de ${inteiro(mediaDiaria)} por dia) — pode ter parado`
        : `o juiz avaliou só ${inteiro(av.total)} conversas (média de ${inteiro(mediaDiaria)} por dia) — pode ter parado`,
    );
  }

  if (av.media !== null && av.avaliaveis >= MIN_AVALIAVEIS_PARA_COMPARAR) {
    if (avVespera.media !== null && avVespera.avaliaveis >= MIN_AVALIAVEIS_PARA_COMPARAR && av.media <= avVespera.media - QUEDA_DE_NOTA) {
      alertas.push(`nota caiu de ${num1(avVespera.media)} para ${num1(av.media)} em relação à véspera`);
    }
    if (av7.media !== null && av7.avaliaveis >= MIN_AVALIAVEIS_PARA_COMPARAR && av.media <= av7.media - QUEDA_DE_NOTA) {
      alertas.push(`nota ${num1(av.media)} está abaixo da média dos 7 dias (${num1(av7.media)})`);
    }
  }

  const m = somarMensagens(doDia(d.mensagens, ontem));
  const m7 = somarMensagens(entre(d.mensagens, base.de, base.ate));

  const semFala = taxa(m.semSofia, m.conversas);
  const semFala7 = taxa(m7.semSofia, m7.conversas);
  if (semFala !== null && semFala7 !== null && m.conversas >= MIN_CONVERSAS_PARA_TAXA && semFala >= semFala7 + ALTA_DE_PONTOS) {
    alertas.push(`Sofia sem falar no dia subiu para ${pct(m.semSofia, m.conversas)} das conversas (7 dias: ${pct(m7.semSofia, m7.conversas)}) — pausa ou etapa?`);
  }

  const vazias = taxa(m.vazias, m.mensagens);
  const vazias7 = taxa(m7.vazias, m7.mensagens);
  if (vazias !== null && vazias7 !== null && m.mensagens >= MIN_MENSAGENS_PARA_TAXA && vazias >= vazias7 + ALTA_DE_PONTOS) {
    alertas.push(`mensagens de paciente vazias subiram para ${pct(m.vazias, m.mensagens)} (7 dias: ${pct(m7.vazias, m7.mensagens)}) — áudio/imagem não chegando?`);
  }

  const sinais = totalDeSinais(m.sinais);
  if (m7.mensagensSofia > 0 && m.mensagensSofia >= MIN_MENSAGENS_SOFIA_PARA_TAXA) {
    const esperado = (totalDeSinais(m7.sinais) / m7.mensagensSofia) * m.mensagensSofia;
    if (sinais >= esperado * FATOR_SINAIS && sinais - esperado >= SALTO_MINIMO_SINAIS) {
      alertas.push(`sinais de erro da Sofia: ${sinais} ontem, o esperado para o movimento do dia era ${num1(esperado)}`);
    }
  }

  return { alertas };
}

export function montarDiario(d: DadosDiarios): string {
  const ontem = d.dia;
  const vespera = somarDias(ontem, -1);
  const base = { de: somarDias(ontem, -7), ate: somarDias(ontem, -1) };
  const { alertas } = avaliarDia(d);

  const av = somarAvaliacoes(doDia(d.avaliacoes, ontem));
  const avVespera = somarAvaliacoes(doDia(d.avaliacoes, vespera));
  const av7 = somarAvaliacoes(entre(d.avaliacoes, base.de, base.ate));
  const m = somarMensagens(doDia(d.mensagens, ontem));
  const m7 = somarMensagens(entre(d.mensagens, base.de, base.ate));

  const semHistorico = av7.total === 0 && m7.conversas === 0;
  const cabecalho = alertas.length
    ? `⚠️ Sofia, resumo de ${rotuloDoDia(ontem)}: piorou`
    : `Sofia, resumo de ${rotuloDoDia(ontem)}: ${semHistorico ? 'sem os 7 dias anteriores para comparar' : 'tudo igual ao normal'}`;

  const comparacoes: string[] = [];
  if (avVespera.media !== null) comparacoes.push(`véspera ${num1(avVespera.media)}`);
  if (av7.media !== null) comparacoes.push(`7 dias ${num1(av7.media)}`);
  const nota =
    av.media === null
      ? 'sem nota: nenhuma conversa avaliável'
      : `nota ${num1(av.media)} só das ${inteiro(av.avaliaveis)} avaliáveis${comparacoes.length ? ` (${comparacoes.join('; ')})` : ''}`;
  const fora =
    av.total > 0
      ? ` Ficaram fora da nota: ${inteiro(av.semSofia)} avaliações de conversas em que a Sofia nem chegou a falar, ${inteiro(av.sumiu)} em que o paciente sumiu depois da 1ª fala dela.`
      : '';
  const linhaJuiz = `Juiz: ${inteiro(av.total)} avaliadas (média dos 7 dias: ${inteiro(av7.total / 7)}); ${nota}.${fora}`;

  const s = m.sinais;
  const sinaisTotal = totalDeSinais(s);
  const linhaTaxas =
    `Conversas do dia em que o paciente escreveu e a Sofia não falou no dia: ${pct(m.semSofia, m.conversas)} · mensagens de paciente vazias: ${pct(m.vazias, m.mensagens)} · ` +
    `sinais de erro: ${sinaisTotal} (${detalheDosSinais(s)}; média dos 7 dias ${num1(totalDeSinais(m7.sinais) / 7)}).`;

  const linhas = [cabecalho, ...alertas.map((a) => `• ${a}`), linhaJuiz, linhaTaxas, linhaDePiores(d.piores, 'Piores unidades do dia')];

  // A pior conversa só entra quando algo piorou: no dia normal a mensagem tem 4 linhas.
  if (alertas.length && d.pior) {
    const p = d.pior;
    const quem = [p.primeiroNome ?? 'paciente', p.final4 ? `final ${p.final4}` : null, `cartão ${p.leadId}`].filter(Boolean).join(', ');
    linhas.push(`Pior conversa avaliável: nota ${num1(p.nota)}, ${p.unidade} (${quem})`, ...p.trecho.map((t) => `  ${t}`));
  }
  return linhas.join('\n');
}

// ── semanal ────────────────────────────────────────────────────────────────────────────────────────
const NOME_DA_FAIXA: Record<FaixaDeNota['faixa'], string> = {
  baixa: 'nota baixa (menos de 5)',
  media: 'nota média (5 a 7)',
  alta: 'nota alta (7 ou mais)',
};

export function montarSemanal(d: DadosSemanais): string {
  const fim = d.fim;
  const ini = somarDias(fim, -6);
  const antFim = somarDias(fim, -7);
  const antIni = somarDias(fim, -13);

  const av = somarAvaliacoes(entre(d.avaliacoes, ini, fim));
  const avAnt = somarAvaliacoes(entre(d.avaliacoes, antIni, antFim));
  const m = somarMensagens(entre(d.mensagens, ini, fim));
  const mAnt = somarMensagens(entre(d.mensagens, antIni, antFim));

  const linhas = [`Sofia, semana de ${rotuloDoDia(ini)} a ${rotuloDoDia(fim)}`];

  linhas.push(
    `Juiz: ${inteiro(av.total)} avaliadas (semana anterior ${inteiro(avAnt.total)}). Só ${inteiro(av.avaliaveis)} (${pct(av.avaliaveis, av.total)}) medem a Sofia; ` +
      `ficaram fora ${inteiro(av.semSofia)} avaliações de conversas em que ela nem chegou a falar e ${inteiro(av.sumiu)} em que o paciente sumiu.`,
  );
  linhas.push(
    av.media === null
      ? 'Nota média: sem conversas avaliáveis na semana.'
      : `Nota média (só avaliáveis): ${num1(av.media)}${avAnt.media !== null ? ` — semana anterior ${num1(avAnt.media)}` : ''}.`,
  );

  const faixas = d.faixas.map(
    (f) => `${NOME_DA_FAIXA[f.faixa]}: ${inteiro(f.conversas)} conversas, ${pct(f.ganhos, f.conversas)} viraram ganho, ${pct(f.comConsulta, f.conversas)} com consulta marcada`,
  );
  linhas.push('Quem converte, por faixa de nota:', ...faixas.map((f) => `  ${f}`));
  linhas.push('  (conversa recente ainda pode converter; leia a diferença entre faixas, não o valor absoluto)');

  linhas.push(
    `Conversas da semana em que o paciente escreveu e a Sofia não falou no dia: ${pct(m.semSofia, m.conversas)} (semana anterior ${pct(mAnt.semSofia, mAnt.conversas)}) · ` +
      `mensagens de paciente vazias: ${pct(m.vazias, m.mensagens)} (semana anterior ${pct(mAnt.vazias, mAnt.mensagens)}).`,
  );
  linhas.push(`Sinais de erro: ${totalDeSinais(m.sinais)} (${detalheDosSinais(m.sinais)}); semana anterior ${totalDeSinais(mAnt.sinais)}.`);
  linhas.push(linhaDePiores(d.piores, 'Piores unidades da semana'));
  return linhas.join('\n');
}
