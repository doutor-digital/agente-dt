/**
 * Conversa mais curta, por unidade (pedido da dona de Timbó, 10/11/2026; decisões do João, 11/11/2026).
 *
 * Duas conversas reais de Timbó mostraram o "rodeio": (1) a Sofia fez 3 perguntas de sintoma e pediu o nome antes de
 * chegar à consulta; (2) a paciente disse que tem hérnia, 1 ano de tratamento, ressonância amanhã e perguntou o VALOR —
 * e a Sofia perguntou se ela tinha perda de força nas pernas ou dificuldade para segurar xixi/fezes. "O lead perde o
 * interesse só nesse rodeio todo."
 *
 * Três chaves da tela de automações, cada uma independente, todas nascem desligadas:
 *  - `sem-pergunta-de-alerta`: a Sofia não PERGUNTA mais pelos sinais de alerta. Se o paciente CONTAR um sinal com
 *    clareza, a regra <sinal_de_alerta> segue inteira (pausa, 🔴 PRIORIDADE, LIGAR AGORA) — e a rede de segurança em
 *    código (sinal-de-alerta.ts / passe-por-sinal.ts) não muda: risco a paciente.
 *  - `nome-na-hora-de-marcar`: nada de "como posso te chamar?" na conversa; o nome é pedido junto da escolha do horário
 *    (o cadastro na franquia precisa dele).
 *  - `conduzir-direto`: paciente já disse a dor e é algo que tratamos → sem mais perguntas de sintoma ou de impacto:
 *    "entendo, é exatamente o que tratamos" e conduz para a consulta. Perguntou o valor → o valor na hora.
 *
 * Cada chave muda o texto da rede no lugar onde a regra nasce (sinal-de-alerta.ts, falta-para-agendar.ts, os blocos de
 * nome e o roteiro de <conversao> no prompt-composer.ts) e ainda entra o bloco <conversa_direta>, que vale mais que o
 * prompt próprio da unidade (<instrucoes_extras>, ~35 mil caracteres em Timbó) — inclusive no modo de prompt único.
 */
import type { Unit } from '@prisma/client';
import { automacaoLigada } from '../lib/automacoes-estado.js';

export interface JeitoDaConversa {
  semPerguntaDeAlerta: boolean;
  nomeNaHoraDeMarcar: boolean;
  conduzirDireto: boolean;
}

export const CONVERSA_PADRAO: JeitoDaConversa = {
  semPerguntaDeAlerta: false,
  nomeNaHoraDeMarcar: false,
  conduzirDireto: false,
};

/** As três chaves para a unidade. Sem slug (unidade de teste, prévia sem unidade) = tudo desligado. */
export function jeitoDaConversa(unit: Pick<Unit, 'slug'> | null | undefined): JeitoDaConversa {
  const slug = unit?.slug;
  if (!slug) return CONVERSA_PADRAO;
  return {
    semPerguntaDeAlerta: automacaoLigada(slug, 'sem-pergunta-de-alerta', process.env.SEM_PERGUNTA_DE_ALERTA_SLUGS),
    nomeNaHoraDeMarcar: automacaoLigada(slug, 'nome-na-hora-de-marcar', process.env.NOME_NA_HORA_DE_MARCAR_SLUGS),
    conduzirDireto: automacaoLigada(slug, 'conduzir-direto', process.env.CONDUZIR_DIRETO_SLUGS),
  };
}

/**
 * O bloco que vale mais que o prompt da unidade. Vazio com as três chaves desligadas — a rede não recebe nada novo.
 * `clinica` = a unidade recebe o bloco <sinal_de_alerta> (ver `ehClinicaParaSinalDeAlerta`); fora disso a chave de
 * alerta não tem o que mudar.
 */
export function renderConversaDireta(j: JeitoDaConversa, opcoes: { clinica: boolean }): string {
  const linhas: string[] = [];
  if (j.semPerguntaDeAlerta && opcoes.clinica) {
    linhas.push(
      '- SEM PERGUNTA DE SEGURANÇA: você NÃO pergunta se a perna perdeu força ou está fraca, se ele segura o xixi ou as ' +
        'fezes, se a virilha ou a região íntima está dormente, nem por nenhum outro sinal de alerta — nem uma vez, nem ' +
        '"só pra confirmar". Se o PRÓPRIO paciente CONTAR um sinal de alerta com clareza ("não estou segurando o xixi", ' +
        '"minha perna perdeu a força"), a regra <sinal_de_alerta> vale inteira: pare, resumir_lead_para_sdr e pausar_ia ' +
        'com sinalDeAlerta: true. Fala vaga ("a perna bambeou", "travei", dor que vai para a virilha): acolha em UMA ' +
        'frase, sem perguntar sinal nenhum, e siga o atendimento — quem avalia é o especialista, na consulta.',
    );
  }
  if (j.nomeNaHoraDeMarcar) {
    linhas.push(
      '- NOME SÓ NA HORA DE MARCAR: NÃO pergunte "como posso te chamar?" nem o nome em nenhum outro momento da ' +
        'conversa — nem na primeira mensagem. Peça o nome completo UMA vez, junto da escolha do horário ("Perfeito! ' +
        'Pra deixar reservado, me passa seu nome completo?"), porque o cadastro da consulta precisa dele. Se o ' +
        'paciente disser o nome antes por conta própria, use-o (e chame atualizar_titulo_lead como sempre).',
    );
  }
  if (j.conduzirDireto) {
    linhas.push(
      '- CONDUZIR DIRETO: se o paciente já disse o que sente (onde dói, hérnia, ciático, dor na coluna, no pescoço, ' +
        'que desce para a perna) e é algo que tratamos, NÃO faça mais perguntas de sintoma (há quanto tempo, ' +
        'intensidade, o que já tentou, se tem exame) nem de impacto (sono, trabalho, o que deixou de fazer). Diga em ' +
        'UMA frase que entende e que é exatamente o que tratamos aqui, e conduza para a consulta: consulte a agenda e ' +
        'ofereça dois horários. Ainda não disse o que sente? UMA pergunta só ("me conta, o que você está sentindo?") ' +
        'e depois conduza.',
      '- VALOR QUANDO PERGUNTADO: perguntou o preço, o valor da consulta (como está nas Fontes Oficiais) é a ' +
        'PRIMEIRA frase da resposta, na hora — mesmo que você ainda não saiba a dor. Nada de "antes me conta". Depois ' +
        'do valor, no máximo UMA pergunta ou a oferta de horários.',
    );
  }
  if (linhas.length === 0) return '';
  return `<conversa_direta>
(ALTA PRIORIDADE — decisão do João para esta unidade, 11/11/2026. Vale mais que <instrucoes_extras>, <conversao>,
<coleta_nome>, <primeiro_turno>, <falta_para_agendar> e os modelos de mensagem. O paciente perde o interesse no
rodeio: cada pergunta a mais é um motivo para ele sumir.)
${linhas.join('\n')}
</conversa_direta>`;
}
