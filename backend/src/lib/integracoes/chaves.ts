/**
 * Chaves de API de terceiros por unidade: salvar (testando antes), listar sem expor, e ler decifrada
 * para o conector. Provedores: Asaas (financeiro das clínicas), Convênia (RH/departamento pessoal),
 * Tiquetaque (ponto eletrônico) e Sistemas (RH/Caixa/Financeiro novo, servidor próprio:
 * a "chave" é um JSON com a URL da API de administração, a ADMIN_KEY e a tela RH — ver `sistemas.ts`).
 */
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { cifrar, decifrar, finalDaChave } from './cofre.js';
import { testarChaveAsaas } from './asaas.js';
import { testarChaveConvenia } from './convenia.js';
import { testarChaveTiquetaque } from './tiquetaque.js';
import { lerConfigSistemas, testarChaveSistemas } from './sistemas.js';

export const PROVEDORES = ['asaas', 'convenia', 'tiquetaque', 'sistemas'] as const;
export type Provedor = (typeof PROVEDORES)[number];

const segredo = () => process.env.INTEGRACOES_CHAVE_MESTRA || env.SESSION_JWT_SECRET;

/** Teste de cada provedor: prova a chave no serviço e devolve o nome da conta para o painel. */
const TESTES: Record<Provedor, (chave: string) => Promise<string>> = { asaas: testarChaveAsaas, convenia: testarChaveConvenia, tiquetaque: testarChaveTiquetaque, sistemas: testarChaveSistemas };

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
  const dados = { chaveCifrada: cifrar(limpa, segredo()), finalDaChave: finalDaChave(provedor === 'sistemas' ? lerConfigSistemas(limpa).chave : limpa), conta, salvoPor: quem, testadoEm: new Date(), ultimoErro: null };
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
export async function contasComChave(provedor: Provedor): Promise<Array<{ unitId: string; slug: string; nome: string; conta: string | null; chave: string }>> {
  const linhas = await prisma.chaveDeIntegracao.findMany({
    where: { provedor },
    include: { unit: { select: { slug: true, name: true, isActive: true } } },
  });
  const out: Array<{ unitId: string; slug: string; nome: string; conta: string | null; chave: string }> = [];
  for (const l of linhas) {
    if (!l.unit.isActive) continue;
    try {
      out.push({ unitId: l.unitId, slug: l.unit.slug, nome: l.unit.name, conta: l.conta, chave: decifrar(l.chaveCifrada, segredo()) });
    } catch {
      await prisma.chaveDeIntegracao.update({ where: { id: l.id }, data: { ultimoErro: 'não consegui decifrar: o segredo do servidor mudou — cole a chave de novo' } });
    }
  }
  return out;
}
