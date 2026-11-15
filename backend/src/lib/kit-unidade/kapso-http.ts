/**
 * O Kapso de verdade: os modelos do WhatsApp da WABA (proxy da API de modelos da Meta). `X-API-Key` no cabeçalho, nunca na URL nem no log.
 * Formato conforme a API de modelos da Meta — NÃO provado contra o Kapso real (o teste usa `chatwoot-falso.ts`).
 */
import { ErroDaPorta, type KapsoPorta } from './portas.js';

export const URL_DO_KAPSO = 'https://api.kapso.ai/meta/whatsapp/v24.0';

export function kapsoHttp(chave: string, buscar: typeof fetch = fetch, base = URL_DO_KAPSO): KapsoPorta {
  async function pedir(metodo: 'GET' | 'POST', waba: string, corpo?: unknown, query = ''): Promise<{ status: number; dados: any }> {
    if (!/^\d{5,25}$/.test(waba)) throw new ErroDaPorta('WABA inválida');
    const r = await buscar(`${base}/${waba}/message_templates${query}`, {
      method: metodo,
      headers: { 'X-API-Key': chave, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(60_000),
    });
    const texto = await r.text();
    let dados: any = null;
    try {
      dados = texto ? JSON.parse(texto) : null;
    } catch {
      dados = texto;
    }
    return { status: r.status, dados };
  }
  const falha = (quando: string, r: { status: number; dados: any }) => new ErroDaPorta(`Kapso ${r.status} ao ${quando}: ${JSON.stringify(r.dados?.error?.message ?? r.dados?.error ?? r.dados ?? '').split(chave).join('***').slice(0, 300)}`, r.status);
  return {
    async modelos(waba) {
      const feitos: Record<string, string> = {};
      let proximo = '?limit=200&fields=name,status';
      for (let pagina = 0; pagina < 20 && proximo; pagina++) {
        const r = await pedir('GET', waba, undefined, proximo);
        if (r.status >= 400) throw falha('listar os modelos', r);
        for (const m of Array.isArray(r.dados?.data) ? r.dados.data : []) if (typeof m?.name === 'string') feitos[m.name] = String(m.status ?? '');
        const depois = r.dados?.paging?.cursors?.after;
        proximo = r.dados?.paging?.next && typeof depois === 'string' ? `?limit=200&fields=name,status&after=${encodeURIComponent(depois)}` : '';
      }
      return feitos;
    },
    async criarModelo(waba, modelo) {
      const r = await pedir('POST', waba, modelo);
      if (r.status >= 400) throw falha(`criar o modelo ${String(modelo.name)}`, r);
    },
  };
}
