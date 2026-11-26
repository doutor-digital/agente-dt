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
  'formulario',
  'respondeu-pelo-celular',
  'falta-etapa',
  'historico',
  'esperando-humano',
  'ia-pausada',
  'sofia-atendendo',
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
  // etiquetas de FLUXO que a régua e a SDR automática leem (chatwoot-regua: ETIQUETAS_OBSERVADAS; chatwoot-gestor: frio/morno)
  'boas-vindas',
  'confirmar-retorno',
  'reativacao',
  'retomada',
  'frio',
  'morno',
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
  /** quem marcou a consulta (a tela do Gestor agrupa por ela) */
  'quem_agendou',
];

/** Atributos de CONTATO: a Sofia lê `interno` (não responder a equipe); `chatwoot-origem` grava `origem`/`campanha_nome`/`conjunto` e a tela do Gestor lê `campanha_codigo`. */
export const ATRIBUTOS_DE_CONTATO: readonly string[] = ['interno', 'origem', 'campanha_codigo', 'campanha_nome', 'conjunto'];

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

/**
 * As listas que o questionário pode TROCAR por conta (`chatwoot.listas`), e onde moram. Só estas: as outras listas (`etapa`, `etapa_tratamento`, `funil`, `situacao_consulta`,
 * `qualificacao`…) são lidas por nome no código (régua, guia, Hoje, agenda, Sofia) e não se trocam por questionário.
 */
export const LISTAS_EDITAVEIS: Readonly<Record<string, 'conversa' | 'contato'>> = {
  origem: 'contato',
  motivo_nao_agendamento: 'conversa',
  motivo_nao_fechamento: 'conversa',
  motivo_espera: 'conversa',
  categoria_consulta: 'conversa',
};

/** Valores que o CÓDIGO escreve ou lê por nome em cada lista editável: a lista nova PRECISA conservá-los (senão a régua ou o rastreio gravam um valor que a lista não mostra). */
export const VALORES_QUE_O_CODIGO_USA: Readonly<Record<string, readonly string[]>> = {
  origem: ['Meta Ads'],
  categoria_consulta: ['Avaliação', 'Sessão', 'Retorno', 'Retorno com exames', 'Retorno após tratamento'],
  motivo_espera: ['Exames', 'Viajando', 'Vai decidir', 'Financeiro agora não'],
  // a régua cobra o documento de quem ficou em «Solicitado exames» (chatwoot-regua: pendencia-documento)
  motivo_nao_fechamento: ['Solicitado exames'],
};
