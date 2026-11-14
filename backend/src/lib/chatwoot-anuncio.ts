/**
 * O «cartão» do anúncio dentro da conversa (João, 14/11/2026: "eu vou conseguir ver a mensagem e o anexo do anúncio? no chatwoot,
 * na kommo conseguimos"). O Chatwoot perde o anúncio no caminho do Kapso; o servidor acha no Kapso (kapso-referral) e, na PRIMEIRA
 * vez que guarda o anúncio de uma mensagem, deixa UMA nota interna: título, campanha/conjunto (se a Meta disser), o texto do
 * anúncio e o link — com a IMAGEM anexada (vídeo: a capa). A imagem é baixada na hora porque o link da Meta expira em dias.
 *
 * Nota interna não chega ao paciente e não pausa a Sofia (chatwoot-ia ignora mensagem privada). Publicação impulsionada que não é
 * anúncio (tipo «post») não ganha nota. CHATWOOT_NOTA_ANUNCIO=0 desliga. Não lança: sem imagem (ou anexo recusado) vai só o texto.
 * Imagem: só https de host da Meta (fbcdn.net / fbsbx.com / facebook.com), sem seguir redirecionamento, até 5 MB, só image/*.
 */
import { logger } from './logger.js';
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import type { ReferralDoKapso } from './kapso-referral.js';
import type { NomesDoAnuncio, PortasDaOrigem } from './chatwoot-origem.js';

export const LIMITE_IMAGEM = 5 * 1024 * 1024;
const LIMITE_TEXTO = 1200;
const EXTENSAO: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

export interface Imagem {
  bytes: Uint8Array;
  tipo: string;
}

/** O texto da nota. Função pura. */
export function textoDaNota(ref: ReferralDoKapso, nomes?: NomesDoAnuncio | null): string {
  const l = [`📣 Veio do anúncio${ref.titulo ? ` «${ref.titulo}»` : ''}`];
  if (nomes?.campanha) l.push(`Campanha: ${nomes.campanha}${nomes.conjunto ? ` · Conjunto: ${nomes.conjunto}` : ''}`);
  const corpo = ref.corpo?.trim();
  if (corpo) l.push('', corpo.length > LIMITE_TEXTO ? `${corpo.slice(0, LIMITE_TEXTO).trimEnd()}…` : corpo);
  const links: string[] = [];
  if (ref.video && hostDaMeta(ref.video)) links.push(`▶️ Ver o vídeo do anúncio: ${ref.video}`);
  if (ref.url) links.push(`🔗 ${ref.url}`);
  if (links.length) l.push('', ...links);
  return l.join('\n');
}

/** Só baixa de host da Meta, em https (o link vem do Kapso, mas não é por isso que vira porta para qualquer endereço). */
export function hostDaMeta(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /(^|\.)(fbcdn\.net|fbsbx\.com|facebook\.com)$/i.test(x.hostname);
  } catch {
    return false;
  }
}

type Baixar = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<{ ok: boolean; headers: { get(n: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

/** A imagem do anúncio, ou null (host fora da Meta, link vencido, não é imagem, grande demais, fora do ar). */
export async function baixarImagem(url: string, baixar: Baixar = fetch as unknown as Baixar): Promise<Imagem | null> {
  if (!hostDaMeta(url)) return null;
  try {
    const r = await baixar(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!r.ok) return null;
    const tipo = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!EXTENSAO[tipo]) return null;
    if (Number(r.headers.get('content-length') ?? 0) > LIMITE_IMAGEM) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > LIMITE_IMAGEM) return null;
    return { bytes, tipo };
  } catch {
    return null;
  }
}

export interface PortasDaNota {
  imagem(url: string): Promise<Imagem | null>;
  nomes(slug: string, anuncio: string): Promise<NomesDoAnuncio | null>;
  /** nota PRIVADA; com anexo, se vier */
  publicar(conversa: number, texto: string, anexo: (Imagem & { nome: string }) | null): Promise<void>;
}

/** Roda na 1ª vez que o anúncio de uma mensagem é guardado. Não lança. */
export async function notaDoAnuncio(
  e: { conversa: number; slug: string | undefined; ref: ReferralDoKapso },
  p: PortasDaNota,
  env: NodeJS.ProcessEnv = process.env,
): Promise<'desligado' | 'nada' | 'com-imagem' | 'so-texto' | 'falhou'> {
  if (env.CHATWOOT_NOTA_ANUNCIO === '0') return 'desligado';
  if (e.ref.tipo !== 'ad') return 'nada';
  try {
    const [img, nomes] = await Promise.all([
      e.ref.midia ? p.imagem(e.ref.midia).catch(() => null) : Promise.resolve(null),
      e.ref.anuncio && e.slug ? p.nomes(e.slug, e.ref.anuncio).catch(() => null) : Promise.resolve(null),
    ]);
    const anexo = img ? { ...img, nome: `anuncio-${e.ref.anuncio ?? 'whatsapp'}.${EXTENSAO[img.tipo] ?? 'jpg'}` } : null;
    await p.publicar(e.conversa, textoDaNota(e.ref, nomes), anexo);
    logger.info({ conversa: e.conversa, anuncio: e.ref.anuncio, imagem: !!anexo }, 'chatwoot-anuncio: nota do anúncio deixada na conversa');
    return anexo ? 'com-imagem' : 'so-texto';
  } catch (err) {
    logger.warn({ conversa: e.conversa, err: String(err) }, 'chatwoot-anuncio: não consegui deixar a nota do anúncio');
    return 'falhou';
  }
}

export function portasDaNota(ctx: ContextoChatwoot, origem: Pick<PortasDaOrigem, 'nomes'>): PortasDaNota {
  const soTexto = (conversa: number, texto: string) =>
    chamar(ctx, 'POST', `conversations/${conversa}/messages`, { corpo: { content: texto, message_type: 'outgoing', private: true } });
  return {
    imagem: (url) => baixarImagem(url),
    nomes: (slug, anuncio) => origem.nomes(slug, anuncio),
    async publicar(conversa, texto, anexo) {
      const conta = ctx.conta;
      if (!conta) throw new Error('o Chatwoot não está ligado');
      if (!Number.isInteger(conversa) || conversa <= 0) throw new Error(`conversa inválida: ${conversa}`);
      if (!anexo) {
        await soTexto(conversa, texto);
        return;
      }
      // a rota de mensagens do Chatwoot recebe anexo só em multipart (attachments[]); `chamar` só fala JSON
      const fd = new FormData();
      fd.append('content', texto);
      fd.append('message_type', 'outgoing');
      fd.append('private', 'true');
      fd.append('attachments[]', new Blob([anexo.bytes], { type: anexo.tipo }), anexo.nome);
      const r = await ctx
        .fetch(`${conta.url}/api/v1/accounts/${conta.conta}/conversations/${conversa}/messages`, {
          method: 'POST',
          headers: { api_access_token: conta.token, Accept: 'application/json' },
          body: fd,
          signal: AbortSignal.timeout(60_000),
        })
        .catch(() => null);
      if (r?.ok) return;
      // o anexo foi recusado (ou caiu no meio): o texto ainda vale
      logger.warn({ conversa, status: r?.status ?? null }, 'chatwoot-anuncio: o Chatwoot recusou a imagem; vai só o texto');
      await soTexto(conversa, texto);
    },
  };
}
