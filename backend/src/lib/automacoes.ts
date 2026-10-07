/**
 * O CATÁLOGO das automações que ligam e desligam por unidade.
 *
 * Por que isto existe (pedido do João, 28/09/2026): "tem coisas que eu nem sei que funcionam na
 * prática, aí eu fico perdido". Cada automação abaixo era só uma variável de ambiente num `.env`
 * dentro da VPS — para saber se a Serra tinha o worker de parados ligado era preciso abrir o Docker.
 * Ninguém lembra de 24 variáveis, e o que ninguém lembra ninguém opera.
 *
 * Este arquivo é a única lista. Quem escreve uma automação nova por slug ENTRA AQUI, senão ela
 * volta a ser invisível. O `verificarCatalogo()` no fim existe pra isso doer no teste, não em
 * produção.
 *
 * COMO O ESTADO É RESOLVIDO (ver `flags.ts`): o banco manda; sem linha no banco, vale a variável de
 * ambiente de sempre. Então enquanto ninguém mexer na tela, o comportamento é byte a byte o de
 * hoje — a migração não liga nem desliga nada sozinha.
 */

/** O que a automação faz de pior, quando erra. É isso que decide se a tela pede confirmação. */
export type Risco =
  /** Move cartão de etapa sozinho — o erro aparece no funil e no relatório. */
  | 'move-cartao'
  /** Manda mensagem pro paciente ou pro time — o erro sai do CRM e chega em gente. */
  | 'manda-mensagem'
  /** Escreve campo do cartão — o erro é dado errado, corrigível. */
  | 'escreve-campo'
  /** Só muda como a IA se comporta ou quanto custa — não move nem escreve nada. */
  | 'comportamento';

export interface Automacao {
  /** Identidade estável, usada na API e no banco. Nunca mude depois de criada. */
  id: string;
  /** A variável de ambiente que ligava isto antes — é o que está no `.env` da VPS hoje. */
  chave: string;
  /** Nome curto, como o João chamaria. */
  nome: string;
  /** Uma frase: o que acontece quando está ligada. Sem jargão. */
  oQueFaz: string;
  /** O detalhe que só se descobre apanhando — o que a tela mostra quando ele abre a linha. */
  pegadinha?: string;
  risco: Risco;
  /** Tem modo seco (decide e registra no log, mas não toca no Kommo). */
  temSeco: boolean;
  /**
   * O que vale quando a variável de ambiente está VAZIA. Quase tudo é `desligado`, mas duas
   * automações nasceram ligadas pra todo mundo — e isso é exatamente o tipo de coisa que ninguém
   * lembra. `seco` = nasce em "só no papel" pra rede toda: a variável lista quem está LIGADO e quem
   * não está nela fica no papel (desligar, só pela tela). Só faz sentido com `temSeco`.
   */
  quandoVazio: 'desligado' | 'todas' | 'seco';
  /** Onde a regra mora, pra quem for ler o código depois. */
  arquivo: string;
}

export const AUTOMACOES: readonly Automacao[] = [
  // ── movem cartão ────────────────────────────────────────────────────────────────────────────
  {
    id: 'parados',
    chave: 'PARADOS_SLUGS',
    nome: 'Worker de parados',
    oQueFaz:
      'De hora em hora, fecha por prazo o que ninguém tocou: EM ESPERA parado há 30 dias e EM NEGOCIAÇÃO há 45 vão pra PERDIDO; NÃO COMPARECEU há 7 dias sem remarcar vai pra EM ESPERA; régua de mensagens esgotada sem resposta vai pra PERDIDO.',
    pegadinha:
      'Antes de perder alguém ele confere a franquia na hora — consulta futura ou tratamento em andamento seguram o cartão. Move no máximo 10 por regra por varredura, pra o estoque antigo entrar aos poucos em vez de numa rajada.',
    risco: 'move-cartao',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/parados-worker.ts',
  },
  {
    id: 'volta-espera',
    chave: 'VOLTA_ESPERA_SLUGS',
    nome: 'Volta de EM ESPERA',
    oQueFaz:
      'Paciente que está em EM ESPERA e volta a escrever de verdade tem o cartão devolvido pra EM QUALIFICAÇÃO na hora, com a retomada automática cancelada e uma nota explicando.',
    pegadinha:
      'Não varre etapa nenhuma: só acorda quando chega mensagem. É a rede pra SDR que estaciona cartão cedo demais. Ignora "ok, obrigado" — só conta mensagem real.',
    risco: 'move-cartao',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/parados-worker.ts',
  },
  {
    id: 'franquia-move',
    chave: 'FRANQUIA_MOVE_SLUGS',
    nome: 'A franquia move a etapa',
    oQueFaz:
      'O que acontece na franquia manda o cartão andar sozinho: marcou vira AGENDADO, foi atendido vira COMPARECEU, começou as sessões vai pra EM TRATAMENTO. Ninguém arrasta cartão na mão.',
    pegadinha:
      'A franquia nunca escreve atendido, valor nem alta por conta própria — esses três continuam vindo da tela. E a máquina se recusa a declarar falta ou perda a partir da etapa de entrada: esse cartão é da Sofia, que pode estar no meio de uma conversa. Mover dispara os bots da etapa de destino: ligue em seco primeiro e leia no log (franquia-move [seco]: moveria) e no resumo da varredura (simulados) quantos cartões iriam pra onde.',
    risco: 'move-cartao',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/franquia-move.ts',
  },
  {
    id: 'franquia-revisao',
    chave: 'FRANQUIA_REVISAO_SLUGS',
    nome: 'Revisão dos agendados velhos',
    oQueFaz:
      'Revê os cartões parados em AGENDADO com consulta mais antiga que D-3, buscando no histórico do paciente o que de fato aconteceu — compareceu, faltou ou desmarcou — e corrige a etapa.',
    pegadinha:
      'É a varredura que alcança o que a janela de 48 dias do sincronizador deixou pra trás. Tem modo seco próprio pra provar em produção antes de mover.',
    risco: 'move-cartao',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/franquia-sync-worker.ts',
  },

  // NOTA: o worker de aderência ("paciente sumindo do tratamento") ainda não está commitado — mora
  // solto na árvore do João em 28/09/2026. A entrada dele foi tirada daqui de propósito: um botão
  // que não liga nada é exatamente a confusão que esta tela existe pra acabar. Quando o worker
  // subir, a entrada volta (o texto está no corpo do PR que criou este arquivo).

  // ── mandam mensagem ─────────────────────────────────────────────────────────────────────────
  {
    id: 'follow-up-24h',
    chave: 'FOLLOW_UP_24H_SLUGS',
    nome: 'Follow-up de 24h',
    oQueFaz: 'Reengaja quem parou de responder, seguindo a régua configurada por etapa do funil.',
    risco: 'manda-mensagem',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/follow-up-worker.ts',
  },
  {
    id: 'confirmacao-d2',
    chave: 'CONFIRMACAO_D2_SLUGS',
    nome: 'Reforço de confirmação (D-2)',
    oQueFaz: 'Manda um segundo toque de confirmação dois dias antes da consulta, além do da véspera.',
    pegadinha:
      'A confirmação de véspera tem chave por consulta desde a v1.139.0 pra não repetir. 15 das 16 unidades não têm bot de lembrete no Kommo — sem ele, quem confirma é isto aqui.',
    risco: 'manda-mensagem',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/reminder-worker.ts',
  },
  {
    id: 'aviso-agendamento',
    chave: 'AVISO_AGENDAMENTO_SLUGS',
    nome: 'Aviso no WhatsApp quando a IA marca',
    oQueFaz: 'Avisa no WhatsApp do João, no instante, toda vez que a IA marca uma consulta — e pra quando.',
    pegadinha:
      'É por unidade de propósito. Ligar na rede toda vira metralhadora: são dezenas de agendamentos por dia somando as unidades. Vale nos primeiros dias de uma unidade nova.',
    risco: 'manda-mensagem',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/aviso-de-agendamento.ts',
  },
  {
    id: 'prometeu-sem-marcar',
    chave: 'PROMETEU_SEM_MARCAR_SLUGS',
    nome: 'Alerta: a IA disse que marcou e não marcou',
    oQueFaz:
      'Quando a IA diz ao paciente que a consulta está marcada, reservada ou confirmada ("fica reservado sexta às 9h", "te espero amanhã às 8h") e a consulta não existe — nem no rastro da IA, nem no cartão (◷ Data da Consulta), nem na franquia pelo telefone —, abre uma tarefa ALERTA no cartão pra SDR ligar e marcar.',
    pegadinha:
      'Nasce em "só no papel" na rede toda: a lista "o que faria" mostra "alertaria" (a IA prometeu e não há consulta) e "confere" (prometeu e a consulta existe), sem criar tarefa. Só confere depois que a conversa fica 10 min parada — se o paciente responde e a IA marca, não avisa. Um alerta por cartão a cada 24 h. Pergunta, oferta e condição ("quer que eu reserve?", "se quiser, deixo reservado", "o Pix garante seu horário reservado") não contam. Medido em 30 dias (set–out/2026): ~640 afirmações, ~280 sem agendamento da IA, ~200 cartões; conferindo cartão e franquia, cerca de metade some (era a recepção que tinha marcado, ou é paciente em tratamento falando da sessão).',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'seco',
    arquivo: 'src/lib/prometeu-sem-marcar-worker.ts',
  },
  {
    id: 'etiquetas-auto',
    chave: 'ETIQUETAS_AUTO_SLUGS',
    nome: 'Etiquetas ▶ automáticas',
    oQueFaz:
      'Põe sozinho as etiquetas que a SDR punha à mão: ▶ Boas-vindas quando o cartão entra em GANHO, ▶ Confirmar retorno 24 h antes do retorno (RETORNO PÓS-TRATAMENTO) e ▶ Reativação depois de 30 dias em PERDIDO sem conversa. A etiqueta aciona o bot do Kommo, que manda a mensagem.',
    pegadinha:
      'Só funciona se a etiqueta tiver gatilho no Kommo daquela unidade. Não põe se o modelo for sair com buraco (programa, próxima sessão ou responsável vazios — cada regra deixa de olhar esses campos quando a unidade tem a `_v2` do modelo dela aprovada: `…sdr_reativacao_lead_frio_v2` ("a equipe Doutor Digital"), `…sdr_boas_vindas_programa_v2` (sem programa nem data) e `…sdr_confirmacao_retorno_v2` (mostra a ◷ Data da Consulta); quem cria a v2 troca o modelo do bot no mesmo passo) nem pra quem pediu pra não receber — em "só no papel" isso aparece como "pularia" com o motivo. A Reativação só pega quem cruza os 30 dias agora: o estoque antigo de PERDIDO nunca entra de uma vez. A ▶ Retomada não está aqui: depende do robô da 3C. Pra testar num cartão só: ligue e ponha os ids em pipelineIntents.etiquetas_teste_leads — o resto segue no papel.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/etiquetas-auto-worker.ts',
  },
  {
    id: 'chat-botoes',
    chave: 'CHAT_BOTOES_SLUGS',
    nome: 'Resposta com botões',
    oQueFaz: 'Deixa a IA responder com botões clicáveis no chat do Kommo, em vez de só texto.',
    pegadinha:
      'Nasce LIGADA pra todas as unidades. Só vale no caminho padrão — no modo widget a resposta precisa fechar o bot pelo return_url. Qualquer falha cai em texto, que já traz as opções escritas.',
    risco: 'manda-mensagem',
    temSeco: false,
    quandoVazio: 'todas',
    arquivo: 'src/lib/resposta-com-botoes.ts',
  },

  // ── escrevem campo ──────────────────────────────────────────────────────────────────────────
  {
    id: 'franquia-sync',
    chave: 'FRANQUIA_SYNC_SLUGS',
    nome: 'Sincronizador da franquia',
    oQueFaz:
      'A cada 15 minutos copia da franquia pro cartão o que aconteceu: data da consulta, situação, fisioterapeuta, sessões, faltas, tratamento, dados da pessoa.',
    pegadinha:
      'Só enxerga a janela de D-3 a D+45, de propósito — ele roda 96 vezes por dia e alargar seria reler um passado que não muda. Por isso o histórico antigo nunca entra sozinho.',
    risco: 'escreve-campo',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/franquia-sync-worker.ts',
  },
  {
    id: 'preenche-campos',
    chave: 'PREENCHE_CAMPOS_SLUGS',
    nome: 'Preenche o que a IA deixou vazio',
    oQueFaz:
      'Depois da conversa, sem gastar token de IA, preenche os campos que ficaram em branco lendo o que já foi dito.',
    pegadinha:
      'Existe porque mandar mais instrução no prompt não resolveu: a Serra manda "OBRIGATÓRIO deduza pelo nome" e entrega 21% de Sexo preenchido. Onde o número parece bom, é a recepção preenchendo na mão porque o Kommo trava a etapa.',
    risco: 'escreve-campo',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/preenche-campos-worker.ts',
  },
  {
    id: 'franquia-sessoes',
    chave: 'FRANQUIA_SESSOES_SLUGS',
    nome: 'Sessões e tratamento no cartão',
    oQueFaz:
      'Atualiza no cartão, a cada varredura, as sessões realizadas, faltas, marcadas e previstas, a próxima e a última sessão, e o local, grau, status e id do tratamento da franquia.',
    pegadinha:
      'Sobrescreve o que está no cartão: a franquia vence. Só funciona onde o campo existe com o tipo certo (número, data, texto); campo de outro tipo é pulado. Ligue em seco primeiro e confira no log o que gravaria.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/franquia-sync-worker.ts',
  },
  {
    id: 'franquia-tela',
    chave: 'FRANQUIA_TELA_SLUGS',
    nome: 'Dados do atendimento da franquia no cartão',
    oQueFaz:
      'Lê a tela de edição do atendimento na franquia e copia pro cartão a forma de pagamento, a data do retorno (Retomar em) e o motivo para não realizar o tratamento. A SDR digita uma vez, só na franquia.',
    pegadinha:
      'A API da franquia não devolve esses campos, então o robô entra na TELA com o login FRANQUIA_TELA_USER/FRANQUIA_TELA_PASS (se a tela mudar ou a senha vencer, ele para e avisa no log). Só lê; nunca grava na franquia. A franquia vence quando tem valor, e vazia nunca apaga o cartão. Precisa dos campos novos no Kommo (forma de pagamento com as 20 opções da franquia e o texto do motivo). Ligue em seco primeiro.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/franquia-sync-worker.ts',
  },
  {
    id: 'campos-sdr',
    chave: 'CAMPOS_SDR_SLUGS',
    nome: 'Campos que a SDR preenchia (teste)',
    oQueFaz:
      'Calcula Tipo de lead (Resgate = já estava na base; Cadastro = novo), Responsável agendamento (quem marcou na franquia, ou a Sofia) e Data de solicitação de cancelamento (desistência na franquia). Grava só em campo vazio.',
    pegadinha:
      'Em seco não grava nada: registra no log o que gravaria e, onde a SDR já preencheu, se o calculado CONFERE ou DIVERGE — é o teste antes de aprovar. O responsável só é conhecido enquanto a avaliação está AGENDADO (depois a recepção dá baixa e a franquia troca o nome). "Transferido de outra unidade" continua manual.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/campos-sdr.ts',
  },
  {
    id: 'campos-sdr-tipos',
    chave: 'CAMPOS_SDR_TIPOS_SLUGS',
    nome: 'Tipo de agendamento e de fechamento = Tipo de lead',
    oQueFaz:
      'Copia o ⬢ Tipo de lead do cartão para o ⬢ Tipo de agendamento (quando há consulta) e o ⬢ Tipo de fechamento de tratamento (quando há tratamento fechado). Grava só em campo vazio. Feito para a SDR não preencher mais esses dois.',
    pegadinha:
      'O Tipo de lead que a SDR pôs vence o calculado. "Transferido de outra unidade" não existe nessas listas e não é copiado. O dashboard ainda lê o Tipo de agendamento (quebra dos Agendados e nota de qualidade) — por isso copiar em vez de só esconder.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/campos-sdr.ts',
  },
  {
    id: 'unidade-por-canal',
    chave: 'UNIDADE_POR_CANAL_SLUGS',
    nome: 'Unidade pelo número de WhatsApp',
    oQueFaz:
      'Para conta com dois números (Petrópolis e Caxias no mesmo Kommo): pelo número em que o paciente escreveu primeiro, marca o ⌂ Unidade de atendimento e a etiqueta da cidade. Grava só em campo vazio.',
    pegadinha:
      'Vale a PRIMEIRA conversa do cartão. Se a SDR corrigir o campo, a correção fica e a etiqueta passa a seguir o campo. Número novo conectado na conta não decide nada até entrar no mapa do código (aparece aviso no log).',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/unidade-por-canal.ts',
  },
  {
    id: 'sugestao-motivo',
    chave: 'SUGESTAO_MOTIVO_SLUGS',
    nome: 'IA sugere o motivo do não agendamento (widget)',
    oQueFaz:
      'No widget do cartão, o botão "Sugerir motivo" lê a conversa oficial (com áudio transcrito) e sugere o ⊘ Motivo do não agendamento. A SDR confirma com "Usar" ou escolhe outro.',
    pegadinha:
      'Só gasta IA no clique. Nunca grava sozinha. Medido contra o gabarito do João: ~70% de acerto (SDR 90%) — por isso é sugestão. Cada uso registra sugerido × escolhido no log (sugestao-motivo: usada).',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/sugestao-motivo.ts',
  },
  {
    id: 'carimbo-etapa',
    chave: 'CARIMBO_ETAPA_SLUGS',
    nome: 'Carimbo de início e fim do tratamento',
    oQueFaz: 'Quando o cartão muda de etapa, carimba as datas de início e fim do tratamento e encerra a conversa.',
    risco: 'escreve-campo',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/carimbo-etapa.ts',
  },
  {
    id: 'titulo-padrao',
    chave: 'TITULO_PADRAO_SLUGS',
    nome: 'Título padrão pro lead sem nome',
    oQueFaz:
      'Lead que chega sem nome vira "Lead dd/mm/aaaa" na primeira mensagem — e "Lead 2 dd/mm/aaaa" se for o segundo do dia.',
    risco: 'escreve-campo',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/titulo-padrao.ts',
  },
  {
    id: 'captura-unificada',
    chave: 'CAPTURA_UNIFICADA_SLUGS',
    nome: 'Captura unificada de campos',
    oQueFaz:
      'Troca as ~30 ferramentas `registra_*` da IA por uma só, `registrar_campo`, com a lista de campos na descrição.',
    pegadinha:
      'É economia, não comportamento: corta ~11 mil tokens do prefixo que vai em TODA chamada — cerca de 25% do custo. O "quando preencher" de cada campo continua lá, uma linha por campo em vez de um schema inteiro.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/captura-unificada.ts',
  },

  // ── mudam o comportamento ou o custo ────────────────────────────────────────────────────────
  {
    id: 'teto-mensal',
    chave: 'TETO_MENSAL_SLUGS',
    nome: 'Teto mensal de custo da IA',
    oQueFaz: 'A IA para de responder quando o gasto do mês estoura o teto da unidade, e quem escreve fica com a equipe.',
    pegadinha:
      'Nasce LIGADA pra rede toda — a variável vazia significa "vale pra todas", ao contrário de quase todas as outras. O alvo do chefe é ficar em até R$ 300 por clínica no mês.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'todas',
    arquivo: 'src/agent/teto-mensal.ts',
  },
  {
    id: 'sofia-calada',
    chave: 'SOFIA_CALADA_SLUGS',
    nome: 'Sofia calada em GANHO, ALTA e CANCELADO',
    oQueFaz: 'Nessas três etapas a IA não responde o paciente — só deixa nota no cartão pro time ler.',
    pegadinha: 'PERDIDO e EM ESPERA continuam governados pela lista de permissão, porque lá quem trabalha é a IA de resgate.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/sofia-calada.ts',
  },
  {
    id: 'preco-convenio',
    chave: 'PRECO_CONVENIO_SLUGS',
    nome: 'Trava do preço de convênio',
    oQueFaz: 'Impede a IA de anunciar o valor de convênio como se fosse o preço da consulta particular.',
    pegadinha:
      'Nasce LIGADA em Bebedouro e Olímpia, mesmo sem ninguém configurar. Existe porque o valor da carteirinha estava vazando como preço do Pix.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/preco-convenio.ts',
  },
  {
    id: 'sem-carinha',
    chave: 'SEM_CARINHA_SLUGS',
    nome: 'Sem a carinha ☺',
    oQueFaz: 'Para de trocar 😊 e 😢 pelos glifos antigos ☺ e ☹ na hora de mandar a mensagem.',
    pegadinha:
      'A troca existia porque o banco do Kommo cortava emoji de 4 bytes. O remédio ficou pior que a doença: ☺ é um glifo preto e branco dos anos 90 e nenhum ser humano digita aquilo no meio de uma conversa.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/carinha-antiga.ts',
  },
  {
    id: 'cartao-enxuto',
    chave: 'CARTAO_ENXUTO_SLUGS',
    nome: 'Cartão enxuto (vigia)',
    oQueFaz: 'O vigia diário do cartão passa a cobrar só o que continua sendo preenchido por gente, e ignora o que a franquia já traz.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/parados.ts',
  },
  {
    id: 'prompt-da-unidade',
    chave: 'PROMPT_DA_UNIDADE_SLUGS',
    nome: 'Prompt próprio da unidade',
    oQueFaz: 'A unidade usa o prompt escrito só pra ela, em vez do prompt padrão montado pela rede.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/prompt-composer.ts',
  },
  {
    id: 'cache-conversa',
    chave: 'ANTHROPIC_CONVO_CACHE_SLUGS',
    nome: 'Cache da conversa na Anthropic',
    oQueFaz: 'Guarda o histórico da conversa no cache da Anthropic, pra não pagar o texto inteiro de novo a cada mensagem.',
    pegadinha: 'É economia pura. O prefixo de ~43 mil tokens é o que domina a conta da IA.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/graph.ts',
  },
  {
    id: 'meta-inbound',
    chave: 'META_INBOUND_SLUGS',
    nome: 'Entrada direto pela Meta',
    oQueFaz: 'A mensagem do paciente entra pelo WhatsApp Cloud API da Meta em vez de passar pelo Kommo.',
    pegadinha: 'Hoje não está montado em unidade nenhuma. O caminho que roda na rede toda é o do Kommo.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/canal-de-entrada.ts',
  },
] as const;

const PORCHAVE = new Map(AUTOMACOES.map((a) => [a.chave, a]));
const PORID = new Map(AUTOMACOES.map((a) => [a.id, a]));

export function automacaoPorId(id: string): Automacao | undefined {
  return PORID.get(id);
}
export function automacaoPorChave(chave: string): Automacao | undefined {
  return PORCHAVE.get(chave);
}

/**
 * Ids e chaves são identidade: duplicata faria a tela escrever no lugar errado, e um id trocado
 * depois de gravado no banco perderia o estado sem avisar. Roda no teste, não em produção.
 */
export function verificarCatalogo(lista: readonly Automacao[] = AUTOMACOES): string[] {
  const problemas: string[] = [];
  const ids = new Set<string>();
  const chaves = new Set<string>();
  for (const a of lista) {
    if (ids.has(a.id)) problemas.push(`id repetido: ${a.id}`);
    if (chaves.has(a.chave)) problemas.push(`chave repetida: ${a.chave}`);
    ids.add(a.id);
    chaves.add(a.chave);
    if (!/^[a-z0-9-]+$/.test(a.id)) problemas.push(`id fora do formato kebab: ${a.id}`);
    if (!/^[A-Z0-9_]+$/.test(a.chave)) problemas.push(`chave não parece variável de ambiente: ${a.chave}`);
    if (!a.oQueFaz.trim()) problemas.push(`${a.id} sem descrição`);
    if (a.quandoVazio === 'seco' && !a.temSeco) problemas.push(`${a.id} nasce em seco mas não tem modo seco`);
  }
  return problemas;
}
