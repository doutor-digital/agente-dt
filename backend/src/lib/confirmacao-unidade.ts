/**
 * Confirmação de presença no JEITO DA UNIDADE (pedido de Petrópolis, 17/11/2026 — pendências 2 e 3).
 *
 * O que a clínica pediu:
 *  2. "Personalizar a mensagem de confirmação, que deverá ser enviada no dia útil anterior ao atendimento."
 *     O texto é o que a própria equipe já mandava à mão. Dia útil = segunda a sexta, sem feriado nacional
 *     (decisão do João, 17/11): a consulta de segunda é confirmada na sexta; a do dia seguinte a um feriado,
 *     antes do feriado. Sai UMA mensagem só, no lugar do reforço de 2 dias (D-2) e da véspera (D-1).
 *  3. "Desativar o envio automático de mensagens após o paciente já ter confirmado." Dois casos medidos:
 *     - a consulta já está CONFIRMADO na franquia (a equipe ou o próprio paciente confirmou): não pergunta de novo;
 *     - a Patrícia (lead 5978191, 17/11): a Sofia mandou "✅ Agendamento confirmado" às 09:00 e o reforço D-2
 *       perguntou "Responda 1 para confirmar" às 09:07. Quem acabou de receber a confirmação do agendamento
 *       (nas últimas 12 h) não recebe a pergunta.
 *
 * Tudo é OPCIONAL e por unidade, em `pipeline_intents.confirmacao_unidade`. Sem a chave, nada muda:
 *   {
 *     "dia_util": true,          // 1 toque no dia útil anterior (sem D-2 e sem a véspera de calendário)
 *     "texto": "…",              // modelo com {saudacao} {nome} {data} {DIA} {dia} {hora} {fisioterapeuta} {endereco}
 *     "sem_janela": true,        // WhatsApp Lite (QR): não existe a janela de 24 h — manda o texto sempre
 *     "pular_confirmada": true   // franquia em CONFIRMADO ou "✅ Agendamento confirmado" nas últimas 12 h = não manda
 *   }
 */
import { ehFeriadoNacional } from './feriados.js';

/**
 * `SPINE_STATUS.CONFIRMADO` (services/spine.service.ts). Copiado e não importado: aquele módulo valida as variáveis
 * de ambiente ao carregar, e este aqui precisa ser testável sozinho. A Sofia marca como AGENDADO (37), nunca 38.
 */
const STATUS_CONFIRMADO = 38;

export interface ConfirmacaoDaUnidade {
  diaUtil: boolean;
  texto: string | null;
  semJanela: boolean;
  pularConfirmada: boolean;
}

/** Lê `pipeline_intents.confirmacao_unidade`. `null` = a unidade segue o padrão da rede. */
export function confirmacaoDaUnidade(pipelineIntents: unknown): ConfirmacaoDaUnidade | null {
  const i = (pipelineIntents ?? {}) as Record<string, unknown>;
  const c = i.confirmacao_unidade;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  const texto = typeof o.texto === 'string' && o.texto.trim() ? o.texto : null;
  return {
    diaUtil: o.dia_util === true,
    texto,
    semJanela: o.sem_janela === true,
    pularConfirmada: o.pular_confirmada === true,
  };
}

function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** Segunda a sexta e não é feriado nacional. `dia` = AAAA-MM-DD (dia local). */
export function ehDiaUtil(dia: string, feriado: (d: string) => boolean = ehFeriadoNacional): boolean {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  const semana = new Date(t).getUTCDay();
  return semana >= 1 && semana <= 5 && !feriado(dia);
}

/** O último dia útil ANTES de `dia` (consulta de segunda → sexta; depois do feriado → antes dele). */
export function diaUtilAnterior(dia: string, feriado: (d: string) => boolean = ehFeriadoNacional): string {
  let d = somarDias(dia, -1);
  for (let i = 0; i < 15 && !ehDiaUtil(d, feriado); i++) d = somarDias(d, -1);
  return d;
}

/**
 * Os dias de consulta que se confirmam HOJE: de amanhã até o próximo dia útil, inclusive.
 * Sexta → sábado, domingo e segunda. Hoje não sendo dia útil → nenhum (quem confirma é o dia útil de antes).
 */
export function diasQueConfirmamHoje(hoje: string, feriado: (d: string) => boolean = ehFeriadoNacional): string[] {
  if (!ehDiaUtil(hoje, feriado)) return [];
  const dias: string[] = [];
  let d = somarDias(hoje, 1);
  for (let i = 0; i < 15; i++) {
    dias.push(d);
    if (ehDiaUtil(d, feriado)) break;
    d = somarDias(d, 1);
  }
  return dias;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Hora local (0–23) → "Bom dia!" / "Boa tarde!" / "Boa noite!". */
export function saudacaoDaHora(hora: number): string {
  if (hora < 12) return 'Bom dia!';
  if (hora < 18) return 'Boa tarde!';
  return 'Boa noite!';
}

/**
 * Preenche o modelo da unidade. `quando` = "AAAA-MM-DDTHH:mm" (hora local da franquia).
 * {data} 18/11 · {DIA} QUARTA · {dia} quarta · {hora} 17:30 · {nome} primeiro nome ou vazio ·
 * {fisioterapeuta} · {endereco} · {saudacao} pela hora do envio. Chave desconhecida fica como está.
 */
export function textoDaUnidade(
  modelo: string,
  args: { quando: string; nome?: string | null; especialista?: string | null; endereco?: string | null; horaDoEnvio: number },
): string {
  const dia = args.quando.slice(0, 10);
  const t = Date.parse(`${dia}T00:00:00Z`);
  const semana = Number.isNaN(t) ? '' : DIAS[new Date(t).getUTCDay()];
  const valores: Record<string, string> = {
    saudacao: saudacaoDaHora(args.horaDoEnvio),
    nome: (args.nome ?? '').trim(),
    data: `${dia.slice(8, 10)}/${dia.slice(5, 7)}`,
    DIA: semana.toUpperCase(),
    dia: semana,
    hora: args.quando.slice(11, 16),
    fisioterapeuta: (args.especialista ?? '').trim(),
    endereco: (args.endereco ?? '').trim(),
  };
  return modelo.replace(/\{(\w+)\}/g, (m, k: string) => (k in valores ? valores[k] : m));
}

/** A confirmação do AGENDAMENTO que a Sofia manda ao marcar ("✅ Agendamento confirmado, Patrícia!"). */
const CONFIRMACAO_DO_AGENDAMENTO = /agendamento confirmado/i;
export const ACABOU_DE_AGENDAR_MS = 12 * 3600_000;

/**
 * Por que NÃO perguntar a quem já confirmou (pendência 3). `null` = pode perguntar.
 *  - franquia em CONFIRMADO: a equipe (ou o "1" do paciente) já confirmou esta consulta;
 *  - "✅ Agendamento confirmado" saiu nas últimas 12 h: o paciente acabou de fechar o horário.
 */
export function jaConfirmou(args: {
  idStatus?: number | null;
  oficiais?: Array<{ direcao: 'entrada' | 'saida'; em: Date; texto: string }> | null;
  agora?: Date;
}): string | null {
  if (args.idStatus === STATUS_CONFIRMADO) return 'consulta já CONFIRMADA na franquia';
  const agora = (args.agora ?? new Date()).getTime();
  const recente = (args.oficiais ?? []).find(
    (m) => m.direcao === 'saida' && agora - m.em.getTime() < ACABOU_DE_AGENDAR_MS && CONFIRMACAO_DO_AGENDAMENTO.test(m.texto ?? ''),
  );
  return recente ? 'recebeu "Agendamento confirmado" há menos de 12 h' : null;
}
