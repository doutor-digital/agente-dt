/**
 * A rede de segurança em código do sinal de alerta (26/10/2026), no fim do turno.
 *
 * O paciente disse o sinal com todas as letras e o modelo não avisou a equipe: o código chama `pausar_ia` com
 * `sinalDeAlerta` (etiqueta 🔴 PRIORIDADE + tarefa LIGAR AGORA + Telegram do João). Se o modelo nem tinha pausado, a
 * resposta dele ignorou o sinal e sai a frase do passe; se já tinha pausado (só sem a flag), a resposta fica.
 * Fica fora do `graph.ts` para poder ser testado com ferramentas de mentira.
 */
import type { Unit } from '@prisma/client';
import type { BaseMessage } from '@langchain/core/messages';
import { logger } from '../lib/logger.js';
import { retornoDaEquipe } from '../lib/retorno-da-equipe.js';
import { AGENT_NODE_TIMEOUT_MS, withTimeout } from './llm-policy.js';
import { pacienteFalouDePs } from './sem-pronto-socorro.js';
import { chamadasDoTurno, ehClinicaParaSinalDeAlerta, fraseDoPasse, pausaDoTurno, sinalNaFala } from './sinal-de-alerta.js';

interface Ferramenta {
  name: string;
  invoke: (entrada: Record<string, unknown>) => Promise<unknown>;
}

export interface PasseEntrada {
  unit: Unit;
  leadId: string | number | undefined;
  /** As mensagens do turno (sem o system), de onde saem as chamadas de ferramenta do modelo. */
  mensagens: BaseMessage[];
  /** As falas do paciente que ainda não tiveram resposta (`falasDoTurno`). */
  falasDoPaciente: string[];
  tools: Ferramenta[];
  recorder: { step: (s: { kind: 'THINKING' | 'ERROR'; title: string; payload?: unknown }) => Promise<unknown> };
  textoFinal: string;
}

export interface PasseResultado {
  /** O aviso saiu (pelo código ou pelo modelo): quem vem depois não pausa de novo. */
  avisou: boolean;
  /** A resposta que vai ao paciente; igual à de entrada quando o código não mexeu. */
  texto: string;
}

export async function passarPorSinalNoTurno(e: PasseEntrada): Promise<PasseResultado> {
  const intacto: PasseResultado = { avisou: false, texto: e.textoFinal };
  if (!ehClinicaParaSinalDeAlerta(e.unit) || !e.leadId) return intacto;
  const { pausou, urgente } = pausaDoTurno(chamadasDoTurno(e.mensagens));
  if (urgente) return { avisou: true, texto: e.textoFinal };
  const sinal = sinalNaFala(e.falasDoPaciente);
  const pausar = e.tools.find((t) => t.name === 'pausar_ia');
  if (!sinal || !pausar) return intacto;

  let resultadoPausa: string;
  try {
    resultadoPausa = String(
      await pausar.invoke({ leadId: Number(e.leadId), motivo: `sinal de alerta: ${sinal}`.slice(0, 200), sinalDeAlerta: true }),
    );
  } catch (err) {
    resultadoPausa = `falhou: ${err instanceof Error ? err.message : String(err)}`;
  }
  const pegou = resultadoPausa.startsWith('OK');
  await e.recorder.step({
    kind: pegou ? 'THINKING' : 'ERROR',
    title: pegou
      ? `🚑 Sinal de alerta na fala do paciente (${sinal}) e o modelo ${pausou ? 'pausou sem avisar a equipe' : 'não parou'} — aviso feito pelo código`
      : `🚑 Sinal de alerta na fala do paciente (${sinal}) e o modelo não avisou; o aviso pelo código não pegou — saiu a resposta do modelo`,
    payload: { original: e.textoFinal, pausa: resultadoPausa },
  });
  // Pausa que não pegou: dizer "a equipe continua" com a IA ainda ligada seria prometer o que não aconteceu. (O aviso à
  // equipe sai ANTES da pausa dentro de `pausar_ia`, então a tarefa e o Telegram podem ter saído mesmo assim.)
  if (!pegou) return intacto;
  // O modelo já tinha pausado, só sem a flag: ele escreveu a resposta sabendo disso, e ela fica.
  if (pausou) return { avisou: true, texto: e.textoFinal };

  const texto = fraseDoPasse(retornoDaEquipe(e.unit), pacienteFalouDePs(e.falasDoPaciente));
  // O resumo para quem vai ligar: depois da pausa e do aviso, que são o que não pode esperar.
  const resumir = e.tools.find((t) => t.name === 'resumir_lead_para_sdr');
  if (resumir) {
    try {
      await withTimeout(
        resumir.invoke({ leadId: Number(e.leadId), focusHint: `SINAL DE ALERTA: ${sinal}. Queixa, sinais e há quanto tempo.` }),
        AGENT_NODE_TIMEOUT_MS,
      );
    } catch (err) {
      logger.warn({ err: String(err), unit: e.unit.slug }, 'sinal de alerta: resumo pelo código falhou');
    }
  }
  return { avisou: true, texto };
}
