/**
 * Uma franquia de mentira em `node:http`, pros testes nunca baterem na de verdade.
 *
 * Ela aplica as regras do guia (401 sem token, 400 com rowsPerPage > 100, página < 1, nome < 2
 * letras, período > 100 dias) e imita o que a franquia real faz e o guia não conta:
 *  - envelope aninhado `{ status, data: { data: [...], total, totalPages } }`;
 *  - período cortado pelo DIA UTC com o fim EXCLUSIVO (o caso pessimista: uma consulta às 22h de
 *    São Paulo cai no dia seguinte em UTC e some se quem pede não tiver folga no fim).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type Registro = Record<string, unknown>;

export interface DadosDaUnidade {
  pacientes?: Registro[];
  agendamentos?: Registro[];
  tratamentos?: Registro[];
  leads?: Registro[];
  gerais?: Record<string, Registro[]>;
  /** sem permissão de BI: responde 403 */
  semBi?: boolean;
  /** devolve um corpo que não é o envelope conhecido */
  formatoEstranho?: boolean;
}

export interface Pedido {
  token: string;
  metodo: string;
  caminho: string;
  corpo: Registro;
}

export interface FranquiaFalsa {
  url: string;
  pedidos: Pedido[];
  /** status devolvidos nas próximas requisições, um por requisição (ex. [500, 500]) */
  falhas: number[];
  /** atraso de cada resposta, em ms */
  atrasoMs: number;
  /** manda o cabeçalho 200 e trava no meio do corpo por este tempo */
  corpoTravadoMs: number;
  fechar(): Promise<void>;
}

const DIA = 86_400_000;

function diasEntre(ini: string, fim: string): number {
  return Math.round((Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${ini}T00:00:00Z`)) / DIA) + 1;
}

function lerCorpo(req: IncomingMessage): Promise<Registro> {
  return new Promise((resolve) => {
    let texto = '';
    req.on('data', (c) => (texto += c));
    req.on('end', () => {
      try {
        resolve(texto ? JSON.parse(texto) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function enviar(res: ServerResponse, status: number, corpo: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

/** Data UTC do registro dentro de [ini, fim) — fim exclusivo, corte pelo dia UTC. */
function noPeriodo(valor: unknown, ini?: unknown, fim?: unknown): boolean {
  if (typeof ini !== 'string' || typeof fim !== 'string') return true;
  if (typeof valor !== 'string') return true;
  const dia = new Date(valor).toISOString().slice(0, 10);
  return dia >= ini && dia < fim;
}

export async function subirFranquiaFalsa(porToken: Record<string, DadosDaUnidade>): Promise<FranquiaFalsa> {
  const falsa: FranquiaFalsa = { url: '', pedidos: [], falhas: [], atrasoMs: 0, corpoTravadoMs: 0, fechar: async () => {} };

  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const caminho = url.pathname;
    const corpo = req.method === 'POST' ? await lerCorpo(req) : {};
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    falsa.pedidos.push({ token, metodo: req.method ?? '?', caminho, corpo });

    if (falsa.atrasoMs) await new Promise((r) => setTimeout(r, falsa.atrasoMs));
    if (res.destroyed) return;

    if (falsa.corpoTravadoMs) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"status":"success","data":{"data":[');
      await new Promise((r) => setTimeout(r, falsa.corpoTravadoMs));
      return res.end(']}}');
    }

    const falha = falsa.falhas.shift();
    if (falha) return enviar(res, falha, { error: `falha simulada ${falha}` });

    if (caminho === '/version') return enviar(res, 200, { version: '1.9.3' });
    if (caminho === '/check') return enviar(res, 200, { api: 'ok' });

    const dados = porToken[token];
    if (!dados) return enviar(res, 401, { error: 'Unauthorized' });
    if (dados.formatoEstranho) return enviar(res, 200, { resultado: 'ok' });

    // ── regras do guia ──
    const erros: string[] = [];
    const pag = (corpo.pagination ?? {}) as { page?: number; rowsPerPage?: number };
    if (pag.rowsPerPage !== undefined && (pag.rowsPerPage > 100 || pag.rowsPerPage < 1)) erros.push('rowsPerPage máximo 100');
    if (pag.page !== undefined && pag.page < 1) erros.push('page começa em 1');
    if (typeof corpo.name === 'string' && corpo.name.length < 2) erros.push('name mínimo 2 caracteres');
    for (const [a, b] of [
      ['initialDate', 'endDate'],
      ['initialCreatedDate', 'endCreatedDate'],
    ] as const) {
      const ini = corpo[a];
      const fim = corpo[b];
      if (typeof ini === 'string' && typeof fim === 'string' && diasEntre(ini, fim) > 100) erros.push('intervalo máximo de 100 dias');
    }
    if (erros.length) return enviar(res, 400, { error: 'Parâmetros inválidos', errors: erros });

    const paginar = (todos: Registro[]) => {
      const page = pag.page ?? 1;
      const rows = pag.rowsPerPage ?? 50;
      const totalPages = Math.max(1, Math.ceil(todos.length / rows));
      return enviar(res, 200, {
        status: 'success',
        data: { data: todos.slice((page - 1) * rows, page * rows), total: todos.length, page, rowsPerPage: rows, totalPages },
      });
    };

    if (req.method === 'POST' && caminho === '/api/schedules/search') {
      const nome = typeof corpo.name === 'string' ? corpo.name.toLowerCase() : null;
      return paginar(
        (dados.agendamentos ?? []).filter(
          (s) => noPeriodo(s.dateAttendance, corpo.initialDate, corpo.endDate) && (!nome || String(s.clientName).toLowerCase().includes(nome)),
        ),
      );
    }
    if (req.method === 'POST' && caminho === '/api/treatments/search') {
      return paginar((dados.tratamentos ?? []).filter((t) => noPeriodo(t.created, corpo.initialCreatedDate, corpo.endCreatedDate)));
    }
    if (req.method === 'POST' && caminho === '/api/leads/search') {
      return paginar((dados.leads ?? []).filter((l) => noPeriodo(l.created, corpo.initialDate, corpo.endDate)));
    }
    if (req.method === 'POST' && caminho === '/api/clients/search') {
      const nome = typeof corpo.name === 'string' ? corpo.name.toLowerCase() : null;
      return paginar(
        (dados.pacientes ?? []).filter(
          (p) => (!nome || String(p.name).toLowerCase().includes(nome)) && (corpo.idClient === undefined || p.idClient === corpo.idClient),
        ),
      );
    }
    const porId = caminho.match(/^\/api\/clients\/(\d+)$/);
    if (req.method === 'GET' && porId) {
      const p = (dados.pacientes ?? []).find((x) => x.idClient === Number(porId[1]));
      return enviar(res, 200, p ? { status: 'success', data: { data: p } } : { success: false, data: null });
    }
    if (req.method === 'GET' && caminho.startsWith('/api/general/')) {
      return enviar(res, 200, { success: true, data: dados.gerais?.[caminho.slice('/api/general/'.length)] ?? [] });
    }
    if (req.method === 'POST' && caminho.startsWith('/api/bi/')) {
      if (dados.semBi) return enviar(res, 403, { error: 'Forbidden' });
      if (typeof corpo.initialDate !== 'string' || typeof corpo.endDate !== 'string') {
        return enviar(res, 400, { error: 'initialDate e endDate são obrigatórios' });
      }
      // BI com fim INCLUSO (como o dashboard usa)
      const dentro = (v: unknown) => typeof v === 'string' && v.slice(0, 10) >= (corpo.initialDate as string) && v.slice(0, 10) <= (corpo.endDate as string);
      const contar = (regs: Registro[], campo: string) => {
        const m: Record<string, number> = {};
        for (const r of regs) m[String(r[campo])] = (m[String(r[campo])] ?? 0) + 1;
        return m;
      };
      if (caminho === '/api/bi/leads/sources') {
        const leads = (dados.leads ?? []).filter((l) => dentro(l.created));
        const m = contar(leads, 'sourceName');
        return enviar(res, 200, { success: true, data: { sources: Object.entries(m).map(([sourceName, total]) => ({ sourceName, total })), total: leads.length } });
      }
      if (caminho === '/api/bi/clients/gender') {
        const pac = (dados.pacientes ?? []).filter((p) => dentro(p.created));
        const m = contar(pac, 'gender');
        const idades = pac.map((p) => Number(p.idade)).filter(Number.isFinite);
        return enviar(res, 200, {
          success: true,
          data: {
            genders: Object.entries(m).map(([gender, total]) => ({ gender, genderName: gender === 'M' ? 'Masculino' : 'Feminino', total })),
            total: pac.length,
            averageAge: idades.length ? idades.reduce((a, b) => a + b, 0) / idades.length : 0,
          },
        });
      }
      if (caminho === '/api/bi/treatments/categories') {
        const trat = (dados.tratamentos ?? []).filter((t) => dentro(t.created));
        const m = contar(trat, 'category');
        return enviar(res, 200, { success: true, data: { categories: Object.entries(m).map(([categoryName, total]) => ({ categoryName, total })), total: trat.length } });
      }
    }
    return enviar(res, 404, { error: 'Not Found' });
  });

  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  falsa.url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  falsa.fechar = () =>
    new Promise((r) => {
      servidor.closeAllConnections();
      servidor.close(() => r());
    });
  return falsa;
}
