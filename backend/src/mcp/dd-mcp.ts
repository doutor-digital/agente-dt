/**
 * dd-mcp — as ferramentas do cérebro, pro Claude Code na máquina do João.
 *
 * Roda local (stdio) e fala com o backend de produção por HTTPS. NÃO guarda token de
 * franquia nem de Kommo: quem tem essas chaves é o servidor. Aqui só mora o login do
 * console, e a sessão é trocada por um cookie que vive em memória.
 *
 * Só leitura, nesta versão. As ferramentas de escrever campo entram depois que o
 * relatório rodar alguns dias e a recepção confirmar que o que ele diz é verdade;
 * mover etapa não entra nunca — é o que dispara gatilho, template e cobrança.
 *
 * Configuração (no ~/.claude.json ou via `claude mcp add`):
 *   command: node
 *   args:    ["<repo>/backend/dist/mcp/dd-mcp.js"]
 *   env:     DD_API_URL, DD_EMAIL, DD_SENHA
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const API = (process.env.DD_API_URL ?? 'https://agente-vps.doutordigitalconsultoria.com').replace(/\/$/, '');
const EMAIL = process.env.DD_EMAIL ?? '';
const SENHA = process.env.DD_SENHA ?? '';

let cookie: string | null = null;

async function entrar(): Promise<void> {
  if (!EMAIL || !SENHA) throw new Error('faltam DD_EMAIL e DD_SENHA no ambiente do MCP');
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: SENHA }),
  });
  if (!r.ok) throw new Error(`login recusado (${r.status})`);
  // getSetCookie() devolve um Set-Cookie por item. O get('set-cookie') junta tudo numa
  // string só, e a data do Expires tem vírgula dentro — separar na mão erra o corte.
  const brutos = r.headers.getSetCookie();
  const pares = brutos.map((c) => c.split(';')[0]).filter(Boolean);
  if (!pares.length) throw new Error('login não devolveu cookie de sessão');
  cookie = pares.join('; ');
}

/** Uma tentativa de reentrar quando a sessão cai — senão a rotina das 17h morre sozinha. */
async function api<T>(caminho: string, tentou = false): Promise<T> {
  if (!cookie) await entrar();
  const r = await fetch(`${API}/api${caminho}`, { headers: { cookie: cookie! } });
  if ((r.status === 401 || r.status === 403) && !tentou) {
    cookie = null;
    return api<T>(caminho, true);
  }
  const corpo = await r.text();
  if (!r.ok) throw new Error(`${caminho} → ${r.status} ${corpo.slice(0, 300)}`);
  return JSON.parse(corpo) as T;
}

interface Unidade { id: string; slug: string; name?: string | null }
let cacheUnidades: Unidade[] | null = null;

/**
 * Atenção: `GET /api/units` devolve `{ units: [...] }`, não a lista crua — é o envelope
 * que o console inteiro usa. Ler como array direto fazia toda ferramenta morrer no
 * primeiro uso com "us.find is not a function". Aceitamos as duas formas para o dia em
 * que o envelope mudar.
 */
async function unidades(): Promise<Unidade[]> {
  if (!cacheUnidades) {
    const corpo = await api<{ units?: Unidade[] } | Unidade[]>('/units');
    const lista = Array.isArray(corpo) ? corpo : corpo?.units;
    if (!Array.isArray(lista)) throw new Error('GET /api/units não devolveu lista de unidades');
    cacheUnidades = lista;
  }
  return cacheUnidades;
}

/** Aceita slug ou id: quem usa escreve "doutor-hernia-maraba", não um cuid. */
async function idDaUnidade(slugOuId: string): Promise<string> {
  const us = await unidades();
  const achada = us.find((u) => u.slug === slugOuId || u.id === slugOuId);
  if (!achada) throw new Error(`unidade "${slugOuId}" não existe. Conhecidas: ${us.map((u) => u.slug).join(', ')}`);
  return achada.id;
}

// Tipado como Tool[] de propósito: o `as unknown as []` de antes desligava a checagem
// justo onde ela importa — um inputSchema torto só apareceria no cliente, em uso.
const FERRAMENTAS: Tool[] = [
  {
    name: 'cerebro_unidades',
    description:
      'Lista as unidades que este acesso enxerga, com slug e nome. Use quando não souber o slug exato de uma unidade.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cerebro_panorama',
    description:
      'O retrato de uma unidade: a agenda e os tratamentos da franquia conferidos contra os cartões do Kommo. ' +
      'Devolve as contagens e a lista "paraOlhar" — quem está sem cartão, quem ficou ambíguo (com os candidatos e a ' +
      'parecença de nome medida) e quem está sumindo do tratamento. O casamento por telefone e por vínculo já vem ' +
      'resolvido; os ambíguos são justamente o que precisa do seu julgamento.',
    inputSchema: {
      type: 'object',
      properties: {
        unidade: { type: 'string', description: 'slug da unidade, ex.: doutor-hernia-maraba' },
        dias: { type: 'number', description: 'janela da agenda em dias (padrão 60, máximo 180)' },
        meses: { type: 'number', description: 'janela dos tratamentos em meses (padrão 6, máximo 12)' },
      },
      required: ['unidade'],
      additionalProperties: false,
    },
  },
  {
    name: 'cerebro_paciente',
    description:
      'A ficha de um paciente: sessões, tratamentos, cartão no Kommo e como ele foi casado. Aceita nome ou telefone. ' +
      'Use pra aprofundar um caso que o panorama marcou como ambíguo ou como sumindo.',
    inputSchema: {
      type: 'object',
      properties: {
        unidade: { type: 'string', description: 'slug da unidade' },
        busca: { type: 'string', description: 'nome do paciente ou telefone' },
      },
      required: ['unidade', 'busca'],
      additionalProperties: false,
    },
  },
];

const server = new Server({ name: 'dd-cerebro', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FERRAMENTAS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = (req.params.arguments ?? {}) as Record<string, unknown>;
  const texto = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 1) }] });
  try {
    switch (req.params.name) {
      case 'cerebro_unidades':
        return texto((await unidades()).map((u) => ({ slug: u.slug, nome: u.name ?? null })));
      case 'cerebro_panorama': {
        const id = await idDaUnidade(String(a.unidade ?? ''));
        const q = new URLSearchParams();
        if (a.dias) q.set('dias', String(a.dias));
        if (a.meses) q.set('meses', String(a.meses));
        return texto(await api(`/units/${id}/cerebro/panorama?${q}`));
      }
      case 'cerebro_paciente': {
        const id = await idDaUnidade(String(a.unidade ?? ''));
        const q = new URLSearchParams({ busca: String(a.busca ?? '') });
        return texto(await api(`/units/${id}/cerebro/paciente?${q}`));
      }
      default:
        throw new Error(`ferramenta desconhecida: ${req.params.name}`);
    }
  } catch (err) {
    // Erro volta como conteúdo, não como exceção: a rotina das 17h precisa continuar e
    // relatar o que falhou, em vez de morrer no meio.
    return { content: [{ type: 'text' as const, text: `ERRO: ${String(err).slice(0, 500)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
