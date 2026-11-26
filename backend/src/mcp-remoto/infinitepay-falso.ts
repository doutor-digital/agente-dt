/** O armazém dos links em memória, com o mesmo contrato do de produção (trava → ler → conferir → gravar a intenção). Só para testes. */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { LinkGuardado } from './infinitepay.js';
import { LivroDeLinks, type ArmazemDeEscrita, type EventoDoLink, type PedidoDeReserva, type ResultadoDaCriacao } from './infinitepay-escrita.js';

interface Linha extends LinkGuardado {
  chave: string | null;
  criadoEmMs: number;
}

export function armazemEmMemoria(inicial: Array<Partial<LinkGuardado> & { orderNsu: string; unidade: string; valorCentavos: number; criadoEmMs?: number; chave?: string }> = []): ArmazemDeEscrita & { linhas: Linha[] } {
  const linhas: Linha[] = inicial.map((l) => ({
    status: 'criado', url: `https://checkout.infinitepay.io/${l.orderNsu}`, descricao: 'x', validoAte: null, criadoPor: 'u', criadoEm: new Date(l.criadoEmMs ?? 0).toISOString(),
    invoiceSlug: null, transactionNsu: null, formaPagamento: null, parcelas: null, valorPagoCentavos: null, reciboUrl: null, pagoEm: null, liquidadoEm: null, ultimoEvento: null, erro: null,
    chave: l.chave ?? null, criadoEmMs: l.criadoEmMs ?? 0, ...l,
  }));
  // uma reserva por vez, como a trava do banco
  let fila: Promise<unknown> = Promise.resolve();
  const livro = (unidade: string) =>
    new LivroDeLinks(linhas.filter((l) => l.unidade === unidade).map((l) => ({ valorCentavos: l.valorCentavos, status: l.status, em: l.criadoEmMs, chave: l.chave, orderNsu: l.orderNsu, url: l.url })));
  return {
    linhas,
    async listar(f) {
      return linhas.filter((l) => l.unidade === f.unidade && (!f.status || l.status === f.status) && (!f.orderNsu || l.orderNsu === f.orderNsu)).slice(0, f.limite);
    },
    async porOrderNsu(unidade, orderNsu) {
      const l = linhas.find((x) => x.unidade === unidade && x.orderNsu === orderNsu);
      return l ? { ...l } : null;
    },
    async ler(unidade) {
      return livro(unidade);
    },
    reservar(p: PedidoDeReserva) {
      const feita = fila.then(() => {
        const existente = linhas.find((l) => l.unidade === p.unidade && l.orderNsu === p.orderNsu);
        // referência de link RECUSADO (falhou) é reaproveitada, como no banco; qualquer outra já existe
        if (existente && existente.status !== 'falhou') throw new ErroDeEntrada(`a referência ${p.orderNsu} já foi usada nesta unidade.`);
        p.conferir(livro(p.unidade));
        if (existente) linhas.splice(linhas.indexOf(existente), 1);
        linhas.push({
          orderNsu: p.orderNsu, unidade: p.unidade, status: 'intencao', url: null, valorCentavos: p.valorCentavos, descricao: p.descricao, validoAte: p.validoAte.toISOString(),
          criadoPor: p.criadoPor, criadoEm: new Date(p.agora).toISOString(), invoiceSlug: null, transactionNsu: null, formaPagamento: null, parcelas: null, valorPagoCentavos: null,
          reciboUrl: null, pagoEm: null, liquidadoEm: null, ultimoEvento: null, erro: null, chave: p.chave, criadoEmMs: p.agora,
        });
      });
      fila = feita.catch(() => undefined);
      return feita;
    },
    async resolver(unidade, orderNsu, r: ResultadoDaCriacao) {
      const l = linhas.find((x) => x.unidade === unidade && x.orderNsu === orderNsu && x.status === 'intencao');
      if (!l) return;
      l.status = r.status;
      if (r.status === 'criado') {
        l.url = r.url;
        l.erro = null;
        if (r.invoiceSlug) l.invoiceSlug = r.invoiceSlug;
      } else l.erro = r.erro;
    },
    async aplicarEvento(unidade, orderNsu, e: EventoDoLink) {
      const l = linhas.find((x) => x.unidade === unidade && x.orderNsu === orderNsu);
      if (!l) return { mudou: false, atual: null };
      let mudou = false;
      if (e.paraStatus && (!e.deStatus || e.deStatus.includes(l.status))) {
        l.status = e.paraStatus;
        if (e.paraStatus === 'pago') l.pagoEm = '2026-11-26T12:00:00.000Z';
        const p = e.pagamento ?? {};
        if (p.invoiceSlug) l.invoiceSlug = p.invoiceSlug;
        if (p.transactionNsu) l.transactionNsu = p.transactionNsu;
        if (p.forma) l.formaPagamento = p.forma;
        if (p.parcelas !== undefined) l.parcelas = p.parcelas;
        if (p.valorPagoCentavos !== undefined) l.valorPagoCentavos = p.valorPagoCentavos;
        if (p.reciboUrl) l.reciboUrl = p.reciboUrl;
        mudou = true;
      } else if (!e.paraStatus && e.liquidado && l.status === 'pago' && !l.liquidadoEm) {
        l.liquidadoEm = '2026-11-26T12:10:00.000Z';
        mudou = true;
      }
      l.ultimoEvento = e.evento;
      return { mudou, atual: { ...l } };
    },
  };
}
