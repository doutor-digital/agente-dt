/**
 * O aviso das 8h: quem escreveu e ninguém leu.
 *
 * Roda uma vez por dia. Manda primeiro só pro João — é o protocolo da casa: alerta novo
 * se prova no número dele antes de chegar em grupo de unidade. Quando o texto estiver
 * afinado, a entrega por unidade é uma chave a mais, não um worker novo.
 *
 * De segunda a sábado. Domingo a clínica não abre, e aviso que chega quando ninguém pode
 * agir só ensina a ignorar aviso.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { avisarJoao } from './alerta-whatsapp.js';
import { contarNaoLidas, montarAviso, type NaoLidasDaConta } from './nao-lidas.js';

const PASSO_MS = 10 * 60_000;
const HORA_PADRAO = 8;
const FUSO = 'America/Sao_Paulo';

let timer: NodeJS.Timeout | null = null;
let rodando = false;
/** O dia em que já avisamos, pra não repetir a cada passo dentro da mesma hora. */
let ultimoDia: string | null = null;

function agoraLocal(): { hora: number; diaSemana: number; dia: string } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date());
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const semana = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(v('weekday'));
  return {
    hora: Number(v('hour')),
    diaSemana: semana,
    dia: `${v('year')}-${v('month')}-${v('day')}`,
  };
}

/** A hora do aviso pode ser mudada sem deploy — em incidente isso importa. */
function horaDoAviso(): number {
  const n = Number(process.env.NAO_LIDAS_HORA);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : HORA_PADRAO;
}

/** Varre as contas do Kommo, não as unidades: Imperatriz tem quatro na mesma conta. */
export async function levantarNaoLidas(): Promise<NaoLidasDaConta[]> {
  const unidades = await prisma.unit.findMany({
    where: { kommoAccessToken: { not: null } },
    orderBy: { slug: 'asc' },
  });
  const porConta = new Map<string, (typeof unidades)[number]>();
  for (const u of unidades) {
    const chave = u.kommoSubdomain ?? u.slug;
    if (!porConta.has(chave)) porConta.set(chave, u);
  }
  const contas: NaoLidasDaConta[] = [];
  for (const u of porConta.values()) contas.push(await contarNaoLidas(u));
  return contas;
}

async function talvezAvisar(): Promise<void> {
  if (rodando) return;
  const { hora, diaSemana, dia } = agoraLocal();
  if (diaSemana === 0) return;              // domingo
  if (hora !== horaDoAviso()) return;
  if (ultimoDia === dia) return;

  rodando = true;
  try {
    const contas = await levantarNaoLidas();
    const texto = montarAviso(contas);
    // Marca o dia mesmo sem nada a dizer: senão o worker refaz a varredura inteira a cada
    // 10 minutos durante a hora do aviso, só pra descobrir de novo que não há nada.
    ultimoDia = dia;
    if (!texto) {
      logger.info('não lidas: nada a avisar hoje');
      return;
    }
    const ok = await avisarJoao(texto, `nao-lidas-${dia}`, 0);
    logger.info({ enviado: ok, contas: contas.length }, 'não lidas: aviso do dia');
  } catch (err) {
    logger.warn({ err: String(err) }, 'não lidas: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startNaoLidasWorker(): void {
  if (timer) return;
  timer = setInterval(() => void talvezAvisar(), PASSO_MS);
  logger.info({ hora: horaDoAviso() }, 'não lidas: worker iniciado');
}

export function stopNaoLidasWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ultimoDia = null;
}
