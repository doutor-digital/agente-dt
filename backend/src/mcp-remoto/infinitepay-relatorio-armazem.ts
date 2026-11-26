/** As tabelas `infinitepay_importacoes`, `infinitepay_movimentos` e `infinitepay_vendas` como o conector as usa, e a versão em memória para os testes. */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { ArmazemDeRelatorios, ImportacaoGuardada, MovimentoGuardado, NovaImportacao, TipoDeRelatorio, VendaGuardada } from './infinitepay-relatorio.js';

const dia = (d: Date) => d.toISOString().slice(0, 10);
const comoData = (d: string) => new Date(`${d}T00:00:00.000Z`);
export const FALHA_DO_BANCO_RELATORIO = 'não consegui gravar nem ler os relatórios no banco; nada foi gravado, tente em instantes';

interface LinhaImportacao {
  id: string; relatorio: string; formato: string; leiaute: string | null; periodoInicio: Date | null; periodoFim: Date | null;
  linhasLidas: number; linhasNovas: number; importadoPor: string; createdAt: Date;
}
interface LinhaMovimento { tipo: string; data: Date; dataPrevista: Date | null; valorCentavos: number; descricao: string }
interface LinhaVenda { quando: Date; valorBrutoCentavos: number; valorLiquidoCentavos: number | null; forma: string; parcelas: number | null; bandeira: string | null; status: string | null }

/** O pedaço do cliente do Prisma que o armazém usa (facilita o teste e a troca por transação). */
export interface BancoDeRelatorios {
  $transaction<T>(fn: (tx: BancoDeRelatorios) => Promise<T>, opcoes?: { timeout?: number; maxWait?: number }): Promise<T>;
  infinitepayImportacao: {
    findUnique(a: { where: { unitSlug_sha256: { unitSlug: string; sha256: string } }; select: { id: true } }): Promise<{ id: string } | null>;
    findMany(a: { where: Record<string, unknown>; orderBy: { createdAt: 'asc' } }): Promise<LinhaImportacao[]>;
    create(a: { data: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }>;
    update(a: { where: { id: string }; data: { linhasNovas: number } }): Promise<unknown>;
  };
  infinitepayMovimento: {
    createMany(a: { data: Array<Record<string, unknown>>; skipDuplicates: true }): Promise<{ count: number }>;
    findMany(a: { where: Record<string, unknown>; orderBy: Array<Record<string, 'asc' | 'desc'>>; take: number }): Promise<LinhaMovimento[]>;
  };
  infinitepayVenda: {
    createMany(a: { data: Array<Record<string, unknown>>; skipDuplicates: true }): Promise<{ count: number }>;
    findMany(a: { where: Record<string, unknown>; orderBy: { quando: 'asc' }; take: number }): Promise<LinhaVenda[]>;
  };
}

const faixa = (de?: string, ate?: string) => ({ ...(de ? { gte: comoData(de) } : {}), ...(ate ? { lte: comoData(ate) } : {}) });

export function armazemDeRelatoriosPrisma(db: BancoDeRelatorios): ArmazemDeRelatorios {
  return {
    async jaImportado(unidade, sha256) {
      return Boolean(await db.infinitepayImportacao.findUnique({ where: { unitSlug_sha256: { unitSlug: unidade, sha256 } }, select: { id: true } }));
    },
    async gravar(i: NovaImportacao) {
      try {
        return await db.$transaction(
          async (tx) => {
            const imp = await tx.infinitepayImportacao.create({
              data: {
                unitSlug: i.unidade, relatorio: i.relatorio, formato: i.formato, leiaute: i.leiaute, sha256: i.sha256, bytes: i.bytes,
                periodoInicio: i.periodoInicio ? comoData(i.periodoInicio) : null, periodoFim: i.periodoFim ? comoData(i.periodoFim) : null,
                linhasLidas: i.movimentos.length + i.vendas.length, linhasNovas: 0, importadoPor: i.importadoPor,
              },
              select: { id: true },
            });
            let novas = 0;
            if (i.movimentos.length) {
              novas += (
                await tx.infinitepayMovimento.createMany({
                  data: i.movimentos.map((m) => ({
                    unitSlug: i.unidade, tipo: m.tipo, data: comoData(m.data), dataPrevista: m.dataPrevista ? comoData(m.dataPrevista) : null,
                    valorCentavos: m.valorCentavos, descricao: m.descricao, chave: m.chave, importacaoId: imp.id,
                  })),
                  skipDuplicates: true,
                })
              ).count;
            }
            if (i.vendas.length) {
              novas += (
                await tx.infinitepayVenda.createMany({
                  data: i.vendas.map((v) => ({
                    unitSlug: i.unidade, quando: new Date(v.quando), valorBrutoCentavos: v.valorBrutoCentavos, valorLiquidoCentavos: v.valorLiquidoCentavos ?? null,
                    forma: v.forma, parcelas: v.parcelas ?? null, bandeira: v.bandeira ?? null, status: v.status ?? null, chave: v.chave, importacaoId: imp.id,
                  })),
                  skipDuplicates: true,
                })
              ).count;
            }
            await tx.infinitepayImportacao.update({ where: { id: imp.id }, data: { linhasNovas: novas } });
            return { id: imp.id, novas };
          },
          { timeout: 60_000, maxWait: 15_000 },
        );
      } catch (e) {
        if (e instanceof ErroDeEntrada) throw e;
        if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002') throw new ErroDeEntrada('este arquivo já foi importado (ou está sendo importado agora por outra chamada); nada mudou');
        throw new ErroDeEntrada(FALHA_DO_BANCO_RELATORIO);
      }
    },
    async movimentos(f) {
      const linhas = await db.infinitepayMovimento.findMany({
        where: { unitSlug: f.unidade, ...(f.tipo ? { tipo: f.tipo } : {}), ...(f.de || f.ate ? { data: faixa(f.de, f.ate) } : {}) },
        orderBy: [{ data: 'desc' }, { valorCentavos: 'desc' }],
        take: f.limite,
      });
      return linhas.map((l): MovimentoGuardado => ({ tipo: l.tipo as 'extrato' | 'recebivel', data: dia(l.data), dataPrevista: l.dataPrevista ? dia(l.dataPrevista) : null, valorCentavos: l.valorCentavos, descricao: l.descricao }));
    },
    async vendas(f) {
      const linhas = await db.infinitepayVenda.findMany({
        where: { unitSlug: f.unidade, ...(f.de || f.ate ? { quando: { ...(f.de ? { gte: new Date(`${f.de}T00:00:00-03:00`) } : {}), ...(f.ate ? { lte: new Date(`${f.ate}T23:59:59.999-03:00`) } : {}) } } : {}) },
        orderBy: { quando: 'asc' },
        take: f.limite,
      });
      return linhas.map((l): VendaGuardada => ({ quando: l.quando.toISOString(), valorBrutoCentavos: l.valorBrutoCentavos, valorLiquidoCentavos: l.valorLiquidoCentavos, forma: l.forma, parcelas: l.parcelas, bandeira: l.bandeira, status: l.status }));
    },
    async importacoes(unidade, relatorio?: TipoDeRelatorio) {
      const linhas = await db.infinitepayImportacao.findMany({ where: { unitSlug: unidade, ...(relatorio ? { relatorio } : {}) }, orderBy: { createdAt: 'asc' } });
      return linhas.map((l): ImportacaoGuardada => ({
        id: l.id, relatorio: l.relatorio, formato: l.formato, leiaute: l.leiaute, periodoInicio: l.periodoInicio ? dia(l.periodoInicio) : null, periodoFim: l.periodoFim ? dia(l.periodoFim) : null,
        linhasLidas: l.linhasLidas, linhasNovas: l.linhasNovas, importadoPor: l.importadoPor, importadoEm: l.createdAt.toISOString(),
      }));
    },
  };
}

/** Em memória, com a mesma regra de unicidade do banco (o que repete não entra e não conta como novo). Só para testes. */
export function relatoriosEmMemoria(): ArmazemDeRelatorios & { importacoesGravadas: ImportacaoGuardada[]; shas: Set<string> } {
  const importacoesGravadas: ImportacaoGuardada[] = [];
  const unidadeDa = new Map<string, string>();
  const shas = new Set<string>();
  const movimentos: Array<MovimentoGuardado & { unidade: string; chave: string }> = [];
  const vendas: Array<VendaGuardada & { unidade: string; chave: string }> = [];
  let n = 0;
  return {
    importacoesGravadas,
    shas,
    async jaImportado(u, sha) {
      return shas.has(`${u}|${sha}`);
    },
    async gravar(i) {
      shas.add(`${i.unidade}|${i.sha256}`);
      let novas = 0;
      for (const m of i.movimentos) {
        if (movimentos.some((x) => x.unidade === i.unidade && x.tipo === m.tipo && x.chave === m.chave)) continue;
        movimentos.push({ unidade: i.unidade, chave: m.chave, tipo: m.tipo, data: m.data, dataPrevista: m.dataPrevista ?? null, valorCentavos: m.valorCentavos, descricao: m.descricao });
        novas += 1;
      }
      for (const v of i.vendas) {
        if (vendas.some((x) => x.unidade === i.unidade && x.chave === v.chave)) continue;
        vendas.push({ unidade: i.unidade, chave: v.chave, quando: v.quando, valorBrutoCentavos: v.valorBrutoCentavos, valorLiquidoCentavos: v.valorLiquidoCentavos ?? null, forma: v.forma, parcelas: v.parcelas ?? null, bandeira: v.bandeira ?? null, status: v.status ?? null });
        novas += 1;
      }
      const id = `imp-${++n}`;
      unidadeDa.set(id, i.unidade);
      importacoesGravadas.push({ id, relatorio: i.relatorio, formato: i.formato, leiaute: i.leiaute, periodoInicio: i.periodoInicio ?? null, periodoFim: i.periodoFim ?? null, linhasLidas: i.movimentos.length + i.vendas.length, linhasNovas: novas, importadoPor: i.importadoPor, importadoEm: '2026-11-26T12:00:00.000Z' });
      return { id, novas };
    },
    async movimentos(f) {
      return movimentos.filter((m) => m.unidade === f.unidade && (!f.tipo || m.tipo === f.tipo) && (!f.de || m.data >= f.de) && (!f.ate || m.data <= f.ate)).slice(0, f.limite);
    },
    async vendas(f) {
      return vendas.filter((v) => v.unidade === f.unidade && (!f.de || v.quando.slice(0, 10) >= f.de) && (!f.ate || v.quando.slice(0, 10) <= f.ate)).slice(0, f.limite);
    },
    async importacoes(u, relatorio) {
      return importacoesGravadas.filter((i) => unidadeDa.get(i.id) === u && (!relatorio || i.relatorio === relatorio)).map((i) => ({ ...i }));
    },
  };
}
