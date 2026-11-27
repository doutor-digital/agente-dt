/**
 * As frases das rodadas de revisão de 27/11 (1ª e 2ª reprovação do sênior) + as 28 da 3ª, com o tipo que um revisor humano daria.
 * Usadas pelo teste (modelo falso) e pela sonda `scripts/sonda-classificador-adiamento.ts` (modelo REAL, 3 rodadas por frase).
 */
import type { TipoDeFala } from './adiamento-propoe-dia.js';

export const OFERTA_DA_SONDA = 'A consulta é R$ 350. Tenho segunda às 8h ou terça às 14h. Qual fica melhor?';

export const DESPEDIDAS_COM_MOTIVO = [
  'Obrigada! Vou conversar com meu esposo e te retorno. Boa noite',
  'Muito obrigada pela atenção, vou ver com minha filha e qualquer coisa te chamo. Tchau',
  'Obrigado, só mês que vem. Tchau tchau',
  'ok, obrigada. Quando eu receber eu te chamo, até mais',
  'Vou falar com meu marido, obrigada, fica com Deus',
  'Vou conversar com meu esposo e te retorno. Boa noite 🙏',
  'Vou falar com meu marido e te aviso. Boa noite!! 😊',
  'Vou ver com meu marido e te falo, bjs',
  'Vou ver com meu marido e te falo. Beijos',
  'Vou falar com meu esposo, até amanhã',
  'vou falar com meu marido, até já',
  'só recebo dia 8, bom final de semana',
  'Vou falar com meu marido e te retorno. Tenha uma ótima noite',
  'vou conversar com minha esposa, grato',
  'vou falar com meu marido, obg',
  'Vou falar com meu marido. Amém, Deus abençoe 🙏',
  'Vou conversar com meu marido e te retorno, gratidão',
  'Vou falar com meu marido e retorno. Bom dia',
  'Só recebo dia 8. Abraço',
  'vou falar com meu esposo, boa noite e obrigada 🙏🏻',
  // 3ª rodada
  'vou falar com meu marido, bjo',
  'vou falar com meu marido, bjos',
  'vou ver com meu esposo e te falo, xau',
  'vou conversar com minha filha, até',
  'vou falar com meu marido, fui',
  'só recebo dia 8, falou',
  'vou ver com meu chefe, boa semana',
  'vou falar com meu marido, boa noite pra você',
  'vou falar com meu esposo, inté',
  'só recebo dia 10, bom domingo',
  'vou ver com meu marido, brigada',
];

/** Despedidas puras (sem adiamento): o pré-filtro já nem chama o modelo. */
export const DESPEDIDAS_PURAS = ['bjo', 'bjos', 'xau', 'até', 'fui', 'falou', 'boa semana', 'boa noite pra você', 'inté', 'bom domingo', '🙏', 'brigada', 'obrigada', 'tchau', 'valeu', 'bom dia', 'boa tarde', 'ok'];

export const RECUSAS = ['desisti', 'já resolvi com outro médico', 'não quero mais', 'não quero', 'não tenho interesse', 'já fechei com outra clínica', 'vou em outra clínica', 'já resolvi', 'vou fazer com outro médico'];
export const RECUSAS_COM_MOTIVO = ['não quero mais, vou ver com meu marido outra clínica', 'desisti, só recebo dia 10', 'já resolvi com outro médico, vou falar com meu marido'];

export const ESCOLHAS_DE_HORARIO = [
  'Pode ser segunda às 8h, só recebo dia 5 mas pago no dia',
  'segunda tá ótimo, só recebo dia 5 mas pago no dia',
  'Segunda de manhã, só recebo dia 5',
  'Dia 9 às 8 eu consigo, só recebo dia 8',
  'a de segunda serve, vou falar com meu marido',
  'Pode marcar terça, só recebo dia 5 mas pago no dia',
  'pode ser a das 14, só recebo dia 5',
  'terça às 14h, vou falar com meu marido só pra avisar',
  'fico com o das 8, depois que eu receber confirmo',
];

export const ADIAMENTOS_COM_MOTIVO = [
  'Só recebo dia 8',
  'vou falar com o meu marido',
  'vou conversar com a minha mãe',
  'depois que eu receber eu te falo',
  'não tenho condições agora, só mês que vem',
  'vou ver com meu esposo',
  'preciso falar com meu marido primeiro',
  'Vou consultar meu marido',
  'deixa eu falar com meu esposo',
  'vou esperar o pagamento',
  'quando cair o salário eu marco',
  'só depois do dia 10',
  'semana que vem eu vejo',
  'tô sem dinheiro agora, só dia 5',
  'esse mês tá apertado',
  'vou ver com meu esposo e te dou retorno',
  'Estou viajando',
  'vou viajar, volto dia 15',
  'vou ver com meu chefe se consigo sair',
  'esse mês estou de plantão, só no próximo',
];

export const ADIOU_SEM_MOTIVO = ['vou pensar', 'agora não', 'te aviso depois', 'depois eu vejo', 'vou ver e te falo'];

/** Falas comuns do paciente (nenhum sinal de adiamento): o pré-filtro não pode chamar o modelo para elas. */
export const FALAS_COMUNS = [
  'bom dia', 'boa tarde', 'boa noite', 'oi', 'olá', 'ok', 'sim', 'não', 'pode ser', 'quero marcar', 'quero marcar uma consulta', 'qual o endereço?',
  'quanto custa?', 'tem vaga amanhã?', 'tem horário hoje?', 'dói na lombar há 2 anos', 'sinto formigamento na perna', 'meu nome é Maria da Silva Souza',
  'meu cpf é 123.456.789-00', 'vocês atendem convênio?', 'aceita cartão?', 'qual o valor da consulta?', 'tenho hérnia de disco', 'fiz ressonância mês passado',
  'obrigada', 'obrigado', 'valeu', 'perfeito', 'combinado', 'beleza', 'ótimo', 'é na terça?', 'a clínica fica onde?', 'tem estacionamento?', 'moro em outra cidade',
  'minha dor é nas costas', 'trabalho o dia todo', 'sou aposentada', 'meu telefone é 99 99999-9999', 'pode me mandar o endereço', 'quanto tempo dura a consulta?',
  'preciso de atestado?', 'posso ir de manhã?', 'qual dia da semana vocês abrem?', 'sábado vocês atendem?', 'quero saber do tratamento', 'já tenho exame',
  'tenho dor há muito tempo', 'o médico atende?', 'é fisioterapeuta mesmo?', 'tem pix?', 'qual a chave?', 'ótima tarde', 'tudo bem?', 'tudo certo',
];

/** frase → tipo que um revisor humano daria (para a matriz de acerto). */
export function corpusRotulado(): Array<{ frase: string; esperado: TipoDeFala }> {
  const l = (xs: string[], t: TipoDeFala) => xs.map((frase) => ({ frase, esperado: t }));
  return [
    ...l(DESPEDIDAS_COM_MOTIVO, 'despedida'),
    ...l(DESPEDIDAS_PURAS, 'despedida'),
    ...l(RECUSAS, 'recusa'),
    ...l(RECUSAS_COM_MOTIVO, 'recusa'),
    ...l(ESCOLHAS_DE_HORARIO, 'escolheu_horario'),
    ...l(ADIAMENTOS_COM_MOTIVO, 'adiou_com_motivo'),
    ...l(ADIOU_SEM_MOTIVO, 'adiou_sem_motivo'),
  ];
}
