/**
 * dd-mcp — as ferramentas do cérebro, pro Claude Code na máquina do João.
 *
 * Roda local (stdio) e fala com o backend de produção por HTTPS. NÃO guarda token de
 * franquia nem de Kommo: quem tem essas chaves é o servidor.
 *
 * Entra com CHAVE DE SERVIÇO (`DD_CHAVE` → header `x-internal-key`). A rotina das 17h
 * roda sem ninguém na frente, e senha de pessoa em cron é ruim: vale pra tudo no
 * console, morre quando a pessoa troca de senha, e fica escrita em arquivo. A chave é só
 * pra isto e gira sozinha. Se `DD_CHAVE` não estiver definida, cai no login por e-mail e
 * senha, que continua servindo pra uso manual.
 *
 * Só leitura, nesta versão. As ferramentas de escrever campo entram depois que o
 * relatório rodar alguns dias e a recepção confirmar que o que ele diz é verdade;
 * mover etapa não entra nunca — é o que dispara gatilho, template e cobrança.
 *
 * Configuração (no ~/.claude.json ou via `claude mcp add`):
 *   command: node
 *   args:    ["<repo>/backend/dist/mcp/dd-mcp.js"]
 *   env:     DD_API_URL + DD_CHAVE   (ou DD_EMAIL + DD_SENHA)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const API = (process.env.DD_API_URL ?? 'https://agente-vps.doutordigitalconsultoria.com').replace(/\/$/, '');
const CHAVE = process.env.DD_CHAVE ?? '';
const EMAIL = process.env.DD_EMAIL ?? '';
const SENHA = process.env.DD_SENHA ?? '';

let cookie: string | null = null;

async function entrar(): Promise<void> {
  if (!EMAIL || !SENHA) {
    throw new Error('sem credencial: defina DD_CHAVE (recomendado) ou DD_EMAIL + DD_SENHA');
  }
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
  const cabecalhos: Record<string, string> = {};
  if (CHAVE) {
    cabecalhos['x-internal-key'] = CHAVE;
  } else {
    if (!cookie) await entrar();
    cabecalhos.cookie = cookie!;
  }
  const r = await fetch(`${API}/api${caminho}`, { headers: cabecalhos });
  // Com chave de serviço não há sessão pra renovar: 401 aqui é chave errada, e repetir
  // só gastaria tempo.
  if (!CHAVE && (r.status === 401 || r.status === 403) && !tentou) {
    cookie = null;
    return api<T>(caminho, true);
  }
  const corpo = await r.text();
  if (!r.ok) throw new Error(`${caminho} → ${r.status} ${corpo.slice(0, 300)}`);
  return JSON.parse(corpo) as T;
}

interface Unidade { slug: string; nome?: string | null; franquiaLigada?: boolean }
let cacheUnidades: Unidade[] | null = null;

/**
 * Lê `/cerebro/unidades`, não `/units`.
 *
 * `/units` fica atrás do login do console e devolve a unidade inteira, credencial
 * incluída — a chave de serviço não abre aquilo, e não deve mesmo. A lista do cérebro
 * devolve só slug, nome e se a franquia está ligada, que é tudo de que aqui se precisa.
 */
async function unidades(): Promise<Unidade[]> {
  if (!cacheUnidades) {
    const corpo = await api<{ unidades?: Unidade[] } | Unidade[]>('/cerebro/unidades');
    const lista = Array.isArray(corpo) ? corpo : corpo?.unidades;
    if (!Array.isArray(lista)) throw new Error('GET /api/cerebro/unidades não devolveu lista de unidades');
    cacheUnidades = lista;
  }
  return cacheUnidades;
}

/**
 * As rotas do cérebro aceitam o slug no lugar do id, então não há id pra resolver. O que
 * resta é conferir que a unidade existe, pra o erro dizer "não existe, conhecidas: …" em
 * vez de um 404 seco vindo do servidor.
 */
async function alvo(slug: string): Promise<string> {
  const us = await unidades();
  if (!us.some((u) => u.slug === slug)) {
    throw new Error(`unidade "${slug}" não existe. Conhecidas: ${us.map((u) => u.slug).join(', ')}`);
  }
  return encodeURIComponent(slug);
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
        return texto(await unidades());
      case 'cerebro_panorama': {
        const u = await alvo(String(a.unidade ?? ''));
        const q = new URLSearchParams();
        if (a.dias) q.set('dias', String(a.dias));
        if (a.meses) q.set('meses', String(a.meses));
        return texto(await api(`/units/${u}/cerebro/panorama?${q}`));
      }
      case 'cerebro_paciente': {
        const u = await alvo(String(a.unidade ?? ''));
        const q = new URLSearchParams({ busca: String(a.busca ?? '') });
        return texto(await api(`/units/${u}/cerebro/paciente?${q}`));
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
