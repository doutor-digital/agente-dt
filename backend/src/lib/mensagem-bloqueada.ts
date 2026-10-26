/**
 * Quando NENHUMA mensagem automática pode sair para o cartão — lembrete, régua, reativação.
 *
 * Item 6 da lista da Suzanne (25/10/2026): Boituva #6298947 ("VIVO OPERADORA - NÃO É LEAD") e Capivari #5699887
 * ("23-arquivo-morto") receberam a régua de 120 h; Açailândia #28780654 (pediu estorno do Pix) recebeu a de 48 h e a de
 * 96 h. O servidor não lia etiqueta nenhuma antes de mandar.
 *
 * OS NOMES VÊM DAS CONTAS, não de palpite (levantados em 26/10/2026 nas 18 contas com token, API de etiquetas):
 *  - `NAO_PERTURBAR` (9 contas), `BLOQUEADO_WHATSAPP` (3), `Fluxo · Opt-out WhatsApp` (16), `Fluxo · Não perturbar` (13):
 *    já eram "não mande nada";
 *  - `não-mandar-mensagem`: só Boituva (o nome que a Suzanne citou);
 *  - `NO_FOLLOW_UP`: 16 das 18 (faltam Rio Verde e Imperatriz) — os robôs do Kommo já a leem ("etiqueta não é NO_FOLLOW_UP");
 *  - `arquivo-morto` (Boituva), `23-arquivo-morto` (Capivari, Cerquilho), `não-aplicavel` (Boituva, Capivari, Cerquilho):
 *    a SDR usa como "morto" — a régua não vai, e por isso a lista da régua é maior que a do lembrete;
 *  - "NÃO É LEAD" NÃO é etiqueta em conta nenhuma: a SDR escreve no NOME do cartão. Por isso o nome também vale.
 *  - "estorno" NÃO existe como etiqueta em conta nenhuma (a Açailândia registrou o pedido só no resumo da IA e no campo
 *    da consulta). Fica a regra por etiqueta/nome caso criem uma — a Suzanne listou "estorno" como bloqueio.
 *
 * Comparação sem acento, sem caixa e sem pontuação: "Não-mandar-mensagem" e "nao mandar mensagem" são a mesma etiqueta.
 * Errar por acento era justamente o risco de uma trava por nome exato.
 *
 * DOIS ESCOPOS, de propósito. Lembrete é a pergunta "você vem?" de uma consulta que o paciente MARCOU: calar por
 * `NO_FOLLOW_UP` (que a SDR põe em quem pediu para não ser cobrado) faria uma falta. A régua e a reativação, que
 * perseguem quem NÃO marcou, calam por qualquer uma.
 */

export type EscopoDoBloqueio = 'lembrete' | 'regua';

function limpar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Etiquetas que dizem "não mande NADA a este cartão" (lembrete incluído). Nomes exatos das contas. */
export const ETIQUETAS_QUE_CALAM_TUDO = [
  'NAO_PERTURBAR',
  'BLOQUEADO_WHATSAPP',
  'Fluxo · Opt-out WhatsApp',
  'Fluxo · Não perturbar',
  'não-mandar-mensagem',
] as const;

/** Etiquetas que calam a RÉGUA e a reativação (quem não marcou), mas não a pergunta de uma consulta marcada. */
export const ETIQUETAS_QUE_CALAM_A_REGUA = ['NO_FOLLOW_UP', 'arquivo-morto', '23-arquivo-morto', 'não-aplicavel'] as const;

const CALAM_TUDO = new Set<string>(ETIQUETAS_QUE_CALAM_TUDO.map(limpar));
const CALAM_A_REGUA = new Set<string>(ETIQUETAS_QUE_CALAM_A_REGUA.map(limpar));

/** "VIVO OPERADORA - NÃO É LEAD", "não e lead", "NAO É LEAD!" — a marca que a SDR escreve no nome do cartão. */
const NAO_E_LEAD = /(^| )nao (e|eh) lead( |$)/;
/** Estorno pedido: se a etiqueta ou o nome disser, ninguém recebe mensagem de venda. */
const ESTORNO = /(^| )(estorno|estornado|estornada)( |$)/;

export interface CartaoParaBloqueio {
  name?: string | null;
  _embedded?: { tags?: Array<{ name?: string | null }> | null } | null;
}

/**
 * Por que NÃO mandar mensagem automática a este cartão — ou null: pode mandar. O texto vai para o log.
 * Cartão ilegível (null) = null: sem leitura não há prova, e quem chama segue como seguia antes desta trava.
 */
export function motivoDeBloqueio(cartao: CartaoParaBloqueio | null | undefined, escopo: EscopoDoBloqueio): string | null {
  if (!cartao) return null;
  for (const bruta of cartao._embedded?.tags ?? []) {
    const t = limpar(bruta.name ?? '');
    if (!t) continue;
    if (CALAM_TUDO.has(t)) return `etiqueta "${bruta.name}"`;
    if (ESTORNO.test(t)) return `etiqueta de estorno ("${bruta.name}")`;
    if (escopo === 'regua' && CALAM_A_REGUA.has(t)) return `etiqueta "${bruta.name}"`;
  }
  const nome = limpar(cartao.name ?? '');
  if (NAO_E_LEAD.test(nome)) return 'o nome do cartão diz NÃO É LEAD';
  if (ESTORNO.test(nome)) return 'o nome do cartão fala em estorno';
  return null;
}
