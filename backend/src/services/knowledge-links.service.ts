import { ChatOpenAI } from '@langchain/openai';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resolveOpenAIApiKey } from './openai.service.js';
import { createKnowledge } from './knowledge.service.js';

const MAX_TEXTO_CHARS = 40_000;
const MIN_TEXTO_CHARS = 200;
const MAX_ENTRIES_POR_LINK = 8;
const FETCH_TIMEOUT_MS = 15_000;
const DISTILL_MODEL = 'gpt-4o-mini';

export type TipoLink = 'video' | 'avaliacao' | 'artigo' | 'pagina';

export function ehPlaylistYoutube(url: string): boolean {
  return /youtube\.com\/playlist|[?&]list=/.test(url);
}

export function extrairVideoIdsYoutube(html: string, max = 8): string[] {
  const ids: string[] = [];
  const vistos = new Set<string>();
  const re = /"videoId":"([A-Za-z0-9_-]{11})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && ids.length < max) {
    if (!vistos.has(m[1])) {
      vistos.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

export function detectarTipo(url: string): TipoLink {
  const u = url.toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'video';
  if (/google\.[a-z.]+\/maps|maps\.app\.goo\.gl|g\.co\/|share\.google/.test(u)) return 'avaliacao';
  if (/scielo|pubmed|ncbi\.nlm|doi\.org|sciencedirect|arxiv|springer|nature\.com|thelancet|nejm|bmj\.com|jospt/.test(u)) {
    return 'artigo';
  }
  return 'pagina';
}

export function urlPermitida(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return true;
}

export function extrairTextoHtml(html: string): { titulo: string | null; texto: string } {
  const tituloMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const titulo = tituloMatch ? decodeEntities(tituloMatch[1]).trim().slice(0, 200) || null : null;

  let corpo = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  corpo = decodeEntities(corpo)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { titulo, texto: corpo.slice(0, MAX_TEXTO_CHARS) };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 31 && c < 65536 ? String.fromCharCode(c) : ' ';
    });
}

export function extrairDescricaoYoutube(html: string): string {
  const m = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
}

export function parseQaPairs(raw: string): Array<{ question: string; answer: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray((parsed as { pares?: unknown })?.pares)
    ? ((parsed as { pares: unknown[] }).pares)
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];
  return arr
    .map((p) => p as { question?: unknown; answer?: unknown; pergunta?: unknown; resposta?: unknown })
    .map((p) => ({
      question: String(p.question ?? p.pergunta ?? '').trim(),
      answer: String(p.answer ?? p.resposta ?? '').trim(),
    }))
    .filter((p) => p.question.length >= 8 && p.answer.length >= 20)
    .slice(0, MAX_ENTRIES_POR_LINK);
}

async function buscarHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const ehYoutube = /youtube\.com|youtu\.be/.test(url);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        ...(ehYoutube ? { Cookie: 'CONSENT=YES+cb; SOCS=CAISAiAD' } : {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar o link`);
    return (await res.text()).slice(0, 2_000_000);
  } finally {
    clearTimeout(t);
  }
}

async function oembedYoutube(videoId: string): Promise<{ title: string; author: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) return null;
    const d = (await res.json()) as { title?: string; author_name?: string };
    if (!d.title) return null;
    return { title: d.title, author: d.author_name ?? '' };
  } catch {
    return null;
  }
}

async function buscarConteudo(url: string, tipo: TipoLink): Promise<{ titulo: string | null; texto: string }> {
  if (tipo === 'video' && ehPlaylistYoutube(url)) {
    const html = await buscarHtml(url);
    const { titulo } = extrairTextoHtml(html);
    const ids = extrairVideoIdsYoutube(html);
    const videos = (await Promise.all(ids.map((id) => oembedYoutube(id)))).filter(
      (v): v is { title: string; author: string } => v !== null,
    );
    const linhas = videos.map((v) => `Depoimento em vídeo: ${v.title}${v.author ? ` (canal ${v.author})` : ''}`);
    return { titulo, texto: linhas.join('\n') };
  }

  const html = await buscarHtml(url);
  if (tipo === 'video') {
    const { titulo } = extrairTextoHtml(html);
    const descricao = extrairDescricaoYoutube(html);
    const idMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
    const oe = idMatch ? await oembedYoutube(idMatch[1]) : null;
    const partes = [
      oe ? `Depoimento em vídeo: ${oe.title}${oe.author ? ` (canal ${oe.author})` : ''}` : '',
      descricao,
    ].filter(Boolean);
    return { titulo: oe?.title ?? titulo, texto: partes.join('\n\n') || extrairTextoHtml(html).texto };
  }
  return extrairTextoHtml(html);
}

async function destilar(
  unit: Unit,
  texto: string,
  contexto: { titulo: string | null; tipo: TipoLink; url: string },
): Promise<Array<{ question: string; answer: string }>> {
  const rotulo =
    contexto.tipo === 'video'
      ? 'títulos e descrições de vídeos de depoimentos de pacientes'
      : contexto.tipo === 'avaliacao'
        ? 'avaliações de pacientes'
        : contexto.tipo === 'artigo'
          ? 'artigo científico'
          : 'página da web';
  const system =
    `Você prepara a base de conhecimento de uma atendente virtual de clínica de coluna. ` +
    `Abaixo está o conteúdo de ${rotulo}${contexto.titulo ? ` ("${contexto.titulo}")` : ''}. ` +
    `Extraia até ${MAX_ENTRIES_POR_LINK} pares de pergunta-e-resposta em PT-BR que a atendente possa usar com pacientes no WhatsApp. ` +
    `Regras: a pergunta é como um PACIENTE perguntaria; a resposta é curta (2-4 frases), fiel APENAS ao conteúdo fornecido, sem inventar dados, sem prometer cura, sem prescrever; ` +
    `se for artigo científico, traduza o achado pra linguagem simples e cite que é "um estudo" sem jargão; ` +
    `se for depoimento/avaliação, transforme em prova social utilizável ("pacientes relatam..."). ` +
    `Se o conteúdo não render pares úteis, retorne lista vazia. ` +
    `Responda SÓ JSON: {"pares":[{"question":"...","answer":"..."}]}`;

  const model = new ChatOpenAI({
    apiKey: resolveOpenAIApiKey(unit),
    model: DISTILL_MODEL,
    temperature: 0.2,
    modelKwargs: { response_format: { type: 'json_object' } },
  });
  const res = await model.invoke([
    { role: 'system', content: system },
    { role: 'user', content: texto.slice(0, MAX_TEXTO_CHARS) },
  ]);
  const raw = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
  return parseQaPairs(raw);
}

export async function processarLink(unit: Unit, linkId: string): Promise<{ status: string; entries: number }> {
  const link = await prisma.knowledgeLink.findFirst({ where: { id: linkId, unitId: unit.id } });
  if (!link) return { status: 'nao_encontrado', entries: 0 };

  try {
    const { titulo, texto } = await buscarConteudo(link.url, link.tipo as TipoLink);
    const minimo = (link.tipo as TipoLink) === 'video' ? 100 : MIN_TEXTO_CHARS;
    if (texto.length < minimo) {
      await prisma.knowledgeLink.update({
        where: { id: link.id },
        data: {
          status: 'falhou',
          titulo: titulo ?? link.titulo,
          chars: texto.length,
          erro: 'A página não entregou texto suficiente pra ler (conteúdo carregado por script ou restrito). Cole o texto manualmente na base de conhecimento.',
        },
      });
      return { status: 'falhou', entries: 0 };
    }

    const pares = await destilar(unit, texto, { titulo, tipo: link.tipo as TipoLink, url: link.url });
    let criadas = 0;
    for (const p of pares) {
      try {
        await createKnowledge(unit, p);
        criadas++;
      } catch (err) {
        logger.warn({ err, linkId }, 'knowledge-link: falha ao criar entrada');
      }
    }

    await prisma.knowledgeLink.update({
      where: { id: link.id },
      data: {
        status: criadas > 0 ? 'processado' : 'falhou',
        titulo: titulo ?? link.titulo,
        chars: texto.length,
        entriesCriadas: criadas,
        erro: criadas > 0 ? null : 'O conteúdo foi lido mas não rendeu perguntas e respostas úteis.',
      },
    });
    return { status: criadas > 0 ? 'processado' : 'falhou', entries: criadas };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.knowledgeLink.update({
      where: { id: link.id },
      data: { status: 'falhou', erro: msg.slice(0, 500) },
    });
    return { status: 'falhou', entries: 0 };
  }
}

export function listLinks(unitId: string) {
  return prisma.knowledgeLink.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export async function createLink(unitId: string, url: string) {
  return prisma.knowledgeLink.create({
    data: { unitId, url: url.trim(), tipo: detectarTipo(url) },
  });
}

export async function deleteLink(unitId: string, id: string): Promise<number> {
  const { count } = await prisma.knowledgeLink.deleteMany({ where: { id, unitId } });
  return count;
}
