/**
 * O aviso (webhook/gatilho) da Focus NFe: quando uma NFS-e NACIONAL é AUTORIZADA a Focus faz um POST (evento `nfsen`) com os mesmos dados da consulta (a documentação não
 * lista outros eventos para a NFS-e Nacional; erro e cancelamento se veem pela consulta). Se o POST falha, ela repete em 1 min, 30 min, 1 h, 3 h e 24 h.
 *
 * O gatilho da Focus NÃO tem assinatura (só deixa configurar um cabeçalho de autorização), então a desconfiança é de duas camadas:
 *   1. o endereço carrega um segredo NOSSO (HMAC da unidade com FOCUS_NFE_WEBHOOK_SEGREDO): quem não conhece o endereço não avisa nada. Assinatura errada = 404 e conta no limite por IP;
 *   2. o corpo NUNCA é confiado: o conector só lê dele a referência e CONFIRMA na API da Focus (GET /v2/nfsen/{ref}). Quem vale é a consulta; o status do corpo é só uma dica.
 *
 * Responde 200 quando tratou, 503 quando a confirmação não pôde ser feita ou ainda não mostra o que o aviso diz (a Focus tenta de novo), 404 para assinatura errada. Nota que o
 * conector não emitiu (painel da Focus, Asaas) responde 200 sem fazer nada. O corpo recebido nunca vai para o log.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { REFERENCIA_VALIDA } from '../lib/integracoes/focus-nfe.js';
import { dinheiro } from './asaas-limites.js';
import { sincronizarNota, type ArmazemDeNotas, type ContextoFocus } from './focus-nfe.js';
import { ipDoCliente, JanelaDeContagem } from './limites.js';

export const SEGREDO_MINIMO = 32;

/** O segredo do webhook, SÓ do ambiente. Ausente ou curto = undefined: então a rota nem é montada e o cadastro do gatilho não pode ser feito. */
export function segredoDoWebhookDoAmbiente(e: NodeJS.ProcessEnv = process.env): string | undefined {
  const s = e.FOCUS_NFE_WEBHOOK_SEGREDO?.trim();
  return s && s.length >= SEGREDO_MINIMO ? s : undefined;
}

export const ROTA_WEBHOOK_FOCUS = '/focus-nfe/webhook/:unidade/:assinatura';

export function assinaturaDoWebhook(segredo: string, unidade: string): string {
  return createHmac('sha256', segredo).update(`focus-nfe|${unidade}`).digest('hex').slice(0, 32);
}

export function urlDoWebhook(origem: string, segredo: string, unidade: string): string {
  return `${origem.replace(/\/+$/, '')}/focus-nfe/webhook/${encodeURIComponent(unidade)}/${assinaturaDoWebhook(segredo, unidade)}`;
}

function assinaturaBoa(segredo: string, unidade: string, recebida: string): boolean {
  const certa = Buffer.from(assinaturaDoWebhook(segredo, unidade));
  const veio = Buffer.from(recebida);
  return certa.length === veio.length && timingSafeEqual(certa, veio);
}

export interface DepsDoAviso {
  agora?: () => number;
  ctx: ContextoFocus;
  armazem: ArmazemDeNotas;
  segredo: string | undefined;
  alertar: (texto: string) => Promise<boolean>;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export interface RespostaDoAviso {
  http: 200 | 404 | 503;
  resultado: string;
}

/** Um aviso ao João por motivo a cada 15 minutos: a Focus repete a entrega e o Telegram não pode virar enxurrada. */
const JANELA_DO_ALERTA_MS = 15 * 60_000;
const ultimoAlerta = new WeakMap<DepsDoAviso, Map<string, number>>();

function alertaLimitado(deps: DepsDoAviso, chave: string, texto: string): void {
  const agora = (deps.agora ?? Date.now)();
  let m = ultimoAlerta.get(deps);
  if (!m) ultimoAlerta.set(deps, (m = new Map()));
  const antes = m.get(chave);
  if (antes !== undefined && agora - antes < JANELA_DO_ALERTA_MS) return;
  m.set(chave, agora);
  void deps.alertar(texto).catch(() => false);
}

const texto = (v: unknown, max = 100): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export async function processarAviso(deps: DepsDoAviso, p: { unidade: string; assinatura: string }, corpoBruto: unknown): Promise<RespostaDoAviso> {
  if (!deps.segredo) {
    alertaLimitado(deps, '__sem_segredo__', '⚠️ A Focus NFe mandou um aviso de nota, mas FOCUS_NFE_WEBHOOK_SEGREDO não está configurado no servidor: não consigo conferir o endereço. Respondi 503 (a Focus tenta de novo).');
    return { http: 503, resultado: 'sem segredo do webhook' };
  }
  if (!assinaturaBoa(deps.segredo, p.unidade, p.assinatura)) return { http: 404, resultado: 'assinatura' };
  const conta = deps.ctx.contas.get(p.unidade);
  if (!conta) {
    // a assinatura é NOSSA: não ter a unidade carregada é falha nossa, não aviso de ninguém. 503 faz a Focus repetir.
    alertaLimitado(deps, `unidade:${p.unidade}`, `⚠️ A Focus NFe mandou um aviso de nota para a unidade ${p.unidade}, mas o conector não tem essa unidade carregada agora (carga inicial, banco fora do ar, unidade inativada ou token renomeado). Respondi 503: a Focus tenta de novo.`);
    return { http: 503, resultado: 'unidade sem Focus carregada' };
  }
  const corpo = corpoBruto && typeof corpoBruto === 'object' && !Array.isArray(corpoBruto) ? (corpoBruto as Record<string, unknown>) : {};
  const ref = texto(corpo.ref, 60);
  if (!ref || !REFERENCIA_VALIDA.test(ref)) return { http: 200, resultado: 'sem referência' };
  const nota = await deps.armazem.porReferenciaEmQualquerAmbiente(p.unidade, ref);
  // nota que o conector não emitiu (painel da Focus, Asaas): nada a fazer, e 200 para a Focus não repetir por 48 h
  if (!nota) return { http: 200, resultado: 'referência desconhecida' };
  if (nota.ambiente !== conta.ambiente) {
    alertaLimitado(deps, `ambiente:${p.unidade}`, `⚠️ A Focus NFe avisou a nota ${ref} (${nota.ambiente}) mas a unidade ${p.unidade} está em ${conta.ambiente} agora: não confirmei nada. Confira FOCUS_NFE_AMBIENTE_*.`);
    return { http: 200, resultado: 'ambiente diferente' };
  }
  let r;
  try {
    r = await sincronizarNota(deps.ctx, conta, nota);
  } catch (e) {
    deps.log?.warn({ unidade: p.unidade, referencia: ref, erro: e instanceof Error ? e.message : String(e) }, 'focus-nfe: não consegui confirmar o aviso (a Focus tenta de novo)');
    return { http: 503, resultado: 'confirmação indisponível' };
  }
  const dissePelaDica = texto(corpo.status, 40);
  // o aviso diz "autorizado" e a consulta ainda não: pode ser só a consulta chegando antes. 503 faz a Focus tentar de novo; a verdade é a consulta.
  if (dissePelaDica === 'autorizado' && r.focus?.status !== 'autorizado' && r.focus?.status !== 'cancelado') {
    await deps.armazem.atualizar(p.unidade, nota.ambiente, ref, { ultimoEvento: 'aviso:autorizado_nao_confirmado' });
    return { http: 503, resultado: 'não confirmado' };
  }
  const quem = `${conta.nome} · ${ref} · ${dinheiro(nota.valorCentavos / 100)}`;
  if (r.mudou && (r.nota.status === 'erro_autorizacao' || r.nota.status === 'negado')) {
    void deps.alertar(`🚫 Focus NFe: a nota ${quem} NÃO foi autorizada (${r.nota.status}). ${r.nota.erro ?? ''}`.slice(0, 600)).catch(() => false);
  }
  if (r.mudou && r.nota.status === 'cancelado') void deps.alertar(`🚫 Focus NFe: a nota ${quem} aparece CANCELADA. Confira se foi pedido.`).catch(() => false);
  if (r.mudou) deps.log?.info({ unidade: p.unidade, referencia: ref, status: r.nota.status }, 'focus-nfe: status da nota atualizado pelo aviso');
  return { http: 200, resultado: r.mudou ? r.nota.status : 'sem mudança' };
}

/** A rota pública. O corpo já vem lido pelo `express.json` geral. Não devolve nada além de {ok}: quem sonda não aprende o que existe. */
export function montarRotaDoWebhookFocus(app: Express, deps: DepsDoAviso, o: { tentativasPorIp?: JanelaDeContagem } = {}): void {
  const erros = o.tentativasPorIp ?? new JanelaDeContagem(30, 10 * 60_000);
  app.post(ROTA_WEBHOOK_FOCUS, (req: Request, res: Response) => {
    void (async () => {
      const ip = ipDoCliente(req);
      if (erros.excedido(ip, Date.now())) {
        res.status(429).set('Retry-After', '600').json({ ok: false });
        return;
      }
      try {
        const r = await processarAviso(deps, { unidade: String(req.params.unidade), assinatura: String(req.params.assinatura) }, req.body);
        if (r.resultado === 'assinatura') erros.registrar(ip, Date.now());
        res.status(r.http).json({ ok: r.http === 200 });
      } catch (e) {
        deps.log?.warn({ erro: e instanceof Error ? e.message : String(e) }, 'focus-nfe: aviso com falha (a Focus tenta de novo)');
        res.status(503).json({ ok: false });
      }
    })();
  });
}
