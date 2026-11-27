/**
 * Leitura dos grupos «Mkt | Dr Hérnia …» pela instância Evolution da Suzanne («Suzanne - Relatorios»), SÓ LEITURA
 * (`POST /chat/findMessages`; nada é enviado, nada é marcado como lido).
 *
 * `normalizarRegistro` decide o que vale ler. Fica de fora (sem custo de modelo):
 *   - o que o PRÓPRIO SISTEMA mandou («Você»: fromMe sem participante — relatórios das 20h, avisos da Lia);
 *   - o que a Suzanne assinou como robô («Lia 🤖 do Marketing»);
 *   - figurinha, reação, mensagem que não abriu («secretEncryptedMessage») e mensagem sem texto.
 * A fala da Suzanne digitada por ela (fromMe COM participante) ENTRA: é quem conversa com as unidades.
 */
import { limpoParaPedido } from './ferramentas.js';
import { chaveDaPessoa, trechoCurto } from './privacidade.js';

export const URL_EVOLUTION_PADRAO = 'https://evolution.doutordigitalconsultoria.com';
export const INSTANCIA_PADRAO = 'Suzanne - Relatorios';
export const TEXTO_MAX = 1000;

export interface RegistroEvolution {
  key?: { id?: string; fromMe?: boolean; remoteJid?: string; participant?: string; participantAlt?: string };
  pushName?: string;
  messageType?: string;
  messageTimestamp?: number | { low?: number };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    documentMessage?: { caption?: string };
  };
}

export interface MensagemDoGrupo {
  /** `<slug>:<id>` */
  ref: string;
  slug: string;
  /** segundos desde 1970 */
  ts: number;
  autorNome: string;
  autorChave: string | null;
  /** já mascarado, ≤ 1000 */
  texto: string;
  /** quem escreveu é a Suzanne (a conta que lê), digitando */
  daConta: boolean;
}

const tsDe = (r: RegistroEvolution): number => {
  const t = r.messageTimestamp;
  return Number(typeof t === 'object' && t !== null ? (t.low ?? 0) : (t ?? 0));
};

export function textoDoRegistro(r: RegistroEvolution): string {
  const m = r.message ?? {};
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '').trim();
}

const ASSINATURA_DE_ROBO = /Lia\s*🤖|🤖\s*do Marketing/i;

/** A mensagem que o Joaoof deve ler, ou null (ruído / robô / vazia). */
export function normalizarRegistro(r: RegistroEvolution, slug: string, segredoPessoa: string | undefined): MensagemDoGrupo | null {
  const id = r.key?.id;
  if (!id) return null;
  const fromMe = r.key?.fromMe === true;
  if (fromMe && !r.key?.participant) return null; // enviada pelo sistema (API/relatório)
  const tipo = r.messageType ?? '';
  if (['stickerMessage', 'reactionMessage', 'secretEncryptedMessage', 'protocolMessage', 'senderKeyDistributionMessage'].includes(tipo)) return null;
  const bruto = textoDoRegistro(r);
  if (bruto.length < 2) return null;
  if (ASSINATURA_DE_ROBO.test(bruto)) return null;
  const numero = (r.key?.participantAlt ?? r.key?.participant ?? '').replace(/@.*/, '');
  return {
    ref: `${slug}:${id}`,
    slug,
    ts: tsDe(r),
    // o nome de perfil é escolhido por quem escreve: uma linha só, sem delimitadores, para não forjar linhas no pedido
    autorNome: limpoParaPedido(trechoCurto(r.pushName ?? '', 80), 80),
    autorChave: chaveDaPessoa(numero, segredoPessoa),
    texto: trechoCurto(bruto, TEXTO_MAX),
    daConta: fromMe,
  };
}

export interface ConfigEvolution {
  url: string;
  instancia: string;
  apikey: string;
}

export function configEvolution(env: NodeJS.ProcessEnv = process.env): ConfigEvolution | null {
  const apikey = String(env.JOAOOF_EVO_APIKEY ?? '').trim();
  if (!apikey) return null;
  return {
    url: String(env.JOAOOF_EVO_URL ?? '').trim().replace(/\/+$/, '') || URL_EVOLUTION_PADRAO,
    instancia: String(env.JOAOOF_EVO_INSTANCIA ?? '').trim() || INSTANCIA_PADRAO,
    apikey,
  };
}

export type LeituraDoGrupo = { ok: true; registros: RegistroEvolution[]; /** registros sem horário: ignorados (não dá para saber se são novos) e NUNCA encerram a leitura */ semHorario?: number; /** havia mais mensagens novas do que o limite: as mais antigas do intervalo ficaram de fora */ truncado: boolean } | { ok: false; erro: string };

/** Páginas de 100, da mais nova para a mais velha. 30 páginas = 3000 mensagens por passo (um grupo ativo faz ~100 por dia). */
const MAX_PAGINAS = 30;

/**
 * Lê as mensagens do grupo mais novas que `desdeTs` (segundos), da mais nova para a mais velha, até `max` (e no máximo 30 páginas de 100).
 * Se o limite cortar antes de alcançar `desdeTs`, devolve `truncado: true` — quem chama registra, nunca finge que leu tudo.
 * Nunca lança: erro de rede vira `{ ok: false }` e o lote tenta de novo no próximo passo.
 */
export async function lerGrupoNoEvolution(cfg: ConfigEvolution, jid: string, desdeTs: number, max = 3000, buscar: typeof fetch = globalThis.fetch): Promise<LeituraDoGrupo> {
  const registros: RegistroEvolution[] = [];
  let alcancou = false;
  let semHorario = 0;
  try {
    for (let pagina = 1; pagina <= MAX_PAGINAS && registros.length < max; pagina++) {
      const r = await buscar(`${cfg.url}/chat/findMessages/${encodeURIComponent(cfg.instancia)}`, {
        method: 'POST',
        headers: { apikey: cfg.apikey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ where: { key: { remoteJid: jid } }, page: pagina, offset: 100 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return { ok: false, erro: `Evolution respondeu ${r.status}` };
      const j = (await r.json()) as { messages?: { records?: RegistroEvolution[] } };
      const lote = j.messages?.records ?? [];
      if (lote.length === 0) {
        alcancou = true; // acabou o histórico
        break;
      }
      for (const reg of lote) {
        const t = tsDe(reg);
        // sem horário (0/ausente): não sabemos se é novo; antes isto contava como «mais velho que o cursor» e ENCERRAVA a leitura em silêncio
        if (!(t > 0)) {
          semHorario++;
          continue;
        }
        if (t <= desdeTs) alcancou = true;
        else registros.push(reg);
      }
      if (alcancou) break;
    }
    return { ok: true, registros: registros.slice(0, max), truncado: !alcancou || registros.length > max, semHorario };
  } catch (err) {
    const e = err as { name?: string; code?: string; cause?: { code?: string } };
    return { ok: false, erro: String(e?.cause?.code ?? e?.code ?? e?.name ?? 'erro de rede').slice(0, 60) };
  }
}
