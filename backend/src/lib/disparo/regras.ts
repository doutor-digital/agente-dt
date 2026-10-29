/**
 * As regras de PÚBLICO e de TEXTO do disparo — puras, sem rede nem banco, para o teste provar cada uma.
 *
 * Tudo aqui nasceu do Outubro Rosa (13–16/10/2026): lista que pegou quem já estava na agenda, saudação com
 * "dona José" e data no nome, quem respondeu SAIR e ficou na lista, telefone sem o nono dígito (22 inválidos; a regra de hoje está em `telefoneWhatsapp`).
 * O lado seguro do erro é SEMPRE o de não mandar: uma mensagem a menos custa uma consulta que a recepção
 * recupera; uma a mais custa o número verde da unidade.
 */
import { finalDoTelefone, pediuParaSair } from '../campanha/metricas.js';
import { comNonoDigito } from '../nono-digito.js';

export { pediuParaSair };

/** Por que alguém ficou de fora da lista. */
export type MotivoDeExclusao =
  | 'sem-telefone'
  | 'telefone-invalido'
  | 'nome-invalido'
  | 'repetido-na-lista'
  | 'ja-na-campanha'
  | 'pediu-sair'
  | 'consulta-futura'
  | 'tratamento-aberto'
  | 'franquia-indisponivel';

/** O texto de oferta que a Sofia lê: preço, prazo, condições. Curto de propósito: vira bloco do prompt em toda resposta de quem recebeu o disparo. */
export const OFERTA_MAX = 1200;

/**
 * A oferta só passa pela trava de preço se o valor estiver escrito "R$ 150": é o único formato que a trava reconhece.
 * "150 reais" ou "por 150" deixariam a Sofia dizer R$ 150 e a trava trocá-lo pelo da ficha (o bug do R$ 150 que a oferta resolve).
 */
export function problemaNaOferta(oferta: string | null | undefined): string | null {
  const t = (oferta ?? '').trim();
  if (!t) return null;
  if (/\b\d[\d.,]*\s*(?:reais|real|contos?|pila)\b/i.test(t)) return 'escreva os valores da oferta como R$ 150 (não "150 reais"): é o único formato que a trava de preço da Sofia reconhece';
  return null;
}

export const ROTULO_DA_EXCLUSAO: Record<MotivoDeExclusao, string> = {
  'sem-telefone': 'sem telefone no contato',
  'telefone-invalido': 'telefone que não é celular com DDD',
  'nome-invalido': 'nome que não serve para saudação',
  'repetido-na-lista': 'mesmo telefone mais de uma vez na lista',
  'ja-na-campanha': 'já está nesta campanha (não manda duas vezes)',
  'pediu-sair': 'pediu para sair (SAIR)',
  'consulta-futura': 'tem consulta marcada na franquia',
  'tratamento-aberto': 'tem tratamento aberto na franquia',
  'franquia-indisponivel': 'a franquia não respondeu (na dúvida, não manda)',
};

/**
 * Celular brasileiro com DDD → só dígitos com DDI e o nono dígito (5563999999999). Qualquer outra coisa → null.
 *
 * O nono dígito — a regra mora em `lib/nono-digito.ts` (o cadastro na franquia usa a MESMA, 29/10/2026); a razão antiga e a nova:
 *  - ANTES (Outubro Rosa, 22 inválidos): número sem o 9 era recusado, porque adivinhar o dígito é mandar para o número de
 *    outra pessoa. Valia para um número QUALQUER, que podia ser fixo ou de outra operadora.
 *  - AGORA (decisão do João, 27/10/2026): as contas antigas do Kommo (Canaã) guardam o WhatsApp com 12 dígitos
 *    (55 + DDD + 8) e a onda de 50 leads ficou com 0 pessoas. Desde 2016 todo celular do Brasil tem o 9 na frente dos
 *    MESMOS 8 dígitos, então para quem era celular o mapeamento é determinístico. O que impede de errar de pessoa é a
 *    faixa: só se acrescenta o 9 quando o 1º dígito depois do DDD é 6, 7, 8 ou 9 (a faixa em que um celular legado
 *    começava). Começou com 2, 3, 4 ou 5 é telefone FIXO e continua recusado — fixo não tem WhatsApp, e acrescentar o
 *    9 a ele cairia no número de outra pessoa.
 *  - Só 12 dígitos COM 55 na frente entram por esse caminho, e só com um DDD que existe (`DDDS_DO_BRASIL`: acrescentar o 9
 *    a um número de DDD inventado é fabricar telefone). 10 dígitos (DDD + 8, sem 55) e qualquer outro tamanho seguem
 *    recusados: sem o 55 a leitura "DDD + 8" não se distingue de lixo.
 *  - Risco que a faixa NÃO elimina: um número de 13 dígitos truncado (faltou o último) tem 12 e pode começar com 9; ele
 *    ganharia um 9 e viraria outro telefone válido. É o preço da decisão do João; a faixa só barra o fixo.
 *
 * O número devolvido é SEMPRE o de 13 dígitos: é o que vai para a Graph API, o que fica gravado no destinatário
 * (`DisparoDestinatario.telefone`, usado pela lista de teste e pelo log) e a base da chave. A chave (DDD + 8 últimos)
 * não depende do 9, então a mesma pessoa em 12 e em 13 dígitos cai na MESMA chave.
 */
export function telefoneWhatsapp(bruto: string | null | undefined): string | null {
  const d = (bruto ?? '').replace(/\D/g, '');
  let completo: string;
  if (d.length === 11) completo = `55${d}`;
  else if (d.length === 13 && d.startsWith('55')) completo = d;
  else if (comNonoDigito(d)) completo = comNonoDigito(d) as string;
  else return null;
  const ddd = Number(completo.slice(2, 4));
  if (ddd < 11 || ddd > 99 || ddd % 10 === 0) return null;
  if (completo[4] !== '9') return null;
  return completo;
}

/** DDD + 8 últimos dígitos: o mesmo número com e sem o nono dígito dá a mesma chave. */
export function chaveDaPessoa(telefone: string): string {
  return `${telefone.slice(2, 4)}${finalDoTelefone(telefone) ?? ''}`;
}

const NOMES_GENERICOS = new Set([
  'paciente', 'cliente', 'contato', 'lead', 'whatsapp', 'sem', 'novo', 'nova', 'dona', 'senhora', 'sr', 'sra',
  'dr', 'dra', 'doutor', 'doutora', 'unknown', 'desconhecido', 'teste',
]);

/**
 * O primeiro nome que cabe numa saudação, ou null. Pega só a primeira palavra: o que vem depois ("Vânia Oliveira
 * 28/04/25 facebook") não entra no texto. Recusa o que não é nome (dígito, símbolo, uma letra, "Paciente").
 */
export function primeiroNomeSeguro(nome: string | null | undefined): string | null {
  const palavra = (nome ?? '').trim().split(/\s+/)[0] ?? '';
  if (palavra.length < 2 || palavra.length > 20) return null;
  if (!/^[\p{L}]+(?:['’-][\p{L}]+)?$/u.test(palavra)) return null;
  if (NOMES_GENERICOS.has(palavra.toLowerCase())) return null;
  return palavra.toLowerCase().replace(/(^|['’-])(\p{L})/gu, (_, sep: string, l: string) => sep + l.toUpperCase());
}

export interface Candidato {
  leadId: number | null;
  /** nome do CONTATO (não o título do cartão, que a SDR enche de data e origem) */
  nome: string | null;
  telefoneBruto: string | null;
}

export interface Elegivel {
  leadId: number | null;
  /** primeiro nome validado — o que entra na saudação */
  nome: string;
  /** nome inteiro do contato, só para conferir a franquia (não vai para o banco do disparo) */
  nomeCompleto: string;
  telefone: string;
  chave: string;
}

/** O que a franquia diz de uma pessoa. */
export type SituacaoNaFranquia = 'livre' | 'consulta-futura' | 'tratamento-aberto' | 'indisponivel';

export interface ContextoDoPublico {
  /** chaves já em qualquer onda desta campanha nesta unidade */
  jaNaCampanha: ReadonlySet<string>;
  /** chaves de quem pediu SAIR (aqui ou em qualquer conversa) */
  pediramSair: ReadonlySet<string>;
  /** a franquia, por candidato já elegível até aqui */
  franquia: (c: Elegivel) => SituacaoNaFranquia | Promise<SituacaoNaFranquia>;
}

export interface ResultadoDaTriagem {
  elegiveis: Elegivel[];
  fora: Partial<Record<MotivoDeExclusao, number>>;
}

/**
 * A triagem. A ordem importa: o que se decide sem rede vem antes, e a franquia (uma ou mais chamadas por pessoa)
 * só é consultada para quem passou do resto.
 */
export async function triar(candidatos: Candidato[], ctx: ContextoDoPublico): Promise<ResultadoDaTriagem> {
  const fora: Partial<Record<MotivoDeExclusao, number>> = {};
  const nega = (m: MotivoDeExclusao) => {
    fora[m] = (fora[m] ?? 0) + 1;
  };
  const vistos = new Set<string>();
  const elegiveis: Elegivel[] = [];

  for (const c of candidatos) {
    if (!(c.telefoneBruto ?? '').replace(/\D/g, '')) {
      nega('sem-telefone');
      continue;
    }
    const telefone = telefoneWhatsapp(c.telefoneBruto);
    if (!telefone) {
      nega('telefone-invalido');
      continue;
    }
    const chave = chaveDaPessoa(telefone);
    if (vistos.has(chave)) {
      nega('repetido-na-lista');
      continue;
    }
    vistos.add(chave);
    if (ctx.jaNaCampanha.has(chave)) {
      nega('ja-na-campanha');
      continue;
    }
    if (ctx.pediramSair.has(chave)) {
      nega('pediu-sair');
      continue;
    }
    const nome = primeiroNomeSeguro(c.nome);
    if (!nome) {
      nega('nome-invalido');
      continue;
    }
    const e: Elegivel = { leadId: c.leadId, nome, nomeCompleto: (c.nome ?? '').trim(), telefone, chave };
    const situacao = await ctx.franquia(e);
    if (situacao === 'consulta-futura') nega('consulta-futura');
    else if (situacao === 'tratamento-aberto') nega('tratamento-aberto');
    else if (situacao === 'indisponivel') nega('franquia-indisponivel');
    else elegiveis.push(e);
  }
  return { elegiveis, fora };
}

// ── texto ───────────────────────────────────────────────────────────────────────────────────────────────────

/** "primeiroNome" | "unidade" | "texto:<literal>" */
export type FonteDeVariavel = string;

export function fonteValida(f: unknown): f is FonteDeVariavel {
  return typeof f === 'string' && (f === 'primeiroNome' || f === 'unidade' || (f.startsWith('texto:') && f.length > 6));
}

/** Os valores de {{1}}, {{2}}… para uma pessoa. */
export function valoresDasVariaveis(fontes: readonly FonteDeVariavel[], ctx: { primeiroNome: string; unidade: string }): string[] {
  return fontes.map((f) => (f === 'primeiroNome' ? ctx.primeiroNome : f === 'unidade' ? ctx.unidade : f.slice('texto:'.length)));
}

/** O texto que a pessoa vai ler. */
export function textoFinal(textoModelo: string, valores: readonly string[]): string {
  return textoModelo.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => valores[Number(n) - 1] ?? `{{${n}}}`);
}

/** `null` = o texto e as variáveis casam ({{1}}…{{n}} em ordem, uma fonte para cada). */
export function problemaNoModelo(textoModelo: string, fontes: readonly unknown[]): string | null {
  if (!textoModelo.trim()) return 'o modelo está sem texto';
  if (!fontes.every(fonteValida)) return 'variável desconhecida (use primeiroNome, unidade ou texto:<valor>)';
  const usados = [...textoModelo.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  const unicos = [...new Set(usados)].sort((a, b) => a - b);
  if (unicos.some((n, i) => n !== i + 1)) return 'as variáveis do texto precisam ser {{1}}, {{2}}… sem pular número';
  if (unicos.length !== fontes.length) return `o texto usa ${unicos.length} variável(is) e a campanha define ${fontes.length}`;
  return null;
}

/** Compara o texto do banco com o da Meta sem se importar com espaço e quebra de linha. */
export function mesmoTexto(a: string, b: string): boolean {
  const n = (t: string) => t.replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}
