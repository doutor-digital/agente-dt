/**
 * Planilha do Google Sheets no conector: lê as abas das planilhas liberadas no painel de integrações
 * (provedor `planilha`). SÓ LEITURA — a fonte de produção só faz GET no export do Google.
 *
 * Dado pessoal, regra fixa e sem exceção:
 *  - coluna de senha/login/"meu inss" já foi DESCARTADA na origem (`lib/integracoes/planilha.ts`); aqui nem existe;
 *  - CPF e telefone chegam mascarados; "CPF/senha" colado numa célula chega omitido;
 *  - `completo: true` só tira o corte de tamanho de célula e de colunas. Não devolve nada do que foi descartado
 *    ou mascarado — não há como: o que foi cortado não está mais na memória do conector;
 *  - a busca roda no dado já limpo, então não serve de oráculo ("existe alguém com o CPF tal?").
 * Padrão de 50 linhas por chamada, no máximo 200.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache, TTL } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { interpretarChavePlanilha, lerPlanilhaPublica, type AbaLimpa, type ModoPlanilha, type PlanilhaLimpa } from '../lib/integracoes/planilha.js';
import { mascararTexto, normalizarCabecalho } from '../lib/integracoes/mascaras.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';

/** O que o conector precisa de uma planilha: a versão JÁ LIMPA dela. */
export interface FontePlanilha {
  modo: ModoPlanilha;
  /** de onde vem (o id da planilha): entra na chave do cache, para trocar o id no painel não servir a planilha antiga */
  id: string;
  ler(): Promise<PlanilhaLimpa>;
}

export interface PlanilhaLiberada {
  apelido: string;
  fonte: FontePlanilha;
}

export interface ContaPlanilha {
  slug: string;
  nome: string;
  planilhas: PlanilhaLiberada[];
}

export interface ContextoPlanilha {
  contas: Map<string, ContaPlanilha>;
  cache: Cache;
  /** planilhas sendo baixadas agora: chamadas simultâneas esperam a mesma leitura em vez de baixar de novo */
  emVoo: Map<string, Promise<PlanilhaLimpa>>;
}

export function criarContextoPlanilha(contas: Map<string, ContaPlanilha>, op: { agora?: () => number } = {}): ContextoPlanilha {
  return { contas, cache: new Cache(op.agora, 50), emVoo: new Map() };
}

/** Modo público: export xlsx por link, sem login. `fetcher` existe para o teste. */
export function fontePlanilhaPublica(id: string, fetcher: typeof fetch = fetch): FontePlanilha {
  return { modo: 'publico', id, ler: () => lerPlanilhaPublica(id, fetcher) };
}

/**
 * A conta de uma unidade a partir do que o painel guardou (a lista `apelido=id`). Lança se a chave não for
 * entendida (inclusive o JSON de conta de serviço, que ainda não lê): quem carrega registra e pula essa unidade.
 */
export function contaPlanilhaDaChave(c: { slug: string; nome: string; chave: string }, fetcher: typeof fetch = fetch): ContaPlanilha {
  return { slug: c.slug, nome: c.nome, planilhas: interpretarChavePlanilha(c.chave).map((p) => ({ apelido: p.apelido, fonte: fontePlanilhaPublica(p.id, fetcher) })) };
}

export const MAX_LINHAS = 200;
export const LINHAS_PADRAO = 50;
const MAX_CONTAS = 10;
const CORTE_CELULA = 300;
const CORTE_COLUNAS = 30;

export function resolverContasPlanilha(ctx: ContextoPlanilha, alvo: string | string[]): ContaPlanilha[] {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma unidade com planilha ligada ainda (cadastre as planilhas no painel de integrações).');
  const pedidos = Array.isArray(alvo) ? alvo : [alvo];
  if (pedidos.some((p) => p.trim().toLowerCase() === 'todas')) {
    if (ctx.contas.size > MAX_CONTAS) throw new ErroDeEntrada(`peça até ${MAX_CONTAS} unidades por vez. Com planilha: ${[...ctx.contas.keys()].join(', ')}`);
    return [...ctx.contas.values()];
  }
  const achadas: ContaPlanilha[] = [];
  const faltam: string[] = [];
  for (const p of pedidos) {
    const slug = acharSlug(ctx.contas.keys(), p);
    if (slug && !achadas.some((a) => a.slug === slug)) achadas.push(ctx.contas.get(slug)!);
    else if (!slug) faltam.push(p);
  }
  if (faltam.length) throw new ErroDeEntrada(`unidade sem planilha, desconhecida ou ambígua: ${faltam.join(', ')}. Com planilha: ${[...ctx.contas.keys()].join(', ')}`);
  return achadas;
}

/** A planilha limpa fica em memória por 10 min. O que entra no cache já passou pela limpeza. */
async function carregar(ctx: ContextoPlanilha, c: ContaPlanilha, p: PlanilhaLiberada): Promise<PlanilhaLimpa> {
  const chave = `planilha|${c.slug}|${p.apelido}|${p.fonte.id}`;
  const g = ctx.cache.pegar<PlanilhaLimpa>(chave);
  if (g !== undefined) return g;
  let voando = ctx.emVoo.get(chave);
  if (!voando) {
    voando = p.fonte
      .ler()
      .then((v) => {
        ctx.cache.guardar(chave, v, TTL.busca);
        return v;
      })
      .finally(() => ctx.emVoo.delete(chave));
    ctx.emVoo.set(chave, voando);
  }
  return voando;
}

/** Cada unidade isolada (uma com erro não derruba as outras) e em paralelo: são downloads independentes. */
async function emCada<T extends object>(contas: ContaPlanilha[], fn: (c: ContaPlanilha) => Promise<T>) {
  const porUnidade: Record<string, ({ ok: true } & T) | { ok: false; erro: string }> = {};
  const feitos = await Promise.all(
    contas.map(async (c) => {
      try {
        return [c.slug, { ok: true as const, ...(await fn(c)) }] as const;
      } catch (e) {
        return [c.slug, { ok: false as const, erro: e instanceof Error ? e.message : String(e) }] as const;
      }
    }),
  );
  for (const [slug, r] of feitos) porUnidade[slug] = r;
  return porUnidade;
}

const OBSERVACAO =
  'Colunas de senha/login são descartadas na origem; CPF e telefone saem mascarados; CPF/senha colados saem omitidos. ' +
  'Isso vale também com completo: true.';

// ----------------------------------------------------------------- planilha_abas

export async function planilhaAbas(ctx: ContextoPlanilha, a: { unidade: string | string[]; planilha?: string }) {
  const contas = resolverContasPlanilha(ctx, a.unidade);
  const porUnidade = await emCada(contas, async (c) => {
    const alvo = a.planilha ? [escolher(c, a.planilha)] : c.planilhas;
    const planilhas = await Promise.all(
      alvo.map(async (p) => {
        const lida = await carregar(ctx, c, p);
        return {
          apelido: p.apelido,
          modo: p.fonte.modo,
          abas: lida.abas.map((ab) => ({
            nome: ab.nome,
            linhas: ab.linhasTotal,
            cabecalhos: ab.cabecalhos,
            colunasDescartadas: ab.colunasDescartadas,
            ...(ab.truncado ? { truncado: true } : {}),
          })),
        };
      }),
    );
    return { planilhas };
  });
  return { observacao: OBSERVACAO, porUnidade };
}

// ----------------------------------------------------------------- planilha_ler

function escolher(c: ContaPlanilha, pedido?: string): PlanilhaLiberada {
  if (!c.planilhas.length) throw new ErroDeEntrada(`${c.slug} não tem planilha liberada`);
  const nomes = c.planilhas.map((p) => p.apelido).join(', ');
  if (!pedido) {
    if (c.planilhas.length === 1) return c.planilhas[0]!;
    throw new ErroDeEntrada(`${c.slug} tem mais de uma planilha: diga qual (${nomes})`);
  }
  const n = normalizarCabecalho(pedido);
  if (!n) throw new ErroDeEntrada(`nome de planilha inválido. Disponíveis: ${nomes}`);
  const exata = c.planilhas.find((p) => normalizarCabecalho(p.apelido) === n);
  if (exata) return exata;
  const parecidas = c.planilhas.filter((p) => normalizarCabecalho(p.apelido).includes(n));
  if (parecidas.length > 1) throw new ErroDeEntrada(`planilha "${pedido}" ambígua em ${c.slug}: ${parecidas.map((p) => p.apelido).join(', ')}`);
  if (!parecidas.length) throw new ErroDeEntrada(`planilha "${pedido}" não liberada em ${c.slug}. Disponíveis: ${nomes}`);
  return parecidas[0]!;
}

function escolherAba(abas: AbaLimpa[], pedido?: string): AbaLimpa {
  const nomes = abas.map((x) => x.nome).join(', ');
  if (!abas.length) throw new ErroDeEntrada('a planilha não tem aba legível');
  if (!pedido) {
    if (abas.length === 1) return abas[0]!;
    throw new ErroDeEntrada(`a planilha tem mais de uma aba: diga qual (${nomes})`);
  }
  const n = normalizarCabecalho(pedido);
  if (!n) throw new ErroDeEntrada(`nome de aba inválido. Abas: ${nomes}`);
  const achadas = abas.filter((x) => normalizarCabecalho(x.nome) === n);
  const parcial = achadas.length ? achadas : abas.filter((x) => normalizarCabecalho(x.nome).includes(n));
  if (parcial.length !== 1) throw new ErroDeEntrada(`aba "${pedido}" ${parcial.length ? 'ambígua' : 'não encontrada'}. Abas: ${nomes}`);
  return parcial[0]!;
}

export interface ArgsPlanilhaLer {
  unidade: string;
  planilha?: string;
  aba?: string;
  busca?: string;
  colunas?: string[];
  /** número da linha como aparece no Google Sheets (a 1ª de dados costuma ser a 2); `proximaLinha` já vem nesse número */
  aPartirDaLinha?: number;
  maxLinhas?: number;
  completo?: boolean;
}

const sem = (s: string) => normalizarCabecalho(s);

export async function planilhaLer(ctx: ContextoPlanilha, a: ArgsPlanilhaLer) {
  const max = a.maxLinhas ?? LINHAS_PADRAO;
  if (!Number.isInteger(max) || max < 1 || max > MAX_LINHAS) throw new ErroDeEntrada(`maxLinhas de 1 até ${MAX_LINHAS}`);
  const inicio = a.aPartirDaLinha ?? 1;
  if (!Number.isInteger(inicio) || inicio < 1) throw new ErroDeEntrada('aPartirDaLinha deve ser 1 ou mais');
  const contas = resolverContasPlanilha(ctx, a.unidade);
  if (contas.length !== 1) throw new ErroDeEntrada('informe UMA unidade');
  const c = contas[0]!;
  const p = escolher(c, a.planilha);
  const aba = escolherAba((await carregar(ctx, c, p)).abas, a.aba);

  // colunas pedidas: pelo nome, sem acento nem caixa; só existem as que sobraram da limpeza
  let indices = aba.cabecalhos.map((_, i) => i);
  if (a.colunas?.length) {
    const faltam = a.colunas.filter((n) => !aba.cabecalhos.some((h) => sem(h) === sem(n)));
    if (faltam.length) throw new ErroDeEntrada(`coluna que não existe nesta aba: ${faltam.join(', ')}. Colunas: ${aba.cabecalhos.join(', ')}`);
    indices = a.colunas.map((n) => aba.cabecalhos.findIndex((h) => sem(h) === sem(n)));
  }
  const omitidas = !a.colunas?.length && !a.completo && indices.length > CORTE_COLUNAS ? indices.length - CORTE_COLUNAS : 0;
  if (omitidas) indices = indices.slice(0, CORTE_COLUNAS);

  const termos = a.busca ? sem(a.busca).split(' ').filter(Boolean) : [];
  const casa = (linha: string[]) => {
    if (!termos.length) return true;
    const alvo = sem(linha.join(' '));
    return termos.every((t) => alvo.includes(t));
  };
  const noFiltro: Array<{ linha: number; dados: string[] }> = [];
  aba.linhas.forEach((dados, i) => {
    if (casa(dados)) noFiltro.push({ linha: aba.numerosDasLinhas[i]!, dados });
  });
  const aPartir = noFiltro.filter((x) => x.linha >= inicio);
  const fatia = aPartir.slice(0, max);
  const corta = (v: string) => (a.completo || v.length <= CORTE_CELULA ? v : `${v.slice(0, CORTE_CELULA)}…`);
  return {
    unidade: c.slug,
    planilha: p.apelido,
    aba: aba.nome,
    cabecalhos: indices.map((i) => aba.cabecalhos[i]!),
    totalNaAba: aba.linhasTotal,
    ...(termos.length ? { totalNoFiltro: noFiltro.length } : {}),
    linhas: fatia.map((x) => ({
      linha: x.linha,
      valores: Object.fromEntries(indices.map((i) => [aba.cabecalhos[i]!, corta(x.dados[i] ?? '')] as const).filter(([, v]) => v !== '')),
    })),
    proximaLinha: aPartir.length > fatia.length ? aPartir[fatia.length]!.linha : null,
    ...(omitidas ? { colunasOmitidas: omitidas, avisoColunas: `só as ${CORTE_COLUNAS} primeiras colunas; peça colunas=[…] ou completo: true para as outras` } : {}),
    ...(aba.truncado ? { aviso: 'a aba passou do teto de linhas ou colunas lido: os números são parciais' } : {}),
    colunasDescartadas: aba.colunasDescartadas.length,
    observacao: OBSERVACAO,
  };
}

// ----------------------------------------------------------------- ferramentas

const unidade = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('unidade ou empresa com planilha liberada: slug ou nome curto, uma lista, ou "todas". Veja listar_integracoes.');
const umaUnidade = z.string().min(1).describe('unidade ou empresa: slug ou nome curto');

export function registrarFerramentasPlanilha(server: McpServer, ctx: ContextoPlanilha, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'planilha_abas',
    {
      title: 'Abas de uma planilha (Google Sheets)',
      description:
        'As planilhas do Google Sheets liberadas no conector e as abas de cada uma: nome, quantidade de linhas, colunas que sobraram e quais ' +
        'foram descartadas. Só leitura. Colunas de senha/login/"meu inss" nunca são lidas; CPF e telefone saem mascarados.',
      inputSchema: { unidade, planilha: z.string().optional().describe('apelido da planilha, se a unidade tiver mais de uma') },
      annotations: ro,
    },
    (args) => executar('planilha_abas', args, auditar, () => planilhaAbas(ctx, args)),
  );
  server.registerTool(
    'planilha_ler',
    {
      title: 'Ler linhas de uma planilha (Google Sheets)',
      description:
        `Linhas de uma aba, uma por vez: ${LINHAS_PADRAO} por padrão, no máximo ${MAX_LINHAS} (use aPartirDaLinha com "proximaLinha" para continuar). ` +
        'Filtra por texto (busca) e escolhe colunas. Só leitura. Senha/login são descartados, CPF e telefone saem mascarados e o ' +
        'CPF/senha colado numa célula sai omitido — com ou sem completo: true, que só tira o corte de tamanho de célula e de colunas.',
      inputSchema: {
        unidade: umaUnidade,
        planilha: z.string().optional().describe('apelido da planilha, se a unidade tiver mais de uma'),
        aba: z.string().optional().describe('nome da aba (ou parte dele), se a planilha tiver mais de uma'),
        busca: z.string().optional().describe('palavras que a linha deve conter, sem acento e sem caixa; roda no dado já mascarado'),
        colunas: z.array(z.string().min(1)).max(50).optional().describe('nomes das colunas a devolver'),
        aPartirDaLinha: z.number().int().min(1).optional().describe('número da linha no Google Sheets, para continuar de onde parou (use "proximaLinha")'),
        maxLinhas: z.number().int().min(1).max(MAX_LINHAS).optional(),
        completo: z.boolean().optional().describe('sem corte de 300 caracteres por célula e de 30 colunas. NÃO libera CPF, telefone nem senha.'),
      },
      annotations: ro,
    },
    // a auditoria guarda os argumentos: CPF ou telefone digitado na busca entra mascarado
    (args) => executar('planilha_ler', { ...args, ...(args.busca ? { busca: mascararTexto(args.busca) } : {}) }, auditar, () => planilhaLer(ctx, args)),
  );
}
