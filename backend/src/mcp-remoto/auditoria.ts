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
import { EVENTO_CLIENTE, EVENTO_COBRANCA, EVENTO_OPERACAO, JANELA_LIVRO_MS, type Lancamento, type TipoDeLancamento } from './asaas-limites.js';

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

/** O pedaço do cliente do banco que o leitor usa (o `prisma` real ou um falso nos testes). */
export interface LeitorDeAuditoria {
  mcpAuditoria: {
    findMany(args: {
      where: { ferramenta: { in: string[] }; createdAt: { gte: Date }; argumentos: { path: string[]; equals: string } };
      select: { createdAt: true; ok: true; ferramenta: true; argumentos: true };
    }): Promise<Array<{ createdAt: Date; ok: boolean; ferramenta: string; argumentos: unknown }>>;
  };
}

const TIPOS: Record<string, TipoDeLancamento> = { estornar_cobranca: 'estorno', transferir: 'transferencia', editar_cobranca: 'edicao' };

/**
 * O que a escrita do Asaas fez nesta conta nas últimas 36 h (auditoria do conector): cobranças criadas, estornos, transferências, edições.
 * É o que faz o teto do dia, o teto por hora e a duplicata sobreviverem a um reinício. Falha definitiva do Asaas não conta;
 * sucesso e "sem resposta" (pode ter gravado) contam.
 */
export async function lancamentosRecentesDe(db: LeitorDeAuditoria, conta: string, agora: number = Date.now()): Promise<Lancamento[]> {
  const linhas = await db.mcpAuditoria.findMany({
    where: { ferramenta: { in: [EVENTO_COBRANCA, EVENTO_OPERACAO] }, createdAt: { gte: new Date(agora - JANELA_LIVRO_MS) }, argumentos: { path: ['conta'], equals: conta } },
    select: { createdAt: true, ok: true, ferramenta: true, argumentos: true },
  });
  type Args = { conta?: string; chave?: string; cobrancaId?: string; idAsaas?: string; incerto?: boolean; valor?: number; noTeto?: number; operacao?: string; fase?: string };
  // a INTENÇÃO (gravada antes de chamar o Asaas) vale como "pode ter acontecido" até aparecer um resultado da mesma operação (mesma chave, depois dela)
  const resultados = new Map<string, number[]>();
  for (const l of linhas) {
    const a = (l.argumentos ?? {}) as Args;
    if (a.fase !== 'intencao' && a.chave) {
      const k = `${l.ferramenta}|${a.chave}`;
      const ts = resultados.get(k) ?? [];
      ts.push(l.createdAt.getTime());
      resultados.set(k, ts);
    }
  }
  const out: Lancamento[] = [];
  for (const l of linhas) {
    const a = (l.argumentos ?? {}) as Args;
    if (a.fase === 'intencao' && (resultados.get(`${l.ferramenta}|${a.chave}`) ?? []).some((t) => t >= l.createdAt.getTime())) continue;
    if (a.conta !== conta || !(l.ok || a.incerto)) continue;
    const valor = Number(a.valor);
    if (!Number.isFinite(valor)) continue;
    const tipo = l.ferramenta === EVENTO_COBRANCA ? 'cobranca' : TIPOS[a.operacao ?? ''];
    if (!tipo) continue; // cancelar e editar cliente não consomem teto
    const noTeto = tipo === 'cobranca' ? valor : Number.isFinite(Number(a.noTeto)) ? Number(a.noTeto) : valor;
    const id = a.cobrancaId ?? a.idAsaas;
    out.push({ conta, tipo, valor, noTeto, em: l.createdAt.getTime(), ...(a.chave ? { chave: a.chave } : {}), ...(id ? { id } : {}) });
  }
  return out;
}
