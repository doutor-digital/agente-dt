/**
 * As decisões do `scripts/backfill-campos.ts` que não dependem de Kommo nem de modelo, para poderem ser testadas.
 *
 * O que a simulação de 24/11/2026 em Salto e Tatuí mostrou, e que está aqui:
 *  - "Motivo do não agendamento" saía em cartão que NÃO está perdido nem em espera (Em qualificação 66, Agendado 6,
 *    Em tratamento 8...): é palpite, e suja o relatório. Só vale em Em espera ou Perdido.
 *  - "Região da dor = Não informada" (60 em Salto, 18 em Tatuí) escondia que o campo está vazio. Valor que diz "não sei" não é dado.
 *  - 1 lote em Salto e 2 em Tatuí voltaram com JSON inválido e o script os engolia em silêncio (até 10 conversas por lote).
 *    Agora o lote é partido ao meio e tentado de novo, e o que não se recupera é CONTADO e mostrado no fim.
 */
import { normalizar } from './franquia-sync.js';

/**
 * Campos que uma CONVERSA pode responder. Os outros da régua (data de pagamento, situação da consulta, motivo da espera) são
 * operacionais: quem sabe é a agenda ou a recepção. "Preferência de horário" fica de fora: voltava com data concreta e vencida.
 */
export const DA_CONVERSA = /queixa|qualifica|sexo|cidade|bairro|estado|profiss|plano|tipo de lead|regi[ãa]o|tempo|idade|motivo do n[ãa]o/i;

export interface RegraDeLeitura {
  kommoFieldId: number;
  kommoFieldName: string;
  kommoFieldType: string;
  kommoFieldEnums?: unknown;
}

export interface Extracao {
  leadId: number;
  campos: Record<string, string | null>;
}

/** "Não informada", "não informou", "sem informação"...: a resposta que diz que NÃO há resposta. */
export function valorNaoInformado(bruto: unknown): boolean {
  const v = normalizar(String(bruto ?? ''));
  if (!v) return false;
  return /^(nao (informad[oa]s?|informou|consta|especificad[oa]s?|se sabe)|sem informacao|sem informacoes|nao ha informacao|nao ha informacoes|ni)$/.test(v);
}

export function ehCampoDeMotivo(nomeDoCampo: string): boolean {
  return /motivo do n[ãa]o/i.test(nomeDoCampo);
}

/** "Motivo do não agendamento" só descreve quem ficou em espera ou foi perdido. `nomeDaEtapa` = nome da etapa no Kommo. */
export function etapaPermiteMotivo(nomeDaEtapa: string | null | undefined): boolean {
  const n = normalizar(nomeDaEtapa);
  return n.includes('espera') || n.includes('perdido');
}

function opcoesDe(regra: RegraDeLeitura): string[] {
  return ((regra.kommoFieldEnums as Array<{ value: string }> | null) ?? []).map((e) => e.value).filter(Boolean);
}

/** Só aceita opção que existe naquela conta — o modelo às vezes inventa um rótulo parecido. */
export function valorValido(regra: RegraDeLeitura, bruto: string): string | null {
  const v = String(bruto ?? '').trim();
  if (!v || v.toLowerCase() === 'null') return null;
  const enums = opcoesDe(regra);
  if (enums.length === 0) return v;
  return enums.find((e) => e.toLowerCase() === v.toLowerCase()) ?? null;
}

export interface Decisao {
  aGravar: Array<{ regra: RegraDeLeitura; valor: string }>;
  /** o campo já tinha valor: nunca sobrescreve */
  jaPreenchidos: number;
  naoInformados: number;
  motivoForaDaEtapa: number;
}

/**
 * O que gravar num cartão a partir do que o modelo extraiu da conversa.
 * `preenchidos` = ids dos campos que o cartão JÁ tem; `nomeDaEtapa` = etapa atual do cartão.
 */
export function decidirCampos(e: {
  campos: Record<string, string | null> | undefined;
  porNome: ReadonlyMap<string, RegraDeLeitura>;
  preenchidos: ReadonlySet<number>;
  nomeDaEtapa: string | null | undefined;
}): Decisao {
  const d: Decisao = { aGravar: [], jaPreenchidos: 0, naoInformados: 0, motivoForaDaEtapa: 0 };
  const campos = e.campos ?? {};

  // Qualificação sem queixa é chute: sem a dor contada não há base para dizer se a pessoa é quente.
  // "Queixa: não informada" não conta como queixa.
  const temQueixa = Object.entries(campos).some(
    ([nome, v]) => /queixa/i.test(nome) && v != null && String(v).trim() !== '' && !valorNaoInformado(v),
  );

  for (const [nome, bruto] of Object.entries(campos)) {
    const regra = e.porNome.get(String(nome).toLowerCase());
    if (!regra || bruto == null) continue;
    if (!temQueixa && /qualifica/i.test(regra.kommoFieldName)) continue;
    if (valorNaoInformado(bruto)) {
      d.naoInformados++;
      continue;
    }
    if (ehCampoDeMotivo(regra.kommoFieldName) && !etapaPermiteMotivo(e.nomeDaEtapa)) {
      d.motivoForaDaEtapa++;
      continue;
    }
    if (e.preenchidos.has(regra.kommoFieldId)) {
      d.jaPreenchidos++;
      continue;
    }
    const valor = valorValido(regra, String(bruto));
    if (valor) d.aGravar.push({ regra, valor });
  }
  return d;
}

/** O array JSON da resposta do modelo. `null` = resposta que não dá para ler (sem array, JSON quebrado ou não-array). `[]` é válido. */
export function lerExtracoes(texto: string): Extracao[] | null {
  const m = texto.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const r: unknown = JSON.parse(m[0]);
    return Array.isArray(r) ? (r as Extracao[]) : null;
  } catch {
    return null;
  }
}

export interface ContagemDeFalhas {
  /** quantas respostas vieram ilegíveis (cada tentativa conta) */
  respostasInvalidas: number;
  /** lotes que deram erro de rede/API (não são repetidos: erro de chave ou limite só se repetiria) */
  lotesComErro: number;
  /** cartões cuja conversa NÃO foi lida, mesmo depois de partir o lote */
  perdidas: number[];
  erros: string[];
}

export function contagemVazia(): ContagemDeFalhas {
  return { respostasInvalidas: 0, lotesComErro: 0, perdidas: [], erros: [] };
}

/**
 * Chama o modelo para o lote. Resposta ilegível (`null`): parte o lote ao meio e tenta cada metade, até sobrar 1 conversa;
 * a que ainda assim não lê entra em `perdidas`. Erro lançado (rede, chave, limite): não repete, conta e segue.
 */
export async function extrairComRetentativa<C extends { leadId: number }>(
  lote: ReadonlyArray<C>,
  chamar: (lote: ReadonlyArray<C>) => Promise<Extracao[] | null>,
  cont: ContagemDeFalhas,
): Promise<Extracao[]> {
  if (lote.length === 0) return [];
  let resposta: Extracao[] | null;
  try {
    resposta = await chamar(lote);
  } catch (err) {
    cont.lotesComErro++;
    cont.perdidas.push(...lote.map((c) => c.leadId));
    cont.erros.push(String(err).slice(0, 160));
    return [];
  }
  if (resposta !== null) return resposta;
  cont.respostasInvalidas++;
  if (lote.length === 1) {
    cont.perdidas.push(lote[0]!.leadId);
    return [];
  }
  const meio = Math.ceil(lote.length / 2);
  const primeira = await extrairComRetentativa(lote.slice(0, meio), chamar, cont);
  const segunda = await extrairComRetentativa(lote.slice(meio), chamar, cont);
  return [...primeira, ...segunda];
}
