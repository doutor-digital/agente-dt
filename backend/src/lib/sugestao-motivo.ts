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
import { ehRespostaDeCortesia } from './cortesia.js';

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
  /** quando foi dita (epoch s). Só a perda-ia usa; a sugestão do widget ignora. */
  em?: number;
  /** áudio do paciente ainda sem transcrição (`transcreverAudios` troca o "[áudio]" do texto pela fala) */
  audioLink?: string;
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

/** Menos que isto (já normalizada) não prova nada: «oi», «...», «ok» estão em qualquer conversa. */
export const MIN_CHARS_DA_PROVA = 6;

export type ProvaDaFrase = { ok: true; fala: FalaDaConversa } | { ok: false; porque: 'curta' | 'pergunta' | 'ausente' };


/** Minúscula, sem acento, espaços colapsados — e a PONTUAÇÃO fica: «não, quero agendar» não pode virar «não quero agendar». */
function comPontuacao(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Palavra que inverte o que vem depois: «tenho interesse» dentro de «NÃO tenho interesse» não prova recusa nenhuma. */
const NEGADORES = new Set(['nao', 'nunca', 'jamais', 'nem', 'sem', 'nenhum', 'nenhuma']);
const ehLetra = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);

/** Primeira ocorrência de `alvo` em `texto` em fronteira de palavra e sem negador logo antes (a menos que a própria frase comece por um). */
function achaSemInverter(texto: string, alvo: string): boolean {
  const comecaNegando = NEGADORES.has(alvo.split(' ')[0].replace(/[^a-z0-9]/g, ''));
  for (let i = texto.indexOf(alvo); i >= 0; i = texto.indexOf(alvo, i + 1)) {
    if (ehLetra(texto[i - 1]) || ehLetra(texto[i + alvo.length])) continue;
    const anterior = texto.slice(0, i).match(/([a-z0-9]+) $/)?.[1];
    if (anterior && NEGADORES.has(anterior) && !comecaNegando) continue;
    return true;
  }
  return false;
}

/**
 * A ÚNICA regra de prova de um motivo (widget, motivo-perdido-ia e perda-ia usam esta). A frase que a IA cita tem de:
 *  - ter pelo menos 6 caracteres (só letras e números) e não ser cortesia («bom dia», «obrigada», «ok obrigado»: estão em toda conversa);
 *  - estar contida, COM A PONTUAÇÃO, em UMA fala do PACIENTE — a mais recente que a traz — em fronteira de palavra e sem negador
 *    colado antes. Comparar sem pontuação deixava «não quero» provar «Não, quero agendar sim», e comparar sem olhar o negador deixava
 *    «tenho interesse» provar «não tenho interesse». Preferi isto a tentar entender o que vem DEPOIS da frase: é simples, errar
 *    significa não provar (o cartão fica) e cobre os dois sentidos invertidos reproduzidos. Custo conhecido: se o modelo «arrumar» a
 *    pontuação da citação (tirar uma vírgula), a prova falha e o motivo cai no genérico — por isso o prompt manda copiar IGUAL;
 *  - e essa fala inteira não pode ser cortesia nem ter pergunta («não quero cirurgia. vocês atendem?» é dúvida).
 * `doPaciente` são só as falas dele, na ordem em que valem.
 */
export function provaDaFrase(frase: string, doPaciente: readonly FalaDaConversa[]): ProvaDaFrase {
  if (frase.trim().endsWith('?')) return { ok: false, porque: 'pergunta' };
  let alvo = comPontuacao(frase).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (alvo.length > 40) alvo = alvo.slice(0, 41).replace(/ \S*$/, '') || alvo.slice(0, 40);
  if (normalizar(alvo).length < MIN_CHARS_DA_PROVA || ehRespostaDeCortesia(frase)) return { ok: false, porque: 'curta' };
  const fala = [...doPaciente].reverse().find((f) => achaSemInverter(comPontuacao(f.texto), alvo));
  if (!fala) return { ok: false, porque: 'ausente' };
  if (fala.texto.includes('?')) return { ok: false, porque: 'pergunta' };
  if (ehRespostaDeCortesia(fala.texto)) return { ok: false, porque: 'curta' };
  return { ok: true, fala };
}

export function fraseProva(frase: string, falas: readonly FalaDaConversa[]): boolean {
  return provaDaFrase(frase, falas.filter((f) => f.autor === 'PACIENTE')).ok;
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
    const prova = fraseProva(frase, falas);
    const clinicaFalouPorUltimo = falas.length > 0 && falas[falas.length - 1].autor !== 'PACIENTE';
    if (!prova && clinicaFalouPorUltimo) {
      const conversou = falas.filter((f) => f.autor === 'PACIENTE').length >= 2;
      const generico = achar(conversou ? 'Não deu continuidade ao atendimento' : 'Não interagiu');
      if (generico) return { motivo: generico, frase: '', travado: true };
    }
  }
  return { motivo, frase, travado: false };
}
