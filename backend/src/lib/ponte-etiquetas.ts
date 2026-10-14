/**
 * Ponte, fase 3 (14/10/2026) — as ETIQUETAS do cartão pelo painel do WhatsApp Web: ver, pôr e tirar.
 *
 * Decisões do João:
 *   - a SDR só ESCOLHE entre as etiquetas que já existem na conta (decisão A3 da trilha): a Ponte nunca cria
 *     etiqueta nova. Por isso a etiqueta é conferida na lista da conta antes de ir para o cartão — o
 *     `tags_to_add` do Kommo CRIA a etiqueta quando o nome não existe;
 *   - etiqueta que começa com ▶ dispara um Salesbot que MANDA um modelo de WhatsApp para o paciente. Pôr uma
 *     ▶ exige confirmação explícita (o painel pergunta, e o servidor recusa sem `confirmado: true`), e fica uma
 *     nota curta no cartão dizendo quem pôs. Tirar não pede confirmação.
 *
 * ARMADILHA do Kommo: `tags_to_add` / `tags_to_delete` vão na RAIZ do corpo do PATCH /api/v4/leads/{id}. Dentro
 * de `_embedded` o Kommo ignora em silêncio, e `_embedded.tags` SUBSTITUI todas. Quem grava é `addTag` /
 * `removeTag` do `kommo.service.ts`, que já fazem certo. Depois de gravar, o cartão é RELIDO e a lista que volta
 * para o painel é a do Kommo (read-back), não a que a gente acha que ficou.
 */
import { KommoApiError } from '../services/kommo.service.js';
import { CacheDaConta } from './ponte-cache.js';
import { numeroDoAmbiente } from './ponte-fila.js';
import { POR_PADRAO, leadIdDoPedido, textoCurto, type Lido } from './ponte-pausa.js';

/** As etiquetas da conta mudam pouco; a Ponte pede a lista a cada "+ etiqueta". */
export const CACHE_ETIQUETAS_MS = 10 * 60_000;

/**
 * No máximo quantas etiquetas ▶ a Ponte põe por hora numa CONTA do Kommo (janela corrida). Cada ▶ manda uma
 * mensagem de WhatsApp para um paciente: se a chave da unidade vazar, isto segura o estrago. Uma SDR põe
 * poucas por hora; a variável de ambiente muda o número sem mexer no código.
 */
export const TETO_DE_ROBO_POR_HORA = Math.max(1, Math.floor(numeroDoAmbiente(process.env.PONTE_ETIQUETA_ROBO_POR_HORA, 30)));

const HORA_MS = 60 * 60_000;
const robosPostos = new Map<string, number[]>();

/** Ainda cabe uma ▶ nesta conta na última hora? */
export function cabeEtiquetaDeRobo(conta: string, agoraMs = Date.now(), teto = TETO_DE_ROBO_POR_HORA): boolean {
  const recentes = (robosPostos.get(conta) ?? []).filter((t) => agoraMs - t < HORA_MS);
  robosPostos.set(conta, recentes);
  return recentes.length < teto;
}

function contarEtiquetaDeRobo(conta: string, agoraMs = Date.now()): void {
  if (robosPostos.size > 2_000) robosPostos.clear();
  robosPostos.set(conta, [...(robosPostos.get(conta) ?? []).filter((t) => agoraMs - t < HORA_MS), agoraMs]);
}

/**
 * A etiqueta dispara o robô que manda mensagem? As da régua começam com ▶ (U+25B6). O ► (U+25BA) entra junto:
 * na tela os dois parecem iguais, e pedir confirmação a mais é melhor que mandar mensagem sem querer.
 */
export function ehEtiquetaDeRobo(nome: string | null | undefined): boolean {
  return /^\s*[▶►]/.test(String(nome ?? ''));
}

/** Para comparar nomes de etiqueta: sem diferença de maiúscula, espaço ou seletor de emoji. O ▶ continua contando. */
export function chaveDaEtiqueta(nome: string | null | undefined): string {
  return String(nome ?? '')
    .normalize('NFC')
    .replace(/\uFE0F/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

/**
 * O nome EXATO da etiqueta na conta, para o que a atendente escolheu. Igual primeiro; depois sem diferença de
 * maiúscula/espaço, só se houver UMA. `null` = a conta não tem essa etiqueta (e a Ponte não cria).
 */
export function acharNaConta(nome: string, daConta: readonly string[]): string | null {
  if (daConta.includes(nome)) return nome;
  const k = chaveDaEtiqueta(nome);
  if (!k) return null;
  const parecidas = daConta.filter((t) => chaveDaEtiqueta(t) === k);
  return parecidas.length === 1 ? parecidas[0] : null;
}

/** A etiqueta já está no cartão? Devolve o nome como está NO CARTÃO (é esse que o `tags_to_delete` precisa). */
export function etiquetaNoCartao(nome: string, doCartao: readonly string[]): string | null {
  if (doCartao.includes(nome)) return nome;
  const k = chaveDaEtiqueta(nome);
  return doCartao.find((t) => chaveDaEtiqueta(t) === k) ?? null;
}

/** "Etiqueta ▶ Retomada posta pela Ponte · por Ana" — quem pôs uma etiqueta que manda mensagem fica registrado. */
export function notaDaEtiquetaDeRobo(nome: string, por: string | null): string {
  return `Etiqueta ${nome} posta pela Ponte · por ${por || POR_PADRAO}`;
}

export interface PedidoDeEtiqueta {
  leadId: number;
  nome: string;
  por: string | null;
  /** A atendente confirmou que a etiqueta ▶ pode mandar mensagem. */
  confirmado: boolean;
}

/** `POST/DELETE …/ponte/etiquetas` → `{ leadId, nome, por?, confirmado? }`. */
export function lerPedidoDeEtiqueta(corpo: unknown): Lido<PedidoDeEtiqueta> {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  const nome = textoCurto(b.nome, 100);
  if (!nome) return { ok: false, erro: 'etiqueta inválida' };
  return { ok: true, pedido: { leadId, nome, por: textoCurto(b.por, 80), confirmado: b.confirmado === true } };
}

// ── com o Kommo ──

/** O pedaço do `KommoClient` que as etiquetas usam (o teste entra com um falso). */
export interface KommoDasEtiquetas {
  listLeadTags(): Promise<Array<{ name: string }>>;
  getLead(leadId: number): Promise<{ id: number; _embedded?: { tags?: Array<{ name: string }> } }>;
  addTag(p: { leadId: number; tag: string }): Promise<void>;
  removeTag(leadId: number, tag: string): Promise<void>;
  addLeadNote(leadId: number, texto: string): Promise<unknown>;
}

const cacheEtiquetas = new CacheDaConta<string[]>(CACHE_ETIQUETAS_MS);

/** Para o teste começar limpo. */
export function limparCacheDasEtiquetas(): void {
  cacheEtiquetas.limpar();
  robosPostos.clear();
}

/** Os nomes das etiquetas de cartão da conta, sem repetição, em ordem alfabética. Cache de 10 min por conta. */
export function etiquetasDaConta(conta: string, kommo: Pick<KommoDasEtiquetas, 'listLeadTags'>, forcar = false): Promise<string[]> {
  return cacheEtiquetas.obter(
    conta,
    async () => {
      const nomes = (await kommo.listLeadTags()).map((t) => String(t?.name ?? '').trim()).filter(Boolean);
      return [...new Set(nomes)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    },
    forcar,
  );
}

export type ResultadoDaEtiqueta =
  | {
      ok: true;
      leadId: number;
      /** A etiqueta, com o nome exato do Kommo. */
      nome: string;
      robo: boolean;
      /** Falso = já estava (pôr) ou já não estava (tirar): nada foi gravado. */
      mudou: boolean;
      /** As etiquetas do cartão RELIDAS do Kommo depois de gravar. */
      etiquetas: string[];
      /** Só nas ▶: a nota "posta pela Ponte" ficou no cartão? */
      nota?: boolean;
    }
  | { ok: false; status: number; erro: string; precisaConfirmar?: boolean };

const nomesDoCartao = (lead: { _embedded?: { tags?: Array<{ name: string }> } } | null | undefined): string[] =>
  (lead?._embedded?.tags ?? []).map((t) => String(t?.name ?? '').trim()).filter(Boolean);

const naoAchou = (err: unknown) => err instanceof KommoApiError && (err.status === 404 || err.status === 204);

async function lerCartao(kommo: KommoDasEtiquetas, leadId: number) {
  try {
    const lead = await kommo.getLead(leadId);
    return lead && typeof lead === 'object' && lead.id ? lead : null;
  } catch (err) {
    if (naoAchou(err)) return null;
    throw err;
  }
}

/** Põe uma etiqueta QUE JÁ EXISTE na conta. ▶ exige `confirmado` e deixa a nota de quem pôs. */
export async function porEtiqueta(conta: string, kommo: KommoDasEtiquetas, pedido: PedidoDeEtiqueta): Promise<ResultadoDaEtiqueta> {
  let nome = acharNaConta(pedido.nome, await etiquetasDaConta(conta, kommo));
  // criada no Kommo nos últimos 10 min? relê a lista uma vez antes de recusar
  if (!nome) nome = acharNaConta(pedido.nome, await etiquetasDaConta(conta, kommo, true));
  if (!nome) {
    return { ok: false, status: 422, erro: 'essa etiqueta não existe no Kommo: a Ponte só põe etiquetas que já existem na conta' };
  }
  const robo = ehEtiquetaDeRobo(nome);
  if (robo && !pedido.confirmado) {
    return { ok: false, status: 409, erro: 'esta etiqueta faz o robô mandar uma mensagem para o paciente: confirme antes', precisaConfirmar: true };
  }
  if (robo && !cabeEtiquetaDeRobo(conta)) {
    return { ok: false, status: 429, erro: `a Ponte já pôs ${TETO_DE_ROBO_POR_HORA} etiquetas ▶ nesta conta na última hora: ponha esta pelo Kommo ou espere` };
  }

  const lead = await lerCartao(kommo, pedido.leadId);
  if (!lead) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };
  const antes = nomesDoCartao(lead);
  // já está: não grava de novo (e uma ▶ que já estava não ganha nota de "posta agora")
  if (etiquetaNoCartao(nome, antes)) return { ok: true, leadId: pedido.leadId, nome, robo, mudou: false, etiquetas: antes };

  await kommo.addTag({ leadId: pedido.leadId, tag: nome });
  if (robo) contarEtiquetaDeRobo(conta);
  const relido = await lerCartao(kommo, pedido.leadId).catch(() => null);
  const depois = relido ? nomesDoCartao(relido) : null;
  if (depois && !etiquetaNoCartao(nome, depois)) {
    return { ok: false, status: 502, erro: 'o Kommo aceitou, mas a etiqueta não aparece no cartão: confira no Kommo' };
  }
  let nota: boolean | undefined;
  if (robo) {
    nota = await kommo.addLeadNote(pedido.leadId, notaDaEtiquetaDeRobo(nome, pedido.por)).then(
      () => true,
      () => false,
    );
  }
  return { ok: true, leadId: pedido.leadId, nome, robo, mudou: true, etiquetas: depois ?? [...antes, nome], ...(robo ? { nota } : {}) };
}

/** Tira a etiqueta do cartão. Não pede confirmação e não precisa existir na conta (só no cartão). */
export async function tirarEtiqueta(kommo: KommoDasEtiquetas, pedido: PedidoDeEtiqueta): Promise<ResultadoDaEtiqueta> {
  const lead = await lerCartao(kommo, pedido.leadId);
  if (!lead) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };
  const antes = nomesDoCartao(lead);
  const noCartao = etiquetaNoCartao(pedido.nome, antes);
  if (!noCartao) {
    return { ok: true, leadId: pedido.leadId, nome: pedido.nome, robo: ehEtiquetaDeRobo(pedido.nome), mudou: false, etiquetas: antes };
  }
  await kommo.removeTag(pedido.leadId, noCartao);
  const relido = await lerCartao(kommo, pedido.leadId).catch(() => null);
  const depois = relido ? nomesDoCartao(relido) : null;
  if (depois && depois.includes(noCartao)) {
    return { ok: false, status: 502, erro: 'o Kommo aceitou, mas a etiqueta continua no cartão: confira no Kommo' };
  }
  return { ok: true, leadId: pedido.leadId, nome: noCartao, robo: ehEtiquetaDeRobo(noCartao), mudou: true, etiquetas: depois ?? antes.filter((t) => t !== noCartao) };
}
