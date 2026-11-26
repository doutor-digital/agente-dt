/**
 * «Só agenda com sim» — a trava, NO CÓDIGO, de `agendar_consulta` / `remarcar_consulta` da Sofia do CRM (reclamação das unidades, 26/11/2026:
 * «marcou sem o paciente concordar»).
 *
 * O prompt já manda a Sofia confirmar antes de marcar, e o modelo às vezes marca assim mesmo: o paciente diz «vou ver» e a consulta é gravada
 * na franquia. Aqui a ferramenta só grava se o paciente aceitou, explicitamente, ESTE dia e ESTE horário, e NADA que ele disse depois desfez o aceite.
 * Vale a fala mais recente dele que seja um aceite ou uma retirada; falas neutras no meio (a forma de pagamento, o nome, o CPF — que a Sofia pede
 * DEPOIS do «sim» e ANTES de chamar a ferramenta) não desfazem, mas só se olha até as 4 últimas falas dele:
 *
 *  1. o paciente NOMEOU o horário (e, se falou do dia, é o mesmo dia) — «quinta às 14h», «pode ser 14:30», «amanhã às 9» —, ou
 *  2. disse «sim» (pode, quero, fechado, ok…) à última mensagem da Sofia, que oferecia UM horário só, o mesmo da ferramenta, com o dia.
 *     «Sim» a uma lista de horários não escolhe nenhum: recusa e a Sofia pergunta qual.
 *
 *  Dúvida, hesitação («vou ver», «depois te aviso», «talvez»), recusa («não», «outro dia»), pergunta de disponibilidade («tem 14h?») e horário
 *  ou dia DIFERENTE do que a ferramenta ia gravar recusam. O erro tem de cair sempre para o lado de perguntar mais uma vez: marcar sem
 *  consentimento é o que as clínicas reclamam, perguntar de novo custa uma mensagem.
 *
 * Chave `chatwoot-agenda-so-com-sim` (CHATWOOT_AGENDA_SO_COM_SIM_SLUGS) por unidade, nasce DESLIGADA; em «só no papel» não bloqueia, só anota o
 * que bloquearia (tela «só no papel»).
 */
import { dataPorExtenso, diaDaSemana } from './feriados.js';
import type { Fala } from './chatwoot-sofia.js';

export const ID_SO_COM_SIM = 'chatwoot-agenda-so-com-sim';

export type Aceite = { ok: true } | { ok: false; motivo: string };

const semAcento = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const DIAS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

/** `HH:MM` de cada horário citado no texto («14h», «14h30», «14:30», «às 9», «2 da tarde», «9 da manhã»). */
export function horariosCitados(texto: string): Set<string> {
  const t = semAcento(texto);
  const out = new Set<string>();
  const add = (h: number, m = 0, periodo?: string) => {
    let hh = h;
    if ((periodo === 'tarde' || periodo === 'noite') && hh < 12) hh += 12;
    if (hh > 23 || m > 59) return;
    out.add(`${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  };
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\s*(?:h|horas?)(?![a-z])\s*(\d{2})?(?!\d)/g)) add(Number(m[1]), m[2] ? Number(m[2]) : 0);
  for (const m of t.matchAll(/(?<![\d/])(\d{1,2}):(\d{2})(?!\d)/g)) add(Number(m[1]), Number(m[2]));
  for (const m of t.matchAll(/(?<![\d/])\bas\s+(\d{1,2})(?!\d|\s*[/:]|\s*h(?![a-z])|\s*(?:sessoes|sessao|dias|vezes|meses|semanas|anos|reais|pessoas|vagas))(?:\s+da\s+(manha|tarde|noite))?/g)) add(Number(m[1]), 0, m[2]);
  for (const m of t.matchAll(/(?<![\d/])(\d{1,2})\s+da\s+(manha|tarde|noite)/g)) add(Number(m[1]), 0, m[2]);
  return out;
}

const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Dias da semana citados (`quinta`…), datas (`27/11`, `dia 27`, `27 de novembro`) e relativos (`hoje`, `amanha`, `depois de amanha`), sem repetir. */
function diasCitados(texto: string, anoMinimo = 0): { semana: Set<string>; datas: Set<string>; diasDoMes: Set<number>; relativos: Set<string> } {
  const t = semAcento(texto);
  const semana = new Set<string>();
  for (const m of t.matchAll(/(?<![a-z])(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?(?![a-z])/g)) semana.add(m[1]!);
  const datas = new Set<string>();
  // «15/03/1980» é nascimento, não dia de consulta: data com ANO de antes do ano do alvo nunca é candidata
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?!\d)/g)) {
    const ano = m[3] ? (m[3].length === 4 ? Number(m[3]) : Number(m[3]) <= 69 ? 2000 + Number(m[3]) : 1900 + Number(m[3])) : null;
    if (ano !== null && ano < anoMinimo) continue;
    datas.add(`${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`);
  }
  // «15 de março de 1980» (nascimento) e «Rua 15 de Novembro» (endereço) não são dia de consulta
  for (const m of t.matchAll(new RegExp(`(?<!\\d)(\\d{1,2}) de (${MESES.join('|')})(?![a-z])(?: de (\\d{4}))?`, 'g'))) {
    if (m[3] && Number(m[3]) < anoMinimo) continue;
    if (/(?<![a-z])(?:rua|r|av|avenida|travessa|tv|praca|alameda|rodovia|estrada)\.?\s+(?:\S+\s+)?$/.test(t.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0))) continue;
    datas.add(`${String(MESES.indexOf(m[2]!) + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`);
  }
  // «dia 27» (sem mês): só o dia do mês, comparado com o do alvo
  const diasDoMes = new Set<number>();
  for (const m of t.matchAll(/(?<![a-z])dia\s+(\d{1,2})(?![\d/]|\s*de\s)/g)) diasDoMes.add(Number(m[1]));
  const relativos = new Set<string>();
  if (/depois de amanha/.test(t)) relativos.add('depois-de-amanha');
  else if (/(?<![a-z])amanha(?![a-z])/.test(t)) relativos.add('amanha');
  if (/(?<![a-z])hoje(?![a-z])/.test(t)) relativos.add('hoje');
  return { semana, datas, diasDoMes, relativos };
}

const somarDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** O dia citado bate com `data` (AAAA-MM-DD)? `null` = o texto não cita dia nenhum. `hoje` = a data de hoje na unidade (para amanhã/hoje). */
function diaBate(c: ReturnType<typeof diasCitados>, data: string, hoje: string | null): boolean | null {
  const nada = !c.semana.size && !c.datas.size && !c.diasDoMes.size && !c.relativos.size;
  if (nada) return null;
  const semanaDoAlvo = semAcento(diaDaSemana(data)).split('-')[0] ?? '';
  const mmdd = data.slice(5);
  const bateSemana = [...c.semana].every((d) => d === semanaDoAlvo);
  const bateData = [...c.datas].every((d) => d === mmdd) && [...c.diasDoMes].every((d) => d === Number(data.slice(8, 10)));
  const bateRel = [...c.relativos].every((r) => (hoje ? data === (r === 'hoje' ? hoje : r === 'amanha' ? somarDias(hoje, 1) : somarDias(hoje, 2)) : false));
  return bateSemana && bateData && bateRel;
}

/** hesitação e desistência: desfazem o aceite onde quer que venham («vou ver», «vamos ver», «esquece, deixa pra lá») */
const HESITACAO = new RegExp(
  [
    String.raw`\bvou (?:ver|pensar|verificar|confirmar|avaliar|conversar|falar|consultar|checar|organizar)`,
    String.raw`\bvamos (?:ver|pensar|avaliar|conversar|falar|checar|verificar|esperar|aguardar)`,
    String.raw`\bdeixa(?:r)? (?:eu )?(?:ver|pensar|confirmar|verificar|checar|falar)`,
    String.raw`\bpreciso (?:ver|pensar|confirmar|conferir|falar|saber|checar|verificar|resolver|organizar)`,
    String.raw`\b(?:depois|mais tarde|amanha cedo) (?:eu )?(?:te )?(?:aviso|falo|confirmo|retorno|respondo|chamo|mando)`,
    String.raw`\bte aviso\b`, String.raw`\bte falo\b`, String.raw`\bte confirmo\b`,
    // «isso eu vejo depois», «decido amanhã», «depois a gente vê»: adiou
    String.raw`\b(?:vejo|decido|resolvo|penso|falo|aviso|respondo)(?: isso| isto| disso| tudo)?(?: com calma)? (?:depois|mais tarde|amanha|outro dia|na semana que vem|quando der)\b`, String.raw`\bisso eu (?:vejo|decido|resolvo|penso)\b`, String.raw`\bdepois a gente (?:ve|vê|conversa|fala|resolve|decide|pensa)\b`, String.raw`\bdepois eu (?:vejo|decido|aviso|confirmo|falo|resolvo|penso|retorno|respondo|te)\b`,
    String.raw`\btalvez\b`, String.raw`\bquem sabe\b`, String.raw`\bacho que\b`, String.raw`\bprovavelmente\b`,
    // desistência
    String.raw`\besquec[ae]\b`, String.raw`\bdeixa (?:pra|para) la\b`, String.raw`\bdeixa (?:quieto|disso|pra outra hora)\b`, String.raw`\bdesist[io]`,
    String.raw`\bmudei de ideia\b`, String.raw`\b(?:pensando|pensei) melhor\b`, String.raw`\bcancela(?:r)? (?:tudo|isso|esse|essa)\b`, String.raw`\bpode cancelar\b`, String.raw`\bnem vou\b`,
    // negação com verbo («não quero mais», «não vou conseguir ir», «não posso», «não dá»): fala do comparecimento, onde quer que venha
    String.raw`\bnao (?:quero|vou|posso|consigo|da|vai|serve|rola|topo|aceito)\b`, String.raw`\bnao tenho (?:como|condicoes|disponibilidade)\b`,
    String.raw`\bnao sei se\b`, String.raw`\bainda nao sei\b`,
    String.raw`\boutr[oa]s? (?:dia|horario|data|opcao)`, String.raw`\bsemana que vem\b`, String.raw`\bproxima semana\b`, String.raw`\bmais pra frente\b`,
    String.raw`\bcalma\b`, String.raw`\bespera(?:r)?\b`, String.raw`\baguarda(?:r)?\b`, String.raw`\bduvida\b`, String.raw`\bantes (?:de|disso)\b`,
    String.raw`\bmas\b`, String.raw`\bporem\b`, String.raw`\bsera que\b`, String.raw`\bseria possivel\b`, String.raw`\btem como\b`,
  ].join('|'),
);

/**
 * a NEGAÇÃO («não», «ainda não», «não sei»): só desfaz o aceite quando responde à pergunta do HORÁRIO. «Não, primeira vez» (a «já é paciente?») e
 * «não tenho convênio» não são recusa do horário — o «não» tem de se referir à vaga, não a qualquer pergunta que a Sofia faça depois do «sim».
 */
const NEGACAO = new RegExp(
  [
    String.raw`\bnao\b(?! (?:ha|tem|tenho|vejo|teria|vou ter) problema)`, String.raw`\bnn\b`, String.raw`\bn\b(?= (?:posso|consigo|da|vai))`, String.raw`\bn sei\b`,
    String.raw`\bainda\b(?! bem)`,
  ].join('|'),
);

/**
 * o paciente diz que o dia ou a hora citados NÃO servem para ele: só vale numa fala que cita hora, dia ou «nesse dia/horário». «trabalho» e «médico» só barram com
 * verbo de impedimento («eu trabalho», «tenho médico», «vou ter reunião nesse horário»): «é minha folga do trabalho» e «já tenho o pedido médico» são sim.
 */
const IMPEDIMENTO = new RegExp(
  [
    // «trabalho» como VERBO: «eu trabalho», «trabalho às 14h», «trabalho quinta», «to no trabalho»; «folga do trabalho», «saio do trabalho» (substantivo) não
    String.raw`\beu trabalho\b`, String.raw`(?<!(?:do|no|de|ao|meu|o|pro|pra|ate|ir ao|vou ao) )\btrabalho (?:nesse|nessa|neste|esse|essa|naquele|nesses|das|as|a partir|ate|de manha|a tarde|a noite|hoje|amanha|todo|todos|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b`,
    String.raw`\b(?:to|estou|fico|ja estou|estarei) (?:trabalhando|ocupad|em reuniao|de plantao|no servico|no trabalho|viajando)`, String.raw`\btrabalhamos\b`,
    // «tenho médico», «já tenho compromisso», «já tenho algo marcado», «vou ter reunião» — «já tenho o pedido médico» não
    String.raw`\b(?:ja )?(?:tenho|terei|vou ter) (?:um |uma |o |a |outro |outra )?(?:medic|compromiss|reunia|aula|prova|exame|dentist|consulta|plantao|curso|audiencia|servico|viagem)`,
    String.raw`\b(?:ja )?(?:tenho|terei|vou ter) (?:algo|alguma coisa|outra coisa|uma coisa)(?: marcad\w*)?\b`, String.raw`\bja (?:esta|to|estou) (?:ocupad|marcad)\w*`, String.raw`\btenho que (?:sair|ir|trabalhar|buscar|levar|estar|cuidar)\b`,
    String.raw`\b(?:vou ter|terei) [^.,;]{0,25}\b(?:nesse|nessa|neste|naquele) (?:dia|horario)`,
    String.raw`\b(?:estou|to|fico) ocupad[oa]\b`, String.raw`\bnao (?:estou|to) (?:livre|disponivel)\b`,
  ].join('|'),
);

/** palavras que dizem «sim» (a frase não é só pergunta de disponibilidade) */
const AFIRMA = /^\W*s\W*$|👍|👌|✅|(?<![a-z])(?:s+i+m+|show|fica sim|fica bom|fica otimo|serve(?: sim| pra mim| para mim)?|da sim|da certo|bacana|joia|massa|top|maravilha|legal|excelente|pode(?: ser| sim| marcar| agendar)?|quero(?: sim)?|fechado|fechou|combinado|ok|okay|beleza|blz|perfeito|otimo|otima|isso(?: mesmo)?|confirmo|confirmado|bora|vamos|marca(?:r)?|marque|agenda(?:r)?|agende|topo|claro|certo|tudo bem|ta bom|ta otimo|ta certo|com certeza|positivo|uhum|aham)(?![a-z])/;
/** o «sim» a UMA oferta só vale se a fala COMEÇA afirmando e é curta («sim», «pode marcar», «ok, perfeito»), sem pergunta nem pedido de informação */
const COMECA_AFIRMANDO = /^\W*s\W*$|^\W*(?:👍|👌|✅|s+i+m+|show|fica sim|fica bom|fica otimo|serve|da sim|da certo|bacana|joia|massa|top|maravilha|legal|excelente|pode|quero|fechado|fechou|combinado|ok|okay|beleza|blz|perfeito|otimo|otima|isso|confirmo|confirmado|bora|vamos|marca|marque|agende|topo|claro|certo|tudo bem|ta bom|ta otimo|ta certo|com certeza|positivo|uhum|aham)(?![a-z])/;
/** «ok, obrigada»: agradece, não escolhe o horário (o «ok» fraco colado num agradecimento não é aceite) */
const AGRADECE = /^\W*(?:ok|okay|certo|beleza|blz|entendi|tudo bem|ta bom|ta certo)\W*(?:muito )?(?:obrigad[oa]|brigad[oa]|valeu|vlw|grat[oa])\W*$/;
const PEDE_INFORMACAO = /(?<![a-z])(?:saber|quanto|qual|quais|onde|como|quando|que horas|valor|preco|endereco|convenio|plano|duvida|pergunta|queria|gostaria|preciso)(?![a-z])/;
/** «saio do trabalho às 14h», «só consigo depois das 14h»: o horário está na frase, mas não é a escolha */
const RESTRICAO_DE_HORA = /(?<![a-z])(?:saio|sai|saindo|depois d|apos|antes d|ate (?:as|a|o)|so consigo|so posso|a partir)/;

type Julgamento = { j: 'aceita' | 'retira' | 'neutra'; motivo: string };

function palavras(t: string): number {
  return t.trim().split(/\s+/).filter(Boolean).length;
}

/** a última frase interrogativa da mensagem (e o que vem depois dela); `null` se a mensagem não pergunta nada */
function ultimaPergunta(msg: string): string | null {
  const i = msg.lastIndexOf('?');
  if (i < 0) return null;
  let ini = 0;
  for (let k = i - 1; k >= 0; k--) {
    const c = msg[k]!;
    if (c === '\n' || c === '?' || c === '!' || (c === '.' && /\s/.test(msg[k + 1] ?? '') && !/(?:^|[\s(])(?:dr|dra|sr|sra|prof|profa|av|r|tel)$/i.test(msg.slice(0, k)))) {
      ini = k + 1;
      break;
    }
  }
  return msg.slice(ini, i + 1);
}

/** pergunta de agendamento: «posso marcar?», «pode ser?», «fechamos?», «esse horário serve?» */
const PERGUNTA_DE_AGENDA = /(?<![a-z])(?:marc\w*|agend\w*|reserv\w*|segur\w*|fech\w*|combinad\w*|confirm\w*|garant\w*|serve|funciona|da certo|pode ser|ta bom|esta bom|fica bom|ficaria bom|bom pra voce|bom para voce|tudo certo|tudo bem|combina|horario|vaga|esse dia|este dia|topa|ok|okay|beleza|de acordo)(?![a-z])/;
/** a pergunta pede para MARCAR («posso marcar…?», «quer que eu agende?», «fecho assim?»): vale mesmo com nome, Pix ou convênio na frase */
const PERGUNTA_DE_MARCAR = /(?<![a-z])(?:posso|podemos|pode|quer que eu|devo|vamos|deseja que eu|gostaria que eu)\s+(?:\w+\s+){0,2}?(?:marc\w*|agend\w*|reserv\w*|fech\w*)(?![a-z])|(?<![a-z])(?:marco|agendo|reservo|fecho)(?![a-z])/;
/** a pergunta é sobre OUTRA coisa (quem é a pessoa, convênio, dados, pagamento): sem o horário nela, o «sim» é a resposta a ela */
const PERGUNTA_DE_OUTRA_COISA = /(?<![a-z])(?:paciente|convenio|plano|nome|cpf|rg|nascimento|telefone|celular|endereco|cidade|bairro|email|pix|pagamento|pagar|dinheiro|cartao|conheceu|indicacao|sintoma|dor|queixa|exame|idade|primeira vez|alguma vez|antes|ja (?:fez|foi|e|esteve|marcou|agendou|veio|consultou|passou)|alergia|medicamento)(?![a-z])/;

/**
 * A mensagem da Sofia pergunta, no fim, SOBRE a vaga? «Tenho quinta às 14:00. Posso marcar?» sim; «Tenho quinta às 14:00. Você já é paciente?» não —
 * a última pergunta é outra. Sem pergunta nenhuma, vale se cita um horário ou fala de marcar.
 */
function perguntaEhDoHorario(msg: string): boolean {
  const q = ultimaPergunta(semAcento(msg));
  if (q === null) return horariosCitados(msg).size > 0 || PERGUNTA_DE_AGENDA.test(semAcento(msg));
  if (horariosCitados(q).size > 0) return true;
  // «Posso marcar no seu nome?» é a pergunta de marcar mesmo falando de nome; «Qual o seu nome?» não
  if (PERGUNTA_DE_MARCAR.test(q)) return true;
  return !PERGUNTA_DE_OUTRA_COISA.test(q) && PERGUNTA_DE_AGENDA.test(q);
}

/**
 * O que UMA fala do paciente diz sobre `alvo`: aceita, retira (hesitou, recusou, perguntou, escolheu outro) ou é neutra (nada a ver com o horário).
 * `anterior` = a mensagem da Sofia COLADA nela (o «sim» só vale a ela e o «não» só desfaz se responde à pergunta dela sobre o horário); `null` = não há
 * mensagem da Sofia imediatamente antes (primeira fala ou rajada do paciente): não dá para saber a que ele responde, e o «não» retira (o lado seguro).
 */
function julgarFala(texto: string, anterior: string | null, alvo: { data: string; hora: string }, hoje: string | null): Julgamento {
  // «sem dúvida, pode marcar» e «ainda bem que tem» são sim; tira antes de procurar hesitação
  const t = semAcento(texto).replace(/sem duvida/g, ' ').replace(/ainda bem/g, ' ');
  const horas = horariosCitados(texto);
  const dias = diasCitados(texto, Number(alvo.data.slice(0, 4)));
  const citaAgenda = /\bnes(?:se|sa|te|ta)s?\s+(?:dia|horario|data)|\bnaquele\s+(?:dia|horario)/.test(t) || horas.size > 0 || dias.semana.size > 0 || dias.datas.size > 0 || dias.diasDoMes.size > 0 || dias.relativos.size > 0;
  if (HESITACAO.test(t) || RESTRICAO_DE_HORA.test(t)) return { j: 'retira', motivo: 'o paciente hesitou, recusou ou condicionou o horário' };
  if (citaAgenda && IMPEDIMENTO.test(t)) return { j: 'retira', motivo: 'o paciente disse que esse dia ou horário não serve para ele' };
  // «não» só desfaz se responde à pergunta do horário (a da vaga, ou nenhuma antes: a fala é a resposta à oferta)
  if (NEGACAO.test(t) && (anterior === null || perguntaEhDoHorario(anterior))) return { j: 'retira', motivo: 'o paciente hesitou, recusou ou condicionou o horário' };
  const hora = alvo.hora.slice(0, 5);
  if (horas.size && !horas.has(hora)) return { j: 'retira', motivo: 'o paciente falou de outro horário' };
  if (horas.size > 1) return { j: 'retira', motivo: 'o paciente citou mais de um horário' };
  const dia = diaBate(dias, alvo.data, hoje);
  if (dia === false) return { j: 'retira', motivo: 'o paciente falou de outro dia' };
  const afirma = AFIRMA.test(t);
  const pergunta = t.includes('?');

  // 1. o paciente NOMEOU o horário (e o dia, se falou dele): escolheu
  if (horas.has(hora)) {
    if (pergunta && !afirma) return { j: 'retira', motivo: 'o paciente só perguntou se há esse horário; ainda não pediu para marcar' };
    if (dia === true) return { j: 'aceita', motivo: '' };
    // sem dia na fala dele: o dia tem de estar na oferta da Sofia
    const ofertaDia = anterior ? diaBate(diasCitados(anterior, Number(alvo.data.slice(0, 4))), alvo.data, hoje) : null;
    if (ofertaDia === true) return { j: 'aceita', motivo: '' };
    return { j: 'retira', motivo: ofertaDia === false ? 'o dia que a Sofia ofereceu não é este' : 'o paciente não disse o dia e a Sofia não ofereceu um dia só' };
  }

  // 2. «sim» a uma oferta de UM horário só, o mesmo da ferramenta
  if (pergunta) return { j: 'retira', motivo: 'o paciente perguntou algo; responda antes de marcar e confirme de novo' };
  if (!afirma) return { j: 'neutra', motivo: 'o paciente não disse sim nem escolheu o horário' };
  if (AGRADECE.test(t)) return { j: 'neutra', motivo: 'um «ok, obrigada» agradece, não escolhe o horário' };
  if (PEDE_INFORMACAO.test(t)) return { j: 'retira', motivo: 'o paciente perguntou ou pediu informação na mesma fala; confirme depois de responder' };
  if (!COMECA_AFIRMANDO.test(t) || palavras(t) > 8) return { j: 'neutra', motivo: 'a fala não é um «sim» curto' };
  if (!anterior) return { j: 'neutra', motivo: 'não há oferta da Sofia antes do «sim»' };
  // o «sim» responde à ÚLTIMA pergunta da mensagem: se ela era outra («…às 14:00. Você já é paciente?»), não é aceite do horário
  if (!perguntaEhDoHorario(anterior)) return { j: 'neutra', motivo: 'a última pergunta da Sofia não era sobre o horário, então o «sim» não o aceita' };
  const ofertados = horariosCitados(anterior);
  if (ofertados.size !== 1 || !ofertados.has(hora)) {
    return { j: 'neutra', motivo: ofertados.size > 1 ? 'a Sofia ofereceu vários horários e o «sim» não escolheu nenhum' : 'o horário que a Sofia ofereceu não é este' };
  }
  const ofertaDia = diaBate(diasCitados(anterior, Number(alvo.data.slice(0, 4))), alvo.data, hoje);
  if (ofertaDia !== true) return { j: 'neutra', motivo: ofertaDia === false ? 'o dia que a Sofia ofereceu não é este' : 'a Sofia não disse o dia na oferta' };
  return { j: 'aceita', motivo: '' };
}

/** Quantas falas do paciente para trás o aceite ainda vale (a forma de pagamento, o nome e o CPF vêm entre o «sim» e a ferramenta). */
const FALAS_PARA_TRAS = 4;

/**
 * O paciente aceitou `alvo` (data AAAA-MM-DD e hora HH:mm) e não desfez? Anda das falas dele mais recentes para as antigas: a primeira que for aceite
 * ou retirada decide; as neutras no meio não contam. `hoje` (AAAA-MM-DD na unidade) só serve para «amanhã» e «hoje». Pura: sem relógio, sem banco.
 */
export function aceitouEsteHorario(falas: readonly Fala[], alvo: { data: string; hora: string }, hoje: string | null = null): Aceite {
  const quando = `${dataPorExtenso(alvo.data)} às ${alvo.hora}`;
  const recusa = (porque: string): Aceite => ({ ok: false, motivo: `${porque} (${quando})` });
  if (!falas.length || falas[falas.length - 1]!.role !== 'user') return recusa('a última mensagem da conversa não é do paciente');
  let vistas = 0;
  let ultimoMotivo = 'o paciente não disse sim nem escolheu o horário';
  for (let i = falas.length - 1; i >= 0 && vistas < FALAS_PARA_TRAS; i--) {
    if (falas[i]!.role !== 'user') continue;
    vistas++;
    const anterior = i > 0 && falas[i - 1]!.role === 'assistant' ? falas[i - 1]!.content : null;
    const r = julgarFala(falas[i]!.content, anterior, alvo, hoje);
    if (r.j === 'aceita') return { ok: true };
    if (r.j === 'retira') return recusa(r.motivo);
    if (vistas === 1) ultimoMotivo = r.motivo;
  }
  return recusa(ultimoMotivo);
}

/** O texto que volta ao modelo quando a trava recusa: manda perguntar uma vez, em uma frase, e só chamar de novo depois do «sim». */
export function recusaDeAceite(ferramenta: string, a: Extract<Aceite, { ok: false }>, alvo: { data: string; hora: string }): string {
  return (
    `RECUSADO: o paciente ainda não aceitou ${dataPorExtenso(alvo.data)} às ${alvo.hora} — ${a.motivo}. A consulta NÃO foi ${ferramenta === 'remarcar_consulta' ? 'remarcada' : 'marcada'}. ` +
    `Pergunte, em UMA frase, se ele confirma exatamente esse dia e horário (ex.: «Posso marcar ${dataPorExtenso(alvo.data)} às ${alvo.hora}?») e só chame ${ferramenta} de novo depois de ele responder que sim. NÃO diga que está marcado.`
  );
}
