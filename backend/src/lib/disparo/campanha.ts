/**
 * Definir e listar campanhas de disparo. Um lugar só para a rota (`PUT /api/disparo/campanhas/:slug`) e para o
 * conector do Claude: o que vale para uma vale para a outra.
 */
import { z } from 'zod';
import { Prisma, type DisparoCampanha } from '@prisma/client';
import { prisma } from '../prisma.js';
import { falha, type ResultadoDeAcao } from './onda.js';
import { OFERTA_MAX, problemaNoModelo } from './regras.js';

const cabecalho = z.object({ tipo: z.enum(['image', 'video', 'document']), link: z.string().url().startsWith('https://'), nomeArquivo: z.string().max(120).optional() });

export const campanhaSchema = z.object({
  nome: z.string().min(2).max(120),
  template: z.string().min(1).max(512).nullish(),
  idioma: z.string().min(2).max(12).default('pt_BR'),
  textoModelo: z.string().min(1).max(4096),
  variaveis: z.array(z.string().min(1).max(200)).max(10).default([]),
  cabecalho: cabecalho.nullish(),
  porUnidade: z.record(z.object({ template: z.string().min(1).max(512).optional(), cabecalho: cabecalho.nullish() })).default({}),
  /** ausente = mantém a que está salva; null ou vazio = apaga */
  oferta: z.string().max(OFERTA_MAX).nullish(),
});

export const slugDaCampanha = z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/);

export type CampanhaEntrada = z.infer<typeof campanhaSchema>;

/**
 * Cria ou atualiza a campanha. `soCriar` recusa (409) se o slug já existe: o conector do Claude usa isso para nunca
 * sobrescrever uma campanha sem que a pessoa tenha pedido "atualizar".
 */
export async function salvarCampanha(slug: string, c: CampanhaEntrada, opcoes: { soCriar?: boolean } = {}): Promise<ResultadoDeAcao<{ id: string; slug: string; criada: boolean }>> {
  const problema = problemaNoModelo(c.textoModelo, c.variaveis);
  if (problema) return falha(422, problema);
  const existente = await prisma.disparoCampanha.findUnique({ where: { slug }, select: { id: true } });
  if (existente && opcoes.soCriar) return falha(409, `a campanha ${slug} já existe; peça para atualizar (e confira antes o que ela tem hoje)`);
  const dados = {
    nome: c.nome,
    template: c.template ?? null,
    idioma: c.idioma,
    textoModelo: c.textoModelo,
    variaveis: c.variaveis as Prisma.InputJsonValue,
    cabecalho: c.cabecalho ? (c.cabecalho as Prisma.InputJsonValue) : Prisma.DbNull,
    porUnidade: c.porUnidade as Prisma.InputJsonValue,
  };
  const oferta = c.oferta === undefined ? undefined : c.oferta?.trim() || null;
  const salva = await prisma.disparoCampanha.upsert({
    where: { slug },
    create: { slug, ...dados, oferta: oferta ?? null },
    update: { ...dados, ...(oferta !== undefined ? { oferta } : {}) },
  });
  return { ok: true, dados: { id: salva.id, slug: salva.slug, criada: !existente } };
}

export interface CampanhaNaLista {
  slug: string;
  nome: string;
  template: string | null;
  idioma: string;
  textoModelo: string;
  variaveis: string[];
  temCabecalho: boolean;
  unidadesComModeloProprio: string[];
  oferta: string | null;
  ondas: Record<string, number>;
}

export function comoItemDaLista(c: DisparoCampanha, ondas: Record<string, number>): CampanhaNaLista {
  const porUnidade = (c.porUnidade ?? {}) as Record<string, unknown>;
  return {
    slug: c.slug,
    nome: c.nome,
    template: c.template,
    idioma: c.idioma,
    textoModelo: c.textoModelo,
    variaveis: Array.isArray(c.variaveis) ? (c.variaveis as unknown[]).map(String) : [],
    temCabecalho: !!c.cabecalho,
    unidadesComModeloProprio: Object.keys(porUnidade).sort(),
    oferta: c.oferta,
    ondas,
  };
}

export async function listarCampanhas(): Promise<CampanhaNaLista[]> {
  const [campanhas, ondas] = await Promise.all([
    prisma.disparoCampanha.findMany({ orderBy: { criadoEm: 'desc' }, take: 50 }),
    prisma.disparoOnda.groupBy({ by: ['campanhaId', 'estado'], _count: true }),
  ]);
  return campanhas.map((c) => comoItemDaLista(c, Object.fromEntries(ondas.filter((o) => o.campanhaId === c.id).map((o) => [o.estado, o._count]))));
}
