/**
 * Sugestão do "⊘ Motivo do não agendamento" pela IA, para a SDR CONFIRMAR no widget (05/10/2026).
 *
 * Decisão do João: a IA sugere, a SDR confirma com um clique — nunca grava sozinha. Medido contra o gabarito dele
 * (31 conversas reais): SDR 90%, IA ~70%. O teto vem de coisas que não estão no chat (combinado por ligação) e de
 * casos iguais com rótulos diferentes; por isso a palavra final é da SDR, e cada "Usar"/"Trocar" fica registrado
 * para medir se a IA melhora.
 *
 * Fonte: a conversa OFICIAL do Kommo (Sofia + equipe + paciente), com áudio transcrito — a do banco da Sofia não
 * tem a parte da SDR. A regra mais importante (e que a IA mais erra): PERGUNTAR não é RECUSAR — "atende pelo
 * plano?" seguido de silêncio é "Não deu continuidade", não "Plano de Saúde". Por isso, além da instrução, uma
 * trava em código: motivo específico só vale com uma frase do PACIENTE que não seja pergunta.
 */
import { normalizar } from './franquia-sync.js';

export const CAMPO_MOTIVO_NAO_AGENDAMENTO = '⊘ Motivo do não agendamento';

const GENERICOS = ['nao interagiu', 'nao deu continuidade ao atendimento'];

export const INSTRUCAO_MOTIVO = `Este paciente conversou com a clínica pelo WhatsApp e NÃO agendou a consulta. Escolha o motivo.

REGRA PRINCIPAL: só escolha um motivo específico (Plano de Saúde, Sem condições financeira, Outra cidade, Vai se organizar, Sem interesse, Informação para terceiro, Clicou por engano, Outra patologia) se o PACIENTE DISSER esse motivo com as palavras dele. PERGUNTAR não é dizer o motivo: "atende pelo plano?", "quanto custa?" seguidos de silêncio NÃO são Plano de Saúde nem Sem condições financeira.

Quando o paciente sumiu sem dizer o motivo:
- 'Não interagiu' = ele praticamente não conversou: só a mensagem inicial, ou pediu informação e não respondeu às perguntas da clínica.
- 'Não deu continuidade ao atendimento' = ele conversou (respondeu perguntas, contou da dor, perguntou valor/plano e recebeu resposta) e depois parou de responder.

Motivos específicos (só se o paciente disse):
- 'Plano de Saúde' = disse que só faz pelo plano/convênio, ou que vai procurar pelo plano.
- 'Sem interesse' = disse que não quer, recusou e agradeceu, ou pediu para encerrar.
- 'Vai se organizar' = disse que vai ver depois, que vai falar com o marido/esposa/família, ou adiou para outro dia.
- 'Sem condições financeira' = disse que não pode pagar ou que está caro para ele.
- 'Outra cidade' = disse que mora longe/em outra cidade.
- 'Informação para terceiro' = está buscando atendimento PARA outra pessoa.
- 'Clicou por engano' = disse que clicou sem querer.
- 'Outra patologia' = o problema não é de coluna/hérnia.

EXEMPLOS:
1) "Atende pelo plano São Bernardo?" → clínica explica que é particular → silêncio = Não deu continuidade ao atendimento.
2) "Só faço se for pelo plano, obrigado" = Plano de Saúde.
3) "Quanto custa?" → clínica responde → silêncio = Não deu continuidade ao atendimento.
4) "Oi, quero informações" → clínica pergunta o nome e a dor → silêncio = Não interagiu.
5) "Vou conversar com meu marido e te falo" = Vai se organizar.
6) "Não quero, obrigada" = Sem interesse.
7) "É pra minha mãe" = Informação para terceiro.`;

export type Autor = 'PACIENTE' | 'SOFIA' | 'EQUIPE';
export interface FalaDaConversa {
  autor: Autor;
  texto: string;
}

/** Quem é quem na conversa oficial: external = paciente; bot (ou o usuário "Doutor Digital", a voz da Sofia) = Sofia. */
export function autorDaMensagem(author: { type?: string | null; name?: string | null } | null | undefined): Autor {
  if (author?.type === 'external') return 'PACIENTE';
  if (author?.type === 'bot' || normalizar(author?.name) === 'doutor digital') return 'SOFIA';
  return 'EQUIPE';
}

export function montarPrompt(falas: FalaDaConversa[], opcoes: string[]): string {
  const texto = falas.map((f) => `${f.autor}: ${f.texto}`).join('\n').slice(-16_000) || '(sem mensagens)';
  return (
    `${INSTRUCAO_MOTIVO}\n\nNa conversa: PACIENTE = o paciente; SOFIA = a assistente virtual; EQUIPE = a atendente humana.\n\n` +
    `Opções (EXATAMENTE uma delas): ${JSON.stringify(opcoes)}\n\nConversa:\n${texto}\n\n` +
    `Responda só com JSON: {"frase_do_paciente": "<frase do PACIENTE que mostra o motivo, ou vazio>", "resposta": "<opção>"}`
  );
}

export interface Sugestao {
  motivo: string;
  /** frase do paciente que justifica (vazia quando ele não disse o motivo) */
  frase: string;
  /** true quando a trava trocou um motivo específico sem prova por "parou de responder" */
  travado: boolean;
}

/**
 * Puro: lê a resposta da IA, casa com uma opção da conta e aplica a trava. null = resposta ilegível ou opção que a
 * conta não tem (o widget mostra "não consegui sugerir").
 */
export function interpretarResposta(texto: string, falas: FalaDaConversa[], opcoes: string[]): Sugestao | null {
  let j: { resposta?: unknown; frase_do_paciente?: unknown };
  try {
    j = JSON.parse(texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const achar = (nome: string) => opcoes.find((o) => normalizar(o) === normalizar(nome)) ?? null;
  const motivo = achar(String(j.resposta ?? ''));
  if (!motivo) return null;
  const frase = String(j.frase_do_paciente ?? '').trim();

  if (!GENERICOS.includes(normalizar(motivo))) {
    const doPaciente = normalizar(falas.filter((f) => f.autor === 'PACIENTE').map((f) => f.texto).join(' '));
    const prova = frase.length > 0 && !frase.endsWith('?') && doPaciente.includes(normalizar(frase).slice(0, 40));
    const clinicaFalouPorUltimo = falas.length > 0 && falas[falas.length - 1].autor !== 'PACIENTE';
    if (!prova && clinicaFalouPorUltimo) {
      const conversou = falas.filter((f) => f.autor === 'PACIENTE').length >= 2;
      const generico = achar(conversou ? 'Não deu continuidade ao atendimento' : 'Não interagiu');
      if (generico) return { motivo: generico, frase: '', travado: true };
    }
  }
  return { motivo, frase, travado: false };
}
