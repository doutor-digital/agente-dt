/**
 * Onde o OAuth do conector remoto guarda clientes, códigos e tokens. Duas versões com o mesmo
 * contrato: Prisma (produção, em `armazem-prisma.ts`) e memória (testes, aqui). Códigos e tokens chegam aqui JÁ como hash.
 */
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface CodigoGuardado {
  codigoHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  escopos: string[];
  recurso: string | null;
  concessaoId: string;
  expiraEm: Date;
  usadoEm: Date | null;
}

export interface TokenGuardado {
  tokenHash: string;
  tipo: 'acesso' | 'renovacao';
  concessaoId: string;
  clientId: string;
  userId: string;
  escopos: string[];
  recurso: string | null;
  expiraEm: Date;
  revogadoEm: Date | null;
}

export interface RegistroAuditoria {
  userId: string;
  clientId: string;
  ferramenta: string;
  argumentos: unknown;
  ok: boolean;
  duracaoMs: number;
  erro?: string;
}

export interface ArmazemOAuth {
  pegarCliente(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  salvarCliente(cliente: OAuthClientInformationFull): Promise<void>;
  salvarCodigo(codigo: CodigoGuardado): Promise<void>;
  lerCodigo(codigoHash: string): Promise<CodigoGuardado | undefined>;
  /** Marca como usado SÓ se ainda não foi usado e não venceu. `true` = esta chamada usou. Atômico. */
  usarCodigo(codigoHash: string, agora: Date): Promise<boolean>;
  salvarToken(token: TokenGuardado): Promise<void>;
  lerToken(tokenHash: string): Promise<TokenGuardado | undefined>;
  /** Revoga SÓ se ainda está ativo. `true` = esta chamada revogou. Atômico (duas trocas simultâneas: uma perde). */
  revogarSeAtivo(tokenHash: string, agora: Date): Promise<boolean>;
  revogarConcessao(concessaoId: string, agora: Date): Promise<void>;
  auditar(registro: RegistroAuditoria): Promise<void>;
}

/** Mesma semântica do Prisma, em memória. Só pra testes. */
export function armazemEmMemoria(): ArmazemOAuth & { auditoria: RegistroAuditoria[]; tokens: Map<string, TokenGuardado> } {
  const clientes = new Map<string, OAuthClientInformationFull>();
  const codigos = new Map<string, CodigoGuardado>();
  const tokens = new Map<string, TokenGuardado>();
  const auditoria: RegistroAuditoria[] = [];
  return {
    auditoria,
    tokens,
    async pegarCliente(id) {
      return clientes.get(id);
    },
    async salvarCliente(c) {
      clientes.set(c.client_id, structuredClone(c));
    },
    async salvarCodigo(c) {
      codigos.set(c.codigoHash, { ...c });
    },
    async lerCodigo(h) {
      const c = codigos.get(h);
      return c ? { ...c } : undefined;
    },
    async usarCodigo(h, agora) {
      const c = codigos.get(h);
      if (!c || c.usadoEm || c.expiraEm <= agora) return false;
      c.usadoEm = agora;
      return true;
    },
    async salvarToken(t) {
      tokens.set(t.tokenHash, { ...t });
    },
    async lerToken(h) {
      const t = tokens.get(h);
      return t ? { ...t } : undefined;
    },
    async revogarSeAtivo(h, agora) {
      const t = tokens.get(h);
      if (!t || t.revogadoEm) return false;
      t.revogadoEm = agora;
      return true;
    },
    async revogarConcessao(id, agora) {
      for (const t of tokens.values()) if (t.concessaoId === id && !t.revogadoEm) t.revogadoEm = agora;
    },
    async auditar(r) {
      auditoria.push(r);
    },
  };
}
