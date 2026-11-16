/**
 * Limite de taxa em memória (janela fixa) para rotas PÚBLICAS. Uma chave (ip, ou "global") pode tentar `max` vezes a cada `janelaMs`; passou disso, recebe
 * quantos segundos esperar. A tabela é limitada (`maxChaves`): sob ataque com milhares de IPs ela não cresce sem fim (apaga as janelas vencidas e, se ainda
 * assim passar do teto, as mais antigas).
 *
 * Um processo só: com mais de uma réplica o limite vale por réplica (o teto GLOBAL de cada rota cobre o resto).
 */
import type { Request } from 'express';

export interface Limitador {
  /** conta uma tentativa. `ok: false` = passou do limite; `esperarSeg` diz quanto falta para a janela abrir */
  tentar(chave: string): { ok: boolean; esperarSeg: number };
}

export function criarLimitador(opcoes: { max: number; janelaMs: number; agora?: () => number; maxChaves?: number }): Limitador {
  const agora = opcoes.agora ?? Date.now;
  const maxChaves = opcoes.maxChaves ?? 5000;
  const tabela = new Map<string, { n: number; desde: number }>();
  return {
    tentar(chave) {
      const t = agora();
      const e = tabela.get(chave);
      if (!e || t - e.desde >= opcoes.janelaMs) {
        if (!e && tabela.size >= maxChaves) {
          for (const [k, v] of tabela) if (t - v.desde >= opcoes.janelaMs) tabela.delete(k);
          // ainda cheia (todas as janelas vivas): descarta as mais antigas (a Map guarda a ordem de inserção)
          for (const k of tabela.keys()) {
            if (tabela.size < maxChaves) break;
            tabela.delete(k);
          }
        }
        tabela.delete(chave);
        tabela.set(chave, { n: 1, desde: t });
        return { ok: true, esperarSeg: 0 };
      }
      e.n += 1;
      if (e.n > opcoes.max) return { ok: false, esperarSeg: Math.max(1, Math.ceil((e.desde + opcoes.janelaMs - t) / 1000)) };
      return { ok: true, esperarSeg: 0 };
    },
  };
}

/**
 * O IP de quem chamou, atrás do proxy (Traefik). O proxy ACRESCENTA o IP que viu no FIM de `X-Forwarded-For`; o que vem antes foi escrito pelo cliente e
 * pode ser mentira — por isso vale o ÚLTIMO. Sem o cabeçalho, o endereço da conexão. (Não usamos `req.ip`: sem `trust proxy` ele devolve o IP do proxy,
 * o mesmo para todo mundo.)
 */
export function ipDoCliente(req: Pick<Request, 'headers' | 'socket'>): string {
  const xff = req.headers['x-forwarded-for'];
  const lista = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return lista[lista.length - 1] ?? req.socket?.remoteAddress ?? 'desconhecido';
}
