/**
 * O MODELO que vai sair: qual template, com qual cabeçalho, com que texto — e a prova de que o que o João
 * aprova é o que a Meta tem.
 *
 * O texto do modelo mora na Meta; o nosso é uma cópia (para a tela mostrar o texto final antes de sair). Cópia pode
 * divergir, então na hora de APROVAR a gente pergunta à Meta e recusa se o modelo não está APROVADO lá, se o texto
 * mudou, ou se o cabeçalho de mídia não bate — o erro de 14/10 (modelo só texto + arte anexada → Araguaína 22/22 e
 * Porto 11/11 recusados) não pode voltar.
 */
import { createHash } from 'node:crypto';
import type { Unit } from '@prisma/client';
import { credenciaisDaUnidade, urlDaGraph, type CabecalhoDeMidia } from '../whatsapp-meta.js';
import { mesmoTexto } from './regras.js';

export interface Definicao {
  template: string;
  idioma: string;
  textoModelo: string;
  variaveis: string[];
  cabecalho: CabecalhoDeMidia | null;
  /** a oferta que a Sofia lê de quem recebe (copiada da campanha na montagem); fora do que a Meta confere */
  oferta?: string | null;
}

interface CampanhaDefinida {
  template: string | null;
  idioma: string;
  textoModelo: string;
  variaveis: unknown;
  cabecalho: unknown;
  porUnidade: unknown;
  oferta?: string | null;
}

const TIPOS_DE_MIDIA = ['image', 'video', 'document'] as const;

function comoCabecalho(v: unknown): CabecalhoDeMidia | null {
  if (!v || typeof v !== 'object') return null;
  const { tipo, link, nomeArquivo } = v as Record<string, unknown>;
  if (typeof tipo !== 'string' || !(TIPOS_DE_MIDIA as readonly string[]).includes(tipo)) return null;
  if (typeof link !== 'string' || !/^https:\/\//.test(link)) return null;
  return { tipo: tipo as CabecalhoDeMidia['tipo'], link, ...(typeof nomeArquivo === 'string' && nomeArquivo ? { nomeArquivo } : {}) };
}

/** O que vale para esta unidade: o que a campanha define para ela, senão o padrão da campanha. */
export function definicaoParaAUnidade(c: CampanhaDefinida, unitSlug: string): Definicao | { erro: string } {
  const propria = ((c.porUnidade ?? {}) as Record<string, { template?: unknown; cabecalho?: unknown }>)[unitSlug] ?? {};
  const template = typeof propria.template === 'string' && propria.template.trim() ? propria.template.trim() : c.template?.trim() || '';
  if (!template) return { erro: `a campanha não tem modelo para a unidade ${unitSlug}` };
  const bruto = 'cabecalho' in propria ? propria.cabecalho : c.cabecalho;
  const cabecalho = bruto == null ? null : comoCabecalho(bruto);
  if (bruto != null && !cabecalho) return { erro: 'cabeçalho inválido (precisa de tipo image|video|document e link https)' };
  const variaveis = Array.isArray(c.variaveis) ? (c.variaveis as unknown[]).map(String) : [];
  return { template, idioma: c.idioma, textoModelo: c.textoModelo, variaveis, cabecalho, ...(c.oferta?.trim() ? { oferta: c.oferta.trim() } : {}) };
}

/** A impressão digital do que o João vê: modelo, texto, variáveis, a oferta que a Sofia vai saber e cada pessoa com o nome que vai na saudação. */
export function impressaoDaOnda(def: Definicao, pessoas: ReadonlyArray<{ chave: string; nome: string }>): string {
  const ordenadas = [...pessoas].sort((a, b) => a.chave.localeCompare(b.chave)).map((p) => `${p.chave}:${p.nome}`);
  return createHash('sha256').update(JSON.stringify([def.template, def.idioma, def.textoModelo, def.variaveis, def.cabecalho, ordenadas, ...(def.oferta ? [def.oferta] : [])])).digest('hex');
}

/**
 * Quem pode aprovar: só os e-mails de `DISPARO_APROVADORES`. Sem a variável NINGUÉM aprova — o login do console é
 * compartilhado (o João, a chefe e as sessões do Claude), e "qualquer super-admin" seria o robô se aprovando.
 */
export function podeAprovar(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const lista = (env.DISPARO_APROVADORES ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!email && lista.includes(email.trim().toLowerCase());
}

interface ComponenteDaMeta {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; url?: string }>;
}
interface ModeloDaMeta {
  name?: string;
  language?: string;
  status?: string;
  components?: ComponenteDaMeta[];
}

export type Busca = (url: string, token: string) => Promise<{ ok: boolean; corpo: unknown }>;

const buscaPadrao: Busca = async (url, token) => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  return { ok: r.ok, corpo: await r.json().catch(() => null) };
};

/** O que a Meta tem hoje bate com o que vamos mandar? `motivo` diz o que não bate. */
export function compararComAMeta(def: Definicao, modelos: ModeloDaMeta[]): { ok: true } | { ok: false; motivo: string } {
  const m = modelos.find((x) => x.name === def.template && x.language === def.idioma);
  if (!m) return { ok: false, motivo: `a Meta não tem o modelo ${def.template} em ${def.idioma} nesta conta` };
  if (m.status !== 'APPROVED') return { ok: false, motivo: `o modelo ${def.template} está ${m.status ?? 'sem status'} na Meta (precisa estar APPROVED)` };
  const cs = m.components ?? [];
  const corpo = cs.find((c) => c.type === 'BODY');
  if (!corpo?.text || !mesmoTexto(corpo.text, def.textoModelo)) {
    return { ok: false, motivo: `o texto do modelo na Meta é diferente do cadastrado na campanha. Na Meta: "${corpo?.text ?? ''}"` };
  }
  const cab = cs.find((c) => c.type === 'HEADER');
  const formato = (cab?.format ?? '').toLowerCase();
  const temMidia = (TIPOS_DE_MIDIA as readonly string[]).includes(formato);
  if (cab && !temMidia && /\{\{/.test(cab.text ?? '')) return { ok: false, motivo: 'cabeçalho de texto com variável não é suportado neste disparo' };
  if (temMidia && !def.cabecalho) return { ok: false, motivo: `o modelo tem cabeçalho de ${formato} e a campanha não definiu a mídia (a Meta recusa o envio sem ela)` };
  if (!temMidia && def.cabecalho) return { ok: false, motivo: 'a campanha define mídia no cabeçalho, mas o modelo aprovado não tem (a Meta recusa o envio)' };
  if (temMidia && def.cabecalho && def.cabecalho.tipo !== formato) return { ok: false, motivo: `o cabeçalho do modelo é ${formato} e a campanha manda ${def.cabecalho.tipo}` };
  const botoes = cs.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  if (botoes.some((b) => /\{\{/.test(b.url ?? ''))) return { ok: false, motivo: 'botão com variável na URL não é suportado neste disparo' };
  return { ok: true };
}

/** Pergunta à Meta (conta WABA da unidade) e compara. Sem o WABA id ou sem resposta: recusa — na dúvida, não aprova. */
export async function conferirModeloNaMeta(
  unit: Pick<Unit, 'metaWabaId' | 'metaPhoneNumberId' | 'metaAccessToken'>,
  def: Definicao,
  buscar: Busca = buscaPadrao,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const cred = credenciaisDaUnidade(unit);
  if (!cred) return { ok: false, motivo: 'a unidade não tem credencial da Meta (phone number id e token)' };
  const waba = unit.metaWabaId?.trim();
  if (!waba) return { ok: false, motivo: 'a unidade não tem o WABA id cadastrado; sem ele não dá para conferir o modelo na Meta' };
  const url = urlDaGraph(`${waba}/message_templates?name=${encodeURIComponent(def.template)}&fields=name,status,language,components&limit=50`);
  try {
    const r = await buscar(url, cred.token);
    const dados = (r.corpo as { data?: ModeloDaMeta[] } | null)?.data;
    if (!r.ok || !Array.isArray(dados)) return { ok: false, motivo: 'a Meta não respondeu à consulta do modelo; tente de novo' };
    return compararComAMeta(def, dados);
  } catch (err) {
    return { ok: false, motivo: `consulta do modelo na Meta falhou: ${err instanceof Error ? err.message : String(err)}` };
  }
}
