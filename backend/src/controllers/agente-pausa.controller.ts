/**
 * Pausar e religar a Sofia DA CLÍNICA pelo painel «Agente» do Chatwoot. Usa o MESMO mecanismo da página pública `/pausa/:slug` (colunas
 * `units.pausa_*`, `aplicarPausa`/`retomar` de `pausa.controller.ts`): pausa a unidade inteira, vale até a hora escolhida (no máximo
 * 7 dias) e a Sofia volta sozinha.
 *
 *   GET  /api/public/agente/pausa?slug=              como está (qualquer atendente da unidade vê) + `podeMudar`
 *   POST /api/public/agente/pausa                    { slug, ate, desde?, motivo?, confirmar: true }   só administradora/gerente
 *   POST /api/public/agente/pausa/retomar            { slug }                                          só administradora/gerente
 *
 * Quem pode: o administrador da CONTA do Chatwoot (ou e-mail em `CHATWOOT_GESTORES`, só na conta do ambiente) — a mesma regra de
 * Gestor/Marketing (`podeVerGestao`). A unidade tem que ser da conta e das caixas da pessoa (`atendenteDaUnidade`: conta errada e
 * unidade de outra clínica recusam antes de qualquer leitura ou escrita). Quem mudou é SEMPRE o nome do login (a página não escolhe),
 * fica em `pausa_por`, no log e no aviso ao João (o mesmo da pausa pela recepção).
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { ctxEhDoAmbiente } from '../lib/conta-da-requisicao.js';
import { podeVerGestao } from '../lib/chatwoot-gestor.js';
import { atendenteDaUnidade } from './aprendizados.controller.js';
import { aplicarPausa, estado as estadoDaPausa, retomar } from './pausa.controller.js';

type Atendente = { nome: string; papel?: string | null; email?: string | null; c: Parameters<typeof ctxEhDoAmbiente>[0] };

export interface PortasDaPausaDoAgente {
  atendente(req: Request, res: Response, slug: string): Promise<{ a: Atendente; unit: Unit } | null>;
  gestoresDaConta(a: Atendente): string | undefined;
  aplicar: typeof aplicarPausa;
  retomar: typeof retomar;
  estado: typeof estadoDaPausa;
}

const portasReais = (): PortasDaPausaDoAgente => ({
  atendente: (req, res, slug) => atendenteDaUnidade(req, res, slug) as Promise<{ a: Atendente; unit: Unit } | null>,
  gestoresDaConta: (a) => (ctxEhDoAmbiente(a.c) ? process.env.CHATWOOT_GESTORES : undefined),
  aplicar: aplicarPausa,
  retomar,
  estado: estadoDaPausa,
});

const slugDe = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
const MSG_SO_GERENTE = 'Só a administradora ou a gerente da conta pode pausar ou religar a Sofia da clínica.';

/** O que a tela precisa do estado: sem código da unidade, sem e-mail de ninguém. */
function paraATela(u: Unit, e: ReturnType<typeof estadoDaPausa>, podeMudar: boolean) {
  return { slug: u.slug, unidade: u.name, tz: e.tz, emPausa: e.emPausa, agendada: e.agendada, desde: e.pausaDesde, ate: e.pausaAte, motivo: e.motivo, por: e.por, descricao: e.descricao, agora: e.agora, podeMudar };
}

export function fazerPausaDoAgente(portas: PortasDaPausaDoAgente = portasReais()) {
  const pode = (a: Atendente) => podeVerGestao(a.papel, a.email, portas.gestoresDaConta(a));

  async function ver(req: Request, res: Response): Promise<void> {
    const r = await portas.atendente(req, res, slugDe(req.query.slug));
    if (!r) return;
    res.set('Cache-Control', 'no-store').json(paraATela(r.unit, portas.estado(r.unit), pode(r.a)));
  }

  async function pausar(req: Request, res: Response): Promise<void> {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const r = await portas.atendente(req, res, slugDe(corpo.slug));
    if (!r) return;
    if (!pode(r.a)) {
      logger.warn({ unit: r.unit.slug, quem: r.a.nome, papel: r.a.papel }, 'agente: pausa da Sofia recusada (não é administradora nem gerente)');
      res.status(403).json({ error: MSG_SO_GERENTE });
      return;
    }
    if (corpo.confirmar !== true) {
      res.status(400).json({ error: 'confirme a pausa antes de enviar' });
      return;
    }
    const motivo = typeof corpo.motivo === 'string' ? corpo.motivo.trim() : '';
    if (motivo.length < 3) {
      res.status(400).json({ error: 'escreva o motivo da pausa' });
      return;
    }
    // não passa por cima de uma pausa que já existe (a da recepção, a de outra pessoa): religar é um passo à parte e fica registrado.
    // A checagem rápida avisa sem tocar no banco; a gravação em si é CONDICIONAL (`soSeLivre`), para duas pausas ao mesmo tempo não se sobrescreverem.
    const ja = portas.estado(r.unit);
    if (ja.emPausa || ja.agendada) {
      res.status(409).json({ error: 'A Sofia já está pausada (ou com pausa marcada). Religue antes de pausar de novo.', ...paraATela(r.unit, ja, true) });
      return;
    }
    const por = r.a.nome.slice(0, 80) || 'atendente';
    // «por» é sempre o login: o que a página mandar não vale
    const res2 = await portas.aplicar(r.unit, { ate: corpo.ate, desde: corpo.desde ?? null, motivo, por }, por, { soSeLivre: true });
    if (!res2.ok) {
      if (res2.conflito) res.status(409).json({ error: res2.erro, ...paraATela(res2.conflito, portas.estado(res2.conflito), true) });
      else res.status(400).json({ error: res2.erro });
      return;
    }
    logger.info({ unit: r.unit.slug, por, ate: res2.unit.pausaAte, motivo: res2.unit.pausaMotivo }, 'agente: Sofia da clínica pausada pelo painel');
    res.set('Cache-Control', 'no-store').json(paraATela(res2.unit, portas.estado(res2.unit), true));
  }

  async function religar(req: Request, res: Response): Promise<void> {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const r = await portas.atendente(req, res, slugDe(corpo.slug));
    if (!r) return;
    if (!pode(r.a)) {
      logger.warn({ unit: r.unit.slug, quem: r.a.nome, papel: r.a.papel }, 'agente: religar a Sofia recusado (não é administradora nem gerente)');
      res.status(403).json({ error: MSG_SO_GERENTE });
      return;
    }
    const por = r.a.nome.slice(0, 80) || 'atendente';
    // sem pausa ativa nem marcada não há o que religar: nada é gravado e ninguém é avisado
    const atual = portas.estado(r.unit);
    if (!atual.emPausa && !atual.agendada) {
      res.set('Cache-Control', 'no-store').json(paraATela(r.unit, atual, true));
      return;
    }
    const unit = await portas.retomar(r.unit, por, { soSeHouver: true });
    logger.info({ unit: r.unit.slug, por }, 'agente: Sofia da clínica religada pelo painel');
    res.set('Cache-Control', 'no-store').json(paraATela(unit, portas.estado(unit), true));
  }

  return { ver, pausar, religar };
}

const reais = fazerPausaDoAgente();
export const agentePausaVerHandler = reais.ver;
export const agentePausarHandler = reais.pausar;
export const agenteReligarHandler = reais.religar;
