/**
 * Vigia de CAIXA PARADA (reclamação nº 1 das unidades, 26/11/2026): «o lead chega no WhatsApp e não entra no CRM». Ninguém vê isso falhar:
 * a caixa só fica em silêncio, e o silêncio de uma caixa de 6 mensagens por hora e o de uma caixa quebrada são iguais a olho nu.
 *
 * Em cada caixa registrada (`unit_chatwoot_caixa`, fora a de histórico), a cada 15 min, compara o que ERA ESPERADO com o que ENTROU e lê o Kapso:
 *  1. SILÊNCIO — zero mensagem de PACIENTE nas últimas X horas CHEIAS (padrão 3), todas dentro do horário de atendimento DAQUELE dia da semana (`spineAgendaDays` +
 *     `spineDayHours` — a mesma fonte de `retorno-da-equipe.ts` e `agenda-tools.ts`: o sábado de Parauapebas é 07–13h sem almoço; fora do almoço; sem feriado; agenda ligada),
 *     quando a média da própria caixa nessas mesmas horas NO MESMO DIA DA SEMANA (últimas 6 semanas: sábado com sábados, segunda com segundas) diz que deveriam ter entrado pelo
 *     menos 4. Com 4 esperadas a chance de zero por acaso é ~2%; sem 3 semanas comparáveis não avisa. A série vem dos relatórios do próprio Chatwoot (`incoming_messages_count`
 *     por hora, por caixa).
 *  2. KAPSO (só caixa de WhatsApp oficial, com número do Kapso e KAPSO_API_KEY):
 *     - ENTREGA com erro: o Kapso entrega cada mensagem ao CRM por webhook (`GET /platform/v1/webhook_deliveries?status=failed&event=meta.messages`, paginação por cursor como
 *       na doc); só `status === 'failed'` conta (`pending` é entrega ainda sendo tentada de novo) — é mensagem de paciente que NÃO entrou;
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
/** Quantas semanas de histórico: cada dia da semana é comparado com o MESMO dia da semana (sábado com sábados), nunca com a média dos dias úteis. */
export const HISTORICO_SEMANAS = 6;
/** Menos semanas comparáveis que isto (mesmo dia da semana, comercial, com dado): a média não vale e o silêncio não avisa. */
export const MIN_SEMANAS_COMPARAVEIS = 3;
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
  /** a agenda está ligada? Sem ela os campos guardam o padrão do banco (08–18, seg–sex), que ninguém conferiu: não vale como horário (mesma regra de retorno-da-equipe.ts) */
  spineEnabled?: boolean | null;
  spineAgendaDays?: number[] | null;
  spineAgendaStart?: string | null;
  spineAgendaEnd?: string | null;
  spineLunchStart?: string | null;
  spineLunchEnd?: string | null;
  /** horário do dia que difere do padrão, por dia da semana (0 = domingo … 6 = sábado): {"6": {"start":"07:00","end":"13:00","lunchStart":null,"lunchEnd":null}} */
  spineDayHours?: unknown;
  businessHoursTimezone?: string | null;
  spineTimezone?: string | null;
}

const minutosDe = (hhmm: unknown): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 24 || min > 59 || (h === 24 && min > 0) ? null : h * 60 + min;
};

const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function diaDaSemanaNoFuso(d: Date, tz: string): number {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  return DIAS[w] ?? 1;
}

/**
 * A janela em que a clínica ATENDE num dia da semana: a MESMA fonte de `retorno-da-equipe.ts` e de `agenda-tools.ts` — `spineAgendaDays` diz os dias, e `spineDayHours`
 * dá o horário do dia que muda (o sábado), com o do padrão (`spineAgendaStart/End`, almoço) para os outros. Chave `lunchStart` presente como null = sem almoço naquele dia.
 * null = a clínica não atende nesse dia (ou o cadastro está quebrado).
 */
export function janelaDoDia(u: HorarioDaUnidade, dia: number): { inicio: number; fim: number; almoco: [number, number] | null } | null {
  const dias = u.spineAgendaDays?.length ? u.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(dia)) return null;
  const mapa = u.spineDayHours && typeof u.spineDayHours === 'object' && !Array.isArray(u.spineDayHours) ? (u.spineDayHours as Record<string, Record<string, unknown>>) : null;
  const proprio = mapa?.[String(dia)];
  const inicio = minutosDe(proprio?.start ?? u.spineAgendaStart);
  const fim = minutosDe(proprio?.end ?? u.spineAgendaEnd);
  if (inicio === null || fim === null || fim <= inicio) return null;
  const temAlmocoProprio = proprio !== undefined && proprio !== null && ('lunchStart' in proprio || 'lunchEnd' in proprio);
  const a = minutosDe(temAlmocoProprio ? proprio!.lunchStart : u.spineLunchStart);
  const b = minutosDe(temAlmocoProprio ? proprio!.lunchEnd : u.spineLunchEnd);
  return { inicio, fim, almoco: a !== null && b !== null && b > a ? [a, b] : null };
}

/** A HORA CHEIA que começa em `inicio` cabe inteira na janela de atendimento DAQUELE dia da semana (almoço incluído: ver abaixo) e sem feriado nacional? */
export function horaCheiaComercial(u: HorarioDaUnidade, inicio: Date): boolean {
  if (u.spineEnabled === false) return false;
  const tz = fusoDaUnidade({ businessHoursTimezone: u.businessHoursTimezone ?? undefined, spineTimezone: u.spineTimezone ?? undefined });
  if (ehFeriadoNacionalAgora(inicio, tz)) return false;
  const janela = janelaDoDia(u, diaDaSemanaNoFuso(inicio, tz));
  if (!janela) return false;
  const p = partesNoFuso(inicio, tz);
  const min = p.hora * 60 + p.min;
  if (min < janela.inicio || min + 60 > janela.fim) return false;
  // o ALMOÇO não tira a hora do horário: a média é do MESMO dia e da MESMA hora, então o dip do almoço já está nela (expectativa menor, não zero) — excluí-lo abria um ponto cego das 13h às 16h
  return true;
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
  /** `silencio` = avisar; `ok` = entrou mensagem; `pouco-esperado` = a média não justifica cobrar; `sem-historico`; `fora-do-horario` = alguma hora da janela não é de atendimento DAQUELE dia */
  veredito: 'silencio' | 'ok' | 'pouco-esperado' | 'sem-historico' | 'fora-do-horario';
  observado: number;
  esperado: number;
  horas: number;
  /** início da janela (ms) — o relógio das X horas cheias que já terminaram */
  desde: number;
  ate: number;
}

/**
 * Silêncio? Janela = as `horas` horas CHEIAS que já terminaram (a hora em curso fica de fora: ela ainda está enchendo). Todas dentro do horário de atendimento do
 * DIA (`janelaDoDia`). Esperado = soma, para cada hora da janela, da MÉDIA dessa mesma hora no MESMO dia da semana nas últimas `semanas` semanas (sábado com sábados,
 * segunda com segundas), contando só as semanas em que aquela hora foi de atendimento e a série tem dado.
 */
export function decidirSilencio(a: { serie: Serie; unidade: HorarioDaUnidade; agora: number; horas?: number; semanas?: number }): DecisaoDoSilencio {
  const horas = a.horas ?? 3;
  const semanas = a.semanas ?? HISTORICO_SEMANAS;
  const ate = Math.floor(a.agora / HORA_MS) * HORA_MS;
  const desde = ate - horas * HORA_MS;
  const base = { horas, desde, ate };
  const janela = Array.from({ length: horas }, (_, i) => desde + i * HORA_MS);
  if (!janela.every((h) => horaCheiaComercial(a.unidade, new Date(h)))) return { ...base, veredito: 'fora-do-horario', observado: 0, esperado: 0 };
  const observado = janela.reduce((s, h) => s + (a.serie.get(h) ?? 0), 0);
  if (observado > 0) return { ...base, veredito: 'ok', observado, esperado: 0 };
  let esperado = 0;
  let semanasComparaveis = Infinity;
  for (const h of janela) {
    let soma = 0;
    let n = 0;
    for (let w = 1; w <= semanas; w++) {
      const t = h - w * 7 * 24 * HORA_MS; // o mesmo dia da semana, w semanas antes
      // semana comparável = a hora está na série (o relatório do Chatwoot traz o balde mesmo com zero) E foi de atendimento; hora sem dado não é «zero», é falta de histórico
      if (!a.serie.has(t) || !horaCheiaComercial(a.unidade, new Date(t))) continue;
      soma += a.serie.get(t) ?? 0;
      n++;
    }
    semanasComparaveis = Math.min(semanasComparaveis, n);
    esperado += n ? soma / n : 0;
  }
  if (semanasComparaveis < MIN_SEMANAS_COMPARAVEIS) return { ...base, veredito: 'sem-historico', observado, esperado };
  return { ...base, veredito: esperado >= ESPERADO_MINIMO ? 'silencio' : 'pouco-esperado', observado, esperado };
}

// ── o Chatwoot: série horária pelos relatórios (só leitura) ───────────────────────────────────────────────────────

/** `incoming_messages_count` por hora da caixa nos últimos `dias` dias. Lança em erro (quem chama decide). */
export async function serieDaCaixa(ctx: ContextoChatwoot, caixa: number, agoraMs: number, tz: string, dias = HISTORICO_SEMANAS * 7 + 1): Promise<Map<number, number>> {
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

/** O cursor da PRÓXIMA página, como a API documenta: `paging.cursors.after`, e só enquanto `paging.next` não é null. null = acabou. */
export function proximaPagina(resposta: unknown): string | null {
  const paging = (resposta as { paging?: { next?: unknown; cursors?: { after?: unknown } } } | null)?.paging;
  const depois = paging?.cursors?.after;
  return paging?.next && typeof depois === 'string' && depois ? depois : null;
}

export interface NumeroDoKapso {
  id: string;
  status: string | null;
  recebimentoLigado: boolean | null;
}

export interface PortaDoKapso {
  numeros(): Promise<Map<string, NumeroDoKapso>>;
  /** problemas de RECEBER (conexão, inscrição e verificação do webhook); [] = saudável; null = não deu para ler */
  saude(numero: string): Promise<string[] | null>;
  /** quando (ms) cada entrega ao CRM ficou SEM entregar, desde `desdeMs`, por número (quem chama conta a partir do ponto que lhe serve) */
  entregasComErro(desdeMs: number): Promise<Map<string, number[]> | null>;
  /** mensagens de paciente que o Kapso recebeu no intervalo; null = não deu para ler */
  entradas(numero: string, desdeMs: number, ateMs: number): Promise<number | null>;
}

/** Entrega que FALHOU de vez: `status === 'failed'` (a API documenta pending | delivered | failed). `pending` é entrega ainda sendo tentada de novo — não conta. */
const falhou = (e: { status?: unknown }): boolean => e?.status === 'failed';

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
        const por = new Map<string, number[]>();
        // GET /webhook_deliveries (docs.kapso.ai): filtros `status`, `event`, `period` (24h|7d|30d) e paginação por CURSOR (`limit` até 100, `after`, resposta `paging`).
        // Só as que falharam de vez, só mensagem de paciente (o eco do celular da equipe e outros eventos não são lead que deixou de entrar).
        let depois: string | null = null;
        for (let pagina = 1; pagina <= PAGINAS_MAX; pagina++) {
          const j: any = await ler(`/webhook_deliveries?status=failed&event=meta.messages&period=7d&limit=100${depois ? `&after=${encodeURIComponent(depois)}` : ''}`);
          for (const e of Array.isArray(j?.data) ? j.data : []) {
            const quando = Date.parse(String(e?.created_at ?? ''));
            if (!Number.isFinite(quando) || quando < desdeMs || e?.event !== 'meta.messages' || !falhou(e)) continue;
            const n = String(e?.phone_number_id ?? '');
            if (n) por.set(n, [...(por.get(n) ?? []), quando]);
          }
          depois = proximaPagina(j);
          if (!depois) break;
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
        // GET /whatsapp/messages (docs.kapso.ai): `phone_number_id`, `direction`, cursor (`limit` até 100, `after`, resposta `paging`); as mais novas primeiro. Segue até passar do
        // começo da janela; se acabar a lista, vale o que contou; se estourar as páginas ANTES de chegar lá, NÃO diagnostica (null) em vez de dizer «0».
        let depois: string | null = null;
        for (let pagina = 1; pagina <= PAGINAS_MAX; pagina++) {
          const j: any = await ler(`/whatsapp/messages?phone_number_id=${encodeURIComponent(numero)}&direction=inbound&limit=100${depois ? `&after=${encodeURIComponent(depois)}` : ''}`);
          const itens: any[] = Array.isArray(j?.data) ? j.data : [];
          let maisAntigo = Infinity;
          for (const m of itens) {
            const t = Number(m?.timestamp) * 1000;
            if (Number.isFinite(t)) maisAntigo = Math.min(maisAntigo, t);
            if (m?.kapso?.direction === 'inbound' && t >= desdeMs && t <= ateMs) n++;
          }
          depois = proximaPagina(j);
          if (!depois || maisAntigo < desdeMs) return n;
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
  cicloKapso: { numeros: Map<string, NumeroDoKapso>; entregas: Map<string, number[]> | null };
  /** já avisou esta caixa nas últimas 3 h? */
  jaAvisou(caixa: number, agora: number): Promise<boolean>;
  /** manda aos destinos (João e, se houver, o grupo da unidade); true = ao menos um recebeu */
  enviar(slug: string, texto: string): Promise<boolean>;
  /** anota que avisou (só no ligado) */
  marcar(caixa: number, agora: number, resumo: string): Promise<void>;
  /** quando foi o último aviso desta caixa (ms; banco e memória); null = nunca — o Kapso conta falhas a partir dele */
  ultimoAviso(caixa: number): Promise<number | null>;
  /** a unidade está com a agenda desligada: o horário não é confiável e o vigia não avalia silêncio — diz isso (log e, ligado, o João), no máximo uma vez por dia */
  semAgenda(caixa: number, slug: string, modo: Estado): Promise<void>;
  /** só no seco: a trava de memória (o seco não grava no banco) — olhar e anotar são coisas separadas */
  secoRecente(caixa: number, agora: number): boolean;
  anotarSeco(caixa: number, agora: number): void;
  /** a caixa/unidade é ignorada de propósito (unidade cancelada, caixa aposentada: CAIXA_VIGIA_IGNORAR) */
  ignorada(caixa: number, slug: string): boolean;
  /**
   * Uma FONTE ficou cega nesta caixa (o relatório do Chatwoot, ou o Kapso): conta varreduras seguidas POR FONTE e avisa o João uma vez, só no ligado.
   * As fontes são independentes — o Kapso respondendo não esconde o Chatwoot que falha, e vice-versa.
   */
  cegueira(caixa: number, fonte: 'chatwoot' | 'kapso', cega: boolean): Promise<void>;
  agora(): number;
}

export type ResultadoDaCaixa = 'desligado' | 'sem-unidade' | 'sem-agenda' | 'sem-leitura' | 'ok' | 'ja-avisou' | 'seco' | 'avisou' | 'nao-saiu';

/** `agora` cai dentro do horário de atendimento do dia (sem a conta da hora cheia, sem almoço): é quando um problema do Kapso vale acordar alguém. */
export function emHorarioDeAtendimento(u: HorarioDaUnidade, agora: number): boolean {
  if (u.spineEnabled === false) return false;
  const tz = fusoDaUnidade({ businessHoursTimezone: u.businessHoursTimezone ?? undefined, spineTimezone: u.spineTimezone ?? undefined });
  const d = new Date(agora);
  if (ehFeriadoNacionalAgora(d, tz)) return false;
  const janela = janelaDoDia(u, diaDaSemanaNoFuso(d, tz));
  if (!janela) return false;
  const p = partesNoFuso(d, tz);
  const min = p.hora * 60 + p.min;
  return min >= janela.inicio && min < janela.fim;
}

/**
 * O último FECHAMENTO da unidade antes de `agora`: o fim do último período de atendimento já terminado. É daí que o Kapso passa a contar falhas — de manhã, ao abrir, o que
 * falhou das 22h às 5h tem de aparecer (a janela de 3 h do silêncio não o vê). Passo de 15 min, no máximo 72 h para trás (fim de semana + feriado); sem achar, 24 h.
 */
export function ultimoFechamento(u: HorarioDaUnidade, agora: number): number {
  const PASSO = 15 * 60_000;
  let t = agora;
  let viuFechado = !emHorarioDeAtendimento(u, t);
  for (let i = 0; i < (72 * 60) / 15; i++) {
    t -= PASSO;
    const aberto = emHorarioDeAtendimento(u, t);
    if (viuFechado && aberto) return t + PASSO; // t é o último instante ABERTO: o fechamento é logo depois
    if (!aberto) viuFechado = true;
  }
  return agora - 24 * HORA_MS;
}

export async function cicloDaCaixa(d: DepsDoVigia, caixa: number, slug: string, horas = horasDaJanela()): Promise<ResultadoDaCaixa> {
  const modo = d.estado(slug);
  if (modo === 'desligado' || d.ignorada(caixa, slug)) return 'desligado';
  const unit = await d.unidade(slug);
  if (!unit) return 'sem-unidade';
  const agora = d.agora();
  // agenda desligada: os campos de horário guardam o padrão do banco, que ninguém conferiu — o vigia não avalia silêncio nem acorda ninguém pelo Kapso. Não fica mudo: diz isso, uma vez por dia
  if (unit.spineEnabled === false) {
    await d.semAgenda(caixa, slug, modo);
    return 'sem-agenda';
  }
  // já avisou nas últimas 3 h? Então nem lê o Chatwoot nem o Kapso (a leitura seria jogada fora)
  if (modo === 'ligado' ? await d.jaAvisou(caixa, agora) : d.secoRecente(caixa, agora)) return 'ja-avisou';
  const tz = fusoDaUnidade({ businessHoursTimezone: unit.businessHoursTimezone ?? undefined, spineTimezone: unit.spineTimezone ?? undefined });
  const problemas: ProblemaDaCaixa[] = [];
  // a saúde de CADA fonte é separada: o Kapso que responde não faz o Chatwoot que falha parecer lido (e o silêncio só existe com o Chatwoot)
  let leuChatwoot = false;
  let leuKapso = false;

  // 1. silêncio, pelo Chatwoot
  try {
    const serie = await d.serie(caixa, agora, tz);
    leuChatwoot = true;
    const dec = decidirSilencio({ serie, unidade: unit, agora, horas });
    if (dec.veredito === 'silencio') {
      const n = d.numeroKapso(slug, caixa);
      const recebeu = n && d.kapso ? await d.kapso.entradas(n, dec.desde, Math.min(dec.ate, agora - FOLGA_DA_ENTREGA_MS)) : null;
      problemas.push(problemaDoSilencio(dec, recebeu));
    }
  } catch (err) {
    logger.warn({ slug, caixa, err: String(err).slice(0, 200) }, `${ID_VIGIA}: não consegui ler a série da caixa — sem veredito de silêncio`);
  }

  // 2. Kapso: saúde do número e entregas com erro (só caixa oficial). Problema do Kapso só ACORDA no horário de atendimento da unidade: de madrugada não adianta
  // (e uma caixa desconectada à noite avisaria 3 h sim, 3 h não até de manhã); no primeiro ciclo do expediente ele aparece.
  const numero = d.numeroKapso(slug, caixa);
  if (numero && d.kapso) {
    const info = d.cicloKapso.numeros.get(numero);
    const saude = await d.kapso.saude(numero);
    leuKapso = saude !== null || d.cicloKapso.entregas !== null;
    if (emHorarioDeAtendimento(unit, agora)) {
      const doNumero = [...(saude ?? []), ...problemasDeReceber(null, info)].filter((v, i, l) => l.indexOf(v) === i);
      if (doNumero.length) problemas.push({ texto: `Número do WhatsApp com problema no Kapso: ${doNumero.join('; ')}.` });
      // falhas desde o ÚLTIMO AVISO (tudo que falhou depois dele ainda não foi dito a ninguém — inclusive o que falhou entre o aviso e o fechamento) ou, sem aviso nenhum,
      // desde o ÚLTIMO FECHAMENTO da clínica: de manhã, o que falhou de madrugada aparece. (Usar «o mais novo dos dois» perdia a falha das 18h quando o aviso foi às 17h e o fechamento às 18h30.)
      const ultimo = await d.ultimoAviso(caixa);
      const desde = ultimo ?? ultimoFechamento(unit, agora);
      const erros = (d.cicloKapso.entregas?.get(numero) ?? []).filter((t) => t >= desde).length;
      if (erros > 0) problemas.push({ texto: `${erros} mensagem(ns) de paciente não foram entregues ao CRM pelo Kapso (desde ${ultimo !== null ? 'o último aviso' : 'o último fechamento da clínica'}).` });
    }
    await d.cegueira(caixa, 'kapso', !leuKapso);
  }
  await d.cegueira(caixa, 'chatwoot', !leuChatwoot);

  if (!problemas.length) return leuChatwoot || leuKapso ? 'ok' : 'sem-leitura';
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
const cegas = new Map<string, number>();
const semAgendaEm = new Map<number, number>();
/** Varreduras seguidas sem ler uma FONTE da caixa até avisar que o vigia está cego nela (8 × 15 min = 2 h). */
export const VARREDURAS_CEGAS = 8;
export function esquecerOSeco(): void {
  ultimoSeco.clear();
  ultimoEnvio.clear();
  cegas.clear();
  semAgendaEm.clear();
}

/** Unidades que o vigia NÃO vigia por padrão, sem ninguém configurar nada: a clínica cancelou (Timbó, 25/11/2026 — IA pausada até 2099, CRM com automações desligadas). */
export const UNIDADES_IGNORADAS_PADRAO: readonly string[] = ['doutor-hernia-timbo'];

/** O que o vigia ignora: as unidades acima + `CAIXA_VIGIA_IGNORAR` (ids de caixa e/ou slugs, separados por vírgula ou espaço: caixa aposentada, número migrado). */
export function ignoradas(env: NodeJS.ProcessEnv = process.env): { caixas: Set<number>; unidades: Set<string> } {
  const caixas = new Set<number>();
  const unidades = new Set<string>(UNIDADES_IGNORADAS_PADRAO);
  for (const t of String(env.CAIXA_VIGIA_IGNORAR ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const n = Number(t);
    if (Number.isInteger(n) && n > 0) caixas.add(n);
    else if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(t)) unidades.add(t);
  }
  return { caixas, unidades };
}

export function depsReais(ctx: ContextoChatwoot, kapso: PortaDoKapso | null, env: NodeJS.ProcessEnv = process.env): Omit<DepsDoVigia, 'cicloKapso'> {
  return {
    estado: estadoDoVigia,
    unidade: async (slug) => {
      const u = await prisma.unit.findUnique({ where: { slug }, select: { name: true, spineEnabled: true, spineAgendaDays: true, spineAgendaStart: true, spineAgendaEnd: true, spineLunchStart: true, spineLunchEnd: true, spineDayHours: true, businessHoursTimezone: true, spineTimezone: true } });
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
    ultimoAviso: async (caixa) => {
      const memoria = Math.max(ultimoEnvio.get(caixa) ?? 0, ultimoSeco.get(caixa) ?? 0);
      const noBanco = await prisma.chatwootReguaDisparo.findFirst({ where: { caixa, regra: REGRA_VIGIA }, orderBy: { criadoEm: 'desc' }, select: { criadoEm: true } }).catch(() => null);
      const t = Math.max(memoria, noBanco?.criadoEm?.getTime() ?? 0);
      return t > 0 ? t : null;
    },
    semAgenda: async (caixa, slug, modo) => {
      const agora = Date.now();
      if (agora - (semAgendaEm.get(caixa) ?? 0) < 24 * HORA_MS) return;
      semAgendaEm.set(caixa, agora);
      logger.warn({ caixa, slug }, `${ID_VIGIA}: caixa ${caixa} sem agenda: vigia não avalia silêncio (a agenda da unidade está desligada, o horário no cadastro não é confiável)`);
      if (modo === 'ligado') await avisarJoao(`⚠️ Vigia: a caixa ${caixa} (${slug}) está sem agenda ligada — não avalio silêncio nem aviso de Kapso nela. Ligue a agenda da unidade ou ignore a caixa (CAIXA_VIGIA_IGNORAR).`, `vigia-sem-agenda:${caixa}`, 24 * HORA_MS);
    },
    secoRecente: (caixa, agora) => agora - (ultimoSeco.get(caixa) ?? 0) < INTERVALO_DO_AVISO_MS,
    anotarSeco: (caixa, agora) => void ultimoSeco.set(caixa, agora),
    ignorada: (caixa, slug) => {
      const i = ignoradas(env);
      return i.caixas.has(caixa) || i.unidades.has(slug);
    },
    cegueira: async (caixa, fonte, cega) => {
      const chave = `${caixa}:${fonte}`;
      if (!cega) {
        cegas.delete(chave);
        return;
      }
      const n = (cegas.get(chave) ?? 0) + 1;
      cegas.set(chave, n);
      if (n !== VARREDURAS_CEGAS) return; // avisa UMA vez quando completa 2 h seguidas; só volta a avisar se voltar a enxergar e cegar de novo
      const slug = unidadeDaCaixa(caixa);
      const onde = fonte === 'chatwoot' ? 'o relatório do Chatwoot (token da conta ou a API de relatórios)' : 'o Kapso (KAPSO_API_KEY ou a API dele)';
      logger.error({ caixa, slug, fonte }, `${ID_VIGIA}: CEGO — ${n} varreduras seguidas sem conseguir ler ${onde} para a caixa ${caixa}`);
      if (slug && estadoDoVigia(slug) === 'ligado') {
        const perde = fonte === 'chatwoot' ? 'não consigo ver se os leads param de entrar nela (o silêncio)' : 'não consigo ver se o número ou a entrega ao CRM falham';
        await avisarJoao(`⚠️ Vigia de caixa cego na caixa ${caixa}: há 2 h não consigo ler ${onde}. Enquanto isso ${perde}. Confira o acesso.`, `vigia-cego:${caixa}:${fonte}`, 6 * HORA_MS);
      }
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
    const cicloKapso = kapso ? { numeros: await kapso.numeros(), entregas: await kapso.entregasComErro(agora - 7 * 24 * HORA_MS) } : { numeros: new Map<string, NumeroDoKapso>(), entregas: null };
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
