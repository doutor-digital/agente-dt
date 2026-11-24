/**
 * O que está POR TRÁS de cada número do painel da Sofia (tela Agente): ao clicar no card, a lista de conversas daquele número no período
 * escolhido, com «Abrir conversa». Só dado que o backend já guarda:
 *
 *   respondidas  → `sofia_mensagem`: uma linha por conversa (a última resposta, quantas respostas)
 *   marcaram     → `sofia_evento` «marcou» de conversas que ela respondeu no período (o mesmo filtro do número)
 *   equipe       → `sofia_evento` «equipe» (uma linha por conversa; o motivo é de outro PR)
 *   pix          → `sofia_evento` «pix» + a linha do sinal (`sinais_pix`, chave sintética `2 bilhões + conversa`): valor, gerado quando e a
 *                  situação PAGO / PENDENTE / VENCIDO. Nunca o link nem a chave Pix.
 *   fora         → respostas antes das 8h, a partir das 18h, sábado e domingo
 *   avaliacoes   → `sofia_avaliacao` (👍/👎 da equipe), com quem avaliou
 *
 * O nome do paciente só existe quando a Sofia marcou consulta (`sofia_evento.nome`); nas outras linhas a tela mostra «Conversa N».
 * Mesma unidade (slug) e mesma conta/caixas da pessoa: a rota passa por `atendenteDaUnidade`.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { fusoDaUnidade } from './fuso.js';
import { BASE_LEAD_CHATWOOT } from './chatwoot-lead.js';
import { instanteLocal } from './sinal-pix.js';
import { foraDoHorario, janelas, partesLocais, type Periodo } from './agente-painel.js';

export const MEDIDAS = ['respondidas', 'marcaram', 'equipe', 'pix', 'fora', 'avaliacoes'] as const;
export type Medida = (typeof MEDIDAS)[number];
export const lerMedida = (v: unknown): Medida | null => (typeof v === 'string' && (MEDIDAS as readonly string[]).includes(v) ? (v as Medida) : null);

/** teto de linhas devolvidas por lista; o total real vai junto para a tela avisar do corte */
export const MAX_LINHAS_DE_DETALHE = 300;
/** o evento do Pix é gravado depois do sinal; esta folga só cobre relógios que não batem por segundos */
const FOLGA_DEPOIS_MS = 2 * 60_000;

export type SituacaoDoPix = 'pago' | 'pendente' | 'vencido';

export interface LinhaDeDetalhe {
  conversa: number;
  nome: string | null;
  /** ISO: o momento que o número conta (última resposta, consulta marcada, passagem, Pix, avaliação) */
  quando: string;
  detalhe: string | null;
  /** avaliacoes */
  nota?: 'boa' | 'ruim';
  quem?: string;
  /** marcaram: «AAAA-MM-DDTHH:mm» da consulta */
  consultaEm?: string | null;
  /** pix: valor e situação (null = não achei a linha do sinal desta conversa) */
  pix?: { valorCentavos: number | null; situacao: SituacaoDoPix | null; geradoEm: string | null; pagoEm: string | null };
}

export interface Detalhe {
  medida: Medida;
  periodo: Periodo;
  /** quantas linhas (conversas; avaliações em `avaliacoes`) a lista tem de verdade */
  total: number;
  /** fora: o NÚMERO DO CARD conta respostas (169 de 412), a lista tem uma linha por conversa; aqui vão as respostas para o total bater com o card */
  totalRespostas?: number;
  linhas: LinhaDeDetalhe[];
  /** pix: quantas em cada situação */
  situacoes?: { pago: number; pendente: number; vencido: number; semRegistro: number };
}

export interface EntradaDoDetalhe {
  respostas: ReadonlyArray<{ conversa: number; criadoEm: Date }>;
  eventos: ReadonlyArray<{ conversa: number; tipo: string; nome: string | null; detalhe: string | null; criadoEm: Date }>;
  avaliacoes: ReadonlyArray<{ conversa: number; nota: string; quemNome: string; texto: string | null; criadoEm: Date }>;
  /** `sinais_pix` das conversas dos Pix do período */
  sinais: ReadonlyArray<{ leadId: string; status: string; venceEm: string; consultaEm: string; valorCentavos: number; criadoEm: Date; pagoEm: Date | null }>;
  agora: Date;
  periodo: Periodo;
  fuso: string;
}

/** PAGO / PENDENTE / VENCIDO: pago = o Asaas baixou; expirado ou passou do último dia do link = vencido; pendente dentro da validade = pendente. Status que não conheço = null (sem registro): nunca vira «para cobrar». */
export function situacaoDoPix(s: { status: string; venceEm: string }, hoje: string): SituacaoDoPix | null {
  if (s.status === 'pago') return 'pago';
  if (s.status === 'expirado') return 'vencido';
  if (s.status !== 'pendente') return null;
  return hoje > s.venceEm ? 'vencido' : 'pendente';
}

const maisRecente = <T extends { criadoEm: Date }>(l: readonly T[]): T[] => [...l].sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());

export function montarDetalhe(medida: Medida, e: EntradaDoDetalhe): Detalhe {
  const j = janelas(e.agora, e.periodo, e.fuso);
  const t = e.agora.getTime();
  const noPeriodo = (d: Date) => d.getTime() >= j.inicio.getTime() && d.getTime() <= t;
  const nomes = new Map<number, string>();
  for (const v of e.eventos) if (v.nome && !nomes.has(v.conversa)) nomes.set(v.conversa, v.nome);
  const respostas = maisRecente(e.respostas.filter((r) => noPeriodo(r.criadoEm)));
  const eventos = (tipo: string) => maisRecente(e.eventos.filter((v) => v.tipo === tipo && noPeriodo(v.criadoEm)));
  /** uma linha por conversa: a mais recente de cada */
  const porConversa = <T extends { conversa: number }>(l: readonly T[]): T[] => {
    const vistas = new Set<number>();
    return l.filter((x) => (vistas.has(x.conversa) ? false : (vistas.add(x.conversa), true)));
  };
  const base = (conversa: number, quando: Date, detalhe: string | null = null): LinhaDeDetalhe => ({ conversa, nome: nomes.get(conversa) ?? null, quando: quando.toISOString(), detalhe });
  let linhas: LinhaDeDetalhe[] = [];
  const out: Pick<Detalhe, 'situacoes' | 'totalRespostas'> = {};

  if (medida === 'respondidas' || medida === 'fora') {
    const alvo = medida === 'fora' ? respostas.filter((r) => foraDoHorario(r.criadoEm, e.fuso)) : respostas;
    const contagem = new Map<number, number>();
    for (const r of alvo) contagem.set(r.conversa, (contagem.get(r.conversa) ?? 0) + 1);
    linhas = porConversa(alvo).map((r) => {
      const n = contagem.get(r.conversa) ?? 1;
      return base(r.conversa, r.criadoEm, n === 1 ? '1 resposta' : `${n} respostas`);
    });
    if (medida === 'fora') out.totalRespostas = alvo.length;
  } else if (medida === 'marcaram') {
    const quem = new Set(respostas.map((r) => r.conversa));
    linhas = eventos('marcou')
      .filter((v) => quem.has(v.conversa))
      .map((v) => ({ ...base(v.conversa, v.criadoEm), consultaEm: v.detalhe }));
    linhas = porConversa(linhas);
  } else if (medida === 'equipe') {
    linhas = porConversa(eventos('equipe')).map((v) => base(v.conversa, v.criadoEm));
  } else if (medida === 'pix') {
    const hoje = partesLocais(e.agora, e.fuso).dia;
    const sit = { pago: 0, pendente: 0, vencido: 0, semRegistro: 0 };
    linhas = porConversa(eventos('pix')).map((v) => {
      const lead = String(BASE_LEAD_CHATWOOT + v.conversa);
      // o sinal que VALIA na hora do evento (a mesma regra de `gerarSinalPix`): criado antes do Pix sair, de uma consulta que ainda não tinha passado
      // (`consulta_em` >= o instante do Pix, no fuso da unidade), ainda dentro da validade (`vence_em` >= o dia do Pix) e o mais recente. Pix reenviado
      // reaproveita o link pendente de dias antes, e é ESSE que casa. «criando» é reserva que o Asaas ainda não respondeu (ou que falhou): não é Pix
      // que o paciente recebeu.
      const t0 = v.criadoEm.getTime();
      const diaDoEvento = partesLocais(v.criadoEm, e.fuso).dia;
      const instante = instanteLocal(v.criadoEm, e.fuso);
      const s = maisRecente(e.sinais.filter((x) => x.leadId === lead && x.status !== 'criando' && x.criadoEm.getTime() <= t0 + FOLGA_DEPOIS_MS && x.venceEm >= diaDoEvento && x.consultaEm >= instante))[0] ?? null;
      const situacao = s ? situacaoDoPix(s, hoje) : null; // sem sinal, ou com status que não conheço: sem registro
      if (situacao) sit[situacao] += 1;
      else sit.semRegistro += 1;
      return { ...base(v.conversa, v.criadoEm), pix: { valorCentavos: s?.valorCentavos ?? null, situacao, geradoEm: s?.criadoEm.toISOString() ?? null, pagoEm: s?.pagoEm?.toISOString() ?? null } };
    });
    out.situacoes = sit;
  } else {
    linhas = maisRecente(e.avaliacoes.filter((a) => noPeriodo(a.criadoEm))).map((a) => ({
      ...base(a.conversa, a.criadoEm, a.texto ? a.texto.slice(0, 200) : null),
      nota: a.nota === 'boa' ? ('boa' as const) : ('ruim' as const),
      quem: a.quemNome,
    }));
  }
  return { medida, periodo: e.periodo, total: linhas.length, linhas: linhas.slice(0, MAX_LINHAS_DE_DETALHE), ...out };
}

/** Lê o que a lista precisa (só o período, só a unidade) e monta. */
export async function detalheDaUnidade(unit: Pick<Unit, 'id' | 'slug' | 'spineTimezone' | 'businessHoursTimezone'>, periodo: Periodo, medida: Medida, agora = new Date()): Promise<Detalhe> {
  const fuso = fusoDaUnidade(unit);
  const desde = janelas(agora, periodo, fuso).inicio;
  const where = { unitSlug: unit.slug, criadoEm: { gte: desde } };
  const [respostas, eventos, avaliacoes] = await Promise.all([
    medida === 'respondidas' || medida === 'fora' || medida === 'marcaram' ? prisma.sofiaMensagem.findMany({ where, select: { conversa: true, criadoEm: true } }) : Promise.resolve([]),
    // só os eventos da medida (+ «marcou», que é o único que traz o nome); as avaliações não precisam deles
    medida === 'avaliacoes' ? Promise.resolve([]) : prisma.sofiaEvento.findMany({ where: { ...where, tipo: { in: medida === 'equipe' || medida === 'pix' ? [medida, 'marcou'] : ['marcou'] } }, select: { conversa: true, tipo: true, nome: true, detalhe: true, criadoEm: true } }),
    medida === 'avaliacoes' ? prisma.sofiaAvaliacao.findMany({ where, select: { conversa: true, nota: true, quemNome: true, texto: true, criadoEm: true } }) : Promise.resolve([]),
  ]);
  let sinais: EntradaDoDetalhe['sinais'] = [];
  if (medida === 'pix') {
    const leads = [...new Set(eventos.filter((v) => v.tipo === 'pix').map((v) => String(BASE_LEAD_CHATWOOT + v.conversa)))].slice(0, 1000);
    // só as linhas DESTA unidade (unit_id) e só das conversas dos Pix do período; nunca o link (`url`) nem o id do link
    if (leads.length) sinais = await prisma.sinalPix.findMany({ where: { unitId: unit.id, leadId: { in: leads } }, select: { leadId: true, status: true, venceEm: true, consultaEm: true, valorCentavos: true, criadoEm: true, pagoEm: true }, orderBy: { criadoEm: 'desc' }, take: 3000 });
  }
  return montarDetalhe(medida, { respostas, eventos, avaliacoes, sinais, agora, periodo, fuso });
}
