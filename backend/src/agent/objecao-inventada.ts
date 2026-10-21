/**
 * A Sofia interrogou uma objeção que o paciente não levantou, e não deu horário (auditoria de Araguaína, 21/10/2026).
 *
 * O caso (lead 28740960, 17/10): ela perguntou "Se quiser, posso só te mostrar um horário disponível pra você ver se
 * encaixa na sua rotina. Quer que eu veja?". Ele respondeu "Sim". Ela: "Me conta então: é mais o valor da consulta que
 * pesa, ou é a questão do horário que fica difícil pro seu trabalho?" — e dez minutos depois, de novo, "O que mais
 * pesa hoje: o valor ou o horário disponível?". O horário só saiu três horas depois, quando ele mandou um áudio.
 *
 * De onde vem: a regra "VOU PENSAR" do prompt manda descobrir a dúvida não dita ("o valor, o horário, ou saber se
 * resolve mesmo?"). Ela passou a usar a sondagem com quem não disse que ia pensar.
 *
 * Regra (João): não inventar objeção; se o paciente não levantou dúvida, seguir para os 2 horários. Aqui fica a
 * conferência em código sobre a resposta pronta — o grafo decide o que fazer (graph.ts).
 */
import type { Fala } from './repeticao.js';
import { juntarFrases, quebrarEmFrases } from './horario-oferecido.js';

/** A pergunta que sonda a objeção: "é o valor que te preocupa…?", "o que mais pesa: o valor ou o horário?". */
const SONDA_OBJECAO =
  /[ée]\s+(?:mais\s+)?o\s+valor|o\s+valor\s+(?:que\s+)?(?:te\s+|lhe\s+)?(?:preocupa|pesa)|o\s+que\s+(?:mais\s+)?(?:pesa|te\s+(?:preocupa|segura|impede|trava))|o\s+que\s+(?:ainda\s+)?(?:est[áa]|t[áa])\s+te\s+segurando|valor\s+ou\s+(?:[ée]\s+)?(?:o\s+|a\s+)?(?:quest[ãa]o\s+d[oe]\s+)?hor[áa]rio|hor[áa]rio\s+ou\s+(?:[ée]\s+)?(?:o\s+)?valor/i;

/** O que, na fala dele, já é dúvida ou objeção — aí a sondagem tem razão de ser. */
const OBJECAO_DELE =
  /pens|\bcar[oa]\b|valor|pre[çc]o|quanto|dinheiro|grana|pagar|pagamento|longe|dist[âa]n|tempo|medo|receio|marido|esposa|mulher|filh|fam[íi]lia|depois|n[ãa]o\s+sei|d[úu]vida|organiz|condi[çc]|parcel|plano|conv[êe]nio|trabalh|hor[áa]rio|agenda|viaj|desist|complicad|dif[íi]cil|apertad|ver\s+(?:com|e\s+te)/i;
/** "Não" é ambíguo (pode responder à pergunta de antes, pode ser recusa): fica com o prompt. */
const NEGA = /(?<![\p{L}])n[ãa]o(?![\p{L}])/iu;

function falaDoTurno(falas: Fala[]): string | null {
  let fim = falas.length - 1;
  while (fim >= 0 && falas[fim].papel !== 'paciente') fim--;
  if (fim < 0) return null;
  const textos: string[] = [];
  for (let i = fim; i >= 0 && falas[i].papel === 'paciente'; i--) textos.unshift(falas[i].texto);
  return textos.join('\n').trim();
}

/**
 * A frase da resposta que sonda uma objeção que ele NÃO levantou neste turno, ou null. Só quando a fala dele é
 * neutra ou um sim ("Sim", "pode ver", "quero") — com dúvida dita ou com "não", a sondagem pode ter razão.
 */
export function objecaoInventada(falas: Fala[], resposta: string): string | null {
  const fala = falaDoTurno(falas);
  if (!fala) return null;
  const semMarcas = fala.replace(/\[[^\]]*\]:?/g, ' ');
  if (!/[\p{L}\p{N}]/u.test(semMarcas)) return null; // só áudio não ouvido, só emoji: não dá para dizer
  if (OBJECAO_DELE.test(semMarcas) || NEGA.test(semMarcas)) return null;
  const sonda = quebrarEmFrases(resposta).find((p) => p.frase.includes('?') && SONDA_OBJECAO.test(p.frase));
  return sonda ? sonda.frase.trim() : null;
}

/** A resposta sem a frase que sonda a objeção (e sem botões, que seriam dela). Vazio se não sobrar nada. */
export function semASonda(resposta: string, sonda: string): string {
  const ficam = quebrarEmFrases(resposta).filter((p) => p.frase.trim() !== sonda && !/^\s*\[\[\s*botoes\s*:/i.test(p.frase));
  const resto = juntarFrases(ficam);
  return /[\p{L}\p{N}]/u.test(resto) ? resto : '';
}

export function instrucaoSemObjecao(fala: string): string {
  return (
    `[instrução interna, não é fala do paciente] Ele NÃO levantou dúvida nem objeção (a mensagem dele foi: "${fala.slice(0, 80)}"). ` +
    'NÃO pergunte o que pesa (valor, horário, se resolve). Siga para o próximo passo: chame consultar_horarios e ' +
    'ofereça DOIS horários concretos (dia da semana + DD/MM + hora). Responda só com a mensagem final.'
  );
}

/** A fala do paciente deste turno (para a instrução). */
export function falaDoPacienteNoTurno(falas: Fala[]): string {
  return falaDoTurno(falas) ?? '';
}
