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
import { withTimeout } from './llm-policy.js';
import { pacienteFalouDePs } from './sem-pronto-socorro.js';
import { enviarTelegram } from '../lib/telegram.js';
import { chamadasDoTurno, ehClinicaParaSinalDeAlerta, fraseDoPasse, pausaDoTurno, SEM_AVISO_NA_PAUSA, sinalNaFala } from './sinal-de-alerta.js';

/** O resumo é útil a quem vai ligar, mas não segura a resposta: prazo curto. */
const PRAZO_DO_RESUMO_MS = 8000;

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
  const chamadas = chamadasDoTurno(e.mensagens);
  const { pausou, urgente, semAviso } = pausaDoTurno(chamadas);
  // O modelo já avisou e parou: nada a fazer. (Se ele chamou a pausa urgente e ela FALHOU, `pausou` é falso e segue.)
  if (urgente && pausou && !semAviso) return { avisou: true, texto: e.textoFinal };
  // Pausou, mas a tarefa e o Telegram falharam: a resposta dele pode dizer "avisei" sem ser verdade — sai a frase honesta.
  if (urgente && pausou && semAviso) {
    return { avisou: true, texto: fraseDoPasse(retornoDaEquipe(e.unit), pacienteFalouDePs(e.falasDoPaciente), false) };
  }
  const sinal = urgente ? 'sinal de alerta confirmado pelo modelo' : sinalNaFala(e.falasDoPaciente);
  const pausar = e.tools.find((t) => t.name === 'pausar_ia');
  if (!sinal || !pausar) return intacto;
  const leadId = Number(e.leadId);

  const pausa = async (): Promise<string> => {
    try {
      return String(await pausar.invoke({ leadId, motivo: `sinal de alerta: ${sinal}`.slice(0, 200), sinalDeAlerta: true }));
    } catch (err) {
      return `falhou: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  // A pausa com o aviso sai PRIMEIRO e o resumo para quem vai ligar corre junto: o aviso não espera o resumo (um LLM),
  // o resumo não depende da pausa, e só ele tem prazo curto — a frase ao paciente não pode ficar presa nele.
  const pausando = pausa(); // começa ANTES do resumo: a pausa é a que não pode esperar
  const resumir = !pausou ? e.tools.find((t) => t.name === 'resumir_lead_para_sdr') : undefined;
  const resumo = resumir
    ? withTimeout(
        resumir.invoke({ leadId, focusHint: `SINAL DE ALERTA: ${sinal}. Queixa, sinais e há quanto tempo.` }),
        PRAZO_DO_RESUMO_MS,
      ).catch((err) => logger.warn({ err: String(err), unit: e.unit.slug }, 'sinal de alerta: resumo pelo código falhou'))
    : Promise.resolve();
  let [resultadoPausa] = await Promise.all([pausando, resumo]);
  let pegou = resultadoPausa.startsWith('OK');
  // Uma segunda tentativa: a pausa é o que impede a IA de continuar vendendo para quem tem sinal de alerta.
  if (!pegou) {
    resultadoPausa = await pausa();
    pegou = resultadoPausa.startsWith('OK');
  }
  await e.recorder.step({
    kind: pegou ? 'THINKING' : 'ERROR',
    title: pegou
      ? `🚑 Sinal de alerta (${sinal}) e o modelo ${pausou ? 'pausou sem avisar a equipe' : 'não parou'} — aviso feito pelo código`
      : `🚨 Sinal de alerta (${sinal}) e a pausa pelo código FALHOU duas vezes — a IA segue ligada neste cartão`,
    payload: { original: e.textoFinal, pausa: resultadoPausa },
  });

  const retorno = retornoDaEquipe(e.unit);
  const falouDePs = pacienteFalouDePs(e.falasDoPaciente);
  if (!pegou) {
    // Alerta direto ao João: a pausa é o que segura a IA, e o aviso do cartão pode não ter saído.
    await enviarTelegram(
      `⚠️ Sinal de alerta SEM pausa · ${e.unit.name} · lead ${leadId}: ${sinal}. A pausa falhou duas vezes (${resultadoPausa.slice(0, 120)}). Olhar o cartão agora.`,
    ).catch(() => false);
    // A resposta do modelo não sai como se nada fosse: ele não viu o sinal. Sai a frase do passe, sem dizer que a equipe
    // foi avisada (não sabemos se foi). Só fica a resposta dele se marcou consulta (é a confirmação que o paciente precisa).
    if (chamadas.some((c) => c.name === 'agendar_consulta')) return intacto;
    return { avisou: false, texto: fraseDoPasse(retorno, falouDePs, false) };
  }
  const avisada = !resultadoPausa.includes(SEM_AVISO_NA_PAUSA);
  // O modelo marcou consulta neste turno: a confirmação dele é a única que o paciente recebe, então a resposta fica
  // (a pausa e o aviso à equipe já saíram).
  if (chamadas.some((c) => c.name === 'agendar_consulta')) return { avisou: true, texto: e.textoFinal };
  // O modelo já tinha pausado, só sem a flag: ele escreveu a resposta sabendo disso, e ela fica — a menos que ninguém
  // tenha sido avisado (a frase dele diria que sim).
  if (pausou && avisada) return { avisou: true, texto: e.textoFinal };
  return { avisou: true, texto: fraseDoPasse(retorno, falouDePs, avisada) };
}
