/**
 * Onde se pergunta "esta automação está ligada nesta unidade?".
 *
 * A resposta vem do banco (`unit_automacoes`, escrito pela tela do console) e, quando não há linha
 * lá, da variável de ambiente de sempre. Essa ordem é o que torna a migração segura: a tabela nasce
 * vazia, então no primeiro deploy TODA unidade continua exatamente como estava no `.env`.
 *
 * POR QUE UM CACHE EM MEMÓRIA, E NÃO UMA CONSULTA POR PERGUNTA. As ~24 portas (`paradosLiberado`,
 * `moveLiberado`, `sofiaCaladaLiberada`…) são funções SÍNCRONAS chamadas no meio do turno da IA e
 * dentro de laços de worker — algumas por cartão. Torná-las `async` para consultar o banco seria
 * refatorar dezenas de pontos de chamada e pagar uma ida ao banco em cada um. Em vez disso um mapa
 * é carregado no boot e revalidado de tempos em tempos, e quem escreve pela tela invalida na hora.
 * Então a mudança vale em segundos, sem redeploy, que é o pedido do João (28/09/2026).
 *
 * O preço disso é honesto: uma réplica pode levar até `VALIDADE_MS` para enxergar o que a outra
 * gravou. Para ligar e desligar automação isso é irrelevante; para qualquer coisa que precise de
 * leitura imediata entre processos, este não é o lugar.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { AUTOMACOES, automacaoPorId, type Automacao } from './automacoes.js';

export type Estado = 'ligado' | 'seco' | 'desligado';

const ESTADOS: readonly Estado[] = ['ligado', 'seco', 'desligado'];

export function ehEstado(v: unknown): v is Estado {
  return typeof v === 'string' && (ESTADOS as readonly string[]).includes(v);
}

/** De quanto em quanto tempo o mapa é relido. Curto porque ligar/desligar é operação de gente esperando. */
const VALIDADE_MS = 30_000;

/** `slug\u0000idDaAutomacao` -> estado gravado na tela. */
let mapa = new Map<string, Estado>();
let carregadoEm = 0;
let carregando: Promise<void> | null = null;

const chaveDoMapa = (slug: string, id: string) => `${slug}\u0000${id}`;

/**
 * Relê a tabela. Nunca lança: banco fora do ar não pode desligar automação — nesse caso o mapa
 * velho continua valendo, e quando ele expira sobra a variável de ambiente, que é o estado seguro.
 */
export async function recarregarAutomacoes(): Promise<void> {
  if (carregando) return carregando;
  carregando = (async () => {
    try {
      const linhas = await prisma.unitAutomacao.findMany({
        select: { automacao: true, estado: true, unit: { select: { slug: true } } },
      });
      const novo = new Map<string, Estado>();
      for (const l of linhas) {
        if (!ehEstado(l.estado)) continue; // lixo no banco não derruba o resto
        novo.set(chaveDoMapa(l.unit.slug, l.automacao), l.estado);
      }
      mapa = novo;
      carregadoEm = Date.now();
    } catch (err) {
      logger.warn({ err: String(err) }, 'automações: falhei ao reler o banco — segue valendo o que já estava carregado');
    } finally {
      carregando = null;
    }
  })();
  return carregando;
}

/** Faz a próxima leitura ir ao banco. Chamado logo depois de gravar pela tela. */
export function invalidarAutomacoes(): void {
  carregadoEm = 0;
}

/** Dispara a releitura quando vencida, sem bloquear quem perguntou (a resposta desta vez usa o mapa atual). */
function revalidarSeVencido(): void {
  if (Date.now() - carregadoEm < VALIDADE_MS) return;
  void recarregarAutomacoes();
}

/**
 * O que a TELA gravou para esta unidade, ou `null` se ela nunca falou nada — e aí quem decide é a
 * variável de ambiente. As portas que têm modo seco próprio (o worker de parados lê três variáveis
 * diferentes) precisam enxergar essa diferença, por isso este `null` não vira `'desligado'`.
 */
export function estadoGravado(slug: string, id: string): Estado | null {
  revalidarSeVencido();
  const gravado = mapa.get(chaveDoMapa(slug, id));
  if (!gravado) return null;
  // "seco" numa automação que não tem modo seco viraria "ligado" sem querer se alguém renomeasse um
  // id no catálogo. Tratar como desligado é o lado seguro do erro.
  if (gravado === 'seco' && !automacaoPorId(id)?.temSeco) return 'desligado';
  return gravado;
}

/**
 * O estado de uma automação numa unidade. `raw` é a variável de ambiente que a porta já recebia —
 * continua sendo o padrão quando a tela nunca falou nada sobre essa unidade.
 */
export function estadoDaAutomacao(slug: string, id: string, raw: string | undefined): Estado {
  return estadoGravado(slug, id) ?? (naListaDoAmbiente(slug, raw, id) ? 'ligado' : 'desligado');
}

/** Atalho para as portas que só querem saber se roda. */
export function automacaoLigada(slug: string, id: string, raw: string | undefined): boolean {
  return estadoDaAutomacao(slug, id, raw) === 'ligado';
}

/**
 * A leitura do csv de sempre: `serra,imperatriz` ou `*`, com aspas sobrando toleradas porque é
 * comum o valor chegar do `.env` entre aspas. Vazio = ninguém, EXCETO nas automações que o catálogo
 * marca como `quandoVazio: 'todas'` — que nasceram ligadas pra rede inteira, e é justamente esse
 * tipo de coisa que ninguém lembra sem a tela.
 */
export function naListaDoAmbiente(slug: string, raw: string | undefined, id?: string): boolean {
  const bruto = (raw ?? '').replace(/^['"]|['"]$/g, '').trim();
  if (!bruto) return id ? automacaoPorId(id)?.quandoVazio === 'todas' : false;
  const lista = bruto
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return lista.includes('*') || lista.includes(slug);
}

/** O que a tela mostra: cada automação, o que ela faz, e o estado de cada unidade. */
export interface LinhaDaTela extends Automacao {
  estado: Estado;
  /** `true` quando ninguém mexeu na tela e o valor ainda vem do `.env` — é o "como sempre foi". */
  vemDoAmbiente: boolean;
  /** O csv cru da variável, pra conferir contra a VPS sem abrir o Docker. */
  ambiente: string;
}

export function panoramaDaUnidade(slug: string, ambiente: NodeJS.ProcessEnv = process.env): LinhaDaTela[] {
  return AUTOMACOES.map((a) => {
    const raw = ambiente[a.chave];
    const gravado = estadoGravado(slug, a.id);
    return {
      ...a,
      estado: gravado ?? (naListaDoAmbiente(slug, raw, a.id) ? 'ligado' : 'desligado'),
      vemDoAmbiente: gravado === null,
      ambiente: (raw ?? '').trim(),
    };
  });
}

/** Carrega uma vez no boot, pra primeira pergunta já ver o banco em vez de cair no `.env`. */
export async function iniciarAutomacoes(): Promise<void> {
  await recarregarAutomacoes();
  logger.info({ automacoes: AUTOMACOES.length, linhas: mapa.size }, 'automações: catálogo e estado carregados');
}

/** Só para teste: injeta um mapa sem passar pelo banco. */
export function _semearParaTeste(linhas: Array<{ slug: string; automacao: string; estado: Estado }>): void {
  mapa = new Map(linhas.map((l) => [chaveDoMapa(l.slug, l.automacao), l.estado]));
  carregadoEm = Date.now();
}
