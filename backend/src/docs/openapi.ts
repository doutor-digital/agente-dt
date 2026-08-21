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

export interface OpenApiDoc {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<{ url: string; description?: string }>;
  tags: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
}

const AREAS_DESC: Record<string, string> = {
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

  return {
    openapi: '3.1.0',
    info: {
      title: 'API do Agente DT',
      version: '1.22.0',
      description:
        'API do sistema que atende os pacientes no WhatsApp, conecta ao Kommo e à agenda da franquia.\n\n' +
        '**Autenticação:** o painel entra em `POST /auth/login` e recebe um cookie de sessão assinado. ' +
        'Toda chamada seguinte envia esse cookie — não há token no cabeçalho.\n\n' +
        '**Segredos** (chaves de API, tokens) sempre voltam mascarados, com um mapa `_hasSecrets` ' +
        'dizendo apenas se cada um está preenchido.\n\n' +
        '_Esta página é gerada a partir das rotas reais do servidor — se a rota existe, ela aparece aqui._',
    },
    servers: [{ url: baseUrl, description: 'Produção' }],
    tags: [...areasUsadas].sort().map((name) => ({ name, description: AREAS_DESC[name] })),
    paths,
  };
}
