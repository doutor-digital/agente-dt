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
    nome: 'Alerta no Telegram: paciente sem resposta',
    oQueFaz:
      'Quando uma mensagem do paciente fica 5 minutos sem NENHUMA resposta (nem da equipe, nem da Sofia, nem de robô), manda um alerta no Telegram do João com a unidade, o contato, a última mensagem e o link do cartão. Um alerta por espera: só volta a avisar depois que alguém responder e o paciente ficar sem resposta de novo.',
    pegadinha:
      'Só em horário de atendimento da unidade (8h–20h, dias da agenda, sem feriado) e só para mensagem dos últimos 60 minutos — a volta de uma queda não vira rajada. Quem decide se houve resposta é a conversa oficial do Kommo (a mesma que a Sofia lê). Precisa de TELEGRAM_BOT_TOKEN no servidor; sem ele, só registra no log. Os grupos das unidades ficam para depois.',
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
    id: 'etiquetas-auto',
    chave: 'ETIQUETAS_AUTO_SLUGS',
    nome: 'Etiquetas ▶ automáticas',
    oQueFaz:
      'Põe sozinho as etiquetas que a SDR punha à mão: ▶ Boas-vindas quando o cartão entra em GANHO, ▶ Confirmar retorno 24 h antes do retorno (RETORNO PÓS-TRATAMENTO) e ▶ Reativação depois de 30 dias em PERDIDO sem conversa. A etiqueta aciona o bot do Kommo, que manda a mensagem.',
    pegadinha:
      'Só funciona se a etiqueta tiver gatilho no Kommo daquela unidade. Não põe se o modelo for sair com buraco (programa, próxima sessão ou responsável vazios — cada regra deixa de olhar esses campos quando a unidade tem a `_v2` do modelo dela aprovada: `…sdr_reativacao_lead_frio_v2` ("a equipe Doutor Digital"), `…sdr_boas_vindas_programa_v2` (sem programa nem data) e `…sdr_confirmacao_retorno_v2` (mostra a ◷ Data da Consulta); quem cria a v2 troca o modelo do bot no mesmo passo) nem pra quem pediu pra não receber — em "só no papel" isso aparece como "pularia" com o motivo. A Reativação só pega quem cruza os 30 dias agora: o estoque antigo de PERDIDO nunca entra de uma vez. A ▶ Retomada não está aqui: depende do robô da 3C. No Kommo dividido (Petrópolis + Caxias), só o cartão com a ⌂ Unidade de atendimento da unidade recebe etiqueta — o de outra unidade e o sem unidade ficam de fora (o robô da etiqueta mandaria o endereço e o Pix errados). Caxias ainda não recebe etiqueta nenhuma: espera os gatilhos com a condição de unidade e os robôs caxias_. Pra testar num cartão só: ligue e ponha os ids em pipelineIntents.etiquetas_teste_leads — o resto segue no papel.',
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
      'Só enxerga a janela de D-3 a D+45, de propósito — ele roda 96 vezes por dia e alargar seria reler um passado que não muda. Por isso o histórico antigo nunca entra sozinho. Em "Só no papel" lê a franquia e registra o que gravaria, sem tocar no Kommo (útil para conferir uma unidade nova, como Caxias no Kommo de Petrópolis). Numa conta dividida entre duas unidades, cada uma só mexe nos cartões com a sua ⌂ Unidade de atendimento; cartão com o campo vazio não é de ninguém.',
    risco: 'escreve-campo',
    temSeco: true,
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
    nome: 'Unidade de atendimento (Petrópolis × Caxias)',
    oQueFaz:
      'Para conta que atende duas cidades no mesmo número (Petrópolis e Caxias): marca o ⌂ Unidade de atendimento e a etiqueta da cidade pela conta de anúncios do anúncio que trouxe o paciente; sem anúncio conhecido, pelo DDD (21 = Caxias, 24 = Petrópolis); sem os dois, deixa vazio para a SDR escolher.',
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
      'Quando alguém da equipe escreve para o paciente — pelo Kommo, pelo app do Kommo ou pelo celular da clínica (WhatsApp Business) — a Sofia não responde por cima: marca "Pausar IA" no cartão e a conversa fica com a equipe. Se a equipe escrever enquanto a Sofia ainda está pensando, a resposta dela é descartada e vira nota no cartão.',
    pegadinha:
      'Quem decide é a conversa oficial do Kommo (a mesma que a Sofia lê): o webhook do Kommo não avisa as mensagens que saem. Só pausa a fala da equipe que veio DEPOIS da última mensagem da Sofia e nas últimas 24 h. Não pausa por robô (Salesbot, régua, transmissão) nem pela resposta automática do WhatsApp Business (saudação e ausência: texto longo que sai até 20 s depois da mensagem do paciente). Para devolver à Sofia, desmarque "Pausar IA": a fala de antes não pausa de novo; uma fala nova da equipe pausa outra vez. Em Parauapebas e Imperatriz o token não lê as conversas (403) e nada muda. Nasce em "só no papel" na rede toda: a lista mostra "gravaria Pausar IA" onde pausaria. Mesmo desligada, duas travas já valem: antes de enviar, a Sofia confere se marcaram "Pausar IA", pausaram pelo widget ou pausaram a unidade enquanto ela pensava; e a reativação de 30 min não religa quem a equipe já atendeu (inclusive pelo celular).',
    risco: 'comportamento',
    temSeco: true,
    quandoVazio: 'seco',
    arquivo: 'src/lib/pausa-equipe.ts',
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
