import type { Request, Response, NextFunction } from 'express';

/**
 * Freio de força bruta no /auth/login.
 *
 * Auditoria de 26/09/2026: o login não tinha NENHUM limite. 12 tentativas seguidas
 * com senha errada voltavam 401, nunca 429 — dá pra varrer senha à vontade contra
 * qualquer e-mail conhecido, e os e-mails das SDRs não são segredo.
 *
 * Desenho conservador, de propósito:
 *  - Chave por IP+e-mail (não só IP): o NAT de uma clínica não tranca as outras
 *    contas; só a conta sob ataque é freada.
 *  - Janela e teto generosos pra humano (digitar errado algumas vezes é normal),
 *    apertados pra robô.
 *  - FALHA ABERTO: qualquer erro aqui deixa passar. Um freio bugado não pode virar
 *    a porta que derruba o login de todo mundo.
 *  - Em memória e POR PROCESSO. No Swarm com N réplicas o teto efetivo é N×MAX —
 *    ainda corta o ataque em ordens de grandeza. O freio distribuído (store
 *    compartilhado) é decisão de operação, não trava esta correção.
 *
 * Não conta sucesso: o middleware roda ANTES do handler. Contamos toda tentativa;
 * como o teto é alto pra uso humano, login legítimo nunca esbarra nele.
 */

const JANELA_MS = 10 * 60 * 1000; // 10 min
const MAX_TENTATIVAS = 15; // por IP+e-mail na janela
const MAX_CHAVES = 50_000; // trava de memória: e-mail rotativo não infla o mapa sem fim

interface Registro {
  n: number;
  desde: number;
}

const tentativas = new Map<string, Registro>();

function podarSeNecessario(agora: number): void {
  if (tentativas.size < MAX_CHAVES) return;
  for (const [chave, reg] of tentativas) {
    if (agora - reg.desde > JANELA_MS) tentativas.delete(chave);
  }
  // Se ainda estourou (ataque ativo com muitas chaves vivas), zera: falhar aberto
  // é melhor do que crescer sem limite.
  if (tentativas.size >= MAX_CHAVES) tentativas.clear();
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  try {
    const agora = Date.now();
    const emailRaw = (req.body as { email?: unknown } | undefined)?.email;
    const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase().slice(0, 200) : '';
    const chave = `${req.ip ?? 'sem-ip'}:${email}`;

    podarSeNecessario(agora);

    const reg = tentativas.get(chave);
    if (!reg || agora - reg.desde > JANELA_MS) {
      tentativas.set(chave, { n: 1, desde: agora });
      next();
      return;
    }

    reg.n += 1;
    if (reg.n > MAX_TENTATIVAS) {
      const faltamMs = JANELA_MS - (agora - reg.desde);
      res.setHeader('Retry-After', String(Math.ceil(faltamMs / 1000)));
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    next();
  } catch {
    // Falha aberto — nunca derrubar o login por causa do freio.
    next();
  }
}
