/**
 * O TETO DE GASTO por dia, em REAIS e POR NÚMERO (as unidades que dividem o número do Kapso somam).
 *
 * O motor conta mensagens, não reais. Por isso o gasto é calculado aqui, por CATEGORIA de cada envio das últimas 24 h (cada onda tem a categoria do modelo congelada na
 * montagem): `Σ envios da categoria × preço da categoria`. O que cabe agora é `(teto − gasto) ÷ preço da onda que vai sair` e vira um teto de 24 h dos freios
 * (`já mandadas + cabe`). Assim uma onda de marketing já enviada gasta o teto que uma de utilidade, mais barata, vai encontrar descontado — e nunca o contrário.
 */
import { prisma } from '../../prisma.js';
import { cambioDoDia, estimarCusto, lerPrecoDaUnidade, mensagensQueCabem, precoDeReservaBrl } from './custo.js';
import { unidadesDoMesmoNumeroKapso } from './porto.js';

/** O preço por mensagem (R$) da categoria na unidade. Sempre um número positivo (sem histórico, a reserva). */
export type PrecoEmReais = (unitId: string, categoria: string | null) => Promise<number>;

/** Quanto tempo um preço BOM continua valendo quando a leitura (banco/câmbio) falha: depois disso, a reserva. */
export const VALIDADE_DO_ULTIMO_PRECO_MS = 24 * 3_600_000;
/** `ate`: até quando o preço guardado vale se a leitura falhar; `fresco`: até quando nem precisa ler de novo (a rodada roda toda hora: uma leitura a cada 5 min por unidade e categoria). */
const FRESCO_MS = 5 * 60_000;
const ultimoPrecoBom = new Map<string, { valor: number; ate: number; fresco: number }>();
export const _esquecerPrecosDeGasto = (): void => (ultimoPrecoBom.clear(), unidadesDoNumero.clear());

/** O preço de UMA unidade. O que vale para o teto é o do NÚMERO (`precoEmReaisDoBanco`). O último preço BOM (até 24 h) se a leitura falha — falhar ABERTO soltaria o gasto justo quando algo está estranho; depois de 24 h, a reserva (conservadora). */
export const precoEmReaisDaUnidade: PrecoEmReais = async (unitId, categoria) => {
  const chave = `${unitId}|${(categoria ?? '').toUpperCase()}`;
  const agora = Date.now();
  const recente = ultimoPrecoBom.get(chave);
  if (recente && recente.fresco > agora) return recente.valor;
  const [preco, cambio] = await Promise.all([lerPrecoDaUnidade(unitId, categoria).catch(() => null), cambioDoDia().catch(() => null)]);
  const e = estimarCusto({ pessoas: 1, categoria, preco, cambio });
  if (e.conhecido && e.porMensagemBrl !== null) {
    ultimoPrecoBom.set(chave, { valor: e.porMensagemBrl, ate: agora + VALIDADE_DO_ULTIMO_PRECO_MS, fresco: agora + FRESCO_MS });
    return e.porMensagemBrl;
  }
  const guardado = recente;
  return guardado && guardado.ate > agora ? guardado.valor : precoDeReservaBrl(categoria);
};

/** As unidades que dividem o número do Kapso da unidade, guardadas 5 min (a conta do teto roda toda hora). Sem leitura, só ela. */
const unidadesDoNumero = new Map<string, { ate: number; ids: string[] }>();
async function unidadesDoNumeroGuardadas(unitId: string): Promise<string[]> {
  const feito = unidadesDoNumero.get(unitId);
  if (feito && feito.ate > Date.now()) return feito.ids;
  try {
    const lidas = await unidadesDoMesmoNumeroKapso(unitId);
    const ids = lidas.length ? lidas : [unitId];
    unidadesDoNumero.set(unitId, { ate: Date.now() + FRESCO_MS, ids });
    return ids;
  } catch {
    // falha de leitura NÃO é guardada (não vira «número só dela» por 5 min): vale a última lista conhecida, ou só a própria unidade desta vez
    return feito?.ids ?? [unitId];
  }
}

/**
 * O teto de gasto é do NÚMERO, que pode ser dividido por várias unidades — cada uma com a sua tabela de custo da Meta. O preço de uma categoria é o MAIOR entre as
 * unidades do número (uma unidade sem histórico não baixa o teto das outras, e um preço alto de uma não é ignorado pela outra).
 */
export const precoEmReaisDoBanco: PrecoEmReais = async (unitId, categoria) => {
  const ids = await unidadesDoNumeroGuardadas(unitId);
  const precos = await Promise.all(ids.map((id) => precoEmReaisDaUnidade(id, categoria)));
  return Math.max(...precos);
};

/** Ondas vivas da unidade com categorias diferentes: vale o MAIOR preço (o teto de gasto não pode subestimar). */
export async function maiorPrecoDasOndas(preco: PrecoEmReais, unitId: string, categorias: ReadonlyArray<string | null>): Promise<number> {
  const precos = await Promise.all([...new Set(categorias)].map((c) => preco(unitId, c).catch(() => precoDeReservaBrl(c))));
  return Math.max(...precos);
}

/** Quantos envios do CRM saíram pelo número desde `desde`, por categoria da onda de cada um (o mesmo conjunto que o motor conta nos tetos de mensagens). */
export type EnviosPorCategoria = Array<{ categoria: string | null; envios: number }>;
export type LerEnvios = (unitId: string, desde: Date) => Promise<EnviosPorCategoria>;

export const enviosPorCategoriaNoBanco: LerEnvios = async (unitId, desde) => {
  const ids = await unidadesDoMesmoNumeroKapso(unitId);
  const grupos = await prisma.disparoDestinatario.groupBy({
    by: ['ondaId'],
    where: { unitId: { in: ids }, onda: { origem: 'chatwoot' }, enviadoEm: { gte: desde } },
    _count: { _all: true },
  });
  if (grupos.length === 0) return [];
  const ondas = await prisma.disparoOnda.findMany({ where: { id: { in: grupos.map((g) => g.ondaId) } }, select: { id: true, categoriaModelo: true } });
  const categoriaDa = new Map(ondas.map((o) => [o.id, o.categoriaModelo]));
  const porCategoria = new Map<string | null, number>();
  for (const g of grupos) {
    const c = categoriaDa.get(g.ondaId) ?? null;
    porCategoria.set(c, (porCategoria.get(c) ?? 0) + g._count._all);
  }
  return [...porCategoria].map(([categoria, envios]) => ({ categoria, envios }));
};

export interface OrcamentoDeGasto {
  /** o gasto estimado das últimas 24 h neste número, categoria por categoria × o preço da categoria */
  gastoBrl: number;
  /** quantas mensagens ainda cabem no teto de gasto, ao preço da onda que vai sair */
  cabem: number;
}

/** A conta ÚNICA do teto de gasto: a rodada a usa para decidir e a tela para mostrar. */
export async function orcamentoDeGasto(a: { unitId: string; agora: Date; tetoReais: number; precoAtual: number; preco: PrecoEmReais; ler?: LerEnvios }): Promise<OrcamentoDeGasto> {
  const porCategoria = await (a.ler ?? enviosPorCategoriaNoBanco)(a.unitId, new Date(a.agora.getTime() - 86_400_000));
  const precos = new Map<string | null, number>();
  await Promise.all([...new Set(porCategoria.map((x) => x.categoria))].map(async (c) => precos.set(c, await a.preco(a.unitId, c).catch(() => precoDeReservaBrl(c)))));
  const gastoBrl = porCategoria.reduce((s, x) => s + x.envios * (precos.get(x.categoria) ?? precoDeReservaBrl(x.categoria)), 0);
  return { gastoBrl, cabem: mensagensQueCabem(a.tetoReais, gastoBrl, a.precoAtual) };
}
