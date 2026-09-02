export interface Degrau {
  aposMin: number;
  intencao: string;
  /** Degrau sobre pagamento: não sai para quem já pagou o antecipado. */
  pularSePagou?: boolean;
}

export interface Preset {
  statusId: number;
  statusName: string;
  lossReasonId: number | null;
  lossReasonName: string | null;
  notes: string;
  steps: Degrau[];
}

export const ETAPAS = {
  QUALIFICACAO: 108773004,
  AGENDADO: 108773008,
  COMPARECEU: 108773012,
  NEGOCIACAO: 108773016,
  PERDIDO: 143,
} as const;

export const MOTIVOS_INTOCAVEIS: Array<{ id: number; nome: string; porque: string }> = [
  { id: 37797692, nome: 'Sem condições financeiras', porque: 'já disse que não pode pagar — insistir constrange' },
  { id: 37797684, nome: 'Financeiramente vulnerável', porque: 'mesma razão, e aqui a exposição é maior' },
  { id: 37797664, nome: 'Bandeira vermelha', porque: 'risco clínico — precisa de gente, não de automação' },
  { id: 37797716, nome: 'Sem interesse', porque: 'é um não claro; insistir vira bloqueio no WhatsApp' },
  { id: 37797708, nome: 'Clicou por engano', porque: 'nunca foi um lead' },
  { id: 37797700, nome: 'Informação para terceiro', porque: 'quem decide não é quem está na conversa' },
  { id: 37797680, nome: 'Assinou contrato', porque: 'já converteu' },
  { id: 37797652, nome: 'Caso enviado para a franquia', porque: 'saiu da nossa alçada' },
  { id: 37797660, nome: 'Mora em outra cidade', porque: 'não é objeção, é impossibilidade' },
  { id: 37797688, nome: 'Outra cidade', porque: 'mesma razão' },
];

export const PRESETS: Preset[] = [
  {
    statusId: ETAPAS.QUALIFICACAO,
    statusName: 'EM QUALIFICAÇÃO',
    lossReasonId: null,
    lossReasonName: null,
    notes: 'Conversou e parou antes de marcar. O objetivo é voltar ao horário.',
    steps: [
      {
        aposMin: 5,
        intencao:
          'Toque leve, uma linha, como quem continua a mesma conversa. NÃO recomece ' +
          'nem se reapresente. Retome exatamente onde parou e devolva a pergunta que ' +
          'ficou no ar. Se você tinha oferecido horários, ofereça os mesmos de novo.',
      },
      {
        aposMin: 30,
        intencao:
          'Ele pode ter se distraído. Retome pelo lado DELE — a queixa que contou — e ' +
          'facilite a resposta: pergunta fechada, de escolher entre duas opções.',
      },
      {
        aposMin: 120,
        intencao:
          'Traga valor, não cobrança. Um esclarecimento curto sobre o que acontece na ' +
          'consulta e o que a especialista avalia. Termine oferecendo horário, sem pressa.',
      },
      {
        aposMin: 360,
        intencao:
          'Último toque com oferta ativa. Reconheça o tempo que passou sem cobrar ' +
          '("imagino que a correria apertou") e ofereça verificar os horários.',
      },
      {
        aposMin: 1200,
        intencao:
          'Encerramento educado, SEM pedir resposta. Deixe claro que ele pode chamar ' +
          'quando quiser e que a porta fica aberta.',
      },
    ],
  },

  {
    statusId: ETAPAS.AGENDADO,
    statusName: 'AGENDADO',
    lossReasonId: null,
    lossReasonName: null,
    notes:
      'Marcou mas não pagou o antecipado. Vale dinheiro direto: R$ 150 garantido ' +
      'contra R$ 350 que talvez não venha, e quem paga antes falta menos.',
    steps: [
      {
        aposMin: 5,
        pularSePagou: true,
        intencao:
          'Ele acabou de marcar e ainda não pagou. Uma mensagem curta, animada, ' +
          'de quem quer garantir a vaga dele — não de quem cobra. Diga que as vagas ' +
          'são concorridas e que o horário só fica reservado com o pagamento ' +
          'antecipado; peça o COMPROVANTE para você travar a reserva agora. ' +
          'Ofereça reenviar a chave Pix junto. NUNCA invente quantas vagas restam ' +
          'nem prazo que ninguém definiu. NÃO repita o endereço nem o resumo do ' +
          'agendamento — isso ele acabou de receber.',
      },
      {
        aposMin: 240,
        pularSePagou: true,
        intencao:
          'Lembre da condição de PAGAMENTO ANTECIPADO como vantagem dele, não como ' +
          'cobrança — e diga com todas as letras que é pagar ANTES do dia, nunca ' +
          '"à vista", que o paciente entende como pagar no balcão. Use os valores ' +
          'das Fontes Oficiais da SUA unidade. Pergunte se ficou alguma dúvida.',
      },
      {
        aposMin: 1200,
        intencao:
          'Reforce dia, hora e que ele deve chegar 15 minutos antes. Sem pedir resposta ' +
          'e sem falar de pagamento de novo — quem não pagou até aqui paga na hora.',
      },
    ],
  },

  {
    statusId: ETAPAS.PERDIDO,
    statusName: 'PERDIDO',
    lossReasonId: 37797672,
    lossReasonName: 'Achou caro',
    notes: 'Objeção de preço. Reancorar no custo de não tratar, nunca dar desconto.',
    steps: [
      {
        aposMin: 120,
        intencao:
          'NÃO defenda o preço e NÃO dê desconto. Pergunte, com genuíno interesse, quanto ' +
          'ele já gastou tentando resolver por conta — pomada, remédio, sessão avulsa. ' +
          'Deixe ele fazer a conta. Termine oferecendo o antecipado de R$ 150.',
      },
      {
        aposMin: 1200,
        intencao:
          'Um último toque leve: diga que se ele quiser retomar depois a porta fica ' +
          'aberta, e que a consulta é onde se descobre a causa. NÃO peça resposta.',
      },
    ],
  },
  {
    statusId: ETAPAS.PERDIDO,
    statusName: 'PERDIDO',
    lossReasonId: 37797676,
    lossReasonName: 'Vai se organizar financeiramente',
    notes:
      'Não é um não — é um "ainda não". Aqui só se mantém a porta aberta; cobrar ' +
      'quem está se organizando empurra pro lado de quem não pode pagar.',
    steps: [
      {
        aposMin: 1200,
        intencao:
          'Uma mensagem só, curta e sem cobrança. Diga que entende, que a vaga existe ' +
          'quando ele puder, e que é só chamar. NÃO ofereça horário nem fale de valor.',
      },
    ],
  },
  {
    statusId: ETAPAS.PERDIDO,
    statusName: 'PERDIDO',
    lossReasonId: 37797656,
    lossReasonName: 'Decidir com a família',
    notes: 'A decisão é de casa. O papel aqui é facilitar, não disputar.',
    steps: [
      {
        aposMin: 180,
        intencao:
          'Ofereça mandar por escrito o que ele precisa pra conversar em casa: o que a ' +
          'consulta avalia, quanto custa, quanto dura. Facilite a conversa dele com a ' +
          'família em vez de disputar com ela.',
      },
      {
        aposMin: 1200,
        intencao:
          'Pergunte, sem pressa, se conseguiram conversar — e ofereça segurar um horário ' +
          'se decidirem seguir.',
      },
    ],
  },
  {
    statusId: ETAPAS.PERDIDO,
    statusName: 'PERDIDO',
    lossReasonId: 37797648,
    lossReasonName: 'Solicitado exames',
    notes: 'Está esperando exame. O gancho é o próprio exame.',
    steps: [
      {
        aposMin: 1200,
        intencao:
          'Diga que quando os exames ficarem prontos a especialista os analisa na consulta, ' +
          'e ofereça já deixar um horário reservado pra depois da data prevista.',
      },
    ],
  },
  {
    statusId: ETAPAS.PERDIDO,
    statusName: 'PERDIDO',
    lossReasonId: 37797696,
    lossReasonName: 'Não interagiu',
    notes: 'Nunca respondeu. Uma tentativa só, curta — mais que isso é insistência com quem nunca falou.',
    steps: [
      {
        aposMin: 240,
        intencao:
          'Uma linha, leve, sem cobrar o silêncio. Pergunte de forma simples se ele ainda ' +
          'sente a dor que o trouxe até aqui. Pergunta fechada, fácil de responder.',
      },
    ],
  },
];

export function ehIntocavel(lossReasonId: number | null | undefined): boolean {
  if (lossReasonId == null) return false;
  return MOTIVOS_INTOCAVEIS.some((m) => m.id === lossReasonId);
}
