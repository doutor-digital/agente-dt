/**
 * Definir e listar campanhas de disparo. Um lugar só para a rota (`PUT /api/disparo/campanhas/:slug`) e para o
 * conector do Claude: o que vale para uma vale para a outra.
 */
import { Prisma, type DisparoCampanha } from '@prisma/client';
import { prisma } from '../prisma.js';
import { falha, type ResultadoDeAcao } from './onda.js';
import { problemaNaOferta, problemaNoModelo } from './regras.js';
import { campanhaSchema, camposDaCampanha, slugDaCampanha, type CampanhaEntrada } from './campanha-schema.js';

export { campanhaSchema, camposDaCampanha, slugDaCampanha, type CampanhaEntrada };

const PADRAO = { idioma: 'pt_BR', variaveis: [] as string[], porUnidade: {} as Record<string, unknown> };
const CAMPOS_COMPARADOS = ['nome', 'template', 'idioma', 'textoModelo', 'variaveis', 'cabecalho', 'porUnidade', 'oferta'] as const;
const igual = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Cria ou atualiza a campanha.
 *  - `soCriar`: recusa (409) se o slug já existe. O conector usa isso para nunca sobrescrever sem que a pessoa tenha pedido "atualizar".
 *  - `mesclar`: o que NÃO veio fica como está salvo (atualizar uma campanha que já tem modelo próprio por unidade e arte
 *    sem apagá-los). Sem `mesclar` (a rota PUT) o que não veio volta ao padrão — "PUT troca tudo", como no #126 —, e só a
 *    `oferta` ausente é mantida.
 * Devolve `alterados`: quais campos mudaram em relação ao que estava salvo (vazio ao criar).
 */
export async function salvarCampanha(
  slug: string,
  c: CampanhaEntrada,
  opcoes: { soCriar?: boolean; mesclar?: boolean } = {},
): Promise<ResultadoDeAcao<{ id: string; slug: string; criada: boolean; alterados: string[] }>> {
  const existente = await prisma.disparoCampanha.findUnique({ where: { slug } });
  const jaExiste = `a campanha ${slug} já existe; peça para atualizar (e confira antes o que ela tem hoje)`;
  if (existente && opcoes.soCriar) return falha(409, jaExiste);
  if (!existente && (!c.nome || !c.textoModelo)) return falha(422, 'para criar a campanha mande o nome e o texto do modelo');
  const manter = !!existente && !!opcoes.mesclar;
  const final = {
    nome: (c.nome ?? existente?.nome)!,
    template: c.template !== undefined ? c.template : manter ? existente.template : null,
    idioma: c.idioma ?? (manter ? existente.idioma : PADRAO.idioma),
    textoModelo: (c.textoModelo ?? existente?.textoModelo)!,
    variaveis: c.variaveis ?? (manter ? (existente.variaveis as string[]) : PADRAO.variaveis),
    cabecalho: c.cabecalho !== undefined ? c.cabecalho : manter ? existente.cabecalho : null,
    porUnidade: c.porUnidade ?? (manter ? (existente.porUnidade as Record<string, unknown>) : PADRAO.porUnidade),
    oferta: c.oferta !== undefined ? c.oferta?.trim() || null : existente?.oferta ?? null,
  };
  const problema = problemaNoModelo(final.textoModelo, final.variaveis) ?? problemaNaOferta(final.oferta);
  if (problema) return falha(422, problema);
  const dados = {
    nome: final.nome,
    template: final.template ?? null,
    idioma: final.idioma,
    textoModelo: final.textoModelo,
    variaveis: final.variaveis as Prisma.InputJsonValue,
    cabecalho: final.cabecalho ? (final.cabecalho as Prisma.InputJsonValue) : Prisma.DbNull,
    porUnidade: final.porUnidade as Prisma.InputJsonValue,
    oferta: final.oferta,
  };
  let salva: DisparoCampanha;
  if (opcoes.soCriar) {
    // Criar de verdade (e não upsert): duas chamadas ao mesmo tempo não se sobrescrevem; a segunda leva o 409 da chave única.
    try {
      salva = await prisma.disparoCampanha.create({ data: { slug, ...dados } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return falha(409, jaExiste);
      throw err;
    }
  } else {
    salva = await prisma.disparoCampanha.upsert({ where: { slug }, create: { slug, ...dados }, update: dados });
  }
  const alterados = existente ? CAMPOS_COMPARADOS.filter((k) => !igual(final[k], existente[k])) : [];
  return { ok: true, dados: { id: salva.id, slug: salva.slug, criada: !existente, alterados } };
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
  const modeloPorUnidade = (c.porUnidade ?? {}) as Record<string, unknown>;
  return {
    slug: c.slug,
    nome: c.nome,
    template: c.template,
    idioma: c.idioma,
    textoModelo: c.textoModelo,
    variaveis: Array.isArray(c.variaveis) ? (c.variaveis as unknown[]).map(String) : [],
    temCabecalho: !!c.cabecalho,
    unidadesComModeloProprio: Object.keys(modeloPorUnidade).sort(),
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
