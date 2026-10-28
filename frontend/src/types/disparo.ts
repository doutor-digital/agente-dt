/**
 * Disparo de campanha (modelo da Meta).
 * Contrato final de GET /api/disparo/ondas/:id/resultado (PR #153, backend/src/lib/disparo/resultado-dados.ts).
 * Regra: número que não deu para medir vem `null` (nunca zero), e `fontes.notas.*` diz o motivo ou a ressalva.
 */
export type DisparoFonte =
  | 'meta-template-analytics'
  | 'meta-pricing-analytics'
  | 'kommo'
  | 'franquia'
  | 'indisponivel';

export interface DisparoResultado {
  ok?: boolean;
  onda: {
    id: string;
    /** montando | montada | aprovada | pausada | concluida | cancelada */
    estado: string;
    /** slug da unidade (para chave); para exibir use `unidadeNome` */
    unidade: string;
    unidadeNome: string;
    /** slug da campanha; para exibir use `campanhaNome` */
    campanha: string;
    campanhaNome: string;
    etiqueta: string | null;
    /** ISO */
    aprovadaEm: string | null;
    aprovadaPor: string | null;
    pausaMotivo: string | null;
  };
  funil: {
    /** = enviados + falhas + pendentes + descartados */
    selecionados: number;
    /** quem recebeu a mensagem (inclui quem depois pediu SAIR) */
    enviados: number;
    falhas: number;
    pendentes: number;
    /** pediu SAIR depois de receber: é parte de `enviados` */
    saiu: number;
    /** barrado antes do envio (inclui quem pediu SAIR antes de receber) */
    descartados: number;
    /** null = não deu para medir (nunca zero) */
    entregues: number | null;
    lidas: number | null;
    responderam: number | null;
    agendaram: number | null;
  };
  custo: {
    usd: number | null;
    brl: number | null;
    /** em reais; null sem câmbio ou sem divisor */
    porResposta: number | null;
    porAgendamento: number | null;
    atualizadoEm: string | null;
  };
  /** hora cheia em UTC (ISO); a tela converte para São Paulo */
  porHora: Array<{ hora: string; enviados: number }>;
  freios: {
    /** texto pronto: "9h às 18h, segunda a sexta, sem feriado nacional" */
    janela: string;
    tetoPorHora: number;
    tetoPorDia: number;
    maxSair: number;
    enviadosUltimaHora: number;
    enviadosUltimas24h: number;
  };
  fontes: {
    entregues: Extract<DisparoFonte, 'meta-template-analytics' | 'indisponivel'>;
    custo: Extract<DisparoFonte, 'meta-pricing-analytics' | 'indisponivel'>;
    responderam: Extract<DisparoFonte, 'kommo' | 'indisponivel'>;
    agendaram: Extract<DisparoFonte, 'franquia' | 'indisponivel'>;
    /** quando a Meta atualizou pela última vez entregues/lidas */
    entreguesAtualizadoEm: string | null;
    /** quando Kommo, franquia, câmbio e Meta foram lidos pela última vez */
    atualizadoEm: string;
    /** por que um número ficou null, ou a ressalva de um que veio ("limite inferior"); null = sem ressalva */
    notas: {
      entregues: string | null;
      custo: string | null;
      responderam: string | null;
      agendaram: string | null;
    };
  };
  atualizadoEm: string;
}

/** Item da lista GET /api/disparo/ondas (para escolher qual onda mostrar). */
export interface DisparoOndaResumo {
  id: string;
  campanha: string;
  unidade: string;
  etiqueta: string | null;
  estado: string;
  total: number;
  criadoEm: string;
  motivo: string | null;
}

/**
 * Uma pessoa da onda, como vem em `destinatarios` de GET /api/disparo/ondas/:id.
 * O telefone chega mascarado e a tela NÃO o mostra.
 */
export interface DisparoPessoa {
  nome: string;
  /** pendente | enviando | enviado | falhou | descartado | saiu */
  estado: string;
  motivo: string | null;
  enviadoEm: string | null;
  kommoLeadId: number | null;
}
