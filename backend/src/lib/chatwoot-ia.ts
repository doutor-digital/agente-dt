/**
 * IA no Chatwoot (pedido do João, 12/11/2026) — automação `chatwoot-ia`, por unidade, padrão DESLIGADO.
 *
 * Um receptor só para os eventos do Chatwoot (`POST /api/public/chatwoot/evento?k=…`, webhook da CONTA com `message_created`).
 * Para cada mensagem nova DO PACIENTE numa caixa do mapa:
 *  1. ÁUDIO → transcreve (o mesmo serviço do Kommo) e deixa NOTA PRIVADA «🎙️ Transcrição do áudio».
 *  2. SOFIA EM SECO → espera 60 s sem o paciente escrever, lê as últimas mensagens públicas da conversa e roda a Sofia no MODO DE
 *     TESTE (`rodarTesteDaSofia`: ferramentas simuladas, nada gravado). Deixa NOTA PRIVADA com o que ela responderia e as ações
 *     que tomaria — os campos que preencheria (o "IA preenchendo o cartão" em seco), agendamento, etapa.
 * Nada vai ao paciente. «ligado» faz o mesmo que «seco» por enquanto (a Sofia de verdade no Chatwoot é outro passo).
 *
 * Travas: só mensagem recebida (incoming), não privada, de caixa do mapa; não roda se a equipe respondeu depois da última fala do
 * paciente; teto de rodadas da Sofia por unidade por dia (em memória); chave na URL (o log mascara `k=`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { aplicarEtiqueta, eventoDeEtiqueta, portasDaPonte, type PortasDaPonte } from './chatwoot-etiquetas.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { rodarTesteDaSofia } from '../controllers/playground.controller.js';

export const ID_IA = 'chatwoot-ia';
export const ESPERA_SOFIA_MS = 60_000;
export const TETO_SOFIA_POR_DIA = 300;
/** quantas mensagens públicas da conversa a Sofia lê */
export const MAX_MENSAGENS_LIDAS = 24;
const MAX_TEXTO_ACAO = 160;

export function chaveDoEvento(tokenChatwoot: string): string {
  return createHmac('sha256', tokenChatwoot).update('chatwoot-evento-v1').digest('hex').slice(0, 32);
}

export function chaveDoEventoConfere(tokenChatwoot: string | undefined, recebida: unknown): boolean {
  if (!tokenChatwoot || typeof recebida !== 'string' || recebida.length !== 32) return false;
  const a = Buffer.from(chaveDoEvento(tokenChatwoot));
  const b = Buffer.from(recebida);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MensagemDoPaciente {
  conversa: number;
  caixa: number;
  slug: string;
  audios: string[];
}

/** Corpo do webhook do Chatwoot → mensagem do paciente numa caixa do mapa, ou null. */
export function mensagemDoPaciente(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): MensagemDoPaciente | null {
  if (corpo?.event !== 'message_created') return null;
  const tipo = corpo?.message_type;
  if (!(tipo === 'incoming' || tipo === 0)) return null;
  if (corpo?.private === true) return null;
  const conversa = Number(corpo?.conversation?.id);
  const caixa = Number(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  const slug = caixas[caixa];
  if (!Number.isInteger(conversa) || conversa <= 0 || !slug) return null;
  // grupo de WhatsApp não é paciente
  const ident = String(corpo?.sender?.identifier ?? corpo?.conversation?.meta?.sender?.identifier ?? '');
  if (/@g\.us$/i.test(ident)) return null;
  const anexos: any[] = Array.isArray(corpo?.attachments) ? corpo.attachments : [];
  const audios = anexos.filter((a) => String(a?.file_type) === 'audio' && typeof a?.data_url === 'string').map((a) => String(a.data_url));
  return { conversa, caixa, slug, audios };
}

export type Fala = { role: 'user' | 'assistant'; content: string };

/**
 * As mensagens do Chatwoot (`/conversations/:id/messages`, em ordem) → falas para a Sofia. Só públicas (nota não entra);
 * entrada = paciente, saída = nós. Áudio sem texto vira a transcrição da nota logo depois, se houver; senão "[áudio]".
 * Junta falas seguidas do mesmo lado. Devolve null se a última fala não é do paciente (a equipe já respondeu).
 */
export function falasDaConversa(mensagens: any[], max = MAX_MENSAGENS_LIDAS): Fala[] | null {
  const transcricoes = new Map<number, string>();
  for (let i = 0; i < mensagens.length; i++) {
    const m = mensagens[i];
    const t = typeof m?.content === 'string' ? m.content : '';
    if (m?.private === true && t.startsWith(PREFIXO_TRANSCRICAO)) {
      // a nota de transcrição vale para o áudio anterior mais perto
      for (let j = i - 1; j >= 0; j--) {
        if (Number(mensagens[j]?.message_type) === 0 && temAudio(mensagens[j])) {
          if (!transcricoes.has(j)) transcricoes.set(j, textoDaTranscricao(t));
          break;
        }
      }
    }
  }
  const falas: Fala[] = [];
  mensagens.forEach((m, i) => {
    const tipo = Number(m?.message_type);
    if (m?.private === true || (tipo !== 0 && tipo !== 1)) return;
    let texto = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!texto && temAudio(m)) texto = transcricoes.get(i) ?? '[áudio]';
    if (!texto && Array.isArray(m?.attachments) && m.attachments.length) texto = '[anexo]';
    if (!texto) return;
    const role: Fala['role'] = tipo === 0 ? 'user' : 'assistant';
    const ultima = falas[falas.length - 1];
    if (ultima && ultima.role === role) ultima.content += `\n${texto}`;
    else falas.push({ role, content: texto });
  });
  if (!falas.length || falas[falas.length - 1]!.role !== 'user') return null;
  // a Sofia começa sempre por uma fala do paciente
  let corte = falas.slice(-max);
  while (corte.length && corte[0]!.role !== 'user') corte = corte.slice(1);
  return corte.length ? corte : null;
}

const temAudio = (m: any) => Array.isArray(m?.attachments) && m.attachments.some((a: any) => String(a?.file_type) === 'audio');
export const PREFIXO_TRANSCRICAO = '🎙️ Transcrição do áudio';
const textoDaTranscricao = (nota: string) => nota.replace(/^🎙️ Transcrição do áudio[^\n]*\n+/, '').replace(/^«|»$/g, '').trim();

export function notaDaTranscricao(texto: string): string {
  return `${PREFIXO_TRANSCRICAO}:\n«${texto.trim()}»`;
}

/** A nota do seco: o que a Sofia responderia + as ações (ferramentas) que tomaria, em português curto. */
export function notaDaSofia(resposta: string, acoes: Array<{ tool: string; args: Record<string, unknown> }>): string {
  const linhas = [`🧪 [SECO] Sofia responderia:\n\n${resposta.trim() || '(sem texto)'}`];
  if (acoes.length) {
    linhas.push('\nAções que ela tomaria:');
    for (const a of acoes) {
      const args = Object.entries(a.args ?? {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' · ');
      linhas.push(`• ${a.tool}${args ? ` — ${args.length > MAX_TEXTO_ACAO ? `${args.slice(0, MAX_TEXTO_ACAO)}…` : args}` : ''}`);
    }
  }
  return linhas.join('\n');
}

// ── portas (trocáveis no teste) ────────────────────────────────────────────────────────────────────

export interface PortasDaIa {
  estado(slug: string): Estado;
  unidade(slug: string): Promise<Unit | null>;
  mensagens(conversa: number): Promise<any[]>;
  nota(conversa: number, texto: string): Promise<void>;
  transcrever(unit: Unit, url: string): Promise<string>;
  sofia(unit: Unit, falas: Fala[]): Promise<{ resposta: string; acoes: Array<{ tool: string; args: Record<string, unknown> }> } | null>;
  agendar(fn: () => void, ms: number): unknown;
  cancelar(t: unknown): void;
  hoje(): string;
}

export function portasReais(ctx: ContextoChatwoot): PortasDaIa {
  return {
    estado: (slug) => estadoDaAutomacao(slug, ID_IA, process.env.CHATWOOT_IA_SLUGS),
    unidade: (slug) => prisma.unit.findUnique({ where: { slug } }),
    async mensagens(conversa) {
      const r = (await chamar(ctx, 'GET', `conversations/${conversa}/messages`)) as { payload?: unknown[] } | null;
      return Array.isArray(r?.payload) ? r.payload : [];
    },
    async nota(conversa, texto) {
      await chamar(ctx, 'POST', `conversations/${conversa}/messages`, { corpo: { content: texto, message_type: 'outgoing', private: true } });
    },
    async transcrever(unit, url) {
      return (await transcribeAudio(unit, url)).text;
    },
    async sofia(unit, falas) {
      const r = await rodarTesteDaSofia(unit, falas);
      if (!r.ok) {
        logger.warn({ unit: unit.slug, erro: r.error }, `${ID_IA}: a Sofia de teste falhou`);
        return null;
      }
      return { resposta: r.reply, acoes: r.actions.map((a) => ({ tool: a.tool, args: a.args })) };
    },
    agendar: (fn, ms) => setTimeout(fn, ms),
    cancelar: (t) => clearTimeout(t as NodeJS.Timeout),
    hoje: () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10),
  };
}

export interface MemoriaDaIa {
  esperas: Map<number, unknown>;
  rodadas: Map<string, number>;
}
export const novaMemoriaDaIa = (): MemoriaDaIa => ({ esperas: new Map(), rodadas: new Map() });

/** Uma mensagem do paciente chegou: transcreve o áudio agora; a Sofia, só depois de 60 s quieto (reagenda a cada fala). */
export async function aoChegar(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa): Promise<void> {
  if (p.estado(m.slug) === 'desligado') return;
  if (m.audios.length) {
    const unit = await p.unidade(m.slug);
    if (unit) {
      for (const url of m.audios) {
        try {
          const texto = await p.transcrever(unit, url);
          if (texto.trim()) await p.nota(m.conversa, notaDaTranscricao(texto));
        } catch (err) {
          logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui transcrever o áudio`);
        }
      }
    }
  }
  const antes = mem.esperas.get(m.conversa);
  if (antes !== undefined) p.cancelar(antes);
  mem.esperas.set(
    m.conversa,
    p.agendar(() => {
      mem.esperas.delete(m.conversa);
      void rodarSofia(m, p, mem).catch((err) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: Sofia em seco falhou`));
    }, ESPERA_SOFIA_MS),
  );
}

export async function rodarSofia(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa): Promise<'nota' | 'equipe-respondeu' | 'teto' | 'sem-unidade' | 'falhou' | 'desligado'> {
  if (p.estado(m.slug) === 'desligado') return 'desligado';
  const chaveDia = `${m.slug}|${p.hoje()}`;
  const feitas = mem.rodadas.get(chaveDia) ?? 0;
  if (feitas >= TETO_SOFIA_POR_DIA) return 'teto';
  const falas = falasDaConversa(await p.mensagens(m.conversa));
  if (!falas) return 'equipe-respondeu';
  const unit = await p.unidade(m.slug);
  if (!unit) return 'sem-unidade';
  mem.rodadas.set(chaveDia, feitas + 1);
  const r = await p.sofia(unit, falas);
  if (!r) return 'falhou';
  await p.nota(m.conversa, notaDaSofia(r.resposta, r.acoes));
  return 'nota';
}

// ── a rota ─────────────────────────────────────────────────────────────────────────────────────────

let estado: { portas: PortasDaIa; mem: MemoriaDaIa; ponte: PortasDaPonte } | null = null;

function estadoDoReceptor() {
  if (!estado) {
    const conta = contaChatwootDoAmbiente();
    if (!conta) return null;
    const ctx = criarContextoChatwoot(conta);
    estado = { portas: portasReais(ctx), mem: novaMemoriaDaIa(), ponte: portasDaPonte(ctx) };
  }
  return estado;
}

export function eventoChatwootHandler(req: Request, res: Response): void {
  const token = process.env.CHATWOOT_API_TOKEN?.trim();
  if (!chaveDoEventoConfere(token, req.query.k)) {
    res.status(401).json({ error: 'chave inválida' });
    return;
  }
  res.json({ ok: true });
  // botão "Perdido: <motivo>" → etiqueta → etapa + motivo no cartão (chatwoot-etiquetas.ts)
  const etq = eventoDeEtiqueta(req.body);
  if (etq) {
    const e = estadoDoReceptor();
    if (e) void aplicarEtiqueta(etq, e.ponte).catch((err) => logger.warn({ err: String(err), conversa: etq.conversa }, 'chatwoot-etiquetas: falhou'));
    return;
  }
  const m = mensagemDoPaciente(req.body);
  if (!m) return;
  const e = estadoDoReceptor();
  if (!e) return;
  void aoChegar(m, e.portas, e.mem).catch((err) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: evento falhou`));
}
