/**
 * O que os botões «Perdido: …» gravam em `motivo_nao_agendamento` e como achar a opção certa na lista REAL da conta. Módulo leve e puro (sem rede nem banco): o kit o usa para recusar uma lista
 * de motivos que deixaria um botão gravando um valor que a tela não mostra.
 */
/** etiqueta do botão → valor do atributo `motivo_nao_agendamento` (tem que existir na lista do atributo) */
export const MOTIVO_POR_ETIQUETA: Readonly<Record<string, string>> = {
  'perdido-sem-interesse': 'Sem interesse',
  'perdido-outra-cidade': 'Outra cidade',
  'perdido-plano-de-saude': 'Plano de saúde',
  'perdido-nao-deu-continuidade': 'Não deu continuidade',
};

/** Outros nomes que a MESMA razão tem em listas que seguem o Kommo da clínica («Plano de Saúde», «Não deu continuidade ao atendimento»). */
const ALIAS_DO_MOTIVO: Readonly<Record<string, readonly string[]>> = {
  'Não deu continuidade': ['Não deu continuidade ao atendimento'],
  'Plano de saúde': ['Plano de Saúde'],
};
const semAcentoNemCaixa = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * O valor que o botão grava, escolhido na lista REAL do atributo da conta: o próprio valor se a lista o tem; senão a opção que só difere em caixa/acento ou o outro nome da mesma razão;
 * senão (lista desconhecida ou sem nada parecido) o valor de sempre. Assim uma conta com a lista do Kommo («Plano de Saúde») não fica com o botão gravando um valor que a tela não mostra.
 */
export function motivoNaLista(padrao: string, opcoes: readonly string[] | undefined): string {
  if (!opcoes?.length || opcoes.includes(padrao)) return padrao;
  const alvos = [padrao, ...(ALIAS_DO_MOTIVO[padrao] ?? [])].map(semAcentoNemCaixa);
  return opcoes.find((o) => alvos.includes(semAcentoNemCaixa(o))) ?? padrao;
}

