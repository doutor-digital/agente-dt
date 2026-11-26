/**
 * «Preço único» — um valor em R$ na resposta da Sofia do CRM que NÃO está na configuração de preços da unidade não sai (reclamação das
 * unidades, 26/11/2026: «preço errado»).
 *
 * O guardrail de saída (`agent/guardrail.ts`) já TROCA o valor errado pelo «mais próximo» da ficha — e foi o que trocou «sinal de R$ 50» por
 * «R$ 250» 34 vezes em 30 dias (#408). Trocar às cegas ainda deixa sair uma frase que ninguém escreveu. Esta é a segunda linha, só da Sofia do
 * CRM: olha a resposta do MODELO (antes do guardrail) e, se sobrou qualquer R$ que não é da unidade, a mensagem é SEGURADA — não vai ao paciente
 * (só um aviso curto de que a equipe confere o valor), a conversa passa para a equipe e a nota privada traz o que ela ia dizer.
 *
 * O que é «da unidade» (a mesma ficha que o guardrail lê, sem regra nova): os R$ das fontes (`sourceProdutos`, `sourcePapel`, `sourceNegocio`),
 * os preços achados por `precosDaConsulta` e o sinal (`sinalDaUnidade` / a ficha). Parcela de um valor da ficha (÷ 2 a 12, ±R$ 2) vale, como no
 * guardrail; valor abaixo de R$ 20 não é preço de consulta; o R$ que é DO PACIENTE («o comprovante mostra R$ 50») ou que a Sofia NEGA («não
 * R$ 450») não conta. Unidade sem nenhum R$ na ficha não tem com o que comparar: nada é segurado (igual ao guardrail).
 *
 * Chave `chatwoot-preco-unico` (CHATWOOT_PRECO_UNICO_SLUGS) por unidade, nasce em «só no papel»: registra o que seguraria e deixa a mensagem sair
 * como sai hoje. Ligada, segura de verdade.
 */
import type { Unit } from '@prisma/client';
import { precosDaConsulta, sinalDaUnidade } from '../agent/prompt-composer.js';
import { sinalDeclaradoNaFicha } from '../agent/guardrail.js';
import { convenioDaUnidade } from '../agent/preco-convenio.js';
import { unidadeSemAntecipado, valorDaConsultaNoDia } from '../agent/pagamento-da-unidade.js';
import { posicoesDeValorDoPaciente, posicoesDeValorNegado } from '../agent/valor-do-paciente.js';

export const ID_PRECO_UNICO = 'chatwoot-preco-unico';

/** O que o paciente lê quando a mensagem é segurada: nada de número, só a promessa de conferir. */
export const AVISO_DE_PRECO_SEGURADO = 'Sobre o valor, deixa eu confirmar direito com a nossa equipe pra não te passar informação errada 🙏 Já te falo por aqui, tá bem?';

const VALOR = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/gi;
/** só vale como preço de consulta/valor de pagamento a partir daqui (o guardrail usa o mesmo corte) */
const PISO = 20;
/** a frase fala de parcela («12x de R$ 29,17», «parcelado», «por mês»): só aí um valor que é fração da consulta vale */
const FALA_DE_PARCELA = /\d+\s*x\b|parcel|vezes|por\s+m[eê]s|mensa(?:l|is)|prestac/i;

/** O valor exato (com centavos) de um achado do `VALOR`, arredondado a 2 casas para comparar sem ruído de ponto flutuante. */
const valorDe = (m: RegExpMatchArray): number => Math.round(Number(`${m[1]!.replace(/\./g, '')}.${m[2] ?? '00'}`) * 100) / 100;

function valoresDe(...textos: Array<string | null | undefined>): Set<number> {
  const set = new Set<number>();
  for (const t of textos) {
    if (!t) continue;
    for (const m of t.matchAll(VALOR)) {
      const n = valorDe(m);
      if (Number.isFinite(n) && n > 0) set.add(n);
    }
  }
  return set;
}

/** Os valores (em R$, com centavos) que são DESTA unidade. Vazio = a ficha não tem preço: nada a conferir. */
export function precosDaUnidade(unit: Pick<Unit, 'sourceProdutos' | 'sourcePapel' | 'sourceNegocio' | 'systemPrompt'> & Partial<Unit>): Set<number> {
  const ficha = valoresDe(unit.sourceProdutos, unit.sourcePapel, unit.sourceNegocio);
  if (ficha.size === 0) return ficha;
  const aprovados = new Set(ficha);
  const p = precosDaConsulta(unit as Unit);
  if (p) {
    aprovados.add(p.antecipado);
    aprovados.add(p.noDia);
    // taxa de reserva obrigatória: o TOTAL («R$ 350 no total — R$ 100 antecipado + R$ 250 no dia») é a frase que o próprio prompt manda dizer
    if (unit.spineBookingRequiresPayment) aprovados.add(total2(p.antecipado + p.noDia));
    const conv = convenioDaUnidade(unit as Unit, p);
    if (conv != null) aprovados.add(conv);
  }
  const daFlag = sinalDaUnidade(unit as Unit);
  if (daFlag) for (const v of [daFlag.sinal, daFlag.comSinal, daFlag.noDia, daFlag.restoNoDia]) aprovados.add(v);
  const daFicha = daFlag ? null : sinalDeclaradoNaFicha(unit, p?.antecipado);
  if (daFicha) {
    aprovados.add(daFicha.sinal);
    aprovados.add(daFicha.restoNoDia);
  }
  return aprovados;
}

/** soma/arredonda a 2 casas: 100 + 250 = 350, sem ruído de ponto flutuante */
const total2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Os totais da consulta (não o sinal nem o resto do sinal): só deles se tira parcela. Com taxa de reserva obrigatória o total é antecipado + no dia
 * (R$ 350, parcelável); sem pagamento antecipado `precosDaConsulta` é nulo e o total é o valor da consulta «no dia» da ficha (R$ 350 → «2x de R$ 175»).
 */
function totaisDaConsulta(unit: Pick<Unit, 'sourceProdutos' | 'systemPrompt'> & Partial<Unit>): number[] {
  const p = precosDaConsulta(unit as Unit);
  const sinal = sinalDaUnidade(unit as Unit);
  // taxa de reserva: só o TOTAL se parcela (a taxa e o resto são partes dele: «2x de R$ 125» seria o resto de R$ 250 dividido, não a consulta)
  if (p && unit.spineBookingRequiresPayment) return [total2(p.antecipado + p.noDia)];
  const totais = [p?.antecipado, p?.noDia, sinal?.comSinal, sinal?.noDia].filter((v): v is number => typeof v === 'number');
  if (unidadeSemAntecipado(unit)) {
    const noDia = valorDaConsultaNoDia(unit.sourceProdutos);
    if (noDia) totais.push(Number(noDia.replace(/\./g, '').replace(',', '.')));
  }
  return totais;
}

/** parcela de um total da consulta (÷ 2 a 12, ±R$ 2 — a folga do guardrail), e só em frase que fala de parcela */
function ehParcela(v: number, totais: number[], frase: string): boolean {
  if (!FALA_DE_PARCELA.test(frase)) return false;
  for (const total of totais) for (let n = 2; n <= 12; n++) if (Math.abs(Math.round(total / n) - v) <= 2) return true;
  return false;
}

/** A frase (até ponto final, !, ? ou quebra de linha) em que está o valor que começa em `pos`. */
function fraseEm(texto: string, pos: number): string {
  const ini = Math.max(texto.lastIndexOf('\n', pos), texto.lastIndexOf('. ', pos), texto.lastIndexOf('! ', pos), texto.lastIndexOf('? ', pos)) + 1;
  const fim = texto.slice(pos).search(/[.!?]\s|\n/);
  return texto.slice(ini, fim < 0 ? texto.length : pos + fim);
}

/**
 * Os valores em R$ da `resposta` que não são desta unidade (com centavos, sem repetir, em ordem de aparição). Vazio = pode sair.
 * `resposta` é a fala do MODELO, antes do guardrail. «R$ 350,99» NÃO é o «R$ 350» da ficha.
 */
export function valoresForaDaConfiguracao(resposta: string, unit: Pick<Unit, 'sourceProdutos' | 'sourcePapel' | 'sourceNegocio' | 'systemPrompt'> & Partial<Unit>): number[] {
  if (!resposta || !/R\$/i.test(resposta)) return [];
  const aprovados = precosDaUnidade(unit);
  if (aprovados.size === 0) return [];
  const totais = totaisDaConsulta(unit);
  const doPaciente = posicoesDeValorDoPaciente(resposta);
  for (const pos of posicoesDeValorNegado(resposta)) doPaciente.add(pos);
  const fora: number[] = [];
  for (const m of resposta.matchAll(VALOR)) {
    const pos = m.index ?? -1;
    if (doPaciente.has(pos)) continue;
    const v = valorDe(m);
    if (!Number.isFinite(v) || v < PISO || aprovados.has(v) || ehParcela(v, totais, fraseEm(resposta, pos))) continue;
    if (!fora.includes(v)) fora.push(v);
  }
  return fora;
}

/** «R$ 280» ou «R$ 350,99» */
export const textoDoValor = (v: number): string => `R$ ${Number.isInteger(v) ? v : v.toFixed(2).replace('.', ',')}`;
export const textoDosValores = (valores: readonly number[]): string => valores.map(textoDoValor).join(', ');
