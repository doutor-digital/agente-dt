/**
 * O gravador da auditoria do conector (`mcp_auditoria`) e o leitor que o código usa de volta (boletos recentes).
 *
 * Duas mãos no mesmo registro, por isso moram juntas: quem GRAVA mascara o que é dado pessoal; quem LÊ precisa do campo
 * como foi escrito. Os eventos internos da escrita do Asaas (`asaas_cobranca_gravada`, `asaas_cliente_gravado`) são montados pelo
 * próprio código sem dado pessoal (documento já mascarado, nome abreviado, referência sem corrida de dígitos) e alimentam a
 * duplicata e o teto de boletos DEPOIS de um reinício: não passam pela máscara dos argumentos, que estragaria a `chave`
 * (hash de 32 hex com 10–11 dígitos seguidos vira "telefone" em ~6% dos casos).
 */
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { mascararArgumentos, mascararErro } from '../lib/integracoes/mascaras.js';
import { randomUUID } from 'node:crypto';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { EVENTO_CLIENTE, EVENTO_COBRANCA, EVENTO_OPERACAO, FALHA_DO_BANCO, JANELA_LIVRO_MS, Livro, type Lancamento, type Porteiro, type TipoDeLancamento } from './asaas-limites.js';

/**
 * Eventos que o código grava e relê. Só entram aqui os que são montados sem dado pessoal. O `evo_envio` NÃO entra: o teto
 * de envios lê só a data e o `ok` dele, e o `argumentos` dele guarda o número de destino inteiro — esse segue mascarado.
 */
export const EVENTOS_INTERNOS: ReadonlySet<string> = new Set([EVENTO_COBRANCA, EVENTO_CLIENTE, EVENTO_OPERACAO]);

/** Os argumentos como vão ao banco: evento interno intacto, o resto pela máscara. */
export function argumentosDaAuditoria(ferramenta: string, argumentos: unknown): unknown {
  return EVENTOS_INTERNOS.has(ferramenta) ? argumentos : mascararArgumentos(argumentos);
}

export interface GravadorDeAuditoria {
  auditar(r: { userId: string; clientId: string; ferramenta: string; argumentos: unknown; ok: boolean; duracaoMs: number; erro?: string }): Promise<void>;
}

/**
 * O `auditar` que as ferramentas recebem: último portão antes do banco, para TODAS (quem chama `auditar` direto, sem passar pelo
 * `executar`, também passa por aqui). CPF/CNPJ/telefone/e-mail/senha digitados no pedido ou repetidos no erro nunca são gravados inteiros.
 */
export function criarAuditor(
  armazem: GravadorDeAuditoria,
  quem: { userId: string; clientId: string },
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void },
): AuditarComEspera {
  return (r) => {
    const gravou = armazem
      .auditar({
        ...quem,
        ferramenta: r.ferramenta,
        argumentos: argumentosDaAuditoria(r.ferramenta, r.argumentos),
        ok: r.ok,
        duracaoMs: r.ms,
        erro: r.erro === undefined ? undefined : mascararErro(r.erro),
      })
      .then(
        () => true,
        (err) => {
          log?.warn({ err }, 'mcp-remoto: auditoria não gravou');
          return false;
        },
      );
    log?.info({ userId: quem.userId, ferramenta: r.ferramenta, ok: r.ok, ms: r.ms }, 'mcp-remoto: ferramenta');
    return gravou;
  };
}

/**
 * O `auditar` que devolve uma promessa: `true` se o banco gravou, `false` se não. As ferramentas comuns ignoram (fire-and-forget); a
 * escrita de dinheiro do Asaas ESPERA a intenção ser gravada antes de chamar o Asaas.
 */
export type AuditarComEspera = (registro: Parameters<Auditar>[0]) => Promise<boolean>;

/** O pedaço do cliente do banco que o leitor usa (o `prisma` real, uma transação dele ou um falso nos testes). */
export interface LeitorDeAuditoria {
  mcpAuditoria: {
    findMany(args: {
      where: { ferramenta: { in: string[] }; createdAt: { gte: Date }; OR: Array<{ argumentos: { path: string[]; equals: string } }> };
      select: { createdAt: true; ok: true; ferramenta: true; argumentos: true };
    }): Promise<Array<{ createdAt: Date; ok: boolean; ferramenta: string; argumentos: unknown }>>;
  };
}

const TIPOS: Record<string, TipoDeLancamento> = { estornar_cobranca: 'estorno', transferir: 'transferencia', editar_cobranca: 'edicao' };

/**
 * O que a escrita do Asaas fez nas últimas 36 h (auditoria do conector) na CHAVE do Asaas `grupo` (e na conta `conta`, para o que foi gravado antes de a
 * chave entrar no registro): cobranças criadas, estornos, transferências, edições. É o que faz o teto do dia, o teto por hora e a duplicata valerem
 * entre instâncias e depois de um reinício. Falha definitiva do Asaas não conta; sucesso e "sem resposta" (pode ter gravado) contam.
 * A INTENÇÃO (gravada antes de chamar o Asaas) conta como "pode ter acontecido" até aparecer o resultado DA MESMA operação (mesmo `intencaoId`).
 */
export async function lancamentosRecentesDe(db: LeitorDeAuditoria, conta: string, agora: number = Date.now(), grupo?: string): Promise<Lancamento[]> {
  const linhas = await db.mcpAuditoria.findMany({
    where: {
      ferramenta: { in: [EVENTO_COBRANCA, EVENTO_OPERACAO] },
      createdAt: { gte: new Date(agora - JANELA_LIVRO_MS) },
      OR: [{ argumentos: { path: ['conta'], equals: conta } }, ...(grupo ? [{ argumentos: { path: ['chaveAsaas'], equals: grupo } }] : [])],
    },
    select: { createdAt: true, ok: true, ferramenta: true, argumentos: true },
  });
  type Args = { conta?: string; chaveAsaas?: string; chave?: string; cobrancaId?: string; idAsaas?: string; incerto?: boolean; valor?: number; noTeto?: number; operacao?: string; fase?: string; intencaoId?: string };
  const resolvidas = new Set<string>();
  for (const l of linhas) {
    const a = (l.argumentos ?? {}) as Args;
    if (a.fase !== 'intencao' && a.intencaoId) resolvidas.add(a.intencaoId);
  }
  const out: Lancamento[] = [];
  for (const l of linhas) {
    const a = (l.argumentos ?? {}) as Args;
    if (a.fase === 'intencao' && a.intencaoId && resolvidas.has(a.intencaoId)) continue;
    if (!(a.conta === conta || (grupo && a.chaveAsaas === grupo)) || !(l.ok || a.incerto)) continue;
    const valor = Number(a.valor);
    if (!Number.isFinite(valor)) continue;
    const tipo = l.ferramenta === EVENTO_COBRANCA ? 'cobranca' : TIPOS[a.operacao ?? ''];
    if (!tipo) continue; // cancelar e editar cliente não consomem teto
    const noTeto = tipo === 'cobranca' ? valor : Number.isFinite(Number(a.noTeto)) ? Number(a.noTeto) : valor;
    const id = a.cobrancaId ?? a.idAsaas;
    out.push({
      conta: a.conta ?? conta, tipo, valor, noTeto, em: l.createdAt.getTime(),
      ...(a.chave ? { chave: a.chave } : {}), ...(id ? { id } : {}), ...(a.intencaoId ? { intencaoId: a.intencaoId } : {}),
    });
  }
  return out;
}

/** O pedaço do `PrismaClient` que o porteiro usa. */
export interface BancoDoPorteiro extends LeitorDeAuditoria {
  $transaction<T>(fn: (tx: TransacaoDoPorteiro) => Promise<T>, opcoes?: { timeout?: number; maxWait?: number }): Promise<T>;
}
export interface TransacaoDoPorteiro extends LeitorDeAuditoria {
  $executeRaw(consulta: TemplateStringsArray, ...valores: unknown[]): Promise<number>;
  mcpAuditoria: LeitorDeAuditoria['mcpAuditoria'] & {
    create(args: { data: { userId: string; clientId: string; ferramenta: string; argumentos: any; ok: boolean; duracaoMs: number } }): Promise<unknown>;
  };
}

/**
 * O porteiro de produção: cada reserva roda numa TRANSAÇÃO que pega `pg_advisory_xact_lock` da chave do Asaas, lê a auditoria, deixa a conferência
 * recusar e grava a intenção, tudo antes de soltar a trava (no fim da transação). Duas instâncias (deploy com sobreposição, réplica) esperam uma a outra.
 */
export function porteiroPrisma(db: BancoDoPorteiro): Porteiro {
  return {
    async reservar(p) {
      const intencaoId = randomUUID();
      try {
        await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`asaas-dinheiro:${p.grupo}`}::text, 0))`;
            p.conferir(new Livro(await lancamentosRecentesDe(tx, p.conta, p.agora, p.grupo)));
            await tx.mcpAuditoria.create({
              data: {
                userId: p.quem.userId,
                clientId: p.quem.clientId ?? 'conector',
                ferramenta: p.evento,
                argumentos: { ...p.argumentos, conta: p.conta, chaveAsaas: p.grupo, intencaoId, fase: 'intencao', incerto: true },
                ok: true,
                duracaoMs: 0,
              },
            });
          },
          { timeout: 15_000, maxWait: 15_000 },
        );
      } catch (e) {
        if (e instanceof ErroDeEntrada) throw e;
        throw new ErroDeEntrada(FALHA_DO_BANCO);
      }
      return { intencaoId };
    },
    async ler(grupo, conta, agora) {
      try {
        return new Livro(await lancamentosRecentesDe(db, conta, agora, grupo));
      } catch {
        throw new ErroDeEntrada(FALHA_DO_BANCO);
      }
    },
  };
}
