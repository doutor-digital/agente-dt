/**
 * Título padrão pra lead sem nome (pedido do João, 23/09/2026).
 *
 * O Kommo nomeia o cartão que nasce do chat como "Lead #22647811"; a SDR nomeia "Fulana 23/09/2026".
 * Na Serra, 34 dos 135 leads de 5 dias ficaram com o nome do Kommo. Enquanto a Sofia não captura o
 * nome, o cartão vira "Lead 23/09/2026" na primeira mensagem — e "Lead 2 23/09/2026" pro segundo sem
 * nome do mesmo dia (data = criação do lead, no fuso da unidade). Quando o nome chega, a captura
 * (`updateLeadTitleWithDate` / rede de segurança do grafo) troca tudo por "Nome dd/mm/aaaa".
 *
 * Só nas unidades em `TITULO_PADRAO_SLUGS` (csv; `*` = todas). Nunca segura a resposta da IA.
 * Review de 23/09: numeração pelo MAIOR número já usado (SDR pode renomear o 1º), fila por unidade
 * (dois leads no mesmo segundo), releitura antes de gravar (a Sofia pode ter capturado o nome no meio).
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { logger } from './logger.js';

export function tituloPadraoLiberado(slug: string, raw: string | undefined = process.env.TITULO_PADRAO_SLUGS): boolean {
  const lista = (raw ?? '').replace(/^['"]|['"]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (lista.length === 0) return false;
  return lista.includes('*') || lista.includes(slug);
}

/** "Lead #123", "Lead 123", "Lead", vazio → sem nome. "Lead 23/09/2026" (o nosso) e "Maria" NÃO. */
export function ehSemNome(nome: string | null | undefined): boolean {
  const s = String(nome ?? '').trim();
  return s === '' || /^lead\s*#?\s*\d*$/i.test(s);
}

/** "Lead 23/09/2026" / "Lead 2 23/09/2026": é o nosso título provisório — a captura do nome pode sobrescrever. */
export function ehTituloPadrao(nome: string | null | undefined): boolean {
  return /^lead(?: \d+)? \d{2}\/\d{2}\/\d{4}$/i.test(String(nome ?? '').trim());
}

export function dataBR(epochS: number, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(epochS * 1000));
}

/**
 * "Lead dd/mm/aaaa" se ninguém do dia usa; senão "Lead N dd/mm/aaaa" com N = MAIOR número já usado + 1
 * ("Lead dd/mm/aaaa" sem número vale 1). Contar em vez de olhar o maior duplicava quando a SDR renomeava o 1º.
 */
export function montarTituloPadrao(data: string, titulosDoDia: string[]): string {
  const re = new RegExp(`^Lead(?: (\\d+))? ${data.replace(/\//g, '\\/')}$`, 'i');
  let maior = 0;
  for (const t of titulosDoDia) {
    const m = re.exec(String(t ?? '').trim());
    if (!m) continue;
    const n = m[1] ? Number(m[1]) : 1;
    if (Number.isFinite(n) && n > maior) maior = n;
  }
  return maior === 0 ? `Lead ${data}` : `Lead ${maior + 1} ${data}`;
}

/** lead já conferido hoje (por processo): 1 leitura do Kommo por lead por dia, não por mensagem */
const conferidos = new Map<string, number>();
const CONFERIDO_MS = 24 * 3600_000;

/** uma renomeação por vez por unidade: dois leads novos no mesmo segundo não podem ler a mesma lista */
const filas = new Map<string, Promise<unknown>>();
function naFilaDaUnidade<T>(unitId: string, fn: () => Promise<T>): Promise<T> {
  const anterior = filas.get(unitId) ?? Promise.resolve();
  const atual = anterior.catch(() => undefined).then(fn);
  filas.set(unitId, atual);
  void atual.finally(() => {
    if (filas.get(unitId) === atual) filas.delete(unitId);
  });
  return atual;
}

async function renomear(unit: Unit, kommo: KommoClient, leadId: number): Promise<string | null> {
  const lead = await kommo.getLead(leadId);
  if (!ehSemNome(lead.name)) return null;
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const criado = lead.created_at ?? Math.floor(Date.now() / 1000);
  const data = dataBR(criado, tz);
  // vizinhos de ±1 dia e filtro pela data no fuso: evita contas de meia-noite
  const vizinhos = await kommo.listLeadsCriadosEntre(criado - 86_400, criado + 86_400);
  const titulosDoDia = vizinhos.filter((l) => l.id !== leadId && dataBR(l.created_at ?? 0, tz) === data).map((l) => l.name ?? '');
  const desejado = montarTituloPadrao(data, titulosDoDia);
  // a Sofia pode ter capturado o nome enquanto contávamos (a captura roda em paralelo): relê antes de gravar
  const agora = await kommo.getLead(leadId);
  if ((agora.name ?? '').trim() !== (lead.name ?? '').trim()) {
    logger.info({ unit: unit.slug, leadId, nome: agora.name }, 'titulo-padrao: o nome chegou antes — não sobrescrevo');
    return null;
  }
  if (desejado === (lead.name ?? '').trim()) return null;
  await kommo.updateLeadName(leadId, desejado);
  logger.info({ unit: unit.slug, leadId, de: lead.name, para: desejado }, 'titulo-padrao: lead sem nome renomeado');
  return desejado;
}

export async function garantirTituloPadrao(unit: Unit, kommo: KommoClient, leadId: number): Promise<string | null> {
  if (!tituloPadraoLiberado(unit.slug)) return null;
  const chave = `${unit.id}:${leadId}`;
  const agora = Date.now();
  const ate = conferidos.get(chave);
  if (ate && ate > agora) return null;
  // reserva antes de ler: duas mensagens seguidas do mesmo lead não podem entrar as duas
  conferidos.set(chave, agora + CONFERIDO_MS);
  if (conferidos.size > 5000) for (const [k, e] of conferidos) if (e <= agora) conferidos.delete(k);
  try {
    return await naFilaDaUnidade(unit.id, () => renomear(unit, kommo, leadId));
  } catch (err) {
    // falha do Kommo (429 em incidente) não pode marcar o lead como conferido por 24 h
    conferidos.delete(chave);
    throw err;
  }
}
