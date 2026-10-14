/**
 * A última porta antes de ESCREVER na franquia (14/10/2026, regra do João: "toda escrita na franquia segue a
 * unidade do cartão — cadastrar lead de Petrópolis em Caxias, ou o contrário, dá BO").
 *
 * Quando duas unidades dividem um Kommo (Petrópolis e Caxias, ver `crm-compartilhado.ts`), escrever com o token
 * de uma delas só é certo depois de alguém olhar o campo «⌂ Unidade de atendimento» do cartão. Quem olhou marca a
 * unidade com `escritaConferida: true` (`unidadeDoCartao` faz isso). Tudo o que escreve SEM essa marca — a Sofia,
 * a confirmação de véspera, o espelho de leads, qualquer caminho novo que alguém esquecer de rotear — é recusado
 * aqui, com uma frase que diz o que fazer. Errar para o lado de não escrever é o lado barato: a SDR marca pelo
 * widget; um paciente no prontuário da clínica errada ninguém desfaz.
 *
 * Unidade que não divide Kommo com ninguém não passa por nada disto: a lista de tokens protegidos fica vazia e a
 * porta devolve `null` sem nem esperar o banco.
 *
 * Sem dependência de propósito (nem Prisma, nem logger): o `spine.service` importa este arquivo, e os testes de
 * contrato da franquia sobem sem banco. Quem carrega a lista é `crm-compartilhado.ts`, que se registra no boot.
 */
import { createHash } from 'node:crypto';

export const MOTIVO_ESCRITA_SEM_CARTAO =
  'Esta conta do Kommo atende duas unidades (cada uma com a sua franquia) e esta escrita não conferiu a ⌂ Unidade de atendimento do cartão. ' +
  'Nada foi gravado na franquia: marque pelo widget do cartão, com a unidade escolhida.';

/** Impressão curta do token: a lista guarda isto, nunca o token. */
export function impressaoDoToken(token: string | null | undefined): string | null {
  const t = (token ?? '').trim();
  if (!t) return null;
  return createHash('sha256').update(t).digest('hex').slice(0, 24);
}

let protegidos = new Set<string>();
let carregador: (() => Promise<void>) | null = null;
let primeiraCarga: Promise<void> | null = null;
let atualizadaEm = 0;
/** Mesma validade das automações: a lista nova vale em até 30 s depois de gravada no banco. */
const VALIDADE_MS = 30_000;

/** Troca a lista inteira (quem chama é o carregador, a cada releitura do banco). */
export function definirTokensProtegidos(tokens: Iterable<string | null | undefined>): void {
  const novo = new Set<string>();
  for (const t of tokens) {
    const i = impressaoDoToken(t);
    if (i) novo.add(i);
  }
  protegidos = novo;
  atualizadaEm = Date.now();
}

/** Registrado no boot por `crm-compartilhado.ts`. Sem carregador (testes, scripts), a lista fica como está. */
export function definirCarregadorDaTrava(fn: (() => Promise<void>) | null): void {
  carregador = fn;
  primeiraCarga = null;
}

async function garantirPrimeiraCarga(): Promise<void> {
  if (!carregador) return;
  primeiraCarga ??= carregador().catch(() => {
    // falhou: tenta de novo na próxima escrita em vez de ficar para sempre com a lista vazia
    primeiraCarga = null;
  });
  await primeiraCarga;
}

/**
 * `null` = pode escrever. Texto = recusa (vai direto para quem pediu: SDR no widget, IA na ferramenta).
 * Só olha o token: a unidade que divide Kommo tem o token na lista; a marca `escritaConferida` é o salvo-conduto.
 */
export async function motivoParaNaoEscrever(unit: { spineToken?: string | null; escritaConferida?: boolean }): Promise<string | null> {
  if (unit.escritaConferida === true) return null;
  const i = impressaoDoToken(unit.spineToken);
  if (!i) return null;
  await garantirPrimeiraCarga();
  // vencida: relê em segundo plano (quem carrega já evita leitura em dobro); esta escrita usa a lista atual
  if (carregador && Date.now() - atualizadaEm > VALIDADE_MS) void carregador().catch(() => undefined);
  return protegidos.has(i) ? MOTIVO_ESCRITA_SEM_CARTAO : null;
}

/** Só para teste. */
export function _zerarTravaParaTeste(): void {
  protegidos = new Set();
  carregador = null;
  primeiraCarga = null;
  atualizadaEm = 0;
}
