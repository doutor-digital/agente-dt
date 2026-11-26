/**
 * Casar Pix recebido no banco (Pluggy) com PESSOAS (paciente da agenda, paciente da Sofia). Peça comum de duas funções: a lista matinal «agendados sem Pix»
 * (`agendados-sem-pix.ts`) e a ferramenta «quanto a Sofia rendeu» (`mcp-remoto/pluggy-rendimento.ts`).
 *
 * O QUE O BANCO DÁ (medido em Açailândia, 14 dias, só contagens): o Pix recebido traz o nome de quem pagou na descrição («Pix NOME SOBRENOME») e o TIPO do documento do
 * pagador (CPF/CNPJ: 7 dos 19 Pix eram de empresa). O NÚMERO do documento nunca é lido. A venda de maquininha chega AGREGADA («Vendas…»), sem nome: não se atribui a
 * ninguém. O cadastro de paciente da franquia não tem CPF, então o casamento é por NOME + VALOR + DATA.
 *
 * REGRA DA CASA: palpite não vira dado. Nome igual (primeiro + último) com valor e data compatíveis é casamento; qualquer coisa a menos é «parecido» e quem chama
 * trata como «a conferir», nunca como «pagou» nem como «não pagou». Nome de uma palavra só nunca casa.
 */
import type { LancamentoPluggy } from './integracoes/pluggy.js';

/** Sem acento, minúsculo. */
export const semAcento = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const LIGACAO = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

/** «MARIA da Conceição  Silva» → ['maria', 'conceicao', 'silva']: sem acento, sem «da/de/do…», sem inicial solta. */
export function tokensDoNome(nome: string | null | undefined): string[] {
  return semAcento(String(nome ?? ''))
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !LIGACAO.has(t));
}

/** «primeiro último» normalizado; null se o nome não tem pelo menos duas palavras (uma palavra só não identifica ninguém). */
export function chaveDoNome(nome: string | null | undefined): string | null {
  const t = tokensDoNome(nome);
  return t.length >= 2 ? `${t[0]} ${t[t.length - 1]}` : null;
}

export type NivelDeNome = 'igual' | 'parecido' | 'nenhum';

/**
 * - `igual`: primeiro e último nome iguais (o meio pode faltar ou diferir: o banco corta e a ficha abrevia);
 * - `parecido`: primeiro nome igual e o último de um é o começo (3+ letras) de uma palavra do outro (nome cortado pelo banco), ou as duas têm 3+ palavras em comum;
 * - `nenhum`: o resto, e qualquer nome de uma palavra só.
 */
export function compararNomes(a: string | null | undefined, b: string | null | undefined): NivelDeNome {
  return compararTokens(tokensDoNome(a), tokensDoNome(b));
}

/** O mesmo que `compararNomes`, para quem já tokenizou (e indexou por primeiro nome) e compara muitas vezes. */
export function compararTokens(ta: ReadonlyArray<string>, tb: ReadonlyArray<string>): NivelDeNome {
  if (ta.length < 2 || tb.length < 2) return 'nenhum';
  if (ta[0] !== tb[0]) return 'nenhum';
  if (ta[ta.length - 1] === tb[tb.length - 1]) return 'igual';
  const corta = (curto: string, longo: ReadonlyArray<string>) => curto.length >= 3 && longo.slice(1).some((t) => t.startsWith(curto) || (t.length >= 3 && curto.startsWith(t)));
  if (corta(ta[ta.length - 1]!, tb) || corta(tb[tb.length - 1]!, ta)) return 'parecido';
  const comuns = ta.filter((t) => tb.includes(t)).length;
  return comuns >= 3 ? 'parecido' : 'nenhum';
}

const ORDEM: Record<NivelDeNome, number> = { nenhum: 0, parecido: 1, igual: 2 };
export const melhorNivel = (a: NivelDeNome, b: NivelDeNome): NivelDeNome => (ORDEM[a] >= ORDEM[b] ? a : b);

// ----------------------------------------------------------------------------------------------------------------- o Pix

export interface PixRecebido {
  id: string;
  /** AAAA-MM-DD, como o banco lançou */
  dia: string;
  centavos: number;
  /** os nomes que o banco deu para quem pagou (campo do pagador e descrição); nunca vazio com nome conhecido */
  nomes: string[];
  /** o pagador é empresa (CNPJ): não é paciente */
  empresa: boolean;
}

export interface EntradasNaoPix {
  lancamentos: number;
  centavos: number;
}

export interface EntradasDoBanco {
  pix: PixRecebido[];
  /** «Vendas…» da maquininha: agregado do dia, sem nome */
  cartaoVendas: EntradasNaoPix;
  /** TED, boleto, depósito, transferência: entrada que não é Pix nem venda */
  outras: EntradasNaoPix;
}

const centavosDe = (v: number): number => Math.round(Math.abs(v) * 100);

/**
 * «Pix NOME SOBRENOME» → «NOME SOBRENOME». Descrição de pessoa jurídica («Pix 12.345.678 EMPRESA LTDA») não tem nome de paciente.
 * Com `jaEPix` (o método de pagamento diz que é Pix) a descrição pode vir SEM o prefixo («MARIA SILVA»): então o texto inteiro é o nome, se não tiver número.
 */
export function nomeDaDescricao(descricao: string | null | undefined, jaEPix = false): string | null {
  const m = /^\s*pix(?:\s+(?:recebido|enviado))?\s+(.+)$/i.exec(descricao ?? '');
  const resto = (m?.[1] ?? (jaEPix && !/^\s*pix\s*$/i.test(descricao ?? '') ? descricao : null))?.trim();
  if (!resto || /\d/.test(resto)) return null;
  return resto;
}

/**
 * É Pix? O método de pagamento que a Pluggy manda (`paymentMethod`) manda: PIX é Pix; TED, boleto e afins não são, mesmo que a descrição diga «Pix». Com método genérico (OTHER, TRANSFER)
 * ou sem método (banco que não informa), vale o prefixo «Pix» da descrição («Pix NOME»).
 */
const METODOS_GENERICOS = new Set(['OTHER', 'TRANSFER']);
export function ehPix(l: Pick<LancamentoPluggy, 'metodoDePagamento' | 'descricao'>): boolean {
  if (l.metodoDePagamento === 'PIX') return true;
  if (l.metodoDePagamento && !METODOS_GENERICOS.has(l.metodoDePagamento)) return false;
  return /^\s*pix\b/i.test(l.descricao);
}

type LancamentoComConta = LancamentoPluggy & { contaTipo?: string | null };

/**
 * Separa o que entrou no banco em Pix (com nome), venda de maquininha e o resto. Só conta entrada efetivada em conta bancária: pendente (o banco ainda pode trocar)
 * e cartão de crédito ficam de fora, como nos totais da `pluggy_extrato`.
 */
export function entradasDoBanco(lancamentos: ReadonlyArray<LancamentoComConta>): EntradasDoBanco {
  const out: EntradasDoBanco = { pix: [], cartaoVendas: { lancamentos: 0, centavos: 0 }, outras: { lancamentos: 0, centavos: 0 } };
  for (const l of lancamentos) {
    if (l.tipo !== 'entrada' || l.status === 'PENDING' || l.contaTipo === 'CREDIT') continue;
    const centavos = centavosDe(l.valor);
    if (ehPix(l)) {
      const nomes = [l.pagador, nomeDaDescricao(l.descricao, l.metodoDePagamento === 'PIX')].filter((n): n is string => !!n && tokensDoNome(n).length > 0);
      const unicos = nomes.filter((n, i) => nomes.findIndex((m) => semAcento(m) === semAcento(n)) === i);
      out.pix.push({
        id: l.id,
        dia: l.data,
        centavos,
        nomes: unicos,
        empresa: l.pagadorTipoDocumento === 'PJ',
      });
    } else if (/^\s*vendas\b/i.test(l.descricao)) {
      out.cartaoVendas.lancamentos += 1;
      out.cartaoVendas.centavos += centavos;
    } else {
      out.outras.lancamentos += 1;
      out.outras.centavos += centavos;
    }
  }
  return out;
}

/** O melhor nível de nome entre uma pessoa e os nomes que o banco deu para o pagador. */
export function nivelPixPessoa(pix: Pick<PixRecebido, 'nomes'>, nomeDaPessoa: string | null | undefined): NivelDeNome {
  let melhor: NivelDeNome = 'nenhum';
  for (const n of pix.nomes) melhor = melhorNivel(melhor, compararNomes(n, nomeDaPessoa));
  return melhor;
}

// ----------------------------------------------------------------------------------------------------------------- valores da unidade

/** `R$ 250`, `R$ 1.250,00`, `R$50` → centavos. A conta do texto separa por frase: a frase com «sessão» ou «pacote» não entra. */
const REAIS_NO_TEXTO = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g;
/** Fora desta faixa não é sinal nem consulta: é pacote de tratamento, mensalidade ou lixo. */
const MIN_REAIS = 20;
const MAX_REAIS = 1000;

/** Frase do texto de produtos que fala da consulta ou do sinal (e não de sessão, pacote, retorno ou tratamento): só dela saem valores. */
const FRASE_DA_CONSULTA = /consult|avalia|sinal|antecipad|reserv|taxa/i;
const FRASE_DE_OUTRO_PRODUTO = /sess[ãa]o|sess[õo]es|pacote|retorno|tratamento|mensalidade|parcel|reavalia/i;

/**
 * Os valores de Pix que valem como «pagou a consulta/sinal» numa unidade, em centavos, do mais barato para o mais caro.
 * Ordem das fontes: a lista da própria operação (`AGENDADOS_SEM_PIX_VALORES`, JSON `{"<slug>": [50, 250]}` em reais) → o sinal cadastrado
 * (`sinalPixCentavos`) + os valores em reais das FRASES do texto de produtos da unidade que falam de consulta/sinal/antecipado/taxa (a mesma fonte que a Sofia lê: «R$ 350 no
 * dia, ou R$ 250 com sinal de R$ 50»); frase que fala de sessão, pacote, retorno ou tratamento fica de fora. Nada de número no código: mudou o texto da unidade, mudou a lista.
 * O worker registra no log, uma vez, a lista que usou (valores em reais, sem dado de paciente).
 */
export function valoresDaUnidade(a: { slug: string; sinalPixCentavos?: number | null; textoDeProdutos?: string | null; env?: string | undefined }): number[] {
  const bruto = (a.env ?? '').trim().replace(/^'|'$/g, '');
  if (bruto) {
    try {
      const lista = (JSON.parse(bruto) as Record<string, unknown>)?.[a.slug];
      if (Array.isArray(lista)) {
        const v = lista.map((x) => Math.round(Number(x) * 100)).filter((c) => Number.isInteger(c) && c > 0);
        if (v.length) return [...new Set(v)].sort((x, y) => x - y);
      }
    } catch {
      // JSON ruim: cai nas outras fontes (o worker avisa no log uma vez)
    }
  }
  const valores = new Set<number>();
  if (typeof a.sinalPixCentavos === 'number' && Number.isInteger(a.sinalPixCentavos) && a.sinalPixCentavos > 0) valores.add(a.sinalPixCentavos);
  for (const frase of (a.textoDeProdutos ?? '').split(/(?<=[.!?;])\s+|\n+/)) {
    if (!FRASE_DA_CONSULTA.test(frase) || FRASE_DE_OUTRO_PRODUTO.test(frase)) continue;
    for (const m of frase.matchAll(REAIS_NO_TEXTO)) {
      const reais = Number(`${m[1]!.replace(/\./g, '')}.${(m[2] ?? '0').padEnd(2, '0')}`);
      if (Number.isFinite(reais) && reais >= MIN_REAIS && reais <= MAX_REAIS) valores.add(Math.round(reais * 100));
    }
  }
  return [...valores].sort((x, y) => x - y);
}

/** A variável da operação está preenchida mas não é um JSON `{slug: [reais]}`? (o worker avisa no log, uma vez) */
export function valoresDaOperacaoInvalidos(env: string | undefined): boolean {
  const bruto = (env ?? '').trim().replace(/^'|'$/g, '');
  if (!bruto) return false;
  try {
    const j = JSON.parse(bruto) as unknown;
    return !j || typeof j !== 'object' || Array.isArray(j);
  } catch {
    return true;
  }
}
