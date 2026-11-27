/**
 * O resumo das 8h e das 18h (Brasília/Tocantins) para o João. Texto puro (o `enviarTelegram` não formata), curto, sem menu:
 * só o que tem para hoje, em ordem de prioridade, separando o que SÓ ELE pode fazer do que está com outra pessoa.
 * Função pura: recebe as demandas e a hora, devolve o texto — o worker só entrega.
 */
import { FUSO_DO_JOAO } from './config.js';
import { partesNoFuso } from '../lib/fuso.js';
import type { Demanda, Prioridade, UnidadeJoaoof } from './repo.js';

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MAX_POR_GRUPO = 8;
const MAX_LINHA = 150;

const dois = (n: number) => String(n).padStart(2, '0');

/** AAAA-MM-DD de hoje no fuso do João */
export function hojeIso(agora: Date): string {
  const p = partesNoFuso(agora, FUSO_DO_JOAO);
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
}

function diaDaSemana(iso: string): string {
  const [a, m, d] = iso.split('-').map(Number);
  return DIAS[new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay()]!;
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const RANK: Record<Prioridade, number> = { urgente: 0, alta: 1, normal: 2, baixa: 3 };

export function nomeDaUnidade(slug: string | null, unidades: UnidadeJoaoof[]): string {
  if (!slug) return 'geral';
  const u = unidades.find((x) => x.slug === slug);
  if (u) return u.nome;
  return slug.replace(/^doutor-hernia-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export interface EntradaDoResumo {
  agora: Date;
  hora: 8 | 18;
  /** abertas + em andamento */
  abertas: Demanda[];
  /** quantas foram resolvidas hoje (só o 18h usa) */
  feitasHoje?: number;
  unidades: UnidadeJoaoof[];
  /** avisos do próprio Joaoof (fonte parada, teto de gasto…) — sobem para o topo */
  alertas?: string[];
  /** pedido do João (/resumo): mostra SEMPRE as pendências, a qualquer hora, inclusive as sem pressa, e nunca devolve null */
  manual?: boolean;
}

const corta = (s: string, n: number) => {
  const l = Array.from(s);
  return l.length <= n ? s : `${l.slice(0, n - 1).join('').trimEnd()}…`;
};

function situacaoDoPrazo(d: Demanda, hoje: string): 'atrasada' | 'hoje' | 'depois' | 'sem' {
  if (!d.prazo) return 'sem';
  return d.prazo < hoje ? 'atrasada' : d.prazo === hoje ? 'hoje' : 'depois';
}

/** Vai para «hoje» quem é urgente/alta, tem prazo vencido ou para hoje, ou a unidade insiste (3+ vezes). */
export function paraHoje(d: Demanda, hoje: string): boolean {
  const s = situacaoDoPrazo(d, hoje);
  return d.prioridade === 'urgente' || d.prioridade === 'alta' || s === 'atrasada' || s === 'hoje' || d.repeticoes >= 3;
}

function pesoDe(d: Demanda, hoje: string): number {
  const s = situacaoDoPrazo(d, hoje);
  return RANK[d.prioridade] * 10 + (s === 'atrasada' ? -5 : s === 'hoje' ? -3 : 0) - Math.min(d.repeticoes, 5) * 0.1;
}

function linha(d: Demanda, hoje: string, unidades: UnidadeJoaoof[]): string {
  const etiquetas: string[] = [];
  if (d.prioridade === 'urgente') etiquetas.push('URGENTE');
  else if (d.prioridade === 'alta') etiquetas.push('alta');
  const s = situacaoDoPrazo(d, hoje);
  if (s === 'atrasada') etiquetas.push(`atrasada (${ddmm(d.prazo!)})`);
  else if (s === 'hoje') etiquetas.push('prazo hoje');
  else if (d.prazo) etiquetas.push(`prazo ${ddmm(d.prazo)}`);
  else if (d.prazoTexto) etiquetas.push(`dito: ${d.prazoTexto}`);
  if (d.repeticoes > 1) etiquetas.push(`${d.repeticoes}x`);
  const quem = d.solicitante ? ` (${d.solicitante})` : '';
  const dono = d.responsavel && d.responsavel !== 'joao' ? ` → ${d.responsavel}` : '';
  const topo = `#${d.numero} ${nomeDaUnidade(d.unidadeSlug, unidades)}${etiquetas.length ? ' · ' + etiquetas.join(' · ') : ''}`;
  return corta(`${topo} — ${d.titulo}${quem}${dono}`, MAX_LINHA);
}

function bloco(titulo: string, itens: Demanda[], hoje: string, unidades: UnidadeJoaoof[]): string[] {
  if (itens.length === 0) return [];
  const mostradas = itens.slice(0, MAX_POR_GRUPO).map((d) => `• ${linha(d, hoje, unidades)}`);
  const resto = itens.length - MAX_POR_GRUPO;
  return ['', `${titulo} (${itens.length})`, ...mostradas, ...(resto > 0 ? [`… e mais ${resto}.`] : [])];
}

/** Devolve o texto do resumo, ou null quando não há o que dizer (o 18h não manda «nada» — o 8h sempre manda, é o sinal de que está vivo). */
export function montarResumo(e: EntradaDoResumo): string | null {
  const hoje = hojeIso(e.agora);
  const cabeca = e.manual
    ? `📋 O que está aberto agora — ${diaDaSemana(hoje)}, ${ddmm(hoje)}`
    : e.hora === 8 ? `☀️ Bom dia, João — ${diaDaSemana(hoje)}, ${ddmm(hoje)}` : `🌆 Fechando o dia — ${diaDaSemana(hoje)}, ${ddmm(hoje)}`;
  const hojeLista = e.abertas.filter((d) => paraHoje(d, hoje)).sort((a, b) => pesoDe(a, hoje) - pesoDe(b, hoje) || a.criadoEm.getTime() - b.criadoEm.getTime());
  const soVoce = hojeLista.filter((d) => d.responsavel === 'joao');
  const comOutros = hojeLista.filter((d) => d.responsavel !== 'joao');
  const semPressa = e.abertas.length - hojeLista.length;
  const alertas = (e.alertas ?? []).map((a) => `⚠️ ${a}`);

  if (!e.manual && e.hora === 18 && hojeLista.length === 0 && alertas.length === 0 && !(e.feitasHoje && e.feitasHoje > 0)) return null;

  const saida: string[] = [cabeca, ...(alertas.length ? ['', ...alertas] : [])];
  if (hojeLista.length === 0) {
    saida.push('', e.abertas.length === 0 ? 'Nada pendente. Sem demanda aberta.' : e.manual ? 'Nada urgente nem com prazo para hoje.' : 'Nada urgente nem com prazo para hoje.');
  } else {
    saida.push(...bloco('SÓ VOCÊ PODE FAZER', soVoce, hoje, e.unidades), ...bloco('COM OUTRA PESSOA', comOutros, hoje, e.unidades));
  }
  if (e.hora === 18 && e.feitasHoje) saida.push('', `Resolvidas hoje: ${e.feitasHoje}.`);
  const restantes = e.abertas.filter((d) => !paraHoje(d, hoje)).sort((a, b) => pesoDe(a, hoje) - pesoDe(b, hoje) || a.criadoEm.getTime() - b.criadoEm.getTime());
  if (e.manual) saida.push(...bloco('SEM PRESSA', restantes, hoje, e.unidades));
  else if (semPressa > 0) saida.push('', `Sem pressa: ${semPressa} aberta${semPressa > 1 ? 's' : ''} (normal/baixa, sem prazo para hoje).`);
  const mostradas = [...hojeLista, ...(e.manual ? restantes : [])];
  if (mostradas.length > 0) {
    // os exemplos usam os números que estão na lista (um exemplo com número que não existe confunde)
    const n1 = mostradas[0]!.numero;
    const n2 = mostradas[1]?.numero ?? n1;
    saida.push('', `Responda do seu jeito: "feito ${n1}", "passa a ${n2} pra Lia", "prazo sexta", "isso não é demanda".`);
  }
  return saida.join('\n');
}
