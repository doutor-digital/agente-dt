/**
 * Convites do formulário «nova clínica»: um CÓDIGO de uso único que vale 14 dias, gerado por um administrador da Doutor Digital e entregue ao franqueado
 * num link (`/nova-clinica/<codigo>`).
 *
 * O código é o SEGREDO: 144 bits aleatórios. O banco guarda só o hash (SHA-256): quem lê o banco não consegue abrir o formulário de ninguém. Código errado,
 * vencido, já usado ou revogado dão a MESMA resposta (quem chuta não descobre qual deles existe). O envio é atômico: dois envios ao mesmo tempo, um só vale.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { RespostasFormulario } from './formulario.js';
import { sugestoesDoKit } from './formulario.js';

export const DIAS_DE_VALIDADE = 14;
/** 18 bytes em base64url = 24 caracteres */
export const FORMATO_DO_CODIGO = /^[A-Za-z0-9_-]{24}$/;

export const gerarCodigo = (): string => randomBytes(18).toString('base64url');
export const hashDoCodigo = (codigo: string): string => createHash('sha256').update(codigo).digest('hex');

export interface ConviteListado {
  id: string;
  rotulo: string | null;
  criadoPor: string;
  criadoEm: Date;
  expiraEm: Date;
  enviadoEm: Date | null;
  importadoEm: Date | null;
  slugSugerido: string | null;
}

/** O que o servidor precisa do banco. A implementação de verdade (Prisma) está em `convites-prisma.ts`; os testes usam uma em memória. */
export interface BancoConvites {
  criar(d: { codigoHash: string; rotulo: string | null; criadoPor: string; expiraEm: Date }): Promise<{ id: string }>;
  /** o convite pelo hash do código, ou null */
  achar(codigoHash: string): Promise<{ id: string; expiraEm: Date; enviadoEm: Date | null } | null>;
  /** reivindica o convite E grava as respostas num passo só: devolve o id se este chamador ganhou, null se já estava usado/vencido/inexistente */
  enviar(d: { codigoHash: string; agora: Date; respostas: RespostasFormulario; slugSugerido: string }): Promise<{ id: string } | null>;
  listar(): Promise<ConviteListado[]>;
  /** encerra o convite agora (não apaga nada) */
  revogar(id: string, agora: Date): Promise<boolean>;
}

export async function criarConvite(banco: BancoConvites, d: { rotulo?: string | null; criadoPor: string; dias?: number; agora?: Date }): Promise<{ id: string; codigo: string; expiraEm: Date }> {
  const dias = d.dias ?? DIAS_DE_VALIDADE;
  if (!Number.isInteger(dias) || dias < 1 || dias > 60) throw new Error('dias precisa ser um inteiro de 1 a 60');
  const codigo = gerarCodigo();
  const expiraEm = new Date((d.agora ?? new Date()).getTime() + dias * 86_400_000);
  const { id } = await banco.criar({ codigoHash: hashDoCodigo(codigo), rotulo: d.rotulo?.trim().slice(0, 120) || null, criadoPor: d.criadoPor.slice(0, 120), expiraEm });
  return { id, codigo, expiraEm };
}

/** O convite está aberto (existe, não venceu, não foi usado)? Só devolve o id; o MOTIVO de não estar nunca sai daqui. */
export async function conviteAberto(banco: BancoConvites, codigo: unknown, agora: Date = new Date()): Promise<{ id: string } | null> {
  if (typeof codigo !== 'string' || !FORMATO_DO_CODIGO.test(codigo)) return null;
  const c = await banco.achar(hashDoCodigo(codigo));
  if (!c || c.enviadoEm || c.expiraEm.getTime() <= agora.getTime()) return null;
  return { id: c.id };
}

export async function registrarEnvio(banco: BancoConvites, codigo: unknown, respostas: RespostasFormulario, agora: Date = new Date()): Promise<{ id: string } | null> {
  if (typeof codigo !== 'string' || !FORMATO_DO_CODIGO.test(codigo)) return null;
  return banco.enviar({ codigoHash: hashDoCodigo(codigo), agora, respostas, slugSugerido: sugestoesDoKit(respostas.clinica.cidade).slug });
}
