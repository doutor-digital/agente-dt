/**
 * Um Asaas falso para os testes da escrita (cliente, cobrança, editar, cancelar, estornar, transferir). Guarda o que foi gravado e
 * deixa injetar falhas por método + rota. NÃO chama a rede. Mesmo papel do `kommo-falso.ts`.
 */
import { criarContextoAsaas, type ContaAsaas } from './asaas.js';
import { criarEscritaAsaas } from './asaas-escrita.js';
import { Livro, type Porteiro } from './asaas-limites.js';
import { lancamentosRecentesDe, type LeitorDeAuditoria } from './auditoria.js';

export class ErroHttp extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

export interface Cli { id: string; name: string; cpfCnpj: string; email?: string; mobilePhone?: string; notificationDisabled?: boolean; deleted?: boolean }
export interface Pg {
  id: string;
  customer?: string;
  status: string;
  value: number;
  dueDate?: string;
  description?: string;
  billingType?: string;
  externalReference?: string;
  installment?: string;
  deleted?: boolean;
  refunds?: Array<{ value: number }>;
  [k: string]: unknown;
}

export interface Opc {
  clientes?: Cli[];
  pagamentos?: Pg[];
  /** falha por método + rota (a primeira que casa) */
  falhas?: Array<{ metodo: string; caminho: RegExp; erro: Error }>;
  falhaNoPagamento?: Error;
  falhaNoCliente?: Error;
  semNomeDaConta?: boolean;
  semEscrita?: boolean;
  semLinhaDigitavel?: boolean;
  /** o Asaas devolve estes clientes para QUALQUER busca por documento (resposta fora do combinado) */
  clientesTortos?: Cli[];
  saldo?: number;
  /** o Asaas NÃO devolve o campo `refunds` na cobrança (para provar que sem a lista e sem o campo o estorno recusa) */
  semCampoRefunds?: boolean;
  /** outro slug para a conta (padrão a Serra) */
  slug?: string;
  /** a impressão curta da chave do Asaas (duas contas com o mesmo valor usam a mesma chave) */
  chaveGrupo?: string;
  fuso?: string;
  /** o POST /transfers responde com este status */
  statusDaTransferencia?: string;
}

export interface Chamada { metodo: string; caminho: string; corpo?: Record<string, any> }

export function asaasFalso(o: Opc = {}) {
  const clientes = [...(o.clientes ?? [])];
  const pagamentos: Pg[] = [...(o.pagamentos ?? [])];
  const chamadas: Chamada[] = [];
  const gets: string[] = [];
  let seq = 0;
  const falhar = (metodo: string, caminho: string) => {
    const f = o.falhas?.find((x) => x.metodo === metodo && x.caminho.test(caminho));
    if (f) throw f.erro;
  };
  const conta: ContaAsaas = {
    slug: o.slug ?? 'doutor-hernia-serra',
    nome: o.slug ?? 'Serra',
    ...(o.fuso ? { fuso: o.fuso } : {}),
    fonte: {
      async get<T>(caminho: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
        gets.push(caminho);
        falhar('GET', caminho);
        if (caminho === '/myAccount/commercialInfo') {
          if (o.semNomeDaConta) throw new ErroHttp('Asaas 404', 404);
          return { companyName: 'Clínica Serra Saúde LTDA' } as T;
        }
        if (caminho === '/finance/balance') return { balance: o.saldo ?? 100_000 } as T;
        if (caminho === '/customers') {
          const doc = String(query.cpfCnpj ?? '');
          if (o.clientesTortos) return { data: o.clientesTortos } as T;
          return { data: clientes.filter((c) => !c.deleted && c.cpfCnpj.replace(/\D/g, '') === doc) } as T;
        }
        const m = caminho.match(/^\/customers\/(.+)$/);
        if (m) {
          const c = clientes.find((x) => x.id === m[1]);
          if (!c) throw new ErroHttp('Asaas 404 em /customers', 404);
          return c as T;
        }
        if (caminho === '/payments') return { data: pagamentos.filter((p) => p.externalReference === query.externalReference) } as T;
        if (/^\/payments\/[^/]+\/refunds$/.test(caminho)) {
          const x = pagamentos.find((y) => y.id === caminho.split('/')[2]);
          if (!x) throw new ErroHttp('Asaas 404 em /payments', 404);
          return { data: x.refunds ?? [] } as T;
        }
        if (/^\/payments\/.+\/identificationField$/.test(caminho)) {
          if (o.semLinhaDigitavel) throw new ErroHttp('Asaas 404', 404);
          return { identificationField: '34191.79001 01043.510047 91020.150008 5 87650026000' } as T;
        }
        if (/^\/payments\/.+\/pixQrCode$/.test(caminho)) return { payload: '00020126580014br.gov.bcb.pix0136abc' } as T;
        const p = caminho.match(/^\/payments\/([^/]+)$/);
        if (p) {
          const x = pagamentos.find((y) => y.id === p[1]);
          if (!x) throw new ErroHttp('Asaas 404 em /payments', 404);
          if (o.semCampoRefunds) {
            const { refunds: _r, ...semCampo } = x;
            void _r;
            return semCampo as T;
          }
          return { ...x, refunds: x.refunds ?? [] } as T;
        }
        throw new Error(`rota não simulada: ${caminho}`);
      },
    },
    ...(o.semEscrita
      ? {}
      : {
          escrita: {
            chaveFinal: '…xYZ1',
            chaveGrupo: o.chaveGrupo ?? 'grupo-da-serra',
            contaSalva: 'Serra (nome salvo)',
            async enviar<T>(metodo: 'POST' | 'PUT' | 'DELETE', caminho: string, corpo?: Record<string, unknown>): Promise<T> {
              chamadas.push({ metodo, caminho, ...(corpo ? { corpo: corpo as Record<string, any> } : {}) });
              falhar(metodo, caminho);
              if (metodo === 'POST' && caminho === '/customers') {
                if (o.falhaNoCliente) throw o.falhaNoCliente;
                const c: Cli = { id: `cus_00000${++seq}1234`, name: String(corpo!.name), cpfCnpj: String(corpo!.cpfCnpj), notificationDisabled: corpo!.notificationDisabled === true };
                clientes.push(c);
                return c as T;
              }
              const cp = caminho.match(/^\/customers\/([^/]+)$/);
              if (metodo === 'PUT' && cp) {
                const c = clientes.find((x) => x.id === cp[1])!;
                if (corpo!.name) c.name = String(corpo!.name);
                if (corpo!.email) c.email = String(corpo!.email);
                if (corpo!.notificationDisabled !== undefined) c.notificationDisabled = corpo!.notificationDisabled === true;
                return c as T;
              }
              if (metodo === 'POST' && caminho === '/payments') {
                if (o.falhaNoPagamento) throw o.falhaNoPagamento;
                const total = (corpo!.installmentCount ? corpo!.totalValue : corpo!.value) as number;
                const p: Pg = {
                  id: `pay_${++seq}0000000001`,
                  status: 'PENDING',
                  customer: String(corpo!.customer),
                  value: total,
                  dueDate: String(corpo!.dueDate),
                  description: String(corpo!.description),
                  billingType: String(corpo!.billingType),
                  ...(corpo!.externalReference ? { externalReference: String(corpo!.externalReference) } : {}),
                  ...(corpo!.installmentCount ? { installment: 'ins_000000123456' } : {}),
                };
                pagamentos.push(p);
                return { ...p, bankSlipUrl: p.billingType === 'BOLETO' ? 'https://www.asaas.com/b/pdf/abc123' : null, invoiceUrl: 'https://www.asaas.com/i/abc123' } as T;
              }
              const pp = caminho.match(/^\/payments\/([^/]+)(\/refund)?$/);
              if (pp) {
                const p = pagamentos.find((x) => x.id === pp[1])!;
                if (metodo === 'PUT') {
                  if (corpo!.value !== undefined) p.value = corpo!.value as number;
                  if (corpo!.dueDate) p.dueDate = String(corpo!.dueDate);
                  if (corpo!.description) p.description = String(corpo!.description);
                  return p as T;
                }
                if (metodo === 'DELETE') {
                  p.deleted = true;
                  p.status = 'DELETED';
                  return { deleted: true, id: p.id } as T;
                }
                if (metodo === 'POST' && pp[2]) {
                  const v = (corpo!.value as number | undefined) ?? p.value;
                  (p.refunds ??= []).push({ value: v });
                  p.status = v >= p.value ? 'REFUNDED' : 'RECEIVED';
                  return p as T;
                }
              }
              if (metodo === 'POST' && caminho === '/transfers') return { id: `tra_${++seq}`, status: o.statusDaTransferencia ?? 'PENDING', value: corpo!.value } as T;
              throw new Error(`escrita não simulada: ${metodo} ${caminho}`);
            },
          },
        }),
  };
  return { conta, clientes, pagamentos, chamadas, gets, posts: () => chamadas.filter((c) => c.metodo !== 'GET') };
}

export const AGORA = Date.parse('2026-10-28T15:00:00-03:00');

// ----------------------------------------------------------------- o banco e o porteiro de mentira

export interface LinhaDeAuditoria {
  ferramenta: string;
  argumentos: Record<string, any>;
  ok: boolean;
  erro?: string;
  createdAt: Date;
}

/**
 * Um banco de auditoria de mentira que DUAS instâncias podem dividir (é a tabela `mcp_auditoria` e a trava `pg_advisory_xact_lock`): `comTrava` é a
 * trava única por chave, `leitor` é o `findMany` do Prisma. Instâncias diferentes = `montar` diferentes com o mesmo `BancoFalso`.
 */
export class BancoFalso {
  linhas: LinhaDeAuditoria[] = [];
  private travas = new Map<string, Promise<void>>();

  async comTrava<T>(chave: string, fn: () => Promise<T>): Promise<T> {
    const anterior = this.travas.get(chave) ?? Promise.resolve();
    let solta!: () => void;
    const minha = new Promise<void>((r) => (solta = r));
    this.travas.set(chave, anterior.then(() => minha));
    await anterior;
    try {
      return await fn();
    } finally {
      solta();
    }
  }

  gravar(l: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }, em: number): void {
    this.linhas.push({ ferramenta: l.ferramenta, argumentos: JSON.parse(JSON.stringify(l.argumentos ?? {})), ok: l.ok, erro: l.erro, createdAt: new Date(em) });
  }

  leitor(): LeitorDeAuditoria {
    return {
      mcpAuditoria: {
        findMany: async ({ where }) =>
          this.linhas
            .filter((l) => where.ferramenta.in.includes(l.ferramenta) && l.createdAt >= where.createdAt.gte && where.OR.some((c) => l.argumentos[c.argumentos.path[0]!] === c.argumentos.equals))
            .map((l) => ({ createdAt: l.createdAt, ok: l.ok, ferramenta: l.ferramenta, argumentos: l.argumentos })),
      },
    };
  }
}

/** O mesmo contrato do `porteiroPrisma` (trava por chave do Asaas → ler → conferir → gravar a intenção), sobre o banco de mentira. */
export function porteiroEmMemoria(banco: BancoFalso, agora: () => number, aoReservar?: (evento: string, argumentos: Record<string, any>) => void): Porteiro {
  let n = 0;
  return {
    async reservar(p) {
      return banco.comTrava(`asaas-dinheiro:${p.grupo}`, async () => {
        // um respiro entre ler e gravar: sem a trava, duas reservas simultâneas passariam as duas pelo mesmo saldo
        const livro = new Livro(await lancamentosRecentesDe(banco.leitor(), p.conta, p.agora, p.grupo));
        await new Promise((r) => setImmediate(r));
        p.conferir(livro);
        const intencaoId = `int-${p.grupo}-${++n}-${Math.random().toString(36).slice(2, 8)}`;
        const argumentos = { ...p.argumentos, conta: p.conta, chaveAsaas: p.grupo, intencaoId, fase: 'intencao', incerto: true };
        banco.gravar({ ferramenta: p.evento, argumentos, ok: true }, agora());
        aoReservar?.(p.evento, argumentos);
        return { intencaoId };
      });
    },
    async ler(grupo, conta, ag) {
      return new Livro(await lancamentosRecentesDe(banco.leitor(), conta, ag, grupo));
    },
  };
}

export const GRUPO_DA_SERRA = 'grupo-da-serra';

/**
 * O conjunto de teste: Asaas falso, estado da escrita com relógio controlável, a Serra ligada, o Telegram falso (`avisos`), o banco de auditoria
 * (`banco`, que pode ser dividido entre duas instâncias) e o registro de eventos. `op` troca qualquer peça (tetos, destinos, relógio…).
 * Os tetos próprios de estorno e transferência nascem sem limite (vale o geral); os testes deles passam `tetoEspecifico`.
 */
export function montar(o: Opc = {}, op: Parameters<typeof criarEscritaAsaas>[0] & { banco?: BancoFalso } = {}) {
  const f = asaasFalso(o);
  const relogio = { t: AGORA };
  const avisos: string[] = [];
  const banco = op.banco ?? new BancoFalso();
  /** as intenções (gravadas antes de chamar o Asaas) ficam à parte: `eventos` só tem o que aconteceu */
  const intencoes: Array<{ evento: string; args: Record<string, any> }> = [];
  const { banco: _banco, ...resto } = op;
  void _banco;
  const agoraDe = resto.agora ?? (() => relogio.t);
  // a escrita nasce DESLIGADA em toda unidade: os testes ligam a Serra, e os de "desligada" passam a lista que querem
  const esc = criarEscritaAsaas({
    agora: () => relogio.t,
    unidades: () => new Set(['doutor-hernia-serra']),
    tetoEspecifico: () => ({ operacao: Infinity, dia: Infinity }),
    porteiro: porteiroEmMemoria(banco, agoraDe, (evento, args) => intencoes.push({ evento, args: { ...args, chamadasAteAgora: f.posts().length } })),
    alertar: async (t) => {
      avisos.push(t);
      return true;
    },
    ...resto,
  });
  const asaas = criarContextoAsaas(new Map([[f.conta.slug, f.conta]]));
  const eventos: Array<{ evento: string; args: Record<string, any>; ok: boolean; erro?: string }> = [];
  const registrar = (evento: string, args: Record<string, unknown>, ok: boolean, erro?: string) => {
    eventos.push({ evento, args, ok, erro });
    banco.gravar({ ferramenta: evento, argumentos: args, ok, erro }, agoraDe());
    return true;
  };
  /** quanto já conta para o teto do dia da Serra */
  const usado = async (tipo?: 'cobranca' | 'estorno' | 'transferencia' | 'edicao') =>
    (await esc.porteiro.ler(f.conta.escrita!.chaveGrupo, f.conta.slug, agoraDe())).somaDoDia(agoraDe(), f.conta.fuso ?? 'America/Sao_Paulo', tipo);
  return { f, esc, asaas, ctx: { asaas, esc }, relogio, eventos, intencoes, registrar, avisos, banco, usado };
}
