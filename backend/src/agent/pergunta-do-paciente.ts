/**
 * Pergunta direta do paciente que fica sem resposta (lista de Marabá, 21/10/2026).
 *
 * Marabá, lead 28220160 (15/10): "Pode ser algum problema na coluna devido o acidente?" recebeu "Fico no aguardo de
 * saber um pouco mais — onde exatamente dói…"; minutos depois, "E se essa área vocês pode atender?" recebeu um
 * horário, sem o sim ou o não. O roteiro (dor primeiro, nome, horário) ganhou da pergunta dele.
 *
 * Aqui, em código: as perguntas que o paciente fez desde a última resposta que leu — frase com "?" ou que começa
 * como pergunta ("pode ser", "vocês atendem"). Preço fica de fora: tem o seu bloco, com a sua ordem
 * (preco-insistido.ts). Cortesia ("tudo bem?", "e você?") também. Puro, sobre a lista de falas.
 */
import type { Fala } from './repeticao.js';
import { linhasSemResposta, soCortesia } from './rajada.js';
import { perguntaPreco } from './preco-insistido.js';

/** Começo de pergunta sem o "?" — paciente no WhatsApp quase nunca põe. */
const COMECA_COMO_PERGUNTA = new RegExp(
  [
    // "pode ser" sozinho é o "ok" do paciente; pergunta é "pode ser da coluna", "pode ser por causa do acidente"
    String.raw`^(?:e\s+|mas\s+)?(?:pode\s+ser\s+(?:da|do|de|por|que|algo|algum|alguma|isso|problema)|ser[aá]\s+que|tem\s+como|[eé]\s+poss[ií]vel|d[aá]\s+pra|daria\s+pra|serve\s+(?:pra|para))\b`,
    // em qualquer ponto da frase: "E se essa área vocês pode atender" (lead 28220160)
    String.raw`\b(?:voc[eê]s|vcs|a\s+cl[ií]nica|o\s+especialista|a\s+especialista)\s+(?:\S+\s+){0,2}?(?:atende[mnr]?|trata[mnr]?|faz(?:em)?|cuida[mnr]?|aceita[mnr]?)(?![\wÀ-ÿ])`,
    String.raw`^(?:e\s+|mas\s+)?(?:como\s+(?:funciona|fa[cç]o|faz)|onde\s+fica|quanto\s+tempo|qual|quais)\b`,
  ].join('|'),
  'i',
);

const MAX_PERGUNTAS = 3;

function frases(linha: string): string[] {
  return linha
    .split(/(?<=[?!.])\s+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

function ehPergunta(frase: string): boolean {
  if (!/\p{L}/u.test(frase)) return false; // "??" sozinho é cobrança, não pergunta nova
  return frase.includes('?') || COMECA_COMO_PERGUNTA.test(frase);
}

/** As perguntas do paciente ainda sem resposta, sem preço e sem cortesia (no máximo 3, as últimas). */
export function perguntasEmAberto(falas: ReadonlyArray<Fala>): string[] {
  const perguntas = linhasSemResposta(falas)
    .flatMap(frases)
    .filter((f) => ehPergunta(f) && !perguntaPreco(f) && !soCortesia(f));
  return perguntas.slice(-MAX_PERGUNTAS);
}

export function renderPerguntaDoPaciente(falas: ReadonlyArray<Fala>, opts: { clinica: boolean }): string {
  const perguntas = perguntasEmAberto(falas);
  if (perguntas.length === 0) return '';
  return [
    '<pergunta_do_paciente>',
    '(contado pelo sistema: ele te fez esta pergunta e ela ainda não teve resposta)',
    ...perguntas.map((p) => `  > "${p.slice(0, 160)}"`),
    '- Responda na PRIMEIRA frase, direto e com franqueza — antes de qualquer pergunta sua (nome, dor, horário).',
    '  Nunca troque a pergunta dele por outra, nem responda "fico no aguardo".',
    '- Se ele já perguntou isso antes, responda de novo, com paciência e outras palavras — nunca "já te',
    '  expliquei" nem "como eu disse".',
    ...(opts.clinica
      ? [
          '- Pergunta sobre a causa ("pode ser da coluna?", "pode ser por causa do acidente?"): sem diagnosticar —',
          '  diga que pode ter relação, sim, e que é exatamente isso que o especialista examina na consulta.',
        ]
      : []),
    '- "Vocês atendem isso?": responda sim ou não pelo que as suas fontes dizem; se elas não disserem, diga que',
    '  confirma com a equipe — sem inventar.',
    '</pergunta_do_paciente>',
  ].join('\n');
}
