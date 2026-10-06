/**
 * O conector remoto do claude.ai: um MCP em `POST /mcp`, protegido por OAuth 2.1, com as
 * ferramentas da franquia (código do spine-mcp em `../franquia-mcp`). Os tokens da franquia
 * ficam no banco desta VPS; o Claude só recebe as respostas.
 *
 * Rotas que entram na raiz do app (o SDK exige a raiz pros metadados):
 *   /.well-known/oauth-authorization-server   metadados do servidor de autorização
 *   /.well-known/oauth-protected-resource/mcp metadados do recurso (aponta pro de cima)
 *   /authorize  /token  /register  /revoke    OAuth (SDK)
 *   POST /oauth/entrar                        o formulário da tela de login
 *   POST /mcp                                 o MCP (Streamable HTTP, sem sessão)
 */
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { criarContexto, type Contexto, type OpcoesContexto, trocarUnidades } from '../franquia-mcp/contexto.js';
import { registrarFerramentas } from '../franquia-mcp/ferramentas.js';
import type { Unidade } from '../franquia-mcp/unidade.js';
import type { ArmazemOAuth } from './armazem.js';
import { enviarPagina, ProvedorOAuth, type Usuario } from './provedor.js';
import type { BuscadorCimd } from './cimd.js';

export interface OpcoesConector {
  /** origem pública do backend, ex. https://agente-vps.doutordigitalconsultoria.com */
  urlPublica: URL;
  armazem: ArmazemOAuth;
  autenticar(email: string, senha: string): Promise<Usuario>;
  buscarUsuario(id: string): Promise<Usuario | null>;
  segredo: string;
  hostsConfiaveis: string[];
  carregarUnidades(): Promise<Map<string, Unidade>>;
  franquia?: OpcoesContexto;
  /** de quanto em quanto tempo relê as unidades do banco (token novo, unidade nova) */
  recarregarUnidadesMs?: number;
  cimd?: BuscadorCimd;
  agora?: () => number;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

const INSTRUCOES = [
  'Dados da franquia Doutor Hérnia (CRM "Spine"), só leitura, de todas as unidades da Doutor Digital.',
  'Comece por listar_unidades. Para relatório da rede use unidade="todas" e leia "rede": ela soma só as unidades',
  'que responderam e lista as que ficaram de fora (unidadesForaDoTotal) ou incompletas (unidadesIncompletas).',
  'Nunca apresente um total sem dizer quais unidades faltaram. Agendamentos são filtrados pela data da consulta;',
  'tratamentos e leads, pela data de criação. Use agruparPor (ex. "statusName") para contar em vez de listar.',
].join(' ');

const ERRO_METODO = { jsonrpc: '2.0', error: { code: -32000, message: 'Use POST: este servidor não mantém sessão.' }, id: null };

export async function montarConectorRemoto(
  app: Express,
  o: OpcoesConector,
): Promise<{ provedor: ProvedorOAuth; contexto: Contexto; urlMcp: URL; parar(): void }> {
  const urlMcp = new URL('/mcp', o.urlPublica);
  const provedor = new ProvedorOAuth({
    armazem: o.armazem,
    autenticar: o.autenticar,
    buscarUsuario: o.buscarUsuario,
    segredo: o.segredo,
    urlMcp,
    hostsConfiaveis: o.hostsConfiaveis,
    cimd: o.cimd,
    agora: o.agora,
  });

  // Metadados com o aviso de CIMD, ANTES do router do SDK (no Express, a primeira rota que casa ganha).
  const metadados = {
    ...createOAuthMetadata({ provider: provedor, issuerUrl: o.urlPublica, scopesSupported: [] }),
    client_id_metadata_document_supported: true,
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').json(metadados);
  });

  // O limite de tentativas do SDK conta por IP; atrás do Traefik todo mundo tem o IP dele, então o
  // limite vira global — aceitável pra poucos usuários. Só desligo o aviso de X-Forwarded-For.
  const semAvisoDeProxy = { rateLimit: { validate: { xForwardedForHeader: false } } };
  app.use(
    mcpAuthRouter({
      provider: provedor,
      issuerUrl: o.urlPublica,
      resourceServerUrl: urlMcp,
      resourceName: 'Doutor Digital',
      scopesSupported: [],
      authorizationOptions: semAvisoDeProxy,
      tokenOptions: semAvisoDeProxy,
      clientRegistrationOptions: semAvisoDeProxy,
      revocationOptions: semAvisoDeProxy,
    }),
  );

  app.post('/oauth/entrar', async (req: Request, res: Response) => {
    try {
      const r = await provedor.concluirLogin(req.body ?? {});
      if ('redirecionar' in r) {
        res.set('Cache-Control', 'no-store').redirect(302, r.redirecionar);
        return;
      }
      enviarPagina(res, r.status, r.retorno, r.html);
    } catch (err) {
      o.log?.warn({ err }, 'mcp-remoto: login falhou com erro inesperado');
      enviarPagina(res, 500, undefined, '<p>Erro inesperado. Tente de novo em instantes.</p>');
    }
  });

  // Ferramentas da franquia: um contexto só (cache, ritmo por token e contador valem pra todas as chamadas).
  const contexto = criarContexto(await o.carregarUnidades(), o.franquia);
  const recarga = setInterval(() => {
    o.carregarUnidades()
      .then((u) => trocarUnidades(contexto, u))
      .catch((err) => o.log?.warn({ err }, 'mcp-remoto: não consegui reler as unidades'));
  }, o.recarregarUnidadesMs ?? 10 * 60_000);
  recarga.unref();

  const exigirToken = requireBearerAuth({ verifier: provedor, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(urlMcp) });

  app.post('/mcp', exigirToken, async (req: Request, res: Response) => {
    const auth = req.auth;
    const userId = String(auth?.extra?.userId ?? '');
    const clientId = auth?.clientId ?? '';
    // Sem sessão: um servidor por requisição. Barato (só registra ferramentas) e não guarda estado entre chamadas.
    const server = new McpServer({ name: 'doutor-digital', version: '1.0.0' }, { instructions: INSTRUCOES });
    registrarFerramentas(server, contexto, {
      auditar: (r) => {
        o.armazem
          .auditar({ userId, clientId, ferramenta: r.ferramenta, argumentos: r.argumentos, ok: r.ok, duracaoMs: r.ms, erro: r.erro })
          .catch((err) => o.log?.warn({ err }, 'mcp-remoto: auditoria não gravou'));
        o.log?.info({ userId, ferramenta: r.ferramenta, ok: r.ok, ms: r.ms }, 'mcp-remoto: ferramenta');
      },
    });
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transporte.close();
      void server.close();
    });
    try {
      await server.connect(transporte);
      await transporte.handleRequest(req, res, req.body);
    } catch (err) {
      o.log?.warn({ err }, 'mcp-remoto: erro ao atender');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'erro interno' }, id: null });
    }
  });
  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json(ERRO_METODO));
  app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json(ERRO_METODO));

  return { provedor, contexto, urlMcp, parar: () => clearInterval(recarga) };
}
