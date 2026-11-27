/**
 * POR ONDE o sinal da Sofia 2.0 é cobrado, por unidade: `asaas` (o Pix copia-e-cola de sempre) ou `infinitepay` (um link de pagamento da InfinitePay).
 *
 * Variável de ambiente `SOFIA_SINAL_VIA_<UNIDADE>` (a mesma regra de nome da chave da InfinitePay: o slug em maiúsculas com "_" no lugar de "-", ou o que vem depois de
 * "doutor-hernia-": `SOFIA_SINAL_VIA_DOUTOR_HERNIA_ACAILANDIA` ou `SOFIA_SINAL_VIA_ACAILANDIA`). Ausente, vazia ou com qualquer outro valor = `asaas`: nenhuma unidade muda
 * sem o João ligar. A variável só ESCOLHE o caminho; quem manda no dinheiro continua sendo `INFINITEPAY_ESCRITA_UNIDADES` (sem ela o sinal cai no Pix do Asaas).
 */
export type ViaDoSinal = 'asaas' | 'infinitepay';

export function sinalViaDaUnidade(slug: string, e: NodeJS.ProcessEnv = process.env): ViaDoSinal {
  const completo = slug.toUpperCase().replace(/-/g, '_');
  const curto = completo.replace(/^DOUTOR_HERNIA_/, '');
  for (const nome of new Set([completo, curto])) {
    const v = (e[`SOFIA_SINAL_VIA_${nome}`] ?? '').trim().toLowerCase();
    if (v) return v === 'infinitepay' ? 'infinitepay' : 'asaas';
  }
  return 'asaas';
}
