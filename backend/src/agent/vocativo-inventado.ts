/**
 * Guarda de saída: a IA só chama o paciente por um nome que ela leu em algum lugar (lista de Parauapebas, 22/10/2026).
 *
 * Lead 28679252 (15/10): a paciente nunca disse o nome (perfil do WhatsApp "Cris Cabeleireira"; nos dois áudios
 * transcritos, nenhum nome) e ouviu "Poxa, Amanda, isso já está pesando…" e "Combinado, Amanda!". O nome não estava
 * no prompt, nem na conversa, nem no que as ferramentas devolveram: foi inventado.
 *
 * Fontes = o prompt do turno (memória, franquia, conversa da outra Sofia) + o que o paciente escreveu ou falou (o
 * áudio transcrito entra na mensagem dele) + o que as ferramentas devolveram. A fala da própria IA não conta: um nome
 * que ela inventou antes não vira fonte. Só sai o vocativo logo depois de uma abertura ("Combinado, X!", "Poxa, X,");
 * nome no meio da frase fica, e na dúvida (diminutivo de um nome conhecido) também fica.
 */
import { textoDe } from './nome-na-resposta.js';

interface MensagemDoTurno {
  getType(): string;
  content: unknown;
}

const ABERTURAS = [
  'oi', 'ol[aá]', 'oi[eê]', 'poxa', 'puxa', 'nossa', 'opa', 'ah', 'ai', 'combinado', 'certo', 'certinho', 'perfeito',
  'entendi', 'entendo', 'que bom', '[oó]timo', 'obrigad[ao]', 'prazer', 'imagina', 'claro', 'tudo bem', 'bom dia',
  'boa tarde', 'boa noite', 'sinto muito', 'fico feliz', 'maravilha', 'beleza', 'pronto', 'pode deixar', 'anotado',
  'fica tranquil[ao]', 'com certeza', 'exato', 'isso', 'ent[aã]o',
]
  // a primeira letra nas duas caixas, sem a flag `i`: com ela, \p{Lu} também casaria minúscula ("Certo, então.")
  .map((a) => (a.startsWith('[') ? a.replace(/^\[([^\]]+)\]/, (_m, c: string) => `[${c}${c.toUpperCase()}]`) : `[${a[0]}${a[0].toUpperCase()}]${a.slice(1)}`))
  .join('|');

// abertura no começo da frase, até 2 palavras a mais ("Que bom te ver"), vírgula, o nome e logo a pontuação ou um emoji
const VOCATIVO = new RegExp(
  String.raw`(^|[.!?…]\s+|\n\s*)((?:${ABERTURAS})(?:\s+[a-zà-ÿ]+){0,2}?)\s*,\s+(\p{Lu}\p{Ll}{1,20})(?=\s*[!?,.…—–]|\s+\p{Extended_Pictographic}|\s*$)`,
  'gu',
);

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Tratamento e abreviação não são nome: "Combinado, Sr. Belino!" e "Entendo, Dra. Sofia aqui" ficam como estão. */
const NAO_E_NOME = new Set(['sr', 'sra', 'srta', 'dr', 'dra', 'jr', 'sofia']);

function palavrasDa(fonte: string): string[] {
  return semAcento(fonte).split(/[^a-z0-9]+/).filter((p) => p.length >= 2);
}

/**
 * O nome está na fonte, inteiro ou como começo de uma palavra dela ("Fran" e "Lu" de "Franciara" e "Luciana"), ou ao
 * contrário com pelo menos 3 letras. Na dúvida fica: o erro barato é deixar um nome que veio de algum lugar.
 */
function nomeConhecido(nome: string, palavras: ReadonlySet<string>): boolean {
  const n = semAcento(nome);
  if (NAO_E_NOME.has(n) || palavras.has(n)) return true;
  for (const p of palavras) if (p.startsWith(n) || (p.length >= 3 && n.startsWith(p))) return true;
  return false;
}

/** Tira da resposta o vocativo com um nome que não está em nenhuma fonte do turno. */
export function semVocativoInventado(
  resposta: string,
  promptDoTurno: string,
  mensagens: ReadonlyArray<MensagemDoTurno>,
): { texto: string; removidos: string[] } {
  const doPaciente = mensagens.filter((m) => m.getType() === 'human' || m.getType() === 'tool').map((m) => textoDe(m.content));
  const palavras = new Set(palavrasDa([promptDoTurno, ...doPaciente].join('\n')));
  const removidos: string[] = [];
  const texto = resposta.replace(VOCATIVO, (inteiro: string, antes: string, abertura: string, nome: string) => {
    if (nomeConhecido(nome, palavras)) return inteiro;
    removidos.push(nome);
    return antes + abertura;
  });
  return { texto, removidos };
}
