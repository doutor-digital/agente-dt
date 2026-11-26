/**
 * Vigia de CAIXA PARADA (reclamação nº 1 das unidades, 26/11/2026): «o lead chega no WhatsApp e não entra no CRM». Ninguém vê isso falhar:
 * a caixa só fica em silêncio, e o silêncio de uma caixa de 6 mensagens por hora e o de uma caixa quebrada são iguais a olho nu.
 *
 * Em cada caixa registrada (`unit_chatwoot_caixa`, fora a de histórico), a cada 15 min, compara o que ERA ESPERADO com o que ENTROU e lê o Kapso:
 *  1. SILÊNCIO — zero mensagem de PACIENTE nas últimas X horas CHEIAS (padrão 3), todas dentro do horário comercial da unidade, quando a média
 *     da própria caixa para essas mesmas horas do dia (últimos 14 dias, só dias úteis) diz que deveriam ter entrado pelo menos 4. Com 4 esperadas a
 *     chance de zero por acaso é ~2%; sem histórico (menos de 5 dias comparáveis) não avisa. A série vem dos relatórios do próprio Chatwoot
 *     (`incoming_messages_count` por hora, por caixa).
 *  2. KAPSO (só caixa de WhatsApp oficial, com número do Kapso e KAPSO_API_KEY):
 *     - ENTREGA com erro: o Kapso entrega cada mensagem ao CRM por webhook (`GET /platform/v1/webhook_deliveries`); entrega que ficou sem entregar (`failed_at`
 *       sem `delivered_at`, ou resposta 4xx/5xx) é mensagem de paciente que NÃO entrou;
 *     - SAÚDE do número (`GET /platform/v1/whatsapp/phone_numbers`, `…/<id>/health`): número que não está CONECTADO, recebimento desligado, conexão, inscrição ou
 *       verificação do webhook falhando. A «saúde de ENVIO» (`messaging_health`, ex. nome de exibição em análise) NÃO conta: não impede de receber;
 *     - quando o silêncio dispara, lê quantas mensagens o Kapso recebeu na mesma janela: «o Kapso recebeu N e o CRM 0» (entrega quebrada) é diferente de
 *       «nada chegou nem no Kapso» (número, Meta ou campanha).
 *
 * Avisa no WhatsApp do João (`alerta-whatsapp.ts`) e, se `CAIXA_VIGIA_DESTINOS` tiver o grupo da unidade, no grupo da clínica. Texto sem nome nem
 * telefone de paciente. UM aviso por caixa a cada 3 h (a marca fica no banco — `chatwoot_regua_disparo`, regra `vigia-caixa` — e vale entre reinícios).
 *
 * Chave por unidade `chatwoot-vigia` (CHATWOOT_VIGIA_SLUGS): NASCE EM SECO (decide e loga «[SECO] avisaria…», não manda nada e não grava nada).
 * `CAIXA_VIGIA=0` desliga o worker inteiro. Só lê o Chatwoot e o Kapso (GET); a única escrita é a marca do aviso, só no modo ligado.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { avisarJoao, configurado, enviarPelaEvolutionComResultado, type ResultadoDoEnvio } from './alerta-whatsapp.js';
import { ehFeriadoNacionalAgora } from './feriados.js';
import { fusoDaUnidade, offsetMinutosNoFuso, partesNoFuso } from './fuso.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { configDaUnidade, unidadeDaCaixa } from './chatwoot-unidades.js';
import { contextoDaCaixa, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

export const ID_VIGIA = 'chatwoot-vigia';
export const REGRA_VIGIA = 'vigia-caixa';

const HORA_MS = 3_600_000;
export const HISTORICO_DIAS = 14;
/** Menos dias comparáveis que isto: a média não vale e o silêncio não avisa. */
export const MIN_DIAS_COMPARAVEIS = 5;
/** Esperadas na janela para o silêncio valer (com 4, a chance de zero por acaso é ~e^-4 = 1,8%). */
export const ESPERADO_MINIMO = 4;
/** Um aviso por caixa a cada 3 h. */
export const INTERVALO_DO_AVISO_MS = 3 * HORA_MS;
const SWEEP_MS = 15 * 60_000;
const PRIMEIRA_VARREDURA_MS = 5 * 60_000;
/** A mensagem que chegou ao Kapso há menos que isto ainda pode estar a caminho do CRM: não conta como «Kapso recebeu e o CRM não». */
const FOLGA_DA_ENTREGA_MS = 10 * 60_000;

export const estadoDoVigia = (slug: string): Estado => estadoDaAutomacao(slug, ID_VIGIA, process.env.CHATWOOT_VIGIA_SLUGS);

/** As X horas da janela: `CAIXA_VIGIA_HORAS` (1 a 12), padrão 3. */
export function horasDaJanela(env: NodeJS.ProcessEnv = process.env): number {
  const n = Math.floor(Number(env.CAIXA_VIGIA_HORAS));
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : 3;
}

// ── horário comercial e a média esperada (puro) ───────────────────────────────────────────────────────────────

export interface HorarioDaUnidade {
  spineAgendaDays?: number[] | null;
  spineAgendaStart?: string | null;
  spineAgendaEnd?: string | null;
  businessHoursTimezone?: string | null;
  spineTimezone?: string | null;
}

const minutosDe = (hhmm: string | null | undefined): number | null => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null;
};

const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function diaDaSemanaNoFuso(d: Date, tz: string): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  return DIAS[w] ?? 1;
}

/** A HORA CHEIA que começa em `inicio` cabe inteira no horário comercial da unidade (dias da agenda, 8h–20h no máximo, sem feriado nacional)? */
export function horaCheiaComercial(u: HorarioDaUnidade, inicio: Date): boolean {
  const tz = fusoDaUnidade({ businessHoursTimezone: u.businessHoursTimezone ?? undefined, spineTimezone: u.spineTimezone ?? undefined });
  if (ehFeriadoNacionalAgora(inicio, tz)) return false;
  const dias = u.spineAgendaDays?.length ? u.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(diaDaSemanaNoFuso(inicio, tz))) return false;
  const p = partesNoFuso(inicio, tz);
  const abre = Math.max(minutosDe(u.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const fecha = Math.min(minutosDe(u.spineAgendaEnd) ?? 20 * 60, 20 * 60);
  const min = p.hora * 60 + p.min;
  return min >= abre && min + 60 <= fecha;
}

/** Série horária de mensagens de paciente: início da hora (ms, UTC) → quantidade. Hora ausente = 0. */
export type Serie = ReadonlyMap<number, number>;

export function serieDosRelatorios(baldes: ReadonlyArray<{ value?: unknown; timestamp?: unknown }>): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of baldes) {
    const t = Number(b?.timestamp);
    const v = Number(b?.value);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(v) || v < 0) continue;
    m.set(Math.floor(t / 3600) * HORA_MS, v);
  }
  return m;
}

export interface DecisaoDoSilencio {
  /** `silencio` = avisar; `ok` = entrou mensagem; `pouco-esperado` = a média não justifica cobrar; `sem-historico`; `fora-do-horario` = alguma hora da janela não é comercial */
  veredito: 'silencio' | 'ok' | 'pouco-esperado' | 'sem-historico' | 'fora-do-horario';
  observado: number;
  esperado: number;
  horas: number;
  /** início da janela (ms) — o relógio das X horas cheias que já terminaram */
  desde: number;
  ate: number;
}

/**
 * Silêncio? Janela = as `horas` horas CHEIAS que já terminaram (a hora em curso fica de fora: ela ainda está enchendo). Todas dentro do horário
 * comercial. Esperado = soma, para cada hora do dia da janela, da MÉDIA dessa hora nos últimos `dias` dias úteis comparáveis.
 */
export function decidirSilencio(a: { serie: Serie; unidade: HorarioDaUnidade; agora: number; horas?: number; dias?: number }): DecisaoDoSilencio {
  const horas = a.horas ?? 3;
  const dias = a.dias ?? HISTORICO_DIAS;
  const ate = Math.floor(a.agora / HORA_MS) * HORA_MS;
  const desde = ate - horas * HORA_MS;
  const base = { horas, desde, ate };
  const janela = Array.from({ length: horas }, (_, i) => desde + i * HORA_MS);
  if (!janela.every((h) => horaCheiaComercial(a.unidade, new Date(h)))) return { ...base, veredito: 'fora-do-horario', observado: 0, esperado: 0 };
  const observado = janela.reduce((s, h) => s + (a.serie.get(h) ?? 0), 0);
  if (observado > 0) return { ...base, veredito: 'ok', observado, esperado: 0 };
  // a média de cada hora do dia: os mesmos horários dos `dias` anteriores à janela, só nos que também foram comerciais
  let esperado = 0;
  let diasComparaveis = Infinity;
  for (const h of janela) {
    let soma = 0;
    let n = 0;
    for (let d = 1; d <= dias; d++) {
      const t = h - d * 24 * HORA_MS;
      // dia comparável = a hora está na série (o relatório do Chatwoot traz o balão mesmo com zero) E foi comercial; hora sem dado não é «zero», é falta de histórico
      if (!a.serie.has(t) || !horaCheiaComercial(a.unidade, new Date(t))) continue;
      soma += a.serie.get(t) ?? 0;
      n++;
    }
    diasComparaveis = Math.min(diasComparaveis, n);
    esperado += n ? soma / n : 0;
  }
  if (diasComparaveis < MIN_DIAS_COMPARAVEIS) return { ...base, veredito: 'sem-historico', observado, esperado };
  return { ...base, veredito: esperado >= ESPERADO_MINIMO ? 'silencio' : 'pouco-esperado', observado, esperado };
}

// ── o Chatwoot: série horária pelos relatórios (só leitura) ───────────────────────────────────────────────────────

/** `incoming_messages_count` por hora da caixa nos últimos `dias` dias. Lança em erro (quem chama decide). */
export async function serieDaCaixa(ctx: ContextoChatwoot, caixa: number, agoraMs: number, tz: string, dias = HISTORICO_DIAS + 1): Promise<Map<number, number>> {
  const conta = ctx.conta;
  if (!conta) throw new Error('sem conta do Chatwoot');
  const ate = Math.floor(agoraMs / 1000);
  const desde = ate - dias * 86_400;
  const offset = Math.round(offsetMinutosNoFuso(new Date(agoraMs), tz) / 60); // os baldes do Chatwoot são cheios na hora local
  const url = `${conta.url}/api/v2/accounts/${conta.conta}/reports?metric=incoming_messages_count&type=inbox&id=${caixa}&since=${desde}&until=${ate}&group_by=hour&timezone_offset=${offset}`;
  const r = await ctx.fetch(url, { headers: { api_access_token: conta.token, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`relatório do Chatwoot respondeu ${r.status}`);
  const j = (await r.json().catch(() => null)) as unknown;
  if (!Array.isArray(j)) throw new Error('relatório do Chatwoot sem lista');
  return serieDosRelatorios(j as Array<{ value?: unknown; timestamp?: unknown }>);
}

// ── o Kapso (só leitura; a chave só no cabeçalho) ─────────────────────────────────────────────────────────────────

const KAPSO = 'https://api.kapso.ai/platform/v1';
const PAGINAS_MAX = 5;

export interface NumeroDoKapso {
  id: string;
  status: string | null;
  recebimentoLigado: boolean | null;
}

export interface PortaDoKapso {
  numeros(): Promise<Map<string, NumeroDoKapso>>;
  /** problemas de RECEBER (conexão, inscrição e verificação do webhook); [] = saudável; null = não deu para ler */
  saude(numero: string): Promise<string[] | null>;
  /** entregas ao CRM que ficaram SEM entregar desde `desdeMs`, por número */
  entregasComErro(desdeMs: number): Promise<Map<string, number> | null>;
  /** mensagens de paciente que o Kapso recebeu no intervalo; null = não deu para ler */
  entradas(numero: string, desdeMs: number, ateMs: number): Promise<number | null>;
}

const falhou = (e: { failed_at?: unknown; delivered_at?: unknown; response_status?: unknown }): boolean => {
  if (e.delivered_at) return false;
  const st = Number(e.response_status);
  return Boolean(e.failed_at) || (Number.isFinite(st) && st >= 400);
};

/** Pura: o que a resposta de saúde diz que impede de RECEBER. */
export function problemasDeReceber(h: unknown, n?: Pick<NumeroDoKapso, 'status' | 'recebimentoLigado'>): string[] {
  const p: string[] = [];
  if (n?.status && n.status !== 'CONNECTED') p.push(`número ${n.status}`);
  if (n?.recebimentoLigado === false) p.push('recebimento desligado no Kapso');
  const checks = ((h ?? {}) as { checks?: Record<string, { passed?: unknown }> }).checks ?? {};
  const nomes: Record<string, string> = { phone_number_connection: 'conexão do número', webhook_subscription: 'inscrição do webhook na Meta', webhook_verified: 'verificação do webhook' };
  for (const [k, rotulo] of Object.entries(nomes)) if (checks[k] && checks[k]!.passed === false) p.push(`${rotulo} falhando`);
  return p;
}

export function kapsoReal(chave: string, buscar: typeof fetch = fetch): PortaDoKapso {
  async function ler(caminho: string): Promise<any> {
    const r = await buscar(`${KAPSO}${caminho}`, { headers: { 'X-API-Key': chave, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Kapso respondeu ${r.status} em ${caminho.split('?')[0]}`);
    return r.json();
  }
  const mascara = (err: unknown) => String(err).split(chave).join('***');
  return {
    async numeros() {
      const m = new Map<string, NumeroDoKapso>();
      try {
        const j = await ler('/whatsapp/phone_numbers?per_page=100');
        for (const p of Array.isArray(j?.data) ? j.data : []) {
          const id = String(p?.phone_number_id ?? p?.id ?? ''); // o id da Meta (o mesmo que a unidade guarda); na lista do Kapso `id` e `phone_number_id` são iguais (conferido)
          if (id) m.set(id, { id, status: typeof p.status === 'string' ? p.status : null, recebimentoLigado: typeof p.inbound_processing_enabled === 'boolean' ? p.inbound_processing_enabled : null });
        }
      } catch (err) {
        logger.warn({ err: mascara(err) }, `${ID_VIGIA}: não consegui listar os números do Kapso`);
      }
      return m;
    },
    async saude(numero) {
      try {
        return problemasDeReceber(await ler(`/whatsapp/phone_numbers/${encodeURIComponent(numero)}/health`));
      } catch (err) {
        logger.warn({ err: mascara(err) }, `${ID_VIGIA}: não consegui ler a saúde do número no Kapso`);
        return null;
      }
    },
    async entregasComErro(desdeMs) {
      try {
        const por = new Map<string, number>();
        // as mais novas primeiro: segue as páginas até passar do começo da janela (no máximo 5 — se a janela é maior que isso, o aviso diz o que viu)
        for (let pagina = 1; pagina <= PAGINAS_MAX; pagina++) {
          const j = await ler(`/webhook_deliveries?per_page=100&page=${pagina}`);
          const itens: any[] = Array.isArray(j?.data) ? j.data : [];
          let maisAntigo = Infinity;
          for (const e of itens) {
            const quando = Date.parse(String(e?.created_at ?? ''));
            if (Number.isFinite(quando)) maisAntigo = Math.min(maisAntigo, quando);
            // só a entrega de MENSAGEM de paciente ao CRM (o eco do celular da equipe e outros eventos não são lead que deixou de entrar)
            if (!Number.isFinite(quando) || quando < desdeMs || e?.event !== 'meta.messages' || !falhou(e)) continue;
            const n = String(e?.phone_number_id ?? '');
            if (n) por.set(n, (por.get(n) ?? 0) + 1);
          }
          if (!itens.length || maisAntigo < desdeMs || !j?.meta?.has_next) break;
        }
        return por;
      } catch (err) {
        logger.warn({ err: mascara(err) }, `${ID_VIGIA}: não consegui ler as entregas do Kapso`);
        return null;
      }
    },
    async entradas(numero, desdeMs, ateMs) {
      try {
        let n = 0;
        // as mais novas primeiro: segue as páginas até passar do começo da janela; se não chegar lá em 5 páginas, NÃO diagnostica (null) em vez de dizer «0»
        for (let pagina = 1; pagina <= PAGINAS_MAX; pagina++) {
          const j = await ler(`/whatsapp/messages?phone_number_id=${encodeURIComponent(numero)}&direction=inbound&per_page=100&page=${pagina}`);
          const itens: any[] = Array.isArray(j?.data) ? j.data : [];
          let maisAntigo = Infinity;
          for (const m of itens) {
            const t = Number(m?.timestamp) * 1000;
            if (Number.isFinite(t)) maisAntigo = Math.min(maisAntigo, t);
            if (m?.kapso?.direction === 'inbound' && t >= desdeMs && t <= ateMs) n++;
          }
          if (!itens.length || maisAntigo < desdeMs || !j?.meta?.has_next) return n; // chegou ao começo da janela (ou ao fim da lista)
        }
        return null;
      } catch (err) {
        logger.warn({ err: mascara(err) }, `${ID_VIGIA}: não consegui contar as mensagens recebidas no Kapso`);
        return null;
      }
    },
  };
}

// ── o aviso ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProblemaDaCaixa {
  /** o que o aviso diz, uma linha */
  texto: string;
}

export function textoDoAviso(a: { unidade: string; caixa: number; problemas: readonly ProblemaDaCaixa[] }): string {
  const linhas = a.problemas.map((p) => `• ${p.texto}`);
  return `⚠️ Caixa parada — ${a.unidade} (caixa ${a.caixa})\n${linhas.join('\n')}\nConfira se os leads estão entrando no CRM. Novo aviso desta caixa só daqui a 3 h.`;
}

const humano = (n: number): string => (Math.round(n) === n ? String(n) : n.toFixed(1).replace('.', ','));

export function problemaDoSilencio(d: DecisaoDoSilencio, kapsoRecebeu: number | null): ProblemaDaCaixa {
  const base = `Zero mensagem de paciente nas últimas ${d.horas} h (o histórico desta caixa diz ~${humano(d.esperado)} nesse horário).`;
  if (kapsoRecebeu === null) return { texto: base };
  if (kapsoRecebeu > 0) return { texto: `${base} O Kapso recebeu ${kapsoRecebeu} no mesmo período: a entrega ao CRM está falhando.` };
  return { texto: `${base} O Kapso também não recebeu nada: confira o número, a Meta e as campanhas.` };
}

// ── o ciclo de uma caixa ──────────────────────────────────────────────────────────────────────────────────────────

export interface UnidadeDoVigia extends HorarioDaUnidade {
  name: string;
}

export interface DepsDoVigia {
  estado(slug: string): Estado;
  unidade(slug: string): Promise<UnidadeDoVigia | null>;
  /** a série horária da caixa; lança se o Chatwoot não responder */
  serie(caixa: number, agora: number, tz: string): Promise<Serie>;
  /** o phone_number_id do Kapso da unidade quando a caixa é de WhatsApp oficial; senão null */
  numeroKapso(slug: string, caixa: number): string | null;
  kapso: PortaDoKapso | null;
  /** o que já foi lido do Kapso NESTE ciclo (uma leitura para todas as caixas) */
  cicloKapso: { numeros: Map<string, NumeroDoKapso>; entregas: Map<string, number> | null };
  /** já avisou esta caixa nas últimas 3 h? */
  jaAvisou(caixa: number, agora: number): Promise<boolean>;
  /** manda aos destinos (João e, se houver, o grupo da unidade); true = ao menos um recebeu */
  enviar(slug: string, texto: string): Promise<boolean>;
  /** anota que avisou (só no ligado) */
  marcar(caixa: number, agora: number, resumo: string): Promise<void>;
  /** só no seco: a trava de memória (o seco não grava no banco) — olhar e anotar são coisas separadas */
  secoRecente(caixa: number, agora: number): boolean;
  anotarSeco(caixa: number, agora: number): void;
  /** a caixa vem sendo ignorada de propósito (CAIXA_VIGIA_IGNORAR) */
  ignorada(caixa: number): boolean;
  /** a varredura ficou CEGA nesta caixa (nada pôde ser lido): conta seguidas e avisa o João uma vez, só no ligado */
  cegueira(caixa: number, cega: boolean): Promise<void>;
  agora(): number;
}

export type ResultadoDaCaixa = 'desligado' | 'sem-unidade' | 'sem-leitura' | 'ok' | 'ja-avisou' | 'seco' | 'avisou' | 'nao-saiu';

export async function cicloDaCaixa(d: DepsDoVigia, caixa: number, slug: string, horas = horasDaJanela()): Promise<ResultadoDaCaixa> {
  const modo = d.estado(slug);
  if (modo === 'desligado' || d.ignorada(caixa)) return 'desligado';
  const unit = await d.unidade(slug);
  if (!unit) return 'sem-unidade';
  const agora = d.agora();
  // já avisou nas últimas 3 h? Então nem lê o Chatwoot nem o Kapso (a leitura seria jogada fora)
  if (modo === 'ligado' ? await d.jaAvisou(caixa, agora) : d.secoRecente(caixa, agora)) return 'ja-avisou';
  const tz = fusoDaUnidade({ businessHoursTimezone: unit.businessHoursTimezone ?? undefined, spineTimezone: unit.spineTimezone ?? undefined });
  const problemas: ProblemaDaCaixa[] = [];
  let leu = false;

  // 1. silêncio, pelo Chatwoot
  try {
    const serie = await d.serie(caixa, agora, tz);
    leu = true;
    const dec = decidirSilencio({ serie, unidade: unit, agora, horas });
    if (dec.veredito === 'silencio') {
      const n = d.numeroKapso(slug, caixa);
      const recebeu = n && d.kapso ? await d.kapso.entradas(n, dec.desde, Math.min(dec.ate, agora - FOLGA_DA_ENTREGA_MS)) : null;
      problemas.push(problemaDoSilencio(dec, recebeu));
    }
  } catch (err) {
    logger.warn({ slug, caixa, err: String(err).slice(0, 200) }, `${ID_VIGIA}: não consegui ler a série da caixa — sem veredito de silêncio`);
  }

  // 2. Kapso: saúde do número e entregas com erro (só caixa oficial)
  const numero = d.numeroKapso(slug, caixa);
  if (numero && d.kapso) {
    const info = d.cicloKapso.numeros.get(numero);
    const saude = await d.kapso.saude(numero);
    if (saude !== null) leu = true;
    const doNumero = [...(saude ?? []), ...problemasDeReceber(null, info)].filter((v, i, l) => l.indexOf(v) === i);
    if (doNumero.length) problemas.push({ texto: `Número do WhatsApp com problema no Kapso: ${doNumero.join('; ')}.` });
    const erros = d.cicloKapso.entregas?.get(numero) ?? 0;
    if (d.cicloKapso.entregas) leu = true;
    if (erros > 0) problemas.push({ texto: `${erros} mensagem(ns) de paciente não foram entregues ao CRM pelo Kapso (últimas ${horas} h).` });
  }

  await d.cegueira(caixa, !leu);
  if (!problemas.length) return leu ? 'ok' : 'sem-leitura';
  const texto = textoDoAviso({ unidade: unit.name, caixa, problemas });
  if (modo === 'seco') {
    d.anotarSeco(caixa, agora);
    logger.info({ slug, caixa, problemas: problemas.map((p) => p.texto) }, `${ID_VIGIA}: [SECO] avisaria o João (e o grupo da unidade): ${problemas.map((p) => p.texto).join(' | ')}`);
    return 'seco';
  }
  const saiu = await d.enviar(slug, texto);
  if (!saiu) {
    logger.warn({ slug, caixa }, `${ID_VIGIA}: aviso NÃO saiu (sem configuração da Evolution ou ela recusou) — tento na próxima varredura`);
    return 'nao-saiu';
  }
  await d.marcar(caixa, agora, problemas.map((p) => p.texto).join(' | ').slice(0, 500));
  logger.info({ slug, caixa }, `${ID_VIGIA}: aviso enviado`);
  return 'avisou';
}

// ── o que toca o banco, o Evolution e o relógio ───────────────────────────────────────────────────────────────────

/** Os destinos de grupo por unidade: JSON `{"<slug>": "<id>@g.us"}` em CAIXA_VIGIA_DESTINOS. */
export function destinoDoGrupo(slug: string, raw: string | undefined = process.env.CAIXA_VIGIA_DESTINOS): string | null {
  if (!raw?.trim()) return null;
  try {
    const d = (JSON.parse(raw.trim().replace(/^'|'$/g, '')) as Record<string, unknown>)?.[slug];
    return typeof d === 'string' && d.trim() ? d.trim() : null;
  } catch {
    logger.warn(`${ID_VIGIA}: CAIXA_VIGIA_DESTINOS não é JSON válido — só o João recebe`);
    return null;
  }
}

function configDoGrupo(env: NodeJS.ProcessEnv): { url: string; header: string; valor: string } | null {
  const url = env.CAIXA_VIGIA_EVOLUTION_URL || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL;
  const header = env.CAIXA_VIGIA_EVOLUTION_HEADER || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_HEADER || env.EVOLUTION_ALERT_HEADER;
  const valor = env.CAIXA_VIGIA_EVOLUTION_VALUE || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_VALUE || env.EVOLUTION_ALERT_VALUE;
  return url && header && valor ? { url, header, valor } : null;
}

export async function enviarOAviso(slug: string, texto: string, env: NodeJS.ProcessEnv = process.env, enviar: typeof enviarPelaEvolutionComResultado = enviarPelaEvolutionComResultado): Promise<boolean> {
  const resultados: ResultadoDoEnvio[] = [];
  if (configurado()) {
    resultados.push(await enviar({ url: env.EVOLUTION_ALERT_URL as string, header: env.EVOLUTION_ALERT_HEADER as string, valor: env.EVOLUTION_ALERT_VALUE as string, numero: env.ALERTA_WHATSAPP_NUMERO as string, texto }));
  } else {
    logger.warn(`${ID_VIGIA}: sem configuração da Evolution do João (EVOLUTION_ALERT_*) — o aviso do João não sai`);
  }
  const grupo = destinoDoGrupo(slug, env.CAIXA_VIGIA_DESTINOS);
  const cfg = grupo ? configDoGrupo(env) : null;
  if (grupo && !cfg) logger.warn({ slug }, `${ID_VIGIA}: tem grupo da unidade mas falta CAIXA_VIGIA_EVOLUTION_URL (ou a do aviso da clínica) — só o João recebe`);
  if (grupo && cfg) resultados.push(await enviar({ ...cfg, numero: grupo, texto }));
  // «incerto» (conectou e não respondeu) pode ter saído: conta como enviado para não repetir em dobro
  return resultados.some((r) => r === 'ok' || r === 'incerto');
}

/** Memória do processo: o último aviso (ligado) e o último log (seco) por caixa — segunda trava quando o banco falha, e a única do seco (que não grava). */
const ultimoSeco = new Map<number, number>();
const ultimoEnvio = new Map<number, number>();
const cegas = new Map<number, number>();
/** Varreduras seguidas sem ler NADA da caixa até avisar que o vigia está cego (8 × 15 min = 2 h). */
export const VARREDURAS_CEGAS = 8;
export function esquecerOSeco(): void {
  ultimoSeco.clear();
  ultimoEnvio.clear();
  cegas.clear();
}

/** Caixas que o vigia ignora de propósito: `CAIXA_VIGIA_IGNORAR` = ids separados por vírgula (caixa aposentada, número migrado). */
export function caixasIgnoradas(env: NodeJS.ProcessEnv = process.env): Set<number> {
  return new Set(String(env.CAIXA_VIGIA_IGNORAR ?? '').split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

export function depsReais(ctx: ContextoChatwoot, kapso: PortaDoKapso | null, env: NodeJS.ProcessEnv = process.env): Omit<DepsDoVigia, 'cicloKapso'> {
  return {
    estado: estadoDoVigia,
    unidade: async (slug) => {
      const u = await prisma.unit.findUnique({ where: { slug }, select: { name: true, spineAgendaDays: true, spineAgendaStart: true, spineAgendaEnd: true, businessHoursTimezone: true, spineTimezone: true } });
      return u;
    },
    serie: async (caixa, agora, tz) => {
      const c = contextoDaCaixa(ctx, caixa);
      if (!c) throw new Error('a caixa não tem conta do Chatwoot válida');
      return serieDaCaixa(c, caixa, agora, tz);
    },
    numeroKapso: (slug, caixa) => {
      const cfg = configDaUnidade(slug);
      return cfg?.caixas.find((x) => x.id === caixa)?.tipo === 'cloud' ? (cfg.kapsoPhoneNumberId ?? null) : null;
    },
    kapso,
    jaAvisou: async (caixa, agora) => {
      // a memória do processo é a segunda trava: com o banco falhando, no máximo UM aviso por caixa a cada 3 h por processo (nunca um a cada varredura)
      if (agora - (ultimoEnvio.get(caixa) ?? 0) < INTERVALO_DO_AVISO_MS) return true;
      return (await prisma.chatwootReguaDisparo.findFirst({ where: { caixa, regra: REGRA_VIGIA, criadoEm: { gte: new Date(agora - INTERVALO_DO_AVISO_MS) } }, select: { id: true } }).catch(() => null)) !== null;
    },
    enviar: (slug, texto) => enviarOAviso(slug, texto),
    marcar: async (caixa, agora, resumo) => {
      ultimoEnvio.set(caixa, agora);
      await prisma.chatwootReguaDisparo
        .create({ data: { caixa, conversationId: 0, regra: REGRA_VIGIA, chave: new Date(agora).toISOString(), modo: 'ligado', texto: resumo } })
        .catch((err: unknown) => logger.warn({ caixa, err: String(err) }, `${ID_VIGIA}: não consegui anotar o aviso no banco (vale a memória do processo)`));
    },
    secoRecente: (caixa, agora) => agora - (ultimoSeco.get(caixa) ?? 0) < INTERVALO_DO_AVISO_MS,
    anotarSeco: (caixa, agora) => void ultimoSeco.set(caixa, agora),
    ignorada: (caixa) => caixasIgnoradas(env).has(caixa),
    cegueira: async (caixa, cega) => {
      if (!cega) {
        cegas.delete(caixa);
        return;
      }
      const n = (cegas.get(caixa) ?? 0) + 1;
      cegas.set(caixa, n);
      if (n !== VARREDURAS_CEGAS) return; // avisa UMA vez quando completa 2 h seguidas; só volta a avisar se voltar a enxergar e cegar de novo
      const slug = unidadeDaCaixa(caixa);
      logger.error({ caixa, slug }, `${ID_VIGIA}: CEGO — ${n} varreduras seguidas sem conseguir ler a caixa ${caixa} (token do Chatwoot, relatório ou Kapso)`);
      if (slug && estadoDoVigia(slug) === 'ligado') await avisarJoao(`⚠️ Vigia de caixa cego na caixa ${caixa}: há 2 h não consigo ler o Chatwoot nem o Kapso dela. Se um lead parar de entrar ali, eu não aviso. Confira o token e a KAPSO_API_KEY.`, `vigia-cego:${caixa}`, 6 * HORA_MS);
    },
    agora: () => Date.now(),
  };
}

// ── o worker ──────────────────────────────────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

/** Uma varredura: lê o Kapso UMA vez e passa por todas as caixas que falam com paciente. Nunca lança. */
export async function varrer(ctx: ContextoChatwoot, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const chave = (env.KAPSO_API_KEY ?? '').trim();
    const kapso = chave ? kapsoReal(chave) : null;
    const reais = depsReais(ctx, kapso, env);
    const agora = Date.now();
    const horas = horasDaJanela(env);
    const caixas = Object.entries(CAIXAS_REGUA).filter(([c]) => unidadeDaCaixa(Number(c)));
    const algumaLigadaOuSeca = caixas.some(([, slug]) => estadoDoVigia(slug) !== 'desligado');
    if (!algumaLigadaOuSeca) return;
    const cicloKapso = kapso ? { numeros: await kapso.numeros(), entregas: await kapso.entregasComErro(agora - horas * HORA_MS) } : { numeros: new Map<string, NumeroDoKapso>(), entregas: null };
    for (const [caixaTxt, slug] of caixas) {
      try {
        const r = await cicloDaCaixa({ ...reais, cicloKapso }, Number(caixaTxt), slug, horas);
        if (r !== 'desligado' && r !== 'ok') logger.info({ slug, caixa: Number(caixaTxt), resultado: r }, `${ID_VIGIA}: ciclo`);
      } catch (err) {
        logger.warn({ slug, caixa: caixaTxt, err: String(err) }, `${ID_VIGIA}: ciclo falhou — tento no próximo`);
      }
    }
  } finally {
    rodando = false;
  }
}

export function startVigiaDeCaixa(ctx: ContextoChatwoot | null, env: NodeJS.ProcessEnv = process.env): void {
  if (timer) return;
  if (env.CAIXA_VIGIA === '0') {
    logger.info(`${ID_VIGIA}: desligado por CAIXA_VIGIA=0`);
    return;
  }
  if (!ctx?.conta) {
    logger.info(`${ID_VIGIA}: sem CHATWOOT_API_TOKEN/CHATWOOT_CONTA_ID — worker não sobe`);
    return;
  }
  primeira = setTimeout(() => void varrer(ctx), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(ctx), SWEEP_MS);
  logger.info(`${ID_VIGIA}: worker iniciado`);
}

export function stopVigiaDeCaixa(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
