/**
 * Renomeia o lead novo de Petrópolis e Caxias — robô de REGRA FIXA, sem IA (a chefe não quer IA lá).
 *
 * Por que existe (medido em 26/10/2026): em 3 dias as SDRs renomearam 66 leads à mão, sempre no formato
 * "Nome dd/mm/aa" (ano com 2 dígitos), data = dia em que o lead foi criado. O Kommo dessa conta não manda
 * mensagem para o agente (0 execution_traces em 7 dias), então o `titulo-padrao` — que roda no webhook de
 * mensagem — nunca acorda. Este módulo só decide; quem varre os leads recentes é o `renomear-lead-worker`.
 *
 * Regras:
 *  1. Só mexe em lead cujo nome ainda é o do Kommo ("Lead #123", vazio): `ehSemNome`. Nome que a SDR deu nunca é tocado.
 *  2. Nome do contato com cara de nome de gente → "Nome dd/mm/aa". Senão → "Lead dd/mm/aa" ("Lead 2 dd/mm/aa" pro
 *     segundo sem nome do dia, a mesma numeração do `titulo-padrao`).
 *  3. Na dúvida, "Lead dd/mm/aa": errar para o genérico custa uma renomeada da SDR; gravar lixo ("Deus é Deus") custa
 *     um cartão que parece nomeado e ninguém mais revisa.
 */
import { ehSemNome, montarTituloPadrao } from './titulo-padrao.js';
import { normalizar } from './franquia-sync.js';
import type { MembroDoCrm } from './crm-compartilhado.js';

export { ehSemNome };

/** dd/mm/aa no fuso informado (o ano com 2 dígitos é o jeito das SDRs de Petrópolis). */
export function dataCurta(epochS: number, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: '2-digit' }).format(new Date(epochS * 1000));
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
  'meu', 'minha', 'seu', 'sua', 'sou', 'tem', 'foi', 'vai', 'sempre', 'obrigado', 'obrigada', 'bom', 'boa', 'dia', 'tarde', 'noite',
  'deus', 'senhor', 'senhora', 'fiel', 'abençoado', 'abencoado', 'abençoada', 'abencoada', 'amém', 'amem', 'gratidão', 'gratidao', 'paz', 'fé', 'fe', 'vida',
  'lead', 'contato', 'cliente', 'paciente', 'usuario', 'usuário', 'whatsapp', 'unknown', 'desconhecido', 'anonimo', 'anônimo', 'nome', 'sem-nome',
  'doutor', 'doutora', 'dr', 'dra', 'clinica', 'clínica', 'hernia', 'hérnia', 'consultorio', 'consultório', 'loja', 'oficial', 'vendas', 'atendimento', 'suporte', 'empresa', 'studio', 'estudio', 'estúdio',
]);

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
  // nome que é só partícula ("De Da") ou começa/termina nela não é nome
  const primeira = palavras[0].toLocaleLowerCase('pt-BR');
  const ultima = palavras[palavras.length - 1].toLocaleLowerCase('pt-BR');
  if (PARTICULAS.has(primeira) || PARTICULAS.has(ultima)) return null;
  return palavras.map((p, i) => capitalizar(p, i === 0)).join(' ');
}

export interface EntradaRenomeacao {
  /** nome atual do lead no Kommo */
  nomeDoLead: string | null | undefined;
  /** nome do contato principal (o do perfil do WhatsApp), ou null se o contato não tem nome / não foi lido */
  nomeDoContato: string | null | undefined;
  /** dd/mm/aa do dia da criação, no fuso da unidade */
  data: string;
  /** nomes de OUTROS leads da unidade (para a numeração do "Lead N dd/mm/aa" do dia) */
  nomesDoDia: readonly string[];
}

export interface PlanoDeRenomeacao {
  para: string;
  /** 'nome' = nome de gente do contato; 'lead' = não deu, vai "Lead dd/mm/aa" */
  tipo: 'nome' | 'lead';
  motivo: string;
}

/** O que o lead deve passar a se chamar, ou `null` se não é para mexer (a SDR já deu nome, ou já está igual). */
export function planejarRenomeacao(e: EntradaRenomeacao): PlanoDeRenomeacao | null {
  if (!ehSemNome(e.nomeDoLead)) return null;
  const nome = nomeDeGente(e.nomeDoContato);
  if (nome) return { para: `${nome} ${e.data}`, tipo: 'nome', motivo: 'nome do contato' };
  const bruto = String(e.nomeDoContato ?? '').trim();
  const motivo = !bruto || bruto === '-' ? 'contato sem nome' : 'nome do contato não parece nome de pessoa';
  return { para: montarTituloPadrao(e.data, [...e.nomesDoDia]), tipo: 'lead', motivo };
}

/** Estados da automação, do mais fraco ao mais forte — para decidir por cartão sem dono. */
export type EstadoDaChave = 'ligado' | 'seco' | 'desligado';
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
