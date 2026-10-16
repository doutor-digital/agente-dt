/**
 * As duas chaves da resposta aos LEMBRETES que o robô do Kommo manda (decisão do João, 16/10/2026):
 *
 *  - `confirmacao-d1` (CONFIRMACAO_D1_SLUGS): a véspera da consulta sai pelo gatilho de 24 h do Kommo,
 *    e o toque em "Confirmar presença"/"Preciso remarcar" é tratado em código. Ligada, DESLIGA a
 *    véspera do servidor (reminder-worker) nesta unidade — senão o paciente recebe duas perguntas.
 *  - `confirmar-sessao` (CONFIRMAR_SESSAO_SLUGS): o mesmo toque no lembrete da SESSÃO (24 h / 3 h antes
 *    da ◷ Próxima sessão) responde sozinho e confirma a sessão na franquia.
 *
 * Mora num arquivo à parte, sem dependência pesada, porque o reminder-worker também pergunta.
 */
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';

export type TipoLembrete = 'consulta' | 'sessao';

export const AUTOMACAO_DO_LEMBRETE: Record<TipoLembrete, string> = {
  consulta: 'confirmacao-d1',
  sessao: 'confirmar-sessao',
};

const VARIAVEL_DO_LEMBRETE: Record<TipoLembrete, string> = {
  consulta: 'CONFIRMACAO_D1_SLUGS',
  sessao: 'CONFIRMAR_SESSAO_SLUGS',
};

export function estadoDoLembrete(slug: string, tipo: TipoLembrete, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_DO_LEMBRETE[tipo], env[VARIAVEL_DO_LEMBRETE[tipo]]);
}

/** A véspera desta unidade é do robô do Kommo? Só "ligado" tira a do servidor; "só no papel" não muda nada. */
export function vesperaPeloRoboDoKommo(slug: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return estadoDoLembrete(slug, 'consulta', env) === 'ligado';
}
