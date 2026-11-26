/** A tabela `focus_notas` (NFS-e emitidas pelo conector) como o conector a lê e escreve. */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { Ambiente } from '../lib/integracoes/focus-nfe.js';
import { LIMITES_FOCUS, LivroDeNotas, STATUS_ATIVOS, type ArmazemDeNotas, type FiltroDeNotas, type NotaGuardada, type PatchDaNota, type PedidoDeReserva } from './focus-nfe.js';

/** O pedaço do cliente do Prisma que o armazém usa (facilita o teste sem banco). */
export interface LinhaDaNota {
  unitSlug: string;
  ambiente: string;
  referencia: string;
  status: string;
  serieDps: number;
  numeroDps: number;
  valorCentavos: number;
  dataCompetencia: string;
  tomadorMascarado: string;
  origem: string | null;
  chaveDuplicata: string;
  criadoPor: string;
  createdAt: Date;
  numeroNfse: string | null;
  codigoVerificacao: string | null;
  urlConsulta: string | null;
  urlDanfse: string | null;
  caminhoXml: string | null;
  emitidaEm: Date | null;
  canceladaEm: Date | null;
  revisao: string | null;
  ultimoEvento: string | null;
  erro: string | null;
}

export interface TabelaDeNotas {
  findMany(args: { where: Record<string, unknown>; select?: Record<string, boolean>; orderBy?: Record<string, string>; take?: number }): Promise<unknown[]>;
  findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, string>; select?: Record<string, boolean> }): Promise<unknown | null>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface BancoDeNotas {
  focusNota: TabelaDeNotas;
  $transaction<T>(fn: (tx: { $executeRaw(consulta: TemplateStringsArray, ...valores: unknown[]): Promise<number>; focusNota: TabelaDeNotas }) => Promise<T>, opcoes?: { timeout?: number; maxWait?: number }): Promise<T>;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function comoNotaGuardada(l: LinhaDaNota): NotaGuardada {
  return {
    referencia: l.referencia,
    unidade: l.unitSlug,
    ambiente: l.ambiente === 'producao' ? 'producao' : 'homologacao',
    status: l.status,
    serieDps: l.serieDps,
    numeroDps: l.numeroDps,
    valorCentavos: l.valorCentavos,
    dataCompetencia: l.dataCompetencia,
    tomadorMascarado: l.tomadorMascarado,
    origem: l.origem,
    chaveDuplicata: l.chaveDuplicata,
    criadoPor: l.criadoPor,
    criadoEm: l.createdAt.toISOString(),
    numeroNfse: l.numeroNfse,
    codigoVerificacao: l.codigoVerificacao,
    urlConsulta: l.urlConsulta,
    urlDanfse: l.urlDanfse,
    caminhoXml: l.caminhoXml,
    emitidaEm: iso(l.emitidaEm),
    canceladaEm: iso(l.canceladaEm),
    revisao: l.revisao,
    ultimoEvento: l.ultimoEvento,
    erro: l.erro,
  };
}

const FALHA_DO_BANCO = 'não consegui conferir nem registrar a nota no banco (tetos, nota repetida e número da DPS): nada foi emitido; tente em instantes';
const ehDuplicata = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
const SELECIONA_LIVRO = { valorCentavos: true, status: true, createdAt: true };

async function lerLivro(t: Pick<TabelaDeNotas, 'findMany'>, unidade: string, ambiente: Ambiente, agora: number): Promise<LivroDeNotas> {
  const linhas = (await t.findMany({ where: { unitSlug: unidade, ambiente, createdAt: { gte: new Date(agora - LIMITES_FOCUS.janelaLivroMs) } }, select: SELECIONA_LIVRO })) as Array<Pick<LinhaDaNota, 'valorCentavos' | 'status' | 'createdAt'>>;
  return new LivroDeNotas(linhas.map((l) => ({ valorCentavos: l.valorCentavos, status: l.status, em: l.createdAt.getTime() })));
}

/**
 * O armazém de produção. `reservar` roda numa TRANSAÇÃO que pega `pg_advisory_xact_lock` da unidade e do ambiente, lê as notas das últimas 36 h e a nota repetida, deixa a
 * conferência recusar, escolhe o número da DPS e grava a intenção, tudo antes de soltar a trava: duas instâncias do servidor nunca passam as duas pelo mesmo saldo do teto nem
 * pelo mesmo número. O índice único (unidade, ambiente, série, número) segura o resto. Se o banco não responde, nada sai.
 */
export function armazemDeNotasPrisma(db: BancoDeNotas): ArmazemDeNotas {
  const achar = async (where: Record<string, unknown>) => {
    const l = (await db.focusNota.findFirst({ where, orderBy: { createdAt: 'desc' } })) as LinhaDaNota | null;
    return l ? comoNotaGuardada(l) : null;
  };
  return {
    async listar(f: FiltroDeNotas) {
      const criado = { ...(f.de ? { gte: f.de } : {}), ...(f.ate ? { lte: f.ate } : {}) };
      const linhas = (await db.focusNota.findMany({
        where: { unitSlug: f.unidade, ...(f.ambiente ? { ambiente: f.ambiente } : {}), ...(f.status ? { status: f.status } : {}), ...(Object.keys(criado).length ? { createdAt: criado } : {}) },
        orderBy: { createdAt: 'desc' },
        take: f.limite,
      })) as LinhaDaNota[];
      return linhas.map(comoNotaGuardada);
    },
    porReferencia: (unidade, ambiente, referencia) => achar({ unitSlug: unidade, ambiente, referencia }),
    porReferenciaEmQualquerAmbiente: (unidade, referencia) => achar({ unitSlug: unidade, referencia }),
    ativaPorChave: (unidade, ambiente, chave) => achar({ unitSlug: unidade, ambiente, chaveDuplicata: chave, status: { in: [...STATUS_ATIVOS] } }),
    async ler(unidade, ambiente, agora) {
      try {
        return await lerLivro(db.focusNota, unidade, ambiente, agora);
      } catch {
        throw new ErroDeEntrada(FALHA_DO_BANCO);
      }
    },
    async reservar(p: PedidoDeReserva) {
      try {
        return await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`focus-nfe:${p.unidade}:${p.ambiente}`}::text, 0))`;
            const repetida = (await tx.focusNota.findFirst({ where: { unitSlug: p.unidade, ambiente: p.ambiente, chaveDuplicata: p.chaveDuplicata, status: { in: [...STATUS_ATIVOS] } }, orderBy: { createdAt: 'desc' } })) as LinhaDaNota | null;
            p.conferir(await lerLivro(tx.focusNota, p.unidade, p.ambiente, p.agora), repetida ? comoNotaGuardada(repetida) : null);
            const ultimo = (await tx.focusNota.findFirst({ where: { unitSlug: p.unidade, ambiente: p.ambiente, serieDps: p.serieDps }, orderBy: { numeroDps: 'desc' }, select: { numeroDps: true } })) as { numeroDps: number } | null;
            const numeroDps = Math.max(p.numeroInicial, (ultimo?.numeroDps ?? 0) + 1, p.numeroMinimo ?? 0);
            await tx.focusNota.create({
              data: {
                unitSlug: p.unidade, ambiente: p.ambiente, referencia: p.referencia, status: 'intencao', serieDps: p.serieDps, numeroDps, valorCentavos: p.valorCentavos, dataCompetencia: p.dataCompetencia,
                tomadorMascarado: p.tomadorMascarado, origem: p.origem, chaveDuplicata: p.chaveDuplicata, criadoPor: p.criadoPor,
              },
            });
            return { serieDps: p.serieDps, numeroDps };
          },
          { timeout: 15_000, maxWait: 15_000 },
        );
      } catch (e) {
        if (e instanceof ErroDeEntrada) throw e;
        if (ehDuplicata(e)) throw new ErroDeEntrada(`a referência ${p.referencia} ou o número da DPS já foi usado nesta unidade. Prepare de novo. Nada foi emitido.`);
        throw new ErroDeEntrada(FALHA_DO_BANCO);
      }
    },
    async atualizar(unidade, ambiente, referencia, patch: PatchDaNota) {
      const data: Record<string, unknown> = { ultimoEventoEm: new Date() };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) data[k] = v;
      await db.focusNota.updateMany({ where: { unitSlug: unidade, ambiente, referencia }, data });
      return achar({ unitSlug: unidade, ambiente, referencia });
    },
  };
}
