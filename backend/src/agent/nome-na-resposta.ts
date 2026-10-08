/**
 * Guarda de saída: nome de profissional só vai ao paciente quando a AGENDA acabou de devolvê-lo.
 *
 * Fontes vivas = o prompt deste turno (o bloco <consulta_do_paciente> com a consulta confirmada agora
 * na franquia, o "próximo agendamento" lido da franquia) + o que as ferramentas devolveram neste turno
 * (agendar_consulta / remarcar devolvem "Especialista: fisioterapeuta Fulana"). Nome que só existe no
 * HISTÓRICO é de consulta velha: em 08/10/2026 a Sofia disse "com a fisioterapeuta Aylana" sobre uma
 * consulta que tinha sido ontem (cartão 28088906, Açailândia). A confirmação logo depois de marcar
 * continua com o nome (21/09 e 03/10: o nome certo do turno é o que a agenda devolve).
 */
import { nomeEstaNaFonte, semNomeDeProfissional } from '../lib/nome-do-profissional.js';

interface MensagemDoTurno {
  getType(): string;
  content: unknown;
}

function textoDe(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : ''))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

/** O que as ferramentas devolveram DESDE a última mensagem do paciente. */
export function resultadosDasFerramentasDoTurno(mensagens: ReadonlyArray<MensagemDoTurno>): string[] {
  let inicio = 0;
  for (let i = mensagens.length - 1; i >= 0; i--) {
    if (mensagens[i].getType() === 'human') {
      inicio = i + 1;
      break;
    }
  }
  return mensagens.slice(inicio).filter((m) => m.getType() === 'tool').map((m) => textoDe(m.content));
}

/** Tira da resposta o nome de profissional que não está em nenhuma fonte viva deste turno. */
export function semNomeForaDaAgenda(
  resposta: string,
  promptDoTurno: string,
  mensagens: ReadonlyArray<MensagemDoTurno>,
): { texto: string; removidos: string[] } {
  const fonteViva = [promptDoTurno, ...resultadosDasFerramentasDoTurno(mensagens)].join('\n');
  return semNomeDeProfissional(resposta, nomeEstaNaFonte(fonteViva));
}
