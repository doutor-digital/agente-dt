/**
 * Agente de suporte 24 h — a FILA entre o painel/menu e o Claude Code que roda na VPS (usuário isolado `suporte-ia`).
 *
 * Pedido do João (09/11/2026): "quero o agente trabalhando por mim, lembrando que o agente vai ser nosso Claude Code".
 *
 * Como funciona:
 *   - demanda de número VERIFICADO pelo grupo de Marketing entra na fila sozinha (depois da análise); as outras só pelo botão
 *     "Mandar para o Claude" no painel (administrador geral). É a primeira trava contra injeção pelo WhatsApp: estranho não
 *     aciona o agente;
 *   - o trabalhador da VPS pede a próxima (`/api/suporte/claude/proxima`, chave de serviço), trabalha num checkout limpo e
 *     devolve o resultado (`/resultado`): resumo, causa, o que fez, o PR (NUNCA mescla) ou o que uma pessoa tem de fazer;
 *   - o resultado vai ao painel e ao bot de chamados.
 *
 * LIGA/DESLIGA — `SUPORTE_CLAUDE` (global): `desligado` (padrão: nada entra na fila e o trabalhador recebe "nada a fazer") | `ligado`.
 * Chave do trabalhador: `SUPORTE_CLAUDE_CHAVE`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { limparTexto, type Verificacao } from './suporte-menu-maquina.js';

export type ModoClaude = 'desligado' | 'ligado';
export type StatusClaude = 'fila' | 'trabalhando' | 'feito' | 'falhou';

export function lerModoClaude(env: NodeJS.ProcessEnv = process.env): ModoClaude {
  return String(env.SUPORTE_CLAUDE ?? '').trim().toLowerCase() === 'ligado' ? 'ligado' : 'desligado';
}

/** Chave do trabalhador da VPS, em tempo constante. Sem chave configurada = recusa tudo. */
export function chaveDoTrabalhadorConfere(recebida: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const certa = String(env.SUPORTE_CLAUDE_CHAVE ?? '').trim();
  if (!certa || certa.length < 24 || typeof recebida !== 'string' || !recebida) return false;
  return timingSafeEqual(createHash('sha256').update(certa).digest(), createHash('sha256').update(recebida).digest());
}

/** Entra sozinha na fila? Só com o agente ligado, número verificado pelo grupo e demanda que ainda não foi para o agente. */
export function entraSozinha(modo: ModoClaude, verificacao: Verificacao, statusAtual: string | null): boolean {
  return modo === 'ligado' && verificacao === 'grupo' && statusAtual == null;
}

/** Pelo painel: pode mandar se não está na fila nem trabalhando e a demanda não está resolvida. */
export function podeMandarPeloPainel(statusDemanda: string, statusClaude: string | null): { ok: true } | { ok: false; erro: string } {
  if (statusDemanda === 'resolvida') return { ok: false, erro: 'a demanda já está resolvida' };
  if (statusClaude === 'fila' || statusClaude === 'trabalhando') return { ok: false, erro: 'o agente já está com esta demanda' };
  return { ok: true };
}

/** Trabalho preso há mais que isto (o trabalhador caiu no meio): é dado como falho para não travar a fila. */
export const TRABALHO_PRESO_MIN = 90;

const PR_DO_REPO = /^https:\/\/github\.com\/doutor-digital\/agente-dt\/pull\/\d{1,7}$/;

export interface ResultadoDoAgente {
  ok: boolean;
  resumo: string;
  prUrl: string | null;
  precisaPessoa: boolean;
  oQueFazer: string | null;
}

/** Lê o que o trabalhador devolveu sem confiar: só PR deste repositório, textos cortados e sem caracteres de controle. */
export function lerResultado(corpo: unknown): { ok: true; r: ResultadoDoAgente } | { ok: false; erro: string } {
  if (typeof corpo !== 'object' || corpo === null) return { ok: false, erro: 'corpo inválido' };
  const c = corpo as Record<string, unknown>;
  const resumo = typeof c.resumo === 'string' ? limparTexto(c.resumo, 2_000) : '';
  if (!resumo) return { ok: false, erro: 'resumo vazio' };
  const pr = typeof c.prUrl === 'string' ? c.prUrl.trim() : '';
  if (pr && !PR_DO_REPO.test(pr)) return { ok: false, erro: 'prUrl tem de ser um PR do doutor-digital/agente-dt' };
  const oQue = typeof c.oQueFazer === 'string' ? limparTexto(c.oQueFazer, 2_000) : '';
  return {
    ok: true,
    r: { ok: c.ok !== false, resumo, prUrl: pr || null, precisaPessoa: c.precisaPessoa !== false, oQueFazer: oQue || null },
  };
}

/** O cartão do Telegram (texto puro). */
export function cartaoDoAgente(protocolo: number, r: ResultadoDoAgente): string {
  const linhas = [`🤖 Claude trabalhou na #${protocolo}${r.ok ? '' : ' (NÃO concluiu)'}`, r.resumo];
  if (r.prUrl) linhas.push('', `PR para revisar e mesclar: ${r.prUrl}`);
  if (r.oQueFazer) linhas.push('', `O que uma pessoa precisa fazer: ${r.oQueFazer}`);
  linhas.push('', r.precisaPessoa ? 'Depois de resolver, marque "Resolvido" no painel suporte.* (a pessoa recebe o "pode testar").' : 'Pode já marcar "Resolvido" no painel.');
  return linhas.join('\n');
}
