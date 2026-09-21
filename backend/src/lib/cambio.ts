/**
 * Câmbio ÚNICO pra converter o custo medido da IA (US$) em reais.
 *
 * Painel (units.controller) e teto mensal (agent/teto-mensal) leem daqui: se cada um tivesse o seu
 * fallback, o alerta diria "R$ 305" e a tela "R$ 0" com `USD_BRL=` em branco. `Number('') || 5.4`
 * e `Number('5,4') || 5.4` caem no padrão em vez de virar 0 ou NaN.
 */
export const USD_BRL = Number(process.env.USD_BRL) || 5.4;
