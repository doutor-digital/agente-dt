/**
 * Ponte, fase 3 (14/10/2026) — as ETIQUETAS do cartão pelo painel do WhatsApp Web: ver, pôr e tirar.
 *
 * Decisões do João:
 *   - a SDR só ESCOLHE entre as etiquetas que já existem na conta (decisão A3 da trilha): a Ponte nunca cria
 *     etiqueta nova. Por isso a etiqueta é conferida na lista da conta antes de ir para o cartão — o
 *     `tags_to_add` do Kommo CRIA a etiqueta quando o nome não existe;
 *   - etiqueta "de robô" dispara um Salesbot que MANDA um modelo de WhatsApp para o paciente. São as que começam
 *     com ▶ e as da lista `ETIQUETAS_DE_ROBO_SEM_SETA` (+ variáveis de ambiente) — "Aderência meio" também dispara
 *     bot e não tem ▶. Pôr uma delas exige confirmação explícita (o painel pergunta, e o servidor recusa sem
 *     `confirmado: true`), fica uma nota curta no cartão dizendo quem pôs, e há um teto por hora na conta. Tirar
 *     não pede confirmação.
 *
 * Por que lista e não "ler os gatilhos do Kommo": os gatilhos de bot só saem pela rota `/ajax/v4/triggers/bots`,
 * que pede o cookie de sessão de um usuário (o token da API, que o servidor tem, não lê). Na dúvida, a regra pede
 * confirmação a mais, nunca a menos.
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

/** Ainda cabe uma etiqueta de robô nesta conta na última hora? (só olha; quem reserva é `reservarVagaDeRobo`) */
export function cabeEtiquetaDeRobo(conta: string, agoraMs = Date.now(), teto = TETO_DE_ROBO_POR_HORA): boolean {
  const recentes = (robosPostos.get(conta) ?? []).filter((t) => agoraMs - t < HORA_MS);
  robosPostos.set(conta, recentes);
  return recentes.length < teto;
}

/**
 * Confere o teto e RESERVA a vaga no mesmo passo, sem `await` no meio: dez pedidos chegando juntos não passam de
 * `teto`. Devolve `null` quando não cabe. Se a etiqueta não for gravada, quem reservou chama `devolver()`.
 */
export function reservarVagaDeRobo(conta: string, teto = TETO_DE_ROBO_POR_HORA, agoraMs = Date.now()): { devolver(): void } | null {
  if (!cabeEtiquetaDeRobo(conta, agoraMs, teto)) return null;
  if (robosPostos.size > 2_000) robosPostos.clear();
  const marca = agoraMs;
  robosPostos.set(conta, [...(robosPostos.get(conta) ?? []), marca]);
  let devolvida = false;
  return {
    devolver() {
      if (devolvida) return;
      devolvida = true;
      const l = robosPostos.get(conta) ?? [];
      const i = l.indexOf(marca);
      if (i >= 0) l.splice(i, 1);
    },
  };
}

/**
 * Etiquetas que disparam robô e NÃO começam com ▶. Conferido nos gatilhos de 07/10/2026: "Aderência meio" →
 * BOT_…_sessao_aderencia_meio (modelo de WhatsApp) em Açailândia (gatilho 38090178), Serra (37904719) e
 * Imperatriz (37390543). Etiqueta nova assim: acrescente aqui ou nas variáveis de ambiente.
 */
export const ETIQUETAS_DE_ROBO_SEM_SETA: readonly string[] = Object.freeze(['Aderência meio']);

/** Para comparar com a lista: além de `chaveDaEtiqueta`, sem acento ("ADERENCIA MEIO" = "Aderência meio"). */
function chaveSemAcento(nome: string | null | undefined): string {
  return chaveDaEtiqueta(nome).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const daVariavel = (v: string | undefined) => String(v ?? '').split(/[;,\n]/).map((t) => t.trim()).filter(Boolean);

/**
 * A lista de etiquetas de robô (sem ▶) que vale para a unidade: a fixa, mais `PONTE_ETIQUETAS_DE_ROBO` (todas as
 * unidades) e `PONTE_ETIQUETAS_DE_ROBO_<SLUG>` (só esta; slug em maiúsculas com "_" no lugar de "-"), separadas
 * por ";" ou ",".
 */
export function etiquetasDeRoboDaUnidade(slug: string, ambiente: Record<string, string | undefined> = process.env): string[] {
  const daUnidade = `PONTE_ETIQUETAS_DE_ROBO_${String(slug).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return [...new Set([...ETIQUETAS_DE_ROBO_SEM_SETA, ...daVariavel(ambiente.PONTE_ETIQUETAS_DE_ROBO), ...daVariavel(ambiente[daUnidade])])];
}

/**
 * A etiqueta dispara o robô que manda mensagem? As da régua começam com ▶ (U+25B6); o ► (U+25BA) entra junto (na
 * tela parecem iguais). E as da `lista` (as sem ▶, como "Aderência meio"). Pedir confirmação a mais é melhor que
 * mandar mensagem sem querer.
 */
export function ehEtiquetaDeRobo(nome: string | null | undefined, lista: readonly string[] = ETIQUETAS_DE_ROBO_SEM_SETA): boolean {
  if (/^\s*[▶►]/.test(String(nome ?? ''))) return true;
  const k = chaveSemAcento(nome);
  return !!k && lista.some((t) => chaveSemAcento(t) === k);
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

export interface OpcoesDaEtiqueta {
  /** As etiquetas de robô sem ▶ desta unidade (`etiquetasDeRoboDaUnidade`). */
  robos?: readonly string[];
  /** Teto de etiquetas de robô por hora na conta (o teste usa um menor). */
  teto?: number;
}

/**
 * Põe uma etiqueta QUE JÁ EXISTE na conta. Etiqueta de robô exige `confirmado`, cabe no teto por hora da conta e
 * deixa a nota de quem pôs.
 */
export async function porEtiqueta(
  conta: string,
  kommo: KommoDasEtiquetas,
  pedido: PedidoDeEtiqueta,
  opcoes: OpcoesDaEtiqueta = {},
): Promise<ResultadoDaEtiqueta> {
  let nome = acharNaConta(pedido.nome, await etiquetasDaConta(conta, kommo));
  // criada no Kommo nos últimos 10 min? relê a lista uma vez antes de recusar
  if (!nome) nome = acharNaConta(pedido.nome, await etiquetasDaConta(conta, kommo, true));
  if (!nome) {
    return { ok: false, status: 422, erro: 'essa etiqueta não existe no Kommo: a Ponte só põe etiquetas que já existem na conta' };
  }
  const robo = ehEtiquetaDeRobo(nome, opcoes.robos);
  if (robo && !pedido.confirmado) {
    return { ok: false, status: 409, erro: 'esta etiqueta faz o robô mandar uma mensagem para o paciente: confirme antes', precisaConfirmar: true };
  }
  // a vaga do teto é reservada AQUI, no mesmo passo da conferência (sem await no meio), e devolvida se nada gravar
  const teto = opcoes.teto ?? TETO_DE_ROBO_POR_HORA;
  const vaga = robo ? reservarVagaDeRobo(conta, teto) : null;
  if (robo && !vaga) {
    return { ok: false, status: 429, erro: `a Ponte já pôs ${teto} etiquetas que mandam mensagem nesta conta na última hora: ponha esta pelo Kommo ou espere` };
  }

  let gravou = false;
  try {
    const lead = await lerCartao(kommo, pedido.leadId);
    if (!lead) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };
    const antes = nomesDoCartao(lead);
    // já está: não grava de novo (e uma de robô que já estava não ganha nota de "posta agora")
    if (etiquetaNoCartao(nome, antes)) return { ok: true, leadId: pedido.leadId, nome, robo, mudou: false, etiquetas: antes };

    await kommo.addTag({ leadId: pedido.leadId, tag: nome });
    gravou = true;
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
  } finally {
    if (vaga && !gravou) vaga.devolver();
  }
}

/** Tira a etiqueta do cartão. Não pede confirmação e não precisa existir na conta (só no cartão). */
export async function tirarEtiqueta(kommo: KommoDasEtiquetas, pedido: PedidoDeEtiqueta, opcoes: OpcoesDaEtiqueta = {}): Promise<ResultadoDaEtiqueta> {
  const lead = await lerCartao(kommo, pedido.leadId);
  if (!lead) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };
  const antes = nomesDoCartao(lead);
  const noCartao = etiquetaNoCartao(pedido.nome, antes);
  if (!noCartao) {
    return { ok: true, leadId: pedido.leadId, nome: pedido.nome, robo: ehEtiquetaDeRobo(pedido.nome, opcoes.robos), mudou: false, etiquetas: antes };
  }
  await kommo.removeTag(pedido.leadId, noCartao);
  const relido = await lerCartao(kommo, pedido.leadId).catch(() => null);
  const depois = relido ? nomesDoCartao(relido) : null;
  if (depois && depois.includes(noCartao)) {
    return { ok: false, status: 502, erro: 'o Kommo aceitou, mas a etiqueta continua no cartão: confira no Kommo' };
  }
  return { ok: true, leadId: pedido.leadId, nome: noCartao, robo: ehEtiquetaDeRobo(noCartao, opcoes.robos), mudou: true, etiquetas: depois ?? antes.filter((t) => t !== noCartao) };
}
