/**
 * Lembrete das demandas abertas do suporte — às 9h e às 17h (America/Sao_Paulo), no @ddchamados_bot do João.
 *
 * Um resumo por horário, com cada demanda aberta (protocolo, quem pediu, unidade, há quanto tempo, 1 linha do relato).
 * SEM demanda aberta não manda nada. Aberta = status `aberta` ou `reaberta` (a `resolvida` espera só o "funcionou?" da pessoa).
 *
 * Esta parte é a regra (pura: sem banco, sem rede, sem timer); o timer e o banco ficam em `suporte-lembrete-worker.ts`.
 *
 * Liga/desliga: `SUPORTE_LEMBRETE` = `desligado` (padrão) | `seco` (monta o texto e escreve no log, não envia) | `ligado`.
 * O lembrete é independente do `SUPORTE_MENU`: demanda aberta existe mesmo com o menu desligado ou pausado.
 *
 * Uma vez por horário: o worker roda só no líder e cada envio tem ainda o seu lease (`suporte-lembrete:AAAA-MM-DD:HH`), porque o líder
 * muda justamente na janela do deploy.
 */
import { diaLocal, relogioLocal } from './qualidade-ia/dias.js';
import type { EstadoPausa } from './suporte-pausa.js';
import { quandoEmSP, SEM_PAUSA } from './suporte-pausa.js';
import { modoDoSuporte, type ModoSuporte } from './suporte-menu.js';

export type ModoLembrete = ModoSuporte;

/** Horas cheias (SP) em que o resumo sai. Passou da hora cheia (fora dessa hora), perdeu: resumo velho não serve. */
export const HORAS_DO_LEMBRETE: readonly number[] = [9, 17];
/** Tentativas de envio por horário quando o Telegram falha (o worker passa a cada minuto). */
export const TENTATIVAS_POR_HORARIO = 5;
/** O Telegram corta em 4096 (e `telegram.ts` em 3500): o resumo mostra no máximo isto e manda o resto para o painel. */
export const MAX_DEMANDAS_NO_TEXTO = 12;
export const MAX_RELATO_NO_TEXTO = 110;
export const PREFIXO_DO_LEASE = 'suporte-lembrete:';
export const TTL_DO_LEASE_MS = 3 * 60 * 60_000;
export const PAINEL_URL = 'https://suporte.doutordigitalconsultoria.com';

/** Mesma regra do `SUPORTE_MENU` (uma só para as duas chaves): vazio ou valor estranho = desligado. */
export const modoDoLembrete: (raw: string | undefined | null) => ModoLembrete = modoDoSuporte;

export function valorDoLembreteReconhecido(raw: string | undefined | null): boolean {
  return ['', 'desligado', 'seco', 'ligado'].includes(String(raw ?? '').trim().toLowerCase());
}

export interface Horario {
  /** AAAA-MM-DD em São Paulo */
  dia: string;
  hora: number;
  /** chave única do horário: `2026-11-11:09` */
  chave: string;
}

/** O horário de lembrete em que `agora` está (a hora cheia inteira: 9h00–9h59 e 17h00–17h59), ou null. */
export function horarioDaVez(agora: Date): Horario | null {
  const { hora } = relogioLocal(agora);
  if (!HORAS_DO_LEMBRETE.includes(hora)) return null;
  const dia = diaLocal(agora);
  return { dia, hora, chave: `${dia}:${String(hora).padStart(2, '0')}` };
}

export interface DemandaAberta {
  protocolo: number;
  nome: string | null;
  /** nome da unidade, se conhecido; senão o slug; senão null */
  unidade: string | null;
  relato: string;
  criadoEm: Date;
  status: string;
}

/** "42 min", "5 h", "2 d 3 h" */
export function haQuanto(desde: Date, agora: Date): string {
  const min = Math.max(0, Math.floor((agora.getTime() - desde.getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  const resto = h % 24;
  return resto ? `${d} d ${resto} h` : `${d} d`;
}

/** Uma linha só: sem quebra, sem controle, cortada. O relato é texto de quem escreveu no WhatsApp: é DADO, e o Telegram o recebe como texto puro. */
export function umaLinha(texto: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const limpo = String(texto ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1).trimEnd()}…` : limpo;
}

/** O resumo; null quando não há demanda aberta (nesse caso NÃO se manda nada). */
export function montarLembrete(d: { demandas: readonly DemandaAberta[]; total: number; reabertas: number; hora: number; agora: Date; pausa: EstadoPausa }): string | null {
  if (d.total <= 0 || d.demandas.length === 0) return null;
  const reabertas = d.reabertas;
  const linhas: string[] = [`📋 Suporte — ${d.total} demanda${d.total > 1 ? 's' : ''} aberta${d.total > 1 ? 's' : ''} (resumo das ${d.hora}h)${reabertas ? ` · ${reabertas} reaberta${reabertas > 1 ? 's' : ''}` : ''}`];
  if (d.pausa.pausado) linhas.push(`⏸ Menu PAUSADO desde ${d.pausa.desde ? quandoEmSP(d.pausa.desde) : '?'} — /voltar para retomar`);
  linhas.push('');
  for (const x of d.demandas.slice(0, MAX_DEMANDAS_NO_TEXTO)) {
    const quem = x.nome ? umaLinha(x.nome, 40) : '(sem nome)';
    const unidade = x.unidade ? umaLinha(x.unidade, 40) : 'unidade não informada';
    linhas.push(`#${x.protocolo}${x.status === 'reaberta' ? ' 🔁' : ''} · ${quem} · ${unidade} · há ${haQuanto(x.criadoEm, d.agora)}`);
    linhas.push(`«${umaLinha(x.relato, MAX_RELATO_NO_TEXTO)}»`);
  }
  const fora = d.total - Math.min(d.demandas.length, MAX_DEMANDAS_NO_TEXTO);
  if (fora > 0) linhas.push('', `… e mais ${fora} no painel.`);
  linhas.push('', `Painel: ${PAINEL_URL}`);
  return linhas.join('\n');
}

// ─── a execução de um passo (com tudo de fora injetado, para o teste) ───────────────────────────────────────

export type DesfechoLembrete =
  | 'fora-do-horario'
  | 'desligado'
  | 'ja-feito'
  | 'sem-demanda'
  | 'seco'
  | 'enviado'
  | 'de-outro'
  | 'sem-lease'
  | 'falhou-envio'
  | 'desistiu';

export interface DepsLembrete {
  agora(): Date;
  modo(): ModoLembrete;
  /** as abertas — as reabertas primeiro (já foram dadas como resolvidas), depois da mais antiga para a mais nova —, no máximo `limite`; `total` e `reabertas` contam TODAS */
  demandasAbertas(limite: number): Promise<{ demandas: DemandaAberta[]; total: number; reabertas: number }>;
  pausa(): Promise<EstadoPausa>;
  /** 'minha' = pode enviar; 'de-outro' = outro processo já cuida deste horário; 'erro' = banco fora */
  reivindicar(nome: string, ttlMs: number): Promise<'minha' | 'de-outro' | 'erro'>;
  liberar(nome: string): Promise<void>;
  enviar(texto: string): Promise<boolean>;
  registrar(nivel: 'info' | 'warn' | 'error', dados: Record<string, unknown>, mensagem: string): void;
}

/** Memória do processo (o lease cobre o resto): horários já resolvidos e tentativas de envio por horário. */
export interface MemoriaDoLembrete {
  resolvidos: Set<string>;
  tentativas: Map<string, number>;
}
export const memoriaNova = (): MemoriaDoLembrete => ({ resolvidos: new Set(), tentativas: new Map() });

export async function passoDoLembrete(deps: DepsLembrete, mem: MemoriaDoLembrete): Promise<DesfechoLembrete> {
  const modo = deps.modo();
  if (modo === 'desligado') return 'desligado';
  const agora = deps.agora();
  const h = horarioDaVez(agora);
  if (!h) return 'fora-do-horario';
  if (mem.resolvidos.has(h.chave)) return 'ja-feito';

  const { demandas, total, reabertas } = await deps.demandasAbertas(MAX_DEMANDAS_NO_TEXTO);
  // a pausa só vira uma linha informativa: se não der para ler, o resumo sai igual (o lembrete não depende do menu)
  const pausa = await deps.pausa().catch((err: unknown) => {
    deps.registrar('warn', { err: String(err) }, 'suporte-lembrete: não consegui ler a pausa — seguindo sem a linha de pausa');
    return SEM_PAUSA;
  });
  const texto = montarLembrete({ demandas, total, reabertas, hora: h.hora, agora, pausa });
  if (texto === null) {
    // nada aberto neste horário: não manda nada. Fica resolvido, para não consultar o banco a cada minuto da hora inteira.
    mem.resolvidos.add(h.chave);
    return 'sem-demanda';
  }
  if (modo === 'seco') {
    mem.resolvidos.add(h.chave);
    deps.registrar('info', { horario: h.chave, total, texto }, 'suporte-lembrete (seco): mandaria este resumo');
    return 'seco';
  }

  const nome = `${PREFIXO_DO_LEASE}${h.chave}`;
  const lease = await deps.reivindicar(nome, TTL_DO_LEASE_MS);
  if (lease === 'erro') return 'sem-lease'; // banco fora: tenta de novo no próximo minuto (a hora cheia é o limite)
  if (lease === 'de-outro') {
    mem.resolvidos.add(h.chave);
    return 'de-outro';
  }
  const enviou = await deps.enviar(texto);
  if (enviou) {
    mem.resolvidos.add(h.chave);
    deps.registrar('info', { horario: h.chave, total }, 'suporte-lembrete: resumo enviado');
    return 'enviado';
  }
  // não chegou: solta o lease para o próprio processo (ou o próximo líder) tentar de novo, com teto de tentativas
  await deps.liberar(nome);
  const n = (mem.tentativas.get(h.chave) ?? 0) + 1;
  mem.tentativas.set(h.chave, n);
  if (n >= TENTATIVAS_POR_HORARIO) {
    mem.resolvidos.add(h.chave);
    deps.registrar('error', { horario: h.chave, tentativas: n }, 'suporte-lembrete: o Telegram não aceitou o resumo — desisti deste horário');
    return 'desistiu';
  }
  deps.registrar('warn', { horario: h.chave, tentativa: n }, 'suporte-lembrete: o resumo não chegou ao Telegram — tento de novo no próximo minuto');
  return 'falhou-envio';
}
