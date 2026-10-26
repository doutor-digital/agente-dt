import type { Unit } from '@prisma/client';
import { preencherLacunas } from './lacunas.js';
import { convenioDaUnidade, corrigirPrecoDoConvenio } from './preco-convenio.js';
import { corrigirValorAntecipado } from './valor-antecipado.js';
import { corrigirTomDaSaida } from './tom-da-saida.js';
import { corrigirLinkDeMapa } from './link-de-mapa.js';
import { precosDaConsulta } from './prompt-composer.js';

export interface GuardrailResult {
  text: string;
  triggered: string[];
  rewritten: boolean;
}

function parseAmounts(...texts: (string | null | undefined)[]): Set<number> {
  const set = new Set<number>();
  const re = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;
  for (const t of texts) {
    if (!t) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1].replace(/\./g, ''));
      if (!Number.isNaN(n) && n > 0) set.add(n);
    }
  }
  return set;
}

/** Os valores de uma oferta com centavos ("R$ 150,50" → 150.5), para comparar exato. */
function valoresExatos(texto: string | null | undefined): Set<number> {
  const set = new Set<number>();
  for (const m of (texto ?? '').matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/gi)) {
    const n = Number(`${m[1]!.replace(/\./g, '')}.${m[2] ?? '00'}`);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  return set;
}

function amountApproved(v: number, approved: Set<number>): boolean {
  if (approved.has(v)) return true;
  for (const total of approved) {
    for (let n = 2; n <= 12; n++) {
      if (Math.abs(Math.round(total / n) - v) <= 2) return true;
    }
  }
  return false;
}

const FALLBACK_PRECO =
  'Sobre o valor, deixa eu confirmar direito pra não te passar informação errada 🙏 ' +
  'Já te falo por aqui, tá bem?';

/**
 * Troca cada valor fora do catálogo pelo valor aprovado mais próximo.
 *
 * Antes daqui, um preço errado derrubava a mensagem INTEIRA. Isso custou caro:
 * em 14 dias foram 176 bloqueios em 10 unidades, e 7 deles eram confirmação de
 * agendamento — o paciente marcava a consulta e recebia de volta uma pergunta
 * de triagem, sem data, sem endereço e sem PIX. O número errado era um detalhe
 * numa mensagem inteira que estava certa.
 *
 * Escolhe o aprovado mais próximo, pulando os que já aparecem na mensagem, pra
 * não produzir "R$ 350 no PIX à vista (ou R$ 350)". Se sobrar valor sem
 * substituto, devolve null e quem chama cai no texto de segurança.
 */
function corrigirValores(
  text: string,
  aprovados: Set<number>,
  foraDoCatalogo: number[],
): { texto: string; trocas: string[] } | null {
  const jaNoTexto = new Set(
    [...parseAmounts(text)].filter((v) => amountApproved(v, aprovados)),
  );
  const alvo = new Set(foraDoCatalogo);
  const trocas: string[] = [];
  let semSubstituto = false;

  // Uma varredura só, com o mesmo formato que detectou os valores — assim
  // "R$ 200," "R$ 200,00" e "R$ 1.500" são tratados igual.
  const re = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;
  const texto = text.replace(re, (match, num: string) => {
    const v = Number(num.replace(/\./g, ''));
    if (!alvo.has(v)) return match;

    const certo = [...aprovados]
      .filter((a) => !jaNoTexto.has(a))
      .sort((a, b) => Math.abs(a - v) - Math.abs(b - v))[0];
    if (certo === undefined) {
      semSubstituto = true;
      return match;
    }
    jaNoTexto.add(certo);
    trocas.push(`${v}→${certo}`);
    return `R$ ${certo}`;
  });

  if (semSubstituto || trocas.length === 0) return null;
  return { texto, trocas };
}

/**
 * Sobrou lacuna que não deu pra preencher. É melhor prometer conferir do que
 * mandar "[chave das Fontes Oficiais]" — o paciente que recebeu isso em Rio
 * Verde entendeu que a clínica não sabia a própria chave Pix.
 */
const FALLBACK_LACUNA =
  'Deixa eu confirmar esse dado com a equipe pra não te passar nada errado 🙏 ' +
  'Já te retorno por aqui, tá bem?';

const FALLBACK_CLINICO =
  'Sobre o que você está sentindo, quem avalia com segurança é a nossa especialista, na consulta — ' +
  'por aqui eu não consigo dar um diagnóstico. Vamos garantir sua consulta? 😊';

const REGRAS_CLINICAS: { key: string; re: RegExp }[] = [
  {
    key: 'diagnostico',
    re: /\bvoc[eê]\s+(tem|est[aá]\s+com|apresenta|possui)\b[^.!?]{0,40}\b(h[eé]rnia|protrus|abaulament|b[ií]co de papagaio|artrose|ci[aá]tica|estenose|les[aã]o|inflama)/i,
  },
  {
    key: 'prescricao',
    re: /\b(tom[ae]|tomar|us[ae]|usar|utilize|receit)\w*\b[^.!?]{0,45}\b(rem[eé]dio|medicament|anti[- ]?inflamat|analg[eé]sic|relaxante|comprimido|pomada|dipirona|ibuprofen|nimesulida|cortic|inje[cç]|infiltra)/i,
  },
  {
    key: 'garantia_cura',
    re: /\b(garant|com certeza|100\s*%|certamente|prometo)\w*\b[^.!?]{0,40}\b(cur[ao]|sar[ae]|resolv|melhora|fica bom|sem dor)/i,
  },
  {
    key: 'promessa_sem_cirurgia',
    re: /\bn[aã]o\s+(vai\s+)?precis\w*\s+(de\s+|fazer\s+)?(cirurgia|opera[cç])/i,
  },
  {
    key: 'minimiza_sintoma',
    re: /\bn[aã]o\s+[eé]\s+nada\s+(grave|s[eé]rio|demais)/i,
  },
];

/**
 * "Não receitamos remédio", "a consulta não é para receitar medicação": é dizer que NÃO prescreve — e é o que a
 * Sofia passou a dizer a quem espera sair com receita (lista de Marabá, 21/10/2026). Só o verbo "receitar" negado
 * passa: "não precisa tomar remédio" continua barrado, porque mandar parar o remédio também é conduta.
 */
const RECEITA_NEGADA = /\b(?:n[aã]o|nem|nunca)\s+(?:\S+\s+){0,3}$/i;

function violaRegra(regra: { key: string; re: RegExp }, text: string): boolean {
  if (regra.key !== 'prescricao') return regra.re.test(text);
  const todas = new RegExp(regra.re.source, regra.re.flags.replace('g', '') + 'g');
  for (const m of text.matchAll(todas)) {
    const negada = /^receit/i.test(m[0]) && RECEITA_NEGADA.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0));
    if (!negada) return true;
  }
  return false;
}

export interface ExtrasDoGuardrail {
  /**
   * O texto da oferta do disparo que ESTE paciente recebeu (preço, prazo, condição). Os valores dele são aprovados
   * junto com os da ficha: sem isto o R$ 150 da campanha seria cortado como "fora do catálogo" e trocado pelo R$ 280.
   */
  ofertaDaCampanha?: string | null;
}

export function aplicarGuardrail(text: string, unit: Unit, extras: ExtrasDoGuardrail = {}): GuardrailResult {
  if (!text || !text.trim()) return { text, triggered: [], rewritten: false };
  const triggered: string[] = [];
  let texto = text;
  let reescreveu = false;

  if (unit.category?.trim() === 'saude') {
    for (const regra of REGRAS_CLINICAS) {
      if (violaRegra(regra, text)) triggered.push('clinico:' + regra.key);
    }
    if (triggered.length > 0) {
      return { text: FALLBACK_CLINICO, triggered, rewritten: true };
    }
  }

  // Palavra em inglês no meio da frase e "já te expliquei" — ver tom-da-saida.ts.
  const tom = corrigirTomDaSaida(texto);
  if (tom.trocas.length > 0) {
    triggered.push('tom:' + tom.trocas.join('/'));
    texto = tom.texto;
    reescreveu = true;
  }

  // Link de mapa montado pela IA a partir do endereço: o Google erra o pino — ver link-de-mapa.ts.
  const mapa = corrigirLinkDeMapa(texto, unit);
  if (mapa.trocou) {
    triggered.push('mapa:link_inventado');
    texto = mapa.texto;
    reescreveu = true;
  }

  // Lacuna antes de preço: preencher "[chave]" e "R$ [valor]" com o dado real da
  // unidade insere um valor que JÁ é do catálogo, então a checagem abaixo segue
  // valendo sobre o texto preenchido. O que não dá pra preencher não sai.
  const lac = preencherLacunas(texto, {
    chavePix: unit.pixKey,
    titularPix: unit.pixHolder,
    valorAntecipado: precosDaConsulta(unit)?.antecipado ?? null,
  });
  if (lac.trocas.length > 0) {
    triggered.push('lacuna_preenchida:' + lac.trocas.join('/'));
    texto = lac.texto;
    reescreveu = true;
  }
  if (lac.restantes.length > 0) {
    triggered.push('lacuna:' + lac.restantes.join('/'));
    return { text: FALLBACK_LACUNA, triggered, rewritten: true };
  }

  // Valores da oferta que este paciente recebeu. Cada R$ da oferta fica ESCONDIDO das duas travas de "número no slot
  // errado" (convênio e antecipado), que o trocariam pelo da ficha — o bug que a oferta resolve. Só esconde:
  //  - o valor EXATO da oferta, centavos incluídos ("R$ 150,99" não é o "R$ 150" da oferta);
  //  - o que NÃO é também um valor da ficha: se a oferta cita "de R$ 250 por R$ 150" e R$ 250 é o preço de quem tem plano,
  //    um "R$ 250 no Pix antecipado" continua sob a trava (é o erro que ela existe para pegar).
  // Qualquer outro número da mesma mensagem segue sob as travas.
  const catalogo = parseAmounts(unit.sourceProdutos, unit.sourcePapel, unit.sourceNegocio);
  const daOferta = parseAmounts(extras.ofertaDaCampanha);
  const exatosDaOferta = valoresExatos(extras.ofertaDaCampanha);
  const escondidos: string[] = [];
  const escondeOferta = (t: string): string =>
    exatosDaOferta.size === 0
      ? t
      : t.replace(/R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/gi, (m, inteiro: string, centavos?: string) => {
          const valor = Number(`${inteiro.replace(/\./g, '')}.${centavos ?? '00'}`);
          if (!exatosDaOferta.has(valor) || catalogo.has(Math.trunc(valor))) return m;
          escondidos.push(m);
          // mantém o "R$" na frente (as travas param no próximo R$) mas sem o número, que é o que elas procuram
          return `R$ ⟦${escondidos.length - 1}⟧`;
        });
  const mostraOferta = (t: string): string => t.replace(/R\$ ⟦(\d+)⟧/g, (_, i: string) => escondidos[Number(i)] ?? '');
  texto = escondeOferta(texto);

  // O desconto do convênio não pode sair como preço do Pix — ver preco-convenio.ts.
  const p = precosDaConsulta(unit);
  if (p) {
    const conv = convenioDaUnidade(unit, p);
    if (conv != null) {
      const r = corrigirPrecoDoConvenio(texto, { antecipado: p.antecipado, convenio: conv });
      if (r.corrigiu) {
        triggered.push(`preco_convenio_corrigido:${conv}->${p.antecipado}`);
        texto = r.texto;
        reescreveu = true;
      }
    }

    // O número no SLOT do antecipado tem de ser o antecipado desta unidade. A checagem de
    // catálogo logo abaixo não pega isto: ela pergunta "esse valor existe na ficha?", e o
    // valor errado costuma existir — na Serra, R$ 250 é o preço de quem tem plano pagando no
    // dia, então "R$ 250 antecipado" passava limpo. Ver valor-antecipado.ts.
    const va = corrigirValorAntecipado(texto, {
      antecipado: p.antecipado,
      taxaDeReserva: unit.spineBookingRequiresPayment ?? false,
    });
    if (va.corrigiu.length > 0) {
      triggered.push(`antecipado_corrigido:${va.corrigiu.join('/')}->${p.antecipado}`);
      texto = va.texto;
      reescreveu = true;
    }
  }

  texto = mostraOferta(texto);

  // O catálogo é a ficha (com a tolerância de parcela de sempre). Os valores da oferta valem EXATOS, sem a conta de parcelas
  // (R$ 150 de oferta não aprova R$ 50 nem R$ 75), e só enquanto a ficha tem valores: unidade sem R$ na ficha não ganha
  // checagem por causa da oferta.
  const aprovados = catalogo;
  if (aprovados.size > 0) {
    const foraDoCatalogo = [...parseAmounts(texto)].filter(
      (v) => v >= 20 && !amountApproved(v, aprovados) && !daOferta.has(v),
    );
    if (foraDoCatalogo.length > 0) {
      const corrigido = corrigirValores(texto, aprovados, foraDoCatalogo);
      if (corrigido) {
        triggered.push('preco_corrigido:' + corrigido.trocas.join('/'));
        return { text: corrigido.texto, triggered, rewritten: true };
      }
      triggered.push('preco:' + foraDoCatalogo.join('/'));
      return { text: FALLBACK_PRECO, triggered, rewritten: true };
    }
  }

  return { text: texto, triggered, rewritten: reescreveu };
}
