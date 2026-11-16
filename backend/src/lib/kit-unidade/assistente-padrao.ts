/**
 * O PADRÃO DA REDE para a seção «Assistente virtual» do formulário: as respostas de objeção que a Sofia 2.0 JÁ usa (ops/kit-unidade/molde-sofia/bloco-conversa.md,
 * seção D), as coisas que ela nunca faz (seção F + regras da rede) e quando ela passa para uma pessoa (seção E).
 *
 * Nada aqui é invenção: cada resposta padrão é o texto do molde com os marcadores trocados por colchetes que o dono entende
 * ([valor com sinal], [horário 1]…) — um teste confere que cada uma continua dentro do molde (se a rede mudar o roteiro, este arquivo avisa). «Tenho medo de doer» e «funciona mesmo?»
 * (16/11, decisão do João) entraram no molde e aqui com o MESMO texto, sem promessa de cura nem de resultado.
 *
 * A regra da rede SEMPRE vence o texto da clínica: o que o dono escreve vira «aprendizado» da unidade (bloco `<aprendizados>`, abaixo das regras da rede no prompt) ou
 * informação nas fontes; nunca muda preço, nunca autoriza diagnóstico, promessa de cura, desconto, nem tira a urgência.
 */

import { TITULO_DO_NUNCA } from '../aprendizados-unidade.js';

export interface ObjecaoPadrao {
  id: string;
  /** como o paciente fala, em linguagem do dono */
  gatilho: string;
  /** a resposta da rede, com [colchetes]; vazia = a rede não tem padrão */
  resposta: string;
  /** dica curta ao lado do campo */
  dica: string;
}

export const MAX_RESPOSTA_OBJECAO = 230;
export const MAX_OBJECOES_EXTRAS = 5;

export const OBJECOES_PADRAO: readonly ObjecaoPadrao[] = [
  { id: 'caro', gatilho: 'Tá caro', resposta: 'Quanto está custando conviver com essa dor, no trabalho e no sono? Com o sinal fica [valor com sinal], e a consulta mostra o que resolve de verdade.', dica: 'Se a clínica não cobra sinal, tire a parte do sinal.' },
  { id: 'pensar', gatilho: 'Vou pensar', resposta: 'Claro! O que pesa mais para você decidir: o valor, o horário ou saber se o tratamento serve pra você?', dica: '' },
  { id: 'convenio', gatilho: 'Aceita convênio?', resposta: 'Nosso atendimento é particular, individual e sem cirurgia. Muitos pacientes com plano tratam aqui por isso.', dica: 'Se a clínica aceita convênio, escreva aqui como é (e preencha também a parte «Pagamento» acima).' },
  { id: 'longe', gatilho: 'É longe', resposta: 'A unidade mais perto de você é [cidade]. Tenho [horário 1] ou [horário 2], dá certo?', dica: '' },
  { id: 'medo', gatilho: 'Tenho medo de doer', resposta: 'É normal ter esse receio. Na consulta o especialista conversa com você, avalia e explica tudo antes; nada é feito sem você entender e concordar. E o tratamento não envolve cirurgia.', dica: '' },
  { id: 'fisio', gatilho: 'Já fiz fisioterapia e não resolveu', resposta: 'Faz sentido desconfiar. A consulta é para achar a causa da dor, não só aliviar.', dica: '' },
  { id: 'familia', gatilho: 'Preciso falar com meu marido / minha família', resposta: 'Ótimo! Posso deixar um horário para vocês dois virem juntos: [horário 1] ou [horário 2]?', dica: '' },
  { id: 'tempo', gatilho: 'Não tenho tempo', resposta: 'Prefere o primeiro horário da manhã ou o último do dia? Tenho [horário 1] ou [horário 2].', dica: 'A assistente só oferece horários que existem de verdade na agenda.' },
  { id: 'funciona', gatilho: 'Funciona mesmo?', resposta: 'Cada caso é um caso, e é para isso que serve a consulta: o especialista acha a causa da sua dor e diz com clareza se o tratamento serve pra você, sem cirurgia.', dica: '' },
];

/** O que a assistente NUNCA faz (regra da rede: o dono não desliga). Só para mostrar na página. */
export const NUNCA_DA_REDE: readonly string[] = [
  'Prometer cura ou resultado garantido',
  'Dar diagnóstico ou indicar remédio',
  'Dar desconto, brinde ou promoção',
  'Falar um preço diferente do que está no cadastro da clínica',
  'Insistir depois de o paciente dizer «não quero» ou «pare de mandar»',
];

/** Quando a assistente chama uma pessoa da equipe (regra da rede). Só para mostrar na página. */
export const PASSA_PARA_PESSOA_DA_REDE: readonly string[] = [
  'O paciente pediu para falar com uma pessoa',
  'Reclamação ou assunto financeiro',
  'Dor forte ou sinais de urgência (a rede trata na hora e avisa a equipe)',
  'O paciente repete que está caro ou que não vai fechar (negociação de preço)',
  'Paciente que já está em tratamento',
];

export const QUANDO_ATENDE = [
  ['sempre', 'A assistente atende 24 horas por dia'],
  ['fora-expediente', 'Só fora do horário da clínica (quando ninguém da equipe está)'],
  ['noite-fim-semana', 'Só à noite e nos fins de semana'],
  ['personalizado', 'Outro horário (vou escrever)'],
] as const;

/** Troca os colchetes da página pelos marcadores do molde (só para o teste de deriva). */
export function paraMarcadoresDoMolde(texto: string): string {
  return texto
    .replace(/\[valor com sinal\]/g, '{{valor_com_sinal}}')
    .replace(/\[valor da consulta\]/g, '{{valor_no_dia}}')
    .replace(/\[valor do sinal\]/g, '{{valor_sinal}}')
    .replace(/\[cidade\]/g, '{{cidade}}')
    .replace(/\[horário 1\]/g, '{horário 1}')
    .replace(/\[horário 2\]/g, '{horário 2}');
}

/**
 * Os [colchetes] das respostas da rede são lacunas que o roteiro da rede preenche. Dentro de um APRENDIZADO (texto corrido, sem substituição) eles viram uma instrução clara, para a
 * Sofia nunca mandar «[valor com sinal]» ao paciente nem chutar um número.
 */
export function resolverMarcadores(texto: string): string {
  return texto
    .replace(/\[valor com sinal\]/gi, 'o valor com sinal do cadastro')
    .replace(/\[valor da consulta\]/gi, 'o valor da consulta do cadastro')
    .replace(/\[valor do sinal\]/gi, 'o valor do sinal do cadastro')
    .replace(/\[cidade\]/gi, 'a cidade da unidade')
    .replace(/\[hor[aá]rio 1\]/gi, 'o primeiro horário real da agenda')
    .replace(/\[hor[aá]rio 2\]/gi, 'o segundo horário real da agenda');
}

/** Os textos dos aprendizados, UM lugar só (o formulário confere o texto composto com as travas da página; o kit grava o mesmo). Aspas retas: a trava recusa « » < >. */
export const licaoDaSaudacao = (s: string) => `Ao se apresentar, use este jeito de falar da clínica: "${s.trim()}"`;
export const licaoDaObjecao = (gatilho: string, resposta: string) => `Se o paciente disser "${gatilho.trim()}", responda neste estilo: "${resolverMarcadores(resposta.trim())}"`;
/**
 * «O que a assistente nunca deve dizer»: UMA COISA CURTA POR LINHA, gravada COMO A DONA ESCREVEU — o kit não corta, não junta e não reescreve (cortar em vírgula/«e» e prefixar «Nunca»
 * foi o que fazia «Não diga que somos franquia, diga que somos independentes» virar o contrário). O aprendizado é uma lista sob o título «O dono pediu que a assistente NUNCA:», com a linha original
 * entre aspas. A linha que o kit NÃO consegue ler como UMA proibição simples é recusada, com o motivo, para a dona reescrever:
 *  - com vírgula, ponto, ponto e vírgula ou dois-pontos (são duas ideias: uma por linha), ou com «e»/«ou» seguido de verbo («…e dar desconto»);
 *  - com «não», «nunca» ou «jamais» depois do começo («dizer não ao desconto», «falar que não damos desconto»: o título já nega, e a segunda negação vira o contrário), ou que começa com «sempre»;
 *  - com exceção («exceto», «a menos que», «mas», «se o paciente…», «quando…»);
 *  - dupla negação («negar desconto», «deixar de prometer cura», «recusar…»);
 *  - mais de 100 letras.
 * A trava da rede lê cada item da lista como «Nunca <item>» (`recusaDaRegra` reconhece o título): é isso que deixa a dona proibir o que a rede já proíbe, e vale igual na página /aprendizados.
 */
export const MAX_LINHA_DO_NUNCA = 100;
const EXCECAO_NA_PROIBICAO = /\b(?:exceto|salvo|a menos que|menos quando|s[oó] se|somente se|apenas se|desde que|caso contr[aá]rio|mas|por[eé]m|contudo|entretanto|todavia|se (?:o|a|ele|ela|voc[eê]|for|houver|perguntar|pedir)|quando|caso (?:o|a|ele|ela|voc[eê]|haja|seja|queira|pe[cç]a|pergunte|tenha|for)|em caso de|enquanto|at[eé] que|depois que)\b/i;
const DUPLA_NEGACAO = /\b(?:nega(?:r|ndo|m)?|negue|neguem|recus\w+|evit\w+|omit\w+|abst\w+|deix\w+\s+de|par(?:ar|e)\s+de|esque[cç]\w+\s+de|dispens\w+)\b/i;
const VERBO_OU_ORDEM = /^(?:diga|dizer|fale|falar|responda|responder|seja|ser|fa[cç]a|fazer|ofere[cç]a|oferecer|prometa|prometer|garanta|garantir|use|usar|passe|passar|mande|mandar|envie|enviar|informe|informar|explique|explicar|sugira|sugerir|recomende|recomendar|indique|indicar|dar|aceite|aceitar|confirme|confirmar|marque|marcar|agende|agendar|chame|chamar|pe[cç]a|pedir|pergunte|perguntar|insista|insistir|aja|agir|atenda|atender|ignore|ignorar|esque[cç]a|trate|tratar|pode|podem|deve|devem|precisa|precisam|afirme|afirmar|assuma|conte|contar|comente|comentar|cite|citar|ent[aã]o)$/i;
const PRIMEIRA_PALAVRA = /^[\s"'“(]*([\p{L}]+)/u;
const semAcento = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '');
const resumo = (t: string) => (t.length > 60 ? `${t.slice(0, 57)}…` : t);

export function licoesDoNunca(texto: string): { ok: true; licao: string } | { ok: false; motivo: string } {
  const linhas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return { ok: false, motivo: 'Escreva o que a assistente nunca pode dizer.' };
  const recusa = (linha: string, porque: string) => ({ ok: false as const, motivo: `Em «${resumo(linha)}» ${porque}` });
  for (const linha of linhas) {
    const lida = semAcento(linha).replace(/[.\s]+$/, '');
    if (linha.length > MAX_LINHA_DO_NUNCA) return recusa(linha, `a linha tem mais de ${MAX_LINHA_DO_NUNCA} letras. Escreva UMA coisa curta por linha.`);
    // vírgula, ponto, ponto e vírgula, dois-pontos, travessão: ponto dentro de número («1.500») não conta
    if (/[,;:!?]|\.(?!\d)|\s[-–—]\s/.test(lida)) return recusa(linha, 'tem vírgula, ponto ou outro corte: são duas ideias. Escreva UMA coisa curta por linha, sem vírgula nem ponto.');
    if (/^\s*sempre\b/i.test(lida)) return recusa(linha, 'começa com «sempre», que é o contrário de uma proibição. Escreva só o que a assistente NUNCA faz.');
    if (/\b(?:nao|nunca|jamais)\b/i.test(lida)) return recusa(linha, 'tem «não», «nunca» ou «jamais». O título já diz «NUNCA»: uma segunda negação viraria o contrário. Escreva direto o que não deve ser feito, por exemplo «dar desconto».');
    if (EXCECAO_NA_PROIBICAO.test(lida)) return recusa(linha, 'tem uma exceção (como «exceto», «mas», «se o paciente…», «quando…»). Escreva só o que a assistente NUNCA faz, sem exceção: exceção é decisão da rede e do João.');
    if (DUPLA_NEGACAO.test(lida.replace(/^\s*evit\w+\s+/i, ''))) return recusa(linha, 'tem uma negação dentro da proibição («negar», «recusar», «evitar», «deixar de»…), e isso viraria o contrário. Escreva direto o que não deve ser feito, por exemplo «dar desconto».');
    // «e»/«ou» só liga coisas do mesmo assunto («política e religião»), nunca uma nova ordem («…e dar desconto»)
    for (const m of linha.matchAll(/\s(?:e|ou)\s+(\p{L}+)/gu)) {
      if (VERBO_OU_ORDEM.test(m[1]!)) return recusa(linha, `tem uma segunda ordem depois de «e»/«ou» (${m[1]}). Escreva UMA coisa por linha.`);
    }
    if (/(?:^|\s)d[êÊ](?:\s|$)/.test(linha)) return recusa(linha, 'tem uma ordem («dê…»). Escreva só o que a assistente NUNCA faz.');
  }
  const licao = `${TITULO_DO_NUNCA}\n${linhas.map((l) => `- "${l.replace(/"/g, "'")}"`).join('\n')}`;
  return { ok: true, licao };
}
export const licaoDeChamarPessoa = (t: string) => `Chame também uma pessoa da equipe quando: ${t.trim()}`;
export const LICAO_SEM_EMOJI = 'Não use emojis nas mensagens.';
export const LICAO_POUCO_EMOJI = 'Use emojis com muita moderação: no máximo um a cada poucas mensagens.';
