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
import { EVENTO_CLIENTE, EVENTO_COBRANCA, type RegistroDeCobranca } from './asaas-escrita.js';

/**
 * Eventos que o código grava e relê. Só entram aqui os que são montados sem dado pessoal. O `evo_envio` NÃO entra: o teto
 * de envios lê só a data e o `ok` dele, e o `argumentos` dele guarda o número de destino inteiro — esse segue mascarado.
 */
export const EVENTOS_INTERNOS: ReadonlySet<string> = new Set([EVENTO_COBRANCA, EVENTO_CLIENTE]);

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
): Auditar {
  return (r) => {
    armazem
      .auditar({
        ...quem,
        ferramenta: r.ferramenta,
        argumentos: argumentosDaAuditoria(r.ferramenta, r.argumentos),
        ok: r.ok,
        duracaoMs: r.ms,
        erro: r.erro === undefined ? undefined : mascararErro(r.erro),
      })
      .catch((err) => log?.warn({ err }, 'mcp-remoto: auditoria não gravou'));
    log?.info({ userId: quem.userId, ferramenta: r.ferramenta, ok: r.ok, ms: r.ms }, 'mcp-remoto: ferramenta');
  };
}

/** O pedaço do cliente do banco que o leitor usa (o `prisma` real ou um falso nos testes). */
export interface LeitorDeAuditoria {
  mcpAuditoria: {
    findMany(args: {
      where: { ferramenta: string; createdAt: { gte: Date }; argumentos: { path: string[]; equals: string } };
      select: { createdAt: true; ok: true; argumentos: true };
    }): Promise<Array<{ createdAt: Date; ok: boolean; argumentos: unknown }>>;
  };
}

/** Boletos gerados na última hora (auditoria do conector): o teto por hora e a duplicata sobrevivem a um reinício. */
export async function cobrancasRecentesDe(db: LeitorDeAuditoria, conta: string, agora: number = Date.now()): Promise<RegistroDeCobranca[]> {
  const linhas = await db.mcpAuditoria.findMany({
    where: { ferramenta: EVENTO_COBRANCA, createdAt: { gte: new Date(agora - 3_600_000) }, argumentos: { path: ['conta'], equals: conta } },
    select: { createdAt: true, ok: true, argumentos: true },
  });
  const out: RegistroDeCobranca[] = [];
  for (const l of linhas) {
    const a = (l.argumentos ?? {}) as { conta?: string; chave?: string; cobrancaId?: string; incerto?: boolean };
    // falha definitiva do Asaas não conta; sucesso e "sem resposta" (pode ter criado) contam
    if (a.conta === conta && a.chave && (l.ok || a.incerto)) out.push({ conta, chave: a.chave, em: l.createdAt.getTime(), ...(a.cobrancaId ? { cobrancaId: a.cobrancaId } : {}) });
  }
  return out;
}
