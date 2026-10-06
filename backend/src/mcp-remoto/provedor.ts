/**
 * O servidor de autorização (OAuth 2.1) do conector remoto. O SDK do MCP cuida do protocolo
 * (rotas, PKCE S256); aqui fica o que é nosso:
 *
 *  - QUEM entra: usuário ativo do console com papel SUPER_ADMIN (v1: só a diretoria);
 *  - PRA ONDE o código volta: só os endereços de retorno EXATOS do Claude, ou loopback (Claude
 *    Code na máquina). Host inteiro não basta: qualquer página em *.claude.ai com redirect
 *    aberto viraria destino. Sem essa trava, qualquer um registraria um "cliente" com retorno
 *    no próprio site e mandaria o link de login pra diretoria — o golpe clássico;
 *  - códigos (5 min, uso único) e tokens (acesso 1 h; renovação 30 dias, trocada a cada uso)
 *    guardados só como SHA-256. Reuso de código ou de renovação derruba a concessão inteira —
 *    menos o retry legítimo: a mesma renovação reapresentada em até 60 s (resposta perdida,
 *    duas chamadas ao mesmo tempo) recebe um par novo em vez de desconectar a diretoria;
 *  - login com freio por IP+e-mail, por IP e global ANTES do bcrypt, que é caro e roda no
 *    mesmo processo da Sofia.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ArmazemOAuth, TokenGuardado } from './armazem.js';
import { BuscadorCimd } from './cimd.js';
import { JanelaDeContagem } from './limites.js';
import { paginaDeLogin } from './pagina.js';

export const TTL_CODIGO_MS = 5 * 60_000;
export const TTL_ACESSO_MS = 60 * 60_000;
export const TTL_RENOVACAO_MS = 30 * 24 * 60 * 60_000;
/** quanto tempo a renovação recém-trocada ainda vale como retry (resposta perdida, corrida) */
export const GRACA_RENOVACAO_MS = 60_000;
const TTL_PEDIDO = '10m';
const AUDIENCIA_PEDIDO = 'mcp-pedido-de-login';

export interface Usuario {
  id: string;
  email: string;
  nome: string | null;
  papel: string;
  ativo: boolean;
}

export interface DependenciasOAuth {
  armazem: ArmazemOAuth;
  /** confere e-mail e senha; lança se não conferir */
  autenticar(email: string, senha: string): Promise<Usuario>;
  buscarUsuario(id: string): Promise<Usuario | null>;
  /** segredo pra assinar o pedido de login entre a tela e o POST */
  segredo: string;
  /** endereço público do MCP (ex. https://agente-vps…/mcp): é o "recurso" dos tokens */
  urlMcp: URL;
  /** endereços de retorno aceitos, EXATOS (além de loopback) */
  retornosPermitidos: string[];
  /** hosts que podem publicar documento de cliente (CIMD) */
  hostsCimd: string[];
  cimd?: BuscadorCimd;
  agora?: () => number;
}

export function hash(segredo: string): string {
  return createHash('sha256').update(segredo).digest('hex');
}

function gerar(prefixo: string): string {
  return `${prefixo}${randomBytes(32).toString('base64url')}`;
}

export function podeUsarOConector(u: Usuario | null): u is Usuario {
  return !!u && u.ativo && u.papel === 'SUPER_ADMIN';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Retorno aceito: um dos endereços exatos, ou http em loopback (qualquer porta, RFC 8252). */
export function retornoAceito(uri: string, permitidos: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return permitidos.includes(uri);
}

/** Compara recursos ignorando a barra final: `…/mcp` e `…/mcp/` são o mesmo. */
function mesmoRecurso(a: string | URL, b: string | URL): boolean {
  const n = (x: string | URL) => String(x).replace(/\/+$/, '');
  return n(a) === n(b);
}

interface Pedido {
  cid: string;
  ru: string;
  cc: string;
  st?: string;
  sc: string[];
  rs?: string;
}

export type ResultadoLogin = { redirecionar: string } | { status: number; html: string; retorno?: string };

export class ProvedorOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  /** 8 erros por IP+e-mail em 15 min: trava a tentativa daquele lugar, sem travar a diretora no escritório */
  readonly errosPorIpEmail = new JanelaDeContagem(8, 15 * 60_000);
  /** 30 erros por IP em 15 min: e-mail aleatório a cada tentativa não escapa */
  readonly errosPorIp = new JanelaDeContagem(30, 15 * 60_000);
  /** 60 tentativas por minuto no total: teto do bcrypt, de qualquer origem */
  readonly tentativasGlobais = new JanelaDeContagem(60, 60_000);
  private agora: () => number;
  private cimd: BuscadorCimd;

  constructor(private d: DependenciasOAuth) {
    this.agora = d.agora ?? Date.now;
    this.cimd = d.cimd ?? new BuscadorCimd(d.hostsCimd);
    this.clientsStore = {
      getClient: async (clientId) => {
        // CIMD: o client_id é a URL de um documento publicado pelo próprio cliente (o claude.ai publica o seu).
        // Fica só com os retornos que aceitamos; sem nenhum, o cliente não existe pra nós.
        if (clientId.startsWith('https://')) {
          const c = await this.cimd.buscar(clientId);
          const aceitos = c?.redirect_uris.filter((r) => retornoAceito(r, d.retornosPermitidos)) ?? [];
          return c && aceitos.length ? { ...c, redirect_uris: aceitos } : undefined;
        }
        return d.armazem.pegarCliente(clientId);
      },
      registerClient: async (metadados) => {
        // o SDK gera o client_id antes de chamar aqui (clientIdGeneration, padrão ligado); o tipo é que não sabe
        const pedido = metadados as OAuthClientInformationFull;
        if (!pedido.client_id) throw new InvalidClientMetadataError('cliente sem client_id');
        const recusados = pedido.redirect_uris.filter((r) => !retornoAceito(r, d.retornosPermitidos));
        if (recusados.length) {
          throw new InvalidClientMetadataError(`redirect_uri não permitido neste servidor: ${recusados.join(', ')}`);
        }
        // Todo cliente vira PÚBLICO (só PKCE, sem segredo): o SDK compara segredo em texto puro, então
        // guardá-lo seria deixar uma credencial legível no banco. A RFC 7591 permite o servidor ajustar
        // os metadados; o cliente usa o que voltar.
        const { client_secret: _s, client_secret_expires_at: _e, ...semSegredo } = pedido;
        const cliente: OAuthClientInformationFull = { ...semSegredo, token_endpoint_auth_method: 'none' };
        await d.armazem.salvarCliente(cliente);
        return cliente;
      },
    };
  }

  // ── 1. tela de login ──────────────────────────────────────────────

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !mesmoRecurso(params.resource, this.d.urlMcp)) {
      throw new InvalidTargetError('este servidor só emite acesso para o próprio MCP');
    }
    const pedido: Pedido = {
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes ?? [],
      rs: params.resource?.href,
    };
    const assinado = jwt.sign(pedido, this.d.segredo, { expiresIn: TTL_PEDIDO, audience: AUDIENCIA_PEDIDO });
    enviarPagina(res, 200, params.redirectUri, paginaDeLogin({ pedido: assinado, cliente: client.client_name, retorno: params.redirectUri }));
  }

  /**
   * O POST da tela. Devolve o que o handler HTTP deve fazer: redirecionar pro cliente com o código,
   * ou mostrar a tela de novo com um erro. Separado do Express pra ser testado direto.
   */
  async concluirLogin(corpo: { pedido?: unknown; email?: unknown; senha?: unknown }, ip: string): Promise<ResultadoLogin> {
    let p: Pedido;
    try {
      p = jwt.verify(String(corpo.pedido ?? ''), this.d.segredo, { audience: AUDIENCIA_PEDIDO }) as Pedido;
    } catch {
      return { status: 400, html: paginaDeLogin({ erro: 'Este pedido de login venceu. Volte ao Claude e clique em Conectar de novo.' }) };
    }
    const cliente = await this.clientsStore.getClient(p.cid);
    if (!cliente || !cliente.redirect_uris.some((r) => redirectUriMatches(p.ru, r))) {
      return { status: 400, html: paginaDeLogin({ erro: 'Cliente desconhecido. Volte ao Claude e conecte de novo.' }) };
    }
    const tela = (erro: string, status = 401): ResultadoLogin => ({
      status,
      retorno: p.ru,
      html: paginaDeLogin({ pedido: String(corpo.pedido), cliente: cliente.client_name, retorno: p.ru, erro, email: String(corpo.email ?? '') }),
    });

    const email = String(corpo.email ?? '').trim().toLowerCase();
    const agora = this.agora();
    const chave = `${ip}|${email}`;
    // os freios vêm ANTES do bcrypt: é ele que custa CPU
    if (this.errosPorIpEmail.excedido(chave, agora) || this.errosPorIp.excedido(ip, agora) || this.tentativasGlobais.excedido('*', agora)) {
      return tela('Muitas tentativas. Espere alguns minutos e tente de novo.', 429);
    }
    this.tentativasGlobais.registrar('*', agora);

    let usuario: Usuario;
    try {
      usuario = await this.d.autenticar(email, String(corpo.senha ?? ''));
    } catch {
      this.errosPorIpEmail.registrar(chave, agora);
      this.errosPorIp.registrar(ip, agora);
      return tela('E-mail ou senha incorretos.');
    }
    if (!podeUsarOConector(usuario)) return tela('Este conector é só para a diretoria da Doutor Digital.', 403);
    this.errosPorIpEmail.limpar(chave);

    const codigo = gerar('ddc_');
    await this.d.armazem.salvarCodigo({
      codigoHash: hash(codigo),
      clientId: cliente.client_id,
      userId: usuario.id,
      redirectUri: p.ru,
      codeChallenge: p.cc,
      escopos: p.sc,
      recurso: p.rs ?? null,
      concessaoId: randomUUID(),
      expiraEm: new Date(agora + TTL_CODIGO_MS),
      usadoEm: null,
    });
    const volta = new URL(p.ru);
    volta.searchParams.set('code', codigo);
    if (p.st) volta.searchParams.set('state', p.st);
    return { redirecionar: volta.href };
  }

  // ── 2. código → tokens ───────────────────────────────────────────

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, codigo: string): Promise<string> {
    const c = await this.d.armazem.lerCodigo(hash(codigo));
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('código inválido');
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    codigo: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const h = hash(codigo);
    const c = await this.d.armazem.lerCodigo(h);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('código inválido');
    // confere tudo ANTES de gastar o código: pedido malformado não queima o código bom
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri não confere');
    if (resource && !mesmoRecurso(resource, c.recurso ?? this.d.urlMcp)) throw new InvalidTargetError('recurso não confere');
    const agora = new Date(this.agora());
    if (!(await this.d.armazem.usarCodigo(h, agora))) {
      // relê: se alguém usou (mesmo agora, em paralelo), é cópia do código — derruba o que ele gerou (RFC 6749 §4.1.2)
      if ((await this.d.armazem.lerCodigo(h))?.usadoEm) await this.d.armazem.revogarConcessao(c.concessaoId, agora);
      throw new InvalidGrantError('código vencido ou já usado');
    }
    if (!podeUsarOConector(await this.d.buscarUsuario(c.userId))) throw new InvalidGrantError('usuário sem acesso');
    return this.emitir(c.concessaoId, c.clientId, c.userId, c.escopos, c.recurso);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    renovacao: string,
    escopos?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const h = hash(renovacao);
    const t = await this.d.armazem.lerToken(h);
    if (!t || t.tipo !== 'renovacao' || t.clientId !== client.client_id) throw new InvalidGrantError('token de renovação inválido');
    const agora = new Date(this.agora());
    if (t.expiraEm <= agora) throw new InvalidGrantError('token de renovação vencido');
    // pedido malformado é recusado SEM gastar a renovação
    if (escopos?.some((e) => !t.escopos.includes(e))) throw new InvalidScopeError('escopo maior que o concedido');
    if (resource && !mesmoRecurso(resource, t.recurso ?? this.d.urlMcp)) throw new InvalidTargetError('recurso não confere');
    const novosEscopos = escopos?.length ? escopos : t.escopos;

    if (t.revogadoEm) {
      await this.d.armazem.revogarConcessao(t.concessaoId, agora);
      throw new InvalidGrantError('token de renovação revogado');
    }
    if (!t.substituidoEm && (await this.d.armazem.substituirSeAtivo(h, agora))) {
      return this.renovarPara(t, novosEscopos, agora);
    }
    // já tinha sido trocada (agora há pouco, por outra chamada, ou antes)
    const atual = t.substituidoEm ? t : await this.d.armazem.lerToken(h);
    if (atual?.substituidoEm && !atual.revogadoEm && agora.getTime() - atual.substituidoEm.getTime() <= GRACA_RENOVACAO_MS) {
      return this.renovarPara(t, novosEscopos, agora); // retry legítimo
    }
    // reuso fora da janela: quem tem a cópia não pode continuar (OAuth 2.1 §4.3.1)
    await this.d.armazem.revogarConcessao(t.concessaoId, agora);
    throw new InvalidGrantError('token de renovação já usado');
  }

  private async renovarPara(t: TokenGuardado, escopos: string[], agora: Date): Promise<OAuthTokens> {
    if (!podeUsarOConector(await this.d.buscarUsuario(t.userId))) {
      await this.d.armazem.revogarConcessao(t.concessaoId, agora);
      throw new InvalidGrantError('usuário sem acesso');
    }
    return this.emitir(t.concessaoId, t.clientId, t.userId, escopos, t.recurso);
  }

  private async emitir(concessaoId: string, clientId: string, userId: string, escopos: string[], recurso: string | null): Promise<OAuthTokens> {
    const acesso = gerar('dda_');
    const renovacao = gerar('ddr_');
    const agora = this.agora();
    const base = { concessaoId, clientId, userId, escopos, recurso, revogadoEm: null, substituidoEm: null };
    await this.d.armazem.salvarToken({ ...base, tokenHash: hash(acesso), tipo: 'acesso', expiraEm: new Date(agora + TTL_ACESSO_MS) });
    await this.d.armazem.salvarToken({ ...base, tokenHash: hash(renovacao), tipo: 'renovacao', expiraEm: new Date(agora + TTL_RENOVACAO_MS) });
    return {
      access_token: acesso,
      token_type: 'Bearer',
      expires_in: TTL_ACESSO_MS / 1000,
      refresh_token: renovacao,
      ...(escopos.length ? { scope: escopos.join(' ') } : {}),
    };
  }

  // ── 3. cada chamada ao /mcp ─────────────────────────────────────

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = await this.d.armazem.lerToken(hash(token));
    if (!t || t.tipo !== 'acesso' || t.revogadoEm || t.expiraEm.getTime() <= this.agora()) {
      throw new InvalidTokenError('token inválido ou vencido');
    }
    if (t.recurso && !mesmoRecurso(t.recurso, this.d.urlMcp)) throw new InvalidTokenError('token de outro recurso');
    // confere o usuário a CADA chamada: desativar no console corta o acesso na hora, sem esperar 1 h
    const usuario = await this.d.buscarUsuario(t.userId);
    if (!podeUsarOConector(usuario)) throw new InvalidTokenError('usuário sem acesso');
    return {
      token,
      clientId: t.clientId,
      scopes: t.escopos,
      expiresAt: Math.floor(t.expiraEm.getTime() / 1000),
      resource: this.d.urlMcp,
      extra: { userId: usuario.id, email: usuario.email },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, pedido: OAuthTokenRevocationRequest): Promise<void> {
    const t = await this.d.armazem.lerToken(hash(pedido.token));
    // RFC 7009: token de outro cliente ou inexistente → responde ok e não faz nada
    if (!t || t.clientId !== client.client_id) return;
    await this.d.armazem.revogarConcessao(t.concessaoId, new Date(this.agora()));
  }
}

/**
 * A tela não pode ir dentro de iframe (clickjacking), não é guardada em cache, e o `form-action`
 * do CSP inclui a origem do retorno — o Chrome aplica o form-action também ao redirect que vem
 * depois do POST, e sem ela o navegador barraria a volta pro claude.ai.
 */
export function enviarPagina(res: Response, status: number, retorno: string | undefined, html: string): void {
  let origemRetorno = '';
  try {
    if (retorno) origemRetorno = ` ${new URL(retorno).origin}`;
  } catch {
    // retorno inválido: fica só 'self'
  }
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${origemRetorno}; frame-ancestors 'none'; base-uri 'none'`,
    })
    .send(html);
}
