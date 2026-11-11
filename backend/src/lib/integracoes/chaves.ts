/**
 * Chaves de API de terceiros por unidade: salvar (testando antes), listar sem expor, e ler decifrada
 * para o conector. Provedores: Asaas (financeiro das clínicas), Convênia (RH/departamento pessoal),
 * Tiquetaque (ponto eletrônico), Tramitação Inteligente (processos e prazos de advocacia) e Sistemas (RH/Caixa/Financeiro
 * novo, servidor próprio: a "chave" é um JSON com a URL da API de administração, a ADMIN_KEY e a tela RH — ver `sistemas.ts`) e Descontratos (o mesmo
 * tipo de JSON, sem a tela; é um servidor à parte, com a própria ADMIN_KEY) e ZenFisio (clínica de fisioterapia: a "chave" é um JSON com
 * clientId, clientSecret, e-mail e senha de login e o entityId da unidade — ver `zenfisio.ts`).
 */
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { cifrar, decifrar, finalDaChave } from './cofre.js';
import { testarChaveAsaas } from './asaas.js';
import { testarChaveConvenia } from './convenia.js';
import { testarChaveTiquetaque } from './tiquetaque.js';
import { testarChaveTramitacao } from './tramitacao.js';
import { lerConfigSistemas, testarChaveDescontratos, testarChaveSistemas } from './sistemas.js';
import { lerConfigZenfisio, testarChaveZenfisio } from './zenfisio.js';

export const PROVEDORES = ['asaas', 'convenia', 'tiquetaque', 'tramitacao', 'sistemas', 'descontratos', 'zenfisio'] as const;
export type Provedor = (typeof PROVEDORES)[number];

const segredo = () => process.env.INTEGRACOES_CHAVE_MESTRA || env.SESSION_JWT_SECRET;

/** Teste de cada provedor: prova a chave no serviço e devolve o nome da conta para o painel. */
const TESTES: Record<Provedor, (chave: string) => Promise<string>> = {
  asaas: testarChaveAsaas,
  convenia: testarChaveConvenia, tiquetaque: testarChaveTiquetaque,
  tramitacao: (chave) => testarChaveTramitacao(chave),
  sistemas: testarChaveSistemas,
  descontratos: testarChaveDescontratos,
  zenfisio: (chave) => testarChaveZenfisio(chave),
};

export function ehProvedor(p: string): p is Provedor {
  return (PROVEDORES as readonly string[]).includes(p);
}

/** Testa a chave no serviço e, se funcionar, guarda cifrada. Chave que não funciona não é salva. */
export async function salvarChave(slug: string, provedor: Provedor, chave: string, quem: string): Promise<{ conta: string; final: string }> {
  const limpa = chave.trim();
  if (limpa.length < 20) throw new Error('chave curta demais: confira se copiou inteira');
  const unit = await prisma.unit.findUnique({ where: { slug }, select: { id: true } });
  if (!unit) throw new Error(`unidade ${slug} não existe`);
  const conta = await TESTES[provedor](limpa);
  const dados = { chaveCifrada: cifrar(limpa, segredo()), finalDaChave: finalDaChave(provedor === 'sistemas' || provedor === 'descontratos' ? lerConfigSistemas(limpa).chave : provedor === 'zenfisio' ? lerConfigZenfisio(limpa).clientSecret : limpa), conta, salvoPor: quem, testadoEm: new Date(), ultimoErro: null };
  await prisma.chaveDeIntegracao.upsert({
    where: { unitId_provedor: { unitId: unit.id, provedor } },
    create: { unitId: unit.id, provedor, ...dados },
    update: dados,
  });
  return { conta, final: dados.finalDaChave };
}

export interface ChaveListada {
  slug: string;
  unidade: string;
  provedor: string;
  conta: string | null;
  final: string;
  testadoEm: Date | null;
  ultimoErro: string | null;
}

export async function listarChaves(): Promise<ChaveListada[]> {
  const linhas = await prisma.chaveDeIntegracao.findMany({ include: { unit: { select: { slug: true, name: true } } }, orderBy: { criadoEm: 'asc' } });
  return linhas.map((l) => ({ slug: l.unit.slug, unidade: l.unit.name, provedor: l.provedor, conta: l.conta, final: l.finalDaChave, testadoEm: l.testadoEm, ultimoErro: l.ultimoErro }));
}

/** Contas de um provedor com a chave decifrada — só para o conector usar em memória. */
export async function contasComChave(provedor: Provedor): Promise<Array<{ unitId: string; slug: string; nome: string; conta: string | null; chave: string; fuso: string | null }>> {
  const linhas = await prisma.chaveDeIntegracao.findMany({
    where: { provedor },
    include: { unit: { select: { slug: true, name: true, isActive: true, spineTimezone: true } } },
    orderBy: { criadoEm: 'asc' }, // determinístico: o Descontratos (uma conta só) vale a linha mais antiga
  });
  const out: Array<{ unitId: string; slug: string; nome: string; conta: string | null; chave: string; fuso: string | null }> = [];
  for (const l of linhas) {
    if (!l.unit.isActive) continue;
    try {
      out.push({ unitId: l.unitId, slug: l.unit.slug, nome: l.unit.name, conta: l.conta, chave: decifrar(l.chaveCifrada, segredo()), fuso: l.unit.spineTimezone || null });
    } catch {
      await prisma.chaveDeIntegracao.update({ where: { id: l.id }, data: { ultimoErro: 'não consegui decifrar: o segredo do servidor mudou — cole a chave de novo' } });
    }
  }
  return out;
}

/**
 * A chave decifrada de UMA unidade (só em memória), ou null se a unidade não tem a chave deste provedor, está inativa ou a chave
 * não decifra. Para quem age por unidade (o sinal Pix da Sofia): `contasComChave` decifra a rede inteira a cada chamada.
 */
export async function chaveDaUnidade(unitId: string, provedor: Provedor): Promise<{ unitId: string; slug: string; chave: string } | null> {
  const l = await prisma.chaveDeIntegracao.findUnique({
    where: { unitId_provedor: { unitId, provedor } },
    include: { unit: { select: { slug: true, isActive: true } } },
  });
  if (!l || !l.unit.isActive) return null;
  try {
    return { unitId: l.unitId, slug: l.unit.slug, chave: decifrar(l.chaveCifrada, segredo()) };
  } catch {
    await prisma.chaveDeIntegracao.update({ where: { id: l.id }, data: { ultimoErro: 'não consegui decifrar: o segredo do servidor mudou — cole a chave de novo' } });
    return null;
  }
}
