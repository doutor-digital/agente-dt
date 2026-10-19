/**
 * Nova tentativa quando a CONEXÃO com o Kommo cai — não quando o Kommo responde erro.
 *
 * Medido em 19/10/2026: ~190 "socket hang up"/timeout por dia só no franquia-sync, e os mesmos nos
 * outros robôs (parados, preenche-campos, franquia-move). O robô só tentava de novo na varredura seguinte
 * (15 min depois) e o cartão ficava atrasado; um cartão da Açailândia (10850692) falhou dias seguidos.
 * O Node reaproveita a conexão aberta (keep-alive) e, quando o Kommo já a fechou do lado dele, a próxima
 * requisição morre com "socket hang up" sem nunca ter sido processada — repetir na hora resolve.
 *
 * SÓ método que pode ser repetido sem efeito colateral: ler (GET) e gravar o mesmo valor de novo
 * (PATCH/PUT/DELETE). POST fica de fora — criar nota, tarefa ou disparar Salesbot duas vezes duplica
 * (o disparo do Salesbot tem a própria retentativa, que confere a conversa antes: `reenvio-salesbot.ts`).
 */

const LEITURAS = new Set(['get', 'head', 'options']);
const GRAVACOES_REPETIVEIS = new Set(['patch', 'put', 'delete']);

/** Espera antes de cada nova tentativa, em ms. Duas bastam para o soluço; mais que isso é o Kommo fora do ar. */
export const ESPERAS_REDE_MS = [400, 1500];

export interface FalhaHttp {
  method?: string;
  /** status HTTP — presente quando o Kommo RESPONDEU. Aí não é queda de rede. */
  status?: number;
  code?: string;
  message?: string;
}

/** A conexão caiu sem resposta (hang up, reset, timeout) — o tipo de falha que repetir conserta. */
export function ehQuedaDeRede(f: FalhaHttp): boolean {
  if (typeof f.status === 'number') return false;
  const sinal = `${f.code ?? ''} ${f.message ?? ''}`.toLowerCase();
  return /socket hang up|econnreset|epipe|etimedout|econnaborted|timeout|aborted|eai_again/.test(sinal);
}

/**
 * A conexão foi recusada/cortada ANTES de o Kommo processar (keep-alive velho, reset). Timeout não entra:
 * no timeout o Kommo pode ter gravado e só a resposta se perdeu.
 */
function conexaoCortada(f: FalhaHttp): boolean {
  if (typeof f.status === 'number') return false;
  const sinal = `${f.code ?? ''} ${f.message ?? ''}`.toLowerCase();
  if (/timeout|etimedout|econnaborted/.test(sinal)) return false;
  return /socket hang up|econnreset|epipe|eai_again/.test(sinal);
}

/**
 * Repete? No máximo `ESPERAS_REDE_MS.length` vezes, e:
 *  - leitura (GET): em qualquer queda de rede, timeout incluído;
 *  - gravação (PATCH/PUT/DELETE): só quando a conexão caiu antes de o Kommo processar. Num timeout de PATCH o
 *    valor pode já ter entrado — e no campo "Resposta IA" regravar dispararia a mensagem de novo;
 *  - POST: nunca.
 */
export function repetirNaRede(f: FalhaHttp, tentativasFeitas: number): boolean {
  if (tentativasFeitas >= ESPERAS_REDE_MS.length) return false;
  const metodo = String(f.method ?? '').toLowerCase();
  if (LEITURAS.has(metodo)) return ehQuedaDeRede(f);
  if (GRAVACOES_REPETIVEIS.has(metodo)) return conexaoCortada(f);
  return false;
}
