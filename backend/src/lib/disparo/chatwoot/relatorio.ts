/**
 * O RELATÓRIO de um disparo pelo CRM — puro (sem banco nem rede): enviadas, entregues, lidas, responderam (até 72 h depois do envio),
 * pediram para sair e falharam. Os números vêm do que a varredura gravou em cada destinatário (`rodada.ts`): o CRM só diz «entregue»/«lida»
 * enquanto a mensagem está na conversa, e a hora que fica é a em que a varredura VIU, não a da Meta.
 *
 * Definições (uma pessoa cai em um só balde de «o que aconteceu»; entregue/lida/respondeu são marcas, que se somam):
 *  - selecionadas: quem está na lista do disparo;
 *  - enviadas: o CRM aceitou a mensagem (tem o id dela, `cw:<id>`), mesmo que a entrega tenha falhado depois;
 *  - entregues / lidas: o CRM marcou a mensagem como entregue / lida (lida implica entregue);
 *  - responderam: escreveram depois do envio, em até 72 h, SEM pedir para sair (quem pediu SAIR conta só em «pediram para sair»);
 *  - pediram para sair: receberam e responderam SAIR;
 *  - falharam: o CRM recusou o envio, o envio ficou incerto, ou a entrega falhou depois de aceita.
 */
import { idDaMensagem } from './mensagens.js';

export const JANELA_DA_RESPOSTA_MS = 72 * 3_600_000;

export interface LinhaDoRelatorio {
  estado: string;
  wamid: string | null;
  enviadoEm: Date | null;
  simuladoEm: Date | null;
  entregueEm: Date | null;
  lidaEm: Date | null;
  respondeuEm: Date | null;
}

export interface NumerosDoRelatorio {
  selecionadas: number;
  enviadas: number;
  /** quem o motor TENTOU: as enviadas + as que falharam sem o CRM aceitar (a base da taxa de falha; cada pessoa conta uma vez) */
  tentadas: number;
  entregues: number;
  lidas: number;
  responderam: number;
  pediramSair: number;
  falharam: number;
  /** ainda na fila (inclui quem está sendo enviado agora) */
  naFila: number;
  /** barradas na hora do envio (conversa mudou, franquia, interno…) */
  descartadas: number;
  /** modo seco: quantas têm o «receberia» gravado (não é envio) */
  receberiam: number;
}

const foiAceita = (l: Pick<LinhaDoRelatorio, 'wamid'>): boolean => idDaMensagem(l.wamid) !== null;

export function numerosDoRelatorio(linhas: readonly LinhaDoRelatorio[]): NumerosDoRelatorio {
  const n: NumerosDoRelatorio = { selecionadas: linhas.length, enviadas: 0, tentadas: 0, entregues: 0, lidas: 0, responderam: 0, pediramSair: 0, falharam: 0, naFila: 0, descartadas: 0, receberiam: 0 };
  for (const l of linhas) {
    if (foiAceita(l)) {
      n.enviadas++;
      n.tentadas++;
      if (l.entregueEm || l.lidaEm) n.entregues++;
      if (l.lidaEm) n.lidas++;
    }
    if (l.estado === 'saiu' && l.enviadoEm) n.pediramSair++;
    else if (l.respondeuEm && l.enviadoEm && l.respondeuEm >= l.enviadoEm && l.respondeuEm.getTime() - l.enviadoEm.getTime() <= JANELA_DA_RESPOSTA_MS) n.responderam++;
    if (l.estado === 'falhou') {
      n.falharam++;
      if (!foiAceita(l)) n.tentadas++; // a que falhou DEPOIS de aceita já está em «enviadas»
    } else if (l.estado === 'pendente' || l.estado === 'enviando') n.naFila++;
    else if (l.estado === 'descartado' || (l.estado === 'saiu' && !l.enviadoEm)) n.descartadas++;
    if (l.simuladoEm) n.receberiam++;
  }
  return n;
}

/** Percentual inteiro (0–100) de `parte` sobre `todo`; `null` quando não há base (nada enviado). */
export const percentual = (parte: number, todo: number): number | null => (todo > 0 ? Math.round((parte / todo) * 100) : null);

export interface TaxasDoRelatorio {
  entregues: number | null;
  lidas: number | null;
  responderam: number | null;
  pediramSair: number | null;
  falharam: number | null;
}

/** Sobre as ENVIADAS (que o CRM aceitou); a falha, sobre as TENTADAS (cada pessoa uma vez). */
export function taxasDoRelatorio(n: NumerosDoRelatorio): TaxasDoRelatorio {
  return {
    entregues: percentual(n.entregues, n.enviadas),
    lidas: percentual(n.lidas, n.enviadas),
    responderam: percentual(n.responderam, n.enviadas),
    pediramSair: percentual(n.pediramSair, n.enviadas),
    falharam: percentual(n.falharam, n.tentadas),
  };
}

/** Envios por hora cheia no fuso informado (AAAA-MM-DD HH), do mais antigo para o mais novo. Só o que o CRM aceitou. */
export function enviosPorHora(linhas: readonly Pick<LinhaDoRelatorio, 'wamid' | 'enviadoEm'>[], fuso: string): Array<{ hora: string; enviadas: number }> {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const por = new Map<string, number>();
  for (const l of linhas) {
    if (!foiAceita(l) || !l.enviadoEm) continue;
    const hora = f.format(l.enviadoEm).replace(/:\d+$/, '').slice(0, 13);
    por.set(hora, (por.get(hora) ?? 0) + 1);
  }
  return [...por].sort((a, b) => a[0].localeCompare(b[0])).map(([hora, enviadas]) => ({ hora, enviadas }));
}
