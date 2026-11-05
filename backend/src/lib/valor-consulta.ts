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
 * o valor da franquia é o do TRATAMENTO). Então não existe um segundo escritor para brigar com este.
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { ehAvaliacao } from './franquia-sync.js';
import { automacaoLigada, type Estado } from './automacoes-estado.js';
import { valorDaConsultaNoDia } from '../agent/pagamento-da-unidade.js';

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
}

export type MotivoDeNaoGravar =
  | 'desligado'
  | 'sem-campo'
  | 'campo-sem-numero'
  | 'sem-consulta-por-vir'
  | 'ja-preenchido'
  | 'sem-preco';

export type DecisaoValorDaConsulta =
  | { acao: 'nada'; motivo: MotivoDeNaoGravar }
  | { acao: 'gravar' | 'gravaria'; valor: number; motivo: string };

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

/** Decide o que fazer com o campo deste cartão. Puro: a ordem dos testes é a ordem dos motivos que o log mostra. */
export function decidirValorDaConsulta(e: EntradaValorDaConsulta): DecisaoValorDaConsulta {
  if (e.estado === 'desligado') return { acao: 'nada', motivo: 'desligado' };
  if (e.tipoDoCampo === null) return { acao: 'nada', motivo: 'sem-campo' };
  if (!TIPOS_QUE_ACEITAM_NUMERO.includes(e.tipoDoCampo)) return { acao: 'nada', motivo: 'campo-sem-numero' };
  if (!avaliacaoPorVir(e.consulta, e.consultaEpoch, e.agoraEpoch)) return { acao: 'nada', motivo: 'sem-consulta-por-vir' };
  if (e.noCartao !== null && e.noCartao.trim() !== '') return { acao: 'nada', motivo: 'ja-preenchido' };
  const valor = precoEmNumero(e.preco);
  if (valor === null) return { acao: 'nada', motivo: 'sem-preco' };
  const motivo = 'avaliação marcada e campo vazio (preço das fontes da unidade)';
  return { acao: e.estado === 'seco' || e.secoGlobal ? 'gravaria' : 'gravar', valor, motivo };
}

/**
 * O robô vai preencher o Valor da Consulta nesta unidade? Ligado (não seco), com o sincronizador também ligado — é ele
 * quem roda a regra — e com o preço nas fontes. É a pergunta do guia da Ponte: só então ele deixa de pedir o campo à
 * SDR. O worker decide cartão a cartão com `decidirValorDaConsulta`; esta é a condição da UNIDADE.
 */
export function valorDaConsultaVemDoRobo(unit: { slug: string; sourceProdutos?: string | null }): boolean {
  return (
    automacaoLigada(unit.slug, 'valor-consulta', process.env.VALOR_CONSULTA_SLUGS) &&
    automacaoLigada(unit.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS) &&
    valorDaConsultaNoDia(unit.sourceProdutos) !== null
  );
}
