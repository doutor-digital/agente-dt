/**
 * Cotação do dólar (R$ por US$) para mostrar custo da Meta em reais: o painel do disparo do Kommo e o custo/teto de gasto dos
 * Disparos do CRM.
 *
 * Por que três fontes (17/11/2026): a awesomeapi, a única até então, passou a responder 429 «QuotaExceeded». Sem câmbio, o custo do
 * disparo do CRM caiu no preço de reserva (R$ 2,00 por mensagem, de propósito alto), e o teto de R$ 50/dia passou a travar o envio em
 * 25 mensagens por dia. Agora vale a primeira fonte que responder com um valor plausível; nenhuma respondeu, `null` (quem chama já
 * trata: o disparo usa a reserva, o painel mostra só US$).
 */

export interface FonteDoDolar {
  nome: string;
  url: string;
  /** o valor da resposta JSON (NaN quando a resposta não tem o formato esperado) */
  ler: (d: unknown) => number;
}

const campo = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);

export const FONTES_DO_DOLAR: readonly FonteDoDolar[] = [
  // Banco Central, série 1 (dólar comercial, venda), último dia útil: oficial, sem cota
  { nome: 'bcb', url: 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados/ultimos/1?formato=json', ler: (d) => Number(campo(Array.isArray(d) ? d[0] : undefined, 'valor')) },
  { nome: 'awesomeapi', url: 'https://economia.awesomeapi.com.br/json/last/USD-BRL', ler: (d) => Number(campo(campo(d, 'USDBRL'), 'bid')) },
  { nome: 'er-api', url: 'https://open.er-api.com/v6/latest/USD', ler: (d) => Number(campo(campo(d, 'rates'), 'BRL')) },
];

/** Fora disto é leitura errada (formato mudou, unidade trocada), não câmbio: melhor `null` (reserva) do que um custo absurdo. */
export const DOLAR_MINIMO = 1;
export const DOLAR_MAXIMO = 20;
const PRAZO_POR_FONTE_MS = 4_000;

type Buscar = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** A primeira fonte que responde com um valor plausível; nenhuma, `null`. Nunca lança. */
export async function cotacaoDoDolar(buscar: Buscar = fetch, fontes: readonly FonteDoDolar[] = FONTES_DO_DOLAR): Promise<number | null> {
  for (const f of fontes) {
    try {
      const r = await buscar(f.url, { signal: AbortSignal.timeout(PRAZO_POR_FONTE_MS) });
      if (!r.ok) continue;
      const v = f.ler(await r.json());
      if (Number.isFinite(v) && v >= DOLAR_MINIMO && v <= DOLAR_MAXIMO) return v;
    } catch {
      // a próxima fonte
    }
  }
  return null;
}
