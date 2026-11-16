/**
 * Renomeia o lead novo de Petrópolis e Caxias — robô de REGRA FIXA, sem IA (a chefe não quer IA lá).
 *
 * Por que existe (medido em 26/10/2026): em 3 dias as SDRs renomearam 66 leads à mão, sempre no formato
 * "Nome dd/mm/aa" (ano com 2 dígitos), data = dia em que o lead foi criado. O Kommo dessa conta não manda
 * mensagem para o agente (0 execution_traces em 7 dias), então o `titulo-padrao` — que roda no webhook de
 * mensagem — nunca acorda. Este módulo só decide; quem varre os leads recentes é o `renomear-lead-worker`.
 *
 * Regras:
 *  1. Só mexe em lead com título GENÉRICO (`ehTituloGenerico`): o do Kommo ("Lead #123", vazio), o provisório do
 *     `titulo-padrao` ("Lead dd/mm/aaaa", "Lead N dd/mm/aaaa") e o nosso ("Lead dd/mm/aa"). Nome que a SDR deu nunca é tocado.
 *     (16/11/2026, pedido da clínica de Petrópolis: "a IA dá o nome do paciente ao cartão, nada de Lead 1, Lead 2". O
 *     `titulo-padrao` chega primeiro e o título dele não contava como "sem nome": o renomear nunca agia.)
 *  2. De onde vem o nome, nesta ordem: (a) o paciente da franquia achado pelo telefone, quando é UM só e bate com o contato;
 *     (b) o nome do contato do WhatsApp, se tiver cara de nome de gente. → "Nome dd/mm/aa".
 *  3. Nada serviu: se o título é "Lead #123"/vazio do Kommo vira "Lead dd/mm/aa" ("Lead 2 dd/mm/aa" pro segundo do dia, a
 *     numeração do `titulo-padrao`); se já era genérico FICA COMO ESTÁ — nunca troca um genérico por outro.
 *  4. Na dúvida, genérico: errar para o genérico custa uma renomeada da SDR; gravar lixo ("Deus é Deus") custa
 *     um cartão que parece nomeado e ninguém mais revisa.
 */
import { ehSemNome, ehTituloPadrao, montarTituloPadrao } from './titulo-padrao.js';
import { normalizar } from './franquia-sync.js';
import type { MembroDoCrm } from './crm-compartilhado.js';
import type { Estado } from './automacoes-estado.js';
import { FUSO_PADRAO, fusoValido } from './fuso.js';

export { ehSemNome };

/** "Lead dd/mm/aa" (o nosso, de 2 dígitos). Com o de 4 dígitos (`ehTituloPadrao`) e o do Kommo (`ehSemNome`) formam o genérico. */
const LEAD_DATA_CURTA = /^lead(?: \d+)? \d{2}\/\d{2}\/\d{2}$/i;

/**
 * O título não diz quem é o paciente: o do Kommo ("Lead #123", vazio), o provisório do `titulo-padrao` ("Lead 16/11/2026",
 * "Lead 6 13/11/2026") ou o nosso de 2 dígitos. Só estes podem ser reescritos; qualquer outro texto foi alguém que escreveu.
 */
export function ehTituloGenerico(nome: string | null | undefined): boolean {
  return ehSemNome(nome) || ehTituloPadrao(nome) || LEAD_DATA_CURTA.test(String(nome ?? '').trim());
}

const formatadores = new Map<string, Intl.DateTimeFormat>();

/** dd/mm/aa no fuso informado (o ano com 2 dígitos é o jeito das SDRs de Petrópolis). */
export function dataCurta(epochS: number, tz: string): string {
  const fuso = fusoValido(tz) ? tz : FUSO_PADRAO;
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: '2-digit' });
    formatadores.set(fuso, f);
  }
  return f.format(new Date(epochS * 1000));
}

/** "Lead 2 16/11/2026" → "Lead 2 16/11/26" (só o ano do FIM do título; o resto fica como está). */
function aDataCurta(titulo: string): string {
  return String(titulo ?? '').replace(/(\d{2}\/\d{2}\/)\d{2}(\d{2})\s*$/, '$1$2');
}

/** Partículas que ficam minúsculas no meio do nome ("Maria da Silva"). */
const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'di', 'du', 'del', 'della', 'van', 'von', 'bin']);

/**
 * Palavras que NÃO aparecem em nome de gente: ligações de frase ("Deus é Deus", "Sueli Jesus é Fiel"), perfis de
 * empresa/ajuda e os rótulos que o Kommo/WhatsApp põem quando não há nome. "e" fica de fora de propósito: "Ana e
 * Pedro" são duas pessoas e o cartão é de uma.
 */
const PALAVRAS_DE_FORA = new Set([
  'é', 'e', 'ou', 'em', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'para', 'pra', 'por', 'com', 'sem', 'que', 'se', 'não', 'nao',
  'meu', 'minha', 'seu', 'sua', 'sou', 'tem', 'foi', 'vai', 'sempre', 'obrigado', 'obrigada',
  'deus', 'senhor', 'senhora', 'fiel', 'abençoado', 'abencoado', 'abençoada', 'abencoada', 'amém', 'amem', 'gratidão', 'gratidao',
  'lead', 'contato', 'cliente', 'paciente', 'usuario', 'usuário', 'whatsapp', 'unknown', 'desconhecido', 'anonimo', 'anônimo', 'nome',
  'doutor', 'doutora', 'dr', 'dra', 'clinica', 'clínica', 'hernia', 'hérnia', 'consultorio', 'consultório', 'loja', 'oficial', 'vendas', 'atendimento', 'suporte', 'empresa', 'studio', 'estudio', 'estúdio',
]);

/**
 * Palavras de saudação/frase que também são sobrenome ou prenome ("Maria Paz", "Ana Dia", "João Vida"): UMA só passa;
 * duas ou mais ("Bom dia", "Boa tarde", "Paz e luz" já cai no "e") é frase.
 */
const PALAVRAS_FRACAS = new Set(['bom', 'boa', 'dia', 'tarde', 'noite', 'paz', 'vida', 'fé', 'fe', 'bem', 'amor', 'luz']);

const VOGAL = /[aeiouyáéíóúâêôãõàü]/i;
/** Letras (qualquer alfabeto), marca de acento, e só hífen/apóstrofo dentro da palavra. Nada de dígito, ponto, emoji. */
const PALAVRA_VALIDA = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u;

function capitalizar(palavra: string, primeira: boolean): string {
  const baixa = palavra.toLocaleLowerCase('pt-BR');
  if (!primeira && PARTICULAS.has(baixa)) return baixa;
  // só mexe em palavra toda minúscula ou toda maiúscula; "McDonald" e "DeSouza" ficam como a pessoa escreveu
  if (palavra !== baixa && palavra !== palavra.toLocaleUpperCase('pt-BR')) return palavra;
  return baixa.replace(/(^|['’-])(\p{L})/gu, (_m, sep: string, letra: string) => sep + letra.toLocaleUpperCase('pt-BR'));
}

/**
 * O nome do contato, arrumado, SE tiver cara de nome de gente; senão `null` (e o lead vira "Lead dd/mm/aa").
 * Letras, 1 a 4 palavras, cada palavra com 2+ letras e uma vogal, sem número/emoji/pontuação de frase, sem palavra
 * de frase ou de empresa, sem letra repetida 3 vezes seguidas ("Aaaana", "kkkk").
 */
export function nomeDeGente(bruto: string | null | undefined): string | null {
  const s = String(bruto ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return null;
  const palavras = s.split(' ');
  if (palavras.length < 1 || palavras.length > 4) return null;
  for (const p of palavras) {
    if (!PALAVRA_VALIDA.test(p)) return null;
    const letras = p.replace(/[^\p{L}\p{M}]/gu, '');
    if (letras.length < 2 && !PARTICULAS.has(p.toLocaleLowerCase('pt-BR'))) return null;
    if (!VOGAL.test(p)) return null;
    if (/(\p{L})\1\1/iu.test(p)) return null;
    if (PALAVRAS_DE_FORA.has(p.toLocaleLowerCase('pt-BR'))) return null;
  }
  if (palavras.filter((p) => PALAVRAS_FRACAS.has(p.toLocaleLowerCase('pt-BR'))).length >= 2) return null;
  // nome que é só partícula ("De Da") ou começa/termina nela não é nome
  const primeira = palavras[0].toLocaleLowerCase('pt-BR');
  const ultima = palavras[palavras.length - 1].toLocaleLowerCase('pt-BR');
  if (PARTICULAS.has(primeira) || PARTICULAS.has(ultima)) return null;
  return palavras.map((p, i) => capitalizar(p, i === 0)).join(' ');
}

/**
 * O que a franquia diz do telefone do cartão. `pacientes` = nomes dos pacientes cadastrados com este telefone (mais de um =
 * mãe e filha no mesmo número). `indisponivel` = não deu para saber (franquia fora do ar, índice ainda não montado): o robô
 * espera a próxima rodada em vez de decidir às cegas.
 */
export type NomesNaFranquia =
  | { tipo: 'pacientes'; nomes: string[] }
  | { tipo: 'nenhum' }
  | { tipo: 'indisponivel'; motivo: string };

/**
 * O nome do paciente como a franquia cadastrou, arrumado para título de cartão: só letras (sem número/emoji/pontuação), com
 * a capitalização normal e, se for comprido (mais de 3 palavras de verdade), "Primeiro Último". `null` se não parece nome.
 */
export function nomeDaFranquia(bruto: string | null | undefined): string | null {
  const s = String(bruto ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 80) return null;
  const palavras = s.split(' ');
  for (const p of palavras) {
    if (!PALAVRA_VALIDA.test(p) || !VOGAL.test(p)) return null;
  }
  const significativas = palavras.filter((p) => !PARTICULAS.has(p.toLocaleLowerCase('pt-BR')));
  if (significativas.length === 0) return null;
  // cabe no cartão: até 4 palavras com no máximo 3 de verdade ("Alex Sandre da Silva"); mais que isso, "Primeiro Último"
  const escolhidas = palavras.length > 4 || significativas.length > 3 ? [significativas[0], significativas[significativas.length - 1]] : palavras;
  if (escolhidas.length === 1 && escolhidas[0].replace(/[^\p{L}]/gu, '').length < 2) return null;
  return escolhidas.map((p, i) => capitalizar(p, i === 0)).join(' ');
}

/** Pedaços de nome que servem para comparar (sem acento, 3+ letras, sem "da/de/do"). */
function palavrasDoNome(nome: string): string[] {
  return normalizar(nome).split(' ').filter((p) => p.length >= 2 && !PARTICULAS.has(p));
}

/**
 * O nome do contato está CONTIDO no do paciente ("Alex" ⊂ "Alex Sandre"; "Lucilene Coelho" ⊂ "Lucilene Coelho Sendra")? Todas as
 * palavras do contato têm de estar no cadastro, sem acento/caixa e sem "da/de/do". Sobrenome em comum NÃO basta (a mãe "Maria
 * Silva" escrevendo pela filha "Ana Silva"), nem o primeiro nome composto ("Maria Eduarda" × "Maria Clara Souza"), e o contato
 * mais completo que o cadastro ("Alex Sandre Silva" × "Alex") fica com o do contato. Contato com um nome só ("Maria") não
 * distingue "Maria Clara" da mãe — esse é o limite do que dá para conferir sem a pessoa.
 */
export function nomesCompativeis(doContato: string, doPaciente: string): boolean {
  const a = palavrasDoNome(doContato);
  const b = new Set(palavrasDoNome(doPaciente));
  return a.length > 0 && a.every((p) => b.has(p));
}

export type FonteDoNome = 'franquia' | 'contato';

export interface EscolhaDeNome {
  nome: string;
  fonte: FonteDoNome;
  /** frase curta para o log e para a lista "o que ela faria" (sem telefone) */
  motivo: string;
}

/**
 * Qual nome o cartão leva e, quando a franquia foi posta de lado, por quê. Ordem pedida pela clínica:
 *  (a) o paciente da franquia — só quando é UM paciente no telefone E o contato tem nome de pessoa contido no cadastro
 *      (traz o nome inteiro: "Alex" → "Alex Sandre"). O índice guarda um cadastro por telefone, então "mãe e filha no mesmo
 *      número" não aparece lá; o nome diferente é o único sinal, e SEM nome de pessoa no contato não há como
 *      conferir — nesse caso a franquia NÃO é usada (o palpite viraria o nome de outra pessoa no cartão);
 *  (b) o nome do contato do WhatsApp, se tiver cara de nome de gente.
 * `escolha` null = nenhum serve; `nota` explica o que foi deixado de lado.
 */
export function resolverNome(nomeDoContato: string | null | undefined, franquia: NomesNaFranquia | null | undefined): { escolha: EscolhaDeNome | null; nota: string } {
  const doContato = nomeDeGente(nomeDoContato);
  let nota = '';
  if (franquia?.tipo === 'pacientes') {
    const vistos = new Set<string>();
    const nomes = franquia.nomes.filter((n) => {
      const k = normalizar(n);
      if (!k || vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    if (nomes.length > 1) {
      nota = `${nomes.length} pacientes no mesmo telefone na franquia, não usei a franquia`;
    } else if (nomes.length === 1) {
      const doPaciente = nomeDaFranquia(nomes[0]);
      if (!doPaciente) nota = 'o cadastro da franquia não tem nome utilizável';
      else if (!doContato) nota = 'há paciente da franquia neste telefone, mas o contato não tem nome de pessoa para conferir — não usei a franquia';
      else if (nomesCompativeis(doContato, doPaciente)) return { escolha: { nome: doPaciente, fonte: 'franquia', motivo: 'paciente da franquia achado pelo telefone, confere com o contato' }, nota: '' };
      else nota = 'o paciente da franquia tem outro nome que o contato, não usei a franquia';
    }
  }
  if (doContato) return { escolha: { nome: doContato, fonte: 'contato', motivo: nota ? `nome do contato; ${nota}` : 'nome do contato' }, nota };
  return { escolha: null, nota };
}

export interface EntradaRenomeacao {
  /** nome atual do lead no Kommo */
  nomeDoLead: string | null | undefined;
  /** nome do contato principal (o do perfil do WhatsApp), ou null se o contato não tem nome / não foi lido */
  nomeDoContato: string | null | undefined;
  /** o que a franquia diz do telefone (omitido = a unidade não consulta a franquia) */
  franquia?: NomesNaFranquia | null;
  /** dd/mm/aa do dia da criação, no fuso da unidade */
  data: string;
  /** nomes de OUTROS leads da unidade (para a numeração do "Lead N dd/mm/aa" do dia) */
  nomesDoDia: readonly string[];
}

export type PlanoDeRenomeacao =
  /** vira "Nome dd/mm/aa" */
  | { tipo: 'nome'; para: string; fonte: FonteDoNome; motivo: string }
  /** vem do Kommo ("Lead #123") e nada serviu: vira "Lead dd/mm/aa" */
  | { tipo: 'lead'; para: string; motivo: string }
  /** já era um título genérico e nada serviu: fica como está (nunca troca genérico por genérico) */
  | { tipo: 'deixa'; para: null; motivo: string };

/** O que o lead deve passar a se chamar, ou `null` se não é para mexer (a SDR já deu nome). */
export function planejarRenomeacao(e: EntradaRenomeacao): PlanoDeRenomeacao | null {
  if (!ehTituloGenerico(e.nomeDoLead)) return null;
  const { escolha, nota } = resolverNome(e.nomeDoContato, e.franquia);
  if (escolha) return { tipo: 'nome', para: `${escolha.nome} ${e.data}`, fonte: escolha.fonte, motivo: escolha.motivo };
  const bruto = String(e.nomeDoContato ?? '').trim();
  const motivo = [!bruto || bruto === '-' ? 'contato sem nome' : 'nome do contato não parece nome de pessoa', nota].filter(Boolean).join('; ');
  // "Lead N dd/mm/aaaa" do titulo-padrao e "Lead N dd/mm/aa" nosso são do mesmo dia e da mesma numeração
  if (ehSemNome(e.nomeDoLead)) return { tipo: 'lead', para: montarTituloPadrao(e.data, e.nomesDoDia.map(aDataCurta)), motivo };
  return { tipo: 'deixa', para: null, motivo: `${motivo}; o título genérico fica como está` };
}

/**
 * Janela por unidade para alcançar o estoque (cartões com mais de 24 h): `RENOMEAR_LEAD_DESDE` = `slug=AAAA-MM-DD,outro=AAAA-MM-DD`.
 * Devolve o instante (epoch s) em que começa esse dia no fuso da unidade, ou `null` (unidade fora da lista, data inválida,
 * no futuro ou mais velha que `MAX_DIAS_DE_ESTOQUE`: o padrão de 24 h vale).
 */
export const MAX_DIAS_DE_ESTOQUE = 30;
export function desdeDaUnidade(slug: string, raw: string | undefined, tz: string, agora: number): number | null {
  for (const par of (raw ?? '').replace(/^['"]|['"]$/g, '').split(',')) {
    const [s, d] = par.split('=').map((x) => x.trim());
    if (s !== slug || !d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const fuso = fusoValido(tz) ? tz : FUSO_PADRAO;
    // meia-noite local do dia pedido: parte de 12:00 UTC (o dia local é o mesmo em qualquer fuso do Brasil) e volta ao início do dia
    const ms = Date.parse(`${d}T12:00:00Z`);
    // o V8 aceita 31/02 e devolve março: dia que não existe é erro de digitação, não "outro dia"
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== d) continue;
    const meioDia = ms / 1000;
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(meioDia * 1000));
    const [h, m] = hhmm.split(':').map(Number);
    const epoch = meioDia - (h * 3600 + m * 60);
    if (epoch > agora || agora - epoch > MAX_DIAS_DE_ESTOQUE * 86_400) return null;
    return epoch;
  }
  return null;
}

/** Estados da automação, do mais fraco ao mais forte — para decidir por cartão sem dono. */
export type EstadoDaChave = Estado;
const FORCA: Record<EstadoDaChave, number> = { desligado: 0, seco: 1, ligado: 2 };

/** O mais fraco dos estados: cartão sem unidade só é renomeado de verdade se TODAS as unidades da conta estiverem ligadas. */
export function estadoMaisFraco(estados: readonly EstadoDaChave[]): EstadoDaChave {
  if (!estados.length) return 'desligado';
  return estados.reduce((a, b) => (FORCA[b] < FORCA[a] ? b : a));
}

export interface DonoDaRenomeacao {
  /** a unidade dona do cartão (pelo ⌂ Unidade de atendimento); null = cartão sem unidade ou Kommo de uma unidade só */
  dono: { id: string; slug: string } | null;
  estado: EstadoDaChave;
}

/**
 * Qual chave vale para ESTE cartão. Kommo de uma unidade só: a dela. Kommo dividido (Petrópolis + Caxias): a da
 * unidade do ⌂ Unidade de atendimento do cartão; cartão SEM unidade (o robô do canal ainda não passou, ou a SDR
 * ainda não escolheu) ou com unidade que ninguém usa vale a mais fraca das chaves do grupo — só renomeia de
 * verdade quando as duas estão ligadas. O nome do cartão não é identidade da unidade (ao contrário de escrever na
 * franquia), por isso o cartão sem unidade também é renomeado, e não fica sem nome até a SDR escolher.
 */
export function estadoDoCartao(
  membros: ReadonlyArray<MembroDoCrm> | null,
  estadoPorSlug: (slug: string) => EstadoDaChave,
  unidadeDoCartao: string | null,
  contaUnit: { id: string; slug: string },
): DonoDaRenomeacao {
  if (!membros || membros.length === 0) return { dono: null, estado: estadoPorSlug(contaUnit.slug) };
  const dono = unidadeDoCartao ? (membros.find((m) => normalizar(m.rotulo) === normalizar(unidadeDoCartao)) ?? null) : null;
  if (dono?.slug) return { dono: { id: dono.unitId, slug: dono.slug }, estado: estadoPorSlug(dono.slug) };
  const slugs = membros.map((m) => m.slug).filter((s): s is string => !!s);
  return { dono: null, estado: estadoMaisFraco(slugs.map(estadoPorSlug)) };
}
