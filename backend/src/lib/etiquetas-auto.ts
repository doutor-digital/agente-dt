/**
 * As etiquetas ▶ que a SDR punha à mão, decididas pelo sistema.
 *
 * Pedido do João (06/10/2026): "as etiquetas precisam ser automatizadas, sem depender da SDR". A
 * etiqueta é só o gatilho — quem manda a mensagem é o bot do Kommo amarrado a ela (régua da Serra,
 * no ar na Açailândia desde 07/10). Por isso cada regra aqui confere também se o MODELO da mensagem
 * vai sair inteiro: etiqueta posta com o campo vazio manda "Aqui é , da Doutor Hérnia" pro paciente.
 *
 * As três regras aprovadas:
 *  - ▶ Boas-vindas     — o cartão entrou em GANHO (COMERCIAL). Espera o programa e a próxima sessão
 *                         estarem no cartão, porque o modelo cita os dois.
 *  - ▶ Confirmar retorno — RETORNO PÓS-TRATAMENTO com "◷ Próxima sessão" nas próximas 24 h.
 *                         Em EM TRATAMENTO não: ali a véspera da sessão já tem bot próprio.
 *  - ▶ Reativação      — 30 dias em PERDIDO sem conversa. Só quem CRUZA os 30 dias agora
 *                         (janela curta): nunca varre o estoque antigo de uma vez.
 * A ▶ Retomada (ligação não atendida) fica de fora: depende do robô da 3C, parado desde 25/08.
 *
 * Tudo aqui é puro (cartão + relógio → decisão) para testar sem Kommo nem banco.
 */
import type { KommoLead } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';

export const ETIQUETA = {
  BOAS_VINDAS: '▶ Boas-vindas',
  CONFIRMAR_RETORNO: '▶ Confirmar retorno',
  REATIVACAO: '▶ Reativação',
} as const;
export type Etiqueta = (typeof ETIQUETA)[keyof typeof ETIQUETA];

export const CAMPO = {
  PROXIMA_SESSAO: '◷ Próxima sessão',
  TRATAMENTO_FECHADO: '⚕ Tratamento fechado',
  RESPONSAVEL: '☻ Responsável agendamento',
  OPT_OUT: '✓ Opt-out WhatsApp',
} as const;

/** Etiquetas que dizem "não mande nada pra este paciente". */
const NAO_CONTATAR = ['NO_FOLLOW_UP', 'Fluxo · Opt-out WhatsApp'];

const HORA = 3600;
const DIA = 24 * HORA;
/** Até quanto tempo depois de entrar em GANHO ainda vale dar as boas-vindas (campos chegam depois). */
export const JANELA_GANHO_S = 2 * DIA;
export const ANTECEDENCIA_RETORNO_S = DIA;
export const DIAS_REATIVACAO = 30;
/** Quem cruzou os 30 dias há mais que isso é estoque antigo: não entra. */
export const JANELA_REATIVACAO_S = 2 * DIA;

export type Decisao =
  | { tipo: 'coloca'; etiqueta: Etiqueta; chave: string; motivo: string; reaplica?: boolean }
  | { tipo: 'pula'; etiqueta: Etiqueta; chave: string; motivo: string };

type Cartao = Pick<KommoLead, 'id' | 'custom_fields_values' | '_embedded'> & { closed_at?: number | null };

function valor(lead: Cartao, nome: string): unknown {
  const alvo = normalizarNome(nome);
  const c = lead.custom_fields_values?.find((f) => normalizarNome(f.field_name ?? '') === alvo);
  return c?.values?.[0]?.value;
}

function preenchido(lead: Cartao, nome: string): boolean {
  const v = valor(lead, nome);
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/** Data de campo do Kommo: epoch em segundos — aceita ms e ISO por segurança. */
export function epochSeg(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e11 ? Math.floor(n / 1000) : n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function temEtiqueta(lead: Cartao, ...nomes: string[]): boolean {
  const tags = (lead._embedded?.tags ?? []).map((t) => t.name);
  return nomes.some((n) => tags.includes(n));
}

function optOut(lead: Cartao): boolean {
  if (temEtiqueta(lead, ...NAO_CONTATAR)) return true;
  return /^\s*sim\s*$/i.test(String(valor(lead, CAMPO.OPT_OUT) ?? ''));
}

const dataBR = (seg: number) =>
  new Date(seg * 1000).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Cartão que está em GANHO (COMERCIAL). `null` = não é com esta regra. */
export function decidirBoasVindas(lead: Cartao, agora: number): Decisao | null {
  const fechou = epochSeg(lead.closed_at);
  if (!fechou || agora - fechou > JANELA_GANHO_S || fechou > agora + HORA) return null;
  if (temEtiqueta(lead, ETIQUETA.BOAS_VINDAS, 'Fluxo · Boas-vindas enviadas')) return null;
  const chave = `boas-vindas:${lead.id}:${fechou}`;
  if (optOut(lead)) return { tipo: 'pula', etiqueta: ETIQUETA.BOAS_VINDAS, chave, motivo: 'paciente pediu para não receber mensagens' };
  const faltam = [CAMPO.TRATAMENTO_FECHADO, CAMPO.PROXIMA_SESSAO].filter((c) => !preenchido(lead, c));
  if (faltam.length) {
    return { tipo: 'pula', etiqueta: ETIQUETA.BOAS_VINDAS, chave, motivo: `falta ${faltam.join(' e ')} — o modelo sairia com buraco (tenta de novo até 48 h depois do GANHO)` };
  }
  return { tipo: 'coloca', etiqueta: ETIQUETA.BOAS_VINDAS, chave, motivo: `entrou em GANHO em ${dataBR(fechou)}` };
}

/** Cartão em RETORNO PÓS-TRATAMENTO. */
export function decidirConfirmarRetorno(lead: Cartao, agora: number): Decisao | null {
  const quando = epochSeg(valor(lead, CAMPO.PROXIMA_SESSAO));
  if (!quando || quando <= agora || quando - agora > ANTECEDENCIA_RETORNO_S) return null;
  const chave = `retorno:${lead.id}:${quando}`;
  if (optOut(lead)) return { tipo: 'pula', etiqueta: ETIQUETA.CONFIRMAR_RETORNO, chave, motivo: 'paciente pediu para não receber mensagens' };
  return {
    tipo: 'coloca',
    etiqueta: ETIQUETA.CONFIRMAR_RETORNO,
    chave,
    motivo: `retorno em ${dataBR(quando)}`,
    // A etiqueta de um retorno anterior ainda no cartão impediria o gatilho de "etiqueta adicionada".
    reaplica: temEtiqueta(lead, ETIQUETA.CONFIRMAR_RETORNO),
  };
}

/**
 * Cartão em PERDIDO (COMERCIAL). `ultimaConversa` = última mensagem que o sistema viu com este
 * paciente (epoch s), ou null quando nunca houve conversa pela IA.
 */
export function decidirReativacao(lead: Cartao, agora: number, ultimaConversa: number | null): Decisao | null {
  const perdeu = epochSeg(lead.closed_at);
  if (!perdeu) return null;
  const desde = agora - perdeu;
  const limite = DIAS_REATIVACAO * DIA;
  if (desde < limite || desde > limite + JANELA_REATIVACAO_S) return null;
  if (temEtiqueta(lead, ETIQUETA.REATIVACAO)) return null;
  const chave = `reativacao:${lead.id}:${perdeu}`;
  if (optOut(lead)) return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: 'paciente pediu para não receber mensagens' };
  if (ultimaConversa && agora - ultimaConversa < limite) {
    return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: `conversou em ${dataBR(ultimaConversa)}, menos de ${DIAS_REATIVACAO} dias` };
  }
  if (!preenchido(lead, CAMPO.RESPONSAVEL)) {
    return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: `${CAMPO.RESPONSAVEL} vazio — o modelo sairia "Aqui é , da Doutor Hérnia"` };
  }
  return { tipo: 'coloca', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: `${DIAS_REATIVACAO} dias em PERDIDO (desde ${dataBR(perdeu)}) sem conversa` };
}
