/**
 * Unidade de atendimento do cartão — Petrópolis × Caxias no mesmo Kommo (05/10/2026; regra trocada em 13/10/2026).
 *
 * Até 13/10 a unidade saía do número de WhatsApp em que o paciente escreveu primeiro (oficial = Petrópolis,
 * QR code = Caxias). O QR caiu em 10/10 e os anúncios de Caxias passaram a cair no número oficial: o robô
 * marcou 104 pacientes de Caxias como Petrópolis. E a conta passa a ter UM número para as duas cidades — o
 * número deixou de dizer de onde o paciente é. Decisão do João (13/10), nesta ordem:
 *  1. o ANÚNCIO de origem (`⌂ ID do anúncio`), pela CONTA DE ANÚNCIOS a que ele pertence (Petrópolis
 *     1055937202829106, Caxias 650695850658904). O robô pergunta a conta à Meta quando a unidade tem token com
 *     acesso; sem token, vale a lista de anúncios conferidos à mão;
 *  2. sem anúncio conhecido, o DDD do telefone (21 = Caxias, 24 = Petrópolis);
 *  3. sem nenhum dos dois, o campo fica vazio e a SDR escolhe.
 *
 * Regras que continuam:
 *  - Campo preenchido pela SDR nunca é trocado — só compara (confere/diverge).
 *  - O robô corrige a SI MESMO, e só com prova forte: se o ANÚNCIO diz outra unidade e quem pôs o valor foi o
 *    robô (evento do Kommo com `created_by` 0), ele troca. O DDD só preenche campo vazio — ele não desfaz o que
 *    o robô antigo marcou pelo número (quem escreveu no QR de Caxias antes de 10/10 é de Caxias, seja qual for
 *    o DDD). É assim que os 93 cartões dos anúncios de Caxias se corrigem depois do deploy.
 *  - A etiqueta segue o CAMPO (o que está no cartão): se a SDR corrigiu para Petrópolis, a etiqueta é PETRÓPOLIS.
 *
 * O nome do arquivo e o id da automação (`unidade-por-canal`) ficaram os antigos: a tela de Automações guarda o
 * estado por esse id.
 */

export const CAMPO_UNIDADE = '⌂ Unidade de atendimento';
/** O anúncio que trouxe o paciente (o rastreio de anúncio grava). O último vale quando o primeiro falta. */
export const CAMPOS_ANUNCIO = ['⌂ ID do anúncio', '⌂ Último anúncio'] as const;

export interface RegrasDaUnidade {
  /** conta de anúncios (sem o "act_") → unidade. */
  contasDeAnuncio: Record<string, string>;
  /** anúncio → conta de anúncios, conferido à mão: vale quando a unidade não tem token para perguntar à Meta. */
  anunciosConhecidos: Record<string, string>;
  /** DDD do telefone → unidade, para quem chegou sem anúncio conhecido. */
  ddd: Record<string, string>;
  /**
   * A cidade cuja agenda esta unidade do agente tem (o token da franquia cadastrado é o dela). Cartão de outra
   * cidade, ou sem cidade, não escreve na franquia — ver `lib/trava-unidade-atendimento.ts` (14/10/2026).
   */
  cidadeDaFranquia: string;
}

const CONTA_PETROPOLIS = '1055937202829106';
const CONTA_CAXIAS = '650695850658904';

/** Por unidade do agente (slug). */
export const REGRAS_POR_UNIDADE: Record<string, RegrasDaUnidade> = {
  'doutor-hernia-petropolis': {
    contasDeAnuncio: { [CONTA_PETROPOLIS]: 'Petrópolis', [CONTA_CAXIAS]: 'Caxias' },
    anunciosConhecidos: {
      // Campanha 120248238857890289 "ENG | WPP | VÍDEO | RMKT | 3205" — conferida na Meta em 13/10.
      '120248238857800289': CONTA_PETROPOLIS,
      '120248238857810289': CONTA_PETROPOLIS,
      '120248238857840289': CONTA_PETROPOLIS,
      '120248238857880289': CONTA_PETROPOLIS,
      '120248238857900289': CONTA_PETROPOLIS,
      // Campanha "ENG | WPP | ABERTO | RMKT - 3205" ("AGENDAR AVALIAÇÃO") — conferida na Meta em 13/10.
      '120250266913240207': CONTA_CAXIAS,
      '120250266913260207': CONTA_CAXIAS,
      '120250266913290207': CONTA_CAXIAS,
      '120250266913310207': CONTA_CAXIAS,
      '120250266913320207': CONTA_CAXIAS,
      '120250266913330207': CONTA_CAXIAS,
      '120250266913410207': CONTA_CAXIAS,
      '120250266913420207': CONTA_CAXIAS,
      '120250266913430207': CONTA_CAXIAS,
    },
    ddd: { '21': 'Caxias', '24': 'Petrópolis' },
    // Só o token da franquia de PETRÓPOLIS está cadastrado: cartão de Caxias marcaria na agenda errada.
    cidadeDaFranquia: 'Petrópolis',
  },
};

/** A etiqueta da cidade: o nome em caixa alta ("Caxias" → "CAXIAS"). */
export const etiquetaDe = (unidade: string): string => unidade.toLocaleUpperCase('pt-BR');

/** DDD de um telefone brasileiro, com ou sem o 55 na frente. null se não parecer telefone brasileiro. */
export function dddDe(telefone: string | null | undefined): string | null {
  let d = String(telefone ?? '').replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  return d.slice(0, 2);
}

export interface Decisao {
  unidade: string;
  motivo: string;
  /** de onde veio: o anúncio é prova forte (corrige o robô); o DDD só preenche vazio */
  fonte: 'anuncio' | 'ddd';
}

/**
 * Puro. `contaDoAnuncio` = a conta que a Meta devolveu para o anúncio (null se não perguntou ou se a Meta não
 * deixou ver). Devolve null quando nada decide — a SDR escolhe.
 */
export function decidirUnidade(e: {
  anuncio: string | null;
  contaDoAnuncio: string | null;
  ddd: string | null;
  regras: RegrasDaUnidade;
}): Decisao | null {
  if (e.anuncio) {
    const conta = e.contaDoAnuncio ?? e.regras.anunciosConhecidos[e.anuncio] ?? null;
    const pelaConta = conta ? e.regras.contasDeAnuncio[conta] : undefined;
    if (pelaConta) return { unidade: pelaConta, motivo: `anúncio ${e.anuncio} é da conta de anúncios de ${pelaConta}`, fonte: 'anuncio' };
  }
  const peloDdd = e.ddd ? e.regras.ddd[e.ddd] : undefined;
  if (peloDdd) {
    const sobra = e.anuncio ? ` (anúncio ${e.anuncio} de conta desconhecida)` : '';
    return { unidade: peloDdd, motivo: `DDD ${e.ddd}${sobra}`, fonte: 'ddd' };
  }
  return null;
}

export type PlanoUnidade =
  | { acao: 'gravar'; unidade: string; etiqueta: string; motivo: string }
  | { acao: 'confere' | 'diverge'; unidade: string; noCartao: string; etiqueta: string | null; motivo: string };

/**
 * Puro. `noCartao` = valor atual do campo (null se vazio); `etiquetas` = as do cartão hoje.
 * Devolve null quando não há o que fazer (nada decidiu). `etiqueta` vem preenchida só quando falta no cartão.
 */
export function planejarUnidade(e: {
  decisao: Decisao | null;
  noCartao: string | null;
  etiquetas: ReadonlyArray<string>;
}): PlanoUnidade | null {
  if (!e.decisao) return null;
  const { unidade, motivo } = e.decisao;
  const tem = new Set(e.etiquetas.map((t) => t.trim().toLocaleUpperCase('pt-BR')));
  const falta = (u: string) => (tem.has(etiquetaDe(u)) ? null : etiquetaDe(u));

  if (!e.noCartao) return { acao: 'gravar', unidade, etiqueta: etiquetaDe(unidade), motivo };
  const igual = e.noCartao.trim().toLocaleLowerCase('pt-BR') === unidade.toLocaleLowerCase('pt-BR');
  // a etiqueta acompanha o que está no cartão (a correção da SDR vence a regra)
  return { acao: igual ? 'confere' : 'diverge', unidade, noCartao: e.noCartao, etiqueta: falta(e.noCartao), motivo };
}

/**
 * Diverge, o ANÚNCIO decidiu e quem pôs o valor foi o próprio robô (`created_by` 0 no Kommo): ele corrige a si
 * mesmo. A SDR, nunca; e o DDD sozinho, nunca.
 */
export function roboCorrige(plano: PlanoUnidade | null, decisao: Decisao | null, autorDoCampo: number | undefined): boolean {
  return plano?.acao === 'diverge' && decisao?.fonte === 'anuncio' && autorDoCampo === 0;
}

/** As etiquetas de OUTRA cidade que sobraram no cartão (a etiqueta segue o campo; a velha sai). */
export function etiquetasSobrando(noCartao: string, etiquetas: ReadonlyArray<string>, regras: RegrasDaUnidade): string[] {
  const cidades = new Set([...Object.values(regras.contasDeAnuncio), ...Object.values(regras.ddd)].map(etiquetaDe));
  const minha = etiquetaDe(noCartao.trim());
  return etiquetas.map((t) => t.trim().toLocaleUpperCase('pt-BR')).filter((t) => t !== minha && cidades.has(t));
}
