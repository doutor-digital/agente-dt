/**
 * A porta INTERNA do Caixa (a função do RH em sistemas-dd) no agente-dt: criar e consultar o link de pagamento da InfinitePay. Quem chama é um SERVIDOR (a função do RH, que já conferiu o
 * usuário e a permissão da unidade e leu o valor), nunca a tela e nunca o navegador. (A nota fiscal tem a sua própria porta, em outro PR: caixa-interno-nota.ts.)
 *
 * Tudo nasce desligado:
 *  - sem CAIXA_SERVICO_TOKEN (32+ caracteres) as rotas nem são montadas (404);
 *  - o pedido vem ASSINADO (HMAC-SHA256 de carimbo + método + caminho + corpo, com o CAIXA_SERVICO_TOKEN como chave; carimbo de 5 min): o segredo nunca vai no fio, e um pedido capturado
 *    não serve para outro caminho nem para outro corpo. Comparação em tempo constante; erro conta por IP e depois de 30 em 10 minutos vira 429;
 *  - CRIAR link só nas unidades de CAIXA_LINK_UNIDADES (vazio = nenhuma) E de INFINITEPAY_ESCRITA_UNIDADES, com a MESMA trava por unidade, o mesmo armazém e o mesmo aviso no Telegram do conector e da
 *    Sofia (a criação é a `criarLink` de infinitepay-escrita.ts, a mesma instância do servidor), mas com a origem `caixa` (livro, tetos e limite por hora próprios: ver abaixo);
 *  - tirar uma unidade de CAIXA_LINK_UNIDADES fecha SÓ a criação: o `/status` (e o aviso de pagamento) de links que já foram enviados ao paciente seguem valendo, porque o dinheiro pode entrar depois.
 *
 * Unidade: o slug EXATO da conta (nada de apelido/«nome curto»: é dinheiro). Idempotência: o link por `origem_ref` (o mesmo pedido devolve o mesmo link; valor diferente recusa).
 * Dado pessoal: o recibo da InfinitePay mostra nome e CPF de quem pagou e NUNCA sai daqui (nem no status, nem no aviso): a equipe vê o recibo no app da InfinitePay.
 * Tetos: a origem `caixa` tem o livro, os tetos (padrão R$ 5.000 por link e R$ 20.000 por dia) e o limite por hora (20) PRÓPRIOS em cada unidade, configuráveis por INFINITEPAY_*_CAIXA: nunca bloqueia a Sofia nem o conector.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { nomeParaAPagina, telefoneParaAPagina } from '../lib/sinal-infinitepay.js';
import { unidadesComLinkDoCaixa } from '../lib/caixa-unidades.js';
import { PREFIXO_ORIGEM_CAIXA } from '../lib/caixa-aviso-rh.js';
import { infinitepayDoServidor } from '../lib/infinitepay-servidor.js';
import { criarLink, ORIGEM_REF } from './infinitepay-escrita.js';
import { ipDoCliente, JanelaDeContagem } from './limites.js';

export const TOKEN_MINIMO = 32;
/** O carimbo do pedido vale 5 minutos (contra repetição de um pedido capturado). */
export const JANELA_PEDIDO_S = 300;

/** O segredo de serviço (CAIXA_SERVICO_TOKEN, 32+): é a CHAVE da assinatura dos pedidos; ele nunca vai no fio. */
export function tokenDoServicoDoAmbiente(e: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = e.CAIXA_SERVICO_TOKEN?.trim();
  return t && t.length >= TOKEN_MINIMO ? t : undefined;
}

/** A assinatura do pedido: HMAC-SHA256 hex de `<timestamp>.<MÉTODO>.<caminho com query>.<corpo>` (GET: corpo vazio). Quem chama (a função do RH) usa a mesma conta. */
export function assinarPedidoDoCaixa(segredo: string, ts: string, metodo: string, caminho: string, corpo: string): string {
  return createHmac('sha256', segredo).update(`${ts}.${metodo.toUpperCase()}.${caminho}.${corpo}`).digest('hex');
}

/** Confere a assinatura (tempo constante) e o carimbo (±5 min). O corpo é o JSON já lido, re-serializado: quem assina usa o mesmo `JSON.stringify`. */
export function pedidoAssinadoConfere(req: Request, segredo: string | undefined, agoraMs: number): boolean {
  if (!segredo || segredo.length < TOKEN_MINIMO) return false;
  const ts = req.get('x-dd-timestamp') ?? '';
  const sig = req.get('x-dd-assinatura') ?? '';
  if (!/^\d{9,11}$/.test(ts) || Math.abs(agoraMs / 1000 - Number(ts)) > JANELA_PEDIDO_S) return false;
  const corpo = req.method === 'GET' || req.body === undefined ? '' : JSON.stringify(req.body);
  const esperada = assinarPedidoDoCaixa(segredo, ts, req.method, req.originalUrl, corpo);
  const a = createHash('sha256').update(sig).digest();
  const b = createHash('sha256').update(esperada).digest();
  return timingSafeEqual(a, b);
}

// ----------------------------------------------------------------- validação

export const REFERENCIA_CAIXA = z
  .string()
  .regex(ORIGEM_REF)
  .refine((s) => s.startsWith(PREFIXO_ORIGEM_CAIXA), { message: `origem_ref começa com "${PREFIXO_ORIGEM_CAIXA}"` });

/** O slug exato da conta (minúsculas, letras/números/hífen). Apelido nunca vale. */
export const SLUG = z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);

const CorpoLink = z.object({
  unidade: SLUG,
  origem_ref: REFERENCIA_CAIXA,
  valor: z.number().min(1).max(1_000_000),
  descricao: z.string().min(3).max(120),
  validade_dias: z.number().int().min(1).max(90).optional(),
  cliente: z.object({ nome: z.string().max(120).optional(), telefone: z.string().max(30).optional() }).optional(),
});

const CONSULTA_STATUS = z.object({ unidade: SLUG, origem_ref: REFERENCIA_CAIXA });

// ----------------------------------------------------------------- rotas

export interface DepsCaixaInterno {
  token: string | undefined;
  alertar: (texto: string) => Promise<boolean>;
  /** por padrão lê do ambiente a CADA pedido (virar a chave não pede reinício). Vale SÓ para criar. */
  unidadesLink?: () => Set<string>;
  agora?: () => number;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export class Recusa extends Error {
  constructor(
    readonly http: number,
    msg: string,
  ) {
    super(msg);
  }
}

/** O porteiro das rotas internas (token de serviço + limite de erros por IP) e o respondedor com o mapa de erros. Usado também pela porta da nota. */
export function criarPorta(d: Pick<DepsCaixaInterno, 'token' | 'agora' | 'log'>, o: { falhasPorIp?: JanelaDeContagem } = {}) {
  const falhas = o.falhasPorIp ?? new JanelaDeContagem(30, 10 * 60_000);
  const agora = d.agora ?? Date.now;
  const porta = (req: Request, res: Response, next: NextFunction): void => {
    const ip = ipDoCliente(req);
    if (falhas.excedido(ip, agora())) {
      res.status(429).set('Retry-After', '600').json({ ok: false });
      return;
    }
    if (!pedidoAssinadoConfere(req, d.token, agora())) {
      falhas.registrar(ip, agora());
      res.status(401).json({ ok: false });
      return;
    }
    next();
  };
  const responder = (res: Response, fn: () => Promise<unknown>): void => {
    void (async () => {
      try {
        res.json({ ok: true, ...((await fn()) as object) });
      } catch (e) {
        if (e instanceof Recusa) res.status(e.http).json({ ok: false, erro: e.message });
        else if (e instanceof ErroDeEntrada) res.status(422).json({ ok: false, erro: e.message });
        else if (e instanceof z.ZodError) res.status(400).json({ ok: false, erro: `pedido inválido: ${e.issues.map((i) => i.path.join('.') || 'corpo').join(', ')}` });
        else {
          d.log?.warn({ erro: e instanceof Error ? e.name : 'erro' }, 'caixa-interno: falha inesperada');
          res.status(500).json({ ok: false, erro: 'falha inesperada' });
        }
      }
    })();
  };
  return { porta, responder };
}

export function montarRotasDoCaixa(app: Express, d: DepsCaixaInterno, o: { falhasPorIp?: JanelaDeContagem } = {}): boolean {
  // sem token as rotas NÃO EXISTEM (404): nada para sondar
  if (!d.token) return false;
  const { porta, responder } = criarPorta(d, o);
  const unidadesLink = d.unidadesLink ?? (() => unidadesComLinkDoCaixa());

  /** A conta da unidade pelo slug EXATO (nunca por apelido). */
  const contaExata = (alvo: string) => {
    const srv = infinitepayDoServidor();
    if (!srv) throw new Recusa(503, 'a InfinitePay deste servidor ainda não foi carregada');
    const conta = srv.ctx.contas.get(alvo);
    if (!conta) throw new Recusa(404, `unidade sem InfinitePay: ${alvo} (use o slug exato)`);
    return { srv, slug: conta.slug };
  };

  app.post('/interno/caixa/link', porta, (req, res) =>
    responder(res, async () => {
      const c = CorpoLink.parse(req.body);
      const { srv, slug } = contaExata(c.unidade);
      // só a CRIAÇÃO depende da lista do Caixa
      if (!unidadesLink().has(slug)) throw new Recusa(403, `o link de pagamento do Caixa não está ligado na unidade ${slug} (CAIXA_LINK_UNIDADES; só o João liga)`);
      const nome = nomeParaAPagina(c.cliente?.nome);
      const telefone = telefoneParaAPagina(c.cliente?.telefone);
      const cliente = { ...(nome ? { nome } : {}), ...(telefone ? { telefone } : {}) };
      const r = await criarLink(srv.ctx, srv.esc, { id: 'caixa' }, {
        unidade: slug,
        origem: 'caixa',
        valor: c.valor,
        descricao: c.descricao,
        origemRef: c.origem_ref,
        ...(c.validade_dias ? { validadeDias: c.validade_dias } : {}),
        ...(Object.keys(cliente).length ? { cliente, semEndereco: true } : { semEndereco: true }),
      });
      return {
        criado: r.criado,
        ja_existia: 'jaExistia' in r ? r.jaExistia === true : false,
        url: r.url,
        order_nsu: r.orderNsu,
        valor: r.valor,
        valido_ate: r.validoAte,
        status: 'status' in r ? r.status : 'criado',
      };
    }),
  );

  // O status NÃO depende da lista de unidades: um link já enviado ao paciente pode ser pago depois de a unidade sair da lista.
  app.get('/interno/caixa/status', porta, (req, res) =>
    responder(res, async () => {
      const q = CONSULTA_STATUS.parse(req.query);
      const { srv, slug } = contaExata(q.unidade);
      const l = await srv.esc.armazem.porOrigemRef(slug, q.origem_ref);
      if (!l) return { existe: false };
      return {
        existe: true,
        status: l.status,
        url: l.url,
        order_nsu: l.orderNsu,
        transaction_nsu: l.transactionNsu,
        valor_centavos: l.valorCentavos,
        valido_ate: l.validoAte,
        pago_em: l.pagoEm,
        valor_pago_centavos: l.valorPagoCentavos,
        forma: l.formaPagamento,
        parcelas: l.parcelas,
        // SEM recibo_url: o recibo mostra nome e CPF de quem pagou. A equipe vê o recibo no app da InfinitePay.
        // estorno/cancelamento avisado pela InfinitePay e não confirmado: o RH mostra o alerta, nunca desfaz sozinho
        em_revisao: !!l.revisao,
      };
    }),
  );

  return true;
}
