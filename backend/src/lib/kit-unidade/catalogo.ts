/**
 * O QUE O CRM PRECISA TER por trás de cada unidade, escrito UMA vez (kit de unidade, 14/11/2026). Não é a lista de tudo que existe no
 * Chatwoot de Parauapebas: é o mínimo que o CÓDIGO lê ou escreve (etiquetas e atributos da régua, da agenda, da Sofia e do funil) mais
 * o conjunto padrão de cada atendente (pastas, mensagens prontas). A conta do Chatwoot é UMA (conta 1) para todas as unidades:
 * etiqueta, atributo e automação são da CONTA e já existem desde Parauapebas — o script só confere e cria o que faltar (idempotente).
 * Caixa, time, atendentes, pastas e mensagens com endereço são DA UNIDADE.
 */

/** Etiquetas (labels) que o código lê ou escreve. Fonte: ETIQUETA_* de chatwoot-*.ts e as regras da régua/Sofia. */
export const ETIQUETAS_DO_CODIGO: readonly string[] = [
  'anuncio',
  'respondeu-pelo-celular',
  'falta-etapa',
  'historico',
  'esperando-humano',
  'ia-pausada',
  'sem-follow-up',
  'sem-resposta',
  'pendente-de-revisao',
  'pendencia-exame-avisado',
  'aderencia-meio',
  'pagou-antecipado',
  'quente',
  'remarcar',
  'alta',
  'urgente',
  'conferir-pagamento',
  'curriculo',
  'reclamacao',
];

/** Atributos de CONVERSA que a régua, a agenda e a Sofia leem/escrevem (chave do Chatwoot). */
export const ATRIBUTOS_DE_CONVERSA: readonly string[] = [
  'etapa',
  'etapa_tratamento',
  'funil',
  'qualificacao',
  'data_consulta',
  'hora_consulta',
  'situacao_consulta',
  'categoria_consulta',
  'pagamento_antecipado',
  'fechou_tratamento',
  'retomar_em',
  'motivo_espera',
  'motivo_nao_agendamento',
  'motivo_nao_fechamento',
  'proxima_sessao',
  'hora_sessao',
  'data_retorno',
  'data_alta',
  'vencimento',
  'valor_parcela',
  'compareceu_ultima_sessao',
  'deixou_avaliacao_google',
  'programa',
];

/** Atributos de CONTATO (a Sofia lê `interno` para não responder a equipe). */
export const ATRIBUTOS_DE_CONTATO: readonly string[] = ['interno'];

/** As pastas (filtros salvos) padrão de cada atendente — as mesmas 10 que Parauapebas tem (12/11/2026). Filtro: etapa/etiqueta da conversa. */
export const PASTAS_PADRAO: readonly string[] = [
  'Quentes',
  'Novos leads',
  'Esperando humano',
  'Urgentes',
  'Agendados',
  'Faltaram',
  'Compareceram (fechar tratamento)',
  'Ficou de ver depois',
  'Sem resposta',
  'Perdidos',
];

/** As automações da CONTA (Configurações → Automação), ids 1–8 de Parauapebas: só etiqueta/prioridade/nota, nunca mandam nada ao paciente. */
export const AUTOMACOES_DA_CONTA: readonly string[] = [
  'parar de receber → sem-follow-up + nota',
  'remarcar/desmarcar → remarcar + alta',
  'pagou/comprovante → conferir-pagamento + alta + nota',
  'dor forte/urgência → urgente',
  'currículo → curriculo + baixa + nota',
  'reclamação → reclamacao + urgente + nota',
  'quer falar com pessoa → alta + nota',
  'resolvida → tira a prioridade',
];

export interface MensagemPronta {
  /** atalho depois da barra: /<prefixo>-<codigo> */
  codigo: string;
  /** texto com marcadores {{unidade.*}} (os mesmos dos modelos) */
  texto: string;
}

/** Mensagens prontas da UNIDADE (levam endereço e mapa, por isso uma por unidade). */
export const MENSAGENS_PRONTAS: readonly MensagemPronta[] = [
  { codigo: 'endereco', texto: '📍 {{unidade.nome}}\n{{unidade.endereco}}\nComo chegar: {{unidade.mapa}}' },
  { codigo: 'chegada', texto: 'Para a sua consulta, chegue 15 minutos antes e leve um documento com foto.\n📍 {{unidade.endereco}}\nComo chegar: {{unidade.mapa}}' },
];

/** O que o `chatwoot_franquias` (Traefik) precisa para o subdomínio da unidade. */
export const DOMINIO_DOS_CRMS = 'doutordigitalconsultoria.com';
export const SERVICO_DO_PROXY = 'chatwoot_franquias';
