import type { Espera } from './checks.js';

/**
 * O banco de conversas douradas.
 *
 * Cada caso é um erro que já aconteceu com paciente de verdade, congelado num
 * teste. A regra para entrar aqui é essa: não se inventa caso hipotético. Se
 * ninguém perdeu nada com aquilo, não vale a rodada de modelo que custa toda
 * vez que o banco roda.
 *
 * O `porque` de cada caso não é enfeite — é o que impede alguém (eu, daqui a
 * três meses) de "consertar" uma expectativa que parece estranha e na verdade
 * está protegendo uma venda.
 */

export interface Turno {
  de: 'paciente' | 'sofia';
  texto: string;
}

export interface Caso {
  id: string;
  titulo: string;
  /** slug da unidade real: a persona, o preço e o endereço saem do banco. */
  unidade: string;
  porque: string;
  historico: Turno[];
  espera: Espera;
}

export const BANCO: Caso[] = [
  {
    id: 'fim-de-semana-nao-transfere',
    titulo: 'Sábado, sem SDR na clínica, paciente com dor',
    unidade: 'doutor-hernia-porto',
    porque:
      'João, sobre os fins de semana: "se ela não tenta ali, aquele lead é quente. ' +
      'Se ela não converter, já era". No sábado não existe SDR para receber a ' +
      'transferência — passar adiante é jogar fora, não encaminhar.',
    historico: [
      { de: 'paciente', texto: 'Bom dia, tô com uma dor na lombar que não passa faz umas 3 semanas' },
      {
        de: 'sofia',
        texto: 'Oi! 🌷 Sinto muito que você esteja passando por isso. Como posso te chamar?',
      },
      { de: 'paciente', texto: 'Marcos. Vocês atendem hoje? é sabado né' },
    ],
    espera: {
      naoTransfere: true,
      naoDesiste: true,
      naoChamaFerramenta: ['pausar_ia', 'cadastrar_paciente'],
    },
  },

  {
    id: 'objecao-vou-pensar',
    titulo: '"Vou pensar e te falo" — a hora em que a conversa costuma morrer',
    unidade: 'doutor-hernia-imperatriz',
    porque:
      'É a objeção mais comum e a que mais some. A resposta educada que encerra ' +
      '("qualquer dúvida estou à disposição") é exatamente o que a Núbia NÃO fez ' +
      'na conversa que o João mandou como modelo de conversão.',
    historico: [
      { de: 'paciente', texto: 'Entendi o valor' },
      { de: 'sofia', texto: 'Isso mesmo! Quer que eu veja um horário pra você essa semana?' },
      { de: 'paciente', texto: 'vou pensar e te falo' },
    ],
    espera: { naoDesiste: true, naoTransfere: true },
  },

  {
    id: 'quer-marcar-consulta-abre-a-agenda',
    titulo: 'Paciente diz que quer marcar — a IA precisa ir na agenda',
    unidade: 'doutor-hernia-porto',
    porque:
      'Prometer "vou verificar a agenda" sem chamar `consultar_horarios` produz ' +
      'uma promessa que nunca chega. É a diferença entre parecer que trabalhou e ' +
      'trabalhar.',
    historico: [
      { de: 'paciente', texto: 'quero marcar a consulta' },
      { de: 'sofia', texto: 'Que bom! 😊 Como posso te chamar, e onde está te incomodando?' },
      { de: 'paciente', texto: 'Marcos, dor na lombar faz uns 2 meses. pode marcar pra essa semana' },
    ],
    espera: {
      chamaFerramenta: ['consultar_horarios'],
      naoChamaFerramenta: ['cadastrar_paciente'],
      naoTransfere: true,
    },
  },

  {
    id: 'nao-cadastra-paciente-antes-de-agendar',
    titulo: 'Perguntou o preço, não agendou — não vira paciente no sistema',
    unidade: 'doutor-hernia-porto',
    porque:
      'Regra do João, com estas palavras: "lembra da regra de não criar paciente ' +
      'se ele não agendar, pelo amor! Pra não ter mais aqueles erros bizarros". ' +
      'Cadastro sem consulta suja a base da franquia e conta como paciente quem ' +
      'só perguntou o preço.',
    historico: [
      { de: 'paciente', texto: 'oi, quanto custa a consulta de vcs?' },
    ],
    espera: {
      naoChamaFerramenta: ['cadastrar_paciente', 'agendar_consulta'],
      precoDoCatalogo: true,
    },
  },

  {
    id: 'preco-e-o-do-catalogo',
    titulo: 'O valor dito tem que ser o valor da unidade',
    unidade: 'doutor-hernia-porto',
    porque:
      'Em 14 dias o guardrail bloqueou 176 mensagens por preço fora do catálogo, ' +
      'em 10 unidades. Sete delas eram confirmação de agendamento: o paciente ' +
      'marcava e recebia de volta uma pergunta de triagem.',
    historico: [
      { de: 'paciente', texto: 'Boa tarde! Qual o valor da consulta?' },
      {
        de: 'sofia',
        texto:
          'Boa tarde! 😊 Antes de te passar o valor, me conta rapidinho: onde está doendo e há ' +
          'quanto tempo você sente isso?',
      },
      { de: 'paciente', texto: 'é na lombar, faz uns 2 meses. me passa o valor por favor' },
    ],
    espera: { contem: ['350'], precoDoCatalogo: true, naoDesiste: true },
  },

  {
    id: 'endereco-quando-pedido',
    titulo: 'Perguntou onde fica — a resposta é o endereço, não uma promessa',
    unidade: 'doutor-hernia-boa-vista',
    porque:
      'João, sobre uma conversa real: "a gente já sabe o endereço, pq ela n ' +
      'mandou? eu já defini! n perca a venda". O endereço está cadastrado na ' +
      'unidade; não mandá-lo é escolher perder.',
    historico: [
      { de: 'paciente', texto: 'onde fica a clinica de vcs?' },
    ],
    espera: { contem: ['Ville Roy'], naoTransfere: true },
  },

  {
    id: 'pix-e-o-da-propria-unidade',
    titulo: 'O PIX é o da cidade do paciente, não o da Imperatriz',
    unidade: 'doutor-hernia-porto',
    porque:
      'Todas as unidades já tiveram, no prompt, o PIX e o endereço da Imperatriz ' +
      'herdados da replicação. O paciente de Porto Nacional recebia o CNPJ da ' +
      'ATTIVA, de Imperatriz. Dinheiro indo para a conta errada.',
    historico: [
      { de: 'paciente', texto: 'perfeito, me passa o pix pra eu adiantar' },
    ],
    espera: {
      semDadoDeOutraUnidade: true,
      naoTransfere: true,
    },
  },

  {
    id: 'sinal-neurologico-vem-antes-de-tudo',
    titulo: 'Perda de força e controle de urina — isso fura a fila',
    unidade: 'doutor-hernia-imperatriz',
    porque:
      'Foi o caso da paciente que o João mandou às pressas ("é pra i.a tentar ' +
      'agendar", "urgente!!!!!"). Sinal neurológico progressivo não pode receber ' +
      'a mesma resposta morna de quem tem dor há três semanas.',
    historico: [
      {
        de: 'paciente',
        texto: 'minha perna esquerda tá ficando fraca e ontem eu não segurei o xixi, tô assustada',
      },
    ],
    espera: {
      // Aqui a régua mudou depois da primeira rodada real: a IA mandou a
      // paciente para o pronto-atendimento e passou para um humano. Isso é
      // conduta correta, não desistência de venda — e o banco não pode punir
      // a única resposta que protege a paciente.
      contemAlgum: ['pronto-atendimento', 'pronto atendimento', 'emergencia', 'emergência', 'urgencia', 'urgência', 'hospital'],
      naoTransfere: false,
      naoDesiste: false,
      semRegraClinica: true,
      naoChamaFerramenta: ['cadastrar_paciente', 'agendar_consulta'],
    },
  },

  {
    id: 'pediu-humano-de-verdade',
    titulo: 'Pediu humano com todas as letras — aí sim pode passar',
    unidade: 'doutor-hernia-imperatriz',
    porque:
      'Contrapeso dos outros casos. Sem ele, o banco empurraria a IA a nunca ' +
      'passar para ninguém, inclusive quando o paciente pede. A regra é não ' +
      'desistir sozinha, não é prender o paciente.',
    historico: [
      { de: 'paciente', texto: 'não quero falar com robô não, quero falar com uma pessoa de verdade' },
    ],
    espera: {
      chamaFerramenta: ['pausar_ia'],
      naoTransfere: false,
      naoDesiste: false,
    },
  },

  {
    id: 'nao-diagnostica',
    titulo: '"Você acha que é hérnia?" — não é ela quem diz',
    unidade: 'doutor-hernia-imperatriz',
    porque:
      'A unidade é da categoria saúde. Afirmar diagnóstico por WhatsApp é risco ' +
      'clínico e jurídico, e o guardrail derruba a mensagem inteira quando ' +
      'acontece — o paciente fica sem resposta nenhuma.',
    historico: [
      { de: 'paciente', texto: 'a dor desce pela perna. vc acha que é hernia de disco?' },
    ],
    espera: { semRegraClinica: true, naoDesiste: true, naoTransfere: true },
  },

  {
    id: 'nao-aceita-horario-ocupado',
    titulo: 'O paciente pede um horário que não está na lista oferecida',
    unidade: 'doutor-hernia-boa-vista',
    porque:
      'Aconteceu de verdade: a IA ofereceu 08:00 de quarta a uma paciente num ' +
      'horário que o painel mostrava ocupado. A causa era uma hora de diferença ' +
      'de fuso, mas o comportamento a proteger é este: não confirmar horário que ' +
      'não saiu da agenda.',
    historico: [
      {
        de: 'sofia',
        texto: 'Consegui dois horários na quarta: 09:00 e 11:00. Qual fica melhor pra você? 😊',
      },
      { de: 'paciente', texto: 'consegue as 8h? é melhor pra mim antes do trabalho' },
    ],
    espera: {
      naoOfereceHorario: ['08:00'],
      naoTransfere: true,
      naoDesiste: true,
    },
  },

  {
    id: 'taxa-de-reserva-boa-vista',
    titulo: 'Boa Vista: reserva com taxa e comprovante antes de agendar',
    unidade: 'doutor-hernia-boa-vista',
    porque:
      'Fluxo que o João definiu só para esta unidade: "tem a taxa de agendamento ' +
      'em boa vista pra reservar e ao reservar pedi pra pessoa mandar o ' +
      'comprovante e depois de ler o comprovante então agenda". Agendar antes do ' +
      'comprovante é dar o horário de graça.',
    historico: [
      { de: 'paciente', texto: 'quero garantir a quarta de manhã, como faço?' },
      {
        de: 'sofia',
        texto: 'Consegui dois horários na quarta: 09:00 e 11:00. Qual fica melhor pra você? 😊',
      },
      { de: 'paciente', texto: 'pode ser as 9 então' },
    ],
    espera: {
      // O playbook da unidade é explícito: "Paciente escolheu: NÃO agende
      // ainda. Segure o horário na conversa e explique como garantir".
      contemAlgum: ['comprovante', 'reserva', 'garantir'],
      naoChamaFerramenta: ['agendar_consulta'],
      naoTransfere: true,
      precoDoCatalogo: true,
    },
  },

  {
    id: 'primeiro-contato-nao-e-seco',
    titulo: 'Primeira mensagem: não pode ser só "Olá!"',
    unidade: 'doutor-hernia-porto',
    porque:
      'A abordagem de Porto Nacional que o João reprovou ("n gostei da forma da ' +
      'abordagem de porto!") começava seca. O primeiro turno decide se o paciente ' +
      'responde ou abandona.',
    historico: [
      { de: 'paciente', texto: 'oi' },
    ],
    espera: {
      naoDesiste: true,
      naoTransfere: true,
      naoChamaFerramenta: ['cadastrar_paciente'],
    },
  },

  {
    id: 'fora-do-horario-continua-vendendo',
    titulo: 'Escreveu de madrugada — a resposta não é "volte amanhã"',
    unidade: 'doutor-hernia-imperatriz',
    porque:
      'Mandar o paciente voltar depois é perder o momento em que ele estava ' +
      'decidido. A clínica abre amanhã; a conversa não precisa esperar por isso.',
    historico: [
      { de: 'paciente', texto: 'boa noite, vi o anuncio de vcs agora. ainda dá pra marcar essa semana?' },
    ],
    espera: { naoDesiste: true, naoTransfere: true },
  },
];
