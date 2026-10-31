/**
 * A ficha de cada etapa do funil COMERCIAL, para a voz do Copiloto ensinar sem inventar.
 * Cópia do `dicionario.json` do widget (missão, o que preencher, para onde vai). É o cartão ANTIGO: quando as fichas vivas
 * da estrutura enxuta existirem, esta tabela sai e a voz passa a ler delas. Fonte: ~/Kommo-Integracao/_replicacao/widgets-dd.
 */
export interface FichaDaEtapa {
  missao: string;
  preencher: string[];
  proxima: string[];
}

export const FICHAS_DAS_ETAPAS: Record<string, FichaDaEtapa> = {
  "Incoming leads": { missao: "Lead acabou de chegar. Leia a conversa, salve o nome no título e mova pra EM QUALIFICAÇÃO.", preencher: ["⬢ Tipo de lead", "✎ Queixa", "★ Qualificação (Quente/Morno/Frio)"], proxima: ["EM QUALIFICAÇÃO"] },
  "EM QUALIFICAÇÃO": { missao: "Descubra a queixa, a região da dor e a urgência. Salve o nome no título e marque Quente, Morno ou Frio.", preencher: ["⬢ Tipo de lead", "✎ Queixa", "★ Qualificação (Quente/Morno/Frio)", "✎ Observações"], proxima: ["AGENDADO", "EM ESPERA"] },
  "EM ESPERA": { missao: "Quer, mas agora não pode. Preencha quando retomar e o motivo. Não é perdido.", preencher: ["◷ Retomar em", "⊘ Motivo da espera", "✎ Observações"], proxima: ["AGENDADO"] },
  "AGENDADO": { missao: "Consulta marcada. Confira data e hora, registre o pagamento antecipado e quem agendou.", preencher: ["⬢ Tipo de agendamento", "¤ Valor da Consulta", "¤ Pagamento antecipado", "Consulta pg no dia"], proxima: ["COMPARECEU", "NÃO COMPARECEU"] },
  "NÃO COMPARECEU": { missao: "Faltou à consulta. Registre o motivo e tente reagendar. Remarcou? Volta pra AGENDADO.", preencher: ["⊘ Motivo do no-show", "◷ Data do reagendamento", "# Nº de reagendamentos"], proxima: ["AGENDADO", "PERDIDO"] },
  "COMPARECEU": { missao: "Veio à consulta. Registre fisioterapeuta, tratamento indicado, semáforo e o que foi decidido.", preencher: ["⚕ Tratamento indicado", "◉ Semáforo", "✎ Contraindicação / bandeira vermelha", "◷ Data de retorno com exames", "★ Satisfação / NPS"], proxima: ["EM NEGOCIAÇÃO", "GANHO / CONCLUIDO"] },
  "EM NEGOCIAÇÃO": { missao: "Saiu avaliando. Registre o valor proposto e a negociação feita, e acompanhe de perto.", preencher: ["✎ Negociação feita", "¤ Desconto concedido", "⬢ Forma de pagamento", "# Nº de parcelas", "⊘ Motivo de não fechamento do tratamento"], proxima: ["GANHO / CONCLUIDO", "PERDIDO"] },
  "GANHO / CONCLUIDO": { missao: "Fechou o tratamento. Registre qual tratamento, valor, forma de pagamento e as datas.", preencher: ["⬢ Tipo de fechamento de tratamento", "◷ Data de fechamento", "⬢ Forma de pagamento", "# Nº de parcelas", "¤ Valor pago / entrada", "◷ Data do pagamento"], proxima: ["RETORNO PÓS-TRATAMENTO"] },
  "RETORNO PÓS-TRATAMENTO": { missao: "Paciente voltando depois do tratamento. Registre a nova consulta como um retorno.", preencher: [], proxima: [] },
  "PERDIDO": { missao: "Não vai vir. Registre o motivo do não agendamento. Se ele voltar a escrever, volta pra qualificação.", preencher: ["⊘ Motivo do não agendamento", "⊘ Motivo de não fechamento do tratamento"], proxima: ["EM QUALIFICAÇÃO"] },
  "EM TRATAMENTO": { missao: "Paciente em tratamento agora. A franquia preenche as sessões sozinha; você confere faltas e a data prevista de término.", preencher: ["◷ Data prevista de término"], proxima: [] },
  "ALTA": { missao: "Tratamento concluído. Confirme a data de alta, registre a satisfação e se autorizou depoimento.", preencher: ["★ Satisfação / NPS (Tratamento)", "◷ Data da pesquisa NPS", "✓ Deixou avaliação (Google)", "✓ Autorizou depoimento / vídeo", "# Indicações geradas"], proxima: [] },
  "TRATAMENTO CANCELADO": { missao: "Paciente parou o tratamento. Registre o motivo, a data e se há previsão de retorno.", preencher: ["◷ Data solicitação de cancelamento", "⊘ Motivo do cancelamento do tratamento", "✓ Cancelamento revertido", "◷ Data do cancelamento", "◷ Data de retorno"], proxima: [] },
};

const semAcento = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** "Etapa de leads de entrada" e "Incoming leads" são a mesma etapa. */
const chave = (nome: string): string => {
  const n = semAcento(nome);
  return /^(incomingleads|leadsdeentrada|etapadeleadsdeentrada|naoclassificad)/.test(n) ? 'incomingleads' : n;
};

export function fichaDaEtapa(nome: string | null | undefined): { nome: string; ficha: FichaDaEtapa } | null {
  if (!nome) return null;
  const alvo = chave(nome);
  for (const [k, ficha] of Object.entries(FICHAS_DAS_ETAPAS)) if (chave(k) === alvo) return { nome: k, ficha };
  return null;
}
