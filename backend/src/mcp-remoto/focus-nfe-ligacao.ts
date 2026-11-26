/**
 * A ligação da Focus NFe ao servidor do conector. Tudo nasce desligado: sem FOCUS_NFE_UNIDADES (lista de slugs) NADA acontece (nenhuma ferramenta, nenhuma rota, nenhuma
 * leitura do banco, nenhum aviso), e o servidor se comporta exatamente como antes. Ligado: carrega as contas do ambiente, monta o webhook (só se FOCUS_NFE_WEBHOOK_SEGREDO tem
 * 32+ caracteres) e devolve o que o `producao.ts` precisa para registrar as ferramentas de quem escreve.
 */
import type { Express } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { lerContasDoAmbiente, unidadesLigadasDaFocus } from '../lib/integracoes/focus-nfe.js';
import { armazemDeNotasPrisma, type BancoDeNotas } from './focus-nfe-armazem.js';
import { criarEscritaFocus, registrarFocusSePermitido, type EstadoEscritaFocus } from './focus-nfe-escrita.js';
import { montarRotaDoWebhookFocus, segredoDoWebhookDoAmbiente, urlDoWebhook } from './focus-nfe-webhook.js';
import { contaFocusDaConfig, criarContextoFocus, limitesDoAmbiente, type ContaFocus, type ContextoFocus } from './focus-nfe.js';
import { manterAtualizado } from './manter-atualizado.js';

export const focusLigado = (e: NodeJS.ProcessEnv = process.env): boolean => unidadesLigadasDaFocus(e).size > 0;

export interface DepsDaLigacao {
  app: Express;
  prisma: BancoDeNotas & { unit: { findMany(args: { select: { slug: true; name: true; isActive: true } }): Promise<Array<{ slug: string; name: string; isActive: boolean }>> } };
  alertar: (texto: string) => Promise<boolean>;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; debug(o: object, m?: string): void };
}

export interface FocusLigada {
  ctx: ContextoFocus;
  esc: EstadoEscritaFocus;
  /** a URL a cadastrar como gatilho na Focus (com o segredo): NUNCA vai para log nem resposta; só o script de ligação a usa */
  registrar(server: McpServer, usuario: string, escritores: ReadonlySet<string>, auditar: Auditar, quem?: { email?: string; clientId?: string }): boolean;
  contas(): Map<string, ContaFocus>;
}

export function ligarFocus(d: DepsDaLigacao, env: NodeJS.ProcessEnv = process.env): FocusLigada | null {
  if (!focusLigado(env)) return null;
  const segredo = segredoDoWebhookDoAmbiente(env);
  if (!segredo) d.log.warn({}, 'mcp-remoto: FOCUS_NFE_WEBHOOK_SEGREDO ausente ou com menos de 32 caracteres — o aviso automático de nota autorizada da Focus fica desligado (a rota nem é montada)');
  const notas = armazemDeNotasPrisma(d.prisma);
  const ctx = criarContextoFocus(new Map(), notas, { webhookConfigurado: Boolean(segredo) });
  const esc = criarEscritaFocus({ limites: limitesDoAmbiente(env), unidades: () => unidadesLigadasDaFocus(env), alertar: d.alertar });
  if (segredo) montarRotaDoWebhookFocus(d.app, { ctx, armazem: notas, segredo, alertar: d.alertar, log: d.log });
  const avisadas = new Set<string>();
  void manterAtualizado(
    async () => {
      // TODAS as unidades, ativas e inativas: o token de uma unidade desativada não pode cair em outra que termine com o mesmo nome (ver lerContasDoAmbiente)
      const unidades = await d.prisma.unit.findMany({ select: { slug: true, name: true, isActive: true } });
      const lido = lerContasDoAmbiente(unidades.map((u) => ({ slug: u.slug, nome: u.name, ativa: u.isActive })), env);
      // o ambiente não muda com o processo no ar: cada variável ignorada é avisada UMA vez
      for (const i of lido.ignoradas) {
        if (avisadas.has(i.variavel)) continue;
        avisadas.add(i.variavel);
        d.log.warn({ variavel: i.variavel, motivo: i.motivo }, 'mcp-remoto: variável da Focus NFe ignorada');
      }
      const contas = new Map<string, ContaFocus>();
      for (const c of lido.contas.values()) contas.set(c.slug, contaFocusDaConfig(c));
      d.log.debug({ contas: contas.size }, 'mcp-remoto: contas da Focus NFe carregadas');
      return contas;
    },
    (contas) => (ctx.contas = contas),
    'as contas da Focus NFe',
  );
  return {
    ctx,
    esc,
    registrar: (server, usuario, escritores, auditar, quem) => registrarFocusSePermitido(server, ctx, esc, usuario, escritores, auditar, quem),
    contas: () => ctx.contas,
  };
}

export { urlDoWebhook };
