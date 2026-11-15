/**
 * De que conta do Chatwoot é esta requisição? (passo 4 da «uma conta por clínica»)
 *
 * As telas (Funil, Hoje, Robôs, Agente, Assistente…) rodam DENTRO do Chatwoot e sabem em que conta a pessoa está (`/app/accounts/<N>/…`):
 * mandam `?conta=<N>`. Esse número é só um PEDIDO — nunca uma prova. Quem decide é o servidor:
 *   1. sem `conta` → a conta do ambiente (Parauapebas), exatamente como era antes;
 *   2. com `conta` → ela tem que ser uma conta que ALGUMA unidade configurada usa (e ter token); senão 403;
 *   3. e a sessão da pessoa tem que ser MEMBRO dessa conta (o `/profile` do Chatwoot lista as contas dela): isso é conferido em
 *      `funil.controller.ts › quemEstaLogado`, com o cache separado por conta.
 * Conta que não existe e conta de que a pessoa não é membro recebem a MESMA resposta (não dá para descobrir quais contas existem).
 * Link avulso (chave do funil) só abre a conta que tem token PRÓPRIO: o token global é o de Parauapebas e não vale em outra conta.
 */
import type { Request } from 'express';
import { contaDaUnidade, contasExplicitas } from './chatwoot-unidades.js';
import { contaChatwootDoAmbiente, contextoDaContaPorId, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

export const MENSAGEM_SEM_CONTA = 'seu usuário do CRM não tem acesso a esta conta — peça para a Suzanne';

export type ContextoDaRequisicao = { ctx: ContextoChatwoot; propria: boolean } | { status: 400 | 403 | 404; erro: string; sessao?: 'sem-conta' };

/** A conta que a requisição PEDIU: `null` = não pediu (vale a do ambiente); `undefined` = pediu algo que não é um número de conta. */
export function contaPedida(req: Pick<Request, 'query'>): number | null | undefined {
  const v = req.query?.conta;
  if (v === undefined) return null;
  if (typeof v !== 'string' || !/^[1-9]\d{0,9}$/.test(v)) return undefined; // repetida (array), objeto, vazia, «1e3», «-1», «0x1»…
  return Number(v);
}

let base: { chave: string; ctx: ContextoChatwoot } | null = null;
/** O contexto do ambiente, um só (identidade: Parauapebas segue com o mesmo objeto de sempre). Refeito se o ambiente mudar. */
function contextoDoAmbiente(e: NodeJS.ProcessEnv): ContextoChatwoot | null {
  const conta = contaChatwootDoAmbiente(e);
  if (!conta) return null;
  const chave = `${conta.url}\u0000${conta.conta}\u0000${conta.token}`;
  if (!base || base.chave !== chave) base = { chave, ctx: criarContextoChatwoot(conta) };
  return base.ctx;
}

/** Só para os testes. */
export const esquecerContextoDoAmbiente = (): void => {
  base = null;
};

/**
 * O contexto da conta pedida, ou o motivo de recusar. `propria` = a conta tem token próprio (o link avulso só vale assim; na do ambiente é sempre true).
 * Nunca fala com o Chatwoot.
 */
export function contextoDaRequisicao(req: Pick<Request, 'query'>, e: NodeJS.ProcessEnv = process.env): ContextoDaRequisicao {
  const amb = contextoDoAmbiente(e);
  if (!amb?.conta) return { status: 404, erro: 'desligado (CRM não configurado)' };
  const pedida = contaPedida(req);
  if (pedida === undefined) return { status: 400, erro: 'conta inválida' };
  const recusa: ContextoDaRequisicao = { status: 403, erro: MENSAGEM_SEM_CONTA, sessao: 'sem-conta' };
  if (pedida === null) return { ctx: amb, propria: true };
  if (pedida === amb.conta.conta && !contasExplicitas().includes(pedida)) return { ctx: amb, propria: true };
  if (!contasExplicitas().includes(pedida)) return recusa; // nenhuma unidade usa essa conta
  const ctx = contextoDaContaPorId(amb, pedida, e);
  if (!ctx?.conta) return recusa; // falta o token da conta
  return { ctx, propria: ctx.conta.token !== amb.conta.token };
}

/** A conta pedida é a do ambiente (a de Parauapebas)? Só nela valem as listas globais (gestores por e-mail). */
export const ehContaDoAmbiente = (ctx: ContextoChatwoot, e: NodeJS.ProcessEnv = process.env): boolean => {
  const amb = contaChatwootDoAmbiente(e);
  return !!amb && !!ctx.conta && ctx.conta.conta === amb.conta && !contasExplicitas().includes(amb.conta);
};

/**
 * A unidade `slug` mora na conta deste contexto? Cinto e suspensório de «você atende uma caixa dela»: uma sessão que é membro da conta 2 e
 * pede a unidade de Parauapebas (conta 1) é recusada aqui, antes de ler qualquer dado. Unidade desconhecida ou com conta inválida: não.
 */
export function unidadeEDaConta(slug: string, ctx: ContextoChatwoot, e: NodeJS.ProcessEnv = process.env): boolean {
  const doSlug = contaDaUnidade(slug);
  if (doSlug === undefined || !ctx.conta) return false;
  const esperada = doSlug ?? contaChatwootDoAmbiente(e)?.conta;
  return esperada === ctx.conta.conta;
}
