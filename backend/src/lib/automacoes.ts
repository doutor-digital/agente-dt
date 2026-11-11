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
 *
 * FORA DESTE CATÁLOGO, DE PROPÓSITO: o que é da rede inteira e não de uma unidade. Cada entrada aqui vira uma
 * linha por unidade na tela (lista de slugs), então "ligar o resumo de qualidade na Serra" não faria sentido.
 * Hoje há duas: `RESUMO_DIARIO_IA=seco|ligado|desligado` (resumo diário da Sofia no Telegram do João,
 * `resumo-diario-ia-worker.ts`; vazio = seco, que só registra o texto no log) e `SUPORTE_MENU=desligado|seco|ligado`
 * (menu de suporte da equipe no WhatsApp, `suporte-menu.ts`; vazio = desligado; seco não envia nem grava nada).
 */

/** O que a automação faz de pior, quando erra. É isso que decide se a tela pede confirmação. */
export type Risco =
  /** Move cartão de etapa sozinho — o erro aparece no funil e no relatório. */
  | 'move-cartao'
  /** Manda mensagem pro paciente ou pro time — o erro sai do CRM e chega em gente. */
  | 'manda-mensagem'
  /** Escreve campo do cartão — o erro é dado errado, corrigível. */
  | 'escreve-campo'
  /** Cria/conclui TAREFA no Kommo (calendário) — nunca toca em campo nem em etapa; o erro é tarefa a mais ou a menos, corrigível. */
  | 'cria-tarefa'
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
   * Segunda variável de ambiente, a lista de quem ESCREVE: na lista de `chave` e fora desta = "só no papel"; nas duas = ligado.
   * Só o calendário tem (`FRANQUIA_CALENDARIO_APLICAR`). Sem ela, a tela mostraria "ligado" para quem está em seco.
   */
  chaveAplicar?: string;
  /** A tela só deixa passar para "ligado" quem JÁ está em "só no papel": a 1ª carga de uma automação grande precisa de um seco conferido. */
  exigeSecoAntes?: boolean;
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
      'Não varre etapa nenhuma: só acorda quando chega mensagem. É a rede pra SDR que estaciona cartão cedo demais. Ignora "ok, obrigado" — só conta mensagem real. Cartão com ◷ Retomar em pra frente fica em EM ESPERA (a SDR decidiu esperar; a Sofia conversa do mesmo jeito); no dia da retomada, a resposta traz o cartão de volta como sempre.',
    risco: 'move-cartao',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/parados-worker.ts',
  },
  {
    id: 'parados-estoques',
    chave: 'PARADOS_ESTOQUES_SLUGS',
    nome: 'Parados: o que nenhuma regra alcançava',
    oQueFaz:
      'Estende o worker de parados aos cartões que ficavam esquecidos (auditoria da Açailândia, 16/10): NÃO COMPARECEU com situação Desmarcado ou vazia, ou sem paciente achado na franquia, segue a jornada pela data da consulta (até 30 dias vai pra EM ESPERA, depois PERDIDO "desmarcou ou faltou e não remarcou"); AGENDADO com consulta vencida há mais de 30 dias (ou sem consulta) e RETORNO PÓS-TRATAMENTO sem retorno marcado há 30 dias vão pra PERDIDO; entrada e EM QUALIFICAÇÃO sem ninguém escrever nem mexer há 90 dias vão pra PERDIDO "não interagiu"; EM TRATAMENTO sem nenhum dado de sessão entra na fila da página /alta pra recepção decidir.',
    pegadinha:
      'Ligar começa a escoar o estoque que já existe (no teto de sempre: 10 por regra por varredura, de hora em hora) — por isso nasce desligada e a primeira passada deve ser "Só no papel". Só roda onde o worker de parados está ligado ou no papel. PERDIDO por fato velho (mais de 90 dias), sem data, de RETORNO PÓS e de lead dormente leva NO_FOLLOW_UP: a régua de PERDIDO não manda nada. Nada sai de EM TRATAMENTO sozinho (o gatilho da ALTA não tem condição): vai pra fila da /alta. ◷ Retomar em pra frente, consulta futura no cartão ou na franquia e tratamento em andamento seguram o cartão. Com esta chave ligada, o NÃO COMPARECEU inteiro passa a seguir a jornada (falta com mais de 30 dias vai direto pra PERDIDO, não pra EM ESPERA).',
    risco: 'move-cartao',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/parados-estoques.ts',
  },
  {
    id: 'perda-ia',
    chave: 'PERDA_IA_SLUGS',
    nome: 'IA move pra PERDIDO quem já recusou',
    oQueFaz:
      'De hora em hora a IA lê a conversa dos cartões em EM QUALIFICAÇÃO e EM ESPERA em que o paciente não escreve há 48 h ou mais e move pra PERDIDO só quem JÁ DISSE que acabou: recusa clara ("já fechei com outro", "não tenho interesse", "achei muito caro"), fora da região ou do serviço, ou engano/spam. Grava o ⊘ Motivo do não agendamento (opção da lista da conta), uma nota com a justificativa e a frase do paciente, e a etiqueta "perdido pela IA".',
    pegadinha:
      'Nunca move: dúvida aberta (o paciente perguntou e ninguém respondeu), "vou ver / vou falar com meu marido", quem a IA não tem certeza ALTA, consulta futura (cartão ou franquia), tratamento em andamento, pagamento antecipado, Quente/Morno, ◷ Retomar em de hoje em diante, "Pausar IA" marcado, equipe falando nas últimas 24 h, NO_FOLLOW_UP/CURRÍCULO, funil TRATAMENTO. Só vale a frase do paciente que está nas 3 últimas falas dele e não é pergunta. Falha da IA ou da franquia = o cartão fica. SUMIÇO (vácuo) NÃO move aqui: é do worker de parados (régua esgotada, EM ESPERA 30 dias); aqui o vácuo só aparece como "pularia". Fica de fora NÃO COMPARECEU (tem consulta na franquia) e a entrada (é da Sofia). Teto por unidade por varredura: 20 cartões lidos e 5 movidos. Só move com motivo da lista fechada: Sem interesse, Plano de Saúde, Outra cidade, Clicou por engano, Outra patologia (levam a etiqueta NO_FOLLOW_UP ANTES da etapa, então a régua de PERDIDO de 48/96/120 h não manda nada — se a etiqueta não entrar, o cartão NÃO é movido) e Sem condições financeira (sem etiqueta: pode receber a régua). Vai se organizar, Está viajando, Assinou contrato e Informação para terceiro nunca movem. Conta sem a etiqueta NO_FOLLOW_UP (ex.: Rio Verde) não move motivo definitivo. A recusa tem de ser a última fala do paciente (depois dela só cortesia); fala com pergunta nunca conta. Em "Só no papel" a leitura RODA (~US$ 0,0004 por cartão) e a tela mostra "moveria" com padrão, motivo e justificativa — é o que se confere antes de ligar. Passa pelo mesmo fecho e pela mesma trava da perda automática do worker de parados.',
    risco: 'move-cartao',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/perda-ia-worker.ts',
  },
  {
    id: 'entrada-automatica',
    chave: 'ENTRADA_AUTOMATICA_SLUGS',
    nome: 'Leads de entrada: vincular e aceitar sozinho',
    oQueFaz:
      'A cada 3 minutos olha a caixa «Leads de entrada» (só conversas de chat) e trata o lead RECENTE (com mais de 3 e menos de 120 minutos): se o telefone (últimos 8 dígitos) bate com UM cartão aberto, vincula a conversa a esse cartão; se não bate com nenhum cartão aberto, aceita o lead na primeira etapa de trabalho do funil onde ele entrou (nas Doutor Hérnia, EM QUALIFICAÇÃO). Com 2 ou mais cartões abertos no mesmo telefone não faz nada: deixa na caixa, à vista, para a recepção decidir.',
    pegadinha:
      'ACEITAR é uma mudança de etapa: os robôs de «entra na etapa» da primeira etapa (boas-vindas, primeiro contato) podem disparar. Por isso só o lead de menos de 2 horas é aceito (ENTRADA_JANELA_MIN); conversa mais velha nunca é aceita por aqui. Vincular não muda a etapa de ninguém nem dispara robô. Cartão só FECHADO (ALTA, PERDIDO, GANHO) não segura o aceite: quem volta depois da alta é cartão novo. Se a busca por telefone falha, o lead fica na caixa (nunca vira «sem cartão»). Formulário, ligação e e-mail não são tocados. Teto por rodada: 30 leads olhados e 15 escritas; erro do Kommo faz a conta descansar 5 minutos. O token precisa ser de administrador (vincular é só admin). Em «Só no papel» a tela mostra «vincularia», «aceitaria» e «pularia» (ambíguo) por lead, sem escrever nada. Junto com a Sofia: se ela já tirou o lead da caixa, o aceite dá 404 e é ignorado.',
    risco: 'move-cartao',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/entrada-automatica.ts',
  },
  {
    id: 'entrada-estoque',
    chave: 'ENTRADA_ESTOQUE_SLUGS',
    nome: 'Leads de entrada: escoar o estoque antigo',
    oQueFaz:
      'Para os leads de entrada com mais de 120 minutos (setembro, outubro…): se o telefone bate com UM cartão aberto, vincula a conversa a ele (como foi feito à mão em Timbó em 05/11: 274 vinculados, nenhum robô). Quem não tem cartão NÃO é aceito: fica na caixa e aparece na tela «Só no papel» como «pularia», para uma pessoa decidir. Ambíguo (2+ cartões abertos) também fica.',
    pegadinha:
      'Vincular consome o lead de entrada e não tem volta: por isso exige «Só no papel» antes. Não muda etapa, não cria cartão, não une os contatos (isso é na tela do Kommo: Contatos, Duplicados). Teto de 15 vínculos por rodada (3 em 3 minutos): um estoque de 600 leva algumas horas, sem rajada. Não depende da chave irmã «Leads de entrada: vincular e aceitar sozinho»; as duas podem ficar em estados diferentes.',
    risco: 'move-cartao',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/entrada-automatica.ts',
  },
  {
    id: 'franquia-move',
    chave: 'FRANQUIA_MOVE_SLUGS',
    nome: 'A franquia move a etapa',
    oQueFaz:
      'O que acontece na franquia manda o cartão andar sozinho: marcou vira AGENDADO, foi atendido vira COMPARECEU, começou as sessões vai pra EM TRATAMENTO. Ninguém arrasta cartão na mão.',
    pegadinha:
      'A franquia nunca escreve atendido, valor nem alta por conta própria — esses três continuam vindo da tela. E a máquina se recusa a declarar falta ou perda a partir da etapa de entrada: esse cartão é da Sofia, que pode estar no meio de uma conversa. Cartão em EM ESPERA com ◷ Retomar em de hoje em diante só sai por fato novo (consulta marcada, tratamento aberto) — a mesma avaliação de antes não o puxa de volta pra COMPARECEU ou EM NEGOCIAÇÃO. Mover dispara os bots da etapa de destino: ligue em seco primeiro e leia no log (franquia-move [seco]: moveria) e no resumo da varredura (simulados) quantos cartões iriam pra onde.',
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

  {
    id: 'casamento-jornada',
    chave: 'CASAMENTO_JORNADA_SLUGS',
    nome: 'Casamento cartão × paciente e jornada (regras de 16/10)',
    oQueFaz:
      'Liga as regras que o João decidiu em 16/10: dois pacientes da franquia no mesmo telefone travam o cartão com a etiqueta CONFLITO_FRANQUIA até a SDR escolher no widget qual é o paciente (o ⚙ idClient fica gravado e não pergunta de novo); o casamento cartão × paciente procura idClient → telefone → nome; ex-paciente que volta vai pra RETORNO PÓS-TRATAMENTO e tratamento finalizado nunca leva a GANHO; a jornada ancora na última avaliação; falta em retorno ou sessão não muda a etapa (vira nota + tarefa); a franquia manda no PERDIDO e na ALTA (avaliação marcada tira do PERDIDO; na ALTA, sessão marcada volta pra EM TRATAMENTO e consulta marcada vai pra RETORNO), uma vez por fato; mesmo paciente com dois cadastros na franquia ganha uma nota pra juntar; a Sofia não tira cartão do funil TRATAMENTO; e o cadastro da Sofia na franquia casa com o paciente que já existe em vez de criar outro.',
    pegadinha:
      'Em "só no papel" tudo continua como antes e a tela mostra o que as regras novas fariam de diferente (etiquetaria, moveria, alertaria, diverge, pularia). O movimento de etapa ainda passa pela chave "A franquia move a etapa": com ela desligada, nada se move. TRATAMENTO CANCELADO continua intocável (a SDR cancela no Kommo). Se a equipe puser o cartão de volta em PERDIDO ou ALTA com o mesmo fato de pé na franquia, o robô não insiste: deixa e abre uma tarefa para conferir (a marca fica em card_alert). O widget precisa da versão com o bloco "Qual é o paciente deste cartão?" para a SDR escolher.',
    risco: 'move-cartao',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/casamento-jornada.ts',
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
    id: 'confirmacao-d1',
    chave: 'CONFIRMACAO_D1_SLUGS',
    nome: 'Véspera pelo robô do Kommo',
    oQueFaz:
      'A pergunta da véspera ("você vem amanhã?") passa a sair pelo robô do Kommo, 24 h antes da ◷ Data da Consulta, para TODO paciente agendado — não só para quem a Sofia marcou. Quando o paciente toca "Confirmar presença" (ou "Preciso remarcar"), o sistema responde sozinho, confirma a consulta na franquia e, se pediu para remarcar, abre tarefa para a equipe.',
    pegadinha:
      'Fora de "Desligado" — inclusive em "Só no papel" — a véspera do SERVIDOR não sai nesta unidade (senão o paciente recebe duas perguntas): crie o gatilho de 24 h no Kommo (script acailandia-gatilho-vespera.js) e mude a chave NO MESMO MOMENTO. Também vale para o botão do lembrete do dia (3 h antes). Só trata o TOQUE no botão (ou o mesmo texto digitado) quando a última mensagem da conversa foi o lembrete do robô — se a SDR ou a Sofia falaram depois, segue com a Sofia; resposta solta ("sim", "ok") também. Lembrete que não diz se é consulta ou sessão, ou hora que não bate com a agenda: responde e abre tarefa, sem confirmar na franquia. Em "Só no papel" o toque segue com a Sofia e a tela mostra o que o sistema faria.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/resposta-ao-lembrete.ts',
  },
  {
    id: 'confirmar-sessao',
    chave: 'CONFIRMAR_SESSAO_SLUGS',
    nome: 'Confirmar presença das sessões',
    oQueFaz:
      'Quando o paciente em tratamento toca "Confirmar presença" no lembrete da sessão (24 h ou 3 h antes da ◷ Próxima sessão), o sistema responde sozinho e marca a sessão como CONFIRMADA na franquia. "Preciso remarcar" vira tarefa para a equipe com a resposta ao paciente.',
    pegadinha:
      'Acha a sessão pelo ⚙ idTreatment (franquia) do cartão e pelo horário da ◷ Próxima sessão — se não bater exatamente, não confirma nada na franquia: responde e abre tarefa para a equipe confirmar na agenda. Responde mesmo com a Sofia calada na etapa, porque é resposta a um lembrete que nós mandamos.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/resposta-ao-lembrete.ts',
  },
  {
    id: 'alerta-sem-resposta',
    chave: 'ALERTA_SEM_RESPOSTA_SLUGS',
    nome: 'Alerta: paciente sem resposta (Telegram + tarefa no cartão)',
    oQueFaz:
      'Quando uma mensagem do paciente fica 5 minutos sem NENHUMA resposta (nem da equipe, nem da Sofia, nem de robô), manda um alerta no Telegram do João com a unidade, o contato, a última mensagem e o link do cartão E também cria, no mesmo momento, uma TAREFA no cartão do Kommo para a equipe da unidade ("ALERTA · … Paciente sem resposta há N min… Responda agora"), com prazo agora e no responsável do cartão. Um alerta e uma tarefa por espera: só voltam depois que alguém responder e o paciente ficar sem resposta de novo.',
    pegadinha:
      'Só em horário de atendimento da unidade (8h–20h, dias da agenda, sem feriado) e só para mensagem dos últimos 60 minutos — a volta de uma queda não vira rajada. Quem decide se houve resposta é a conversa oficial do Kommo (a mesma que a Sofia lê). Se o Kommo recusar a tarefa, o Telegram sai mesmo assim dizendo que a tarefa não foi criada (uma tentativa por espera, para não duplicar); se faltar TELEGRAM_BOT_TOKEN no servidor, a tarefa sai e o Telegram não. Em "só no papel" nada é criado no Kommo. Os grupos das unidades no Telegram ficam para depois.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/sem-resposta-worker.ts',
  },
  {
    id: 'disparo-campanha',
    chave: 'DISPARO_CAMPANHA_SLUGS',
    nome: 'Disparo de campanha pela API oficial',
    oQueFaz:
      'Manda o modelo da campanha (Outubro Rosa…) pela API oficial do WhatsApp com o token da unidade, sem a tela de Transmissões do Kommo e sem o código por e-mail. Só sai onda que o João APROVOU na tela de aprovação: ele vê a unidade, quantas pessoas e o texto final antes de sair. Depois manda sozinho, em lote, com os freios.',
    pegadinha:
      'NASCE EM "SÓ NO PAPEL" PARA A REDE TODA: em seco, decide tudo (franquia, SAIR, janela, tetos) e grava quem RECEBERIA, mas não manda nada nem escreve no Kommo — a chave lista quem está LIGADO. Mesmo ligado, só recebe de verdade quem estiver em DISPARO_LISTA_DE_TESTE (números de teste); sem a variável NINGUÉM recebe, e `*` solta a onda aprovada inteira — uma decisão à parte, depois da prova. Freios por unidade: 9h–18h de segunda a sexta (sem feriado), 30 por hora e 100 por 24 h, para de vez se mais de 3 pessoas responderem SAIR e pausa se 5 envios seguidos falharem. Nunca manda para quem tem consulta futura ou tratamento aberto na franquia (reconferido na hora do envio), para quem respondeu SAIR, nem duas vezes para a mesma pessoa na campanha. Mensagem por fora do Kommo não aparece lá: cada envio deixa uma nota no cartão.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'seco',
    arquivo: 'src/lib/disparo/lote.ts',
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
    id: 'ligacao-whatsapp',
    chave: 'LIGACAO_WHATSAPP_SLUGS',
    nome: 'Ligação pelo WhatsApp no cartão',
    oQueFaz:
      'Liga o painel "Ligar pelo WhatsApp" do widget no cartão: a SDR pede a permissão do paciente, combina pelo chat ("Posso te ligar agora?") e liga do navegador pelo número oficial. Toda ligação fica registrada no cartão com duração e resultado.',
    pegadinha:
      'A Meta só deixa ligar para quem deu permissão e corta a permissão de quem não atende — por isso há três travas: o botão só fica verde depois que o paciente responde no chat; 2 ligações seguidas sem atender travam aquele paciente; e se no dia menos da metade das ligações for atendida, a fila "Ligar próximo" pausa até amanhã e abre uma tarefa ALERTA. Em "só no papel" o painel aparece e mostra tudo, mas só liga e só pede permissão para o número de teste (LIGACAO_TESTE_TELEFONES — o do João). Precisa do campo "calls" assinado no webhook do app da Meta e encaminhado pra cá.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/ligacao-whatsapp-servico.ts',
  },
  {
    id: 'ligacao-gravar',
    chave: 'LIGACAO_GRAVAR_SLUGS',
    nome: 'Gravar as ligações pelo WhatsApp',
    oQueFaz:
      'Marca que esta unidade quer as ligações pelo WhatsApp gravadas. Hoje só muda o aviso no painel do widget ("esta ligação pode ser gravada: avise o paciente") — a gravação em si ainda não está montada (decisão do João pendente).',
    pegadinha:
      'A Meta NÃO grava ligação (a doc de 08/10/2026 não tem gravação; só correio de voz em teste, para ligação recebida). Gravar seria o navegador da SDR gravar os dois lados e subir o áudio para o nosso servidor — exige avisar o paciente no começo (LGPD), lugar seguro para guardar e prazo para apagar. Deixe desligado até a decisão.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/controllers/ligacao-whatsapp.controller.ts',
  },
  {
    id: 'prometeu-sem-marcar',
    chave: 'PROMETEU_SEM_MARCAR_SLUGS',
    nome: 'Alerta: a IA disse que marcou e não marcou',
    oQueFaz:
      'Quando a IA diz ao paciente que a consulta está marcada, reservada ou confirmada ("fica reservado sexta às 9h", "te espero amanhã às 8h") e a consulta não existe — nem no rastro da IA, nem no cartão (◷ Data da Consulta), nem na franquia pelo telefone —, abre uma tarefa ALERTA no cartão pra SDR ligar e marcar.',
    pegadinha:
      'Nasce em "só no papel" na rede toda: a lista "o que faria" mostra "alertaria" (a IA prometeu e não há consulta) e "confere" (prometeu e a consulta existe), sem criar tarefa. Só confere depois que a conversa fica 10 min parada — se o paciente responde e a IA marca, não avisa. Um alerta por cartão a cada 24 h. Pergunta, oferta e condição ("quer que eu reserve?", "se quiser, deixo reservado", "o Pix garante seu horário reservado") não contam. Medido em 30 dias (set–out/2026): 642 afirmações, 273 sem agendamento da IA, 204 alertas em 194 cartões; conferindo cartão e franquia, cerca de metade some (era a recepção que tinha marcado, ou paciente em tratamento). Chave de emergência da rede: PROMETEU_SEM_MARCAR_DESLIGADO=1 nem sobe o vigia.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'seco',
    arquivo: 'src/lib/prometeu-sem-marcar-worker.ts',
  },
  {
    id: 'agendamento-perdido-filtro',
    chave: 'AGENDAMENTO_PERDIDO_FILTRO_SLUGS',
    nome: 'Alerta de agendamento perdido sem alarme falso',
    oQueFaz:
      'O aviso "a IA ofereceu horário e a consulta não foi marcada" (nota no cartão + Telegram do João) deixa de sair em três casos que não são venda perdida: o paciente adiou e a IA gravou ⊘ Motivo da espera com ◷ Retomar em (a retomada automática cuida); o paciente nunca respondeu depois da oferta (a régua de follow-up cuida); e de madrugada, entre 21h e 8h na hora da unidade (o vigia espera a manhã e só avisa se ainda valer).',
    pegadinha:
      'Medido nos 20 alertas de 19–20/10/2026: 10 eram de quem adiou ("deixa para o próximo", "só volto em dezembro", "vou pelo plano"), 4 de quem nunca respondeu e 6 chegaram de madrugada — ligada, sobrariam 6, todos de quem respondeu e ficou sem consulta (inclusive o "vou ver com meu marido"). Em "só no papel" o aviso sai igual a hoje e a lista mostra "pularia" com o motivo. Se o paciente voltar a escrever dentro de 24 h da oferta e não marcar, o aviso sai.',
    risco: 'manda-mensagem',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/agendamento-perdido-worker.ts',
  },
  {
    id: 'rotina-exlead',
    chave: 'ROTINA_EXLEAD_SLUGS',
    nome: 'Rotina diária: ex-lead que nunca agendou',
    oQueFaz:
      'Quem nunca teve consulta (nem no cartão nem na franquia) e hoje está em PERDIDO ou EM ESPERA recebe a ▶ Reativação 30 dias depois da última mensagem do paciente (ou da entrada em PERDIDO, o que for mais recente), a ▶ Reativação 2 aos 60 e a ▶ Reativação 3 aos 90.',
    pegadinha:
      'DIVIDE a ▶ Reativação com as Etiquetas ▶ automáticas pela MARCA, sem buraco: o etiquetas-auto continua pondo a Reativação de 30 d depois da perda, mas PULA a pessoa a quem esta rotina já deu algum degrau; e a Reativação que ele já pôs conta como o 1º degrau daqui (nada em dobro). O que a rotina não alcança (lista cortada, «Pausar IA», ◷ Retomar em, quem nunca escreveu) segue saindo do etiquetas-auto como sempre. É a mesma ▶ e o mesmo robô, então valem as MESMAS travas dele: sem a `_v2` do modelo, responsável vazio ou que não é gente segura o 1º toque; cartão que nasceu em PERDIDO (carga) e quem voltou em outro cartão não recebem. Nunca manda para motivo de perda encerrado — o do campo ⊘ OU o escolhido no diálogo NATIVO do Kommo (Outra cidade, Clicou por engano, Outra patologia, Plano de Saúde, Sem interesse, Bandeira vermelha, Assinou contrato…) —, NO_FOLLOW_UP, NAO_PERTURBAR, opt-out, CURRÍCULO, Fora do escopo. O 1º toque só vale enquanto o silêncio está entre 30 e 60 dias: o estoque mais velho não entra de uma vez (o teto do dia também o espalha). Em PERDIDO o relógio conta da última mensagem ou da perda; em EM ESPERA, da última mensagem ou da ENTRADA na etapa (a SDR que move para esperar uma ligação não dispara a Reativação horas depois). Depois do 1º degrau o relógio segue na última mensagem do paciente: só ela zera a régua, mudar de etapa não. Paciente que a franquia não conhece (vínculo, nome, telefone) conta como «nunca agendou». Degraus e teto são da PESSOA: dois cartões do mesmo contato não recebem dois modelos no mesmo dia. Prazos: rotina_exlead_d1..d3; degraus prontos: rotina_exlead_toques_prontos (padrão 1). Teto do dia somado com as outras réguas.',
    risco: 'manda-mensagem',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/rotina-exlead-worker.ts',
  },
  {
    id: 'etiquetas-auto',
    chave: 'ETIQUETAS_AUTO_SLUGS',
    nome: 'Etiquetas ▶ automáticas',
    oQueFaz:
      'Põe sozinho as etiquetas que a SDR punha à mão: ▶ Boas-vindas quando o cartão entra em GANHO, ▶ Confirmar retorno 24 h antes do retorno (RETORNO PÓS-TRATAMENTO) e ▶ Reativação depois de 30 dias em PERDIDO sem conversa. A etiqueta aciona o bot do Kommo, que manda a mensagem.',
    pegadinha:
      'Só funciona se a etiqueta tiver gatilho no Kommo daquela unidade. Não põe se o modelo for sair com buraco (programa, próxima sessão ou responsável vazios — cada regra deixa de olhar esses campos quando a unidade tem a `_v2` do modelo dela aprovada: `…sdr_reativacao_lead_frio_v2` ("a equipe Doutor Digital"), `…sdr_boas_vindas_programa_v2` (sem programa nem data) e `…sdr_confirmacao_retorno_v2` (mostra a ◷ Data da Consulta); quem cria a v2 troca o modelo do bot no mesmo passo) nem pra quem pediu pra não receber — em "só no papel" isso aparece como "pularia" com o motivo. A Reativação só pega quem cruza os 30 dias agora: o estoque antigo de PERDIDO nunca entra de uma vez. A Rotina «ex-lead» dá os degraus 2 e 3 da ▶ Reativação a quem nunca agendou; este robô pula a pessoa a quem ela já deu um degrau. A ▶ Retomada não está aqui: depende do robô da 3C (a Rotina diária «esquecidos por etapa» é outra coisa). No Kommo dividido (Petrópolis + Caxias), só o cartão com a ⌂ Unidade de atendimento da unidade recebe etiqueta — o de outra unidade e o sem unidade ficam de fora (o robô da etiqueta mandaria o endereço e o Pix errados). Caxias ainda não recebe etiqueta nenhuma: espera os gatilhos com a condição de unidade e os robôs caxias_. Pra testar num cartão só: ligue e ponha os ids em pipelineIntents.etiquetas_teste_leads — o resto segue no papel.',
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

  {
    id: 'rotina-robos',
    chave: 'ROTINA_ROBOS_SLUGS',
    nome: 'Rotina diária: esquecidos por etapa',
    oQueFaz:
      'Todo dia, em horário comercial, põe a etiqueta ▶ Retomada (e a 2 e a 3) em quem o paciente parou de responder e ninguém tocou: EM QUALIFICAÇÃO com 2, 4 e 7 dias sem resposta, NÃO COMPARECEU com 1, 3 e 6 (contados da falta ou da última mensagem, o que for mais recente), EM NEGOCIAÇÃO com 2, 5 e 9. A etiqueta aciona o robô do Kommo, que manda o modelo do WhatsApp.',
    pegadinha:
      'Um degrau por vez, na ordem, sem repetir e sem pular; qualquer mensagem do paciente zera a régua; depois do último degrau sem resposta não manda mais nada (quem move é o parados). O dia 1 da QUALIFICAÇÃO é da Sofia (follow-up-24h, dentro da janela). Nunca manda para NO_FOLLOW_UP, NAO_PERTURBAR, opt-out, CURRÍCULO, consulta futura (cartão ou franquia), ◷ Retomar em de hoje em diante, «Pausar IA», equipe que falou nas últimas 48 h ou qualquer fala nas últimas 24 h. Os degraus e o teto são da PESSOA, não do cartão: dois cartões do mesmo contato não recebem dois modelos no mesmo dia. TETO por unidade por dia (30; rotina_teto_dia) somado com as outras réguas da rotina e com a marca de cada toque. Prazos por unidade: rotina_qualificacao_d1..d3, rotina_naocompareceu_d1..d3, rotina_negociacao_d1..d3. Só funciona se a conta tiver a etiqueta e o gatilho dela no Kommo (o gatilho só se lê com sessão): rotina_toques_prontos diz quantos degraus (1 a 3) estão prontos; o padrão é 1 (▶ Retomada), e quem já recebeu o último degrau pronto sai da fila sem gastar chamada. Etiqueta que a conta não tem = não faz nada. SOBREPOSIÇÃO: em EM NEGOCIAÇÃO os robôs decisao_retomada_4d / encerramento_7d do Kommo (relativos à ◷ Data da Consulta) podem mandar a deles também; com o parados ligado, a régua esgotada da Sofia leva a QUALIFICAÇÃO para PERDIDO antes do 2º dia. Em «só no papel» a tela mostra por etapa e por degrau quantos receberiam (teto simulado por dia).',
    risco: 'manda-mensagem',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/rotina-etapas-worker.ts',
  },

  // ── escrevem campo ──────────────────────────────────────────────────────────────────────────
  {
    id: 'franquia-sync',
    chave: 'FRANQUIA_SYNC_SLUGS',
    nome: 'Sincronizador da franquia',
    oQueFaz:
      'A cada 15 minutos copia da franquia pro cartão o que aconteceu: data da consulta, situação, fisioterapeuta, sessões, faltas, tratamento, dados da pessoa.',
    pegadinha:
      'Só enxerga a janela de D-3 a D+45, de propósito — ele roda 96 vezes por dia e alargar seria reler um passado que não muda. Por isso o histórico antigo nunca entra sozinho. Em "Só no papel" lê a franquia e registra o que gravaria, sem tocar no Kommo (útil para conferir uma unidade nova, como Caxias no Kommo de Petrópolis). Numa conta dividida entre duas unidades, cada uma só mexe nos cartões com a sua ⌂ Unidade de atendimento; cartão com o campo vazio não é de ninguém.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/franquia-sync-worker.ts',
  },
  {
    id: 'franquia-calendario',
    chave: 'FRANQUIA_CALENDARIO_SLUGS',
    nome: 'Agenda da franquia no Calendário do Kommo',
    oQueFaz:
      'Cada agendamento da franquia vira UMA tarefa no horário da consulta, no Calendário do Kommo (/todo/calendar), e acompanha a franquia: remarcou, a tarefa muda de hora; atendeu, faltou ou desmarcou, a tarefa é concluída com o resultado.',
    pegadinha:
      'Só mexe em TAREFAS (nunca em campo nem em etapa do cartão) e nunca apaga: fechar é concluir com resultado. Em "Só no papel" lê a franquia e o Kommo e registra o que criaria, sem escrever. A unidade só roda se a conta do Kommo tiver o tipo de tarefa "Consulta" (ou um tipo escolhido em unit_calendario) — sem ele fica parada e o log avisa. TROCAR O TIPO depois de criar tarefas duplica a agenda inteira. Numa conta dividida (Petrópolis × Caxias) cada unidade usa o próprio marcador e só põe a tarefa no cartão que é dela. Roda a cada 15 minutos (FRANQUIA_CALENDARIO_INTERVALO_MIN muda), então a tarefa aparece no Kommo em até esse tempo depois de marcar na franquia.',
    risco: 'cria-tarefa',
    temSeco: true,
    chaveAplicar: 'FRANQUIA_CALENDARIO_APLICAR',
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/franquia-calendario-worker.ts',
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
    id: 'tipo-lead-chegada',
    chave: 'TIPO_LEAD_CHEGADA_SLUGS',
    nome: '⬢ Tipo de lead na chegada do lead',
    oQueFaz:
      'Preenche o ⬢ Tipo de lead quando o lead chega: Resgate se a pessoa já existia (na franquia ou primeiro contato há mais de 90 dias), Cadastro se é nova. Grava só em campo vazio e não troca depois.',
    pegadinha:
      'Roda sozinho a cada 3 minutos nos cartões abertos criados nas últimas 6 h (com 3 min de vida; qualquer funil), com ou sem Sofia na unidade; não mexe no estoque antigo. Escritores do ⬢ Tipo de lead: este robô (na chegada), o campos-sdr (no agendamento, só em campo vazio — com o campo já preenchido só registra confere/diverge) e a captura da Sofia, que grava SEM ler. LIGADO, a Sofia deixa de gravar esse campo (nem recebe a ferramenta) e o robô é o único escritor; em "Só no papel" a Sofia segue como hoje, então o seco ainda não mostra o resultado final. Qualquer valor no campo, inclusive "Transferido de outra unidade", é respeitado. Na dúvida NÃO grava e tenta de novo (a cada 10 a 60 min, enquanto o cartão estiver na janela): franquia fora do ar, contato sem telefone, índice ausente/velho, unidade sem franquia conectada — nunca vira "Cadastro" por erro. A franquia ignora filtro de telefone, então o telefone é procurado num ÍNDICE do nosso lado (pacientes + leads da franquia, últimos 8 dígitos), montado até 1×/dia por unidade (carga lenta, com pausa e teto de chamadas; só para unidade em seco ou ligada) e guardado no banco. Cadastro só sai com o índice da unidade inteiro e com menos de 36 h; índice ainda não montado, velho, cortado pelo teto (base muito grande) ou com erro = não grava e o log avisa. Telefone que está na franquia como paciente OU lead de data anterior ao cartão = Resgate (mãe e filha no mesmo número também). A busca por nome fica de reforço. O índice só enxerga o campo WhatsApp do cadastro e leads dos últimos 3 anos. Cartões criados em lote (15 no mesmo minuto ou 60 em 10 min: importação, carga da franquia) ficam de fora — o campos-sdr os alcança no agendamento. Cartão em que a Sofia/recepção já criou o paciente ou marcou a consulta fica para o campos-sdr (a busca acharia o paciente recém-criado). Conta sem o campo ⬢ Tipo de lead (nome exato) ou sem a opção "Resgate"/"Cadastro": não grava e avisa no log. Conta dividida (Petrópolis × Caxias): só age no cartão que já tem a ⌂ Unidade de atendimento. Em "Só no papel" lê o Kommo e a franquia (só leitura) e registra o que gravaria.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/tipo-lead-chegada.ts',
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
    id: 'valor-consulta',
    chave: 'VALOR_CONSULTA_SLUGS',
    nome: 'Valor da Consulta preenchido sozinho',
    oQueFaz:
      'Preenche o ¤ Valor da Consulta com o preço da consulta das fontes da unidade quando o paciente tem consulta marcada. Grava só em campo vazio. Unidade com pagamento antecipado: grava o preço antecipado quando o ¤ Pagamento antecipado é Sim (ou a consulta já foi paga antes) e o preço no dia quando é Não; a Sofia já grava na hora de agendar. Paciente com plano/convênio e unidade com taxa de reserva ficam de fora.',
    pegadinha:
      'O preço vem do texto "CONSULTA … R$ …, pago no dia" das fontes da unidade (nada fixo no código); sem preço lá, não grava e o log avisa. Só vale para AVALIAÇÃO que ainda vai acontecer (agendada, confirmada ou remarcada, com horário no futuro): atendida, falta, desmarcada, retorno e sessão não recebem. Nunca troca o que uma pessoa digitou, nem o 0 da cortesia, e relê o cartão antes de escrever. Em unidade com pagamento antecipado (preço antecipado nas fontes), sem forma de pagamento o robô ESPERA (e no dia da consulta grava o preço no dia); se o próprio robô gravou o valor e a forma mudou (Não→Sim por comprovante), ele troca — só o que ele mesmo gravou (a marca fica na tabela valor_consulta_gravado). O preço antecipado vem das mesmas fontes que a Sofia usa; sem ele (Timbó) nada disso vale. Os modelos de WhatsApp "consulta prepagamento" e "dados pix" leem este campo. Roda junto do sincronizador da franquia (precisa estar ligado na unidade): vê os cartões que ele visita (janela de D-3 a D+45 e a revisão dos antigos), no máximo 60 por varredura (VALOR_CONSULTA_MAX). Ligado, o guia "O que eu faço agora?" deixa de pedir este campo à SDR nos cartões já casados com a franquia e com a consulta ainda por vir (exceto em unidade com pagamento antecipado, onde o robô espera a forma de pagamento: lá o guia continua pedindo enquanto o campo estiver vazio); cartão sem paciente casado ou com consulta já passada continua pedindo. Kommo dividido (Petrópolis × Caxias): o guia lê a chave e o preço da unidade da Ponte e o robô os da unidade da franquia — só ligue lá com a chave e o preço iguais nas duas. Em "Só no papel" só registra o que gravaria; se o sincronizador inteiro estiver em seco, também não grava.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/valor-consulta.ts',
  },
  {
    id: 'unidade-por-canal',
    chave: 'UNIDADE_POR_CANAL_SLUGS',
    nome: 'Unidade de atendimento (Petrópolis × Caxias)',
    oQueFaz:
      'Para conta que atende duas cidades no mesmo número (Petrópolis e Caxias): marca o ⌂ Unidade de atendimento e a etiqueta da cidade pela conta de anúncios do anúncio que trouxe o paciente; sem anúncio conhecido, pelo DDD (21 = Caxias, 24 = Petrópolis); sem os dois, deixa vazio para a SDR escolher. Ligado, também atende e cadastra quem escreveu ANTES de o cartão ter unidade (a Sofia fica calada nesse intervalo): quando o cartão passa a ser de Petrópolis, a varredura relê a conversa oficial e, se o paciente ficou sem resposta (até 2 h, dentro do horário da unidade), reinicia o turno da IA uma vez; sempre tenta o cadastro do lead na franquia. Cartão de Caxias nunca é atendido nem cadastrado por Petrópolis. Em "Só no papel" só registra no log o que retomaria.',
    pegadinha:
      'Nunca troca o que a SDR marcou. Troca o que o PRÓPRIO robô marcou se a regra discordar (é assim que os 104 pacientes de Caxias marcados como Petrópolis até 13/10 se corrigem). Anúncio novo entra sozinho quando a unidade tem o token da Meta com acesso às duas contas de anúncio; sem token vale a lista conferida no código, e anúncio fora dela cai no DDD.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/unidade-por-canal.ts',
  },
  {
    id: 'unidade-no-cartao',
    chave: 'UNIDADE_NO_CARTAO_SLUGS',
    nome: '⌂ Unidade no cartão (modelo da primeira sessão)',
    oQueFaz:
      'Preenche o campo ⌂ Unidade com a cidade da unidade ("Balsas/MA") em todo cartão que estiver vazio. É o campo que o modelo de WhatsApp da primeira sessão lê: vazio, o Kommo manda o exemplo da Meta ("Unidade: Imperatriz/MA").',
    pegadinha:
      'O modelo sai no mesmo segundo em que o cartão entra em EM TRATAMENTO, então o robô preenche ANTES: cartão novo ou que mexeu, em até 5 min; o estoque (tudo menos PERDIDO), do mais novo ao mais velho, no máximo 200 por rodada, e de novo a cada 24 h. Nunca troca o que alguém escreveu — se não fala da cidade, aparece como "diverge". Petrópolis: o valor segue a ⌂ Unidade de atendimento (Petrópolis/RJ ou Duque de Caxias/RJ); vazia, não grava. A cidade de cada unidade mora no código (unidade nova: pedir pra incluir). Gravar muda a "última atualização" do cartão uma vez.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/unidade-no-cartao.ts',
  },
  {
    id: 'motivo-no-cabecalho',
    chave: 'MOTIVO_NO_CABECALHO_SLUGS',
    nome: 'Motivo no topo do cartão perdido',
    oQueFaz:
      'Copia o motivo que a SDR escolheu no campo ⊘ (não agendamento, não fechamento ou cancelamento do tratamento) para o motivo da perda do Kommo, no topo do cartão. Assim o cartão em PERDIDO deixa de mostrar "Motivo indefinido" e a SDR continua escolhendo um motivo só.',
    pegadinha:
      'Só mexe em cartão PERDIDO ou TRATAMENTO CANCELADO com o topo vazio — o que alguém ou um robô de prazo já pôs lá nunca é trocado — e só copia o que está no campo. Motivo que não existe na lista do Kommo é criado com o mesmo texto. Leva até 10 min depois de a SDR mover; na 1ª vez passa nos perdidos dos últimos 30 dias, 200 por rodada. Onde a Sofia tem régua de follow-up por motivo de perda, o cartão passa a seguir a régua daquele motivo. Petrópolis e Caxias: ligue na de Petrópolis (dona do Kommo); vale para os cartões das duas.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/motivo-no-cabecalho.ts',
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
    id: 'motivo-perdido-ia',
    chave: 'MOTIVO_PERDIDO_IA_SLUGS',
    nome: 'IA preenche o motivo do cartão que foi pra PERDIDO',
    oQueFaz:
      'Quando um cartão entra em PERDIDO (últimas 24 h, e pelo menos 10 min depois, pra SDR ter tempo de escolher) com o ⊘ Motivo do não agendamento vazio, a IA lê a conversa — a mesma leitura e o mesmo classificador do botão "Sugerir motivo" do widget — e preenche com a opção da lista DA CONTA que casa. Deixa uma nota no cartão. Depois o robô "Motivo no topo do cartão perdido" copia o motivo pro topo, se estiver ligado.',
    pegadinha:
      'Nunca sobrescreve: campo já preenchido (nem o de não fechamento), cartão de currículo e quem já foi atendido ficam como estão; relê o cartão logo antes de gravar. Sem opção que sirva na lista da conta, não grava nada (não inventa "Outro"). Se a IA estiver fora do ar, não faz nada. Em "Só no papel" a leitura RODA (custo pequeno) e a tela mostra "gravaria" com o motivo e a frase do paciente. Até 20 cartões por varredura (de hora em hora) por unidade; cada cartão é lido uma vez por dia. Modelo barato (Haiku 5.5, ~US$ 0,0004 por cartão); o botão do widget usa um modelo mais forte e acerta ~70% — compare o seco com o gabarito antes de ligar. Escrever no campo NÃO dispara os robôs de entrada em PERDIDO (eles disparam na mudança de etapa).',
    risco: 'escreve-campo',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/perda-ia-worker.ts',
  },
  {
    id: 'widget-cadastrar',
    chave: 'WIDGET_CADASTRAR_SLUGS',
    nome: 'Só cadastrar na franquia (widget, sem consulta)',
    oQueFaz:
      'No widget do cartão, o botão "Só cadastrar na franquia" cadastra o paciente (nome + telefone) na franquia e liga o cartão a ele, sem marcar consulta. Se a franquia já tem alguém com esse telefone, só liga o cartão.',
    pegadinha:
      'É clique de gente, nunca robô: a regra de 26/09 (a IA só cadastra quem agenda) continua valendo. Kommo dividido (Petrópolis + Caxias): segue a ⌂ Unidade de atendimento do cartão — campo vazio, recusa. Liga na unidade onde o widget está instalado (em Petrópolis vale também para os cartões de Caxias).',
    risco: 'escreve-campo',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/cadastro-pelo-widget.ts',
  },
  {
    id: 'cadastro-todo-lead',
    chave: 'CADASTRO_TODO_LEAD_SLUGS',
    nome: 'Cadastrar TODO lead na franquia (como lead)',
    oQueFaz:
      'A IA cadastra na franquia, como LEAD e já na primeira mensagem, toda pessoa que entra em contato — não só quem agenda (a regra de 26/09 deixa de valer para o lead). Paciente continua sendo criado só ao agendar. Número interno da rede e telefone que fala com 3 ou mais unidades em 30 dias nunca são cadastrados — nem quando veio de anúncio. Quem veio de anúncio pago (rastreio no cartão: origem Meta-* ou campanha) é lead, sempre. Quem NÃO veio de anúncio (orgânico: um "oi", engano, secretária que não está na lista, fornecedor) tem a conversa lida por uma IA barata, que decide: lead (cadastra), não é lead (barra e guarda o motivo) ou dúvida (não cadastra agora e lê de novo numa mensagem futura — no máximo 3 leituras por lead, 1 a cada 10 minutos).',
    pegadinha:
      'Nasce DESLIGADA: a regra de 26/09 segue intacta (só a trava de um cadastro por vez por lead vale a mais). Em "Só no papel" a regra de 26/09 continua decidindo e a nova só registra no log e nesta lista: "gravaria" (cadastraria), "pularia" com o motivo (barrou interno, barrou 3+ unidades, sem telefone, barraria pela IA, dúvida). Em "Só no papel" a leitura da IA RODA (custa centavos: ~US$ 0,0001 por leitura, estimado) — só não cria nada. Falha da IA (sem chave Anthropic na unidade, fora do ar) conta como dúvida e nunca cadastra. Lead de anúncio que o rastreio ainda não gravou no cartão no 1º turno é tratado como orgânico até a próxima mensagem. Só vale onde "espelhar leads" está ligado na unidade e a franquia está conectada. Número interno: variável NUMEROS_INTERNOS (csv com o telefone COMPLETO, comparado pelos últimos 8 dígitos; item com menos de 8 dígitos é ignorado) — trocar no .env e recriar o contêiner basta, sem deploy; com a variável vazia ou ausente a regra NÃO cadastra ninguém além de quem agendou. A franquia exige "Nome Completo": quem só tem o primeiro nome fica de fora e é tentado de novo a cada 10 minutos de conversa até dar o sobrenome. Conversa sem telefone não é cadastrada. Dúvida na conferência (banco fora do ar) também não cadastra. Só cria lead onde o casamento cartão × paciente ("Casamento cartão × paciente e jornada") está LIGADO — sem ele, lead novo duplicaria quem já é paciente; quem já está na franquia (lead ou paciente) nunca é recriado. O cadastro roda no fim do turno da IA e, SÓ na conta dividida (Petrópolis × Caxias), TAMBÉM quando a IA é pulada (fora do horário, pausa da unidade ou do cartão, etapa fora da allowlist ou pausada por regra, equipe falou): lead atendido só pela SDR é cadastrado do mesmo jeito, com as mesmas travas. Nas demais unidades, com a IA pulada o lead segue sem cadastro por esta regra (limitação conhecida; outro PR). Etapa calada pelo nome (GANHO/ALTA/cancelado) não cadastra. Em conta dividida (Petrópolis × Caxias) o cartão que ainda não tinha unidade é cadastrado depois que o robô unidade-por-canal (ou a SDR) marca a unidade — e só se for desta. Para medir a cobertura em "Só no papel": leads novos por dia (conversas criadas) × leads distintos com decisão no log (cadastro-todo-lead).',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/cadastro-todo-lead.ts',
  },
  {
    id: 'carimbo-etapa',
    chave: 'CARIMBO_ETAPA_SLUGS',
    nome: 'Carimbo de início e fim do tratamento',
    oQueFaz: 'Quando o cartão muda de etapa, carimba as datas de início e fim do tratamento e encerra a conversa.',
    pegadinha:
      'Só age quando o Kommo avisa a mudança de etapa (o webhook do agente assina status_lead). No Kommo dividido (Petrópolis + Caxias) vale a chave da unidade do cartão (⌂ Unidade de atendimento): cartão de Caxias só com a chave de Caxias ligada, e cartão sem unidade não ganha carimbo de ninguém — o motivo fica no log.',
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
    id: 'renomear-lead',
    chave: 'RENOMEAR_LEAD_SLUGS',
    nome: 'Renomear o lead novo (sem IA)',
    oQueFaz:
      'A cada 5 minutos lê os leads criados nas últimas 24 h que ainda têm o nome do Kommo ("Lead #123") e dá o nome que as SDRs dão à mão: "Nome dd/mm/aa", com o nome do contato do WhatsApp e a data de criação. Se o contato não tem nome, ou o nome não parece de pessoa (frase, emoji, número), vira "Lead dd/mm/aa" ("Lead 2 dd/mm/aa" para o segundo do dia).',
    pegadinha:
      'Regra fixa, sem IA — nasceu para Petrópolis e Caxias, onde o Kommo não manda mensagem para o agente e o título padrão nunca acorda. Nome que a SDR já deu NUNCA é tocado (relê o lead antes de gravar) e só age em lead com 3 minutos de vida. Na conta dividida vale a chave da unidade do cartão (⌂ Unidade de atendimento); cartão sem unidade só é renomeado se as duas chaves estiverem ligadas (em "só no papel" numa e ligada na outra, ele fica só no papel). Na dúvida escreve "Lead dd/mm/aa" em vez de arriscar um nome errado.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/renomear-lead.ts',
  },
  {
    id: 'nome-no-contato',
    chave: 'NOME_NO_CONTATO_SLUGS',
    nome: 'Nome confirmado também no contato',
    oQueFaz:
      'Quando a IA confirma o nome do paciente, grava também no CONTATO do Kommo — é dele que sai o "Olá, {{contact.name}}" dos modelos do WhatsApp.',
    pegadinha:
      'Não grava quando o nome é de outra pessoa (a esposa marcando pro marido) nem quando o contato já tem uma versão mais completa ("Anny Santos" fica, mesmo com "Anny" confirmado). Nome achado pela rede de segurança do título não entra.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/nome-no-contato.ts',
  },
  {
    id: 'telefone-de-familiar',
    chave: 'TELEFONE_FAMILIAR_SLUGS',
    nome: 'Telefone do paciente mandado por familiar vira contato do cartão',
    oQueFaz:
      'Quando quem conversa (a esposa, a filha) manda no chat o celular do paciente dizendo de quem é ("esse é o número dele"), o número entra como mais um contato DESTE cartão e fica uma nota. Assim, quando a equipe ou a Sofia escreverem para ele, a conversa cai no mesmo cartão em vez de abrir um cartão novo e vazio.',
    pegadinha:
      'Só com o número E uma palavra que diga de quem é ("dele", "dela", "do meu marido", "esse é o número", "manda mensagem pra ele"), nas 3 últimas mensagens do paciente dos últimos 15 minutos — o número numa mensagem e o "é dele" na seguinte também vale. Só celular com DDD. Número em linha de CPF, Pix, carteirinha ou protocolo não entra, nem CPF válido. Mais de um número diferente, não faz nada. Grava com e sem o nono dígito (o WhatsApp de alguns números chega sem o 9). Se o número já é contato de outro cartão, liga a este também e a nota pede para conferir e Mesclar. Não junta nem apaga cartão. Nasce em "só no papel" na rede toda: a lista mostra "gravaria contato do cartão" com o número.',
    risco: 'escreve-campo',
    temSeco: true,
    quandoVazio: 'seco',
    arquivo: 'src/lib/telefone-de-familiar.ts',
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
    id: 'pausa-equipe',
    chave: 'PAUSA_EQUIPE_SLUGS',
    nome: 'A equipe falou, a Sofia para',
    oQueFaz:
      'Quando alguém da equipe escreve para o paciente — pelo Kommo, pelo app do Kommo ou pelo celular da clínica (WhatsApp Business) — a Sofia não responde por cima: marca "Pausar IA" no cartão e a conversa fica com a equipe. A Sofia VOLTA SOZINHA quando passa 1 h sem mensagem da equipe (PAUSA_EQUIPE_VOLTA_MIN, em minutos, padrão 60): desmarca "Pausar IA", deixa uma nota no cartão e só volta a responder quando o paciente escrever — não puxa conversa. Se a equipe escrever enquanto a Sofia ainda está pensando, a resposta dela é descartada e vira nota no cartão.',
    pegadinha:
      'Quem decide é a conversa oficial do Kommo (a mesma que a Sofia lê): o webhook do Kommo não avisa as mensagens que saem. Só pausa a fala da equipe que veio DEPOIS da última mensagem da Sofia e nas últimas 24 h. Não pausa por robô (Salesbot, régua, transmissão) nem pela resposta automática do WhatsApp Business (saudação e ausência: texto longo que sai até 20 s depois da mensagem do paciente). A volta em 1 h vale SÓ para a pausa que esta automação fez (fica registrada): a caixinha marcada por gente, a pausa com data do widget, a pausa da unidade e a pausa da própria Sofia (`pausar_ia`) nunca são desmarcadas por ela; se alguém mexer na caixinha depois, a volta automática sai de cena. Só volta se a Sofia atende na etapa do cartão (as mesmas etapas permitidas e regras globais de antes de responder; em GANHO/ALTA a pausa continua). A volta olha a última fala HUMANA (saudação/ausência do WhatsApp Business não contam) e é a mesma chave: em "só no papel" a lista mostra "gravaria Pausar IA (volta)"; desligada, não faz nada. Para devolver à Sofia antes disso, desmarque "Pausar IA": a fala de antes não pausa de novo; uma fala nova da equipe pausa outra vez. Em Parauapebas e Imperatriz o token não lê as conversas (403) e nada muda. Nasce em "só no papel" na rede toda: a lista mostra "gravaria Pausar IA" onde pausaria. Mesmo desligada, duas travas já valem: antes de enviar, a Sofia confere se marcaram "Pausar IA", pausaram pelo widget ou pausaram a unidade enquanto ela pensava; e a reativação de 30 min não religa quem a equipe já atendeu (inclusive pelo celular).',
    risco: 'comportamento',
    temSeco: true,
    quandoVazio: 'seco',
    arquivo: 'src/lib/pausa-equipe.ts',
  },
  {
    id: 'encerramento-pergunta-motivo',
    chave: 'ENCERRAMENTO_PERGUNTA_MOTIVO_SLUGS',
    nome: 'Paciente adiou: a Sofia pergunta o que pesou',
    oQueFaz:
      'Quando o paciente diz que agora não pode, que vai se organizar ou agradece e encerra SEM consulta marcada, a Sofia não fecha com "claro, sem pressa, fico à disposição": acolhe numa frase e faz UMA pergunta curta e gentil para entender o que o faz esperar (dor, valor, agenda, falar com a família). Se o motivo é com a equipe (valor, convênio, condição de pagamento), oferece chamar a equipe. Pedido da Stefany (Timbó, 10/11/2026).',
    pegadinha:
      'Desligada, vale a regra da rede (21/10, auditoria de Araguaína): resposta curta e calorosa, sem pergunta. Ligada ou não, a Sofia NUNCA oferece horário nessa hora (o corte de horário continua) e quem já tem consulta marcada só recebe a despedida curta. "Tá bom"/"ok" depois de a Sofia já ter encerrado continua sem pergunta. Não tem "só no papel": é texto do prompt.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/paciente-encerrou.ts',
  },
  {
    id: 'sem-pergunta-de-alerta',
    chave: 'SEM_PERGUNTA_DE_ALERTA_SLUGS',
    nome: 'Sofia não pergunta sinal de alerta (força, xixi, fezes)',
    oQueFaz:
      'A Sofia deixa de PERGUNTAR se a perna perdeu força, se o paciente segura o xixi ou as fezes, se a virilha está dormente. Se o paciente CONTAR um desses sinais com clareza, tudo continua: ela para, avisa a equipe, etiqueta 🔴 PRIORIDADE e tarefa LIGAR AGORA. Pedido da dona de Timbó (10/11/2026): "o lead perde o interesse nesse rodeio todo".',
    pegadinha:
      'Só tira a PERGUNTA. A detecção do sinal no que o paciente escreve (rede de segurança em código, sinal-de-alerta.ts e passe-por-sinal.ts) e a regra de nunca sugerir pronto-socorro seguem iguais. Fala vaga ("a perna bambeou", dor que vai para a virilha) deixa de virar pergunta: a Sofia acolhe e segue para a consulta. Não tem "só no papel": é texto do prompt.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/conversa-direta.ts',
  },
  {
    id: 'nome-na-hora-de-marcar',
    chave: 'NOME_NA_HORA_DE_MARCAR_SLUGS',
    nome: 'Sofia pede o nome só na hora de marcar',
    oQueFaz:
      'Nada de "como posso te chamar?" no começo nem no meio da conversa: a Sofia pede o nome completo uma vez, junto da escolha do horário, porque o cadastro da consulta precisa dele. Se o paciente disser o nome antes por conta própria, ela usa. Pedido da dona de Timbó (10/11/2026).',
    pegadinha:
      'Vale mais que a chave "coletar nome" do cadastro da unidade e que o prompt próprio da unidade. O título do cartão no Kommo só ganha o nome quando ele é dito — até lá fica o título de sempre. Não tem "só no papel": é texto do prompt.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/conversa-direta.ts',
  },
  {
    id: 'conduzir-direto',
    chave: 'CONDUZIR_DIRETO_SLUGS',
    nome: 'Sofia conduz direto para a consulta (sem rodeio de sintomas)',
    oQueFaz:
      'Se o paciente já disse a dor e é algo que tratamos, a Sofia não faz mais perguntas de sintoma (há quanto tempo, intensidade) nem de impacto (sono, trabalho): diz que entende, que é exatamente o que tratamos, e oferece horários. Perguntou o valor, o valor vai na primeira frase, na hora. Pedido da dona de Timbó (10/11/2026).',
    pegadinha:
      'Desligada, vale o roteiro da rede (preço depois da queixa, uma pergunta de impacto). Ligada ou não, a Sofia nunca diagnostica, nunca promete resultado e para no sinal de alerta que o paciente contar. Não tem "só no papel": é texto do prompt.',
    risco: 'comportamento',
    temSeco: false,
    quandoVazio: 'desligado',
    arquivo: 'src/agent/conversa-direta.ts',
  },
  {
    id: 'cache-agenda',
    chave: 'CACHE_AGENDA_SLUGS',
    nome: 'Cache curto dos horários da agenda',
    oQueFaz:
      'Quando duas conversas da mesma unidade pedem os horários do mesmo dia em poucos minutos, a segunda usa a busca da primeira em vez de ir de novo à franquia — cada busca marca e cancela um agendamento de teste para cada horário que confere (até 4 por dia).',
    pegadinha:
      'Vale 10 minutos (CACHE_AGENDA_MIN, de 1 a 60), por unidade + dia + turno pedido + configuração da agenda (horário, almoço, duração da sessão, profissional por turno): mudou a configuração, o guardado deixa de servir. Fica numa tabela do banco, que vale para todas as cópias do servidor. Só guarda dia com horário CONFIRMADO pela sondagem — erro da franquia, lista vazia e sondagem que deixou agendamento fantasma nunca. Horário que já passou sai na leitura. Apaga o dia quando a Sofia marca, remarca ou cancela, quando uma marcação falha (horário ocupado ou recusado pela franquia) e quando a recepção bloqueia ou libera horário pela tela. Marcação feita direto na franquia NÃO apaga: vale o prazo — e o agendar_consulta confere o horário de novo antes de marcar. Nasce em "só no papel" na rede toda: a Sofia sempre consulta a franquia e a lista mostra, por conversa e dia, "confere" (o cache teria acertado), "diverge" (teria oferecido horário que a franquia já não aceita) ou "pularia" (não havia busca guardada). Ligue uma unidade por vez.',
    risco: 'comportamento',
    temSeco: true,
    quandoVazio: 'seco',
    arquivo: 'src/lib/cache-agenda.ts',
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
    id: 'sorriso-colorido',
    chave: 'SORRISO_COLORIDO_SLUGS',
    nome: 'Sorriso colorido ☺️ na confirmação',
    oQueFaz:
      'Deixa passar, inteiro, o ☺️ (☺ com o seletor de variação) que a confirmação de agendamento da unidade usa no fecho, em vez de rebaixá-lo para o ☺ preto e branco.',
    pegadinha:
      'Sem isto o envio arranca o seletor de variação de todo emoji e o WhatsApp mostra o ☺ em preto e branco. Vale só para o par ☺️ exato; qualquer outro emoji segue as regras de sempre. Ligar em Timbó junto com o formato novo da confirmação.',
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
  {
    id: 'rotina-aniversario',
    chave: 'ROTINA_ANIVERSARIO_SLUGS',
    nome: 'Rotina diária: aniversário',
    oQueFaz:
      'No dia do aniversário (fuso da unidade, entre 9h e 12h), paciente e ex-paciente recebem a ▶ Aniversário: parabéns e um convite. Quem está em tratamento ativo recebe a ▶ Aniversário tratamento (só parabéns, sem convite).',
    pegadinha:
      'A DATA É DA FRANQUIA: só manda com ⚙ idClient no cartão e a ficha da franquia com data de nascimento que bate com hoje — sem idClient, sem franquia na unidade, ficha sem data ou com outra data, não manda (o campo do cartão só serve de peneira). Nunca por busca de nome. A trava de paciente falecido lê o status da ficha, mas ainda SEM PROVA (80 fichas reais lidas: todas «ATIVO»); o que protege de verdade é NO_FOLLOW_UP/NAO_PERTURBAR. Uma vez por ano por pessoa (a marca é do contato), nunca junto de outro toque no mesmo dia (a retomada e o ex-lead pulam quem faz aniversário hoje, quando esta está ligada), nunca para NO_FOLLOW_UP, NAO_PERTURBAR, opt-out, CURRÍCULO ou motivo de perda encerrado. O funil TRATAMENTO NÃO é trava aqui; sem a etiqueta ▶ Aniversário tratamento na conta, quem está em tratamento não recebe nada. Fim de semana ou feriado: cumprimenta no 1º dia útil, com até 3 dias de atraso; no dia em que a régua é ligada, quem fez anos nos 3 dias anteriores também recebe, uma vez. Teto do dia somado com as outras réguas.',
    risco: 'manda-mensagem',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/rotina-aniversario-worker.ts',
  },
  {
    id: 'faxina-do-mes',
    chave: 'FAXINA_DO_MES_SLUGS',
    nome: 'Faxina do mês',
    oQueFaz:
      'No dia 1 de cada mês, de madrugada (2h às 7h), arruma o que o dia a dia deixou para trás e manda o relatório no Telegram do João: vincula chat antigo da fila de entrada ao cartão aberto do mesmo telefone, conclui tarefa de robô vencida há mais de 30 dias, tira etiqueta ▶ que ficou presa no cartão, relata o que as automações de etapa já fizeram e pede uma passada do motivo de perda.',
    pegadinha:
      'A faxina NÃO move cartão por regra própria e não dispara passada de etapa: LÊ o resumo da última varredura de parados, estoques parados e sincronizador/revisão dos agendados velhos (desligada fica quieta; em só no papel conta o «moveria»). Só chama o motivo-perdido-ia. Em «Só no papel» a faxina não grava NADA no Kommo e não dispara o motivo-perdido-ia ligado: o relatório diz o que FARIA. Os chats da caixa «Leads de entrada» seguem a regra da `entrada-estoque` (a mesma do robô de 3 em 3 minutos): só vincula quando o telefone (últimos 8 dígitos E mesmo DDD) bate com UM cartão aberto; 2+ cartões vão para a equipe com os links; quem não tem par fica na caixa (a faxina NUNCA aceita lead). Só trata chat com mais de 120 minutos na caixa: o mais novo é do robô de 3 em 3 minutos (se ele estiver desligado, fica na caixa). Se a `entrada-estoque` já está ligada ou em só no papel na conta, a faxina só relata a última rodada dela. Tarefa de pessoa nunca é tocada (só created_by 0 com marca de alerta), e ALERTA CLÍNICO (sinal de alerta, URGENTE, LIGAR AGORA) nunca é fechado: vai para «precisam da equipe» com o link. Tetos por unidade: 100 chats lidos, 60 vínculos, 300 tarefas, 100 etiquetas; o que passar fica para o mês seguinte. Uma vez por unidade por mês (trava no banco). Conta dividida (Petrópolis × Caxias) não junta chat. Para testar fora do dia 1: POST /units/:id/automacoes/faxina-do-mes/rodar (o relatório chega no Telegram).',
    risco: 'move-cartao',
    temSeco: true,
    exigeSecoAntes: true,
    quandoVazio: 'desligado',
    arquivo: 'src/lib/faxina-do-mes-worker.ts',
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
