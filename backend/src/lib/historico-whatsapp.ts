/**
 * Histórico antigo do WhatsApp pelo Evolution, SÓ LEITURA (13/11/2026, pedido do João para Caxias).
 *
 * Unidade no WhatsApp Lite: o Kommo só tem o que chegou depois de conectar o Lite. O mesmo número fica conectado também
 * num Evolution (mais um aparelho conectado, `syncFullHistory`), que guarda a conversa antiga. Na 1ª vez que a Sofia vai
 * responder um paciente, ela lê dali as últimas falas de antes e guarda na MEMÓRIA do lead (o mesmo bloco do "Passar
 * para a Sofia" da Ponte). O Evolution NUNCA envia nada: aqui só existe `/chat/findMessages`.
 *
 * Config (`.env`): `HISTORICO_EVO=<slug>=<instância>:<chave da instância>;<slug2>=…` e, opcional, `HISTORICO_EVO_URL`.
 * Unidade fora da lista = nada muda (nem consulta ao banco).
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { fusoDaUnidade } from './fuso.js';
import { MARCA_DO_HISTORICO, MAX_TEXTO_DA_FALA, juntarNaMemoria, montarHistorico, notaDoHistorico, type FalaDaTela } from './ponte-passar-sofia.js';
import { createKommoClient } from '../services/kommo.service.js';

export const URL_PADRAO = 'https://evolution.doutordigitalconsultoria.com';
export const MAX_FALAS_DO_HISTORICO = 40;
const TEMPO_MAXIMO_MS = 4_000;
/** Quem já foi tentado (achou ou não) não é consultado de novo por 6 h neste processo. */
const TENTADO_MS = 6 * 60 * 60_000;

export interface ContaDoHistorico {
  url: string;
  instancia: string;
  chave: string;
}

/** `HISTORICO_EVO` → a conta da unidade, ou null. Formato: `slug=instancia:chave;slug2=instancia2:chave2`. */
export function contaDoHistorico(slug: string, e: NodeJS.ProcessEnv = process.env): ContaDoHistorico | null {
  const bruto = e.HISTORICO_EVO?.trim();
  if (!bruto) return null;
  for (const parte of bruto.split(';')) {
    const [s, resto] = parte.split('=', 2).map((x) => x?.trim());
    if (s !== slug || !resto) continue;
    const i = resto.indexOf(':');
    if (i <= 0) return null;
    const instancia = resto.slice(0, i).trim();
    const chave = resto.slice(i + 1).trim();
    if (!instancia || !chave) return null;
    return { url: (e.HISTORICO_EVO_URL?.trim() || URL_PADRAO).replace(/\/+$/, ''), instancia, chave };
  }
  return null;
}

/** Os JIDs possíveis de um telefone BR: com e sem o 9 do celular (contas antigas do WhatsApp ficaram sem ele). */
export function jidsDoTelefone(telefone: string | null | undefined): string[] {
  let d = String(telefone ?? '').replace(/\D/g, '');
  if (d.length < 10) return [];
  if (d.length <= 11) d = `55${d}`;
  const lista = [d];
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') lista.push(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12) lista.push(`${d.slice(0, 4)}9${d.slice(4)}`);
  return lista.map((x) => `${x}@s.whatsapp.net`);
}

interface MsgCrua {
  key?: { fromMe?: boolean };
  messageTimestamp?: number | string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
  };
}

function textoDa(m: MsgCrua): string {
  const msg = m.message ?? {};
  const t = msg.conversation ?? msg.extendedTextMessage?.text ?? msg.imageMessage?.caption ?? msg.videoMessage?.caption ?? '';
  const limpo = String(t).replace(/\s+/g, ' ').trim();
  return limpo.length > MAX_TEXTO_DA_FALA ? `${limpo.slice(0, MAX_TEXTO_DA_FALA - 1)}…` : limpo;
}

function quandoLocal(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)).replace(',', '');
}

/**
 * Registros do Evolution → falas de texto, em ordem, só as de ANTES de `ate` (o que veio depois já está na conversa do
 * Kommo/da Sofia). Mídia sem legenda fica de fora. As últimas `max`.
 */
export function falasDoEvolution(registros: readonly MsgCrua[], ate: number, tz: string, max = MAX_FALAS_DO_HISTORICO): FalaDaTela[] {
  return registros
    .map((m) => ({ m, ms: Number(m.messageTimestamp ?? 0) * 1000 }))
    .filter((x) => x.ms > 0 && x.ms < ate)
    .sort((a, b) => a.ms - b.ms)
    .map(({ m, ms }) => ({ de: m.key?.fromMe ? ('equipe' as const) : ('paciente' as const), texto: textoDa(m), hora: quandoLocal(ms, tz) }))
    .filter((f) => f.texto)
    .slice(-max);
}

type Buscar = (input: string, init: RequestInit) => Promise<Response>;

async function registrosDo(conta: ContaDoHistorico, jid: string, buscar: Buscar, sinal: AbortSignal): Promise<MsgCrua[]> {
  const r = await buscar(`${conta.url}/chat/findMessages/${encodeURIComponent(conta.instancia)}`, {
    method: 'POST',
    headers: { apikey: conta.chave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ where: { key: { remoteJid: jid } }, page: 1, offset: 100 }),
    signal: sinal,
  });
  if (!r.ok) throw new Error(`Evolution ${r.status}`);
  const j = (await r.json().catch(() => null)) as { messages?: { records?: MsgCrua[] }; records?: MsgCrua[] } | MsgCrua[] | null;
  if (Array.isArray(j)) return j;
  return j?.messages?.records ?? j?.records ?? [];
}

const tentados = new Map<string, number>();

export interface DepsDoHistorico {
  env: NodeJS.ProcessEnv;
  buscar: Buscar;
  agora(): number;
}

/**
 * Na 1ª resposta a um paciente, põe o histórico antigo dele (do Evolution) na memória do lead. Nunca lança e nunca
 * segura o turno mais que ~4 s. Devolve quantas falas guardou (0 = nada a fazer / nada achado / falhou).
 */
export async function historicoDoWhatsappNaMemoria(unit: Unit, leadId: number, deps?: Partial<DepsDoHistorico>): Promise<number> {
  const env = deps?.env ?? process.env;
  const conta = contaDoHistorico(unit.slug, env);
  if (!conta) return 0;
  const agora = deps?.agora?.() ?? Date.now();
  const k = `${unit.id}:${leadId}`;
  const ultima = tentados.get(k);
  if (ultima && agora - ultima < TENTADO_MS) return 0;
  tentados.set(k, agora);
  if (tentados.size > 5_000) tentados.clear();
  try {
    const [mem, conv] = await Promise.all([
      prisma.leadMemory.findUnique({ where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } }, select: { summary: true } }),
      prisma.conversation.findUnique({ where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } }, select: { id: true, phone: true } }),
    ]);
    if (mem?.summary?.includes(MARCA_DO_HISTORICO)) return 0; // já tem (desta busca ou da Ponte)
    const jids = jidsDoTelefone(conv?.phone);
    if (!jids.length) return 0;
    // o que entrou depois da 1ª fala que a Sofia já tem é conversa do Kommo: corta ali (sem ela, 2 min atrás)
    const primeira = conv
      ? await prisma.message.findFirst({ where: { conversationId: conv.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
      : null;
    const ate = primeira ? primeira.createdAt.getTime() : agora - 2 * 60_000;
    const buscar = deps?.buscar ?? ((i, o) => fetch(i, o));
    const sinal = AbortSignal.timeout(TEMPO_MAXIMO_MS);
    const tz = fusoDaUnidade(unit);
    let falas: FalaDaTela[] = [];
    for (const jid of jids) {
      falas = falasDoEvolution(await registrosDo(conta, jid, buscar, sinal), ate, tz);
      if (falas.length) break;
    }
    if (!falas.length) return 0;
    const historico = montarHistorico(falas, quandoLocal(agora, tz), null, 'whatsapp');
    const summary = juntarNaMemoria(mem?.summary, historico);
    await prisma.leadMemory.upsert({
      where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
      create: { unitId: unit.id, leadId: String(leadId), summary },
      update: { summary },
    });
    // e vira NOTA no cartão: o Kommo (Lite) não tem esse histórico e a equipe também precisa ler
    await createKommoClient(unit)
      .addLeadNote(leadId, notaDoHistorico(falas, quandoLocal(agora, tz), null, 'whatsapp'))
      .catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'histórico do WhatsApp: não consegui pôr a nota no cartão (segue)'));
    logger.info({ unit: unit.slug, leadId, falas: falas.length }, 'histórico do WhatsApp (Evolution) guardado na memória do lead');
    return falas.length;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'histórico do WhatsApp (Evolution): falhou — segue sem');
    return 0;
  }
}

export function _limparParaTeste(): void {
  tentados.clear();
}
