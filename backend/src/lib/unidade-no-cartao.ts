/**
 * ⌂ Unidade no cartão — o campo que os modelos de WhatsApp leem (20/10/2026).
 *
 * O caso: em Balsas a clínica mandou o modelo da primeira sessão ao Aciolino (lead 28770332) e saiu
 * "Unidade: Imperatriz/MA". O modelo tem `Unidade: {{lead.cf.<id do ⌂ Unidade>}}`; com o campo VAZIO o Kommo
 * põe o EXEMPLO cadastrado na Meta — "Imperatriz/MA" em 7 contas, outro texto nas demais (errado também).
 * 19 contas têm 1–2 modelos com esse campo e quase ninguém o preenchia (Balsas: 2 de 4.750 cartões).
 *
 * O modelo sai por gatilho no MESMO instante em que o cartão entra em EM TRATAMENTO (atraso 0): um robô que
 * olhasse só a entrada na etapa chegaria depois da mensagem. Por isso o campo é preenchido ANTES — o worker
 * (`unidade-no-cartao-worker.ts`) passa em todo cartão que mexeu e, uma vez por dia, no estoque.
 *
 * Regras (decisão do João, 20/10):
 *  - campo vazio → grava o valor da unidade, no formato do exemplo do modelo ("Cidade/UF");
 *  - valor que alguém pôs → nunca troca. Se ele nem fala da cidade da unidade, vira "diverge" na tela;
 *  - a exceção é o valor que o PRÓPRIO robô pôs e ficou errado — só acontece na conta dividida
 *    (Petrópolis × Caxias), quando a SDR troca a unidade de atendimento do cartão;
 *  - Petrópolis × Caxias: o valor sai do «⌂ Unidade de atendimento» do cartão; vazio = não grava (a SDR
 *    escolhe a unidade antes — ver `crm-compartilhado.ts`).
 */
import { normalizarNome } from './kommo-schema.js';

/** O campo que os modelos usam. Pelo nome: o id muda de conta pra conta. */
export const CAMPO_UNIDADE_MODELO = '⌂ Unidade';

export type ValorDaUnidade =
  | { fixo: string }
  /** rótulo da opção no «⌂ Unidade de atendimento» → valor */
  | { porAtendimento: Record<string, string> };

/**
 * Por unidade do agente (slug da conta dona do Kommo — os `-resgate` e afins dividem a conta e ficam de fora,
 * senão a mesma conta seria varrida duas vezes). Unidade fora desta lista não é preenchida, mesmo com a chave ligada.
 */
export const VALOR_POR_UNIDADE: Record<string, ValorDaUnidade> = {
  'doutor-hernia-acailandia': { fixo: 'Açailândia/MA' },
  'doutor-hernia-araguaina': { fixo: 'Araguaína/TO' },
  'doutor-hernia-balsas': { fixo: 'Balsas/MA' },
  'doutor-hernia-bebedouro': { fixo: 'Bebedouro/SP' },
  'doutor-hernia-boa-vista': { fixo: 'Boa Vista/RR' },
  'doutor-hernia-boituva': { fixo: 'Boituva/SP' },
  'doutor-hernia-canaa': { fixo: 'Canaã dos Carajás/PA' },
  'doutor-hernia-capivari': { fixo: 'Capivari/SP' },
  'doutor-hernia-cerquilho': { fixo: 'Cerquilho/SP' },
  'doutor-hernia-imperatriz': { fixo: 'Imperatriz/MA' },
  'doutor-hernia-maraba': { fixo: 'Marabá/PA' },
  'doutor-hernia-mossoro': { fixo: 'Mossoró/RN' },
  'doutor-hernia-olimpia': { fixo: 'Olímpia/SP' },
  'doutor-hernia-parauapebas': { fixo: 'Parauapebas/PA' },
  'doutor-hernia-porto': { fixo: 'Porto Nacional/TO' },
  'doutor-hernia-rioverde': { fixo: 'Rio Verde/GO' },
  'doutor-hernia-serra': { fixo: 'Serra/ES' },
  'doutor-hernia-taubate': { fixo: 'Taubaté/SP' },
  // Conta dividida: Caxias não tem credencial do Kommo; a varredura é a da dona (Petrópolis), cartão a cartão.
  'doutor-hernia-petropolis': { porAtendimento: { Petrópolis: 'Petrópolis/RJ', Caxias: 'Duque de Caxias/RJ' } },
};

/** O campo do modelo na lista de campos da conta: só pelo nome exato (há "⌂ Unidade de atendimento" em Petrópolis). */
export function acharCampoDoModelo<T extends { name: string }>(campos: ReadonlyArray<T>): T | null {
  const achados = campos.filter((f) => f.name.trim() === CAMPO_UNIDADE_MODELO);
  return achados.length === 1 ? achados[0]! : null;
}

/** Puro. O valor que o cartão deve ter; null = não dá pra saber (conta dividida sem unidade de atendimento). */
export function valorDesejado(regra: ValorDaUnidade, atendimento: string | null): string | null {
  if ('fixo' in regra) return regra.fixo;
  if (!atendimento?.trim()) return null;
  const alvo = normalizarNome(atendimento);
  const achado = Object.entries(regra.porAtendimento).find(([rotulo]) => normalizarNome(rotulo) === alvo);
  return achado ? achado[1] : null;
}

/** Os valores que só o robô escreve — é o que ele pode corrigir. */
export function valoresDoRobo(regra: ValorDaUnidade): string[] {
  return 'fixo' in regra ? [regra.fixo] : Object.values(regra.porAtendimento);
}

const semUf = (s: string) => s.replace(/[\s/\-–,]+[a-z]{2}\s*$/i, '');

/**
 * Puro. O valor posto à mão fala da mesma cidade? "BALSAS - MA", "Balsas" e "Doutor Hérnia Balsas" falam de
 * Balsas/MA; "Imperatriz/MA" não. "Caxias" fala de Duque de Caxias/RJ.
 */
export function falaDaCidade(noCartao: string, valor: string): boolean {
  const a = normalizarNome(semUf(noCartao));
  const b = normalizarNome(semUf(valor));
  if (a.length < 4 || b.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

export type PlanoUnidadeNoCartao =
  | { acao: 'gravar'; valor: string; motivo: string }
  | { acao: 'trocar' | 'diverge'; valor: string; noCartao: string; motivo: string };

/**
 * Puro. `noCartao` = valor atual do ⌂ Unidade (null se vazio); `atendimento` = o «⌂ Unidade de atendimento» do
 * cartão (só conta na conta dividida). null = nada a fazer: já está certo, fala da cidade em outro formato, ou
 * não dá pra saber a unidade.
 */
export function planejarUnidadeNoCartao(e: {
  regra: ValorDaUnidade;
  noCartao: string | null;
  atendimento: string | null;
}): PlanoUnidadeNoCartao | null {
  const valor = valorDesejado(e.regra, e.atendimento);
  if (!valor) return null;
  const deOnde = 'porAtendimento' in e.regra ? ` (unidade de atendimento: ${e.atendimento?.trim()})` : '';
  const atual = e.noCartao?.trim() || null;
  if (!atual) return { acao: 'gravar', valor, motivo: `campo vazio${deOnde}` };
  if (normalizarNome(atual) === normalizarNome(valor)) return null;
  if (valoresDoRobo(e.regra).some((v) => normalizarNome(v) === normalizarNome(atual))) {
    return { acao: 'trocar', valor, noCartao: atual, motivo: `o robô tinha posto ${atual}${deOnde}` };
  }
  if (falaDaCidade(atual, valor)) return null;
  return { acao: 'diverge', valor, noCartao: atual, motivo: 'posto à mão e não fala da cidade da unidade — o robô não troca' };
}

/**
 * Puro. Do que a página planejou, quanto cabe no teto da rodada — e se a página inteira coube (só então o
 * cursor do estoque anda; senão a mesma página é relida na próxima rodada e o resto entra).
 */
export function caberNoTeto<T>(planos: ReadonlyArray<T>, restante: number): { entram: T[]; paginaInteira: boolean } {
  const n = Math.max(0, restante);
  return { entram: planos.slice(0, n), paginaInteira: planos.length <= n };
}
