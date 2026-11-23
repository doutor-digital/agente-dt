/**
 * Pedidos de nota fiscal (emitir ou cancelar) preparados e à espera do ok da pessoa. Mesmo molde do `Pendentes` do Kommo
 * (`kommo-escrita.ts`): código de uso ÚNICO, validade de 15 minutos, e quem confirma é quem preparou. Em memória: o agente roda numa
 * réplica só; reinício = preparar de novo (e isso é seguro: o preparar não grava nada no Asaas).
 *
 * Arquivo à parte, sem importar o resto do Asaas, para o estado da escrita (`asaas-escrita.ts`) poder guardá-lo sem criar volta de import.
 */
import { randomBytes } from 'node:crypto';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';

export const VALIDADE_NOTA_MS = 15 * 60_000;
const MAX_PENDENTES = 200;

export interface PedidoDeNota {
  usuario: string;
  /** slug da clínica */
  unidade: string;
  acao: 'emitir' | 'cancelar';
  /** o resumo que a pessoa viu (para o registro) */
  resumo: unknown;
  /** emitir: o corpo do POST /invoices (sem a referência, que leva o código) */
  corpo?: Record<string, unknown>;
  /** emitir: emitir já (POST …/authorize depois de agendar) em vez de esperar a data */
  emitirAgora?: boolean;
  /** `parcelamento`: a cobrança é parcela (ins_…): a nota do parcelamento inteiro também conta como repetida */
  origem?: { tipo: 'cobranca' | 'cliente'; id: string; parcelamento?: string };
  valor?: number;
  dataEmissao?: string;
  /** emitir: as notas ativas que já existiam na prévia (a pessoa foi avisada); nota NOVA que aparecer depois derruba a confirmação */
  jaExistiam?: string[];
  /** cancelar */
  notaId?: string;
  statusAntes?: string;
}

export class PendentesNota {
  private itens = new Map<string, PedidoDeNota & { criadoEm: number }>();
  constructor(private agora: () => number = Date.now) {}

  guardar(p: PedidoDeNota): { codigo: string; expiraEm: string } {
    for (const [k, v] of this.itens) if (this.agora() - v.criadoEm > VALIDADE_NOTA_MS) this.itens.delete(k);
    if (this.itens.size >= MAX_PENDENTES) throw new ErroDeEntrada('pedidos de nota fiscal demais esperando confirmação: confirme ou espere vencer (15 minutos)');
    const codigo = randomBytes(6).toString('hex').toUpperCase();
    const criadoEm = this.agora();
    this.itens.set(codigo, { ...p, criadoEm });
    return { codigo, expiraEm: new Date(criadoEm + VALIDADE_NOTA_MS).toISOString() };
  }

  /** Tira o pedido (uso ÚNICO). Código de outra pessoa NÃO é gasto: quem preparou ainda pode confirmar. */
  tirar(codigo: string, usuario: string): PedidoDeNota & { criadoEm: number } {
    const chave = codigo.trim().toUpperCase();
    const p = this.itens.get(chave);
    if (!p) throw new ErroDeEntrada('código de confirmação desconhecido ou já usado: prepare a nota de novo');
    if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
    this.itens.delete(chave);
    if (this.agora() - p.criadoEm > VALIDADE_NOTA_MS) throw new ErroDeEntrada('o código venceu (15 minutos): prepare a nota de novo');
    return p;
  }

  get pendentes(): number {
    return this.itens.size;
  }
}
