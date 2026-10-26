/**
 * "Pediu horário": o sinal que o fluxo da Meta (n8n, "DD · CTWA → Meta CAPI") lê para mandar `LeadSubmitted`
 * quando o paciente chega ao horário, sem depender da SDR marcar "★ Qualificação = Quente".
 *
 * Decisão do João (26/10/2026), que revoga a de 24/09 ("Lead só com Quente"): a meta de campanha "Maximizar
 * leads por mensagens" pede 10 leads em 30 dias por Página, e só conta lead até 7 dias depois do clique.
 *
 * POR QUE ESTE SINAL E NÃO OUTRO (medido em Balsas, 30 dias, 297 leads de anúncio):
 *  - o campo "◷ Preferência de horário" que a Sofia grava só estava preenchido em 1 cartão e "⬢ Intenção
 *    principal = Agendar" em 3 — não há volume ali;
 *  - texto do paciente não serve: a mensagem pronta do anúncio já diz "quero agendar uma avaliação", e
 *    "boa tarde" casa com "tarde";
 *  - `consultar_horarios` com horário CONFIRMADO para oferecer é o momento em que a Sofia já sabe que o
 *    paciente quer marcar e que a clínica tem vaga. É o sinal que existe, é barato e não inventa lead para
 *    quem só disse "oi".
 *
 * LIMITES CONHECIDOS: a consulta também serve à remarcação e o gatilho não olha a etapa (o n8n filtra: só etapa pré-agendamento,
 * só cartão de anúncio, só até 7 dias do clique); o "uma vez por dia" vive na memória do processo (um deploy repete o PATCH — a
 * etiqueta é idempotente e o evento tem event_id único); o seco não lê o cartão, então "etiquetaria" conta consultas, não cartões sem etiqueta.
 *
 * COMO O RECADO CHEGA AO n8n: uma etiqueta no cartão ("IA · Pediu horário"). O n8n já lê o cartão inteiro a cada
 * webhook da Kommo; etiqueta não precisa de chave nem de endpoint novo, a SDR enxerga o que a máquina enxergou, e
 * quem escreve é UM só (a Sofia). O n8n NUNCA grava nada de volta aqui — por isso não há segundo escritor.
 *
 * Nasce em "só no papel" na rede toda (catálogo: `quandoVazio: 'seco'`): decide e escreve uma linha na tela de
 * Automações ("etiquetaria"), sem tocar no Kommo. Ligar é uma unidade por vez, pela tela.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { logger } from './logger.js';

export const ID_AUTOMACAO = 'capi-pediu-horario';
/** Nome exato que o n8n procura (cfg.pediuHorario.tag). Mudar aqui é mudar o contrato com o fluxo da Meta. */
export const ETIQUETA_PEDIU_HORARIO = 'IA · Pediu horário';

/** A etiqueta é idempotente na Kommo, mas cada PATCH dispara webhook; uma vez por cartão por dia basta. */
const REPETIR_A_CADA_MS = 24 * 3600_000;
const vistos = new Map<string, number>();

export type ResultadoPediuHorario = 'sem-cartao' | 'desligado' | 'seco' | 'marcou' | 'repetido' | 'falhou';

export interface DepsPediuHorario {
  estado: (slug: string) => Estado;
  simular: typeof registrarSimulacao;
  agora: () => number;
}

const depsPadrao: DepsPediuHorario = {
  estado: (slug) => estadoDaAutomacao(slug, ID_AUTOMACAO, process.env.CAPI_PEDIU_HORARIO_SLUGS),
  simular: registrarSimulacao,
  agora: () => Date.now(),
};

/**
 * Chamada quando a Sofia acabou de achar horário para oferecer. Nunca lança e nunca atrasa a resposta
 * ao paciente (quem chama não espera: `void`). Em seco só registra; ligada, põe a etiqueta.
 */
export async function sinalizarPediuHorario(
  unit: Pick<Unit, 'id' | 'slug'>,
  leadId: number | undefined,
  kommo: Pick<KommoClient, 'addTag'> | undefined,
  deps: DepsPediuHorario = depsPadrao,
): Promise<ResultadoPediuHorario> {
  try {
    if (!leadId || !Number.isFinite(leadId) || leadId <= 0 || !kommo) return 'sem-cartao';
    const estado = deps.estado(unit.slug);
    if (estado === 'desligado') return 'desligado';

    if (estado === 'seco') {
      deps.simular(unit, ID_AUTOMACAO, {
        leadId,
        acao: 'etiquetaria',
        alvo: ETIQUETA_PEDIU_HORARIO,
        motivo: 'a Sofia achou horário para oferecer — o fluxo da Meta mandaria LeadSubmitted',
      });
      return 'seco';
    }

    const chave = `${unit.id}:${leadId}`;
    const agora = deps.agora();
    if (agora - (vistos.get(chave) ?? 0) < REPETIR_A_CADA_MS) return 'repetido';
    vistos.set(chave, agora);
    if (vistos.size > 20_000) for (const [k, t] of vistos) if (agora - t > REPETIR_A_CADA_MS) vistos.delete(k);

    try {
      await kommo.addTag({ leadId, tag: ETIQUETA_PEDIU_HORARIO });
    } catch (err) {
      vistos.delete(chave); // não deu: a próxima consulta tenta de novo
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pediu-horario: não consegui pôr a etiqueta');
      return 'falhou';
    }
    return 'marcou';
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pediu-horario: erro inesperado (ignorado)');
    return 'falhou';
  }
}

/** Só para teste: esquece o que já marcou. */
export function esquecerPediuHorario(): void {
  vistos.clear();
}
