/**
 * Monta as contas do conector a partir do que o painel de integrações guarda: o RH/Caixa (provedor `sistemas`, uma conta por unidade onde foi cadastrado, com o
 * slug da unidade) e o Descontratos/Ficha (provedor `descontratos`, uma conta só, slug fixo `descontratos`, `tipo: 'dsc'`). Função pura: quem lê o banco e
 * decifra a chave é a `producao.ts`. Configuração ilegível vira aviso (sem o conteúdo) e a conta fica de fora; uma conta ruim nunca derruba a outra.
 */
import { lerConfigSistemas, sistemasChamar, type ConfigSistemas } from '../lib/integracoes/sistemas.js';
import { SLUG_DESCONTRATOS, tipoDaConta, type ContaSistemas, type FonteSistemas } from './sistemas.js';

export interface LinhaDeChave {
  slug: string;
  nome: string;
  chave: string;
}

type Fetcher = typeof fetch;

const fonteDe = (cfg: ConfigSistemas, fetcher?: Fetcher): FonteSistemas => ({ chamar: (metodo, caminho, o) => sistemasChamar(cfg, metodo, caminho, o, fetcher) });

export function montarContasSistemas(
  rh: LinhaDeChave[],
  descontratos: LinhaDeChave[],
  avisar: (aviso: { slug?: string; unidades?: string[]; motivo: string }) => void = () => {},
  fetcher?: Fetcher,
): Map<string, ContaSistemas> {
  const contas = new Map<string, ContaSistemas>();
  for (const c of rh) {
    try {
      const cfg = lerConfigSistemas(c.chave);
      contas.set(c.slug, { slug: c.slug, nome: c.nome, tela: cfg.tela, fonte: fonteDe(cfg, fetcher) });
    } catch (err) {
      avisar({ slug: c.slug, motivo: err instanceof Error ? err.message : 'inválida' });
    }
  }
  if (descontratos.length > 1) avisar({ unidades: descontratos.map((c) => c.slug), motivo: 'o Descontratos está cadastrado em mais de uma unidade; só a primeira vale' });
  const dsc = descontratos[0];
  if (dsc) {
    try {
      const cfg = lerConfigSistemas(dsc.chave);
      if (contas.has(SLUG_DESCONTRATOS)) throw new Error(`já existe uma unidade chamada ${SLUG_DESCONTRATOS}`);
      contas.set(SLUG_DESCONTRATOS, { slug: SLUG_DESCONTRATOS, nome: 'Descontratos/Ficha', tipo: 'dsc', fonte: fonteDe(cfg, fetcher) });
    } catch (err) {
      avisar({ slug: dsc.slug, motivo: err instanceof Error ? err.message : 'inválida' });
    }
  }
  return contas;
}

/** O que a lista de integrações por unidade mostra: só o RH/Caixa (o Descontratos não é uma unidade). */
export function contasDoRh(contas: Map<string, ContaSistemas>): Map<string, ContaSistemas> {
  return new Map([...contas].filter(([, c]) => tipoDaConta(c) === 'rh'));
}
