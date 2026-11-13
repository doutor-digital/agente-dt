/**
 * "🤖 Passar para a Sofia" (Ponte, 12/11/2026). A atendente atende pelo WhatsApp Web e o Kommo (canal Lite) não tem o
 * histórico antigo sincronizado — só o que entrou depois de conectar. A extensão lê as falas da conversa aberta e manda
 * aqui; o servidor guarda o histórico na MEMÓRIA do lead (o bloco que o prompt da Sofia já lê), tira a pausa, libera a
 * Sofia naquele lead mesmo fora do horário da IA e abre o turno para ela responder a última fala do paciente — pelo
 * Kommo, como sempre. A extensão nunca envia nada pelo WhatsApp Web.
 *
 * Aqui só as regras puras (lidas e testadas sem banco).
 */
import { leadIdDoPedido } from './ponte-pausa.js';

export const MAX_FALAS = 60;
export const MAX_TEXTO_DA_FALA = 1_500;
/** Teto do histórico guardado na memória: o fim da conversa é o que importa (o começo é cortado). */
export const MAX_HISTORICO = 3_500;
/** Por quanto tempo a Sofia fica liberada naquele lead fora do horário dela. */
export const LIBERADA_POR_MS = 12 * 60 * 60_000;
export const MARCA_DO_HISTORICO = '[Conversa no WhatsApp antes da Sofia';

export interface FalaDaTela {
  de: 'paciente' | 'equipe';
  texto: string;
  /** "10:02" ou "10:02, 12/11/2026" — como o WhatsApp Web mostra; só para a Sofia se situar. */
  hora: string | null;
}

export interface PedidoDePassagem {
  leadId: number;
  por: string | null;
  falas: FalaDaTela[];
}

function limpar(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function lerPedidoDePassagem(body: unknown): { ok: true; pedido: PedidoDePassagem } | { ok: false; erro: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  if (!Array.isArray(b.falas)) return { ok: false, erro: 'sem falas' };
  const falas: FalaDaTela[] = [];
  // as mais recentes valem mais: se vier demais, corta o começo
  for (const f of b.falas.slice(-MAX_FALAS)) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const de = o.de === 'paciente' || o.de === 'equipe' ? o.de : null;
    const texto = limpar(o.texto, MAX_TEXTO_DA_FALA);
    if (!de || !texto) continue;
    const hora = limpar(o.hora, 40) || null;
    falas.push({ de, texto, hora });
  }
  if (!falas.length) return { ok: false, erro: 'nenhuma fala legível na conversa' };
  const por = limpar(b.por, 60) || null;
  return { ok: true, pedido: { leadId, por, falas } };
}

/**
 * Separa o que a Sofia precisa RESPONDER (as falas do paciente depois da última da equipe) do que é só contexto.
 * Sem fala pendente, a Sofia fica liberada e responde quando o paciente escrever de novo.
 */
export function dividirFalas(falas: readonly FalaDaTela[]): { anteriores: FalaDaTela[]; pendentes: string[] } {
  let i = falas.length;
  while (i > 0 && falas[i - 1]!.de === 'paciente') i--;
  return { anteriores: falas.slice(0, i), pendentes: falas.slice(i).map((f) => f.texto) };
}

/** O bloco que vai para a memória do lead. `quando` = "12/11 14:30" (hora local da unidade). */
export function montarHistorico(falas: readonly FalaDaTela[], quando: string, por: string | null, origem: 'tela' | 'whatsapp' = 'tela'): string {
  const fonte = origem === 'tela' ? `lida da tela pela equipe${por ? ` (${por})` : ''}` : 'lida do WhatsApp da clínica';
  const cab = `${MARCA_DO_HISTORICO} assumir — ${fonte} em ${quando}. As falas "Equipe" são da recepção da clínica, não suas:]`;
  const linhas = falas.map((f) => `${f.de === 'paciente' ? 'Paciente' : 'Equipe'}${f.hora ? ` (${f.hora})` : ''}: ${f.texto}`);
  // guarda o FIM: tira linhas do começo até caber
  let corpo = linhas.join('\n');
  while (corpo.length > MAX_HISTORICO - cab.length - 1 && linhas.length > 1) {
    linhas.shift();
    corpo = `…\n${linhas.join('\n')}`;
  }
  if (corpo.length > MAX_HISTORICO - cab.length - 1) corpo = `…${corpo.slice(-(MAX_HISTORICO - cab.length - 2))}`;
  return `${cab}\n${corpo}`;
}

/** Junta ao resumo que já existe; uma passagem nova troca o bloco da anterior (não empilha). */
export function juntarNaMemoria(resumoAtual: string | null | undefined, historico: string): string {
  const atual = (resumoAtual ?? '').trim();
  const i = atual.indexOf(MARCA_DO_HISTORICO);
  const semBlocoVelho = (i >= 0 ? atual.slice(0, i) : atual).trim();
  return semBlocoVelho ? `${semBlocoVelho}\n\n${historico}` : historico;
}

export function liberadaAgora(liberadaAte: Date | null | undefined, agora: Date = new Date()): boolean {
  return !!liberadaAte && liberadaAte.getTime() > agora.getTime();
}

// ── "Sofia atende todos" (12/11/2026): a chave da unidade na Ponte ──

/** Teto da chave: no máximo 24 h por vez (esquecida ligada, ela desliga sozinha). */
export const MAX_TODOS_MS = 24 * 60 * 60_000;

export function lerPedidoDeTodos(
  body: unknown,
  agora: Date = new Date(),
): { ok: true; ate: Date | null; por: string | null } | { ok: false; erro: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const por = limpar(b.por, 60) || null;
  if (b.ate === null) return { ok: true, ate: null, por };
  if (typeof b.ate !== 'string') return { ok: false, erro: 'informe até quando' };
  const ate = new Date(b.ate);
  if (Number.isNaN(ate.getTime())) return { ok: false, erro: 'data inválida' };
  if (ate.getTime() <= agora.getTime()) return { ok: false, erro: 'o horário já passou' };
  if (ate.getTime() - agora.getTime() > MAX_TODOS_MS) return { ok: false, erro: 'no máximo 24 h por vez' };
  return { ok: true, ate, por };
}
