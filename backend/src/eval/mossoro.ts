/**
 * Prova de fogo da unidade nova: Mossoró, criada em 17/09/2026.
 *
 * Mossoró nasceu CLONADA de Marabá. A primeira rodada já deixou passar o
 * WhatsApp, o Instagram, o horário de sábado e a política de reserva de Marabá
 * dentro do prompt dela — coisas que trocar o nome da cidade não conserta.
 * Corrigi à mão; isto aqui é o que prova que ficou corrigido.
 *
 * Cada caso é um dado da ficha que a clínica respondeu, e a pergunta é sempre a
 * mesma: a IA fala de Mossoró, ou ainda fala de Marabá?
 *
 * Roda sem executar ferramenta nenhuma e com um Kommo de mentira — ver o
 * cabeçalho de `runner.ts`. Nada é escrito no CRM nem na franquia.
 */
import type { Caso } from './banco.js';

const U = 'doutor-hernia-mossoro';

export const CASOS_MOSSORO: Caso[] = [
  {
    id: 'mossoro-preco',
    titulo: 'Preço: R$ 200 antecipado / R$ 220 no dia (Marabá é 200/350)',
    unidade: U,
    porque:
      'A fonte foi clonada de Marabá, que cobra R$ 350 no dia. Se sobrou 350 em ' +
      'algum canto do texto, o paciente de Mossoró ouve um preço que não existe.',
    historico: [
      { de: 'paciente', texto: 'Oi, tô com dor na lombar há uns dois meses' },
      { de: 'sofia', texto: 'Oi! 🌷 Sinto muito. Como posso te chamar?' },
      { de: 'paciente', texto: 'Rafael. Quanto custa a consulta?' },
    ],
    espera: {
      // Ela NÃO diz o preço aqui de propósito: a regra da unidade manda entender
      // a queixa antes de falar em dinheiro. O que este caso protege é o que ela
      // NÃO pode dizer — R$ 350 é o preço de Marabá e não existe em Mossoró.
      naoContem: ['350'],
      precoDoCatalogo: true,
      semDadoDeOutraUnidade: true,
      naoDesiste: true,
    },
  },
  {
    id: 'mossoro-pix',
    titulo: 'Chave Pix: o CNPJ de Mossoró, não o de Marabá',
    unidade: U,
    porque:
      'Em Rio Verde, 6 pacientes pagaram na conta errada por 12 dias. A chave de ' +
      'Mossoró foi conferida contra o print do banco: 56.267.421/0001-38.',
    historico: [
      { de: 'paciente', texto: 'Quero pagar adiantado, me passa o Pix' },
    ],
    espera: {
      contem: ['56.267.421'],
      naoContem: ['55.990.941'],
      semDadoDeOutraUnidade: true,
    },
  },
  {
    id: 'mossoro-endereco',
    titulo: 'Endereço: Nova Betânia, em Mossoró',
    unidade: U,
    porque: 'A Serra já mandou "[Endereço da Clínica]" literal. Aqui o endereço existe — tem que sair certo.',
    historico: [
      { de: 'paciente', texto: 'Onde fica a clínica de vocês?' },
    ],
    espera: {
      contemAlgum: ['Raimundo Leao de Moura', 'Raimundo Leão de Moura'],
      naoContem: ['Marab'],
      semDadoDeOutraUnidade: true,
    },
  },
  {
    id: 'mossoro-sabado',
    titulo: 'Sábado: Mossoró NÃO atende (Marabá atende 08-12)',
    unidade: U,
    porque:
      'O texto clonado dizia "sábado das 08:00 às 12:00", que é a realidade de ' +
      'Marabá. Prometer sábado faz o paciente aparecer na porta fechada.',
    historico: [
      { de: 'paciente', texto: 'Vocês atendem no sábado? só consigo ir sábado' },
    ],
    espera: {
      naoContem: ['08:00 às 12:00'],
      naoTransfere: true,
      naoDesiste: true,
    },
  },
  {
    id: 'mossoro-convenio',
    titulo: 'Convênio: responde particular sem empurrar pra equipe',
    unidade: U,
    porque:
      'A ficha diz que não aceita convênio e que emite recibo pra reembolso. ' +
      'Ela já sabe a resposta — "vou confirmar com a equipe" aqui é venda perdida.',
    historico: [
      { de: 'paciente', texto: 'Vocês atendem pelo meu plano? tenho Hapvida' },
    ],
    espera: {
      naoTransfere: true,
      naoDesiste: true,
      semDadoDeOutraUnidade: true,
    },
  },
  {
    id: 'mossoro-fora-de-escopo',
    titulo: 'Joelho: a clínica só trata coluna',
    unidade: U,
    porque: 'A ficha respondeu "o que não for coluna" como recusa. Marcar um joelho é desperdiçar a agenda.',
    historico: [
      { de: 'paciente', texto: 'Boa tarde, tô com uma dor forte no joelho direito, vocês tratam?' },
    ],
    espera: {
      naoDesiste: true,
      semRegraClinica: true,
    },
  },
];
