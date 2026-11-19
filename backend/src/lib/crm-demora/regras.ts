/**
 * «QUANDO A SDR DEMORA A RESPONDER» — as REGRAS PURAS (nada aqui fala com o banco, com o Chatwoot nem com o WhatsApp).
 *
 * O CUIDADO CENTRAL: o `waiting_since` do Chatwoot NÃO serve para contar a espera da equipe. No Chatwoot 4.19.1 ele é zerado por QUALQUER mensagem
 * pública de saída — usuário (inclusive o conector, por onde saem a nossa mensagem de espera, a régua e as tarefas), robô da Sofia e eco do
 * celular — então a nossa própria mensagem de espera apagaria a espera que ela veio denunciar. A espera é calculada pelas MENSAGENS:
 * `esperaDaEquipe` = a 1ª mensagem do paciente depois da última resposta HUMANA (usuário do CRM que não é o conector, ou o celular da unidade),
 * ignorando o robô (régua, tarefas), a mensagem de espera e as notas.
 *
 * Dois ajustes que o enunciado não pede mas que a conversa com a Sofia exige (sem eles, quando a Sofia passa uma conversa de 20 minutos de
 * papo o robô gritaria «20 min esperando» no mesmo segundo):
 *  - a fala da Sofia (robô do CRM, `agent_bot`) é um PISO: o paciente que ela respondeu não está esperando a equipe;
 *  - a passagem da Sofia (nota «Sofia passou esta conversa…» com a etiqueta `esperando-humano` de pé) abre a espera NO MOMENTO da passagem.
 */
import { ETIQUETA_HISTORICO, janelaDe24hAberta } from '../chatwoot-regua.js';
import { USUARIO_ROBO } from '../chatwoot-pausa.js';
import { ETIQUETA_HUMANO } from '../chatwoot-sofia.js';
import { ETIQUETA_SOFIA_ATENDENDO, sofiaPodeAtender } from '../chatwoot-sofia-atendendo.js';
import { ETIQUETA_SEM_FOLLOW_UP } from '../disparo/chatwoot/filtro.js';
import { ehRespostaDeCortesia } from '../cortesia.js';
import { dentroDaJanela, localParaUtc, type JanelaDeEnvio } from '../crm-tarefas/regras.js';
import { partesNoFuso } from '../fuso.js';
import type { ConversaLida } from '../chatwoot-porta.js';
import { AUTOMACAO_DEMORA, ehMensagemDeEspera, ehNotaDePassagem } from './marca.js';

export { AUTOMACAO_DEMORA };

export type Passo = 'espera' | 'aviso-10' | 'aviso-30';
export const PASSOS: readonly Passo[] = ['espera', 'aviso-10', 'aviso-30'];

/** Minutos de espera da equipe (dentro do horário de atender) a partir dos quais cada passo é devido. */
export const MINUTOS_DO_PASSO: Readonly<Record<Passo, number>> = { espera: 5, 'aviso-10': 10, 'aviso-30': 30 };
/**
 * Até quantos minutos de espera o passo ainda vale. Depois disso é atraso (servidor fora do ar, janela de horário fechada): não acorda ninguém
 * nem fala com o paciente sobre uma mensagem velha — nem a retomada de um deploy vira rajada.
 */
export const VALE_ATE_MINUTOS: Readonly<Record<Passo, number>> = { espera: 60, 'aviso-10': 90, 'aviso-30': 180 };
/** Com a etiqueta `sofia-atendendo` (e o tanto de espera em minutos úteis), os avisos à equipe esperam este tanto: a Sofia está conversando. Passou disso, ela travou — a equipe é avisada. */
export const SOFIA_TRAVADA_APOS_MINUTOS = 15;
/** O paciente escreveu há menos que isto e a Sofia pode responder: a mensagem de espera NÃO sai (a rodada da Sofia ainda vai ler a conversa). */
export const SOFIA_AINDA_LENDO_MS = 3 * 60_000;

// ── 1. as mensagens da conversa → papéis ─────────────────────────────────────────────────────────────

export type Papel = 'paciente' | 'humano' | 'sofia' | 'robo' | 'passagem';

export interface MensagemDaConversa {
  papel: Papel;
  em: Date;
  /** só paciente: «ok, obrigada» sem anexo (não abre espera quando já houve resposta nossa antes) */
  cortesia?: boolean;
}

const atributos = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
};

/**
 * Uma mensagem crua do Chatwoot (`/conversations/:id/messages`) → o papel dela na conversa. `null` = não conta (atividade, nota, a nossa mensagem de espera).
 * Quem responde e não sabemos quem é (saída sem remetente e sem eco) conta como HUMANO: na dúvida, não incomoda ninguém.
 */
export function classificarMensagem(m: any, robos: ReadonlySet<number> = new Set()): MensagemDaConversa | null {
  const tipo = Number(m?.message_type);
  const em = new Date(Number(m?.created_at) * 1000);
  if (!Number.isFinite(em.getTime()) || em.getTime() <= 0) return null;
  if (tipo === 2) return null;
  if (m?.private === true) return ehNotaDePassagem(m?.content) ? { papel: 'passagem', em } : null;
  if (tipo === 0) {
    const texto = typeof m?.content === 'string' ? m.content.trim() : '';
    const anexos = Array.isArray(m?.attachments) && m.attachments.length > 0;
    return { papel: 'paciente', em, cortesia: !anexos && texto !== '' && ehRespostaDeCortesia(texto) };
  }
  if (tipo !== 1 && tipo !== 3) return null;
  if (ehMensagemDeEspera(m)) return null;
  if (tipo === 3) return { papel: 'robo', em };
  const eco = atributos(m?.content_attributes).external_echo;
  if (eco === true || eco === 'true') return { papel: 'humano', em };
  const tipoDoRemetente = String(m?.sender?.type ?? m?.sender_type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (tipoDoRemetente === 'agentbot') return { papel: 'sofia', em };
  const id = Number(m?.sender?.id ?? m?.sender_id);
  // o conector (régua, tarefas, disparos) é o usuário 2 na conta 1; numa clínica de conta própria é outro id (`robos` traz o da conta)
  if (tipoDoRemetente === 'user' && (id === USUARIO_ROBO || robos.has(id))) return { papel: 'robo', em };
  // usuário do CRM (inclusive o «📱 Celular da unidade» da caixa Evolution) ou remetente desconhecido: gente
  return { papel: 'humano', em };
}

export const mensagensDaConversa = (cruas: unknown[], robos: ReadonlySet<number> = new Set()): MensagemDaConversa[] =>
  cruas.map((m) => classificarMensagem(m, robos)).filter((m): m is MensagemDaConversa => m !== null);

// ── 2. desde quando a equipe está devendo resposta ───────────────────────────────────────────────────

export interface EsperaDaEquipe {
  /** o instante em que a conversa passou a ser da equipe responder */
  desde: Date;
  /** a mensagem mais nova do paciente (janela de 24 h do WhatsApp); null só na passagem sem mensagem nova */
  ultimaDoPaciente: Date | null;
  /** a espera abriu pela passagem da Sofia, não por uma mensagem do paciente */
  pelaPassagem: boolean;
}

/**
 * `null` = a equipe não deve resposta. `esperandoHumano` = a conversa tem a etiqueta `esperando-humano` (a Sofia passou e continua passada).
 */
export function esperaDaEquipe(mensagens: readonly MensagemDaConversa[], o: { esperandoHumano: boolean }): EsperaDaEquipe | null {
  const ordem = [...mensagens].sort((a, b) => a.em.getTime() - b.em.getTime());
  const pacientes = ordem.filter((m) => m.papel === 'paciente');
  const ultimaDoPaciente = pacientes.at(-1)?.em ?? null;
  const t = (papel: Papel) => ordem.filter((m) => m.papel === papel).at(-1)?.em.getTime() ?? 0;
  const humana = t('humano');
  const sofia = t('sofia');
  const passagem = t('passagem');
  // a Sofia passou e a etiqueta continua: a espera da equipe abre na passagem (se a equipe respondeu depois, `humana` é maior e não há espera)
  if (o.esperandoHumano && passagem > humana) return { desde: new Date(passagem), ultimaDoPaciente, pelaPassagem: true };
  const piso = Math.max(humana, sofia);
  for (const p of pacientes) {
    if (p.em.getTime() <= piso) continue;
    // «ok, obrigada» depois de uma resposta nossa (de gente, da Sofia ou da régua) não é o paciente esperando
    const jaRespondemos = ordem.some((m) => (m.papel === 'humano' || m.papel === 'sofia' || m.papel === 'robo') && m.em.getTime() < p.em.getTime());
    if (p.cortesia && jaRespondemos) continue;
    return { desde: p.em, ultimaDoPaciente, pelaPassagem: false };
  }
  return null;
}

// ── 3. o que fazer agora ─────────────────────────────────────────────────────────────────────────────

export interface EntradaDaDecisao {
  espera: EsperaDaEquipe | null;
  agora: Date;
  fuso: string;
  janela: JanelaDeEnvio;
  /** open | pending | resolved | snoozed */
  status: string;
  lida: Pick<ConversaLida, 'etiquetas' | 'grupo' | 'interno' | 'attrs'>;
  /** a Sofia está ligada na unidade (`chatwoot-ia` = ligado) */
  iaLigada: boolean;
  /** a conversa é de caixa de WhatsApp oficial (a janela de 24 h vale) */
  caixaOficial: boolean;
}

const z2 = (n: number) => String(n).padStart(2, '0');

/**
 * Quantos minutos da espera caíram DENTRO do horário de atender (8h–20h do fuso da unidade). Quem escreve às 20h10 e não é respondido está esperando
 * 5 minutos às 8h05 do dia seguinte — e é aí que a mensagem de espera e os avisos começam; contar o relógio corrido deixaria a conversa mais parada da
 * noite fora de todos os prazos. Mais de uma semana corrida = «muito», sem conta.
 */
export function minutosUteis(desde: Date, agora: Date, fuso: string, j: JanelaDeEnvio): number {
  if (agora.getTime() <= desde.getTime()) return 0;
  const MAX_DIAS = 8;
  if (agora.getTime() - desde.getTime() > MAX_DIAS * 86_400_000) return 999_999;
  const p0 = partesNoFuso(desde, fuso);
  const dia0 = Date.UTC(p0.ano, p0.mes - 1, p0.dia);
  let total = 0;
  for (let i = 0; i <= MAX_DIAS + 1; i++) {
    const d = new Date(dia0 + i * 86_400_000);
    const rotulo = (dd: Date, hora: number) => `${dd.getUTCFullYear()}-${z2(dd.getUTCMonth() + 1)}-${z2(dd.getUTCDate())}T${z2(hora)}:00`;
    const ini = localParaUtc(rotulo(d, j.inicio), fuso);
    const fim = j.fim >= 24 ? localParaUtc(rotulo(new Date(d.getTime() + 86_400_000), 0), fuso) : localParaUtc(rotulo(d, j.fim), fuso);
    if (!ini || !fim) continue;
    if (ini.getTime() >= agora.getTime()) break;
    const de = Math.max(ini.getTime(), desde.getTime());
    const ate = Math.min(fim.getTime(), agora.getTime());
    if (ate > de) total += ate - de;
  }
  return Math.floor(total / 60_000);
}

/** «10 min», «2 h», «14 h 30 min». */
export function duracaoCurta(minutos: number): string {
  const m = Math.max(0, Math.round(minutos));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export interface Decisao {
  /** minutos de espera DENTRO do horário de atender (o que decide os passos) */
  minutos: number;
  /** minutos corridos desde que a espera abriu (o que o texto diz) */
  minutosReais: number;
  devidos: Passo[];
  /** o que NÃO sai e por quê (só para o resumo do ciclo e o seco) */
  barrados: Array<{ passo: Passo; motivo: string }>;
}

const tem = (etiquetas: readonly string[], e: string) => etiquetas.some((x) => x.trim().toLowerCase() === e);

export function decidirDemora(e: EntradaDaDecisao): Decisao {
  const vazio: Decisao = { minutos: 0, minutosReais: 0, devidos: [], barrados: [] };
  if (!e.espera) return vazio;
  const minutos = minutosUteis(e.espera.desde, e.agora, e.fuso, e.janela);
  const saida: Decisao = { minutos, minutosReais: Math.max(0, Math.floor((e.agora.getTime() - e.espera.desde.getTime()) / 60_000)), devidos: [], barrados: [] };
  if (minutos < MINUTOS_DO_PASSO.espera) return saida;
  const etiquetas = e.lida.etiquetas;
  // conversa que não é de paciente a atender: nada sai (nem aviso à equipe)
  const naoE = e.lida.grupo ? 'grupo' : e.lida.interno ? 'contato interno' : tem(etiquetas, ETIQUETA_HISTORICO) ? 'histórico' : e.status !== 'open' && e.status !== 'pending' ? `conversa ${e.status || 'sem status'}` : null;
  const foraDoHorario = !dentroDaJanela(e.agora, e.fuso, e.janela);
  const sofiaAtendendo = tem(etiquetas, ETIQUETA_SOFIA_ATENDENDO);
  const sofiaPodeResponder = e.iaLigada && sofiaPodeAtender({ status: e.status, lida: { id: 0, nome: '', telefone: null, attrs: e.lida.attrs, etiquetas: [...etiquetas], grupo: e.lida.grupo, interno: e.lida.interno } });
  const hora = e.agora.getTime();

  for (const passo of PASSOS) {
    if (minutos < MINUTOS_DO_PASSO[passo]) continue;
    const barra = (motivo: string) => saida.barrados.push({ passo, motivo });
    if (minutos > VALE_ATE_MINUTOS[passo]) {
      barra('passou do prazo do aviso');
      continue;
    }
    if (naoE) {
      barra(naoE);
      continue;
    }
    if (foraDoHorario) {
      barra('fora do horário (8h–20h da unidade)');
      continue;
    }
    if (passo === 'espera') {
      if (sofiaAtendendo) barra('a Sofia está atendendo (etiqueta sofia-atendendo)');
      else if (tem(etiquetas, ETIQUETA_SEM_FOLLOW_UP)) barra('etiqueta sem-follow-up');
      else if (e.caixaOficial && !janelaDe24hAberta(e.espera.ultimaDoPaciente, e.agora)) barra('janela de 24 h do WhatsApp fechada');
      else if (sofiaPodeResponder && e.espera.ultimaDoPaciente && hora - e.espera.ultimaDoPaciente.getTime() < SOFIA_AINDA_LENDO_MS) barra('a Sofia ainda vai ler a conversa');
      else saida.devidos.push(passo);
      continue;
    }
    if (sofiaAtendendo && minutos < SOFIA_TRAVADA_APOS_MINUTOS) {
      barra('a Sofia está atendendo (etiqueta sofia-atendendo)');
      continue;
    }
    saida.devidos.push(passo);
  }
  return saida;
}

/** O dia no fuso da unidade, «2026-11-19» (chave de «1 mensagem de espera por conversa por dia»). */
export function diaNoFuso(d: Date, fuso: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p;
}

/** A chave de um episódio de espera: o instante em que a espera abriu, em segundos. Mesma espera = mesma chave; a equipe respondeu e o paciente voltou = chave nova. */
export const chaveDoEpisodio = (desde: Date): string => `ep${Math.floor(desde.getTime() / 1000)}`;
