import type { Router } from 'express';

type Metodo = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RotaLida {
  metodo: Metodo;
  path: string;
}

function lerRotas(router: Router): RotaLida[] {
  const out: RotaLida[] = [];
  try {
    const stack = (router as unknown as { stack?: unknown[] }).stack ?? [];
    for (const camada of stack) {
      const c = camada as { route?: { path?: unknown; methods?: Record<string, boolean> } };
      const path = c.route?.path;
      if (typeof path !== 'string') continue;
      for (const [m, ativo] of Object.entries(c.route?.methods ?? {})) {
        if (ativo && ['get', 'post', 'put', 'patch', 'delete'].includes(m)) {
          out.push({ metodo: m as Metodo, path });
        }
      }
    }
  } catch {
    return [];
  }
  return out;
}

function paraOpenApi(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const convertido = path.replace(/:(\w+)/g, (_, nome: string) => {
    params.push(nome);
    return `{${nome}}`;
  });
  return { path: convertido, params };
}

function areaDe(path: string): string {
  const regras: Array<[RegExp, string]> = [
    [/^\/relatorios/, 'Relatórios'],
    [/^\/cerebro/, 'Relatórios'],
    [/^\/webhooks/, 'Webhooks'],
    [/^\/auth/, 'Autenticação'],
    [/^\/(debug|health)/, 'Diagnóstico'],
    [/^\/integrations/, 'Integrações'],
    [/^\/(users|global-actions|admin)/, 'Plataforma'],
    [/\/(lessons|knowledge|templates|strategy-lab|changelog|playground|config|prompt)/, 'Agente'],
    [/\/(spine|agenda|kommo|follow-up|leads)/, 'Agenda e CRM'],
    [/\/(reports|traces|llm|conversations|stats|dashboard|whatsapp|sla|logs)/, 'Análise'],
    [/^\/units/, 'Unidades'],
  ];
  for (const [re, area] of regras) if (re.test(path)) return area;
  return 'Outros';
}

function acessoDe(path: string): string {
  if (path.startsWith('/webhooks')) return 'Aberto (assinatura do serviço externo)';
  if (path === '/health') return 'Aberto';
  if (path.startsWith('/relatorios') || path === '/cerebro/unidades') return 'Chave de serviço (x-internal-key) ou super admin';
  if (path.startsWith('/debug') || path.startsWith('/users') || path.startsWith('/global-actions')) {
    return 'Super admin';
  }
  if (path.startsWith('/units/:id')) return 'Logado, com acesso à unidade';
  return 'Logado';
}

const DESCRICOES: Record<string, string> = {
  'GET /health': 'Diz apenas que o servidor está de pé.',
  'GET /debug/diagnostico': 'Raio-x completo: banco, OpenAI, Claude, atendimento, juiz e unidades. Prova cada dependência em vez de só dizer "ok". Não consome crédito de IA.',
  'POST /auth/login': 'Entra no painel. Devolve um cookie de sessão assinado.',
  'POST /auth/logout': 'Encerra a sessão.',
  'GET /auth/me': 'Quem está logado e qual o nível de acesso.',
  'GET /units': 'Lista as clínicas que você pode ver.',
  'POST /units': 'Cria uma clínica nova.',
  'GET /units/:id': 'Configuração completa da clínica. Segredos voltam mascarados.',
  'PATCH /units/:id': 'Altera a configuração da clínica.',
  'POST /units/:id/clone': 'Duplica uma clínica como molde pra outra.',
  'GET /units/:id/lessons': 'Aprendizados: as regras que a IA aplica só nesta clínica.',
  'POST /units/:id/lessons': 'Cria um aprendizado.',
  'POST /units/:id/lessons/reflect': 'A IA relê as conversas recentes e propõe aprendizados novos (chegam desligados, você aprova).',
  'POST /units/:id/strategy-lab': 'Gera 3 mensagens com abordagens diferentes para um lead travado.',
  'GET /units/:id/changelog': 'Histórico de tudo que foi treinado ou corrigido nesta clínica.',
  'GET /units/:id/knowledge': 'Base de conhecimento (perguntas e respostas prontas).',
  'GET /units/:id/dashboard': 'Números da clínica para o painel.',
  'GET /units/:id/prompt-performance': 'Qualidade média por versão de prompt, com o nível de confiança da amostra.',
  'POST /webhooks/:unitSlug/kommo': 'Entrada das mensagens do Kommo. É por aqui que a conversa do paciente chega.',
  'POST /webhooks/:unitSlug/salesbot': 'Entrada pelo Salesbot do Kommo.',
  'POST /webhooks/:unitSlug/widget': 'Entrada pelo modo widget do Salesbot.',
  'POST /webhooks/:unitSlug/meta': 'Entrada do WhatsApp oficial (Meta).',
  'GET /webhooks/:unitSlug/meta': 'Verificação do webhook exigida pela Meta.',
};


/* ───────────── rotas com contrato detalhado ─────────────
 * O gerador acima lê o Express e só sabe "existe esta rota". Para as que o n8n chama com chave de
 * serviço isso não basta: quem testa precisa ver os parâmetros, o cabeçalho e o formato da resposta.
 * Cada entrada aqui SOBREPÕE a genérica da mesma rota. */

const CHAVE = [{ ChaveDeServico: [] }];

const CONTAGEM = {
  type: 'object',
  description: 'Agendamentos de uma categoria no dia. `marcadas` já desconta desmarcadas e remarcadas.',
  properties: {
    marcadas: { type: 'integer', example: 4 },
    atendidas: { type: 'integer', example: 3 },
    faltas: { type: 'integer', example: 1 },
    abertas: { type: 'integer', description: 'Marcado ou confirmado, sem desfecho até agora', example: 0 },
    desmarcadas: { type: 'integer', example: 0 },
  },
};

export const SCHEMAS_RELATORIO = {
  Contagem: CONTAGEM,
  ResumoAgenda: {
    type: 'object',
    properties: {
      avaliacao: { $ref: '#/components/schemas/Contagem' },
      sessao: { $ref: '#/components/schemas/Contagem' },
      retorno: { $ref: '#/components/schemas/Contagem' },
      amanha: {
        type: 'object',
        description: 'Marcados para amanhã, sem os desmarcados',
        properties: { avaliacao: { type: 'integer' }, sessao: { type: 'integer' }, retorno: { type: 'integer' } },
      },
      semCategoria: { type: 'integer', description: 'Agendamentos de hoje/amanhã cuja categoria o relatório não reconhece. Ficam fora da conta.' },
    },
  },
  UnidadeRelatada: {
    type: 'object',
    properties: {
      slug: { type: 'string', example: 'doutor-hernia-serra' },
      nome: { type: 'string', example: 'Serra' },
      leadsNovos: { type: 'integer', nullable: true, description: 'null = o Kommo não respondeu (veja `falhas`)' },
      agenda: { allOf: [{ $ref: '#/components/schemas/ResumoAgenda' }], nullable: true, description: 'null = a franquia não respondeu' },
      tratamentos: {
        type: 'object', nullable: true,
        properties: { fechadosHoje: { type: 'integer' }, valorHoje: { type: 'number', description: 'Soma do `price` dos tratamentos criados hoje e não cancelados' } },
      },
      analise: { allOf: [{ $ref: '#/components/schemas/AnaliseUnidade' }], nullable: true, description: 'Últimos 7 dias, dos campos do cartão. null = o Kommo não respondeu' },
      falhas: { type: 'array', items: { type: 'string' }, description: 'O que deu errado nesta unidade, em palavras de gente' },
    },
  },
  AnaliseUnidade: {
    type: 'object',
    description: 'Campos do cartão no Kommo, janela de 7 dias. Todo motivo vem com `registradas` (quantos casos tinham o campo preenchido).',
    properties: {
      leads: { type: 'object', description: 'Leads criados na janela, por ★ Qualificação', properties: { total: { type: 'integer' }, quente: { type: 'integer' }, morno: { type: 'integer' }, frio: { type: 'integer' }, semQualificacao: { type: 'integer' } } },
      objecoes: { $ref: '#/components/schemas/Motivos' },
      consultas: { type: 'object', description: 'Cartões com ◷ Data da Consulta na janela, por ✓ Situação da consulta', properties: { total: { type: 'integer' }, atendidas: { type: 'integer' }, faltas: { type: 'integer' }, desmarcadas: { type: 'integer' }, abertas: { type: 'integer' }, semSituacao: { type: 'integer' } } },
      antecipado: { type: 'object', description: '`comprovante` = ✓ Consulta pg antecipado; `disseQueIaPagar` = ¤ Pagamento antecipado. `pagou`/`naoPagou` cruzam o comprovante com a situação.', properties: {
        comprovante: { type: 'integer' }, disseQueIaPagar: { type: 'integer' },
        pagou: { type: 'object', properties: { atendidas: { type: 'integer' }, faltas: { type: 'integer' } } },
        naoPagou: { type: 'object', properties: { atendidas: { type: 'integer' }, faltas: { type: 'integer' } } } } },
      faltas: { $ref: '#/components/schemas/Motivos' },
      naoFechou: { $ref: '#/components/schemas/Motivos' },
      camposAusentes: { type: 'array', items: { type: 'string' }, description: 'Campos que esta conta do Kommo não tem' },
      truncado: { type: 'boolean', description: 'A lista do Kommo bateu no teto de páginas: os números são um piso' },
    },
  },
  Motivos: {
    type: 'object',
    properties: {
      registradas: { type: 'integer', description: 'Quantos casos tinham o motivo preenchido' },
      ranking: { type: 'array', items: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }] }, example: [['Sem condições financeira', 15], ['Vai se organizar', 5]] },
    },
  },
  RelatorioRede: {
    type: 'object',
    required: ['data', 'texto', 'saude'],
    properties: {
      data: { type: 'string', example: '2026-09-30' },
      geradoEm: { type: 'string', format: 'date-time' },
      duracaoMs: { type: 'integer', example: 48211 },
      texto: { type: 'string', description: 'As mensagens juntas numa string só. Só negrito com `*`.' },
      mensagens: { type: 'array', items: { type: 'string' }, description: 'Uma mensagem de WhatsApp por item: [placar do dia (franquia), análise dos 7 dias (Kommo)]. É o que o n8n envia.' },
      janela: { type: 'object', description: 'Período da análise', properties: { de: { type: 'string', example: '2026-09-24' }, ate: { type: 'string', example: '2026-09-30' } } },
      totaisAnalise: { $ref: '#/components/schemas/AnaliseUnidade' },
      totais: { type: 'object', description: 'Soma da rede: leads, avaliacao, sessao, retorno, amanha, tratamentos' },
      unidades: { type: 'array', items: { $ref: '#/components/schemas/UnidadeRelatada' } },
      semFranquia: { type: 'array', items: { type: 'string' }, description: 'Unidades ativas que ficaram de fora por não terem a franquia ligada' },
      saude: {
        type: 'object',
        description: 'O n8n olha `completo`: se for false, avisa o João à parte',
        properties: { unidades: { type: 'integer' }, falhas: { type: 'integer' }, completo: { type: 'boolean' } },
      },
    },
  },
  ErroSimples: {
    type: 'object',
    properties: { error: { type: 'string', example: 'data_invalida' }, detalhe: { type: 'string' } },
  },
};

const R401 = { description: 'Sem chave de serviço válida e sem sessão de super admin' };

export const ROTAS_DETALHADAS: Record<string, Record<string, unknown>> = {
  '/relatorios/rede-diaria': {
    get: {
      tags: ['Relatórios'],
      operationId: 'relatorioRedeDiaria',
      summary: 'Relatório das 18h da rede (franquia + Kommo)',
      description:
        'Duas partes: o **placar do dia** (agenda e tratamentos da franquia + leads novos do Kommo) e a **análise dos últimos 7 dias** ' +
        '(leads quentes e qualificação, objeção principal, faltas e seus motivos, pagamento antecipado × comparecimento, dos campos do cartão no Kommo).\n\n' +
        '**Só leitura.** Não envia mensagem, não grava campo, não move cartão — pode chamar à vontade.\n\n' +
        'Pode levar de 1 a alguns minutos na rede inteira (2 unidades por vez, teto de 75 s por unidade). ' +
        'Para testar rápido, use `unidades=` com um slug só.\n\n' +
        '**Acesso:** chave de serviço no cabeçalho `x-internal-key`, ou sessão de super admin.',
      security: CHAVE,
      parameters: [
        { name: 'data', in: 'query', required: false, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-09-30' },
          description: 'Dia a relatar, AAAA-MM-DD. Padrão: hoje no fuso da clínica. Use para conferir um dia passado.' },
        { name: 'unidades', in: 'query', required: false, schema: { type: 'string', example: 'doutor-hernia-serra,doutor-hernia-maraba' },
          description: 'Slugs separados por vírgula. Padrão: toda unidade ativa com a franquia ligada. Com este filtro o bloco "sem franquia" não aparece.' },
        { name: 'formato', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'texto'], default: 'json' },
          description: '`texto` devolve só a mensagem, em texto puro — bom para ler no navegador.' },
      ],
      responses: {
        '200': {
          description: 'O relatório. Com `formato=texto` vem `text/plain`.',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RelatorioRede' } },
            'text/plain': { schema: { type: 'string' } },
          },
        },
        '400': { description: '`data` fora do formato AAAA-MM-DD', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErroSimples' } } } },
        '401': R401,
        '404': { description: 'Nenhuma unidade elegível (slug errado, ou nenhuma com franquia ligada)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErroSimples' } } } },
        '500': { description: 'Falha inesperada ao montar o relatório', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErroSimples' } } } },
      },
    },
  },
  '/cerebro/unidades': {
    get: {
      tags: ['Relatórios'],
      operationId: 'cerebroUnidades',
      summary: 'Lista mínima de unidades e se a franquia está ligada',
      description:
        'Serve para conferir **quem entra no relatório** antes de rodá-lo: entra quem está com `franquiaLigada = true`.\n\n' +
        'Devolve só slug, nome e se há token da franquia — nunca a credencial.\n\n**Acesso:** chave de serviço ou sessão logada.',
      security: CHAVE,
      responses: {
        '200': {
          description: 'Lista de unidades',
          content: { 'application/json': { schema: { type: 'object', properties: { unidades: { type: 'array', items: {
            type: 'object', properties: { slug: { type: 'string' }, nome: { type: 'string' }, franquiaLigada: { type: 'boolean' } } } } } } } },
        },
        '401': R401,
      },
    },
  },
};

export interface OpenApiDoc {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<{ url: string; description?: string }>;
  tags: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

const AREAS_DESC: Record<string, string> = {
  Relatórios: 'Relatórios para a gestão e a lista de conferência. Todas de leitura. Entram com a chave de serviço (`x-internal-key`).',
  Webhooks: 'Portas de entrada. Quem chama é o Kommo, a Meta e o Instagram — não você.',
  Autenticação: 'Entrar e sair do painel.',
  Diagnóstico: 'Use quando algo "não funciona" e você não sabe por quê.',
  Unidades: 'As clínicas: criar, listar, configurar.',
  Agente: 'O cérebro da IA: conhecimento, aprendizados e sugestões.',
  'Agenda e CRM': 'Conexão com a agenda da franquia e com o Kommo.',
  Análise: 'Relatórios, custo, conversas e histórico de execução.',
  Integrações: 'Chamadas máquina-a-máquina (n8n).',
  Plataforma: 'Usuários e regras que valem para todas as clínicas.',
  Outros: 'Demais endpoints.',
};

export function gerarOpenApi(router: Router, baseUrl: string): OpenApiDoc {
  const rotas = lerRotas(router);
  const paths: OpenApiDoc['paths'] = {};
  const areasUsadas = new Set<string>();

  for (const r of rotas) {
    const { path, params } = paraOpenApi(r.path);
    const area = areaDe(r.path);
    areasUsadas.add(area);
    const chave = `${r.metodo.toUpperCase()} ${r.path}`;
    const descricao = DESCRICOES[chave];
    const acesso = acessoDe(r.path);

    paths[path] ??= {};
    paths[path][r.metodo] = {
      tags: [area],
      summary: descricao ?? `${r.metodo.toUpperCase()} ${path}`,
      description: `**Acesso:** ${acesso}${descricao ? `\n\n${descricao}` : ''}`,
      parameters: params.map((nome) => ({
        name: nome,
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description: nome === 'id' ? 'ID da clínica' : nome === 'unitSlug' ? 'Apelido da clínica na URL' : undefined,
      })),
      responses: {
        '200': { description: 'Deu certo' },
        '401': { description: 'Sessão ausente ou expirada' },
        '403': { description: 'Sem acesso a esta clínica' },
      },
    };
  }

  for (const [caminho, ops] of Object.entries(ROTAS_DETALHADAS)) {
    paths[caminho] = { ...(paths[caminho] ?? {}), ...ops };
    areasUsadas.add('Relatórios');
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'API do Agente DT',
      version: '1.22.0',
      description:
        'API do sistema que atende os pacientes no WhatsApp, conecta ao Kommo e à agenda da franquia.\n\n' +
        '**Autenticação:** o painel entra em `POST /auth/login` e recebe um cookie de sessão assinado. ' +
        'Toda chamada seguinte envia esse cookie. **Exceção:** as rotas da área *Relatórios* e as do cérebro/faxina aceitam, no lugar do cookie, a chave de serviço no cabeçalho `x-internal-key`.\n\n' +
        '**Segredos** (chaves de API, tokens) sempre voltam mascarados, com um mapa `_hasSecrets` ' +
        'dizendo apenas se cada um está preenchido.\n\n' +
        '_Esta página é gerada a partir das rotas reais do servidor — se a rota existe, ela aparece aqui._',
    },
    servers: [{ url: baseUrl, description: 'Produção' }],
    tags: [...areasUsadas].sort().map((name) => ({ name, description: AREAS_DESC[name] })),
    paths,
    components: {
      schemas: SCHEMAS_RELATORIO,
      securitySchemes: {
        ChaveDeServico: {
          type: 'apiKey', in: 'header', name: 'x-internal-key',
          description: 'A `INTERNAL_API_KEY` do backend. É a mesma que o n8n usa na faxina das 20h.',
        },
      },
    },
  };
}

/**
 * Só o contrato dos Relatórios, sem ler o Express. Serve ao servidor de teste local e ao arquivo
 * exportado para Postman/Insomnia/Bruno — lugares que não têm (nem devem ter) o backend inteiro de pé.
 */
export function gerarOpenApiRelatorios(servers: Array<{ url: string; description?: string }>): OpenApiDoc {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Relatório da rede · 18h',
      version: '1.0.0',
      description:
        'Contrato da rota que alimenta o relatório das 18h da chefe. **Só leitura**: nada aqui envia mensagem ou grava dado.\n\n' +
        'Autenticação: cabeçalho `x-internal-key` com a `INTERNAL_API_KEY` do backend. Em **Authentication**, escolha `ChaveDeServico` e cole a chave.',
    },
    servers,
    tags: [{ name: 'Relatórios', description: 'Leitura. Entram com a chave de serviço.' }],
    paths: ROTAS_DETALHADAS as OpenApiDoc['paths'],
    components: {
      schemas: SCHEMAS_RELATORIO,
      securitySchemes: {
        ChaveDeServico: { type: 'apiKey', in: 'header', name: 'x-internal-key', description: 'A `INTERNAL_API_KEY` do backend.' },
      },
    },
  };
}
