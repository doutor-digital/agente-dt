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
import { type Auditar, registrarFerramentas } from '../franquia-mcp/ferramentas.js';
import type { Unidade } from '../franquia-mcp/unidade.js';
import type { ArmazemOAuth } from './armazem.js';
import { enviarPagina, ProvedorOAuth, type Usuario } from './provedor.js';
import type { BuscadorCimd } from './cimd.js';
import { criarAuditor } from './auditoria.js';
import { ipDoCliente, Semaforo } from './limites.js';

export interface OpcoesConector {
  /** origem pública do backend, ex. https://agente-vps.doutordigitalconsultoria.com */
  urlPublica: URL;
  armazem: ArmazemOAuth;
  autenticar(email: string, senha: string): Promise<Usuario>;
  buscarUsuario(id: string): Promise<Usuario | null>;
  segredo: string;
  /** endereços de retorno aceitos, exatos (ex. https://claude.ai/api/mcp/auth_callback) */
  retornosPermitidos: string[];
  /** hosts que podem publicar documento de cliente (CIMD) */
  hostsCimd: string[];
  carregarUnidades(): Promise<Map<string, Unidade>>;
  franquia?: OpcoesContexto;
  /** de quanto em quanto tempo relê as unidades do banco (token novo, unidade nova) */
  recarregarUnidadesMs?: number;
  /** espera entre tentativas quando a leitura das unidades falha */
  tentarDeNovoMs?: number;
  /** ferramentas rodando ao mesmo tempo, somando todos os usuários */
  ferramentasSimultaneas?: number;
  /** ferramentas além das da franquia (Kommo, cérebro, relatório cruzado), registradas a cada requisição */
  /** `quem.userId` é o usuário do console que fez login no conector (para liberar a escrita só a quem pode). */
  extras?: (server: McpServer, auditar: Auditar, quem: { userId: string; email?: string }) => void;
  cimd?: BuscadorCimd;
  agora?: () => number;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export const INSTRUCOES = [
  'Dados da Doutor Digital, só leitura (as exceções, para quem tem permissão, estão descritas abaixo: umas em dois passos, e no sistema novo de RH/Caixa também SQL direto). Comece por listar_integracoes: ela diz o que cada clínica e cada empresa do grupo (ex. HM Tecnologia) tem ligado.',
  'Fontes: o CRM da franquia Doutor Hérnia (ferramentas sem prefixo: pacientes, agenda, tratamentos, BI),',
  'o CRM comercial Kommo (kommo_*), o ERP Bling das empresas que usam (bling_*: pedidos, contas a receber, notas, clientes),',
  'o Asaas das clínicas (asaas_*: cobranças, extrato do que entrou de verdade, saldo, clientes; para quem tem permissão, também cadastrar cliente e gerar BOLETO em dois passos, numa clínica só — asaas_preparar_cliente/asaas_preparar_cobranca → mostrar o resumo, com a conta e se o cliente será avisado → asaas_confirmar_cliente/asaas_confirmar_cobranca só se a pessoa aprovar; não cancela, não estorna, não edita e não faz Pix, cartão, parcelamento nem transferência),',
  'o RH das empresas que usam o Convênia (convenia_*: colaboradores, admissões e desligamentos, férias, afastamentos — ficha completa, com dado pessoal sensível: CPF, salário, dados bancários, endereço, nascimento e dados de saúde; nas listagens use completo: true para a ficha inteira),',
  'o ponto eletrônico Tiquetaque (tiquetaque_*: batidas do dia e quem está trabalhando agora, atrasos e faltas, horas e banco de horas, afastamentos; uma conta cobre várias clínicas e empresas, filtre por local — registro completo, com dado pessoal sensível: CPF, PIS, foto/selfie e GPS da batida, anexo de atestado e justificativa escrita; em tiquetaque_colaboradores e tiquetaque_horas use completo: true para a ficha e o espelho inteiros),',
  'a Tramitação Inteligente dos escritórios de advocacia (tramitacao_*: processos, publicações, clientes e prazos; só leitura, documentos só como metadados, CPF e telefone mascarados, nunca a senha do Meu INSS; a busca de cliente por nome lê só parte da base: se a resposta vier com truncado, não conclua que o cliente não existe),',
  'os eventos de conversão mandados para a Meta pelo rastreio de anúncios (meta_eventos, meta_eventos_lead),',
  'e, para quem tem permissão, alterar cartões do Kommo em dois passos (kommo_preparar_alteracao → mostrar o resumo → kommo_confirmar_alteracao só se a pessoa aprovar).',
  'Para quem tem permissão, preparar disparo de campanha pela API oficial do WhatsApp (disparo_*: cadastrar a campanha, montar a onda, ler a prévia e devolver o LINK do painel); aprovar e retomar o envio são do João no painel, nunca por aqui.',
  'Para quem tem permissão, o WhatsApp da Suzanne (evo_*): ler e organizar conversas, grupos e etiquetas; enviar só em dois passos (evo_preparar → mostrar → evo_confirmar com o ok da pessoa).',
  'SISTEMAS DA PATROA (sistemas_*): o RH, o Caixa, o Financeiro, os DESCONTRATOS e a FICHA vivem no sistema novo, em servidor próprio (PostgreSQL). Dois sistemas: sistema="rh" (RH/Caixa/Financeiro) e sistema="descontratos" (Descontratos + Ficha). NÃO use o conector do Supabase para ler nem gravar nesses sistemas: o Supabase antigo não é mais a fonte (as telas já leem o servidor novo), então o que se gravar lá não aparece para ninguém. Tudo o que precisar ler ou gravar neles passa pelas ferramentas sistemas_*.',
  'Para todos, só LER: sistemas_esquema (mapa do banco), sistemas_consultar (SELECT), sistemas_usuarios, sistemas_log (registro de alterações), sistemas_simular (o que um usuário enxerga).',
  'Para quem tem permissão, CRIAR e ALTERAR quase tudo, SEM pedir confirmação, com sistemas_sql: criar tabela, view, índice, função, gatilho, política, tipo e sequência, alterar tabela, comentar, dar GRANT, renomear, INSERT, UPDATE e DELETE com WHERE. Antes de cada mudança o sistema tira sozinho uma cópia de segurança (backup) do esquema e das linhas tocadas; se o backup falhar, nada roda. Tudo fica no registro (quem, quando, o SQL, as linhas afetadas). Veja o sistemas_esquema antes de escrever.',
  'O que DESTRÓI continua em dois passos (sistemas_preparar_sql → mostrar o resumo à pessoa → sistemas_confirmar_sql só se ela aprovar): DROP, TRUNCATE, UPDATE ou DELETE sem WHERE, apagar coluna ou restrição, REVOKE e desligar a segurança por linha. O que NUNCA roda, nem com confirmação: mexer em auth/storage/catálogo do banco, em senhas, nas tabelas de usuários (rh_usuarios, dsc_usuarios) e no registro de auditoria, SET ROLE, SECURITY DEFINER, COPY, extensões, VACUUM e BEGIN/COMMIT.',
  'Usuários do RH: sistemas_usuario (papel, inclusive ADMIN, unidade, ativo) e sistemas_convite (link de acesso, inclusive de admin) rodam direto; TIRAR ou desativar um admin é em dois passos (sistemas_preparar_admin → sistemas_confirmar_admin). Os usuários do Descontratos são geridos pela tela de administração dele. Outros caminhos mais cuidadosos continuam no RH: sistemas_preparar_alteracao/sistemas_confirmar_alteracao (uma linha, mostrando antes → depois) e sistemas_preparar_tabela/coluna/indice → sistemas_confirmar_estrutura.',
  'o cérebro que confere um contra o outro (cerebro_*), o relatório cruzado (relatorio_funil) e, para Kommo + Bling, relatorio_vendas.',
  'Para "quantos leads viraram consulta/tratamento", use relatorio_funil: o cruzamento Kommo → franquia é feito em código, por telefone,',
  'e vem com a cobertura — não some números de ferramentas diferentes por conta própria. Unidade aceita nome curto ("serra").',
  'Petrópolis e Caxias dividem um Kommo e são DUAS unidades: cada uma vê só os cartões com o seu "⌂ Unidade de atendimento";',
  'cartão sem unidade não entra em nenhuma (vem contado em semUnidade, o MESMO número nas duas; na rede, rede.semUnidade). Nunca some os sem unidade a uma das duas.',
  'Para relatório da rede use unidade="todas" onde houver e leia "rede": ela soma só as unidades que responderam e lista as que',
  'ficaram de fora (unidadesForaDoTotal) ou incompletas (unidadesIncompletas). Nunca apresente um total sem dizer quais faltaram.',
  'Agendamentos são filtrados pela data da consulta; tratamentos e leads, pela data de criação. Use agruparPor para contar em vez de listar.',
  'Alcance, cliques e gasto de anúncio vêm do conector do Metricool (se estiver ligado): cruze com a "origem" do relatorio_funil.',
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
    retornosPermitidos: o.retornosPermitidos,
    hostsCimd: o.hostsCimd,
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

  // O limite de tentativas do SDK conta por IP. Atrás do Traefik o `req.ip` é o dele pra todo mundo:
  // um desconhecido gastaria a cota da diretoria (e a renovação dela daria 429). Conta pelo IP real.
  const porIpReal = { rateLimit: { keyGenerator: ipDoCliente, validate: false } };
  app.use(
    mcpAuthRouter({
      provider: provedor,
      issuerUrl: o.urlPublica,
      resourceServerUrl: urlMcp,
      resourceName: 'Doutor Digital',
      scopesSupported: [],
      authorizationOptions: porIpReal,
      tokenOptions: porIpReal,
      clientRegistrationOptions: porIpReal,
      revocationOptions: porIpReal,
    }),
  );

  app.post('/oauth/entrar', async (req: Request, res: Response) => {
    try {
      const r = await provedor.concluirLogin(req.body ?? {}, ipDoCliente(req));
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
  // As unidades carregam EM SEGUNDO PLANO: banco lento na subida não segura o agente, e o conector
  // nunca fica pela metade (OAuth no ar e /mcp faltando) — até carregar, as ferramentas dizem que está carregando.
  const contexto = criarContexto(new Map(), o.franquia);
  let proxima: NodeJS.Timeout | undefined;
  let parado = false;
  const carregar = () => {
    o.carregarUnidades()
      .then((u) => {
        trocarUnidades(contexto, u);
        agendar(o.recarregarUnidadesMs ?? 10 * 60_000);
      })
      .catch((err) => {
        o.log?.warn({ err }, 'mcp-remoto: não consegui ler as unidades; tento de novo');
        agendar(o.tentarDeNovoMs ?? 30_000);
      });
  };
  const agendar = (ms: number) => {
    if (parado) return;
    proxima = setTimeout(carregar, ms);
    proxima.unref();
  };
  carregar();

  const limpeza = setInterval(() => {
    o.armazem.limparVencidos(new Date()).catch((err) => o.log?.warn({ err }, 'mcp-remoto: limpeza de tokens vencidos falhou'));
  }, 6 * 3_600_000);
  limpeza.unref();

  // Os tokens da franquia são os mesmos da Sofia. Além do ritmo por token, no máximo N ferramentas ao
  // mesmo tempo no conector inteiro: um relatório grande não vira rajada em cima da agenda dela.
  const vagas = new Semaforo(o.ferramentasSimultaneas ?? 2, 60_000);

  const exigirToken = requireBearerAuth({ verifier: provedor, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(urlMcp) });

  app.post('/mcp', exigirToken, async (req: Request, res: Response) => {
    const auth = req.auth;
    const userId = String(auth?.extra?.userId ?? '');
    const clientId = auth?.clientId ?? '';
    // Sem sessão: um servidor por requisição. Barato (só registra ferramentas) e não guarda estado entre chamadas.
    const server = new McpServer({ name: 'doutor-digital', version: '1.0.0' }, { instructions: INSTRUCOES });
    const auditar: Auditar = criarAuditor(o.armazem, { userId, clientId }, o.log);
    registrarFerramentas(server, contexto, { auditar });
    o.extras?.(server, auditar, { userId, email: String(auth?.extra?.email ?? '') || undefined });
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transporte.close();
      void server.close();
    });
    let sair: (() => void) | undefined;
    try {
      if (req.body?.method === 'tools/call') sair = await vagas.entrar();
      res.on('close', () => sair?.());
      await server.connect(transporte);
      await transporte.handleRequest(req, res, req.body);
    } catch (err) {
      if (err instanceof Error && err.message === 'conector ocupado') {
        res.status(503).set('Retry-After', '30').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Conector ocupado com outros relatórios. Tente em 30 s.' }, id: req.body?.id ?? null });
        return;
      }
      o.log?.warn({ err }, 'mcp-remoto: erro ao atender');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'erro interno' }, id: null });
    }
  });
  app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json(ERRO_METODO));
  app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json(ERRO_METODO));

  return {
    provedor,
    contexto,
    urlMcp,
    parar: () => {
      parado = true;
      clearTimeout(proxima);
      clearInterval(limpeza);
    },
  };
}
