/**
 * O PADRÃO DA REDE para a seção «Assistente virtual» do formulário: as respostas de objeção que a Sofia 2.0 JÁ usa (ops/kit-unidade/molde-sofia/bloco-conversa.md,
 * seção D), as coisas que ela nunca faz (seção F + regras da rede) e quando ela passa para uma pessoa (seção E).
 *
 * Nada aqui é invenção: cada resposta padrão é o texto do molde com os marcadores trocados por colchetes que o dono entende
 * ([valor com sinal], [horário 1]…) — um teste confere que cada uma continua dentro do molde (se a rede mudar o roteiro, este arquivo avisa). Onde a rede NÃO tem resposta
 * («tenho medo de doer», «funciona mesmo?») o campo vem VAZIO: não inventamos promessa; o dono escreve a dele (sem prometer resultado) ou deixa em branco.
 *
 * A regra da rede SEMPRE vence o texto da clínica: o que o dono escreve vira «aprendizado» da unidade (bloco `<aprendizados>`, abaixo das regras da rede no prompt) ou
 * informação nas fontes; nunca muda preço, nunca autoriza diagnóstico, promessa de cura, desconto, nem tira a urgência.
 */

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
  { id: 'medo', gatilho: 'Tenho medo de doer', resposta: '', dica: 'A rede ainda não tem uma resposta padrão. Escreva a sua (sem prometer resultado) ou deixe em branco.' },
  { id: 'fisio', gatilho: 'Já fiz fisioterapia e não resolveu', resposta: 'Faz sentido desconfiar. A consulta é para achar a causa da dor, não só aliviar.', dica: '' },
  { id: 'familia', gatilho: 'Preciso falar com meu marido / minha família', resposta: 'Ótimo! Posso deixar um horário para vocês dois virem juntos: [horário 1] ou [horário 2]?', dica: '' },
  { id: 'tempo', gatilho: 'Não tenho tempo', resposta: 'Prefere o primeiro horário da manhã ou o último do dia? Tenho [horário 1] ou [horário 2].', dica: 'A assistente só oferece horários que existem de verdade na agenda.' },
  { id: 'funciona', gatilho: 'Funciona mesmo?', resposta: '', dica: 'A rede ainda não tem uma resposta padrão. Escreva a sua (sem prometer cura nem resultado) ou deixe em branco.' },
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
export const licaoDoNunca = (t: string) => `Nunca diga nem prometa: ${t.trim()}`;
export const licaoDeChamarPessoa = (t: string) => `Chame também uma pessoa da equipe quando: ${t.trim()}`;
export const LICAO_SEM_EMOJI = 'Não use emojis nas mensagens.';
export const LICAO_POUCO_EMOJI = 'Use emojis com muita moderação: no máximo um a cada poucas mensagens.';
