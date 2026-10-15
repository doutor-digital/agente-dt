/**
 * Ponte 0.5.1 — "Observações" (pedido do João, 15/10/2026: "vamos colocar o campo de observações").
 *
 * A atendente escreve no painel do WhatsApp Web e o texto vira uma NOTA comum no cartão do Kommo (a nota de texto do
 * lead, `note_type: common`), com o prefixo "Observação pela Ponte · Ana · 15/10/2026 15:42:" e o texto embaixo. A
 * hora é a de Brasília, carimbada AQUI (o relógio do computador da atendente não vale).
 *
 * As regras:
 *   - o texto não pode ser vazio, passar de `MAX_OBSERVACAO` letras nem ter HTML (uma tag de HTML de verdade ou um
 *     comentário — "<L4 e L5>" e "dor < 5" passam): o pedido volta 400, e nada vai para o Kommo. Quebras de linha
 *     ficam; o resto do controle sai (`limparObservacao`, a mesma conta da extensão, para a prévia ser o que grava);
 *   - o cartão tem de ser DESTA conta: ele é lido com o token da unidade da chave (como nas etiquetas e na ligação) —
 *     cartão de outra conta, ou apagado, não aparece (404) e nada é gravado;
 *   - UMA nota por observação: o mesmo texto no mesmo cartão em menos de `JANELA_DE_REPETICAO_MS` (clique duplo, ou a
 *     resposta que se perdeu e a atendente clicou de novo) devolve a nota da primeira vez, sem gravar outra;
 *   - não dá para saber se gravou (o Kommo não respondeu a tempo, respondeu 5xx, ou disse OK sem o id da nota): erro
 *     `incerto`, dizendo para conferir no cartão ANTES de tentar de novo — e a vaga da "uma nota por observação"
 *     CONTINUA reservada pela janela (o clique de novo não grava a segunda). Só a recusa clara (o Kommo respondeu 4xx,
 *     ou o cartão não foi lido) libera a vaga.
 *
 * Nunca escreve no WhatsApp. Log sem dado de paciente: id do cartão, id da nota e o tamanho do texto, nunca o texto.
 */
import { KommoApiError } from '../services/kommo.service.js';
import { POR_PADRAO, leadIdDoPedido, textoCurto, type Lido } from './ponte-pausa.js';

/** No máximo quantas letras uma observação tem (a caixa do painel tem o mesmo limite). */
export const MAX_OBSERVACAO = 2000;

/** O começo de toda nota de observação: quem procura no histórico do Kommo acha por ele. */
export const PREFIXO_DA_OBSERVACAO = 'Observação pela Ponte';

/** O mesmo texto no mesmo cartão dentro desta janela é a MESMA observação (não grava de novo). */
export const JANELA_DE_REPETICAO_MS = 2 * 60_000;

const FUSO_DE_BRASILIA = 'America/Sao_Paulo';

export interface PedidoDeNota {
  leadId: number;
  /** Já limpo (`limparObservacao`). */
  texto: string;
  por: string | null;
}

/**
 * As tags de HTML que contam (as de texto, as de mídia e as perigosas). Só elas: "<L4 e L5>" e "<alta>" são texto da
 * atendente, não HTML. A extensão usa a mesma lista (`desenho.js`, `problemaDaObservacao`).
 */
export const TAGS_DE_HTML =
  'a|abbr|audio|b|big|blockquote|body|br|button|center|code|del|div|em|embed|font|form|h[1-6]|head|hr|html|i|iframe|img|input|ins|label|li|link|mark|meta|object|ol|option|p|pre|s|script|select|small|source|span|strike|strong|style|sub|sup|svg|table|tbody|td|textarea|th|thead|title|tr|u|ul|video';

const TAG_DE_HTML = new RegExp(`<\\/?(?:${TAGS_DE_HTML})(?:\\s[^<>]*)?\\/?>`, 'i');

/** Tem HTML? Uma tag de verdade (`<b>`, `</p>`, `<img src=x>`, `<br/>`) ou um comentário (`<!--`). */
export function temHtml(texto: string): boolean {
  return TAG_DE_HTML.test(texto) || /<!--/.test(texto);
}

/**
 * O texto da observação como vai para o Kommo: as quebras de linha ficam (`\r\n` vira `\n`, no máximo uma linha em
 * branco seguida); tab vira espaço; o resto do controle sai; espaço no fim da linha e nas pontas sai.
 */
export function limparObservacao(bruto: string): string {
  return bruto
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `POST …/ponte/nota` → `{ leadId, texto, por? }`. */
export function lerPedidoDeNota(corpo: unknown): Lido<PedidoDeNota> {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  if (typeof b.texto !== 'string') return { ok: false, erro: 'escreva a observação' };
  const texto = limparObservacao(b.texto);
  if (!texto) return { ok: false, erro: 'escreva a observação' };
  if (texto.length > MAX_OBSERVACAO) return { ok: false, erro: `a observação passa de ${MAX_OBSERVACAO} letras: encurte e tente de novo` };
  if (temHtml(texto)) return { ok: false, erro: 'a observação não pode ter HTML (tags como <b> ou <br>)' };
  // o nome de quem escreveu entra na nota: sem < >, para nunca virar tag
  const por = textoCurto(typeof b.por === 'string' ? b.por.replace(/[<>]/g, '') : b.por, 80);
  return { ok: true, pedido: { leadId, texto, por } };
}

/** "15/10/2026 15:42" no horário de Brasília. */
export function dataHoraDeBrasilia(agora: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: FUSO_DE_BRASILIA,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(agora)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** "Observação pela Ponte · Ana · 15/10/2026 15:42:" e, na linha de baixo, o texto da atendente. */
export function textoDaNota(pedido: Pick<PedidoDeNota, 'texto' | 'por'>, agora: Date): string {
  return `${PREFIXO_DA_OBSERVACAO} · ${pedido.por || POR_PADRAO} · ${dataHoraDeBrasilia(agora)}:\n${pedido.texto}`;
}

// ── com o Kommo ──

/** O pedaço do `KommoClient` que a observação usa (o teste entra com um falso). */
export interface KommoDaNota {
  getLead(leadId: number): Promise<{ id: number } | null | undefined>;
  addLeadNote(leadId: number, texto: string): Promise<{ id?: number } | null>;
}

export type ResultadoDaNota =
  | { ok: true; leadId: number; notaId: number; repetido?: boolean }
  /** `incerto`: pode ter gravado — a vaga da janela continua reservada (o clique de novo não grava outra). */
  | { ok: false; status: number; erro: string; incerto?: boolean };

const INCERTO = 'não sei se a observação foi gravada (o Kommo não confirmou): confira no histórico do cartão antes de tentar de novo';

const naoAchou = (err: unknown) => err instanceof KommoApiError && (err.status === 404 || err.status === 204);

/** Lê o cartão com o token DESTA unidade e grava a nota. Sem a releitura não há escrita. */
export async function gravarObservacao(kommo: KommoDaNota, pedido: PedidoDeNota, agora: Date = new Date()): Promise<ResultadoDaNota> {
  let lead: { id: number } | null | undefined;
  try {
    lead = await kommo.getLead(pedido.leadId);
  } catch (err) {
    if (!naoAchou(err)) throw err;
    lead = null;
  }
  // outra conta (o token desta unidade não vê) ou cartão apagado: nada é gravado
  if (!lead || typeof lead !== 'object' || lead.id !== pedido.leadId) {
    return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo desta unidade' };
  }
  let r: { id?: number } | null;
  try {
    r = await kommo.addLeadNote(pedido.leadId, textoDaNota(pedido, agora));
  } catch (err) {
    // o Kommo RESPONDEU com recusa (4xx): nada gravado. Sem resposta (tempo esgotado) ou 5xx: pode ter gravado
    const status = err instanceof KommoApiError ? err.status : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { ok: false, status: 502, erro: 'o Kommo recusou a nota agora: tente de novo' };
    }
    return { ok: false, status: 502, erro: INCERTO, incerto: true };
  }
  const notaId = r && typeof r === 'object' && typeof r.id === 'number' && r.id > 0 ? r.id : null;
  // disse OK sem o id: provavelmente gravou — não deixa gravar a segunda
  if (!notaId) return { ok: false, status: 502, erro: INCERTO, incerto: true };
  return { ok: true, leadId: pedido.leadId, notaId };
}

const recentes = new Map<string, { em: number; p: Promise<ResultadoDaNota> }>();

/** Para o teste começar limpo. */
export function limparObservacoesRecentes(): void {
  recentes.clear();
}

/**
 * `gravarObservacao`, uma vez só por observação: a mesma (conta, cartão, texto) dentro de `JANELA_DE_REPETICAO_MS`
 * espera a primeira e devolve a nota dela (`repetido: true`). A vaga é reservada ANTES do primeiro `await`, então dois
 * pedidos juntos também viram uma nota só. Recusa clara (nada gravado) libera a vaga e a próxima tenta de verdade; o
 * resultado INCERTO (pode ter gravado) segura a vaga até o fim da janela e devolve o mesmo aviso.
 */
export async function gravarObservacaoUmaVez(
  conta: string,
  kommo: KommoDaNota,
  pedido: PedidoDeNota,
  agora: Date = new Date(),
): Promise<ResultadoDaNota> {
  const agoraMs = agora.getTime();
  for (const [k, v] of recentes) if (agoraMs - v.em > JANELA_DE_REPETICAO_MS) recentes.delete(k);
  const chave = `${conta}|${pedido.leadId}|${pedido.texto}`;
  const ja = recentes.get(chave);
  if (ja) {
    const r = await ja.p;
    return r.ok ? { ...r, repetido: true } : r;
  }
  if (recentes.size > 2_000) recentes.clear();
  const p = gravarObservacao(kommo, pedido, agora);
  recentes.set(chave, { em: agoraMs, p });
  try {
    const r = await p;
    if (!r.ok && !r.incerto) recentes.delete(chave);
    return r;
  } catch (err) {
    recentes.delete(chave);
    throw err;
  }
}
