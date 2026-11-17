/**
 * A CAIXA e os MODELOS, lidos do Chatwoot da conta da unidade (a mesma fonte que a régua usa: `inboxes/:id/message_templates`).
 *
 * A regra que não se negocia: só manda por caixa `Channel::Whatsapp` (WhatsApp oficial). A «Clínica Demonstração» (conta 2, caixa 6) é um
 * canal de API registrado como «cloud» na configuração: o tipo gravado em `unit_chatwoot_caixa` NÃO basta, o Chatwoot é quem diz o canal de verdade.
 */
import { chamar, type ContextoChatwoot } from '../../../mcp-remoto/chatwoot.js';
import { mesmoTexto, problemaNoModelo } from '../regras.js';
import { logger } from '../../logger.js';

export const CANAL_WHATSAPP = 'Channel::Whatsapp';

export type CaixaOficial = { ok: true; nome: string; provedor: string | null } | { ok: false; motivo: string };

/** A caixa existe nesta conta e é WhatsApp oficial? Lança se não deu para ler (quem chama trata como «adiar», nunca como «sim»). */
export async function caixaWhatsappOficial(ctx: ContextoChatwoot, caixa: number): Promise<CaixaOficial> {
  const r = (await chamar(ctx, 'GET', 'inboxes')) as { payload?: unknown[] } | null;
  const lista = Array.isArray(r?.payload) ? (r.payload as Array<{ id?: unknown; name?: unknown; channel_type?: unknown; provider?: unknown }>) : [];
  const c = lista.find((x) => Number(x?.id) === caixa);
  if (!c) return { ok: false, motivo: `a caixa ${caixa} não existe nesta conta do CRM` };
  if (c.channel_type !== CANAL_WHATSAPP) {
    return { ok: false, motivo: `a caixa ${caixa} é do canal ${String(c.channel_type ?? 'desconhecido')}, não WhatsApp oficial (${CANAL_WHATSAPP}): o disparo não sai por ela` };
  }
  return { ok: true, nome: String(c.name ?? `caixa ${caixa}`).slice(0, 80), provedor: typeof c.provider === 'string' ? c.provider : null };
}

/** Um modelo APROVADO da caixa, já lido para a tela. */
export interface ModeloDaCaixa {
  nome: string;
  idioma: string;
  categoria: string | null;
  /** `true` = o CRM não informou a categoria e ela foi ASSUMIDA como marketing (a mais cara): vale para o preço, mas não prova reclassificação */
  categoriaAssumida?: boolean;
  /** o corpo, com {{1}}, {{2}}… */
  texto: string;
  /** quantas variáveis o corpo pede (0 = nenhuma) */
  variaveis: number;
  cabecalho: string | null;
  rodape: string | null;
  botoes: string[];
  /** por que NÃO dá para disparar este modelo, ou `null` se dá */
  problema: string | null;
}

interface ComponenteCru {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
}

/** Só corpo com variáveis numéricas em ordem: é o que o Chatwoot sabe preencher (`processed_params.body`). */
export function modeloDaCaixa(cru: { name?: unknown; language?: unknown; status?: unknown; category?: unknown; components?: unknown }): ModeloDaCaixa | null {
  if (String(cru.status ?? '').toUpperCase() !== 'APPROVED') return null;
  const nome = String(cru.name ?? '');
  if (!/^[a-z0-9_]{1,512}$/.test(nome)) return null;
  const comps = (Array.isArray(cru.components) ? cru.components : []) as ComponenteCru[];
  const corpo = comps.find((c) => String(c?.type).toUpperCase() === 'BODY')?.text;
  if (typeof corpo !== 'string' || !corpo.trim()) return null;
  const cab = comps.find((c) => String(c?.type).toUpperCase() === 'HEADER');
  const formato = String(cab?.format ?? '').toUpperCase();
  const rodape = comps.find((c) => String(c?.type).toUpperCase() === 'FOOTER')?.text;
  const botoes = comps.find((c) => String(c?.type).toUpperCase() === 'BUTTONS')?.buttons ?? [];
  const usados = [...corpo.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]!);
  const numeros = [...new Set(usados)];
  let problema: string | null = null;
  if (numeros.some((n) => !/^\d+$/.test(n))) problema = 'variável com nome (não numerada): o CRM só preenche {{1}}, {{2}}…';
  else if (cab && formato && formato !== 'TEXT') problema = `o modelo tem cabeçalho de ${formato.toLowerCase()} (mídia): esta tela ainda só manda modelos de texto`;
  else if (cab && /\{\{/.test(cab.text ?? '')) problema = 'o cabeçalho do modelo tem variável: esta tela ainda não preenche cabeçalho';
  else if (botoes.some((b) => /\{\{/.test(b.url ?? '') || ['COPY_CODE', 'OTP', 'FLOW', 'MPM', 'CATALOG'].includes(String(b.type).toUpperCase()))) problema = 'o modelo tem botão que pede parâmetro: esta tela ainda não preenche botões';
  else {
    const ordem = numeros.map(Number).sort((a, b) => a - b);
    if (ordem.some((n, i) => n !== i + 1)) problema = 'as variáveis do modelo não são {{1}}, {{2}}… em ordem';
  }
  return {
    nome,
    idioma: String(cru.language ?? ''),
    categoria: categoriaDoCrm(nome, cru.category),
    categoriaAssumida: !(typeof cru.category === 'string' && cru.category.trim()),
    texto: corpo,
    variaveis: numeros.length,
    cabecalho: cab && formato === 'TEXT' && typeof cab.text === 'string' ? cab.text : null,
    rodape: typeof rodape === 'string' ? rodape : null,
    botoes: botoes.map((b) => String(b.text ?? b.type ?? '').slice(0, 40)).filter(Boolean),
    problema,
  };
}

/** Modelos cuja categoria o CRM não informou, já logados (uma vez por nome): o aviso não se repete a cada leitura da caixa. */
const SEM_CATEGORIA_LOGADOS = new Set<string>();
export const CATEGORIA_QUANDO_O_CRM_NAO_DIZ = 'MARKETING';

/**
 * A categoria do modelo (marketing, utilidade, autenticação): o preço e o teto de gasto dependem dela. O CRM sem categoria NÃO vira «desconhecida» nem some da
 * conferência: é tratado como MARKETING (a mais cara) de forma explícita, e logado.
 */
function categoriaDoCrm(nome: string, crua: unknown): string {
  if (typeof crua === 'string' && crua.trim()) return crua.trim().toUpperCase();
  if (!SEM_CATEGORIA_LOGADOS.has(nome)) {
    SEM_CATEGORIA_LOGADOS.add(nome);
    logger.warn({ modelo: nome }, `disparo-crm: o CRM não informou a categoria do modelo — tratado como ${CATEGORIA_QUANDO_O_CRM_NAO_DIZ} (a mais cara)`);
  }
  return CATEGORIA_QUANDO_O_CRM_NAO_DIZ;
}

/** Os modelos APROVADOS da caixa, como o Chatwoot os guarda (lança se não deu para ler). */
export async function modelosDaCaixa(ctx: ContextoChatwoot, caixa: number): Promise<ModeloDaCaixa[]> {
  const r = (await chamar(ctx, 'GET', `inboxes/${caixa}/message_templates`)) as { payload?: unknown[] } | null;
  const lista = Array.isArray(r?.payload) ? r.payload : [];
  const vistos = new Set<string>();
  const modelos: ModeloDaCaixa[] = [];
  for (const cru of lista) {
    const m = modeloDaCaixa((cru ?? {}) as never);
    if (!m || vistos.has(`${m.nome}|${m.idioma}`)) continue;
    vistos.add(`${m.nome}|${m.idioma}`);
    modelos.push(m);
  }
  return modelos.sort((a, b) => a.nome.localeCompare(b.nome));
}

/** Como o modelo aparece no WhatsApp além do corpo: só para a tela mostrar (não entra no envio nem no que é gravado). */
export type ApresentacaoDoModelo = { cabecalho: string | null; rodape: string | null; botoes: string[] };
/** `transitorio`: não deu para LER o CRM (não é um defeito do modelo): quem chama tenta de novo, não pausa nem cancela nada. */
export type ConferenciaDoModelo = { ok: true; /** do MESMO modelo já lido na conferência (sem nova chamada ao CRM) */ modelo?: ApresentacaoDoModelo } | { ok: false; motivo: string; transitorio?: true; /** a categoria que o CRM tem agora, quando foi ela que mudou */ categoriaNova?: string };

/**
 * O modelo que a onda vai mandar ainda está aprovado na caixa, com o MESMO texto que a pessoa viu e aprovou? Roda na montagem, na aprovação
 * e antes de cada rodada de envio: a Meta pode pausar ou reprovar um modelo depois de aprovado.
 */
export async function conferirModeloDaOnda(
  ctx: ContextoChatwoot,
  caixa: number,
  def: { template: string; idioma: string; textoModelo: string; variaveis: string[]; categoria?: string | null; categoriaAssumida?: boolean },
): Promise<ConferenciaDoModelo> {
  let modelos: ModeloDaCaixa[];
  try {
    const oficial = await caixaWhatsappOficial(ctx, caixa);
    if (!oficial.ok) return oficial;
    modelos = await modelosDaCaixa(ctx, caixa);
  } catch (err) {
    return { ok: false, transitorio: true, motivo: `não consegui ler a caixa/modelos no CRM agora (${err instanceof Error ? err.message.slice(0, 120) : 'erro'}); tente de novo` };
  }
  const m = modelos.find((x) => x.nome === def.template && x.idioma === def.idioma);
  if (!m) return { ok: false, motivo: `o modelo ${def.template} (${def.idioma}) não está aprovado nesta caixa` };
  if (m.problema) return { ok: false, motivo: m.problema };
  if (!mesmoTexto(m.texto, def.textoModelo)) return { ok: false, motivo: `o texto do modelo no CRM mudou desde que você o escolheu. No CRM agora: "${m.texto.slice(0, 200)}"` };
  // A CATEGORIA congelada na montagem (marketing, utilidade…): o custo e o teto de gasto foram calculados com ela. A Meta pode RECLASSIFICAR um modelo depois de aprovado
  // (utilidade → marketing custa ~8× mais): se mudou, a onda não segue precificada errada — pausa, como quando o texto muda.
  // (a categoria da ONDA assumida como marketing, ou a do CRM assumida desta vez, não prova reclassificação: só compara quando as DUAS são informadas)
  if (def.categoria && !def.categoriaAssumida && m.categoria && !m.categoriaAssumida && def.categoria.trim().toUpperCase() !== m.categoria.trim().toUpperCase()) {
    return { ok: false, categoriaNova: m.categoria.toUpperCase(), motivo: `a Meta mudou a categoria do modelo de ${def.categoria.toUpperCase()} para ${m.categoria.toUpperCase()}: o custo do disparo mudou. Monte o disparo de novo para ver o custo certo` };
  }
  const p = problemaNoModelo(def.textoModelo, def.variaveis);
  return p ? { ok: false, motivo: p } : { ok: true, modelo: { cabecalho: m.cabecalho, rodape: m.rodape, botoes: m.botoes } };
}
